'use strict';

process.env.TL_PGDATA = ':memory:';
process.env.TL_ENCRYPTION_KEY = 'b'.repeat(64);

const test = require('node:test');
const assert = require('node:assert');
const sec = require('../src/crypto');

test('password hash verifies and rejects', () => {
  const h = sec.hashPassword('correct horse battery');
  assert.ok(h.startsWith('s1$'));
  assert.ok(sec.verifyPassword('correct horse battery', h));
  assert.ok(!sec.verifyPassword('wrong', h));
  assert.ok(!sec.verifyPassword('correct horse battery', 'garbage'));
  assert.notStrictEqual(h, sec.hashPassword('correct horse battery'), 'salted');
});

test('encrypt/decrypt round-trips and never stores plaintext', () => {
  const secret = 'the caller said something deeply private ここは日本語も';
  const ct = sec.encrypt(secret);
  assert.ok(ct.startsWith('g1$'));
  assert.ok(!ct.includes('private'));
  assert.strictEqual(sec.decrypt(ct), secret);
  assert.notStrictEqual(sec.encrypt(secret), ct, 'fresh IV every time');
  assert.strictEqual(sec.decrypt('plain old row'), 'plain old row');
});

test('tampered ciphertext fails closed', () => {
  const ct = sec.encrypt('hello');
  const parts = ct.split('$');
  const flipped = Buffer.from(parts[3], 'base64');
  flipped[0] ^= 0xff;
  parts[3] = flipped.toString('base64');
  assert.throws(() => sec.decrypt(parts.join('$')));
});

test('TOTP matches RFC 6238 test vector', () => {
  const secretB32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.strictEqual(sec.totpCode(secretB32, 59 * 1000), '287082');
  assert.ok(sec.verifyTotp(secretB32, '287082', 59 * 1000));
  assert.ok(sec.verifyTotp(secretB32, '287082', 75 * 1000), '±1 step window');
  assert.ok(!sec.verifyTotp(secretB32, '000000', 59 * 1000));
  assert.ok(!sec.verifyTotp(secretB32, 'abc', 59 * 1000));
});

test('new TOTP secrets are valid base32 and verifiable end to end', () => {
  const s = sec.newTotpSecret();
  assert.match(s, /^[A-Z2-7]+$/);
  const code = sec.totpCode(s);
  assert.ok(sec.verifyTotp(s, code));
});

test('login flow: password, TOTP requirement, left workers blocked', async () => {
  const db = require('../src/db');
  const auth = require('../src/auth');
  const id = await db.insert(
    `INSERT INTO worker (email, name, password_hash, role, created_at) VALUES (?,?,?,?,?)`,
    ['login@test.org', 'Login Test', sec.hashPassword('a-good-password'), 'worker', db.now()]);
  await db.run('INSERT INTO worker_program (worker_id, program_id) VALUES (?,?)',
    [id, await db.chatProgramId()]);

  assert.strictEqual(await auth.login('login@test.org', 'nope'), null);
  assert.strictEqual(await auth.login('nobody@test.org', 'a-good-password'), null);
  const ok = await auth.login('Login@Test.org ', 'a-good-password');
  assert.ok(ok && ok.token, 'email is case/space insensitive');
  assert.ok(await auth.workerFromToken(ok.token), 'session resolves');

  const secret = sec.newTotpSecret();
  await db.run('UPDATE worker SET totp_secret = ?, totp_enabled = 1 WHERE id = ?',
    [sec.encrypt(secret), id]);
  assert.deepStrictEqual(await auth.login('login@test.org', 'a-good-password'),
    { totpRequired: true });
  assert.strictEqual(await auth.login('login@test.org', 'a-good-password', '000000'), null);
  const mfa = await auth.login('login@test.org', 'a-good-password', sec.totpCode(secret));
  assert.ok(mfa && mfa.token, 'correct code logs in');

  await db.run(`UPDATE worker SET service_status = 'left' WHERE id = ?`, [id]);
  assert.strictEqual(
    await auth.login('login@test.org', 'a-good-password', sec.totpCode(secret)), null,
    'departed workers cannot log in');

  await auth.logout(ok.token);
  assert.strictEqual(await auth.workerFromToken(ok.token), null, 'logout ends session');
});

test('expired sessions are rejected', async () => {
  const db = require('../src/db');
  const auth = require('../src/auth');
  const w = await db.get('SELECT id FROM worker LIMIT 1');
  const token = await auth.createSession(w.id);
  await db.run('UPDATE session SET expires_at = ? WHERE token = ?',
    [new Date(Date.now() - 1000).toISOString(), token]);
  assert.strictEqual(await auth.workerFromToken(token), null);
});

test('rate limiter allows within window and blocks over it (DB-backed)', async () => {
  const rl = require('../src/ratelimit');
  for (let i = 0; i < 5; i++) assert.ok(await rl.allow('t:k', 5, 60_000));
  assert.ok(!(await rl.allow('t:k', 5, 60_000)), 'sixth call blocked');
  assert.ok(await rl.allow('t:other', 5, 60_000), 'other keys unaffected');
});
