'use strict';

// Out-of-band notification delivery. Two Google Chat incoming webhooks
// (both optional — everything degrades to the in-console signals):
//
//  - TL_NOTIFY_WEBHOOK_URL — the team channel. Backup pages, help requests,
//    shift assignments and substitution traffic land here, formatted as
//    human-readable Google Chat messages. TELL already lives in Google
//    Chat, so this reaches people who aren't looking at the console.
//  - TL_OPS_WEBHOOK_URL — the ops/maintainer channel for health alerts from
//    /api/cron/ops-check (falls back to the team webhook if unset).
//
// Any endpoint that accepts POST {"text": "..."} works (Google Chat spaces
// do natively: space → Apps & integrations → Webhooks). Messages carry
// METADATA ONLY — never chat content, intake content, or caller details.
// TL_BASE_URL (e.g. the production URL), when set, adds a console link to
// each message.

const { log } = require('./log');
const db = require('./db');
const mail = require('./mail');
const { brand } = require('./profile');

const link = (path) => {
  const base = (process.env.TL_BASE_URL || '').replace(/\/+$/, '');
  return base ? `\n${base}${path}` : '';
};

// One formatter per event kind. Anything unlisted falls back to a plain
// line, so a new event never fails silently. Everything is names, ids, dates
// and shift numbers: a help request's note stays in the console, because a
// worker may describe the caller in it and chat apps and inboxes keep
// copies (the ops test passes its own fixed text).
const FORMATS = {
  backup_page: () =>
    '🔔 *Backup page* — a caller is waiting and the shift needs help. ' +
    'Can you jump on?' + link('/console.html'),
  help_requested: (p) =>
    `🙋 *${p.from || 'A worker'} asked for help*` +
    (p.note ? `: ${p.note}` : '') + link('/console.html'),
  slot_assigned: (p) =>
    `📅 You've been assigned *Shift ${p.shift}* on *${p.date}*. ` +
    'Please confirm it on the schedule.' + link('/schedule.html'),
  // Auto-fill batches: one message per person with their whole list, and one
  // team post for the draft — never one message per slot.
  slots_assigned: (p) =>
    `📅 You've been assigned ${p.count} shift(s) for ${p.month}: ${p.list}. ` +
    'Please confirm them on the schedule.' + link('/schedule.html'),
  schedule_drafted: (p) =>
    `🗓️ The *${p.month}* schedule has been drafted from availability: ` +
    `${p.assigned} shift(s) across ${p.workers} people` +
    (p.openLeft ? `, ${p.openLeft} still open` : '') +
    '. Check *My shifts* and confirm yours.' + link('/schedule.html'),
  sub_request: (p) =>
    `🔁 *Cover wanted*: Shift ${p.shift} on ${p.date} needs a substitute.` +
    link('/schedule.html'),
  sub_taken: (p) =>
    `✅ Shift ${p.shift} on ${p.date} has been covered.` + link('/schedule.html'),
  ops_alert: (p) => `🚨 *${brand('name')} ops alert*\n${p.text || ''}`,
  ops_digest: (p) => `📋 *${brand('name')} daily check*\n${p.text || ''}`,
  // Personal kinds — these never post to the shared space, only to the
  // worker's own email (and only when they've opted in on My profile).
  shift_reminder: (p) =>
    `⏰ Reminder: you're on *Shift ${p.shift}* tomorrow, ${p.date}.` +
    link('/schedule.html'),
  feedback_left: () =>
    '💬 Your supervisor left feedback on one of your chats. ' +
    'It\'s waiting in your console.' + link('/console.html'),
  followup_assigned: (p) =>
    `📌 A follow-up has been assigned to you, due ${p.due}.` + link('/console.html'),
};

// Kinds that are about one person rather than the team: email-only.
const PERSONAL = new Set(['shift_reminder', 'feedback_left', 'followup_assigned',
  'slots_assigned']);

// Kinds that ride another kind's email opt-in instead of their own profile
// row: the batched auto-fill email is still "a shift is assigned to me".
const PREF_ALIAS = { slots_assigned: 'slot_assigned' };

// The email-preference catalogue My profile offers, with the labels shown
// there. Preferences live in worker.notify_prefs as {"email": {kind: true}}
// and default to OFF — the shared Google Chat space stays the baseline.
const EMAIL_PREFS = [
  ['slot_assigned', 'A shift is assigned to me'],
  ['shift_reminder', 'A reminder the day before my shift'],
  ['sub_request', 'A shift needs cover'],
  ['sub_taken', 'A cover request is resolved (staff)'],
  ['backup_page', "I'm paged as backup — a caller is waiting"],
  ['help_requested', 'A colleague asks for help (supervisors & staff)'],
  ['feedback_left', 'Feedback is left on one of my chats'],
  ['followup_assigned', 'A follow-up is assigned to me'],
];

const SUBJECTS = Object.fromEntries(EMAIL_PREFS.map(([k, label]) => [k, label]));

async function postWebhook(url, text) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
}

// Email copies for the workers an event concerns, honouring each worker's
// own opt-in. Same metadata-only text as the space, minus the markdown.
async function emailCopies(kind, workerIds, text) {
  if (!mail.configured() || !workerIds.length) return 0;
  const rows = await db.all(
    `SELECT email, notify_prefs FROM worker
     WHERE id IN (${workerIds.map(() => '?').join(',')}) AND service_status != 'left'`,
    workerIds);
  let sent = 0;
  const prefKind = PREF_ALIAS[kind] || kind;
  for (const w of rows) {
    let prefs;
    try { prefs = JSON.parse(w.notify_prefs || '{}'); } catch { prefs = {}; }
    if (!(prefs.email && prefs.email[prefKind])) continue;
    if (await mail.send(w.email, `${brand('name')} — ${SUBJECTS[prefKind] || prefKind}`,
      text.replace(/\*/g, ''))) sent += 1;
  }
  return sent;
}

// The seam every caller uses. workerIds is who the event concerns: team
// kinds post to the Google Chat space AND email each listed worker who has
// opted in; personal kinds go by email only. Returns true only on confirmed
// delivery somewhere.
async function notify(kind, workerIds, payload = {}) {
  log('notify', { kind, workers: workerIds.length });
  const format = FORMATS[kind] || (() => `${brand('name')}: ${kind}`);
  const text = format(payload);

  let posted = false;
  if (!PERSONAL.has(kind)) {
    const isOps = kind.startsWith('ops_');
    const url = (isOps && process.env.TL_OPS_WEBHOOK_URL) ||
      process.env.TL_NOTIFY_WEBHOOK_URL;
    if (url) {
      try {
        await postWebhook(url, text);
        posted = true;
      } catch (e) {
        log('notify_webhook_error', { kind, error: String(e).slice(0, 200) });
      }
    }
  }
  let emailed = 0;
  try {
    emailed = await emailCopies(kind, workerIds, text);
  } catch (e) {
    log('notify_email_error', { kind, error: String(e).slice(0, 200) });
  }
  return posted || emailed > 0;
}

module.exports = { notify, FORMATS, EMAIL_PREFS };
