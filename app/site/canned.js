'use strict';

// Canned responses page: add, edit and delete the replies the console's "/"
// picker offers. Workers manage their own; supervisors and coordinators also
// manage the shared ones (and can add {{org}}'s starter set when there are none).

const $ = (id) => document.getElementById(id);
const RANK = { trainee: 0, worker: 1, supervisor: 2, coordinator: 3 };
let me = null;

async function send(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status}).`);
  return data;
}

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

function editForm(c, done) {
  const f = el('form');
  const l = el('label', null, 'Name');
  const li = el('input'); li.type = 'text'; li.maxLength = 60; li.value = c.label; li.required = true;
  l.append(li);
  const b = el('label', null, 'Message');
  const bi = el('textarea'); bi.maxLength = 2000; bi.value = c.body; bi.required = true;
  b.append(bi);
  f.append(l, b);
  let si = null;
  if (RANK[me.role] >= RANK.supervisor) {
    const s = el('label', 'check');
    si = el('input'); si.type = 'checkbox'; si.checked = c.shared;
    s.append(si, ' Shared with everyone');
    f.append(s);
  }
  const err = el('span', 'err');
  const save = el('button', 'primary', 'Save'); save.type = 'submit';
  const cancel = el('button', null, 'Cancel'); cancel.type = 'button';
  cancel.onclick = done;
  const row = el('div', 'btns'); row.append(save, cancel, err);
  f.append(row);
  f.onsubmit = async (e) => {
    e.preventDefault();
    err.textContent = '';
    const body = { label: li.value, body: bi.value };
    if (si) body.shared = si.checked;
    try { await send('PATCH', `/api/canned/${c.id}`, body); load(); } catch (x) { err.textContent = x.message; }
  };
  setTimeout(() => bi.focus(), 0);
  return f;
}

function card(c) {
  const box = el('div', 'cr');
  box.dataset.id = c.id;
  const show = () => {
    box.innerHTML = '';
    const top = el('div', 'top');
    top.append(el('span', 'label', c.label));
    if (c.canEdit) {
      const btns = el('div', 'btns');
      const edit = el('button', null, 'Edit');
      edit.onclick = () => { box.innerHTML = ''; box.append(editForm(c, show)); };
      const del = el('button', 'del', 'Delete');
      del.onclick = async () => {
        const whose = c.shared ? 'It will go for everyone.' : '';
        if (!confirm(`Delete "${c.label}"? ${whose}`.trim())) return;
        try { await send('DELETE', `/api/canned/${c.id}`); load(); } catch (x) { alert(x.message); }
      };
      btns.append(edit, del);
      top.append(btns);
    }
    box.append(top, el('div', 'body', c.body));
  };
  show();
  return box;
}

async function load() {
  if (!me) {
    const res = await fetch('/api/me');
    if (res.status === 401) { location.href = 'console.html'; return; }
    me = await res.json();
    const canShare = RANK[me.role] >= RANK.supervisor;
    $('addSharedWrap').hidden = !canShare;
    if (canShare) $('whoShares').textContent = 'you can add and change those';
    if (RANK[me.role] < RANK.worker) {
      // Trainees can read them here but not add their own yet.
      $('addForm').closest('.panel').hidden = true;
    }
  }
  const res = await fetch('/api/canned');
  if (res.status === 401) { location.href = 'console.html'; return; }
  const rows = await res.json();
  const shared = rows.filter((c) => c.shared);
  const mine = rows.filter((c) => !c.shared);
  const fill = (target, list, emptyText) => {
    target.innerHTML = '';
    target.classList.toggle('muted', !list.length);
    if (!list.length) target.append(el('p', 'empty', emptyText));
    for (const c of list) target.append(card(c));
  };
  const canShare = RANK[me.role] >= RANK.supervisor;
  $('starter').hidden = !(canShare && !shared.length);
  fill($('sharedList'), shared, canShare ? '' : 'None yet — a supervisor or coordinator can add them.');
  if (canShare && !shared.length) $('sharedList').innerHTML = '';
  const mineEmpty = RANK[me.role] < RANK.worker ? 'Personal responses are for support workers.'
    : canShare ? 'None yet — add one above and untick "Share with everyone" to keep it to yourself.'
      : 'None yet — add one above.';
  fill($('mineList'), mine, mineEmpty);
}

$('addForm').onsubmit = async (e) => {
  e.preventDefault();
  $('addErr').textContent = '';
  const body = { label: $('addLabel').value, body: $('addBody').value };
  if (!$('addSharedWrap').hidden) body.shared = $('addShared').checked;
  try {
    await send('POST', '/api/canned', body);
    $('addLabel').value = ''; $('addBody').value = '';
    load();
  } catch (x) { $('addErr').textContent = x.message; }
};

$('starterBtn').onclick = async () => {
  $('starterErr').textContent = '';
  try { await send('POST', '/api/canned/starter'); load(); } catch (x) { $('starterErr').textContent = x.message; }
};

load();
