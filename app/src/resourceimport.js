'use strict';

// Resource directory CSV import for coordinators. Always previewed first:
// the same call with apply=false reports what each row would do (add,
// update, skip, error) without writing anything. Rows match existing
// resources by name (case-insensitive, retired ones excluded); a match is
// skipped unless updateExisting is set, when its non-empty CSV fields
// replace the stored ones. Imported resources are active straight away.

const db = require('./db');
const { parseCsv, mapHeader } = require('./csv');

const FIELDS = {
  name: ['resource', 'resource name', 'agency', 'agency name', 'organisation', 'organization',
    'organisation name', 'organization name', 'service', 'service name', 'title'],
  category: ['taxonomy', 'type', 'topic', 'section', 'group'],
  description: ['details', 'notes', 'about', 'summary', 'information', 'info'],
  url: ['website', 'web', 'web site', 'link', 'site', 'homepage'],
  phone: ['telephone', 'tel', 'phone number', 'telephone number', 'hotline', 'contact number'],
  languages: ['language', 'languages spoken', 'langs'],
};
const LIMITS = { name: 200, category: 200, description: 2000, url: 500, phone: 100, languages: 200 };
const MAX_ROWS = 2000;

// Only web links; a bare "example.org" becomes https://example.org.
function cleanUrl(u) {
  if (!u) return '';
  const v = /^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`;
  try {
    const p = new URL(v);
    return ['http:', 'https:'].includes(p.protocol) ? p.toString() : null;
  } catch { return null; }
}

async function importResources(csvText, { apply = false, updateExisting = false } = {}, actorId) {
  const rows = parseCsv(csvText);
  if (rows.length < 2) return { error: 'The file needs a header row and at least one resource.' };
  const { map, unknown } = mapHeader(rows[0], FIELDS);
  if (map.name === undefined) {
    return { error: 'No name column found — call one column "Name" (or "Agency name", "Organisation"…).' };
  }
  const data = rows.slice(1);
  if (data.length > MAX_ROWS) return { error: `That's ${data.length} rows; import at most ${MAX_ROWS} at a time.` };

  const existing = await db.all(`SELECT * FROM resource WHERE status != 'retired'`);
  const byName = new Map(existing.map((r) => [r.name.trim().toLowerCase(), r]));
  const seen = new Set();
  const results = [];
  const counts = { add: 0, update: 0, skip: 0, error: 0 };

  for (let i = 0; i < data.length; i++) {
    const line = i + 2; // spreadsheet row number, header being row 1
    const get = (f) => (map[f] === undefined ? '' : String(data[i][map[f]] || '').slice(0, LIMITS[f]));
    const rec = Object.fromEntries(Object.keys(FIELDS).map((f) => [f, get(f)]));
    const key = rec.name.trim().toLowerCase();
    const note = (action, reason) => {
      counts[action] += 1;
      results.push({ line, action, name: rec.name || '(no name)', category: rec.category, reason });
    };
    if (!key) { note('error', 'no name'); continue; }
    if (seen.has(key)) { note('skip', 'appears earlier in the file'); continue; }
    seen.add(key);
    const url = cleanUrl(rec.url);
    if (url === null) { note('error', `"${rec.url}" isn't a web address`); continue; }
    rec.url = url;

    const match = byName.get(key);
    if (match && !updateExisting) { note('skip', 'already in the directory'); continue; }
    if (match) {
      const changes = Object.keys(FIELDS).filter((f) => f !== 'name' && rec[f] &&
        rec[f] !== (match[f] || ''));
      if (!changes.length) { note('skip', 'already in the directory, nothing new'); continue; }
      if (apply) {
        await db.run(
          `UPDATE resource SET ${changes.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`,
          [...changes.map((f) => rec[f]), match.id]);
      }
      note('update', `updates ${changes.join(', ')}`);
      continue;
    }
    if (apply) {
      await db.insert(
        `INSERT INTO resource (name, category, description, url, phone, languages, status, created_at)
         VALUES (?,?,?,?,?,?,'active',?)`,
        [rec.name.trim(), rec.category, rec.description || null, rec.url || null,
          rec.phone || null, rec.languages || null, db.now()]);
    }
    note('add', '');
  }

  if (apply) {
    await db.audit(actorId, 'resources_imported', 'resource', null,
      `${counts.add} added, ${counts.update} updated, ${counts.skip} skipped, ${counts.error} with errors`);
  }
  const columns = Object.fromEntries(Object.entries(map).map(([f, i]) => [f, rows[0][i]]));
  return { applied: apply, columns, unknownColumns: unknown, counts, rows: results };
}

module.exports = { importResources, FIELDS, cleanUrl };
