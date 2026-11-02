'use strict';

// Scheduling at TELL's real size: 150 volunteers, a month of availability,
// auto-fill. Checks the draft is safe (no overlaps, nobody past their count)
// and fair (shared out, not piled on a few), and that it stays quick.

process.env.TL_PGDATA = ':memory:';
process.env.TL_ENCRYPTION_KEY = '7'.repeat(64);

const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const sec = require('../src/crypto');
const schedule = require('../src/schedule');
const mail = require('../src/mail');

const MONTH = '2026-11';
let seed = 42; // deterministic "random" volunteers
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (a) => a[Math.floor(rnd() * a.length)];

test.before(async () => {
  await db.init();
  mail._setTransportForTests(async () => true);
});

async function person(i, role, extra = {}) {
  return db.insert(
    `INSERT INTO worker (email, name, password_hash, role, status, service_status, created_at)
     VALUES (?,?,?,?,'off','in_service',?)`,
    [`scale-${i}@test.org`, extra.name || `Scale ${String(i).padStart(3, '0')}`,
      sec.hashPassword('x'.repeat(12)), role, db.now()]);
}

test('auto-fill never gives one person shifts whose hours overlap', async () => {
  // Sunday S5 runs 22:00-02:00, into Monday S6 (01:30-05:30): different
  // dates, same night.
  const id = await person(900, 'worker', { name: 'Night Owl' });
  await schedule.submitAvailability(id, {
    month: '2027-02', canShifts: [5, 6], canDays: { 5: [0], 6: [1] }, desiredShifts: 20 });
  await schedule.generateMonth('2027-02', id);
  const { proposals } = await schedule.proposeAssignments('2027-02');
  const mine = proposals.filter((p) => p.workerId === id);
  assert.ok(mine.length >= 4);
  const s5 = new Set(mine.filter((p) => p.shiftNumber === 5).map((p) => p.date));
  for (const p of mine.filter((q) => q.shiftNumber === 6)) {
    const before = new Date(Date.parse(p.date) - 86_400_000).toISOString().slice(0, 10);
    assert.ok(!s5.has(before), `S6 ${p.date} overlaps S5 ${before}`);
  }
});

test('150 volunteers: the month is filled safely, shared out, and quickly', async () => {
  const ids = [];
  for (let i = 0; i < 150; i++) {
    ids.push(await person(i, i < 3 ? 'coordinator' : i < 15 ? 'supervisor' : i < 30 ? 'trainee' : 'worker'));
  }
  const popular = [1, 1, 2, 2, 3, 3, 4, 4, 4, 2, 5, 6, 7, 1, 3, 4];
  for (let i = 3; i < 150; i++) {
    if (rnd() > 0.85) continue;
    if (rnd() < 0.08) { await schedule.submitAvailability(ids[i], { month: MONTH, canShifts: [] }); continue; }
    const shifts = [...new Set(Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(popular)))];
    const canDays = {};
    for (const s of shifts) {
      if (rnd() < 0.55) canDays[s] = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => Math.floor(rnd() * 7));
    }
    await schedule.submitAvailability(ids[i], { month: MONTH, canShifts: shifts, canDays,
      desiredShifts: rnd() < 0.15 ? null : 2 + Math.floor(rnd() * 5) });
  }
  // Two seats per shift (phone and chat lines), so supply and demand are close.
  await schedule.generateMonth(MONTH, ids[0]);
  for (const r of await db.all(
    `SELECT date, shift_number FROM shift_slot WHERE date LIKE ? AND role = 'worker'`, [MONTH + '-%'])) {
    await db.insert(`INSERT INTO shift_slot (date, shift_number, role, created_at) VALUES (?,?,'worker',?)`,
      [r.date, r.shift_number, db.now()]);
  }

  const t0 = Date.now();
  const draft = await schedule.proposeAssignments(MONTH);
  const applied = await schedule.applyAssignments(MONTH, ids[0]);
  const ms = Date.now() - t0;
  assert.ok(ms < 15_000, `preview + apply took ${ms}ms`);
  assert.strictEqual(applied.assigned, draft.proposals.length);
  assert.strictEqual(draft.unstatedMax, 4);

  const defs = new Map((await schedule.shiftDefs()).map((d) => [d.number, d]));
  const slots = await db.all(
    `SELECT * FROM shift_slot WHERE date LIKE ? AND worker_id IS NOT NULL`, [MONTH + '-%']);
  const avail = new Map((await schedule.availabilityFor(MONTH)).map((a) => [a.workerId, a]));
  const per = new Map();
  for (const s of slots) {
    const d = defs.get(Number(s.shift_number));
    const start = Date.parse(`${s.date}T${d.start}:00Z`);
    const end = Date.parse(`${s.date}T${d.end}:00Z`) + (d.end <= d.start ? 86_400_000 : 0);
    if (!per.has(Number(s.worker_id))) per.set(Number(s.worker_id), []);
    per.get(Number(s.worker_id)).push({ s, start, end });
  }
  for (const [id, list] of per) {
    const a = avail.get(id);
    list.sort((x, y) => x.start - y.start);
    for (let i = 1; i < list.length; i++) {
      assert.ok(list[i].start >= list[i - 1].end, `overlap for worker ${id}`);
      assert.notStrictEqual(list[i].s.date, list[i - 1].s.date, `two shifts on one date for ${id}`);
    }
    for (const { s } of list) assert.ok(a.canShifts.includes(Number(s.shift_number)));
    assert.ok(list.length <= (a.desiredShifts ?? 4), `worker ${id} past their count`);
  }

  // Shared out: nearly everyone who offered gets something, and nobody hoards.
  const trainees = new Set((await db.all(`SELECT id FROM worker WHERE role = 'trainee'`)).map((r) => Number(r.id)));
  // Trainees take observation/supervised seats by hand, never worker slots.
  const offering = [...avail.values()].filter((a) => a.canShifts.length && !trainees.has(a.workerId));
  const none = offering.filter((a) => !per.has(a.workerId));
  assert.ok(offering.length > 90);
  assert.ok(none.length <= offering.length * 0.05, `${none.length} of ${offering.length} got nothing`);
  assert.deepStrictEqual(draft.offeredButNone.length, none.length);
  assert.ok(Math.max(...[...per.values()].map((l) => l.length)) <= 6);
});
