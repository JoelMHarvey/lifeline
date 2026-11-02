'use strict';

process.env.TL_PGDATA = ':memory:';
process.env.TL_ENCRYPTION_KEY = '9'.repeat(64);

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
    [`ocs-${emailSeq++}@test.org`, `OCS ${role} ${emailSeq}`,
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

const ocsOn = (slots, date) => slots
  .filter((s) => s.date === date && s.shiftNumber >= 8)
  .map((s) => `${s.start}-${s.end}`).sort();

test('default pattern matches the sheet: Fri night 21-02, weekends day+night, none Mon-Thu', async () => {
  const coord = await makeWorker('coordinator');
  await schedule.generateMonth('2028-03', coord.id);
  const slots = await schedule.monthSlots('2028-03');
  // 2028-03-01 is a Wednesday.
  assert.deepStrictEqual(ocsOn(slots, '2028-03-01'), [], 'Wednesday: no OCS');
  assert.deepStrictEqual(ocsOn(slots, '2028-03-03'), ['21:00-02:00'], 'Friday: night only, to 02:00');
  assert.deepStrictEqual(ocsOn(slots, '2028-03-04'), ['09:00-21:00', '21:00-09:00'], 'Saturday');
  assert.deepStrictEqual(ocsOn(slots, '2028-03-05'), ['09:00-21:00', '21:00-09:00'], 'Sunday');
  assert.ok(slots.filter((s) => s.shiftNumber >= 8).every((s) => s.role === 'supervisor'));

  // Friday's block is 5 hours and crosses midnight.
  const fri = slots.find((s) => s.date === '2028-03-03' && s.shiftNumber === 9);
  const row = await db.get('SELECT * FROM shift_slot WHERE id = ?', [fri.id]);
  const def = (await schedule.shiftDefs()).find((d) => d.number === 9);
  const span = schedule.slotSpan(def, row.date, schedule.slotTimes(def, row));
  assert.strictEqual((span.end - span.start) / 3_600_000, 5);
});

test('coordinator edits the weekly pattern; it drives new months, not existing slots', async () => {
  const coord = await makeWorker('coordinator');
  const sup = await makeWorker('supervisor');
  const coordCookie = 'session=' + await auth.createSession(coord.id);
  const supCookie = 'session=' + await auth.createSession(sup.id);

  // A slot generated under the old pattern keeps its hours.
  await schedule.generateMonth('2028-05', coord.id);
  const before = await schedule.monthSlots('2028-05');
  // 2028-05-05 is a Friday.
  assert.deepStrictEqual(ocsOn(before, '2028-05-05'), ['21:00-02:00']);

  // Supervisors can't change the pattern; bad times are rejected.
  assert.strictEqual((await call('PATCH', '/api/shift-defs/9',
    { days: { fri: ['21:00', '03:00'] } }, supCookie)).status, 403);
  assert.strictEqual((await call('PATCH', '/api/shift-defs/9',
    { days: { fri: ['9pm', '03:00'] } }, coordCookie)).status, 400);
  assert.strictEqual((await call('PATCH', '/api/shift-defs/2',
    { days: { fri: ['21:00', '03:00'] } }, coordCookie)).status, 400, 'worker shifts are not patterns');

  // Friday night now runs to 03:00, and Thursday gets a night block too.
  const ok = await call('PATCH', '/api/shift-defs/9', { days: {
    thu: ['21:00', '02:00'], fri: ['21:00', '03:00'],
    sat: ['21:00', '09:00'], sun: ['21:00', '09:00'] } }, coordCookie);
  assert.strictEqual(ok.status, 200);

  const after = await schedule.monthSlots('2028-05');
  assert.deepStrictEqual(ocsOn(after, '2028-05-05'), ['21:00-02:00'], 'existing slot unchanged');

  await schedule.generateMonth('2028-06', coord.id);
  const june = await schedule.monthSlots('2028-06');
  // 2028-06-01 is a Thursday, 2028-06-02 a Friday.
  assert.deepStrictEqual(ocsOn(june, '2028-06-01'), ['21:00-02:00']);
  assert.deepStrictEqual(ocsOn(june, '2028-06-02'), ['21:00-03:00']);

  // The change is in the coordinator's trail, in words.
  const audit = (await call('GET', '/api/schedule/audit', null, coordCookie)).body;
  const entry = audit.find((a) => a.action === 'shift_def_updated');
  assert.strictEqual(entry.detail,
    'OCS Night: Thu 21:00–02:00 · Fri 21:00–03:00 · Sat, Sun 21:00–09:00');
});

test('one slot\'s hours can be changed (and reset); the calendar feed follows them', async () => {
  const coord = await makeWorker('coordinator');
  const sup = await makeWorker('supervisor');
  const worker = await makeWorker('worker');
  const supCookie = 'session=' + await auth.createSession(sup.id);
  const coordCookie = 'session=' + await auth.createSession(coord.id);

  // Staff add a night block by hand on a Saturday: it carries 21:00-09:00.
  const created = await call('POST', '/api/schedule/slot',
    { date: '2028-07-01', shiftNumber: 9, role: 'worker' }, supCookie);
  assert.strictEqual(created.status, 200);
  const id = created.body.id;
  let slot = (await schedule.monthSlots('2028-07')).find((s) => s.id === id);
  assert.strictEqual(slot.role, 'supervisor');
  assert.strictEqual(`${slot.start}-${slot.end}`, '21:00-09:00');

  // Workers are not eligible for it; the supervisor is.
  assert.strictEqual((await call('PATCH', '/api/schedule/slot/' + id,
    { workerId: Number(worker.id) }, coordCookie)).status, 400);
  assert.strictEqual((await call('PATCH', '/api/schedule/slot/' + id,
    { workerId: Number(sup.id) }, coordCookie)).status, 200);

  // A supervisor shortens this one night; validation holds.
  assert.strictEqual((await call('PATCH', '/api/schedule/slot/' + id,
    { start: '21:00', end: '21:00' }, supCookie)).status, 400);
  assert.strictEqual((await call('PATCH', '/api/schedule/slot/' + id,
    { start: '21:00', end: '01:00' }, supCookie)).status, 200);
  slot = (await schedule.monthSlots('2028-07')).find((s) => s.id === id);
  assert.strictEqual(`${slot.start}-${slot.end}`, '21:00-01:00');

  // The supervisor's calendar feed carries the changed hours.
  const token = await schedule.calTokenFor(sup.id);
  const ics = await schedule.icsFor(token);
  // Shift times are Tokyo wall-clock (TELL's profile): 21:00-01:00 JST.
  assert.match(ics, /DTSTART:20280701T120000Z/);
  assert.match(ics, /DTEND:20280701T160000Z/);

  // A worker slot can be given one-off hours, then put back to standard.
  const ws = await call('POST', '/api/schedule/slot',
    { date: '2028-07-03', shiftNumber: 1, role: 'worker' }, supCookie);
  await call('PATCH', '/api/schedule/slot/' + ws.body.id,
    { start: '09:00', end: '11:00' }, supCookie);
  let w = (await schedule.monthSlots('2028-07')).find((s) => s.id === ws.body.id);
  assert.strictEqual(w.customTimes, true);
  assert.strictEqual(`${w.start}-${w.end}`, '09:00-11:00');
  await call('PATCH', '/api/schedule/slot/' + ws.body.id, { start: null, end: null }, supCookie);
  w = (await schedule.monthSlots('2028-07')).find((s) => s.id === ws.body.id);
  assert.strictEqual(w.customTimes, false);
  assert.strictEqual(`${w.start}-${w.end}`, '08:30-12:30');

  // Availability can't tick a supervision block; auto-fill never touches one.
  await schedule.submitAvailability(worker.id, { month: '2028-07', canShifts: [1, 8, 9] });
  assert.deepStrictEqual(
    (await schedule.availabilityFor('2028-07', worker.id))[0].canShifts, [1]);
  const { proposals } = await schedule.proposeAssignments('2028-07');
  assert.ok(proposals.every((p) => p.shiftNumber < 8));
});
