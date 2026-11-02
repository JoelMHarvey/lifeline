'use strict';

const $ = (id) => document.getElementById(id);
let lastReport = null;

// Default to the current month, in the organisation's timezone.
const todayParts = Object.fromEntries(new Intl.DateTimeFormat('en-US',
  { timeZone: '{{timezone}}', year: 'numeric', month: '2-digit', day: '2-digit' })
  .formatToParts(new Date()).map((p) => [p.type, p.value]));
$('from').value = `${todayParts.year}-${todayParts.month}-01`;
$('to').value = `${todayParts.year}-${todayParts.month}-${todayParts.day}`;

$('runBtn').onclick = run;
run();

async function run() {
  const res = await fetch(`/api/reports?from=${$('from').value}&to=${$('to').value}`);
  if (res.status === 401 || res.status === 403) { location.href = 'console.html'; return; }
  if (!res.ok) return;
  lastReport = await res.json();
  $('csvBtn').disabled = false;
  render(lastReport);
}

function render(r) {
  const out = $('out');
  out.innerHTML = '';

  const tiles = document.createElement('div');
  tiles.className = 'tiles';
  const tile = (k, n) => {
    const d = document.createElement('div');
    d.className = 'tile';
    d.innerHTML = '<div class="n"></div><div class="k"></div>';
    d.querySelector('.n').textContent = n ?? '—';
    d.querySelector('.k').textContent = k;
    tiles.appendChild(d);
  };
  tile('Contacts', r.contacts.total);
  if (r.contacts.phone) tile('of which phone', r.contacts.phone);
  tile('Completed', r.contacts.completed);
  tile('Abandoned', r.contacts.abandoned);
  tile('Timed out', r.contacts.timed_out);
  tile('Intakes submitted', r.contacts.intakes_submitted);
  tile('Highlighted', r.contacts.highlighted);
  tile('Referrals made', r.referrals_made);
  tile('Wait p50', r.waits.p50_secs != null ? r.waits.p50_secs + 's' : '—');
  tile('Wait p95', r.waits.p95_secs != null ? r.waits.p95_secs + 's' : '—');
  out.appendChild(tiles);

  for (const [fieldId, counts] of Object.entries(r.fields)) {
    const h = document.createElement('h3');
    h.textContent = fieldId.replace(/_/g, ' ');
    out.appendChild(h);
    const tbl = document.createElement('table');
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    for (const [label, n] of entries) {
      const tr = document.createElement('tr');
      const td1 = document.createElement('td');
      td1.textContent = label;
      const td2 = document.createElement('td');
      td2.className = 'n';
      td2.textContent = n;
      tr.appendChild(td1);
      tr.appendChild(td2);
      tbl.appendChild(tr);
    }
    out.appendChild(tbl);
  }
}

$('csvBtn').onclick = () => {
  if (!lastReport) return;
  const rows = [['section', 'label', 'count']];
  const c = lastReport.contacts;
  for (const k of Object.keys(c)) rows.push(['contacts', k, c[k]]);
  rows.push(['waits', 'p50_secs', lastReport.waits.p50_secs ?? '']);
  rows.push(['waits', 'p95_secs', lastReport.waits.p95_secs ?? '']);
  rows.push(['referrals', 'made', lastReport.referrals_made]);
  for (const [fieldId, counts] of Object.entries(lastReport.fields)) {
    for (const [label, n] of Object.entries(counts)) rows.push([fieldId, label, n]);
  }
  const csv = rows.map((r) => r.map((v) =>
    /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = `tell-report-${lastReport.range.from}-${lastReport.range.to}.csv`;
  a.click();
};
