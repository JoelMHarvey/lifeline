'use strict';

// First-run setup wizard (profile feature "setupWizard"; plan 08, P7).
//
// A new lifeline's deployment starts with an empty database. The wizard
// walks the first coordinator through the organisation, its look, the
// safety numbers, modules, shifts, email and their own account, then a
// ready check. It is open only while no account exists and setup has never
// been completed, exactly like the old one-step setup it replaces.
//
// Progress lives server-side in config "setup.draft" so a closed tab
// resumes. Nothing takes effect until finish(), which writes the config
// overrides (src/profile.js SETUP_KEYS — a serverless deployment can't write
// profile files), the module choice, the shift pattern and the account.
// No password is ever stored in the draft.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const sec = require('./crypto');
const profile = require('./profile');
const modules = require('./modules');
const mail = require('./mail');

const DRAFT = 'setup.draft';
const DONE = 'setup.completed_at';
const CLAIM = 'setup.claim';
const MODULES_KEY = 'setup.modules';
const MAX_DRAFT = 48 * 1024;
const STEPS = ['org', 'look', 'safety', 'modules', 'voice', 'shifts', 'email', 'account'];
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const MODES = ['phone', 'chat', 'both'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const PLAIN_BAD = /['"\\<>`$\r\n{}]/;

// ---------------------------------------------------------------------------
// Colour: WCAG contrast and the shades derived from one accent colour.

const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const rgbToHex = (rgb) => '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v)))
  .toString(16).padStart(2, '0')).join('');
function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
const mix = (hex, toward, t) => rgbToHex(hexToRgb(hex).map((v, i) => v + (toward[i] - v) * t));

// accentDark (hover), soft (focus ring, highlights) and deep (headings,
// shadows) from the accent, as the TELL and generic palettes are built.
function deriveColors(accent) {
  return {
    accent,
    accentDark: mix(accent, [0, 0, 0], 0.18),
    soft: mix(accent, [255, 255, 255], 0.88),
    deep: mix(accent, [0, 0, 0], 0.62),
  };
}

// The accent carries white button text and is used as link/heading colour on
// white panels: both must reach 4.5:1 (WCAG AA for normal text).
function colorProblems(accent) {
  if (!/^#[0-9a-fA-F]{6}$/.test(accent || '')) return ['pick a colour'];
  const out = [];
  const onWhite = contrast(accent, '#ffffff');
  if (onWhite < 4.5) {
    out.push(`white text on it has contrast ${onWhite.toFixed(2)}:1; it needs 4.5:1 — choose a darker colour`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Logo: an allow-list SVG sanitiser. Rebuilds the drawing from known shape
// elements and presentation attributes only, so scripts, event handlers,
// links, external references and text never survive. Output uses single
// quotes (the templates embed it in a double-quoted CSS url).

const SVG_TAGS = new Set(['svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon']);
const SVG_ATTRS = new Set(['viewBox', 'width', 'height', 'd', 'fill', 'stroke', 'stroke-width',
  'stroke-linecap', 'stroke-linejoin', 'fill-rule', 'clip-rule', 'opacity', 'fill-opacity',
  'stroke-opacity', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'points',
  'transform']);
const SAFE_VALUE = /^[#0-9a-zA-Z.,\s()+\-%]*$/;
const MAX_LOGO_IN = 64 * 1024;
const MAX_LOGO_OUT = 4096;

function sanitizeSvg(input) {
  const text = String(input || '');
  if (!text.trim()) return { error: 'empty file' };
  if (text.length > MAX_LOGO_IN) return { error: 'logo file is too big (64 KB max)' };
  const body = text.replace(/<\?xml[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '');
  const out = [];
  const stack = [];
  let sawSvg = false;
  let skipDepth = 0; // inside an element we drop (and everything in it)
  // Linear-time tag pattern (no competing lazy/greedy runs); self-closing
  // is read from the attribute text.
  const tagRe = /<\s*(\/)?\s*([a-zA-Z][\w:-]*)([^<>]*)>/g;
  let m;
  while ((m = tagRe.exec(body))) {
    const [, closing, rawName, rawAttrs] = m;
    const selfClose = /\/\s*$/.test(rawAttrs);
    const attrText = selfClose ? rawAttrs.replace(/\/\s*$/, '') : rawAttrs;
    const name = rawName.toLowerCase() === 'svg' ? 'svg' : rawName;
    const allowed = SVG_TAGS.has(name);
    if (closing) {
      if (skipDepth) { if (stack.pop() === '!skip') skipDepth -= 1; continue; }
      if (stack.length && stack[stack.length - 1] === name) { stack.pop(); out.push(`</${name}>`); }
      continue;
    }
    if (skipDepth || !allowed) {
      if (!selfClose) { stack.push('!skip'); skipDepth += 1; }
      continue;
    }
    if (name === 'svg') sawSvg = true;
    const attrs = [];
    const attrRe = /([a-zA-Z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let a;
    while ((a = attrRe.exec(attrText))) {
      const key = a[1];
      // One line: a raw newline inside the CSS url("…") the logo is
      // embedded in would end it and take the stylesheet with it.
      const val = (a[3] !== undefined ? a[3] : a[4]).replace(/\s+/g, ' ').trim();
      if (!SVG_ATTRS.has(key) || !SAFE_VALUE.test(val) || /url\s*\(|expression/i.test(val)) continue;
      attrs.push(`${key}='${val}'`);
    }
    if (name === 'svg') attrs.unshift("xmlns='http://www.w3.org/2000/svg'");
    out.push(`<${name}${attrs.length ? ' ' + attrs.join(' ') : ''}${selfClose ? '/' : ''}>`);
    if (!selfClose) stack.push(name);
  }
  if (!sawSvg || out[0] === undefined || !out[0].startsWith('<svg')) return { error: 'not an SVG drawing' };
  while (stack.length) { const n = stack.pop(); if (n !== '!skip') out.push(`</${n}>`); }
  const svg = out.join('');
  if (!/<(path|circle|ellipse|rect|line|polyline|polygon)\b/.test(svg)) return { error: 'the SVG has no shapes we can use' };
  if (svg.length > MAX_LOGO_OUT) return { error: 'the drawing is too detailed (4 KB max after cleaning) — simplify it' };
  return { svg };
}

// ---------------------------------------------------------------------------
// Shift presets the shifts step offers.

function presets() {
  const example = profile.load('tell');
  const tell = example.schedule;
  return {
    three8: {
      label: 'Three 8-hour shifts (day, evening, night)',
      rows: [['Day', '08:00', '16:00', 'both'], ['Evening', '16:00', '00:00', 'both'],
        ['Night', '00:00', '08:00', 'both']],
    },
    two12: {
      label: 'Two 12-hour shifts (day, night)',
      rows: [['Day', '08:00', '20:00', 'both'], ['Night', '20:00', '08:00', 'both']],
    },
    tell: {
      label: `An example: ${example.org}’s ${tell.shifts.length} overlapping shifts`,
      rows: tell.shifts.map(([, label, start, end, , m]) => [label, start, end, m.default || 'both']),
      weekSeats: tell.weekSeats,
    },
  };
}

// ---------------------------------------------------------------------------
// Profiles a setup can start from (prefill only; TL_PROFILE stays the base).

function startProfiles() {
  const dir = path.join(__dirname, '..', 'profiles');
  const ids = new Set(['generic', 'tell']);
  try {
    for (const f of fs.readdirSync(dir)) if (/^[a-z0-9_-]+\.json$/.test(f)) ids.add(f.slice(0, -5));
  } catch { /* bundled without the folder: the built-ins */ }
  const out = [];
  for (const id of [...ids].sort()) {
    try { const p = profile.load(id); out.push({ id, name: p.name }); } catch { /* skip broken */ }
  }
  return out;
}

// Wizard defaults from a profile.
// Wizard defaults. "Start from" another profile borrows its colour and shift
// pattern only: names, logo and above all the safety numbers always start
// from this deployment's own base profile, so another lifeline's phone
// numbers can never be carried onto a caller page by a missed review.
function defaultsFrom(id) {
  const p = profile.load(id);
  const b = profile.base();
  return {
    org: { from: id, name: b.name, shortName: b.shortName, website: b.website || '', timezone: b.timezone },
    look: { accent: p.colors.accent, logo: b.logo.svg },
    safety: {
      phone: b.phone || '',
      primaryNumber: b.emergency.primary.number || '', primaryLabel: b.emergency.primary.label,
      secondaryNumber: b.emergency.secondary.number || '', secondaryLabel: b.emergency.secondary.label,
      message: '',
    },
    modules: ['schedule'],
    shifts: {
      rows: p.schedule.shifts.map(([, label, start, end, , m]) => [label, start, end, m.default || 'both']),
      weekSeats: null,
    },
    email: { fromName: b.mail.fromName || b.name },
    account: { name: '', email: '', totp: false },
    voice: { provider: 'mock', overflowNumber: '' },
  };
}

// ---------------------------------------------------------------------------
// State

async function getConfig(key) {
  const r = await db.get('SELECT value FROM config WHERE key = ?', [key]);
  return r ? r.value : null;
}
async function setConfig(key, value) {
  await db.run(`INSERT INTO config (key, value) VALUES (?, ?)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value]);
}

function enabled() { return profile.base().features.setupWizard === true; }

async function isOpen() {
  if (!enabled()) return false;
  const n = await db.get('SELECT COUNT(*) AS n FROM worker');
  if (Number(n.n) > 0) return false;
  return !(await getConfig(DONE));
}

async function readDraft() {
  const raw = await getConfig(DRAFT);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// The draft as the page may see it: no TOTP secret.
function publicDraft(d) {
  if (!d) return null;
  const copy = JSON.parse(JSON.stringify(d));
  if (copy.account) delete copy.account.totpSecret;
  return copy;
}

// ---------------------------------------------------------------------------
// Validation, step by step. Each returns {field: message}; empty = fine.

const plain = (v, max = 120) => {
  const t = String(v ?? '').trim();
  if (!t) return 'required';
  if (t.length > max) return `${max} characters at most`;
  if (PLAIN_BAD.test(t)) return 'no quotes, <, >, backslash, $, braces or line breaks (use ’ for an apostrophe)';
  return null;
};
const numberErr = (v) => (/^[0-9+][0-9 ()+-]{1,23}$/.test(String(v || '').trim()) ? null
  : 'a phone number: digits, spaces, + - and brackets');

function validateStep(step, d) {
  const e = {};
  const put = (k, msg) => { if (msg) e[k] = msg; };
  const s = d[step] || {};
  if (step === 'org') {
    put('name', plain(s.name));
    put('shortName', plain(s.shortName, 40));
    if (String(s.website || '').trim() && !/^https?:\/\/[^\s'"<>{}\\$`]+$/.test(String(s.website).trim())) {
      e.website = 'a web address starting https://';
    }
    if (!profile.zoneName(s.timezone)) e.timezone = 'pick a timezone from the list';
    if (String(s.website || '').trim().length > 120) e.website = '120 characters at most';
  } else if (step === 'look') {
    const probs = colorProblems(s.accent);
    if (probs.length) e.accent = probs.join('; ');
    if (s.logo && sanitizeSvg(s.logo).error) e.logo = sanitizeSvg(s.logo).error;
  } else if (step === 'safety') {
    const wantsHelpline = (d.modules || []).includes('helpline');
    const any = s.phone || s.primaryNumber;
    if (wantsHelpline || any) {
      put('phone', numberErr(s.phone));
      put('primaryNumber', numberErr(s.primaryNumber));
      put('primaryLabel', plain(s.primaryLabel, 40));
    }
    if (String(s.secondaryNumber || '').trim()) {
      put('secondaryNumber', numberErr(s.secondaryNumber));
      put('secondaryLabel', plain(s.secondaryLabel, 40));
    }
    const msg = String(s.message || '').trim();
    if (msg && (msg.length > 600 || /[<>{}]/.test(msg))) e.message = 'up to 600 characters, no <, > or braces';
  } else if (step === 'modules') {
    const list = d.modules || [];
    if (!Array.isArray(list) || !list.length) e.modules = 'choose at least one';
    else if (list.some((m) => !['schedule', 'board', 'helpline', 'voice'].includes(m))) e.modules = 'unknown module';
    else if (list.includes('voice') && !profile.base().features.voice) e.modules = 'phone calls are not available here';
    else if (list.includes('voice') && !list.includes('helpline')) e.modules = 'phone calls need the helpline module';
    else if (list.includes('helpline')) {
      const sf = d.safety || {};
      if (numberErr(sf.phone) || numberErr(sf.primaryNumber)) {
        e.modules = 'the helpline needs the safety numbers first (step 3)';
      }
    }
  } else if (step === 'voice') {
    if (!(d.modules || []).includes('voice')) return e;
    const v = d.voice || {};
    if (!require('./voice').providerByName(v.provider || 'mock')) e.provider = 'choose a provider';
    if (String(v.overflowNumber || '').trim()) put('overflowNumber', numberErr(v.overflowNumber));
  } else if (step === 'shifts') {
    if (!(d.modules || []).includes('schedule')) return e;
    const rows = (s.rows || []);
    if (!rows.length) e.rows = 'add at least one shift';
    if (rows.length > 12) e.rows = '12 shifts at most';
    rows.forEach(([label, start, end, mode], i) => {
      const n = i + 1;
      if (plain(label, 40)) e[`row${n}`] = `shift ${n}: name ${plain(label, 40)}`;
      else if (!HHMM.test(start || '') || !HHMM.test(end || '') || start === end) e[`row${n}`] = `shift ${n}: times must be HH:MM and differ`;
      else if (!MODES.includes(mode)) e[`row${n}`] = `shift ${n}: mode must be phone, chat or both`;
    });
    if (s.weekSeats) {
      rows.forEach((_, i) => {
        const w = s.weekSeats[i + 1];
        if (!w) return;
        const ok = WEEKDAYS.every((wd) => Number.isInteger(Number(w[wd])) && Number(w[wd]) >= 0 && Number(w[wd]) <= 6);
        if (!ok) e[`seats${i + 1}`] = `shift ${i + 1}: seats are 0 to 6`;
        else if (!WEEKDAYS.some((wd) => Number(w[wd]) > 0)) e[`seats${i + 1}`] = `shift ${i + 1}: must run on at least one day`;
      });
    }
  } else if (step === 'email') {
    if (String(s.fromName || '').trim()) put('fromName', plain(s.fromName, 60));
  } else if (step === 'account') {
    put('name', plain(s.name, 80));
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s.email || '').trim())) e.email = 'an email address';
  }
  return e;
}

// ---------------------------------------------------------------------------
// The profile the draft describes (for the preview and the ready check).

function draftOverrides(d) {
  const o = {};
  const org = d.org || {};
  const look = d.look || {};
  const sf = d.safety || {};
  // Only values that would pass their step's checks: a half-typed draft
  // can never put a broken value into the preview or the templates.
  const set = (k, v) => {
    const t = String(v ?? '').trim();
    if (t && !profile.overrideError(k, t)) o[k] = t;
  };
  set('name', org.name); set('shortName', org.shortName); set('longName', org.name);
  set('website', org.website); set('timezone', org.timezone);
  if (look.accent && !colorProblems(look.accent).length) {
    for (const [k, v] of Object.entries(deriveColors(look.accent))) o[`colors.${k}`] = v;
  }
  if (look.logo) {
    let svg = (sanitizeSvg(look.logo).svg) || null;
    // The starting profile's own logo follows the new colour.
    try {
      const start = profile.base();
      if (svg && o['colors.accent'] && sanitizeSvg(start.logo.svg).svg === svg) {
        svg = svg.split(start.colors.accent).join(o['colors.accent']);
        // (the base logo is drawn in the base accent colour)
      }
    } catch { /* unknown starting profile: keep the drawing as it is */ }
    if (svg) o['logo.svg'] = svg;
  }
  if (!numberErr(sf.phone)) set('phone', sf.phone);
  if (!numberErr(sf.primaryNumber)) {
    set('emergency.primary.number', sf.primaryNumber); set('emergency.primary.label', sf.primaryLabel);
  }
  if (String(sf.secondaryNumber || '').trim() && !numberErr(sf.secondaryNumber)) {
    set('emergency.secondary.number', sf.secondaryNumber); set('emergency.secondary.label', sf.secondaryLabel);
  }
  set('mail.fromName', (d.email || {}).fromName);
  return o;
}

// The safety-valve message the numbers suggest (step 3 prefills with it).
function suggestedMessage(d) {
  const o = draftOverrides(d);
  const p = previewProfile({ ...d, safety: { ...(d.safety || {}), message: '' } }, o);
  return profile.render(p.safetyValveMessage, p, 'safetyValveMessage');
}

function previewProfile(d, o = draftOverrides(d)) {
  const raw = JSON.parse(JSON.stringify(profile.RAW.get(profile.base())));
  for (const [k, v] of Object.entries(o)) {
    const ks = k.split('.');
    let t = raw;
    for (const x of ks.slice(0, -1)) t = t[x];
    t[ks[ks.length - 1]] = v;
  }
  const msg = String((d.safety || {}).message || '').trim();
  if (msg) raw.safetyValveMessage = msg;
  return profile.withComputedForPreview(raw);
}

// ---------------------------------------------------------------------------
// The ready check: what must hold before finish().

// The modules that will actually run: TL_MODULES wins over the choice.
function effectiveModules(d) {
  if (process.env.TL_MODULES && String(process.env.TL_MODULES).trim()) {
    try { return modules.parse(process.env.TL_MODULES); } catch { /* reported at boot */ }
  }
  return d.modules || [];
}

function readiness(d) {
  const mods = effectiveModules(d);
  const checks = [];
  let encryption = false;
  try { encryption = sec.decrypt(sec.encrypt('setup-check')) === 'setup-check'; } catch { /* no key */ }
  // Set in the environment, not a generated development key file.
  checks.push({ key: 'encryption', ok: encryption && sec.keyFromEnv(), step: null,
    label: 'Encryption key (TL_ENCRYPTION_KEY) is set in the environment and works' });
  checks.push({ key: 'email', ok: mail.configured(), step: 'email', optional: true,
    label: 'Email can be sent (TL_SMTP_URL or TL_RESEND_API_KEY)' });
  checks.push({ key: 'emailTested', ok: !!(d.email && d.email.testedAt), step: 'email', optional: true,
    label: 'A test email arrived' });
  for (const step of STEPS) {
    const errs = validateStep(step, d);
    checks.push({ key: step, ok: !Object.keys(errs).length, step,
      label: { org: 'Organisation details', look: 'Colour and logo', safety: 'Safety numbers',
        modules: 'Modules', voice: 'Phone calls', shifts: 'Shifts', email: 'Email sender',
        account: 'Your account' }[step] });
  }
  if (mods.includes('helpline')) {
    const p = previewProfile(d);
    checks.push({ key: 'safetyNumbers', ok: p.ready.helpline, step: 'safety',
      label: 'Helpline phone and emergency number set (the helpline is on)' });
  }
  // A message written by hand must still carry today's numbers.
  const custom = String((d.safety || {}).message || '').trim();
  if (custom) {
    const sf = d.safety || {};
    const missing = [sf.phone, sf.primaryNumber].map((x) => String(x || '').trim())
      .filter((x) => x && !custom.includes(x));
    checks.push({ key: 'messageNumbers', ok: !missing.length, step: 'safety',
      label: missing.length
        ? `Your “nobody can answer” message doesn’t mention ${missing.join(' or ')} — update it, or clear it to use the suggested one`
        : 'Your “nobody can answer” message has the current numbers' });
  }
  if (d.account && d.account.totp) {
    checks.push({ key: 'totpEnrolled', ok: !!d.account.totpSecret, step: 'account',
      label: 'Authenticator app set up (show the QR code on “Your account”)' });
  }
  if (mods.includes('schedule')) {
    checks.push({ key: 'oneShift', ok: !!((d.shifts || {}).rows || []).length, step: 'shifts',
      label: 'At least one shift (the schedule is on)' });
  }
  if (process.env.TL_MODULES) {
    checks.push({ key: 'modulesEnv', ok: true, step: 'modules', optional: true,
      label: `Modules are fixed by TL_MODULES=${process.env.TL_MODULES} on this server; your choice is saved but the environment wins` });
  }
  return { checks, ok: checks.every((c) => c.ok || c.optional) };
}

// ---------------------------------------------------------------------------
// API used by server.js

async function state() {
  const open = await isOpen();
  if (!open) return { open: false };
  let draft = await readDraft();
  if (!draft) draft = { step: 'org', ...defaultsFrom(profile.base().id) };
  return {
    open: true,
    draft: publicDraft(draft),
    profiles: startProfiles(),
    presets: presets(),
    suggestedMessage: suggestedMessage(draft),
    preview: { colors: previewProfile(draft).colors, logoCssUrl: previewProfile(draft).logo.cssUrl },
    env: {
      mailConfigured: mail.configured(), mailFrom: mail.configured() ? mail.fromAddress() : null,
      modulesFromEnv: process.env.TL_MODULES || null,
      deployHook: !!process.env.TL_DEPLOY_HOOK_URL,
      voiceAvailable: profile.base().features.voice === true,
      voiceProviders: require('./voice').providerList(),
    },
    readiness: readiness(draft),
  };
}

// Merge one step's answers into the draft. `from` (step org) restarts the
// other steps from that profile's values.
async function save(patch) {
  if (!(await isOpen())) return { status: 403, error: 'setup is finished' };
  let d = (await readDraft()) || { step: 'org', ...defaultsFrom(profile.base().id) };
  const p = patch || {};
  if (p.org && p.org.from && p.org.from !== (d.org || {}).from) {
    const ids = startProfiles().map((x) => x.id);
    if (!ids.includes(p.org.from)) return { status: 400, error: 'unknown starting profile' };
    const keep = d.account;
    d = { step: 'org', ...defaultsFrom(p.org.from), account: keep };
  }
  // Shapes first: a malformed patch is refused, never stored (a stored one
  // would break every later state() call).
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  for (const k of ['org', 'look', 'safety', 'shifts', 'voice', 'email', 'account']) {
    if (p[k] !== undefined && !isObj(p[k])) return { status: 400, error: `${k} must be an object` };
    for (const v of Object.values(p[k] || {})) {
      if (k !== 'shifts' && v !== null && !['string', 'boolean', 'number'].includes(typeof v)) {
        return { status: 400, error: `${k}: unexpected value` };
      }
      if (typeof v === 'string' && v.length > 600 && !(k === 'look')) return { status: 400, error: `${k}: value too long` };
    }
  }
  if (p.shifts) {
    const rows = p.shifts.rows;
    if (rows !== undefined && !(Array.isArray(rows) && rows.length <= 24 && rows.every((r) =>
      Array.isArray(r) && r.length === 4 && r.every((x) => typeof x === 'string' && x.length <= 40)))) {
      return { status: 400, error: 'shifts: rows must be [name, start, end, mode]' };
    }
    const w = p.shifts.weekSeats;
    if (w !== undefined && w !== null && !(isObj(w) && Object.values(w).every((x) => isObj(x) &&
      Object.values(x).every((n) => typeof n === 'number' || typeof n === 'string')))) {
      return { status: 400, error: 'shifts: seats must be {shift: {weekday: n}}' };
    }
  }
  if (p.modules !== undefined && !(Array.isArray(p.modules) && p.modules.every((m) => typeof m === 'string'))) {
    return { status: 400, error: 'modules must be a list' };
  }
  if (p.org && typeof p.org.timezone === 'string') p.org.timezone = profile.zoneName(p.org.timezone) || p.org.timezone;
  for (const k of ['org', 'look', 'safety', 'shifts', 'voice']) {
    if (p[k]) d[k] = { ...(d[k] || {}), ...p[k] };
  }
  if (p.email && typeof p.email === 'object') {
    const testedAt = d.email && d.email.testedAt;   // only sendTestEmail() sets it
    d.email = { ...(d.email || {}), ...p.email, testedAt };
  }
  if (p.account && typeof p.account === 'object') {
    const secret = d.account && d.account.totpSecret; // only startTotp() sets it
    d.account = { ...(d.account || {}), ...p.account };
    delete d.account.totpSecret;
    if (secret && d.account.totp) d.account.totpSecret = secret;
  }
  if (Array.isArray(p.modules)) d.modules = p.modules.map(String);
  if (p.look && typeof p.look.logo === 'string' && p.look.logo.trim()) {
    const s = sanitizeSvg(p.look.logo);
    if (s.error) return { status: 400, error: s.error, errors: { logo: s.error } };
    d.look.logo = s.svg;
  }
  if (STEPS.includes(p.step) || p.step === 'ready') d.step = p.step;
  const json = JSON.stringify(d);
  if (json.length > MAX_DRAFT) return { status: 400, error: 'too much data' };
  await setConfig(DRAFT, json);
  const step = Object.keys(p).find((k) => STEPS.includes(k)) || (Array.isArray(p.modules) ? 'modules' : null);
  return { ok: true, errors: step ? validateStep(step, d) : {}, state: await state() };
}

// TOTP enrolment during setup: a secret held (encrypted) in the draft until
// finish(); shown once, as a QR code.
async function startTotp(accountEmail) {
  if (!(await isOpen())) return { status: 403, error: 'setup is finished' };
  const d = (await readDraft()) || { step: 'account', ...defaultsFrom(profile.base().id) };
  const secret = sec.newTotpSecret();
  d.account = { ...(d.account || {}), totp: true, totpSecret: sec.encrypt(secret) };
  await setConfig(DRAFT, JSON.stringify(d));
  const url = sec.otpauthUrl(secret, accountEmail || (d.account.email || 'coordinator'),
    (d.org && d.org.name) || profile.brand('name'));
  const qr = await require('qrcode').toDataURL(url, { margin: 1, width: 200 });
  return { secret, otpauth: url, qr };
}

// The "Phone calls" step's test call: the chosen provider rings, answers,
// plays the message callers would hear on overflow, and hangs up. Nothing
// reaches the queue.
async function voiceTest() {
  if (!(await isOpen())) return { status: 403, error: 'setup is finished' };
  const d = (await readDraft()) || {};
  const p = require('./voice').providerByName((d.voice && d.voice.provider) || 'mock');
  if (!p) return { status: 400, error: 'choose a provider' };
  const pv = previewProfile(d);
  const message = String((d.safety || {}).message || '').trim() ||
    profile.render(pv.safetyValveMessage, pv, 'safetyValveMessage');
  return { ...(await p.selfTest(message)), message };
}

async function sendTestEmail(to) {
  if (!(await isOpen())) return { status: 403, error: 'setup is finished' };
  if (!mail.configured()) return { status: 400, error: 'email is not configured on this server' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(to || '').trim())) return { status: 400, error: 'an email address' };
  // A handful in total, with fixed wording: an open setup page must not be
  // usable to send mail through the lifeline's account.
  const sentSoFar = Number(await getConfig('setup.test_emails')) || 0;
  if (sentSoFar >= 5) return { status: 429, error: 'five test emails have been sent already — finish setup and test from the app' };
  await setConfig('setup.test_emails', String(sentSoFar + 1));
  const d = (await readDraft()) || {};
  const ok = await mail.send(String(to).trim(), 'Setup test email',
    'This is a test from the setup wizard of a new helpline installation. ' +
    'If you can read it, email works.\n\nIf you did not expect this, you can ignore it.');
  if (!ok) return { status: 502, error: 'the email server refused the message — check the mail settings' };
  d.email = { ...(d.email || {}), testedAt: db.now() };
  await setConfig(DRAFT, JSON.stringify(d));
  return { ok: true };
}

// Write everything, create the coordinator, close setup. Returns the new
// coordinator's id. Order matters: settings first (all re-runnable), the
// account (which closes the gate) next, the completion mark last.
async function finish({ password, totpCode } = {}) {
  if (!(await isOpen())) return { status: 403, error: 'setup is finished' };
  const d = await readDraft();
  if (!d) return { status: 400, error: 'nothing to finish yet' };
  const ready = readiness(d);
  if (!ready.ok) {
    return { status: 400, error: 'some steps still need attention', readiness: ready };
  }
  if (String(password || '').length < 10) return { status: 400, error: 'a password of 10 or more characters' };
  if (d.account.totp) {
    if (!d.account.totpSecret || !sec.verifyTotp(sec.decrypt(d.account.totpSecret), totpCode)) {
      return { status: 400, error: 'that authenticator code didn’t match — try the current one' };
    }
  }
  // One finish at a time. A claim left by a crashed finish expires.
  await db.run('DELETE FROM config WHERE key = ? AND value < ?',
    [CLAIM, new Date(Date.now() - 2 * 60_000).toISOString()]);
  const claim = await db.run(`INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING`,
    [CLAIM, db.now()]);
  if (!claim.changes) return { status: 409, error: 'setup is already being finished' };
  try {
    if (!(await isOpen())) return { status: 403, error: 'setup is finished' };
    // 1. Settings as config overrides (brand.*), replacing any earlier run's.
    const o = draftOverrides(d);
    const msg = String((d.safety || {}).message || '').trim();
    await db.run("DELETE FROM config WHERE key LIKE 'brand.%' OR key LIKE 'org.%'");
    for (const [k, v] of Object.entries(o)) {
      if (profile.overrideError(k, v)) continue;
      await setConfig('brand.' + k, v);
    }
    if (msg && !profile.overrideError('safetyValveMessage', msg)) await setConfig('safety_valve_message', msg);
    else await db.run("DELETE FROM config WHERE key = 'safety_valve_message'");
    await profile.loadOverrides((sql) => db.all(sql));

    // 2. Modules (TL_MODULES in the environment still wins).
    await setConfig(MODULES_KEY, (d.modules || []).join(','));
    await modules.loadConfig((sql, params) => db.all(sql, params), true);

    // 2b. Phone calls: provider and overflow; recording stays off.
    if ((d.modules || []).includes('voice')) {
      const v = d.voice || {};
      await require('./voice').setSettings({ provider: v.provider || 'mock',
        overflowNumber: v.overflowNumber || '', recording: false }, { id: null });
    }

    // 3. Shifts, when the schedule is on: shift 1..n as given, others retired.
    if (effectiveModules(d).includes('schedule')) await writeShifts(d.shifts);

    // 4. The coordinator.
    const email = String(d.account.email).trim().toLowerCase();
    const workerId = await db.insert(
      `INSERT INTO worker (email, name, password_hash, role, created_at, totp_secret, totp_enabled)
       VALUES (?,?,?,'coordinator',?,?,?)`,
      [email, String(d.account.name).trim(), sec.hashPassword(password), db.now(),
        d.account.totp ? d.account.totpSecret : null, d.account.totp ? 1 : 0]);
    await db.run('INSERT INTO worker_program (worker_id, program_id) VALUES (?,?) ON CONFLICT DO NOTHING',
      [workerId, await db.chatProgramId()]);

    // 5. Done.
    await setConfig(DONE, db.now());
    await db.run('DELETE FROM config WHERE key IN (?, ?, ?, ?)', [DRAFT, OWNER, 'setup.test_emails', GENERATED]);
    await db.audit(workerId, 'setup_completed', 'config', null,
      `modules ${(d.modules || []).join(',')}; ${Object.keys(o).length} setting(s)`);
    return { ok: true, workerId };
  } finally {
    await db.run('DELETE FROM config WHERE key = ?', [CLAIM]);
  }
}

async function writeShifts(shifts) {
  const schedule = require('./schedule');
  await schedule.ensureShiftsSeeded();
  const rows = (shifts && shifts.rows) || [];
  const weeks = (shifts && shifts.weekSeats) || {};
  const existing = await db.all('SELECT number FROM shift_def');
  const have = new Set(existing.map((r) => Number(r.number)));
  for (let i = 0; i < rows.length; i++) {
    const [label, start, end, mode] = rows[i];
    const number = i + 1;
    const week = weeks[number] || weeks[String(number)];
    const seats = week ? JSON.stringify(Object.fromEntries(WEEKDAYS.map((wd) => [wd, Number(week[wd]) || 0]))) : null;
    if (have.has(number)) {
      await db.run(
        `UPDATE shift_def SET label = ?, start_time = ?, end_time = ?, takeover_time = ?, modes_json = ?,
           kind = 'worker', days_json = NULL, seats = 1, seats_json = ?, active = 1 WHERE number = ?`,
        [String(label).trim(), start, end, start, JSON.stringify({ default: mode }), seats, number]);
    } else {
      await db.run(
        `INSERT INTO shift_def (number, label, start_time, end_time, takeover_time, modes_json, seats_json)
         VALUES (?,?,?,?,?,?,?)`,
        [number, String(label).trim(), start, end, start, JSON.stringify({ default: mode }), seats]);
    }
  }
  // Anything else seeded on this fresh install is retired (no slots exist yet).
  await db.run('UPDATE shift_def SET active = 0 WHERE number > ?', [rows.length]);
  await setConfig('seed:week_seats_v1', db.now());
}

// The finished organisation as a profile file someone can commit to
// profiles/<id>.json: the base profile with the overrides applied and the
// shift pattern as it now stands.
async function exportProfile(id) {
  let name = String(id || 'my-lifeline').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 40) || 'my-lifeline';
  // Never the name of a built-in profile: committing it would replace that one.
  if (['tell', 'generic'].includes(name)) name += '-copy';
  const raw = JSON.parse(JSON.stringify(profile.RAW.get(profile.base())));
  for (const [k, v] of Object.entries(profile.currentOverrides())) {
    const ks = k.split('.');
    let t = raw;
    for (const x of ks.slice(0, -1)) t = t[x];
    t[ks[ks.length - 1]] = v;
  }
  const saved = await getConfig('safety_valve_message');
  if (saved) raw.safetyValveMessage = saved;
  const defs = await db.all('SELECT * FROM shift_def WHERE active = 1 ORDER BY number');
  const workers = defs.filter((r) => (r.kind || 'worker') === 'worker');
  if (workers.length) {
    raw.schedule = {
      ...raw.schedule,
      shifts: workers.map((r) => [Number(r.number), r.label, r.start_time, r.end_time, r.takeover_time,
        JSON.parse(r.modes_json || '{}')]),
      supervision: defs.filter((r) => r.kind === 'supervision').map((r) =>
        [Number(r.number), r.label, r.start_time, r.end_time, JSON.parse(r.days_json || '{}')]),
      weekSeats: Object.fromEntries(workers.filter((r) => r.seats_json)
        .map((r) => [Number(r.number), JSON.parse(r.seats_json)])),
    };
  }
  raw.id = name;
  // The module choice lives outside the profile: set it in the environment.
  const mods = await getConfig(MODULES_KEY);
  raw.notes = { modules: mods || null,
    howTo: mods ? `Run this profile with TL_PROFILE=${name} and TL_MODULES=${mods}.`
      : `Run this profile with TL_PROFILE=${name}.` };
  return raw;
}

// Ask the host to rebuild static pages (Vercel deploy hook), so pages pick
// up what the wizard or the organisation editor saved. Best effort.
async function requestRebuild(reason) {
  const url = process.env.TL_DEPLOY_HOOK_URL;
  if (!url) return false;
  try {
    const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(8000) });
    require('./log').log('rebuild_requested', { reason, status: res.status });
    return res.ok;
  } catch (e) {
    require('./log').log('rebuild_failed', { reason, error: String(e).slice(0, 120) });
    return false;
  }
}

// Setup belongs to the first browser that opens it (a random cookie, kept
// hashed in config "setup.owner"), so nobody else can change the answers —
// the email, the numbers, 2FA — between the owner's review and Finish. It
// frees up after two hours without activity, or for anyone who presents
// TL_SETUP_TOKEN (when one is set).
const OWNER = 'setup.owner';
const OWNER_IDLE_MS = 2 * 3600_000;
const sha256hex = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
async function claimOwner(cookieToken, presentedSetupToken) {
  let o = null;
  try { o = JSON.parse((await getConfig(OWNER)) || 'null'); } catch { o = null; }
  if (o && cookieToken && sha256hex(cookieToken) === o.hash) {
    if (Date.now() - Date.parse(o.at) > 60_000) await setConfig(OWNER, JSON.stringify({ hash: o.hash, at: db.now() }));
    return { ok: true };
  }
  const idle = !o || !(Date.now() - Date.parse(o.at) <= OWNER_IDLE_MS);
  const withToken = !!process.env.TL_SETUP_TOKEN && !!presentedSetupToken && tokenOk(presentedSetupToken);
  if (!idle && !withToken) return { ok: false };
  const token = crypto.randomBytes(24).toString('hex');
  await setConfig(OWNER, JSON.stringify({ hash: sha256hex(token), at: db.now() }));
  return { ok: true, token };
}

const hashToken = (t) => crypto.createHash('sha256').update(String(t || '')).digest();
// TL_SETUP_TOKEN, when set, must accompany every setup call.
function tokenOk(given) {
  const want = process.env.TL_SETUP_TOKEN;
  if (!want) return true;
  return crypto.timingSafeEqual(hashToken(given), hashToken(want));
}

// In production a fresh deployment never sets itself up for whoever finds
// it first: setup needs TL_SETUP_TOKEN, or — when that isn't set — a token
// generated once and printed to the server log (only someone who can read
// the host's logs can start setup). Local development needs none.
const GENERATED = 'setup.generated_token';
async function setupTokenOk(given) {
  if (process.env.TL_SETUP_TOKEN) return tokenOk(given);
  if (!sec.isProduction() || process.env.TL_DEV === '1') return true;
  let row = await getConfig(GENERATED);
  if (!row) {
    const token = crypto.randomBytes(9).toString('base64url');
    const r = await db.run('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING',
      [GENERATED, crypto.createHash('sha256').update(token).digest('hex')]);
    if (r.changes) {
      process.stdout.write(`\n*** First-run setup token: ${token} ***\n` +
        '*** Enter it in the setup wizard. (Set TL_SETUP_TOKEN to choose your own.) ***\n\n');
    }
    row = await getConfig(GENERATED);
  }
  const given_ = crypto.createHash('sha256').update(String(given || '')).digest();
  return crypto.timingSafeEqual(given_, Buffer.from(row, 'hex'));
}

module.exports = {
  enabled, isOpen, claimOwner, setupTokenOk, state, save, startTotp, sendTestEmail, voiceTest, finish, exportProfile, requestRebuild,
  tokenOk, sanitizeSvg, colorProblems, deriveColors, contrast, validateStep, previewProfile,
  readiness, presets, STEPS,
};
