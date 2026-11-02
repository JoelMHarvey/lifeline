'use strict';

// The setup wizard (plan 08, P7) on a fresh generic install: every step,
// resume, the safety gates, the logo sanitiser, finish, and what the
// finished install looks like.

process.env.TL_PROFILE = 'generic';
delete process.env.TL_MODULES;
delete process.env.TL_SETUP_TOKEN;
process.env.TL_PGDATA = ':memory:';
process.env.TL_ENCRYPTION_KEY = '2'.repeat(64);

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const db = require('../src/db');
const sec = require('../src/crypto');
const profile = require('../src/profile');
const modules = require('../src/modules');
const setup = require('../src/setup');
const site = require('../src/site');

let server;
let base;
// This browser's setup cookie (setup belongs to the first browser).
let jar = '';
const keep = (r) => {
  const c = r.headers.get('set-cookie');
  if (c && c.startsWith('setup_owner=')) jar = c.split(';')[0];
};
const post = async (p, body, headers = {}) => {
  const r = await fetch(base + p, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(jar ? { Cookie: jar } : {}), ...headers },
    body: JSON.stringify(body) });
  keep(r);
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
};
const get = async (p, headers = {}) => {
  const r = await fetch(base + p, { headers: { ...(jar ? { Cookie: jar } : {}), ...headers } });
  keep(r);
  return { status: r.status, body: await r.json().catch(() => null) };
};

test.before(async () => {
  await db.init();
  const { app } = require('../server');
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
test.after(() => { server.close(); server.closeAllConnections(); });

test('logo sanitiser keeps shapes and drops everything else', () => {
  const dirty = `<?xml version="1.0"?><!-- hi --><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
    onload="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)"><path d="M0 0h1"/></a>
    <image href="http://evil/x.png"/><path d="M1 1L5 5" fill="#123456" style="x" onclick="y"/>
    <circle cx="5" cy="5" r="2" fill="url(#g)"/><text>hello</text><foreignObject><div>x</div></foreignObject></svg>`;
  const { svg, error } = setup.sanitizeSvg(dirty);
  assert.ok(!error, error);
  assert.ok(!/script|onload|onclick|javascript|image|href|style|text|foreignObject|url\(|"/i.test(svg), svg);
  assert.ok(svg.startsWith("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'>"));
  assert.ok(svg.includes("<path d='M1 1L5 5' fill='#123456'/>"));
  assert.ok(svg.includes("<circle cx='5' cy='5' r='2'/>"), 'the url() fill is dropped, the shape kept');
  assert.ok(!svg.includes('M0 0h1'), 'shapes inside a dropped <a> go too');
  assert.match(setup.sanitizeSvg('<html><body>no</body></html>').error, /not an SVG/);
  assert.match(setup.sanitizeSvg('<svg><text>hi</text></svg>').error, /no shapes/);
});

test('colour check: AA against white text, shades derived', () => {
  assert.deepStrictEqual(setup.colorProblems('#2f5fa8'), []);
  assert.match(setup.colorProblems('#ffd400')[0], /needs 4\.5:1/);
  const c = setup.deriveColors('#2f5fa8');
  assert.ok(setup.contrast(c.deep, c.soft) >= 4.5);
});

test('the old one-step setup is replaced by the wizard', async () => {
  const r = await post('/api/setup', { name: 'X', email: 'x@y.org', password: 'x'.repeat(12) });
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.body.wizard, true);
  const page = site.render(profile.base())['setup.html'];
  assert.ok(page.includes("location.replace('wizard.html')"));
});

test('wizard: steps validate, save server-side and resume', async () => {
  let s = await get('/api/setup/state');
  assert.strictEqual(s.status, 200);
  assert.strictEqual(s.body.open, true);
  assert.strictEqual(s.body.draft.step, 'org');

  let r = await post('/api/setup/save', { org: { name: 'Harbour "Line"', shortName: '', timezone: 'Mars/Base' } });
  assert.ok(r.body.errors.name && r.body.errors.shortName && r.body.errors.timezone);
  r = await post('/api/setup/save', { org: { name: 'Harbour Lifeline', shortName: 'Harbour',
    website: 'https://harbour.example', timezone: 'Europe/London' }, step: 'look' });
  assert.deepStrictEqual(r.body.errors, {});

  r = await post('/api/setup/save', { look: { accent: '#ffe066' } });
  assert.match(r.body.errors.accent, /needs 4\.5:1/);
  r = await post('/api/setup/save', { look: { accent: '#0f6e5a',
    logo: "<svg viewBox='0 0 24 24'><script>x</script><circle cx='12' cy='12' r='9'/></svg>" } });
  assert.deepStrictEqual(r.body.errors, {});

  // The helpline can't be chosen before the safety numbers are in.
  r = await post('/api/setup/save', { modules: ['schedule', 'helpline'] });
  assert.match(r.body.errors.modules, /safety numbers/);
  r = await post('/api/setup/save', { safety: { phone: '0800 123 4567', primaryNumber: '999',
    primaryLabel: 'emergency services', secondaryNumber: '111', secondaryLabel: 'urgent medical help' } });
  assert.deepStrictEqual(r.body.errors, {});
  r = await post('/api/setup/save', { modules: ['schedule', 'helpline'] });
  assert.deepStrictEqual(r.body.errors, {});
  assert.match(r.body.state.suggestedMessage, /call 999 \(emergency services\) or 111 \(urgent medical help\)\. Harbour Lifeline phone: 0800 123 4567\./);

  const preset = r.body.state.presets.two12;
  r = await post('/api/setup/save', { shifts: { rows: [['Day', '08:00', '08:00', 'both']] } });
  assert.match(r.body.errors.row1, /differ/);
  r = await post('/api/setup/save', { shifts: { rows: preset.rows,
    weekSeats: { 1: { mon: 2, tue: 2, wed: 2, thu: 2, fri: 2, sat: 1, sun: 1 } } } });
  assert.deepStrictEqual(r.body.errors, {});
  r = await post('/api/setup/save', { email: { fromName: 'Harbour Lifeline' } });
  r = await post('/api/setup/save', { account: { name: 'Robin', email: 'robin@harbour.example', totp: true }, step: 'ready' });
  assert.deepStrictEqual(r.body.errors, {});

  // A closed tab resumes where it was.
  s = await get('/api/setup/state');
  assert.strictEqual(s.body.draft.step, 'ready');
  assert.strictEqual(s.body.draft.org.name, 'Harbour Lifeline');
  assert.deepStrictEqual(s.body.draft.modules, ['schedule', 'helpline']);
  assert.ok(s.body.draft.look.logo.startsWith('<svg') && !s.body.draft.look.logo.includes('script'));
});

test('wizard: finish creates the coordinator and applies everything', async () => {
  const t = await post('/api/setup/totp', { email: 'robin@harbour.example' });
  assert.ok(t.body.qr.startsWith('data:image/png'));
  assert.ok(!(await get('/api/setup/state')).body.draft.account.totpSecret, 'the secret is never sent back');

  assert.strictEqual((await post('/api/setup/finish', { password: 'short' })).status, 400);
  const badCode = await post('/api/setup/finish', { password: 'a long password', totpCode: '000000' });
  assert.match(badCode.body.error, /authenticator code/);
  const ok = await post('/api/setup/finish', { password: 'a long password',
    totpCode: sec.totpCode(t.body.secret, Date.now()) });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  assert.match(ok.headers.get('set-cookie'), /^session=/);

  const w = await db.get("SELECT role, totp_enabled FROM worker WHERE email = 'robin@harbour.example'");
  assert.strictEqual(w.role, 'coordinator');
  assert.strictEqual(Number(w.totp_enabled), 1);

  // Closed for good.
  assert.strictEqual((await get('/api/setup/state')).body.open, false);
  assert.strictEqual((await post('/api/setup/save', { org: { name: 'Hijack' } })).status, 403);
  assert.strictEqual((await post('/api/setup/finish', { password: 'another long one' })).status, 403);

  // Settings in effect.
  const p = profile.profile();
  assert.strictEqual(p.name, 'Harbour Lifeline');
  assert.strictEqual(p.timezone, 'Europe/London');
  assert.strictEqual(p.colors.accent, '#0f6e5a');
  assert.strictEqual(p.phone, '0800 123 4567');
  assert.strictEqual(p.ready.helpline, true);
  assert.ok(p.logo.svg.includes('<circle'));
  assert.deepStrictEqual(modules.list(), ['helpline', 'schedule']);
  assert.match(await db.getConfig('safety_valve_message'), /Harbour Lifeline phone: 0800 123 4567/);
  const defs = await db.all('SELECT number, label, start_time, seats_json FROM shift_def WHERE active = 1 ORDER BY number');
  assert.deepStrictEqual(defs.map((d) => [Number(d.number), d.label, d.start_time]), [[1, 'Day', '08:00'], [2, 'Night', '20:00']]);
  assert.strictEqual(JSON.parse(defs[0].seats_json).mon, 2);
  const audit = await db.get("SELECT detail FROM audit_log WHERE action = 'setup_completed'");
  assert.match(audit.detail, /modules schedule,helpline/);
});

test('the finished install serves its own name, colours and numbers, and no TELL', async () => {
  const caller = await (await fetch(base + '/caller.html')).text();
  assert.match(caller, /<title>Harbour Lifeline Chat<\/title>/);
  assert.ok(caller.includes('Call <strong>999</strong> (emergency services)'));
  assert.ok(caller.includes('Harbour Lifeline phone: <strong>0800 123 4567</strong>'));
  assert.match(caller, /<div class="panel" id="startCard" data-safety="[0-9a-f]{16}">/, 'chat offered now numbers are set');
  const css = await (await fetch(base + '/shared.css')).text();
  assert.ok(css.includes('--accent: #0f6e5a;'));
  const LEAK = /\bTELL\b|telljp|Tokyo|03-5774|00a79d|paper.plane/;
  for (const [rel, body] of Object.entries(site.render(profile.profile()))) {
    assert.doesNotMatch(String(body), LEAK, rel);
  }
});

test('a page built before the numbers changed cannot start a chat', async () => {
  const callerHtml = await (await fetch(base + '/caller.html')).text();
  const hash = callerHtml.match(/id="startCard" data-safety="([0-9a-f]{16})"/)[1];
  assert.strictEqual(hash, profile.profile().safetyHash);
  const stale = await post('/api/chat/start', { pageSafety: profile.base().safetyHash });
  assert.strictEqual(stale.status, 409);
  assert.strictEqual(stale.body.stale, true);
  const fresh = await post('/api/chat/start', { pageSafety: hash });
  assert.strictEqual(fresh.status, 200, JSON.stringify(fresh.body));
});

test('the finished settings export as a profile that loads', async () => {
  const sid = (await db.get("SELECT id FROM worker WHERE email = 'robin@harbour.example'")).id;
  const cookie = 'session=' + await require('../src/auth').createSession(sid);
  const r = await fetch(base + '/api/admin/profile-export?id=harbour-test', { headers: { Cookie: cookie } });
  assert.strictEqual(r.status, 200);
  const exported = await r.json();
  const file = path.join(__dirname, '..', 'profiles', 'harbour-test.json');
  try {
    fs.writeFileSync(file, JSON.stringify(exported));
    const loaded = profile.load('harbour-test');
    assert.strictEqual(loaded.name, 'Harbour Lifeline');
    assert.strictEqual(loaded.phone, '0800 123 4567');
    assert.strictEqual(loaded.timezone, 'Europe/London');
    assert.strictEqual(loaded.schedule.shifts.length, 2);
    assert.strictEqual(loaded.features.setupWizard, true);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('TL_SETUP_TOKEN guards the wizard; TELL has no wizard', async () => {
  process.env.TL_SETUP_TOKEN = 'letmein';
  try {
    assert.strictEqual((await get('/api/setup/state')).status, 401);
    assert.strictEqual((await get('/api/setup/state', { 'x-setup-token': 'letmein' })).status, 200);
  } finally {
    delete process.env.TL_SETUP_TOKEN;
  }
  profile._set('tell');
  try {
    assert.strictEqual((await get('/api/setup/state')).status, 404);
    const tell = site.render(profile.load('tell'));
    assert.ok(!tell['setup.html'].includes('wizard'));
    assert.ok(!tell['caller.js'].includes('pageSafety'));
  } finally {
    profile._set('generic');
  }
});


// --- Review fixes -------------------------------------------------------------

test('logo sanitiser: line breaks folded, no catastrophic backtracking', () => {
  const { svg } = setup.sanitizeSvg("<svg viewBox='0 0 24 24'><path d='M0 0\n L10 10'/></svg>");
  assert.ok(!/[\r\n]/.test(svg));
  assert.ok(svg.includes("d='M0 0 L10 10'"));
  const t = Date.now();
  setup.sanitizeSvg('<svg ' + ' '.repeat(65000));
  setup.sanitizeSvg('<svg>' + '<a'.repeat(32000));
  assert.ok(Date.now() - t < 1000, 'linear time');
  assert.match(profile.overrideError('logo.svg', "<svg><path d='M0\n0'/></svg>") || '', /sanitised/);
});

test('timezones must be named zones from the list', () => {
  assert.strictEqual(profile.zoneName('Europe/London'), 'Europe/London');
  assert.strictEqual(profile.zoneName('+05:00'), null);
  assert.strictEqual(profile.zoneName('Mars/Base'), null);
});
