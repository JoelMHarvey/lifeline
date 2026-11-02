'use strict';

// Which organisation this deployment serves. One deployment, one lifeline:
// TL_PROFILE picks profiles/<id>.json (default "generic"; TELL's own
// deployments set TL_PROFILE=tell), and everything that
// names the organisation — page titles, colours, logo, phone and emergency
// numbers, email subjects, seed shift pattern, form option lists — reads it
// from here. Clinical content is not in the profile and does not change.
//
// Pages are templates in site/ with {{path}} tokens, rendered per profile
// (render() below; tools/render-site.js builds public/ at deploy time; the
// server renders them itself when it runs from the repo). TELL's rendered
// pages are pinned by test/fixtures/tell-pages.json.
//
// Template syntax:
//   {{a.b}}               the value at a.b; null or missing is an error
//   {{#a.b}}...{{/a.b}}   the inside only when a.b is set (non-empty)
//   {{^a.b}}...{{/a.b}}   the inside only when a.b is not set

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'profiles');

// Static requires so serverless bundlers ship the two built-in profiles
// even when they don't trace fs reads.
const BUILT_IN = {
  tell: () => require('../profiles/tell.json'),
  generic: () => require('../profiles/generic.json'),
};

const REQUIRED = ['id', 'name', 'shortName', 'longName', 'org', 'manual', 'website', 'timezone', 'phone',
  'emergency', 'mail', 'colors', 'logo', 'text', 'safetyValveMessage', 'schedule', 'import',
  'forms', 'canned', 'seed'];

// Fields dropped into pages and JavaScript string literals as they are, so
// they may not carry anything that would break out of HTML or a JS string.
const PLAIN = ['name', 'shortName', 'longName', 'org', 'manual', 'website', 'phone',
  'legacy.system', 'legacy.board', 'text.slotNoteExample',
  'emergency.primary.number', 'emergency.primary.label',
  'emergency.secondary.number', 'emergency.secondary.label', 'mail.fromName'];
const UNSAFE = /['"\\<>`$\r\n{}]/;

// Optional switches for features a profile turns on (off when absent).
//   orgEditor    Admin → Organisation: coordinators override display names
//   shiftEditor  Schedule → Shifts: coordinators edit and add shift times
//   setupWizard  first-run setup is the step-by-step wizard (wizard.html),
//                and what it saves (look, numbers, timezone) may override
//                the file — see SETUP_KEYS
//   voice        the console's call panel and the caller page's "call us"
//                button (they still need the voice module switched on)
const FEATURES = ['orgEditor', 'shiftEditor', 'setupWizard', 'voice'];

const COLORS = ['bg', 'panel', 'line', 'ink', 'muted', 'accent', 'accentDark', 'accentInk',
  'deep', 'soft'];
const HEX = /^#[0-9a-fA-F]{6}$/;

// Keys a coordinator may override from the config table ("brand.name" etc).
// Phone and emergency numbers are deliberately not here: the caller page is
// a static file built from the profile, and the numbers on it and in the
// server's messages must never disagree.
const OVERRIDABLE = ['name', 'shortName', 'longName', 'org', 'manual', 'website', 'mail.fromName'];

// What the setup wizard saves on top of those, honoured only when the
// profile file turns setupWizard on (never for TELL). The wizard is the one
// writer: a serverless deployment can't write profile files. Numbers are
// here because a new lifeline enters them in the wizard; pages built from
// them carry a fingerprint (safetyHash) the chat checks, so a page built
// before a number changed can't start a chat (server.js).
const SETUP_KEYS = ['timezone', 'colors.accent', 'colors.accentDark', 'colors.soft', 'colors.deep',
  'logo.svg', 'phone', 'emergency.primary.number', 'emergency.primary.label',
  'emergency.secondary.number', 'emergency.secondary.label', 'safetyValveMessage'];
const NUMBER = /^[0-9+][0-9 ()+-]{1,23}$/;

function get(obj, dotted) {
  let v = obj;
  for (const k of String(dotted).split('.')) {
    if (v === null || v === undefined) return undefined;
    v = v[k];
  }
  return v;
}

// The canonical name of an IANA timezone, or null. Offset forms ("+05:00")
// are refused: older browsers can't format with them.
let ZONES = null;
function zoneName(v) {
  if (typeof v !== 'string' || !v) return null;
  if (!ZONES) {
    try { ZONES = new Set(Intl.supportedValuesOf('timeZone')); } catch { ZONES = new Set(); }
    ZONES.add('UTC');
  }
  if (ZONES.has(v)) return v;
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: v }).resolvedOptions().timeZone;
    return ZONES.has(name) && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(v) ? name : null;
  } catch { return null; }
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

function validate(p, where) {
  const fail = (msg) => { throw new Error(`TL_PROFILE ${where}: ${msg}`); };
  if (!p || typeof p !== 'object') fail('not a JSON object');
  for (const k of REQUIRED) if (!(k in p)) fail(`missing required key "${k}"`);
  for (const k of ['id', 'name', 'shortName', 'longName', 'org', 'manual']) {
    if (typeof p[k] !== 'string' || !p[k].trim()) fail(`"${k}" must be a non-empty string`);
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: p.timezone });
  } catch {
    fail(`"timezone" must be an IANA zone such as "Asia/Tokyo" or "Europe/London" (got ${JSON.stringify(p.timezone)})`);
  }
  if (typeof p.timezone !== 'string' || UNSAFE.test(p.timezone)) fail('"timezone" must be a plain string');
  for (const k of PLAIN) {
    const v = get(p, k);
    if (v === null || v === undefined) continue;
    if (typeof v !== 'string') fail(`"${k}" must be a string or null`);
    if (UNSAFE.test(v)) fail(`"${k}" may not contain quotes, <, >, backslash, $, braces or a newline (use ’ for an apostrophe)`);
  }
  for (const k of ['primary', 'secondary']) {
    if (!p.emergency[k] || typeof p.emergency[k].label !== 'string') fail(`"emergency.${k}" needs a number (or null) and a label`);
  }
  for (const k of COLORS) {
    if (!HEX.test(get(p.colors, k) || '')) fail(`"colors.${k}" must be a #rrggbb colour`);
  }
  if (typeof p.logo.svg !== 'string' || !p.logo.svg.startsWith('<svg') || /["{}]/.test(p.logo.svg)) {
    fail('"logo.svg" must be an <svg> using single quotes, with no braces');
  }
  for (const [k, v] of Object.entries(p.text || {})) {
    if (typeof v !== 'string' || v.includes('{{')) fail(`"text.${k}" must be a string without {{`);
  }
  const s = p.schedule;
  if (!Array.isArray(s.shifts) || !s.shifts.length) fail('"schedule.shifts" needs at least one shift');
  if (!Array.isArray(s.supervision)) fail('"schedule.supervision" must be a list (may be empty)');
  if (!s.weekSeats || typeof s.weekSeats !== 'object') fail('"schedule.weekSeats" must be an object (may be empty)');
  if (s.groupPrefix !== null && !/^[A-Za-z]{1,3}$/.test(s.groupPrefix)) fail('"schedule.groupPrefix" must be 1-3 letters or null');
  if (!p.forms.regionField || !p.forms.regionField.id) fail('"forms.regionField" needs an id');
  if (!Array.isArray(p.forms.nationalityOptions)) fail('"forms.nationalityOptions" must be a list');
  if (!Array.isArray(p.canned.starter)) fail('"canned.starter" must be a list');
  if (!Array.isArray(p.seed.resources)) fail('"seed.resources" must be a list');
  if (p.seed.boardTopics !== undefined && !(Array.isArray(p.seed.boardTopics) &&
      p.seed.boardTopics.every((t) => Array.isArray(t) && typeof t[0] === 'string' && t[0]))) {
    fail('"seed.boardTopics" must be a list of [name, pinned] pairs');
  }
  if (p.features !== undefined) {
    if (!p.features || typeof p.features !== 'object' || Array.isArray(p.features)) fail('"features" must be an object');
    for (const [k, v] of Object.entries(p.features)) {
      if (!FEATURES.includes(k)) fail(`"features.${k}" is not a known feature (known: ${FEATURES.join(', ')})`);
      if (typeof v !== 'boolean') fail(`"features.${k}" must be true or false`);
    }
  }
  if (p.id !== where) fail(`"id" is "${p.id}" but the file is ${where}.json`);
}

// Optional keys a profile may leave out (older or hand-written profiles):
// these neutral values fill the gaps.
const TEXT_DEFAULTS = {
  cssHeader: 'Shared styles.', logoName: 'The logo', siteLabel: '',
  passcodeIntro: 'This site is for the team only. ', indexNotice: '',
  slotNoteExample: 'e.g. first shift, observing', supervisionHours: '',
};

// Values computed from the profile for templates: the logo as a CSS url,
// the deep colour as rgb() parts, and whether the helpline can safely run.
function withComputed(p) {
  const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(', ');
  const cssUrl = 'data:image/svg+xml,' +
    p.logo.svg.replace(/%/g, '%25').replace(/#/g, '%23').replace(/</g, '%3C').replace(/>/g, '%3E');
  return {
    ...p,
    text: { ...TEXT_DEFAULTS, ...(p.text || {}) },
    legacy: { system: null, board: null, ...(p.legacy || {}) },
    prototype: p.prototype === true,
    features: Object.fromEntries(FEATURES.map((k) => [k, !!(p.features && p.features[k])])),
    colors: { ...p.colors, deepRgb: hexRgb(p.colors.deep) },
    logo: { ...p.logo, cssUrl },
    ready: { helpline: !!(p.phone && p.emergency.primary.number) },
    // Fingerprint of everything a caller in crisis reads off the page.
    safetyHash: require('crypto').createHash('sha256').update(JSON.stringify([
      p.phone, p.emergency.primary, p.emergency.secondary])).digest('hex').slice(0, 16),
  };
}

function load(id) {
  const name = String(id || 'generic').trim().toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(name)) throw new Error(`TL_PROFILE "${id}": not a valid profile name`);
  let raw;
  if (BUILT_IN[name]) raw = JSON.parse(JSON.stringify(BUILT_IN[name]()));
  else {
    const file = path.join(DIR, name + '.json');
    if (!fs.existsSync(file)) {
      const known = fs.existsSync(DIR)
        ? fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))
        : Object.keys(BUILT_IN);
      throw new Error(`TL_PROFILE "${id}": no profiles/${name}.json (known: ${known.join(', ')})`);
    }
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
      throw new Error(`TL_PROFILE "${id}": profiles/${name}.json is not valid JSON (${e.message})`);
    }
  }
  validate(raw, name);
  const out = deepFreeze(withComputed(raw));
  RAW.set(out, raw);
  return out;
}
const RAW = new WeakMap(); // computed profile → the validated file contents

let current = load(process.env.TL_PROFILE);
let overrides = {};
let cache = { version: '{}', profile: current };

// The active profile: the file, with config-table overrides applied.
function profile() { return effective(); }
// The file alone (what a static build without database access renders).
function base() { return current; }

// A value from the active profile. Unknown keys throw so a typo can't
// silently print "undefined" in an email.
function brand(key) {
  const v = get(profile(), key);
  if (v === undefined) throw new Error(`brand("${key}"): no such profile key`);
  return v;
}

// Keys an override may set on this deployment.
function allowedKeys() {
  return current.features.setupWizard ? [...OVERRIDABLE, ...SETUP_KEYS] : [...OVERRIDABLE];
}

// Why an override value can't be used, or null when it can.
function overrideError(key, value) {
  if (!allowedKeys().includes(key)) return `${key} can't be overridden`;
  if (typeof value !== 'string') return 'must be text';
  const v = value.trim();
  if (!v) return 'must not be empty';
  if (key === 'safetyValveMessage') {
    if (v.length > 600) return 'must be 600 characters or fewer';
    if (/[<>{}]/.test(v)) return 'may not contain <, > or braces';
    return null;
  }
  if (key === 'logo.svg') {
    if (v.length > 4096) return 'must be 4 KB or smaller';
    if (!v.startsWith('<svg') || /["{}\r\n\f\t\\]/.test(v) || /<script|\bon\w+\s*=|javascript:/i.test(v)) {
      return 'must be a sanitised <svg> (use the wizard’s upload)';
    }
    return null;
  }
  if (v.length > 120) return 'must be 120 characters or fewer';
  if (UNSAFE.test(v)) return 'may not contain quotes, <, >, backslash, $, braces or a newline (use ’ for an apostrophe)';
  if (key === 'website' && !/^https?:\/\/[^\s]+$/.test(v)) return 'must be a web address starting https://';
  if (key.startsWith('colors.') && !HEX.test(v)) return 'must be a #rrggbb colour';
  if (key === 'timezone' && zoneName(v) !== v) return 'must be an IANA timezone such as Europe/London';
  if ((key === 'phone' || /^emergency\.\w+\.number$/.test(key)) && !NUMBER.test(v)) {
    return 'must be a phone number (digits, spaces, + - and brackets)';
  }
  return null;
}

function setPath(obj, dotted, value) {
  const ks = dotted.split('.');
  let o = obj;
  for (const k of ks.slice(0, -1)) o = o[k];
  o[ks[ks.length - 1]] = value;
}

// The active profile with the config-table overrides applied (cached until
// the overrides change). Computed values (logo url, readiness, safetyHash)
// are worked out again from the merged values.
function effective() {
  const version = overridesVersion();
  if (cache.version === version) return cache.profile;
  let p = current;
  if (Object.keys(overrides).length) {
    const merged = JSON.parse(JSON.stringify(RAW.get(current)));
    for (const [k, v] of Object.entries(overrides)) setPath(merged, k, v);
    p = deepFreeze(withComputed(merged));
  }
  cache = { version, profile: p };
  return p;
}
const overridesVersion = () => JSON.stringify(overrides);

// The overrides as {key: value} (for the wizard and the profile export).
const currentOverrides = () => ({ ...overrides });

// Read "brand.<key>" / "org.<key>" rows from the config table. Called by
// db.init() after migrations; a bad override is ignored, not fatal.
async function loadOverrides(query) {
  // Without the organisation editor or the setup wizard nothing may
  // override the file (TELL): a stray row can't rebrand it.
  if (!current.features.orgEditor && !current.features.setupWizard) {
    overrides = {};
    return overrides;
  }
  const rows = await query(
    "SELECT key, value FROM config WHERE key LIKE 'brand.%' OR key LIKE 'org.%'");
  const next = {};
  for (const r of rows) {
    const key = r.key.replace(/^(brand|org)\./, '');
    if (overrideError(key, r.value)) continue;
    next[key] = r.value;
  }
  overrides = next;
  return next;
}

// Render a template against a profile (the active one by default).
function render(template, p = profile(), where = 'template') {
  let out = String(template);
  const section = /\{\{([#^])([\w.]+)\}\}([\s\S]*?)\{\{\/\2\}\}/;
  let m;
  let guard = 0;
  while ((m = section.exec(out))) {
    if (++guard > 10000) throw new Error(`${where}: section nesting runaway`);
    const v = get(p, m[2]);
    const on = !(v === null || v === undefined || v === false || v === '' ||
      (Array.isArray(v) && !v.length));
    const keep = (m[1] === '#') === on;
    out = out.slice(0, m.index) + (keep ? m[3] : '') + out.slice(m.index + m[0].length);
  }
  out = out.replace(/\{\{([\w.]+)\}\}/g, (all, key) => {
    const v = get(p, key);
    if (v === null || v === undefined || typeof v === 'object') {
      throw new Error(`${where}: {{${key}}} has no value in profile "${p.id}"`);
    }
    return String(v);
  });
  const left = out.indexOf('{{');
  if (left !== -1) {
    throw new Error(`${where}: unrendered "${out.slice(left, left + 40)}" (unclosed section?)`);
  }
  return out;
}

// What the public /api/branding returns: enough for an outside page or app
// to match the look, nothing operational.
function publicBranding() {
  const cur = profile();
  return {
    id: cur.id,
    name: brand('name'),
    shortName: brand('shortName'),
    longName: brand('longName'),
    website: brand('website'),
    colors: { ...cur.colors },
    logo: cur.logo.svg,
    phone: cur.phone,
    emergency: {
      primary: { ...cur.emergency.primary },
      secondary: { ...cur.emergency.secondary },
    },
    helplineReady: cur.ready.helpline,
  };
}

// Tests only: switch profile (or back to the env default).
function _set(id) {
  current = load(id === undefined ? process.env.TL_PROFILE : id);
  overrides = {};
  cache = { version: '{}', profile: current };
  return current;
}

module.exports = {
  profile, base, brand, render, load, loadOverrides, publicBranding, _set, OVERRIDABLE, FEATURES,
  SETUP_KEYS, allowedKeys, zoneName, effective, overridesVersion, overrideError, currentOverrides,
  withComputedForPreview: (raw) => withComputed(raw), RAW,
};
