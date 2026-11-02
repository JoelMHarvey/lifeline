'use strict';

process.env.TL_PGDATA = ':memory:';
process.env.TL_ENCRYPTION_KEY = 'a'.repeat(64);

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const db = require('../src/db');
const sec = require('../src/crypto');
const schedule = require('../src/schedule');
const auth = require('../src/auth');

let emailSeq = 0;
async function makeWorker(role = 'worker', service = 'in_service', name = null) {
  const id = await db.insert(
    `INSERT INTO worker (email, name, password_hash, role, status, service_status, created_at)
     VALUES (?,?,?,?,'off',?,?)`,
    [`af-${emailSeq++}@test.org`, name || `AF ${role} ${emailSeq}`,
      sec.hashPassword('x'.repeat(12)), role, service, db.now()]);
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

// 2028-02: starts on a Tuesday, 29 days (leap year).
const MONTH = '2028-02';

test('auto-fill respects shifts, weekdays, desired counts and never double-books a day', async () => {
  const anna = await makeWorker('worker', 'in_service', 'Anna');
  const bart = await makeWorker('worker', 'in_service', 'Bart');
  const tina = await makeWorker('trainee', 'in_service', 'Tina');
  const away = await makeWorker('worker', 'in_service', 'Away Al');

  // Anna: S1 Mondays only, wants 2. Bart: S1 and S2 any day, wants 4.
  // Tina is a trainee (never eligible for worker slots) and Away Al
  // submitted "away" (no shifts) — neither may appear in the draft.
  await schedule.submitAvailability(anna.id,
    { month: MONTH, canShifts: [1], canDays: { 1: [1] }, desiredShifts: 2 });
  await schedule.submitAvailability(bart.id,
    { month: MONTH, canShifts: [1, 2], desiredShifts: 4 });
  await schedule.submitAvailability(tina.id,
    { month: MONTH, canShifts: [1, 2], desiredShifts: 10 });
  await schedule.submitAvailability(away.id, { month: MONTH, canShifts: [] });

  // Six open worker slots: S1 on the first two Mondays and a Wednesday,
  // S2 on those same three days twice over... keep it simple: S1 ×3, S2 ×3.
  const dates = ['2028-02-07', '2028-02-14', '2028-02-02']; // Mon, Mon, Wed
  for (const d of dates) {
    for (const n of [1, 2]) {
      await db.insert(
        `INSERT INTO shift_slot (date, shift_number, role, created_at) VALUES (?,?,?,?)`,
        [d, n, 'worker', db.now()]);
    }
  }

  const { proposals, openLeft } = await schedule.proposeAssignments(MONTH);
  const names = (date, shift) =>
    proposals.filter((p) => p.date === date && p.shiftNumber === shift).map((p) => p.name);

  // Anna gets the Monday S1s (most unmet want per slot walked in order),
  // and never the Wednesday one or any S2.
  assert.deepStrictEqual(names('2028-02-07', 1), ['Anna']);
  assert.deepStrictEqual(names('2028-02-14', 1), ['Anna']);
  assert.deepStrictEqual(names('2028-02-02', 1), ['Bart']);
  // Nobody is double-booked on a date: Bart can't take S1 and S2 on the same day.
  for (const d of dates) {
    const onDay = proposals.filter((p) => p.date === d).map((p) => p.name);
    assert.strictEqual(new Set(onDay).size, onDay.length, `no double-booking on ${d}`);
  }
  // Tina and Away Al never appear.
  assert.ok(!proposals.some((p) => p.name === 'Tina' || p.name === 'Away Al'));
  // Bart caps at 4; Anna at 2 — 6 slots, Anna 2 + Bart max 4, but the
  // double-booking rule holds Bart to one slot per day (3 days) → 3.
  assert.strictEqual(proposals.filter((p) => p.name === 'Bart').length, 3);
  assert.strictEqual(openLeft, 6 - proposals.length);
});

test('apply assigns through the normal state, audits per slot, and is idempotent', async () => {
  const coord = await makeWorker('coordinator', 'in_service', 'Coord C');
  const coordCookie = 'session=' + await auth.createSession(coord.id);
  const worker = await makeWorker('worker');
  const workerCookie = 'session=' + await auth.createSession(worker.id);

  // Coordinator-only.
  assert.strictEqual((await call('POST', '/api/schedule/autofill',
    { month: MONTH }, workerCookie)).status, 403);

  const preview = await call('POST', '/api/schedule/autofill', { month: MONTH }, coordCookie);
  assert.strictEqual(preview.status, 200);
  const expected = preview.body.proposals.length;
  assert.ok(expected > 0);

  const applied = await call('POST', '/api/schedule/autofill',
    { month: MONTH, apply: true }, coordCookie);
  assert.strictEqual(applied.status, 200);
  assert.strictEqual(applied.body.assigned, expected);

  // The slots are ordinary assigned-awaiting-confirmation slots now.
  const sched = (await call('GET', '/api/schedule?month=' + MONTH, null, coordCookie)).body;
  assert.strictEqual(sched.slots.filter((s) => s.status === 'assigned').length, expected);

  // Audited: one entry per slot marked (auto-fill), plus the summary line.
  const audit = (await call('GET', '/api/schedule/audit', null, coordCookie)).body;
  assert.strictEqual(
    audit.filter((a) => a.action === 'slot_assigned' && /\(auto-fill\)$/.test(a.detail)).length,
    expected);
  const summary = audit.find((a) => a.action === 'schedule_autofilled');
  assert.match(summary.detail, new RegExp(`^${MONTH}: ${expected} assigned`));

  // Running it again finds nothing open to fill.
  const again = await call('POST', '/api/schedule/autofill',
    { month: MONTH, apply: true }, coordCookie);
  assert.strictEqual(again.body.assigned, 0);
});
