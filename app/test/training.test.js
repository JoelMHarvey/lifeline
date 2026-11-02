'use strict';

process.env.TL_PGDATA = ':memory:';
process.env.TL_ENCRYPTION_KEY = '7'.repeat(64);

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const db = require('../src/db');
const sec = require('../src/crypto');
const schedule = require('../src/schedule');
const auth = require('../src/auth');

let emailSeq = 0;
async function makeWorker(role = 'worker') {
  const id = await db.insert(
    `INSERT INTO worker (email, name, password_hash, role, status, service_status, created_at)
     VALUES (?,?,?,?,'off','in_service',?)`,
    [`tr-${emailSeq++}@test.org`, `TR ${role} ${emailSeq}`,
      sec.hashPassword('x'.repeat(12)), role, db.now()]);
  return db.get('SELECT * FROM worker WHERE id = ?', [id]);
}

let server;
let port;
test.before(async () => {
  await db.init();
  await schedule.ensureShiftsSeeded();
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

test('a shift can carry a worker plus OS and SS seats; trainees numbered per role', async () => {
  const sup = await makeWorker('supervisor');
  const worker = await makeWorker('worker');
  const trainee = await makeWorker('trainee');
  const supCookie = 'session=' + await auth.createSession(sup.id);

  const add = async (date, role, who) => {
    const r = await call('POST', '/api/schedule/slot', { date, shiftNumber: 3, role }, supCookie);
    assert.strictEqual(r.status, 200, `${role} slot created`);
    if (who) {
      const a = await call('PATCH', '/api/schedule/slot/' + r.body.id,
        { workerId: Number(who.id) }, supCookie);
      assert.strictEqual(a.status, 200, `${role} assigned`);
    }
    return r.body.id;
  };

  // 5 Nov: the worker on S3 with the trainee observing; 9 and 12 Nov two
  // more observations; 20 Nov the trainee's first supervised shift.
  await add('2029-11-05', 'worker', worker);
  const os1 = await add('2029-11-05', 'observer', trainee);
  const os2 = await add('2029-11-09', 'observer', trainee);
  const os3 = await add('2029-11-12', 'observer', trainee);
  const ss1 = await add('2029-11-20', 'supervised', trainee);

  // A trainee can't take the worker seat itself.
  const seat = await call('POST', '/api/schedule/slot',
    { date: '2029-11-21', shiftNumber: 3, role: 'worker' }, supCookie);
  assert.strictEqual((await call('PATCH', '/api/schedule/slot/' + seat.body.id,
    { workerId: Number(trainee.id) }, supCookie)).status, 400);
  // Unknown roles are refused.
  assert.strictEqual((await call('POST', '/api/schedule/slot',
    { date: '2029-11-21', shiftNumber: 3, role: 'shadow' }, supCookie)).status, 400);

  const slots = (await call('GET', '/api/schedule?month=2029-11', null, supCookie)).body.slots;
  const byId = new Map(slots.map((s) => [s.id, s]));
  assert.strictEqual(slots.filter((s) => s.date === '2029-11-05').length, 2, 'two people on 5 Nov S3');
  assert.deepStrictEqual([os1, os2, os3].map((id) => byId.get(id).ordinal), [1, 2, 3]);
  assert.strictEqual(byId.get(ss1).ordinal, 1, 'SS counted separately from OS');
  assert.strictEqual(byId.get(ss1).role, 'supervised');

  // Counts carry across months, and a cancelled observation drops out.
  await call('PATCH', '/api/schedule/slot/' + os2, { cancel: true }, supCookie);
  const os4 = await add('2029-12-03', 'observer', trainee);
  const dec = (await call('GET', '/api/schedule?month=2029-12', null, supCookie)).body.slots;
  assert.strictEqual(dec.find((s) => s.id === os4).ordinal, 3);
});
