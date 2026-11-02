'use strict';

// Data layer: Postgres in production (DATABASE_URL → Neon), embedded PGlite
// for local dev and tests (no server to install; persists to TL_PGDATA, or
// in-memory when TL_PGDATA=:memory:). One query interface over both.
//
// All timestamps are ISO-8601 TEXT (UTC) — portable and lexicographically
// ordered, so range comparisons work as string comparisons.

const path = require('node:path');
const profile = require('./profile');

let backend = null;      // { query(sqlWithDollars, params) → { rows } }
let ready = null;

function toDollar(sql) {
  // Convert `?` placeholders to $1..$n (no literal '?' appears in our SQL).
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS worker (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  display_name TEXT,
  phone TEXT,
  pronouns TEXT,
  languages TEXT,
  password_hash TEXT NOT NULL,
  must_change_pw INTEGER NOT NULL DEFAULT 0,
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL DEFAULT 'worker'
    CHECK (role IN ('trainee','worker','supervisor','coordinator')),
  supervisor_id BIGINT REFERENCES worker(id),
  service_status TEXT NOT NULL DEFAULT 'in_service'
    CHECK (service_status IN ('in_service','on_leave','left')),
  privacy INTEGER NOT NULL DEFAULT 0,
  notify_prefs TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'off' CHECK (status IN ('off','on_shift','backup')),
  status_updated_at TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS program (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS worker_program (
  worker_id BIGINT NOT NULL REFERENCES worker(id),
  program_id BIGINT NOT NULL REFERENCES program(id),
  PRIMARY KEY (worker_id, program_id)
);

CREATE TABLE IF NOT EXISTS session (
  token TEXT PRIMARY KEY,
  worker_id BIGINT NOT NULL REFERENCES worker(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS caller (
  id BIGSERIAL PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  alias TEXT,
  first_seen TEXT NOT NULL
);

-- One row per interaction. worker_id NULL = still waiting in queue.
-- triage_json and intake_json are encrypted at rest (src/crypto.js).
-- caller_seen_at powers serverless abandonment detection: the caller's
-- stream heartbeat refreshes it and the sweep abandons stale waiting contacts.
CREATE TABLE IF NOT EXISTS contact (
  id BIGSERIAL PRIMARY KEY,
  caller_id BIGINT NOT NULL REFERENCES caller(id),
  worker_id BIGINT REFERENCES worker(id),
  program_id BIGINT REFERENCES program(id),
  chat_token TEXT NOT NULL UNIQUE,
  triage_json TEXT NOT NULL DEFAULT '{}',
  priority INTEGER NOT NULL DEFAULT 0,
  queued_at TEXT NOT NULL,
  claimed_at TEXT,
  ended_at TEXT,
  queue_wait_secs INTEGER,
  outcome TEXT CHECK (outcome IN ('completed','abandoned','timed_out')),
  intake_json TEXT NOT NULL DEFAULT '{}',
  intake_status TEXT NOT NULL DEFAULT 'draft'
    CHECK (intake_status IN ('draft','submitted','reviewed')),
  paged_at TEXT,
  caller_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS contact_observer (
  contact_id BIGINT NOT NULL REFERENCES contact(id),
  worker_id BIGINT NOT NULL REFERENCES worker(id),
  PRIMARY KEY (contact_id, worker_id)
);

CREATE TABLE IF NOT EXISTS message (
  id BIGSERIAL PRIMARY KEY,
  contact_id BIGINT NOT NULL REFERENCES contact(id),
  sender TEXT NOT NULL CHECK (sender IN ('caller','worker','system')),
  body TEXT NOT NULL,
  client_msg_id TEXT,
  sent_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_message_contact ON message(contact_id, id);

CREATE TABLE IF NOT EXISTS canned_response (
  id BIGSERIAL PRIMARY KEY,
  worker_id BIGINT REFERENCES worker(id),
  label TEXT NOT NULL,
  body TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS help_request (
  id BIGSERIAL PRIMARY KEY,
  contact_id BIGINT REFERENCES contact(id),
  worker_id BIGINT NOT NULL REFERENCES worker(id),
  note TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS event_log (
  id BIGSERIAL PRIMARY KEY,
  event TEXT NOT NULL,
  contact_id BIGINT,
  worker_id BIGINT,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  actor_id BIGINT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id BIGINT,
  at TEXT NOT NULL
);

-- Phase 2: versioned form definitions. schema_json is configuration, not
-- caller data, so it is stored in the clear. The current definition of a
-- form is its highest version. Old intakes always render against the
-- version they were submitted under.
CREATE TABLE IF NOT EXISTS form_def (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  schema_json TEXT NOT NULL,
  created_by BIGINT REFERENCES worker(id),
  created_at TEXT NOT NULL,
  UNIQUE (name, version)
);

-- Phase 2: caller directives (iCarol parity). body is encrypted at rest.
-- Retired directives are kept for the record, never deleted.
CREATE TABLE IF NOT EXISTS directive (
  id BIGSERIAL PRIMARY KEY,
  caller_id BIGINT NOT NULL REFERENCES caller(id),
  alert_level TEXT NOT NULL DEFAULT 'info'
    CHECK (alert_level IN ('info','caution','alert')),
  body TEXT NOT NULL,
  created_by BIGINT REFERENCES worker(id),
  created_at TEXT NOT NULL,
  retired_at TEXT,
  retired_by BIGINT REFERENCES worker(id)
);

-- Phase 2: referral directory. status 'suggested' rows come from workers
-- and wait for coordinator approval. Retired resources stay for history.
CREATE TABLE IF NOT EXISTS resource (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  description TEXT,
  url TEXT,
  phone TEXT,
  languages TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','suggested','retired')),
  suggested_by BIGINT REFERENCES worker(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contact_referral (
  contact_id BIGINT NOT NULL REFERENCES contact(id),
  resource_id BIGINT NOT NULL REFERENCES resource(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (contact_id, resource_id)
);

-- Phase 2: manual follow-ups. note is encrypted at rest.
CREATE TABLE IF NOT EXISTS followup (
  id BIGSERIAL PRIMARY KEY,
  caller_id BIGINT NOT NULL REFERENCES caller(id),
  contact_id BIGINT REFERENCES contact(id),
  assigned_to BIGINT NOT NULL REFERENCES worker(id),
  due_at TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','done','cancelled')),
  created_by BIGINT REFERENCES worker(id),
  created_at TEXT NOT NULL,
  done_at TEXT
);

-- Phase 2: supervisor QA loop. A row opens when a worker asks for
-- supervisor follow-up on an intake, or a supervisor starts a review
-- unprompted. body (the written feedback) is encrypted at rest.
CREATE TABLE IF NOT EXISTS feedback (
  id BIGSERIAL PRIMARY KEY,
  contact_id BIGINT NOT NULL REFERENCES contact(id),
  worker_id BIGINT NOT NULL REFERENCES worker(id),
  requested INTEGER NOT NULL DEFAULT 0,
  supervisor_id BIGINT REFERENCES worker(id),
  body TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  acknowledged_at TEXT
);

-- Phase 3: shift definitions (TELL Manual ch.24 S1-S7). times are "HH:MM";
-- an end before the start crosses midnight. modes_json maps weekday names to
-- 'phone' | 'chat' | 'both', with a 'default' key (S3 is chat on weekdays,
-- phone+chat Sat/Sun/Mon).
CREATE TABLE IF NOT EXISTS shift_def (
  number INTEGER PRIMARY KEY,
  label TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  takeover_time TEXT NOT NULL,
  modes_json TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1
);

-- Phase 3: monthly availability. Workers may resubmit — the most recently
-- submitted row per (worker, month) wins, matching the manual's "we will
-- always refer to the most recently dated one". notes is the free-text
-- "Only, Nots and Also" line.
CREATE TABLE IF NOT EXISTS availability (
  id BIGSERIAL PRIMARY KEY,
  worker_id BIGINT NOT NULL REFERENCES worker(id),
  month TEXT NOT NULL,
  can_shifts TEXT NOT NULL DEFAULT '[]',
  desired_shifts INTEGER,
  notes TEXT,
  submitted_at TEXT NOT NULL
);

-- Phase 3: one row per person-slot on the schedule. role distinguishes the
-- worker on the line from On Call Supervisor and Observer (trainee) slots.
-- status: open (unassigned) / assigned / confirmed / sub_requested / cancelled.
CREATE TABLE IF NOT EXISTS shift_slot (
  id BIGSERIAL PRIMARY KEY,
  date TEXT NOT NULL,
  shift_number INTEGER NOT NULL REFERENCES shift_def(number),
  role TEXT NOT NULL DEFAULT 'worker'
    CHECK (role IN ('worker','supervisor','observer','supervised')),
  worker_id BIGINT REFERENCES worker(id),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','assigned','confirmed','sub_requested','cancelled')),
  confirmed_at TEXT,
  sub_requested_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_slot_date ON shift_slot(date, shift_number);

-- Phase 3: noticeboard (the Chatboard replacement). Deliberately simple:
-- topics and flat posts, pinned topics on top. Post bodies are encrypted at
-- rest — notebook entries routinely reference service users.
CREATE TABLE IF NOT EXISTS board_topic (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_by BIGINT REFERENCES worker(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS board_post (
  id BIGSERIAL PRIMARY KEY,
  topic_id BIGINT NOT NULL REFERENCES board_topic(id),
  worker_id BIGINT NOT NULL REFERENCES worker(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_board_post_topic ON board_post(topic_id, id);

-- Per-worker read positions for unread counts.
CREATE TABLE IF NOT EXISTS board_read (
  worker_id BIGINT NOT NULL REFERENCES worker(id),
  topic_id BIGINT NOT NULL REFERENCES board_topic(id),
  last_post_id BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (worker_id, topic_id)
);

-- Supportability: the last unhandled errors, persisted so a maintainer (and
-- the ops-check alert) can see failures without trawling platform logs.
-- Metadata only: path + trimmed message, never request bodies or content.
CREATE TABLE IF NOT EXISTS error_log (
  id BIGSERIAL PRIMARY KEY,
  path TEXT,
  message TEXT NOT NULL,
  at TEXT NOT NULL
);

-- One-time email sign-in codes. Hashed at rest, short-lived, single-use,
-- attempt-capped. Rows are swept opportunistically on each new request.
CREATE TABLE IF NOT EXISTS login_code (
  id BIGSERIAL PRIMARY KEY,
  worker_id BIGINT NOT NULL REFERENCES worker(id),
  code_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0
);

-- Calendar day notes (group meeting nights, special events) — the notes
-- TELL writes beside day headers on the scheduling spreadsheet. One per
-- date, coordinator-managed, staff-facing metadata only.
CREATE TABLE IF NOT EXISTS schedule_note (
  date TEXT PRIMARY KEY,
  note TEXT NOT NULL
);

-- Problem reports and requests from testers and staff, worked through by
-- coordinators on the Ops page. The reference shown to people is TL-<id>.
-- Free text (details, notes) is staff-written but could stray into caller
-- specifics, so it is encrypted at rest like other contact-adjacent text.
CREATE TABLE IF NOT EXISTS issue_report (
  id BIGSERIAL PRIMARY KEY,
  reporter_id BIGINT REFERENCES worker(id),
  kind TEXT NOT NULL DEFAULT 'bug' CHECK (kind IN ('bug','request','question')),
  severity TEXT NOT NULL DEFAULT 'normal' CHECK (severity IN ('minor','normal','blocking')),
  title TEXT NOT NULL,
  body TEXT,
  page TEXT,
  client TEXT,
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','in_progress','fixed','done','wont_fix')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS issue_note (
  id BIGSERIAL PRIMARY KEY,
  issue_id BIGINT NOT NULL REFERENCES issue_report(id),
  author_id BIGINT REFERENCES worker(id),
  status TEXT,
  body TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_issue_note_issue ON issue_note(issue_id, id);

-- Training milestones and certifications, as on iCarol's Skills &
-- Achievements profile section. Workers keep their own list up to date and
-- coordinators can edit anyone's. Staff-facing metadata only.
CREATE TABLE IF NOT EXISTS skill_achievement (
  id BIGSERIAL PRIMARY KEY,
  worker_id BIGINT NOT NULL REFERENCES worker(id),
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  due_on TEXT,
  status TEXT NOT NULL DEFAULT 'to_be_done'
    CHECK (status IN ('to_be_done','in_progress','completed')),
  status_changed TEXT,
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Fixed-window rate limiting that works across serverless instances.
CREATE TABLE IF NOT EXISTS rate_limit (
  key TEXT PRIMARY KEY,
  window_start BIGINT NOT NULL,
  count INTEGER NOT NULL
);

INSERT INTO config (key, value) VALUES ('last_sweep_at', '0')
  ON CONFLICT (key) DO NOTHING;
`;

// Additive migrations for databases created before these columns existed
// (the live Neon instance). ADD COLUMN IF NOT EXISTS is idempotent, so
// running them on every boot is safe. New columns here, new tables above.
const MIGRATIONS = [
  // Phase 2: highlight flag ("other Vols-Staff should be aware") and the
  // form name+version an intake was written under.
  `ALTER TABLE contact ADD COLUMN IF NOT EXISTS highlight INTEGER NOT NULL DEFAULT 0`,
  // People on the line per worker shift (a phone line and a chat line, say);
  // "Create month's slots" makes this many seats per shift per day.
  `ALTER TABLE shift_def ADD COLUMN IF NOT EXISTS seats INTEGER NOT NULL DEFAULT 1`,
  // Emails sent per day (UTC), counts only, so Ops can warn before the
  // provider's daily limit (Gmail ~500) is reached.
  `CREATE TABLE IF NOT EXISTS mail_count (day TEXT PRIMARY KEY, sent INTEGER NOT NULL DEFAULT 0)`,
  // 'chat' (from the caller widget) or 'phone' (an intake a worker starts
  // themselves for a phone call: no queue, no transcript, no pre-chat survey).
  `ALTER TABLE contact ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'chat'`,
  // Voice calls (plan 08, P8): the provider's call id, and the last two
  // digits of the caller's number (the number itself is never stored —
  // caller.token holds a keyed hash so a repeat caller is recognised).
  `ALTER TABLE contact ADD COLUMN IF NOT EXISTS voice_call_id TEXT`,
  `ALTER TABLE contact ADD COLUMN IF NOT EXISTS voice_hint TEXT`,
  // Set once the provider has actually bridged the call to a worker.
  `ALTER TABLE contact ADD COLUMN IF NOT EXISTS voice_answered_at TEXT`,
  // One contact per provider call, however often the webhook is retried.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_voice_call ON contact(voice_call_id) WHERE voice_call_id IS NOT NULL`,
  `ALTER TABLE contact ADD COLUMN IF NOT EXISTS form_name TEXT`,
  `ALTER TABLE contact ADD COLUMN IF NOT EXISTS form_version INTEGER`,
  // Phase 3: per-worker secret for the personal ICS calendar feed.
  `ALTER TABLE worker ADD COLUMN IF NOT EXISTS cal_token TEXT`,
  // Training/support group number — the "S08" in front of names on TELL's
  // schedule sheet and in iCarol. NULL = not in a group.
  `ALTER TABLE worker ADD COLUMN IF NOT EXISTS support_group INTEGER`,
  // Profile fields matching iCarol's User Details page.
  `ALTER TABLE worker ADD COLUMN IF NOT EXISTS title TEXT`,
  `ALTER TABLE worker ADD COLUMN IF NOT EXISTS gender TEXT`,
  `ALTER TABLE worker ADD COLUMN IF NOT EXISTS birthday TEXT`,
  `ALTER TABLE worker ADD COLUMN IF NOT EXISTS preferred_language TEXT`,
  `ALTER TABLE worker ADD COLUMN IF NOT EXISTS background TEXT`,
  `ALTER TABLE worker ADD COLUMN IF NOT EXISTS photo TEXT`,
  `ALTER TABLE worker ADD COLUMN IF NOT EXISTS date_started TEXT`,
  `ALTER TABLE worker ADD COLUMN IF NOT EXISTS end_of_service TEXT`,
  // Day-before shift reminder emails: sent once per slot.
  `ALTER TABLE shift_slot ADD COLUMN IF NOT EXISTS reminded INTEGER NOT NULL DEFAULT 0`,
  // Slot annotations from the scheduling sheet: second-seat labels (SS1),
  // observation markers (10th OS), channel notes (WEBEX).
  `ALTER TABLE shift_slot ADD COLUMN IF NOT EXISTS note TEXT`,
  // Per-shift weekday restrictions on availability: {"3":[1,3]} means shift 3
  // only on Mondays and Wednesdays. A shift with no entry means any day.
  `ALTER TABLE availability ADD COLUMN IF NOT EXISTS can_days TEXT`,
  // Human-readable context on audit entries ("assigned to Ben Demo"), so the
  // schedule changes view reads without reconstructing state. Older rows
  // simply have none.
  `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS detail TEXT`,
  // Supervision blocks live in shift_def beside the worker shifts: kind
  // 'supervision' rows are the On Call Supervisor 12-hour blocks, never
  // offered on the availability form and only assignable to staff.
  `ALTER TABLE shift_def ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'worker'`,
  // Supervision blocks run to a weekly pattern ({"fri":["21:00","02:00"]});
  // absent weekdays are off. NULL means every day at start/end.
  `ALTER TABLE shift_def ADD COLUMN IF NOT EXISTS days_json TEXT`,
  // Worker shifts' seats by weekday ({"sat":4,"mon":0,...}); 0 = the shift
  // doesn't run that day. NULL means "seats" every day.
  `ALTER TABLE shift_def ADD COLUMN IF NOT EXISTS seats_json TEXT`,
  // A trainee slot's number as recorded elsewhere ("SS3" on the imported
  // sheet). Counting carries on from it; NULL = count from history here.
  `ALTER TABLE shift_slot ADD COLUMN IF NOT EXISTS training_no INTEGER`,
  // Per-slot hours: frozen from the pattern when a supervision slot is
  // created, or set by hand for a one-off. NULL follows the definition.
  `ALTER TABLE shift_slot ADD COLUMN IF NOT EXISTS start_time TEXT`,
  `ALTER TABLE shift_slot ADD COLUMN IF NOT EXISTS end_time TEXT`,
  // 1 when the shift editor wrote the old hours onto a past slot (so it
  // keeps them) — not a hand-set one-off, so not shown as "changed".
  `ALTER TABLE shift_slot ADD COLUMN IF NOT EXISTS times_stamped INTEGER NOT NULL DEFAULT 0`,
  // Supervised shifts (SS) join observation shifts as an extra seat. The
  // role CHECK was created inline, so widen it in place — only when it does
  // not already allow the new role, so later boots take no table lock.
  // Problem report references (TL-0007) come from their own gap-free
  // counter: Postgres sequences jump by 32 after a restart, and Neon restarts
  // the database every time it wakes. Reports from before keep the number
  // they were given (their id).
  `ALTER TABLE issue_report ADD COLUMN IF NOT EXISTS ref_no INTEGER`,
  `UPDATE issue_report SET ref_no = id WHERE ref_no IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_issue_ref_no ON issue_report(ref_no)`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shift_slot_role_check'
         AND pg_get_constraintdef(oid) LIKE '%supervised%') THEN
       ALTER TABLE shift_slot DROP CONSTRAINT IF EXISTS shift_slot_role_check;
       ALTER TABLE shift_slot ADD CONSTRAINT shift_slot_role_check
         CHECK (role IN ('worker','supervisor','observer','supervised'));
     END IF;
   END $$`,
];

async function makeBackend() {
  // A serverless host without DATABASE_URL would give every instance its own
  // throwaway database (callers queued where no worker can see them). A
  // production server needs a real database or an explicit data directory.
  if (!process.env.DATABASE_URL && process.env.TL_DEV !== '1') {
    if (process.env.VERCEL) {
      throw new Error('DATABASE_URL is required on Vercel (e.g. a Neon pooled connection string)');
    }
    if (process.env.NODE_ENV === 'production' && !process.env.TL_PGDATA) {
      throw new Error('Set DATABASE_URL (Postgres), or TL_PGDATA to a persistent directory, in production');
    }
  }
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 3, // serverless-friendly; Neon pools upstream
    });
    return { query: (sql, params) => pool.query(sql, params), kind: 'pg' };
  }
  const { PGlite } = require('@electric-sql/pglite');
  // On Vercel without DATABASE_URL, fall back to /tmp so the function still
  // boots — but that storage is EPHEMERAL and per-instance. Set DATABASE_URL
  // (Neon) before any real use; this fallback exists for first-boot previews.
  const dataDir = process.env.TL_PGDATA ||
    (process.env.VERCEL ? '/tmp/tl-pgdata' : path.join(__dirname, '..', '.pgdata'));
  if (process.env.VERCEL && !process.env.DATABASE_URL) {
    process.stderr.write('WARNING: no DATABASE_URL — using EPHEMERAL /tmp storage. ' +
      'Set DATABASE_URL before real use.\n');
  }
  const lite = dataDir === ':memory:' ? new PGlite() : new PGlite(dataDir);
  return { query: (sql, params) => lite.query(sql, params), kind: 'pglite' };
}

async function init() {
  if (!ready) {
    ready = (async () => {
      backend = await makeBackend();
      // Run schema statements one by one (PGlite prefers single statements).
      for (const stmt of SCHEMA.split(';')) {
        const s = stmt.trim();
        if (s) await backend.query(s);
      }
      for (const stmt of MIGRATIONS) await backend.query(stmt);
      // Coordinator overrides of the organisation's display names.
      await profile.loadOverrides(async (sql) => (await backend.query(sql)).rows);
      // The setup wizard's module choice (TL_MODULES still wins).
      await require('./modules').loadConfig(async (sql) => (await backend.query(sql)).rows,
        profile.base().features.setupWizard);
      return backend;
    })();
  }
  return ready;
}

async function all(sql, params = []) {
  await init();
  const r = await backend.query(toDollar(sql), params);
  return r.rows;
}
async function get(sql, params = []) {
  return (await all(sql, params))[0] || null;
}
// For UPDATE/DELETE where the caller needs the affected-row count.
async function run(sql, params = []) {
  await init();
  const r = await backend.query(toDollar(sql), params);
  return { changes: r.affectedRows ?? r.rowCount ?? 0, rows: r.rows || [] };
}
// INSERT returning the new id.
async function insert(sql, params = []) {
  const row = await get(sql + ' RETURNING id', params);
  return Number(row.id);
}

const now = () => new Date().toISOString();

const CONFIG_DEFAULTS = {
  backup_page_after_secs: '90',
  safety_valve_after_secs: '600',
  caller_stale_after_secs: '90',
  max_active_chats: '1',
  chat_program: 'Live Chat',
  // Auto-fill's limit for people who leave "how many shifts" blank.
  autofill_unstated_max: '4',
  // Conversations older than this are deleted (src/retention.js); 0 keeps all.
  retention_days: '365',
  // Built from the profile's numbers; a value saved in the config table
  // still wins, so an existing deployment's own wording is kept.
  get safety_valve_message() {
    return profile.render(profile.profile().safetyValveMessage, profile.profile(),
      'safetyValveMessage');
  },
};

async function getConfig(key) {
  const row = await get('SELECT value FROM config WHERE key = ?', [key]);
  return row ? row.value : CONFIG_DEFAULTS[key];
}

async function eventLog(event, { contactId = null, workerId = null } = {}) {
  await run('INSERT INTO event_log (event, contact_id, worker_id, at) VALUES (?,?,?,?)',
    [event, contactId, workerId, now()]);
}

async function audit(actorId, action, entity = null, entityId = null, detail = null) {
  await run('INSERT INTO audit_log (actor_id, action, entity, entity_id, detail, at) VALUES (?,?,?,?,?,?)',
    [actorId, action, entity, entityId, detail ? String(detail).slice(0, 200) : null, now()]);
}

async function chatProgramId() {
  const name = await getConfig('chat_program');
  let row = await get('SELECT id FROM program WHERE name = ?', [name]);
  if (!row) {
    await run('INSERT INTO program (name) VALUES (?) ON CONFLICT (name) DO NOTHING', [name]);
    row = await get('SELECT id FROM program WHERE name = ?', [name]);
  }
  return Number(row.id);
}

async function workerInProgram(workerId, programId) {
  return !!(await get(
    'SELECT 1 AS x FROM worker_program WHERE worker_id = ? AND program_id = ?',
    [workerId, programId]));
}

const SESSION_HOURS = Number(process.env.TL_SESSION_HOURS || 12);

module.exports = {
  init, all, get, run, insert, now, getConfig, eventLog, audit,
  chatProgramId, workerInProgram, CONFIG_DEFAULTS, SESSION_HOURS,
};
