'use strict';

process.env.TL_PGDATA = ':memory:';
process.env.TL_ENCRYPTION_KEY = '4'.repeat(64);

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const db = require('../src/db');
const sec = require('../src/crypto');
const auth = require('../src/auth');
const { parseCsv, mapHeader } = require('../src/csv');

let emailSeq = 0;
async function makeWorker(role = 'worker') {
  const id = await db.insert(
    `INSERT INTO worker (email, name, password_hash, role, status, service_status, created_at)
     VALUES (?,?,?,?,'off','in_service',?)`,
    [`ci-${emailSeq++}@test.org`, `CI ${role} ${emailSeq}`,
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

test('CSV reader: quotes, commas, doubled quotes, line breaks, BOM, semicolons, CRLF', () => {
  const rows = parseCsv('﻿Name,Description\r\n' +
    '"Hello, World","He said ""hi""\nand left"\r\n' +
    '\r\n' +
    'Plain,  spaced  \n');
  assert.deepStrictEqual(rows, [
    ['Name', 'Description'],
    ['Hello, World', 'He said "hi"\nand left'],
    ['Plain', 'spaced'],
  ]);
  assert.deepStrictEqual(parseCsv('a;b\n"x;y";2'), [['a', 'b'], ['x;y', '2']]);
  assert.deepStrictEqual(parseCsv('a\tb\nx\ty'), [['a', 'b'], ['x', 'y']]);
  const { map, unknown } = mapHeader(['Agency Name', 'Telephone', 'Web site', 'Fax'],
    { name: ['agency name'], phone: ['telephone'], url: ['web site'] });
  assert.deepStrictEqual(map, { name: 0, phone: 1, url: 2 });
  assert.deepStrictEqual(unknown, ['Fax']);
});

test('resource import: preview writes nothing; apply adds, skips, updates, rejects bad links', async () => {
  const coord = await makeWorker('coordinator');
  const worker = await makeWorker('worker');
  const coordCookie = 'session=' + await auth.createSession(coord.id);
  const workerCookie = 'session=' + await auth.createSession(worker.id);
  await db.insert(
    `INSERT INTO resource (name, category, phone, status, created_at)
     VALUES ('TELL Counselling', 'Counseling & Support', '03-1111-1111', 'active', ?)`, [db.now()]);

  const csv = 'Agency Name,Category,Description,Website,Telephone,Languages,Fax\n' +
    '"Tokyo Help Line","Crisis lines","Free, anonymous, 24h",tokyohelp.example,03-2222-2222,"English, Japanese",x\n' +
    'TELL counselling,Counseling & Support,,,03-9999-9999,,\n' +
    'Tokyo Help Line,Crisis lines,duplicate row,,,,\n' +
    'Bad Link Clinic,Health,,javascript:alert(1),,,\n' +
    ',Health,no name,,,,\n';

  assert.strictEqual((await call('POST', '/api/resources/import', { csv }, workerCookie)).status, 403);

  const before = (await db.get('SELECT COUNT(*) AS n FROM resource')).n;
  const preview = await call('POST', '/api/resources/import', { csv }, coordCookie);
  assert.strictEqual(preview.status, 200);
  assert.strictEqual(preview.body.applied, false);
  assert.deepStrictEqual(preview.body.counts, { add: 1, update: 0, skip: 2, error: 2 });
  assert.deepStrictEqual(preview.body.columns, { name: 'Agency Name', category: 'Category',
    description: 'Description', url: 'Website', phone: 'Telephone', languages: 'Languages' });
  assert.deepStrictEqual(preview.body.unknownColumns, ['Fax']);
  const reasons = preview.body.rows.map((r) => `${r.line}:${r.action}:${r.reason}`);
  assert.deepStrictEqual(reasons, [
    '2:add:', '3:skip:already in the directory', '4:skip:appears earlier in the file',
    '5:error:"javascript:alert(1)" isn\'t a web address', '6:error:no name']);
  assert.strictEqual((await db.get('SELECT COUNT(*) AS n FROM resource')).n, before, 'preview wrote nothing');

  // Apply, updating the existing one from its new phone number.
  const applied = await call('POST', '/api/resources/import',
    { csv, apply: true, updateExisting: true }, coordCookie);
  assert.deepStrictEqual(applied.body.counts, { add: 1, update: 1, skip: 1, error: 2 });
  const added = await db.get(`SELECT * FROM resource WHERE name = 'Tokyo Help Line'`);
  assert.strictEqual(added.status, 'active');
  assert.strictEqual(added.description, 'Free, anonymous, 24h');
  assert.strictEqual(added.url, 'https://tokyohelp.example/');
  assert.strictEqual(added.languages, 'English, Japanese');
  const updated = await db.get(`SELECT * FROM resource WHERE name = 'TELL Counselling'`);
  assert.strictEqual(updated.phone, '03-9999-9999');
  assert.strictEqual(updated.category, 'Counseling & Support', 'empty CSV cells never blank a field');

  // It's listed in the directory, and the import is in the audit log.
  const list = (await call('GET', '/api/resources?q=tokyo', null, workerCookie)).body;
  assert.ok(list.some((r) => r.name === 'Tokyo Help Line'));
  const audit = await db.get(`SELECT detail FROM audit_log WHERE action = 'resources_imported'`);
  assert.strictEqual(audit.detail, '1 added, 1 updated, 1 skipped, 2 with errors');

  // A file without a name column is refused with a clear message.
  const noName = await call('POST', '/api/resources/import', { csv: 'Phone\n123\n' }, coordCookie);
  assert.strictEqual(noName.status, 400);
  assert.match(noName.body.error, /No name column/);
});

test('large directory files get through (route-specific body limit)', async () => {
  const coord = await makeWorker('coordinator');
  const cookie = 'session=' + await auth.createSession(coord.id);
  const desc = 'x'.repeat(900);
  let csv = 'Name,Description\n';
  for (let i = 0; i < 1500; i++) csv += `Resource ${i},"${desc}"\n`;
  assert.ok(csv.length > 1024 * 1024, 'over 1 MB');
  const r = await call('POST', '/api/resources/import', { csv }, cookie);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.counts.add, 1500);
});

test('people import reads quoted fields (names with commas) properly', async () => {
  const coord = await makeWorker('coordinator');
  const cookie = 'session=' + await auth.createSession(coord.id);
  const r = await call('POST', '/api/admin/import', {
    csv: 'email,name,role\n"quoted@test.org","Harvey, Joel",supervisor\nplain@test.org,Plain Name,\n',
  }, cookie);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.created.map((c) => c.name), ['Harvey, Joel', 'Plain Name']);
  const w = await db.get(`SELECT role FROM worker WHERE email = 'quoted@test.org'`);
  assert.strictEqual(w.role, 'supervisor');
});
