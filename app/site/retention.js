'use strict';

// Admin → Keeping records: how long conversations are kept.
(function () {
  const sel = document.getElementById('retDays');
  const btn = document.getElementById('retSave');
  const msg = document.getElementById('retMsg');
  if (!sel) return;
  let current = null;
  const label = (d) => (d === 0 ? 'until someone deletes them'
    : (sel.querySelector(`option[value="${d}"]`) || {}).textContent || `${d} days`);

  fetch('/api/admin/retention').then((r) => (r.ok ? r.json() : null)).then((r) => {
    if (!r) return;
    current = r.days;
    if (!sel.querySelector(`option[value="${r.days}"]`)) {
      const o = document.createElement('option');
      o.value = String(r.days); o.textContent = `${r.days} days`;
      sel.appendChild(o);
    }
    sel.value = String(r.days);
  });

  btn.addEventListener('click', async () => {
    const days = Number(sel.value);
    const shorter = days !== 0 && (current === 0 || (current !== null && days < current));
    if (shorter && !confirm(`Conversations older than ${label(days)} will be deleted ` +
        'for good at the next hourly check. Continue?')) return;
    const res = await fetch('/api/admin/retention', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { msg.textContent = body.error || 'Not saved.'; return; }
    current = days;
    msg.textContent = 'Saved.';
  });
})();
