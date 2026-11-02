'use strict';

process.env.TL_PGDATA = ':memory:';
process.env.TL_ENCRYPTION_KEY = 'f'.repeat(64);

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const db = require('../src/db');

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, () => resolve(server));
  });
}

function get(server, path) {
  return new Promise((resolve, reject) => {
    const r = http.request({ port: server.address().port, method: 'GET', path }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    r.on('error', reject);
    r.end();
  });
}

let server;
test.before(async () => {
  await db.init();
  const { app } = require('../server');
  server = await listen(app);
});
test.after(() => { server.close(); server.closeAllConnections(); });

test('plain healthz is ok and does no database work; deep=1 adds the db check', async () => {
  const plain = await get(server, '/healthz');
  assert.strictEqual(plain.status, 200);
  assert.strictEqual(plain.body.ok, true);
  assert.strictEqual(plain.body.encryption, true);
  // No db field at all — uptime pingers must not touch (and wake) Neon.
  assert.strictEqual(plain.body.db, undefined);

  const deep = await get(server, '/healthz?deep=1');
  assert.strictEqual(deep.status, 200);
  assert.strictEqual(deep.body.ok, true);
  assert.strictEqual(deep.body.db, true);
});
