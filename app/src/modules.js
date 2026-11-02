'use strict';

// Which parts of the app this deployment runs. TL_MODULES is a comma list;
// unset means everything (today's full TELL install).
//
//   helpline  caller chat, queue, console, intake/records, directives,
//             referrals, review, reports, wallboard — everything that
//             touches caller data
//   schedule  shift calendar, availability, ICS feeds
//   board     the noticeboard
//
// Core (accounts, sign-in, profile, admin, ops, problem reports) is always
// on. TL_MODULES=schedule is the scheduler-only install: no caller data,
// and no queue sweep keeping the database awake.

//   voice     phone calls answered in the browser (plan 08, P8). Opt-in
//             only: never part of the default set, and needs helpline.

const ALL = ['helpline', 'schedule', 'board', 'voice'];
// Unset TL_MODULES means these — everything except voice.
const DEFAULT = ['helpline', 'schedule', 'board'];

function parse(value) {
  if (value === undefined || value === null || !String(value).trim()) return [...DEFAULT];
  const list = String(value).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const bad = list.filter((m) => !ALL.includes(m));
  if (bad.length) throw new Error(`TL_MODULES: unknown module(s) ${bad.join(', ')} (known: ${ALL.join(', ')})`);
  if (list.includes('voice') && !list.includes('helpline')) {
    throw new Error('TL_MODULES: voice needs helpline (a call is a helpline contact)');
  }
  return ALL.filter((m) => list.includes(m));
}

// API path prefixes per module. Anything not listed is core.
const API_PREFIXES = {
  schedule: ['/api/schedule', '/api/availability', '/api/shift-defs', '/api/shifts', '/api/my-cal-token'],
  board: ['/api/board'],
  voice: ['/api/voice'],
  helpline: ['/api/chat', '/api/claim', '/api/directives', '/api/end', '/api/followups',
    '/api/form', '/api/admin/forms', '/api/help', '/api/intake', '/api/my-chats', '/api/my-feedback',
    '/api/observe', '/api/observers', '/api/phone-intake', '/api/prechat', '/api/referral',
    '/api/reports', '/api/resources', '/api/review', '/api/canned', '/api/wallboard',
    '/api/worker', '/api/status', '/api/cron/sweep', '/metrics.json'],
};

function moduleOfPath(path) {
  for (const [mod, prefixes] of Object.entries(API_PREFIXES)) {
    if (prefixes.some((p) => path === p || path.startsWith(p + '/'))) return mod;
  }
  return null;
}

let enabledList = parse(process.env.TL_MODULES);

const enabled = (mod) => enabledList.includes(mod);
const list = () => [...enabledList];

// Express middleware: a disabled module's API answers 404 as if absent.
// The queue pinger gets a quiet 200 so uptime monitors don't page anyone.
function gate(req, res, next) {
  const mod = moduleOfPath(req.path);
  if (!mod || enabled(mod)) return next();
  if (req.path === '/api/cron/sweep') return res.json({ ok: true, skipped: 'helpline module off' });
  return res.status(404).json({ error: 'not available on this installation' });
}

// The setup wizard's choice (config "setup.modules"), used when TL_MODULES
// isn't set and the profile has the wizard on. The environment always wins.
async function loadConfig(query, allowed) {
  if (!allowed || (process.env.TL_MODULES && String(process.env.TL_MODULES).trim())) return false;
  const rows = await query("SELECT value FROM config WHERE key = 'setup.modules'");
  if (!rows[0] || !rows[0].value) return false;
  try { enabledList = parse(rows[0].value); return true; } catch { return false; }
}

// Tests switch modules without restarting the process.
function _set(value) { enabledList = parse(value); }

module.exports = { ALL, DEFAULT, parse, enabled, list, gate, moduleOfPath, loadConfig, _set };
