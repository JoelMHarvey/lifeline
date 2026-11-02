'use strict';

const $ = (id) => document.getElementById(id);
const post = (url, body) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
});

let me = null;
let isCoordinator = false;

(async () => {
  const res = await fetch('/api/me');
  if (!res.ok) { location.href = 'console.html'; return; }
  me = await res.json();
  isCoordinator = me.role === 'coordinator';
  if (isCoordinator) {
    $('importPanel').style.display = 'block';
    $('pendingPanel').style.display = 'block';
    loadPending();
  }
  load();
})();

let timer = null;
$('q').addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(load, 250);
});

async function load() {
  const q = $('q').value.trim();
  const rows = await (await fetch('/api/resources?q=' + encodeURIComponent(q))).json();
  const tbl = $('tbl');
  tbl.innerHTML = '';
  let lastCat = null;
  for (const r of rows) {
    if (r.category !== lastCat) {
      lastCat = r.category;
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = isCoordinator ? 4 : 3;
      td.className = 'cat';
      td.textContent = r.category || 'Uncategorised';
      tr.appendChild(td);
      tbl.appendChild(tr);
    }
    const tr = document.createElement('tr');
    const name = document.createElement('td');
    if (r.url) {
      const a = document.createElement('a');
      a.href = r.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = r.name;
      name.appendChild(a);
    } else name.textContent = r.name;
    const desc = document.createElement('td');
    desc.className = 'muted';
    desc.textContent = r.description || '';
    const contact = document.createElement('td');
    contact.textContent = [r.phone, r.languages].filter(Boolean).join(' · ');
    tr.appendChild(name);
    tr.appendChild(desc);
    tr.appendChild(contact);
    if (isCoordinator) {
      const act = document.createElement('td');
      const edit = document.createElement('button');
      edit.textContent = 'Edit';
      edit.style.cssText = 'font-size:12px;padding:2px 8px';
      edit.onclick = () => editResource(r);
      const retire = document.createElement('button');
      retire.textContent = 'Retire';
      retire.style.cssText = 'font-size:12px;padding:2px 8px;margin-left:4px';
      retire.onclick = async () => {
        if (!confirm(`Retire "${r.name}"? Past referrals keep it; new ones can't use it.`)) return;
        await patch(r.id, { status: 'retired' });
        load();
      };
      act.appendChild(edit);
      act.appendChild(retire);
      tr.appendChild(act);
    }
    tbl.appendChild(tr);
  }
  if (!rows.length) tbl.innerHTML = '<tr><td class="muted">Nothing found.</td></tr>';
}

const patch = (id, body) => fetch('/api/resources/' + id, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function editResource(r) {
  const name = prompt('Name', r.name);
  if (name === null) return;
  const category = prompt('Category', r.category || '');
  if (category === null) return;
  const description = prompt('Description', r.description || '');
  if (description === null) return;
  const phone = prompt('Phone', r.phone || '');
  if (phone === null) return;
  const url = prompt('URL', r.url || '');
  if (url === null) return;
  await patch(r.id, { name, category, description, phone, url });
  load();
}

$('suggestBtn').onclick = async () => {
  const name = $('sName').value.trim();
  if (!name) { $('suggestMsg').textContent = 'Name is required.'; return; }
  const res = await post('/api/resources', {
    name,
    category: $('sCategory').value.trim(),
    description: $('sDesc').value.trim() || undefined,
    phone: $('sPhone').value.trim() || undefined,
    url: $('sUrl').value.trim() || undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { $('suggestMsg').textContent = data.error || 'Failed.'; return; }
  ['sName', 'sCategory', 'sDesc', 'sPhone', 'sUrl'].forEach((id) => { $(id).value = ''; });
  $('suggestMsg').textContent = data.status === 'active'
    ? 'Added to the directory.' : 'Suggested — a coordinator will review it.';
  if (data.status === 'active') load();
  if (isCoordinator) loadPending();
};

async function loadPending() {
  const rows = await (await fetch('/api/resources?status=suggested')).json();
  const tbl = $('pendingTbl');
  tbl.innerHTML = rows.length ? '' : '<tr><td class="muted">No pending suggestions.</td></tr>';
  for (const r of rows) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.textContent = `${r.name}${r.category ? ' — ' + r.category : ''}${r.description ? ' · ' + r.description : ''}`;
    const act = document.createElement('td');
    const approve = document.createElement('button');
    approve.className = 'primary';
    approve.textContent = 'Approve';
    approve.style.cssText = 'font-size:12px;padding:2px 8px';
    approve.onclick = async () => { await patch(r.id, { status: 'active' }); loadPending(); load(); };
    const reject = document.createElement('button');
    reject.textContent = 'Reject';
    reject.style.cssText = 'font-size:12px;padding:2px 8px;margin-left:4px';
    reject.onclick = async () => { await patch(r.id, { status: 'retired' }); loadPending(); };
    act.appendChild(approve);
    act.appendChild(reject);
    tr.appendChild(td);
    tr.appendChild(act);
    tbl.appendChild(tr);
  }
}

// ---------------------------------------------------------------------------
// CSV import (coordinators): preview what each row would do, then apply.

const ACTION_WORDS = { add: 'Add', update: 'Update', skip: 'Skip', error: 'Problem' };

$('templateLink').onclick = (e) => {
  e.preventDefault();
  const csv = 'Name,Category,Description,Website,Phone,Languages\r\n' +
    '"Example Counselling Centre","Counseling & Support","Low-cost counselling, in English and Japanese",' +
    'https://example.org,03-0000-0000,"English, Japanese"\r\n';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
  a.download = 'tell-resources-template.csv';
  a.click();
  URL.revokeObjectURL(a.href);
};

let importCsv = null;

$('previewBtn').onclick = async () => {
  const file = $('importFile').files[0];
  const box = $('importResult');
  if (!file) { box.textContent = 'Choose a CSV file first.'; return; }
  if (file.size > 3.5 * 1024 * 1024) { box.textContent = 'That file is over 3.5 MB — split it into smaller files.'; return; }
  importCsv = await file.text();
  await runImport(false);
};

async function runImport(apply) {
  const box = $('importResult');
  box.textContent = apply ? 'Importing…' : 'Reading the file…';
  const res = await post('/api/resources/import',
    { csv: importCsv, apply, updateExisting: $('importUpdate').checked });
  const r = await res.json().catch(() => ({}));
  box.innerHTML = '';
  if (!res.ok) {
    box.append(Object.assign(document.createElement('p'), {
      className: 'a-error', textContent: r.error || 'That didn\'t work.' }));
    return;
  }
  const p = (text, cls = '') => Object.assign(document.createElement('p'), { textContent: text, className: cls });
  const cols = Object.entries(r.columns).map(([f, h]) => `${f} ← "${h}"`).join(' · ');
  box.append(p((apply ? 'Imported. ' : '') + `Columns used: ${cols}`, 'muted'));
  if (r.unknownColumns.length) box.append(p(`Ignored columns: ${r.unknownColumns.join(', ')}`, 'muted'));
  const counts = document.createElement('div');
  counts.className = 'counts';
  for (const [k, n] of Object.entries(r.counts)) {
    if (!n) continue;
    const verb = apply ? { add: 'added', update: 'updated', skip: 'skipped', error: 'with problems' }[k]
      : { add: 'to add', update: 'to update', skip: 'to skip', error: 'with problems' }[k];
    counts.append(Object.assign(document.createElement('span'), { className: 'a-' + k, textContent: `${n} ${verb}` }));
  }
  box.append(counts);

  const wrap = document.createElement('div');
  wrap.className = 'scroll';
  const tbl = document.createElement('table');
  tbl.innerHTML = '<tr><th>Row</th><th>Action</th><th>Name</th><th>Category</th><th>Note</th></tr>';
  for (const row of r.rows) {
    const tr = document.createElement('tr');
    for (const [v, cls] of [[row.line, ''], [ACTION_WORDS[row.action], 'a-' + row.action],
      [row.name, ''], [row.category || '', ''], [row.reason || '', 'muted']]) {
      const td = document.createElement('td');
      td.textContent = v;
      if (cls) td.className = cls;
      tr.append(td);
    }
    tbl.append(tr);
  }
  wrap.append(tbl);
  box.append(wrap);

  const changes = r.counts.add + r.counts.update;
  if (!apply && changes) {
    const go = Object.assign(document.createElement('button'), {
      className: 'primary', textContent: `Import ${changes} resource${changes === 1 ? '' : 's'}` });
    go.style.marginTop = '10px';
    go.onclick = () => { go.disabled = true; runImport(true); };
    box.append(go);
  } else if (!apply) {
    box.append(p('Nothing to import — every row is already in the directory or has a problem.', 'muted'));
  }
  if (apply) load();
}

// Changing "update existing" after a preview previews again, so what's
// imported is always what was shown.
$('importUpdate').onchange = () => { if (importCsv) runImport(false); };
