'use strict';

const $ = (id) => document.getElementById(id);
const post = (url, body, method = 'POST') => fetch(url, {
  method, headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
});

// Today's date where the helpline is (YYYY-MM-DD), not where the browser is
// or UTC: shift dates are the organisation's calendar dates.
const orgToday = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US',
    { timeZone: '{{timezone}}', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
};

let me = null;
let month = orgToday().slice(0, 7);
let shifts = [];
let slots = [];
let dayNotes = {};
let workers = null; // staff only: roster for assignment
let isStaff = false; // supervisors and coordinators manage the calendar

(async () => {
  const res = await fetch('/api/me');
  if (!res.ok) { location.href = 'console.html'; return; }
  me = await res.json();
  isStaff = ['supervisor', 'coordinator'].includes(me.role);
  if (me.role === 'coordinator') {
    $('genBtn').style.display = 'inline-block';
    $('autofillBtn').style.display = 'inline-block';
  }
  if (isStaff) {
    workers = await (await fetch('/api/schedule/workers')).json().catch(() => null);
  }
  await loadAll();
})();

function shiftMonth(delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  month = d.toISOString().slice(0, 7);
  loadAll();
}
$('prevBtn').onclick = () => shiftMonth(-1);
$('nextBtn').onclick = () => shiftMonth(1);
$('printBtn').onclick = () => window.print();
$('genBtn').onclick = async () => {
  if (!confirm(`Create empty worker slots for every shift/day of ${month}?`)) return;
  await post('/api/schedule/generate', { month });
  loadAll();
};
// Phones: Calendar / My shifts & availability tabs.
function setSchedTab(name) {
  document.querySelector('main').dataset.tab = name;
  for (const b of document.querySelectorAll('#schedTabs button')) {
    b.classList.toggle('on', b.dataset.tab === name);
  }
}
for (const b of document.querySelectorAll('#schedTabs button')) {
  b.onclick = () => {
    setSchedTab(b.dataset.tab);
    window.scrollTo({ top: 0 }); // start the other tab from its top
  };
}
setSchedTab('cal');

$('autofillBtn').onclick = async () => {
  const res = await post('/api/schedule/autofill', { month });
  const draft = await res.json().catch(() => null);
  if (!res.ok || !draft) { alert((draft && draft.error) || 'Failed.'); return; }
  if (!draft.proposals.length) {
    alert(draft.openSlots === 0
      ? 'Nothing to fill: every worker slot this month already has someone ' +
        '(or the month\'s slots haven\'t been created yet).'
      : `Nothing to fill: none of the ${draft.openSlots} open slot(s) has an available, ` +
        'eligible person who is free then and under their shift count.');
    return;
  }
  const sample = draft.proposals.slice(0, 12)
    .map((p) => `  ${p.date} S${p.shiftNumber} → ${p.name}`).join('\n');
  const none = draft.offeredButNone || [];
  const spread = `${draft.people} people get shifts, at most ${draft.mostForOne} each` +
    (none.length ? `; ${none.length} who offered get none (${none.slice(0, 5).join(', ')}` +
      `${none.length > 5 ? ', …' : ''})` : '') +
    `. Anyone who left "shifts I'd like" blank gets at most ${draft.unstatedMax}.`;
  if (!confirm(`Draft for ${month}: ${draft.proposals.length} assignment(s), ` +
    `${draft.openLeft} slot(s) left open for lack of availability.\n${spread}\n\n` + sample +
    (draft.proposals.length > 12 ? `\n  …and ${draft.proposals.length - 12} more` : '') +
    '\n\nApply? Everyone assigned is asked to confirm as usual, and each ' +
    'assignment lands in Recent changes. Check "Only, Nots and Also" notes ' +
    'yourself — the draft does not read them.')) return;
  const applied = await (await post('/api/schedule/autofill', { month, apply: true })).json();
  alert(`Assigned ${applied.assigned} shift(s) across ${applied.workers} people; ` +
    `${applied.openLeft} left open.`);
  loadAll();
};

$('calFeedBtn').onclick = async () => {
  const { token } = await (await fetch('/api/my-cal-token')).json();
  const url = `${location.origin}/api/schedule/ics/${token}`;
  prompt('Subscribe to this URL from your calendar app (Google Calendar: ' +
    '"Add other calendars → From URL"). Keep it private — it is your personal feed.', url);
};

async function loadAll() {
  $('monthLabel').textContent = new Date(month + '-01T00:00:00Z')
    .toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const data = await (await fetch('/api/schedule?month=' + month)).json();
  shifts = data.shifts;
  slots = data.slots;
  dayNotes = data.dayNotes || {};
  drawCalendar();
  drawShiftKey();
  drawMySlots();
  drawCover();
  drawAvailability();
  drawRoster();
  drawStats();
  drawAudit();
  drawSeatsEditor();
  drawOcsEditor();{{#features.shiftEditor}}
  if (typeof drawShiftEditor === 'function') drawShiftEditor();{{/features.shiftEditor}}
}

const workerShifts = () => shifts.filter((s) => s.kind !== 'supervision');
const defOf = (n) => shifts.find((s) => s.number === n);

function drawShiftKey() {
  const key = workerShifts().map((s) => {
    const modes = s.modes.default +
      (Object.keys(s.modes).length > 1 ? ' (varies by day)' : '');
    return `S${s.number} ${s.start}–${s.end} ${modes}`;
  });
  for (const s of shifts) {
    if (s.kind === 'supervision') key.push(`👁 ${s.label}: ${describeDays(s.days)}`);
  }
  $('shiftKey').textContent = key.join(' · ');
}

const WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const WD_LABEL = { sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat' };

// "Fri 21:00–02:00, Sat, Sun 21:00–09:00" — same-hours days grouped.
function describeDays(days) {
  if (!days) return 'every day';
  const groups = new Map();
  for (const wd of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) {
    if (!days[wd]) continue;
    const key = `${days[wd][0]}–${days[wd][1]}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(WD_LABEL[wd]);
  }
  if (!groups.size) return 'off';
  return [...groups].map(([t, ds]) => `${ds.join(', ')} ${t}`).join('; ');
}

function drawCalendar() {
  const cal = $('cal');
  cal.innerHTML = '';
  for (const d of ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']) {
    const h = document.createElement('div');
    h.className = 'dayHead';
    h.textContent = d;
    cal.appendChild(h);
  }
  const first = new Date(month + '-01T00:00:00Z');
  for (let i = 0; i < first.getUTCDay(); i++) {
    const b = document.createElement('div');
    b.className = 'day blank';
    cal.appendChild(b);
  }
  const today = orgToday();
  const byDate = new Map();
  for (const s of slots) {
    if (!byDate.has(s.date)) byDate.set(s.date, []);
    byDate.get(s.date).push(s);
  }
  const d = new Date(first);
  while (d.toISOString().slice(0, 7) === month) {
    const dateStr = d.toISOString().slice(0, 10);
    const cell = document.createElement('div');
    cell.className = 'day' + (dateStr === today ? ' today' : '');
    const num = document.createElement('div');
    num.className = 'dnum';
    num.textContent = String(d.getUTCDate());
    // Shown only in the phone list, where there's no weekday header row.
    num.appendChild(el('span', { className: 'dwd',
      textContent: d.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' }) }));
    if (dateStr === today) cell.id = 'todayCell';
    cell.appendChild(num);
    if (dayNotes[dateStr]) {
      const dn = document.createElement('div');
      dn.className = 'daynote';
      dn.textContent = dayNotes[dateStr];
      if (isStaff) {
        dn.classList.add('clickable');
        dn.onclick = () => editDayNote(dateStr);
      }
      cell.appendChild(dn);
    }
    for (const s of (byDate.get(dateStr) || [])) cell.appendChild(slotChip(s));
    if (isStaff) {
      const add = document.createElement('div');
      add.className = 'muted';
      add.style.cssText = 'cursor:pointer;font-size:11px';
      add.textContent = '+ slot';
      add.onclick = () => addSlot(dateStr);
      cell.appendChild(add);
      if (!dayNotes[dateStr]) {
        const dnAdd = document.createElement('div');
        dnAdd.className = 'muted';
        dnAdd.style.cssText = 'cursor:pointer;font-size:11px';
        dnAdd.textContent = '+ note';
        dnAdd.onclick = () => editDayNote(dateStr);
        cell.appendChild(dnAdd);
      }
    }
    cal.appendChild(cell);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  // Phones list the whole month; open it at today the first time.
  if (!scrolledToToday && $('todayCell') && matchMedia('(max-width: 760px)').matches) {
    scrolledToToday = true;
    $('todayCell').scrollIntoView({ block: 'start' });
  }
}
let scrolledToToday = false;

const STATUS_WORDS = { open: 'unstaffed', assigned: 'assigned — awaiting confirmation',
  confirmed: 'confirmed', sub_requested: 'cover wanted' };

function slotTipText(s, def) {
  const isOcs = def && def.kind === 'supervision';
  const head = isOcs ? `👁 ${def.label}` : `S${s.shiftNumber}`;
  const mode = def && !isOcs
    ? (def.modes[WD[new Date(s.date + 'T00:00:00Z').getUTCDay()]] || def.modes.default)
    : null;
  return `${head} · ${s.start}–${s.end}${mode ? ' · ' + mode : ''}` +
    (s.customTimes ? ' (changed for this day)' : '') +
    `\n${s.workerName || 'Nobody yet'} · ${STATUS_WORDS[s.status] || s.status}` +
    (s.role === 'observer' || s.role === 'supervised'
      ? ` · ${ROLE_INFO[s.role].label}${s.ordinal ? ' no. ' + s.ordinal : ''}` : '') +
    (s.note ? `\n${s.note}` : '');
}

// One floating tooltip for every chip: shows on hover (and keyboard focus),
// kept inside the window.
function attachTip(el, text) {
  const tip = $('slotTip');
  el.tabIndex = 0;
  const show = () => {
    tip.textContent = text;
    tip.style.display = 'block';
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    let top = r.bottom + 6;
    if (top + h > innerHeight - 4) top = r.top - h - 6;
    tip.style.top = Math.max(4, top) + 'px';
    tip.style.left = Math.max(4, Math.min(r.left, innerWidth - w - 4)) + 'px';
  };
  const hide = () => { tip.style.display = 'none'; };
  el.addEventListener('mouseenter', show);
  el.addEventListener('focus', show);
  el.addEventListener('mouseleave', hide);
  el.addEventListener('blur', hide);
  el.addEventListener('click', hide);
}

function slotChip(s) {
  const div = document.createElement('div');
  div.className = 'slot ' + s.status +
    (s.workerId === me.id ? ' mine' : '') +
    (isStaff || s.status === 'sub_requested' ? ' clickable' : '');
  const roleTag = (ROLE_INFO[s.role] || ROLE_INFO.worker).tag;
  const def = defOf(s.shiftNumber);
  const isOcs = def && def.kind === 'supervision';
  const name = isOcs
    ? `${roleTag}${def.label.replace(/^OCS\s*/, '')} ${s.workerName || '—'}`
    : `S${s.shiftNumber} ${roleTag}${s.workerGroup ? '· ' + s.workerGroup + ' ' : ''}${s.workerName || '—'}` +
      (s.ordinal ? ` · ${ROLE_INFO[s.role].short}${s.ordinal}` : '');
  div.textContent = name;
  if (s.customTimes) div.appendChild(document.createTextNode(' ⏱'));
  if (s.note) {
    const n = document.createElement('span');
    n.className = 'slotnote';
    n.textContent = s.note;
    div.appendChild(n);
  }
  attachTip(div, slotTipText(s, def));
  if (isStaff) div.onclick = () => staffSlotMenu(s);
  else if (s.status === 'sub_requested' && s.workerId !== me.id) {
    div.onclick = () => takeSlot(s);
  }
  return div;
}

// ---------------------------------------------------------------------------
// Staff slot editor: one dialog for a slot (who, note, hours, extra seats,
// cover, cancel) and for adding a slot to a day.

const ROLE_INFO = {
  worker: { label: 'Worker', tag: '' },
  supervisor: { label: 'Supervisor', tag: '👁 ' },
  observer: { label: 'Observation shift (OS)', tag: '🎓 ', short: 'OS' },
  supervised: { label: 'Supervised shift (SS)', tag: '🤝 ', short: 'SS' },
};
const longDate = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB',
  { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) e.append(k);
  return e;
};

// People who can take a role, best first: for worker seats, those marked
// available for this shift on this weekday; for OS/SS seats, trainees.
async function peopleFor(role, date, shiftNumber) {
  const av = role === 'worker'
    ? await (await fetch(`/api/availability?month=${date.slice(0, 7)}&all=1`)).json()
      .catch(() => [])
    : [];
  const dow = new Date(date + 'T00:00:00Z').getUTCDay();
  const avail = new Set(av.filter((a) => a.canShifts.includes(shiftNumber) &&
    (!a.canDays || !a.canDays[shiftNumber] || a.canDays[shiftNumber].includes(dow)))
    .map((a) => a.workerId));
  const pool = (workers || []).filter((w) => w.service_status === 'in_service' &&
    (role === 'observer' || role === 'supervised' ? true
      : role === 'supervisor' ? ['supervisor', 'coordinator'].includes(w.role)
        : w.role !== 'trainee'));
  const rank = (w) => (role === 'worker' ? (avail.has(Number(w.id)) ? 0 : 1)
    : role === 'observer' || role === 'supervised' ? (w.role === 'trainee' ? 0 : 1) : 0);
  pool.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  return pool.map((w) => ({ id: Number(w.id), name: w.name,
    hint: role === 'worker' && avail.has(Number(w.id)) ? ' ✓ available'
      : (role === 'observer' || role === 'supervised') && w.role === 'trainee' ? ' (trainee)' : '' }));
}

function personSelect(people, current, blank = '— nobody —') {
  const sel = el('select');
  sel.append(el('option', { value: '', textContent: blank }));
  for (const p of people) {
    sel.append(el('option', { value: String(p.id), textContent: p.name + p.hint,
      selected: p.id === current }));
  }
  return sel;
}

function openDialog(title, sub, body) {
  const dlg = $('slotDlg');
  $('dlgTitle').textContent = title;
  $('dlgSub').textContent = sub;
  const box = $('dlgBody');
  box.innerHTML = '';
  box.append(...body);
  $('dlgErr').textContent = '';
  if (!dlg.open) dlg.showModal();
}

// Run a change, then refresh the calendar and close — or show the error.
async function act(fn) {
  try {
    const res = await fn();
    if (res && !res.ok) {
      $('dlgErr').textContent = (await res.json().catch(() => ({}))).error || 'That didn\'t work.';
      return;
    }
    $('slotDlg').close();
    loadAll();
  } catch {
    $('dlgErr').textContent = 'That didn\'t work — check the connection and try again.';
  }
}

const row = (label, ...controls) =>
  el('div', { className: 'dlgRow' }, el('span', { className: 'dlgLabel', textContent: label }), ...controls);
const btn = (text, onclick, cls = '') => el('button', { type: 'button', textContent: text, onclick, className: cls });

async function staffSlotMenu(s) {
  const def = defOf(s.shiftNumber);
  const isOcs = def && def.kind === 'supervision';
  const head = isOcs ? `👁 ${def.label}` : `S${s.shiftNumber}`;
  const info = ROLE_INFO[s.role] || ROLE_INFO.worker;
  const body = [];

  // Who.
  const people = await peopleFor(s.role, s.date, s.shiftNumber);
  const who = personSelect(people, s.workerId);
  body.push(row(isOcs || s.role === 'worker' ? 'Who' : info.label, who,
    btn('Assign', () => act(() => who.value
      ? post('/api/schedule/slot/' + s.id, { workerId: Number(who.value) }, 'PATCH')
      : post('/api/schedule/slot/' + s.id, { workerId: null }, 'PATCH')), 'primary')));

  // Note.
  const note = el('input', { type: 'text', value: s.note || '', maxLength: 60,
    placeholder: '{{text.slotNoteExample}}' });
  body.push(row('Note', note,
    btn('Save', () => act(() => post('/api/schedule/slot/' + s.id, { note: note.value }, 'PATCH')))));

  // Hours.
  const st = el('input', { type: 'time', value: s.start });
  const en = el('input', { type: 'time', value: s.end });
  const hours = [st, '–', en,
    btn('Save', () => act(() => post('/api/schedule/slot/' + s.id,
      { start: st.value, end: en.value }, 'PATCH')))];
  if (s.customTimes) {
    hours.push(btn('Standard hours', () => act(() => post('/api/schedule/slot/' + s.id,
      { start: null, end: null }, 'PATCH'))));
  }
  body.push(row('Hours', ...hours));

  // Extra seats on this shift: someone observing, or on a supervised shift.
  if (!isOcs) {
    const role = el('select');
    for (const r of ['observer', 'supervised', 'worker']) {
      role.append(el('option', { value: r,
        textContent: r === 'worker' ? 'Second worker' : ROLE_INFO[r].label }));
    }
    const pick = el('span');
    const refreshPick = async () => {
      pick.innerHTML = '';
      pick.append(personSelect(await peopleFor(role.value, s.date, s.shiftNumber), null, '— choose later —'));
    };
    role.onchange = refreshPick;
    await refreshPick();
    body.push(el('h4', { textContent: 'Add someone else to this shift' }));
    body.push(row('', role, pick, btn('Add', () => act(async () => {
      const res = await post('/api/schedule/slot',
        { date: s.date, shiftNumber: s.shiftNumber, role: role.value });
      if (!res.ok) return res;
      const person = pick.querySelector('select').value;
      if (!person) return res;
      const { id } = await res.json();
      return post('/api/schedule/slot/' + id, { workerId: Number(person) }, 'PATCH');
    }), 'primary')));
  }

  // Cover and cancel.
  const foot = [];
  if (s.workerId && s.status !== 'sub_requested') {
    foot.push(btn('Request cover', () => act(() => post(`/api/schedule/slot/${s.id}/sub-request`))));
  }
  if (s.status === 'sub_requested') {
    foot.push(btn('Email everyone for cover', () => coverDialog(s)));
  }
  foot.push(btn('Cancel this slot', () => {
    if (confirm('Cancel this slot? It disappears from the schedule.')) {
      act(() => post('/api/schedule/slot/' + s.id, { cancel: true }, 'PATCH'));
    }
  }, 'dlgDanger'));
  body.push(el('div', { className: 'dlgFoot' }, ...foot));

  const status = STATUS_WORDS[s.status] || s.status;
  openDialog(`${head} · ${longDate(s.date)}`,
    `${s.start}–${s.end} · ${s.role === 'worker' || isOcs ? '' : info.label + ' · '}` +
    `${s.workerName || 'nobody yet'} · ${status}` +
    (s.ordinal ? ` · ${info.short} no. ${s.ordinal}` : ''), body);
}

async function addSlot(date) {
  const shiftSel = el('select');
  for (const d of shifts) {
    shiftSel.append(el('option', { value: String(d.number),
      textContent: d.kind === 'supervision' ? `👁 ${d.label}` : `S${d.number} ${d.start}–${d.end}` }));
  }
  const roleSel = el('select');
  for (const r of ['worker', 'observer', 'supervised', 'supervisor']) {
    roleSel.append(el('option', { value: r, textContent: ROLE_INFO[r].label }));
  }
  const pick = el('span');
  const refresh = async () => {
    const def = defOf(Number(shiftSel.value));
    const ocs = def && def.kind === 'supervision';
    roleSel.disabled = ocs;
    if (ocs) roleSel.value = 'supervisor';
    pick.innerHTML = '';
    pick.append(personSelect(await peopleFor(roleSel.value, date, Number(shiftSel.value)),
      null, '— choose later —'));
  };
  shiftSel.onchange = refresh;
  roleSel.onchange = refresh;
  await refresh();
  openDialog(`Add a slot · ${longDate(date)}`, 'An extra seat on a shift, or a shift that isn\'t on the calendar yet.', [
    row('Shift', shiftSel),
    row('Role', roleSel),
    row('Who', pick),
    el('div', { className: 'dlgFoot' }, btn('Add slot', () => act(async () => {
      const res = await post('/api/schedule/slot',
        { date, shiftNumber: Number(shiftSel.value), role: roleSel.value });
      if (!res.ok) return res;
      const person = pick.querySelector('select').value;
      if (!person) return res;
      const { id } = await res.json();
      return post('/api/schedule/slot/' + id, { workerId: Number(person) }, 'PATCH');
    }), 'primary')),
  ]);
}

async function takeSlot(s) {
  if (!confirm(`Take S${s.shiftNumber} on ${s.date}? It becomes your shift to confirm.`)) return;
  const res = await post(`/api/schedule/slot/${s.id}/take`);
  if (!res.ok) alert((await res.json()).error || 'Could not take it.');
  loadAll();
}

async function drawMySlots() {
  const rows = await (await fetch('/api/schedule/mine')).json();
  const box = $('mySlots');
  box.innerHTML = rows.length ? '' : '<p class="muted">None assigned.</p>';
  for (const s of rows) {
    const div = document.createElement('div');
    div.className = 'myslot';
    const shift = defOf(s.shiftNumber);
    const label = shift && shift.kind === 'supervision' ? shift.label : `S${s.shiftNumber}`;
    div.textContent = `${s.date} · ${label}` +
      (s.start ? ` ${s.start}–${s.end}` : '') +
      (s.role !== 'worker' && !(shift && shift.kind === 'supervision') ? ` (${s.role})` : '') + ' ';
    if (s.status === 'confirmed') {
      const b = document.createElement('span');
      b.className = 'badge ok';
      b.textContent = 'confirmed';
      div.appendChild(b);
    } else if (s.status === 'sub_requested') {
      const b = document.createElement('span');
      b.className = 'badge warn';
      b.textContent = 'cover requested';
      div.appendChild(b);
    } else {
      const c = document.createElement('button');
      c.textContent = 'Confirm';
      c.className = 'primary';
      c.style.cssText = 'font-size:12px;padding:2px 8px';
      c.onclick = async () => { await post(`/api/schedule/slot/${s.id}/confirm`); loadAll(); };
      div.appendChild(c);
      const r = document.createElement('button');
      r.textContent = "Can't make it";
      r.style.cssText = 'font-size:12px;padding:2px 8px;margin-left:4px';
      r.onclick = async () => {
        if (confirm('Request cover for this shift? You stay responsible until a colleague takes it.')) {
          await post(`/api/schedule/slot/${s.id}/sub-request`);
          loadAll();
        }
      };
      div.appendChild(r);
    }
    box.appendChild(div);
  }
}

function drawCover() {
  const list = slots.filter((s) => s.status === 'sub_requested');
  const box = $('coverList');
  box.innerHTML = list.length ? '' : '<p class="muted">None.</p>';
  for (const s of list) {
    const div = document.createElement('div');
    div.className = 'myslot';
    div.textContent = `${s.date} · S${s.shiftNumber} — ${s.workerName || '—'} needs cover `;
    if (s.workerId !== me.id && me.role !== 'trainee') {
      const b = document.createElement('button');
      b.className = 'primary';
      b.style.cssText = 'font-size:12px;padding:2px 8px';
      b.textContent = 'Take it';
      b.onclick = () => takeSlot(s);
      div.appendChild(b);
    }
    if (isStaff) {
      const e = btn('Email everyone', () => coverDialog(s));
      e.style.cssText = 'font-size:12px;padding:2px 8px;margin-left:4px';
      e.title = 'Email everyone who could take this shift';
      div.appendChild(e);
    }
    box.appendChild(div);
  }
}

// Staff: a templated email to everyone who could take a shift needing
// cover. The server works out who it reaches; the message can be edited.
async function coverDialog(s) {
  const res = await fetch(`/api/schedule/slot/${s.id}/cover-broadcast`);
  const d = await res.json().catch(() => ({}));
  if (!res.ok) { alert(d.error || 'Could not prepare the email.'); return; }
  const subject = el('input', { type: 'text', value: d.subject, maxLength: 150 });
  const body = el('textarea', { value: d.body, rows: 11, maxLength: 3000 });
  body.className = 'coverBody';
  const n = d.recipients.length;
  const who = el('details', { className: 'coverWho' },
    el('summary', { textContent: `Goes to ${n} ${n === 1 ? 'person' : 'people'} who could take it` }),
    el('p', { className: 'muted', textContent: d.recipients.join(', ') || 'Nobody is free to take it.' }));
  const warn = [];
  if (!d.mailConfigured) warn.push('Email is not set up on this site, so nothing can be sent.');
  if (d.lastSentAt) warn.push(`A cover email for this shift last went out ${fmtWhen(d.lastSentAt)}.`);
  const send = btn(`Send to ${n}`, () => act(async () => {
    send.disabled = true;
    const r = await post(`/api/schedule/slot/${s.id}/cover-broadcast`,
      { subject: subject.value, body: body.value });
    if (r.ok) {
      const out = await r.json();
      alert(`Sent to ${out.sent} of ${out.recipients}.`);
      return { ok: true };
    }
    send.disabled = false;
    return r;
  }), 'primary');
  if (!n || !d.mailConfigured) send.disabled = true;
  openDialog('Email everyone for cover',
    'Each person gets their own copy — nobody sees anyone else\'s address.', [
      row('Subject', subject),
      body,
      who,
      ...warn.map((w) => el('p', { className: 'coverWarn', textContent: w })),
      el('div', { className: 'dlgFoot' }, send),
    ]);
}

const DAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

async function drawAvailability() {
  // Availability is for the *next* month by default when viewing the current one.
  $('avMonth').textContent = month;
  const box = $('avShifts');
  box.innerHTML = '';
  const mine = await (await fetch('/api/availability?month=' + month)).json();
  for (const s of workerShifts()) {
    const wrap = document.createElement('div');
    wrap.className = 'avShiftWrap';
    const label = document.createElement('label');
    label.className = 'avShift';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = s.number;
    cb.checked = !!(mine && mine.canShifts.includes(s.number));
    label.appendChild(cb);
    label.appendChild(document.createTextNode(
      `S${s.number} ${s.start}–${s.end} (${s.modes.default}${Object.keys(s.modes).length > 1 ? '*' : ''})`));
    wrap.appendChild(label);
    // Which days of the week this shift works — all on unless restricted.
    const daysRow = document.createElement('div');
    daysRow.className = 'avDays';
    daysRow.dataset.shift = s.number;
    const restricted = mine && mine.canDays && mine.canDays[s.number];
    for (let d = 0; d < 7; d++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dayBtn' + (!restricted || restricted.includes(d) ? ' on' : '');
      b.dataset.day = d;
      b.textContent = DAY_LABELS[d];
      b.onclick = () => b.classList.toggle('on');
      daysRow.appendChild(b);
    }
    daysRow.style.display = cb.checked ? 'flex' : 'none';
    cb.onchange = () => { daysRow.style.display = cb.checked ? 'flex' : 'none'; };
    wrap.appendChild(daysRow);
    box.appendChild(wrap);
  }
  $('avDesired').value = mine && mine.desiredShifts != null ? mine.desiredShifts : '';
  $('avNotes').value = (mine && mine.notes) || '';
  $('avState').textContent = mine ? `Last submitted ${new Date(mine.submittedAt).toLocaleString()}` : 'Not yet submitted for this month.';
}

$('avSubmit').onclick = async () => {
  const canShifts = [...document.querySelectorAll('#avShifts input:checked')]
    .map((c) => Number(c.value));
  // Days per ticked shift: all seven (or none) means unrestricted — omit it.
  const canDays = {};
  for (const n of canShifts) {
    const row = document.querySelector(`#avShifts .avDays[data-shift="${n}"]`);
    if (!row) continue;
    const days = [...row.querySelectorAll('.dayBtn.on')].map((b) => Number(b.dataset.day));
    if (days.length > 0 && days.length < 7) canDays[n] = days;
  }
  const res = await post('/api/availability', {
    month,
    canShifts,
    canDays,
    desiredShifts: $('avDesired').value === '' ? null : Number($('avDesired').value),
    notes: $('avNotes').value.trim() || undefined,
  });
  $('avState').textContent = res.ok ? 'Submitted ✓' : 'Failed — try again.';
};

function availabilityLine(r) {
  const shiftsTxt = r.canShifts.map((n) => {
    const days = r.canDays && r.canDays[n];
    return `S${n}` + (days ? ` (${days.map((d) => DAY_LABELS[d]).join(' ')})` : '');
  }).join(', ');
  return `: ${r.canShifts.length ? shiftsTxt : 'away'}` +
    (r.desiredShifts != null ? ` · wants ${r.desiredShifts}` : '') +
    (r.notes ? ` · ${r.notes}` : '');
}

// Name as a mailto link for staff (click to email them), plain text otherwise.
function nameEl(name, email, subject) {
  if (!email) return document.createTextNode(name);
  const a = document.createElement('a');
  a.href = `mailto:${email}?subject=${encodeURIComponent(subject)}`;
  a.textContent = name;
  a.title = email;
  return a;
}

async function drawRoster() {
  const rows = await (await fetch(`/api/availability?month=${month}&all=1`)).json()
    .catch(() => []);
  const box = $('rosterList');
  box.innerHTML = '';

  if (!isStaff) {
    // Workers see the swap-partner view: who has submitted, and what.
    if (!rows.length) { box.textContent = 'No availability submitted yet.'; return; }
    for (const r of rows) {
      const p = document.createElement('p');
      p.textContent = r.name + availabilityLine(r);
      box.appendChild(p);
    }
    return;
  }

  // Staff see everyone in service, grouped by whether they have submitted,
  // each name a click-to-email link. The filter box earns its keep once the
  // team grows past a screenful.
  const byId = new Map(rows.map((r) => [r.workerId, r]));
  const inService = (workers || []).filter((w) => w.service_status === 'in_service');
  const submitted = inService.filter((w) => byId.has(Number(w.id)));
  const missing = inService.filter((w) => !byId.has(Number(w.id)));
  const filter = $('rosterFilter');
  filter.style.display = 'block';
  filter.oninput = () => {
    const q = filter.value.trim().toLowerCase();
    for (const p of box.querySelectorAll('p[data-name]')) {
      p.style.display = !q || p.dataset.name.includes(q) ? '' : 'none';
    }
  };

  const group = (label, cls) => {
    const h = document.createElement('div');
    h.className = 'rosterGrp' + (cls ? ' ' + cls : '');
    h.textContent = label;
    box.appendChild(h);
  };
  const row = (w, tail, subject) => {
    const p = document.createElement('p');
    p.dataset.name = w.name.toLowerCase();
    p.appendChild(nameEl(w.name, w.email, subject));
    if (tail) p.appendChild(document.createTextNode(tail));
    box.appendChild(p);
  };

  group(`Not yet submitted (${missing.length})`, missing.length ? 'gap' : '');
  if (!missing.length) {
    const p = document.createElement('p');
    p.textContent = 'Everyone has submitted ✓';
    box.appendChild(p);
  }
  for (const w of missing) {
    row(w, '', `{{name}} — availability needed for ${month}`);
  }
  group(`Submitted (${submitted.length})`);
  for (const w of submitted) {
    row(w, availabilityLine(byId.get(Number(w.id))), `{{name}} schedule — ${month}`);
  }

  $('missingBox').style.display = 'block';
  $('remindState').textContent = '';
  $('remindBtn').style.display = missing.length ? 'inline-block' : 'none';
}

$('remindBtn').onclick = async () => {
  if (!confirm(`Email an availability reminder for ${month} to everyone who hasn't submitted?`)) return;
  const res = await post('/api/availability/remind', { month });
  const body = await res.json().catch(() => ({}));
  $('remindState').textContent = res.ok
    ? `Reminded ${body.sent} of ${body.missing}.`
    : (body.error || 'Failed — try again.');
};

// Coordinator only: the latest few schedule changes, with the full log one
// click away in its own window.
const fmtWhen = (at) => new Date(at).toLocaleString('en-GB', {
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

async function drawAudit() {
  if (me.role !== 'coordinator') return;
  const rows = await (await fetch('/api/schedule/audit?limit=5')).json().catch(() => null);
  if (!rows) return;
  $('auditPanel').style.display = 'block';
  const box = $('auditList');
  if (!rows.length) { box.textContent = 'No changes recorded yet.'; return; }
  box.innerHTML = '';
  for (const r of rows) {
    box.append(el('p', { textContent: `${fmtWhen(r.at)} · ${r.actorName} ${r.what}` +
      (r.slot ? ` ${r.slot}` : '') + (r.detail ? ` — ${r.detail}` : '') }));
  }
}

async function drawStats() {
  const rows = await (await fetch('/api/schedule/stats')).json().catch(() => []);
  const box = $('statsBox');
  const mine = rows[0];
  if (!mine) { box.textContent = 'No shifts recorded yet.'; return; }
  box.textContent = `Worked ${mine.worked} shifts (${mine.hours} hours) all-time · ` +
    `${mine.worked_12mo} in 12 months · ${mine.worked_month} this month · ` +
    `${mine.scheduled - mine.worked} upcoming`;
}

async function editDayNote(date) {
  const note = prompt(`Note under ${date} (e.g. "Group 1 7pm") — empty removes it:`,
    dayNotes[date] || '');
  if (note === null) return;
  await post('/api/schedule/day-note', { date, note });
  loadAll();
}

// Coordinator only: each supervision block's weekly pattern — which days it
// runs and its hours on each. Used when the month's slots are created; one
// night's change is "set hours" on that slot.
// Coordinator only: seats per worker shift. The note survives the redraw
// that follows a save.
let seatsNote = '';
const SEAT_DAYS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'],
  ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];
function drawSeatsEditor() {
  if (me.role !== 'coordinator') return;
  $('seatsPanel').style.display = 'block';
  const box = $('seatsEditor');
  box.innerHTML = '';
  const table = document.createElement('table');
  table.className = 'seatsGrid';
  const head = document.createElement('tr');
  head.appendChild(el('th', { textContent: '' }));
  for (const [, label] of SEAT_DAYS) head.appendChild(el('th', { textContent: label }));
  table.appendChild(head);
  const rows = [];
  for (const def of shifts.filter((x) => x.kind === 'worker')) {
    const tr = document.createElement('tr');
    tr.appendChild(el('th', { textContent: `S${def.number}`, title: `${def.start}–${def.end}` }));
    const week = def.weekSeats ||
      Object.fromEntries(SEAT_DAYS.map(([wd]) => [wd, def.seats || 1]));
    const inputs = {};
    for (const [wd, label] of SEAT_DAYS) {
      const inp = document.createElement('input');
      inp.type = 'number'; inp.min = 0; inp.max = 6; inp.value = week[wd] ?? 1;
      inp.setAttribute('aria-label', `S${def.number} ${label}`);
      const mark = () => inp.classList.toggle('off', Number(inp.value) === 0);
      inp.oninput = mark; mark();
      inputs[wd] = inp;
      const td = document.createElement('td');
      td.appendChild(inp);
      tr.appendChild(td);
    }
    rows.push({ number: def.number, inputs,
      was: JSON.stringify(Object.fromEntries(SEAT_DAYS.map(([wd]) => [wd, week[wd] ?? 1]))) });
    table.appendChild(tr);
  }
  const save = document.createElement('button');
  save.textContent = 'Save';
  save.style.cssText = 'font-size:12px;padding:2px 8px;margin-top:6px';
  const state = document.createElement('span');
  state.className = 'muted';
  state.style.marginLeft = '6px';
  state.textContent = seatsNote;
  seatsNote = '';
  save.onclick = async () => {
    const changed = rows.map((r) => ({ ...r,
      week: Object.fromEntries(SEAT_DAYS.map(([wd]) => [wd, Number(r.inputs[wd].value)])) }))
      .filter((r) => JSON.stringify(r.week) !== r.was);
    if (!changed.length) { state.textContent = 'Nothing changed.'; return; }
    for (const r of changed) {
      const res = await post('/api/shift-defs/' + r.number, { seats: r.week }, 'PATCH');
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { state.textContent = `S${r.number}: ${body.error || 'failed'}`; return; }
    }
    seatsNote = 'Saved ✓ — press "Create month\'s slots" to add seats to this month.';
    loadAll();
  };
  box.append(table, save, state);
}

function drawOcsEditor() {
  const box = $('ocsEditor');
  if (me.role !== 'coordinator') return;
  $('ocsPanel').style.display = 'block';
  box.innerHTML = '';
  for (const def of shifts.filter((x) => x.kind === 'supervision')) {
    const wrap = document.createElement('details');
    wrap.className = 'ocsDef';
    const h = document.createElement('summary');
    h.className = 'ocsName';
    h.append(el('span', { textContent: '👁 ' + def.label }),
      el('span', { className: 'ocsSummary', textContent: describeDays(def.days) }));
    wrap.appendChild(h);
    const days = def.days || Object.fromEntries(WD.map((wd) => [wd, [def.start, def.end]]));
    for (const wd of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) {
      const row = document.createElement('label');
      row.className = 'ocsRow';
      row.dataset.wd = wd;
      const on = document.createElement('input');
      on.type = 'checkbox';
      on.checked = !!days[wd];
      const st = document.createElement('input');
      st.type = 'time';
      st.value = days[wd] ? days[wd][0] : def.start;
      const en = document.createElement('input');
      en.type = 'time';
      en.value = days[wd] ? days[wd][1] : def.end;
      const sync = () => { st.disabled = en.disabled = !on.checked; };
      on.onchange = sync;
      sync();
      const day = document.createElement('span');
      day.className = 'ocsDay';
      day.textContent = WD_LABEL[wd];
      row.append(on, day, st, document.createTextNode('–'), en);
      wrap.appendChild(row);
    }
    const save = document.createElement('button');
    save.textContent = 'Save ' + def.label;
    save.style.cssText = 'font-size:12px;padding:2px 8px;margin-top:4px';
    const state = document.createElement('span');
    state.className = 'muted';
    state.style.marginLeft = '6px';
    save.onclick = async () => {
      const out = {};
      for (const row of wrap.querySelectorAll('.ocsRow')) {
        const [on, st, en] = row.querySelectorAll('input');
        if (on.checked) out[row.dataset.wd] = [st.value, en.value];
      }
      const res = await post('/api/shift-defs/' + def.number, { days: out }, 'PATCH');
      const body = await res.json().catch(() => ({}));
      state.textContent = res.ok ? 'Saved ✓' : (body.error || 'Failed.');
      if (res.ok) loadAll();
    };
    wrap.append(save, state);
    box.appendChild(wrap);
  }
}
