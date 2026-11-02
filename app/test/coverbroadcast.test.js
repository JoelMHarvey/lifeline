'use strict';

process.env.TL_PGDATA = ':memory:';
process.env.TL_ENCRYPTION_KEY = '6'.repeat(64);
process.env.TL_BASE_URL = 'https://tell.example.org/';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const db = require('../src/db');
const sec = require('../src/crypto');
const schedule = require('../src/schedule');
const auth = require('../src/auth');
const mail = require('../src/mail');

let emailSeq = 0;
async function makeWorker(role = 'worker', service = 'in_service') {
  const id = await db.insert(
    `INSERT INTO worker (email, name, password_hash, role, status, service_status, created_at)
     VALUES (?,?,?,?,'off',?,?)`,
    [`cb-${emailSeq++}@test.org`, `CB ${role} ${emailSeq}`,
      sec.hashPassword('x'.repeat(12)), role, service, db.now()]);
  return db.get('SELECT * FROM worker WHERE id = ?', [id]);
}

const sent = [];
let server;
let port;
test.before(async () => {
  mail._setTransportForTests(async (m) => { sent.push(m); return true; });
  await db.init();
  await schedule.ensureShiftsSeeded();
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

test('cover broadcast: templated, reaches exactly who could take it, once per 15 minutes', async () => {
  const sup = await makeWorker('supervisor');
  const holder = await makeWorker('worker');      // can't make it
  const free = await makeWorker('worker');        // should be asked
  const alsoOn = await makeWorker('worker');      // already on that shift
  const trainee = await makeWorker('trainee');    // can't take a worker seat
  const left = await makeWorker('worker', 'left');
  const supCookie = 'session=' + await auth.createSession(sup.id);
  const holderCookie = 'session=' + await auth.createSession(holder.id);

  // S4 on Saturday 24 Oct 2026: the holder plus a second worker.
  const slot = await db.insert(
    `INSERT INTO shift_slot (date, shift_number, role, worker_id, status, created_at)
     VALUES ('2026-10-24', 4, 'worker', ?, 'assigned', ?)`, [holder.id, db.now()]);
  await db.insert(
    `INSERT INTO shift_slot (date, shift_number, role, worker_id, status, created_at)
     VALUES ('2026-10-24', 4, 'worker', ?, 'assigned', ?)`, [alsoOn.id, db.now()]);

  // Not asking for cover yet: nothing to broadcast.
  assert.strictEqual((await call('GET', `/api/schedule/slot/${slot}/cover-broadcast`,
    null, supCookie)).status, 409);
  await call('POST', `/api/schedule/slot/${slot}/sub-request`, null, holderCookie);

  // Workers can't broadcast.
  assert.strictEqual((await call('GET', `/api/schedule/slot/${slot}/cover-broadcast`,
    null, holderCookie)).status, 403);

  const draft = (await call('GET', `/api/schedule/slot/${slot}/cover-broadcast`,
    null, supCookie)).body;
  assert.strictEqual(draft.subject, 'Cover needed: S4, Saturday 24 October, 19:00–23:00');
  assert.match(draft.body, /S4 · Saturday 24 October · 19:00–23:00 \(phone & chat\)/);
  assert.match(draft.body, /https:\/\/tell\.example\.org\/schedule\.html/);
  assert.match(draft.body, new RegExp(`Thank you,\\n${sup.name}$`));
  assert.ok(draft.recipients.includes(free.name));
  assert.ok(draft.recipients.includes(sup.name), 'staff can take worker seats too');
  for (const p of [holder, alsoOn, trainee, left]) {
    assert.ok(!draft.recipients.includes(p.name), `${p.name} not asked`);
  }

  // The sender can edit the message; each person gets their own email.
  sent.length = 0;
  const r = await call('POST', `/api/schedule/slot/${slot}/cover-broadcast`,
    { subject: draft.subject, body: draft.body + '\n\nPS: it\'s a quiet shift.' }, supCookie);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.sent, draft.recipients.length);
  assert.strictEqual(sent.length, draft.recipients.length);
  assert.ok(sent.every((m) => typeof m.to === 'string' && !m.to.includes(',')), 'one address each');
  assert.ok(sent.every((m) => m.text.endsWith("PS: it's a quiet shift.")));

  // A second send within 15 minutes is refused; the send is in the log.
  assert.strictEqual((await call('POST', `/api/schedule/slot/${slot}/cover-broadcast`,
    { subject: 'again', body: 'again' }, supCookie)).status, 429);
  const coord = await makeWorker('coordinator');
  const coordCookie = 'session=' + await auth.createSession(coord.id);
  const log = (await call('GET', '/api/schedule/audit', null, coordCookie)).body;
  const entry = log.find((e) => e.action === 'cover_broadcast');
  assert.strictEqual(entry.what, 'emailed everyone for cover');
  assert.strictEqual(entry.detail, `${sent.length} of ${sent.length} emailed`);
});
