'use strict';

process.env.TL_PGDATA = ':memory:';
process.env.TL_ENCRYPTION_KEY = '9'.repeat(64);

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const db = require('../src/db');
const sec = require('../src/crypto');
const auth = require('../src/auth');

let emailSeq = 0;
async function makeWorker(role = 'worker') {
  const id = await db.insert(
    `INSERT INTO worker (email, name, password_hash, role, status, service_status, created_at)
     VALUES (?,?,?,?,'off','in_service',?)`,
    [`se-${emailSeq++}@test.org`, `SE ${role} ${emailSeq}`,
      sec.hashPassword('x'.repeat(12)), role, db.now()]);
  return db.get('SELECT * FROM worker WHERE id = ?', [id]);
}

let server;
let port;
test.before(async () => {
  await db.init();
  const { app } = require('../server');
  server = await new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, () => resolve(s));
  });
  port = server.address().port;
});
test.after(() => { server.close(); server.closeAllConnections(); });

const call = (method, path, body, cookie) => new Promise((resolve, reject) => {
  const r = http.request({ port, method, path,
    headers: { 'Content-Type': 'application/json', Cookie: cookie } }, (res) => {
    let data = '';
    res.on('data', (c) => { data += c; });
    res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} }));
  });
  r.on('error', reject);
  r.end(body ? JSON.stringify(body) : undefined);
});


const schedule = require('../src/schedule');
const mail = require('../src/mail');

test('seats per shift: coordinators set them; generating tops months up', async () => {
  const coord = await makeWorker('coordinator');
  const sup = await makeWorker('supervisor');
  const cc = 'session=' + await auth.createSession(coord.id);
  const sc = 'session=' + await auth.createSession(sup.id);
  assert.strictEqual((await call('PATCH', '/api/shift-defs/4', { seats: 2 }, sc)).status, 403);
  for (const bad of [0, 7, 1.5, 'x']) {
    assert.strictEqual((await call('PATCH', '/api/shift-defs/4', { seats: bad }, cc)).status, 400);
  }
  assert.strictEqual((await call('PATCH', '/api/shift-defs/8', { seats: 2 }, cc)).status, 400, 'OCS has no seats');
  assert.strictEqual((await call('PATCH', '/api/shift-defs/4', { seats: 2 }, cc)).status, 200);
  assert.strictEqual((await schedule.shiftDefs()).find((d) => d.number === 4).seats, 2);

  const seatsOn = async (date, n) => Number((await db.get(
    `SELECT COUNT(*) AS n FROM shift_slot WHERE date = ? AND shift_number = ? AND role = 'worker'
       AND status != 'cancelled'`, [date, n])).n);
  const g1 = await schedule.generateMonth('2027-03', coord.id);
  // A flat count replaces S4's weekday pattern: 2 every day. The other
  // shifts keep the default weekday seats (Sun 9, Mon 7, Tue-Thu 5, Fri 6,
  // Sat 8 with S4 at 2); March 2027 starts on a Monday. Plus OCS Day
  // (Sat, Sun: 8) and OCS Night (Fri-Sun: 12).
  assert.strictEqual(g1.created, 4 * 9 + 5 * 7 + 5 * 5 + 5 * 5 + 4 * 5 + 4 * 6 + 4 * 8 + 8 + 12);
  assert.strictEqual(await seatsOn('2027-03-10', 4), 2);
  assert.strictEqual(await seatsOn('2027-03-10', 1), 1);

  // Raise S4 to 3: running it again adds only the missing seats.
  await call('PATCH', '/api/shift-defs/4', { seats: 3 }, cc);
  assert.strictEqual((await schedule.generateMonth('2027-03', coord.id)).created, 31);
  assert.strictEqual(await seatsOn('2027-03-10', 4), 3);
  // Lowering never removes anyone.
  await call('PATCH', '/api/shift-defs/4', { seats: 1 }, cc);
  assert.strictEqual((await schedule.generateMonth('2027-03', coord.id)).created, 0);
  assert.strictEqual(await seatsOn('2027-03-10', 4), 3);
  assert.ok(await db.get(`SELECT 1 FROM audit_log WHERE action = 'shift_def_updated' AND detail = 'S4: 3 people per shift'`));
});

test('email: Resend takes over when its key is set, batching 100 to a request', async () => {
  const saved = { ...process.env };
  const calls = [];
  let mode = 'ok';
  mail._setTransportForTests(null);
  mail._setFetchForTests(async (url, opts) => {
    calls.push({ url, auth: opts.headers.Authorization, body: JSON.parse(opts.body) });
    if (mode === 'busy-once') { mode = 'ok'; return new Response('slow down', { status: 429 }); }
    if (mode === 'reject') return new Response('{"message":"domain not verified"}', { status: 403 });
    return new Response('{"data":[]}', { status: 200 });
  });
  try {
    delete process.env.TL_SMTP_URL;
    process.env.TL_RESEND_API_KEY = 're_test_key';
    assert.strictEqual(mail.configured(), false, 'Resend needs a From address');
    process.env.TL_MAIL_FROM = 'TELL Lifeline <lifeline@tell.example>';
    assert.strictEqual(mail.configured(), true);
    assert.strictEqual(mail.account(), 'lifeline@tell.example');

    const msgs = Array.from({ length: 230 }, (_, i) => ({ to: `v${i}@test.org`, subject: 'Cover', text: 'Can you help?' }));
    assert.strictEqual(await mail.sendMany(msgs), 230);
    assert.deepStrictEqual(calls.map((c) => [c.url, c.body.length]), [
      ['https://api.resend.com/emails/batch', 100],
      ['https://api.resend.com/emails/batch', 100],
      ['https://api.resend.com/emails/batch', 30]]);
    assert.strictEqual(calls[0].auth, 'Bearer re_test_key');
    assert.deepStrictEqual(calls[0].body[0],
      { from: 'TELL Lifeline <lifeline@tell.example>', to: ['v0@test.org'], subject: 'Cover', text: 'Can you help?' });

    calls.length = 0;
    mode = 'busy-once';
    assert.strictEqual(await mail.send('one@test.org', 'Code', '123456'), true, 'a 429 is retried');
    assert.deepStrictEqual(calls.map((c) => c.url), ['https://api.resend.com/emails', 'https://api.resend.com/emails']);
    mode = 'reject';
    assert.strictEqual(await mail.send('one@test.org', 'Code', '123456'), false);

    const st = await mail.status();
    assert.strictEqual(st.provider, 'resend');
    assert.strictEqual(st.sentToday, 231);
    assert.strictEqual(st.dailyLimit, null);

    // Back to Gmail: remove the key.
    delete process.env.TL_RESEND_API_KEY;
    delete process.env.TL_MAIL_FROM;
    process.env.TL_SMTP_URL = 'smtps://tell%40gmail.com:pw@smtp.gmail.com:465';
    const g = await mail.status();
    assert.deepStrictEqual([g.provider, g.from, g.dailyLimit], ['gmail', 'tell@gmail.com', 500]);
    process.env.TL_MAIL_DAILY_LIMIT = '200';
    assert.strictEqual((await mail.status()).nearLimit, true, '231 of 200');
  } finally {
    for (const k of ['TL_SMTP_URL', 'TL_RESEND_API_KEY', 'TL_MAIL_FROM', 'TL_MAIL_DAILY_LIMIT']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    mail._setFetchForTests(null);
  }
});

test('seats by weekday: a pattern can switch a shift off on some days', async () => {
  const coord = await makeWorker('coordinator');
  const cc = 'session=' + await auth.createSession(coord.id);
  const week = { sun: 0, mon: 0, tue: 3, wed: 0, thu: 0, fri: 0, sat: 1 };
  for (const bad of [{ ...week, tue: 7 }, { ...week, tue: -1 }, { sun: 1 },
    { sun: 0, mon: 0, tue: 0, wed: 0, thu: 0, fri: 0, sat: 0 }]) {
    assert.strictEqual((await call('PATCH', '/api/shift-defs/2', { seats: bad }, cc)).status, 400);
  }
  assert.strictEqual((await call('PATCH', '/api/shift-defs/2', { seats: week }, cc)).status, 200);
  const def = (await schedule.shiftDefs()).find((d) => d.number === 2);
  assert.deepStrictEqual(def.weekSeats, week);
  assert.strictEqual(schedule.seatsOn(def, '2027-05-04'), 3, 'Tuesday');
  assert.strictEqual(schedule.seatsOn(def, '2027-05-05'), 0, 'Wednesday');
  await schedule.generateMonth('2027-05', coord.id);
  const n = async (date) => Number((await db.get(
    `SELECT COUNT(*) AS n FROM shift_slot WHERE date = ? AND shift_number = 2`, [date])).n);
  assert.strictEqual(await n('2027-05-04'), 3);
  assert.strictEqual(await n('2027-05-05'), 0);
  assert.strictEqual(await n('2027-05-01'), 1);
  const audit = await db.get(
    `SELECT detail FROM audit_log WHERE action = 'shift_def_updated' ORDER BY id DESC LIMIT 1`);
  assert.match(audit.detail, /S2: Mon off · Tue 3 · Wed–Fri off · Sat 1 · Sun off/);
  // A flat number goes back to the same count every day.
  await call('PATCH', '/api/shift-defs/2', { seats: 1 }, cc);
  assert.strictEqual((await schedule.shiftDefs()).find((d) => d.number === 2).weekSeats, null);
});
