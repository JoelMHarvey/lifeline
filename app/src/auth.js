'use strict';

// Accounts + sessions, async over Postgres. Same semantics as before:
// email + scrypt password, optional TOTP, expiring server-side sessions
// with sliding renewal, role gates, forced password change.

const crypto = require('node:crypto');
const db = require('./db');
const sec = require('./crypto');
const { log } = require('./log');
const profile = require('./profile');

const ROLE_RANK = { trainee: 0, worker: 1, supervisor: 2, coordinator: 3 };

async function createSession(workerId) {
  const token = crypto.randomBytes(24).toString('hex');
  const expires = new Date(Date.now() + db.SESSION_HOURS * 3600_000).toISOString();
  await db.run('INSERT INTO session (token, worker_id, created_at, expires_at) VALUES (?,?,?,?)',
    [token, workerId, db.now(), expires]);
  return token;
}

// Returns {token, worker}, {totpRequired:true}, or null. Never reveals which
// part failed.
async function login(email, password, totpCode) {
  const w = await db.get('SELECT * FROM worker WHERE email = ?',
    [String(email || '').trim().toLowerCase()]);
  if (!w || !sec.verifyPassword(password, w.password_hash)) return null;
  if (w.service_status === 'left') return null;
  if (w.totp_enabled) {
    if (!totpCode) return { totpRequired: true };
    if (!sec.verifyTotp(sec.decrypt(w.totp_secret), totpCode)) return null;
  }
  const token = await createSession(w.id);
  await db.audit(w.id, 'login');
  log('login', { workerId: Number(w.id) });
  return { token, worker: w };
}

// --- Email sign-in codes -----------------------------------------------
// Six digits, ten minutes, single-use, five attempts. Hashed at rest with a
// per-row salt: a leaked table gives an attacker nothing usable inside the
// expiry window without also beating the attempt cap.

const CODE_TTL_MS = 10 * 60_000;
const CODE_MAX_ATTEMPTS = 5;

function hashCode(code, salt) {
  return crypto.createHash('sha256').update(salt + ':' + code).digest('hex');
}

// Creates and emails a code. Returns {sent} — callers must answer the HTTP
// request generically either way, so an outsider can't probe which email
// addresses have accounts.
async function requestLoginCode(email, sendMail) {
  const w = await db.get('SELECT * FROM worker WHERE email = ?',
    [String(email || '').trim().toLowerCase()]);
  if (!w || w.service_status === 'left') return { sent: false };

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const salt = crypto.randomBytes(8).toString('hex');
  await db.run('DELETE FROM login_code WHERE expires_at < ? OR worker_id = ?',
    [db.now(), w.id]); // one live code per account, stale rows swept
  await db.run(
    `INSERT INTO login_code (worker_id, code_hash, created_at, expires_at)
     VALUES (?,?,?,?)`,
    [w.id, salt + '$' + hashCode(code, salt), db.now(),
      new Date(Date.now() + CODE_TTL_MS).toISOString()]);
  await db.audit(w.id, 'login_code_requested');

  const sent = await sendMail(w.email, `Your ${profile.brand('name')} sign-in code`,
    `Your sign-in code is: ${code}\n\n` +
    `It expires in 10 minutes and works once. If you didn't request it, ` +
    `you can ignore this email.`);
  return { sent };
}

// Same result shapes as login(): {token, worker}, {totpRequired:true}, or null.
async function loginWithCode(email, code, totpCode) {
  const w = await db.get('SELECT * FROM worker WHERE email = ?',
    [String(email || '').trim().toLowerCase()]);
  if (!w || w.service_status === 'left') return null;

  // Burn an attempt atomically before comparing, so parallel guesses can't
  // exceed the cap.
  const row = await db.get(
    `UPDATE login_code SET attempts = attempts + 1
     WHERE worker_id = ? AND used = 0 AND attempts < ? AND expires_at > ?
     RETURNING id, code_hash`,
    [w.id, CODE_MAX_ATTEMPTS, db.now()]);
  if (!row) return null;

  const [salt, stored] = String(row.code_hash).split('$');
  const given = hashCode(String(code || '').trim(), salt);
  if (!crypto.timingSafeEqual(Buffer.from(stored, 'hex'), Buffer.from(given, 'hex'))) {
    return null;
  }
  if (w.totp_enabled) {
    // Code checks out but the account has an authenticator: ask for it
    // without consuming the code, so the same code + TOTP can be resubmitted.
    if (!totpCode) return { totpRequired: true };
    if (!sec.verifyTotp(sec.decrypt(w.totp_secret), totpCode)) return null;
  }
  await db.run('UPDATE login_code SET used = 1 WHERE id = ?', [row.id]);
  // Proving control of the inbox stands in for the temporary password, so
  // don't then demand a password change — a password can be set in My profile.
  if (w.must_change_pw) {
    await db.run('UPDATE worker SET must_change_pw = 0 WHERE id = ?', [w.id]);
    w.must_change_pw = 0;
  }
  const token = await createSession(w.id);
  await db.audit(w.id, 'login_code');
  log('login_code', { workerId: Number(w.id) });
  return { token, worker: w };
}

async function workerFromToken(token) {
  if (!token) return null;
  const row = await db.get(
    `SELECT worker.*, session.expires_at
     FROM session JOIN worker ON worker.id = session.worker_id
     WHERE session.token = ?`, [token]);
  if (!row) return null;
  if (Date.parse(row.expires_at) < Date.now()) {
    await db.run('DELETE FROM session WHERE token = ?', [token]);
    return null;
  }
  if (Date.parse(row.expires_at) - Date.now() < db.SESSION_HOURS * 1800_000) {
    await db.run('UPDATE session SET expires_at = ? WHERE token = ?',
      [new Date(Date.now() + db.SESSION_HOURS * 3600_000).toISOString(), token]);
  }
  return row;
}

async function logout(token) {
  if (token) await db.run('DELETE FROM session WHERE token = ?', [token]);
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function attachWorker(req, _res, next) {
  try {
    req.sessionToken = parseCookies(req.headers.cookie).session;
    req.worker = await workerFromToken(req.sessionToken);
    next();
  } catch (e) { next(e); }
}

function requireWorker(req, res, next) {
  if (!req.worker) return res.status(401).json({ error: 'not logged in' });
  if (req.worker.must_change_pw && !req.path.startsWith('/api/password') &&
      req.path !== '/api/me' && req.path !== '/api/logout') {
    return res.status(403).json({ error: 'password change required', mustChangePw: true });
  }
  next();
}

function requireRole(minRole) {
  return (req, res, next) => {
    if (!req.worker) return res.status(401).json({ error: 'not logged in' });
    if (ROLE_RANK[req.worker.role] < ROLE_RANK[minRole]) {
      return res.status(403).json({ error: 'insufficient role' });
    }
    next();
  };
}

async function setPassword(workerId, newPassword) {
  if (String(newPassword || '').length < 10) {
    return { error: 'password must be at least 10 characters' };
  }
  await db.run('UPDATE worker SET password_hash = ?, must_change_pw = 0 WHERE id = ?',
    [sec.hashPassword(newPassword), workerId]);
  await db.audit(workerId, 'password_change');
  return { ok: true };
}

async function endOtherSessions(workerId, keepToken) {
  await db.run('DELETE FROM session WHERE worker_id = ? AND token != ?',
    [workerId, keepToken || '']);
}

module.exports = {
  login, logout, workerFromToken, parseCookies, attachWorker,
  requireWorker, requireRole, setPassword, endOtherSessions,
  createSession, requestLoginCode, loginWithCode, ROLE_RANK,
};
