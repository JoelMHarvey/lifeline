'use strict';

// Record keeping: conversations older than the retention period are deleted
// for good. "Conversation" means a contact and everything recorded about it:
// chat transcript, triage and intake answers, supervisor feedback, referrals
// and observers. Closed follow-ups, retired directives and help requests past
// the period go too, and so does a caller once nothing refers to them.
//
// Open follow-ups and active directives stay: they are standing instructions
// someone still has to act on. Audit and event logs keep ids and times only,
// so they stay. Backups keep whatever they held when they were taken.
//
// The period is the config value retention_days (default 365; 0 keeps
// everything). Coordinators change it on the Admin page. It runs from the
// ops check and hourly on a long-running server, a bounded batch at a time.

const db = require('./db');

const DEFAULT_DAYS = 365;
const MIN_DAYS = 30;
const MAX_DAYS = 3650;
const BATCH = 500;
const MAX_BATCHES = 10; // up to 5,000 contacts per run; the next run continues

async function days() {
  const n = Number(await db.getConfig('retention_days'));
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_DAYS;
}

// 0 (keep everything) or a whole number of days between MIN and MAX.
function validDays(n) {
  return Number.isInteger(n) && (n === 0 || (n >= MIN_DAYS && n <= MAX_DAYS));
}

async function setDays(n, actorId) {
  if (!validDays(n)) return { error: `choose 0 (keep everything) or ${MIN_DAYS}–${MAX_DAYS} days` };
  const before = await days();
  await db.run(`INSERT INTO config (key, value) VALUES ('retention_days', ?)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [String(n)]);
  await db.audit(actorId, 'retention_changed', null, null, `${before} → ${n} days`);
  return { ok: true, days: n };
}

const cutoffFor = (d, nowMs) => new Date(nowMs - d * 86_400_000).toISOString();

async function purge({ nowMs = Date.now() } = {}) {
  const d = await days();
  const result = { days: d, contacts: 0, followups: 0, directives: 0, helpRequests: 0, callers: 0 };
  if (!d) return result;
  const cutoff = cutoffFor(d, nowMs);

  // Finished contacts past the period, and any never-finished one queued
  // before it (an old abandoned wait the sweep never closed).
  for (let i = 0; i < MAX_BATCHES; i++) {
    const rows = await db.all(
      `SELECT id FROM contact
        WHERE (ended_at IS NOT NULL AND ended_at < ?)
           OR (ended_at IS NULL AND queued_at < ?)
        ORDER BY id LIMIT ${BATCH}`, [cutoff, cutoff]);
    if (!rows.length) break;
    const ids = rows.map((r) => Number(r.id));
    const marks = ids.map(() => '?').join(',');
    for (const t of ['contact_referral', 'contact_observer', 'message', 'feedback']) {
      await db.run(`DELETE FROM ${t} WHERE contact_id IN (${marks})`, ids);
    }
    for (const t of ['help_request', 'followup']) {
      await db.run(`UPDATE ${t} SET contact_id = NULL WHERE contact_id IN (${marks})`, ids);
    }
    await db.run(`DELETE FROM contact WHERE id IN (${marks})`, ids);
    result.contacts += ids.length;
    if (ids.length < BATCH) break;
  }

  const count = async (sql, params) => Number((await db.get(sql, params)).n);
  result.followups = await count(
    `SELECT COUNT(*) AS n FROM followup WHERE status <> 'open' AND COALESCE(done_at, created_at) < ?`, [cutoff]);
  await db.run(
    `DELETE FROM followup WHERE status <> 'open' AND COALESCE(done_at, created_at) < ?`, [cutoff]);
  result.directives = await count(
    'SELECT COUNT(*) AS n FROM directive WHERE retired_at IS NOT NULL AND retired_at < ?', [cutoff]);
  await db.run('DELETE FROM directive WHERE retired_at IS NOT NULL AND retired_at < ?', [cutoff]);
  result.helpRequests = await count('SELECT COUNT(*) AS n FROM help_request WHERE created_at < ?', [cutoff]);
  await db.run('DELETE FROM help_request WHERE created_at < ?', [cutoff]);

  const orphans = `FROM caller WHERE first_seen < ?
      AND NOT EXISTS (SELECT 1 FROM contact WHERE contact.caller_id = caller.id)
      AND NOT EXISTS (SELECT 1 FROM followup WHERE followup.caller_id = caller.id)
      AND NOT EXISTS (SELECT 1 FROM directive WHERE directive.caller_id = caller.id)`;
  result.callers = await count(`SELECT COUNT(*) AS n ${orphans}`, [cutoff]);
  await db.run(`DELETE ${orphans}`, [cutoff]);

  if (result.contacts || result.followups || result.directives || result.helpRequests || result.callers) {
    await db.audit(null, 'retention_purge', null, null,
      `${result.contacts} contacts, ${result.followups} follow-ups, ${result.directives} directives, ` +
      `${result.helpRequests} help requests, ${result.callers} callers (older than ${d} days)`);
  }
  return result;
}

module.exports = { days, setDays, validDays, purge, DEFAULT_DAYS, MIN_DAYS, MAX_DAYS };
