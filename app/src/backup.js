'use strict';

// Encrypted full-database export/restore, for off-site copies during UAT and
// beyond. The dump is one JSON document of every durable table, encrypted
// with the app key (AES-256-GCM via crypto.js) — so a stolen backup file is
// useless without TL_ENCRYPTION_KEY, and the key TELL already guards is the
// only thing to keep alongside the files. Transient tables (sessions, rate
// limits, sign-in codes) are deliberately left out.
//
// Restore order matters for foreign keys: parents first. Restoring DELETES
// what is in the target database first — it is for standing up a replacement
// instance, not merging.

const db = require('./db');
const sec = require('./crypto');

const TABLES = [
  'worker', 'program', 'worker_program',
  'caller', 'contact', 'contact_observer', 'message',
  'canned_response', 'help_request', 'event_log', 'audit_log',
  'form_def', 'directive', 'resource', 'contact_referral',
  'followup', 'feedback',
  'shift_def', 'availability', 'shift_slot', 'schedule_note',
  'board_topic', 'board_post', 'board_read',
  'skill_achievement', 'error_log', 'config',
  'issue_report', 'issue_note',
];

const FORMAT = 'tell-backup-1';

async function dump() {
  const out = { format: FORMAT, at: db.now(), tables: {} };
  for (const t of TABLES) {
    out.tables[t] = await db.all(`SELECT * FROM ${t} ORDER BY 1`);
  }
  return out;
}

async function exportEncrypted() {
  return sec.encrypt(JSON.stringify(await dump()));
}

function decryptExport(blob) {
  const parsed = JSON.parse(sec.decrypt(String(blob).trim()));
  if (parsed.format !== FORMAT) {
    throw new Error(`not a recognised backup (format ${parsed.format || 'missing'})`);
  }
  return parsed;
}

// Wipes the target tables and loads the dump. BIGSERIAL sequences are reset
// so new rows keep getting fresh ids after a restore.
async function restore(parsed) {
  const counts = {};
  for (const t of [...TABLES].reverse()) {
    await db.run(`DELETE FROM ${t}`);
  }
  for (const t of TABLES) {
    const rows = parsed.tables[t] || [];
    for (const row of rows) {
      const keys = Object.keys(row);
      await db.run(
        `INSERT INTO ${t} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
        keys.map((k) => row[k]));
    }
    counts[t] = rows.length;
    if (rows.length && rows[0].id !== undefined) {
      await db.run(
        `SELECT setval(pg_get_serial_sequence('${t}','id'), (SELECT MAX(id) FROM ${t}))`);
    }
  }
  return counts;
}

module.exports = { dump, exportEncrypted, decryptExport, restore, TABLES, FORMAT };
