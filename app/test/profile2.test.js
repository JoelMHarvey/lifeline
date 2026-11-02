'use strict';

process.env.TL_PGDATA = ':memory:';
process.env.TL_ENCRYPTION_KEY = 'b'.repeat(64);

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const db = require('../src/db');
const sec = require('../src/crypto');
const auth = require('../src/auth');
const mail = require('../src/mail');
const notify = require('../src/notify');
const schedule = require('../src/schedule');

let emailSeq = 0;
async function makeWorker(role = 'worker', prefs = null) {
  const id = await db.insert(
    `INSERT INTO worker (email, name, password_hash, role, status, service_status,
       notify_prefs, created_at)
     VALUES (?,?,?,?,'off','in_service',?,?)`,
    [`p2-${emailSeq++}@test.org`, `P2 ${role} ${emailSeq}`,
      sec.hashPassword('x'.repeat(12)), role,
      prefs ? JSON.stringify(prefs) : '{}', db.now()]);
  return db.get('SELECT * FROM worker WHERE id = ?', [id]);
}

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, () => resolve(server));
  });
}

function req(server, method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const r = http.request({ port: server.address().port, method, path,
      headers: { 'Content-Type': 'application/json', Cookie: cookie || '' } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} }));
    });
    r.on('error', reject);
    r.end(body ? JSON.stringify(body) : undefined);
  });
}

const sentMail = [];
let server;
test.before(async () => {
  await db.init();
  mail._setTransportForTests(async (msg) => { sentMail.push(msg); return true; });
  const { app } = require('../server');
  server = await listen(app);
});
test.after(() => server.close());
test.beforeEach(() => { sentMail.length = 0; });

// --- Email copies through notify -------------------------------------------

test('notify emails opted-in workers and skips everyone else', async () => {
  const optIn = await makeWorker('worker', { email: { slot_assigned: true } });
  const optOut = await makeWorker('worker');
  const ok = await notify.notify('slot_assigned',
    [Number(optIn.id), Number(optOut.id)], { shift: 3, date: '2026-11-01' });
  assert.strictEqual(ok, true); // emailed, even with no webhook configured
  assert.strictEqual(sentMail.length, 1);
  assert.strictEqual(sentMail[0].to, optIn.email);
  assert.ok(sentMail[0].text.includes('Shift 3'));
  assert.ok(!sentMail[0].text.includes('*'), 'markdown stripped for email');
});

test('personal kinds never require a webhook and left workers get nothing', async () => {
  const w = await makeWorker('worker', { email: { feedback_left: true } });
  await db.run(`UPDATE worker SET service_status = 'left' WHERE id = ?`, [w.id]);
  const ok = await notify.notify('feedback_left', [Number(w.id)], {});
  assert.strictEqual(ok, false);
  assert.strictEqual(sentMail.length, 0);
});

test('feedback and follow-up assignment trigger personal notifications', async () => {
  const worker = await makeWorker('worker', {
    email: { feedback_left: true, followup_assigned: true } });
  const sup = await makeWorker('supervisor');
  const supCookie = 'session=' + await auth.createSession(sup.id);

  // A handled contact for the worker, then the supervisor leaves feedback.
  const callerId = await db.insert(
    'INSERT INTO caller (token, first_seen) VALUES (?,?)', ['p2tok1', db.now()]);
  const contactId = await db.insert(
    `INSERT INTO contact (caller_id, program_id, chat_token, worker_id, queued_at)
     VALUES (?,?,?,?,?)`,
    [callerId, await db.chatProgramId(), 'p2chat1', worker.id, db.now()]);
  const fb = await req(server, 'POST', '/api/review/feedback',
    { contactId: Number(contactId), body: 'Nice pacing on the opening.' }, supCookie);
  assert.strictEqual(fb.status, 200);
  assert.strictEqual(sentMail.length, 1);
  assert.strictEqual(sentMail[0].to, worker.email);

  const fu = await req(server, 'POST', '/api/followups',
    { callerId: Number(callerId), assignedTo: Number(worker.id),
      dueAt: new Date(Date.now() + 86_400_000).toISOString() }, supCookie);
  assert.strictEqual(fu.status, 200);
  assert.strictEqual(sentMail.length, 2);
  assert.strictEqual(sentMail[1].to, worker.email);
});

// --- Shift reminders ---------------------------------------------------------

test('shift reminders go once per slot, only inside 24h, only when opted in', async () => {
  await schedule.ensureShiftsSeeded();
  const yes = await makeWorker('worker', { email: { shift_reminder: true } });
  const no = await makeWorker('worker');
  const tomorrow = new Date(Date.now() + 20 * 3_600_000).toISOString().slice(0, 10);
  const farDate = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
  // S4 19:00–23:00: pick dates so one start falls inside the next 24h.
  for (const [w, date] of [[yes, tomorrow], [no, tomorrow], [yes, farDate]]) {
    await db.run(
      `INSERT INTO shift_slot (date, shift_number, role, worker_id, status, created_at)
       VALUES (?,?,'worker',?,'confirmed',?)`, [date, 4, w.id, db.now()]);
  }
  // Fix "now" so the tomorrow 19:00 slot (Tokyo time, TELL's profile) is
  // within 24h regardless of wall clock.
  const now = require('../src/tz').wallToUtc(tomorrow, '19:00') - 3 * 3_600_000;
  const sent = await schedule.sendShiftReminders(notify.notify, now);
  assert.strictEqual(sent, 2); // both tomorrow slots marked; only one emails
  assert.strictEqual(sentMail.length, 1);
  assert.strictEqual(sentMail[0].to, yes.email);
  // Second pass: nothing left to send.
  assert.strictEqual(await schedule.sendShiftReminders(notify.notify, now), 0);
});

// --- My stats ----------------------------------------------------------------

test('myStats splits scheduled and worked by period', async () => {
  await schedule.ensureShiftsSeeded();
  const w = await makeWorker();
  const now = Date.now();
  const past = new Date(now - 5 * 86_400_000).toISOString().slice(0, 10);
  const future = new Date(now + 5 * 86_400_000).toISOString().slice(0, 10);
  for (const [date, status] of [[past, 'confirmed'], [future, 'assigned']]) {
    await db.run(
      `INSERT INTO shift_slot (date, shift_number, role, worker_id, status, created_at)
       VALUES (?,?,'worker',?,?,?)`, [date, 1, w.id, status, db.now()]);
  }
  const s = await schedule.myStats(Number(w.id), now);
  assert.strictEqual(s.allPast.worked, 1);
  assert.strictEqual(s.allPast.workedHours, 4); // S1 08:30–12:30
  assert.strictEqual(s.firstShift, past);
  const totalScheduled = s.thisMonth.scheduled + s.nextMonth.scheduled;
  assert.ok(totalScheduled >= 1); // the future slot lands in this or next month
});

// --- Skills & achievements ---------------------------------------------------

test('skills CRUD: own entries, status change stamps the date, others are walled off', async () => {
  const w = await makeWorker();
  const other = await makeWorker();
  const cookie = 'session=' + await auth.createSession(w.id);
  const otherCookie = 'session=' + await auth.createSession(other.id);

  const add = await req(server, 'POST', '/api/skills',
    { category: 'Training', title: 'QPR Gatekeeper Training', dueOn: '2026-12-01' }, cookie);
  assert.strictEqual(add.status, 200);
  const id = add.body.id;

  let list = (await req(server, 'GET', '/api/skills', null, cookie)).body;
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].status, 'to_be_done');

  const patch = await req(server, 'PATCH', '/api/skills/' + id,
    { status: 'completed' }, cookie);
  assert.strictEqual(patch.status, 200);
  list = (await req(server, 'GET', '/api/skills', null, cookie)).body;
  assert.strictEqual(list[0].status, 'completed');
  assert.strictEqual(list[0].statusChanged, new Date().toISOString().slice(0, 10));

  // Another worker can't see, edit or delete it.
  const otherList = (await req(server, 'GET', '/api/skills', null, otherCookie)).body;
  assert.strictEqual(otherList.length, 0);
  assert.strictEqual((await req(server, 'PATCH', '/api/skills/' + id,
    { status: 'to_be_done' }, otherCookie)).status, 404);
  assert.strictEqual((await req(server, 'DELETE', '/api/skills/' + id,
    null, otherCookie)).status, 404);

  // A coordinator can manage anyone's.
  const coord = await makeWorker('coordinator');
  const coordCookie = 'session=' + await auth.createSession(coord.id);
  const viaCoord = await req(server, 'GET', '/api/skills?workerId=' + w.id, null, coordCookie);
  assert.strictEqual(viaCoord.body.length, 1);
  assert.strictEqual((await req(server, 'DELETE', '/api/skills/' + id,
    null, coordCookie)).status, 200);
  assert.strictEqual((await req(server, 'GET', '/api/skills', null, cookie)).body.length, 0);
});
