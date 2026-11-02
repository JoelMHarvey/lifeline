'use strict';

// First-run setup wizard (src/setup.js). Every answer is saved server-side
// as you go, so closing the tab resumes where you were. Nothing takes effect
// until "Finish" on the last step.

const STEPS = [
  ['org', 'Organisation'], ['look', 'Look'], ['safety', 'Safety numbers'], ['modules', 'Modules'],
  ['voice', 'Phone calls'], ['shifts', 'Shifts'], ['email', 'Email'], ['account', 'Your account'], ['ready', 'Ready check'],
];
const WD = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];
const MODES = [['both', 'Phone + chat'], ['phone', 'Phone'], ['chat', 'Chat']];

let S = null;        // server state
let D = null;        // the draft
let errors = {};
let setupToken = '';
try { setupToken = sessionStorage.getItem('setupToken') || ''; } catch { /* private mode */ }

const $ = (id) => document.getElementById(id);
// Append, skipping empty slots (conditional pieces pass null).
const put = (parent, ...kids) => parent.append(...kids.filter((k) => k !== null && k !== undefined));
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) if (k !== null && k !== undefined) e.append(k);
  return e;
};

async function api(path, body) {
  const res = await fetch('/api/setup/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'x-setup-token': setupToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function load() {
  const r = await api('state');
  if (r.status === 401 && r.data.tokenRequired) return askToken();
  if (r.status === 409 && r.data.otherBrowser) return problem(r.data.error);
  if (r.status === 404 || (r.ok && !r.data.open)) return closed();
  if (!r.ok) return problem('Setup could not load (' + (r.data.error || r.status) + '). Reload to try again.');
  S = r.data;
  D = S.draft;
  draw();
}

function askToken() {
  const body = $('body');
  body.innerHTML = '';
  const input = el('input', { type: 'password', autocomplete: 'off' });
  const go = el('button', { className: 'primary', textContent: 'Continue' });
  go.onclick = () => {
    setupToken = input.value.trim();
    try { sessionStorage.setItem('setupToken', setupToken); } catch { /* ignore */ }
    load();
  };
  put(body, el('h2', { textContent: 'Setup token' }),
    el('p', { className: 'muted', textContent: 'This server asks for the setup token (TL_SETUP_TOKEN) you were given.' }),
    el('div', { className: 'field' }, input), go);
}

function problem(text) {
  $('steps').innerHTML = '';
  $('body').innerHTML = '';
  put($('body'), el('h2', { textContent: 'Setup can’t continue here' }), el('p', { textContent: text }));
}

function closed() {
  $('steps').innerHTML = '';
  $('body').innerHTML = '';
  $('body').append(el('h2', { textContent: 'Setup is finished' }),
    el('p', { className: 'muted', textContent: 'This service is already set up. Sign in to continue.' }),
    el('p', {}, el('a', { href: 'console.html', textContent: 'Go to sign-in →' })));
}

// ---------------------------------------------------------------------------

function draw() {
  const at = STEPS.findIndex(([k]) => k === D.step);
  const steps = $('steps');
  steps.innerHTML = '';
  STEPS.forEach(([k, label], i) => {
    const b = el('button', { textContent: `${i + 1}. ${label}` });
    b.onclick = () => go(k);
    steps.append(el('li', { className: i === at ? 'on' : (i < at ? 'done' : '') }, b));
  });
  const body = $('body');
  body.innerHTML = '';
  const draw = { org: drawOrg, look: drawLook, safety: drawSafety, modules: drawModules,
    voice: drawVoice, shifts: drawShifts, email: drawEmail, account: drawAccount, ready: drawReady }[D.step] || drawOrg;
  draw(body);
}

const nextOf = (k) => STEPS[Math.min(STEPS.length - 1, STEPS.findIndex(([s]) => s === k) + 1)][0];
const prevOf = (k) => STEPS[Math.max(0, STEPS.findIndex(([s]) => s === k) - 1)][0];

async function save(patch, then) {
  const r = await api('save', patch);
  if (!r.ok) {
    errors = r.data.errors || { _: r.data.error || 'Could not save.' };
    draw();
    return false;
  }
  S = r.data.state;
  D = S.draft;
  errors = r.data.errors || {};
  if (then && !Object.keys(errors).length) D.step = then;
  if (then && !Object.keys(errors).length) await api('save', { step: then });
  draw();
  return true;
}

async function go(step) {
  await api('save', { step });
  D.step = step;
  errors = {};
  draw();
}

function field(label, input, { hint, key } = {}) {
  return el('label', { className: 'field' }, label, input,
    hint ? el('span', { className: 'hint', textContent: hint }) : null,
    key && errors[key] ? el('span', { className: 'err', textContent: errors[key] }) : null);
}
const text = (value, props = {}) => el('input', { type: 'text', value: value ?? '', ...props });

function navButtons(onNext, nextLabel = 'Save and continue') {
  const wrap = el('div', { className: 'nav' });
  const back = el('button', { textContent: '← Back' });
  back.onclick = () => go(prevOf(D.step));
  back.disabled = D.step === 'org';
  const next = el('button', { className: 'primary', textContent: nextLabel });
  next.onclick = async () => { next.disabled = true; await onNext(); next.disabled = false; };
  wrap.append(back, next);
  if (errors._) wrap.prepend(el('span', { className: 'err', textContent: errors._ }));
  return wrap;
}

// 1 --------------------------------------------------------------------------
function drawOrg(body) {
  const o = D.org || {};
  const from = el('select');
  for (const p of S.profiles) from.append(el('option', { value: p.id, textContent: `${p.name} (${p.id})` }));
  from.value = o.from || 'generic';
  from.onchange = () => save({ org: { from: from.value } });
  const name = text(o.name, { maxLength: 120 });
  const shortName = text(o.shortName, { maxLength: 40 });
  const website = text(o.website, { placeholder: 'https://', maxLength: 200 });
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const tz = text(o.timezoneChosen ? o.timezone : (o.timezone === 'UTC' && browserTz ? browserTz : o.timezone), { maxLength: 60 });
  tz.setAttribute('list', 'tzList');
  const list = el('datalist', { id: 'tzList' });
  try { for (const z of Intl.supportedValuesOf('timeZone')) list.append(el('option', { value: z })); } catch { /* old browser */ }
  put(body, el('h2', { textContent: 'Your organisation' }),
    field('Start from', from, { hint: 'Fills in the later steps from an existing profile. You can change everything.' }),
    field('Name', name, { key: 'name', hint: 'As callers and volunteers should see it, e.g. "Harbour Lifeline".' }),
    field('Short name', shortName, { key: 'shortName', hint: 'Used in page titles and calendar entries.' }),
    field('Public website', website, { key: 'website', hint: 'Optional. The caller page links your logo to it.' }),
    field('Time zone', tz, { key: 'timezone', hint: 'Where the helpline is. Shift times are local times there.' }), list,
    navButtons(() => save({ org: { name: name.value, shortName: shortName.value, website: website.value,
      timezone: tz.value.trim(), timezoneChosen: true } }, nextOf('org'))));
}

// 2 --------------------------------------------------------------------------
function luminance(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const contrastWhite = (hex) => 1.05 / (luminance(hex) + 0.05);

function drawLook(body) {
  const l = D.look || {};
  const color = el('input', { type: 'color', value: l.accent || '#2f5fa8' });
  const ratio = el('span', { className: 'hint' });
  const logo = el('input', { type: 'file', accept: '.svg,image/svg+xml' });
  let logoText = null;
  const preview = el('div', { id: 'preview' });
  const paint = () => {
    const c = color.value;
    const r = contrastWhite(c);
    ratio.textContent = `Contrast with white text: ${r.toFixed(2)}:1 — ${r >= 4.5 ? 'passes AA ✓' : 'too light: needs 4.5:1. Choose a darker colour.'}`;
    ratio.style.color = r >= 4.5 ? 'var(--ok)' : 'var(--danger)';
    preview.style.setProperty('--pv-accent', c);
    preview.style.setProperty('--pv-deep', S.preview.colors.deep);
  };
  color.oninput = paint;
  logo.onchange = async () => {
    const f = logo.files[0];
    if (!f) return;
    if (f.size > 64 * 1024) { errors.logo = 'logo file is too big (64 KB max)'; draw(); return; }
    logoText = await f.text();
  };
  const logoBox = el('div', { className: 'pvLogo' });
  logoBox.style.backgroundImage = `url("${S.preview.logoCssUrl}")`;
  const sf = D.safety || {};
  preview.append(
    el('div', { className: 'pvNav' }, logoBox, (D.org && D.org.name) || 'Your lifeline'),
    el('div', { className: 'pvBody' },
      el('div', { className: 'pvStrip' }, el('strong', { textContent: 'In immediate danger? ' }),
        sf.primaryNumber ? `Call ${sf.primaryNumber} (${sf.primaryLabel || 'emergency'}).` : 'Contact your local emergency services now.'),
      el('div', { className: 'pvCard' }, el('strong', { textContent: `Chat with ${(D.org && D.org.shortName) || 'us'}` }),
        el('div', { className: 'muted', textContent: 'You’ll talk with a trained support worker.' }),
        el('span', { className: 'pvBtn', textContent: 'Start chat' }))));
  put(body, el('h2', { textContent: 'Look' }),
    field('Main colour', color, { key: 'accent', hint: 'Buttons, links and the menu edge. Lighter and darker shades are worked out from it.' }), ratio,
    field('Logo (SVG)', logo, { key: 'logo', hint: 'Optional. Simple shapes only: scripts, links, images and text are removed. Leave empty to keep the current one.' }),
    el('h3', { textContent: 'Preview' }), preview,
    navButtons(() => save({ look: { accent: color.value, ...(logoText ? { logo: logoText } : {}) } }, nextOf('look'))));
  paint();
}

// 3 --------------------------------------------------------------------------
function drawSafety(body) {
  const s = D.safety || {};
  const phone = text(s.phone, { inputMode: 'tel', maxLength: 24 });
  const pNum = text(s.primaryNumber, { inputMode: 'tel', maxLength: 24 });
  const pLab = text(s.primaryLabel, { maxLength: 40 });
  const sNum = text(s.secondaryNumber, { inputMode: 'tel', maxLength: 24 });
  const sLab = text(s.secondaryLabel, { maxLength: 40 });
  const msg = el('textarea', { rows: 4, maxLength: 600, value: s.message || S.suggestedMessage });
  put(body, el('h2', { textContent: 'Safety numbers' }),
    el('p', { className: 'warnBox', textContent: 'Callers in crisis see these numbers on the chat page and in the message shown when nobody can answer. Check every digit with a second person against your published numbers.' }),
    field('Your helpline’s phone number', phone, { key: 'phone' }),
    el('div', { className: 'row2' },
      field('Emergency number', pNum, { key: 'primaryNumber', hint: 'e.g. 999, 112, 911, 119' }),
      field('…which is for', pLab, { key: 'primaryLabel', hint: 'e.g. ambulance/fire' })),
    el('div', { className: 'row2' },
      field('Second emergency number (optional)', sNum, { key: 'secondaryNumber' }),
      field('…which is for', sLab, { key: 'secondaryLabel', hint: 'e.g. police' })),
    field('Message when nobody can answer', msg, { key: 'message', hint: 'Shown to a caller who has waited a long time. Prefilled from the numbers; you can edit it.' }),
    el('p', { className: 'muted', textContent: 'Only needed if you turn on the helpline (caller chat) in the next step. Without these numbers the chat stays off.' }),
    navButtons(() => save({ safety: { phone: phone.value, primaryNumber: pNum.value, primaryLabel: pLab.value,
      secondaryNumber: sNum.value, secondaryLabel: sLab.value,
      message: msg.value.trim() === S.suggestedMessage ? '' : msg.value } }, nextOf('safety'))));
}

// 4 --------------------------------------------------------------------------
function drawModules(body) {
  const chosen = new Set(D.modules || []);
  const boxes = [
    ['schedule', 'Shift scheduler', 'Shifts, availability, cover requests, calendar feeds. No caller data — the usual first step.'],
    ['board', 'Noticeboard', 'Topics and posts for the team.'],
    ['helpline', 'Helpline (caller chat)', 'Callers chat with support workers; queue, intake records, reports. Needs the safety numbers.'],
    ...(S.env.voiceAvailable ? [['voice', 'Phone calls in the browser (preview)',
      'Calls ring in the same queue as chats and are answered in the console with a headset. Needs the helpline. Only a test provider exists so far — no real calls.']] : []),
  ].map(([k, label, hint]) => {
    const cb = el('input', { type: 'checkbox', checked: chosen.has(k) });
    cb.dataset.k = k;
    return el('label', { className: 'field', style: 'flex-direction:row;gap:8px;align-items:flex-start' }, cb,
      el('span', {}, el('strong', { textContent: label }), el('br'), el('span', { className: 'hint', textContent: hint })));
  });
  put(body, el('h2', { textContent: 'Modules' }),
    S.env.modulesFromEnv ? el('p', { className: 'warnBox', textContent: `This server sets TL_MODULES=${S.env.modulesFromEnv}; that wins over your choice here.` }) : null,
    ...boxes, errors.modules ? el('p', { className: 'err', textContent: errors.modules }) : null,
    navButtons(() => save({ modules: boxes.map((b) => b.querySelector('input')).filter((c) => c.checked).map((c) => c.dataset.k) },
      nextOf('modules'))));
}

// 4b -------------------------------------------------------------------------
function drawVoice(body) {
  if (!(D.modules || []).includes('voice')) {
    put(body, el('h2', { textContent: 'Phone calls' }),
      el('p', { className: 'muted', textContent: 'Phone calls are off, so there is nothing to set here.' }),
      navButtons(() => go(nextOf('voice')), 'Continue'));
    return;
  }
  const v = D.voice || {};
  const prov = el('select');
  for (const p of S.env.voiceProviders) prov.append(el('option', { value: p.name, textContent: p.label }));
  prov.value = v.provider || 'mock';
  const overflow = text(v.overflowNumber, { inputMode: 'tel', maxLength: 24 });
  const out = el('div', { className: 'hint' });
  const testBtn = el('button', { textContent: 'Make a test call' });
  testBtn.onclick = async () => {
    await api('save', { voice: { provider: prov.value, overflowNumber: overflow.value } });
    const r = await api('voice-test', {});
    out.textContent = r.ok ? `✓ ${r.data.events.join(' → ')}. A caller nobody answers would hear: “${r.data.message}”` : (r.data.error || 'Test failed.');
  };
  put(body, el('h2', { textContent: 'Phone calls' }),
    el('p', { className: 'warnBox', textContent: 'Preview: only the test provider is available. It simulates calls; no phone numbers, no audio, no cost.' }),
    field('Provider', prov, { key: 'provider' }),
    field('Overflow number (optional)', overflow, { key: 'overflowNumber',
      hint: 'If nobody answers in time, calls go here. Without one, the caller hears your “nobody can answer” message with the emergency numbers. A call is never left in silence.' }),
    el('p', { className: 'muted', textContent: 'Calls are not recorded. A coordinator can change that later; every change is logged.' }),
    el('div', {}, testBtn, out),
    navButtons(() => save({ voice: { provider: prov.value, overflowNumber: overflow.value } }, nextOf('voice'))));
}

// 5 --------------------------------------------------------------------------
function drawShifts(body) {
  if (!(D.modules || []).includes('schedule')) {
    put(body, el('h2', { textContent: 'Shifts' }),
      el('p', { className: 'muted', textContent: 'The shift scheduler is off, so there is nothing to set here.' }),
      navButtons(() => go(nextOf('shifts')), 'Continue'));
    return;
  }
  const sh = D.shifts || { rows: [] };
  let rows = (sh.rows || []).map((r) => [...r]);
  let weeks = sh.weekSeats ? JSON.parse(JSON.stringify(sh.weekSeats)) : {};
  const preset = el('select');
  preset.append(el('option', { value: '', textContent: 'Choose a preset…' }));
  for (const [k, p] of Object.entries(S.presets)) preset.append(el('option', { value: k, textContent: p.label }));
  const table = el('table', { className: 'grid' });
  const seatsTable = el('table', { className: 'grid' });
  const read = () => {
    rows = [...table.querySelectorAll('tr[data-i]')].map((tr) => {
      const [label, start, end, mode] = tr.querySelectorAll('input,select');
      return [label.value, start.value, end.value, mode.value];
    });
    weeks = {};
    for (const tr of seatsTable.querySelectorAll('tr[data-i]')) {
      weeks[Number(tr.dataset.i) + 1] = Object.fromEntries([...tr.querySelectorAll('input')].map((inp) => [inp.dataset.wd, Number(inp.value)]));
    }
  };
  const paint = () => {
    table.innerHTML = '';
    table.append(el('tr', {}, el('th', { textContent: '#' }), el('th', { textContent: 'Name' }), el('th', { textContent: 'From' }),
      el('th', { textContent: 'To' }), el('th', { textContent: 'Covers' }), el('th')));
    rows.forEach(([label, start, end, mode], i) => {
      const m = el('select');
      for (const [v, t] of MODES) m.append(el('option', { value: v, textContent: t }));
      m.value = mode || 'both';
      const rm = el('button', { textContent: '✕', title: 'Remove' });
      rm.onclick = () => {
        read();
        rows.splice(i, 1);
        // Seats are keyed by row number: move the rows below up one.
        const next = {};
        for (const [k, v] of Object.entries(weeks)) {
          const n = Number(k);
          if (n < i + 1) next[n] = v; else if (n > i + 1) next[n - 1] = v;
        }
        weeks = next;
        paint();
      };
      const tr = el('tr', {}, el('td', { textContent: `S${i + 1}` }), el('td', {}, text(label, { maxLength: 40 })),
        el('td', {}, el('input', { type: 'time', value: start })), el('td', {}, el('input', { type: 'time', value: end })),
        el('td', {}, m), el('td', {}, rm));
      tr.dataset.i = i;
      table.append(tr);
      if (errors[`row${i + 1}`]) table.append(el('tr', {}, el('td'), el('td', { colSpan: 5, className: 'err', textContent: errors[`row${i + 1}`] })));
    });
    seatsTable.innerHTML = '';
    seatsTable.append(el('tr', {}, el('th', { textContent: 'People per shift' }), ...WD.map(([, l]) => el('th', { textContent: l }))));
    rows.forEach((r, i) => {
      const w = weeks[i + 1] || {};
      const tr = el('tr', {}, el('td', { textContent: `S${i + 1} ${r[0] || ''}` }),
        ...WD.map(([wd]) => {
          const inp = el('input', { type: 'number', min: 0, max: 6, value: w[wd] ?? 1 });
          inp.dataset.wd = wd;
          return el('td', {}, inp);
        }));
      tr.dataset.i = i;
      seatsTable.append(tr);
      if (errors[`seats${i + 1}`]) seatsTable.append(el('tr', {}, el('td', { colSpan: 8, className: 'err', textContent: errors[`seats${i + 1}`] })));
    });
  };
  preset.onchange = () => {
    const p = S.presets[preset.value];
    if (!p) return;
    rows = p.rows.map((r) => [...r]);
    weeks = p.weekSeats ? JSON.parse(JSON.stringify(p.weekSeats)) : {};
    paint();
  };
  const add = el('button', { textContent: '+ Add a shift' });
  add.onclick = () => { read(); rows.push(['', '09:00', '13:00', 'both']); paint(); };
  paint();
  put(body, el('h2', { textContent: 'Shifts' }),
    field('Start from a pattern', preset, { hint: 'Then adjust the rows. Times are local times; a shift may run past midnight.' }),
    el('div', { style: 'overflow-x:auto' }, table), add, errors.rows ? el('p', { className: 'err', textContent: errors.rows }) : null,
    el('h3', { textContent: 'How many people each shift needs', style: 'margin-top:14px' }),
    el('p', { className: 'hint', textContent: '0 means the shift doesn’t run that day. Coordinators can change all of this later on the schedule page.' }),
    el('div', { style: 'overflow-x:auto' }, seatsTable),
    navButtons(() => { read(); return save({ shifts: { rows, weekSeats: weeks } }, nextOf('shifts')); }));
}

// 6 --------------------------------------------------------------------------
function drawEmail(body) {
  const e = D.email || {};
  const fromName = text(e.fromName, { maxLength: 60 });
  const to = el('input', { type: 'email', value: (D.account && D.account.email) || '', placeholder: 'you@example.org' });
  const send = el('button', { textContent: 'Send me a test email' });
  const status = el('span', { className: 'hint' });
  send.onclick = async () => {
    send.disabled = true;
    const r = await api('test-email', { to: to.value });
    send.disabled = false;
    status.textContent = r.ok ? 'Sent ✓ — check your inbox (and spam folder).' : (r.data.error || 'Failed.');
    if (r.ok) { const s = await api('state'); S = s.data; D = S.draft; }
  };
  put(body, el('h2', { textContent: 'Email' }),
    S.env.mailConfigured
      ? el('p', { className: 'okBox', textContent: `Email is set up on this server. Messages come from ${S.env.mailFrom}.` })
      : el('p', { className: 'warnBox', textContent: 'Email isn’t set up on this server yet (TL_SMTP_URL or TL_RESEND_API_KEY). Sign-in codes, shift reminders and cover requests need it. It’s set in the hosting environment, never here.' }),
    field('Sender name', fromName, { key: 'fromName', hint: 'The name people see on emails, e.g. "Harbour Lifeline".' }),
    S.env.mailConfigured ? el('div', { className: 'field' }, 'Test it', to, el('span', {}, send, ' ', status)) : null,
    e.testedAt ? el('p', { className: 'okBox', textContent: 'A test email was sent during setup ✓' }) : null,
    navButtons(() => save({ email: { fromName: fromName.value } }, nextOf('email'))));
}

// 7 --------------------------------------------------------------------------
function drawAccount(body) {
  const a = D.account || {};
  const name = text(a.name, { maxLength: 80 });
  const email = el('input', { type: 'email', value: a.email || '' });
  const totp = el('input', { type: 'checkbox', checked: !!a.totp });
  const qr = el('div', { id: 'qr' });
  const enrol = el('button', { textContent: 'Show the QR code' });
  enrol.onclick = async () => {
    const r = await api('totp', { email: email.value });
    if (!r.ok) { qr.textContent = r.data.error || 'Failed.'; return; }
    totp.checked = true; // the server now expects a code at Finish
    qr.innerHTML = '';
    qr.append(el('img', { src: r.data.qr, alt: 'Authenticator QR code' }),
      el('p', { className: 'hint', textContent: `Or type this key: ${r.data.secret}` }),
      el('p', { className: 'hint', textContent: 'You’ll enter a code from the app when you finish.' }));
  };
  put(body, el('h2', { textContent: 'Your account' }),
    el('p', { className: 'muted', textContent: 'You become the first coordinator. You set the password on the last step.' }),
    field('Your name', name, { key: 'name' }), field('Email', email, { key: 'email' }),
    el('label', { className: 'field', style: 'flex-direction:row;gap:8px' }, totp,
      'Use an authenticator app for sign-in (recommended)'),
    el('div', {}, enrol, qr),
    navButtons(() => save({ account: { name: name.value, email: email.value, totp: totp.checked } }, nextOf('account'))));
}

// 8 --------------------------------------------------------------------------
function drawReady(body) {
  const r = S.readiness;
  const list = el('ul', { className: 'checks' });
  for (const c of r.checks) {
    const li = el('li', {}, (c.ok ? '✅ ' : (c.optional ? '⚠️ ' : '❌ ')) + c.label + (c.optional && !c.ok ? ' (optional)' : ''));
    if (!c.ok && c.step) {
      const fix = el('a', { href: '#', textContent: ' — fix' });
      fix.onclick = (e) => { e.preventDefault(); go(c.step); };
      li.append(fix);
    }
    list.append(li);
  }
  const pw = el('input', { type: 'password', autocomplete: 'new-password' });
  const pw2 = el('input', { type: 'password', autocomplete: 'new-password' });
  const code = el('input', { type: 'text', inputMode: 'numeric', maxLength: 6, autocomplete: 'one-time-code' });
  const out = el('p', { className: 'err' });
  const finish = el('button', { className: 'primary', textContent: 'Finish setup' });
  finish.disabled = !r.ok;
  finish.onclick = async () => {
    if (pw.value.length < 10) { out.textContent = 'The password needs 10 or more characters.'; return; }
    if (pw.value !== pw2.value) { out.textContent = 'The two passwords don’t match.'; return; }
    finish.disabled = true;
    const res = await api('finish', { password: pw.value, totpCode: code.value.trim() });
    finish.disabled = false;
    if (!res.ok) { out.textContent = res.data.error || 'Setup could not finish.'; return; }
    done(res.data);
  };
  const sf = D.safety || {};
  const summary = el('div', { className: 'okBox' },
    el('strong', { textContent: 'Please check before you finish:' }), el('br'),
    `Name: ${(D.org && D.org.name) || '—'} · Time zone: ${(D.org && D.org.timezone) || '—'}`, el('br'),
    `Helpline phone: ${sf.phone || 'not set'} · Emergency: ${sf.primaryNumber ? `${sf.primaryNumber} (${sf.primaryLabel || ''})` : 'not set'}` +
      (sf.secondaryNumber ? ` · ${sf.secondaryNumber} (${sf.secondaryLabel || ''})` : ''), el('br'),
    `Modules: ${(D.modules || []).join(', ') || '—'}`, el('br'),
    `Your account: ${(D.account && D.account.email) || '—'}${D.account && D.account.totp ? ' with an authenticator app' : ''}`);
  put(body, el('h2', { textContent: 'Ready check' }), summary, list,
    field('Choose your password', pw, { hint: '10 or more characters.' }), field('Type it again', pw2),
    D.account && D.account.totp ? field('Code from your authenticator app', code) : null,
    out, el('div', { className: 'nav' }, el('button', { textContent: '← Back', onclick: () => go(prevOf('ready')) }), finish));
}

function done(result) {
  $('steps').innerHTML = '';
  const body = $('body');
  body.innerHTML = '';
  put(body, el('h2', { textContent: 'You’re set up ✓' }),
    el('p', { textContent: 'You are signed in as the first coordinator. Add your team on the Admin page.' }),
    result.rebuildRequested
      ? el('p', { className: 'okBox', textContent: 'The pages are being rebuilt with your name, colours and numbers; this takes a minute or two.' })
      : el('p', { className: 'muted', textContent: 'If your pages are built ahead of time (for example on Vercel), redeploy once so they show your name, colours and numbers. Until then the chat refuses to start from an out-of-date page.' }),
    el('p', {}, el('a', { href: 'admin.html', textContent: 'Admin →' }), ' · ',
      el('a', { href: 'schedule.html', textContent: 'Schedule →' }), ' · ',
      el('a', { href: '/api/admin/profile-export', textContent: 'Download these settings as a profile file' })));
}

load();
