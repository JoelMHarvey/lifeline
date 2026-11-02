'use strict';

// The organisation profile (src/profile.js) with no TL_PROFILE set: TELL.
// Everything TELL sees must be exactly what it saw before profiles existed —
// pages, seeds, the safety-valve message, email subjects, the ICS feed.

process.env.TL_PROFILE = 'tell';
process.env.TL_PGDATA = ':memory:';
process.env.TL_ENCRYPTION_KEY = '2'.repeat(64);

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');

const db = require('../src/db');
const profile = require('../src/profile');
const site = require('../src/site');

const ROOT = path.join(__dirname, '..');
const sha = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');

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

test('TL_PROFILE=tell is TELL; no TL_PROFILE is the neutral profile', () => {
  assert.strictEqual(profile.profile().id, 'tell');
  assert.strictEqual(profile.brand('name'), 'TELL Lifeline');
  const env = { ...process.env };
  delete env.TL_PROFILE;
  const r = spawnSync(process.execPath, ['-e', "process.stdout.write(require('./src/profile').profile().id)"],
    { cwd: ROOT, encoding: 'utf8', env });
  assert.strictEqual(r.stdout, 'generic');
});

test('an unknown TL_PROFILE stops the server at boot with a clear error', () => {
  const r = spawnSync(process.execPath, ['-e', "require('./server')"], {
    cwd: ROOT, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, TL_PROFILE: 'no-such-org', TL_PGDATA: ':memory:' },
  });
  assert.notStrictEqual(r.status, 0, 'boot must fail');
  assert.match(r.stderr, /TL_PROFILE "no-such-org": no profiles\/no-such-org\.json \(known: .*generic.*tell/);
});

test('a broken profile is refused with the reason', () => {
  const bad = JSON.parse(JSON.stringify(profile.load('tell')));
  const tmp = path.join(ROOT, 'profiles', 'zz-broken-test.json');
  try {
    fs.writeFileSync(tmp, JSON.stringify({ ...bad, id: 'zz-broken-test', name: "TELL's <b>" }));
    assert.throws(() => profile.load('zz-broken-test'), /"name" may not contain quotes/);
    const noPhone = { ...bad, id: 'zz-broken-test' };
    delete noPhone.phone;
    fs.writeFileSync(tmp, JSON.stringify(noPhone));
    assert.throws(() => profile.load('zz-broken-test'), /missing required key "phone"/);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  assert.throws(() => profile.load('../etc/passwd'), /not a valid profile name/);
});

test('profiles are frozen', () => {
  assert.throws(() => { 'use strict'; profile.profile().phone = 'x'; }, TypeError);
  assert.throws(() => { 'use strict'; profile.profile().schedule.shifts.push([]); }, TypeError);
});

test('template syntax: tokens, sections, inverted sections, errors', () => {
  const p = { id: 't', a: 'A', n: null, o: { b: 'B' } };
  assert.strictEqual(profile.render('x{{a}}{{o.b}}', p), 'xAB');
  assert.strictEqual(profile.render('{{#a}}yes{{/a}}{{^a}}no{{/a}}', p), 'yes');
  assert.strictEqual(profile.render('{{#n}}yes{{/n}}{{^n}}no{{/n}}', p), 'no');
  assert.strictEqual(profile.render('{{#a}}[{{#o.b}}{{o.b}}{{/o.b}}]{{/a}}', p), '[B]');
  assert.throws(() => profile.render('{{n}}', p), /\{\{n\}\} has no value/);
  assert.throws(() => profile.render('{{#a}}open', p), /unrendered/);
});

// ---------------------------------------------------------------------------
// Pages

// TELL's pages are pinned: site/ rendered for TELL must match these hashes
// byte for byte. A deliberate change to TELL's pages updates the fixture:
//   node tools/render-site.js --update-tell-fixture
test('TELL\'s pages are byte-for-byte what they were (test/fixtures/tell-pages.json)', () => {
  const files = site.render(profile.load('tell'));
  const want = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tell-pages.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(files).sort(), Object.keys(want).sort(), 'same file list');
  for (const [rel, body] of Object.entries(files)) {
    const hash = crypto.createHash('sha256').update(Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')).digest('hex');
    assert.strictEqual(hash, want[rel], `${rel} changed for TELL`);
  }
});

test('TELL pages keep their titles, logo, colours and numbers', async () => {
  const caller = await (await fetch(base + '/caller.html')).text();
  assert.ok(caller.includes('<title>TELL Lifeline Chat (prototype)</title>'));
  assert.ok(caller.includes('href="https://telljp.com" target="_blank" rel="noopener"'));
  assert.ok(caller.includes('title="TELL — Tokyo English Lifeline">TELL</a>'));
  assert.ok(caller.includes('Call <strong>119</strong> (ambulance/fire) or\n    <strong>110</strong> (police). TELL Lifeline phone: <strong>03-5774-0992</strong>.'));
  assert.ok(caller.includes('<div class="panel" id="startCard">'), 'start card shown');
  assert.ok(!caller.includes('notReady'));
  const callerJs = await (await fetch(base + '/caller.js')).text();
  assert.ok(callerJs.includes('Please try again, or call us on 03-5774-0992.'));
  const css = await (await fetch(base + '/shared.css')).text();
  assert.ok(css.includes('--accent: #00a79d;'));
  assert.ok(css.includes("fill='%2300a79d' d='M22 2 2 10.5l6.5 2.2L21 4 10.8 14l.2 6 3.4-4.1 5.1 1.7z'"));
  const nav = await (await fetch(base + '/nav.js')).text();
  assert.ok(nav.includes("link('console.html', 'TELL Lifeline')"));
});

test('/api/branding gives the public look and numbers', async () => {
  const b = await (await fetch(base + '/api/branding')).json();
  assert.strictEqual(b.name, 'TELL Lifeline');
  assert.strictEqual(b.shortName, 'TELL');
  assert.strictEqual(b.phone, '03-5774-0992');
  assert.strictEqual(b.emergency.primary.number, '119');
  assert.strictEqual(b.colors.accent, '#00a79d');
  assert.ok(b.logo.startsWith('<svg'));
  assert.strictEqual(b.helplineReady, true);
});

// ---------------------------------------------------------------------------
// Seeds and server text (hashes taken from the code before profiles)

test('TELL seeds are unchanged', () => {
  const schedule = require('../src/schedule');
  const forms = require('../src/forms');
  const canned = require('../src/canned');
  assert.strictEqual(sha(schedule.DEFAULT_SHIFTS), '394be2d71193f5da25d1a03be8341d3f8f695593c0528a5e63a672199c5063e7');
  assert.strictEqual(sha(schedule.DEFAULT_SUPERVISION), 'c5308f7aa9bf3bb66f3c8ed31b835ec5ea8a741d008dcb87bafc3da0ca6d9ff6');
  assert.strictEqual(sha(schedule.DEFAULT_WEEK_SEATS), '8ead935b3b88b07d6304e5865507f947fd9f61d8ecf1260432a462b17afb89cd');
  assert.strictEqual(sha(forms.DEFAULT_CHAT_INTAKE), 'e4e9765b2d4377f5201d0966220646059fa639d109230a556900f283444ea97f');
  assert.strictEqual(sha(forms.DEFAULT_PRE_CHAT), '09c52efccf1f2b7f68686da6a9d89410fdff0fd728949df2b83d972408fcfcd8');
  assert.strictEqual(sha(canned.STARTER), '40f132471c50c52c65218aa7541fee829ead606cf1dda8cc61f7793bae433be9');
  assert.strictEqual(db.CONFIG_DEFAULTS.safety_valve_message,
    'We are very sorry — all of our support workers are helping other people right now. ' +
    'Please try again in a little while. If you are in immediate danger, call 119 (ambulance/fire) or 110 (police). ' +
    'TELL Lifeline phone: 03-5774-0992.');
  assert.deepStrictEqual(profile.profile().seed.resources.map((r) => r[0]),
    ['TELL Counseling', 'Tokyo Mental Health', 'Yorisoi Hotline', 'Inochi no Denwa', 'Himawari Medical Info']);
});

test('a saved safety-valve message still wins over the profile', async () => {
  await db.run(`INSERT INTO config (key, value) VALUES ('safety_valve_message', 'Our own words.')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  assert.strictEqual(await db.getConfig('safety_valve_message'), 'Our own words.');
  await db.run(`DELETE FROM config WHERE key = 'safety_valve_message'`);
  assert.match(await db.getConfig('safety_valve_message'), /TELL Lifeline phone: 03-5774-0992\.$/);
});

test('TELL labels: TOTP issuer, ICS, group tags, mail From', async () => {
  const sec = require('../src/crypto');
  assert.strictEqual(sec.otpauthUrl('ABC', 'a@b.org'),
    'otpauth://totp/TELL%20Lifeline:a%40b.org?secret=ABC&issuer=TELL%20Lifeline');
  // The issuer is a label: the code an existing enrolment produces is the same.
  assert.strictEqual(sec.totpCode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59 * 1000), '287082');

  const schedule = require('../src/schedule');
  assert.strictEqual(schedule.groupTag(8), 'S08');
  assert.deepStrictEqual(schedule.splitGroupPrefix('S08 Alex M'), { name: 'Alex M', group: 8 });
  assert.strictEqual(schedule.parseGroup('s8'), 8);

  const w = await db.insert(
    `INSERT INTO worker (email, name, password_hash, role, status, service_status, created_at)
     VALUES ('ics@test.org', 'Ics', 'x', 'worker', 'off', 'in_service', ?)`, [db.now()]);
  await schedule.ensureShiftsSeeded();
  const date = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  const slot = await db.insert(
    `INSERT INTO shift_slot (date, shift_number, role, worker_id, status, created_at)
     VALUES (?, 2, 'worker', ?, 'assigned', ?)`, [date, w, db.now()]);
  const ics = await schedule.icsFor(await schedule.calTokenFor(w));
  assert.ok(ics.includes('PRODID:-//TELL Lifeline//shifts//EN'));
  assert.ok(ics.includes(`UID:tell-slot-${slot}@tell-lifeline`));
  assert.ok(ics.includes('SUMMARY:TELL Shift 2'));

  const mail = require('../src/mail');
  const before = process.env.TL_MAIL_FROM;
  process.env.TL_MAIL_FROM = 'lifeline@tell.example';
  try {
    assert.strictEqual(mail.fromAddress(), 'lifeline@tell.example', 'no name added for TELL');
  } finally {
    if (before === undefined) delete process.env.TL_MAIL_FROM; else process.env.TL_MAIL_FROM = before;
  }
});

test('TELL ignores stray override rows (no organisation editor or wizard)', async () => {
  await db.run(`INSERT INTO config (key, value) VALUES ('brand.name', 'TELL Test'), ('org.phone', '000')`);
  await profile.loadOverrides((sql) => db.all(sql));
  try {
    assert.strictEqual(profile.brand('name'), 'TELL Lifeline');
    assert.strictEqual(profile.brand('phone'), '03-5774-0992');
  } finally {
    await db.run(`DELETE FROM config WHERE key IN ('brand.name', 'org.phone')`);
    await profile.loadOverrides((sql) => db.all(sql));
  }
  assert.strictEqual(profile.brand('name'), 'TELL Lifeline');
  assert.throws(() => profile.brand('nope'), /no such profile key/);
});

test('an existing database keeps its forms and shifts when the profile changes', async () => {
  const forms = require('../src/forms');
  const schedule = require('../src/schedule');
  await forms.ensureSeeded();
  await schedule.ensureShiftsSeeded();
  // A coordinator's own edit on top of the seed.
  const pre = await forms.currentForm('pre_chat');
  const edited = JSON.parse(JSON.stringify(pre.schema));
  forms.fieldsOf(edited).find((f) => f.id === 'nationality').options[0].label = 'Japan (edited)';
  await forms.saveNewVersion('pre_chat', edited, null);
  const snap = async () => ({
    forms: await db.all('SELECT name, version, schema_json FROM form_def ORDER BY name, version'),
    shifts: await db.all('SELECT * FROM shift_def ORDER BY number'),
  });
  const before = await snap();
  profile._set('generic');
  try {
    await forms.ensureSeeded();
    // Run the shift seeding again as a fresh process would (it is cached once
    // per process), including the once-only weekday seat pass.
    await db.run(`DELETE FROM config WHERE key = 'seed:week_seats_v1'`);
    delete require.cache[require.resolve('../src/schedule')];
    await require('../src/schedule').ensureShiftsSeeded();
  } finally {
    profile._set('tell');
  }
  const after = await snap();
  assert.deepStrictEqual(after.forms, before.forms, 'stored form versions untouched');
  assert.deepStrictEqual(after.shifts, before.shifts, 'stored shift definitions untouched');
  assert.ok(after.forms.some((f) => f.schema_json.includes('Japan (edited)')));
  assert.ok(after.forms.every((f) => !f.schema_json.includes('"region"')), 'no generic seed slipped in');
});
