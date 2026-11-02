'use strict';

// Dev/UAT seed: synthetic accounts + shared canned responses. Never run
// against a production database — real accounts come from /setup and the
// coordinator admin screen (including CSV import).

const db = require('./src/db');
const sec = require('./src/crypto');

const workers = [
  // email, name, password, role
  ['aiko@example.org', 'Aiko Tanaka', 'aiko-demo-pass1', 'worker'],
  ['ben@example.org', 'Ben Carter', 'ben-demo-pass22', 'worker'],
  ['yuki@example.org', 'Yuki Sato', 'yuki-demo-pass3', 'worker'],
  ['taro@example.org', 'Taro Trainee', 'taro-demo-pass4', 'trainee'],
  ['grace@example.org', 'Grace Supervisor', 'grace-demo-pas5', 'supervisor'],
  ['joel@example.org', 'Joel Coordinator', 'joel-demo-pass6', 'coordinator'],
];

// Shared canned responses: the same starter set supervisors can add from
// the Canned responses page.
const { STARTER: shared } = require('./src/canned');

// Refuse a real database unless asked twice: these accounts have known
// passwords.
if ((process.env.DATABASE_URL || process.env.NODE_ENV === 'production') &&
    !process.argv.includes('--force')) {
  console.error('seed.js adds demo accounts with published passwords. ' +
    'It will not run against DATABASE_URL or in production without --force.');
  process.exit(1);
}

(async () => {
  await db.init();
  const programId = await db.chatProgramId();

  for (const [email, name, pw, role] of workers) {
    await db.run(
      `INSERT INTO worker (email, name, password_hash, role, phone, created_at)
       VALUES (?,?,?,?,?,?) ON CONFLICT (email) DO NOTHING`,
      [email, name, sec.hashPassword(pw), role,
        role === 'supervisor' ? '080-0000-0000' : null, db.now()]);
    const w = await db.get('SELECT id FROM worker WHERE email = ?', [email]);
    await db.run(
      'INSERT INTO worker_program (worker_id, program_id) VALUES (?,?) ON CONFLICT DO NOTHING',
      [w.id, programId]);
  }

  const existing = await db.get(
    'SELECT COUNT(*) AS n FROM canned_response WHERE worker_id IS NULL');
  if (Number(existing.n) === 0) {
    for (const [label, body] of shared) {
      await db.run('INSERT INTO canned_response (worker_id, label, body) VALUES (NULL,?,?)',
        [label, body]);
    }
  }

  // Synthetic referral directory entries so the console's referral search has
  // something to find during UAT. All public, well-known services.
  const haveResources = await db.get('SELECT COUNT(*) AS n FROM resource');
  if (Number(haveResources.n) === 0) {
    // The organisation's own starter directory (profiles/<id>.json seed.resources).
    const resources = require('./src/profile').profile().seed.resources;
    for (const [name, category, description, url, phone] of resources) {
      await db.run(
        `INSERT INTO resource (name, category, description, url, phone, status, created_at)
         VALUES (?,?,?,?,?,'active',?)`,
        [name, category, description, url, phone, db.now()]);
    }
  }

  console.log('Seeded (synthetic). Logins (email / password / role):');
  for (const [email, , pw, role] of workers) console.log(`  ${email} / ${pw}  (${role})`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
