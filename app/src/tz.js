'use strict';

// The organisation's clock. Shift times are wall-clock times where the
// helpline is ("19:00" means 7 pm in Tokyo for TELL), so turning a shift into
// real instants — for calendar feeds, reminders, "in the next 24 hours" —
// needs the organisation's timezone (profile "timezone", an IANA name).

const profile = require('./profile');

const zone = () => profile.profile().timezone;

const fmtCache = new Map();
function parts(ms, tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return o;
}

// How far ahead of UTC the zone's clock is at that instant, in ms.
function offsetAt(ms, tz = zone()) {
  const p = parts(ms, tz);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

// "2026-11-03", "19:00" in the zone → UTC ms. Tries the zone's offset a day
// either side: a wall time that happens twice (clocks going back) is its
// first occurrence; one skipped by clocks going forward moves forward by the
// size of the jump (02:30 on a spring-forward night in New York is 03:30).
function wallToUtc(dateStr, hhmm, tz = zone(), plusDays = 0) {
  const naive = Date.parse(`${dateStr}T${hhmm}:00Z`) + plusDays * 86_400_000;
  const before = naive - offsetAt(naive - 86_400_000, tz);
  const after = naive - offsetAt(naive + 86_400_000, tz);
  const real = (t) => naive - offsetAt(t, tz) === t;
  if (real(before) && real(after)) return Math.min(before, after);
  if (real(before)) return before;
  if (real(after)) return after;
  return Math.max(before, after);
}

// The instant the zone's calendar day containing ms began (local midnight).
function dayStart(ms = Date.now(), tz = zone()) {
  return wallToUtc(dateIn(ms, tz), '00:00', tz);
}

// The zone's calendar date (YYYY-MM-DD) at an instant.
function dateIn(ms = Date.now(), tz = zone()) {
  const p = parts(ms, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

function valid(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

module.exports = { zone, offsetAt, wallToUtc, dateIn, dayStart, valid };
