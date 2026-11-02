'use strict';

// The console's call panel (module "voice"): incoming calls ring here with
// Answer / Decline; answering opens the phone intake beside the call, with
// mute, hold, hang up and a call timer. Supervisors can listen in to a live
// call. Uses console.js's openChat() for the intake. Does nothing unless the
// voice module is on.

(() => {
  const bar = document.createElement('div');
  bar.id = 'voiceBar';
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', 'Phone calls');
  bar.style.cssText = 'display:none;position:sticky;top:0;z-index:80;padding:8px 16px;' +
    'background:var(--deep);color:#fff;font-size:14px';
  document.body.prepend(bar);

  const declined = new Set();
  let muted = false;
  let held = false;
  let mock = false;
  let lastRingCount = 0;

  const btn = (label, onClick, style = '') => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'margin-left:8px;font-size:13px;padding:3px 10px;' + style;
    b.onclick = onClick;
    return b;
  };
  const mmss = (secs) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  const line = (...kids) => { const d = document.createElement('div'); d.style.padding = '3px 0'; d.append(...kids); return d; };
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}) });

  async function answer(id) {
    const res = await post('/api/voice/answer/' + id);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { alert(data.error || 'Could not answer.'); poll(); return; }
    muted = false; held = false;
    if (typeof openChat === 'function') openChat(data); // eslint-disable-line no-undef
    poll();
  }

  function draw(s) {
    bar.innerHTML = '';
    // The call ended (either side): the open intake now finishes the contact.
    if (!s.myCall && typeof active !== 'undefined' && active && active.voice) active.ended = true; // eslint-disable-line no-undef
    const ringing = s.ringing.filter((r) => !declined.has(r.contactId));
    if (s.myCall) {
      const secs = Math.max(0, Math.round((Date.now() - Date.parse(s.myCall.since)) / 1000));
      const id = s.myCall.contactId;
      bar.append(line(
        document.createTextNode(`📞 On a call · ${mmss(secs)}${held ? ' · on hold' : ''}${muted ? ' · muted' : ''}` +
          (mock ? ' · test mode, no audio' : '') + (s.recording ? ' · RECORDING' : '')),
        btn(muted ? 'Unmute' : 'Mute', () => { muted = !muted; poll(); }),
        btn(held ? 'Resume' : 'Hold', async () => { await post('/api/voice/hold/' + id, { on: !held }); held = !held; poll(); }),
        btn('Hang up', async () => {
          if (!confirm('Hang up this call? Your intake stays open to finish.')) return;
          await post('/api/voice/hangup/' + id);
          // The intake stays open; submitting it now finishes the contact.
          if (typeof active !== 'undefined' && active && active.voice) active.ended = true; // eslint-disable-line no-undef
          poll();
        }, 'background:var(--danger);color:#fff;border-color:var(--danger)')));
    }
    for (const r of ringing) {
      const who = r.web ? 'Web call' : (r.hint ? `Phone ··${r.hint}` : 'Phone call');
      bar.append(line(
        document.createTextNode(`🔔 Incoming call — ${who} · waiting ${mmss(r.waitedSecs)}` +
          (r.priorContacts ? ` · ${r.priorContacts} earlier contact(s)` : '') + (r.paged ? ' · backups paged' : '')),
        s.myCall ? document.createTextNode('') : btn('Answer', () => answer(r.contactId), 'background:var(--ok);color:#fff;border-color:var(--ok)'),
        btn('Decline', () => { declined.add(r.contactId); poll(); })));
    }
    for (const c of s.liveCalls || []) {
      bar.append(line(document.createTextNode(`🎧 ${c.worker} is on a call`),
        btn('Listen in', async () => {
          const res = await post('/api/voice/monitor/' + c.contactId);
          alert(res.ok ? 'Listening in (silent).' + (mock ? ' Test mode: no audio.' : '') : 'Could not listen in.');
        })));
    }
    bar.style.display = bar.childElementCount ? 'block' : 'none';
    if (ringing.length > lastRingCount && typeof notifyBrowser === 'function') {
      notifyBrowser('Incoming call', 'A caller is waiting — can you answer?'); // eslint-disable-line no-undef
    }
    lastRingCount = ringing.length;
  }

  async function poll() {
    try {
      const res = await fetch('/api/voice/state');
      if (res.ok) draw(await res.json());
    } catch { /* offline: try again next tick */ }
  }

  (async () => {
    const m = await fetch('/api/modules').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
    if (!(m.modules || []).includes('voice')) return;
    const tok = await fetch('/api/voice/token').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
    mock = tok.provider === 'mock';
    poll();
    setInterval(poll, 2000);
  })();
})();
