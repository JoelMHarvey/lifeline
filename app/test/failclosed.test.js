'use strict';

// Fail closed: a deployment whose profile has no helpline phone or emergency
// number must not run the caller chat. The caller page says the chat is not
// available, the chat APIs refuse, and health checks report it.

process.env.TL_PROFILE = 'generic';
delete process.env.TL_MODULES;           // everything on, helpline included
process.env.TL_PGDATA = ':memory:';
process.env.TL_ENCRYPTION_KEY = '2'.repeat(64);

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const db = require('../src/db');

let server;
let base;
test.before(async () => {
  await db.init();
  const { app } = require('../server');
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
test.after(() => { server.close(); server.closeAllConnections(); });

test('the caller page offers no chat and points to emergency services', async () => {
  const html = await (await fetch(`${base}/caller.html`)).text();
  assert.match(html, /<div class="panel" id="startCard" hidden( data-safety="[0-9a-f]+")?>/, 'start card hidden');
  assert.ok(html.includes('id="notReady"'));
  assert.ok(html.includes('Chat is not available'));
  assert.ok(html.includes('Contact your local emergency services now.'));
  assert.doesNotMatch(html, /\bTELL\b|03-5774|\b119\b|\b110\b/);
});

test('staff see a not-configured banner on the console', async () => {
  const html = await (await fetch(`${base}/console.html`)).text();
  assert.ok(html.includes('id="notConfigured"'));
  assert.ok(html.includes('profiles/generic.json'));
});

test('the chat APIs refuse with 503 and say why', async () => {
  const start = await fetch(`${base}/api/chat/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.strictEqual(start.status, 503);
  assert.strictEqual((await start.json()).notConfigured, true);
  const count = await db.get('SELECT COUNT(*) AS n FROM contact');
  assert.strictEqual(Number(count.n), 0, 'no contact was created');
  const form = await fetch(`${base}/api/prechat/form`);
  assert.strictEqual(form.status, 503);
});

test('healthz and the ops check report the missing configuration', async () => {
  // A fresh install waiting for its setup wizard reports the gap but stays
  // up, so a host's health check doesn't restart it mid-setup.
  const fresh = await fetch(`${base}/healthz`);
  assert.strictEqual(fresh.status, 200);
  const freshBody = await fresh.json();
  assert.strictEqual(freshBody.helpline, false);
  assert.strictEqual(freshBody.setup, 'open');
  // Once anyone has an account, a missing helpline is a failure.
  const id = await db.insert(
    `INSERT INTO worker (email, name, password_hash, role, created_at) VALUES (?,?,?,?,?)`,
    ['fc-health@test.org', 'FC Health', 'x', 'coordinator', db.now()]);
  const res = await fetch(`${base}/healthz`);
  await db.run('DELETE FROM worker WHERE id = ?', [id]);
  assert.strictEqual(res.status, 500);
  const body = await res.json();
  assert.strictEqual(body.ok, false);
  assert.strictEqual(body.helpline, false);
  assert.strictEqual(body.setup, undefined);
  const ops = await (await fetch(`${base}/api/cron/ops-check`)).json();
  assert.ok(JSON.stringify(ops).includes('Helpline NOT CONFIGURED'));
});

test('the generic safety-valve message and canned set carry no numbers', () => {
  const msg = db.CONFIG_DEFAULTS.safety_valve_message;
  assert.match(msg, /contact your local emergency services\.$/);
  assert.doesNotMatch(msg, /\bTELL\b|\d{3}/);
  const canned = require('../src/canned');
  assert.doesNotMatch(JSON.stringify(canned.STARTER), /\bTELL\b|\b119\b|\b110\b/);
});

test('a profile with a phone but no emergency number is still not ready', () => {
  const profile = require('../src/profile');
  const fs = require('node:fs');
  const path = require('node:path');
  const g = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'profiles', 'generic.json'), 'utf8'));
  const tmp = path.join(__dirname, '..', 'profiles', 'zz-halfready-test.json');
  try {
    fs.writeFileSync(tmp, JSON.stringify({ ...g, id: 'zz-halfready-test', phone: '0000-000' }));
    assert.strictEqual(profile.load('zz-halfready-test').ready.helpline, false);
    fs.writeFileSync(tmp, JSON.stringify({ ...g, id: 'zz-halfready-test', phone: '0000-000',
      emergency: { ...g.emergency, primary: { number: '999', label: 'emergency' } } }));
    assert.strictEqual(profile.load('zz-halfready-test').ready.helpline, true);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test('a waiting caller whose place was lost is told, with the numbers (not left waiting)', async () => {
  const profile = require('../src/profile');
  await db.run("INSERT INTO config (key, value) VALUES ('brand.phone', '0800 1'), ('brand.emergency.primary.number', '999')");
  await profile.loadOverrides((sql) => db.all(sql));
  try {
    const queue = require('../src/queue');
    const { chatToken, contactId } = await queue.joinQueue({ alias: 'W' });
    await queue.endContact(contactId, 'abandoned');
    const res = await fetch(`${base}/api/chat/stream?token=${chatToken}`);
    const text = await res.text();
    assert.match(text, /"type":"safety_valve"/);
    assert.match(text, /place in the queue was lost/);
    assert.match(text, /999/);
  } finally {
    await db.run("DELETE FROM config WHERE key IN ('brand.phone', 'brand.emergency.primary.number')");
    await profile.loadOverrides((sql) => db.all(sql));
  }
});
