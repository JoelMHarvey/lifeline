'use strict';

process.env.TL_PGDATA = ':memory:';
process.env.TL_ENCRYPTION_KEY = 'f'.repeat(64);
process.env.CRON_SECRET = 'ops-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const db = require('../src/db');
const sec = require('../src/crypto');
const notify = require('../src/notify');
const auth = require('../src/auth');

let emailSeq = 0;
async function makeWorker(role = 'worker') {
  const id = await db.insert(
    `INSERT INTO worker (email, name, password_hash, role, status, service_status, created_at)
     VALUES (?,?,?,?,'off','in_service',?)`,
    [`ops-${emailSeq++}@test.org`, `Ops ${role} ${emailSeq}`,
      sec.hashPassword('x'.repeat(12)), role, db.now()]);
  return db.get('SELECT * FROM worker WHERE id = ?', [id]);
}

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, () => resolve(server));
  });
}

// A tiny local sink standing in for a Google Chat webhook.
function webhookSink() {
  const received = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        received.push(JSON.parse(body));
        res.writeHead(200).end('{}');
      });
    });
    server.listen(0, () => resolve({ server, received,
      url: `http://localhost:${server.address().port}/hook` }));
  });
}

test('notify formats Google Chat text messages and reports delivery', async () => {
  const sink = await webhookSink();
  process.env.TL_NOTIFY_WEBHOOK_URL = sink.url;
  process.env.TL_BASE_URL = 'https://example.test/';

  const ok = await notify.notify('backup_page', [1, 2], {});
  assert.strictEqual(ok, true);
  await notify.notify('sub_request', [3], { shift: 4, date: '2026-10-10' });
  await notify.notify('help_requested', [], { from: 'Aiko', note: 'second opinion please' });

  assert.strictEqual(sink.received.length, 3);
  assert.ok(sink.received[0].text.includes('Backup page'));
  assert.ok(sink.received[0].text.includes('https://example.test/console.html'),
    'TL_BASE_URL link appended without a double slash');
  assert.ok(sink.received[1].text.includes('Shift 4 on 2026-10-10'));
  assert.ok(sink.received[2].text.includes('Aiko'), 'help note passes through');

  // Ops events prefer the ops webhook when set.
  const opsSink = await webhookSink();
  process.env.TL_OPS_WEBHOOK_URL = opsSink.url;
  await notify.notify('ops_alert', [], { text: 'something is wrong' });
  assert.strictEqual(opsSink.received.length, 1);
  assert.ok(opsSink.received[0].text.includes('ops alert'));
  assert.strictEqual(sink.received.length, 3, 'team channel untouched by ops event');

  // Delivery failure reports false, never throws.
  sink.server.close();
  const failed = await notify.notify('backup_page', [], {});
  assert.strictEqual(failed, false);
  opsSink.server.close();
  delete process.env.TL_NOTIFY_WEBHOOK_URL;
  delete process.env.TL_OPS_WEBHOOK_URL;
  delete process.env.TL_BASE_URL;
});

test('unhandled errors are persisted and visible on the coordinator ops view', async () => {
  const { app } = require('../server');
  const server = await listen(app);
  const port = server.address().port;

  const coord = await makeWorker('coordinator');
  const token = await auth.createSession(coord.id);

  // Force an unhandled error: claim with a non-numeric id makes Number() NaN
  // — the route 500s and the middleware records it.
  await db.run(`INSERT INTO error_log (path, message, at) VALUES ('/test','synthetic boom',?)`,
    [db.now()]);

  const ops = await (await fetch(`http://localhost:${port}/api/admin/ops`, {
    headers: { Cookie: `session=${token}` } })).json();
  assert.ok(ops.recent_errors.some((e) => e.message === 'synthetic boom'));
  assert.strictEqual(typeof ops.env.database, 'boolean');
  assert.ok(ops.uptime_secs >= 0);

  const worker = await makeWorker('worker');
  const wToken = await auth.createSession(worker.id);
  const forbidden = await fetch(`http://localhost:${port}/api/admin/ops`, {
    headers: { Cookie: `session=${wToken}` } });
  assert.strictEqual(forbidden.status, 403, 'ops view is coordinator-only');
  server.close();
});

test('ops-check: guarded by CRON_SECRET, reports problems, posts to the ops webhook', async () => {
  const { app } = require('../server');
  const server = await listen(app);
  const port = server.address().port;

  const noSecret = await fetch(`http://localhost:${port}/api/cron/ops-check`);
  assert.strictEqual(noSecret.status, 401);

  const sink = await webhookSink();
  process.env.TL_OPS_WEBHOOK_URL = sink.url;

  // The synthetic error from the previous test is within the last hour, so
  // the check flags it and posts an alert.
  const r = await (await fetch(
    `http://localhost:${port}/api/cron/ops-check?secret=ops-test-secret`)).json();
  assert.strictEqual(r.ok, false);
  assert.ok(r.problems.some((p) => /unhandled error/.test(p)));
  assert.strictEqual(r.notified, true);
  assert.ok(sink.received[0].text.includes('ops alert'));

  // Clear the errors: the check goes green, and digest mode posts a summary.
  await db.run('DELETE FROM error_log');
  const green = await (await fetch(
    `http://localhost:${port}/api/cron/ops-check?secret=ops-test-secret&digest=1`)).json();
  assert.strictEqual(green.ok, true);
  assert.strictEqual(green.problems.length, 0);
  assert.ok(sink.received.some((m) => m.text.includes('daily check')));

  sink.server.close();
  delete process.env.TL_OPS_WEBHOOK_URL;
  server.close();
});
