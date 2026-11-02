'use strict';

// Security primitives, all on node:crypto — no dependencies.
//  - Password hashing: scrypt (N=16384) with per-password salt
//  - At-rest encryption: AES-256-GCM with an app-level key (chat bodies,
//    triage and intake content)
//  - TOTP (RFC 6238, SHA-1, 30s step) for worker MFA

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Passwords

const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32, SCRYPT_OPTS);
  return `s1$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('s1$')) return false;
  const [, saltHex, hashHex] = stored.split('$');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'),
    expected.length, SCRYPT_OPTS);
  return crypto.timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------------
// App-level encryption key
// Production: TL_ENCRYPTION_KEY env var, 64 hex chars (32 bytes).
// Dev fallback: a generated keyfile next to the DB, with a loud warning —
// convenient locally, never acceptable in production.

let keyCache = null;
// A real deployment: Vercel, or NODE_ENV=production (the Dockerfile sets it).
const isProduction = () => process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
const keyFromEnv = () => !!(process.env.TL_ENCRYPTION_KEY || '').trim();
function encryptionKey() {
  if (keyCache) return keyCache;
  // Tolerate the common paste accidents: surrounding quotes and whitespace.
  const env = (process.env.TL_ENCRYPTION_KEY || '')
    .trim().replace(/^['"]|['"]$/g, '').trim();
  if (env) {
    if (!/^[0-9a-fA-F]{64}$/.test(env)) {
      throw new Error('TL_ENCRYPTION_KEY must be 64 hex characters (32 bytes); ' +
        `got ${env.length} characters after trimming`);
    }
    keyCache = Buffer.from(env, 'hex');
    return keyCache;
  }
  // Production never invents a key: a generated key lives in the container
  // and is lost on the next deploy, taking every encrypted record with it.
  if (isProduction() && process.env.TL_DEV !== '1') {
    throw new Error('TL_ENCRYPTION_KEY is required in production (64 hex characters: ' +
      'openssl rand -hex 32). Keep a copy safe: it is the only way to read the records.');
  }
  const keyfile = process.env.TL_KEYFILE ||
    path.join(__dirname, '..', '.enckey');
  if (fs.existsSync(keyfile)) {
    keyCache = Buffer.from(fs.readFileSync(keyfile, 'utf8').trim(), 'hex');
    return keyCache;
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyfile, key.toString('hex'), { mode: 0o600 });
  process.stderr.write(
    'WARNING: TL_ENCRYPTION_KEY not set — generated dev keyfile at ' +
    keyfile + '. Set TL_ENCRYPTION_KEY in production.\n');
  keyCache = key;
  return keyCache;
}

function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return `g1$${iv.toString('base64')}$${cipher.getAuthTag().toString('base64')}$${ct.toString('base64')}`;
}

function decrypt(stored) {
  if (stored === null || stored === undefined) return null;
  if (!String(stored).startsWith('g1$')) return String(stored); // pre-encryption rows
  const [, ivB64, tagB64, ctB64] = String(stored).split('$');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(),
    Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')),
    decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------
// TOTP (RFC 6238; SHA-1, 6 digits, 30-second step, ±1 step window)

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of str.toUpperCase().replace(/=+$/, '').replace(/\s/g, '')) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function newTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function totpCode(secretB32, timeMs = Date.now(), step = 30) {
  const counter = Math.floor(timeMs / 1000 / step);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', base32Decode(secretB32)).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(code % 1_000_000).padStart(6, '0');
}

function verifyTotp(secretB32, code, timeMs = Date.now()) {
  const clean = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  for (const skew of [0, -1, 1]) {
    if (totpCode(secretB32, timeMs + skew * 30_000) === clean) return true;
  }
  return false;
}

// The issuer is only the label an authenticator app shows; changing it
// never invalidates an enrolled secret.
function otpauthUrl(secretB32, accountName, issuer = require('./profile').brand('name')) {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}` +
    `?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}`;
}

// A separate key for another purpose (e.g. hashing callers' phone numbers),
// derived from the app key with HKDF so it is as strong as the app key and
// never the key itself.
function deriveKey(label) {
  return Buffer.from(crypto.hkdfSync('sha256', encryptionKey(), Buffer.alloc(0), String(label), 32));
}

module.exports = {
  deriveKey, isProduction, keyFromEnv, encryptionKey,
  hashPassword, verifyPassword,
  encrypt, decrypt,
  newTotpSecret, totpCode, verifyTotp, otpauthUrl, base32Decode,
};
