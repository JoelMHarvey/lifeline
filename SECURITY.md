# Security

People in crisis use this software, and its database holds what they said.
This page says how that data is protected, what you must do when you run it,
and how to report a problem.

## Reporting a vulnerability

Please **don't open a public issue.** Use GitHub's private vulnerability
reporting: the repository's **Security** tab, then **Report a
vulnerability**. Include what you found, how to reproduce it, and what an
attacker could reach.

We'll acknowledge it within a few days. We fix anything that exposes caller
data or blocks the caller path first.

## How data is protected

- **Encrypted at rest:** chat messages, intake answers, directives,
  follow-up notes, supervisor feedback, the pre-chat survey and noticeboard
  posts. They use AES-256-GCM under `TL_ENCRYPTION_KEY`. A database dump
  alone doesn't reveal them.
- **Callers are anonymous by design.** A caller is a random token in their
  browser plus an optional nickname. Phone calls (preview) store only a
  keyed hash of the number and its last two digits.
- **Staff accounts:**
  - passwords are hashed with scrypt;
  - sign-in codes by email are single-use and expire after 10 minutes;
  - authenticator-app (TOTP) two-factor is available;
  - sessions are server-side, in HttpOnly SameSite cookies, marked Secure
    on a production deployment.
- **Roles:** trainee, worker, supervisor and coordinator.
  - Every API route checks the role.
  - A worker sees the caller record of a contact they have taken.
  - Supervisors review contacts.
  - Coordinators administer the service.
- **Audit log:** who did what and when. It covers sign-ins, taking a
  contact, intake submission, supervisors opening a contact in review,
  directives, admin and settings changes, backups and schedule changes.
- **Rate limits** on:
  - sign-in and sign-in codes (per address and per email);
  - the team passcode;
  - password changes;
  - chat starts and chat messages;
  - the setup wizard;
  - webhooks and web calls;
  - problem reports.
- **Logs** carry ids, events and counts, never message content or caller
  details. Chat-app and email notifications carry names, dates and shift
  numbers; a help request's note stays in the console.
- **Headers:** pages send `nosniff`, `no-referrer` and, in production, HSTS.
  Only the caller page may be embedded in another site, so the lifeline can
  put the chat on its own website; staff pages refuse to be framed.
- **Fails closed in production:** the server won't start without
  `TL_ENCRYPTION_KEY` or (on Vercel) `DATABASE_URL`, the ops check needs
  `CRON_SECRET`, and `seed.js` (demo accounts with published passwords)
  refuses a real database unless given `--force`.
- **Backups** (`/api/admin/backup`) are encrypted with the same key.
- **Retention:** conversations are deleted for good once they pass the
  retention period: one year by default, changed by a coordinator on the
  Admin page (every change is audited).
- **Fail-safe caller page:** without a configured helpline phone and
  emergency number, the chat doesn't run. The emergency numbers are plain
  HTML, so they show even if the app is down.

## What you must do as an operator

1. **Set `TL_ENCRYPTION_KEY`** to 64 random hex characters
   (`openssl rand -hex 32`). In production the app refuses to start without
   it. Keep a copy apart from your backups: the key is what restores them,
   and losing it loses every encrypted record.
2. **Use HTTPS only.** Vercel and Fly provide it.
3. **Keep the setup token to yourself.** Until the first coordinator
   exists, the setup wizard asks for `TL_SETUP_TOKEN`. If you didn't set
   one, the server prints a token in its log, once, the first time the
   wizard is opened; if you miss it, set `TL_SETUP_TOKEN` and redeploy.
4. **Turn on two-factor** for coordinators and supervisors.
5. **Set `CRON_SECRET`.** The ops check and `/metrics.json` need it (or,
   for metrics, a supervisor's sign-in).
6. **Keep backups** and test a restore (`tools/restore-backup.js`).
7. **Watch the ops check** (`/api/cron/ops-check` with a webhook).
   It reports:
   - the helpline not being configured;
   - unhandled errors;
   - callers stuck past the safety valve;
   - pages built with out-of-date numbers.
8. **Check the retention period** (Admin → Keeping records). Conversations
   are deleted automatically once they're a year old; choose a different
   period, or keep them until someone deletes them, to match your policy.

## Known limitations

- The phone-call feature is a **preview with a test provider only**. Don't
  offer it to real callers (see `app/VOICE.md`).
- **Retention** covers conversations, closed follow-ups, retired directives
  and help requests. Open follow-ups, active directives, the audit log (ids
  and times only), staff accounts and backups aren't expired by it.
- **Rate limits** key on the address from the host's own header (Vercel,
  Fly) or the last `X-Forwarded-For` hop. Behind another proxy that appends
  rather than overwrites, check this suits you.
- **The caller's chat link** carries its access token in the page address.
  It isn't sent to other sites (`no-referrer`), but it can sit in browser
  history on a shared device, as can the caller's saved session.
- **Two-factor is optional.** Coordinators should turn it on; nothing
  forces it yet, and re-enrolling an authenticator doesn't ask for the old
  code.
- **Sign-in session tokens** are stored as issued, not hashed. A database
  leak alone exposes live sessions until they expire (12 hours).
- **If the worker on a chat drops out mid-conversation** the caller waits
  until a supervisor or the safety valve steps in; there's no automatic
  hand-over.
- **If nobody is on shift**, the caller sees the queue and then the safety
  message with your numbers; there's no "closed" state tied to the rota.
