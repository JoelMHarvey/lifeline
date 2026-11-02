'use strict';

// TELL-format workbook import. Only for a profile with import.tellWorkbook
// set (profiles/tell.json); other organisations' sheets won't have this layout.
//
// Import one month from TELL's scheduling workbook (the Excel sheet the
// coordinator keeps today) into the shift calendar, so the app can run in
// parallel with the sheet during the pilot.
//
// The sheet's layout (2025 onwards): one tab per month; each week starts
// with a row of day headers ("Monday 2", "Thursday 5   Group 1 7 pm");
// shift labels S1-S7 sit in column A for Monday-Thursday and beside the
// Friday and Sunday blocks for the weekend side; each person is a cell
// "S08 Alex M" (support group, first name, surname initial) with a
// confirmation checkbox in the cell to its left. Trainees are suffixed
// "SS3" (third supervised shift) or "OS" (observing; several names may
// share one cell, comma-separated). On Call Supervisors are free text:
// "On-call Supervisor Junko M 9 AM - 9 PM".
//
// parseSheet works on a plain grid (rows of cell values) so it can be
// tested without Excel; tools/import-sheet.js loads the .xlsx.

const db = require('./db');
const schedule = require('./schedule');
const profile = require('./profile');

function enabled() { return profile.profile().import.tellWorkbook === true; }

const DAY_RE = /^\s*(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+(\d{1,2})\b([\s\S]*)$/i;
const LABEL_RE = /^\s*S([1-7])\s*$/;
const OCS_RE = /on[\s-]*call\s+supervisor:?\s*(.+?)\s+(\d{1,2}(?::?\d{2})?\s*[AP]\.?M\.?)\s*[-–]\s*(\d{1,2}(?::?\d{2})?\s*[AP]\.?M\.?)/i;
const LEFT_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday'];

const pad = (n) => String(n).padStart(2, '0');
const clean = (s) => String(s).replace(/\s+/g, ' ').trim();

// "S08 Alex M" → { name: 'Alex M', group: 8 }
function personOf(text) {
  const { name, group } = schedule.splitGroupPrefix(clean(text));
  return { name, group };
}

// One name cell → zero or more entries (role, name, group, ordinal).
function parseNameCell(text) {
  const t = clean(text);
  if (!t || /^\?+$/.test(t)) return [];
  // "S02 Ann A (F) Ben B, Cal C OS": a facilitator on the line
  // leading a group of observers.
  const f = t.match(/^(.*?)\s*\(F\)\s*(.*)$/i);
  if (f) {
    const lead = parseNameCell(f[1]).map((e) => ({ ...e, note: 'facilitator' }));
    return [...lead, ...parseNameCell(/\bOS\s*$/i.test(f[2]) ? f[2] : f[2] + ' OS')];
  }
  // Observers: "Dee D, Eve E OS", "Fay F OS", "S11 Gus G (10th OS)".
  const nth = t.match(/\((\d+)(?:st|nd|rd|th)\s*OS\)/i);
  if (nth || /\bOS\s*$/.test(t)) {
    const body = t.replace(/\(\d+(?:st|nd|rd|th)\s*OS\)/i, '').replace(/,?\s*\bOS\s*$/, '');
    return body.split(',').map((s) => s.trim()).filter(Boolean).map((s) => ({
      role: 'observer', ...personOf(s), ordinal: nth ? Number(nth[1]) : null, note: null }));
  }
  // Supervised: "S12 Joel H SS3" or "S12 Joel H (SS3)".
  const ss = t.match(/\(?\bSS\s?(\d+)\)?\s*$/i);
  if (ss) {
    return [{ role: 'supervised', ...personOf(t.slice(0, ss.index)), ordinal: Number(ss[1]), note: null }];
  }
  // Any other bracketed tag ("(OSA)") stays with the person as a slot note.
  const tag = t.match(/\s*\(([^)]{1,20})\)\s*$/);
  const name = tag ? t.slice(0, tag.index) : t;
  return [{ role: 'worker', ...personOf(name), ordinal: null, note: tag ? tag[1] : null }];
}

function hour24(t) {
  const m = String(t).match(/(\d{1,2})(?::?(\d{2}))?\s*([AP])/i);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3].toUpperCase() === 'P') h += 12;
  return h;
}

// grid: rows (0-based) of cell values — strings, booleans, dates, null.
// month: 'YYYY-MM'. Returns { entries, notes, skipped }.
function parseSheet(grid, month) {
  const entries = [];
  const notes = {};
  const skipped = [];
  let headers = null;           // [{ col, day, dayName }] for the current week
  let left = null;              // current shift label, Monday-Thursday side
  let right = null;             // current shift label, Friday-Sunday side

  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] || [];
    const found = [];
    row.forEach((v, c) => {
      if (typeof v !== 'string') return;
      const m = v.match(DAY_RE);
      if (m) found.push({ col: c, day: Number(m[2]), dayName: m[1].toLowerCase(), rest: clean(m[3]) });
    });
    if (found.length) {
      headers = found.sort((a, b) => a.col - b.col);
      left = null; right = null;
      for (const h of headers) {
        if (h.rest) notes[`${month}-${pad(h.day)}`] = h.rest;
      }
      continue;
    }
    if (!headers) continue;

    // Shift labels on this row: column before the first day block is the
    // left side's; any other is the weekend side's.
    const firstCol = headers[0].col;
    row.forEach((v, c) => {
      const m = typeof v === 'string' && v.match(LABEL_RE);
      if (!m) return;
      if (c < firstCol) left = Number(m[1]); else right = Number(m[1]);
    });

    for (let i = 0; i < headers.length; i++) {
      const h = headers[i];
      const end = i + 1 < headers.length ? headers[i + 1].col : h.col + 4;
      const date = `${month}-${pad(h.day)}`;
      for (let c = h.col; c < end; c++) {
        const v = row[c];
        if (typeof v !== 'string' || !v.trim() || LABEL_RE.test(v)) continue;
        const confirmed = row[c - 1] === true;
        const ocs = v.match(OCS_RE);
        if (ocs && /^\?+$/.test(ocs[1].trim())) { skipped.push({ cell: [r, c], reason: 'unfilled' }); continue; }
        if (ocs) {
          const startH = hour24(ocs[2]);
          entries.push({ date, shift: null, ocs: startH !== null && startH < 12 ? 'day' : 'night',
            role: 'supervisor', ...personOf(ocs[1]), ordinal: null, note: null, confirmed, cell: [r, c] });
          continue;
        }
        if (/\b(empty|shift)\b/i.test(v)) { skipped.push({ cell: [r, c], reason: 'note' }); continue; }
        const shift = LEFT_DAYS.includes(h.dayName) ? left : right;
        if (!shift) { skipped.push({ cell: [r, c], reason: 'no shift label above it' }); continue; }
        for (const e of parseNameCell(v)) {
          if (!e.name) continue;
          entries.push({ date, shift, ocs: null, ...e, confirmed, cell: [r, c] });
        }
      }
    }
  }
  return { entries, notes, skipped };
}

// Match the sheet's "Alex M" (+ group) to a worker. Full name first, then
// first name + surname initial; the group, when both sides have one, must
// agree. Returns { worker } or { error }.
function makeMatcher(workers) {
  const norm = (s) => String(s || '').toLowerCase().normalize('NFKD')
    .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const people = workers.map((w) => ({ w, names: [norm(w.name), norm(w.display_name)].filter(Boolean) }));
  return (name, group, role = null) => {
    const n = norm(name);
    const groupOk = (w) => !group || !w.support_group || Number(w.support_group) === group;
    let hits = people.filter((p) => p.names.includes(n) && groupOk(p.w));
    if (!hits.length) {
      const toks = n.split(' ');
      const first = toks[0];
      const initial = toks.length > 1 ? toks[toks.length - 1] : '';
      hits = people.filter((p) => groupOk(p.w) && p.names.some((full) => {
        const ft = full.split(' ');
        return ft[0] === first && (!initial || (ft.length > 1 && ft[ft.length - 1].startsWith(initial)));
      }));
    }
    // Two people share a first name and initial (and the cell gave no
    // group): if only one of them can take this kind of seat, it's them.
    if (hits.length > 1 && role) {
      const can = hits.filter((p) => schedule.eligibleForRole(p.w, role));
      if (can.length === 1) hits = can;
    }
    if (hits.length === 1) return { worker: hits[0].w };
    return { error: hits.length ? 'more than one match' : 'no match' };
  };
}

// Put the parsed month into the calendar. Dry run unless apply. Never
// notifies anyone (assign() would email every volunteer); one audit row.
async function importMonth(month, parsed, { apply = false, actorId = null } = {}) {
  if (!enabled()) throw new Error(`TELL-format workbook import is off for profile "${profile.profile().id}" (import.tellWorkbook)`);
  const workers = await db.all(
    `SELECT id, name, display_name, role, service_status, support_group FROM worker
     WHERE service_status != 'left'`);
  const match = makeMatcher(workers);
  const defs = await schedule.shiftDefs();
  const ocsDef = { day: defs.find((d) => d.kind === 'supervision' && d.number === 8),
    night: defs.find((d) => d.kind === 'supervision' && d.number === 9) };
  if (apply) await schedule.generateMonth(month, actorId);

  const report = { placed: 0, alreadyThere: 0, extraSeats: 0, notesAdded: 0,
    unmatched: [], ineligible: [] };
  for (const e of parsed.entries) {
    const label = `${e.date} ${e.ocs ? 'OCS ' + e.ocs : 'S' + e.shift} ${e.group ? schedule.groupTag(e.group) + ' ' : ''}${e.name}`;
    const m = match(e.name, e.group, e.role);
    if (!m.worker) { report.unmatched.push(`${label} (${m.error})`); continue; }
    if (!schedule.eligibleForRole(m.worker, e.role)) {
      report.ineligible.push(`${label}: ${m.worker.role} can't take a ${e.role} seat`);
      continue;
    }
    const def = e.ocs ? ocsDef[e.ocs] : defs.find((d) => d.number === e.shift);
    if (!def) { report.unmatched.push(`${label} (no such shift)`); continue; }
    const already = await db.get(
      `SELECT id FROM shift_slot WHERE date = ? AND shift_number = ? AND worker_id = ?
         AND status != 'cancelled'`, [e.date, def.number, m.worker.id]);
    if (already) { report.alreadyThere += 1; continue; }
    report.placed += 1;
    if (!apply) continue;
    const open = e.role === 'worker' || e.role === 'supervisor'
      ? await db.get(
        `SELECT id FROM shift_slot WHERE date = ? AND shift_number = ? AND role = ?
           AND worker_id IS NULL AND status = 'open' ORDER BY id LIMIT 1`,
        [e.date, def.number, e.role])
      : null;
    let slotId = open && Number(open.id);
    if (!slotId) {
      const times = def.kind === 'supervision'
        ? (schedule.timesOn(def, e.date) || { start: def.start, end: def.end }) : null;
      slotId = await db.insert(
        `INSERT INTO shift_slot (date, shift_number, role, start_time, end_time, created_at)
         VALUES (?,?,?,?,?,?)`,
        [e.date, def.number, e.role, times ? times.start : null, times ? times.end : null, db.now()]);
      if (e.role === 'worker') report.extraSeats += 1;
    }
    await db.run(
      `UPDATE shift_slot SET worker_id = ?, status = ?, confirmed_at = ?,
         note = COALESCE(?, note), training_no = ? WHERE id = ?`,
      [m.worker.id, e.confirmed ? 'confirmed' : 'assigned', e.confirmed ? db.now() : null,
        e.note ? String(e.note).slice(0, 60) : null, e.ordinal || null, slotId]);
  }
  for (const [date, note] of Object.entries(parsed.notes)) {
    const have = await db.get('SELECT note FROM schedule_note WHERE date = ?', [date]);
    if (have) continue;
    report.notesAdded += 1;
    if (apply) await db.run('INSERT INTO schedule_note (date, note) VALUES (?, ?)', [date, note.slice(0, 200)]);
  }
  if (apply) {
    await db.audit(actorId, 'schedule_imported', 'month', null,
      `${month}: ${report.placed} placed from the sheet, ${report.unmatched.length} unmatched`);
  }
  return report;
}

module.exports = { parseSheet, parseNameCell, makeMatcher, importMonth, enabled };
