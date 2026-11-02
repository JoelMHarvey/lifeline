'use strict';

// Canned responses: the ready-made replies a support worker picks with "/"
// in the console. Shared ones (worker_id NULL) are for everyone and are
// managed by supervisors and coordinators; personal ones belong to the
// worker who wrote them and only they see them. Templates, not caller data,
// so they're stored as plain text.

const db = require('./db');

const profile = require('./profile');

// The starter set, offered to supervisors when there are no shared ones yet
// (and used by the dev seed). It is the organisation's own
// (profiles/<id>.json canned.starter): it names the organisation and its
// emergency numbers, and the qualification scripts come from its manual.
const starter = () => profile.profile().canned.starter;

const MAX_LABEL = 60;
const MAX_BODY = 2000;
const RANK = { trainee: 0, worker: 1, supervisor: 2, coordinator: 3 };
const canShare = (worker) => (RANK[worker.role] || 0) >= RANK.supervisor;

function clean({ label, body } = {}) {
  const l = String(label || '').replace(/\s+/g, ' ').trim();
  const b = String(body || '').trim();
  if (!l) return { error: 'Give it a short name, e.g. "Welcome".' };
  if (!b) return { error: 'Write the message itself.' };
  if (l.length > MAX_LABEL) return { error: `Keep the name under ${MAX_LABEL} characters.` };
  if (b.length > MAX_BODY) return { error: `Keep the message under ${MAX_BODY} characters.` };
  return { label: l, body: b };
}

async function list(worker) {
  const rows = await db.all(
    `SELECT id, worker_id, label, body FROM canned_response
     WHERE worker_id IS NULL OR worker_id = ?
     ORDER BY (worker_id IS NULL) DESC, LOWER(label), id`, [worker.id]);
  return rows.map((r) => ({
    ...r,
    shared: r.worker_id === null,
    canEdit: r.worker_id === null ? canShare(worker) : Number(r.worker_id) === Number(worker.id),
  }));
}

// Can this worker change (or delete) this row? Returns the row or an error.
async function editable(worker, id) {
  const row = await db.get('SELECT * FROM canned_response WHERE id = ?', [id]);
  const visible = row && (row.worker_id === null || Number(row.worker_id) === Number(worker.id));
  if (!visible) return { status: 404, error: 'Not found' };
  if (row.worker_id === null && !canShare(worker)) {
    return { status: 403, error: 'Only supervisors and coordinators can change shared responses.' };
  }
  return { row };
}

async function create(worker, input) {
  const c = clean(input);
  if (c.error) return { status: 400, error: c.error };
  const shared = Boolean(input && input.shared);
  if (shared && !canShare(worker)) {
    return { status: 403, error: 'Only supervisors and coordinators can add shared responses.' };
  }
  const id = await db.insert(
    'INSERT INTO canned_response (worker_id, label, body) VALUES (?,?,?)',
    [shared ? null : worker.id, c.label, c.body]);
  if (shared) await db.audit(worker.id, 'canned_added', 'canned_response', id, c.label);
  return { id };
}

async function update(worker, id, input) {
  const e = await editable(worker, id);
  if (e.error) return e;
  const c = clean({ label: input.label ?? e.row.label, body: input.body ?? e.row.body });
  if (c.error) return { status: 400, error: c.error };
  let ownerId = e.row.worker_id;
  if (input.shared !== undefined) {
    // Sharing a personal one (or taking a shared one back as yours) is a
    // supervisor's call.
    if (!canShare(worker)) return { status: 403, error: 'Only supervisors and coordinators can share responses.' };
    ownerId = input.shared ? null : worker.id;
  }
  await db.run('UPDATE canned_response SET label = ?, body = ?, worker_id = ? WHERE id = ?',
    [c.label, c.body, ownerId, id]);
  if (e.row.worker_id === null || ownerId === null) {
    await db.audit(worker.id, 'canned_changed', 'canned_response', id, c.label);
  }
  return { ok: true };
}

async function remove(worker, id) {
  const e = await editable(worker, id);
  if (e.error) return e;
  await db.run('DELETE FROM canned_response WHERE id = ?', [id]);
  if (e.row.worker_id === null) {
    await db.audit(worker.id, 'canned_deleted', 'canned_response', id, e.row.label);
  }
  return { ok: true };
}

// Adds whichever starter responses aren't already shared (matched by name).
async function addStarter(worker) {
  if (!canShare(worker)) return { status: 403, error: 'Only supervisors and coordinators can add shared responses.' };
  const have = new Set((await db.all(
    'SELECT label FROM canned_response WHERE worker_id IS NULL')).map((r) => r.label.toLowerCase()));
  let added = 0;
  for (const [label, body] of starter()) {
    if (have.has(label.toLowerCase())) continue;
    await db.run('INSERT INTO canned_response (worker_id, label, body) VALUES (NULL,?,?)', [label, body]);
    added += 1;
  }
  if (added) await db.audit(worker.id, 'canned_starter_added', 'canned_response', null, `${added} added`);
  return { added };
}

module.exports = {
  get STARTER() { return starter(); },
  list, create, update, remove, addStarter, MAX_LABEL, MAX_BODY };
