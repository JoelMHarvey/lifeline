'use strict';

// Setup wizard review fixes on a second fresh install: the setup belongs to
// one browser, malformed drafts are refused, custom messages must carry the
// numbers, test emails are capped, starting from another profile never
// borrows its numbers, and a cold instance serves the saved settings.

process.env.TL_PROFILE = 'generic';
delete process.env.TL_MODULES;
delete process.env.TL_SETUP_TOKEN;
process.env.TL_PGDATA = ':memory:';
process.env.TL_ENCRYPTION_KEY = '2'.repeat(64);

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const db = require('../src/db');
const profile = require('../src/profile');
const mail = require('../src/mail');

let server;
let base;
const browser = () => {
  let jar = '';
  const go = async (method, p, body) => {
    const r = await fetch(base + p, { method,
      headers: { 'Content-Type': 'application/json', ...(jar ? { Cookie: jar } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const c = r.headers.get('set-cookie');
    if (c && c.startsWith('setup_owner=')) jar = c.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { get: (p) => go('GET', p), post: (p, b) => go('POST', p, b) };
};

const sent = [];
test.before(async () => {
  await db.init();
  mail._setTransportForTests(async (m) => { sent.push(m); return true; });
  const { app } = require('../server');
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
test.after(() => { server.close(); server.closeAllConnections(); });

const owner = browser();
const intruder = browser();

test('setup belongs to the first browser', async () => {
  assert.strictEqual((await owner.get('/api/setup/state')).status, 200);
  const other = await intruder.post('/api/setup/save', { account: { email: 'attacker@evil.example', totp: false } });
  assert.strictEqual(other.status, 409);
  assert.strictEqual(other.body.otherBrowser, true);
  assert.strictEqual((await intruder.get('/api/setup/state')).status, 409);
  assert.strictEqual((await owner.get('/api/setup/state')).status, 200);
});

test('malformed drafts are refused, not stored', async () => {
  for (const bad of [{ shifts: { rows: 'x' } }, { shifts: { rows: [5] } }, { org: 'x' },
    { modules: 'helpline' }, { safety: { phone: { a: 1 } } }]) {
    assert.strictEqual((await owner.post('/api/setup/save', bad)).status, 400, JSON.stringify(bad));
  }
  const r = await owner.post('/api/setup/save', { org: { name: 'Help {{now}}', shortName: 'H' } });
  assert.ok(r.body.errors.name);
  assert.strictEqual((await owner.get('/api/setup/state')).status, 200, 'the wizard still loads');
});

test('starting from another profile never borrows its numbers or name', async () => {
  const r = await owner.post('/api/setup/save', { org: { from: 'tell' } });
  const d = r.body.state.draft;
  assert.strictEqual(d.safety.phone, '');
  assert.strictEqual(d.safety.primaryNumber, '');
  assert.notStrictEqual(d.org.name, 'TELL Lifeline');
  assert.ok(!d.look.logo.includes('M22 2'), 'not the TELL paper plane');
  assert.strictEqual(d.shifts.rows.length, 7, 'the shift pattern does come across');
});

test('a hand-written message must carry the current numbers; 2FA must be enrolled', async () => {
  await owner.post('/api/setup/save', { org: { from: 'generic' } });
  await owner.post('/api/setup/save', { org: { name: 'Bay Line', shortName: 'Bay', timezone: 'Europe/London' },
    safety: { phone: '0800 111 222', primaryNumber: '999', primaryLabel: 'emergency services',
      message: 'Sorry. Call 112 if in danger. Our line: 0800 000 000.' },
    modules: ['schedule', 'helpline'], account: { name: 'Bo', email: 'bo@bay.example', totp: true } });
  const s = await owner.get('/api/setup/state');
  const keys = Object.fromEntries(s.body.readiness.checks.map((c) => [c.key, c.ok]));
  assert.strictEqual(keys.messageNumbers, false);
  assert.strictEqual(keys.totpEnrolled, false);
  assert.strictEqual(s.body.readiness.ok, false);
});

test('test emails: fixed wording, five at most', async () => {
  await owner.post('/api/setup/save', { org: { name: 'Buy cheap pills now', shortName: 'X' } });
  const r = await owner.post('/api/setup/test-email', { to: 't@example.org' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].subject, 'Setup test email');
  assert.ok(!/pills/.test(sent[0].text));
  await db.run(`UPDATE config SET value = '5' WHERE key = 'setup.test_emails'`);
  await db.run('DELETE FROM rate_limit');
  const capped = await owner.post('/api/setup/test-email', { to: 'more@example.org' });
  assert.strictEqual(capped.status, 429);
  assert.match(capped.body.error, /five test emails/);
});

test('a fresh instance serves the saved numbers and modules on its first request', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-cold-'));
  const env = { ...process.env, TL_PGDATA: dir, TL_PROFILE: 'generic' };
  delete env.TL_MODULES;
  const run = (code) => spawnSync(process.execPath, ['-e', code], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8', timeout: 120_000 });
  try {
    // "Another instance" saved settings earlier.
    let r = run(`const db=require('./src/db');(async()=>{await db.init();
      for (const [k,v] of [['brand.phone','0800 111 222'],['brand.emergency.primary.number','999'],['setup.modules','schedule,helpline']])
        await db.run('INSERT INTO config (key, value) VALUES (?, ?)', [k, v]);
      process.exit(0)})().catch(e=>{console.error(e);process.exit(1)})`);
    assert.strictEqual(r.status, 0, r.stderr);
    // A cold instance (like a serverless function: no db.init at boot).
    r = run(`const http=require('http');const {app}=require('./server');
      const s=http.createServer(app).listen(0,async()=>{const b='http://localhost:'+s.address().port;
        const pre=await fetch(b+'/api/prechat/form');const mods=await (await fetch(b+'/api/modules')).json();
        console.log(JSON.stringify({pre:pre.status,mods:mods.modules}));process.exit(0)})`);
    assert.strictEqual(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.strictEqual(out.pre, 200, 'chat available on the first request');
    assert.deepStrictEqual(out.mods, ['helpline', 'schedule'], 'the saved module choice, not the defaults');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
