'use strict';

const $ = (id) => document.getElementById(id);

let me = null;
let es = null;
const seenPages = new Set();
let active = null;         // worker's own chat
let observing = null;      // contactId a trainee is observing
let canned = [];
let saveTimer = null;
let reconnectDelay = 1000;
const pendingMsgs = new Map();
let intakeForm = null;     // current form definition {name, version, schema}
let intakeAnswers = {};    // field id → answer for the active chat

const post = (url, body) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
});

// ---------------------------------------------------------------------------
// Login + forced password change

// Two ways in: the default emails a one-time code (nothing to remember —
// what UAT volunteers use); "Use a password instead" is the classic form.
let loginMode = 'code';   // 'code' | 'pw'
let codeSent = false;

function drawLoginMode() {
  $('codeRow').style.display = loginMode === 'code' && codeSent ? 'block' : 'none';
  $('pwRow').style.display = loginMode === 'pw' ? 'block' : 'none';
  $('resendLink').style.display = loginMode === 'code' && codeSent ? 'inline' : 'none';
  $('modeLink').textContent = loginMode === 'code'
    ? 'Use a password instead' : 'Email me a code instead';
  $('loginBtn').textContent = loginMode === 'pw' ? 'Log in'
    : (codeSent ? 'Sign in' : 'Email me a code');
}

async function requestCode() {
  $('loginErr').textContent = ''; $('loginInfo').style.display = 'none';
  const email = $('loginEmail').value.trim();
  if (!email) { $('loginErr').textContent = 'Enter your email first.'; return; }
  const res = await post('/api/login/code', { email });
  const data = await res.json().catch(() => ({}));
  if (res.status === 503) {  // no mail configured on this server
    loginMode = 'pw'; drawLoginMode();
    $('loginErr').textContent = data.error || 'Email sign-in unavailable — use your password.';
    return;
  }
  if (!res.ok) { $('loginErr').textContent = data.error || 'Could not send a code.'; return; }
  codeSent = true; drawLoginMode();
  $('loginInfo').style.display = 'block';
  $('loginInfo').textContent =
    'If that address has an account, a 6-digit code is on its way. It lasts 10 minutes.';
  $('loginCode').value = '';
  $('loginCode').focus();
}

async function submitLogin() {
  $('loginErr').textContent = '';
  const email = $('loginEmail').value.trim();
  const totp = $('loginTotp').value.trim() || undefined;
  const res = loginMode === 'pw'
    ? await post('/api/login', { email, password: $('loginPw').value, totp })
    : await post('/api/login/code/verify', { email, code: $('loginCode').value.trim(), totp });
  const data = await res.json().catch(() => ({}));
  if (res.ok) return boot(data);
  if (data.totpRequired) {
    $('totpRow').style.display = 'block';
    $('loginTotp').focus();
    $('loginErr').textContent = 'Enter the 6-digit code from your authenticator app.';
  } else {
    $('loginErr').textContent = data.error || 'Login failed.';
  }
}

$('loginBtn').onclick = () =>
  (loginMode === 'code' && !codeSent ? requestCode() : submitLogin());
$('modeLink').onclick = (e) => {
  e.preventDefault();
  loginMode = loginMode === 'code' ? 'pw' : 'code';
  $('loginErr').textContent = ''; $('loginInfo').style.display = 'none';
  $('totpRow').style.display = 'none';
  drawLoginMode();
  (loginMode === 'pw' ? $('loginPw') : (codeSent ? $('loginCode') : $('loginEmail'))).focus();
};
$('resendLink').onclick = (e) => { e.preventDefault(); requestCode(); };
drawLoginMode();
['loginEmail', 'loginCode', 'loginPw', 'loginTotp'].forEach((id) =>
  $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') $('loginBtn').click(); }));

$('changePwBtn').onclick = async () => {
  if ($('newPw').value !== $('newPw2').value) {
    $('changePwErr').textContent = 'Passwords do not match.'; return;
  }
  const res = await post('/api/password', { next: $('newPw').value });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { $('changePwErr').textContent = data.error || 'Failed.'; return; }
  location.reload();
};

(async () => {
  const res = await fetch('/api/me');
  if (res.ok) return boot(await res.json());
  const body = await res.json().catch(() => ({}));
  // The UAT gate answers before login does — collect the team passcode first.
  if (body.passcode) { location.href = 'passcode.html?next=console.html'; return; }
  const setup = await (await fetch('/api/setup-needed')).json().catch(() => ({}));
  if (setup.needed) $('setupHint').style.display = 'block';
})();

async function boot(user) {
  me = user;
  if (me.mustChangePw) {
    $('loginForm').style.display = 'none';
    $('changePwForm').style.display = 'flex';
    $('loginOverlay').style.display = 'flex';
    return;
  }
  // Scheduler-only installations: the console is just the way in.
  // (The login response doesn't carry the module list; /api/me does.)
  const mods = me.modules ||
    (await (await fetch('/api/modules')).json().catch(() => ({}))).modules;
  if (mods && !mods.includes('helpline')) {
    location.replace(mods.includes('schedule') ? 'schedule.html' : 'profile.html');
    return;
  }
  $('loginOverlay').style.display = 'none';
  // The shared side menu (nav.js) shows who is signed in and the pages their
  // role can reach; after an in-page login it needs to look again.
  if (window.tellNav) window.tellNav.refresh();
  if (me.role === 'trainee') applyTraineeMode();
  setStatusUI(me.status || 'off');
  canned = await (await fetch('/api/canned')).json();
  if (me.role !== 'trainee') {
    await resumeMyChats();
    loadFollowups();
    loadMyFeedback();
  }
  loadActiveDirectives();
  loadBoardUnread();
  connectStream();
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function applyTraineeMode() {
  $('statusSeg').style.display = 'none';
  $('helpBtn').style.display = 'none';
  $('observeBanner').style.display = 'block';
  $('observeBanner').textContent =
    'Trainee mode — you observe chats read-only when a worker invites you.';
}

// ---------------------------------------------------------------------------
// Resizable caller-record column (width remembered per browser)

(() => {
  const root = document.documentElement;
  try {
    const saved = localStorage.getItem('tellRecordW');
    if (saved) root.style.setProperty('--recordW', saved + 'px');
  } catch { /* private mode */ }
  const handle = $('recordResize');
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.classList.add('dragging');
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = $('recordCol').getBoundingClientRect().width;
    const move = (ev) => {
      const w = Math.min(Math.max(startW + (startX - ev.clientX), 280),
        window.innerWidth * 0.6);
      root.style.setProperty('--recordW', w + 'px');
    };
    const up = () => {
      handle.classList.remove('dragging');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      const w = Math.round($('recordCol').getBoundingClientRect().width);
      try { localStorage.setItem('tellRecordW', String(w)); } catch { /* ignore */ }
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
})();

// ---------------------------------------------------------------------------
// Status

document.querySelectorAll('#statusSeg button').forEach((b) => {
  b.onclick = async () => {
    const res = await post('/api/status', { status: b.dataset.status });
    if (res.ok) setStatusUI(b.dataset.status);
  };
});
function setStatusUI(status) {
  document.querySelectorAll('#statusSeg button').forEach((b) =>
    b.classList.toggle('active', b.dataset.status === status));
}

// ---------------------------------------------------------------------------
// Event stream (SSE down, POST up)

function connectStream() {
  es = new EventSource('/api/worker/stream');
  es.onopen = () => {
    reconnectDelay = 1000;
    flushPending();
  };
  es.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'queue') {
      renderQueue(msg.waiting);
      renderOnCall(msg.onCall);
    } else if (msg.type === 'message') {
      const relevant = (active && msg.contactId === active.contactId) ||
        (observing && msg.contactId === observing);
      if (!relevant) return;
      if (msg.sender === 'worker' && msg.client_msg_id && pendingMsgs.has(msg.client_msg_id)) return;
      addBubble(msg.sender, msg.body, msg.id);
      // The caller pressing "Leave chat" ends the contact server-side; treat
      // it like our own End chat so the intake-then-clear flow takes over.
      if (msg.sender === 'system' && active && msg.contactId === active.contactId &&
          msg.body === 'The caller left the chat.') {
        active.ended = true;
        addBubble('system', 'Finish the intake, then submit.');
      }
    } else if (msg.type === 'page') {
      if (!seenPages.has(msg.contactId)) {
        seenPages.add(msg.contactId);
        showPage(msg);
      }
    } else if (msg.type === 'help') {
      notifyBrowser('Help requested', `${msg.from}: ${msg.note || 'needs assistance'}`);
    } else if (msg.type === 'caller_disconnected' && active && msg.contactId === active.contactId) {
      addBubble('system', 'The caller seems to have disconnected. You can still finish and submit the intake.');
    } else if (msg.type === 'observe_start') {
      if (me.role === 'trainee') startObserving(msg);
    }
  };
  es.onerror = () => {
    es.close();
    setTimeout(connectStream, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  };
}

let flushing = false;
async function flushPending() {
  if (flushing) return;
  flushing = true;
  try {
    for (const [clientMsgId, m] of [...pendingMsgs]) {
      const res = await post('/api/worker/message',
        { contactId: m.contactId, body: m.body, clientMsgId });
      if (res.ok) {
        const data = await res.json();
        const el = document.querySelector(`[data-client-id="${clientMsgId}"]`);
        if (el) { el.classList.remove('pending'); el.dataset.msgId = data.id; }
        pendingMsgs.delete(clientMsgId);
      } else break;
    }
  } catch { /* offline — retried below */ }
  flushing = false;
}
setInterval(flushPending, 4000);

function notifyBrowser(title, body) {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body });
  }
}

// ---------------------------------------------------------------------------
// On-call supervisor chip

function renderOnCall(onCall) {
  const chip = $('onCallChip');
  if (!onCall) { chip.style.display = 'none'; return; }
  chip.style.display = 'inline-block';
  chip.textContent = '';
  chip.appendChild(document.createTextNode('On call: ' + onCall.name + ' '));
  if (onCall.phone) {
    const a = document.createElement('a');
    a.href = 'tel:' + onCall.phone;
    a.textContent = onCall.phone;
    chip.appendChild(a);
  }
}

// ---------------------------------------------------------------------------
// Queue rendering + paging banner

function renderQueue(waiting) {
  $('tabQueueN').textContent = waiting.length ? String(waiting.length) : '';
  const box = $('queueList');
  box.innerHTML = '';
  if (!waiting.length) {
    box.innerHTML = '<p class="muted">No one is waiting.</p>';
    return;
  }
  for (const c of waiting) {
    const div = document.createElement('div');
    div.className = 'queueItem' + (c.paged ? ' paged' : '');
    const name = c.alias || 'Anonymous';
    const repeat = c.priorContacts > 0 ? ` · returning (${c.priorContacts})` : '';
    const pri = c.priority > 0 ? ' <span class="badge danger">risk indicated</span>' : '';
    div.innerHTML =
      `<div><strong></strong>${pri}</div>
       <div class="muted"></div>
       <div class="muted">waiting <span class="wait" data-queued="${c.queuedAt}">0:00</span></div>`;
    div.querySelector('strong').textContent = name;
    div.querySelectorAll('.muted')[0].textContent =
      (c.triage.concern || 'No concern given') + repeat;
    if (me.role !== 'trainee') {
      const btn = document.createElement('button');
      btn.className = 'primary';
      btn.style.cssText = 'margin-top:6px;width:100%';
      btn.textContent = 'Accept';
      btn.onclick = () => acceptChat(c.contactId);
      div.appendChild(btn);
    }
    box.appendChild(div);
  }
}

setInterval(() => {
  document.querySelectorAll('.wait[data-queued]').forEach((el) => {
    const s = Math.max(0, Math.round((Date.now() - Date.parse(el.dataset.queued)) / 1000));
    el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  });
}, 1000);

function showPage(msg) {
  notifyBrowser('{{shortName}}: caller waiting', 'A caller needs support — can you jump on?');
  const banner = $('pageBanner');
  banner.textContent = '🔔 A caller is waiting and needs backup — click to accept';
  banner.style.display = 'block';
  banner.onclick = async () => {
    banner.style.display = 'none';
    await post('/api/status', { status: 'on_shift' });
    setStatusUI('on_shift');
    acceptChat(msg.contactId);
  };
}

// ---------------------------------------------------------------------------
// Chat

async function acceptChat(contactId) {
  if (active && active.channel === 'phone') {
    alert('Finish (submit) or discard your phone intake before accepting a chat.');
    return;
  }
  const res = await fetch('/api/claim/' + contactId, { method: 'POST' });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    alert(e.error === 'already claimed or gone'
      ? 'Someone else already took this chat (or the caller left).'
      : 'Could not accept — you may already have an active chat, or you are not in this program.');
    return;
  }
  openChat(await res.json());
}

async function resumeMyChats() {
  const chats = await (await fetch('/api/my-chats')).json();
  if (chats.length) {
    const c = chats.find((x) => x.channel !== 'phone') || chats[0];
    openChat({ ...c, history: [], queueWaitSecs: null });
  }
}

// Phones show one column at a time (Waiting / Chat / Caller & intake).
function setTab(name) {
  document.querySelector('main').dataset.tab = name;
  for (const b of document.querySelectorAll('#mobileTabs button')) {
    b.classList.toggle('on', b.dataset.tab === name);
  }
}
for (const b of document.querySelectorAll('#mobileTabs button')) {
  b.onclick = () => setTab(b.dataset.tab);
}
setTab('queue');

function openChat(data) {
  if (data.channel === 'phone') { openPhoneIntake(data); setTab('record'); return; }
  setTab('chat');
  active = data;
  observing = null;
  $('msgs').innerHTML = '';
  $('composerWrap').style.display = 'block';
  $('observeCtl').style.display = 'block';
  $('inviteObserverBtn').style.display = '';
  $('chatHead').innerHTML = '';
  const strong = document.createElement('strong');
  strong.textContent = data.alias || 'Anonymous';
  $('chatHead').appendChild(strong);
  if (data.queueWaitSecs != null) {
    const b = document.createElement('span');
    b.className = 'badge';
    b.textContent = `waited ${data.queueWaitSecs}s`;
    $('chatHead').appendChild(b);
  }
  for (const m of data.messages || []) addBubble(m.sender, m.body, m.id);
  renderCallerRecord(data);
  renderMyChat();
  $('input').focus();
}

// Phone shifts: the same workspace with no chat — the intake starts blank
// (no pre-chat survey to prefill from), referrals and directives work as
// usual, and submitting the intake finishes the call.
function openPhoneIntake(data) {
  active = { ...data, ended: {{#features.voice}}!data.voice{{/features.voice}}{{^features.voice}}true{{/features.voice}} };
  observing = null;
  $('msgs').innerHTML = '';
  $('composerWrap').style.display = 'none';
  $('observeCtl').style.display = 'block';
  $('inviteObserverBtn').style.display = 'none';
  const head = $('chatHead');
  head.innerHTML = '';
  const strong = document.createElement('strong');
  strong.textContent = '📞 Phone call';
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = 'intake only';
  const discard = document.createElement('button');
  discard.textContent = 'Discard';
  discard.style.cssText = 'margin-left:auto;font-size:13px;padding:3px 10px';
  discard.title = 'Started this by mistake? Throw it away.';
  discard.onclick = discardPhoneIntake;
{{#features.voice}}  if (data.voice) discard.hidden = true; // a call's contact can't be discarded
{{/features.voice}}  head.append(strong, badge, discard);
  addBubble('system', 'Phone call: fill in the intake on the right as you go, ' +
    'then press Submit intake when the call ends.');
  renderCallerRecord(data);
  renderMyChat();
}

$('phoneBtn').onclick = async () => {
{{#features.voice}}  if (active && active.voice && !active.ended) {
    alert('You are on a call. Hang up before starting a phone intake.');
    return;
  }
{{/features.voice}}  if (active && active.channel !== 'phone') {
    alert('You have a chat open. End it and submit its intake before starting a phone intake.');
    return;
  }
  const res = await fetch('/api/phone-intake', { method: 'POST' });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) { toast((data && data.error) || 'Could not start a phone intake.', true); return; }
  openChat(data);
};

async function discardPhoneIntake() {
  if (!active || active.channel !== 'phone') return;
  if (!confirm('Discard this phone intake? Nothing in it is kept.')) return;
  clearTimeout(saveTimer);
  const res = await fetch('/api/phone-intake/' + active.contactId, { method: 'DELETE' });
  if (!res.ok) { toast('Could not discard it — try again.', true); return; }
  clearWorkspace();
  toast('Phone intake discarded.');
}

let toastTimer = null;
function toast(text, bad = false) {
  const t = $('toast');
  t.textContent = text;
  t.className = bad ? 'bad' : '';
  t.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.style.display = 'none'; }, bad ? 6000 : 3500);
}

function startObserving(msg) {
  observing = msg.contactId;
  active = null;
  $('msgs').innerHTML = '';
  $('composerWrap').style.display = 'none';
  $('chatHead').innerHTML = '<strong>Observing chat (read-only)</strong>';
  for (const m of msg.messages || []) addBubble(m.sender, m.body, m.id);
  notifyBrowser('{{shortName}}: observation started', 'You have been invited to observe a chat.');
}

function renderMyChat() {
  $('myChats').innerHTML = '';
  if (!active) { $('myChats').innerHTML = '<p class="muted">None active.</p>'; return; }
  const div = document.createElement('div');
  div.innerHTML = `<strong></strong> <span class="badge ok"></span>`;
  div.querySelector('strong').textContent = active.alias || 'Anonymous';
  div.querySelector('.badge').textContent = active.channel === 'phone' ? 'phone' : 'active';
  $('myChats').appendChild(div);
}

function addBubble(sender, body, id) {
  if (id && document.querySelector(`[data-msg-id="${id}"]`)) return null;
  const el = document.createElement('div');
  el.className = 'msg ' + sender;
  el.textContent = body;
  if (id) el.dataset.msgId = id;
  $('msgs').appendChild(el);
  $('msgs').scrollTop = $('msgs').scrollHeight;
  return el;
}

function sendMessage() {
  const body = $('input').value.trim();
  if (!body || !active) return;
  $('input').value = '';
  hideCanned();
  const clientMsgId = crypto.randomUUID();
  const el = addBubble('worker', body);
  el.classList.add('pending');
  el.dataset.clientId = clientMsgId;
  pendingMsgs.set(clientMsgId, { contactId: active.contactId, body });
  flushPending();
}

$('sendBtn').onclick = sendMessage;

$('endBtn').onclick = async () => {
  if (!active) return;
  if (!confirm('End this chat? The caller will be told the chat has ended.')) return;
  await fetch('/api/end/' + active.contactId, { method: 'POST' });
  active.ended = true;
  addBubble('system', 'Chat ended. Finish the intake, then submit.');
  setTab('record');
};

$('inviteObserverBtn').onclick = async () => {
  if (!active) return;
  const trainees = await (await fetch('/api/observers/online')).json();
  if (!trainees.length) { alert('No trainees are online right now.'); return; }
  const names = trainees.map((t, i) => `${i + 1}. ${t.name}`).join('\n');
  const pick = prompt('Invite which trainee to observe (read-only)?\n' + names, '1');
  const t = trainees[Number(pick) - 1];
  if (!t) return;
  const res = await post('/api/observe/' + active.contactId, { traineeId: t.id });
  if (res.ok) addBubble('system', `${t.name} is now observing this chat (the caller is not told).`);
};

// ---------------------------------------------------------------------------
// Canned responses ("/" opens the picker)

let cannedSel = 0;
function showCanned(filter) {
  const pop = $('cannedPop');
  const items = canned.filter((c) =>
    (c.label + ' ' + c.body).toLowerCase().includes(filter.toLowerCase()));
  pop.innerHTML = '';
  cannedSel = Math.max(0, Math.min(cannedSel, items.length - 1));
  items.forEach((c, i) => {
    const div = document.createElement('div');
    div.className = 'item' + (i === cannedSel ? ' sel' : '');
    div.innerHTML = `<strong></strong> <span class="muted"></span>`;
    div.querySelector('strong').textContent = c.label + (c.shared ? '' : ' (mine)');
    div.querySelector('.muted').textContent = c.body.slice(0, 70);
    div.onclick = () => insertCanned(c);
    pop.appendChild(div);
  });
  // Always say where they come from, so an empty list isn't a dead end.
  const foot = document.createElement('div');
  foot.className = 'item manage muted';
  foot.innerHTML = '<a href="canned.html" target="_blank" rel="noopener"></a>';
  foot.querySelector('a').textContent = !canned.length
    ? 'No canned responses yet — add some (opens in a new tab)'
    : items.length ? 'Add or edit canned responses…' : 'No match — add or edit canned responses…';
  pop.appendChild(foot);
  pop.style.display = 'block';
  pop.dataset.items = JSON.stringify(items.map((c) => c.id));
}
// Pick up responses added in another tab when the worker comes back.
async function reloadCanned() {
  const res = await fetch('/api/canned').catch(() => null);
  if (res && res.ok) canned = await res.json();
}
window.addEventListener('focus', reloadCanned);
function hideCanned() { $('cannedPop').style.display = 'none'; cannedSel = 0; }
function insertCanned(c) {
  $('input').value = c.body;
  hideCanned();
  $('input').focus();
}

$('input').addEventListener('input', () => {
  const v = $('input').value;
  if (v.startsWith('/')) showCanned(v.slice(1));
  else hideCanned();
});
$('input').addEventListener('keydown', (e) => {
  const pop = $('cannedPop');
  if (pop.style.display === 'block') {
    const ids = JSON.parse(pop.dataset.items || '[]');
    if (e.key === 'ArrowDown') { e.preventDefault(); cannedSel = Math.max(0, Math.min(cannedSel + 1, ids.length - 1)); showCanned($('input').value.slice(1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); cannedSel = Math.max(cannedSel - 1, 0); showCanned($('input').value.slice(1)); return; }
    if (e.key === 'Enter' && ids.length) { e.preventDefault(); insertCanned(canned.find((c) => c.id === ids[cannedSel])); return; }
    if (e.key === 'Escape') { hideCanned(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

// ---------------------------------------------------------------------------
// Caller record: directives, contacts-today, previous referrals

function renderCallerRecord(data) {
  const info = $('callerInfo');
  info.innerHTML = '';
  const rows = [
    ['Alias', data.alias || 'Anonymous'],
    ['Previous contacts', String((data.history || []).length)],
    ['Contacts today', String(data.contactsToday || 1)],
    ...(data.prechat || []),
  ];
  for (const [k, v] of rows) {
    const p = document.createElement('p');
    p.innerHTML = `<span class="muted"></span> `;
    p.querySelector('span').textContent = k + ': ';
    p.appendChild(document.createTextNode(v));
    info.appendChild(p);
  }
  renderDirectives(data.directives || []);
  if (me.role === 'supervisor' || me.role === 'coordinator') {
    $('directiveCtl').style.display = 'block';
  }
  renderReferrals(data.referrals || [], data.previousReferrals || []);
  renderIntake(data);
}

function renderDirectives(directives) {
  const box = $('directivesList');
  box.innerHTML = '';
  for (const d of directives) {
    const div = document.createElement('div');
    div.className = 'directive ' + d.alertLevel;
    const lvl = document.createElement('div');
    lvl.className = 'lvl';
    lvl.textContent = d.alertLevel;
    const body = document.createElement('div');
    body.textContent = d.body;
    div.appendChild(lvl);
    div.appendChild(body);
    if (me.role === 'supervisor' || me.role === 'coordinator') {
      const btn = document.createElement('button');
      btn.textContent = 'Retire';
      btn.style.cssText = 'margin-top:4px;font-size:12px;padding:2px 8px';
      btn.onclick = async () => {
        if (!confirm('Retire this directive? It stays in the record but stops showing.')) return;
        await post('/api/directives/' + d.id + '/retire');
        div.remove();
      };
      div.appendChild(btn);
    }
    box.appendChild(div);
  }
}

$('addDirectiveBtn').onclick = async () => {
  if (!active || !active.callerId) return;
  const body = prompt('Directive text (what should workers know before talking to this caller?)');
  if (!body) return;
  const level = prompt('Alert level: info, caution, or alert', 'info');
  if (!['info', 'caution', 'alert'].includes(level)) { alert('Bad level.'); return; }
  const res = await post('/api/directives',
    { callerId: active.callerId, alertLevel: level, body });
  if (res.ok) {
    const d = await res.json();
    active.directives = [...(active.directives || []),
      { id: d.id, alertLevel: level, body }];
    renderDirectives(active.directives);
  }
};

// ---------------------------------------------------------------------------
// Referrals

function renderReferrals(current, previous) {
  $('referralsWrap').style.display = 'block';
  const sel = $('refSelected');
  sel.innerHTML = current.length ? '' : '<span class="muted">None yet.</span>';
  for (const r of current) {
    const b = document.createElement('span');
    b.className = 'badge ok';
    b.textContent = r.name + ' ✕';
    b.style.cursor = 'pointer';
    b.title = 'Remove this referral';
    b.onclick = async () => {
      await fetch('/api/referral', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId: active.contactId, resourceId: r.id }),
      });
      active.referrals = active.referrals.filter((x) => x.id !== r.id);
      renderReferrals(active.referrals, active.previousReferrals || []);
    };
    sel.appendChild(b);
  }
  const prev = $('prevReferrals');
  prev.innerHTML = '';
  if (previous.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.style.cssText = 'font-size:12px;margin-top:6px';
    p.textContent = 'Previously referred: ' +
      [...new Set(previous.map((r) => r.name))].join(', ');
    prev.appendChild(p);
  }
}

let refTimer = null;
$('refSearch').addEventListener('input', () => {
  clearTimeout(refTimer);
  const q = $('refSearch').value.trim();
  if (!q) { $('refResults').style.display = 'none'; return; }
  refTimer = setTimeout(async () => {
    const rows = await (await fetch('/api/resources?q=' + encodeURIComponent(q))).json();
    const box = $('refResults');
    box.innerHTML = '';
    box.style.display = rows.length ? 'block' : 'none';
    for (const r of rows.slice(0, 12)) {
      const div = document.createElement('div');
      div.className = 'item';
      div.textContent = r.name + (r.category ? ` — ${r.category}` : '');
      div.onclick = async () => {
        if (!active) return;
        const res = await post('/api/referral',
          { contactId: active.contactId, resourceId: r.id });
        if (res.ok) {
          if (!(active.referrals || []).some((x) => x.id === r.id)) {
            active.referrals = [...(active.referrals || []), { id: r.id, name: r.name }];
          }
          renderReferrals(active.referrals, active.previousReferrals || []);
          $('refSearch').value = '';
          box.style.display = 'none';
        }
      };
      box.appendChild(div);
    }
  }, 250);
});

// ---------------------------------------------------------------------------
// Dynamic intake (rendered from the versioned form definition)

function fieldVisible(f) {
  if (!f.show_if) return true;
  return Object.entries(f.show_if).every(([dep, val]) => intakeAnswers[dep] === val);
}

function renderIntake(data) {
  intakeForm = data.form || intakeForm;
  const stored = data.intake || {};
  intakeAnswers = stored.answers ? { ...stored.answers } : {};
  prefillFromTriage(data.triage || {});
  $('intakeForm').style.display = 'flex';
  $('intakeAnonNote').style.display = 'block';
  setSaveState(data.intakeStatus === 'submitted' ? 'submitted' : '',
    data.intakeStatus === 'submitted' ? 'saved' : '');
  drawIntakeFields();
}

// Carry pre-chat answers into a still-blank intake so the worker corrects
// rather than retypes. Matching is by field id (the survey and the intake
// share ids for age, gender_identity, nationality), plus the explicit
// main_concern → main_concerns bridge (their option ids are shared too).
// Legacy {concern} triage falls back to a label match via f.prefill.
function prefillFromTriage(triage) {
  if (!intakeForm) return;
  const pre = (triage && triage.answers) || {};
  for (const s of intakeForm.schema.sections) {
    for (const f of s.fields) {
      if (intakeAnswers[f.id] !== undefined) continue;
      let src = pre[f.id];
      if (src === undefined && f.id === 'main_concerns') src = pre.main_concern;
      if (src !== undefined) {
        const ids = (f.options || []).map((o) => o.id);
        if (f.type === 'checkboxes') {
          const vals = (Array.isArray(src) ? src : [src]).filter((v) => ids.includes(v));
          if (vals.length) intakeAnswers[f.id] = vals;
        } else if (Array.isArray(src)) {
          const v = src.find((x) => ids.includes(x) && x !== 'no_answer') ||
            src.find((x) => ids.includes(x));
          if (v) intakeAnswers[f.id] = v;
        } else if (!ids.length || ids.includes(src)) {
          intakeAnswers[f.id] = src;
        }
        if (pre[f.id + '_other'] && f.other_text) {
          intakeAnswers[f.id + '_other'] = pre[f.id + '_other'];
        }
        continue;
      }
      // Legacy widget shape ({concern: 'Anxiety or stress'}).
      if (f.prefill && triage) {
        const key = f.prefill.replace(/^triage\./, '');
        const val = triage[key];
        if (!val) continue;
        const match = (f.options || []).find((o) =>
          o.label.toLowerCase().includes(String(val).toLowerCase().split(' ')[0]));
        if (match) intakeAnswers[f.id] = f.type === 'checkboxes' ? [match.id] : match.id;
      }
    }
  }
}

function drawIntakeFields() {
  const box = $('intakeFields');
  box.innerHTML = '';
  if (!intakeForm) return;
  for (const section of intakeForm.schema.sections) {
    const fields = section.fields.filter((f) => !f.retired && fieldVisible(f));
    if (!fields.length) continue;
    if (section.title) {
      const t = document.createElement('div');
      t.className = 'sectionTitle';
      t.textContent = section.title;
      box.appendChild(t);
    }
    for (const f of fields) box.appendChild(drawField(f));
  }
}

function drawField(f) {
  const wrap = document.createElement('fieldset');
  const label = document.createElement('div');
  label.className = 'flabel';
  label.textContent = f.label || f.id;
  if (f.required) {
    const r = document.createElement('span');
    r.className = 'req';
    r.textContent = ' *';
    label.appendChild(r);
  }
  wrap.appendChild(label);
  const options = (f.options || []).filter((o) =>
    !o.retired || valueUses(f, o.id));
  const set = (val) => { intakeAnswers[f.id] = val; scheduleSave(); redrawIfBranch(f); };

  if (f.type === 'select') {
    const sel = document.createElement('select');
    sel.appendChild(new Option('(select one)', ''));
    for (const o of options) sel.appendChild(new Option(o.label, o.id));
    sel.value = intakeAnswers[f.id] || '';
    sel.onchange = () => set(sel.value || undefined);
    wrap.appendChild(sel);
  } else if (f.type === 'radio') {
    const box = document.createElement('div');
    box.className = 'checks';
    for (const o of options) {
      const l = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'f_' + f.id;
      input.checked = intakeAnswers[f.id] === o.id;
      input.onchange = () => set(o.id);
      l.appendChild(input);
      l.appendChild(document.createTextNode(o.label));
      box.appendChild(l);
    }
    wrap.appendChild(box);
    if (f.other_text) wrap.appendChild(otherText(f));
  } else if (f.type === 'checkboxes') {
    const box = document.createElement('div');
    box.className = 'checks';
    for (const o of options) {
      const l = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = (intakeAnswers[f.id] || []).includes(o.id);
      input.onchange = () => {
        const cur = new Set(intakeAnswers[f.id] || []);
        input.checked ? cur.add(o.id) : cur.delete(o.id);
        set([...cur]);
      };
      l.appendChild(input);
      l.appendChild(document.createTextNode(o.label));
      box.appendChild(l);
    }
    wrap.appendChild(box);
  } else if (f.type === 'checkbox') {
    const l = document.createElement('label');
    l.style.fontWeight = '400';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = intakeAnswers[f.id] === true;
    input.onchange = () => set(input.checked ? true : undefined);
    l.appendChild(input);
    l.appendChild(document.createTextNode(' ' + (f.label || '')));
    wrap.innerHTML = '';
    wrap.appendChild(l);
  } else if (f.type === 'textarea') {
    const ta = document.createElement('textarea');
    ta.rows = 4;
    ta.value = intakeAnswers[f.id] || '';
    ta.oninput = () => { intakeAnswers[f.id] = ta.value || undefined; scheduleSave(); };
    wrap.appendChild(ta);
  } else {
    const input = document.createElement('input');
    input.value = intakeAnswers[f.id] || '';
    input.oninput = () => { intakeAnswers[f.id] = input.value || undefined; scheduleSave(); };
    wrap.appendChild(input);
  }
  return wrap;
}

function otherText(f) {
  const input = document.createElement('input');
  input.placeholder = 'If not listed, share here';
  input.value = intakeAnswers[f.id + '_other'] || '';
  input.oninput = () => {
    intakeAnswers[f.id + '_other'] = input.value || undefined;
    scheduleSave();
  };
  return input;
}

function valueUses(f, optId) {
  const v = intakeAnswers[f.id];
  return Array.isArray(v) ? v.includes(optId) : v === optId;
}

// Branching (the suicide ladder): when an answer changes, fields whose
// show_if depends on it may appear or disappear — and answers on rungs that
// are no longer reachable are cleared, so "not reached" is never recorded.
function redrawIfBranch(f) {
  if (!intakeForm) return;
  const dependents = [];
  for (const s of intakeForm.schema.sections) {
    for (const g of s.fields) {
      if (g.show_if && Object.keys(g.show_if).includes(f.id)) dependents.push(g);
    }
  }
  if (!dependents.length) return;
  let cleared = false;
  const clearDown = (field) => {
    for (const s of intakeForm.schema.sections) {
      for (const g of s.fields) {
        if (g.show_if && Object.keys(g.show_if).includes(field.id) && !fieldVisible(g)) {
          if (intakeAnswers[g.id] !== undefined) {
            delete intakeAnswers[g.id];
            cleared = true;
          }
          clearDown(g);
        }
      }
    }
  };
  clearDown(f);
  if (cleared) scheduleSave();
  drawIntakeFields();
}

function collectIntake() {
  const answers = {};
  for (const [k, v] of Object.entries(intakeAnswers)) {
    if (v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)) answers[k] = v;
  }
  return {
    form: intakeForm ? intakeForm.name : 'chat_intake',
    version: intakeForm ? intakeForm.version : 1,
    answers,
  };
}

function missingRequired() {
  if (!intakeForm) return [];
  const missing = [];
  for (const s of intakeForm.schema.sections) {
    for (const f of s.fields) {
      if (!f.required || f.retired || !fieldVisible(f)) continue;
      const v = intakeAnswers[f.id];
      if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) {
        missing.push(f.label || f.id);
      }
    }
  }
  return missing;
}

const hhmm = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function setSaveState(text, cls) {
  const el = $('saveState');
  el.textContent = text;
  el.className = cls || '';
}

// Autosave: 0.8s after the last change, and again every 5s while a save is
// failing, so a dropped connection never silently loses the intake.
function scheduleSave(delay = 800, retrying = false) {
  if (!active) return;
  const contactId = active.contactId;
  // A retry keeps the red "not saved" badge up until a save gets through.
  if (!retrying) setSaveState('saving…', 'saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const res = await fetch('/api/intake/' + contactId, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intake: collectIntake() }),
    }).catch(() => null);
    if (!active || active.contactId !== contactId) return;
    if (res && res.ok) {
      setSaveState(`draft saved ${hhmm()}`, 'saved');
    } else {
      setSaveState('not saved — retrying', 'failed');
      scheduleSave(5000, true);
    }
  }, delay);
}

function clearWorkspace() {
  setTab('queue');
  active = null;
  intakeAnswers = {};
  setSaveState('');
  renderMyChat();
  $('composerWrap').style.display = 'none';
  $('observeCtl').style.display = 'none';
  $('directiveCtl').style.display = 'none';
  $('referralsWrap').style.display = 'none';
  $('chatHead').innerHTML = '<span class="muted">Accept a waiting chat to begin.</span>';
  $('msgs').innerHTML = '';
  $('intakeForm').style.display = 'none';
  $('intakeAnonNote').style.display = 'none';
  $('directivesList').innerHTML = '';
  $('callerInfo').innerHTML = '<p class="muted">No active chat.</p>';
  loadActiveDirectives();
}

$('intakeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!active) return;
  const missing = missingRequired();
  if (missing.length &&
      !confirm('Required fields not filled in:\n\n' + missing.join('\n') +
        '\n\nSubmit anyway?')) return;
  clearTimeout(saveTimer); // the submit carries everything a pending autosave would
  const btn = $('submitIntakeBtn');
  btn.disabled = true;
  btn.textContent = 'Submitting…';
  const res = await fetch('/api/intake/' + active.contactId, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ intake: collectIntake(), submit: true }),
  }).catch(() => null);
  btn.disabled = false;
  btn.textContent = 'Submit intake';
  if (!res || !res.ok) {
    setSaveState('not submitted', 'failed');
    toast('The intake was NOT submitted — check your connection and press Submit again.', true);
    scheduleSave(5000, true); // keep the draft safe meanwhile
    return;
  }
  const phone = active.channel === 'phone';
  // Only clear the workspace once the chat itself is over (a phone intake is
  // over when submitted); submitting mid-conversation keeps the chat open.
  if (active.ended) {
    clearWorkspace();
    toast(phone ? 'Phone intake submitted ✓' : 'Intake submitted ✓ — the chat is closed.');
  } else {
    setSaveState(`submitted ${hhmm()}`, 'saved');
    toast('Intake submitted ✓ — you can keep editing until the chat ends.');
  }
});

// ---------------------------------------------------------------------------
// Follow-ups

async function loadFollowups() {
  const rows = await (await fetch('/api/followups')).json().catch(() => []);
  const box = $('fuList');
  box.innerHTML = rows.length ? '' : '<p class="muted">None open.</p>';
  for (const f of rows) {
    const div = document.createElement('div');
    if (f.overdue) div.className = 'overdue';
    const due = new Date(f.dueAt);
    div.textContent = `${f.alias || 'Anonymous'} — due ${due.toLocaleDateString()}` +
      (f.note ? ` · ${f.note.slice(0, 60)}` : '');
    const btn = document.createElement('button');
    btn.textContent = 'Done';
    btn.style.cssText = 'margin-left:6px;font-size:12px;padding:1px 8px';
    btn.onclick = async () => { await post(`/api/followups/${f.id}/done`); loadFollowups(); };
    div.appendChild(btn);
    box.appendChild(div);
  }
}

$('followupBtn').onclick = async () => {
  if (!active) return;
  const days = prompt('Follow up in how many days?', '7');
  if (!days || Number.isNaN(Number(days))) return;
  const note = prompt('Note for the follow-up (optional)') || undefined;
  const dueAt = new Date(Date.now() + Number(days) * 86_400_000).toISOString();
  const res = await post('/api/followups',
    { contactId: active.contactId, dueAt, note });
  if (res.ok) { alert('Follow-up scheduled.'); loadFollowups(); }
};

// ---------------------------------------------------------------------------
// Noticeboard unread badge (shift-start: read the notebooks)

async function loadBoardUnread() {
  const r = await (await fetch('/api/board/unread')).json().catch(() => ({ unread: 0 }));
  if (window.tellNav) window.tellNav.setUnread(r.unread);
}

// ---------------------------------------------------------------------------
// Active directives (shift-start review, per {{manual}} ch.24)

async function loadActiveDirectives() {
  const rows = await (await fetch('/api/directives/active')).json().catch(() => []);
  const box = $('activeDirectives');
  box.innerHTML = rows.length ? '' : '<p class="muted">None.</p>';
  for (const d of rows) {
    const div = document.createElement('div');
    div.className = 'directive ' + d.alertLevel;
    const lvl = document.createElement('span');
    lvl.className = 'lvl';
    lvl.textContent = d.alertLevel + ' · ' + (d.alias || 'Anonymous');
    const body = document.createElement('div');
    body.textContent = d.body;
    div.appendChild(lvl);
    div.appendChild(body);
    box.appendChild(div);
  }
}

// ---------------------------------------------------------------------------
// "My feedback" (supervisor QA responses to my intakes)

async function loadMyFeedback() {
  const rows = await (await fetch('/api/my-feedback')).json().catch(() => []);
  const fresh = rows.filter((f) => !f.acknowledged);
  if (!fresh.length) return;
  const box = $('feedbackBox');
  box.style.display = 'block';
  box.innerHTML = '';
  const h = document.createElement('strong');
  h.textContent = `Feedback from your supervisor (${fresh.length})`;
  box.appendChild(h);
  for (const f of fresh) {
    const p = document.createElement('p');
    p.style.marginTop = '6px';
    p.textContent = `${f.supervisorName || 'Supervisor'}: ${f.body}`;
    const btn = document.createElement('button');
    btn.textContent = 'Got it';
    btn.style.cssText = 'margin-left:6px;font-size:12px;padding:1px 8px';
    btn.onclick = async () => {
      await post(`/api/my-feedback/${f.id}/ack`);
      p.remove();
      if (!box.querySelector('p')) box.style.display = 'none';
    };
    p.appendChild(btn);
    box.appendChild(p);
  }
}

// ---------------------------------------------------------------------------
// Help

$('helpBtn').onclick = async () => {
  const note = prompt('What do you need help with? (visible to supervisors and backups)');
  if (note === null) return;
  await post('/api/help', { contactId: active ? active.contactId : null, note });
  alert('Supervisors and backups have been notified.');
};
