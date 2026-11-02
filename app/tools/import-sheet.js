#!/usr/bin/env node
'use strict';

// TELL-format workbook import: one month tab of TELL's Excel schedule into
// the shift calendar. Refuses to run unless the profile sets
// import.tellWorkbook (TELL's does).
//
//   node tools/import-sheet.js <schedule.xlsx> --tab "2026 November" [--month 2026-11] [--apply]
//
// Dry run by default: prints what would be placed and every name it could
// not match to a volunteer account. --apply writes it (no notifications are
// sent). Uses DATABASE_URL / TL_PGDATA like the server. Run the volunteer CSV
// import first so names have accounts to match.

const ExcelJS = require('exceljs');
const db = require('../src/db');
const { parseSheet, importMonth, enabled } = require('../src/sheetimport');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];

function monthFromTab(tab) {
  const t = tab.toLowerCase();
  const year = (t.match(/\b(20\d\d)\b/) || [])[1];
  const mi = MONTHS.findIndex((m) => t.includes(m));
  return year && mi !== -1 ? `${year}-${String(mi + 1).padStart(2, '0')}` : null;
}

// Cell value → plain value. Merged cells: only the top-left cell carries
// the value, so names spanning columns aren't read twice.
function plain(cell) {
  if (cell.isMerged && cell.master && cell.master.address !== cell.address) return null;
  const v = cell.value;
  if (v && typeof v === 'object') {
    if (v.richText) return v.richText.map((p) => p.text).join('');
    if ('result' in v) return v.result;
    if (v.text) return v.text;
    if (v instanceof Date) return v;
  }
  return v;
}

async function main() {
  if (!enabled()) {
    console.error('TELL-format workbook import is not enabled for this profile (import.tellWorkbook).');
    process.exit(2);
  }
  const file = process.argv[2];
  const tab = arg('--tab');
  const apply = process.argv.includes('--apply');
  if (!file || !tab) {
    console.error('usage: node tools/import-sheet.js <schedule.xlsx> --tab "2026 November" [--month 2026-11] [--apply]');
    process.exit(2);
  }
  const month = arg('--month') || monthFromTab(tab);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || '')) {
    console.error(`can't tell the month from "${tab}" — pass --month YYYY-MM`);
    process.exit(2);
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet(tab);
  if (!ws) {
    console.error(`no tab "${tab}". Visible tabs: ` +
      wb.worksheets.filter((w) => w.state === 'visible').map((w) => w.name).join(', '));
    process.exit(2);
  }
  const grid = [];
  ws.eachRow({ includeEmpty: true }, (row, r) => {
    const out = [];
    row.eachCell({ includeEmpty: true }, (cell, c) => { out[c - 1] = plain(cell); });
    grid[r - 1] = out;
  });

  await db.init();
  const parsed = parseSheet(grid, month);
  const report = await importMonth(month, parsed, { apply });
  console.log(`${apply ? 'Imported' : 'Dry run for'} ${month} from "${tab}"`);
  console.log(`  read from the sheet:   ${parsed.entries.length} people-shifts, ${Object.keys(parsed.notes).length} day notes`);
  console.log(`  ${apply ? 'placed' : 'would place'}:          ${report.placed}` +
    (report.extraSeats ? ` (${report.extraSeats} needed an extra seat beyond the weekly pattern)` : ''));
  console.log(`  already in the app:    ${report.alreadyThere}`);
  console.log(`  day notes ${apply ? 'added' : 'to add'}:      ${report.notesAdded}`);
  if (report.unmatched.length) {
    console.log(`\n  Not matched to a volunteer account (${report.unmatched.length}):`);
    for (const u of report.unmatched) console.log('    ' + u);
  }
  if (report.ineligible.length) {
    console.log(`\n  Wrong role for the seat (${report.ineligible.length}):`);
    for (const u of report.ineligible) console.log('    ' + u);
  }
  if (!apply) console.log('\nNothing written. Add --apply to import.');
  await db.close?.();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
