'use strict';

const $ = (id) => document.getElementById(id);

(async () => {
  const [hres, ores] = await Promise.all([fetch('/healthz?deep=1'), fetch('/api/admin/ops')]);
  if (ores.status === 401 || ores.status === 403) { location.href = 'console.html'; return; }
  const health = await hres.json();
  const ops = await ores.json();

  const hbox = $('health');
  hbox.innerHTML = '';
  const badge = (label, good) => {
    const b = document.createElement('span');
    b.className = 'badge ' + (good ? 'ok' : 'danger');
    b.style.marginRight = '6px';
    b.textContent = label + (good ? ' ✓' : ' ✗');
    return b;
  };
  hbox.appendChild(badge('database', health.db));
  hbox.appendChild(badge('encryption', health.encryption));
  const up = document.createElement('span');
  up.className = 'muted';
  up.textContent = ` instance up ${Math.round(ops.uptime_secs / 60)} min · ${ops.node}`;
  hbox.appendChild(up);

  const grid = $('envGrid');
  const labels = {
    database: 'DATABASE_URL (Neon)',
    encryption_key: 'TL_ENCRYPTION_KEY',
    team_webhook: 'Team webhook (Google Chat)',
    ops_webhook: 'Ops webhook',
    cron_secret: 'CRON_SECRET',
    uat_passcode: 'UAT passcode gate',
    base_url: 'TL_BASE_URL (links in messages)',
  };
  for (const [key, set] of Object.entries(ops.env)) {
    const div = document.createElement('div');
    div.textContent = (labels[key] || key) + ': ';
    const b = document.createElement('strong');
    b.textContent = set ? 'set' : 'not set';
    b.style.color = set ? 'var(--ok)' : 'var(--warn)';
    div.appendChild(b);
    grid.appendChild(div);
  }

  // Which service sends email, and today's count against its daily limit,
  // so the switch to an email service (DEPLOY.md) happens before Gmail
  // starts refusing.
  const m = ops.mail || {};
  const mb = $('mailStatus');
  mb.classList.remove('muted');
  const NAMES = { gmail: 'Gmail', smtp: 'SMTP', resend: 'Resend (email service)', test: 'test' };
  mb.textContent = !m.configured
    ? (m.provider === 'resend' ? 'Resend key set but TL_MAIL_FROM is missing — no email is going out.'
      : 'Not configured — no email is going out (sign-in codes, schedules, cover requests).')
    : `Sending through ${NAMES[m.provider] || m.provider} as ${m.from}. ` +
      `${m.sentToday} sent today` +
      (m.dailyLimit ? ` of about ${m.dailyLimit} allowed a day.` : '.') +
      (m.nearLimit ? ' Close to the daily limit — time to switch to an email service (DEPLOY.md, "Switching to an email service").' : '');
  mb.style.color = !m.configured || m.nearLimit ? 'var(--danger)' : '';

  const ev = $('events');
  ev.textContent = ops.events_24h.length
    ? ops.events_24h.map((e) => `${e.event} ×${e.n}`).join(' · ')
    : 'No events in the last 24 hours.';

  const tbl = $('errTbl');
  if (!ops.recent_errors.length) {
    tbl.innerHTML = '<tr><td class="muted">None recorded. 🎉</td></tr>';
  } else {
    tbl.innerHTML = '<tr><th>When</th><th>Path</th><th>Error</th></tr>';
    for (const e of ops.recent_errors) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td></td><td></td><td class="msg"></td>';
      tr.children[0].textContent = new Date(e.at).toLocaleString();
      tr.children[1].textContent = e.path || '—';
      tr.children[2].textContent = e.message;
      tbl.appendChild(tr);
    }
  }
})();

$('testNotifyBtn').onclick = async () => {
  $('testResult').textContent = 'sending…';
  const res = await fetch('/api/admin/ops/test-notify', { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  $('testResult').textContent = res.ok
    ? `team: ${data.team_delivered ? 'delivered ✓' : 'not delivered — check the webhook URL'} · ` +
      `ops: ${data.ops_delivered ? 'delivered ✓' : 'not delivered'}`
    : 'failed';
};

// Problems & requests: open ones first, most urgent at the top.
// A link to one report (ops.html#TL-0007, as in the emails) shows them all,
// so it's found even once closed.
let issueScope = /^#TL-\d+$/.test(location.hash) ? 'all' : 'open';
async function loadIssues() {
  const res = await fetch('/api/issues?scope=' + issueScope);
  if (!res.ok) return;
  const rows = await res.json();
  const box = document.getElementById('issueList');
  box.innerHTML = '';
  box.classList.toggle('muted', !rows.length);
  if (!rows.length) {
    box.textContent = issueScope === 'open' ? 'Nothing open — all clear.' : 'Nothing here yet.';
  }
  for (const it of rows) box.append(window.renderIssue(it, { coordinator: true, onChange: loadIssues }));
  if (issueScope === 'open') {
    document.getElementById('issueCount').textContent = rows.length ? `(${rows.length} open)` : '';
  }
}
for (const b of document.querySelectorAll('.issueTabs button')) {
  b.onclick = () => {
    issueScope = b.dataset.scope;
    for (const x of document.querySelectorAll('.issueTabs button')) {
      x.classList.toggle('primary', x === b);
    }
    loadIssues();
  };
}
for (const x of document.querySelectorAll('.issueTabs button')) {
  x.classList.toggle('primary', x.dataset.scope === issueScope);
}
loadIssues();
