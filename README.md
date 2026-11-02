# Lifeline

**A chat helpline platform for crisis lifelines.** Callers reach a trained
support worker from a web page; workers take them from a shared queue in a
one-screen console; supervisors watch the wallboard and review the records.
It also has a volunteer shift scheduler and a team noticeboard. Each
lifeline hosts its own copy, so its callers' records stay in its own
database.

*"Lifeline" is a working name.*

It was built with and for [TELL](https://telljp.com) (Tokyo English
Lifeline), and is now de-branded so any lifeline can run it. TELL's own
setup ships as one profile among others.

## What it does

- **Caller chat:**
  - a pre-chat survey whose risk answers move the caller up the queue;
  - emergency numbers on the page that work even if the app is down;
  - a "nobody can answer" safety valve;
  - the page refuses to run when no helpline or emergency number is
    configured.
- **The queue:**
  - shared by the team, with on-call backup paging;
  - claiming a caller is atomic, so two workers never take the same person;
  - programs (sub-teams) scope who takes which callers.
- **The worker console:** chat, the caller record (history, directives,
  referrals) and an auto-saving intake on one screen. It also has canned
  replies, trainee observation, follow-ups and "ask for help".
- **Records:**
  - versioned intake forms that coordinators edit without a deploy;
  - the suicide-question ladder;
  - supervisor review and feedback;
  - aggregate service reports;
  - a referral directory.
- **Scheduler and noticeboard:**
  - availability, auto-fill, confirmation, cover requests;
  - calendar feeds in the helpline's own time zone;
  - a team noticeboard.
- **Security:**
  - caller content encrypted at rest (AES-256-GCM);
  - scrypt passwords, sign-in codes and authenticator (TOTP) two-factor;
  - role-based access and an audit log;
  - rate limits and encrypted backups.
- **Your organisation, no code:**
  - a setup wizard on first run covers name, colours, logo, safety
    numbers, modules, shifts, email and the first coordinator;
  - or write a profile file — see [ONBOARDING](app/ONBOARDING.md).
- **Phone calls in the browser** (preview): calls join the same queue as
  chats. Only a test provider exists so far — see [VOICE](app/VOICE.md).

## Quick start (local)

```bash
cd app
npm install
TL_PGDATA=.pgdata npm start          # http://localhost:3000 — the setup wizard opens
npm test                             # the full suite (~8 minutes)
```

With no database configured it uses an embedded Postgres (PGlite) in
`.pgdata/`. Without `TL_ENCRYPTION_KEY` it generates a development key file
and warns you: **set a real key before real callers**.

## Deploying

- **[ONBOARDING](app/ONBOARDING.md):** stand up a new lifeline in 30
  minutes. It covers the wizard, profiles, and which settings are
  safety-critical.
- **[DEPLOY](app/DEPLOY.md):** Vercel + Neon (primary) and Docker/Fly.
  It also covers email, backups and monitoring.
- **[SECURITY](SECURITY.md):** how data is protected, what you must do as
  an operator, and how to report a vulnerability.

### Configuration

| Variable | Needed | What it does |
|---|---|---|
| `DATABASE_URL` | production | Postgres connection string (e.g. Neon). Without it: embedded PGlite. |
| `TL_ENCRYPTION_KEY` | **yes** | 64 hex characters (32 bytes). Encrypts caller content. Keep it apart from backups — it is the restore credential. |
| `TL_PROFILE` | on Vercel | Which profile in `app/profiles/`: `generic` for a new lifeline (TELL uses `tell`). Vercel builds stop without it; elsewhere it defaults to `generic`. |
| `TL_MODULES` | no | `helpline,schedule,board[,voice]`. Default: everything except voice. `schedule` alone is a scheduler-only install. |
| `TL_BASE_URL` | recommended | The site's public address, used for links in emails. |
| `TL_SMTP_URL` or `TL_RESEND_API_KEY` + `TL_MAIL_FROM` | recommended | Email for sign-in codes, reminders and cover requests. |
| `TL_SETUP_TOKEN` | recommended | Guards the first-run wizard. Unset in production, the server prints a one-time token to its log instead. |
| `CRON_SECRET` | yes, in production | Guards the ops check, backups and `/metrics.json` (the ops check refuses to run without it). |
| `TL_NOTIFY_WEBHOOK_URL`, `TL_OPS_WEBHOOK_URL` | no | Google Chat (or compatible) webhooks for team pages and ops alerts. |
| `TL_DEPLOY_HOOK_URL` | no | Rebuilds static pages after the wizard or an organisation edit. |
| `UAT_PASSCODE` | no | A team passcode in front of everything: for trial sites. |
| `TL_VOICE_*` | no | Phone-call preview only; see VOICE.md. |

The full list, with defaults, is in [DEPLOY](app/DEPLOY.md).

## Contributing

See [CONTRIBUTING](CONTRIBUTING.md). Pages live in `app/site/` as templates.
TELL's rendered pages are pinned by a test, so changes can't drift them by
accident.

## Background

Lifeline was designed with TELL (Tokyo English Life Line) as a replacement
for their iCarol setup, and TELL's configuration ships as the `tell` profile.
It has since been de-branded so any lifeline can run it: the `generic`
profile and the setup wizard are the starting point for everyone else.

## Licence

[MIT](LICENSE), © 2026 Joel Harvey.
