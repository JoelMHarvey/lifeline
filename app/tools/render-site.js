#!/usr/bin/env node
'use strict';

// Build the web pages for one organisation: site/ templates → public/.
//
//   node tools/render-site.js            TL_PROFILE's pages (default generic)
//   node tools/render-site.js --check    exit 1 if public/ is out of date
//
// Every deployment runs this as its build step (npm run build), with its own
// TL_PROFILE. public/ is build output and isn't committed.
//
// On Vercel the build stops if TL_PROFILE isn't set: an existing deployment
// that forgot it would otherwise quietly turn into the blank "generic"
// lifeline. A failed build leaves the live site as it was.
//
// A deployment set up with the wizard keeps its look and numbers in the
// database (config overrides). When the build can reach it (DATABASE_URL or
// TL_PGDATA) and the profile has the wizard or the organisation editor on,
// pages are built with those settings; --file-only skips the database.
// TELL's profile never reads the database here.

const path = require('path');
const site = require('../src/site');
const { profile, base } = require('../src/profile');

const PUBLIC = path.join(__dirname, '..', 'public');

async function main() {
  if (process.env.VERCEL && !process.env.TL_PROFILE) {
    console.error('TL_PROFILE is not set. Set it in the Vercel project ' +
      '(Settings → Environment Variables): "generic" for a new lifeline, ' +
      'or your own profile name. The build stops here so the live site is unchanged.');
    process.exit(1);
  }
  const f = base().features;
  const useDb = !process.argv.includes('--file-only') && base().id !== 'tell' &&
    (f.setupWizard || f.orgEditor) && (process.env.DATABASE_URL || process.env.TL_PGDATA);
  if (useDb) {
    await require('../src/db').init(); // loads the overrides
    console.log('Using settings saved in the database.');
  }
  const files = site.render(profile());

  // Re-pin TELL's pages after a deliberate change to them.
  if (process.argv.includes('--update-tell-fixture')) {
    const fs = require('fs');
    const crypto = require('crypto');
    const tell = site.render(require('../src/profile').load('tell'));
    const out = {};
    for (const rel of Object.keys(tell).sort()) {
      out[rel] = crypto.createHash('sha256').update(Buffer.isBuffer(tell[rel]) ? tell[rel] : Buffer.from(tell[rel], 'utf8')).digest('hex');
    }
    fs.writeFileSync(path.join(__dirname, '..', 'test', 'fixtures', 'tell-pages.json'), JSON.stringify(out, null, 2) + '\n');
    console.log(`Pinned ${Object.keys(out).length} TELL pages in test/fixtures/tell-pages.json.`);
    return;
  }

  if (process.argv.includes('--check')) {
    const fs = require('fs');
    const os = require('os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'site-'));
    fs.cpSync(PUBLIC, tmp, { recursive: true });
    const drift = site.write(tmp, files);
    fs.rmSync(tmp, { recursive: true, force: true });
    if (drift.length) {
      console.error(`public/ is out of date for profile "${profile().id}": ${drift.join(', ')}`);
      console.error('Run: npm run render');
      process.exit(1);
    }
    console.log(`public/ matches site/ for profile "${profile().id}".`);
  } else {
    const changed = site.write(PUBLIC, files);
    console.log(`Rendered ${Object.keys(files).length} files for profile "${profile().id}"` +
      (changed.length ? `; changed: ${changed.join(', ')}` : '; nothing changed') + '.');
  }
}

main().then(() => process.exit(process.exitCode || 0))
  .catch((e) => { console.error(e.message || e); process.exit(1); });
