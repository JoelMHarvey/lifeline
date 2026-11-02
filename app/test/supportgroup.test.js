'use strict';

process.env.TL_PGDATA = ':memory:';
process.env.TL_ENCRYPTION_KEY = '4'.repeat(64);

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
    [`sg-${emailSeq++}@test.org`, `SE ${role} ${emailSeq}`,
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

test('group parsing accepts the sheet\'s forms', () => {
  for (const [v, want] of [['S08', 8], ['8', 8], ['08', 8], ['group 12', 12], ['', null],
    [null, null], ['S0', undefined], ['abc', undefined], ['100', undefined]]) {
    assert.strictEqual(schedule.parseGroup(v), want, String(v));
  }
  assert.deepStrictEqual(schedule.splitGroupPrefix('S08 Alex M'), { name: 'Alex M', group: 8 });
  assert.deepStrictEqual(schedule.splitGroupPrefix('Alex M'), { name: 'Alex M', group: null });
});

test('support group: set by coordinators, imported from CSV, shown on the schedule', async () => {
  const coord = await makeWorker('coordinator');
  const cc = 'session=' + await auth.createSession(coord.id);
  const sup = await makeWorker('supervisor');
  const sc = 'session=' + await auth.createSession(sup.id);
  const w = await makeWorker('worker');
  assert.strictEqual((await call('PATCH', `/api/admin/workers/${w.id}`, { supportGroup: 'S05' }, sc)).status, 403);
  assert.strictEqual((await call('PATCH', `/api/admin/workers/${w.id}`, { supportGroup: 'x' }, cc)).status, 400);
  assert.strictEqual((await call('PATCH', `/api/admin/workers/${w.id}`, { supportGroup: 'S05' }, cc)).status, 200);
  const list = (await call('GET', '/api/admin/workers', null, cc)).body;
  assert.strictEqual(list.find((x) => x.id === Number(w.id)).support_group, 5);

  // CSV: an iCarol-style "S08 Name" sets the group; a group column wins.
  const csv = 'Email,Name,Role,Support group\n' +
    'g1@sg.test,S08 Nia Nash,Worker,\n' +
    'g2@sg.test,S08 Oli Ott,worker,11\n' +
    'g3@sg.test,Pia Park,worker,bad\n';
  const imp = (await call('POST', '/api/admin/import', { csv }, cc)).body;
  assert.deepStrictEqual(imp.created.map((c) => [c.name, c.group]), [['Nia Nash', 'S08'], ['Oli Ott', 'S11']]);
  assert.match(imp.errors.join(), /bad group/);
  const nia = await db.get(`SELECT * FROM worker WHERE email = 'g1@sg.test'`);
  assert.strictEqual(nia.name, 'Nia Nash');
  assert.strictEqual(nia.role, 'worker');

  await schedule.shiftDefs(); // seeds S1-S7
  const slot = await db.insert(
    `INSERT INTO shift_slot (date, shift_number, role, worker_id, status, created_at)
     VALUES ('2027-09-01', 1, 'worker', ?, 'assigned', ?)`, [nia.id, db.now()]);
  const s = (await schedule.monthSlots('2027-09')).find((x) => x.id === Number(slot));
  assert.strictEqual(s.workerGroup, 'S08');
});
