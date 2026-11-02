'use strict';

// Web phone calls (plan 08, P8) with the mock provider: one queue for calls
// and chats, answer/hold/hang up, the fail-safe overflow, privacy, the
// caller page's web call, and TELL never gaining voice by accident.

process.env.TL_PROFILE = 'generic';
process.env.TL_MODULES = 'helpline,schedule,voice';
process.env.TL_PGDATA = ':memory:';
process.env.TL_ENCRYPTION_KEY = '2'.repeat(64);
process.env.TL_VOICE_WEBHOOK_SECRET = 'test-secret';
process.env.TL_VOICE_DEMO = '1'; // pretend callers only

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const db = require('../src/db');
const sec = require('../src/crypto');
const auth = require('../src/auth');
const profile = require('../src/profile');
const modules = require('../src/modules');
const queue = require('../src/queue');
const voice = require('../src/voice');
const mock = require('../src/voice/mock');
const site = require('../src/site');

let server;
let base;
let seq = 0;
async function makeWorker(role) {
  const id = await db.insert(
    `INSERT INTO worker (email, name, password_hash, role, status, service_status, created_at)
     VALUES (?,?,?,?,'on_shift','in_service',?)`,
    [`v-${seq++}@test.org`, `V ${role} ${seq}`, sec.hashPassword('x'.repeat(12)), role, db.now()]);
  await db.run('INSERT INTO worker_program (worker_id, program_id) VALUES (?,?) ON CONFLICT DO NOTHING',
    [id, await db.chatProgramId()]);
  return { id, cookie: 'session=' + await auth.createSession(id) };
}
const call = async (method, p, body, cookie, headers = {}) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: typeof body === 'string' ? body : (body === undefined ? undefined : JSON.stringify(body)) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const webhook = (payload, sig) => {
  const raw = JSON.stringify(payload);
  return call('POST', '/api/voice/webhook/mock', raw, null, { 'X-Voice-Signature': sig === undefined ? mock.sign(raw) : sig });
};

let worker; let worker2; let sup; let coord;
test.before(async () => {
  await db.init();
  // The lifeline's numbers, as the setup wizard would have saved them.
  for (const [k, v] of [['phone', '0800 000 111'], ['emergency.primary.number', '999'],
    ['emergency.primary.label', 'emergency services']]) {
    await db.run('INSERT INTO config (key, value) VALUES (?, ?)', ['brand.' + k, v]);
  }
  await profile.loadOverrides((sql) => db.all(sql));
  const { app } = require('../server');
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
  worker = await makeWorker('worker');
  worker2 = await makeWorker('worker');
  sup = await makeWorker('supervisor');
  coord = await makeWorker('coordinator');
});
test.after(() => { server.close(); server.closeAllConnections(); });

test('voice is opt-in: never in the default modules, and needs the helpline', () => {
  assert.deepStrictEqual(modules.parse(undefined), ['helpline', 'schedule', 'board']);
  assert.throws(() => modules.parse('schedule,voice'), /voice needs helpline/);
  assert.deepStrictEqual(modules.parse('helpline,voice'), ['helpline', 'voice']);
});

test('webhooks must be signed', async () => {
  assert.strictEqual((await webhook({ event: 'inbound', from: '+44 7700 900123' }, 'nope')).status, 401);
  assert.strictEqual((await webhook({ event: 'inbound', from: '+44 7700 900123' }, '')).status, 401);
  assert.strictEqual((await webhook({ event: 'bogus' })).status, 400);
});

let firstCall;
test('an inbound call joins the queue; the number is never stored', async () => {
  const r = await webhook({ event: 'inbound', callId: 'CALL1', from: '+44 7700 900123' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  firstCall = r.body.contactId;
  const c = await db.get('SELECT * FROM contact WHERE id = ?', [firstCall]);
  assert.strictEqual(c.channel, 'voice');
  assert.strictEqual(c.voice_hint, '23');
  const caller = await db.get('SELECT * FROM caller WHERE id = ?', [c.caller_id]);
  assert.match(caller.token, /^voice:[0-9a-f]{64}$/);
  assert.strictEqual(caller.alias, 'Phone call ··23');
  const dump = JSON.stringify([await db.all('SELECT * FROM caller'), await db.all('SELECT * FROM contact'),
    await db.all('SELECT * FROM event_log'), await db.all('SELECT * FROM audit_log')]);
  assert.ok(!/7700|900123/.test(dump), 'no part of the number beyond the last two digits');
  assert.ok((await queue.waiting()).some((w) => Number(w.id) === firstCall));
  // It rings in the call panel, not in the chat list.
  const s = await call('GET', '/api/voice/state', undefined, worker.cookie);
  assert.deepStrictEqual(s.body.ringing.map((x) => [x.contactId, x.hint]), [[firstCall, '23']]);
});

test('a repeat caller is recognised by the hashed number', async () => {
  const r = await webhook({ event: 'inbound', callId: 'CALL2', from: '+447700900123' });
  const a = await db.get('SELECT caller_id FROM contact WHERE id = ?', [firstCall]);
  const b = await db.get('SELECT caller_id FROM contact WHERE id = ?', [r.body.contactId]);
  assert.strictEqual(a.caller_id, b.caller_id);
  // The caller hangs up before anyone answers: abandoned.
  assert.strictEqual((await webhook({ event: 'hangup', callId: 'CALL2' })).status, 200);
  assert.strictEqual((await db.get('SELECT outcome FROM contact WHERE id = ?', [r.body.contactId])).outcome, 'abandoned');
});

test('answering claims the call atomically and opens the phone intake', async () => {
  const a = await call('POST', `/api/voice/answer/${firstCall}`, {}, worker.cookie);
  assert.strictEqual(a.status, 200, JSON.stringify(a.body));
  assert.strictEqual(a.body.channel, 'phone');
  assert.strictEqual(a.body.voice, true);
  assert.ok(a.body.form && a.body.form.schema, 'the intake form comes with it');
  assert.strictEqual((await call('POST', `/api/voice/answer/${firstCall}`, {}, worker2.cookie)).status, 409);
  const m = mock._calls().get('CALL1');
  assert.strictEqual(m.state, 'connected');
  assert.strictEqual(m.recording, false, 'recording is off by default');

  // The call occupies the worker: no chat on top of it.
  const chat = await queue.joinQueue({ alias: 'C' });
  const w = await db.get('SELECT * FROM worker WHERE id = ?', [worker.id]);
  assert.strictEqual(await queue.claim(chat.contactId, w), null);
  await queue.endContact(chat.contactId, 'abandoned');

  const my = await call('GET', '/api/my-chats', undefined, worker.cookie);
  const mine = my.body.find((x) => x.contactId === firstCall);
  assert.strictEqual(mine.channel, 'phone');
  assert.strictEqual(mine.voice, true);
  const st = await call('GET', '/api/voice/state', undefined, worker.cookie);
  assert.strictEqual(st.body.myCall.contactId, firstCall);
});

test('supervisors see live calls and can listen in (audited); workers cannot', async () => {
  const s = await call('GET', '/api/voice/state', undefined, sup.cookie);
  assert.ok(s.body.liveCalls.some((c) => c.contactId === firstCall));
  assert.strictEqual((await call('POST', `/api/voice/monitor/${firstCall}`, {}, worker2.cookie)).status, 403);
  assert.strictEqual((await call('POST', `/api/voice/monitor/${firstCall}`, {}, sup.cookie)).status, 200);
  assert.deepStrictEqual(mock._calls().get('CALL1').monitors, [sup.id]);
  assert.ok(await db.get(`SELECT id FROM audit_log WHERE action = 'voice_monitor' AND entity_id = ?`, [firstCall]));
});

test('hold, then hang up: the contact ends and the intake stays to finish', async () => {
  assert.strictEqual((await call('POST', `/api/voice/hold/${firstCall}`, { on: true }, worker.cookie)).body.held, true);
  assert.strictEqual(mock._calls().get('CALL1').held, true);
  assert.strictEqual((await call('POST', `/api/voice/hangup/${firstCall}`, {}, worker2.cookie)).status, 404, 'only your own call');
  assert.strictEqual((await call('POST', `/api/voice/hangup/${firstCall}`, {}, worker.cookie)).status, 200);
  assert.strictEqual(mock._calls().get('CALL1').state, 'ended');
  const c = await db.get('SELECT outcome, ended_at FROM contact WHERE id = ?', [firstCall]);
  assert.strictEqual(c.outcome, 'completed');
  const saved = await call('PATCH', `/api/intake/${firstCall}`, { intake: { answers: { reflection: 'x' } }, submit: true }, worker.cookie);
  assert.strictEqual(saved.status, 200);
});

test('nobody answers: the call overflows — never silence', async () => {
  await db.run(`INSERT INTO config (key, value) VALUES ('safety_valve_after_secs', '60')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  const old = new Date(Date.now() - 120_000).toISOString();
  // No overflow number: the caller hears the safety-valve message.
  let r = await webhook({ event: 'inbound', callId: 'CALL3', from: '+44 7700 900555' });
  await db.run('UPDATE contact SET queued_at = ? WHERE id = ?', [old, r.body.contactId]);
  await queue.sweep();
  assert.strictEqual((await db.get('SELECT outcome FROM contact WHERE id = ?', [r.body.contactId])).outcome, 'timed_out');
  const msg = mock._calls().get('CALL3').events.find((e) => e.type === 'message');
  assert.match(msg.text, /call 999 \(emergency services\)/);
  assert.strictEqual(mock._calls().get('CALL3').state, 'ended');
  // With an overflow number: transferred there.
  assert.strictEqual((await call('PUT', '/api/voice/settings', { overflowNumber: '0800 999 000' }, coord.cookie)).status, 200);
  r = await webhook({ event: 'inbound', callId: 'CALL4', from: '+44 7700 900556' });
  await db.run('UPDATE contact SET queued_at = ? WHERE id = ?', [old, r.body.contactId]);
  await queue.sweep();
  const t = mock._calls().get('CALL4').events.find((e) => e.type === 'transferred');
  assert.strictEqual(t.to, '0800 999 000');
  await db.run(`DELETE FROM config WHERE key = 'safety_valve_after_secs'`);
});

test('recording is off unless a coordinator turns it on, and that is audited', async () => {
  assert.strictEqual((await call('PUT', '/api/voice/settings', { recording: true }, sup.cookie)).status, 403);
  assert.strictEqual((await call('GET', '/api/voice/settings', undefined, coord.cookie)).body.recording, false);
  assert.strictEqual((await call('PUT', '/api/voice/settings', { recording: true }, coord.cookie)).body.settings.recording, true);
  assert.match((await db.get(`SELECT detail FROM audit_log WHERE action = 'voice_settings' ORDER BY id DESC LIMIT 1`)).detail, /recording ON/);
  const r = await webhook({ event: 'inbound', callId: 'CALL5', from: '+44 7700 900777' });
  await call('POST', `/api/voice/answer/${r.body.contactId}`, {}, worker2.cookie);
  assert.strictEqual(mock._calls().get('CALL5').recording, true);
  await call('POST', `/api/voice/hangup/${r.body.contactId}`, {}, worker2.cookie);
  await call('PUT', '/api/voice/settings', { recording: false }, coord.cookie);
});

test('"call us" from the caller page: queue, answer, hang up', async () => {
  const start = await call('POST', '/api/voice/web-call', { pageSafety: profile.profile().safetyHash });
  assert.strictEqual(start.status, 200, JSON.stringify(start.body));
  const tok = start.body.callToken;
  let s = await call('POST', '/api/voice/web-call/status', { token: tok });
  assert.strictEqual(s.body.state, 'waiting');
  assert.strictEqual(s.body.position, 1);
  const contact = await db.get('SELECT id FROM contact WHERE chat_token = ?', [tok]);
  const st = await call('GET', '/api/voice/state', undefined, worker.cookie);
  assert.strictEqual(st.body.ringing.find((x) => x.contactId === Number(contact.id)).web, true);
  await call('POST', `/api/voice/answer/${contact.id}`, {}, worker.cookie);
  s = await call('POST', '/api/voice/web-call/status', { token: tok });
  assert.strictEqual(s.body.state, 'connected');
  await call('POST', '/api/voice/web-call/hangup', { token: tok });
  s = await call('POST', '/api/voice/web-call/status', { token: tok });
  assert.strictEqual(s.body.state, 'ended');
  assert.strictEqual(s.body.outcome, 'completed');
  // A page built before the numbers changed can't start a call either.
  assert.strictEqual((await call('POST', '/api/voice/web-call', { pageSafety: 'stale' })).status, 409);
});

test('no numbers configured: calls are refused with a message, not queued', async () => {
  await db.run(`DELETE FROM config WHERE key = 'brand.phone'`);
  await profile.loadOverrides((sql) => db.all(sql));
  try {
    const r = await webhook({ event: 'inbound', callId: 'CALL6', from: '+44 7700 900888' });
    assert.strictEqual(r.body.refused, true);
    assert.ok(!(await db.get(`SELECT id FROM contact WHERE voice_call_id = 'CALL6'`)));
    assert.match(mock._calls().get('CALL6').events.find((e) => e.type === 'message').text, /not taking calls/);
  } finally {
    await db.run(`INSERT INTO config (key, value) VALUES ('brand.phone', '0800 000 111')`);
    await profile.loadOverrides((sql) => db.all(sql));
  }
});

test('the demo call and the setup test call use the mock only', async () => {
  const d = await call('POST', '/api/voice/demo-call', {}, sup.cookie);
  assert.strictEqual(d.status, 200);
  assert.ok(d.body.contactId);
  assert.strictEqual((await call('POST', '/api/voice/demo-call', {}, worker.cookie)).status, 403);
  const t = await mock.selfTest('hello');
  assert.deepStrictEqual(t.events, ['ringing', 'answered', 'message', 'hangup']);
});

test('TELL: no voice API, no call panel, no call button', async () => {
  const tellSite = site.render(profile.load('tell'));
  const tellPub = (f) => tellSite[f];
  assert.ok(!tellPub('console.html').includes('voicepanel'));
  assert.ok(!tellPub('caller.html').includes('voiceCard'));
  const gen = site.render(profile.profile()); // generic + this test's numbers
  assert.ok(!site.render(profile.load('generic'))['caller.html'].includes('voiceCard'), 'no numbers, no call button');
  assert.ok(gen['console.html'].includes('<script src="voicepanel.js"></script>'));
  assert.ok(gen['caller.html'].includes('id="voiceCard"'));
  modules._set(undefined); // TELL's default: no voice
  try {
    assert.strictEqual((await call('GET', '/api/voice/state', undefined, worker.cookie)).status, 404);
    assert.strictEqual((await webhook({ event: 'inbound', from: '+1' })).status, 404);
  } finally {
    modules._set(process.env.TL_MODULES);
  }
});

test('the wizard offers phone calls only with the helpline, and its test call is the mock', () => {
  const setup = require('../src/setup');
  assert.match(setup.validateStep('modules', { modules: ['schedule', 'voice'] }).modules, /need the helpline/);
  const ok = setup.validateStep('voice', { modules: ['helpline', 'voice'], voice: { provider: 'mock', overflowNumber: 'abc' } });
  assert.match(ok.overflowNumber, /phone number/);
  assert.deepStrictEqual(setup.validateStep('voice', { modules: ['helpline', 'voice'], voice: { provider: 'mock' } }), {});
});


// --- Review fixes -------------------------------------------------------------

test('no webhook secret, no webhooks; the mock takes no real callers outside demo mode', async () => {
  const saved = process.env.TL_VOICE_WEBHOOK_SECRET;
  delete process.env.TL_VOICE_WEBHOOK_SECRET;
  try {
    const raw = JSON.stringify({ event: 'inbound', from: '+44 7700 900321' });
    const forged = require('node:crypto').createHmac('sha256', 'mock-voice-secret').update(raw).digest('hex');
    assert.strictEqual((await call('POST', '/api/voice/webhook/mock', raw, null, { 'X-Voice-Signature': forged })).status, 401);
    assert.strictEqual((await call('POST', '/api/voice/webhook/mock', raw, null, { 'X-Voice-Signature': 'é'.repeat(64) })).status, 401);
  } finally {
    process.env.TL_VOICE_WEBHOOK_SECRET = saved;
  }
  delete process.env.TL_VOICE_DEMO;
  try {
    assert.strictEqual((await call('GET', '/api/voice/available')).body.available, false);
    assert.strictEqual((await call('POST', '/api/voice/web-call', { pageSafety: profile.profile().safetyHash })).status, 503);
    const r = await webhook({ event: 'inbound', callId: 'REAL1', from: '+44 7700 900999' });
    assert.strictEqual(r.body.refused, true);
    assert.ok(!(await db.get(`SELECT id FROM contact WHERE voice_call_id = 'REAL1'`)));
  } finally {
    process.env.TL_VOICE_DEMO = '1';
  }
  assert.strictEqual((await call('GET', '/api/voice/available')).body.available, true);
});

test('withheld numbers are never merged into one caller', async () => {
  const a = await webhook({ event: 'inbound', callId: 'ANON1', from: 'anonymous' });
  const b = await webhook({ event: 'inbound', callId: 'ANON2', from: 'Restricted' });
  const ca = await db.get('SELECT caller_id FROM contact WHERE id = ?', [a.body.contactId]);
  const cb = await db.get('SELECT caller_id FROM contact WHERE id = ?', [b.body.contactId]);
  assert.notStrictEqual(ca.caller_id, cb.caller_id);
  const tok = await db.get('SELECT token FROM caller WHERE id = ?', [ca.caller_id]);
  assert.match(tok.token, /^voice-unknown:/);
  for (const id of ['ANON1', 'ANON2']) await webhook({ event: 'hangup', callId: id });
  // A retried webhook makes no second contact.
  const x = await webhook({ event: 'inbound', callId: 'DUP1', from: '+44 7700 900432' });
  const y = await webhook({ event: 'inbound', callId: 'DUP1', from: '+44 7700 900432' });
  assert.strictEqual(x.body.contactId, y.body.contactId);
  await webhook({ event: 'hangup', callId: 'DUP1' });
});

test('one thing at a time: no call on top of a phone intake', async () => {
  const w = await makeWorker('worker');
  const intake = await call('POST', '/api/phone-intake', {}, w.cookie);
  assert.strictEqual(intake.status, 200);
  const r = await webhook({ event: 'inbound', callId: 'BUSY1', from: '+44 7700 900111' });
  assert.strictEqual((await call('POST', `/api/voice/answer/${r.body.contactId}`, {}, w.cookie)).status, 409);
  await call('DELETE', `/api/phone-intake/${intake.body.contactId}`, undefined, w.cookie);
  await webhook({ event: 'hangup', callId: 'BUSY1' });
});

test('a caller gone at answer time is abandoned, not re-queued; a hang-up before the bridge is abandoned', async () => {
  const r = await webhook({ event: 'inbound', callId: 'GONE1', from: '+44 7700 900222' });
  mock._calls().get('GONE1').state = 'ended'; // the hangup webhook was lost
  const a = await call('POST', `/api/voice/answer/${r.body.contactId}`, {}, worker2.cookie);
  assert.strictEqual(a.status, 410);
  const c = await db.get('SELECT outcome, worker_id FROM contact WHERE id = ?', [r.body.contactId]);
  assert.deepStrictEqual([c.outcome, c.worker_id], ['abandoned', null]);
  // Claimed but never bridged, then the caller hangs up: abandoned, not completed.
  const r2 = await webhook({ event: 'inbound', callId: 'GONE2', from: '+44 7700 900223' });
  const w = await db.get('SELECT * FROM worker WHERE id = ?', [worker2.id]);
  await queue.claim(r2.body.contactId, w);
  await webhook({ event: 'hangup', callId: 'GONE2' });
  assert.strictEqual((await db.get('SELECT outcome FROM contact WHERE id = ?', [r2.body.contactId])).outcome, 'abandoned');
});

test('overflow falls back to the message when the transfer fails, and a broken provider never stops the sweep', async () => {
  await db.run(`INSERT INTO config (key, value) VALUES ('safety_valve_after_secs', '60')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  const old = new Date(Date.now() - 120_000).toISOString();
  const r = await webhook({ event: 'inbound', callId: 'FALL1', from: '+44 7700 900333' });
  await db.run('UPDATE contact SET queued_at = ? WHERE id = ?', [old, r.body.contactId]);
  const realTransfer = mock.transfer;
  mock.transfer = async () => { throw new Error('transfer refused'); };
  try { await queue.sweep(); } finally { mock.transfer = realTransfer; }
  const events = mock._calls().get('FALL1').events.map((e) => e.type);
  assert.ok(events.includes('message') && events.includes('hangup'), events.join(','));

  // A provider that throws on everything: the call is ended, the pass carries on
  // and a waiting chat is still paged.
  await db.run(`INSERT INTO config (key, value) VALUES ('backup_page_after_secs', '30')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  const chat = await queue.joinQueue({ alias: 'P' });
  await db.run(`UPDATE contact SET queued_at = ? WHERE id = ?`, [new Date(Date.now() - 45_000).toISOString(), chat.contactId]);
  const r2 = await webhook({ event: 'inbound', callId: 'FALL2', from: '+44 7700 900334' });
  await db.run('UPDATE contact SET queued_at = ? WHERE id = ?', [old, r2.body.contactId]);
  const saved = { t: mock.transfer, m: mock.playMessage, h: mock.hangup };
  mock.transfer = mock.playMessage = mock.hangup = async () => { throw new Error('down'); };
  let result;
  try { result = await queue.sweep(); } finally { Object.assign(mock, { transfer: saved.t, playMessage: saved.m, hangup: saved.h }); }
  assert.ok(result.toPage.some((c) => Number(c.id) === chat.contactId), 'the chat was still paged');
  await queue.endContact(chat.contactId, 'abandoned');
  await db.run(`DELETE FROM config WHERE key IN ('safety_valve_after_secs', 'backup_page_after_secs')`);
  await call('PUT', '/api/voice/settings', { overflowNumber: '' }, coord.cookie);
});

test('a web call whose page closed is ended; chat routes refuse a call token', async () => {
  const start = await call('POST', '/api/voice/web-call', { pageSafety: profile.profile().safetyHash });
  const tok = start.body.callToken;
  const contact = await db.get('SELECT id, voice_call_id FROM contact WHERE chat_token = ?', [tok]);
  assert.strictEqual((await call('POST', '/api/chat/message', { chatToken: tok, body: 'hi' })).status, 404);
  await db.run('UPDATE contact SET caller_seen_at = ? WHERE id = ?', [new Date(Date.now() - 300_000).toISOString(), contact.id]);
  await queue.sweep();
  assert.strictEqual((await db.get('SELECT outcome FROM contact WHERE id = ?', [contact.id])).outcome, 'abandoned');
  assert.strictEqual(mock._calls().get(contact.voice_call_id).state, 'ended');
});

test('call traffic alone drives the sweep (nobody online)', async () => {
  await db.run(`INSERT INTO config (key, value) VALUES ('safety_valve_after_secs', '60')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  const r = await webhook({ event: 'inbound', callId: 'SWEEP1', from: '+44 7700 900444' });
  await db.run('UPDATE contact SET queued_at = ? WHERE id = ?', [new Date(Date.now() - 120_000).toISOString(), r.body.contactId]);
  await db.run(`UPDATE config SET value = '0' WHERE key = 'last_sweep_at'`);
  await webhook({ event: 'inbound', callId: 'SWEEP2', from: '+44 7700 900445' }); // any webhook
  assert.strictEqual((await db.get('SELECT outcome FROM contact WHERE id = ?', [r.body.contactId])).outcome, 'timed_out');
  await webhook({ event: 'hangup', callId: 'SWEEP2' });
  await db.run(`DELETE FROM config WHERE key = 'safety_valve_after_secs'`);
});
