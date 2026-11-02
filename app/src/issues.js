'use strict';

// Problem reports and requests. Anyone signed in files one from the side
// menu and gets a TL-#### reference; coordinators are emailed and work
// through them on the Ops page, moving each through new → in progress →
// fixed / done / won't fix with notes. The reporter is emailed each status
// change with its note, follows everything on issues.html, and can reopen
// a report that turns out not to be fixed.
//
// Free text is encrypted at rest. The new-report email to coordinators
// carries the title and metadata only — the details stay in the app — in
// line with the rest of the app's notifications.

const db = require('./db');
const sec = require('./crypto');
const mail = require('./mail');
const { log } = require('./log');

const KINDS = ['bug', 'request', 'question'];
const SEVERITIES = ['minor', 'normal', 'blocking'];
const STATUSES = ['new', 'in_progress', 'fixed', 'done', 'wont_fix'];
const OPEN = ['new', 'in_progress'];
const STATUS_WORDS = {
  new: 'New', in_progress: 'In progress', fixed: 'Fixed — please check it',
  done: 'Done', wont_fix: "Won't fix",
};
const KIND_WORDS = { bug: 'Problem', request: 'Request', question: 'Question' };

const ref = (n) => `TL-${String(n).padStart(4, '0')}`;
const refOf = (row) => ref(row.ref_no || row.id);
const link = (path) => {
  const base = (process.env.TL_BASE_URL || '').replace(/\/+$/, '');
  return base ? `\n\n${base}${path}` : '';
};
const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

async function create(reporter, input) {
  const kind = KINDS.includes(input.kind) ? input.kind : 'bug';
  const severity = SEVERITIES.includes(input.severity) ? input.severity : 'normal';
  const title = clip(input.title, 140);
  const body = clip(input.body, 5000);
  if (!title) return { error: 'please give it a short title' };
  const now = db.now();
  // Next reference number; two reports at the same instant collide on the
  // unique index, so try again.
  let id = null;
  for (let attempt = 0; id == null; attempt++) {
    try {
      id = await db.insert(
        `INSERT INTO issue_report (reporter_id, kind, severity, title, body, page, client,
           status, created_at, updated_at, ref_no)
         VALUES (?,?,?,?,?,?,?,'new',?,?,
           (SELECT COALESCE(MAX(ref_no), 0) + 1 FROM issue_report))`,
        [reporter.id, kind, severity, title, body ? sec.encrypt(body) : null,
          clip(input.page, 300) || null, clip(input.client, 400) || null, now, now]);
    } catch (e) {
      if (attempt >= 4 || !/idx_issue_ref_no|duplicate key/.test(String(e))) throw e;
    }
  }
  const { ref_no: refNo } = await db.get('SELECT ref_no FROM issue_report WHERE id = ?', [id]);
  const tl = ref(refNo);
  await db.audit(reporter.id, 'issue_reported', 'issue_report', id, `${tl}: ${title}`);

  // Tell the coordinators (or, with none in service yet, the app's own
  // mailbox). Metadata only; the details are on the Ops page.
  if (mail.configured()) {
    const staff = await db.all(
      `SELECT email FROM worker WHERE role = 'coordinator' AND service_status = 'in_service'`);
    const to = staff.length ? staff.map((s) => s.email) : [mail.account()].filter(Boolean);
    const text = `${reporter.name} reported a ${KIND_WORDS[kind].toLowerCase()} ` +
      `(${severity}${input.page ? ', on ' + clip(input.page, 300) : ''}):\n\n` +
      `    ${tl} · ${title}\n\nThe details are on the Ops page.` + link(`/ops.html#${tl}`);
    for (const addr of to) {
      mail.send(addr, `[${tl}] ${KIND_WORDS[kind]}: ${title}`, text)
        .catch((e) => log('issue_mail_error', { error: String(e).slice(0, 200) }));
    }
  }
  return { id: Number(id), ref: tl };
}

async function list({ reporterId = null, scope = 'open' } = {}) {
  const where = [];
  const params = [];
  if (reporterId) { where.push('issue_report.reporter_id = ?'); params.push(reporterId); }
  if (scope === 'open') where.push(`issue_report.status IN ('new','in_progress')`);
  if (scope === 'closed') where.push(`issue_report.status IN ('fixed','done','wont_fix')`);
  const rows = await db.all(
    `SELECT issue_report.*, worker.name AS reporter_name FROM issue_report
     LEFT JOIN worker ON worker.id = issue_report.reporter_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY CASE issue_report.severity WHEN 'blocking' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
       issue_report.id DESC`, params);
  if (!rows.length) return [];
  const notes = await db.all(
    `SELECT issue_note.*, worker.name AS author_name FROM issue_note
     LEFT JOIN worker ON worker.id = issue_note.author_id
     WHERE issue_id IN (${rows.map(() => '?').join(',')}) ORDER BY issue_note.id`,
    rows.map((r) => r.id));
  const byIssue = new Map();
  for (const n of notes) {
    const k = Number(n.issue_id);
    if (!byIssue.has(k)) byIssue.set(k, []);
    byIssue.get(k).push({ at: n.at, author: n.author_name || '—', status: n.status || null,
      statusWords: n.status ? STATUS_WORDS[n.status] : null,
      body: n.body ? sec.decrypt(n.body) : null });
  }
  return rows.map((r) => ({
    id: Number(r.id), ref: refOf(r), kind: r.kind, severity: r.severity,
    title: r.title, body: r.body ? sec.decrypt(r.body) : '',
    page: r.page, client: r.client, status: r.status, statusWords: STATUS_WORDS[r.status],
    reporterId: r.reporter_id ? Number(r.reporter_id) : null,
    reporterName: r.reporter_name || '—',
    createdAt: r.created_at, updatedAt: r.updated_at,
    notes: byIssue.get(Number(r.id)) || [],
  }));
}

async function addNote(issue, actor, status, note) {
  const body = clip(note, 5000);
  await db.run(
    'INSERT INTO issue_note (issue_id, author_id, status, body, at) VALUES (?,?,?,?,?)',
    [issue.id, actor.id, status, body ? sec.encrypt(body) : null, db.now()]);
  if (status) {
    await db.run('UPDATE issue_report SET status = ?, updated_at = ? WHERE id = ?',
      [status, db.now(), issue.id]);
  } else {
    await db.run('UPDATE issue_report SET updated_at = ? WHERE id = ?', [db.now(), issue.id]);
  }
  return body;
}

// Coordinator: move a report on and/or add a note. The reporter is emailed
// the new status and the note.
async function update(id, actor, { status, note }) {
  const issue = await db.get('SELECT * FROM issue_report WHERE id = ?', [Number(id)]);
  if (!issue) return { error: 'no such report' };
  const next = status && status !== issue.status ? status : null;
  if (next && !STATUSES.includes(next)) return { error: 'unknown status' };
  if (!next && !clip(note, 5000)) return { error: 'nothing to change' };
  const body = await addNote(issue, actor, next, note);
  await db.audit(actor.id, 'issue_updated', 'issue_report', issue.id,
    `${refOf(issue)}: ${next ? STATUS_WORDS[next] : 'note added'}`);

  let emailed = false;
  if (mail.configured() && issue.reporter_id && Number(issue.reporter_id) !== Number(actor.id)) {
    const r = await db.get('SELECT email, name FROM worker WHERE id = ?', [issue.reporter_id]);
    if (r) {
      const words = next ? STATUS_WORDS[next] : STATUS_WORDS[issue.status];
      emailed = await mail.send(r.email, `[${refOf(issue)}] ${words}: ${issue.title}`,
        `Hello ${r.name},\n\nYour report ${refOf(issue)} — "${issue.title}" — ` +
        (next ? `is now: ${words}.` : 'has a new note.') +
        (body ? `\n\n${actor.name} wrote:\n\n${body}` : '') +
        (next === 'fixed' ? '\n\nIf it still isn\'t right, open "My problem reports" ' +
          'and press "Still not fixed".' : '') +
        link('/issues.html'));
    }
  }
  return { ok: true, emailed };
}

// Reporter: add a comment to their own open report, optionally closing it
// ("it's sorted"). Coordinators are told — metadata only — unless the
// reporter is the only coordinator reading anyway.
async function comment(id, reporter, { note, close = false }) {
  const issue = await db.get('SELECT * FROM issue_report WHERE id = ?', [Number(id)]);
  if (!issue || Number(issue.reporter_id) !== Number(reporter.id)) {
    return { error: 'not your report' };
  }
  if (!OPEN.includes(issue.status)) return { error: 'this report is closed — reopen it instead' };
  if (!close && !clip(note, 5000)) return { error: 'write a comment first' };
  await addNote(issue, reporter, close ? 'done' : null,
    close ? (clip(note, 5000) || 'Closed by the person who reported it.') : note);
  await db.audit(reporter.id, close ? 'issue_closed_by_reporter' : 'issue_commented',
    'issue_report', issue.id, refOf(issue));
  if (mail.configured()) {
    const staff = await db.all(
      `SELECT email FROM worker WHERE role = 'coordinator' AND service_status = 'in_service'
         AND id != ?`, [reporter.id]);
    for (const s of staff) {
      mail.send(s.email, `[${refOf(issue)}] ${close ? 'Closed by reporter' : 'New comment'}: ${issue.title}`,
        `${reporter.name} ${close ? 'closed' : 'added a comment to'} ${refOf(issue)} — ` +
        `"${issue.title}".` + link(`/ops.html#${refOf(issue)}`))
        .catch((e) => log('issue_mail_error', { error: String(e).slice(0, 200) }));
    }
  }
  return { ok: true };
}

// Reporter: a "fixed", "done" or "won't fix" report that isn't right after
// all goes back to new, with their comment.
async function reopen(id, reporter, note) {
  const issue = await db.get('SELECT * FROM issue_report WHERE id = ?', [Number(id)]);
  if (!issue || Number(issue.reporter_id) !== Number(reporter.id)) {
    return { error: 'not your report' };
  }
  if (OPEN.includes(issue.status)) return { error: 'this report is still open' };
  await addNote(issue, reporter, 'new', note || 'Still not fixed.');
  await db.audit(reporter.id, 'issue_reopened', 'issue_report', issue.id, refOf(issue));
  return { ok: true };
}

module.exports = { create, list, update, reopen, comment, ref, refOf, KINDS, SEVERITIES, STATUSES, STATUS_WORDS };
