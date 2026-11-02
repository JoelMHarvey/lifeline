# Deploying Lifeline

The app is built to run serverless:
- Express runs behind `api/index.js`.
- Transport is SSE plus POST; there are no WebSockets.
- Postgres connects via `DATABASE_URL`.
- A sweep, throttled through the database, runs from stream heartbeats.

**Vercel + Neon is the primary deployment.** The Dockerfile and `fly.toml`
cover self-hosting on Docker or Fly.

New here? [ONBOARDING.md](ONBOARDING.md) walks through standing up a lifeline:
the first-run wizard, profiles and the safety-critical settings. This file is
the hosting detail.

**Which organisation:** `TL_PROFILE` picks `profiles/<id>.json`. Unset means
`generic`, a neutral starting point the setup wizard makes yours. TELL's own
deployments set `TL_PROFILE=tell`.

**Pages are built at deploy time.** `npm run build` renders `site/` into
`public/` for the profile. `vercel.json` sets it as the build command, so
Vercel does this on every deploy. A server started from the repo (`npm start`,
Docker) renders the pages itself.

## Vercel + Neon (primary)

1. **Database:** in the [Neon console](https://console.neon.tech), create a
   project in the region closest to your callers, and copy the pooled
   connection string.

2. **Vercel project:** import your copy of the repository with **Root
   Directory = `app`** and the Framework preset set to Other. The build
   command and output directory come from `vercel.json`.

3. **Environment variables** (Project → Settings → Environment Variables,
   apply to Production + Preview):

   | Var | Value |
   |---|---|
   | `DATABASE_URL` | the Neon pooled connection string |
   | `TL_ENCRYPTION_KEY` | `openssl rand -hex 32` — **store a copy safely**; losing it means losing every encrypted record |
   | `UAT_PASSCODE` | gate for the API during UAT (see note below) |
   | `TL_PROFILE` | **required on Vercel** (the build stops without it): the profile in `profiles/`, `generic` for a new lifeline. **TELL: `tell`** |
   | `TL_MODULES` | optional; which parts run — `schedule` for the scheduler-only install (see below). Unset = everything except voice |
   | `TL_SETUP_TOKEN` | recommended for a fresh deployment: the setup wizard asks for it |
   | `CRON_SECRET` | random string guarding the ops check, backups and `/metrics.json` (required for the ops check in production) |

4. **Deploy:** push to `main`, or redeploy from the dashboard. Then open
   the site. On the neutral profile the **setup wizard** opens: organisation,
   look, safety numbers, modules, shifts, email, your coordinator account.
   Then add the team in `/admin.html`, or import them from CSV.

5. **Sweep backstop** — paging/safety-valve/abandonment sweeps run whenever
   any caller or worker stream is open (i.e. whenever anyone is waiting —
   exactly when they're needed), so no frequent external sweep is required.
   See **Monitoring without waking Neon** below before adding any monitor.

### Page protection on Vercel

Static pages are served by Vercel's CDN, so the app's `UAT_PASSCODE` gate
covers only the API — but that is enough: when an API call is refused, the
page sends the visitor to `/passcode.html`, a branded "enter the team
passcode" screen that sets a 30-day cookie. Nobody sees a native browser
login dialog. Basic auth with the same passcode (any username) still passes,
so curl/scripts keep working. For belt-and-braces page gating, Vercel
**Deployment Protection** (password) remains an option — though every page
is useless without an account login anyway (`/caller.html` is the one public
surface, and it is designed to be public in production).

## Scheduler-only install (as TELL's pilot ran)

A separate Vercel project and database running only the shift calendar:
set `TL_MODULES=schedule` (add `,board` for the noticeboard). Caller chat,
intake, directives, reports and the wallboard are switched off — their APIs
answer 404 and their pages send people to the schedule — so this install
holds no caller data. `/api/cron/sweep` answers 200 without touching the
database, so an existing pinger doesn't keep Neon awake. Sign-in, profiles,
admin (with CSV import), Ops and problem reports work as usual.

To load a month from the coordinator's Excel workbook for the parallel run,
import the volunteers first (Admin → CSV import; an iCarol name like
`S08 Alex Morgan` sets support group 8), then:

```
DATABASE_URL=... TL_ENCRYPTION_KEY=... \
  node tools/import-sheet.js TELL_Lifeline_SCHEDULE.xlsx --tab "2026 November"
```

It's a dry run: it reports how many people-shifts it would place and lists
every name it couldn't match to an account. Fix those (or add the people),
then add `--apply`. Nobody is notified; re-running places only what's
missing. Run it from a machine you trust — the workbook holds volunteers'
names.

## Fly.io / Docker (fallback)

Works with the embedded PGlite database on a volume — no external Postgres:

```bash
fly launch --no-deploy --copy-config --name tell-lifeline --region nrt
fly volumes create tell_data --region nrt --size 1
fly secrets set TL_ENCRYPTION_KEY=$(openssl rand -hex 32) UAT_PASSCODE='...'
fly deploy       # fly.toml sets TL_PGDATA=/data/pgdata
```

Or set `DATABASE_URL` to any Postgres and skip the volume.

## UAT checklist before sharing the URL

- [ ] `TL_ENCRYPTION_KEY` is set and a copy is stored safely
- [ ] `DATABASE_URL` points at the intended database
- [ ] UAT gate on (passcode and/or Vercel Deployment Protection)
- [ ] Open `/healthz?deep=1` — expect `{"ok":true,...,"db":true}`
- [ ] `/setup` done; seeded/demo accounts are **not** used in a real deploy
- [ ] Remind the team: **synthetic role-play only, no real caller stories** —
      content is encrypted at rest, but the build is not approved for real
      data until the remaining items in `README.md` and the clinical/board
      sign-off are done

## Suggested UAT script for the team

Run the two-window walkthrough in `README.md` as a role-play: one person
plays a caller on their phone, one worker on shift, one backup who answers
the 90-second page, a supervisor on the wallboard, a trainee invited to
observe. Capture friction notes straight into GitHub issues.


## Google Chat notifications + ops alerts

1. In the team's Google Chat space: space name → **Apps & integrations →
   Webhooks → Add webhook**. Copy the URL into `TL_NOTIFY_WEBHOOK_URL`.
2. Optionally repeat in a private ops space for `TL_OPS_WEBHOOK_URL`.
3. Set `TL_BASE_URL` to the production URL so messages carry links.
4. Redeploy, then press **Send test notifications** on `ops.html` — both
   spaces should receive a hello.
5. Add an UptimeRobot monitor for the self-check:
   `https://<app>/api/cron/ops-check?secret=<CRON_SECRET>` **hourly** (see
   the Neon section below for why not more often). It alerts the ops space
   when something is wrong; add `&digest=1` on a once-a-day monitor for a
   green-day summary too.

## Monitoring without waking Neon

Neon bills by compute time and suspends after ~5 idle minutes — but only if
nothing touches the database. A monitor that pings a DB-touching endpoint
every 5 minutes keeps compute awake (and billing) 24 hours a day. The
cheap setup:

- **Uptime monitor** (as often as you like): plain `/healthz`. It proves
  the deployment answers without any database work.
- **Self-check monitor** (hourly, not more): `/api/cron/ops-check?secret=…`.
  This is the one deliberate DB wake-up — health checks, shift reminders
  and the usage alert all ride it. Hourly ≈ a couple of compute-hours a
  day instead of twenty-four.
- **No sweep monitor needed.** Sweeps run from live caller/worker streams,
  exactly when someone is waiting; ops-check alerts if callers are waiting
  and sweeps have stopped. Keep `/api/cron/sweep` only for manual pokes.
- In the Neon console, make sure the compute's **scale to zero** (autosuspend)
  is enabled, and avoid dashboards or scripts that poll `/metrics.json` or
  `/healthz?deep=1` on a timer — both query the database.

With this setup the database is awake only while people actually use the
site, plus about five minutes per hour for the self-check.
   The same self-check also sends a counts-only **usage alert** email
   (new caller contacts, caller messages, sign-in codes since the last
   check) to `TL_USAGE_EMAIL`, defaulting to the SMTP account's own
   mailbox — handy during the trial for knowing the moment testers
   actually use the site. No content or caller details, ever.

## Email sign-in codes

The login page's default is "enter your email, we send a 6-digit code" —
no passwords for UAT volunteers to manage. It needs an SMTP account to send
from. With a Gmail address:

1. On the Google account: **Security → 2-Step Verification** must be on,
   then **App passwords** → create one for "Mail" (16 characters, shown once).
2. Set `TL_SMTP_URL` in Vercel:
   `smtps://your.address%40gmail.com:abcdabcdabcdabcd@smtp.gmail.com:465`
   — note the `%40` for the `@` in the username, and the app password with
   the spaces removed. Optionally set `TL_MAIL_FROM` for a nicer From line.
3. Redeploy. The Ops page's environment list shows `email_codes: yes` when
   the app sees the config, and sending yourself a code from the login page
   confirms end to end.

Without `TL_SMTP_URL` the login page detects it and falls back to the
password form, so nothing breaks while this is unset. Any other provider's
SMTP URL works the same way (`smtps://` for port 465, `smtp://` with STARTTLS
for 587).

## Switching to an email service (when the Gmail limit bites)

Gmail sends to about **500 recipients a day**, then refuses until the next
day — sign-in codes included. At ~150 volunteers a month is roughly 65
assignment emails, ~30 availability reminders, and ~130 per cover request,
so a few cover requests on a busy day reach it. The **Ops → Email** line
shows today's count against the limit and turns red at 80%.

The app also speaks **Resend** (resend.com), an email service built for
this. It is used whenever its key is set; Gmail stays the fallback.
Pricing at the time of writing: free for 3,000 emails a month (100 a day),
Pro $20/month for 50,000.

1. Create a Resend account and **add the sending domain** (e.g.
   `telljp.com`). Resend shows a few DNS records (SPF/DKIM); TELL's IT adds
   them where the domain's DNS is managed. Wait for "Verified".
2. **API Keys → Create** a key with "Sending access" only.
3. In Vercel → tell-lifeline → Settings → Environment Variables (Production):
   - `TL_RESEND_API_KEY` = the key (`re_…`)
   - `TL_MAIL_FROM` = `TELL Lifeline <lifeline@telljp.com>` — any address on
     the verified domain. Required: Resend refuses unverified senders.
   - `TL_MAIL_DAILY_LIMIT` = the plan's daily cap, so Ops warns against it
     (`100` on the free plan; leave unset on Pro, which has none).
   - `TL_USAGE_EMAIL` = the mailbox that should get usage alerts (with no
     SMTP account they otherwise go to the `TL_MAIL_FROM` address).
4. Redeploy. Ops → Email should read "Sending through Resend (email
   service) as …"; send yourself a sign-in code to confirm.

**Switching back:** delete `TL_RESEND_API_KEY` and redeploy — `TL_SMTP_URL`
(Gmail) takes over again. Keep `TL_SMTP_URL` set as the fallback.

Bulk emails (cover requests, availability reminders) go 100 to a request
with Resend, so a 130-person cover email is two calls instead of 130.
Every person still gets their own email; nobody sees anyone else's
address. Note that mail sent through Resend no longer appears in the Gmail
account's Sent folder.

## Encrypted backups

The Ops page has **Download encrypted backup** — one file holding every
durable table, AES-256-GCM-encrypted under `TL_ENCRYPTION_KEY`. For scheduled
off-site copies, fetch it with the cron secret from any machine TELL controls
(e.g. a weekly launchd/cron job on a Mac):

```bash
curl -fsS "https://<app>/api/admin/backup?secret=$CRON_SECRET" \
  -o "tell-backup-$(date +%F).enc"
```

Keep the files and the key apart: the backup is useless without the key, and
the key is the restore credential. To restore into a fresh database:

```bash
cd app
TL_ENCRYPTION_KEY=... DATABASE_URL=<target> node tools/restore-backup.js tell-backup-....enc --yes
```

Restoring replaces the target database's content (sessions excluded —
everyone signs in again).
