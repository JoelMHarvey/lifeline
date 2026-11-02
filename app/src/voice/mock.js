'use strict';

// The mock voice provider: the whole VoiceProvider interface (see index.js)
// with no network, no account and no audio. Calls live in memory, so it
// suits tests, local demos and the setup wizard's test call — never real
// callers. Every action is appended to the call's event list, which tests
// and the console read back.

const crypto = require('node:crypto');

const calls = new Map(); // callId → { id, from, state, workerId, held, monitors, events }

const name = 'mock';
const label = 'Mock (no real calls — for testing)';

// No secret, no webhooks: there is deliberately no built-in default.
function secret() {
  return process.env.TL_VOICE_WEBHOOK_SECRET || null;
}

function event(call, type, detail = {}) {
  call.events.push({ type, at: new Date().toISOString(), ...detail });
}

// A browser client token. Real providers return a signed JWT the voice SDK
// uses to register the worker's browser as a phone; the mock's just names
// the identity.
async function issueClientToken(identity) {
  return { provider: name, identity, token: crypto.randomBytes(12).toString('hex'), expiresInSecs: 3600 };
}

// Webhook signature: HMAC-SHA256 of the raw body, hex, in X-Voice-Signature.
// Real providers each have their own scheme; this one mirrors their shape.
function sign(rawBody) {
  if (!secret()) throw new Error('TL_VOICE_WEBHOOK_SECRET is not set');
  return crypto.createHmac('sha256', secret()).update(rawBody).digest('hex');
}
function verifyWebhook(headers, rawBody) {
  if (!secret() || !rawBody || !rawBody.length) return false;
  const given = Buffer.from(String((headers && (headers['x-voice-signature'] || headers['X-Voice-Signature'])) || ''));
  const want = Buffer.from(sign(rawBody));
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

// Webhook body → {type: 'inbound'|'hangup', callId, from}.
function parseWebhook(body) {
  const b = body || {};
  if (!['inbound', 'hangup'].includes(b.event)) return null;
  if (b.event === 'inbound') {
    const id = String(b.callId || ('MOCK' + crypto.randomBytes(6).toString('hex')));
    if (!calls.has(id)) {
      const call = { id, state: 'ringing', workerId: null, held: false, monitors: [], events: [] };
      event(call, 'ringing');
      calls.set(id, call);
    }
    return { type: 'inbound', callId: id, from: String(b.from || ''), web: !!b.web };
  }
  return { type: 'hangup', callId: String(b.callId || '') };
}

const get = (callId) => {
  const c = calls.get(String(callId));
  if (!c) throw new Error('mock voice: no such call');
  return c;
};

async function answer(callId, { workerId, recording }) {
  const c = get(callId);
  if (c.state !== 'ringing') throw new Error(`mock voice: call is ${c.state}`);
  c.state = 'connected'; c.workerId = workerId; c.recording = !!recording;
  event(c, 'answered', { workerId, recording: !!recording });
}
async function hangup(callId, { by } = {}) {
  const c = calls.get(String(callId));
  if (!c || c.state === 'ended') return;
  c.state = 'ended';
  event(c, 'hangup', { by: by || 'worker' });
}
async function hold(callId, on) {
  const c = get(callId);
  c.held = !!on;
  event(c, on ? 'held' : 'resumed');
}
async function transfer(callId, to) {
  const c = get(callId);
  c.state = 'transferred';
  event(c, 'transferred', { to });
}
async function playMessage(callId, text, { thenHangup = true } = {}) {
  const c = get(callId);
  event(c, 'message', { text });
  if (thenHangup) { c.state = 'ended'; event(c, 'hangup', { by: 'system' }); }
}
// Whether the call is still live at the provider: 'ringing', 'connected',
// 'ended', 'transferred', or null for a call it doesn't know.
async function status(callId) {
  const c = calls.get(String(callId));
  return c ? c.state : null;
}

async function monitor(callId, { supervisorId }) {
  const c = get(callId);
  c.monitors.push(supervisorId);
  event(c, 'monitor', { supervisorId });
}

// What the host would do if the app itself were unreachable: real providers
// are configured with a fallback (a static message or overflow number).
function fallbackDescription() {
  return 'The mock has no fallback; real providers are configured with a static fallback message or number (VOICE.md).';
}

// The setup wizard's test call: ring, answer, play the overflow message,
// hang up — all in memory, nothing touches the queue.
async function selfTest(message) {
  const { callId } = parseWebhook({ event: 'inbound', from: '+0000000000' });
  await answer(callId, { workerId: 0, recording: false });
  await playMessage(callId, message || 'This is a test call.');
  const events = calls.get(callId).events.map((e) => e.type);
  calls.delete(callId);
  return { ok: true, events };
}

// Tests and demos.
const _calls = () => calls;
function _reset() { calls.clear(); }

module.exports = {
  name, label, testOnly: true, issueClientToken, sign, verifyWebhook, parseWebhook, status, answer, hangup, hold,
  transfer, playMessage, monitor, fallbackDescription, selfTest, _calls, _reset,
};
