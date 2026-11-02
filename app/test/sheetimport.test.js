'use strict';

// Importing a month from TELL's scheduling sheet: the parser reads the
// sheet's layout (day header rows, S1-S7 labels on each side, "S08 Name"
// cells with checkboxes, OS/SS trainees, free-text On Call Supervisors),
// and the import places people without notifying anyone. Names are made up.

process.env.TL_PGDATA = ':memory:';
process.env.TL_ENCRYPTION_KEY = '3'.repeat(64);

const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const sec = require('../src/crypto');
const { parseSheet, parseNameCell, importMonth } = require('../src/sheetimport');

test.before(async () => { await db.init(); });

// A week in the sheet's shape: col 0 = left labels, Mon block from col 1,
// Fri block from col 17 (its first column also holds weekend labels), Sat
// from 22, Sun from 26, right labels at 30. Two cells per person: the
// checkbox, then the name.
function week() {
  const g = [];
  const row = (cells) => { const r = []; for (const [c, v] of Object.entries(cells)) r[c] = v; g.push(r); };
  row({ 1: 'Monday 2', 5: 'Tuesday 3', 9: 'Wednesday 4', 13: 'Thursday 5   Group 1 7 pm',
    17: 'Friday 6', 22: 'Saturday 7', 26: 'Sunday 8' });
  row({ 0: 'S1', 1: true, 2: 'S03 Ann Able', 5: false, 6: 'S04 Ben Bold', 17: 'S1', 18: false,
    19: 'S05 Cal Cole', 26: false, 27: 'S05 Cal Cole' });
  row({ 0: 'S4', 1: false, 2: 'S07 Dee Dane', 3: false, 4: 'S08 Eve Earl', 17: 'S4',
    22: false, 23: 'S08 Eve Earl', 30: 'S4' });
  row({ 2: 'S09 Fay Ford SS3', 4: 'Gus Gray, Hal Hunt OS', 27: 'S10 Ivy Ince (10th OS)' });
  row({ 17: 'S5', 18: false, 19: 'S02 Jo Jay', 30: 'S5' });
  row({ 22: 'On-call Supervisor Kim Kerr 9 AM - 9 PM', 26: 'On-call Supervisor  Lee Lamb 9PM - 9AM' });
  row({ 31: 'Empty chat shift' });
  return g;
}

test('parses names, groups, roles, trainee counts, supervisors and day notes', () => {
  const { entries, notes } = parseSheet(week(), '2026-11');
  const pick = (date, name) => entries.find((e) => e.date === date && e.name === name);
  assert.deepStrictEqual(
    (({ shift, role, group, confirmed }) => ({ shift, role, group, confirmed }))(pick('2026-11-02', 'Ann Able')),
    { shift: 1, role: 'worker', group: 3, confirmed: true });
  assert.strictEqual(pick('2026-11-06', 'Cal Cole').shift, 1, 'Friday uses the weekend-side label');
  assert.strictEqual(pick('2026-11-08', 'Cal Cole').shift, 1);
  assert.strictEqual(pick('2026-11-07', 'Eve Earl').shift, 4);
  const fay = pick('2026-11-02', 'Fay Ford');
  assert.deepStrictEqual([fay.role, fay.ordinal, fay.group, fay.shift], ['supervised', 3, 9, 4]);
  assert.strictEqual(pick('2026-11-02', 'Gus Gray').role, 'observer');
  assert.strictEqual(pick('2026-11-02', 'Hal Hunt').role, 'observer');
  assert.strictEqual(pick('2026-11-08', 'Ivy Ince').ordinal, 10);
  assert.strictEqual(pick('2026-11-06', 'Jo Jay').shift, 5);
  assert.strictEqual(pick('2026-11-07', 'Kim Kerr').ocs, 'day');
  assert.strictEqual(pick('2026-11-08', 'Lee Lamb').ocs, 'night');
  assert.deepStrictEqual(notes, { '2026-11-05': 'Group 1 7 pm' });
  assert.ok(!entries.some((e) => /shift/i.test(e.name)), 'notes beside the grid are not people');
});

test('cell formats seen in the real sheet', () => {
  assert.deepStrictEqual(parseNameCell('S12 Fay Ford (SS1)').map((e) => [e.role, e.ordinal]), [['supervised', 1]]);
  const fac = parseNameCell('S02 Mo Moss (F) Ned North, Oz Orr OS');
  assert.deepStrictEqual(fac.map((e) => [e.role, e.name, e.note]),
    [['worker', 'Mo Moss', 'facilitator'], ['observer', 'Ned North', null], ['observer', 'Oz Orr', null]]);
  assert.deepStrictEqual(parseNameCell('S10 Pat Pike\n (OSA)').map((e) => [e.role, e.name, e.note]),
    [['worker', 'Pat Pike', 'OSA']]);
  assert.deepStrictEqual(parseNameCell('???'), []);
});

test('import matches "First I" to accounts, places people silently, and is re-runnable', async () => {
  const add = (name, role, group) => db.insert(
    `INSERT INTO worker (email, name, password_hash, role, support_group, created_at) VALUES (?,?,?,?,?,?)`,
    [`${name.replace(/\W/g, '')}@sheet.test`, name, sec.hashPassword('x'.repeat(12)), role, group, db.now()]);
  const ann = await add('Ann Abbott', 'worker', 3);
  await add('Ann Archer', 'worker', 6);            // same first name + initial, other group
  await add('Kim Kerr', 'supervisor', null);
  await add('Fay Fordham', 'trainee', 9);
  const coord = await add('Cora Coord', 'coordinator', null);
  const grid = [
    ['', 'Monday 2'], ['S1', true, 'S03 Ann A'],
    ['S2', false, 'Ann A'],                         // no group: ambiguous
    ['S4', false, 'S09 Fay F SS2'],
    [null, 'On-call Supervisor Kim K 9 AM - 9 PM'],
    [null, false, 'S01 Zed Zane'],
  ];
  const parsed = parseSheet(grid, '2027-08');
  const dry = await importMonth('2027-08', parsed, { actorId: coord });
  assert.strictEqual(dry.placed, 3);
  assert.strictEqual(dry.unmatched.length, 2);
  assert.match(dry.unmatched.join('\n'), /Ann A \(more than one match\)/);
  assert.match(dry.unmatched.join('\n'), /Zed Zane \(no match\)/);
  assert.strictEqual(Number((await db.get(`SELECT COUNT(*) AS n FROM shift_slot WHERE date LIKE '2027-08%'`)).n), 0,
    'dry run writes nothing');

  const r = await importMonth('2027-08', parsed, { apply: true, actorId: coord });
  assert.strictEqual(r.placed, 3);
  const s1 = await db.get(`SELECT * FROM shift_slot WHERE date = '2027-08-02' AND shift_number = 1 AND role = 'worker'`);
  assert.strictEqual(Number(s1.worker_id), ann);
  assert.strictEqual(s1.status, 'confirmed', 'ticked box → confirmed');
  const ss = await db.get(`SELECT * FROM shift_slot WHERE date = '2027-08-02' AND shift_number = 4 AND role = 'supervised'`);
  assert.ok(ss && ss.status === 'assigned');
  const slots = await require('../src/schedule').monthSlots('2027-08');
  assert.strictEqual(slots.find((s) => s.id === Number(ss.id)).ordinal, 2, 'keeps the sheet\'s SS2');
  const ocs = await db.get(`SELECT * FROM shift_slot WHERE date = '2027-08-02' AND shift_number = 8`);
  assert.ok(ocs && ocs.worker_id, 'Monday OCS added on an off day');
  const again = await importMonth('2027-08', parsed, { apply: true, actorId: coord });
  assert.strictEqual(again.placed, 0);
  assert.strictEqual(again.alreadyThere, 3);
  const audit = await db.get(`SELECT detail FROM audit_log WHERE action = 'schedule_imported' ORDER BY id LIMIT 1`);
  assert.match(audit.detail, /2027-08: 3 placed from the sheet, 2 unmatched/);
});
