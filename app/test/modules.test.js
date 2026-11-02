'use strict';

process.env.TL_PGDATA = ':memory:';
process.env.TL_ENCRYPTION_KEY = '2'.repeat(64);

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
    [`md-${emailSeq++}@test.org`, `SE ${role} ${emailSeq}`,
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
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
    let data = '';
    res.on('data', (c) => { data += c; });
    res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} }));
  });
  r.on('error', reject);
  r.end(body ? JSON.stringify(body) : undefined);
});

const modules = require('../src/modules');

test.afterEach(() => modules._set(undefined));

test('TL_MODULES parsing: default is everything; unknown names are rejected', () => {
  assert.deepStrictEqual(modules.parse(undefined), ['helpline', 'schedule', 'board']);
  assert.deepStrictEqual(modules.parse(' Schedule '), ['schedule']);
  assert.deepStrictEqual(modules.parse('board,schedule'), ['schedule', 'board']);
  assert.throws(() => modules.parse('schedule,payroll'), /unknown module/);
  assert.strictEqual(modules.moduleOfPath('/api/schedule/slot/4'), 'schedule');
  assert.strictEqual(modules.moduleOfPath('/api/chat/start'), 'helpline');
  assert.strictEqual(modules.moduleOfPath('/api/admin/forms/chat_intake'), 'helpline');
  assert.strictEqual(modules.moduleOfPath('/api/admin/workers'), null);
  assert.strictEqual(modules.moduleOfPath('/api/statusx'), null, 'prefixes match whole segments');
});

test('scheduler-only install: helpline and board APIs are absent, the rest works', async () => {
  modules._set('schedule');
  const w = await makeWorker('coordinator');
  const c = 'session=' + await auth.createSession(w.id);
  assert.deepStrictEqual((await call('GET', '/api/modules')).body, { modules: ['schedule'] });
  assert.deepStrictEqual((await call('GET', '/api/me', null, c)).body.modules, ['schedule']);
  for (const p of ['/api/canned', '/api/directives/active', '/api/wallboard', '/api/board/unread',
    '/api/reports?from=2026-01-01&to=2026-01-31', '/api/resources']) {
    assert.strictEqual((await call('GET', p, null, c)).status, 404, p);
  }
  assert.strictEqual((await call('POST', '/api/chat/start', {})).status, 404, 'no caller chat');
  const sweep = await call('POST', '/api/cron/sweep', {});
  assert.strictEqual(sweep.status, 200);
  assert.strictEqual(sweep.body.skipped, 'helpline module off');
  assert.strictEqual((await call('GET', '/api/shifts', null, c)).status, 200);
  assert.strictEqual((await call('GET', '/api/schedule?month=2026-11', null, c)).status, 200);
  assert.strictEqual((await call('GET', '/api/admin/workers', null, c)).status, 200);
  assert.strictEqual((await call('GET', '/api/issues/mine', null, c)).status, 200);

  modules._set(undefined);
  assert.strictEqual((await call('GET', '/api/canned', null, c)).status, 200, 'full install unchanged');
});
