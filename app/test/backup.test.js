'use strict';

process.env.TL_PGDATA = ':memory:';
process.env.TL_ENCRYPTION_KEY = 'd'.repeat(64);
process.env.CRON_SECRET = 'backup-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const db = require('../src/db');
const sec = require('../src/crypto');
const auth = require('../src/auth');
const backup = require('../src/backup');

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, () => resolve(server));
  });
}

function get(server, path, cookie) {
  return new Promise((resolve, reject) => {
    const r = http.request({ port: server.address().port, method: 'GET', path,
      headers: { Cookie: cookie || '' } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on('error', reject);
    r.end();
  });
}

let server;
test.before(async () => {
  await db.init();
  const { app } = require('../server');
  server = await listen(app);
});
test.after(() => server.close());

test('backup round-trips: dump, wipe, restore, data and sequences intact', async () => {
  const workerId = await db.insert(
    `INSERT INTO worker (email, name, password_hash, role, status, service_status, created_at)
     VALUES ('bk@test.org','Backup Tester',?, 'worker','off','in_service',?)`,
    [sec.hashPassword('x'.repeat(12)), db.now()]);
  const callerId = await db.insert(
    'INSERT INTO caller (token, first_seen) VALUES (?,?)', ['bktok', db.now()]);
  const contactId = await db.insert(
    `INSERT INTO contact (caller_id, program_id, chat_token, worker_id, queued_at)
     VALUES (?,?,?,?,?)`,
    [callerId, await db.chatProgramId(), 'bkchat', workerId, db.now()]);
  await db.run(
    'INSERT INTO message (contact_id, sender, body, sent_at) VALUES (?,?,?,?)',
    [contactId, 'caller', sec.encrypt('hello backup'), db.now()]);

  const blob = await backup.exportEncrypted();
  assert.ok(blob.length > 1000);
  assert.ok(!blob.includes('hello backup'), 'blob is not plaintext');

  // Wipe, then restore from the blob.
  await db.run('DELETE FROM message');
  await db.run('DELETE FROM contact');
  await db.run('DELETE FROM caller');
  const counts = await backup.restore(backup.decryptExport(blob));
  assert.ok(counts.worker >= 1);
  assert.strictEqual(counts.message, 1);

  const msg = await db.get('SELECT body FROM message WHERE contact_id = ?', [contactId]);
  assert.strictEqual(sec.decrypt(msg.body), 'hello backup');

  // Sequences reset: a fresh insert gets a new id, not a collision.
  const again = await db.insert(
    'INSERT INTO caller (token, first_seen) VALUES (?,?)', ['bktok2', db.now()]);
  assert.ok(Number(again) > Number(callerId));
});

test('backup download needs a coordinator or the cron secret', async () => {
  assert.strictEqual((await get(server, '/api/admin/backup')).status, 401);

  const w = await db.get(`SELECT * FROM worker WHERE email = 'bk@test.org'`);
  const workerCookie = 'session=' + await auth.createSession(w.id);
  assert.strictEqual((await get(server, '/api/admin/backup', workerCookie)).status, 403);

  const viaSecret = await get(server, '/api/admin/backup?secret=backup-test-secret');
  assert.strictEqual(viaSecret.status, 200);
  assert.ok(viaSecret.headers['content-disposition'].includes('tell-backup-'));
  assert.ok(viaSecret.body.length > 1000);
  // And the download decrypts with the key.
  const parsed = backup.decryptExport(viaSecret.body);
  assert.strictEqual(parsed.format, backup.FORMAT);
});
