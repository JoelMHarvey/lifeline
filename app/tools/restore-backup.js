#!/usr/bin/env node
'use strict';

// Restore an encrypted backup file into a database. DESTRUCTIVE: the target
// database's content is replaced by the backup's.
//
//   TL_ENCRYPTION_KEY=... DATABASE_URL=... node tools/restore-backup.js <file> --yes
//
// Point DATABASE_URL (or TL_PGDATA for a local PGlite directory) at the
// TARGET — typically a fresh Neon database when standing a replacement up.
// The key must be the same one the backup was taken under.

const fs = require('node:fs');
const path = require('node:path');

const file = process.argv[2];
const confirmed = process.argv.includes('--yes');
if (!file) {
  console.error('usage: node tools/restore-backup.js <backup file> --yes');
  process.exit(1);
}
if (!confirmed) {
  console.error('Refusing without --yes: restoring REPLACES everything in the target database.');
  process.exit(1);
}

process.chdir(path.join(__dirname, '..'));
const db = require('../src/db');
const backup = require('../src/backup');

(async () => {
  const blob = fs.readFileSync(file, 'utf8');
  const parsed = backup.decryptExport(blob); // throws on wrong key or bad file
  console.log(`Backup from ${parsed.at} — restoring ${backup.TABLES.length} tables…`);
  await db.init();
  const counts = await backup.restore(parsed);
  for (const [t, n] of Object.entries(counts)) {
    if (n) console.log(`  ${t}: ${n} rows`);
  }
  console.log('Done. Sessions were not restored — everyone signs in again.');
  process.exit(0);
})().catch((e) => {
  console.error('Restore failed:', e.message);
  process.exit(1);
});
