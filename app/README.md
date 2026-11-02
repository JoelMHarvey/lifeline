# Lifeline — the application

> Start with the [project README](../README.md), [ONBOARDING](ONBOARDING.md)
> and [DEPLOY](DEPLOY.md). This page is the feature reference, phase by phase.
> The features were specified with TELL, whose setup is the `tell` profile;
> names such as iCarol, Chatboard or the TELL Manual below refer to that case
> study.

The Phase 1 build: caller chat
with pre-chat triage, a real queue with program-scoped backup paging and atomic
claim, the one-screen support-worker console (chat + caller record + auto-saving
intake + canned responses), trainee observation, a supervisor wallboard, coordinator
admin with CSV import, and observability endpoints.

**Phase 2** adds the record-keeping layer, built field-for-field from the
captured iCarol forms:

- **Versioned intake forms**: the full chat intake (demographics, main
  concerns, contributing factors, the Ideation → Intention → Plan → Means
  suicide ladder with honest branching, conversation content, reflection)
  rendered from a JSON definition. Coordinators **add / rename / reorder /
  retire** every option list from the admin screen — no deploy. Each save
  publishes a new version; a record remembers the version it was written
  under and always renders and reports against it; the server enforces
  retire-not-delete.
- **TELL's real pre-chat survey**: the caller widget renders the full survey
  visitors see today (prefecture, main concern, the suicide question,
  self-harm, upset scale, age, gender identity, transgender, nationality,
  nickname) from its own versioned `pre_chat` form — coordinator-editable like
  the intake, served publicly with retired options stripped. Suicide/self-harm
  answers boost queue priority; all answers show in the caller record and
  **prefill the intake** — the worker corrects, not retypes.
- The caller-record column is **resizable** (drag the divider; width is
  remembered per browser).
- **Caller directives** with alert levels (info / caution / alert), shown on
  claim alongside contacts-today; supervisors add and retire them in place.
- **Referral directory**: searchable categorised resources, referrals attached
  to the contact, previous referrals per caller, worker suggest → coordinator
  approve (replacing the Chatboard "Additions to Resources" thread).
- **Supervisor QA loop**: answering yes to "would you like your supervisor to
  follow up with you?" opens an item in the review queue; supervisors review
  intakes against the transcript and send feedback the worker sees and
  acknowledges in their console; feedback marks the intake reviewed.
- **Highlight flag** ("other workers should be aware") on the wallboard and in review.
- **Manual follow-ups** with due dates, in the console.
- **Service reports** (supervisor+): outcome/wait aggregates plus per-field
  answer counts labelled against each record's own form version, with CSV
  download. Aggregates only — free text never reaches a report.

Directives, follow-up notes, feedback bodies and intake answers are all
encrypted at rest like chat content.

**Phase 3** adds the operations layer, specified by TELL Manual ch. 24:

- **Shift calendar** (`schedule.html`): S1–S7 seeded with the manual's exact
  times, modes (S3 varies by weekday) and takeover times; month grid with
  coverage-at-a-glance colours (unstaffed / assigned / confirmed / cover
  wanted); monthly **availability** submission with the "Only, Nots and Also"
  line (latest submission wins) and an all-workers roster view; coordinator
  slot generation and assignment (submitted availability marked in the
  picker); supervisor and observer (trainee) slot types; worker
  **confirmation**; **worker-owned substitution** — flag your shift, any
  eligible colleague takes it, staff are notified via the webhook seam;
  volunteer-hours statistics; printable month view; personal **ICS calendar
  feeds** (private token per worker, works in Google Calendar etc.).
- **Noticeboard** (`board.html`): the Chatboard replacement — Workers' and
  Director's Notebooks and a pinned Protocols & Key Numbers topic seeded;
  flat posts (encrypted at rest — notebook entries mention service users),
  pinned topics, per-worker unread counts, and an unread badge on the
  console's Noticeboard link so the shift-start "read the notebooks" step
  has a visible cue. Supervisors create and pin topics; everyone, trainees
  included, reads and posts.
- The wallboard shows the manual's end-of-shift check: **next-24h shifts not
  yet confirmed** (or unstaffed).

Phase 1 was grown from the prototype and hardened for real use:

- **Accounts**: **email sign-in codes** as the default way in (6 digits, sent
  to the account's inbox, 10-minute expiry, single-use, 5 attempts, hashed at
  rest — needs `TL_SMTP_URL`), plus email + password (scrypt) behind "Use a
  password instead", optional **TOTP MFA** (RFC 6238, tested against the RFC
  vector, honoured by both login paths), expiring server-side sessions, forced
  password change for imported accounts on the password path, login rate
  limiting.
- **Roles**: trainee / worker / supervisor / coordinator with service status
  (in service / on leave / left) and per-worker supervisor links. Trainees are
  read-only: they can never claim or send into a chat — they observe when a
  worker invites them (mirrors TELL's shift-observation training).
- **Profile**: iCarol's User Details fields (photo, title, gender, pronouns,
  birthday, languages, background), a read-only service record, per-worker
  **shift statistics** (scheduled/worked shifts and hours by period),
  **email notification preferences**, and **Skills & achievements** (training
  milestones and certifications: category, title, due date, status with
  change-date tracking, notes — workers keep their own, coordinators can
  manage anyone's).
- **Programs** (e.g. Live Chat vs phone): queue claims and backup paging are
  scoped to the contact's program — never the whole roster.
- **Encryption at rest** (AES-256-GCM, app-level key): chat bodies, triage and
  intake content. Logs and metrics stay metadata-only.
- **Serverless-ready**: SSE streams + POST sends, Postgres (Neon) or embedded
  PGlite, DB-backed rate limiting, and a DB-throttled sweep driven by stream
  heartbeats — runs identically on Vercel and as a plain Node server.
- **Audit log**: append-only record of logins, claims, intake submissions, and
  every admin action.
- **Admin** (coordinator): create/edit workers, roles, service status,
  password resets, and CSV import from iCarol's Vols–Staff export
  (`email,name,role,programs,phone`) — each import row gets a temporary
  password that must be changed on first login.
- **On-call chip**: the console header shows the supervisor currently on
  shift/on call with tap-to-call phone, like iCarol's "Currently on call" panel.

## Run it

Requires Node 22+. Deps: `express`, `pg`, `@electric-sql/pglite`. Transport is SSE + POST (serverless-compatible — deploys to Vercel; see `DEPLOY.md`).

```bash
cd app
npm ci
npm start                 # http://localhost:3000 → /setup creates the coordinator
```

For a demo/UAT database with synthetic accounts instead of /setup:

```bash
npm run seed              # prints synthetic logins (email/password/role)
npm start
```

## Environment

| Var | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string (Neon in production). Unset → embedded PGlite at `TL_PGDATA` (default `app/.pgdata`; `:memory:` for tests) — zero-install local dev. |
| `TL_ENCRYPTION_KEY` | **Required in production.** 64 hex chars (32 bytes) for at-rest encryption. Without it a dev keyfile is generated with a warning. |
| `PORT` | default 3000 (local mode) |
| `UAT_PASSCODE` | gates the site during UAT: browsers get a branded passcode page (30-day cookie); basic auth with the same passcode still works for scripts |
| `CRON_SECRET` | guards `/api/cron/sweep` and `/api/cron/ops-check` (external pingers) |
| `TL_NOTIFY_WEBHOOK_URL` | **Google Chat incoming webhook** for the team space: backup pages, help requests, shift assignments, substitution traffic — human-readable messages, metadata only |
| `TL_OPS_WEBHOOK_URL` | optional second Google Chat webhook for ops alerts/digests (falls back to the team webhook) |
| `TL_BASE_URL` | the app's public URL — adds console/schedule links to Google Chat messages |
| `TL_SMTP_URL` | SMTP URL for **email sign-in codes** (e.g. `smtps://you@gmail.com:app-password@smtp.gmail.com:465` with a Gmail app password). Unset → the login page falls back to password-only. |
| `TL_MAIL_FROM` | From header for all email (defaults to the SMTP username); required with Resend, on its verified domain |
| `TL_RESEND_API_KEY` | optional: send through **Resend** (an email service) instead of SMTP, for when Gmail's ~500/day limit is too low. Remove it to fall back to `TL_SMTP_URL`. See DEPLOY.md → "Switching to an email service" |
| `TL_MAIL_DAILY_LIMIT` | optional: the provider's daily cap, for the Ops warning (Gmail's 500 is assumed for `smtp.gmail.com`) |
| `TL_USAGE_EMAIL` | where the trial-time **usage alert** goes (counts-only email from the ops self-check when the site has been used since the last check; defaults to the SMTP account's own address) |

## Tests

```bash
npm test   # queue/routing + security + phase 2: atomic claim, program scoping,
           # trainee gates, sweep/paging/safety valve, scrypt, AES-GCM, TOTP RFC
           # vector, sessions, rate limiting, form versioning (retire-not-delete),
           # directives, referrals, QA loop, follow-ups, report aggregation
```

## Supportability & help

- **Google Chat delivery**: notifications land in the team's existing Google
  Chat space (see the environment table). The Ops page has a
  "send test notifications" button to verify both webhooks after setup.
- **Per-worker email copies**: each worker opts in per event kind on My
  profile (shift assigned, day-before reminder, cover wanted/resolved,
  backup page, help requests, feedback left, follow-up assigned). Uses the
  same `TL_SMTP_URL` as sign-in codes; metadata only, default off. Personal
  kinds (reminders, feedback, follow-ups) go by email only, never to the
  shared space.
- **Ops page** (`ops.html`, coordinator): health, which settings are
  configured, last-24h event counts, and the most recent unhandled errors
  (persisted in `error_log`, capped at 500) — the first place to look before
  platform logs.
- **`/api/cron/ops-check`** (CRON_SECRET-guarded): checks database,
  encryption, recent errors, stuck queue, sweep freshness, and unstaffed
  next-24h shifts; posts an alert to the ops webhook when anything is wrong,
  or a daily digest with `?digest=1`; also sends the day-before shift
  reminder emails (once per slot). Point a second UptimeRobot monitor at it.
- **User guide** (`help.html`): the full in-app manual — getting started,
  shifts, chats, intake, review, admin, troubleshooting — linked as "Help"
  in the console header.

## Remaining before real caller data (tracked for Phase 1 completion)

- Clinical/board sign-off on the data-protection design.
