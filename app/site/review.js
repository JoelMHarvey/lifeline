'use strict';

const $ = (id) => document.getElementById(id);
let selectedFeedbackId = null;

(async () => {
  const res = await fetch('/api/review/queue');
  if (res.status === 401 || res.status === 403) { location.href = 'console.html'; return; }
  render(await res.json());
})();

function render(queue) {
  const reqBox = $('requestedList');
  reqBox.innerHTML = queue.requested.length ? '' : '<p class="muted">None waiting.</p>';
  for (const r of queue.requested) {
    const div = document.createElement('div');
    div.className = 'item requested';
    div.textContent = `${r.workerName} asked for follow-up · ${r.alias || 'Anonymous'}`;
    div.onclick = () => openAndShow(r.contactId, r.feedbackId);
    reqBox.appendChild(div);
  }
  const subBox = $('submittedList');
  subBox.innerHTML = queue.submitted.length ? '' : '<p class="muted">None yet.</p>';
  for (const s of queue.submitted) {
    const div = document.createElement('div');
    div.className = 'item' + (s.highlight ? ' highlight' : '');
    div.textContent = `${s.alias || 'Anonymous'} · ${s.workerName}` +
      (s.highlight ? ' · ⚑ highlighted' : '');
    div.onclick = () => openAndShow(s.contactId, null);
    subBox.appendChild(div);
  }
}

// Phones stack the list above the detail: bring the detail into view.
async function openAndShow(contactId, feedbackId) {
  await openContact(contactId, feedbackId);
  if (matchMedia('(max-width: 760px)').matches) $('detail').scrollIntoView({ behavior: 'smooth' });
}

async function openContact(contactId, feedbackId) {
  selectedFeedbackId = feedbackId;
  const c = await (await fetch('/api/review/contact/' + contactId)).json();
  const box = $('detail');
  box.innerHTML = '';

  const head = document.createElement('h2');
  head.style.fontSize = '17px';
  head.textContent = `${c.alias || 'Anonymous'} — handled by ${c.workerName || '—'}`;
  box.appendChild(head);
  if (c.highlight) {
    const flag = document.createElement('p');
    flag.className = 'badge danger';
    flag.textContent = '⚑ highlighted — other workers should be aware';
    box.appendChild(flag);
  }

  const meta = document.createElement('dl');
  const metaRows = [
    ['Queued', c.queuedAt], ['Ended', c.endedAt || '—'],
    ['Outcome', c.outcome || '—'],
    ['Queue wait', c.queueWaitSecs != null ? c.queueWaitSecs + 's' : '—'],
    ['Intake', c.intakeStatus],
    ['Referrals', (c.referrals || []).map((r) => r.name).join(', ') || 'none'],
  ];
  for (const [k, v] of metaRows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    meta.appendChild(dt);
    meta.appendChild(dd);
  }
  box.appendChild(meta);

  const ih = document.createElement('h3');
  ih.textContent = `Intake (form v${(c.intake && c.intake.version) || (c.form && c.form.version) || '?'})`;
  box.appendChild(ih);
  box.appendChild(renderAnswers(c));

  const th = document.createElement('h3');
  th.textContent = 'Transcript';
  box.appendChild(th);
  const t = document.createElement('div');
  t.className = 'msgs';
  t.id = 'transcript';
  for (const m of c.messages || []) {
    const el = document.createElement('div');
    el.className = 'msg ' + m.sender;
    el.textContent = m.body;
    t.appendChild(el);
  }
  box.appendChild(t);

  const fh = document.createElement('h3');
  fh.textContent = 'Feedback to the worker';
  box.appendChild(fh);
  const ta = document.createElement('textarea');
  ta.rows = 4;
  ta.placeholder = 'What went well, what to try next time — the worker sees this in their console.';
  box.appendChild(ta);
  const btn = document.createElement('button');
  btn.className = 'primary';
  btn.style.marginTop = '8px';
  btn.textContent = 'Send feedback';
  btn.onclick = async () => {
    if (!ta.value.trim()) return;
    const res = await fetch('/api/review/feedback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contactId: c.contactId, body: ta.value.trim(),
        feedbackId: selectedFeedbackId || undefined,
      }),
    });
    if (res.ok) {
      btn.textContent = 'Sent ✓';
      btn.disabled = true;
      const q = await (await fetch('/api/review/queue')).json();
      render(q);
    }
  };
  box.appendChild(btn);
}

// Render answers against the form version the record was written under —
// labels come from that version, so renames don't rewrite history.
function renderAnswers(c) {
  const dl = document.createElement('dl');
  const answers = (c.intake && c.intake.answers) || {};
  const fields = [];
  if (c.form) for (const s of c.form.schema.sections) for (const f of s.fields) fields.push(f);
  const labelOf = (f, v) => {
    const o = (f.options || []).find((x) => x.id === v);
    return o ? o.label : String(v);
  };
  for (const f of fields) {
    const v = answers[f.id];
    if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) continue;
    const dt = document.createElement('dt');
    dt.textContent = f.label || f.id;
    const dd = document.createElement('dd');
    dd.textContent = v === true ? 'yes'
      : Array.isArray(v) ? v.map((x) => labelOf(f, x)).join(', ') : labelOf(f, v);
    dl.appendChild(dt);
    dl.appendChild(dd);
    if (answers[f.id + '_other']) {
      const dt2 = document.createElement('dt');
      dt2.textContent = '↳ other';
      const dd2 = document.createElement('dd');
      dd2.textContent = answers[f.id + '_other'];
      dl.appendChild(dt2);
      dl.appendChild(dd2);
    }
  }
  if (!dl.children.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'No intake recorded.';
    return p;
  }
  return dl;
}
