'use strict';

// Fixed-window rate limiter backed by the database, so limits hold across
// serverless instances. One atomic upsert per check.

const db = require('./db');

// allow(key, max, windowMs) → true if the action may proceed.
async function allow(key, max, windowMs) {
  const nowMs = Date.now();
  const windowFloor = nowMs - windowMs;
  const row = await db.get(
    `INSERT INTO rate_limit (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN rate_limit.window_start < ? THEN 1 ELSE rate_limit.count + 1 END,
       window_start = CASE WHEN rate_limit.window_start < ? THEN ? ELSE rate_limit.window_start END
     RETURNING count`,
    [key, nowMs, windowFloor, windowFloor, nowMs]);
  return Number(row.count) <= max;
}

// The caller's address as the host saw it. The first X-Forwarded-For entry
// is whatever the client sent, so it can't key a rate limit: use the
// platform's own header (Vercel, Fly), else the address the nearest proxy
// recorded (the last entry), else the socket.
function clientIp(req) {
  const h = req.headers;
  const platform = h['x-vercel-forwarded-for'] || h['fly-client-ip'] || h['x-real-ip'];
  if (platform) return String(platform).split(',')[0].trim();
  const fwd = h['x-forwarded-for'];
  if (fwd) {
    const hops = String(fwd).split(',').map((x) => x.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

module.exports = { allow, clientIp };
