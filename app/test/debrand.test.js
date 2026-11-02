'use strict';

// De-branding guard rails. A scheduler-only deployment on the generic
// profile must not show TELL anywhere, and no TELL literal may creep back
// into the code outside profiles/ (comments aside).

process.env.TL_PROFILE = 'generic';
process.env.TL_MODULES = 'schedule';
process.env.TL_PGDATA = ':memory:';
process.env.TL_ENCRYPTION_KEY = '2'.repeat(64);

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const db = require('../src/db');
const profile = require('../src/profile');
const site = require('../src/site');

const ROOT = path.join(__dirname, '..');
const BRAND = /\bTELL\b|telljp|03-5774/;
// What a generic page must not carry: the name, the site, Tokyo, the phone,
// TELL teal and its deep shade, the paper plane.
// …and TELL's pilot/legacy vocabulary.
const LEAK = /\bTELL\b|telljp|Tokyo|03-5774|00a79d|008a81|0b3d3a|11, 61, 58|[Pp]aper.plane|\b[Tt]eal\b|iCarol|Chatboard|WEBEX|[Ss]ynthetic data|private trial|\(prototype\)/;

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

// Strip comments, then look for TELL literals. The one allowed literal is
// the name of the TELL-format workbook import, which is TELL's by design.
function codeLines(file) {
  const text = fs.readFileSync(file, 'utf8');
  const out = [];
  let inBlock = false;
  text.split('\n').forEach((line, i) => {
    let l = line;
    if (inBlock) {
      const end = l.indexOf('*/');
      if (end === -1) return;
      l = l.slice(end + 2); inBlock = false;
    }
    l = l.replace(/\/\*.*?\*\//g, '').replace(/<!--.*?-->/g, '');
    const open = l.search(/\/\*|<!--/);
    if (open !== -1) { l = l.slice(0, open); inBlock = true; }
    l = l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1');     // line comment (not a URL)
    if (/^\s*--/.test(l)) return;                      // SQL comment
    out.push([i + 1, l.replace(/TELL-format/g, '')]);
  });
  return out;
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}

test('no TELL literals in code outside profiles/ (comments aside)', () => {
  const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'site')),
    path.join(ROOT, 'server.js'), path.join(ROOT, 'seed.js')]
    .filter((f) => /\.(js|html|css)$/.test(f));
  const hits = [];
  for (const f of files) {
    for (const [n, l] of codeLines(f)) {
      if (BRAND.test(l)) hits.push(`${path.relative(ROOT, f)}:${n}: ${l.trim().slice(0, 100)}`);
    }
  }
  assert.deepStrictEqual(hits, [], 'move these into profiles/*.json');
});

test('every page rendered for the generic profile is free of TELL', () => {
  const files = site.render(profile.load('generic'));
  const hits = Object.entries(files)
    .map(([rel, body]) => [rel, String(body).match(LEAK)])
    .filter(([, m]) => m).map(([rel, m]) => `${rel}: ${m[0]}`);
  assert.deepStrictEqual(hits, []);
});

test('the scheduler pages a generic deployment serves are free of TELL', async () => {
  const pages = ['index', 'setup', 'passcode', 'profile', 'schedule', 'changes', 'admin',
    'ops', 'issues', 'help'];
  const assets = new Set(['shared.css', 'nav.js']);
  for (const page of pages) {
    const res = await fetch(`${base}/${page}.html`);
    assert.strictEqual(res.status, 200, page);
    const html = await res.text();
    assert.doesNotMatch(html, LEAK, `${page}.html`);
    for (const m of html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"/:]+\.(?:js|css))"/g)) assets.add(m[1]);
  }
  for (const a of assets) {
    const res = await fetch(`${base}/${a}`);
    assert.strictEqual(res.status, 200, a);
    assert.doesNotMatch(await res.text(), LEAK, a);
  }
  const admin = await (await fetch(`${base}/admin.js`)).text();
  assert.ok(admin.includes('<th hidden>Group</th>'), 'support-group column hidden');
  const index = await (await fetch(`${base}/`)).text();
  assert.match(index, /<title>Lifeline<\/title>/);
  const css = await (await fetch(`${base}/shared.css`)).text();
  assert.ok(css.includes(`--accent: ${profile.profile().colors.accent};`));
});

test('generic: branding, seeds, ICS and group naming come from the profile', async () => {
  const b = await (await fetch(`${base}/api/branding`)).json();
  assert.strictEqual(b.name, 'Lifeline');
  assert.strictEqual(b.phone, null);
  assert.strictEqual(b.helplineReady, false);
  assert.doesNotMatch(JSON.stringify(b), LEAK);

  const schedule = require('../src/schedule');
  await schedule.ensureShiftsSeeded();
  const defs = await db.all('SELECT number, label, kind FROM shift_def ORDER BY number');
  assert.deepStrictEqual(defs.map((d) => [d.number, d.label, d.kind]),
    [[1, 'Day', 'worker'], [2, 'Evening', 'worker'], [3, 'Night', 'worker']]);

  assert.strictEqual(schedule.groupTag(8), '');
  assert.deepStrictEqual(schedule.splitGroupPrefix('S08 Alex M'), { name: 'S08 Alex M', group: null });
  assert.strictEqual(schedule.parseGroup('8'), 8);

  const w = await db.insert(
    `INSERT INTO worker (email, name, password_hash, role, status, service_status, created_at)
     VALUES ('g@test.org', 'G', 'x', 'worker', 'off', 'in_service', ?)`, [db.now()]);
  const date = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  await db.insert(`INSERT INTO shift_slot (date, shift_number, role, worker_id, status, created_at)
    VALUES (?, 2, 'worker', ?, 'assigned', ?)`, [date, w, db.now()]);
  const ics = await schedule.icsFor(await schedule.calTokenFor(w));
  assert.ok(ics.includes('PRODID:-//Lifeline//shifts//EN'));
  assert.ok(ics.includes('SUMMARY:Lifeline Evening'));
  assert.doesNotMatch(ics, LEAK);

  const sec = require('../src/crypto');
  assert.match(sec.otpauthUrl('ABC', 'a@b.org'), /^otpauth:\/\/totp\/Lifeline:/);
});

test('generic: the TELL-format workbook import is off', async () => {
  const sheet = require('../src/sheetimport');
  assert.strictEqual(sheet.enabled(), false);
  await assert.rejects(sheet.importMonth('2026-11', { entries: [] }), /TELL-format workbook import is off/);
});

test('generic: a scheduler-only deployment is healthy without helpline numbers', async () => {
  const res = await fetch(`${base}/healthz`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).helpline, undefined);
});

test('generic colours pass WCAG AA for text', () => {
  const c = profile.profile().colors;
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const [fg, bg] of [['ink', 'bg'], ['ink', 'panel'], ['muted', 'bg'], ['muted', 'panel'],
    ['accentInk', 'accent'], ['accentInk', 'accentDark'], ['accent', 'panel'], ['deep', 'soft']]) {
    assert.ok(ratio(c[fg], c[bg]) >= 4.5, `${fg} on ${bg}: ${ratio(c[fg], c[bg]).toFixed(2)}`);
  }
});
