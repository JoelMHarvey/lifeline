'use strict';

process.env.TL_PGDATA = ':memory:';
process.env.TL_ENCRYPTION_KEY = 'b'.repeat(64);

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
    [`sa-${emailSeq++}@test.org`, `SA ${role} ${emailSeq}`,
      sec.hashPassword('x'.repeat(12)), role, service, db.now()]);
  return db.get('SELECT * FROM worker WHERE id = ?', [id]);
}

const sentMail = [];
let server;
let port;
test.before(async () => {
  mail._setTransportForTests(async (m) => { sentMail.push(m); return true; });
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

test('schedule audit trail: entries carry actor, slot and human detail; coordinator-only', async () => {
  const coord = await makeWorker('coordinator');
  const sup = await makeWorker('supervisor');
  const w = await makeWorker('worker');
  const coordCookie = 'session=' + await auth.createSession(coord.id);
  const supCookie = 'session=' + await auth.createSession(sup.id);

  // Produce a trail: create a slot, assign it, note it, submit availability.
  const created = await call('POST', '/api/schedule/slot',
    { date: '2026-12-05', shiftNumber: 2, role: 'worker' }, coordCookie);
  const slotId = created.body.id;
  await call('PATCH', '/api/schedule/slot/' + slotId, { workerId: Number(w.id) }, coordCookie);
  await call('PATCH', '/api/schedule/slot/' + slotId, { note: 'SS2' }, coordCookie);
  await call('POST', '/api/schedule/day-note',
    { date: '2026-12-05', note: 'Group 1 7pm' }, supCookie);
  await schedule.submitAvailability(w.id,
    { month: '2026-12', canShifts: [2], canDays: { 2: [1, 3] }, desiredShifts: 3 });

  // Coordinator reads it; supervisor and worker do not.
  assert.strictEqual((await call('GET', '/api/schedule/audit', null, supCookie)).status, 403);
  const r = await call('GET', '/api/schedule/audit', null, coordCookie);
  assert.strictEqual(r.status, 200);
  const rows = r.body;

  const assigned = rows.find((x) => x.action === 'slot_assigned');
  assert.strictEqual(assigned.actorName, coord.name);
  assert.strictEqual(assigned.slot, 'S2 2026-12-05');
  assert.strictEqual(assigned.what, 'assigned');
  assert.strictEqual(assigned.detail, `to ${w.name}`);

  assert.strictEqual(rows.find((x) => x.action === 'slot_note_set').detail, '"SS2"');
  const dayNote = rows.find((x) => x.action === 'day_note_set');
  assert.strictEqual(dayNote.actorName, sup.name);
  assert.strictEqual(dayNote.detail, '2026-12-05: Group 1 7pm');
  const avail = rows.find((x) => x.action === 'availability_submitted');
  assert.strictEqual(avail.actorName, w.name);
  assert.strictEqual(avail.detail, '2026-12: S2 (Mo We) · wants 3');
});

test('availability chase: missing list and reminder email to exactly those people', async () => {
  const sup = await makeWorker('supervisor');
  const submitted = await makeWorker('worker');
  const missing = await makeWorker('worker');
  const left = await makeWorker('worker', 'left'); // out of service — never chased
  const supCookie = 'session=' + await auth.createSession(sup.id);
  const workerCookie = 'session=' + await auth.createSession(submitted.id);
  await schedule.submitAvailability(submitted.id, { month: '2027-01', canShifts: [1] });

  // Staff see the gap list (names only); workers do not.
  assert.strictEqual(
    (await call('GET', '/api/availability/missing?month=2027-01', null, workerCookie)).status, 403);
  const r = await call('GET', '/api/availability/missing?month=2027-01', null, supCookie);
  assert.strictEqual(r.status, 200);
  const names = r.body.map((m) => m.name);
  assert.ok(names.includes(missing.name) && names.includes(sup.name), 'non-submitters listed');
  assert.ok(!names.includes(submitted.name), 'submitters not listed');
  assert.ok(!names.includes(left.name), 'people who left are not chased');
  assert.strictEqual(r.body[0].email, undefined, 'no addresses to the client');

  // The reminder mails exactly the missing people, prefs or not.
  sentMail.length = 0;
  const remind = await call('POST', '/api/availability/remind', { month: '2027-01' }, supCookie);
  assert.strictEqual(remind.status, 200);
  assert.strictEqual(remind.body.sent, remind.body.missing);
  const to = sentMail.map((m) => m.to);
  assert.ok(to.includes(missing.email) && !to.includes(submitted.email) && !to.includes(left.email));
  assert.match(sentMail[0].subject, /availability needed for 2027-01/);
  assert.strictEqual(
    (await call('POST', '/api/availability/remind', { month: '2027-01' }, workerCookie)).status, 403);

  // The chase itself lands in the trail.
  const coord = await makeWorker('coordinator');
  const coordCookie = 'session=' + await auth.createSession(coord.id);
  const audit = (await call('GET', '/api/schedule/audit', null, coordCookie)).body;
  const entry = audit.find((x) => x.action === 'availability_reminded');
  assert.strictEqual(entry.actorName, sup.name);
  assert.match(entry.detail, /^2027-01: \d+ of \d+ reminded$/);
});

test('schedule audit pages back with ?before=', async () => {
  const coord = await makeWorker('coordinator');
  const coordCookie = 'session=' + await auth.createSession(coord.id);
  for (let i = 0; i < 5; i++) {
    await call('POST', '/api/schedule/day-note',
      { date: `2027-02-0${i + 1}`, note: `note ${i}` }, coordCookie);
  }
  const first = (await call('GET', '/api/schedule/audit?limit=2', null, coordCookie)).body;
  assert.strictEqual(first.length, 2);
  assert.ok(first[0].id > first[1].id, 'newest first');
  const next = (await call('GET', `/api/schedule/audit?limit=2&before=${first[1].id}`,
    null, coordCookie)).body;
  assert.strictEqual(next.length, 2);
  assert.ok(next[0].id < first[1].id, 'strictly older than the last page');
  assert.match(next[0].detail, /^2027-02-03: note 2$/);
});
