'use strict';

// The safety valve must not close a chat a worker accepted at the same
// moment: the sweep reads the waiting list, a worker claims one of those
// contacts, then the sweep reaches it. The claim wins.

process.env.TL_PGDATA = ':memory:';
process.env.TL_ENCRYPTION_KEY = '2'.repeat(64);

const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const sec = require('../src/crypto');
const queue = require('../src/queue');

test.before(() => db.init());

test('a chat claimed between the waiting read and the valve stays claimed', async () => {
  const wid = await db.insert(
    `INSERT INTO worker (email, name, password_hash, role, status, service_status, created_at)
     VALUES ('race@test.org', 'Race', ?, 'worker', 'on_shift', 'in_service', ?)`,
    [sec.hashPassword('x'.repeat(12)), db.now()]);
  await db.run('INSERT INTO worker_program (worker_id, program_id) VALUES (?,?)', [wid, await db.chatProgramId()]);
  const worker = await db.get('SELECT * FROM worker WHERE id = ?', [wid]);
  const { contactId } = await queue.joinQueue({ alias: 'R' });
  // Waited past the safety valve (600s by default).
  await db.run('UPDATE contact SET queued_at = ? WHERE id = ?',
    [new Date(Date.now() - 700_000).toISOString(), contactId]);

  // The sweep's waiting read happens first; the claim lands right after it.
  const realAll = db.all;
  let raced = false;
  db.all = async (sql, params) => {
    const rows = await realAll(sql, params);
    if (!raced && /WHERE worker_id IS NULL AND outcome IS NULL/.test(sql)) {
      raced = true;
      assert.ok(await queue.claim(contactId, worker), 'the worker accepts it');
    }
    return rows;
  };
  let result;
  try { result = await queue.sweep(); } finally { db.all = realAll; }

  assert.ok(raced, 'the race was exercised');
  assert.ok(!result.toClose.some((c) => Number(c.id) === contactId), 'not closed by the valve');
  const c = await db.get('SELECT worker_id, outcome, ended_at FROM contact WHERE id = ?', [contactId]);
  assert.strictEqual(Number(c.worker_id), wid);
  assert.strictEqual(c.outcome, null);
  assert.strictEqual(c.ended_at, null);
});

test('an unclaimed chat past the valve is still closed', async () => {
  const { contactId } = await queue.joinQueue({ alias: 'S' });
  await db.run('UPDATE contact SET queued_at = ? WHERE id = ?',
    [new Date(Date.now() - 700_000).toISOString(), contactId]);
  const result = await queue.sweep();
  assert.ok(result.toClose.some((c) => Number(c.id) === contactId));
  assert.strictEqual((await db.get('SELECT outcome FROM contact WHERE id = ?', [contactId])).outcome, 'timed_out');
});
