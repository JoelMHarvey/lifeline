'use strict';

process.env.TL_PGDATA = ':memory:';
process.env.TL_ENCRYPTION_KEY = 'd'.repeat(64);

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const db = require('../src/db');
const sec = require('../src/crypto');
const queue = require('../src/queue');

let emailSeq = 0;
async function makeWorker() {
  const id = await db.insert(
    `INSERT INTO worker (email, name, password_hash, role, status, service_status, created_at)
     VALUES (?,?,?,'worker','on_shift','in_service',?)`,
    [`leave-${emailSeq++}@test.org`, `Leaver ${emailSeq}`,
      sec.hashPassword('x'.repeat(12)), db.now()]);
  const w = await db.get('SELECT * FROM worker WHERE id = ?', [id]);
  await db.run('INSERT INTO worker_program (worker_id, program_id) VALUES (?, ?)',
    [id, await db.chatProgramId()]);
  return w;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, () => resolve(server));
  });
}

function post(server, path, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ port: server.address().port, method: 'POST', path,
      headers: { 'Content-Type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} }));
    });
    r.on('error', reject);
    r.end(JSON.stringify(body));
  });
}

let server;
test.before(async () => {
  await db.init();
  const { app } = require('../server');
  server = await listen(app);
});
test.after(() => server.close());

test('explicit leave on a claimed chat completes it and tells the worker', async () => {
  const w = await makeWorker();
  const { contactId, chatToken } = await queue.joinQueue({ triage: {} });
  assert.ok(await queue.claim(contactId, w));

  const r = await post(server, '/api/chat/leave', { chatToken, explicit: true });
  assert.strictEqual(r.status, 200);

  const c = await db.get('SELECT outcome, ended_at FROM contact WHERE id = ?', [contactId]);
  assert.strictEqual(c.outcome, 'completed');
  assert.ok(c.ended_at);
  const msgs = await db.all('SELECT sender, body FROM message WHERE contact_id = ?', [contactId]);
  const note = msgs.find((m) => m.sender === 'system');
  assert.ok(note, 'system note stored');
  assert.strictEqual(sec.decrypt(note.body), 'The caller left the chat.');
});

test('explicit leave while still waiting abandons the contact', async () => {
  const { contactId, chatToken } = await queue.joinQueue({ triage: {} });
  await post(server, '/api/chat/leave', { chatToken, explicit: true });
  const c = await db.get('SELECT outcome FROM contact WHERE id = ?', [contactId]);
  assert.strictEqual(c.outcome, 'abandoned');
});

test('the pagehide beacon still leaves a claimed chat open for the sweep', async () => {
  const w = await makeWorker();
  const { contactId, chatToken } = await queue.joinQueue({ triage: {} });
  assert.ok(await queue.claim(contactId, w));
  await post(server, '/api/chat/leave', { chatToken });
  const c = await db.get('SELECT outcome, caller_seen_at FROM contact WHERE id = ?', [contactId]);
  assert.strictEqual(c.outcome, null);
  assert.strictEqual(c.caller_seen_at, '1970-01-01T00:00:00.000Z');
});
