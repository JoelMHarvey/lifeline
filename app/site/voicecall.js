'use strict';

// "Call us from your browser" on the caller page (module "voice"): for
// people who can't or won't dial. The call joins the same queue as chats.
// Hidden unless the voice module is on.

(async () => {
  const card = document.getElementById('voiceCard');
  if (!card) return;
  const m = await fetch('/api/modules').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  if (!(m.modules || []).includes('voice')) return;
  // Only when calls really can be taken (never the test provider for a
  // real caller, never without the helpline numbers).
  const av = await fetch('/api/voice/available').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  if (!av.available) return;
  card.hidden = false;
  const btn = document.getElementById('voiceCallBtn');
  const status = document.getElementById('voiceStatus');
  const hang = document.getElementById('voiceHangBtn');
  let token = null;
  let timer = null;

  const show = (text) => { status.textContent = text; status.hidden = false; };
  const send = (path) => fetch('/api/voice/web-call/' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  // Closing the tab ends the call rather than leaving it ringing.
  addEventListener('pagehide', () => {
    if (token && !hang.hidden) {
      navigator.sendBeacon('/api/voice/web-call/hangup', new Blob([JSON.stringify({ token })], { type: 'text/plain' }));
    }
  });
  async function poll() {
    const res = await send('status');
    if (!res.ok) return;
    const s = await res.json();
    if (s.state === 'waiting') show(`Calling… you are number ${s.position || 1} in the queue. Please stay on this page.`);
    else if (s.state === 'connected') show('Connected to a support worker.');
    else {
      clearInterval(timer);
      hang.hidden = true; btn.hidden = false; btn.disabled = false;
      show(s.message || 'The call has ended.');
    }
  }
  btn.onclick = async () => {
    btn.disabled = true;
    const res = await fetch('/api/voice/web-call', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageSafety: card.dataset.safety || undefined }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { btn.disabled = false; show(data.error || 'Calls are not available right now.'); return; }
    token = data.callToken;
    btn.hidden = true; hang.hidden = false;
    show('Calling…' + (data.test ? ' (test mode — no audio)' : ''));
    timer = setInterval(poll, 2000);
    poll();
  };
  hang.onclick = async () => {
    if (token) await send('hangup');
    clearInterval(timer);
    hang.hidden = true; btn.hidden = false; btn.disabled = false;
    show('You hung up. You can call or chat again any time.');
  };
})();
