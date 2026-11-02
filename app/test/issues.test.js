'use strict';

process.env.TL_PGDATA = ':memory:';
process.env.TL_ENCRYPTION_KEY = '5'.repeat(64);
process.env.TL_BASE_URL = 'https://tell.example.org';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const db = require('../src/db');
const sec = require('../src/crypto');
const auth = require('../src/auth');
const mail = require('../src/mail');
const backup = require('../src/backup');

let emailSeq = 0;
async function makeWorker(role = 'worker') {
  const id = await db.insert(
    `INSERT INTO worker (email, name, password_hash, role, status, service_status, created_at)
     VALUES (?,?,?,?,'off','in_service',?)`,
    [`is-${emailSeq++}@test.org`, `IS ${role} ${emailSeq}`,
      sec.hashPassword('x'.repeat(12)), role, db.now()]);
  return db.get('SELECT * FROM worker WHERE id = ?', [id]);
}

const sent = [];
let server;
let port;
test.before(async () => {
  mail._setTransportForTests(async (m) => { sent.push(m); return true; });
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

test('report → reference → coordinator email → fixed with note → reporter email → reopen', async () => {
  const coord = await makeWorker('coordinator');
  const tester = await makeWorker('worker');
  const other = await makeWorker('worker');
  const coordCookie = 'session=' + await auth.createSession(coord.id);
  const testerCookie = 'session=' + await auth.createSession(tester.id);
  const otherCookie = 'session=' + await auth.createSession(other.id);

  // A title is required.
  assert.strictEqual((await call('POST', '/api/issues', { title: '  ' }, testerCookie)).status, 400);

  sent.length = 0;
  const filed = await call('POST', '/api/issues', {
    kind: 'bug', severity: 'blocking', title: 'Take it does nothing on my phone',
    body: 'Pressed Take it under Shifts needing cover; nothing happened.',
    page: '/schedule.html', client: 'Mobile Safari · 390×844',
  }, testerCookie);
  assert.strictEqual(filed.status, 200);
  assert.match(filed.body.ref, /^TL-\d{4}$/);

  // Details are encrypted at rest.
  const row = await db.get('SELECT body FROM issue_report WHERE id = ?', [filed.body.id]);
  assert.ok(!row.body.includes('Pressed Take it'), 'body stored encrypted');

  // Coordinators are emailed the title and metadata, not the details.
  const toCoord = sent.find((m) => m.to === coord.email);
  assert.ok(toCoord, 'coordinator emailed');
  assert.strictEqual(toCoord.subject, `[${filed.body.ref}] Problem: Take it does nothing on my phone`);
  assert.match(toCoord.text, /blocking, on \/schedule\.html/);
  assert.match(toCoord.text, new RegExp(`https://tell\\.example\\.org/ops\\.html#${filed.body.ref}$`));
  assert.ok(!toCoord.text.includes('nothing happened'), 'details stay in the app');

  // The reporter sees their own; another worker sees none of it; only
  // coordinators get the full list.
  const mine = (await call('GET', '/api/issues/mine', null, testerCookie)).body;
  assert.strictEqual(mine.length, 1);
  assert.strictEqual(mine[0].body, 'Pressed Take it under Shifts needing cover; nothing happened.');
  assert.strictEqual((await call('GET', '/api/issues/mine', null, otherCookie)).body.length, 0);
  assert.strictEqual((await call('GET', '/api/issues', null, testerCookie)).status, 403);
  assert.strictEqual((await call('PATCH', `/api/issues/${filed.body.id}`,
    { status: 'done' }, testerCookie)).status, 403);
  const open = (await call('GET', '/api/issues?scope=open', null, coordCookie)).body;
  assert.strictEqual(open[0].ref, filed.body.ref);
  assert.strictEqual(open[0].client, 'Mobile Safari · 390×844');

  // A reporter can't reopen something still open, and nobody else can at all.
  assert.strictEqual((await call('POST', `/api/issues/${filed.body.id}/reopen`,
    {}, testerCookie)).status, 400);

  // Fixed, with a note: the reporter is emailed both.
  sent.length = 0;
  const fix = await call('PATCH', `/api/issues/${filed.body.id}`,
    { status: 'fixed', note: 'The button was hidden behind the menu on narrow screens. Fixed.' },
    coordCookie);
  assert.strictEqual(fix.status, 200);
  assert.strictEqual(fix.body.emailed, true);
  const toTester = sent.find((m) => m.to === tester.email);
  assert.strictEqual(toTester.subject,
    `[${filed.body.ref}] Fixed — please check it: Take it does nothing on my phone`);
  assert.match(toTester.text, /hidden behind the menu/);
  assert.match(toTester.text, /Still not fixed/);
  const closed = (await call('GET', '/api/issues?scope=closed', null, coordCookie)).body;
  assert.strictEqual(closed[0].notes[0].statusWords, 'Fixed — please check it');

  // Someone else can't reopen it; the reporter can, with a comment.
  assert.strictEqual((await call('POST', `/api/issues/${filed.body.id}/reopen`,
    {}, otherCookie)).status, 400);
  assert.strictEqual((await call('POST', `/api/issues/${filed.body.id}/reopen`,
    { note: 'Still hidden on my iPad' }, testerCookie)).status, 200);
  const again = (await call('GET', '/api/issues/mine', null, testerCookie)).body[0];
  assert.strictEqual(again.status, 'new');
  assert.strictEqual(again.notes[1].body, 'Still hidden on my iPad');

  // Reports (and calendar day notes) are part of the encrypted backup.
  assert.ok(['issue_report', 'issue_note', 'schedule_note'].every((t) => backup.TABLES.includes(t)));
  const dump = await backup.dump();
  assert.strictEqual(dump.tables.issue_report.length, 1);
  assert.strictEqual(dump.tables.issue_note.length, 2);
});

test('reporter comments on and closes their own open report; coordinators are told', async () => {
  const coord = await makeWorker('coordinator');
  const tester = await makeWorker('worker');
  const other = await makeWorker('worker');
  const testerCookie = 'session=' + await auth.createSession(tester.id);
  const otherCookie = 'session=' + await auth.createSession(other.id);

  const filed = (await call('POST', '/api/issues',
    { kind: 'request', title: 'Bigger buttons on the schedule' }, testerCookie)).body;

  // Only the reporter can comment; an empty comment is refused.
  assert.strictEqual((await call('POST', `/api/issues/${filed.id}/comment`,
    { note: 'me too' }, otherCookie)).status, 400);
  assert.strictEqual((await call('POST', `/api/issues/${filed.id}/comment`,
    { note: '  ' }, testerCookie)).status, 400);

  sent.length = 0;
  assert.strictEqual((await call('POST', `/api/issues/${filed.id}/comment`,
    { note: 'Especially Take it on a phone.' }, testerCookie)).status, 200);
  let mine = (await call('GET', '/api/issues/mine', null, testerCookie)).body
    .find((i) => i.id === filed.id);
  assert.strictEqual(mine.status, 'new', 'a comment does not change the status');
  assert.strictEqual(mine.notes[0].body, 'Especially Take it on a phone.');
  const told = sent.find((m) => m.to === coord.email);
  assert.strictEqual(told.subject, `[${filed.ref}] New comment: Bigger buttons on the schedule`);
  assert.match(told.text, new RegExp(`/ops\\.html#${filed.ref}$`));
  assert.ok(!told.text.includes('Especially'), 'comment text stays in the app');

  // Closing it themselves marks it done; after that it's reopen, not comment.
  assert.strictEqual((await call('POST', `/api/issues/${filed.id}/comment`,
    { close: true }, testerCookie)).status, 200);
  mine = (await call('GET', '/api/issues/mine', null, testerCookie)).body
    .find((i) => i.id === filed.id);
  assert.strictEqual(mine.status, 'done');
  assert.strictEqual(mine.notes[1].body, 'Closed by the person who reported it.');
  assert.strictEqual((await call('POST', `/api/issues/${filed.id}/comment`,
    { note: 'one more thing' }, testerCookie)).status, 400);
  assert.strictEqual((await call('POST', `/api/issues/${filed.id}/reopen`,
    { note: 'Actually not sorted' }, testerCookie)).status, 200);
});

test('references stay consecutive even when the id sequence jumps (as after a restart)', async () => {
  const tester = await makeWorker('worker');
  const cookie = 'session=' + await auth.createSession(tester.id);
  const file = async (t) => (await call('POST', '/api/issues', { title: t }, cookie)).body.ref;
  const n = (r) => Number(r.slice(3));
  const a = await file('first');
  await db.run(`SELECT setval(pg_get_serial_sequence('issue_report','id'), 500)`);
  const b = await file('second');
  const c = await file('third');
  assert.strictEqual(n(b), n(a) + 1);
  assert.strictEqual(n(c), n(b) + 1);
  const row = await db.get('SELECT id FROM issue_report WHERE title = ?', ['second']);
  assert.ok(Number(row.id) > 500, 'the id did jump; the reference did not');
});
