'use strict';

process.env.TL_PGDATA = ':memory:';
process.env.TL_ENCRYPTION_KEY = '8'.repeat(64);

const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const schedule = require('../src/schedule');

// Production seeded the OCS blocks before weekly patterns existed, so its
// rows have days_json NULL. The first shiftDefs() after upgrade must give
// them the sheet's pattern once, and never overwrite an edited one.
test('OCS rows seeded without a pattern get the default pattern on upgrade', async () => {
  await db.init();
  // As in production: the worker shifts exist, and the OCS rows predate patterns.
  await db.run(
    `INSERT INTO shift_def (number, label, start_time, end_time, takeover_time, modes_json)
     VALUES (1,'Shift 1','08:30','12:30','09:00','{"default":"phone"}')`);
  await db.run(
    `INSERT INTO shift_def (number, label, start_time, end_time, takeover_time, modes_json, kind)
     VALUES (8,'OCS Day','09:00','21:00','09:00','{}','supervision'),
            (9,'OCS Night','21:00','09:00','21:00','{}','supervision')`);
  const defs = await schedule.shiftDefs();
  const night = defs.find((d) => d.number === 9);
  assert.deepStrictEqual(night.days,
    { fri: ['21:00', '02:00'], sat: ['21:00', '09:00'], sun: ['21:00', '09:00'] });
});
