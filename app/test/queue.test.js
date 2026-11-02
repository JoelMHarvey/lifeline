'use strict';

process.env.TL_PGDATA = ':memory:';
process.env.TL_ENCRYPTION_KEY = 'a'.repeat(64);

const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const sec = require('../src/crypto');
const queue = require('../src/queue');

let emailSeq = 0;
async function addWorker({ role = 'worker', status = 'on_shift', inProgram = true, service = 'in_service' } = {}) {
  const id = await db.insert(
    `INSERT INTO worker (email, name, password_hash, role, status, service_status, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    [`w${emailSeq++}@test.org`, `Worker ${emailSeq}`, sec.hashPassword('x'.repeat(12)),
      role, status, service, db.now()]);
  if (inProgram) {
    await db.run('INSERT INTO worker_program (worker_id, program_id) VALUES (?,?)',
      [id, await db.chatProgramId()]);
  }
  return db.get('SELECT * FROM worker WHERE id = ?', [id]);
}

test('joinQueue creates caller + waiting contact; reuses caller by token', async () => {
  const a = await queue.joinQueue({ alias: 'A', triage: { concern: 'Loneliness' } });
  assert.ok(a.contactId && a.chatToken && a.callerToken);
  assert.strictEqual((await queue.waiting()).length, 1);

  const b = await queue.joinQueue({ callerToken: a.callerToken, alias: 'A' });
  const callers = await db.get('SELECT COUNT(*) AS n FROM caller');
  assert.strictEqual(Number(callers.n), 1, 'returning caller token must not create a new caller');
  const w = (await queue.waiting()).find((c) => Number(c.id) === b.contactId);
  assert.strictEqual(Number(w.prior_contacts), 1);

  await queue.endContact(a.contactId, 'abandoned');
  await queue.endContact(b.contactId, 'abandoned');
});

test('triage is encrypted at rest but readable through triageOf', async () => {
  const { contactId } = await queue.joinQueue({ alias: 'E', triage: { concern: 'Anxiety', safe: 'yes' } });
  const raw = await db.get('SELECT triage_json FROM contact WHERE id = ?', [contactId]);
  assert.ok(raw.triage_json.startsWith('g1$'), 'stored ciphertext, not plaintext');
  assert.ok(!raw.triage_json.includes('Anxiety'));
  const c = await db.get('SELECT * FROM contact WHERE id = ?', [contactId]);
  assert.strictEqual(queue.triageOf(c).concern, 'Anxiety');
  await queue.endContact(contactId, 'abandoned');
});

test('unsafe triage answer jumps the queue', async () => {
  const first = await queue.joinQueue({ alias: 'waiting-longer' });
  const urgent = await queue.joinQueue({ alias: 'urgent', triage: { safe: 'no' } });
  const order = (await queue.waiting()).map((c) => Number(c.id));
  assert.deepStrictEqual(order, [urgent.contactId, first.contactId]);
  await queue.endContact(first.contactId, 'abandoned');
  await queue.endContact(urgent.contactId, 'abandoned');
});

test('claim is atomic: second worker gets null', async () => {
  const w1 = await addWorker();
  const w2 = await addWorker();
  const { contactId } = await queue.joinQueue({ alias: 'raced' });

  const first = await queue.claim(contactId, w1);
  const second = await queue.claim(contactId, w2);
  assert.ok(first, 'first claim succeeds');
  assert.strictEqual(second, null, 'second claim must lose the race');
  assert.strictEqual((await queue.waiting()).length, 0);
  assert.ok(first.queue_wait_secs >= 0);
  await queue.endContact(contactId, 'completed');
});

test('trainees, out-of-program and on-leave workers cannot claim', async () => {
  const trainee = await addWorker({ role: 'trainee' });
  const outsider = await addWorker({ inProgram: false });
  const onLeave = await addWorker({ service: 'on_leave' });
  const ok = await addWorker();
  const { contactId } = await queue.joinQueue({ alias: 'gated' });

  assert.strictEqual(await queue.claim(contactId, trainee), null, 'trainee blocked');
  assert.strictEqual(await queue.claim(contactId, outsider), null, 'not in program blocked');
  assert.strictEqual(await queue.claim(contactId, onLeave), null, 'on leave blocked');
  assert.ok(await queue.claim(contactId, ok), 'eligible worker claims fine');
  await queue.endContact(contactId, 'completed');
});

test('worker at max_active_chats cannot claim another', async () => {
  const w = await addWorker();
  const a = await queue.joinQueue({ alias: 'first' });
  const b = await queue.joinQueue({ alias: 'second' });
  assert.ok(await queue.claim(a.contactId, w));
  assert.strictEqual(await queue.claim(b.contactId, w), null, 'no capacity for a second chat');
  await queue.endContact(a.contactId, 'completed');
  assert.ok(await queue.claim(b.contactId, w), 'capacity frees up when the first ends');
  await queue.endContact(b.contactId, 'completed');
});

test('claiming an abandoned contact fails', async () => {
  const w = await addWorker();
  const { contactId } = await queue.joinQueue({ alias: 'gone' });
  await queue.endContact(contactId, 'abandoned');
  assert.strictEqual(await queue.claim(contactId, w), null);
});

test('sweep pages once, program-scoped; safety-valves long waits; abandons silent callers', async () => {
  const backupIn = await addWorker({ status: 'backup' });
  const backupOut = await addWorker({ status: 'backup', inProgram: false });
  const backupTrainee = await addWorker({ role: 'trainee', status: 'backup' });
  const { contactId } = await queue.joinQueue({ alias: 'long wait' });
  const backdate = (secs) => new Date(Date.now() - secs * 1000).toISOString();
  await db.run('UPDATE contact SET queued_at = ? WHERE id = ?', [backdate(120), contactId]);

  let r = await queue.sweep();
  assert.strictEqual(r.toPage.length, 1, 'pages after backup_page_after_secs');
  const backups = (await queue.backupsFor(r.toPage[0])).map((b) => Number(b.id));
  assert.ok(backups.includes(Number(backupIn.id)), 'in-program backup paged');
  assert.ok(!backups.includes(Number(backupOut.id)), 'out-of-program backup not paged');
  assert.ok(!backups.includes(Number(backupTrainee.id)), 'trainee backup not paged');

  r = await queue.sweep();
  assert.strictEqual(r.toPage.length, 0, 'never pages the same contact twice');

  await db.run('UPDATE contact SET queued_at = ? WHERE id = ?', [backdate(700), contactId]);
  r = await queue.sweep();
  assert.strictEqual(r.toClose.length, 1, 'safety valve closes very long waits');
  const row = await db.get('SELECT outcome FROM contact WHERE id = ?', [contactId]);
  assert.strictEqual(row.outcome, 'timed_out');

  // Abandonment via stale caller_seen_at (stream heartbeat stopped)
  const gone = await queue.joinQueue({ alias: 'silent' });
  await db.run('UPDATE contact SET caller_seen_at = ? WHERE id = ?', [backdate(300), gone.contactId]);
  r = await queue.sweep();
  assert.strictEqual(r.abandoned.length, 1, 'stale waiting caller marked abandoned');
  const g = await db.get('SELECT outcome FROM contact WHERE id = ?', [gone.contactId]);
  assert.strictEqual(g.outcome, 'abandoned');
});

test('maybeSweep throttles: only one caller per window does work', async () => {
  await db.run(`UPDATE config SET value = '0' WHERE key = 'last_sweep_at'`);
  const a = await queue.maybeSweep();
  const b = await queue.maybeSweep();
  assert.ok(Array.isArray(a.toPage), 'first call swept');
  assert.deepStrictEqual(b, { toPage: [], toClose: [], abandoned: [] }, 'second call throttled');
});

test('endContact records queue_wait_secs for abandoned callers', async () => {
  const { contactId } = await queue.joinQueue({ alias: 'left' });
  await queue.endContact(contactId, 'abandoned');
  const row = await db.get('SELECT * FROM contact WHERE id = ?', [contactId]);
  assert.strictEqual(row.outcome, 'abandoned');
  assert.ok(row.queue_wait_secs >= 0, 'wait recorded even without a claim');
  assert.strictEqual(await queue.endContact(contactId, 'completed'), false, 'outcome is write-once');
});

test('onCallSupervisor prefers reachable supervisors and ignores off ones', async () => {
  await db.run(`UPDATE worker SET status = 'off'`);
  assert.strictEqual(await queue.onCallSupervisor(), null);
  const sup = await addWorker({ role: 'supervisor', status: 'backup' });
  await db.run('UPDATE worker SET phone = ? WHERE id = ?', ['080-1111-2222', sup.id]);
  const got = await queue.onCallSupervisor();
  assert.strictEqual(Number(got.id), Number(sup.id));
  assert.strictEqual(got.phone, '080-1111-2222');
});
