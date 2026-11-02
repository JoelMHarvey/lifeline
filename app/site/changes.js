'use strict';

// The full schedule audit log (coordinators): loaded a page at a time,
// filtered in the browser, downloadable as CSV.

const $ = (id) => document.getElementById(id);
const PAGE = 200;
let entries = [];
let exhausted = false;

const fmtWhen = (at) => new Date(at).toLocaleString('en-GB', {
  weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  hour: '2-digit', minute: '2-digit' });

async function loadPage() {
  const before = entries.length ? `&before=${entries[entries.length - 1].id}` : '';
  const res = await fetch(`/api/schedule/audit?limit=${PAGE}${before}`);
  if (res.status === 401) { location.href = 'console.html'; return; }
  if (res.status === 403) {
    $('rows').innerHTML = '<tr><td colspan="5" class="muted">The change log is for coordinators.</td></tr>';
    return;
  }
  const page = await res.json();
  entries = entries.concat(page);
  exhausted = page.length < PAGE;
  refreshFilters();
  render();
}

function refreshFilters() {
  const fill = (sel, values) => {
    const keep = sel.value;
    const first = sel.options[0];
    sel.innerHTML = '';
    sel.append(first);
    for (const v of values) sel.append(new Option(v, v));
    sel.value = values.includes(keep) ? keep : '';
  };
  fill($('who'), [...new Set(entries.map((e) => e.actorName))].sort());
  fill($('what'), [...new Set(entries.map((e) => e.what))].sort());
}

function visible() {
  const q = $('q').value.trim().toLowerCase();
  const who = $('who').value;
  const what = $('what').value;
  return entries.filter((e) => (!who || e.actorName === who) && (!what || e.what === what) &&
    (!q || [e.actorName, e.what, e.slot, e.detail, fmtWhen(e.at)]
      .some((v) => v && String(v).toLowerCase().includes(q))));
}

function render() {
  const rows = visible();
  const body = $('rows');
  body.innerHTML = '';
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="5" class="muted">${entries.length
      ? 'Nothing matches those filters.' : 'No changes recorded yet.'}</td></tr>`;
  }
  for (const e of rows) {
    const tr = document.createElement('tr');
    for (const [cls, text] of [['when', fmtWhen(e.at)], ['', e.actorName],
      ['', e.what], ['slot', e.slot || ''], ['', e.detail || '']]) {
      const td = document.createElement('td');
      if (cls) td.className = cls;
      td.textContent = text;
      tr.append(td);
    }
    body.append(tr);
  }
  $('count').textContent = `${rows.length} of ${entries.length} loaded` +
    (exhausted ? ' (all)' : '');
  $('more').style.display = exhausted ? 'none' : 'inline-block';
}

$('q').oninput = render;
$('who').onchange = render;
$('what').onchange = render;
$('more').onclick = loadPage;

$('csvBtn').onclick = () => {
  const cell = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const lines = [['When (UTC)', 'Who', 'What', 'Slot', 'Detail'].map(cell).join(',')];
  for (const e of visible()) {
    lines.push([e.at, e.actorName, e.what, e.slot, e.detail].map(cell).join(','));
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/csv' }));
  a.download = `{{id}}-schedule-changes-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
};

loadPage();
