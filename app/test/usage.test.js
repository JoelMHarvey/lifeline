'use strict';

process.env.TL_PGDATA = ':memory:';
process.env.TL_ENCRYPTION_KEY = 'e'.repeat(64);
process.env.CRON_SECRET = 'usage-test-secret';
process.env.TL_USAGE_EMAIL = 'usage@test.org';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const db = require('../src/db');
const sec = require('../src/crypto');
const mail = require('../src/mail');

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, () => resolve(server));
  });
}

function get(server, path) {
  return new Promise((resolve, reject) => {
    const r = http.request({ port: server.address().port, method: 'GET', path }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    r.on('error', reject);
    r.end();
  });
}

const sentMail = [];
let server;
test.before(async () => {
  mail._setTransportForTests(async (m) => { sentMail.push(m); return true; });
  await db.init();
  const { app } = require('../server');
  server = await listen(app);
});
test.after(() => { server.close(); server.closeAllConnections(); });

const usageMails = () => sentMail.filter((m) => m.subject === 'TELL Lifeline activity');

test('usage alert: baseline run is silent, activity is reported once, counts only', async () => {
  // First run only sets the baseline — nothing to compare against yet.
  const first = await get(server, '/api/cron/ops-check?secret=usage-test-secret');
  assert.strictEqual(first.status, 200);
  assert.strictEqual(usageMails().length, 0);
  assert.ok(await db.getConfig('usage_alert_last'), 'baseline mark stored');

  await new Promise((r) => setTimeout(r, 10));

  // Simulate a caller contact with a message, and a sign-in code request.
  const workerId = await db.insert(
    `INSERT INTO worker (email, name, password_hash, role, status, service_status, created_at)
     VALUES ('ua@test.org','Usage Tester',?, 'worker','off','in_service',?)`,
    [sec.hashPassword('x'.repeat(12)), db.now()]);
  const callerId = await db.insert(
    'INSERT INTO caller (token, first_seen) VALUES (?,?)', ['uatok', db.now()]);
  const contactId = await db.insert(
    `INSERT INTO contact (caller_id, program_id, chat_token, queued_at)
     VALUES (?,?,?,?)`,
    [callerId, await db.chatProgramId(), 'uachat', db.now()]);
  await db.run(
    'INSERT INTO message (contact_id, sender, body, sent_at) VALUES (?,?,?,?)',
    [contactId, 'caller', sec.encrypt('a very private message'), db.now()]);
  await db.run(
    `INSERT INTO login_code (worker_id, code_hash, created_at, expires_at)
     VALUES (?,?,?,?)`,
    [workerId, 'salt$deadbeef', db.now(), db.now()]);

  const second = await get(server, '/api/cron/ops-check?secret=usage-test-secret');
  assert.strictEqual(second.status, 200);
  assert.ok(second.body.info.includes('usage alert sent'), JSON.stringify(second.body));
  const mails = usageMails();
  assert.strictEqual(mails.length, 1);
  assert.strictEqual(mails[0].to, 'usage@test.org');
  assert.match(mails[0].text, /1 new caller contact\(s\)/);
  assert.match(mails[0].text, /1 caller message\(s\)/);
  assert.match(mails[0].text, /1 sign-in code\(s\) requested/);
  // Metadata only — never message content.
  assert.ok(!mails[0].text.includes('a very private message'));

  // Third run: nothing new since the mark advanced — stays silent.
  const third = await get(server, '/api/cron/ops-check?secret=usage-test-secret');
  assert.strictEqual(third.status, 200);
  assert.strictEqual(usageMails().length, 1);
});
