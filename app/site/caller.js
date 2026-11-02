'use strict';

// Caller widget. Transport is SSE (EventSource) down + fetch POST up:
//  - messages queue locally and show as pending until the server acks the POST
//  - the stream reconnects with backoff, replaying anything missed via ?since=
//  - the widget never looks dead: waiting UI + connection state banner
//  - closing the page sends a leave beacon so the queue frees up fast

const $ = (id) => document.getElementById(id);

let chatToken = null;
let lastMsgId = 0;
let es = null;
let reconnectDelay = 1000;
let connectedToWorker = false;
let ended = false;
let flushing = false;
const pending = new Map(); // clientMsgId -> bubble element

// ---------------------------------------------------------------------------
// Pre-chat survey, rendered from the server's versioned definition so {{org}}
// can edit the questions without a deploy. If loading it fails, the chat can
// still start — a person in crisis is never blocked by a config problem.

let surveyForm = null;
const answers = {};

async function loadSurvey() {
  try {
    const res = await fetch('/api/prechat/form');
    if (res.status === 401) {
      const body = await res.json().catch(() => ({}));
      if (body.passcode) { location.href = 'passcode.html?next=caller.html'; return; }
    }
    if (!res.ok) throw new Error();
    surveyForm = await res.json();
  } catch {
    $('surveyFields').innerHTML =
      '<p class="muted">We could not load the questions — you can still start the chat.</p>';
    return;
  }
  const box = $('surveyFields');
  box.innerHTML = '';
  for (const section of surveyForm.schema.sections) {
    for (const f of section.fields) box.appendChild(drawSurveyField(f));
  }
}

function drawSurveyField(f) {
  const wrap = document.createElement('div');
  wrap.dataset.fieldId = f.id;
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
  const set = (val) => {
    if (val === undefined || val === '' || (Array.isArray(val) && !val.length)) delete answers[f.id];
    else answers[f.id] = val;
    wrap.classList.remove('missing');
    maybeOtherBox(wrap, f);
  };

  if (f.type === 'select') {
    const sel = document.createElement('select');
    sel.appendChild(new Option('(select one)', ''));
    for (const o of f.options || []) sel.appendChild(new Option(o.label, o.id));
    sel.onchange = () => set(sel.value || undefined);
    wrap.appendChild(sel);
  } else if (f.type === 'radio' || f.type === 'checkboxes') {
    const opts = document.createElement('div');
    opts.className = 'opts';
    for (const o of f.options || []) {
      const l = document.createElement('label');
      const input = document.createElement('input');
      input.type = f.type === 'radio' ? 'radio' : 'checkbox';
      if (f.type === 'radio') input.name = 'sv_' + f.id;
      input.onchange = () => {
        if (f.type === 'radio') set(o.id);
        else {
          const cur = new Set(Array.isArray(answers[f.id]) ? answers[f.id] : []);
          input.checked ? cur.add(o.id) : cur.delete(o.id);
          set([...cur]);
        }
      };
      l.appendChild(input);
      l.appendChild(document.createTextNode(o.label));
      opts.appendChild(l);
    }
    wrap.appendChild(opts);
  } else if (f.type === 'textarea') {
    const ta = document.createElement('textarea');
    ta.rows = 3;
    ta.oninput = () => set(ta.value.trim() || undefined);
    wrap.appendChild(ta);
  } else {
    const input = document.createElement('input');
    input.oninput = () => set(input.value.trim() || undefined);
    wrap.appendChild(input);
  }
  maybeOtherBox(wrap, f);
  return wrap;
}

// "Other: Please Specify" / "If not listed, please share here" companion box,
// shown once the field has any answer (matches {{org}}'s live survey).
function maybeOtherBox(wrap, f) {
  const existing = wrap.querySelector('.otherBox');
  const wanted = f.other_text && answers[f.id] !== undefined;
  if (wanted && !existing) {
    const input = document.createElement('input');
    input.className = 'otherBox';
    input.placeholder = f.type === 'select'
      ? 'Other: please specify' : 'If not listed, please share here';
    input.style.marginTop = '4px';
    input.oninput = () => {
      const v = input.value.trim();
      if (v) answers[f.id + '_other'] = v;
      else delete answers[f.id + '_other'];
    };
    wrap.appendChild(input);
  } else if (!wanted && existing) {
    existing.remove();
    delete answers[f.id + '_other'];
  }
}

function missingRequired() {
  if (!surveyForm) return [];
  const missing = [];
  for (const s of surveyForm.schema.sections) {
    for (const f of s.fields) {
      if (!f.required) continue;
      if (answers[f.id] === undefined) missing.push(f.id);
    }
  }
  return missing;
}

loadSurvey();

$('startBtn').onclick = async () => {
  const missing = missingRequired();
  if (missing.length) {
    for (const id of missing) {
      const el = document.querySelector(`[data-field-id="${id}"]`);
      if (el) el.classList.add('missing');
    }
    document.querySelector('.missing')?.scrollIntoView({ block: 'center' });
    $('startErr').textContent = 'Please answer the questions marked in red — they help us keep you safe.';
    $('startErr').style.display = 'block';
    return;
  }
  $('startErr').style.display = 'none';
  $('startBtn').disabled = true;
  try {
    const res = await fetch('/api/chat/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callerToken: localStorage.getItem('{{id}}CallerToken') || undefined,
        alias: $('alias').value.trim() || undefined,{{#features.setupWizard}}
        // The safety numbers this page shows (the fingerprint sits in the
        // HTML beside them); the server refuses a chat from a page built
        // before they changed.
        pageSafety: $('startCard').dataset.safety,{{/features.setupWizard}}
        triage: surveyForm
          ? { form: surveyForm.name, version: surveyForm.version, answers }
          : { answers },
      }),
    });
{{#features.setupWizard}}    if (res.status === 409) {
      const stale = await res.json().catch(() => ({}));
      $('startErr').textContent = 'This page is out of date — please reload it. ' + (stale.message || '');
      $('startErr').style.display = 'block';
      $('startBtn').disabled = false;
      return;
    }
{{/features.setupWizard}}    if (!res.ok) throw new Error('start failed');
    const data = await res.json();
    chatToken = data.chatToken;
    localStorage.setItem('{{id}}CallerToken', data.callerToken);
    $('startCard').style.display = 'none';
    $('chatCard').style.display = 'flex';
    connect();
  } catch {
    $('startErr').textContent =
      'Sorry, we could not start the chat. Please try again{{#phone}}, or call us on {{phone}}{{/phone}}.';
    $('startErr').style.display = 'block';
    $('startBtn').disabled = false;
  }
};

function connect() {
  if (ended) return;
  es = new EventSource(`/api/chat/stream?token=${chatToken}&since=${lastMsgId}`);

  es.onopen = () => {
    reconnectDelay = 1000;
    setConnState('');
    flushPending();
  };

  es.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'position') {
      $('posLine').textContent = msg.position === 1
        ? "You're next in line."
        : `You are number ${msg.position} in the queue.`;
    } else if (msg.type === 'connected') {
      connectedToWorker = true;
      $('waitBox').style.display = 'none';
      $('msgs').style.display = 'flex';
      $('composer').style.display = 'flex';
      $('input').focus();
    } else if (msg.type === 'message') {
      lastMsgId = Math.max(lastMsgId, msg.id);
      if (msg.sender === 'caller' && msg.client_msg_id && pending.has(msg.client_msg_id)) {
        confirmPending(msg.client_msg_id, msg.id);
      } else if (msg.sender !== 'caller' || !isRendered(msg.id)) {
        addBubble(msg.sender === 'worker' ? 'worker-remote' : msg.sender, msg.body, msg.id);
      }
    } else if (msg.type === 'safety_valve') {
      ended = true;
      es.close();
      showWaitEnd(msg.body);
    } else if (msg.type === 'ended') {
      ended = true;
      es.close();
      addBubble('system', 'The chat has ended. Thank you for reaching out — you can start a new chat any time.');
      $('composer').style.display = 'none';
    }
  };

  es.onerror = () => {
    if (ended) return;
    es.close();
    setConnState('Reconnecting — your messages will be sent when we’re back online.');
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  };
}

function setConnState(text) {
  $('connState').textContent = text;
  $('connState').style.display = text && connectedToWorker ? 'block' : 'none';
  $('connState').style.color = 'var(--warn)';
}

function isRendered(id) {
  return !!document.querySelector(`[data-msg-id="${id}"]`);
}

function addBubble(kind, body, id) {
  const el = document.createElement('div');
  // caller widget renders worker messages on the left, own messages right
  el.className = 'msg ' + (kind === 'worker-remote' ? 'caller' : kind === 'caller' ? 'worker' : 'system');
  el.textContent = body;
  if (id) el.dataset.msgId = id;
  $('msgs').appendChild(el);
  $('msgs').scrollTop = $('msgs').scrollHeight;
  return el;
}

function confirmPending(clientMsgId, id) {
  const el = pending.get(clientMsgId);
  if (!el) return;
  el.classList.remove('pending');
  if (id) el.dataset.msgId = id;
  const meta = el.querySelector('.meta');
  if (meta) meta.remove();
  pending.delete(clientMsgId);
}

async function flushPending() {
  if (flushing || ended) return;
  flushing = true;
  try {
    for (const [clientMsgId, el] of [...pending]) {
      const res = await fetch('/api/chat/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatToken, body: el.dataset.body, clientMsgId }),
      });
      if (res.ok) {
        const data = await res.json();
        lastMsgId = Math.max(lastMsgId, data.id);
        confirmPending(clientMsgId, data.id);
      } else break; // retry on next flush
    }
  } catch { /* offline — retried by the interval below */ }
  flushing = false;
}
setInterval(flushPending, 4000);

function sendMessage() {
  const body = $('input').value.trim();
  if (!body || ended) return;
  $('input').value = '';
  const clientMsgId = crypto.randomUUID();
  const el = addBubble('caller', body);
  el.classList.add('pending');
  el.dataset.body = body;
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = 'sending…';
  el.appendChild(meta);
  pending.set(clientMsgId, el);
  flushPending();
}

$('sendBtn').onclick = sendMessage;
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

// Leave chat: two gentle taps rather than a jarring browser dialog. The
// server posts a system note so the worker knows the caller chose to go.
let leaveArmed = null;
$('leaveBtn').onclick = async () => {
  if (ended) return;
  if (!leaveArmed) {
    $('leaveBtn').textContent = 'Sure? Tap again';
    $('leaveBtn').classList.add('confirm');
    leaveArmed = setTimeout(() => {
      leaveArmed = null;
      $('leaveBtn').textContent = 'Leave chat';
      $('leaveBtn').classList.remove('confirm');
    }, 5000);
    return;
  }
  clearTimeout(leaveArmed);
  ended = true;
  if (es) es.close();
  try {
    await fetch('/api/chat/leave', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatToken, explicit: true }),
    });
  } catch { /* the pagehide beacon is the backstop */ }
  addBubble('system', 'You left the chat. Thank you for reaching out — you can start a new chat any time.');
  $('composer').style.display = 'none';
};

// Closing the tab: tell the server so waiting spots free immediately.
addEventListener('pagehide', () => {
  if (chatToken && !ended) {
    navigator.sendBeacon('/api/chat/leave',
      new Blob([JSON.stringify({ chatToken })], { type: 'application/json' }));
  }
});

function showWaitEnd(body) {
  $('waitBox').innerHTML = '';
  const p = document.createElement('p');
  p.textContent = body;
  $('waitBox').appendChild(p);
  $('waitBox').style.display = 'block';
  $('msgs').style.display = 'none';
  $('composer').style.display = 'none';
}
