'use strict';

// TELL Lifeline Phase 1 server — serverless-compatible.
//
// Transport is Server-Sent Events + POST (no WebSockets): every deliverable
// (message, queue change, page, observation) lives in Postgres, and the SSE
// streams poll the DB on a short tick. That makes any number of serverless
// instances equivalent — no in-memory socket registry to share — while the
// same file still runs as a plain long-lived server locally (npm start).
//
// The sweep (backup paging, safety valve, abandonment) runs opportunistically
// from stream heartbeats behind a DB throttle, plus an optional guarded
// /api/cron/sweep endpoint for an external pinger.

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');

const db = require('./src/db');
const sec = require('./src/crypto');
const { log } = require('./src/log');
const auth = require('./src/auth');
const queue = require('./src/queue');
const rl = require('./src/ratelimit');
const forms = require('./src/forms');
const schedule = require('./src/schedule');
const board = require('./src/board');
const { notify: notifyOut, EMAIL_PREFS } = require('./src/notify');
const mail = require('./src/mail');
const { snapshot } = require('./src/stats');
const backup = require('./src/backup');
const issues = require('./src/issues');
const { parseCsv, mapHeader } = require('./src/csv');
const { importResources, cleanUrl } = require('./src/resourceimport');
const canned = require('./src/canned');
const modules = require('./src/modules');
const profile = require('./src/profile');
const tz = require('./src/tz');
const retention = require('./src/retention');
const site = require('./src/site');
const setup = require('./src/setup');
const voice = require('./src/voice');

const PORT = Number(process.env.PORT || 3000);
// Fail at boot, not on the first caller's message.
if (sec.isProduction()) sec.encryptionKey();
if (modules.enabled('voice')) voice.checkEnv(); // unknown provider: fail at boot
const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
// Cookies are Secure on a real deployment (always HTTPS there).
const SECURE = sec.isProduction() ? '; Secure' : '';
// Security headers. Every page except the caller's may not be framed
// (clickjacking the console); the caller page may be embedded in the
// lifeline's own website. vercel.json sets the same for the static pages.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (!/^\/caller\.(html|js)$/.test(req.path)) {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  }
  if (sec.isProduction()) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
});
// A resource directory export can run to a few megabytes; everything else
// stays small. (The first parser to read a body wins; the global one skips it.)
app.use('/api/resources/import', express.json({ limit: '4mb' }));
// Voice webhooks are signed over the raw body.
app.use('/api/voice/webhook', express.json({ limit: '64kb',
  verify: (req, _res, buf) => { req.rawBody = Buffer.from(buf); } }));
app.use(express.json({ limit: '256kb' }));
// Saved settings (organisation editor, setup wizard): the overrides and the
// wizard's module choice. Read on an instance's first request — before the
// module gate, so a fresh serverless instance never serves the file's
// defaults (no numbers → chat refused; default modules) — and again every
// 30 seconds, since another instance may have changed them.
let overridesReadAt = 0;
app.use((req, res, next) => {
  const f = profile.base().features;
  if (!(f.orgEditor || f.setupWizard) || Date.now() - overridesReadAt <= 30_000) return next();
  overridesReadAt = Date.now();
  (async () => {
    await profile.loadOverrides((sql) => db.all(sql));
    if (f.setupWizard) await modules.loadConfig((sql) => db.all(sql), true);
  })().then(() => next(), (e) => { overridesReadAt = 0; next(e); });
});
// Disabled modules' APIs are absent (see src/modules.js).
app.use(modules.gate);

// Wrap async handlers so rejections hit the error middleware.
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// UAT gate. A browser gets a branded passcode page (one cookie, 30 days)
// instead of the native basic-auth dialog, which read as a confusing second
// login and asks for a username nobody has. Basic auth with the same
// passcode still passes, so scripts and monitors keep working. On Vercel,
// static files are served by the CDN and bypass this — API calls carry the
// gate, and the pages' own scripts redirect to the passcode page on a
// gate 401.
const UAT_PASSCODE = process.env.UAT_PASSCODE;
const uatCookieValue = () => UAT_PASSCODE &&
  crypto.createHmac('sha256', UAT_PASSCODE).update('tell-uat-gate').digest('hex');
if (UAT_PASSCODE) {
  app.use((req, res, next) => {
    // The ICS feed carries its own per-worker secret token — calendar apps
    // can't answer a passcode prompt. The passcode page itself must load.
    if (req.path === '/healthz' || req.path === '/api/cron/sweep' ||
        req.path === '/api/cron/ops-check' ||
        req.path.startsWith('/api/schedule/ics/') || req.path.startsWith('/api/voice/webhook/') ||
        req.path === '/passcode.html' || req.path === '/api/passcode' ||
        req.path === '/api/admin/backup') return next();
    const cookies = auth.parseCookies(req.headers.cookie);
    if (cookies.uat === uatCookieValue()) return next();
    const header = req.headers.authorization || '';
    if (header.startsWith('Basic ')) {
      const decoded = Buffer.from(header.slice(6), 'base64').toString();
      if (decoded.slice(decoded.indexOf(':') + 1) === UAT_PASSCODE) return next();
    }
    if (req.path.startsWith('/api/')) {
      // No WWW-Authenticate header: the browser must not pop its own dialog.
      return res.status(401).json({ error: 'team passcode required', passcode: true });
    }
    res.redirect('/passcode.html?next=' + encodeURIComponent(req.path.replace(/^\//, '')));
  });

  app.post('/api/passcode', h(async (req, res) => {
    if (!(await rl.allow('passcode:' + rl.clientIp(req), 10, 15 * 60_000))) {
      return res.status(429).json({ error: 'too many attempts — wait a few minutes' });
    }
    const given = Buffer.from(String((req.body || {}).code || ''));
    const want = Buffer.from(UAT_PASSCODE);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
      return res.status(401).json({ error: 'that passcode didn’t match' });
    }
    res.setHeader('Set-Cookie',
      `uat=${uatCookieValue()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${SECURE}`);
    res.json({ ok: true });
  }));
}

app.use(h(auth.attachWorker));

// Pages: rendered from site/ for this deployment's profile, in memory, when
// the server runs from the repo (npm start, Docker, Fly). Where site/ isn't
// shipped (a serverless function), the host serves public/ — built at deploy
// time by npm run build — and never reaches this.
if (site.available()) app.use(site.middleware());
app.use(express.static(path.join(__dirname, 'public')));

const cookieFor = (token) =>
  `session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${db.SESSION_HOURS * 3600}${SECURE}`;

// ---------------------------------------------------------------------------
// SSE plumbing

function sseInit(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': open\n\n');
}
const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const ping = (res) => res.write(': ping\n\n');

async function messagesFor(contactId, sinceId = 0) {
  const rows = await db.all(
    `SELECT id, sender, body, client_msg_id, sent_at FROM message
     WHERE contact_id = ? AND id > ? ORDER BY id`, [contactId, sinceId]);
  return rows.map((m) => ({ ...m, id: Number(m.id), body: sec.decrypt(m.body) }));
}

async function storeMessage(contactId, sender, body, clientMsgId) {
  if (clientMsgId) {
    const dup = await db.get(
      'SELECT id FROM message WHERE contact_id = ? AND client_msg_id = ?',
      [contactId, clientMsgId]);
    if (dup) return { id: Number(dup.id), dup: true };
  }
  const id = await db.insert(
    'INSERT INTO message (contact_id, sender, body, client_msg_id, sent_at) VALUES (?,?,?,?,?)',
    [contactId, sender, sec.encrypt(body), clientMsgId || null, db.now()]);
  return { id, dup: false };
}

const systemMessage = (contactId, body) => storeMessage(contactId, 'system', body, null);

// Decode a contact's pre-chat answers against the survey version they were
// given, returning display pairs plus the short summary the queue shows.
// Legacy {concern, safe} triage from the old widget still renders.
async function prechatInfo(contactRow) {
  const triage = queue.triageOf(contactRow);
  if (!triage || !triage.answers) {
    const pairs = [];
    if (triage && triage.concern) pairs.push(['Concern (pre-chat)', triage.concern]);
    if (triage && triage.safe) pairs.push(['Safe right now', triage.safe]);
    return { pairs, concern: (triage && triage.concern) || null,
      risk: !!(triage && triage.safe === 'no') };
  }
  const form = (triage.form && triage.version
    ? await forms.formVersion(triage.form, Number(triage.version)) : null) ||
    await forms.currentForm('pre_chat');
  const fields = form ? forms.fieldsOf(form.schema) : [];
  const labelOf = (f, v) => {
    const o = (f.options || []).find((x) => x.id === v);
    return o ? o.label : String(v);
  };
  const pairs = [];
  let concern = null;
  for (const f of fields) {
    const v = triage.answers[f.id];
    if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) continue;
    const shown = v === true ? 'yes'
      : Array.isArray(v) ? v.map((x) => labelOf(f, x)).join(', ') : labelOf(f, v);
    pairs.push([f.label || f.id, shown]);
    if (f.id === 'main_concern') concern = shown;
    const other = triage.answers[f.id + '_other'];
    if (other) pairs.push(['↳ ' + (f.label || f.id), String(other)]);
  }
  return {
    pairs, concern,
    risk: triage.answers.suicidal_thoughts === 'yes' ||
      triage.answers.self_harm === 'recent',
  };
}

async function queueStateMsg() {
  // Calls ring in the console's call panel (voicepanel.js), not the chat list.
  const waiting = (await queue.waiting()).filter((c) => c.channel !== 'voice');
  return {
    type: 'queue',
    waiting: await Promise.all(waiting.map(async (c) => {
      const pre = await prechatInfo(c);
      return {
        contactId: Number(c.id),
        alias: c.alias,
        priority: c.priority,
        priorContacts: Number(c.prior_contacts),
        queuedAt: c.queued_at,
        paged: !!c.paged_at,
        triage: { concern: pre.concern, risk: pre.risk },
      };
    })),
    onCall: await queue.onCallSupervisor(),
  };
}

// ---------------------------------------------------------------------------
// First-run setup

app.get('/api/setup-needed', h(async (_req, res) => {
  const row = await db.get('SELECT COUNT(*) AS n FROM worker');
  res.json({ needed: Number(row.n) === 0 });
}));

app.post('/api/setup', h(async (req, res) => {
  if (setup.enabled()) return res.status(404).json({ error: 'use the setup wizard (wizard.html)', wizard: true });
  if (!(await setup.setupTokenOk((req.body || {}).setupToken || req.headers['x-setup-token']))) {
    return res.status(401).json({ error: 'setup token required (TL_SETUP_TOKEN, or the one in the server log)', tokenRequired: true });
  }
  const row = await db.get('SELECT COUNT(*) AS n FROM worker');
  if (Number(row.n) > 0) return res.status(403).json({ error: 'already set up' });
  const { name, email, password } = req.body || {};
  if (!name || !email || String(password || '').length < 10) {
    return res.status(400).json({ error: 'name, email and a 10+ character password required' });
  }
  const workerId = await db.insert(
    `INSERT INTO worker (email, name, password_hash, role, created_at)
     VALUES (?,?,?,'coordinator',?)`,
    [String(email).trim().toLowerCase(), name, sec.hashPassword(password), db.now()]);
  await db.run('INSERT INTO worker_program (worker_id, program_id) VALUES (?,?) ON CONFLICT DO NOTHING',
    [workerId, await db.chatProgramId()]);
  await db.audit(workerId, 'setup_coordinator_created');
  const token = await auth.createSession(workerId);
  res.setHeader('Set-Cookie', cookieFor(token));
  res.json({ ok: true });
}));

// Setup wizard (profile feature "setupWizard"; src/setup.js). Open only while
// no account exists; TL_SETUP_TOKEN, when set, must come with every call.
const setupGate = h(async (req, res, next) => {
  if (!setup.enabled()) return res.status(404).json({ error: 'not available' });
  if (!(await setup.setupTokenOk(req.headers['x-setup-token']))) {
    return res.status(401).json({ error: 'setup token required', tokenRequired: true });
  }
  if (await setup.isOpen()) {
    const own = await setup.claimOwner(auth.parseCookies(req.headers.cookie).setup_owner,
      req.headers['x-setup-token']);
    if (!own.ok) {
      return res.status(409).json({ error: 'Setup is in progress in another browser. It frees up after two hours without activity.', otherBrowser: true });
    }
    if (own.token) {
      res.setHeader('Set-Cookie',
        `setup_owner=${own.token}; Path=/api/setup; HttpOnly; SameSite=Strict; Max-Age=${3 * 86400}${SECURE}`);
    }
  }
  next();
});
const setupReply = (res, r) => (r.status ? res.status(r.status).json(r) : res.json(r));

app.get('/api/setup/state', setupGate, h(async (_req, res) => res.json(await setup.state())));
app.post('/api/setup/save', setupGate, h(async (req, res) => setupReply(res, await setup.save(req.body || {}))));
app.post('/api/setup/totp', setupGate, h(async (req, res) =>
  setupReply(res, await setup.startTotp((req.body || {}).email))));
app.post('/api/setup/voice-test', setupGate, h(async (_req, res) => setupReply(res, await setup.voiceTest())));
app.post('/api/setup/test-email', setupGate, h(async (req, res) => {
  if (!(await rl.allow('setup-mail:' + rl.clientIp(req), 3, 10 * 60_000))) {
    return res.status(429).json({ error: 'too many test emails — wait a few minutes' });
  }
  setupReply(res, await setup.sendTestEmail((req.body || {}).to));
}));
app.post('/api/setup/finish', setupGate, h(async (req, res) => {
  if (!(await rl.allow('setup-finish:' + rl.clientIp(req), 10, 10 * 60_000))) {
    return res.status(429).json({ error: 'too many attempts — wait a few minutes' });
  }
  const r = await setup.finish(req.body || {});
  if (!r.ok) return setupReply(res, r);
  const token = await auth.createSession(r.workerId);
  res.setHeader('Set-Cookie', cookieFor(token));
  const rebuild = await setup.requestRebuild('setup finished');
  res.json({ ok: true, rebuildRequested: rebuild });
}));

// The organisation as a reusable profile file (coordinators; deployments with
// the wizard or the organisation editor).
app.get('/api/admin/profile-export', auth.requireWorker, auth.requireRole('coordinator'), h(async (req, res) => {
  const f = profile.base().features;
  if (!f.setupWizard && !f.orgEditor) return res.status(404).json({ error: 'not available' });
  const p = await setup.exportProfile(req.query.id || profile.brand('shortName'));
  res.setHeader('Content-Disposition', `attachment; filename="${p.id}.json"`);
  res.type('application/json').send(JSON.stringify(p, null, 2) + '\n');
}));

// ---------------------------------------------------------------------------
// Caller API

// The survey the widget shows before a chat. Public (no login): callers see
// it. Retired options/fields are stripped server-side.
// Fail closed: without a helpline phone and emergency number in the profile
// the caller chat does not run at all (the caller page says so too).
const helplineNotReady = (_req, res, next) => (profile.profile().ready.helpline ? next()
  : res.status(503).json({ error: 'the chat is not available: this service has no helpline or emergency number configured', notConfigured: true }));

app.get('/api/prechat/form', helplineNotReady, h(async (_req, res) => {
  const form = await forms.currentForm('pre_chat');
  res.json({ name: form.name, version: form.version,
    schema: forms.publicSchema(form.schema) });
}));

app.post('/api/chat/start', helplineNotReady, h(async (req, res) => {
  if (!(await rl.allow('chat:' + rl.clientIp(req), 20, 10 * 60_000))) {
    return res.status(429).json({ error: 'too many requests' });
  }
  // Wizard-configured deployments: the page must show today's numbers. The
  // refusal carries the current safety message (with the numbers) so the
  // caller is never left without them, and is logged for the ops check.
  if (profile.base().features.setupWizard &&
      (req.body || {}).pageSafety !== profile.profile().safetyHash) {
    await db.eventLog('stale_page_refused', {});
    return res.status(409).json({ error: 'this page is out of date — reload it', stale: true,
      message: await db.getConfig('safety_valve_message') });
  }
  const { callerToken, alias, triage } = req.body || {};
  const result = await queue.joinQueue({
    callerToken,
    alias: String(alias || '').slice(0, 40) || undefined,
    triage,
  });
  res.json(result);
}));

app.post('/api/chat/message', h(async (req, res) => {
  const { chatToken, body, clientMsgId } = req.body || {};
  if (typeof body !== 'string' || !body.trim()) return res.status(400).json({ error: 'empty' });
  if (!(await rl.allow('msg:' + String(chatToken).slice(0, 16), 60, 60_000))) {
    return res.status(429).json({ error: 'slow down' });
  }
  const c = await db.get("SELECT id, outcome FROM contact WHERE chat_token = ? AND channel != 'voice'", [chatToken]);
  if (!c || c.outcome) return res.status(404).json({ error: 'chat not active' });
  await db.run('UPDATE contact SET caller_seen_at = ? WHERE id = ?', [db.now(), c.id]);
  const r = await storeMessage(c.id, 'caller', body.slice(0, 4000), clientMsgId);
  res.json(r);
}));

// Two ways a caller leaves: the pagehide beacon (tab closed — mark for the
// sweep, or free the queue spot), and the explicit "Leave chat" button,
// which ends the contact cleanly and tells the worker why it ended.
app.post('/api/chat/leave', h(async (req, res) => {
  const { chatToken, explicit } = req.body || {};
  const c = await db.get("SELECT id, worker_id, outcome FROM contact WHERE chat_token = ? AND channel != 'voice'",
    [String(chatToken || '')]);
  if (c && !c.outcome) {
    if (!c.worker_id) {
      await queue.endContact(c.id, 'abandoned');
    } else if (explicit) {
      await systemMessage(c.id, 'The caller left the chat.');
      await queue.endContact(c.id, 'completed');
    } else {
      await db.run('UPDATE contact SET caller_seen_at = ? WHERE id = ?',
        ['1970-01-01T00:00:00.000Z', c.id]);
    }
  }
  res.json({ ok: true });
}));

// Caller SSE stream: replay + position + connected + messages + end states.
app.get('/api/chat/stream', h(async (req, res) => {
  const contact = await db.get("SELECT * FROM contact WHERE chat_token = ? AND channel != 'voice'",
    [String(req.query.token || '')]);
  if (!contact) { res.status(404).end(); return; }
  sseInit(res);
  const state = {
    lastMsg: Number(req.query.since || 0),
    workerAnnounced: !!contact.worker_id,
    lastPos: null,
    closed: false,
  };

  const announceWorker = async (workerId) => {
    const w = await db.get('SELECT name, display_name FROM worker WHERE id = ?', [workerId]);
    sse(res, { type: 'connected', workerName: (w.display_name || w.name).split(' ')[0] });
  };

  // Every ending tells the caller something: a page left waiting silently
  // with no one coming is the worst outcome on a crisis line.
  const finish = async (row) => {
    if (row.outcome === 'timed_out') {
      sse(res, { type: 'safety_valve', body: await db.getConfig('safety_valve_message') });
    } else if (row.outcome === 'abandoned' && !row.worker_id) {
      // Their connection dropped while waiting (a sleeping phone, a closed
      // tab coming back): the place in the queue is gone. Say so, with the
      // numbers, rather than showing "you are number N" forever.
      sse(res, { type: 'safety_valve',
        body: 'Your place in the queue was lost because the connection dropped. ' +
          'Please reload this page to start again. ' + await db.getConfig('safety_valve_message') });
    } else {
      sse(res, { type: 'ended' });
    }
    res.end();
  };

  // Initial state
  if (contact.outcome) { await finish(contact); return; }
  await db.run('UPDATE contact SET caller_seen_at = ? WHERE id = ?', [db.now(), contact.id]);
  for (const m of await messagesFor(contact.id, state.lastMsg)) {
    state.lastMsg = Math.max(state.lastMsg, m.id);
    sse(res, { type: 'message', ...m, sentAt: m.sent_at });
  }
  if (contact.worker_id) await announceWorker(contact.worker_id);
  else {
    state.lastPos = await queue.queuePosition(contact.id);
    sse(res, { type: 'position', position: state.lastPos });
  }
  log('stream_caller_connect', { contactId: Number(contact.id) });

  const timer = setInterval(async () => {
    if (state.closed) return;
    try {
      let emitted = false;
      await db.run('UPDATE contact SET caller_seen_at = ? WHERE id = ? AND outcome IS NULL',
        [db.now(), contact.id]);
      queue.maybeSweep().catch(() => {});
      const row = await db.get('SELECT * FROM contact WHERE id = ?', [contact.id]);
      for (const m of await messagesFor(contact.id, state.lastMsg)) {
        state.lastMsg = Math.max(state.lastMsg, m.id);
        sse(res, { type: 'message', ...m, sentAt: m.sent_at });
        emitted = true;
      }
      if (row.outcome) { state.closed = true; clearInterval(timer); await finish(row); return; }
      if (row.worker_id && !state.workerAnnounced) {
        state.workerAnnounced = true;
        await announceWorker(row.worker_id);
        emitted = true;
      }
      if (!row.worker_id) {
        const pos = await queue.queuePosition(contact.id);
        if (pos !== state.lastPos) {
          state.lastPos = pos;
          if (pos !== null) { sse(res, { type: 'position', position: pos }); emitted = true; }
        }
      }
      if (!emitted) ping(res);
    } catch (e) {
      log('stream_caller_error', { error: String(e).slice(0, 200) });
    }
  }, 3000);

  req.on('close', () => {
    state.closed = true;
    clearInterval(timer);
    log('stream_caller_disconnect', { contactId: Number(contact.id) });
  });
}));

// ---------------------------------------------------------------------------
// Auth

app.post('/api/login', h(async (req, res) => {
  if (!(await rl.allow('login:' + rl.clientIp(req), 10, 15 * 60_000))) {
    return res.status(429).json({ error: 'too many attempts — wait a few minutes' });
  }
  const { email, password, totp } = req.body || {};
  const result = await auth.login(email, password, totp);
  if (!result) return res.status(401).json({ error: 'invalid credentials' });
  if (result.totpRequired) return res.status(401).json({ totpRequired: true });
  res.setHeader('Set-Cookie', cookieFor(result.token));
  const w = result.worker;
  res.json({ id: Number(w.id), name: w.name, role: w.role, mustChangePw: !!w.must_change_pw });
}));

// Email sign-in: ask for a code. The response is identical whether or not
// the address has an account, so this endpoint can't be used to probe for
// registered emails. Per-IP and per-address limits stop code spam.
app.post('/api/login/code', h(async (req, res) => {
  if (!mail.configured()) {
    return res.status(503).json({ error: 'email sign-in is not set up on this server — use your password' });
  }
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email required' });
  // Per-IP generous (a whole team can share one office IP), per-address tight.
  if (!(await rl.allow('code-ip:' + rl.clientIp(req), 30, 15 * 60_000)) ||
      !(await rl.allow('code-email:' + email, 3, 15 * 60_000))) {
    return res.status(429).json({ error: 'too many code requests — wait a few minutes' });
  }
  await auth.requestLoginCode(email, mail.send);
  res.json({ ok: true });
}));

// Email sign-in: redeem the code. Shares the password login's per-IP limit
// and answers with the same shapes.
app.post('/api/login/code/verify', h(async (req, res) => {
  if (!(await rl.allow('login:' + rl.clientIp(req), 10, 15 * 60_000))) {
    return res.status(429).json({ error: 'too many attempts — wait a few minutes' });
  }
  const { email, code, totp } = req.body || {};
  const result = await auth.loginWithCode(email, code, totp);
  if (!result) return res.status(401).json({ error: 'that code didn’t work — check it or request a new one' });
  if (result.totpRequired) return res.status(401).json({ totpRequired: true });
  res.setHeader('Set-Cookie', cookieFor(result.token));
  const w = result.worker;
  res.json({ id: Number(w.id), name: w.name, role: w.role, mustChangePw: !!w.must_change_pw });
}));

app.post('/api/logout', h(async (req, res) => {
  await auth.logout(req.sessionToken);
  res.setHeader('Set-Cookie', 'session=; Path=/; HttpOnly; Max-Age=0');
  res.json({ ok: true });
}));

app.get('/api/me', h(async (req, res) => {
  if (!req.worker) return res.status(401).json({ error: 'not logged in' });
  const w = req.worker;
  const supervisor = w.supervisor_id
    ? await db.get('SELECT name FROM worker WHERE id = ?', [w.supervisor_id]) : null;
  res.json({
    id: Number(w.id), name: w.name, role: w.role, status: w.status,
    mustChangePw: !!w.must_change_pw, totpEnabled: !!w.totp_enabled,
    phone: w.phone, privacy: !!w.privacy,
    notifyPrefs: JSON.parse(w.notify_prefs || '{}'),
    email: w.email, displayName: w.display_name,
    pronouns: w.pronouns, languages: w.languages,
    title: w.title, gender: w.gender, birthday: w.birthday,
    preferredLanguage: w.preferred_language, background: w.background,
    photo: w.photo,
    serviceStatus: w.service_status,
    dateStarted: w.date_started || (w.created_at || '').slice(0, 10),
    endOfService: w.end_of_service,
    supervisorName: supervisor ? supervisor.name : null,
    modules: modules.list(),
  });
}));

// Which modules this installation runs — public, so pages can adapt before
// sign-in (the landing page, the sign-in screen).
app.get('/api/modules', (_req, res) => res.json({ modules: modules.list() }));

// The organisation's public look and numbers (name, colours, logo, phone),
// for an outside page or app. Nothing operational.
app.get('/api/branding', (_req, res) => res.json(profile.publicBranding()));

// Admin → Organisation (profile feature "orgEditor"): coordinators override
// the plain display names from the config table. Numbers are not editable
// here — they live only in the profile file (see src/profile.js).
const ORG_LABELS = {
  name: 'Product name', shortName: 'Short name', longName: 'Full name',
  org: 'How text refers to the organisation', manual: 'Training manual name',
  website: 'Public website', 'mail.fromName': 'Email sender name',
};
const orgEditorOn = (_req, res, next) => (profile.profile().features.orgEditor ? next()
  : res.status(404).json({ error: 'the organisation editor is not enabled for this organisation' }));

app.get('/api/admin/organisation', auth.requireWorker, auth.requireRole('coordinator'), orgEditorOn, h(async (_req, res) => {
  const rows = await db.all(
    "SELECT key, value FROM config WHERE key LIKE 'brand.%' OR key LIKE 'org.%'");
  const saved = Object.fromEntries(rows.map((r) => [r.key.replace(/^(brand|org)\./, ''), r.value]));
  const p = profile.base(); // the file's values, shown as the defaults
  const get = (k) => k.split('.').reduce((o, x) => (o == null ? o : o[x]), p);
  res.json({
    profile: p.id,
    fields: profile.OVERRIDABLE.map((key) => ({
      key, label: ORG_LABELS[key] || key, profileValue: get(key) ?? null,
      override: saved[key] ?? null,
      // A saved value that fails today's checks is not in effect.
      ignored: saved[key] != null && !!profile.overrideError(key, saved[key]),
    })),
    numbers: (({ phone, emergency, timezone }) => ({ phone, emergency, timezone }))(profile.profile()),
  });
}));

app.put('/api/admin/organisation', auth.requireWorker, auth.requireRole('coordinator'), orgEditorOn, h(async (req, res) => {
  const { key, value } = req.body || {};
  if (!profile.OVERRIDABLE.includes(key)) return res.status(400).json({ error: 'unknown field' });
  const clear = value === null || value === undefined || String(value).trim() === '';
  if (!clear) {
    const err = profile.overrideError(key, String(value));
    if (err) return res.status(400).json({ error: `${ORG_LABELS[key] || key} ${err}` });
  }
  await db.run('DELETE FROM config WHERE key = ?', ['org.' + key]);
  if (clear) await db.run('DELETE FROM config WHERE key = ?', ['brand.' + key]);
  else {
    await db.run(`INSERT INTO config (key, value) VALUES (?, ?)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, ['brand.' + key, String(value).trim()]);
  }
  await profile.loadOverrides((sql) => db.all(sql));
  setup.requestRebuild('organisation edited').catch(() => {});
  await db.audit(req.worker.id, clear ? 'org_override_cleared' : 'org_override_set', 'config', null,
    clear ? key : `${key} = ${String(value).trim()}`);
  res.json({ ok: true, value: profile.brand(key) });
}));

app.post('/api/password', h(async (req, res) => {
  if (!req.worker) return res.status(401).json({ error: 'not logged in' });
  if (!(await rl.allow('password:' + req.worker.id, 10, 15 * 60_000))) {
    return res.status(429).json({ error: 'too many attempts — wait a few minutes' });
  }
  const { current, next } = req.body || {};
  if (!req.worker.must_change_pw &&
      !sec.verifyPassword(current, req.worker.password_hash)) {
    return res.status(403).json({ error: 'current password incorrect' });
  }
  const r = await auth.setPassword(req.worker.id, next);
  if (r.error) return res.status(400).json(r);
  await auth.endOtherSessions(req.worker.id, req.sessionToken);
  res.json({ ok: true });
}));

app.post('/api/totp/start', auth.requireWorker, h(async (req, res) => {
  const secret = sec.newTotpSecret();
  await db.run('UPDATE worker SET totp_secret = ?, totp_enabled = 0 WHERE id = ?',
    [sec.encrypt(secret), req.worker.id]);
  const otpauth = sec.otpauthUrl(secret, req.worker.email, profile.brand('name'));
  // A scannable QR beats typing a 32-character secret; generated server-side
  // so the page needs no CDN. The data URL goes only to this logged-in worker.
  const qr = await require('qrcode')
    .toDataURL(otpauth, { margin: 1, width: 220 })
    .catch(() => null);
  res.json({ secret, otpauth, qr });
}));

app.post('/api/totp/confirm', auth.requireWorker, h(async (req, res) => {
  const w = await db.get('SELECT totp_secret FROM worker WHERE id = ?', [req.worker.id]);
  if (!w.totp_secret || !sec.verifyTotp(sec.decrypt(w.totp_secret), req.body.code)) {
    return res.status(400).json({ error: 'code did not match — try again' });
  }
  await db.run('UPDATE worker SET totp_enabled = 1 WHERE id = ?', [req.worker.id]);
  await db.audit(req.worker.id, 'totp_enabled');
  res.json({ ok: true });
}));

app.post('/api/profile', auth.requireWorker, h(async (req, res) => {
  const { phone, privacy, notifyPrefs, displayName, pronouns, languages,
    title, gender, birthday, preferredLanguage, background, photo } = req.body || {};
  // The photo is a small data URL the browser produced by resizing the
  // chosen image — never a caller-facing asset, and capped so a giant
  // original can't be smuggled into the row. Empty string clears it.
  // 60k chars ≈ a 45KB image — generous for the 192px square the browser
  // sends, and safely under express's JSON body limit.
  if (photo !== undefined && photo !== '' &&
      !(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(String(photo)) &&
        String(photo).length <= 60_000)) {
    return res.status(400).json({ error: 'photo must be a small image' });
  }
  const text = (v, cap) => (v !== undefined ? String(v).slice(0, cap) : null);
  await db.run(
    `UPDATE worker SET phone = COALESCE(?, phone), privacy = COALESCE(?, privacy),
       notify_prefs = COALESCE(?, notify_prefs),
       display_name = COALESCE(?, display_name),
       pronouns = COALESCE(?, pronouns), languages = COALESCE(?, languages),
       title = COALESCE(?, title), gender = COALESCE(?, gender),
       birthday = COALESCE(?, birthday),
       preferred_language = COALESCE(?, preferred_language),
       background = COALESCE(?, background), photo = COALESCE(?, photo)
     WHERE id = ?`,
    [text(phone, 40),
      privacy !== undefined ? (privacy ? 1 : 0) : null,
      notifyPrefs !== undefined ? JSON.stringify(notifyPrefs) : null,
      text(displayName, 60),
      text(pronouns, 40),
      text(languages, 120),
      text(title, 60),
      text(gender, 40),
      text(birthday, 20),
      text(preferredLanguage, 40),
      text(background, 2000),
      photo !== undefined ? String(photo) : null,
      req.worker.id]);
  res.json({ ok: true });
}));

// The email-notification catalogue My profile offers (kind + label).
app.get('/api/notify-kinds', auth.requireWorker, h(async (_req, res) => {
  res.json(EMAIL_PREFS.map(([kind, label]) => ({ kind, label })));
}));

// My own shift statistics, shaped like iCarol's table.
app.get('/api/schedule/my-stats', auth.requireWorker, h(async (req, res) => {
  res.json(await schedule.myStats(req.worker.id));
}));

// ---------------------------------------------------------------------------
// Skills & achievements (iCarol's profile section): workers keep their own
// list, coordinators can manage anyone's via ?workerId / body.workerId.

const skillRow = (s) => ({
  id: Number(s.id), workerId: Number(s.worker_id), category: s.category,
  title: s.title, dueOn: s.due_on, status: s.status,
  statusChanged: s.status_changed, notes: s.notes,
});

function skillTargetWorker(req, requested) {
  const want = Number(requested || req.worker.id);
  if (want !== Number(req.worker.id) && req.worker.role !== 'coordinator') return null;
  return want;
}

app.get('/api/skills', auth.requireWorker, h(async (req, res) => {
  const target = skillTargetWorker(req, req.query.workerId);
  if (!target) return res.status(403).json({ error: 'not yours to view' });
  const rows = await db.all(
    'SELECT * FROM skill_achievement WHERE worker_id = ? ORDER BY due_on NULLS LAST, id',
    [target]);
  res.json(rows.map(skillRow));
}));

app.post('/api/skills', auth.requireWorker, h(async (req, res) => {
  const { category, title, dueOn, status, notes, workerId } = req.body || {};
  const target = skillTargetWorker(req, workerId);
  if (!target) return res.status(403).json({ error: 'not yours to edit' });
  if (!String(category || '').trim() || !String(title || '').trim()) {
    return res.status(400).json({ error: 'category and title required' });
  }
  const st = ['to_be_done', 'in_progress', 'completed'].includes(status) ? status : 'to_be_done';
  const id = await db.insert(
    `INSERT INTO skill_achievement (worker_id, category, title, due_on, status,
       status_changed, notes, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [target, String(category).slice(0, 60), String(title).slice(0, 120),
      dueOn ? String(dueOn).slice(0, 10) : null, st, db.now().slice(0, 10),
      notes ? String(notes).slice(0, 500) : null, db.now()]);
  await db.audit(req.worker.id, 'skill_added', 'skill_achievement', id);
  res.json({ id });
}));

app.patch('/api/skills/:id', auth.requireWorker, h(async (req, res) => {
  const row = await db.get('SELECT * FROM skill_achievement WHERE id = ?', [Number(req.params.id)]);
  if (!row || !skillTargetWorker(req, row.worker_id)) {
    return res.status(404).json({ error: 'no such entry' });
  }
  const { category, title, dueOn, status, notes } = req.body || {};
  const st = ['to_be_done', 'in_progress', 'completed'].includes(status) ? status : null;
  if (st) {
    await db.run(
      `UPDATE skill_achievement SET
         status_changed = CASE WHEN status != ? THEN ? ELSE status_changed END,
         status = ?
       WHERE id = ?`,
      [st, db.now().slice(0, 10), st, Number(req.params.id)]);
  }
  await db.run(
    `UPDATE skill_achievement SET
       category = COALESCE(?, category), title = COALESCE(?, title),
       due_on = COALESCE(?, due_on), notes = COALESCE(?, notes)
     WHERE id = ?`,
    [category !== undefined ? String(category).slice(0, 60) : null,
      title !== undefined ? String(title).slice(0, 120) : null,
      dueOn !== undefined ? String(dueOn).slice(0, 10) : null,
      notes !== undefined ? String(notes).slice(0, 500) : null,
      Number(req.params.id)]);
  await db.audit(req.worker.id, 'skill_updated', 'skill_achievement', Number(req.params.id));
  res.json({ ok: true });
}));

app.delete('/api/skills/:id', auth.requireWorker, h(async (req, res) => {
  const row = await db.get('SELECT * FROM skill_achievement WHERE id = ?', [Number(req.params.id)]);
  if (!row || !skillTargetWorker(req, row.worker_id)) {
    return res.status(404).json({ error: 'no such entry' });
  }
  await db.run('DELETE FROM skill_achievement WHERE id = ?', [Number(req.params.id)]);
  await db.audit(req.worker.id, 'skill_deleted', 'skill_achievement', Number(row.id));
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Worker API

app.post('/api/status', auth.requireWorker, auth.requireRole('worker'), h(async (req, res) => {
  const { status } = req.body || {};
  if (!['off', 'on_shift', 'backup'].includes(status)) {
    return res.status(400).json({ error: 'bad status' });
  }
  await queue.setStatus(req.worker.id, status);
  log('worker_status', { workerId: Number(req.worker.id), status });
  res.json({ ok: true, status });
}));

// Everything the console needs about a caller beyond this contact:
// active directives, how many times they've contacted today, and the
// referrals made to them on past contacts.
async function callerContext(callerId, excludeContactId) {
  const directives = (await db.all(
    `SELECT id, alert_level, body, created_at FROM directive
     WHERE caller_id = ? AND retired_at IS NULL ORDER BY
       CASE alert_level WHEN 'alert' THEN 0 WHEN 'caution' THEN 1 ELSE 2 END, id DESC`,
    [callerId])).map((d) => ({
    id: Number(d.id), alertLevel: d.alert_level,
    body: sec.decrypt(d.body), createdAt: d.created_at,
  }));
  const today = await db.get(
    'SELECT COUNT(*) AS n FROM contact WHERE caller_id = ? AND queued_at >= ?',
    [callerId, new Date(tz.dayStart()).toISOString()]);
  const previousReferrals = await db.all(
    `SELECT resource.id, resource.name, resource.category, contact_referral.created_at
     FROM contact_referral
     JOIN resource ON resource.id = contact_referral.resource_id
     JOIN contact ON contact.id = contact_referral.contact_id
     WHERE contact.caller_id = ? AND contact.id != ?
     ORDER BY contact_referral.created_at DESC LIMIT 20`,
    [callerId, excludeContactId || 0]);
  return { directives, contactsToday: Number(today.n), previousReferrals };
}

async function referralsFor(contactId) {
  return db.all(
    `SELECT resource.id, resource.name, resource.category
     FROM contact_referral JOIN resource ON resource.id = contact_referral.resource_id
     WHERE contact_id = ? ORDER BY contact_referral.created_at`, [contactId]);
}

app.post('/api/claim/:contactId', auth.requireWorker, auth.requireRole('worker'), h(async (req, res) => {
  const contactId = Number(req.params.contactId);
  const contact = await queue.claim(contactId, req.worker);
  if (!contact) return res.status(409).json({ error: 'already claimed or gone' });
  await db.audit(req.worker.id, 'contact_claim', 'contact', contactId);

  const caller = await db.get('SELECT * FROM caller WHERE id = ?', [contact.caller_id]);
  const history = await db.all(
    `SELECT id, queued_at, ended_at, outcome, intake_status FROM contact
     WHERE caller_id = ? AND id != ? ORDER BY queued_at DESC LIMIT 10`,
    [contact.caller_id, contactId]);

  const displayName = (req.worker.display_name || req.worker.name).split(' ')[0];
  await systemMessage(contactId, `Connected to support worker ${displayName}.`);
  res.json({
    contactId,
    callerId: Number(contact.caller_id),
    alias: caller.alias,
    triage: queue.triageOf(contact),
    prechat: (await prechatInfo(contact)).pairs,
    queueWaitSecs: contact.queue_wait_secs,
    intake: queue.intakeOf(contact),
    history,
    messages: await messagesFor(contactId),
    form: await forms.currentForm('chat_intake'),
    referrals: await referralsFor(contactId),
    ...await callerContext(contact.caller_id, contactId),
  });
}));

app.get('/api/my-chats', auth.requireWorker, h(async (req, res) => {
  const chats = await queue.activeChats(req.worker.id);
  const form = chats.length ? await forms.currentForm('chat_intake') : null;
  res.json(await Promise.all(chats.map(async (c) => ({
    contactId: Number(c.id),
    callerId: Number(c.caller_id),
    // The console shows a live call like a phone intake (no chat composer).
    channel: c.channel === 'voice' ? 'phone' : (c.channel || 'chat'),
    ...(c.channel === 'voice' ? { voice: true } : {}),
    alias: c.alias,
    triage: queue.triageOf(c),
    prechat: (await prechatInfo(c)).pairs,
    intake: queue.intakeOf(c),
    intakeStatus: c.intake_status,
    messages: await messagesFor(c.id),
    form,
    referrals: await referralsFor(c.id),
    ...await callerContext(c.caller_id, c.id),
  }))));
}));

app.post('/api/worker/message', auth.requireWorker, auth.requireRole('worker'), h(async (req, res) => {
  const { contactId, body, clientMsgId } = req.body || {};
  if (typeof body !== 'string' || !body.trim()) return res.status(400).json({ error: 'empty' });
  const c = await db.get('SELECT worker_id, outcome FROM contact WHERE id = ?', [Number(contactId)]);
  if (!c || c.outcome || Number(c.worker_id) !== Number(req.worker.id)) {
    return res.status(404).json({ error: 'not your active contact' });
  }
  const r = await storeMessage(Number(contactId), 'worker', body.slice(0, 4000), clientMsgId);
  res.json(r);
}));

app.patch('/api/intake/:contactId', auth.requireWorker, auth.requireRole('worker'), h(async (req, res) => {
  const contactId = Number(req.params.contactId);
  const own = await db.get('SELECT id, channel, ended_at FROM contact WHERE id = ? AND worker_id = ?',
    [contactId, req.worker.id]);
  if (!own) return res.status(404).json({ error: 'not your contact' });
  const submit = req.body.submit === true;
  const intake = req.body.intake || {};
  // Phase 2 intakes carry {form, version, answers}; the columns record which
  // definition the record was written under so it always renders against it.
  const answers = intake.answers || {};
  await db.run(
    // A draft autosave never turns a submitted intake back into a draft (one
    // can land just after Submit if the worker was still typing).
    `UPDATE contact SET intake_json = ?,
       intake_status = CASE WHEN ? THEN 'submitted'
         WHEN intake_status IN ('submitted','reviewed') THEN intake_status ELSE 'draft' END,
       form_name = COALESCE(?, form_name), form_version = COALESCE(?, form_version),
       highlight = ?
     WHERE id = ?`,
    [sec.encrypt(JSON.stringify(intake)), submit,
      intake.form || null, intake.version || null,
      answers.highlight === true ? 1 : 0, contactId]);
  // A phone intake is the whole contact: submitting it ends the call. No
  // queue wait is recorded, so phone calls stay out of the chat wait times.
  if (submit && own.channel === 'phone' && !own.ended_at) {
    await db.run(
      `UPDATE contact SET ended_at = ?, outcome = 'completed' WHERE id = ? AND outcome IS NULL`,
      [db.now(), contactId]);
  }
  if (submit) {
    await db.eventLog('intake_submitted', { contactId, workerId: req.worker.id });
    await db.audit(req.worker.id, 'intake_submit', 'contact', contactId);
    log('intake_submitted', { contactId, highlight: answers.highlight === true });
    // "Would you like your supervisor to follow up with you?" — yes opens a
    // QA item supervisors see, instead of relying on someone noticing a field.
    if (answers.supervisor_followup === 'yes') {
      const existing = await db.get(
        'SELECT id FROM feedback WHERE contact_id = ? AND requested = 1', [contactId]);
      if (!existing) {
        await db.insert(
          'INSERT INTO feedback (contact_id, worker_id, requested, created_at) VALUES (?,?,1,?)',
          [contactId, req.worker.id, db.now()]);
        await db.eventLog('feedback_requested', { contactId, workerId: req.worker.id });
      }
    }
  }
  res.json({ ok: true, status: submit ? 'submitted' : 'draft' });
}));

// ---------------------------------------------------------------------------
// Voice (module "voice", opt-in; src/voice). Calls share the chat queue;
// answering one opens the phone intake beside it.

const voiceReply = (res, r) => (r.status ? res.status(r.status).json(r) : res.json(r));

// Provider webhooks: signed, no session, exempt from the UAT passcode.
app.post('/api/voice/webhook/:provider', h(async (req, res) => {
  if (!(await rl.allow('voicehook:' + rl.clientIp(req), 120, 60_000))) {
    return res.status(429).json({ error: 'too many requests' });
  }
  const r = await voice.handleWebhook(req.params.provider, req.headers, req.rawBody, req.body);
  // Call traffic alone must keep the queue moving (overflow, backup pages)
  // on a serverless host with no console open.
  await queue.maybeSweep().catch(() => {});
  voiceReply(res, r);
}));

app.get('/api/voice/token', auth.requireWorker, h(async (req, res) => {
  const p = await voice.provider();
  res.json(await p.issueClientToken('worker-' + req.worker.id));
}));

app.get('/api/voice/state', auth.requireWorker, h(async (req, res) => {
  await queue.maybeSweep().catch(() => {});
  res.json(await voice.state(req.worker));
}));

app.post('/api/voice/answer/:contactId', auth.requireWorker, auth.requireRole('worker'), h(async (req, res) => {
  if (!profile.profile().ready.helpline) return res.status(503).json({ error: 'helpline not configured' });
  const r = await voice.answer(Number(req.params.contactId), req.worker);
  if (r.status) return voiceReply(res, r);
  const c = await db.get('SELECT * FROM contact WHERE id = ?', [r.contactId]);
  const caller = await db.get('SELECT alias FROM caller WHERE id = ?', [c.caller_id]);
  res.json({
    contactId: r.contactId,
    callerId: Number(c.caller_id),
    channel: 'phone', // the console's intake-only view
    voice: true,
    alias: caller.alias,
    triage: {},
    prechat: [],
    intake: queue.intakeOf(c),
    intakeStatus: c.intake_status,
    history: [],
    messages: [],
    form: await forms.currentForm('chat_intake'),
    referrals: await referralsFor(c.id),
    ...await callerContext(c.caller_id, c.id),
  });
}));

app.post('/api/voice/hangup/:contactId', auth.requireWorker, h(async (req, res) =>
  voiceReply(res, await voice.hangup(Number(req.params.contactId), req.worker))));

app.post('/api/voice/hold/:contactId', auth.requireWorker, h(async (req, res) =>
  voiceReply(res, await voice.hold(Number(req.params.contactId), req.worker, !!(req.body || {}).on))));

app.post('/api/voice/monitor/:contactId', auth.requireWorker, auth.requireRole('supervisor'), h(async (req, res) =>
  voiceReply(res, await voice.monitor(Number(req.params.contactId), req.worker))));

app.get('/api/voice/settings', auth.requireWorker, auth.requireRole('coordinator'), h(async (_req, res) =>
  res.json({ ...(await voice.settings()), providers: voice.providerList() })));

app.put('/api/voice/settings', auth.requireWorker, auth.requireRole('coordinator'), h(async (req, res) =>
  voiceReply(res, await voice.setSettings(req.body || {}, req.worker))));

// "Call us" from the caller page. The browser gets a secret call token (the
// contact's chat_token), sent in request bodies (never a URL, so it stays
// out of access logs), to follow and end its own call. Polling it keeps the
// call alive and drives the sweep; a closed tab ends it (pagehide beacon, or
// the stale rule). The mock provider only takes these in demo mode.
app.get('/api/voice/available', h(async (_req, res) => {
  res.json({ available: profile.profile().ready.helpline && await voice.takesRealCalls(),
    test: (await voice.provider()).testOnly === true });
}));

app.post('/api/voice/web-call', helplineNotReady, h(async (req, res) => {
  if (!(await rl.allow('webcall:' + rl.clientIp(req), 6, 10 * 60_000))) {
    return res.status(429).json({ error: 'too many calls — please wait a few minutes' });
  }
  if (profile.base().features.setupWizard &&
      (req.body || {}).pageSafety !== profile.profile().safetyHash) {
    return res.status(409).json({ error: 'this page is out of date — reload it', stale: true });
  }
  if (!(await voice.takesRealCalls())) return res.status(503).json({ error: 'calls are not available' });
  const p = await voice.provider();
  const ev = p.parseWebhook({ event: 'inbound', web: true });
  const r = await voice.inbound(ev);
  if (r.refused || !r.contactId) return res.status(503).json({ error: 'calls are not available' });
  const c = await db.get('SELECT chat_token FROM contact WHERE id = ?', [r.contactId]);
  res.json({ callToken: c.chat_token, provider: p.name, test: p.testOnly === true,
    client: await p.issueClientToken('caller-' + r.contactId) });
}));

const webCallOf = (req) => db.get(`SELECT * FROM contact WHERE chat_token = ? AND channel = 'voice'`,
  [String((req.body || {}).token || '')]);

app.post('/api/voice/web-call/status', h(async (req, res) => {
  const c = await webCallOf(req);
  if (!c) return res.status(404).json({ error: 'no such call' });
  if (!c.ended_at) {
    await db.run('UPDATE contact SET caller_seen_at = ? WHERE id = ?', [db.now(), c.id]);
    await queue.maybeSweep().catch(() => {});
  }
  const now = await db.get('SELECT * FROM contact WHERE id = ?', [c.id]);
  const state = now.ended_at ? 'ended' : (now.worker_id ? 'connected' : 'waiting');
  res.json({ state, outcome: now.outcome || null,
    position: state === 'waiting' ? await queue.queuePosition(now.id) : null,
    message: now.outcome === 'timed_out' ? await db.getConfig('safety_valve_message') : null });
}));

app.post('/api/voice/web-call/hangup', express.text({ type: 'text/plain' }), h(async (req, res) => {
  // sendBeacon on pagehide posts text/plain JSON.
  if (typeof req.body === 'string') { try { req.body = JSON.parse(req.body); } catch { req.body = {}; } }
  const c = await webCallOf(req);
  if (!c) return res.status(404).json({ error: 'no such call' });
  const p = await voice.provider();
  await p.hangup(c.voice_call_id, { by: 'caller' }).catch(() => {});
  await voice.onHangup(c.voice_call_id);
  res.json({ ok: true });
}));

// Mock provider only: ring the queue with a pretend call, so staff can try
// the call panel. Refused for any real provider.
app.post('/api/voice/demo-call', auth.requireWorker, auth.requireRole('supervisor'), h(async (req, res) => {
  const p = await voice.provider();
  if (p.name !== 'mock') return res.status(400).json({ error: 'demo calls need the mock provider' });
  const ev = p.parseWebhook({ event: 'inbound', from: (req.body || {}).from || '+00 0000 0042' });
  voiceReply(res, { ok: true, callId: ev.callId, ...(await voice.inbound(ev)) });
}));

// Phone shifts: the worker starts an intake themselves — no queue, no chat,
// no pre-chat survey to prefill from. One open at a time; asking again
// returns the open one. The caller is an anonymous record ("Phone call"),
// so directives, follow-ups and referrals work as they do for chats.
app.post('/api/phone-intake', auth.requireWorker, auth.requireRole('worker'), h(async (req, res) => {
  let c = await db.get(
    `SELECT * FROM contact WHERE worker_id = ? AND channel = 'phone' AND ended_at IS NULL
     ORDER BY id DESC LIMIT 1`, [req.worker.id]);
  if (!c) {
    const nowIso = db.now();
    const callerId = await db.insert(
      'INSERT INTO caller (token, alias, first_seen) VALUES (?,?,?)',
      [crypto.randomUUID(), 'Phone call', nowIso]);
    const id = await db.insert(
      `INSERT INTO contact (caller_id, worker_id, chat_token, queued_at, claimed_at, channel)
       VALUES (?,?,?,?,?,'phone')`,
      [callerId, req.worker.id, crypto.randomUUID(), nowIso, nowIso]);
    await db.audit(req.worker.id, 'phone_intake_started', 'contact', id);
    await db.eventLog('phone_intake_started', { contactId: id, workerId: req.worker.id });
    c = await db.get('SELECT * FROM contact WHERE id = ?', [id]);
  }
  res.json({
    contactId: Number(c.id),
    callerId: Number(c.caller_id),
    channel: 'phone',
    alias: 'Phone call',
    triage: {},
    prechat: [],
    intake: queue.intakeOf(c),
    intakeStatus: c.intake_status,
    history: [],
    messages: [],
    form: await forms.currentForm('chat_intake'),
    referrals: await referralsFor(c.id),
    ...await callerContext(c.caller_id, c.id),
  });
}));

// Throw away a phone intake started by mistake (never one already submitted).
app.delete('/api/phone-intake/:contactId', auth.requireWorker, auth.requireRole('worker'), h(async (req, res) => {
  const id = Number(req.params.contactId);
  const c = await db.get(
    `SELECT * FROM contact WHERE id = ? AND worker_id = ? AND channel = 'phone'`, [id, req.worker.id]);
  if (!c) return res.status(404).json({ error: 'not your phone intake' });
  if (c.intake_status !== 'draft') return res.status(409).json({ error: 'already submitted' });
  for (const t of ['contact_referral', 'contact_observer', 'message', 'feedback']) {
    await db.run(`DELETE FROM ${t} WHERE contact_id = ?`, [id]);
  }
  for (const t of ['help_request', 'followup']) {
    await db.run(`UPDATE ${t} SET contact_id = NULL WHERE contact_id = ?`, [id]);
  }
  await db.run('DELETE FROM contact WHERE id = ?', [id]);
  const others = await db.get('SELECT COUNT(*) AS n FROM contact WHERE caller_id = ?', [c.caller_id]);
  const dirs = await db.get('SELECT COUNT(*) AS n FROM directive WHERE caller_id = ?', [c.caller_id]);
  const fus = await db.get('SELECT COUNT(*) AS n FROM followup WHERE caller_id = ?', [c.caller_id]);
  if (!Number(others.n) && !Number(dirs.n) && !Number(fus.n)) {
    await db.run('DELETE FROM caller WHERE id = ?', [c.caller_id]);
  }
  await db.audit(req.worker.id, 'phone_intake_discarded', 'contact', id);
  res.json({ ok: true });
}));

app.post('/api/end/:contactId', auth.requireWorker, auth.requireRole('worker'), h(async (req, res) => {
  const contactId = Number(req.params.contactId);
  const own = await db.get('SELECT id FROM contact WHERE id = ? AND worker_id = ?',
    [contactId, req.worker.id]);
  if (!own) return res.status(404).json({ error: 'not your contact' });
  await queue.endContact(contactId, 'completed');
  res.json({ ok: true });
}));

// Canned responses (src/canned.js): everyone sees the shared ones plus their
// own; workers manage their own, supervisors and coordinators the shared ones.
const cannedReply = (res, r) => (r.error ? res.status(r.status || 400).json({ error: r.error }) : res.json(r));
app.get('/api/canned', auth.requireWorker, h(async (req, res) => {
  res.json(await canned.list(req.worker));
}));

app.post('/api/canned', auth.requireWorker, auth.requireRole('worker'), h(async (req, res) => {
  cannedReply(res, await canned.create(req.worker, req.body || {}));
}));

app.post('/api/canned/starter', auth.requireWorker, auth.requireRole('supervisor'), h(async (req, res) => {
  cannedReply(res, await canned.addStarter(req.worker));
}));

app.patch('/api/canned/:id', auth.requireWorker, auth.requireRole('worker'), h(async (req, res) => {
  cannedReply(res, await canned.update(req.worker, Number(req.params.id), req.body || {}));
}));

app.delete('/api/canned/:id', auth.requireWorker, auth.requireRole('worker'), h(async (req, res) => {
  cannedReply(res, await canned.remove(req.worker, Number(req.params.id)));
}));

app.post('/api/help', auth.requireWorker, auth.requireRole('worker'), h(async (req, res) => {
  const { contactId, note } = req.body || {};
  await db.insert(
    'INSERT INTO help_request (contact_id, worker_id, note, created_at) VALUES (?,?,?,?)',
    [contactId || null, req.worker.id, note || null, db.now()]);
  await db.eventLog('help_requested', { contactId: contactId || null, workerId: req.worker.id });
  log('help_requested', { workerId: Number(req.worker.id) });
  const staff = await db.all(
    `SELECT id FROM worker WHERE (role IN ('supervisor','coordinator') OR status = 'backup')
       AND service_status = 'in_service'`);
  notifyOut('help_requested', staff.map((s) => Number(s.id)), {
    from: (req.worker.display_name || req.worker.name).split(' ')[0],
  }).catch(() => {});
  res.json({ ok: true });
}));

app.post('/api/help/:id/resolve', auth.requireWorker, auth.requireRole('supervisor'), h(async (req, res) => {
  await db.run('UPDATE help_request SET resolved_at = ? WHERE id = ?',
    [db.now(), Number(req.params.id)]);
  res.json({ ok: true });
}));

// Trainee observation
app.get('/api/observers/online', auth.requireWorker, h(async (_req, res) => {
  // "Online" on serverless = has an in-service trainee account; the invite
  // reaches them next stream tick if their console is open.
  res.json(await db.all(
    `SELECT id, name FROM worker WHERE role = 'trainee' AND service_status = 'in_service'`));
}));

app.post('/api/observe/:contactId', auth.requireWorker, auth.requireRole('worker'), h(async (req, res) => {
  const contactId = Number(req.params.contactId);
  const c = await db.get('SELECT * FROM contact WHERE id = ? AND ended_at IS NULL', [contactId]);
  const isSupervisor = auth.ROLE_RANK[req.worker.role] >= auth.ROLE_RANK.supervisor;
  if (!c || (Number(c.worker_id) !== Number(req.worker.id) && !isSupervisor)) {
    return res.status(404).json({ error: 'no such active contact' });
  }
  const trainee = await db.get(`SELECT * FROM worker WHERE id = ? AND role = 'trainee'`,
    [Number(req.body.traineeId)]);
  if (!trainee) return res.status(400).json({ error: 'not a trainee' });
  await db.run('INSERT INTO contact_observer (contact_id, worker_id) VALUES (?,?) ON CONFLICT DO NOTHING',
    [contactId, trainee.id]);
  await db.audit(req.worker.id, 'observer_added', 'contact', contactId);
  res.json({ ok: true });
}));

// Worker SSE stream: queue state, messages for owned/observed contacts,
// backup pages, help requests, observation starts, caller staleness.
app.get('/api/worker/stream', h(async (req, res) => {
  const worker = await auth.workerFromToken(auth.parseCookies(req.headers.cookie).session);
  if (!worker || worker.must_change_pw) { res.status(401).end(); return; }
  sseInit(res);
  log('stream_worker_connect', { workerId: Number(worker.id) });

  const maxMsg = await db.get('SELECT COALESCE(MAX(id), 0) AS m FROM message');
  const maxHelp = await db.get('SELECT COALESCE(MAX(id), 0) AS m FROM help_request');
  const state = {
    closed: false,
    lastQueueJson: '',
    lastMsgId: Number(maxMsg.m),
    lastHelpId: Number(maxHelp.m),
    sentPages: new Set(),
    knownObs: new Set(),
    staleWarned: new Set(),
  };

  // Existing observations replay immediately (trainee reconnect).
  const existingObs = await db.all(
    'SELECT contact_id FROM contact_observer JOIN contact ON contact.id = contact_id ' +
    'WHERE contact_observer.worker_id = ? AND contact.ended_at IS NULL', [worker.id]);
  for (const o of existingObs) {
    state.knownObs.add(Number(o.contact_id));
    sse(res, {
      type: 'observe_start', contactId: Number(o.contact_id),
      messages: await messagesFor(o.contact_id),
    });
  }
  sse(res, await queueStateMsg());

  const tick = async () => {
    if (state.closed) return;
    let emitted = false;
    queue.maybeSweep().catch(() => {});

    const qmsg = await queueStateMsg();
    const qjson = JSON.stringify(qmsg);
    if (qjson !== state.lastQueueJson) {
      state.lastQueueJson = qjson;
      res.write(`data: ${qjson}\n\n`);
      emitted = true;
    }

    // New observations
    const obs = await db.all(
      'SELECT contact_id FROM contact_observer JOIN contact ON contact.id = contact_id ' +
      'WHERE contact_observer.worker_id = ? AND contact.ended_at IS NULL', [worker.id]);
    for (const o of obs) {
      const cid = Number(o.contact_id);
      if (!state.knownObs.has(cid)) {
        state.knownObs.add(cid);
        sse(res, { type: 'observe_start', contactId: cid, messages: await messagesFor(cid) });
        emitted = true;
      }
    }

    // Messages for owned + observed contacts. Relevance comes from the
    // message's own contact row, not the active-chats snapshot: a claim or
    // an ending (caller pressed Leave) inside one tick window would
    // otherwise drop the messages that raced it.
    const active = await queue.activeChats(worker.id);
    const fresh = await db.all(
      `SELECT message.*, contact.worker_id AS contact_worker_id FROM message
       JOIN contact ON contact.id = message.contact_id
       WHERE message.id > ? ORDER BY message.id`, [state.lastMsgId]);
    for (const m of fresh) {
      state.lastMsgId = Math.max(state.lastMsgId, Number(m.id));
      if (Number(m.contact_worker_id) === Number(worker.id) ||
          state.knownObs.has(Number(m.contact_id))) {
        sse(res, {
          type: 'message', id: Number(m.id), contactId: Number(m.contact_id),
          sender: m.sender, body: sec.decrypt(m.body),
          client_msg_id: m.client_msg_id, sentAt: m.sent_at,
        });
        emitted = true;
      }
    }

    // Backup pages (program-scoped, non-trainee, on-call)
    if (worker.status === 'backup' && worker.role !== 'trainee') {
      for (const w of qmsg.waiting) {
        if (w.paged && !state.sentPages.has(w.contactId)) {
          const contact = await db.get('SELECT * FROM contact WHERE id = ?', [w.contactId]);
          if (contact && (await queue.backupsFor(contact)).some((b) => Number(b.id) === Number(worker.id))) {
            state.sentPages.add(w.contactId);
            sse(res, { type: 'page', contactId: w.contactId, alias: w.alias, queuedAt: w.queuedAt });
            emitted = true;
          }
        }
      }
    }

    // Caller gone quiet on an active chat
    const staleAfter = Number(await db.getConfig('caller_stale_after_secs'));
    for (const c of active) {
      // A live call has no caller stream; the provider reports its hangup.
      if (c.channel === 'voice') continue;
      const cid = Number(c.id);
      const seenAgo = c.caller_seen_at ? (Date.now() - Date.parse(c.caller_seen_at)) / 1000 : 0;
      if (seenAgo > Math.min(60, staleAfter) && !state.staleWarned.has(cid)) {
        state.staleWarned.add(cid);
        sse(res, { type: 'caller_disconnected', contactId: cid });
        emitted = true;
      } else if (seenAgo < 10 && state.staleWarned.has(cid)) {
        state.staleWarned.delete(cid); // caller came back
      }
    }

    // Help requests for supervisors/coordinators/backups
    if (auth.ROLE_RANK[worker.role] >= auth.ROLE_RANK.supervisor || worker.status === 'backup') {
      const helps = await db.all(
        `SELECT help_request.id, note, worker.name AS from_name, help_request.worker_id
         FROM help_request JOIN worker ON worker.id = help_request.worker_id
         WHERE help_request.id > ? AND resolved_at IS NULL ORDER BY help_request.id`,
        [state.lastHelpId]);
      for (const hr of helps) {
        state.lastHelpId = Math.max(state.lastHelpId, Number(hr.id));
        if (Number(hr.worker_id) !== Number(worker.id)) {
          sse(res, { type: 'help', id: Number(hr.id), from: hr.from_name, note: hr.note || '' });
          emitted = true;
        }
      }
    }

    if (!emitted) ping(res);
  };

  const timer = setInterval(() => {
    tick().catch((e) => log('stream_worker_error', { error: String(e).slice(0, 200) }));
  }, 2000);

  req.on('close', () => {
    state.closed = true;
    clearInterval(timer);
    log('stream_worker_disconnect', { workerId: Number(worker.id) });
  });
}));

// ---------------------------------------------------------------------------
// Phase 2: forms (versioned, coordinator-editable)

app.get('/api/form/:name', auth.requireWorker, h(async (req, res) => {
  const version = req.query.version ? Number(req.query.version) : null;
  const form = version
    ? await forms.formVersion(req.params.name, version)
    : await forms.currentForm(req.params.name);
  if (!form) return res.status(404).json({ error: 'no such form' });
  res.json(form);
}));

app.post('/api/admin/forms/:name', auth.requireWorker, auth.requireRole('coordinator'), h(async (req, res) => {
  const r = await forms.saveNewVersion(req.params.name, req.body.schema, req.worker.id);
  if (r.error) return res.status(400).json(r);
  log('form_def_saved', { form: r.name, version: r.version, actor: Number(req.worker.id) });
  res.json(r);
}));

// ---------------------------------------------------------------------------
// Phase 2: caller directives

app.post('/api/directives', auth.requireWorker, auth.requireRole('supervisor'), h(async (req, res) => {
  const { callerId, alertLevel = 'info', body } = req.body || {};
  if (!callerId || !body || !['info', 'caution', 'alert'].includes(alertLevel)) {
    return res.status(400).json({ error: 'callerId, body and a valid alertLevel required' });
  }
  const caller = await db.get('SELECT id FROM caller WHERE id = ?', [Number(callerId)]);
  if (!caller) return res.status(404).json({ error: 'no such caller' });
  const id = await db.insert(
    'INSERT INTO directive (caller_id, alert_level, body, created_by, created_at) VALUES (?,?,?,?,?)',
    [Number(callerId), alertLevel, sec.encrypt(String(body).slice(0, 2000)),
      req.worker.id, db.now()]);
  await db.audit(req.worker.id, 'directive_created', 'directive', id);
  res.json({ id });
}));

// Shift-start review list (TELL Manual ch.24: "Read the Users with
// Directives... to make sure you are familiar with the ways to respond").
// Any logged-in worker or trainee can read it — same audience as iCarol.
app.get('/api/directives/active', auth.requireWorker, h(async (_req, res) => {
  const rows = await db.all(
    `SELECT directive.id, directive.alert_level, directive.body,
            directive.created_at, caller.alias
     FROM directive JOIN caller ON caller.id = directive.caller_id
     WHERE retired_at IS NULL
     ORDER BY CASE alert_level WHEN 'alert' THEN 0 WHEN 'caution' THEN 1 ELSE 2 END,
       directive.id DESC`);
  res.json(rows.map((d) => ({
    id: Number(d.id), alias: d.alias, alertLevel: d.alert_level,
    body: sec.decrypt(d.body), createdAt: d.created_at,
  })));
}));

app.post('/api/directives/:id/retire', auth.requireWorker, auth.requireRole('supervisor'), h(async (req, res) => {
  const r = await db.run(
    'UPDATE directive SET retired_at = ?, retired_by = ? WHERE id = ? AND retired_at IS NULL',
    [db.now(), req.worker.id, Number(req.params.id)]);
  if (!r.changes) return res.status(404).json({ error: 'no active directive with that id' });
  await db.audit(req.worker.id, 'directive_retired', 'directive', Number(req.params.id));
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Phase 2: referral directory + per-contact referrals

app.get('/api/resources', auth.requireWorker, h(async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const wantSuggested = req.query.status === 'suggested' &&
    auth.ROLE_RANK[req.worker.role] >= auth.ROLE_RANK.coordinator;
  const rows = await db.all(
    `SELECT id, name, category, description, url, phone, languages, status
     FROM resource WHERE status = ? ORDER BY category, name`,
    [wantSuggested ? 'suggested' : 'active']);
  const filtered = q
    ? rows.filter((r) => `${r.name} ${r.category} ${r.description || ''}`
        .toLowerCase().includes(q))
    : rows;
  res.json(filtered);
}));

// Workers suggest; coordinators create directly. Mirrors the live Chatboard
// "Additions to iCarol Resources" propose→approve workflow, as a button.
app.post('/api/resources', auth.requireWorker, auth.requireRole('worker'), h(async (req, res) => {
  const { name, category = '', description, phone, languages } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  // Links open from the console: web addresses only (no javascript: links).
  const url = cleanUrl(String(req.body.url || '').trim());
  if (url === null) return res.status(400).json({ error: "that isn't a web address" });
  const isCoordinator = auth.ROLE_RANK[req.worker.role] >= auth.ROLE_RANK.coordinator;
  const id = await db.insert(
    `INSERT INTO resource (name, category, description, url, phone, languages, status, suggested_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [String(name).slice(0, 200), String(category).slice(0, 200), description || null,
      url || null, phone || null, languages || null,
      isCoordinator ? 'active' : 'suggested',
      isCoordinator ? null : req.worker.id, db.now()]);
  await db.audit(req.worker.id, isCoordinator ? 'resource_created' : 'resource_suggested',
    'resource', id);
  res.json({ id, status: isCoordinator ? 'active' : 'suggested' });
}));

// CSV import into the directory (coordinators): preview with apply=false,
// then the same file with apply=true. See src/resourceimport.js.
app.post('/api/resources/import', auth.requireWorker, auth.requireRole('coordinator'), h(async (req, res) => {
  const { csv, apply, updateExisting } = req.body || {};
  const r = await importResources(csv, { apply: apply === true, updateExisting: updateExisting === true },
    req.worker.id);
  if (r.error) return res.status(400).json(r);
  res.json(r);
}));

app.patch('/api/resources/:id', auth.requireWorker, auth.requireRole('coordinator'), h(async (req, res) => {
  const id = Number(req.params.id);
  const row = await db.get('SELECT id FROM resource WHERE id = ?', [id]);
  if (!row) return res.status(404).json({ error: 'no such resource' });
  const { name, category, description, phone, languages, status } = req.body || {};
  let url = req.body.url;
  if (url !== undefined && url !== null) {
    url = cleanUrl(String(url).trim());
    if (url === null) return res.status(400).json({ error: "that isn't a web address" });
  }
  if (status && !['active', 'suggested', 'retired'].includes(status)) {
    return res.status(400).json({ error: 'bad status' });
  }
  await db.run(
    `UPDATE resource SET name = COALESCE(?, name), category = COALESCE(?, category),
       description = COALESCE(?, description), url = COALESCE(?, url),
       phone = COALESCE(?, phone), languages = COALESCE(?, languages),
       status = COALESCE(?, status)
     WHERE id = ?`,
    [name || null, category !== undefined ? category : null, description !== undefined ? description : null,
      url !== undefined ? url : null, phone !== undefined ? phone : null,
      languages !== undefined ? languages : null, status || null, id]);
  await db.audit(req.worker.id, 'resource_updated', 'resource', id);
  res.json({ ok: true });
}));

app.post('/api/referral', auth.requireWorker, auth.requireRole('worker'), h(async (req, res) => {
  const { contactId, resourceId } = req.body || {};
  const own = await db.get('SELECT id FROM contact WHERE id = ? AND worker_id = ?',
    [Number(contactId), req.worker.id]);
  if (!own) return res.status(404).json({ error: 'not your contact' });
  const resource = await db.get(`SELECT id FROM resource WHERE id = ? AND status = 'active'`,
    [Number(resourceId)]);
  if (!resource) return res.status(404).json({ error: 'no such active resource' });
  await db.run(
    'INSERT INTO contact_referral (contact_id, resource_id, created_at) VALUES (?,?,?) ON CONFLICT DO NOTHING',
    [Number(contactId), Number(resourceId), db.now()]);
  await db.eventLog('referral_made', { contactId: Number(contactId), workerId: req.worker.id });
  res.json({ ok: true });
}));

app.delete('/api/referral', auth.requireWorker, auth.requireRole('worker'), h(async (req, res) => {
  const { contactId, resourceId } = req.body || {};
  const own = await db.get('SELECT id FROM contact WHERE id = ? AND worker_id = ?',
    [Number(contactId), req.worker.id]);
  if (!own) return res.status(404).json({ error: 'not your contact' });
  await db.run('DELETE FROM contact_referral WHERE contact_id = ? AND resource_id = ?',
    [Number(contactId), Number(resourceId)]);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Phase 2: manual follow-ups

app.post('/api/followups', auth.requireWorker, auth.requireRole('worker'), h(async (req, res) => {
  const { contactId, callerId, dueAt, note, assignedTo } = req.body || {};
  let cid = Number(callerId) || null;
  if (contactId) {
    const c = await db.get('SELECT caller_id FROM contact WHERE id = ?', [Number(contactId)]);
    if (c) cid = Number(c.caller_id);
  }
  if (!cid || !dueAt || Number.isNaN(Date.parse(dueAt))) {
    return res.status(400).json({ error: 'callerId (or contactId) and a valid dueAt required' });
  }
  const id = await db.insert(
    `INSERT INTO followup (caller_id, contact_id, assigned_to, due_at, note, created_by, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    [cid, contactId ? Number(contactId) : null,
      Number(assignedTo) || req.worker.id, new Date(dueAt).toISOString(),
      note ? sec.encrypt(String(note).slice(0, 2000)) : null,
      req.worker.id, db.now()]);
  await db.audit(req.worker.id, 'followup_created', 'followup', id);
  const assignee = Number(assignedTo) || req.worker.id;
  if (assignee !== Number(req.worker.id)) {
    notifyOut('followup_assigned', [assignee],
      { due: tz.dateIn(new Date(dueAt).getTime()) }).catch(() => {});
  }
  res.json({ id });
}));

app.get('/api/followups', auth.requireWorker, h(async (req, res) => {
  const all = req.query.all === '1' &&
    auth.ROLE_RANK[req.worker.role] >= auth.ROLE_RANK.supervisor;
  const rows = await db.all(
    `SELECT followup.*, worker.name AS assigned_name, caller.alias
     FROM followup
     JOIN worker ON worker.id = followup.assigned_to
     JOIN caller ON caller.id = followup.caller_id
     WHERE followup.status = 'open' ${all ? '' : 'AND followup.assigned_to = ?'}
     ORDER BY followup.due_at`, all ? [] : [req.worker.id]);
  res.json(rows.map((f) => ({
    id: Number(f.id), callerId: Number(f.caller_id),
    contactId: f.contact_id ? Number(f.contact_id) : null,
    assignedTo: Number(f.assigned_to), assignedName: f.assigned_name,
    alias: f.alias, dueAt: f.due_at, note: f.note ? sec.decrypt(f.note) : null,
    overdue: Date.parse(f.due_at) < Date.now(),
  })));
}));

app.post('/api/followups/:id/done', auth.requireWorker, auth.requireRole('worker'), h(async (req, res) => {
  const f = await db.get(`SELECT * FROM followup WHERE id = ? AND status = 'open'`,
    [Number(req.params.id)]);
  if (!f) return res.status(404).json({ error: 'no open follow-up with that id' });
  const isSupervisor = auth.ROLE_RANK[req.worker.role] >= auth.ROLE_RANK.supervisor;
  if (Number(f.assigned_to) !== Number(req.worker.id) && !isSupervisor) {
    return res.status(403).json({ error: 'not yours' });
  }
  const status = req.body.cancel === true ? 'cancelled' : 'done';
  await db.run('UPDATE followup SET status = ?, done_at = ? WHERE id = ?',
    [status, db.now(), f.id]);
  await db.audit(req.worker.id, 'followup_' + status, 'followup', Number(f.id));
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Phase 2: supervisor QA + "My feedback"

// Review queue: requested-feedback items first, then recent submitted
// intakes not yet reviewed.
app.get('/api/review/queue', auth.requireWorker, auth.requireRole('supervisor'), h(async (_req, res) => {
  const requested = await db.all(
    `SELECT feedback.id AS feedback_id, feedback.contact_id, feedback.created_at,
            feedback.sent_at, worker.name AS worker_name, caller.alias
     FROM feedback
     JOIN contact ON contact.id = feedback.contact_id
     JOIN worker ON worker.id = feedback.worker_id
     JOIN caller ON caller.id = contact.caller_id
     WHERE feedback.requested = 1 AND feedback.sent_at IS NULL
     ORDER BY feedback.id`);
  const submitted = await db.all(
    `SELECT contact.id AS contact_id, contact.ended_at, contact.highlight,
            worker.name AS worker_name, caller.alias
     FROM contact
     JOIN worker ON worker.id = contact.worker_id
     JOIN caller ON caller.id = contact.caller_id
     WHERE intake_status = 'submitted'
     ORDER BY contact.id DESC LIMIT 50`);
  res.json({
    requested: requested.map((r) => ({
      feedbackId: Number(r.feedback_id), contactId: Number(r.contact_id),
      workerName: r.worker_name, alias: r.alias, createdAt: r.created_at,
    })),
    submitted: submitted.map((r) => ({
      contactId: Number(r.contact_id), workerName: r.worker_name,
      alias: r.alias, endedAt: r.ended_at, highlight: !!r.highlight,
    })),
  });
}));

// Full contact view for review: intake (against its form version),
// transcript, triage. Supervisor-only — same trust level that reviews
// contacts in iCarol today; the access lands in the audit log.
app.get('/api/review/contact/:id', auth.requireWorker, auth.requireRole('supervisor'), h(async (req, res) => {
  const c = await db.get(
    `SELECT contact.*, caller.alias, worker.name AS worker_name
     FROM contact JOIN caller ON caller.id = contact.caller_id
     LEFT JOIN worker ON worker.id = contact.worker_id
     WHERE contact.id = ?`, [Number(req.params.id)]);
  if (!c) return res.status(404).json({ error: 'no such contact' });
  await db.audit(req.worker.id, 'review_contact_viewed', 'contact', Number(c.id));
  const intake = queue.intakeOf(c);
  const form = c.form_name
    ? await forms.formVersion(c.form_name, Number(c.form_version))
    : await forms.currentForm('chat_intake');
  res.json({
    contactId: Number(c.id), alias: c.alias, workerName: c.worker_name,
    queuedAt: c.queued_at, endedAt: c.ended_at, outcome: c.outcome,
    queueWaitSecs: c.queue_wait_secs, intakeStatus: c.intake_status,
    highlight: !!c.highlight, triage: queue.triageOf(c),
    prechat: (await prechatInfo(c)).pairs, intake, form,
    referrals: await referralsFor(c.id),
    messages: await messagesFor(c.id),
  });
}));

app.post('/api/review/feedback', auth.requireWorker, auth.requireRole('supervisor'), h(async (req, res) => {
  const { contactId, body, feedbackId } = req.body || {};
  if (!body) return res.status(400).json({ error: 'feedback body required' });
  let row = feedbackId
    ? await db.get('SELECT * FROM feedback WHERE id = ?', [Number(feedbackId)])
    : null;
  if (!row) {
    const c = await db.get('SELECT id, worker_id FROM contact WHERE id = ?', [Number(contactId)]);
    if (!c || !c.worker_id) return res.status(404).json({ error: 'no such handled contact' });
    const id = await db.insert(
      'INSERT INTO feedback (contact_id, worker_id, requested, created_at) VALUES (?,?,0,?)',
      [Number(c.id), Number(c.worker_id), db.now()]);
    row = await db.get('SELECT * FROM feedback WHERE id = ?', [id]);
  }
  await db.run(
    'UPDATE feedback SET supervisor_id = ?, body = ?, sent_at = ? WHERE id = ?',
    [req.worker.id, sec.encrypt(String(body).slice(0, 4000)), db.now(), Number(row.id)]);
  await db.run(`UPDATE contact SET intake_status = 'reviewed' WHERE id = ? AND intake_status = 'submitted'`,
    [Number(row.contact_id)]);
  await db.audit(req.worker.id, 'feedback_sent', 'feedback', Number(row.id));
  notifyOut('feedback_left', [Number(row.worker_id)], {}).catch(() => {});
  res.json({ ok: true, feedbackId: Number(row.id) });
}));

app.get('/api/my-feedback', auth.requireWorker, h(async (req, res) => {
  const rows = await db.all(
    `SELECT feedback.*, supervisor.name AS supervisor_name
     FROM feedback LEFT JOIN worker supervisor ON supervisor.id = feedback.supervisor_id
     WHERE feedback.worker_id = ? AND feedback.sent_at IS NOT NULL
     ORDER BY feedback.id DESC LIMIT 20`, [req.worker.id]);
  res.json(rows.map((f) => ({
    id: Number(f.id), contactId: Number(f.contact_id),
    supervisorName: f.supervisor_name, body: f.body ? sec.decrypt(f.body) : null,
    sentAt: f.sent_at, acknowledged: !!f.acknowledged_at,
  })));
}));

app.post('/api/my-feedback/:id/ack', auth.requireWorker, h(async (req, res) => {
  const r = await db.run(
    'UPDATE feedback SET acknowledged_at = ? WHERE id = ? AND worker_id = ? AND acknowledged_at IS NULL',
    [db.now(), Number(req.params.id), req.worker.id]);
  if (!r.changes) return res.status(404).json({ error: 'nothing to acknowledge' });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Phase 3: shift calendar

app.get('/api/shifts', auth.requireWorker, h(async (_req, res) =>
  res.json(await schedule.shiftDefs())));

app.post('/api/availability', auth.requireWorker, h(async (req, res) => {
  const r = await schedule.submitAvailability(req.worker.id, req.body || {});
  if (r.error) return res.status(400).json(r);
  res.json(r);
}));

// Mine for a month; supervisors+ can read everyone's (the "general
// availability sheet" workers use to find swap partners is name+shifts only,
// so any worker may read the roster view too — matching TELL's SW site).
app.get('/api/availability', auth.requireWorker, h(async (req, res) => {
  const month = String(req.query.month || '');
  if (req.query.all === '1') {
    return res.json(await schedule.availabilityFor(month));
  }
  const mine = await schedule.availabilityFor(month, req.worker.id);
  res.json(mine[0] || null);
}));

app.get('/api/schedule', auth.requireWorker, h(async (req, res) => {
  const month = String(req.query.month || '');
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM' });
  const notes = await db.all(
    'SELECT date, note FROM schedule_note WHERE date LIKE ?', [month + '-%']);
  res.json({
    month,
    shifts: await schedule.shiftDefs(),
    slots: await schedule.monthSlots(month),
    dayNotes: Object.fromEntries(notes.map((n) => [n.date, n.note])),
  });
}));

// Day notes — the margin notes TELL writes on the scheduling sheet
// ("Group 1 7pm"). One per date; an empty note removes it. Supervisors and
// coordinators manage the calendar; only generating the month stays
// coordinator-only.
app.post('/api/schedule/day-note', auth.requireWorker, auth.requireRole('supervisor'), h(async (req, res) => {
  const { date, note } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    return res.status(400).json({ error: 'date=YYYY-MM-DD' });
  }
  const text = String(note || '').slice(0, 120).trim();
  if (!text) {
    await db.run('DELETE FROM schedule_note WHERE date = ?', [date]);
  } else {
    await db.run(
      `INSERT INTO schedule_note (date, note) VALUES (?,?)
       ON CONFLICT (date) DO UPDATE SET note = EXCLUDED.note`, [date, text]);
  }
  await db.audit(req.worker.id, 'day_note_set', 'schedule_note', null,
    `${date}: ${text || 'removed'}`);
  res.json({ ok: true });
}));

// The coordinator's audit trail of schedule changes: who did what, when.
app.get('/api/schedule/audit', auth.requireWorker, auth.requireRole('coordinator'), h(async (req, res) => {
  res.json(await schedule.scheduleAudit(req.query.limit, req.query.before));
}));

// Who hasn't submitted availability for a month (names only), and a
// deliberate one-off chase email to exactly those people. The chase is a
// staff request, not a subscription, so it does not consult notify_prefs.
app.get('/api/availability/missing', auth.requireWorker, auth.requireRole('supervisor'), h(async (req, res) => {
  const month = String(req.query.month || '');
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM' });
  res.json((await schedule.availabilityMissing(month)).map(({ id, name }) => ({ id, name })));
}));

app.post('/api/availability/remind', auth.requireWorker, auth.requireRole('supervisor'), h(async (req, res) => {
  const month = String((req.body || {}).month || '');
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM' });
  if (!mail.configured()) return res.status(400).json({ error: 'email is not configured' });
  const missing = await schedule.availabilityMissing(month);
  const sent = await mail.sendMany(missing.map((w) => ({
    to: w.email,
    subject: profile.brand('name') + ' — availability needed for ' + month,
    text: `Hello ${w.name},\n\nYou haven't submitted your availability for ${month} yet. ` +
      'Please do so on the schedule page — even if you are away, submit it so the ' +
      'scheduler knows.\n\n' +
      ((process.env.TL_BASE_URL || '').replace(/\/+$/, '') + '/schedule.html') +
      '\n\nThank you!',
  })));
  await db.audit(req.worker.id, 'availability_reminded', 'availability', null,
    `${month}: ${sent} of ${missing.length} reminded`);
  res.json({ missing: missing.length, sent });
}));

// Cover broadcast for a shift whose holder can't make it: GET returns the
// templated message and who it would reach (names only); POST sends it, one
// email per person so nobody sees anyone else's address. A deliberate staff
// request like the availability chase, so notify_prefs are not consulted;
// one broadcast per slot per 15 minutes guards against double sends.
const coverBase = () => process.env.TL_BASE_URL || '';

app.get('/api/schedule/slot/:id/cover-broadcast', auth.requireWorker, auth.requireRole('supervisor'), h(async (req, res) => {
  const d = await schedule.coverDraft(Number(req.params.id), req.worker, coverBase());
  if (d.error) return res.status(409).json(d);
  res.json({ subject: d.subject, body: d.body, lastSentAt: d.lastSentAt,
    recipients: d.recipients.map((r) => r.name), mailConfigured: mail.configured() });
}));

app.post('/api/schedule/slot/:id/cover-broadcast', auth.requireWorker, auth.requireRole('supervisor'), h(async (req, res) => {
  const subject = String((req.body || {}).subject || '').trim().slice(0, 150);
  const body = String((req.body || {}).body || '').trim().slice(0, 3000);
  if (!subject || !body) return res.status(400).json({ error: 'subject and message are both needed' });
  if (!mail.configured()) return res.status(400).json({ error: 'email is not configured' });
  const d = await schedule.coverDraft(Number(req.params.id), req.worker, coverBase());
  if (d.error) return res.status(409).json(d);
  if (d.lastSentAt && Date.now() - Date.parse(d.lastSentAt) < schedule.COVER_BROADCAST_GAP_MS) {
    return res.status(429).json({ error: 'A cover email went out for this shift in the last 15 minutes.' });
  }
  // Mark before sending so a double click can't send twice.
  await db.audit(req.worker.id, 'cover_broadcast', 'shift_slot', Number(d.slot.id),
    `sending to ${d.recipients.length}`);
  const sent = await mail.sendMany(d.recipients.map((r) => ({ to: r.email, subject, text: body })));
  await db.run(
    `UPDATE audit_log SET detail = ? WHERE id = (SELECT MAX(id) FROM audit_log
       WHERE action = 'cover_broadcast' AND entity_id = ?)`,
    [`${sent} of ${d.recipients.length} emailed`, Number(d.slot.id)]);
  res.json({ sent, recipients: d.recipients.length });
}));

app.get('/api/schedule/mine', auth.requireWorker, h(async (req, res) =>
  res.json(await schedule.mySlots(req.worker.id))));

app.post('/api/schedule/generate', auth.requireWorker, auth.requireRole('coordinator'), h(async (req, res) => {
  const month = String((req.body || {}).month || '');
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM' });
  res.json(await schedule.generateMonth(month, req.worker.id));
}));

// A supervision block's weekly pattern: which weekdays it runs and its
// hours on each. Used when slots are created from now on.
// With the profile's shiftEditor feature, also a shift's name, hours,
// takeover time and default mode (src/schedule.js updateShiftDef).
const SHIFT_FIELDS = ['label', 'start', 'end', 'takeover', 'mode'];
const shiftEditorOn = (_req, res, next) => (profile.profile().features.shiftEditor ? next()
  : res.status(404).json({ error: 'the shift editor is not enabled for this organisation' }));
// (PATCH below checks the same switch only when shift fields are sent, so
// the seats and supervisor-pattern edits keep working everywhere.)

app.delete('/api/shift-defs/:number', auth.requireWorker, auth.requireRole('coordinator'), shiftEditorOn, h(async (req, res) => {
  const r = await schedule.removeShiftDef(Number(req.params.number), req.worker.id);
  if (r.error) return res.status(400).json(r);
  res.json(r);
}));

app.post('/api/shift-defs', auth.requireWorker, auth.requireRole('coordinator'), shiftEditorOn, h(async (req, res) => {
  const r = await schedule.createShiftDef(req.body || {}, req.worker.id);
  if (r.error) return res.status(400).json(r);
  res.json(r);
}));

app.patch('/api/shift-defs/:number', auth.requireWorker, auth.requireRole('coordinator'), h(async (req, res) => {
  const body = req.body || {};
  if (SHIFT_FIELDS.some((k) => body[k] !== undefined)) {
    if (!profile.profile().features.shiftEditor) {
      return res.status(404).json({ error: 'the shift editor is not enabled for this organisation' });
    }
    const r = await schedule.updateShiftDef(Number(req.params.number), body, req.worker.id);
    if (r.error) return res.status(400).json(r);
    return res.json(r);
  }
  const r = body.seats !== undefined
    ? await schedule.setSeats(Number(req.params.number), body.seats, req.worker.id)
    : await schedule.setSupervisionPattern(Number(req.params.number), body.days, req.worker.id);
  if (r.error) return res.status(400).json(r);
  res.json(r);
}));

// Auto-fill the month's open worker slots from submitted availability.
// Without apply it only returns the draft for the coordinator to review.
app.post('/api/schedule/autofill', auth.requireWorker, auth.requireRole('coordinator'), h(async (req, res) => {
  const { month, apply } = req.body || {};
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) {
    return res.status(400).json({ error: 'month=YYYY-MM' });
  }
  if (!apply) return res.json(await schedule.proposeAssignments(month));
  res.json(await schedule.applyAssignments(month, req.worker.id));
}));

// Assignment roster for the schedule page: names, roles, service status and
// email (so staff can contact people about their availability) — nothing
// else from the admin page (no phone, TOTP state or supervisor links).
app.get('/api/schedule/workers', auth.requireWorker, auth.requireRole('supervisor'), h(async (_req, res) => {
  res.json(await db.all(
    'SELECT id, name, role, service_status, email FROM worker ORDER BY name'));
}));

app.post('/api/schedule/slot', auth.requireWorker, auth.requireRole('supervisor'), h(async (req, res) => {
  const { date, shiftNumber, role = 'worker' } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ||
      !schedule.SLOT_ROLES.includes(role)) {
    return res.status(400).json({ error: 'date and a valid role required' });
  }
  const defs = await schedule.shiftDefs();
  const def = defs.find((d) => d.number === Number(shiftNumber));
  if (!def) return res.status(400).json({ error: 'no such shift' });
  // A supervision block is a supervisor slot by definition, and carries its
  // hours for that day (the block's defaults on a day the pattern is off).
  const isOcs = def.kind === 'supervision';
  const slotRole = isOcs ? 'supervisor' : role;
  const times = isOcs ? (schedule.timesOn(def, date) || { start: def.start, end: def.end }) : null;
  const id = await db.insert(
    `INSERT INTO shift_slot (date, shift_number, role, start_time, end_time, created_at)
     VALUES (?,?,?,?,?,?)`,
    [date, Number(shiftNumber), slotRole, times ? times.start : null,
      times ? times.end : null, db.now()]);
  await db.audit(req.worker.id, 'slot_created', 'shift_slot', id,
    slotRole !== 'worker' ? slotRole : null);
  res.json({ id });
}));

app.patch('/api/schedule/slot/:id', auth.requireWorker, auth.requireRole('supervisor'), h(async (req, res) => {
  const { workerId, cancel, note, start, end } = req.body || {};
  if (start !== undefined || end !== undefined) {
    // One slot's hours ("Friday's session runs 21:00-02:00"); both empty
    // returns a worker slot to its definition's hours.
    const clear = !start && !end;
    if (!clear && !(schedule.isHHMM(start) && schedule.isHHMM(end) && start !== end)) {
      return res.status(400).json({ error: 'start and end must be HH:MM and differ' });
    }
    const r = await db.run('UPDATE shift_slot SET start_time = ?, end_time = ?, times_stamped = 0 WHERE id = ?',
      [clear ? null : start, clear ? null : end, Number(req.params.id)]);
    if (!r.changes) return res.status(404).json({ error: 'no such slot' });
    await db.audit(req.worker.id, 'slot_times_set', 'shift_slot', Number(req.params.id),
      clear ? 'back to standard hours' : `${start}–${end}`);
    if (workerId === undefined && cancel === undefined && note === undefined) {
      return res.json({ ok: true });
    }
  }
  if (note !== undefined) {
    const text = String(note).slice(0, 60).trim();
    const r = await db.run('UPDATE shift_slot SET note = ? WHERE id = ?',
      [text || null, Number(req.params.id)]);
    if (!r.changes) return res.status(404).json({ error: 'no such slot' });
    await db.audit(req.worker.id, 'slot_note_set', 'shift_slot', Number(req.params.id),
      text ? `"${text}"` : 'removed');
    if (workerId === undefined && cancel === undefined) return res.json({ ok: true });
  }
  if (cancel === true) {
    const r = await db.run(
      `UPDATE shift_slot SET status = 'cancelled' WHERE id = ?`, [Number(req.params.id)]);
    if (!r.changes) return res.status(404).json({ error: 'no such slot' });
    await db.audit(req.worker.id, 'slot_cancelled', 'shift_slot', Number(req.params.id));
    return res.json({ ok: true });
  }
  const r = await schedule.assign(Number(req.params.id),
    workerId === null ? null : Number(workerId), req.worker.id);
  if (r.error) return res.status(400).json(r);
  res.json(r);
}));

app.post('/api/schedule/slot/:id/confirm', auth.requireWorker, h(async (req, res) => {
  const ok = await schedule.confirm(Number(req.params.id), req.worker.id);
  if (!ok) return res.status(404).json({ error: 'not your unconfirmed slot' });
  res.json({ ok: true });
}));

app.post('/api/schedule/slot/:id/sub-request', auth.requireWorker, h(async (req, res) => {
  const r = await schedule.requestSub(Number(req.params.id), req.worker);
  if (r.error) return res.status(400).json(r);
  res.json(r);
}));

app.post('/api/schedule/slot/:id/take', auth.requireWorker, h(async (req, res) => {
  const r = await schedule.takeSub(Number(req.params.id), req.worker);
  if (r.error) return res.status(409).json(r);
  res.json(r);
}));

app.get('/api/schedule/stats', auth.requireWorker, h(async (req, res) => {
  const isStaff = auth.ROLE_RANK[req.worker.role] >= auth.ROLE_RANK.supervisor;
  res.json(await schedule.stats(isStaff && req.query.all === '1' ? null : req.worker.id));
}));

app.get('/api/my-cal-token', auth.requireWorker, h(async (req, res) =>
  res.json({ token: await schedule.calTokenFor(req.worker.id) })));

app.get('/api/schedule/ics/:token', h(async (req, res) => {
  const ics = await schedule.icsFor(req.params.token);
  if (!ics) return res.status(404).end();
  res.set('Content-Type', 'text/calendar; charset=utf-8').send(ics);
}));

// ---------------------------------------------------------------------------
// Phase 3: noticeboard

app.get('/api/board', auth.requireWorker, h(async (req, res) =>
  res.json(await board.topicsFor(req.worker.id))));

app.get('/api/board/unread', auth.requireWorker, h(async (req, res) =>
  res.json({ unread: await board.unreadTotal(req.worker.id) })));

app.get('/api/board/topics/:id', auth.requireWorker, h(async (req, res) => {
  const t = await board.readTopic(Number(req.params.id), req.worker.id);
  if (!t) return res.status(404).json({ error: 'no such topic' });
  res.json(t);
}));

app.post('/api/board/topics/:id/posts', auth.requireWorker, h(async (req, res) => {
  const r = await board.post(Number(req.params.id), req.worker.id, (req.body || {}).body);
  if (r.error) return res.status(400).json(r);
  res.json(r);
}));

app.post('/api/board/topics', auth.requireWorker, auth.requireRole('supervisor'), h(async (req, res) => {
  const { name, pinned } = req.body || {};
  const r = await board.createTopic(name, req.worker.id, pinned === true);
  if (r.error) return res.status(400).json(r);
  res.json(r);
}));

app.post('/api/board/topics/:id/pin', auth.requireWorker, auth.requireRole('supervisor'), h(async (req, res) => {
  const ok = await board.setPinned(Number(req.params.id), (req.body || {}).pinned !== false,
    req.worker.id);
  if (!ok) return res.status(404).json({ error: 'no such topic' });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Phase 2: service reporting (aggregates only — no content, no names)

app.get('/api/reports', auth.requireWorker, auth.requireRole('supervisor'), h(async (req, res) => {
  // From/to are the organisation's calendar days, midnight to midnight local.
  const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(v)) ? String(v) : null);
  const from = day(req.query.from) && new Date(tz.wallToUtc(day(req.query.from), '00:00')).toISOString();
  const to = day(req.query.to) && new Date(tz.wallToUtc(day(req.query.to), '00:00', tz.zone(), 1)).toISOString();
  if (!from || !to) return res.status(400).json({ error: 'from and to dates required' });

  const contacts = await db.all(
    'SELECT * FROM contact WHERE queued_at >= ? AND queued_at < ?', [from, to]);
  const waits = contacts.map((c) => c.queue_wait_secs)
    .filter((w) => w !== null && w !== undefined).map(Number).sort((a, b) => a - b);
  const pct = (p) => waits.length
    ? waits[Math.min(waits.length - 1, Math.floor((p / 100) * waits.length))] : null;

  // Per-field answer counts across submitted intakes, labelled against each
  // record's own form version so renamed options report correctly. Only
  // option-typed fields aggregate — free text (textarea/text and the *_other
  // companions) is content and never reaches a report.
  const fieldCounts = {};
  const formCache = new Map();
  const formFor = async (c) => {
    const key = `${c.form_name || 'chat_intake'}@${c.form_version || 'current'}`;
    if (!formCache.has(key)) {
      formCache.set(key, c.form_name && c.form_version
        ? await forms.formVersion(c.form_name, Number(c.form_version))
        : await forms.currentForm('chat_intake'));
    }
    return formCache.get(key);
  };
  let submitted = 0;
  for (const c of contacts) {
    if (!['submitted', 'reviewed'].includes(c.intake_status)) continue;
    submitted += 1;
    const intake = queue.intakeOf(c);
    const form = await formFor(c);
    const fields = form ? forms.fieldsOf(form.schema) : [];
    for (const [fieldId, value] of Object.entries(intake.answers || {})) {
      if (value === null || value === undefined || value === '' || value === false) continue;
      const field = fields.find((f) => f.id === fieldId);
      if (!field) continue; // unknown ids (incl. *_other free text) stay out
      if (field.type === 'checkbox') {
        fieldCounts[fieldId] = fieldCounts[fieldId] || {};
        fieldCounts[fieldId].Yes = (fieldCounts[fieldId].Yes || 0) + 1;
        continue;
      }
      if (!Array.isArray(field.options) || !field.options.length) continue;
      const values = Array.isArray(value) ? value : [value];
      for (const v of values) {
        const opt = field.options.find((o) => o.id === v);
        const label = opt ? opt.label : String(v);
        fieldCounts[fieldId] = fieldCounts[fieldId] || {};
        fieldCounts[fieldId][label] = (fieldCounts[fieldId][label] || 0) + 1;
      }
    }
  }

  const referrals = await db.get(
    `SELECT COUNT(*) AS n FROM contact_referral WHERE created_at >= ? AND created_at < ?`,
    [from, to]);

  res.json({
    range: { from: req.query.from, to: req.query.to },
    contacts: {
      total: contacts.length,
      phone: contacts.filter((c) => c.channel === 'phone').length,
      completed: contacts.filter((c) => c.outcome === 'completed').length,
      abandoned: contacts.filter((c) => c.outcome === 'abandoned').length,
      timed_out: contacts.filter((c) => c.outcome === 'timed_out').length,
      highlighted: contacts.filter((c) => c.highlight).length,
      intakes_submitted: submitted,
    },
    waits: { p50_secs: pct(50), p95_secs: pct(95) },
    referrals_made: Number(referrals.n),
    fields: fieldCounts,
  });
}));

// ---------------------------------------------------------------------------
// Admin (coordinator only)

app.get('/api/admin/workers', auth.requireWorker, auth.requireRole('coordinator'), h(async (_req, res) => {
  res.json(await db.all(
    `SELECT worker.id, email, worker.name, role, service_status, status, phone,
            totp_enabled, must_change_pw, supervisor_id, support_group,
            (SELECT string_agg(program.name, ',') FROM worker_program
              JOIN program ON program.id = worker_program.program_id
              WHERE worker_program.worker_id = worker.id) AS programs
     FROM worker ORDER BY worker.name`));
}));

async function upsertPrograms(workerId, programNames) {
  await db.run('DELETE FROM worker_program WHERE worker_id = ?', [workerId]);
  for (const name of programNames) {
    await db.run('INSERT INTO program (name) VALUES (?) ON CONFLICT (name) DO NOTHING', [name.trim()]);
    const p = await db.get('SELECT id FROM program WHERE name = ?', [name.trim()]);
    await db.run('INSERT INTO worker_program (worker_id, program_id) VALUES (?,?) ON CONFLICT DO NOTHING',
      [workerId, p.id]);
  }
}

const tempPassword = () => crypto.randomBytes(9).toString('base64url');

app.post('/api/admin/workers', auth.requireWorker, auth.requireRole('coordinator'), h(async (req, res) => {
  const { email, role = 'worker', phone, programs = [] } = req.body || {};
  const split = schedule.splitGroupPrefix(req.body && req.body.name);
  const name = split.name;
  const group = req.body && req.body.supportGroup !== undefined
    ? schedule.parseGroup(req.body.supportGroup) : split.group;
  if (!email || !name) return res.status(400).json({ error: 'email and name required' });
  if (group === undefined) return res.status(400).json({ error: 'group must be a number 1-99' });
  if (!['trainee', 'worker', 'supervisor', 'coordinator'].includes(role)) {
    return res.status(400).json({ error: 'bad role' });
  }
  const pw = tempPassword();
  try {
    const workerId = await db.insert(
      `INSERT INTO worker (email, name, phone, password_hash, must_change_pw, role, support_group, created_at)
       VALUES (?,?,?,?,1,?,?,?)`,
      [String(email).trim().toLowerCase(), name, phone || null,
        sec.hashPassword(pw), role, group, db.now()]);
    await upsertPrograms(workerId,
      programs.length ? programs : [await db.getConfig('chat_program')]);
    await db.audit(req.worker.id, 'worker_created', 'worker', workerId);
    res.json({ id: workerId, tempPassword: pw });
  } catch (e) {
    res.status(400).json({
      error: /unique|duplicate/i.test(String(e)) ? 'email already exists' : 'create failed',
    });
  }
}));

app.patch('/api/admin/workers/:id', auth.requireWorker, auth.requireRole('coordinator'), h(async (req, res) => {
  const id = Number(req.params.id);
  const w = await db.get('SELECT * FROM worker WHERE id = ?', [id]);
  if (!w) return res.status(404).json({ error: 'no such worker' });
  const { role, serviceStatus, phone, supervisorId, programs, resetPassword, supportGroup } = req.body || {};
  if (supportGroup !== undefined) {
    const g = schedule.parseGroup(supportGroup);
    if (g === undefined) return res.status(400).json({ error: 'group must be a number 1-99' });
    await db.run('UPDATE worker SET support_group = ? WHERE id = ?', [g, id]);
  }
  if (role && ['trainee', 'worker', 'supervisor', 'coordinator'].includes(role)) {
    await db.run('UPDATE worker SET role = ? WHERE id = ?', [role, id]);
  }
  if (serviceStatus && ['in_service', 'on_leave', 'left'].includes(serviceStatus)) {
    await db.run('UPDATE worker SET service_status = ?, status = ? WHERE id = ?',
      [serviceStatus, serviceStatus === 'in_service' ? w.status : 'off', id]);
    if (serviceStatus === 'left') {
      await db.run('DELETE FROM session WHERE worker_id = ?', [id]);
    }
  }
  if (phone !== undefined) await db.run('UPDATE worker SET phone = ? WHERE id = ?', [phone, id]);
  if (supervisorId !== undefined) {
    await db.run('UPDATE worker SET supervisor_id = ? WHERE id = ?', [supervisorId || null, id]);
  }
  if (Array.isArray(programs)) await upsertPrograms(id, programs);
  let temp;
  if (resetPassword) {
    temp = tempPassword();
    await db.run(
      'UPDATE worker SET password_hash = ?, must_change_pw = 1, totp_enabled = 0 WHERE id = ?',
      [sec.hashPassword(temp), id]);
    await db.run('DELETE FROM session WHERE worker_id = ?', [id]);
  }
  await db.audit(req.worker.id, 'worker_updated', 'worker', id);
  res.json({ ok: true, tempPassword: temp });
}));

app.post('/api/admin/import', auth.requireWorker, auth.requireRole('coordinator'), h(async (req, res) => {
  const rows = parseCsv(req.body.csv);
  if (!rows.length) return res.status(400).json({ error: 'empty csv' });
  const { map } = mapHeader(rows[0], {
    email: ['e-mail', 'email address'],
    name: ['full name', 'volunteer name'],
    role: [],
    programs: ['program'],
    phone: ['mobile', 'phone number'],
    group: ['support group', 'group number', 'training group'],
  });
  if (map.email === undefined || map.name === undefined) {
    return res.status(400).json({ error: 'csv needs email and name columns' });
  }
  const cell = (f, k) => (map[k] !== undefined ? f[map[k]] || '' : '');
  const created = [];
  const errors = [];
  for (const f of rows.slice(1)) {
    const line = f.join(',');
    const email = cell(f, 'email').toLowerCase();
    // "S08 Alex M" (iCarol's naming) → name "Alex M", group 8; an explicit
    // group column wins over the prefix.
    const split = schedule.splitGroupPrefix(cell(f, 'name'));
    const name = split.name;
    if (!email || !name) { errors.push(`skipped: ${line.slice(0, 60)}`); continue; }
    const group = cell(f, 'group') ? schedule.parseGroup(cell(f, 'group')) : split.group;
    if (group === undefined) { errors.push(`bad group "${cell(f, 'group')}": ${email}`); continue; }
    const role = ['trainee', 'worker', 'supervisor', 'coordinator']
      .includes(cell(f, 'role').toLowerCase()) ? cell(f, 'role').toLowerCase() : 'worker';
    const programs = cell(f, 'programs')
      ? cell(f, 'programs').split('|') : [await db.getConfig('chat_program')];
    const pw = tempPassword();
    try {
      const workerId = await db.insert(
        `INSERT INTO worker (email, name, phone, password_hash, must_change_pw, role, support_group, created_at)
         VALUES (?,?,?,?,1,?,?,?)`,
        [email, name, cell(f, 'phone') || null, sec.hashPassword(pw), role, group, db.now()]);
      await upsertPrograms(workerId, programs);
      created.push({ email, name, group: schedule.groupTag(group) || null, tempPassword: pw });
    } catch {
      errors.push(`duplicate or invalid: ${email}`);
    }
  }
  await db.audit(req.worker.id, 'workers_imported', 'worker', created.length);
  res.json({ created, errors });
}));

app.get('/api/wallboard', auth.requireWorker, auth.requireRole('supervisor'), h(async (_req, res) =>
  res.json(await snapshot())));

// ---------------------------------------------------------------------------
// Ops

// External pinger backstop for the sweep (UptimeRobot etc.). Guarded when
// CRON_SECRET is set; the stream-heartbeat sweeps make this a backstop only.
app.all('/api/cron/sweep', h(async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers['x-cron-secret'] !== secret &&
      req.query.secret !== secret) {
    return res.status(401).json({ error: 'bad secret' });
  }
  const r = await queue.sweep();
  res.json({ paged: r.toPage.length, timed_out: r.toClose.length, abandoned: r.abandoned.length });
}));

// Conversations past the retention period (src/retention.js), expired
// sign-in material and old rate-limit counters. Runs from the ops check (the
// Vercel cron) and hourly on a long-running server. Never throws.
async function housekeeping() {
  const purged = await retention.purge().catch((e) => {
    log('retention_failed', { error: String(e).slice(0, 200) });
    return null;
  });
  if (purged && purged.contacts) log('retention_purge', { contacts: purged.contacts, days: purged.days });
  const now = db.now();
  const dayAgoIso = new Date(Date.now() - 86_400_000).toISOString();
  await Promise.all([
    db.run('DELETE FROM session WHERE expires_at < ?', [now]),
    db.run('DELETE FROM login_code WHERE expires_at < ?', [dayAgoIso]),
    db.run('DELETE FROM rate_limit WHERE window_start < ?', [Date.now() - 86_400_000]),
  ].map((p) => p.catch(() => {})));
}

// Self-diagnosis for a mostly-solo maintainer: one endpoint checks
// everything and posts to the ops Google Chat webhook when something is
// wrong (or a daily digest with ?digest=1). Point a second UptimeRobot
// monitor here — the same pattern as the sweep backstop. The response
// always reports the findings, webhook or not.
app.all('/api/cron/ops-check', h(async (req, res) => {
  const secret = process.env.CRON_SECRET;
  // It reports operational state and sends alerts and emails: on a real
  // deployment it needs CRON_SECRET (the sweep above is harmless and stays
  // open as a backstop).
  if (!secret && sec.isProduction()) {
    return res.status(401).json({ error: 'set CRON_SECRET to use the ops check' });
  }
  if (secret && req.headers['x-cron-secret'] !== secret &&
      req.query.secret !== secret) {
    return res.status(401).json({ error: 'bad secret' });
  }
  const problems = [];
  const info = [];
  await housekeeping();
  if (UAT_PASSCODE && modules.enabled('helpline')) {
    info.push('The team passcode (UAT_PASSCODE) is on, so callers must know it to reach the chat');
  }

  try {
    await db.get('SELECT 1 AS ok');
  } catch (e) { problems.push('Database check FAILED: ' + String(e).slice(0, 120)); }
  try {
    if (sec.decrypt(sec.encrypt('ops-check')) !== 'ops-check') throw new Error('round-trip mismatch');
  } catch (e) { problems.push('Encryption check FAILED: ' + String(e).slice(0, 120)); }
  const staleRefusals = await db.get(
    `SELECT COUNT(*) AS n FROM event_log WHERE event = 'stale_page_refused' AND at >= ?`,
    [new Date(Date.now() - 3_600_000).toISOString()])
    .catch(() => ({ n: 0 }));
  if (Number(staleRefusals.n) > 0) {
    problems.push(`${staleRefusals.n} chat(s) refused in the last hour from pages showing out-of-date numbers — rebuild/redeploy the pages`);
  }
  if (modules.enabled('helpline') && !profile.profile().ready.helpline) {
    problems.push(`Helpline NOT CONFIGURED: profile "${profile.profile().id}" has no phone or emergency number, so the caller chat is switched off`);
  }

  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const errs = await db.get('SELECT COUNT(*) AS n FROM error_log WHERE at >= ?', [hourAgo])
    .catch(() => ({ n: 0 }));
  if (Number(errs.n) > 0) problems.push(`${errs.n} unhandled error(s) in the last hour (see /ops.html)`);

  const waiting = await queue.waiting().catch(() => []);
  const valveAfter = Number(await db.getConfig('safety_valve_after_secs'));
  const stuck = waiting.filter((c) =>
    (Date.now() - Date.parse(c.queued_at)) / 1000 > valveAfter + 120);
  if (stuck.length) {
    problems.push(`${stuck.length} caller(s) waiting past the safety valve — the sweep may not be running`);
  }
  info.push(`queue: ${waiting.length} waiting`);

  // Sweeps ride live caller/worker streams, so a quiet site legitimately
  // goes hours without one (that is Neon asleep, which is the goal). It is
  // only a problem when someone IS waiting and sweeps still aren't running —
  // that means the streams are broken.
  const lastSweep = Number(await db.getConfig('last_sweep_at'));
  if (waiting.length && lastSweep && Date.now() - lastSweep > 10 * 60_000) {
    problems.push('Callers are waiting but no sweep in 10+ minutes — streams may be broken');
  }

  const unconfirmed = await schedule.unconfirmedNext24h().catch(() => []);
  const unstaffed = unconfirmed.filter((s) => s.status === 'open');
  if (unstaffed.length) problems.push(`${unstaffed.length} unstaffed shift(s) in the next 24h`);
  if (unconfirmed.length > unstaffed.length) {
    info.push(`${unconfirmed.length - unstaffed.length} shift(s) in the next 24h awaiting confirmation`);
  }

  // Day-before shift reminder emails ride this cron (opt-in per worker).
  const reminders = await schedule.sendShiftReminders(notifyOut).catch(() => 0);
  if (reminders) info.push(`${reminders} shift reminder(s) sent`);

  // Usage alert: when humans have used the site since the last check, email
  // a counts-only summary (never content, never caller details) to
  // TL_USAGE_EMAIL. A prototype profile defaults it to the SMTP account's
  // own mailbox; otherwise it's off unless set. The first run after deploy
  // only sets the baseline.
  try {
    const usageTo = process.env.TL_USAGE_EMAIL ||
      (profile.profile().prototype ? mail.account() : null);
    if (mail.configured() && usageTo) {
      const mark = await db.getConfig('usage_alert_last');
      const nowIso = db.now();
      if (mark) {
        const count = async (sql) =>
          Number((await db.get(sql, [mark]).catch(() => ({ n: 0 }))).n);
        const contacts = await count('SELECT COUNT(*) AS n FROM contact WHERE queued_at > ?');
        const callerMsgs = await count(
          `SELECT COUNT(*) AS n FROM message WHERE sent_at > ? AND sender = 'caller'`);
        const codes = await count('SELECT COUNT(*) AS n FROM login_code WHERE created_at > ?');
        const parts = [];
        if (contacts) parts.push(`${contacts} new caller contact(s)`);
        if (callerMsgs) parts.push(`${callerMsgs} caller message(s)`);
        if (codes) parts.push(`${codes} sign-in code(s) requested`);
        if (parts.length) {
          const sent = await mail.send(usageTo, profile.brand('name') + ' activity',
            `Since ${mark} (UTC): ${parts.join(' · ')}.\n\n` +
            'Counts only — no content. Details on /ops.html and /reports.html.');
          if (sent) info.push('usage alert sent');
        }
      }
      await db.run(
        `INSERT INTO config (key, value) VALUES ('usage_alert_last', ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [nowIso]);
    }
  } catch (e) {
    problems.push('Usage alert FAILED: ' + String(e).slice(0, 120));
  }

  const digest = req.query.digest === '1';
  let notified = false;
  if (problems.length) {
    notified = await notifyOut('ops_alert', [], { text: problems.join('\n') });
  } else if (digest) {
    const t = await (async () => {
      const s = await snapshot();
      return `All checks green. Today: ${s.today.contacts_today} contacts ` +
        `(${s.today.completed} completed, ${s.today.abandoned + s.today.timed_out} lost). ` +
        info.join(' · ');
    })().catch(() => 'All checks green.');
    notified = await notifyOut('ops_digest', [], { text: t });
  }
  res.json({ ok: problems.length === 0, problems, info, notified });
}));

// Encrypted full-database export. Two ways in: a coordinator's session
// (the Ops page button), or CRON_SECRET for a scheduled fetch from a machine
// TELL controls — which is why the UAT gate exempts this path; the route
// does its own auth. The blob is AES-256-GCM under TL_ENCRYPTION_KEY: keep
// backups and the key apart, and the key is the restore credential.
app.get('/api/admin/backup', h(async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const bySecret = secret && req.query.secret === secret;
  if (!bySecret) {
    if (!req.worker) return res.status(401).json({ error: 'not logged in' });
    if (req.worker.role !== 'coordinator') {
      return res.status(403).json({ error: 'insufficient role' });
    }
  }
  const blob = await backup.exportEncrypted();
  await db.audit(req.worker ? req.worker.id : null, 'backup_exported');
  const stamp = db.now().slice(0, 16).replace(/:/g, '');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${profile.profile().id}-backup-${stamp}.enc"`);
  res.send(blob);
}));

// Coordinator ops view: health, recent errors, config presence — the first
// place to look when something misbehaves, before platform logs.
// ---------------------------------------------------------------------------
// Problem reports and requests: anyone signed in files one (and follows
// their own); coordinators work through them on the Ops page.

app.post('/api/issues', auth.requireWorker, h(async (req, res) => {
  if (!(await rl.allow('issue:' + req.worker.id, 20, 60 * 60_000))) {
    return res.status(429).json({ error: 'That is a lot of reports in an hour — try again shortly.' });
  }
  const r = await issues.create(req.worker, req.body || {});
  if (r.error) return res.status(400).json(r);
  res.json(r);
}));

app.get('/api/issues/mine', auth.requireWorker, h(async (req, res) =>
  res.json(await issues.list({ reporterId: req.worker.id, scope: 'all' }))));

app.post('/api/issues/:id/comment', auth.requireWorker, h(async (req, res) => {
  const r = await issues.comment(Number(req.params.id), req.worker, req.body || {});
  if (r.error) return res.status(400).json(r);
  res.json(r);
}));

app.post('/api/issues/:id/reopen', auth.requireWorker, h(async (req, res) => {
  const r = await issues.reopen(Number(req.params.id), req.worker, (req.body || {}).note);
  if (r.error) return res.status(400).json(r);
  res.json(r);
}));

app.get('/api/issues', auth.requireWorker, auth.requireRole('coordinator'), h(async (req, res) => {
  const scope = ['open', 'closed', 'all'].includes(req.query.scope) ? req.query.scope : 'open';
  res.json(await issues.list({ scope }));
}));

app.patch('/api/issues/:id', auth.requireWorker, auth.requireRole('coordinator'), h(async (req, res) => {
  const r = await issues.update(Number(req.params.id), req.worker, req.body || {});
  if (r.error) return res.status(400).json(r);
  res.json(r);
}));

app.get('/api/admin/ops', auth.requireWorker, auth.requireRole('coordinator'), h(async (_req, res) => {
  const errors = await db.all(
    'SELECT id, path, message, at FROM error_log ORDER BY id DESC LIMIT 50');
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const events = await db.all(
    `SELECT event, COUNT(*) AS n FROM event_log WHERE at >= ?
     GROUP BY event ORDER BY n DESC`, [dayAgo]);
  res.json({
    uptime_secs: Math.round(process.uptime()),
    node: process.version,
    env: {
      database: !!process.env.DATABASE_URL,
      encryption_key: !!process.env.TL_ENCRYPTION_KEY,
      team_webhook: !!process.env.TL_NOTIFY_WEBHOOK_URL,
      ops_webhook: !!(process.env.TL_OPS_WEBHOOK_URL || process.env.TL_NOTIFY_WEBHOOK_URL),
      cron_secret: !!process.env.CRON_SECRET,
      uat_passcode: !!process.env.UAT_PASSCODE,
      base_url: !!process.env.TL_BASE_URL,
      email_codes: mail.configured(),
    },
    mail: await mail.status(),
    recent_errors: errors.map((e) => ({
      id: Number(e.id), path: e.path, message: e.message, at: e.at,
    })),
    events_24h: events.map((e) => ({ event: e.event, n: Number(e.n) })),
  });
}));

// How long conversations are kept (Admin → Keeping records).
app.get('/api/admin/retention', auth.requireWorker, auth.requireRole('coordinator'), h(async (_req, res) => {
  res.json({ days: await retention.days(), min: retention.MIN_DAYS, max: retention.MAX_DAYS });
}));

app.put('/api/admin/retention', auth.requireWorker, auth.requireRole('coordinator'), h(async (req, res) => {
  const r = await retention.setDays(Number((req.body || {}).days), req.worker.id);
  if (r.error) return res.status(400).json(r);
  res.json(r);
}));

// A coordinator presses this after pasting the webhook URLs into Vercel:
// sends a hello to both channels and reports what actually arrived.
app.post('/api/admin/ops/test-notify', auth.requireWorker, auth.requireRole('coordinator'), h(async (req, res) => {
  const team = await notifyOut('help_requested', [], {
    from: 'Ops test', note: 'If you can read this, the team webhook works.',
  });
  const ops = await notifyOut('ops_digest', [], {
    text: 'If you can read this, the ops webhook works.',
  });
  await db.audit(req.worker.id, 'ops_test_notify');
  res.json({ team_delivered: team, ops_delivered: ops });
}));

// Health = every subsystem a chat depends on, checked by name, so a config
// mistake surfaces here instead of failing mid-conversation.
// Uptime monitors may ping this every few minutes, so the default answer
// does no database work — a frequent pinger would otherwise keep Neon's
// compute awake (and billing) around the clock. ?deep=1 adds the real DB
// round-trip; the Ops page uses it, and the hourly ops-check exercises the
// database anyway.
app.get('/healthz', h(async (req, res) => {
  const checks = { encryption: false };
  try {
    checks.encryption = sec.decrypt(sec.encrypt('healthz-ping')) === 'healthz-ping';
  } catch (e) {
    log('healthz_fail', { check: 'encryption', error: String(e).slice(0, 200) });
  }
  if (req.query.deep === '1') {
    checks.db = false;
    try {
      await db.get('SELECT 1 AS ok');
      checks.db = true;
    } catch (e) {
      log('healthz_fail', { check: 'db', error: String(e).slice(0, 200) });
    }
  }
  // Only present when it fails, so a configured deployment's reply is as before.
  if (modules.enabled('helpline') && !profile.profile().ready.helpline) checks.helpline = false;
  // A fresh install waiting for its setup wizard is healthy: a host's health
  // check (Fly) must not restart it before anyone can finish setting it up.
  if (checks.helpline === false && await setup.isOpen().catch(() => false)) checks.setup = 'open';
  const ok = checks.encryption && checks.db !== false &&
    (checks.helpline !== false || checks.setup === 'open');
  res.status(ok ? 200 : 500)
    .json({ ok, ...checks, uptime_secs: Math.round(process.uptime()) });
}));

// Live queue numbers reveal when the line is unstaffed: supervisors, or a
// monitor with CRON_SECRET.
app.get('/metrics.json', h(async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const bySecret = secret && req.headers['x-cron-secret'] === secret;
  const staff = req.worker && ['supervisor', 'coordinator'].includes(req.worker.role);
  if (!bySecret && !staff) return res.status(401).json({ error: 'not available' });
  const s = await snapshot();
  res.json({
    queue_depth: s.queue_depth,
    longest_wait_secs: s.longest_wait_secs,
    active_chats: s.active_chats,
    ...s.today,
  });
}));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  log('unhandled_error', { path: req.path, error: String(err).slice(0, 300) });
  // Persist for the ops page and ops-check alerts (metadata only). Failing
  // to record must never mask the original error.
  db.run('INSERT INTO error_log (path, message, at) VALUES (?,?,?)',
    [req.path, String(err).slice(0, 300), db.now()])
    .then(() => db.run(
      `DELETE FROM error_log WHERE id NOT IN
         (SELECT id FROM error_log ORDER BY id DESC LIMIT 500)`))
    .catch(() => {});
  if (!res.headersSent) res.status(500).json({ error: 'internal error' });
});

// ---------------------------------------------------------------------------
// Local long-running mode (npm start / Docker / Fly). On Vercel, api/index.js
// exports the app and the intervals below never start.

if (require.main === module) {
  db.init().then(() => {
    app.listen(PORT, () => log('listening', { port: PORT }));
    setInterval(() => {
      queue.maybeSweep().catch(() => {});
    }, 5000);
    setInterval(() => { housekeeping(); }, 3600_000).unref();
  });
}

module.exports = { app };
