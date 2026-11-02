'use strict';

process.env.TL_PGDATA = ':memory:';
process.env.TL_ENCRYPTION_KEY = '8'.repeat(64);

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const db = require('../src/db');
const sec = require('../src/crypto');
const auth = require('../src/auth');

let emailSeq = 0;
async function makeWorker(role = 'worker') {
  const id = await db.insert(
    `INSERT INTO worker (email, name, password_hash, role, status, service_status, created_at)
     VALUES (?,?,?,?,'off','in_service',?)`,
    [`ph-${emailSeq++}@test.org`, `PH ${role} ${emailSeq}`,
      sec.hashPassword('x'.repeat(12)), role, db.now()]);
  return db.get('SELECT * FROM worker WHERE id = ?', [id]);
}

let server;
let port;
test.before(async () => {
  await db.init();
  const { app } = require('../server');
  server = await new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, () => resolve(s));
  });
  port = server.address().port;
});
test.after(() => { server.close(); server.closeAllConnections(); });

const call = (method, path, body, cookie) => new Promise((resolve, reject) => {
  const r = http.request({ port, method, path,
    headers: { 'Content-Type': 'application/json', Cookie: cookie } }, (res) => {
    let data = '';
    res.on('data', (c) => { data += c; });
    res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} }));
  });
  r.on('error', reject);
  r.end(body ? JSON.stringify(body) : undefined);
});


const { snapshot } = require('../src/stats');
const resource = async () => db.insert(
  `INSERT INTO resource (name, category, status, created_at) VALUES ('Help', 'x', 'active', ?)`, [db.now()]);

test('phone intake: starts blank, saves, submits and finishes the call', async () => {
  const w = await makeWorker('worker');
  const cookie = 'session=' + await auth.createSession(w.id);

  const start = await call('POST', '/api/phone-intake', null, cookie);
  assert.strictEqual(start.status, 200);
  const d = start.body;
  assert.strictEqual(d.channel, 'phone');
  assert.deepStrictEqual([d.triage, d.prechat, d.messages, d.intake], [{}, [], [], {}]);
  assert.ok(d.form && d.form.schema, 'the intake form comes with it');
  // Asking again (a reload, a double click) returns the same open intake.
  assert.strictEqual((await call('POST', '/api/phone-intake', null, cookie)).body.contactId, d.contactId);
  // It shows up for resume, marked as phone; it isn't an "active chat".
  const mine = (await call('GET', '/api/my-chats', null, cookie)).body;
  assert.deepStrictEqual(mine.map((c) => [c.contactId, c.channel]), [[d.contactId, 'phone']]);
  assert.strictEqual((await snapshot()).active_chats, 0);

  // A worker on a phone intake can still be given a chat.
  const callerId = await db.insert(
    `INSERT INTO caller (token, alias, first_seen) VALUES ('tok-ph-1', 'Sky', ?)`, [db.now()]);
  const chatId = await db.insert(
    `INSERT INTO contact (caller_id, chat_token, queued_at) VALUES (?, 'chat-ph-1', ?)`, [callerId, db.now()]);
  assert.strictEqual((await call('POST', `/api/claim/${chatId}`, null, cookie)).status, 200);
  await call('POST', `/api/end/${chatId}`, null, cookie);

  const form = { form: d.form.name, version: d.form.version };
  const draft = await call('PATCH', `/api/intake/${d.contactId}`,
    { intake: { ...form, answers: { age: 'x' } } }, cookie);
  assert.deepStrictEqual(draft.body, { ok: true, status: 'draft' });
  const sub = await call('PATCH', `/api/intake/${d.contactId}`,
    { intake: { ...form, answers: { age: 'x', notes: 'called about work' } }, submit: true }, cookie);
  assert.strictEqual(sub.body.status, 'submitted');
  let row = await db.get('SELECT * FROM contact WHERE id = ?', [d.contactId]);
  assert.deepStrictEqual([row.intake_status, row.outcome, row.queue_wait_secs, row.channel],
    ['submitted', 'completed', null, 'phone']);
  assert.ok(row.ended_at);

  // An autosave landing just after Submit doesn't turn it back into a draft.
  await call('PATCH', `/api/intake/${d.contactId}`,
    { intake: { ...form, answers: { age: 'x', notes: 'called about work' } } }, cookie);
  row = await db.get('SELECT intake_status FROM contact WHERE id = ?', [d.contactId]);
  assert.strictEqual(row.intake_status, 'submitted');
  assert.strictEqual((await call('DELETE', `/api/phone-intake/${d.contactId}`, null, cookie)).status, 409);

  // The next press starts a fresh one.
  const next = (await call('POST', '/api/phone-intake', null, cookie)).body;
  assert.notStrictEqual(next.contactId, d.contactId);
});

test('phone intake: discard throws it away; only its owner can', async () => {
  const w = await makeWorker('worker');
  const other = await makeWorker('worker');
  const cookie = 'session=' + await auth.createSession(w.id);
  const otherCookie = 'session=' + await auth.createSession(other.id);
  const trainee = await makeWorker('trainee');
  const trCookie = 'session=' + await auth.createSession(trainee.id);
  assert.strictEqual((await call('POST', '/api/phone-intake', null, trCookie)).status, 403);

  const d = (await call('POST', '/api/phone-intake', null, cookie)).body;
  const rid = await resource();
  assert.strictEqual((await call('POST', '/api/referral',
    { contactId: d.contactId, resourceId: rid }, cookie)).status, 200);
  assert.strictEqual((await call('DELETE', `/api/phone-intake/${d.contactId}`, null, otherCookie)).status, 404);
  assert.strictEqual((await call('DELETE', `/api/phone-intake/${d.contactId}`, null, cookie)).status, 200);
  assert.strictEqual(await db.get('SELECT id FROM contact WHERE id = ?', [d.contactId]), null);
  assert.strictEqual(await db.get('SELECT id FROM caller WHERE id = ?', [d.callerId]), null);
  assert.ok(await db.get(`SELECT 1 FROM audit_log WHERE action = 'phone_intake_discarded'`));
  assert.deepStrictEqual((await call('GET', '/api/my-chats', null, cookie)).body, []);
});
