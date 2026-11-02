'use strict';

process.env.TL_PGDATA = ':memory:';
process.env.TL_ENCRYPTION_KEY = 'b'.repeat(64);

const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const sec = require('../src/crypto');
const queue = require('../src/queue');
const forms = require('../src/forms');

let emailSeq = 0;
async function makeWorker(role = 'worker') {
  const id = await db.insert(
    `INSERT INTO worker (email, name, password_hash, role, status, service_status, created_at)
     VALUES (?,?,?,?,'on_shift','in_service',?)`,
    [`p2-${emailSeq++}@test.org`, `P2 Worker ${emailSeq}`,
      sec.hashPassword('x'.repeat(12)), role, db.now()]);
  await db.run('INSERT INTO worker_program (worker_id, program_id) VALUES (?,?) ON CONFLICT DO NOTHING',
    [id, await db.chatProgramId()]);
  return db.get('SELECT * FROM worker WHERE id = ?', [id]);
}

async function makeContact(worker) {
  const { contactId } = await queue.joinQueue({ alias: 'P2', triage: { concern: 'Anxiety or stress' } });
  if (worker) await queue.claim(contactId, worker);
  return db.get('SELECT * FROM contact WHERE id = ?', [contactId]);
}

// ---------------------------------------------------------------------------
// Form definitions

test('default chat_intake form seeds itself and is valid', async () => {
  const form = await forms.currentForm('chat_intake');
  assert.strictEqual(form.version, 1);
  assert.strictEqual(forms.validateSchema(form.schema, null), null);
  const ids = forms.fieldsOf(form.schema).map((f) => f.id);
  for (const required of ['ideation', 'intention', 'plan', 'means',
    'supervisor_followup', 'highlight', 'main_concerns']) {
    assert.ok(ids.includes(required), `default form must include ${required}`);
  }
});

test('saving a new version bumps the version; old version stays readable', async () => {
  const cur = await forms.currentForm('chat_intake');
  const schema = JSON.parse(JSON.stringify(cur.schema));
  const age = forms.fieldsOf(schema).find((f) => f.id === 'age');
  age.options.push({ id: '100+', label: '100+' });
  const r = await forms.saveNewVersion('chat_intake', schema, null);
  assert.strictEqual(r.version, cur.version + 1);
  const v1 = await forms.formVersion('chat_intake', 1);
  assert.ok(!forms.fieldsOf(v1.schema).find((f) => f.id === 'age')
    .options.some((o) => o.id === '100+'), 'old version unchanged');
  const now = await forms.currentForm('chat_intake');
  assert.strictEqual(now.version, r.version);
});

test('removing an option is rejected; retiring it is accepted', async () => {
  const cur = await forms.currentForm('chat_intake');
  const removed = JSON.parse(JSON.stringify(cur.schema));
  const age = forms.fieldsOf(removed).find((f) => f.id === 'age');
  age.options = age.options.filter((o) => o.id !== '0-12');
  const bad = await forms.saveNewVersion('chat_intake', removed, null);
  assert.match(bad.error, /retire/, 'deletion must be rejected with the retire hint');

  const retired = JSON.parse(JSON.stringify(cur.schema));
  forms.fieldsOf(retired).find((f) => f.id === 'age')
    .options.find((o) => o.id === '0-12').retired = true;
  const ok = await forms.saveNewVersion('chat_intake', retired, null);
  assert.ok(ok.version > cur.version);
});

test('removing a field is rejected; renaming an option label is fine', async () => {
  const cur = await forms.currentForm('chat_intake');
  const noField = JSON.parse(JSON.stringify(cur.schema));
  for (const s of noField.sections) s.fields = s.fields.filter((f) => f.id !== 'reflection');
  const bad = await forms.saveNewVersion('chat_intake', noField, null);
  assert.match(bad.error, /reflection/);

  const renamed = JSON.parse(JSON.stringify(cur.schema));
  forms.fieldsOf(renamed).find((f) => f.id === 'nationality')
    .options.find((o) => o.id === 'n_america').label = 'North America';
  const ok = await forms.saveNewVersion('chat_intake', renamed, null);
  assert.ok(ok.version > cur.version);
});

test('duplicate field and option ids are rejected', async () => {
  assert.match(forms.validateSchema({
    sections: [{ id: 's', fields: [
      { id: 'a', type: 'text' }, { id: 'a', type: 'text' }] }],
  }, null), /duplicate field/);
  assert.match(forms.validateSchema({
    sections: [{ id: 's', fields: [
      { id: 'a', type: 'select', options: [{ id: 'x', label: 'X' }, { id: 'x', label: 'Y' }] }] }],
  }, null), /duplicate option/);
});

// ---------------------------------------------------------------------------
// Pre-chat survey

test('pre_chat form seeds; public endpoint strips retired options', async () => {
  const form = await forms.currentForm('pre_chat');
  assert.ok(form.version >= 1);
  const ids = forms.fieldsOf(form.schema).map((f) => f.id);
  for (const required of ['prefecture', 'main_concern', 'suicidal_thoughts',
    'self_harm', 'upset_scale', 'age', 'gender_identity', 'transgender', 'nationality']) {
    assert.ok(ids.includes(required), `pre_chat must include ${required}`);
  }

  // Retire an option, then check the public copy hides it while the
  // authenticated copy keeps it (for rendering old records).
  const schema = JSON.parse(JSON.stringify(form.schema));
  forms.fieldsOf(schema).find((f) => f.id === 'nationality')
    .options.find((o) => o.id === 'other').retired = true;
  const saved = await forms.saveNewVersion('pre_chat', schema, null);
  assert.ok(saved.version > form.version);

  const { app } = require('../server');
  const http = require('node:http');
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const pub = await (await fetch(`http://localhost:${port}/api/prechat/form`)).json();
  const pubNat = forms.fieldsOf(pub.schema).find((f) => f.id === 'nationality');
  assert.ok(!pubNat.options.some((o) => o.id === 'other'), 'retired option hidden from callers');
  server.close();
});

test('new-shape triage boosts priority on suicide/self-harm signals', async () => {
  const calm = await queue.joinQueue({
    triage: { form: 'pre_chat', version: 1,
      answers: { suicidal_thoughts: 'no', self_harm: 'none', upset_scale: '5' } },
  });
  const risk = await queue.joinQueue({
    triage: { form: 'pre_chat', version: 1,
      answers: { suicidal_thoughts: 'yes', self_harm: 'none' } },
  });
  const harm = await queue.joinQueue({
    triage: { form: 'pre_chat', version: 1,
      answers: { suicidal_thoughts: 'no_answer', self_harm: 'recent' } },
  });
  const rows = await queue.waiting();
  const pri = (id) => Number(rows.find((r) => Number(r.id) === id).priority);
  assert.strictEqual(pri(calm.contactId), 0, 'being very upset alone does not jump the queue');
  assert.strictEqual(pri(risk.contactId), 1);
  assert.strictEqual(pri(harm.contactId), 1);
  for (const c of [calm, risk, harm]) await queue.endContact(c.contactId, 'abandoned');
});

// ---------------------------------------------------------------------------
// Directives

test('directives are encrypted at rest and retire in place', async () => {
  const sup = await makeWorker('supervisor');
  const c = await makeContact(null);
  const id = await db.insert(
    'INSERT INTO directive (caller_id, alert_level, body, created_by, created_at) VALUES (?,?,?,?,?)',
    [c.caller_id, 'alert', sec.encrypt('Do not give the caller a third chat today'),
      sup.id, db.now()]);
  const raw = await db.get('SELECT body FROM directive WHERE id = ?', [id]);
  assert.ok(raw.body.startsWith('g1$'));
  assert.ok(!raw.body.includes('third chat'));

  const active = await db.all(
    'SELECT * FROM directive WHERE caller_id = ? AND retired_at IS NULL', [c.caller_id]);
  assert.strictEqual(active.length, 1);
  await db.run('UPDATE directive SET retired_at = ?, retired_by = ? WHERE id = ?',
    [db.now(), sup.id, id]);
  const after = await db.all(
    'SELECT * FROM directive WHERE caller_id = ? AND retired_at IS NULL', [c.caller_id]);
  assert.strictEqual(after.length, 0);
  const kept = await db.get('SELECT * FROM directive WHERE id = ?', [id]);
  assert.ok(kept, 'retired directive stays in the record');
  await queue.endContact(c.id, 'completed');
});

test('active-directives review list shows live directives, hides retired', async () => {
  const { app } = require('../server');
  const http = require('node:http');
  const auth = require('../src/auth');

  const sup = await makeWorker('supervisor');
  const w = await makeWorker();
  const c = await makeContact(null);
  const live = await db.insert(
    'INSERT INTO directive (caller_id, alert_level, body, created_by, created_at) VALUES (?,?,?,?,?)',
    [c.caller_id, 'caution', sec.encrypt('shift-start review me'), sup.id, db.now()]);
  const gone = await db.insert(
    'INSERT INTO directive (caller_id, alert_level, body, created_by, created_at) VALUES (?,?,?,?,?)',
    [c.caller_id, 'info', sec.encrypt('old news'), sup.id, db.now()]);
  await db.run('UPDATE directive SET retired_at = ? WHERE id = ?', [db.now(), gone]);

  const token = await auth.createSession(w.id);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const rows = await (await fetch(`http://localhost:${port}/api/directives/active`,
    { headers: { Cookie: `session=${token}` } })).json();
  assert.ok(rows.some((d) => d.id === live && d.body === 'shift-start review me'));
  assert.ok(!rows.some((d) => d.id === gone), 'retired directive hidden');
  const anon = await fetch(`http://localhost:${port}/api/directives/active`);
  assert.strictEqual(anon.status, 401, 'login required');
  await queue.endContact(c.id, 'abandoned');
  server.close();
});

// ---------------------------------------------------------------------------
// Referrals

test('referrals link to contacts; previous referrals surface per caller', async () => {
  const w = await makeWorker();
  const rid = await db.insert(
    `INSERT INTO resource (name, category, status, created_at) VALUES (?,?,'active',?)`,
    ['Test Counselling', 'Counselling', db.now()]);

  const c1 = await makeContact(w);
  await db.run('INSERT INTO contact_referral (contact_id, resource_id, created_at) VALUES (?,?,?)',
    [c1.id, rid, db.now()]);
  await queue.endContact(c1.id, 'completed');

  // Same caller returns; previous referral shows on the new contact.
  const caller = await db.get('SELECT token FROM caller WHERE id = ?', [c1.caller_id]);
  const again = await queue.joinQueue({ callerToken: caller.token });
  const prev = await db.all(
    `SELECT resource.name FROM contact_referral
     JOIN contact ON contact.id = contact_referral.contact_id
     JOIN resource ON resource.id = contact_referral.resource_id
     WHERE contact.caller_id = ? AND contact.id != ?`,
    [c1.caller_id, again.contactId]);
  assert.strictEqual(prev.length, 1);
  assert.strictEqual(prev[0].name, 'Test Counselling');
  await queue.endContact(again.contactId, 'abandoned');
});

test('duplicate referral insert is a no-op (ON CONFLICT)', async () => {
  const w = await makeWorker();
  const rid = await db.insert(
    `INSERT INTO resource (name, status, created_at) VALUES (?,'active',?)`,
    ['Dup Resource', db.now()]);
  const c = await makeContact(w);
  for (let i = 0; i < 2; i++) {
    await db.run(
      'INSERT INTO contact_referral (contact_id, resource_id, created_at) VALUES (?,?,?) ON CONFLICT DO NOTHING',
      [c.id, rid, db.now()]);
  }
  const n = await db.get('SELECT COUNT(*) AS n FROM contact_referral WHERE contact_id = ?', [c.id]);
  assert.strictEqual(Number(n.n), 1);
  await queue.endContact(c.id, 'completed');
});

// ---------------------------------------------------------------------------
// QA loop + highlight (through the server route)

test('submitting an intake with supervisor_followup=yes opens a QA item; highlight flags the contact', async () => {
  const { app } = require('../server');
  const http = require('node:http');
  const auth = require('../src/auth');

  const w = await makeWorker();
  const token = await auth.createSession(w.id);
  const c = await makeContact(w);

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const res = await fetch(`http://localhost:${port}/api/intake/${c.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: `session=${token}` },
    body: JSON.stringify({
      submit: true,
      intake: {
        form: 'chat_intake', version: 1,
        answers: {
          ideation: 'no', supervisor_followup: 'yes', highlight: true,
          feelings_content: 'synthetic', main_concerns: ['anxiety'],
        },
      },
    }),
  });
  assert.strictEqual(res.status, 200);

  const contact = await db.get('SELECT * FROM contact WHERE id = ?', [c.id]);
  assert.strictEqual(Number(contact.highlight), 1);
  assert.strictEqual(contact.form_name, 'chat_intake');
  assert.strictEqual(Number(contact.form_version), 1);
  assert.ok(contact.intake_json.startsWith('g1$'), 'intake encrypted at rest');

  const fb = await db.get('SELECT * FROM feedback WHERE contact_id = ?', [c.id]);
  assert.ok(fb, 'QA item opened');
  assert.strictEqual(Number(fb.requested), 1);
  assert.strictEqual(Number(fb.worker_id), Number(w.id));

  // Re-submitting must not open a second QA item.
  await fetch(`http://localhost:${port}/api/intake/${c.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: `session=${token}` },
    body: JSON.stringify({
      submit: true,
      intake: { form: 'chat_intake', version: 1, answers: { supervisor_followup: 'yes' } },
    }),
  });
  const count = await db.get(
    'SELECT COUNT(*) AS n FROM feedback WHERE contact_id = ? AND requested = 1', [c.id]);
  assert.strictEqual(Number(count.n), 1);

  await queue.endContact(c.id, 'completed');
  server.close();
});

test('supervisor feedback marks the intake reviewed and reaches the worker', async () => {
  const { app } = require('../server');
  const http = require('node:http');
  const auth = require('../src/auth');

  const w = await makeWorker();
  const sup = await makeWorker('supervisor');
  const wToken = await auth.createSession(w.id);
  const sToken = await auth.createSession(sup.id);
  const c = await makeContact(w);
  await db.run(`UPDATE contact SET intake_status = 'submitted' WHERE id = ?`, [c.id]);

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const call = (path, opts = {}, token = sToken) => fetch(`http://localhost:${port}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Cookie: `session=${token}`, ...(opts.headers || {}) },
  });

  const sent = await call('/api/review/feedback', {
    method: 'POST',
    body: JSON.stringify({ contactId: c.id, body: 'Lovely pacing — well held.' }),
  });
  assert.strictEqual(sent.status, 200);

  const contact = await db.get('SELECT intake_status FROM contact WHERE id = ?', [c.id]);
  assert.strictEqual(contact.intake_status, 'reviewed');
  const raw = await db.get('SELECT body FROM feedback WHERE contact_id = ?', [c.id]);
  assert.ok(raw.body.startsWith('g1$'), 'feedback encrypted at rest');

  const mine = await (await call('/api/my-feedback', {}, wToken)).json();
  assert.strictEqual(mine.length, 1);
  assert.strictEqual(mine[0].body, 'Lovely pacing — well held.');
  assert.strictEqual(mine[0].acknowledged, false);

  const ack = await call(`/api/my-feedback/${mine[0].id}/ack`, { method: 'POST' }, wToken);
  assert.strictEqual(ack.status, 200);

  // A worker must not reach the review queue.
  const forbidden = await call('/api/review/queue', {}, wToken);
  assert.strictEqual(forbidden.status, 403);

  await queue.endContact(c.id, 'completed');
  server.close();
});

// ---------------------------------------------------------------------------
// Follow-ups

test('followups: open list is per-worker, done closes them', async () => {
  const w = await makeWorker();
  const c = await makeContact(w);
  const id = await db.insert(
    `INSERT INTO followup (caller_id, contact_id, assigned_to, due_at, note, created_by, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    [c.caller_id, c.id, w.id, new Date(Date.now() + 86_400_000).toISOString(),
      sec.encrypt('check in about sleep'), w.id, db.now()]);
  const open = await db.all(
    `SELECT * FROM followup WHERE status = 'open' AND assigned_to = ?`, [w.id]);
  assert.strictEqual(open.length, 1);
  assert.strictEqual(sec.decrypt(open[0].note), 'check in about sleep');
  await db.run(`UPDATE followup SET status = 'done', done_at = ? WHERE id = ?`, [db.now(), id]);
  const after = await db.all(
    `SELECT * FROM followup WHERE status = 'open' AND assigned_to = ?`, [w.id]);
  assert.strictEqual(after.length, 0);
  await queue.endContact(c.id, 'completed');
});

// ---------------------------------------------------------------------------
// Reports

test('reports aggregate labelled answers and never include free text', async () => {
  const { app } = require('../server');
  const http = require('node:http');
  const auth = require('../src/auth');

  const w = await makeWorker();
  const sup = await makeWorker('supervisor');
  const wToken = await auth.createSession(w.id);
  const sToken = await auth.createSession(sup.id);
  const c = await makeContact(w);

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  await fetch(`http://localhost:${port}/api/intake/${c.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: `session=${wToken}` },
    body: JSON.stringify({
      submit: true,
      intake: {
        form: 'chat_intake', version: 1,
        answers: {
          ideation: 'yes', intention: 'no',
          main_concerns: ['anxiety', 'suicide'],
          feelings_content: 'a long free-text paragraph that must never appear in reports because it is content',
          supervisor_followup: 'no',
        },
      },
    }),
  });
  await queue.endContact(c.id, 'completed');

  const from = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const rep = await (await fetch(
    `http://localhost:${port}/api/reports?from=${from}&to=${to}`,
    { headers: { Cookie: `session=${sToken}` } })).json();

  assert.ok(rep.contacts.total >= 1);
  assert.ok(rep.fields.main_concerns.Anxiety >= 1, 'option ids report as labels');
  assert.ok(rep.fields.main_concerns.Suicide >= 1);
  assert.ok(rep.fields.ideation.Yes >= 1);
  assert.ok(!rep.fields.feelings_content, 'free text stays out of reports');

  // Role gate: plain workers can't read reports.
  const forbidden = await fetch(
    `http://localhost:${port}/api/reports?from=${from}&to=${to}`,
    { headers: { Cookie: `session=${wToken}` } });
  assert.strictEqual(forbidden.status, 403);

  server.close();
});
