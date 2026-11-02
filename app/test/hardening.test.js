'use strict';

// Ship hardening: security headers, gated metrics, web-address-only
// resource links, rate-limit keys that a client can't spoof, help-request
// notes kept off chat apps, and housekeeping of expired rows.

process.env.TL_PGDATA = ':memory:';
process.env.TL_ENCRYPTION_KEY = '9'.repeat(64);
process.env.CRON_SECRET = 'hardening-secret';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const db = require('../src/db');
const sec = require('../src/crypto');
const auth = require('../src/auth');
const rl = require('../src/ratelimit');

let server;
let base;
let seq = 0;

async function makeWorker(role) {
  const id = await db.insert(
    `INSERT INTO worker (email, name, password_hash, role, status, service_status, created_at)
     VALUES (?,?,?,?,'off','in_service',?)`,
    [`hard-${seq++}@test.org`, `Hard ${role} ${seq}`, sec.hashPassword('x'.repeat(12)), role, db.now()]);
  return { id, cookie: `session=${await auth.createSession(id)}` };
}

test.before(async () => {
  await db.init();
  const { app } = require('../server');
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
test.after(() => { server.close(); server.closeAllConnections(); });

test('pages carry security headers; only the caller page may be framed', async () => {
  const consolePage = await fetch(`${base}/console.html`);
  assert.strictEqual(consolePage.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(consolePage.headers.get('referrer-policy'), 'no-referrer');
  assert.strictEqual(consolePage.headers.get('x-frame-options'), 'DENY');
  assert.match(consolePage.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.strictEqual(consolePage.headers.get('x-powered-by'), null);
  const caller = await fetch(`${base}/caller.html`);
  assert.strictEqual(caller.headers.get('x-frame-options'), null);
  assert.strictEqual(caller.headers.get('x-content-type-options'), 'nosniff');
});

test('vercel.json sets the same headers for the static pages', () => {
  const v = require('../vercel.json');
  const all = v.headers.find((h) => h.source === '/(.*)');
  assert.ok(all.headers.some((x) => x.key === 'X-Content-Type-Options'));
  const frame = v.headers.find((h) => h.headers.some((x) => x.key === 'X-Frame-Options'));
  const re = new RegExp('^' + frame.source + '$');
  assert.ok(re.test('/console.html') && re.test('/admin.html'));
  assert.ok(!re.test('/caller.html') && !re.test('/caller.js'));
});

test('/metrics.json needs a supervisor or the cron secret', async () => {
  assert.strictEqual((await fetch(`${base}/metrics.json`)).status, 401);
  const worker = await makeWorker('worker');
  assert.strictEqual((await fetch(`${base}/metrics.json`, { headers: { cookie: worker.cookie } })).status, 401);
  const sup = await makeWorker('supervisor');
  assert.strictEqual((await fetch(`${base}/metrics.json`, { headers: { cookie: sup.cookie } })).status, 200);
  const bySecret = await fetch(`${base}/metrics.json`, { headers: { 'x-cron-secret': 'hardening-secret' } });
  assert.strictEqual(bySecret.status, 200);
});

test('resource links must be web addresses', async () => {
  const coord = await makeWorker('coordinator');
  const post = (body) => fetch(`${base}/api/resources`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', cookie: coord.cookie },
    body: JSON.stringify(body) });
  const bad = await post({ name: 'Bad link', url: 'javascript:alert(1)' });
  assert.strictEqual(bad.status, 400);
  const good = await post({ name: 'Good link', url: 'example.org/help' });
  assert.strictEqual(good.status, 200);
  const { id } = await good.json();
  const row = await db.get('SELECT url FROM resource WHERE id = ?', [id]);
  assert.strictEqual(row.url, 'https://example.org/help');
  const patch = await fetch(`${base}/api/resources/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', cookie: coord.cookie },
    body: JSON.stringify({ url: 'data:text/html,hi' }) });
  assert.strictEqual(patch.status, 400);
});

test('rate limits key on the platform address, not a client-supplied one', () => {
  const req = (headers) => ({ headers, socket: { remoteAddress: '10.0.0.1' } });
  assert.strictEqual(rl.clientIp(req({ 'x-vercel-forwarded-for': '203.0.113.5',
    'x-forwarded-for': '1.2.3.4, 203.0.113.5' })), '203.0.113.5');
  assert.strictEqual(rl.clientIp(req({ 'fly-client-ip': '198.51.100.7' })), '198.51.100.7');
  // A spoofed first entry is ignored: the nearest proxy's entry is last.
  assert.strictEqual(rl.clientIp(req({ 'x-forwarded-for': '1.2.3.4, 198.51.100.9' })), '198.51.100.9');
  assert.strictEqual(rl.clientIp(req({})), '10.0.0.1');
});

test('a help request reaches the team without its note', async () => {
  const sink = [];
  const hook = http.createServer((q, s) => {
    let b = ''; q.on('data', (c) => { b += c; });
    q.on('end', () => { sink.push(JSON.parse(b)); s.writeHead(200).end('{}'); });
  });
  await new Promise((r) => hook.listen(0, r));
  process.env.TL_NOTIFY_WEBHOOK_URL = `http://localhost:${hook.address().port}/hook`;
  try {
    const w = await makeWorker('worker');
    const res = await fetch(`${base}/api/help`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie: w.cookie },
      body: JSON.stringify({ note: 'caller mentioned a private detail' }) });
    assert.strictEqual(res.status, 200);
    for (let i = 0; i < 50 && !sink.length; i++) await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(sink.length, 1);
    assert.match(sink[0].text, /asked for help/);
    assert.ok(!sink[0].text.includes('private detail'));
    const stored = await db.get('SELECT note FROM help_request ORDER BY id DESC LIMIT 1');
    assert.ok(stored.note, 'the note is still kept for the console');
  } finally {
    delete process.env.TL_NOTIFY_WEBHOOK_URL;
    hook.close();
  }
});

test('the ops check clears expired sessions, codes and old rate-limit rows', async () => {
  const w = await makeWorker('worker');
  const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
  await db.run('INSERT INTO session (token, worker_id, created_at, expires_at) VALUES (?,?,?,?)',
    ['expired-token', w.id, old, old]);
  await db.run(`INSERT INTO login_code (worker_id, code_hash, created_at, expires_at)
    VALUES (?,?,?,?)`, [w.id, 'x', old, old]);
  await db.run('INSERT INTO rate_limit (key, window_start, count) VALUES (?,?,?)',
    ['old-key', Date.now() - 3 * 86_400_000, 1]);
  await db.run('INSERT INTO rate_limit (key, window_start, count) VALUES (?,?,?)',
    ['fresh-key', Date.now(), 1]);
  const r = await fetch(`${base}/api/cron/ops-check?secret=hardening-secret`);
  assert.strictEqual(r.status, 200);
  assert.ok(!(await db.get("SELECT 1 FROM session WHERE token = 'expired-token'")));
  assert.strictEqual(Number((await db.get('SELECT COUNT(*) AS n FROM login_code WHERE worker_id = ?', [w.id])).n), 0);
  assert.ok(!(await db.get("SELECT 1 FROM rate_limit WHERE key = 'old-key'")));
  assert.ok(await db.get("SELECT 1 FROM rate_limit WHERE key = 'fresh-key'"));
});

test('changing a password is rate-limited', async () => {
  const w = await makeWorker('worker');
  let last;
  for (let i = 0; i < 11; i++) {
    last = await fetch(`${base}/api/password`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie: w.cookie },
      body: JSON.stringify({ current: 'wrong-password-1', next: 'another-password-2' }) });
  }
  assert.strictEqual(last.status, 429);
});
