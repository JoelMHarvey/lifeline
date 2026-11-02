# Stand up a new lifeline in 30 minutes

The same code runs TELL and any other helpline. What differs is one file:
`profiles/<id>.json`, picked by the `TL_PROFILE` environment variable. With
no `TL_PROFILE` the app starts from `generic`, a neutral profile that the
setup wizard makes yours. TELL's deployments set `TL_PROFILE=tell`.

One deployment serves one organisation. There is no multi-tenancy.

## The quick way: the setup wizard

Deploy with no `TL_PROFILE` (the neutral `generic` profile), or with any profile that has `features.setupWizard: true`, on an empty database. Then open the site.

- It sends you to `wizard.html`, which walks you through eight steps:
  1. organisation and time zone;
  2. colour (checked for contrast) and logo (cleaned of anything but shapes);
  3. the safety numbers;
  4. modules;
  5. shifts (presets, or your own rows and seats per weekday);
  6. email (with a test send);
  7. your coordinator account (with optional authenticator);
  8. a ready check.
- Progress is saved as you go, so a closed tab resumes where it was.
- Nothing takes effect until **Finish**. The wizard can never be opened again once an account exists.

What it saves lives in the database:
- Settings go in the `config` table as `brand.*` overrides, because a serverless host can't write profile files.
- The module choice is `setup.modules`. A `TL_MODULES` environment variable still wins.
- Shifts go in as ordinary shift rows.

Afterwards, **Download these settings as a profile file** gives you a `profiles/<id>.json` you can commit and reuse.

| Environment variable | What it does |
|---|---|
| `TL_SETUP_TOKEN` | Recommended. The wizard asks for it first, so nobody else can set up a fresh deployment before you. Unset in production, the server prints a one-time token to its log the first time the wizard is opened (set this variable if you miss it). Setup also belongs to the first browser that opens it; another browser is turned away until two hours pass without activity, or until it presents the token. |
| `TL_DEPLOY_HOOK_URL` | Optional. A Vercel deploy hook. Finishing the wizard, or saving on Admin → Organisation, triggers a rebuild so the static pages show the new name, colours and numbers. |

On a static host, the build step (`npm run build`, already set in `vercel.json`) reads the saved settings when `DATABASE_URL` is available at build time.

Until pages are rebuilt with the new numbers, the caller page refuses to start a chat. The page carries a fingerprint of the numbers it shows, and the server returns "this page is out of date". It never runs a chat on a page showing old numbers.

The rest of this guide is the manual way, by editing a profile file.

## 1. Copy a profile (5 minutes)

```bash
cp profiles/generic.json profiles/acme.json
```

Set `"id": "acme"` (it must match the file name), then work through the
table below. The server checks the file at boot and refuses to start if a
required key is missing or a value is malformed. The error names the key.

## 2. Fill it in (15 minutes)

**Safety-critical** keys are marked ⚠. The caller sees them in a crisis.
Get a second person to check them against the organisation's published
numbers before going live.

| Key | What it is | Notes |
|---|---|---|
| `id` | Short name of the profile | Same as the file name |
| `name` | Product name, e.g. `TELL Lifeline` | Page titles, email subjects, the authenticator app label, calendar feed |
| `shortName` | Short form, e.g. `TELL` | Page titles, calendar event titles, browser notifications |
| `longName` | Full name, e.g. `TELL — Tokyo English Lifeline` | Logo tooltip on the caller page |
| `org` | How text refers to the organisation, e.g. `TELL` or `the organisation` | Used as "{org}'s starter set" |
| `manual` | Name of the training manual | Help page |
| `website` | Public site URL, or `null` | Logo link on the caller page; `null` means no link |
| ⚠ `timezone` | IANA zone where the helpline is, e.g. `Asia/Tokyo`, `Europe/London` | Shift times are wall-clock times there; calendar feeds, reminders and the 24-hour checks convert them. Wrong zone = shifts at the wrong hour in people's calendars |
| ⚠ `phone` | Helpline phone number shown to callers | `null` switches the caller chat off (see below) |
| ⚠ `emergency.primary` | `{ "number": "119", "label": "ambulance/fire" }` | `number: null` switches the caller chat off |
| ⚠ `emergency.secondary` | `{ "number": "110", "label": "police" }` | `number` may be `null` (it is left out) |
| ⚠ `safetyValveMessage` | What a caller sees after a long wait | A template: `{{phone}}`, `{{emergency.primary.number}}` etc. A message saved in the config table (`safety_valve_message`) still wins |
| ⚠ `canned.starter` | The starter canned replies, `[label, text]` | The `Emergency` reply must carry this organisation's numbers |
| `mail.fromName` | Display name for a bare From address, or `null` | `null` leaves `TL_MAIL_FROM` as it is |
| `colors.*` | `bg panel line ink muted accent accentDark accentInk deep soft`, each `#rrggbb` | Text colours must pass WCAG AA (4.5:1). The generic profile's are checked in `test/debrand.test.js` |
| `logo.svg` | An inline `<svg>` using single quotes | Drawn beside headings. No web fonts or remote images |
| `text.cssHeader`, `text.logoName` | Comment text in `shared.css` | Cosmetic |
| `schedule.shifts` | `[number, label, start, end, takeover, {default: mode, sat: mode…}]` | Seeds a **new** database only. Mode is `phone`, `chat` or `both` |
| `schedule.supervision` | `[number, label, start, end, {weekday: [start, end]}]` | On-call supervisor blocks; `[]` for none |
| `schedule.weekSeats` | `{shift number: {sun: 2, mon: 1…}}` | Seats per weekday; `{}` = one seat every day |
| `schedule.groupPrefix` | Support-group letter, e.g. `"S"` for "S08 Alex M" | `null` hides support groups |
| `features.orgEditor` | `true` adds Admin → Organisation: coordinators override the display names (audited) | Off for TELL. Numbers are never editable there |
| `features.shiftEditor` | `true` adds Schedule → Shifts: coordinators rename, re-time and add shifts (audited) | Off for TELL. New hours apply from today; past slots keep theirs |
| `features.setupWizard` | `true` makes first-run setup the wizard, and lets what it saves (look, numbers, timezone) override this file | Off for TELL |
| `features.voice` | `true` puts the console call panel and the caller page’s “Call us” button on the pages (calls also need `voice` in the modules) | Off for TELL. Preview: mock provider only — see VOICE.md |
| `import.tellWorkbook` | `true` only for TELL | Turns on the TELL-format workbook import |
| `forms.regionField` | The first pre-chat question: where the caller is | A select with options, or `{ "id": "region", "type": "text", "label": "…" }` |
| `forms.nationalityOptions` | `[{ "id": …, "label": … }]` | Used in the pre-chat survey and the intake |
| `seed.resources` | `[name, category, description, url, phone]` | Only `npm run seed` reads these (test data) |

Seeds (shifts, forms, canned replies) are written once, into an empty
database. Changing the profile later never rewrites stored forms or shifts.
Change those in the app.

### Phone numbers missing? The chat stays off

If `phone` or `emergency.primary.number` is `null`, the deployment
**fails closed**:

- the caller page says the chat is not available and points to local
  emergency services;
- `/api/chat/start` and `/api/prechat/form` return 503;
- staff see a red banner on the console;
- `/healthz` returns 500 with `"helpline": false`, and the ops check reports
  `Helpline NOT CONFIGURED`.

A scheduler-only deployment (`TL_MODULES=schedule`) needs no numbers.

### Display-name overrides

Overrides work only for a profile with `features.orgEditor` or `features.setupWizard` on; with neither (TELL), nothing overrides the file. With the editor on, a coordinator uses Admin → Organisation. Otherwise, add rows to the `config` table: `brand.name`, `brand.shortName`,
`brand.longName`, `brand.org`, `brand.manual`, `brand.website` or
`brand.mail.fromName` (an `org.` prefix works too). These change
server-generated text (email subjects, notifications, the calendar feed, the
authenticator label) and, on a server that renders its own pages, the pages
too. A static build (Vercel) takes its pages from the file only, so put
lasting changes there.

The organisation editor can't change phone or emergency numbers. Those come
from the profile file, or from the setup wizard on a new deployment. Pages
carry a fingerprint of the numbers they show. If a number changes and the
pages haven't been rebuilt, the chat refuses to start from an old page and
shows the current safety message instead.

## 3. Build and run (10 minutes)

The pages are templates in `site/`. `npm run build` builds them into
`public/` for `TL_PROFILE`.

**Running from the repo** (`npm start`, Docker, Fly): set `TL_PROFILE=acme`.
The server renders `site/` itself, so there's no build step.

**Vercel:** set `TL_PROFILE=acme`. `vercel.json` already makes
`npm run build` the build step, so the CDN serves pages rendered for your
profile.

Check it:

```bash
TL_PROFILE=acme node tools/render-site.js      # fails loudly on a bad template value
TL_PROFILE=acme npm start
curl localhost:3000/api/branding               # name, colours, phone
curl localhost:3000/healthz                    # 200 once numbers are set
```

Then open `/caller.html`. Read the emergency strip aloud and check every
number.

## For developers

- Edit pages in `site/`. `public/` is build output (`npm run build`) and
  isn't committed. TELL's rendered pages are pinned by hash in
  `test/fixtures/tell-pages.json`; `test/orgprofile.test.js` fails if they
  change by accident.
- Template syntax: `{{a.b}}` inserts a value (missing or null is an error);
  `{{#a.b}}…{{/a.b}}` keeps the inside only when `a.b` is set;
  `{{^a.b}}…{{/a.b}}` keeps it only when `a.b` is not set.
- No TELL literal may appear in `src/`, `site/`, `server.js` or `seed.js`
  outside comments (`test/debrand.test.js`). It goes in `profiles/tell.json`.
