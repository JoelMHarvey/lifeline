'use strict';

// Schedule → Shifts: a coordinator renames a shift, changes its hours,
// takeover time or default mode, or adds a new one. Loaded only when the
// organisation's profile turns the shift editor on; uses schedule.js's
// globals (me, shifts, el, post, loadAll, $).

function drawShiftEditor() {
  if (!me || me.role !== 'coordinator') return;
  $('shiftEdPanel').style.display = 'block';
  const box = $('shiftEditor');
  box.innerHTML = '';
  const MODES = [['phone', 'Phone'], ['chat', 'Chat'], ['both', 'Phone + chat']];

  const form = (def, onSave, saveLabel) => {
    const wrap = el('div', { className: 'shiftEd' });
    const label = el('input', { type: 'text', value: def.label, maxLength: 40, ariaLabel: 'Name' });
    const start = el('input', { type: 'time', value: def.start, ariaLabel: 'Start' });
    const end = el('input', { type: 'time', value: def.end, ariaLabel: 'End' });
    const takeover = el('input', { type: 'time', value: def.takeover, ariaLabel: 'Takeover' });
    const mode = el('select', { ariaLabel: 'Mode' });
    for (const [v, t] of MODES) mode.appendChild(el('option', { value: v, textContent: t }));
    mode.value = (def.modes && def.modes.default) || 'both';
    const state = el('span', { className: 'muted' });
    const save = el('button', { textContent: saveLabel });
    save.onclick = async () => {
      save.disabled = true;
      const r = await onSave({ label: label.value, start: start.value, end: end.value,
        takeover: takeover.value, mode: mode.value });
      const body = await r.json().catch(() => ({}));
      save.disabled = false;
      state.textContent = r.ok ? 'Saved ✓' : (body.error || 'Failed.');
      if (r.ok) loadAll();
    };
    wrap.append(
      el('label', {}, 'Name ', label),
      el('span', { className: 'shiftEdTimes' },
        el('label', {}, 'From ', start), el('label', {}, 'to ', end),
        el('label', {}, 'takeover ', takeover)),
      el('label', {}, 'Mode ', mode),
      el('span', {}, save, ' ', state));
    const days = Object.keys(def.modes || {}).filter((k) => k !== 'default');
    if (days.length) {
      wrap.append(el('p', { className: 'muted', textContent:
        'Day exceptions kept: ' + days.map((d) => `${d} ${def.modes[d]}`).join(', ') }));
    }
    return wrap;
  };

  for (const def of shifts.filter((x) => x.kind === 'worker')) {
    const d = el('details', { className: 'ocsDef' });
    d.append(el('summary', { className: 'ocsName' },
      el('span', { textContent: `S${def.number} ${def.label}` }),
      el('span', { className: 'ocsSummary', textContent: `${def.start}–${def.end}` })));
    d.append(form(def, (body) => post('/api/shift-defs/' + def.number, body, 'PATCH'), 'Save'));
    const rm = el('button', { textContent: 'Remove this shift', className: 'shiftEdRemove' });
    const rmState = el('span', { className: 'muted' });
    rm.onclick = async () => {
      if (!confirm(`Remove S${def.number} ${def.label}? Only possible while it has no slots.`)) return;
      const r = await post('/api/shift-defs/' + def.number, {}, 'DELETE');
      const body = await r.json().catch(() => ({}));
      rmState.textContent = r.ok ? 'Removed ✓' : (body.error || 'Failed.');
      if (r.ok) loadAll();
    };
    d.append(el('p', {}, rm, ' ', rmState));
    box.appendChild(d);
  }
  const add = el('details', { className: 'ocsDef' });
  add.append(el('summary', { className: 'ocsName' }, el('span', { textContent: '＋ Add a shift' })));
  add.append(form({ label: '', start: '09:00', end: '13:00', takeover: '09:00', modes: { default: 'both' } },
    (body) => post('/api/shift-defs', body), 'Add shift'));
  box.appendChild(add);
}
