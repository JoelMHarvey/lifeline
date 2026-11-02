'use strict';

// Phase 3 shift calendar. The rules come straight from TELL Manual ch.24:
// shifts S1-S7 with fixed takeover times, monthly
// availability with an "Only, Nots and Also" line, confirmation before the
// shift, and worker-owned substitution — a worker who can't make a shift
// requests cover, and any eligible colleague takes it (staff are notified;
// there is no blocking approval step, matching the manual's actual practice).

const crypto = require('node:crypto');
const db = require('./db');
const { log } = require('./log');
const { notify } = require('./notify');
const profile = require('./profile');
const tz = require('./tz');

// The shift pattern a new database starts with: the organisation's
// (profiles/<id>.json schedule.shifts / supervision / weekSeats — for TELL,
// Manual ch.24's S1-S7, the On Call Supervisor blocks from the scheduling
// sheet and the sheet's seats per weekday). Seeded once; after that they are
// rows the coordinator owns, so changing the profile never rewrites them.
//   shifts:      [number, label, start, end, takeover, {weekday|default: mode}]
//   supervision: [number, label, start, end, {weekday: [start, end]}] — On
//                Call Supervisor cover; a weekday that is absent is off, and
//                only staff can be assigned
//   weekSeats:   {shift number: {weekday: seats}}, 0 = the shift doesn't run
const sched = () => profile.profile().schedule;
const WEEK_SEATS_SEEDED = 'seed:week_seats_v1';
const MAX_SEATS = 6;

// Support group: "S08", "8", "08", "group 8" → 8; blank → null; anything
// else → undefined (invalid). Groups run 1-99. The letter is the profile's
// schedule.groupPrefix ("S" for TELL); null turns the naming off.
const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function parseGroup(v) {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  if (!t) return null;
  const prefix = sched().groupPrefix;
  const re = prefix ? new RegExp(`^(?:${escRe(prefix)}|group\\s*)?0*(\\d{1,2})$`, 'i')
    : /^(?:group\s*)?0*(\d{1,2})$/i;
  const m = t.match(re);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n >= 1 && n <= 99 ? n : undefined;
}

// iCarol and the sheet put the group in front of the name ("S08 Alex M");
// split it off so the name is stored once and the group as a number.
function splitGroupPrefix(name) {
  const prefix = sched().groupPrefix;
  const m = prefix && String(name || '').trim().match(new RegExp(`^${escRe(prefix)}(\\d{2})\\s+(.+)$`));
  return m ? { name: m[2].trim(), group: Number(m[1]) } : { name: String(name || '').trim(), group: null };
}

const groupTag = (n) => (n && sched().groupPrefix ? sched().groupPrefix + String(n).padStart(2, '0') : '');

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const isHHMM = (t) => HHMM.test(String(t || ''));

let seeded = null; // once per process: the checks below are writes-if-missing

async function ensureShiftsSeeded() {
  if (seeded) return seeded;
  seeded = (async () => {
    const row = await db.get('SELECT number FROM shift_def LIMIT 1');
    if (!row) {
      for (const [number, label, start, end, takeover, modes] of sched().shifts) {
        await db.run(
          `INSERT INTO shift_def (number, label, start_time, end_time, takeover_time, modes_json)
           VALUES (?,?,?,?,?,?) ON CONFLICT (number) DO NOTHING`,
          [number, label, start, end, takeover, JSON.stringify(modes)]);
      }
    }
    // Supervision blocks seed separately so databases created before they
    // existed pick them up too; blocks seeded before weekly patterns existed
    // get the sheet's pattern once (an edited pattern is never null again).
    for (const [number, label, start, end, days] of sched().supervision) {
      await db.run(
        `INSERT INTO shift_def (number, label, start_time, end_time, takeover_time, modes_json, kind, days_json)
         VALUES (?,?,?,?,?,?,'supervision',?) ON CONFLICT (number) DO NOTHING`,
        [number, label, start, end, start, '{}', JSON.stringify(days)]);
      await db.run(
        `UPDATE shift_def SET days_json = ? WHERE number = ? AND kind = 'supervision'
           AND days_json IS NULL`, [JSON.stringify(days), number]);
    }
    // Weekday seats: once per database, and only onto shifts nobody has
    // given a seat count or pattern yet.
    const done = await db.get('SELECT value FROM config WHERE key = ?', [WEEK_SEATS_SEEDED]);
    if (!done) {
      for (const [number, week] of Object.entries(sched().weekSeats)) {
        await db.run(
          `UPDATE shift_def SET seats_json = ? WHERE number = ? AND kind = 'worker'
             AND seats_json IS NULL AND seats = 1`, [JSON.stringify(week), Number(number)]);
      }
      await db.run(
        `INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING`,
        [WEEK_SEATS_SEEDED, db.now()]);
    }
  })().catch((e) => { seeded = null; throw e; });
  return seeded;
}

async function shiftDefs() {
  await ensureShiftsSeeded();
  const rows = await db.all('SELECT * FROM shift_def WHERE active = 1 ORDER BY number');
  return rows.map((r) => ({
    number: Number(r.number), label: r.label,
    start: r.start_time, end: r.end_time, takeover: r.takeover_time,
    modes: JSON.parse(r.modes_json || '{}'),
    kind: r.kind || 'worker',
    days: r.days_json ? JSON.parse(r.days_json) : null,
    seats: Math.max(1, Number(r.seats) || 1),
    weekSeats: r.seats_json ? JSON.parse(r.seats_json) : null,
  }));
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const weekdayOf = (dateStr) => WEEKDAYS[new Date(dateStr + 'T00:00:00Z').getUTCDay()];

// How many worker seats a shift has on a date: its weekday pattern if it
// has one (0 = not running that day), else its flat seat count.
function seatsOn(def, dateStr) {
  if (def.kind === 'supervision') return timesOn(def, dateStr) ? 1 : 0;
  if (!def.weekSeats) return def.seats;
  const n = Number(def.weekSeats[weekdayOf(dateStr)]);
  return Number.isInteger(n) && n >= 0 ? n : def.seats;
}

function modeOn(def, dateStr) {
  return def.modes[weekdayOf(dateStr)] || def.modes.default || 'both';
}

// The hours a definition runs on a date, or null when a supervision block is
// off that weekday. Definitions without a weekly pattern run every day.
function timesOn(def, dateStr) {
  if (!def.days) return { start: def.start, end: def.end };
  const d = def.days[weekdayOf(dateStr)];
  return d ? { start: d[0], end: d[1] } : null;
}

// A slot's own hours: its override if it has one, else its definition's
// hours that day (the definition's defaults for a block added by hand on an
// off day). `slot` is a shift_slot row.
function slotTimes(def, slot) {
  if (slot.start_time && slot.end_time) return { start: slot.start_time, end: slot.end_time };
  return timesOn(def, slot.date) || { start: def.start, end: def.end };
}

// Start/end instants in UTC ms; an end at or before the start crosses
// midnight into the next day. Shift times are wall-clock times in the
// organisation's timezone (profile "timezone"): the calendar stores what the
// manual says and the UI shows it verbatim, and this turns it into the real
// instant for calendar feeds, reminders and "the next 24 hours".
function slotSpan(def, dateStr, times = null) {
  const t = times || { start: def.start, end: def.end };
  const at = (hhmm, plusDays = 0) => tz.wallToUtc(dateStr, hhmm, tz.zone(), plusDays);
  const start = at(t.start);
  const end = t.end <= t.start ? at(t.end, 1) : at(t.end);
  return { start, end };
}

const spanOfSlot = (def, slot) => slotSpan(def, slot.date, slotTimes(def, slot));
const hoursOf = ({ start, end }) => (end - start) / 3_600_000;

function durationHours(def) {
  return hoursOf(slotSpan(def, '2026-01-01'));
}

// Replace a supervision block's weekly pattern. days is {weekday: [start,
// end] | null}; null or absent is off. Applies to slots created from now on
// — existing slots keep the hours they were created with.
// How many people a worker shift needs at once (1-6). Applies when slots
// are created; already-created months are topped up by "Create month's slots".
async function setSeats(number, seats, actorId) {
  const def = (await shiftDefs()).find((d) => d.number === Number(number));
  if (!def || def.kind !== 'worker') return { error: 'not a worker shift' };
  // A weekday pattern: {sun..sat: 0-6}, every day given, at least one > 0.
  if (seats && typeof seats === 'object' && !Array.isArray(seats)) {
    const week = {};
    for (const wd of WEEKDAYS) {
      const n = Number(seats[wd]);
      if (!Number.isInteger(n) || n < 0 || n > MAX_SEATS) {
        return { error: `${wd}: seats must be 0 to ${MAX_SEATS}` };
      }
      week[wd] = n;
    }
    if (!Object.values(week).some((n) => n > 0)) return { error: 'the shift must run on at least one day' };
    await db.run('UPDATE shift_def SET seats_json = ? WHERE number = ?',
      [JSON.stringify(week), def.number]);
    await db.audit(actorId, 'shift_def_updated', 'shift_def', def.number,
      `S${def.number}: ${describeWeekSeats(week)}`);
    return { ok: true };
  }
  const n = Number(seats);
  if (!Number.isInteger(n) || n < 1 || n > MAX_SEATS) return { error: `seats must be 1 to ${MAX_SEATS}` };
  // A flat count replaces any weekday pattern: every day, n people.
  await db.run('UPDATE shift_def SET seats = ?, seats_json = NULL WHERE number = ?', [n, def.number]);
  await db.audit(actorId, 'shift_def_updated', 'shift_def', def.number,
    `S${def.number}: ${n} ${n === 1 ? 'person' : 'people'} per shift`);
  return { ok: true };
}

// "Mon 2 · Tue–Fri 1 · Sat 2 · Sun off" style summary for the audit log.
function describeWeekSeats(week) {
  const order = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const label = (wd) => wd[0].toUpperCase() + wd.slice(1);
  const runs = [];
  for (const wd of order) {
    const last = runs[runs.length - 1];
    if (last && last.n === week[wd]) last.to = wd; else runs.push({ from: wd, to: wd, n: week[wd] });
  }
  return runs.map((r) => (r.from === r.to ? label(r.from) : `${label(r.from)}–${label(r.to)}`) +
    ' ' + (r.n === 0 ? 'off' : r.n)).join(' · ');
}

async function setSupervisionPattern(number, days, actorId) {
  const def = (await shiftDefs()).find((d) => d.number === Number(number));
  if (!def || def.kind !== 'supervision') return { error: 'not a supervision block' };
  if (!days || typeof days !== 'object' || Array.isArray(days)) {
    return { error: 'days must be {weekday: [start, end]}' };
  }
  const clean = {};
  for (const wd of WEEKDAYS) {
    const v = days[wd];
    if (v == null) continue;
    if (!Array.isArray(v) || !isHHMM(v[0]) || !isHHMM(v[1]) || v[0] === v[1]) {
      return { error: `${wd}: times must be HH:MM and differ` };
    }
    clean[wd] = [v[0], v[1]];
  }
  await db.run('UPDATE shift_def SET days_json = ? WHERE number = ?',
    [JSON.stringify(clean), def.number]);
  await db.audit(actorId, 'shift_def_updated', 'shift_def', def.number,
    `${def.label}: ${describeDays(clean)}`);
  return { ok: true };
}

// Shift editor (profile feature "shiftEditor"). A coordinator renames a
// shift, changes its hours, takeover time or default mode, or adds a new
// worker shift. New hours apply from today: slots dated before today that
// still follow the definition are first stamped with the old hours, so
// history and worked-hours stay true.
const MODES = ['phone', 'chat', 'both'];
const LABEL_MAX = 40;

function cleanShiftFields(f, { partial }) {
  const out = {};
  if (f.label !== undefined || !partial) {
    const label = String(f.label || '').trim();
    if (!label || label.length > LABEL_MAX) return { error: `name must be 1 to ${LABEL_MAX} characters` };
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(label)) return { error: 'name must be a single line of text' };
    out.label = label;
  }
  for (const k of ['start', 'end', 'takeover']) {
    if (f[k] === undefined && partial) continue;
    if (!isHHMM(f[k])) return { error: `${k} must be HH:MM` };
    out[k] = f[k];
  }
  if (f.mode !== undefined || !partial) {
    if (!MODES.includes(f.mode)) return { error: `mode must be ${MODES.join(', ')}` };
    out.mode = f.mode;
  }
  return { fields: out };
}

async function updateShiftDef(number, fields, actorId) {
  const def = (await shiftDefs()).find((d) => d.number === Number(number));
  if (!def) return { error: 'no such shift' };
  const c = cleanShiftFields(fields || {}, { partial: true });
  if (c.error) return c;
  const f = c.fields;
  if (def.kind === 'supervision' && Object.keys(f).some((k) => k !== 'label')) {
    return { error: 'supervisor blocks: change hours with the weekly pattern' };
  }
  const next = { label: f.label ?? def.label, start: f.start ?? def.start, end: f.end ?? def.end,
    takeover: f.takeover ?? def.takeover };
  if (next.start === next.end) return { error: 'start and end must differ' };
  const changes = [];
  if (next.label !== def.label) changes.push(`name "${def.label}" → "${next.label}"`);
  if (next.start !== def.start || next.end !== def.end) {
    changes.push(`hours ${def.start}–${def.end} → ${next.start}–${next.end}`);
    // Every slot that has already started keeps the hours it was worked.
    const now = Date.now();
    const horizon = new Date(now + 2 * 86_400_000).toISOString().slice(0, 10);
    const open = await db.all(
      `SELECT id, date FROM shift_slot
       WHERE shift_number = ? AND start_time IS NULL AND date <= ?`, [def.number, horizon]);
    for (const s of open) {
      if (slotSpan(def, s.date).start > now) continue;
      await db.run(
        `UPDATE shift_slot SET start_time = ?, end_time = ?, times_stamped = 1
         WHERE id = ? AND start_time IS NULL`, [def.start, def.end, s.id]);
    }
  }
  if (next.takeover !== def.takeover) changes.push(`takeover ${def.takeover} → ${next.takeover}`);
  let modes = def.modes;
  if (f.mode && f.mode !== (def.modes.default || 'both')) {
    modes = { ...def.modes, default: f.mode };
    changes.push(`mode ${def.modes.default || 'both'} → ${f.mode}`);
  }
  if (!changes.length) return { ok: true, changed: false };
  await db.run(
    `UPDATE shift_def SET label = ?, start_time = ?, end_time = ?, takeover_time = ?, modes_json = ?
     WHERE number = ?`,
    [next.label, next.start, next.end, next.takeover, JSON.stringify(modes), def.number]);
  await db.audit(actorId, 'shift_def_updated', 'shift_def', def.number,
    `S${def.number}: ${changes.join('; ')}`);
  return { ok: true, changed: true };
}

async function createShiftDef(fields, actorId) {
  const c = cleanShiftFields(fields || {}, { partial: false });
  if (c.error) return c;
  const f = c.fields;
  if (f.start === f.end) return { error: 'start and end must differ' };
  await ensureShiftsSeeded();
  // Next free number; another create racing this one just moves us on.
  let number = null;
  for (let attempt = 0; attempt < 5 && number === null; attempt += 1) {
    const top = await db.get('SELECT MAX(number) AS n FROM shift_def');
    const want = Number(top && top.n || 0) + 1 + attempt;
    const r = await db.run(
      `INSERT INTO shift_def (number, label, start_time, end_time, takeover_time, modes_json)
       VALUES (?,?,?,?,?,?) ON CONFLICT (number) DO NOTHING`,
      [want, f.label, f.start, f.end, f.takeover, JSON.stringify({ default: f.mode })]);
    if (r.changes) number = want;
  }
  if (number === null) return { error: 'could not pick a shift number — try again' };
  await db.audit(actorId, 'shift_def_created', 'shift_def', number,
    `S${number} "${f.label}" ${f.start}–${f.end}, ${f.mode}`);
  return { ok: true, number };
}

// Take a worker shift off the schedule — only while no slot has ever been
// created for it (a shift added by mistake), so no history is lost. It is
// retired rather than deleted, so its number is never reused.
async function removeShiftDef(number, actorId) {
  const def = (await shiftDefs()).find((d) => d.number === Number(number));
  if (!def || def.kind !== 'worker') return { error: 'no such shift' };
  const used = await db.get('SELECT COUNT(*) AS n FROM shift_slot WHERE shift_number = ?', [def.number]);
  if (Number(used.n) > 0) {
    return { error: 'this shift already has slots on the schedule; set its seats to 0 on the days it should stop running instead' };
  }
  const left = (await shiftDefs()).filter((d) => d.kind === 'worker' && d.number !== def.number);
  if (!left.length) return { error: 'the schedule needs at least one shift' };
  await db.run('UPDATE shift_def SET active = 0 WHERE number = ?', [def.number]);
  await db.audit(actorId, 'shift_def_removed', 'shift_def', def.number, `S${def.number} "${def.label}"`);
  return { ok: true };
}

// "Fri 21:00–02:00 · Sat, Sun 21:00–09:00" — same-hours days grouped.
function describeDays(days) {
  const LABEL = { sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat' };
  const order = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const groups = new Map();
  for (const wd of order) {
    if (!days[wd]) continue;
    const key = `${days[wd][0]}–${days[wd][1]}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(LABEL[wd]);
  }
  if (!groups.size) return 'off every day';
  return [...groups].map(([t, ds]) => `${ds.join(', ')} ${t}`).join(' · ');
}

// ---------------------------------------------------------------------------
// Availability

// Weekday restrictions per shift: canDays is {shiftNumber: [0-6,...]} with
// 0 = Sunday. A shift missing from it, or listed for all seven days, is
// unrestricted, so nothing is stored for it.
function cleanDays(canDays, shifts) {
  const out = {};
  if (!canDays || typeof canDays !== 'object' || Array.isArray(canDays)) return out;
  for (const n of shifts) {
    const raw = canDays[n] ?? canDays[String(n)];
    if (!Array.isArray(raw)) continue;
    const days = [...new Set(raw.map(Number)
      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    if (days.length > 0 && days.length < 7) out[n] = days;
  }
  return out;
}

// Can this availability entry cover this shift on this date?
function availableOn(entry, shiftNumber, dateStr) {
  if (!entry.canShifts.includes(Number(shiftNumber))) return false;
  const days = entry.canDays && entry.canDays[shiftNumber];
  return !days || days.includes(new Date(dateStr + 'T00:00:00Z').getUTCDay());
}

async function submitAvailability(workerId, { month, canShifts, canDays, desiredShifts, notes }) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ''))) {
    return { error: 'month must be YYYY-MM' };
  }
  const defs = await shiftDefs();
  // Availability is about worker shifts only — OCS blocks are assigned by hand.
  const valid = new Set(defs.filter((d) => d.kind === 'worker').map((d) => d.number));
  const shifts = (Array.isArray(canShifts) ? canShifts : [])
    .map(Number).filter((n) => valid.has(n));
  const days = cleanDays(canDays, shifts);
  const id = await db.insert(
    `INSERT INTO availability (worker_id, month, can_shifts, can_days, desired_shifts, notes, submitted_at)
     VALUES (?,?,?,?,?,?,?)`,
    [workerId, month, JSON.stringify(shifts), JSON.stringify(days),
      desiredShifts != null ? Number(desiredShifts) : null,
      notes ? String(notes).slice(0, 1000) : null, db.now()]);
  await db.eventLog('availability_submitted', { workerId });
  await db.audit(workerId, 'availability_submitted', 'availability', id,
    `${month}: ${shifts.length ? availabilitySummary(shifts, days) : 'away'}` +
    (desiredShifts != null ? ` · wants ${Number(desiredShifts)}` : ''));
  return { id };
}

const DAY_SHORT = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function availabilitySummary(shifts, days) {
  return shifts.map((n) => 'S' + n +
    (days[n] ? ` (${days[n].map((d) => DAY_SHORT[d]).join(' ')})` : '')).join(', ');
}

// Latest submission per worker for a month ("we will always refer to the
// most recently dated one").
async function availabilityFor(month, workerId = null) {
  const rows = await db.all(
    `SELECT availability.*, worker.name FROM availability
     JOIN worker ON worker.id = availability.worker_id
     WHERE month = ? ${workerId ? 'AND worker_id = ?' : ''}
     ORDER BY availability.id DESC`,
    workerId ? [month, workerId] : [month]);
  const latest = new Map();
  for (const r of rows) {
    const key = Number(r.worker_id);
    if (!latest.has(key)) {
      latest.set(key, {
        workerId: key, name: r.name,
        canShifts: JSON.parse(r.can_shifts || '[]'),
        canDays: JSON.parse(r.can_days || '{}'),
        desiredShifts: r.desired_shifts != null ? Number(r.desired_shifts) : null,
        notes: r.notes, submittedAt: r.submitted_at,
      });
    }
  }
  return [...latest.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Slots

function datesOfMonth(month) {
  const [y, m] = month.split('-').map(Number);
  const out = [];
  for (let d = new Date(Date.UTC(y, m - 1, 1));
    d.getUTCMonth() === m - 1; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// Create the month's empty slots: each worker shift gets its number of
// seats per day, and each supervision block one supervisor slot on the
// weekdays its pattern runs, carrying that day's hours (so a later pattern
// change never rewrites slots already on the calendar). Idempotent, and a
// top-up: running it again after raising a shift's seats adds only the
// missing seats; lowering seats never removes anyone.
async function generateMonth(month, actorId) {
  const defs = await shiftDefs();
  let created = 0;
  for (const date of datesOfMonth(month)) {
    for (const def of defs) {
      const isOcs = def.kind === 'supervision';
      const times = isOcs ? timesOn(def, date) : null;
      if (isOcs && !times) continue; // block is off this weekday
      const role = isOcs ? 'supervisor' : 'worker';
      const want = seatsOn(def, date);
      if (!want) continue; // shift doesn't run this weekday
      const have = Number((await db.get(
        `SELECT COUNT(*) AS n FROM shift_slot WHERE date = ? AND shift_number = ? AND role = ?
           AND status != 'cancelled'`,
        [date, def.number, role])).n);
      for (let i = have; i < want; i++) {
        await db.insert(
          `INSERT INTO shift_slot (date, shift_number, role, start_time, end_time, created_at)
           VALUES (?,?,?,?,?,?)`,
          [date, def.number, role, times ? times.start : null, times ? times.end : null, db.now()]);
        created += 1;
      }
    }
  }
  await db.audit(actorId, 'schedule_generated', 'month', null,
    `${month}: ${created} slot(s) created`);
  log('schedule_generated', { month, created });
  return { created };
}

async function slotById(id) {
  return db.get('SELECT * FROM shift_slot WHERE id = ?', [Number(id)]);
}

// Slot roles: 'worker' (on the line), 'supervisor' (OCS / on-call), and
// the extra seats new volunteers take beside a worker — 'observer' (an
// observation shift, OS) and 'supervised' (a supervised shift, SS, taking
// contacts with an experienced worker alongside).
const SLOT_ROLES = ['worker', 'supervisor', 'observer', 'supervised'];

function eligibleForRole(worker, role) {
  if (!worker || worker.service_status !== 'in_service') return false;
  if (role === 'observer' || role === 'supervised') return true; // trainees train
  if (role === 'supervisor') return ['supervisor', 'coordinator'].includes(worker.role);
  return worker.role !== 'trainee';                           // worker slots
}

async function assign(slotId, workerId, actorId) {
  const slot = await slotById(slotId);
  if (!slot || slot.status === 'cancelled') return { error: 'no such slot' };
  if (workerId == null) {
    const prev = slot.worker_id
      ? await db.get('SELECT name FROM worker WHERE id = ?', [Number(slot.worker_id)]) : null;
    await db.run(
      `UPDATE shift_slot SET worker_id = NULL, status = 'open', confirmed_at = NULL,
         sub_requested_at = NULL WHERE id = ?`, [slot.id]);
    await db.audit(actorId, 'slot_unassigned', 'shift_slot', Number(slot.id),
      prev ? `was ${prev.name}` : null);
    return { ok: true };
  }
  const worker = await db.get('SELECT * FROM worker WHERE id = ?', [Number(workerId)]);
  if (!eligibleForRole(worker, slot.role)) {
    return { error: `not eligible for a ${slot.role} slot` };
  }
  await db.run(
    `UPDATE shift_slot SET worker_id = ?, status = 'assigned', confirmed_at = NULL,
       sub_requested_at = NULL WHERE id = ?`, [worker.id, slot.id]);
  await db.audit(actorId, 'slot_assigned', 'shift_slot', Number(slot.id),
    `to ${worker.name}`);
  notify('slot_assigned', [Number(worker.id)],
    { slotId: Number(slot.id), date: slot.date, shift: Number(slot.shift_number) })
    .catch(() => {});
  return { ok: true };
}

async function confirm(slotId, workerId) {
  const r = await db.run(
    `UPDATE shift_slot SET status = 'confirmed', confirmed_at = ?
     WHERE id = ? AND worker_id = ? AND status IN ('assigned','sub_requested')`,
    [db.now(), Number(slotId), workerId]);
  if (r.changes) await db.eventLog('shift_confirmed', { workerId });
  return r.changes > 0;
}

// Worker-owned substitution: the assignee flags the slot; any eligible
// colleague takes it over (and then confirms it themselves). Staff see the
// request on the schedule and get the out-of-band notification.
async function requestSub(slotId, actor) {
  const slot = await slotById(slotId);
  if (!slot || !slot.worker_id) return { error: 'no assigned slot' };
  const isStaff = ['supervisor', 'coordinator'].includes(actor.role);
  if (Number(slot.worker_id) !== Number(actor.id) && !isStaff) {
    return { error: 'not your shift' };
  }
  await db.run(
    `UPDATE shift_slot SET status = 'sub_requested', sub_requested_at = ? WHERE id = ?`,
    [db.now(), slot.id]);
  const holder = await db.get('SELECT name FROM worker WHERE id = ?', [Number(slot.worker_id)]);
  await db.audit(actor.id, 'sub_requested', 'shift_slot', Number(slot.id),
    holder && Number(actor.id) !== Number(slot.worker_id) ? `for ${holder.name}` : null);
  const staff = await db.all(
    `SELECT id FROM worker WHERE role IN ('supervisor','coordinator')
       AND service_status = 'in_service'`);
  notify('sub_request', staff.map((s) => Number(s.id)),
    { slotId: Number(slot.id), date: slot.date, shift: Number(slot.shift_number) })
    .catch(() => {});
  return { ok: true };
}

async function takeSub(slotId, taker) {
  const slot = await slotById(slotId);
  if (!slot || slot.status !== 'sub_requested') return { error: 'not up for cover' };
  if (Number(slot.worker_id) === Number(taker.id)) return { error: 'already yours' };
  if (!eligibleForRole(taker, slot.role)) {
    return { error: `not eligible for a ${slot.role} slot` };
  }
  const r = await db.run(
    `UPDATE shift_slot SET worker_id = ?, status = 'assigned', confirmed_at = NULL,
       sub_requested_at = NULL WHERE id = ? AND status = 'sub_requested'`,
    [taker.id, slot.id]);
  if (!r.changes) return { error: 'someone else just took it' };
  const prev = await db.get('SELECT name FROM worker WHERE id = ?', [Number(slot.worker_id)]);
  await db.audit(taker.id, 'sub_taken', 'shift_slot', Number(slot.id),
    prev ? `from ${prev.name}` : null);
  const staff = await db.all(
    `SELECT id FROM worker WHERE role IN ('supervisor','coordinator')
       AND service_status = 'in_service'`);
  notify('sub_taken', staff.map((s) => Number(s.id)),
    { slotId: Number(slot.id), date: slot.date, shift: Number(slot.shift_number) })
    .catch(() => {});
  return { ok: true };
}

async function monthSlots(month) {
  const byNumber = new Map((await shiftDefs()).map((d) => [d.number, d]));
  const rows = await db.all(
    `SELECT shift_slot.*, worker.name AS worker_name, worker.display_name, worker.support_group
     FROM shift_slot LEFT JOIN worker ON worker.id = shift_slot.worker_id
     WHERE shift_slot.date LIKE ? AND shift_slot.status != 'cancelled'
     ORDER BY shift_slot.date, shift_slot.shift_number,
       CASE shift_slot.role WHEN 'worker' THEN 0 WHEN 'supervised' THEN 1
         WHEN 'observer' THEN 2 ELSE 3 END, shift_slot.id`,
    [month + '-%']);
  const ordinals = await trainingOrdinals(month);
  return rows.map((s) => ({
    ordinal: ordinals.get(Number(s.id)) || null,
    id: Number(s.id), date: s.date, shiftNumber: Number(s.shift_number),
    role: s.role, status: s.status,
    workerId: s.worker_id ? Number(s.worker_id) : null,
    workerName: s.worker_id ? (s.display_name || s.worker_name) : null,
    workerGroup: s.worker_id && s.support_group ? groupTag(Number(s.support_group)) : null,
    confirmedAt: s.confirmed_at,
    note: s.note || null,
    ...hoursFields(byNumber.get(Number(s.shift_number)), s),
  }));
}

// Resolved hours for the UI, and whether they were set by hand on a worker
// slot (supervision slots always carry their own hours).
function hoursFields(def, s) {
  if (!def) return { start: null, end: null, customTimes: false };
  const t = slotTimes(def, s);
  return { start: t.start, end: t.end,
    customTimes: def.kind !== 'supervision' && !!(s.start_time && s.end_time) && !Number(s.times_stamped) };
}

// Each trainee's running count of observation and supervised shifts, in
// date order up to the end of the month (the sheet's "10th OS", "SS2"):
// slot id → n.
async function trainingOrdinals(month) {
  const rows = await db.all(
    `SELECT id, worker_id, role, training_no FROM shift_slot
     WHERE role IN ('observer','supervised') AND worker_id IS NOT NULL
       AND status != 'cancelled' AND date <= ?
     ORDER BY date, shift_number, id`, [month + '-31']);
  const seen = new Map();
  const out = new Map();
  for (const r of rows) {
    const key = `${r.worker_id}:${r.role}`;
    // A recorded number (from the imported sheet) resets the count, so
    // later shifts carry on from it.
    seen.set(key, r.training_no ? Number(r.training_no) : (seen.get(key) || 0) + 1);
    out.set(Number(r.id), seen.get(key));
  }
  return out;
}

async function mySlots(workerId) {
  const byNumber = new Map((await shiftDefs()).map((d) => [d.number, d]));
  const from = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const rows = await db.all(
    `SELECT * FROM shift_slot WHERE worker_id = ? AND date >= ?
       AND status != 'cancelled' ORDER BY date, shift_number`,
    [workerId, from]);
  return rows.map((s) => ({
    id: Number(s.id), date: s.date, shiftNumber: Number(s.shift_number),
    role: s.role, status: s.status, confirmedAt: s.confirmed_at,
    ...hoursFields(byNumber.get(Number(s.shift_number)), s),
  }));
}

// The manual's end-of-shift check: everyone on the next 24 hours confirmed?
async function unconfirmedNext24h(now = Date.now()) {
  const defs = await shiftDefs();
  const byNumber = new Map(defs.map((d) => [d.number, d]));
  const today = tz.dateIn(now);
  const tomorrow = tz.dateIn(now + 86_400_000);
  const rows = await db.all(
    `SELECT shift_slot.*, worker.name AS worker_name FROM shift_slot
     LEFT JOIN worker ON worker.id = shift_slot.worker_id
     WHERE shift_slot.date BETWEEN ? AND ?
       AND shift_slot.status IN ('assigned','sub_requested','open')
     ORDER BY shift_slot.date, shift_slot.shift_number`, [today, tomorrow]);
  return rows.filter((s) => {
    const def = byNumber.get(Number(s.shift_number));
    if (!def) return false;
    const { start } = spanOfSlot(def, s);
    return start > now && start <= now + 24 * 3_600_000;
  }).map((s) => ({
    id: Number(s.id), date: s.date, shiftNumber: Number(s.shift_number),
    role: s.role, status: s.status, workerName: s.worker_name || null,
  }));
}

// Volunteer hours (iCarol Shift Statistics parity): past assigned/confirmed
// slots count as worked, each for its own hours.
async function stats(workerId = null) {
  const defs = await shiftDefs();
  const byNumber = new Map(defs.map((d) => [d.number, d]));
  const rows = await db.all(
    `SELECT shift_slot.*, worker.name AS worker_name FROM shift_slot
     JOIN worker ON worker.id = shift_slot.worker_id
     WHERE shift_slot.worker_id IS NOT NULL
       AND shift_slot.status IN ('assigned','confirmed')
     ${workerId ? 'AND shift_slot.worker_id = ?' : ''}`,
    workerId ? [workerId] : []);
  const now = Date.now();
  const monthStart = tz.dateIn(now).slice(0, 7);
  const yearAgo = tz.dateIn(now - 365 * 86_400_000);
  const per = new Map();
  for (const s of rows) {
    const def = byNumber.get(Number(s.shift_number));
    if (!def) continue;
    const span = spanOfSlot(def, s);
    const key = Number(s.worker_id);
    if (!per.has(key)) {
      per.set(key, { workerId: key, name: s.worker_name,
        scheduled: 0, worked: 0, worked_12mo: 0, worked_month: 0, hours: 0 });
    }
    const p = per.get(key);
    p.scheduled += 1;
    if (span.end < now) {
      p.worked += 1;
      p.hours += hoursOf(span);
      if (s.date >= yearAgo) p.worked_12mo += 1;
      if (s.date.startsWith(monthStart)) p.worked_month += 1;
    }
  }
  return [...per.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Auto-fill: draft the month's open worker slots from the submitted
// availabilities. Deterministic and explainable rather than clever-clever:
// the most constrained slots (fewest possible people) are filled first, and
// within a slot the person with the fewest shifts so far wins, so the month
// is shared out (with 150 volunteers and one seat per shift, ranking by
// flexibility first left a third of those who offered with nothing while
// others got ten). Ties go to the least flexible person — so someone who can
// only do Monday S1 is not beaten to it by a colleague who could work
// anything — then the most unmet want, then name. Nobody is double-booked
// on a date or given shifts whose hours overlap (Sunday S5 runs to 02:00,
// past Monday S6's 01:30 start), nobody is pushed past their desired count,
// people who gave no count stop at autofill_unstated_max (default 4), and a
// slot with no candidate stays open.
// Free-text "Only, Nots and Also" is NOT parsed — the coordinator reviews
// the draft against it, and every applied slot still needs the worker's own
// confirmation, so a wrong guess costs one unassign.

async function proposeAssignments(month) {
  const avail = await availabilityFor(month);
  const workerRows = await db.all(
    `SELECT * FROM worker WHERE service_status = 'in_service'`);
  const byId = new Map(workerRows.map((w) => [Number(w.id), w]));
  const entries = avail.filter((a) => {
    const w = byId.get(a.workerId);
    return w && eligibleForRole(w, 'worker') && a.canShifts.length;
  });
  const slots = await db.all(
    `SELECT * FROM shift_slot WHERE date LIKE ? AND role = 'worker' AND status = 'open'
     ORDER BY date, shift_number, id`, [month + '-%']);
  const byNumber = new Map((await shiftDefs()).map((d) => [d.number, d]));
  const spanOf = (s) => {
    const def = byNumber.get(Number(s.shift_number));
    return def ? spanOfSlot(def, s) : null;
  };
  const unstatedMax = Math.max(0, Number(await db.getConfig('autofill_unstated_max')) || 0);
  const capOf = (a) => (a.desiredShifts != null ? a.desiredShifts : unstatedMax);
  // What everyone already carries, so auto-fill tops up rather than piling
  // on: this month's shift counts, the dates each person is on, and the
  // hours they're busy (a day either side too, for shifts across midnight).
  const [y, m] = month.split('-').map(Number);
  const edge = (d) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
  const existing = await db.all(
    `SELECT * FROM shift_slot
     WHERE date >= ? AND date <= ? AND worker_id IS NOT NULL
       AND status IN ('assigned','confirmed','sub_requested')`, [edge(0), edge(32)]);
  const count = new Map();
  const onDate = new Map();
  const busy = new Map();
  const addLoad = (workerId, s, inMonth = true) => {
    if (inMonth) {
      count.set(workerId, (count.get(workerId) || 0) + 1);
      if (!onDate.has(workerId)) onDate.set(workerId, new Set());
      onDate.get(workerId).add(s.date);
    }
    const sp = spanOf(s);
    if (sp) {
      if (!busy.has(workerId)) busy.set(workerId, []);
      busy.get(workerId).push(sp);
    }
  };
  for (const e of existing) addLoad(Number(e.worker_id), e, e.date.startsWith(month));
  const clashes = (workerId, s) => {
    const sp = spanOf(s);
    return !!sp && (busy.get(workerId) || []).some((b) => b.start < sp.end && sp.start < b.end);
  };

  // Who could take each slot at all, and how many openings each person has
  // ("flexibility") — the scarce people and the scarce slots go first.
  const flexibility = new Map();
  const slotCands = new Map();
  for (const s of slots) {
    const c = entries.filter((a) => availableOn(a, Number(s.shift_number), s.date));
    slotCands.set(s.id, c);
    for (const a of c) flexibility.set(a.workerId, (flexibility.get(a.workerId) || 0) + 1);
  }
  const ordered = [...slots].sort((a, b) =>
    (slotCands.get(a.id).length - slotCands.get(b.id).length) ||
    a.date.localeCompare(b.date) || (a.shift_number - b.shift_number));

  const proposals = [];
  for (const s of ordered) {
    const cands = slotCands.get(s.id).filter((a) =>
      !(onDate.get(a.workerId) && onDate.get(a.workerId).has(s.date)) &&
      (count.get(a.workerId) || 0) < capOf(a) &&
      !clashes(a.workerId, s));
    if (!cands.length) continue;
    cands.sort((x, y) => {
      const cx = count.get(x.workerId) || 0;
      const cy = count.get(y.workerId) || 0;
      // Most unmet want; no stated want ranks below any unmet want.
      const rx = x.desiredShifts == null ? 0 : x.desiredShifts - cx;
      const ry = y.desiredShifts == null ? 0 : y.desiredShifts - cy;
      return (cx - cy) || (flexibility.get(x.workerId) - flexibility.get(y.workerId)) ||
        (ry - rx) || x.name.localeCompare(y.name);
    });
    const pick = cands[0];
    addLoad(pick.workerId, s);
    proposals.push({
      slotId: Number(s.id), date: s.date, shiftNumber: Number(s.shift_number),
      workerId: pick.workerId, name: pick.name,
    });
  }
  // Second pass: nobody who offered goes without while a colleague holds
  // two or more drafted shifts that they could do instead. Hand one over
  // (from whoever holds the most) if it fits the newcomer's day and hours.
  const slotOf = new Map(slots.map((s) => [Number(s.id), s]));
  const dropLoad = (workerId, s) => {
    count.set(workerId, count.get(workerId) - 1);
    onDate.get(workerId).delete(s.date);
    const sp = spanOf(s);
    const list = busy.get(workerId) || [];
    const i = list.findIndex((b) => sp && b.start === sp.start && b.end === sp.end);
    if (i >= 0) list.splice(i, 1);
  };
  for (const a of entries) {
    if (count.get(a.workerId) || capOf(a) < 1) continue;
    const options = proposals.filter((p) => {
      const s = slotOf.get(p.slotId);
      return (count.get(p.workerId) || 0) >= 2 && availableOn(a, p.shiftNumber, p.date) &&
        !clashes(a.workerId, s);
    }).sort((x, y) => (count.get(y.workerId) - count.get(x.workerId)) ||
      x.date.localeCompare(y.date) || (x.shiftNumber - y.shiftNumber));
    if (!options.length) continue;
    const p = options[0];
    const s = slotOf.get(p.slotId);
    dropLoad(p.workerId, s);
    p.workerId = a.workerId;
    p.name = a.name;
    addLoad(a.workerId, s);
  }

  proposals.sort((a, b) => a.date.localeCompare(b.date) || (a.shiftNumber - b.shiftNumber));
  // How the draft spreads, for the coordinator's review: people given at
  // least one shift, the most anyone gets, and who offered but got none.
  const perPerson = new Map();
  for (const p of proposals) perPerson.set(p.workerId, (perPerson.get(p.workerId) || 0) + 1);
  const withNone = entries.filter((a) => !perPerson.has(a.workerId) && !count.has(a.workerId))
    .map((a) => a.name);
  return {
    proposals, openSlots: slots.length, openLeft: slots.length - proposals.length,
    people: perPerson.size, mostForOne: Math.max(0, ...perPerson.values()),
    offeredButNone: withNone, unstatedMax,
  };
}

// Apply a fresh draft. Each slot goes through the normal assigned-await-
// confirmation state and the audit trail; notification is batched — one
// email per person with their whole list (slot_assigned preference), one
// team post for the draft — instead of one message per slot.
async function applyAssignments(month, actorId) {
  const { proposals, openLeft } = await proposeAssignments(month);
  const perWorker = new Map();
  let assigned = 0;
  for (const p of proposals) {
    const r = await db.run(
      `UPDATE shift_slot SET worker_id = ?, status = 'assigned', confirmed_at = NULL,
         sub_requested_at = NULL WHERE id = ? AND status = 'open'`,
      [p.workerId, p.slotId]);
    if (!r.changes) continue; // the slot moved under us — leave it alone
    assigned += 1;
    await db.audit(actorId, 'slot_assigned', 'shift_slot', p.slotId,
      `to ${p.name} (auto-fill)`);
    if (!perWorker.has(p.workerId)) perWorker.set(p.workerId, []);
    perWorker.get(p.workerId).push(`S${p.shiftNumber} ${p.date}`);
  }
  // Sent before replying, one after another: on Vercel, work left running
  // after the response can be frozen mid-send, and with 150 volunteers this
  // is dozens of emails.
  for (const [workerId, list] of perWorker) {
    await notify('slots_assigned', [workerId],
      { month, count: list.length, list: list.join(', ') }).catch(() => {});
  }
  if (assigned) {
    await notify('schedule_drafted', [],
      { month, assigned, workers: perWorker.size, openLeft }).catch(() => {});
  }
  await db.audit(actorId, 'schedule_autofilled', 'month', null,
    `${month}: ${assigned} assigned across ${perWorker.size} people, ${openLeft} left open`);
  return { assigned, workers: perWorker.size, openLeft };
}

// ---------------------------------------------------------------------------
// The coordinator's changes view: recent schedule-related audit entries with
// the actor's name and, for slot entries, the slot's date and shift.

const AUDIT_ACTIONS = [
  'schedule_generated', 'schedule_autofilled', 'slot_created', 'slot_assigned',
  'slot_unassigned', 'slot_note_set', 'slot_times_set', 'slot_cancelled',
  'sub_requested', 'sub_taken', 'day_note_set', 'shift_def_updated', 'shift_def_created',
  'shift_def_removed',
  'availability_submitted', 'availability_reminded', 'cover_broadcast',
];

// ---------------------------------------------------------------------------
// Cover broadcast: when a shift needs cover at short notice, staff email
// everyone who could take it. Recipients are worked out here — in service,
// eligible for the slot's role, not the person who can't make it and not
// anyone already on that shift — and the message is a template the sender
// can edit before it goes. Taking the shift stays the normal "Take it".

const COVER_BROADCAST_GAP_MS = 15 * 60_000;

async function coverRecipients(slot) {
  const busy = new Set((await db.all(
    `SELECT worker_id FROM shift_slot WHERE date = ? AND shift_number = ?
       AND worker_id IS NOT NULL AND status != 'cancelled'`,
    [slot.date, slot.shift_number])).map((r) => Number(r.worker_id)));
  const people = await db.all(
    `SELECT id, name, email, role, service_status FROM worker
     WHERE service_status = 'in_service' ORDER BY name`);
  return people.filter((w) => eligibleForRole(w, slot.role) && !busy.has(Number(w.id)));
}

async function coverDraft(slotId, sender, baseUrl = '') {
  const slot = await slotById(slotId);
  if (!slot || slot.status !== 'sub_requested') return { error: 'this shift is not asking for cover' };
  const def = (await shiftDefs()).find((d) => d.number === Number(slot.shift_number));
  if (!def) return { error: 'no such shift' };
  const t = slotTimes(def, slot);
  const day = new Date(slot.date + 'T00:00:00Z').toLocaleDateString('en-GB',
    { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  const isOcs = def.kind === 'supervision';
  const name = isOcs ? `On Call Supervisor (${def.label.replace(/^OCS\s*/, '').toLowerCase()})`
    : `S${slot.shift_number}`;
  const mode = isOcs ? '' : { phone: ' (phone)', chat: ' (chat)', both: ' (phone & chat)' }[modeOn(def, slot.date)] || '';
  const link = baseUrl ? `\n\n${baseUrl.replace(/\/+$/, '')}/schedule.html` : '';
  const recipients = await coverRecipients(slot);
  const last = await db.get(
    `SELECT at FROM audit_log WHERE action = 'cover_broadcast' AND entity = 'shift_slot'
       AND entity_id = ? ORDER BY id DESC LIMIT 1`, [Number(slot.id)]);
  return {
    slot,
    subject: `Cover needed: ${name}, ${day}, ${t.start}–${t.end}`,
    body: `Hello,\n\nA shift needs cover at short notice:\n\n` +
      `    ${name} · ${day} · ${t.start}–${t.end}${mode}\n\n` +
      'If you can take it, open the schedule and press "Take it" under ' +
      '"Shifts needing cover". The first person to take it gets the shift, ' +
      `and you'll be asked to confirm it as usual.${link}\n\n` +
      `Thank you,\n${sender.name}`,
    recipients: recipients.map((w) => ({ id: Number(w.id), name: w.name, email: w.email })),
    lastSentAt: last ? last.at : null,
  };
}

// How each action reads in the log ("Grace assigned S4 7 Nov — to Ben").
const AUDIT_VERBS = {
  schedule_generated: 'generated the month',
  schedule_autofilled: 'auto-filled the month',
  slot_created: 'added a slot',
  slot_assigned: 'assigned',
  slot_unassigned: 'unassigned',
  slot_note_set: 'set a slot note',
  slot_times_set: 'changed slot hours',
  slot_cancelled: 'cancelled a slot',
  sub_requested: 'requested cover',
  sub_taken: 'took cover',
  day_note_set: 'set a day note',
  shift_def_updated: 'changed shift settings',
  shift_def_created: 'added a shift',
  shift_def_removed: 'removed a shift',
  schedule_imported: 'imported the month from the sheet',
  availability_submitted: 'submitted availability',
  availability_reminded: 'sent availability reminders',
  cover_broadcast: 'emailed everyone for cover',
};

// Newest first; `before` (an entry id) pages back through older entries.
async function scheduleAudit(limit = 100, before = null) {
  const params = [...AUDIT_ACTIONS];
  let older = '';
  if (before != null && Number.isFinite(Number(before))) {
    older = 'AND audit_log.id < ?';
    params.push(Number(before));
  }
  params.push(Math.min(Number(limit) || 100, 500));
  const rows = await db.all(
    `SELECT audit_log.*, worker.name AS actor_name,
            shift_slot.date AS slot_date, shift_slot.shift_number, shift_slot.role AS slot_role,
            shift_def.kind AS def_kind, shift_def.label AS def_label
     FROM audit_log
     LEFT JOIN worker ON worker.id = audit_log.actor_id
     LEFT JOIN shift_slot ON audit_log.entity = 'shift_slot'
       AND shift_slot.id = audit_log.entity_id
     LEFT JOIN shift_def ON shift_def.number = shift_slot.shift_number
     WHERE audit_log.action IN (${AUDIT_ACTIONS.map(() => '?').join(',')}) ${older}
     ORDER BY audit_log.id DESC LIMIT ?`, params);
  const TAG = { supervisor: ' 👁', observer: ' 🎓', supervised: ' 🤝' };
  return rows.map((r) => {
    let slot = null;
    if (r.slot_date) {
      const name = r.def_kind === 'supervision'
        ? String(r.def_label || '').replace(/^OCS\s*/, '👁 ')
        : `S${r.shift_number}${TAG[r.slot_role] || ''}`;
      slot = `${name} ${r.slot_date}`;
    }
    return {
      id: Number(r.id), at: r.at, action: r.action,
      actorName: r.actor_name || '—',
      what: AUDIT_VERBS[r.action] || r.action,
      slot,
      detail: r.detail || null,
    };
  });
}

// In-service people who have not submitted availability for a month — the
// chase list ("submit every month, even if you are away" is the rule).
async function availabilityMissing(month) {
  const submitted = new Set((await availabilityFor(month)).map((a) => a.workerId));
  const rows = await db.all(
    `SELECT id, name, email FROM worker WHERE service_status = 'in_service' ORDER BY name`);
  return rows.filter((w) => !submitted.has(Number(w.id)))
    .map((w) => ({ id: Number(w.id), name: w.name, email: w.email }));
}

// ---------------------------------------------------------------------------
// Personal ICS feed (02: "shifts appear in workers' own calendars"). The URL
// carries its own secret, so calendar apps need no cookie.

async function calTokenFor(workerId) {
  const w = await db.get('SELECT cal_token FROM worker WHERE id = ?', [workerId]);
  if (w.cal_token) return w.cal_token;
  const token = crypto.randomBytes(16).toString('hex');
  await db.run('UPDATE worker SET cal_token = ? WHERE id = ? AND cal_token IS NULL',
    [token, workerId]);
  const again = await db.get('SELECT cal_token FROM worker WHERE id = ?', [workerId]);
  return again.cal_token;
}

async function icsFor(calToken) {
  const w = await db.get('SELECT id, name FROM worker WHERE cal_token = ?', [String(calToken)]);
  if (!w) return null;
  const defs = await shiftDefs();
  const byNumber = new Map(defs.map((d) => [d.number, d]));
  const from = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const rows = await db.all(
    `SELECT * FROM shift_slot WHERE worker_id = ? AND date >= ?
       AND status IN ('assigned','confirmed','sub_requested') ORDER BY date`,
    [w.id, from]);
  const fmt = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const p = profile.profile();
  // RFC 5545 text: escape \ ; , and newlines; fold lines over 75 octets.
  const icsText = (t) => String(t).replace(/[\\;,]/g, (c) => '\\' + c).replace(/\r?\n|\r/g, '\\n');
  const fold = (line) => {
    const out = [];
    let cur = '';
    for (const ch of line) {
      if (Buffer.byteLength(cur + ch) > (out.length ? 74 : 75)) { out.push(cur); cur = ''; }
      cur += ch;
    }
    out.push(cur);
    return out.join('\r\n ');
  };
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//${profile.brand('name')}//shifts//EN`];
  for (const s of rows) {
    const def = byNumber.get(Number(s.shift_number));
    if (!def) continue;
    const { start, end } = spanOfSlot(def, s);
    lines.push('BEGIN:VEVENT',
      `UID:${p.id}-slot-${s.id}@${p.id}-lifeline`,
      `DTSTART:${fmt(start)}`, `DTEND:${fmt(end)}`,
      fold(`SUMMARY:${icsText(profile.brand('shortName'))} ${icsText(def.label)}${s.role !== 'worker' ? ' (' + s.role + ')' : ''}` +
        (s.status === 'sub_requested' ? ' — cover requested' : '')),
      'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

// One worker's own numbers for the profile page, shaped like iCarol's Shift
// Statistics table: scheduled vs worked shifts and hours per period.
async function myStats(workerId, now = Date.now()) {
  const defs = await shiftDefs();
  const byNumber = new Map(defs.map((d) => [d.number, d]));
  const rows = await db.all(
    `SELECT shift_slot.* FROM shift_slot
     WHERE shift_slot.worker_id = ? AND shift_slot.status IN ('assigned','confirmed')`,
    [workerId]);
  const monthStart = tz.dateIn(now).slice(0, 7);
  const [my, mm] = monthStart.split('-').map(Number);
  const nextMonth = mm === 12 ? `${my + 1}-01` : `${my}-${String(mm + 1).padStart(2, '0')}`;
  const yearAgo = tz.dateIn(now - 365 * 86_400_000);
  const mk = () => ({ scheduled: 0, worked: 0, scheduledHours: 0, workedHours: 0 });
  const out = { allPast: mk(), last12mo: mk(), thisMonth: mk(), nextMonth: mk() };
  let firstShift = null;
  const add = (p, hours, worked) => {
    p.scheduled += 1;
    p.scheduledHours += hours;
    if (worked) { p.worked += 1; p.workedHours += hours; }
  };
  for (const s of rows) {
    const def = byNumber.get(Number(s.shift_number));
    if (!def) continue;
    const span = spanOfSlot(def, s);
    const hours = hoursOf(span);
    const worked = span.end < now;
    if (worked && (!firstShift || s.date < firstShift)) firstShift = s.date;
    if (worked) add(out.allPast, hours, true);
    if (worked && s.date >= yearAgo) add(out.last12mo, hours, true);
    if (s.date.startsWith(monthStart)) add(out.thisMonth, hours, worked);
    if (s.date.startsWith(nextMonth)) add(out.nextMonth, hours, false);
  }
  return { ...out, firstShift };
}

// Day-before reminder emails: every assigned/confirmed slot starting in the
// next 24 hours whose worker hasn't been reminded yet. Each slot is marked
// before sending so retries can't double-mail; delivery itself is gated by
// the worker's own email preference (notify checks it).
async function sendShiftReminders(notifyFn, now = Date.now()) {
  const defs = await shiftDefs();
  const byNumber = new Map(defs.map((d) => [d.number, d]));
  const today = tz.dateIn(now);
  const tomorrow = tz.dateIn(now + 86_400_000);
  const rows = await db.all(
    `SELECT shift_slot.* FROM shift_slot
     WHERE shift_slot.date BETWEEN ? AND ? AND shift_slot.worker_id IS NOT NULL
       AND shift_slot.status IN ('assigned','confirmed') AND shift_slot.reminded = 0`,
    [today, tomorrow]);
  let sent = 0;
  for (const s of rows) {
    const def = byNumber.get(Number(s.shift_number));
    if (!def) continue;
    const { start } = spanOfSlot(def, s);
    if (start <= now || start > now + 24 * 3_600_000) continue;
    const r = await db.run(
      'UPDATE shift_slot SET reminded = 1 WHERE id = ? AND reminded = 0', [s.id]);
    if (!r.changes) continue; // another instance got there first
    await notifyFn('shift_reminder', [Number(s.worker_id)],
      { shift: Number(s.shift_number), date: s.date });
    sent += 1;
  }
  return sent;
}

module.exports = {
  parseGroup, splitGroupPrefix, groupTag,
  setSeats, seatsOn, describeWeekSeats,
  get DEFAULT_WEEK_SEATS() { return sched().weekSeats; },
  get DEFAULT_SHIFTS() { return sched().shifts; },
  get DEFAULT_SUPERVISION() { return sched().supervision; },
  ensureShiftsSeeded, shiftDefs, updateShiftDef, createShiftDef, removeShiftDef, modeOn, slotSpan, durationHours,
  timesOn, slotTimes, isHHMM, setSupervisionPattern, describeDays,
  submitAvailability, availabilityFor, availableOn, datesOfMonth, generateMonth,
  assign, confirm, requestSub, takeSub, monthSlots, mySlots,
  unconfirmedNext24h, stats, myStats, sendShiftReminders, calTokenFor, icsFor,
  eligibleForRole, SLOT_ROLES, slotById, scheduleAudit, AUDIT_VERBS, availabilityMissing,
  coverDraft, COVER_BROADCAST_GAP_MS,
  proposeAssignments, applyAssignments,
};
