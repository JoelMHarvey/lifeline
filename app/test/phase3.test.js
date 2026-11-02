'use strict';

process.env.TL_PGDATA = ':memory:';
process.env.TL_ENCRYPTION_KEY = 'd'.repeat(64);

const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const sec = require('../src/crypto');
const schedule = require('../src/schedule');
const auth = require('../src/auth');
const board = require('../src/board');

let emailSeq = 0;
async function makeWorker(role = 'worker', service = 'in_service') {
  const id = await db.insert(
    `INSERT INTO worker (email, name, password_hash, role, status, service_status, created_at)
     VALUES (?,?,?,?,'off',?,?)`,
    [`p3-${emailSeq++}@test.org`, `P3 ${role} ${emailSeq}`,
      sec.hashPassword('x'.repeat(12)), role, service, db.now()]);
  return db.get('SELECT * FROM worker WHERE id = ?', [id]);
}

// ---------------------------------------------------------------------------
// Shift definitions

test('shift defs seed S1-S7 with the manual times; S3 varies by day', async () => {
  const defs = await schedule.shiftDefs();
  assert.strictEqual(defs.filter((d) => d.kind === 'worker').length, 7);
  // Plus the two On Call Supervisor 12-hour blocks.
  const ocs = defs.filter((d) => d.kind === 'supervision');
  assert.deepStrictEqual(ocs.map((d) => d.label), ['OCS Day', 'OCS Night']);
  assert.deepStrictEqual(ocs[1].days.fri, ['21:00', '02:00'], "Friday's night block ends 02:00");
  const s1 = defs.find((d) => d.number === 1);
  assert.strictEqual(s1.start, '08:30');
  assert.strictEqual(s1.takeover, '09:00');
  const s3 = defs.find((d) => d.number === 3);
  assert.strictEqual(schedule.modeOn(s3, '2026-09-16'), 'chat');   // Wednesday
  assert.strictEqual(schedule.modeOn(s3, '2026-09-13'), 'both');   // Sunday
  const s5 = defs.find((d) => d.number === 5);
  const span = schedule.slotSpan(s5, '2026-09-13');
  assert.strictEqual((span.end - span.start) / 3_600_000, 4, 'S5 crosses midnight, still 4h');
});

// ---------------------------------------------------------------------------
// Availability

test('availability: the most recent submission per worker/month wins', async () => {
  const w = await makeWorker();
  await schedule.submitAvailability(w.id,
    { month: '2026-10', canShifts: [1, 2], desiredShifts: 2 });
  await schedule.submitAvailability(w.id,
    { month: '2026-10', canShifts: [3, 4, 5], desiredShifts: 4, notes: 'NOT the 3rd Monday' });
  const all = await schedule.availabilityFor('2026-10');
  const mine = all.find((a) => a.workerId === Number(w.id));
  assert.deepStrictEqual(mine.canShifts, [3, 4, 5]);
  assert.strictEqual(mine.desiredShifts, 4);
  assert.strictEqual(mine.notes, 'NOT the 3rd Monday');
  const bad = await schedule.submitAvailability(w.id, { month: 'nope', canShifts: [] });
  assert.ok(bad.error);
});

// ---------------------------------------------------------------------------
// Slots: generation, assignment, confirmation, substitution

test('generateMonth creates one slot per shift per day, idempotently', async () => {
  const coord = await makeWorker('coordinator');
  const r1 = await schedule.generateMonth('2026-11', coord.id);
  // Worker seats follow TELL's sheet weekday pattern (DEFAULT_WEEK_SEATS):
  // Sun 10, Mon 8, Tue-Thu 5, Fri 6, Sat 10 a day. November 2026 has five
  // Sundays and Mondays, four of every other day. Plus On Call Supervisor
  // blocks: Fridays (night) and weekends (day + night).
  const workerSeats = 5 * 10 + 5 * 8 + 3 * 4 * 5 + 4 * 6 + 4 * 10;
  assert.strictEqual(r1.created, workerSeats + 4 * 1 + 4 * 2 + 5 * 2);
  const seats = async (date, n) => Number((await db.get(
    `SELECT COUNT(*) AS n FROM shift_slot WHERE date = ? AND shift_number = ? AND role = 'worker'`,
    [date, n])).n);
  assert.strictEqual(await seats('2026-11-03', 5), 0, 'no overnight chat shift on a Tuesday');
  assert.strictEqual(await seats('2026-11-07', 4), 4, 'four on Saturday evening');
  assert.strictEqual(await seats('2026-11-02', 7), 1, 'S7 runs Monday morning');
  const r2 = await schedule.generateMonth('2026-11', coord.id);
  assert.strictEqual(r2.created, 0, 'second run creates nothing');
});

test('assignment enforces role eligibility; confirm is assignee-only', async () => {
  const coord = await makeWorker('coordinator');
  const w = await makeWorker();
  const trainee = await makeWorker('trainee');
  const onLeave = await makeWorker('worker', 'on_leave');

  const slotId = await db.insert(
    `INSERT INTO shift_slot (date, shift_number, role, created_at) VALUES ('2026-12-01',4,'worker',?)`,
    [db.now()]);
  assert.ok((await schedule.assign(slotId, trainee.id, coord.id)).error, 'trainee blocked');
  assert.ok((await schedule.assign(slotId, onLeave.id, coord.id)).error, 'on-leave blocked');
  assert.deepStrictEqual(await schedule.assign(slotId, w.id, coord.id), { ok: true });

  assert.strictEqual(await schedule.confirm(slotId, trainee.id), false, 'not their slot');
  assert.strictEqual(await schedule.confirm(slotId, w.id), true);
  const s = await schedule.slotById(slotId);
  assert.strictEqual(s.status, 'confirmed');

  // Observer slots accept trainees; supervisor slots need supervisor+.
  const obsId = await db.insert(
    `INSERT INTO shift_slot (date, shift_number, role, created_at) VALUES ('2026-12-01',4,'observer',?)`,
    [db.now()]);
  assert.deepStrictEqual(await schedule.assign(obsId, trainee.id, coord.id), { ok: true });
  const supId = await db.insert(
    `INSERT INTO shift_slot (date, shift_number, role, created_at) VALUES ('2026-12-01',4,'supervisor',?)`,
    [db.now()]);
  assert.ok((await schedule.assign(supId, w.id, coord.id)).error, 'worker not supervisor');
});

test('substitution: assignee requests, eligible colleague takes, trainee cannot', async () => {
  const coord = await makeWorker('coordinator');
  const a = await makeWorker();
  const b = await makeWorker();
  const trainee = await makeWorker('trainee');
  const slotId = await db.insert(
    `INSERT INTO shift_slot (date, shift_number, role, created_at) VALUES ('2026-12-05',3,'worker',?)`,
    [db.now()]);
  await schedule.assign(slotId, a.id, coord.id);

  assert.ok((await schedule.requestSub(slotId, b)).error, 'only the assignee (or staff) can flag it');
  assert.deepStrictEqual(await schedule.requestSub(slotId, a), { ok: true });
  assert.ok((await schedule.takeSub(slotId, trainee)).error, 'trainee cannot take a worker slot');
  assert.ok((await schedule.takeSub(slotId, a)).error, 'cannot take your own');
  assert.deepStrictEqual(await schedule.takeSub(slotId, b), { ok: true });
  const s = await schedule.slotById(slotId);
  assert.strictEqual(Number(s.worker_id), Number(b.id));
  assert.strictEqual(s.status, 'assigned', 'the taker still has to confirm');
  assert.ok((await schedule.takeSub(slotId, a)).error, 'no longer up for cover');
});

test('unconfirmedNext24h flags assigned-not-confirmed and unstaffed slots in window', async () => {
  const coord = await makeWorker('coordinator');
  const w = await makeWorker();
  // Six hours from now on the organisation's (Tokyo) wall clock.
  const at = Date.now() + 6 * 3_600_000;
  const soon = new Date(at + require('../src/tz').offsetAt(at));
  const date = soon.toISOString().slice(0, 10);
  const hh = String(soon.getUTCHours()).padStart(2, '0');
  await db.run(
    `INSERT INTO shift_def (number, label, start_time, end_time, takeover_time, modes_json)
     VALUES (99,'Test shift',?,?,?, '{}') ON CONFLICT (number) DO NOTHING`,
    [hh + ':30', hh + ':45', hh + ':30']);
  const assignedId = await db.insert(
    `INSERT INTO shift_slot (date, shift_number, role, created_at) VALUES (?,99,'worker',?)`,
    [date, db.now()]);
  await schedule.assign(assignedId, w.id, coord.id);
  const openId = await db.insert(
    `INSERT INTO shift_slot (date, shift_number, role, created_at) VALUES (?,99,'worker',?)`,
    [date, db.now()]);
  const flagged = await schedule.unconfirmedNext24h();
  assert.ok(flagged.some((s) => s.id === assignedId && s.status === 'assigned'));
  assert.ok(flagged.some((s) => s.id === openId && s.status === 'open'));
  await schedule.confirm(assignedId, w.id);
  const after = await schedule.unconfirmedNext24h();
  assert.ok(!after.some((s) => s.id === assignedId), 'confirmed slot drops off');
  await db.run('UPDATE shift_def SET active = 0 WHERE number = 99');
});

test('stats: past assigned slots count as worked hours', async () => {
  const coord = await makeWorker('coordinator');
  const w = await makeWorker();
  for (const date of ['2026-09-01', '2026-09-02']) {
    const id = await db.insert(
      `INSERT INTO shift_slot (date, shift_number, role, created_at) VALUES (?,2,'worker',?)`,
      [date, db.now()]);
    await schedule.assign(id, w.id, coord.id);
  }
  const rows = await schedule.stats(w.id);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].worked, 2);
  assert.strictEqual(rows[0].hours, 8);
});

// ---------------------------------------------------------------------------
// ICS feed

test('ICS feed serves the worker my shifts under a private token', async () => {
  const coord = await makeWorker('coordinator');
  const w = await makeWorker();
  const date = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  const id = await db.insert(
    `INSERT INTO shift_slot (date, shift_number, role, created_at) VALUES (?,4,'worker',?)`,
    [date, db.now()]);
  await schedule.assign(id, w.id, coord.id);
  const token = await schedule.calTokenFor(w.id);
  assert.strictEqual(await schedule.calTokenFor(w.id), token, 'token is stable');
  const ics = await schedule.icsFor(token);
  assert.ok(ics.includes('BEGIN:VCALENDAR'));
  assert.ok(ics.includes(`UID:tell-slot-${id}@tell-lifeline`));
  assert.ok(ics.includes('TELL Shift 4'));
  assert.strictEqual(await schedule.icsFor('wrong-token'), null);
});

// ---------------------------------------------------------------------------
// Noticeboard

test('board: topics seed, posts encrypt at rest, unread counts move on read', async () => {
  const a = await makeWorker();
  const b = await makeWorker();
  const topics = await board.topicsFor(a.id);
  const names = topics.map((t) => t.name);
  assert.ok(names.includes("Workers' Notebook"));
  assert.ok(names.includes('Protocols & Key Numbers'));
  assert.ok(topics.find((t) => t.name === 'Protocols & Key Numbers').pinned);

  const notebook = topics.find((t) => t.name === "Workers' Notebook");
  const p = await board.post(notebook.id, a.id, 'SU may call back about housing resources');
  assert.ok(p.id);
  const raw = await db.get('SELECT body FROM board_post WHERE id = ?', [p.id]);
  assert.ok(raw.body.startsWith('g1$'), 'post encrypted at rest');
  assert.ok(!raw.body.includes('housing'));

  const forB = await board.topicsFor(b.id);
  assert.strictEqual(forB.find((t) => t.id === notebook.id).unread, 1);
  const read = await board.readTopic(notebook.id, b.id);
  assert.strictEqual(read.posts[read.posts.length - 1].body,
    'SU may call back about housing resources');
  const afterRead = await board.topicsFor(b.id);
  assert.strictEqual(afterRead.find((t) => t.id === notebook.id).unread, 0);
  // The author never sees their own post as unread.
  const forA = await board.topicsFor(a.id);
  assert.strictEqual(forA.find((t) => t.id === notebook.id).unread, 0);
});

test('board: duplicate topic names rejected; pin toggles', async () => {
  const sup = await makeWorker('supervisor');
  const t = await board.createTopic('Shift swaps', sup.id);
  assert.ok(t.id);
  const dup = await board.createTopic('Shift swaps', sup.id);
  assert.ok(dup.error);
  assert.strictEqual(await board.setPinned(t.id, true, sup.id), true);
  const topics = await board.topicsFor(sup.id);
  assert.ok(topics.find((x) => x.id === t.id).pinned);
});

test('slot notes and day notes round-trip through the schedule API', async () => {
  const { app } = require('../server');
  const server = await new Promise((resolve) => {
    const s = require('node:http').createServer(app);
    s.listen(0, () => resolve(s));
  });
  const port = server.address().port;
  const coord = await db.insert(
    `INSERT INTO worker (email, name, password_hash, role, status, service_status, created_at)
     VALUES ('notes-coord@test.org','Notes Coord',?, 'coordinator','off','in_service',?)`,
    [sec.hashPassword('x'.repeat(12)), db.now()]);
  const worker = await db.insert(
    `INSERT INTO worker (email, name, password_hash, role, status, service_status, created_at)
     VALUES ('notes-worker@test.org','Notes Worker',?, 'worker','off','in_service',?)`,
    [sec.hashPassword('x'.repeat(12)), db.now()]);
  const coordCookie = 'session=' + await auth.createSession(coord);
  const workerCookie = 'session=' + await auth.createSession(worker);
  const call = (method, path, body, cookie) => new Promise((resolve, reject) => {
    const r = require('node:http').request({ port, method, path,
      headers: { 'Content-Type': 'application/json', Cookie: cookie } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} }));
    });
    r.on('error', reject);
    r.end(body ? JSON.stringify(body) : undefined);
  });

  await schedule.ensureShiftsSeeded();
  const slotId = await db.insert(
    `INSERT INTO shift_slot (date, shift_number, role, status, created_at)
     VALUES ('2026-11-07', 3, 'worker', 'open', ?)`, [db.now()]);

  // Slot note: coordinator sets, everyone sees, empty clears.
  assert.strictEqual((await call('PATCH', '/api/schedule/slot/' + slotId,
    { note: 'SS2' }, coordCookie)).status, 200);
  assert.strictEqual((await call('PATCH', '/api/schedule/slot/' + slotId,
    { note: 'nope' }, workerCookie)).status, 403);
  let sched = (await call('GET', '/api/schedule?month=2026-11', null, workerCookie)).body;
  assert.strictEqual(sched.slots.find((s) => s.id === Number(slotId)).note, 'SS2');
  await call('PATCH', '/api/schedule/slot/' + slotId, { note: '' }, coordCookie);
  sched = (await call('GET', '/api/schedule?month=2026-11', null, workerCookie)).body;
  assert.strictEqual(sched.slots.find((s) => s.id === Number(slotId)).note, null);

  // Day note: set, read back, remove.
  assert.strictEqual((await call('POST', '/api/schedule/day-note',
    { date: '2026-11-07', note: 'Group 1 7pm' }, coordCookie)).status, 200);
  assert.strictEqual((await call('POST', '/api/schedule/day-note',
    { date: '2026-11-07', note: 'x' }, workerCookie)).status, 403);
  sched = (await call('GET', '/api/schedule?month=2026-11', null, workerCookie)).body;
  assert.strictEqual(sched.dayNotes['2026-11-07'], 'Group 1 7pm');
  await call('POST', '/api/schedule/day-note', { date: '2026-11-07', note: '' }, coordCookie);
  sched = (await call('GET', '/api/schedule?month=2026-11', null, coordCookie)).body;
  assert.strictEqual(sched.dayNotes['2026-11-07'], undefined);

  server.close();
  server.closeAllConnections();
});
