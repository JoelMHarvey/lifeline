'use strict';

const $ = (id) => document.getElementById(id);
const post = (url, body) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
});

let me = null;
let current = null;

(async () => {
  const res = await fetch('/api/me');
  if (!res.ok) { location.href = 'console.html'; return; }
  me = await res.json();
  if (me.role === 'supervisor' || me.role === 'coordinator') {
    $('newTopicBtn').style.display = 'block';
  }
  await loadTopics();
})();

async function loadTopics() {
  const topics = await (await fetch('/api/board')).json();
  const box = $('topics');
  box.innerHTML = '';
  for (const t of topics) {
    const div = document.createElement('div');
    div.className = 'topic' + (current === t.id ? ' sel' : '');
    const pin = document.createElement('span');
    pin.className = 'pin';
    pin.textContent = t.pinned ? '📌' : '';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = t.name;
    div.appendChild(pin);
    div.appendChild(name);
    if (t.unread > 0) {
      const b = document.createElement('span');
      b.className = 'badge danger';
      b.textContent = String(t.unread);
      div.appendChild(b);
    } else {
      const n = document.createElement('span');
      n.className = 'muted';
      n.style.fontSize = '12px';
      n.textContent = String(t.postCount);
      div.appendChild(n);
    }
    div.onclick = async () => {
      await openTopic(t.id);
      // Phones stack the list above the posts: bring the posts into view.
      if (matchMedia('(max-width: 760px)').matches) $('topicHead').scrollIntoView({ behavior: 'smooth' });
    };
    box.appendChild(div);
  }
}

async function openTopic(id) {
  const t = await (await fetch('/api/board/topics/' + id)).json();
  current = id;
  const head = $('topicHead');
  head.innerHTML = '';
  const h = document.createElement('h2');
  h.style.fontSize = '17px';
  h.textContent = (t.pinned ? '📌 ' : '') + t.name;
  head.appendChild(h);
  if (me.role === 'supervisor' || me.role === 'coordinator') {
    const pinBtn = document.createElement('button');
    pinBtn.textContent = t.pinned ? 'Unpin' : 'Pin';
    pinBtn.style.cssText = 'font-size:12px;padding:2px 10px;margin-top:4px';
    pinBtn.onclick = async () => {
      await post(`/api/board/topics/${t.id}/pin`, { pinned: !t.pinned });
      openTopic(t.id);
      loadTopics();
    };
    head.appendChild(pinBtn);
  }
  const box = $('posts');
  box.innerHTML = t.posts.length ? '' : '<p class="muted" style="padding:10px 2px">No posts yet.</p>';
  for (const p of t.posts) {
    const div = document.createElement('div');
    div.className = 'post';
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${p.author} · ${new Date(p.createdAt).toLocaleString()}`;
    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = p.body;
    div.appendChild(meta);
    div.appendChild(body);
    box.appendChild(div);
  }
  $('composer').style.display = 'block';
  box.scrollTop = box.scrollHeight;
  loadTopics();
}

$('postBtn').onclick = async () => {
  const body = $('postBody').value.trim();
  if (!body || !current) return;
  const res = await post(`/api/board/topics/${current}/posts`, { body });
  if (res.ok) {
    $('postBody').value = '';
    openTopic(current);
  }
};

$('newTopicBtn').onclick = async () => {
  const name = prompt('Topic name');
  if (!name) return;
  const res = await post('/api/board/topics', { name });
  if (!res.ok) alert((await res.json()).error || 'Failed.');
  loadTopics();
};
