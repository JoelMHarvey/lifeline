'use strict';

// Admin → Organisation: coordinators override the organisation's display
// names (product name, short name, …) without a deploy. Loaded only when
// the profile turns the organisation editor on. Phone and emergency numbers
// are shown but not editable: they live only in the profile file.

(async () => {
  const box = document.getElementById('orgEditor');
  const res = await fetch('/api/admin/organisation');
  if (!res.ok) { box.textContent = 'Not available.'; return; }
  const data = await res.json();
  box.innerHTML = '';
  const table = document.createElement('table');
  for (const f of data.fields) {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.textContent = f.label;
    const td = document.createElement('td');
    const input = document.createElement('input');
    input.value = f.override || '';
    if (f.ignored) input.title = 'This saved value is not in effect: it fails the checks. Save a new one.';
    input.placeholder = f.profileValue || '(not set)';
    input.maxLength = 120;
    input.setAttribute('aria-label', f.label);
    const save = document.createElement('button');
    save.textContent = 'Save';
    save.style.cssText = 'font-size:12px;padding:3px 8px;margin-left:6px';
    const state = document.createElement('span');
    state.className = 'muted';
    state.style.marginLeft = '6px';
    save.onclick = async () => {
      const r = await fetch('/api/admin/organisation', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: f.key, value: input.value }),
      });
      const body = await r.json().catch(() => ({}));
      state.textContent = r.ok ? (input.value.trim() ? 'Saved ✓' : 'Back to the default ✓') : (body.error || 'Failed.');
    };
    input.style.width = '260px';
    td.append(input, save, state);
    tr.append(th, td);
    table.appendChild(tr);
  }
  const n = data.numbers;
  const p = document.createElement('p');
  p.className = 'muted';
  p.style.marginTop = '8px';
  const em = [n.emergency.primary, n.emergency.secondary]
    .filter((e) => e.number).map((e) => `${e.number} (${e.label})`).join(', ');
  p.textContent = `Helpline phone: ${n.phone || 'not set'} · Emergency: ${em || 'not set'}` +
    (n.timezone ? ` · Timezone: ${n.timezone}` : '') +
    ` — these come from profiles/${data.profile}.json and are changed there, by a deploy.`;
  box.append(table, p);
})();
