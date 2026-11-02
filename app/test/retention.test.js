'use strict';

// Retention: conversations past the period are deleted with everything
// recorded about them; recent ones, open follow-ups and active directives
// stay; coordinators can change the period.

process.env.TL_PGDATA = ':memory:';
process.env.TL_ENCRYPTION_KEY = '7'.repeat(64);

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const db = require('../src/db');
const sec = require('../src/crypto');
const auth = require('../src/auth');
const retention = require('../src/retention');

let server;
let base;
let seq = 0;
const DAY = 86_400_000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();

async function makeWorker(role) {
  const id = await db.insert(
    `INSERT INTO worker (email, name, password_hash, role, created_at) VALUES (?,?,?,?,?)`,
    [`ret-${seq++}@test.org`, `Ret ${role} ${seq}`, sec.hashPassword('x'.repeat(12)), role, db.now()]);
  return { id, cookie: `session=${await auth.createSession(id)}` };
}

async function makeConversation(workerId, endedDaysAgo) {
  const callerId = await db.insert('INSERT INTO caller (token, first_seen) VALUES (?,?)',
    [`tok-${seq++}`, ago(endedDaysAgo + 1)]);
  const contactId = await db.insert(
    `INSERT INTO contact (caller_id, worker_id, chat_token, queued_at, claimed_at, ended_at, outcome)
     VALUES (?,?,?,?,?,?,'completed')`,
    [callerId, workerId, `ct-${seq++}`, ago(endedDaysAgo + 1), ago(endedDaysAgo + 1), ago(endedDaysAgo)]);
  await db.run('INSERT INTO message (contact_id, sender, body, sent_at) VALUES (?,?,?,?)',
    [contactId, 'caller', sec.encrypt('hello'), ago(endedDaysAgo)]);
  await db.run('INSERT INTO feedback (contact_id, worker_id, created_at) VALUES (?,?,?)',
    [contactId, workerId, ago(endedDaysAgo)]);
  return { callerId, contactId };
}

test.before(async () => {
  await db.init();
  const { app } = require('../server');
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
test.after(() => { server.close(); server.closeAllConnections(); });

test('the default period is one year', async () => {
  assert.strictEqual(await retention.days(), 365);
});

test('old conversations go with their messages, feedback and caller; recent ones stay', async () => {
  const w = await makeWorker('worker');
  const old = await makeConversation(w.id, 400);
  const recent = await makeConversation(w.id, 30);
  // An old caller with an open follow-up and an active directive keeps both.
  const kept = await makeConversation(w.id, 500);
  await db.run(`INSERT INTO followup (caller_id, contact_id, assigned_to, due_at, status, created_at)
    VALUES (?,?,?,?, 'open', ?)`, [kept.callerId, kept.contactId, w.id, ago(490), ago(500)]);
  await db.run(`INSERT INTO followup (caller_id, assigned_to, due_at, status, created_at, done_at)
    VALUES (?,?,?, 'done', ?, ?)`, [kept.callerId, w.id, ago(495), ago(500), ago(495)]);
  await db.run('INSERT INTO directive (caller_id, body, created_at) VALUES (?,?,?)',
    [kept.callerId, sec.encrypt('call back'), ago(500)]);
  await db.run(`INSERT INTO directive (caller_id, body, created_at, retired_at) VALUES (?,?,?,?)`,
    [kept.callerId, sec.encrypt('old'), ago(500), ago(450)]);
  await db.run('INSERT INTO help_request (worker_id, note, created_at) VALUES (?,?,?)', [w.id, 'old', ago(400)]);

  const r = await retention.purge();
  assert.strictEqual(r.contacts, 2);
  const has = async (sql, p) => !!(await db.get(sql, p));
  assert.ok(!(await has('SELECT 1 FROM contact WHERE id = ?', [old.contactId])));
  assert.ok(!(await has('SELECT 1 FROM message WHERE contact_id = ?', [old.contactId])));
  assert.ok(!(await has('SELECT 1 FROM feedback WHERE contact_id = ?', [old.contactId])));
  assert.ok(!(await has('SELECT 1 FROM caller WHERE id = ?', [old.callerId])));
  assert.ok(await has('SELECT 1 FROM contact WHERE id = ?', [recent.contactId]));
  assert.ok(await has('SELECT 1 FROM message WHERE contact_id = ?', [recent.contactId]));

  assert.ok(await has('SELECT 1 FROM caller WHERE id = ?', [kept.callerId]), 'caller with open work stays');
  assert.ok(await has(`SELECT 1 FROM followup WHERE caller_id = ? AND status = 'open'`, [kept.callerId]));
  assert.ok(!(await has(`SELECT 1 FROM followup WHERE caller_id = ? AND status = 'done'`, [kept.callerId])));
  assert.ok(await has('SELECT 1 FROM directive WHERE caller_id = ? AND retired_at IS NULL', [kept.callerId]));
  assert.ok(!(await has('SELECT 1 FROM directive WHERE caller_id = ? AND retired_at IS NOT NULL', [kept.callerId])));
  assert.ok(!(await has(`SELECT 1 FROM help_request WHERE note = 'old'`)));
  assert.ok(await has(`SELECT 1 FROM audit_log WHERE action = 'retention_purge'`));
});

test('0 keeps everything', async () => {
  const w = await makeWorker('worker');
  await db.run(`INSERT INTO config (key, value) VALUES ('retention_days', '0')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  const c = await makeConversation(w.id, 4000);
  const r = await retention.purge();
  assert.strictEqual(r.contacts, 0);
  assert.ok(await db.get('SELECT 1 FROM contact WHERE id = ?', [c.contactId]));
  await db.run(`DELETE FROM config WHERE key = 'retention_days'`);
});

test('coordinators change the period; it is validated and audited', async () => {
  const coord = await makeWorker('coordinator');
  const sup = await makeWorker('supervisor');
  const put = (cookie, days) => fetch(`${base}/api/admin/retention`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ days }) });
  assert.strictEqual((await put(sup.cookie, 730)).status, 403);
  assert.strictEqual((await put(coord.cookie, 7)).status, 400);
  assert.strictEqual((await put(coord.cookie, 'soon')).status, 400);
  assert.strictEqual((await put(coord.cookie, 730)).status, 200);
  const got = await (await fetch(`${base}/api/admin/retention`, { headers: { cookie: coord.cookie } })).json();
  assert.strictEqual(got.days, 730);
  const a = await db.get(`SELECT detail FROM audit_log WHERE action = 'retention_changed' ORDER BY id DESC LIMIT 1`);
  assert.strictEqual(a.detail, '365 → 730 days');

  // A conversation 400 days old now stays; the ops check runs the purge.
  const w = await makeWorker('worker');
  const c = await makeConversation(w.id, 400);
  await fetch(`${base}/api/cron/ops-check`);
  assert.ok(await db.get('SELECT 1 FROM contact WHERE id = ?', [c.contactId]));
  assert.strictEqual((await put(coord.cookie, 365)).status, 200);
  await fetch(`${base}/api/cron/ops-check`);
  assert.ok(!(await db.get('SELECT 1 FROM contact WHERE id = ?', [c.contactId])));
});

test('the Admin page offers the setting', async () => {
  const html = await (await fetch(`${base}/admin.html`)).text();
  assert.ok(html.includes('id="retDays"'));
  assert.ok(html.includes('retention.js'));
});
