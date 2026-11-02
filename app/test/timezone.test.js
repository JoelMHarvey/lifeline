'use strict';

// Shift times are wall-clock times where the helpline is (profile
// "timezone"). Calendar feeds, reminders and "next 24 hours" checks must use
// the real instant: TELL's 19:00 shift starts at 10:00 UTC.

process.env.TL_PROFILE = 'tell';
process.env.TL_PGDATA = ':memory:';
process.env.TL_ENCRYPTION_KEY = '2'.repeat(64);

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../src/db');
const tz = require('../src/tz');
const profile = require('../src/profile');

test.before(() => db.init());

test('wall-clock to UTC: Tokyo, London across DST, UTC', () => {
  const iso = (ms) => new Date(ms).toISOString();
  assert.strictEqual(iso(tz.wallToUtc('2026-11-03', '19:00', 'Asia/Tokyo')), '2026-11-03T10:00:00.000Z');
  assert.strictEqual(iso(tz.wallToUtc('2026-11-03', '01:30', 'Asia/Tokyo')), '2026-11-02T16:30:00.000Z');
  assert.strictEqual(iso(tz.wallToUtc('2026-07-01', '09:00', 'Europe/London')), '2026-07-01T08:00:00.000Z');
  assert.strictEqual(iso(tz.wallToUtc('2026-12-01', '09:00', 'Europe/London')), '2026-12-01T09:00:00.000Z');
  assert.strictEqual(iso(tz.wallToUtc('2026-07-01', '09:00', 'UTC')), '2026-07-01T09:00:00.000Z');
  assert.strictEqual(tz.dateIn(Date.parse('2026-11-03T20:00:00Z'), 'Asia/Tokyo'), '2026-11-04');
  assert.strictEqual(tz.dateIn(Date.parse('2026-11-03T20:00:00Z'), 'UTC'), '2026-11-03');
});

test('TELL shifts are Tokyo time: span, crossing midnight, calendar feed', async () => {
  assert.strictEqual(profile.profile().timezone, 'Asia/Tokyo');
  const schedule = require('../src/schedule');
  await schedule.ensureShiftsSeeded();
  const defs = await schedule.shiftDefs();
  const s4 = defs.find((d) => d.number === 4); // 19:00-23:00
  const s5 = defs.find((d) => d.number === 5); // 22:00-02:00
  const span4 = schedule.slotSpan(s4, '2026-11-03');
  assert.strictEqual(new Date(span4.start).toISOString(), '2026-11-03T10:00:00.000Z');
  const span5 = schedule.slotSpan(s5, '2026-11-03');
  assert.strictEqual(new Date(span5.end).toISOString(), '2026-11-03T17:00:00.000Z');
  assert.strictEqual(schedule.durationHours(s5), 4);

  const w = await db.insert(
    `INSERT INTO worker (email, name, password_hash, role, status, service_status, created_at)
     VALUES ('tz@test.org', 'Tz', 'x', 'worker', 'off', 'in_service', ?)`, [db.now()]);
  const date = tz.dateIn(Date.now() + 3 * 86_400_000);
  await db.insert(`INSERT INTO shift_slot (date, shift_number, role, worker_id, status, created_at)
    VALUES (?, 4, 'worker', ?, 'assigned', ?)`, [date, w, db.now()]);
  const ics = await schedule.icsFor(await schedule.calTokenFor(w));
  assert.ok(ics.includes(`DTSTART:${date.replace(/-/g, '')}T100000Z`), ics);
  assert.ok(ics.includes(`DTEND:${date.replace(/-/g, '')}T140000Z`));
});

test('the 24-hour window uses real time: a Tokyo 19:00 shift 8 hours away is in it', async () => {
  const schedule = require('../src/schedule');
  const date = '2030-05-10';
  const id = await db.insert(`INSERT INTO shift_slot (date, shift_number, role, status, created_at)
    VALUES (?, 4, 'worker', 'open', ?)`, [date, db.now()]);
  const start = Date.parse('2030-05-10T10:00:00Z'); // 19:00 JST
  const inWindow = await schedule.unconfirmedNext24h(start - 8 * 3_600_000);
  assert.ok(inWindow.some((s) => s.id === Number(id)));
  // An hour after the real start it has begun and drops out. (Reading 19:00
  // as UTC kept it listed for another nine hours.)
  const after = await schedule.unconfirmedNext24h(start + 3_600_000);
  assert.ok(!after.some((s) => s.id === Number(id)));
});

test('a profile with a bad timezone is refused', () => {
  const g = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'profiles', 'generic.json'), 'utf8'));
  const tmp = path.join(__dirname, '..', 'profiles', 'zz-tz-test.json');
  try {
    fs.writeFileSync(tmp, JSON.stringify({ ...g, id: 'zz-tz-test', timezone: 'Mars/Olympus' }));
    assert.throws(() => profile.load('zz-tz-test'), /"timezone" must be an IANA zone/);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test('the schedule page knows the organisation timezone', () => {
  const page = require('../src/site').render(profile.load('tell'))['schedule.js'];
  assert.ok(page.includes("timeZone: 'Asia/Tokyo'"));
});

test('daylight saving: skipped times move forward, repeated times take the first', () => {
  const iso = (ms) => new Date(ms).toISOString();
  // New York springs forward at 02:00 on 8 Mar 2026: 02:00 is 03:00 EDT.
  assert.strictEqual(iso(tz.wallToUtc('2026-03-08', '02:00', 'America/New_York')), '2026-03-08T07:00:00.000Z');
  // Santiago skips midnight on 6 Sep 2026: still the same day, 01:00.
  assert.strictEqual(iso(tz.wallToUtc('2026-09-06', '00:00', 'America/Santiago')), '2026-09-06T04:00:00.000Z');
  // Clocks going back: 01:30 happens twice; the first one counts.
  assert.strictEqual(iso(tz.wallToUtc('2026-11-01', '01:30', 'America/New_York')), '2026-11-01T05:30:00.000Z');
  assert.strictEqual(iso(tz.wallToUtc('2026-10-25', '01:30', 'Europe/London')), '2026-10-25T00:30:00.000Z');
  // Every wall time that exists converts back to the same clock time.
  for (const z of ['America/New_York', 'Europe/London', 'Australia/Sydney', 'Asia/Kathmandu']) {
    for (let t = Date.parse('2026-01-01T00:00:00Z'); t < Date.parse('2027-01-01T00:00:00Z'); t += 3 * 3_600_000) {
      const wall = new Date(t + tz.offsetAt(t, z)).toISOString();
      const back = tz.wallToUtc(wall.slice(0, 10), wall.slice(11, 16), z);
      // Same wall-clock time (in the repeated hour, its first occurrence).
      assert.strictEqual(new Date(back + tz.offsetAt(back, z)).toISOString(), wall, `${z} ${wall}`);
      assert.ok(back <= t);
    }
  }
  assert.strictEqual(iso(tz.dayStart(Date.parse('2026-11-03T20:00:00Z'), 'Asia/Tokyo')), '2026-11-03T15:00:00.000Z');
});

test('the 24-hour window spans the short spring-forward day', async () => {
  const g = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'profiles', 'generic.json'), 'utf8'));
  const tmp = path.join(__dirname, '..', 'profiles', 'zz-ny-test.json');
  const schedule = require('../src/schedule');
  fs.writeFileSync(tmp, JSON.stringify({ ...g, id: 'zz-ny-test', timezone: 'America/New_York' }));
  try {
    profile._set('zz-ny-test');
    // S1 08:30 on 14 Mar 2027 (spring forward) is 12:30 UTC. At 23:30 the
    // night before, "now + 24h" is already the 15th.
    const id = await db.insert(`INSERT INTO shift_slot (date, shift_number, role, status, created_at)
      VALUES ('2027-03-14', 1, 'worker', 'open', ?)`, [db.now()]);
    const now = tz.wallToUtc('2027-03-13', '23:30');
    const flagged = await schedule.unconfirmedNext24h(now);
    assert.ok(flagged.some((s) => s.id === Number(id)));
  } finally {
    profile._set();
    fs.rmSync(tmp, { force: true });
  }
});
