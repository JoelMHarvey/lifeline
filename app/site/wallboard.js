'use strict';

const $ = (id) => document.getElementById(id);
const fmtSecs = (s) => s == null ? '—' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

const STATUS_BADGE = { on_shift: 'ok', backup: 'warn', off: '' };

async function refresh() {
  let s;
  try {
    const res = await fetch('/api/wallboard');
    if (res.status === 401 || res.status === 403) { location.href = 'console.html'; return; }
    s = await res.json();
  } catch { return; } // transient failure — keep last render
  $('asOf').textContent = 'as of ' + new Date().toLocaleTimeString();

  const stats = [
    ['Waiting now', s.queue_depth, s.queue_depth > 0],
    ['Longest wait', fmtSecs(s.longest_wait_secs), s.longest_wait_secs > 120],
    ['Active chats', s.active_chats, false],
    ['Contacts today', s.today.contacts_today, false],
    ['Abandoned today', s.today.abandoned + s.today.timed_out,
      s.today.abandoned + s.today.timed_out > 0],
    ['Wait p50 / p95', `${fmtSecs(s.today.wait_p50_secs)} / ${fmtSecs(s.today.wait_p95_secs)}`, false],
  ];
  $('stats').innerHTML = '';
  for (const [label, value, alert] of stats) {
    const div = document.createElement('div');
    div.className = 'panel stat';
    div.innerHTML = `<div class="num${alert ? ' alert' : ''}"></div><div class="label"></div>`;
    div.querySelector('.num').textContent = value;
    div.querySelector('.label').textContent = label;
    $('stats').appendChild(div);
  }

  const tbl = $('workers');
  tbl.innerHTML = '<tr><th>Name</th><th>Role</th><th>Status</th></tr>';
  for (const w of s.workers) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td></td><td class="muted"></td>
      <td><span class="badge ${STATUS_BADGE[w.status] || ''}"></span></td>`;
    tr.children[0].textContent = w.name;
    tr.children[1].textContent = w.role;
    tr.querySelector('.badge').textContent = w.status.replace('_', ' ');
    tbl.appendChild(tr);
  }

  const help = $('help');
  help.innerHTML = s.open_help_requests.length ? '' : '<p class="muted">None.</p>';
  for (const h of s.open_help_requests) {
    const div = document.createElement('div');
    div.style.marginBottom = '8px';
    div.innerHTML = `<strong></strong> <span class="muted"></span>
      <button style="float:right;font-size:12px;padding:2px 8px">Resolve</button>`;
    div.querySelector('strong').textContent = h.worker_name;
    div.querySelector('.muted').textContent = h.note || 'needs assistance';
    div.querySelector('button').onclick = async () => {
      await fetch('/api/help/' + h.id + '/resolve', { method: 'POST' });
      refresh();
    };
    help.appendChild(div);
  }

  const un = $('unconfirmed');
  const unc = s.unconfirmed_24h || [];
  un.innerHTML = unc.length ? '' : '<p class="muted">All confirmed.</p>';
  for (const u of unc) {
    const div = document.createElement('div');
    div.style.marginBottom = '4px';
    const badge = u.status === 'open' ? 'danger' : 'warn';
    div.innerHTML = `<span class="badge ${badge}"></span> <strong></strong> <span class="muted"></span>`;
    div.querySelector('.badge').textContent =
      u.status === 'open' ? 'unstaffed' : u.status === 'sub_requested' ? 'cover wanted' : 'unconfirmed';
    div.querySelector('strong').textContent = `S${u.shiftNumber} ${u.date}`;
    div.querySelector('.muted').textContent =
      (u.role !== 'worker' ? u.role + ' · ' : '') + (u.workerName || 'no one assigned');
    un.appendChild(div);
  }

  const hi = $('highlights');
  const rows = s.highlighted || [];
  hi.innerHTML = rows.length ? '' : '<p class="muted">None.</p>';
  for (const c of rows) {
    const div = document.createElement('div');
    div.style.marginBottom = '6px';
    div.innerHTML = `⚑ <strong></strong> <span class="muted"></span>
      <a href="review.html" style="font-size:12px">review</a>`;
    div.querySelector('strong').textContent = c.alias || 'Anonymous';
    div.querySelector('.muted').textContent =
      (c.worker_name ? 'with ' + c.worker_name + ' · ' : '') +
      (c.ended_at ? new Date(c.ended_at).toLocaleDateString() : 'active');
    hi.appendChild(div);
  }
}

refresh();
setInterval(refresh, 3000);
