'use strict';

// The web pages, rendered for one organisation. site/ holds the templates
// (see src/profile.js for the syntax); render() turns the whole folder into
// {relative path: contents} for a profile. tools/render-site.js writes that
// into public/, and public/ as committed is TELL's copy — a test checks the
// two never drift apart.

const fs = require('fs');
const path = require('path');
const profile = require('./profile');

const SITE = path.join(__dirname, '..', 'site');
const TEXT = new Set(['.html', '.js', '.css', '.svg', '.json', '.txt', '.webmanifest']);

function walk(dir, base = dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

function available() { return fs.existsSync(SITE); }

// Every file in site/, rendered for p. Binary files pass through as Buffers.
function render(p = profile.profile()) {
  const files = {};
  for (const rel of walk(SITE)) {
    const buf = fs.readFileSync(path.join(SITE, rel));
    files[rel] = TEXT.has(path.extname(rel).toLowerCase())
      ? profile.render(buf.toString('utf8'), p, 'site/' + rel)
      : buf;
  }
  return files;
}

// Write a rendered site into dir (public/ by default): changed files only,
// and files that are not in site/ are removed.
function write(dir, files) {
  const changed = [];
  const keep = new Set(Object.keys(files));
  for (const [rel, body] of Object.entries(files)) {
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const next = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    if (fs.existsSync(dest) && fs.readFileSync(dest).equals(next)) continue;
    fs.writeFileSync(dest, next);
    changed.push(rel);
  }
  if (fs.existsSync(dir)) {
    for (const rel of walk(dir)) {
      if (!keep.has(rel)) { fs.unlinkSync(path.join(dir, rel)); changed.push(rel + ' (removed)'); }
    }
  }
  return changed;
}

const TYPES = {
  '.html': 'text/html; charset=UTF-8', '.js': 'application/javascript; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.txt': 'text/plain; charset=UTF-8', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.ico': 'image/x-icon',
};

// Express middleware serving the site rendered in memory for the active
// profile — what a non-TELL server uses when it runs straight from the repo
// (TELL keeps serving public/ as before). Rendered on first request, so a
// template error shows up there and in the tests, never at import time.
function middleware() {
  let cache = null;
  let cachedFor = null;
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    // Re-render when a coordinator changes a display-name override.
    if (!cache || cachedFor !== profile.overridesVersion()) {
      cachedFor = profile.overridesVersion();
      cache = render(profile.effective());
    }
    let rel = decodeURIComponent(req.path).replace(/^\/+/, '');
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const body = cache[rel];
    if (body === undefined) return next();
    res.setHeader('Content-Type', TYPES[path.extname(rel).toLowerCase()] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=0');
    res.send(Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8'));
  };
}

module.exports = { render, write, available, middleware, SITE };
