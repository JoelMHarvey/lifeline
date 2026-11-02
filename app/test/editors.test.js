'use strict';

// The organisation editor and shift editor (profile features orgEditor and
// shiftEditor): on for the generic profile, off — and invisible — for TELL.

process.env.TL_PROFILE = 'generic';
process.env.TL_MODULES = 'schedule';
process.env.TL_PGDATA = ':memory:';
process.env.TL_ENCRYPTION_KEY = '2'.repeat(64);

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const db = require('../src/db');
const auth = require('../src/auth');
const sec = require('../src/crypto');
const profile = require('../src/profile');
const schedule = require('../src/schedule');
const site = require('../src/site');

let server;
let base;
let coordCookie;
let supCookie;
let seq = 0;

async function makeWorker(role) {
  const id = await db.insert(
    `INSERT INTO worker (email, name, password_hash, role, status, service_status, created_at)
     VALUES (?,?,?,?,'off','in_service',?)`,
    [`ed-${seq++}@test.org`, `Ed ${role}`, sec.hashPassword('x'.repeat(12)), role, db.now()]);
  return 'session=' + await auth.createSession(id);
}

const call = async (method, path, body, cookie) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

test.before(async () => {
  await db.init();
  const { app } = require('../server');
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
  coordCookie = await makeWorker('coordinator');
  supCookie = await makeWorker('supervisor');
});
test.after(() => { server.close(); server.closeAllConnections(); });

test('organisation editor: coordinators override names; emails and pages follow', async () => {
  assert.strictEqual((await call('GET', '/api/admin/organisation', undefined, supCookie)).status, 403);
  const got = await call('GET', '/api/admin/organisation', undefined, coordCookie);
  assert.strictEqual(got.status, 200);
  assert.deepStrictEqual(got.body.fields.map((f) => f.key), profile.OVERRIDABLE);
  assert.strictEqual(got.body.fields.find((f) => f.key === 'name').profileValue, 'Lifeline');

  // Bad values are refused with the reason; numbers aren't editable at all.
  const bad = await call('PUT', '/api/admin/organisation', { key: 'name', value: 'A "quoted" name' }, coordCookie);
  assert.strictEqual(bad.status, 400);
  assert.match(bad.body.error, /may not contain quotes/);
  assert.strictEqual((await call('PUT', '/api/admin/organisation', { key: 'phone', value: '999' }, coordCookie)).status, 400);
  assert.strictEqual((await call('PUT', '/api/admin/organisation', { key: 'website', value: 'example.org' }, coordCookie)).status, 400);

  const ok = await call('PUT', '/api/admin/organisation', { key: 'name', value: 'Harbour Line' }, coordCookie);
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(profile.brand('name'), 'Harbour Line');
  assert.match(sec.otpauthUrl('A', 'b@c.org'), /issuer=Harbour%20Line/);
  // The server renders its own pages, so the title follows at once.
  const index = await (await fetch(base + '/index.html')).text();
  assert.match(index, /<title>Harbour Line<\/title>/);
  const audit = await db.get(`SELECT detail FROM audit_log WHERE action = 'org_override_set' ORDER BY id DESC LIMIT 1`);
  assert.strictEqual(audit.detail, 'name = Harbour Line');

  // Empty clears it back to the profile.
  assert.strictEqual((await call('PUT', '/api/admin/organisation', { key: 'name', value: '' }, coordCookie)).status, 200);
  assert.strictEqual(profile.brand('name'), 'Lifeline');
  assert.match(await (await fetch(base + '/index.html')).text(), /<title>Lifeline<\/title>/);
});

test('shift editor: rename, re-time and add shifts; past slots keep their hours', async () => {
  await schedule.ensureShiftsSeeded();
  const w = await db.insert(
    `INSERT INTO worker (email, name, password_hash, role, status, service_status, created_at)
     VALUES ('ed-w@test.org', 'W', 'x', 'worker', 'off', 'in_service', ?)`, [db.now()]);
  const past = await db.insert(`INSERT INTO shift_slot (date, shift_number, role, worker_id, status, created_at)
    VALUES ('2020-01-06', 1, 'worker', ?, 'confirmed', ?)`, [w, db.now()]);
  const future = await db.insert(`INSERT INTO shift_slot (date, shift_number, role, status, created_at)
    VALUES ('2099-01-06', 1, 'worker', 'open', ?)`, [db.now()]);

  assert.strictEqual((await call('PATCH', '/api/shift-defs/1', { label: 'Early' }, supCookie)).status, 403);
  assert.strictEqual((await call('PATCH', '/api/shift-defs/1', { start: '25:00' }, coordCookie)).status, 400);
  assert.strictEqual((await call('PATCH', '/api/shift-defs/1', { start: '16:00' }, coordCookie)).status, 400,
    'start equal to end is refused');
  const r = await call('PATCH', '/api/shift-defs/1',
    { label: 'Early', start: '07:00', end: '15:00', takeover: '07:15', mode: 'phone' }, coordCookie);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const def = (await schedule.shiftDefs()).find((d) => d.number === 1);
  assert.deepStrictEqual([def.label, def.start, def.end, def.takeover, def.modes.default],
    ['Early', '07:00', '15:00', '07:15', 'phone']);
  const p = await db.get('SELECT start_time, end_time FROM shift_slot WHERE id = ?', [past]);
  assert.deepStrictEqual([p.start_time, p.end_time], ['08:00', '16:00'], 'the past slot keeps the hours worked');
  const f = await db.get('SELECT start_time FROM shift_slot WHERE id = ?', [future]);
  assert.strictEqual(f.start_time, null, 'future slots follow the new hours');

  const added = await call('POST', '/api/shift-defs',
    { label: 'Twilight', start: '18:00', end: '22:00', takeover: '18:00', mode: 'chat' }, coordCookie);
  assert.strictEqual(added.status, 200);
  assert.strictEqual(added.body.number, 4);
  assert.ok((await schedule.shiftDefs()).some((d) => d.number === 4 && d.label === 'Twilight'));
  const log = (await schedule.scheduleAudit(10)).map((e) => e.what);
  assert.ok(log.includes('added a shift') && log.includes('changed shift settings'));

  // Seats still edit as before.
  assert.strictEqual((await call('PATCH', '/api/shift-defs/4', { seats: 2 }, coordCookie)).status, 200);
});

test('generic pages carry both editors', () => {
  const files = site.render(profile.load('generic'));
  assert.ok(files['admin.html'].includes('<script src="orgeditor.js"></script>'));
  assert.ok(files['admin.html'].includes('id="orgEditor"'));
  assert.ok(files['schedule.html'].includes('<script src="shifteditor.js"></script>'));
  assert.ok(files['schedule.js'].includes('drawShiftEditor()'));
});

test('TELL: both editors are off and absent from its pages', async () => {
  const tell = profile.load('tell');
  assert.deepStrictEqual(tell.features, { orgEditor: false, shiftEditor: false, setupWizard: false, voice: false });
  const files = site.render(tell);
  assert.ok(!files['admin.html'].includes('orgEditor'));
  assert.ok(!files['schedule.html'].includes('shiftEd'));
  assert.ok(!files['schedule.js'].includes('drawShiftEditor'));
  profile._set('tell');
  try {
    assert.strictEqual((await call('GET', '/api/admin/organisation', undefined, coordCookie)).status, 404);
    assert.strictEqual((await call('POST', '/api/shift-defs', { label: 'X', start: '01:00', end: '02:00', takeover: '01:00', mode: 'chat' }, coordCookie)).status, 404);
    assert.strictEqual((await call('PATCH', '/api/shift-defs/1', { label: 'X' }, coordCookie)).status, 404);
  } finally {
    profile._set('generic');
  }
});

// --- Review fixes -----------------------------------------------------------

test('shift names: one line only, and escaped in the calendar feed', async () => {
  const bad = await call('PATCH', '/api/shift-defs/2', { label: 'Day\r\nDESCRIPTION:pwned' }, coordCookie);
  assert.strictEqual(bad.status, 400);
  assert.match(bad.body.error, /single line/);
  assert.strictEqual((await call('PATCH', '/api/shift-defs/2', { label: 'Late, long; ok\\' }, coordCookie)).status, 200);
  await call('PUT', '/api/admin/organisation',
    { key: 'shortName', value: 'A rather long organisation short name, with a comma; and more words here' }, coordCookie);
  const w = await db.insert(
    `INSERT INTO worker (email, name, password_hash, role, status, service_status, created_at)
     VALUES ('ics2@test.org', 'I', 'x', 'worker', 'off', 'in_service', ?)`, [db.now()]);
  await db.insert(`INSERT INTO shift_slot (date, shift_number, role, worker_id, status, created_at)
    VALUES ('2099-02-01', 2, 'worker', ?, 'assigned', ?)`, [w, db.now()]);
  const ics = await schedule.icsFor(await schedule.calTokenFor(w));
  await call('PUT', '/api/admin/organisation', { key: 'shortName', value: '' }, coordCookie);
  const unfolded = ics.replace(/\r\n /g, '');
  assert.ok(unfolded.includes('SUMMARY:A rather long organisation short name\\, with a comma\\; and more words here Late\\, long\\; ok\\\\'), unfolded);
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, `line too long: ${line}`);
  assert.ok(!/^DESCRIPTION/m.test(ics));
});

test('changing hours stamps every slot that has started, including today, without marking it changed', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const def = (await schedule.shiftDefs()).find((d) => d.number === 3); // Night 00:00-08:00
  const started = await db.insert(`INSERT INTO shift_slot (date, shift_number, role, status, created_at)
    VALUES (?, 3, 'worker', 'open', ?)`, [today, db.now()]);
  const later = await db.insert(`INSERT INTO shift_slot (date, shift_number, role, status, created_at)
    VALUES ('2099-03-01', 3, 'worker', 'open', ?)`, [db.now()]);
  assert.strictEqual((await call('PATCH', '/api/shift-defs/3', { start: '23:00', end: '07:00' }, coordCookie)).status, 200);
  const s = await db.get('SELECT start_time, end_time, times_stamped FROM shift_slot WHERE id = ?', [started]);
  assert.deepStrictEqual([s.start_time, s.end_time, Number(s.times_stamped)], [def.start, def.end, 1]);
  assert.strictEqual((await db.get('SELECT start_time FROM shift_slot WHERE id = ?', [later])).start_time, null);
  const month = (await schedule.monthSlots(today.slice(0, 7))).find((x) => x.id === Number(started));
  assert.strictEqual(month.customTimes, false, 'stamped hours are not shown as a one-off change');
});

test('a shift added by mistake can be removed while it has no slots', async () => {
  const added = await call('POST', '/api/shift-defs',
    { label: 'Oops', start: '10:00', end: '11:00', takeover: '10:00', mode: 'both' }, coordCookie);
  assert.strictEqual(added.status, 200);
  const n = added.body.number;
  assert.strictEqual((await call('DELETE', '/api/shift-defs/' + n, undefined, supCookie)).status, 403);
  assert.strictEqual((await call('DELETE', '/api/shift-defs/' + n, undefined, coordCookie)).status, 200);
  assert.ok(!(await schedule.shiftDefs()).some((d) => d.number === n));
  // One with slots can't be removed.
  const used = await call('DELETE', '/api/shift-defs/2', undefined, coordCookie);
  assert.strictEqual(used.status, 400);
  assert.match(used.body.error, /already has slots/);
  // A new shift never reuses a retired number.
  const next = await call('POST', '/api/shift-defs',
    { label: 'Next', start: '10:00', end: '11:00', takeover: '10:00', mode: 'both' }, coordCookie);
  assert.strictEqual(next.body.number, n + 1);
});

test('a saved override that fails the checks is reported as not in effect', async () => {
  await db.run(`INSERT INTO config (key, value) VALUES ('brand.website', 'not a url')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  await profile.loadOverrides((sql) => db.all(sql));
  const got = await call('GET', '/api/admin/organisation', undefined, coordCookie);
  const site = got.body.fields.find((f) => f.key === 'website');
  assert.strictEqual(site.override, 'not a url');
  assert.strictEqual(site.ignored, true);
  assert.strictEqual(profile.brand('website'), null);
  await db.run(`DELETE FROM config WHERE key = 'brand.website'`);
});
