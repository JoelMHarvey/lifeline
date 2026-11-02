'use strict';

// Wallboard / metrics queries, async. "Today" is the organisation's day
// (profile timezone), from local midnight.

const db = require('./db');
const queue = require('./queue');
const schedule = require('./schedule');
const tz = require('./tz');

function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function todayStats() {
  const since = new Date(tz.dayStart()).toISOString();

  const contacts = await db.all(
    'SELECT outcome, queue_wait_secs FROM contact WHERE queued_at >= ?', [since]);

  const waits = contacts
    .map((c) => c.queue_wait_secs)
    .filter((w) => w !== null && w !== undefined)
    .map(Number)
    .sort((a, b) => a - b);

  return {
    contacts_today: contacts.length,
    completed: contacts.filter((c) => c.outcome === 'completed').length,
    abandoned: contacts.filter((c) => c.outcome === 'abandoned').length,
    timed_out: contacts.filter((c) => c.outcome === 'timed_out').length,
    wait_p50_secs: percentile(waits, 50),
    wait_p95_secs: percentile(waits, 95),
  };
}

async function snapshot() {
  const q = await queue.waiting();
  const oldest = q.reduce(
    (m, c) => Math.max(m, (Date.now() - Date.parse(c.queued_at)) / 1000), 0);
  const active = await db.get(
    `SELECT COUNT(*) AS n FROM contact WHERE worker_id IS NOT NULL AND ended_at IS NULL
       AND channel = 'chat'`);
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  return {
    queue_depth: q.length,
    longest_wait_secs: Math.round(oldest),
    active_chats: Number(active.n),
    workers: await queue.workersByStatus(),
    today: await todayStats(),
    open_help_requests: await db.all(
      `SELECT help_request.id, help_request.note, help_request.created_at,
              worker.name AS worker_name, help_request.contact_id
       FROM help_request JOIN worker ON worker.id = help_request.worker_id
       WHERE resolved_at IS NULL ORDER BY help_request.id DESC`),
    // The manual's end-of-shift check, always on screen: shifts starting in
    // the next 24h that nobody has confirmed (or that have no one assigned).
    unconfirmed_24h: await schedule.unconfirmedNext24h(),
    // Contacts flagged "other workers should be aware" on the intake, so the
    // wallboard mirrors iCarol's highlighted-report row on the Calls page.
    highlighted: await db.all(
      `SELECT contact.id, contact.ended_at, caller.alias, worker.name AS worker_name
       FROM contact JOIN caller ON caller.id = contact.caller_id
       LEFT JOIN worker ON worker.id = contact.worker_id
       WHERE contact.highlight = 1 AND contact.queued_at >= ?
       ORDER BY contact.id DESC LIMIT 10`, [weekAgo]),
  };
}

module.exports = { snapshot, todayStats };
