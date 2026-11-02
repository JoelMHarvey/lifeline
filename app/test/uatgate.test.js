'use strict';

process.env.TL_PGDATA = ':memory:';
process.env.TL_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.UAT_PASSCODE = 'uat-test-passcode';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const db = require('../src/db');

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, () => resolve(server));
  });
}

function req(server, method, path, { body, cookie, basic } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  if (basic) headers.Authorization = 'Basic ' + Buffer.from(basic).toString('base64');
  return new Promise((resolve, reject) => {
    const r = http.request({ port: server.address().port, method, path, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({
          status: res.statusCode, headers: res.headers,
          body: data && res.headers['content-type']?.includes('json') ? JSON.parse(data) : data,
        }));
      });
    r.on('error', reject);
    r.end(body ? JSON.stringify(body) : undefined);
  });
}

let server;
test.before(async () => {
  await db.init();
  const { app } = require('../server');
  server = await listen(app);
});
test.after(() => server.close());

test('gated API answers JSON 401 without a browser auth challenge', async () => {
  const r = await req(server, 'GET', '/api/me');
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.body.passcode, true);
  assert.strictEqual(r.headers['www-authenticate'], undefined);
});

test('gated page redirects to the passcode page, which itself loads', async () => {
  const r = await req(server, 'GET', '/console.html');
  assert.strictEqual(r.status, 302);
  assert.ok(r.headers.location.startsWith('/passcode.html?next=console.html'));
  const page = await req(server, 'GET', '/passcode.html');
  assert.strictEqual(page.status, 200);
  assert.ok(String(page.body).includes('team passcode'));
});

test('the right passcode sets a cookie that opens the gate; wrong ones do not', async () => {
  const bad = await req(server, 'POST', '/api/passcode', { body: { code: 'nope' } });
  assert.strictEqual(bad.status, 401);

  const good = await req(server, 'POST', '/api/passcode', { body: { code: 'uat-test-passcode' } });
  assert.strictEqual(good.status, 200);
  const cookie = good.headers['set-cookie'][0].split(';')[0];
  assert.ok(cookie.startsWith('uat='));

  const page = await req(server, 'GET', '/console.html', { cookie });
  assert.strictEqual(page.status, 200);
  const api = await req(server, 'GET', '/api/me', { cookie });
  assert.strictEqual(api.status, 401); // through the gate, into normal auth
  assert.strictEqual(api.body.passcode, undefined);

  // A forged cookie value stays outside.
  const forged = await req(server, 'GET', '/console.html', { cookie: 'uat=deadbeef' });
  assert.strictEqual(forged.status, 302);
});

test('basic auth with the passcode still passes for scripts', async () => {
  const r = await req(server, 'GET', '/api/me', { basic: 'anyone:uat-test-passcode' });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.body.passcode, undefined); // normal "not logged in", not the gate
});

test('health and cron endpoints stay exempt', async () => {
  const r = await req(server, 'GET', '/healthz');
  assert.strictEqual(r.status, 200);
  const cron = await req(server, 'GET', '/api/cron/ops-check');
  assert.notStrictEqual(cron.status, 302);
  assert.strictEqual(cron.body.passcode, undefined); // its own secret check answers
});
