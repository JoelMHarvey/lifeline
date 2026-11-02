'use strict';

process.env.TL_PGDATA = ':memory:';
process.env.TL_ENCRYPTION_KEY = 'e'.repeat(64);

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const db = require('../src/db');
const sec = require('../src/crypto');
const auth = require('../src/auth');
const mail = require('../src/mail');

let emailSeq = 0;
async function makeWorker(extra = {}) {
  const email = `code-${emailSeq++}@test.org`;
  const id = await db.insert(
    `INSERT INTO worker (email, name, password_hash, role, status, service_status,
       must_change_pw, created_at)
     VALUES (?,?,?,?,'off','in_service',?,?)`,
    [email, `Code Tester ${emailSeq}`, sec.hashPassword('x'.repeat(12)),
      extra.role || 'worker', extra.mustChangePw ? 1 : 0, db.now()]);
  return db.get('SELECT * FROM worker WHERE id = ?', [id]);
}

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, () => resolve(server));
  });
}

function req(server, method, path, body, cookie) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  return new Promise((resolve, reject) => {
    const r = http.request({ port: server.address().port, method, path, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data ? JSON.parse(data) : {},
        }));
      });
    r.on('error', reject);
    r.end(body ? JSON.stringify(body) : undefined);
  });
}

// Captures outbound mail instead of speaking SMTP.
const sentMail = [];
function codeFrom(msg) {
  return msg.text.match(/code is: (\d{6})/)[1];
}

let server;
test.before(async () => {
  await db.init();
  mail._setTransportForTests(async (msg) => { sentMail.push(msg); return true; });
  const { app } = require('../server');
  server = await listen(app);
});
test.after(() => server.close());
test.beforeEach(async () => {
  sentMail.length = 0;
  await db.run('DELETE FROM rate_limit');
});

test('unconfigured mail answers 503, not a silent nothing', async () => {
  mail._setTransportForTests(null);
  assert.strictEqual(mail.configured(), false);
  const w = await makeWorker();
  const r = await req(server, 'POST', '/api/login/code', { email: w.email });
  assert.strictEqual(r.status, 503);
  mail._setTransportForTests(async (msg) => { sentMail.push(msg); return true; });
});

test('unknown email gets the same ok answer and no mail', async () => {
  const r = await req(server, 'POST', '/api/login/code', { email: 'nobody@test.org' });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body, { ok: true });
  assert.strictEqual(sentMail.length, 0);
});

test('full round trip: request, verify, session works, no forced password change', async () => {
  const w = await makeWorker({ mustChangePw: true });
  const r1 = await req(server, 'POST', '/api/login/code', { email: w.email });
  assert.strictEqual(r1.status, 200);
  assert.strictEqual(sentMail.length, 1);
  assert.strictEqual(sentMail[0].to, w.email);
  const code = codeFrom(sentMail[0]);

  const bad = await req(server, 'POST', '/api/login/code/verify',
    { email: w.email, code: code === '000000' ? '000001' : '000000' });
  assert.strictEqual(bad.status, 401);

  const good = await req(server, 'POST', '/api/login/code/verify', { email: w.email, code });
  assert.strictEqual(good.status, 200);
  assert.strictEqual(good.body.mustChangePw, false);
  const cookie = good.headers['set-cookie'][0].split(';')[0];
  const me = await req(server, 'GET', '/api/me', null, cookie);
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.body.name, w.name);
});

test('a code works exactly once', async () => {
  const w = await makeWorker();
  await req(server, 'POST', '/api/login/code', { email: w.email });
  const code = codeFrom(sentMail[0]);
  const first = await req(server, 'POST', '/api/login/code/verify', { email: w.email, code });
  assert.strictEqual(first.status, 200);
  const again = await req(server, 'POST', '/api/login/code/verify', { email: w.email, code });
  assert.strictEqual(again.status, 401);
});

test('five wrong guesses burn the code even if the sixth is right', async () => {
  const w = await makeWorker();
  await req(server, 'POST', '/api/login/code', { email: w.email });
  const code = codeFrom(sentMail[0]);
  const wrong = code === '999999' ? '999998' : '999999';
  for (let i = 0; i < 5; i++) {
    await db.run('DELETE FROM rate_limit'); // isolate the attempt cap from the IP limit
    const r = await req(server, 'POST', '/api/login/code/verify', { email: w.email, code: wrong });
    assert.strictEqual(r.status, 401);
  }
  await db.run('DELETE FROM rate_limit');
  const r = await req(server, 'POST', '/api/login/code/verify', { email: w.email, code });
  assert.strictEqual(r.status, 401);
});

test('expired codes are refused', async () => {
  const w = await makeWorker();
  await req(server, 'POST', '/api/login/code', { email: w.email });
  const code = codeFrom(sentMail[0]);
  await db.run('UPDATE login_code SET expires_at = ? WHERE worker_id = ?',
    [new Date(Date.now() - 1000).toISOString(), w.id]);
  const r = await req(server, 'POST', '/api/login/code/verify', { email: w.email, code });
  assert.strictEqual(r.status, 401);
});

test('a new code replaces the previous one', async () => {
  const w = await makeWorker();
  await req(server, 'POST', '/api/login/code', { email: w.email });
  const oldCode = codeFrom(sentMail[0]);
  await req(server, 'POST', '/api/login/code', { email: w.email });
  const newCode = codeFrom(sentMail[1]);
  if (oldCode !== newCode) {
    const r = await req(server, 'POST', '/api/login/code/verify', { email: w.email, code: oldCode });
    assert.strictEqual(r.status, 401);
  }
  await db.run('DELETE FROM rate_limit');
  const r2 = await req(server, 'POST', '/api/login/code/verify', { email: w.email, code: newCode });
  assert.strictEqual(r2.status, 200);
});

test('an authenticator-protected account still asks for its TOTP', async () => {
  const w = await makeWorker();
  const secret = sec.newTotpSecret();
  await db.run('UPDATE worker SET totp_secret = ?, totp_enabled = 1 WHERE id = ?',
    [sec.encrypt(secret), w.id]);
  await req(server, 'POST', '/api/login/code', { email: w.email });
  const code = codeFrom(sentMail[0]);

  const r1 = await req(server, 'POST', '/api/login/code/verify', { email: w.email, code });
  assert.strictEqual(r1.status, 401);
  assert.strictEqual(r1.body.totpRequired, true);

  const r2 = await req(server, 'POST', '/api/login/code/verify',
    { email: w.email, code, totp: sec.totpCode(secret) });
  assert.strictEqual(r2.status, 200);
});

test('left workers never receive codes', async () => {
  const w = await makeWorker();
  await db.run(`UPDATE worker SET service_status = 'left' WHERE id = ?`, [w.id]);
  const r = await req(server, 'POST', '/api/login/code', { email: w.email });
  assert.strictEqual(r.status, 200); // same generic answer
  assert.strictEqual(sentMail.length, 0);
});

test('per-address rate limit holds', async () => {
  const w = await makeWorker();
  for (let i = 0; i < 3; i++) {
    const r = await req(server, 'POST', '/api/login/code', { email: w.email });
    assert.strictEqual(r.status, 200);
  }
  const r4 = await req(server, 'POST', '/api/login/code', { email: w.email });
  assert.strictEqual(r4.status, 429);
});
