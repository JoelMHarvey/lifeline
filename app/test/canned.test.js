'use strict';

process.env.TL_PGDATA = ':memory:';
process.env.TL_ENCRYPTION_KEY = '5'.repeat(64);

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
    [`cr-${emailSeq++}@test.org`, `CR ${role} ${emailSeq}`,
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


test('canned responses: workers keep their own, supervisors run the shared ones', async () => {
  const sup = await makeWorker('supervisor');
  const w1 = await makeWorker('worker');
  const w2 = await makeWorker('worker');
  const trainee = await makeWorker('trainee');
  const supC = 'session=' + await auth.createSession(sup.id);
  const w1C = 'session=' + await auth.createSession(w1.id);
  const w2C = 'session=' + await auth.createSession(w2.id);
  const trC = 'session=' + await auth.createSession(trainee.id);

  // Nothing yet; the starter set is a supervisor's button and only adds what's missing.
  assert.deepStrictEqual((await call('GET', '/api/canned', null, w1C)).body, []);
  assert.strictEqual((await call('POST', '/api/canned/starter', null, w1C)).status, 403);
  const first = await call('POST', '/api/canned/starter', null, supC);
  assert.strictEqual(first.body.added, 8);
  assert.strictEqual((await call('POST', '/api/canned/starter', null, supC)).body.added, 0);

  // A worker's own response, and a refused attempt to share one.
  const mine = await call('POST', '/api/canned', { label: '  My   hello ', body: 'Hi there' }, w1C);
  assert.ok(mine.body.id);
  assert.strictEqual((await call('POST', '/api/canned',
    { label: 'x', body: 'y', shared: true }, w1C)).status, 403);
  assert.strictEqual((await call('POST', '/api/canned', { label: '', body: 'y' }, w1C)).status, 400);
  assert.strictEqual((await call('POST', '/api/canned', { label: 'T', body: 'y' }, trC)).status, 403);

  const list1 = (await call('GET', '/api/canned', null, w1C)).body;
  assert.strictEqual(list1.length, 9);
  const own = list1.find((c) => c.id === mine.body.id);
  assert.deepStrictEqual([own.label, own.shared, own.canEdit], ['My hello', false, true]);
  const welcome = list1.find((c) => c.label === 'Welcome');
  assert.deepStrictEqual([welcome.shared, welcome.canEdit], [true, false]);
  // Another worker doesn't see it, and can't touch it.
  assert.strictEqual((await call('GET', '/api/canned', null, w2C)).body.length, 8);
  assert.strictEqual((await call('PATCH', `/api/canned/${mine.body.id}`, { body: 'z' }, w2C)).status, 404);
  assert.strictEqual((await call('DELETE', `/api/canned/${mine.body.id}`, null, w2C)).status, 404);

  // Workers can't change shared ones; supervisors can, and it's audited.
  assert.strictEqual((await call('PATCH', `/api/canned/${welcome.id}`, { body: 'z' }, w1C)).status, 403);
  assert.strictEqual((await call('DELETE', `/api/canned/${welcome.id}`, null, w1C)).status, 403);
  assert.strictEqual((await call('PATCH', `/api/canned/${welcome.id}`,
    { body: 'Hello, this is TELL.' }, supC)).status, 200);
  assert.strictEqual((await db.get('SELECT body FROM canned_response WHERE id = ?', [welcome.id])).body,
    'Hello, this is TELL.');
  assert.ok(await db.get(`SELECT 1 FROM audit_log WHERE action = 'canned_changed'`));

  // The owner edits and deletes their own.
  assert.strictEqual((await call('PATCH', `/api/canned/${mine.body.id}`,
    { label: 'Hello', body: 'Hi, how are you?' }, w1C)).status, 200);
  assert.strictEqual((await call('PATCH', `/api/canned/${mine.body.id}`, { shared: true }, w1C)).status, 403);
  assert.strictEqual((await call('DELETE', `/api/canned/${mine.body.id}`, null, w1C)).status, 200);
  assert.strictEqual((await call('GET', '/api/canned', null, w1C)).body.length, 8);

  // A supervisor can share one of their own with everyone.
  const supOwn = await call('POST', '/api/canned', { label: 'Sup note', body: 'b', shared: false }, supC);
  await call('PATCH', `/api/canned/${supOwn.body.id}`, { shared: true }, supC);
  assert.ok((await call('GET', '/api/canned', null, w2C)).body.some((c) => c.label === 'Sup note' && c.shared));
  assert.strictEqual((await call('DELETE', `/api/canned/${welcome.id}`, null, supC)).status, 200);
  assert.ok(await db.get(`SELECT 1 FROM audit_log WHERE action = 'canned_deleted' AND detail = 'Welcome'`));

  // Trainees can read them in the console.
  assert.strictEqual((await call('GET', '/api/canned', null, trC)).status, 200);
});
