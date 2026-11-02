'use strict';

// Web phone calls (plan 08, P8): one queue for chats and calls.
//
// A call — an ordinary phone call to the lifeline's number, or a "call us"
// from the caller page's browser — becomes a contact with channel 'voice'.
// It joins the same program-scoped queue, backup paging and atomic claim as
// a chat; answering it opens the phone intake beside the call. A live call
// occupies the worker like a chat does.
//
// The provider does the telephony. Every provider implements the same
// interface (VoiceProvider), so the queue never knows which one is in use:
//
//   issueClientToken(identity)          token the browser voice SDK registers with
//   verifyWebhook(headers, rawBody)     true only for genuine provider requests
//   parseWebhook(body)                  → {type: 'inbound'|'hangup', callId, from}
//   answer(callId, {workerId, recording})  bridge the call to the worker's browser
//   hangup(callId, {by})
//   hold(callId, on)
//   transfer(callId, number)            e.g. to the overflow number
//   playMessage(callId, text)           speak a message, then hang up
//   monitor(callId, {supervisorId})     silent listen-in (observation)
//   status(callId)                      'ringing'|'connected'|'ended'|… or null
//   selfTest(message)                   the setup wizard's test call
//   testOnly                            true for a provider that can't carry
//                                       real audio (the mock)
//
// Only the mock provider exists so far (src/voice/mock.js): no accounts, no
// phone numbers, no real calls. VOICE.md covers going live.
//
// Fail-safe: a call nobody answers within the safety-valve window is never
// left ringing into silence — it goes to the overflow number if one is set,
// otherwise it hears the safety-valve message (with the emergency numbers)
// before the call ends. A deployment with no helpline/emergency numbers
// takes no calls at all.
//
// Privacy: no recording unless a coordinator turns it on (audited). The
// caller's number is never stored: caller.token keeps a keyed hash so a
// repeat caller is recognised (directives, history), and workers see only
// its last two digits. Logs carry ids and outcomes, never audio or numbers.

const crypto = require('node:crypto');
const db = require('../db');
const queue = require('../queue');
const profile = require('../profile');
const { log } = require('../log');

const PROVIDERS = { mock: require('./mock') };

async function getConfig(key) {
  const r = await db.get('SELECT value FROM config WHERE key = ?', [key]);
  return r ? r.value : null;
}
async function setConfig(key, value) {
  if (value === null) return db.run('DELETE FROM config WHERE key = ?', [key]);
  return db.run(`INSERT INTO config (key, value) VALUES (?, ?)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value]);
}

async function settings() {
  return {
    provider: (await getConfig('voice.provider')) || process.env.TL_VOICE_PROVIDER || 'mock',
    recording: (await getConfig('voice.recording')) === 'on',
    overflowNumber: (await getConfig('voice.overflow_number')) || null,
  };
}

async function provider() {
  const name = (await settings()).provider;
  const p = PROVIDERS[name];
  if (!p) throw new Error(`voice provider "${name}" is not available (known: ${Object.keys(PROVIDERS).join(', ')})`);
  return p;
}

// Boot check: an unknown TL_VOICE_PROVIDER fails loudly, not mid-sweep.
function checkEnv() {
  const name = process.env.TL_VOICE_PROVIDER;
  if (name && !PROVIDERS[name]) {
    throw new Error(`TL_VOICE_PROVIDER "${name}" is not available (known: ${Object.keys(PROVIDERS).join(', ')})`);
  }
}

// A test-only provider (the mock) never carries a real caller: real calls
// and the caller page's "Call us" are refused unless demo mode is on
// (TL_VOICE_DEMO=1, for demos and tests with pretend callers only).
const demoMode = () => process.env.TL_VOICE_DEMO === '1';
async function takesRealCalls() {
  const p = await provider();
  return !p.testOnly || demoMode();
}
const providerByName = (name) => PROVIDERS[name] || null;
const providerList = () => Object.values(PROVIDERS).map((p) => ({ name: p.name, label: p.label }));

// A keyed hash of the caller's number: recognises a repeat caller, can't be
// reversed without the app key.
function callerKey(number) {
  const key = require('../crypto').deriveKey('voice-caller-number');
  return crypto.createHmac('sha256', key).update(normaliseNumber(number)).digest('hex');
}
// Digits only, so "+44 7700 900123" and "+447700900123" match. Anything
// with fewer than 6 digits ("anonymous", "Restricted", short codes) is not
// a number we can recognise again: such callers are never merged.
function normaliseNumber(number) {
  const d = String(number || '').replace(/\D/g, '');
  return d.length >= 6 ? d : '';
}
const hintOf = (number) => {
  const d = String(number || '').replace(/\D/g, '');
  return d.length >= 4 ? d.slice(-2) : null;
};

// ---------------------------------------------------------------------------
// Inbound

async function inbound({ callId, from, web }) {
  const p = await provider();
  if (!(await takesRealCalls())) {
    await p.playMessage(callId, 'This service is not taking calls. If you are in danger, contact your local emergency services now.');
    log('voice_refused', { reason: 'test provider outside demo mode' });
    return { refused: true };
  }
  if (!profile.profile().ready.helpline) {
    // Fail closed: no numbers configured, so no calls taken.
    await p.playMessage(callId, 'This service is not taking calls. If you are in danger, contact your local emergency services now.');
    log('voice_refused', { reason: 'helpline not configured' });
    return { refused: true };
  }
  const existing = await db.get('SELECT id FROM contact WHERE voice_call_id = ?', [String(callId)]);
  if (existing) return { contactId: Number(existing.id) };
  const known = !web && normaliseNumber(from);
  const token = known ? 'voice:' + callerKey(from)
    : (web ? 'voice-web:' : 'voice-unknown:') + crypto.randomBytes(12).toString('hex');
  const hint = web ? null : hintOf(from);
  let caller = await db.get('SELECT id FROM caller WHERE token = ?', [token]);
  if (!caller) {
    const id = await db.insert('INSERT INTO caller (token, alias, first_seen) VALUES (?,?,?)',
      [token, web ? 'Web call' : (hint ? `Phone call ··${hint}` : 'Phone call'), db.now()]);
    caller = { id };
  }
  let contactId;
  try {
    contactId = await db.insert(
      `INSERT INTO contact (caller_id, program_id, chat_token, queued_at, caller_seen_at, channel,
         voice_call_id, voice_hint)
       VALUES (?,?,?,?,?,'voice',?,?)`,
      [caller.id, await db.chatProgramId(), crypto.randomBytes(16).toString('hex'), db.now(), db.now(),
        String(callId), hint]);
  } catch (e) {
    // A retried webhook racing the first: one contact per call.
    const again = await db.get('SELECT id FROM contact WHERE voice_call_id = ?', [String(callId)]);
    if (again) return { contactId: Number(again.id) };
    throw e;
  }
  await db.eventLog('queue_join', { contactId });
  log('voice_inbound', { contactId, web: !!web });
  return { contactId };
}

// The caller hung up (or the provider dropped the call).
async function onHangup(callId) {
  const c = await db.get('SELECT * FROM contact WHERE voice_call_id = ? AND outcome IS NULL', [String(callId)]);
  if (!c) return false;
  const outcome = c.voice_answered_at ? 'completed' : 'abandoned';
  await queue.endContact(c.id, outcome);
  log('voice_hangup', { contactId: Number(c.id), by: 'caller', outcome });
  return true;
}

async function handleWebhook(providerName, headers, rawBody, body) {
  const p = providerByName(providerName);
  if (!p) return { status: 404, error: 'unknown provider' };
  if (!p.verifyWebhook(headers, rawBody)) return { status: 401, error: 'bad signature' };
  const ev = p.parseWebhook(body);
  if (!ev) return { status: 400, error: 'unrecognised event' };
  if (ev.type === 'inbound') return { ok: true, ...(await inbound(ev)) };
  if (ev.type === 'hangup') return { ok: true, ended: await onHangup(ev.callId) };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The worker's side

async function ownCall(contactId, workerId) {
  return db.get(
    `SELECT * FROM contact WHERE id = ? AND worker_id = ? AND channel = 'voice' AND ended_at IS NULL`,
    [Number(contactId), workerId]);
}

async function answer(contactId, worker) {
  const c = await db.get(`SELECT * FROM contact WHERE id = ? AND channel = 'voice'`, [Number(contactId)]);
  if (!c) return { status: 404, error: 'no such call' };
  // One thing at a time: not while on a chat, another call or a phone intake.
  const busy = await db.get('SELECT id FROM contact WHERE worker_id = ? AND ended_at IS NULL LIMIT 1', [worker.id]);
  if (busy) return { status: 409, error: 'finish what you have open first (a chat, call or phone intake)' };
  const claimed = await queue.claim(c.id, worker);
  if (!claimed) return { status: 409, error: 'someone else answered, the caller hung up, or you are busy' };
  const p = await provider();
  try {
    await p.answer(c.voice_call_id, { workerId: worker.id, recording: (await settings()).recording });
  } catch (e) {
    log('voice_answer_failed', { contactId: Number(c.id), error: String(e).slice(0, 120) });
    const live = await p.status(c.voice_call_id).catch(() => null);
    if (live !== 'ringing') {
      // The caller has gone: don't ring a dead call for everyone.
      await db.run('UPDATE contact SET worker_id = NULL, claimed_at = NULL WHERE id = ? AND outcome IS NULL', [c.id]);
      await queue.endContact(c.id, 'abandoned');
      return { status: 410, error: 'the caller has already hung up' };
    }
    // Still ringing: back in the queue for someone else.
    await db.run(`UPDATE contact SET worker_id = NULL, claimed_at = NULL, queue_wait_secs = NULL
      WHERE id = ? AND outcome IS NULL`, [c.id]);
    return { status: 502, error: 'the call could not be connected — it is back in the queue' };
  }
  await db.run('UPDATE contact SET voice_answered_at = ? WHERE id = ?', [db.now(), c.id]);
  await db.audit(worker.id, 'voice_answered', 'contact', Number(c.id));
  return { ok: true, contactId: Number(c.id) };
}

async function hangup(contactId, worker) {
  const c = await ownCall(contactId, worker.id);
  if (!c) return { status: 404, error: 'not your call' };
  await (await provider()).hangup(c.voice_call_id, { by: 'worker' });
  await queue.endContact(c.id, 'completed');
  await db.audit(worker.id, 'voice_hangup', 'contact', Number(c.id));
  return { ok: true };
}

async function hold(contactId, worker, on) {
  const c = await ownCall(contactId, worker.id);
  if (!c) return { status: 404, error: 'not your call' };
  await (await provider()).hold(c.voice_call_id, !!on);
  return { ok: true, held: !!on };
}

async function monitor(contactId, supervisor) {
  const c = await db.get(
    `SELECT * FROM contact WHERE id = ? AND channel = 'voice' AND worker_id IS NOT NULL AND ended_at IS NULL`,
    [Number(contactId)]);
  if (!c) return { status: 404, error: 'no such live call' };
  await (await provider()).monitor(c.voice_call_id, { supervisorId: supervisor.id });
  await db.audit(supervisor.id, 'voice_monitor', 'contact', Number(c.id));
  return { ok: true };
}

// A web caller whose page stopped polling (tab closed): end the provider leg.
async function dropAbandoned(contact) {
  const p = await provider();
  await p.hangup(contact.voice_call_id, { by: 'system' });
  log('voice_hangup', { contactId: Number(contact.id), by: 'stale page' });
}

// The fail-safe: called when a waiting call reaches the safety valve.
// Never throws: the sweep must carry on to page backups for everyone else.
// Overflow number first, then the spoken message, then at least a hangup;
// if all fail the maintainers are alerted.
async function overflow(contact) {
  const id = Number(contact.id);
  const attempts = [];
  try {
    const s = await settings();
    const p = await provider();
    if (s.overflowNumber) attempts.push(['overflow number', () => p.transfer(contact.voice_call_id, s.overflowNumber)]);
    attempts.push(['message', async () => p.playMessage(contact.voice_call_id, await db.getConfig('safety_valve_message'))]);
    attempts.push(['hangup', () => p.hangup(contact.voice_call_id, { by: 'system' })]);
  } catch (e) {
    log('voice_overflow_failed', { contactId: id, error: String(e).slice(0, 120) });
  }
  for (const [to, run] of attempts) {
    try {
      await run();
      log('voice_overflow', { contactId: id, to });
      if (to !== 'hangup') return true;
      break;
    } catch (e) {
      log('voice_overflow_step_failed', { contactId: id, to, error: String(e).slice(0, 120) });
    }
  }
  require('../notify').notify('ops_alert', [], {
    text: `A call (contact ${id}) reached the safety valve and could not be sent to the overflow number or message. Check the voice provider.`,
  }).catch(() => {});
  return false;
}

// What the console's call panel shows this worker.
async function state(worker) {
  const ringing = (await queue.waiting()).filter((c) => c.channel === 'voice').map((c) => ({
    contactId: Number(c.id),
    waitedSecs: Math.max(0, Math.round((Date.now() - Date.parse(c.queued_at)) / 1000)),
    hint: c.voice_hint || null,
    web: String(c.caller_token || '').startsWith('voice-web:'),
    priorContacts: Number(c.prior_contacts),
    paged: !!c.paged_at,
  }));
  const mine = await db.get(
    `SELECT id, claimed_at FROM contact WHERE worker_id = ? AND channel = 'voice' AND ended_at IS NULL
     ORDER BY id DESC LIMIT 1`, [worker.id]);
  const live = ['supervisor', 'coordinator'].includes(worker.role)
    ? (await db.all(
      `SELECT contact.id, contact.claimed_at, worker.name AS worker_name FROM contact
       JOIN worker ON worker.id = contact.worker_id
       WHERE contact.channel = 'voice' AND contact.ended_at IS NULL AND contact.worker_id IS NOT NULL
         AND contact.worker_id != ?`, [worker.id]))
      .map((r) => ({ contactId: Number(r.id), since: r.claimed_at, worker: r.worker_name }))
    : [];
  return {
    ringing,
    myCall: mine ? { contactId: Number(mine.id), since: mine.claimed_at } : null,
    liveCalls: live,
    recording: (await settings()).recording,
  };
}

async function setSettings(patch, actor) {
  const p = patch || {};
  const changes = [];
  if (p.recording !== undefined) {
    const on = p.recording === true || p.recording === 'on';
    await setConfig('voice.recording', on ? 'on' : 'off');
    changes.push(`recording ${on ? 'ON' : 'off'}`);
  }
  if (p.overflowNumber !== undefined) {
    const v = String(p.overflowNumber || '').trim();
    if (v && !/^[0-9+][0-9 ()+-]{1,23}$/.test(v)) return { status: 400, error: 'overflow number: digits, spaces, + - and brackets' };
    await setConfig('voice.overflow_number', v || null);
    changes.push(v ? 'overflow number set' : 'overflow number cleared');
  }
  if (p.provider !== undefined) {
    if (!PROVIDERS[p.provider]) return { status: 400, error: 'unknown provider' };
    await setConfig('voice.provider', p.provider);
    changes.push(`provider ${p.provider}`);
  }
  if (changes.length) await db.audit(actor.id, 'voice_settings', 'config', null, changes.join('; '));
  return { ok: true, settings: await settings() };
}

module.exports = {
  settings, provider, dropAbandoned, checkEnv, takesRealCalls, demoMode, normaliseNumber, providerByName, providerList, callerKey, hintOf, inbound, onHangup,
  handleWebhook, answer, hangup, hold, monitor, overflow, state, setSettings, PROVIDERS,
};
