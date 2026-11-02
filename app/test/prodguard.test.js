'use strict';

// A real deployment refuses to start in an unsafe state: no encryption key,
// no database (on Vercel), the seed script with its published passwords.
// Each check runs in a child process with production settings.

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const app = path.join(__dirname, '..');
function run(code, env) {
  const clean = { ...process.env };
  for (const k of ['TL_ENCRYPTION_KEY', 'DATABASE_URL', 'TL_PGDATA', 'VERCEL', 'NODE_ENV', 'TL_DEV', 'CRON_SECRET']) delete clean[k];
  return spawnSync(process.execPath, ['-e', code], { cwd: app, env: { ...clean, ...env }, encoding: 'utf8' });
}

test('production without TL_ENCRYPTION_KEY refuses to load the server', () => {
  const r = run("require('./server')", { NODE_ENV: 'production', TL_PGDATA: ':memory:' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /TL_ENCRYPTION_KEY/);
});

test('Vercel without DATABASE_URL refuses to make a database', () => {
  const r = run("require('./src/db').init().then(() => process.exit(0), (e) => { console.error(String(e)); process.exit(3); })",
    { VERCEL: '1', TL_ENCRYPTION_KEY: 'a'.repeat(64) });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /DATABASE_URL/);
});

test('production sends HSTS and the ops check needs CRON_SECRET', () => {
  const code = `
    const http = require('node:http');
    const db = require('./src/db');
    const auth = require('./src/auth');
    db.init().then(async () => {
      const { app } = require('./server');
      const s = http.createServer(app).listen(0, async () => {
        const base = 'http://localhost:' + s.address().port;
        const ops = await fetch(base + '/api/cron/ops-check');
        const hsts = ops.headers.get('strict-transport-security');
        console.log(JSON.stringify({ ops: ops.status, hsts }));
        s.close(); s.closeAllConnections(); process.exit(0);
      });
    });`;
  const r = run(code, { NODE_ENV: 'production', TL_PGDATA: ':memory:', TL_ENCRYPTION_KEY: 'b'.repeat(64) });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.strictEqual(out.ops, 401);
  assert.match(out.hsts, /max-age/);
});

test('seed.js will not run against DATABASE_URL without --force', () => {
  const r = spawnSync(process.execPath, ['seed.js'], {
    cwd: app, encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none' } });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /--force/);
});
