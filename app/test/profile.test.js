'use strict';

process.env.TL_PGDATA = ':memory:';
process.env.TL_ENCRYPTION_KEY = 'c'.repeat(64);

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const db = require('../src/db');
const sec = require('../src/crypto');
const auth = require('../src/auth');

async function makeWorker() {
  const id = await db.insert(
    `INSERT INTO worker (email, name, password_hash, role, status, service_status, created_at)
     VALUES (?,?,?,'worker','off','in_service',?)`,
    ['profile@test.org', 'Profile Tester', sec.hashPassword('x'.repeat(12)),
      '2026-05-16T00:00:00.000Z']);
  return db.get('SELECT * FROM worker WHERE id = ?', [id]);
}

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, () => resolve(server));
  });
}

function req(server, method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const r = http.request({ port: server.address().port, method, path,
      headers: { 'Content-Type': 'application/json', Cookie: cookie } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} }));
    });
    r.on('error', reject);
    r.end(body ? JSON.stringify(body) : undefined);
  });
}

let server, cookie;
test.before(async () => {
  await db.init();
  const w = await makeWorker();
  cookie = 'session=' + await auth.createSession(w.id);
  const { app } = require('../server');
  server = await listen(app);
});
test.after(() => server.close());

test('profile fields round-trip through save and /api/me', async () => {
  const photo = 'data:image/jpeg;base64,' + Buffer.from('tiny').toString('base64');
  const save = await req(server, 'POST', '/api/profile', {
    displayName: 'S12 Joel', title: 'Support Worker', gender: 'Male',
    pronouns: 'he/him', birthday: '1970-01-02', preferredLanguage: 'English',
    languages: 'English, 日本語', phone: '090-0000-0000',
    background: 'Chess and long walks.', privacy: true, photo,
  }, cookie);
  assert.strictEqual(save.status, 200);

  const me = (await req(server, 'GET', '/api/me', null, cookie)).body;
  assert.strictEqual(me.displayName, 'S12 Joel');
  assert.strictEqual(me.title, 'Support Worker');
  assert.strictEqual(me.gender, 'Male');
  assert.strictEqual(me.pronouns, 'he/him');
  assert.strictEqual(me.birthday, '1970-01-02');
  assert.strictEqual(me.preferredLanguage, 'English');
  assert.strictEqual(me.languages, 'English, 日本語');
  assert.strictEqual(me.background, 'Chess and long walks.');
  assert.strictEqual(me.photo, photo);
  assert.strictEqual(me.privacy, true);
  assert.strictEqual(me.serviceStatus, 'in_service');
  assert.strictEqual(me.dateStarted, '2026-05-16'); // falls back to created_at
});

test('photo must be a small image data URL; empty clears it', async () => {
  const bad = await req(server, 'POST', '/api/profile',
    { photo: 'data:text/html;base64,PHNjcmlwdD4=' }, cookie);
  assert.strictEqual(bad.status, 400);
  const huge = await req(server, 'POST', '/api/profile',
    { photo: 'data:image/jpeg;base64,' + 'A'.repeat(60_001) }, cookie);
  assert.strictEqual(huge.status, 400);

  const clear = await req(server, 'POST', '/api/profile', { photo: '' }, cookie);
  assert.strictEqual(clear.status, 200);
  const me = (await req(server, 'GET', '/api/me', null, cookie)).body;
  assert.strictEqual(me.photo, '');
});

test('fields not sent stay untouched', async () => {
  await req(server, 'POST', '/api/profile', { phone: '080-1111-2222' }, cookie);
  const me = (await req(server, 'GET', '/api/me', null, cookie)).body;
  assert.strictEqual(me.phone, '080-1111-2222');
  assert.strictEqual(me.title, 'Support Worker'); // unchanged from earlier test
});

test('totp/start includes a scannable QR data URL matching the otpauth', async () => {
  const r = await req(server, 'POST', '/api/totp/start', {}, cookie);
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.otpauth.startsWith('otpauth://totp/'));
  assert.ok(r.body.qr.startsWith('data:image/png;base64,'));
  assert.ok(r.body.qr.length > 500);
});
