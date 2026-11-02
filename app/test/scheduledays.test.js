'use strict';

process.env.TL_PGDATA = ':memory:';
process.env.TL_ENCRYPTION_KEY = 'c'.repeat(64);

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const db = require('../src/db');
const sec = require('../src/crypto');
const schedule = require('../src/schedule');
const auth = require('../src/auth');

let emailSeq = 0;
async function makeWorker(role = 'worker') {
  const id = await db.insert(
    `INSERT INTO worker (email, name, password_hash, role, status, service_status, created_at)
     VALUES (?,?,?,?,'off','in_service',?)`,
    [`sd-${emailSeq++}@test.org`, `SD ${role} ${emailSeq}`,
      sec.hashPassword('x'.repeat(12)), role, db.now()]);
  return db.get('SELECT * FROM worker WHERE id = ?', [id]);
}

let server;
let port;
test.before(async () => {
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

// ---------------------------------------------------------------------------
// Weekday restrictions on availability

test('availability: canDays round-trips, is sanitised, and gates availableOn', async () => {
  const w = await makeWorker();
  await schedule.submitAvailability(w.id, {
    month: '2026-11',
    canShifts: [1, 3],
    canDays: {
      1: [1, 3, 3, 9, -1, 'x'],        // dupes and junk dropped → [1, 3]
      3: [0, 1, 2, 3, 4, 5, 6],        // all seven days = unrestricted → dropped
      5: [2],                          // shift not in canShifts → dropped
    },
  });
  const mine = (await schedule.availabilityFor('2026-11', w.id))[0];
  assert.deepStrictEqual(mine.canShifts, [1, 3]);
  assert.deepStrictEqual(mine.canDays, { 1: [1, 3] });

  // 2026-11-02 is a Monday (1), 2026-11-03 a Tuesday (2).
  assert.strictEqual(schedule.availableOn(mine, 1, '2026-11-02'), true);
  assert.strictEqual(schedule.availableOn(mine, 1, '2026-11-03'), false);
  assert.strictEqual(schedule.availableOn(mine, 3, '2026-11-03'), true, 'unrestricted shift');
  assert.strictEqual(schedule.availableOn(mine, 5, '2026-11-02'), false, 'unticked shift');
});

test('availability: entries submitted without canDays stay unrestricted', async () => {
  const w = await makeWorker();
  await schedule.submitAvailability(w.id, { month: '2026-11', canShifts: [2] });
  const mine = (await schedule.availabilityFor('2026-11', w.id))[0];
  assert.deepStrictEqual(mine.canDays, {});
  assert.strictEqual(schedule.availableOn(mine, 2, '2026-11-02'), true);
});

// ---------------------------------------------------------------------------
// Supervisors manage the calendar; generating the month stays coordinator-only

test('supervisors can book and edit slots; only coordinators generate the month', async () => {
  const sup = await makeWorker('supervisor');
  const coord = await makeWorker('coordinator');
  const worker = await makeWorker('worker');
  const supCookie = 'session=' + await auth.createSession(sup.id);
  const coordCookie = 'session=' + await auth.createSession(coord.id);
  const workerCookie = 'session=' + await auth.createSession(worker.id);

  // Supervisor adds a slot directly to the calendar...
  const created = await call('POST', '/api/schedule/slot',
    { date: '2026-11-07', shiftNumber: 4, role: 'supervisor' }, supCookie);
  assert.strictEqual(created.status, 200);
  const slotId = created.body.id;

  // ...assigns themselves to it, sets a note, and writes a day note.
  assert.strictEqual((await call('PATCH', '/api/schedule/slot/' + slotId,
    { workerId: Number(sup.id) }, supCookie)).status, 200);
  assert.strictEqual((await call('PATCH', '/api/schedule/slot/' + slotId,
    { note: 'WEBEX' }, supCookie)).status, 200);
  assert.strictEqual((await call('POST', '/api/schedule/day-note',
    { date: '2026-11-07', note: 'Supervision 7pm' }, supCookie)).status, 200);

  const sched = (await call('GET', '/api/schedule?month=2026-11', null, workerCookie)).body;
  const slot = sched.slots.find((s) => s.id === Number(slotId));
  assert.strictEqual(slot.workerId, Number(sup.id));
  assert.strictEqual(slot.note, 'WEBEX');
  assert.strictEqual(sched.dayNotes['2026-11-07'], 'Supervision 7pm');

  // Workers still cannot touch any of it.
  assert.strictEqual((await call('POST', '/api/schedule/slot',
    { date: '2026-11-08', shiftNumber: 1, role: 'worker' }, workerCookie)).status, 403);
  assert.strictEqual((await call('PATCH', '/api/schedule/slot/' + slotId,
    { note: 'nope' }, workerCookie)).status, 403);
  assert.strictEqual((await call('POST', '/api/schedule/day-note',
    { date: '2026-11-08', note: 'x' }, workerCookie)).status, 403);

  // Generating the month is the roster owner's job.
  assert.strictEqual((await call('POST', '/api/schedule/generate',
    { month: '2026-11' }, supCookie)).status, 403);
  assert.strictEqual((await call('POST', '/api/schedule/generate',
    { month: '2026-11' }, coordCookie)).status, 200);
});

test('schedule workers roster: staff get names, roles and email; workers get 403', async () => {
  const sup = await makeWorker('supervisor');
  const worker = await makeWorker('worker');
  const supCookie = 'session=' + await auth.createSession(sup.id);
  const workerCookie = 'session=' + await auth.createSession(worker.id);

  assert.strictEqual((await call('GET', '/api/schedule/workers', null, workerCookie)).status, 403);
  const r = await call('GET', '/api/schedule/workers', null, supCookie);
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.length >= 2);
  const row = r.body[0];
  // Email is included so staff can contact people about availability;
  // nothing else from the admin page crosses over.
  assert.ok(row.id && row.name && row.role && row.service_status && row.email);
  assert.strictEqual(row.phone, undefined);
  assert.strictEqual(row.totp_enabled, undefined);
});
