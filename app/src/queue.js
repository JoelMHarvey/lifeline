'use strict';

// Queue + routing, async over Postgres. Claim-based model unchanged: waiting
// callers are visible to every eligible worker; accepting claims atomically
// (UPDATE ... WHERE worker_id IS NULL) so two workers can never land on the
// same caller. Programs scope claims and paging; trainees never claim.
//
// Serverless changes: abandonment is detected via contact.caller_seen_at
// (refreshed by the caller's stream heartbeat) instead of socket close, and
// the sweep is throttled through the DB so concurrent instances don't stampede.

const crypto = require('node:crypto');
const db = require('./db');
const sec = require('./crypto');
const { log } = require('./log');
const { notify } = require('./notify');

async function joinQueue({ callerToken, alias, triage }) {
  let caller = callerToken
    ? await db.get('SELECT * FROM caller WHERE token = ?', [callerToken])
    : null;
  if (!caller) {
    const token = crypto.randomBytes(16).toString('hex');
    const id = await db.insert(
      'INSERT INTO caller (token, alias, first_seen) VALUES (?,?,?)',
      [token, alias || null, db.now()]);
    caller = { id, token };
  } else if (alias) {
    await db.run('UPDATE caller SET alias = ? WHERE id = ?', [alias, caller.id]);
  }

  // Priority boost for risk signals in the pre-chat survey. New shape is
  // {form, version, answers}; the legacy {concern, safe} widget shape still
  // boosts on safe === 'no'.
  const a = (triage && triage.answers) || {};
  const priority = (a.suicidal_thoughts === 'yes' || a.self_harm === 'recent' ||
    (triage && triage.safe === 'no')) ? 1 : 0;
  const chatToken = crypto.randomBytes(16).toString('hex');
  const contactId = await db.insert(
    `INSERT INTO contact (caller_id, program_id, chat_token, triage_json, priority, queued_at, caller_seen_at)
     VALUES (?,?,?,?,?,?,?)`,
    [caller.id, await db.chatProgramId(), chatToken,
      sec.encrypt(JSON.stringify(triage || {})), priority, db.now(), db.now()]);

  await db.eventLog('queue_join', { contactId });
  log('queue_join', { contactId, priority });
  return { contactId, chatToken, callerToken: caller.token };
}

function triageOf(contactRow) {
  try { return JSON.parse(sec.decrypt(contactRow.triage_json)); } catch { return {}; }
}
function intakeOf(contactRow) {
  try { return JSON.parse(sec.decrypt(contactRow.intake_json)); } catch { return {}; }
}

async function waiting() {
  return db.all(
    `SELECT contact.*, caller.alias, caller.token AS caller_token,
            (SELECT COUNT(*) FROM contact c2 WHERE c2.caller_id = contact.caller_id
               AND c2.id != contact.id) AS prior_contacts
     FROM contact JOIN caller ON caller.id = contact.caller_id
     WHERE worker_id IS NULL AND outcome IS NULL
     ORDER BY priority DESC, queued_at ASC`);
}

async function queuePosition(contactId) {
  const rows = await waiting();
  const i = rows.findIndex((r) => Number(r.id) === Number(contactId));
  return i === -1 ? null : i + 1;
}

async function activeChats(workerId) {
  return db.all(
    `SELECT contact.*, caller.alias FROM contact JOIN caller ON caller.id = contact.caller_id
     WHERE worker_id = ? AND ended_at IS NULL`, [workerId]);
}

async function workerHasCapacity(workerId) {
  const max = Number(await db.getConfig('max_active_chats'));
  // A phone intake in progress isn't a chat; the console asks the worker to
  // finish or discard it before taking one.
  return (await activeChats(workerId)).filter((c) => c.channel !== 'phone').length < max;
}

async function eligibleToClaim(worker, contact) {
  if (!worker || worker.role === 'trainee') return false;
  if (worker.service_status !== 'in_service') return false;
  if (contact.program_id &&
      !(await db.workerInProgram(worker.id, contact.program_id))) return false;
  return workerHasCapacity(worker.id);
}

// Atomic claim. Returns the claimed contact row, or null if ineligible or
// someone else won the race (or the caller abandoned).
async function claim(contactId, worker) {
  const contact = await db.get('SELECT * FROM contact WHERE id = ?', [contactId]);
  if (!contact || !(await eligibleToClaim(worker, contact))) return null;
  const waitSecs = Math.max(0, Math.round((Date.now() - Date.parse(contact.queued_at)) / 1000));
  const r = await db.run(
    `UPDATE contact SET worker_id = ?, claimed_at = ?, queue_wait_secs = ?
     WHERE id = ? AND worker_id IS NULL AND outcome IS NULL`,
    [worker.id, db.now(), waitSecs, contactId]);
  if (r.changes === 0) return null;
  await db.eventLog('claim', { contactId, workerId: worker.id });
  log('claim', { contactId: Number(contactId), workerId: worker.id, waitSecs });
  return db.get('SELECT * FROM contact WHERE id = ?', [contactId]);
}

// unclaimedOnly: don't end a contact a worker claimed a moment ago. The
// safety valve uses it: a chat or call accepted at the valve's edge stays
// with the worker who accepted it instead of being closed under them.
async function endContact(contactId, outcome, { unclaimedOnly = false } = {}) {
  const contact = await db.get('SELECT queued_at, queue_wait_secs FROM contact WHERE id = ? AND outcome IS NULL',
    [contactId]);
  if (!contact) return false;
  const waitSecs = contact.queue_wait_secs ??
    Math.max(0, Math.round((Date.now() - Date.parse(contact.queued_at)) / 1000));
  const r = await db.run(
    `UPDATE contact SET ended_at = ?, outcome = ?, queue_wait_secs = ?
     WHERE id = ? AND outcome IS NULL${unclaimedOnly ? ' AND worker_id IS NULL' : ''}`,
    [db.now(), outcome, waitSecs, contactId]);
  if (r.changes > 0) {
    await db.eventLog('contact_end_' + outcome, { contactId });
    log('contact_end', { contactId: Number(contactId), outcome });
  }
  return r.changes > 0;
}

// The sweep runs opportunistically from stream heartbeats (and the guarded
// /api/cron/sweep endpoint). A DB-side throttle makes concurrent callers
// cheap: only one instance per ~5s actually does the work.
async function maybeSweep() {
  const nowMs = Date.now();
  const r = await db.run(
    `UPDATE config SET value = ? WHERE key = 'last_sweep_at' AND CAST(value AS BIGINT) < ?`,
    [String(nowMs), nowMs - 5000]);
  if (r.changes === 0) return { toPage: [], toClose: [], abandoned: [] };
  return sweep();
}

async function sweep() {
  const pageAfter = Number(await db.getConfig('backup_page_after_secs'));
  const valveAfter = Number(await db.getConfig('safety_valve_after_secs'));
  const staleAfter = Number(await db.getConfig('caller_stale_after_secs'));
  const toPage = [];
  const toClose = [];
  const abandoned = [];
  for (const c of await waiting()) {
    const waitSecs = (Date.now() - Date.parse(c.queued_at)) / 1000;
    const seenAgo = c.caller_seen_at
      ? (Date.now() - Date.parse(c.caller_seen_at)) / 1000 : 0;
    // A phone call has no browser to go quiet — the provider reports its
    // hangup (src/voice). A web call's page polls, so it can go stale.
    const isVoice = c.channel === 'voice';
    const watched = !isVoice || String(c.caller_token || '').startsWith('voice-web:');
    if (watched && seenAgo >= staleAfter) {
      // Caller's stream went silent while waiting = abandoned.
      if (await endContact(c.id, 'abandoned')) {
        abandoned.push(c);
        if (isVoice) {
          try { await require('./voice').dropAbandoned(c); } catch { /* best effort */ }
        }
      }
    } else if (waitSecs >= valveAfter) {
      if (await endContact(c.id, 'timed_out', { unclaimedOnly: true })) {
        toClose.push(c);
        // Never silence: a call goes to the overflow number or hears the
        // safety-valve message. overflow() never throws, and this must not
        // stop the pass (backups below still get paged).
        if (isVoice) {
          try { await require('./voice').overflow(c); } catch { /* logged inside */ }
        }
      }
    } else if (waitSecs >= pageAfter && !c.paged_at) {
      await db.run('UPDATE contact SET paged_at = ? WHERE id = ?', [db.now(), c.id]);
      await db.eventLog('backup_paged', { contactId: c.id });
      log('backup_paged', { contactId: Number(c.id), waitSecs: Math.round(waitSecs) });
      toPage.push(c);
    }
  }
  // Out-of-band webhook for pages — the in-console banner arrives via the
  // worker streams; this reaches backups who aren't at a computer.
  for (const c of toPage) {
    const backups = await backupsFor(c);
    if (backups.length) {
      notify('backup_page', backups.map((b) => Number(b.id)), { contactId: Number(c.id) })
        .catch(() => {});
    }
  }
  return { toPage, toClose, abandoned };
}

async function backupsFor(contact) {
  return db.all(
    `SELECT worker.* FROM worker
     JOIN worker_program wp ON wp.worker_id = worker.id
     WHERE worker.status = 'backup' AND worker.role != 'trainee'
       AND worker.service_status = 'in_service' AND wp.program_id = ?`,
    [contact.program_id || await db.chatProgramId()]);
}

async function setStatus(workerId, status) {
  await db.run('UPDATE worker SET status = ?, status_updated_at = ? WHERE id = ?',
    [status, db.now(), workerId]);
  await db.eventLog('worker_status_' + status, { workerId });
}

async function workersByStatus() {
  return db.all(
    `SELECT id, name, role, status FROM worker
     WHERE service_status = 'in_service' ORDER BY name`);
}

async function onCallSupervisor() {
  return db.get(
    `SELECT id, name, phone, status FROM worker
     WHERE role IN ('supervisor','coordinator') AND status != 'off'
       AND service_status = 'in_service'
     ORDER BY CASE status WHEN 'on_shift' THEN 0 ELSE 1 END, status_updated_at DESC
     LIMIT 1`);
}

module.exports = {
  joinQueue, waiting, queuePosition, activeChats, workerHasCapacity,
  eligibleToClaim, claim, endContact, sweep, maybeSweep, backupsFor,
  setStatus, workersByStatus, onCallSupervisor, triageOf, intakeOf,
};
