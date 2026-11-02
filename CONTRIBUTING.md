# Contributing

Thank you for helping. People in crisis use this software, so changes are
judged first on whether they keep callers safe.

## Getting set up

```bash
cd app
npm install
npm test              # the full suite, about 8 minutes
node --test test/queue.test.js   # one file
```

Tests run against an in-memory Postgres (PGlite); nothing external is
needed. `npm test` runs with `TL_PROFILE=tell`, because most tests use
TELL's shift pattern and forms as reference data. Tests about other profiles
set their own.

## How the code is laid out

- `app/server.js`: the HTTP API (Express).
- `app/src/`: the logic. The queue, intake forms, scheduler, setup wizard,
  voice, crypto and the database layer.
- `app/site/`: the web pages, as templates (`{{name}}`, `{{#key}}…{{/key}}`).
  They are rendered per organisation profile.
- `app/profiles/`: one JSON file per organisation. `generic` is the
  default; `tell` is TELL's.
- `app/public/`: build output (`npm run build`). It is not committed.

## Rules that the tests enforce

- **TELL's pages must not change by accident.** `test/orgprofile.test.js`
  pins every page rendered for TELL by its hash. If you mean to change what
  TELL sees, re-pin the pages with
  `node tools/render-site.js --update-tell-fixture` and say why in the PR.
- **No organisation's name or numbers in code.** They belong in a profile
  (`test/debrand.test.js` checks this).
- **Fail closed on the caller path.** Without a helpline phone and an
  emergency number, the chat doesn't run; see `test/failclosed.test.js`.
- **Seeds only.** A changed profile never rewrites a database's stored forms
  or shifts.
- **Database changes are additive.** Add columns and indexes; never drop or
  rewrite data in a migration.

## Pull requests

- Keep each one focused.
- Include a test for the behaviour you change.
- Run `npm test` before you open it.

For anything that touches caller data, encryption, sign-in or the queue,
explain in the PR what could go wrong for a caller and how the change
prevents it.

Security problems: please don't open a public issue. See
[SECURITY.md](SECURITY.md).
