'use strict';

// Outbound email: sign-in codes, schedule and cover emails, problem-report
// updates, usage alerts. Two providers, chosen by environment, so TELL can
// switch without a code change (DEPLOY.md, "Switching to an email service"):
//
//   Gmail / any SMTP (the default)
//     TL_SMTP_URL=smtps://you@gmail.com:app-password@smtp.gmail.com:465
//     (an app password, not the account password). Free, but Gmail stops
//     sending after about 500 recipients a day.
//
//   Resend (an email service; takes over when its key is set)
//     TL_RESEND_API_KEY=re_...   TL_MAIL_FROM="TELL Lifeline <lifeline@telljp.com>"
//     The From address must be on a domain verified in Resend. Bulk sends
//     go 100 to a request.
//
// TL_MAIL_FROM overrides the From header (otherwise the SMTP username), and
// TL_MAIL_DAILY_LIMIT overrides the daily limit Ops warns against.
//
// send() never throws and reports delivery honestly, same contract as
// notify.js: true only when the provider accepted the message.

const { log } = require('./log');

let transportOverride = null; // tests inject a capture function here
let fetchOverride = null;     // tests stand in for the Resend API here

function provider() {
  if (transportOverride) return 'test';
  if (process.env.TL_RESEND_API_KEY) return 'resend';
  if (process.env.TL_SMTP_URL) return 'smtp';
  return null;
}

function configured() {
  const p = provider();
  // Resend refuses a From address that isn't on a verified domain, so it
  // needs one set explicitly.
  if (p === 'resend') return !!process.env.TL_MAIL_FROM;
  return !!p;
}

function smtpUser() {
  try {
    return decodeURIComponent(new URL(process.env.TL_SMTP_URL).username) || null;
  } catch {
    return null;
  }
}

// The profile's mail.fromName, when set, names a bare From address
// ("Name <addr>"). TELL's is null, so its From header is exactly as set.
function fromAddress() {
  const addr = process.env.TL_MAIL_FROM || smtpUser() || 'no-reply@localhost';
  const name = require('./profile').brand('mail.fromName');
  return name && !addr.includes('<') ? `${name} <${addr}>` : addr;
}

// The mailbox TELL controls — the default destination for operational
// alerts: the SMTP account, or the address inside TL_MAIL_FROM.
function account() {
  if (smtpUser()) return smtpUser();
  const m = /<([^>]+)>/.exec(process.env.TL_MAIL_FROM || '');
  return m ? m[1] : (process.env.TL_MAIL_FROM || null);
}

// ---------------------------------------------------------------------------
// Daily count (UTC day, numbers only) for the Ops page.

const today = () => new Date().toISOString().slice(0, 10);

async function countSent(n) {
  if (!n) return;
  try {
    const db = require('./db');
    await db.run(
      `INSERT INTO mail_count (day, sent) VALUES (?, ?)
       ON CONFLICT (day) DO UPDATE SET sent = mail_count.sent + EXCLUDED.sent`, [today(), n]);
  } catch { /* counting must never stop a send */ }
}

function dailyLimit() {
  if (process.env.TL_MAIL_DAILY_LIMIT) return Number(process.env.TL_MAIL_DAILY_LIMIT) || null;
  if (provider() === 'smtp' && /@smtp\.(gmail|googlemail)\.com/i
    .test(process.env.TL_SMTP_URL || '')) return 500;
  return null;
}

async function status() {
  let sentToday = 0;
  try {
    const db = require('./db');
    const row = await db.get('SELECT sent FROM mail_count WHERE day = ?', [today()]);
    sentToday = row ? Number(row.sent) : 0;
  } catch { /* table may not exist yet */ }
  const limit = dailyLimit();
  const p = provider();
  return {
    provider: p === 'smtp' && /gmail|googlemail/i.test(process.env.TL_SMTP_URL || '') ? 'gmail' : p,
    configured: configured(),
    from: configured() ? fromAddress() : null,
    sentToday,
    dailyLimit: limit,
    nearLimit: !!limit && sentToday >= limit * 0.8,
  };
}

// ---------------------------------------------------------------------------
// SMTP: one pooled connection per process, reused across messages (a cover
// email to 150 volunteers would otherwise open 150 TLS connections in one
// request). A connection left idle — or frozen with a serverless instance —
// can fail on reuse, so a failed send is retried once on a fresh transport.

let pooled = null;
function transport(fresh = false) {
  if (fresh && pooled) { try { pooled.close(); } catch { /* already gone */ } pooled = null; }
  if (!pooled) {
    const nodemailer = require('nodemailer');
    pooled = nodemailer.createTransport(process.env.TL_SMTP_URL, {
      pool: true, maxConnections: 1, maxMessages: 200,
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
    });
  }
  return pooled;
}

async function smtpSend(m) {
  for (const fresh of [false, true]) {
    try {
      await transport(fresh).sendMail({ from: fromAddress(), to: m.to, subject: m.subject, text: m.text });
      return true;
    } catch (e) {
      log('mail_error', { provider: 'smtp', error: String(e).slice(0, 300), retried: fresh });
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Resend's HTTP API. Rate-limited (429) and server errors are retried after
// a short wait; anything else is reported as not sent.

const RESEND = 'https://api.resend.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function resendPost(path, body) {
  const f = fetchOverride || fetch;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res = null;
    try {
      res = await f(RESEND + path, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.TL_RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      log('mail_error', { provider: 'resend', error: String(e).slice(0, 300), attempt });
    }
    if (res && res.ok) return true;
    if (res && res.status !== 429 && res.status < 500) {
      const detail = await res.text().catch(() => '');
      log('mail_error', { provider: 'resend', status: res.status, error: detail.slice(0, 300) });
      return false;
    }
    if (attempt < 2) await sleep(1000 * (attempt + 1));
  }
  return false;
}

const resendMessage = (m) => ({ from: fromAddress(), to: [m.to], subject: m.subject, text: m.text });

// ---------------------------------------------------------------------------

async function send(to, subject, text) {
  if (transportOverride) return transportOverride({ to, subject, text });
  if (!configured()) {
    log('mail_skipped', { reason: 'email not configured' });
    return false;
  }
  const ok = provider() === 'resend'
    ? await resendPost('/emails', resendMessage({ to, subject, text }))
    : await smtpSend({ to, subject, text });
  if (ok) { log('mail_sent', { subject }); await countSent(1); }
  return ok;
}

// Many separate messages (each person gets their own; nobody sees anyone
// else's address). Returns how many were accepted. Resend takes them 100 to
// a request; SMTP sends them one after another over the pooled connection.
async function sendMany(messages) {
  if (!messages.length) return 0;
  if (transportOverride) {
    let n = 0;
    for (const m of messages) if (await transportOverride(m)) n += 1;
    return n;
  }
  if (!configured()) {
    log('mail_skipped', { reason: 'email not configured', count: messages.length });
    return 0;
  }
  let sent = 0;
  if (provider() === 'resend') {
    for (let i = 0; i < messages.length; i += 100) {
      const chunk = messages.slice(i, i + 100);
      if (await resendPost('/emails/batch', chunk.map(resendMessage))) sent += chunk.length;
    }
  } else {
    for (const m of messages) if (await smtpSend(m)) sent += 1;
  }
  log('mail_sent_many', { sent, of: messages.length });
  await countSent(sent);
  return sent;
}

function _setTransportForTests(fn) { transportOverride = fn; }
function _setFetchForTests(fn) { fetchOverride = fn; }

module.exports = {
  configured, account, send, sendMany, status, provider, fromAddress,
  _setTransportForTests, _setFetchForTests,
};
