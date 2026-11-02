'use strict';

const $ = (id) => document.getElementById(id);
let workers = [];

const post = (url, body, method = 'POST') => fetch(url, {
  method, headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
});

async function load() {
  const res = await fetch('/api/admin/workers');
  if (res.status === 401 || res.status === 403) { location.href = 'console.html'; return; }
  workers = await res.json();
  render();
}

function render() {
  const fRole = $('fRole').value;
  const fStatus = $('fStatus').value;
  const tbl = $('tbl');
  tbl.innerHTML = `<tr><th{{^schedule.groupPrefix}} hidden{{/schedule.groupPrefix}}>Group</th><th>Name</th><th>Email</th><th>Role</th><th>Service</th>
    <th>Programs</th><th>MFA</th><th></th></tr>`;
  for (const w of workers) {
    if (fRole && w.role !== fRole) continue;
    if (fStatus && w.service_status !== fStatus) continue;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td{{^schedule.groupPrefix}} hidden{{/schedule.groupPrefix}}><input data-k="group" inputmode="numeric" placeholder="—"
        aria-label="Support group" style="width:44px;padding:2px 4px"></td><td></td><td class="muted"></td>
      <td><select data-k="role">
        ${['trainee', 'worker', 'supervisor', 'coordinator'].map((r) =>
          `<option ${r === w.role ? 'selected' : ''}>${r}</option>`).join('')}
      </select></td>
      <td><select data-k="serviceStatus">
        ${[['in_service', 'in service'], ['on_leave', 'on leave'], ['left', 'left']].map(([v, t]) =>
          `<option value="${v}" ${v === w.service_status ? 'selected' : ''}>${t}</option>`).join('')}
      </select></td>
      <td class="muted"></td>
      <td></td>
      <td><button data-k="reset" style="font-size:12px;padding:3px 8px">Reset pw</button></td>`;
    const groupIn = tr.querySelector('[data-k="group"]');
    groupIn.value = w.support_group ? '{{#schedule.groupPrefix}}{{schedule.groupPrefix}}{{/schedule.groupPrefix}}' + String(w.support_group).padStart(2, '0') : '';
    groupIn.onchange = async () => {
      const res = await post('/api/admin/workers/' + w.id, { supportGroup: groupIn.value }, 'PATCH');
      if (!res.ok) { alert((await res.json().catch(() => ({}))).error || 'failed'); }
      load();
    };
    tr.children[1].textContent = w.name;
    tr.children[2].textContent = w.email;
    tr.children[5].textContent = w.programs || '—';
    tr.children[6].innerHTML = w.totp_enabled
      ? '<span class="badge ok">TOTP</span>'
      : (w.must_change_pw ? '<span class="badge warn">temp pw</span>' : '<span class="badge">none</span>');
    tr.querySelector('[data-k="role"]').onchange = async (e) => {
      await post('/api/admin/workers/' + w.id, { role: e.target.value }, 'PATCH');
      load();
    };
    tr.querySelector('[data-k="serviceStatus"]').onchange = async (e) => {
      await post('/api/admin/workers/' + w.id, { serviceStatus: e.target.value }, 'PATCH');
      load();
    };
    tr.querySelector('[data-k="reset"]').onclick = async () => {
      if (!confirm(`Reset password for ${w.name}? Their sessions and TOTP are cleared.`)) return;
      const r = await (await post('/api/admin/workers/' + w.id, { resetPassword: true }, 'PATCH')).json();
      showTemp(`${w.email} → temporary password: ${r.tempPassword}`);
      load();
    };
    tbl.appendChild(tr);
  }
}

function showTemp(text) {
  const box = $('tempPw');
  box.style.display = 'block';
  box.textContent = text + '  (share it securely — it must be changed on first login)';
}

$('nAdd').onclick = async () => {
  const res = await post('/api/admin/workers', {
    name: $('nName').value.trim(),
    email: $('nEmail').value.trim(),
    role: $('nRole').value,
    phone: $('nPhone').value.trim() || undefined,
  });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'failed'); return; }
  showTemp(`${$('nEmail').value.trim()} → temporary password: ${data.tempPassword}`);
  $('nName').value = ''; $('nEmail').value = ''; $('nPhone').value = '';
  load();
};

$('importBtn').onclick = async () => {
  const res = await post('/api/admin/import', { csv: $('csv').value });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'failed'); return; }
  $('importOut').textContent =
    data.created.map((c) => `${c.group ? c.group + ' ' : ''}${c.name} <${c.email}>  temp password: ${c.tempPassword}`).join('\n') +
    (data.errors.length ? '\n\nErrors:\n' + data.errors.join('\n') : '');
  load();
};

// Panels for modules this installation doesn't run are removed.
fetch('/api/modules').then((r) => r.json()).then((d) => {
  for (const el of document.querySelectorAll('[data-module]')) {
    if (d.modules && !d.modules.includes(el.dataset.module)) el.remove();
  }
}).catch(() => {});

$('fRole').onchange = render;
$('fStatus').onchange = render;
load();

// ---------------------------------------------------------------------------
// Intake form options editor. Loads the current form definition, lets the
// coordinator add / rename / reorder / retire options per field, and saves
// the whole schema as a new version. The server enforces retire-not-delete.

let formDef = null;
let formName = 'chat_intake';

$('loadFormBtn').onclick = () => loadFormEditor(formName);

async function loadFormEditor(name) {
  formName = name;
  const res = await fetch('/api/form/' + name);
  if (!res.ok) { alert('Could not load the form.'); return; }
  formDef = await res.json();
  drawFormEditor();
}

function drawFormEditor() {
  const box = $('formEditor');
  box.innerHTML = '';
  const picker = document.createElement('p');
  for (const [name, label] of [['chat_intake', 'Worker intake'], ['pre_chat', 'Caller pre-chat survey']]) {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'font-size:13px;padding:3px 12px;margin-right:6px' +
      (name === formDef.name ? ';background:var(--accent);color:#fff;border-color:var(--accent)' : '');
    b.onclick = () => loadFormEditor(name);
    picker.appendChild(b);
  }
  box.appendChild(picker);
  const head = document.createElement('p');
  head.className = 'muted';
  head.style.marginTop = '6px';
  head.textContent = `Editing "${formDef.name}" — current version ${formDef.version}. ` +
    'Saving publishes version ' + (formDef.version + 1) + '.';
  box.appendChild(head);

  for (const section of formDef.schema.sections) {
    for (const field of section.fields) {
      if (!['select', 'radio', 'checkboxes'].includes(field.type)) continue;
      const panel = document.createElement('div');
      panel.style.cssText = 'border:1px solid var(--line);border-radius:10px;padding:10px;margin:8px 0';
      const title = document.createElement('strong');
      title.style.fontSize = '13px';
      title.textContent = `${section.title || section.id} → ${field.label || field.id}`;
      panel.appendChild(title);
      const list = document.createElement('div');
      list.style.marginTop = '6px';
      field.options.forEach((o, i) => list.appendChild(optionRow(field, o, i)));
      panel.appendChild(list);
      const add = document.createElement('button');
      add.textContent = '+ Add option';
      add.style.cssText = 'font-size:12px;padding:3px 10px;margin-top:6px';
      add.onclick = () => {
        const label = prompt('Label for the new option');
        if (!label) return;
        const id = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
          .slice(0, 40) || 'opt_' + Date.now();
        if (field.options.some((o) => o.id === id)) { alert('An option with that id exists.'); return; }
        field.options.push({ id, label });
        drawFormEditor();
      };
      panel.appendChild(add);
      box.appendChild(panel);
    }
  }

  const save = document.createElement('button');
  save.className = 'primary';
  save.textContent = `Publish version ${formDef.version + 1}`;
  save.style.marginTop = '8px';
  save.onclick = async () => {
    const res = await post('/api/admin/forms/' + formDef.name, { schema: formDef.schema });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { alert(data.error || 'Save failed.'); return; }
    alert(`Published version ${data.version}. New chats use it immediately.`);
    loadFormEditor();
  };
  box.appendChild(save);
}

function optionRow(field, o, i) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:6px;align-items:center;margin:2px 0;font-size:14px' +
    (o.retired ? ';opacity:.45' : '');
  const label = document.createElement('span');
  label.style.flex = '1';
  label.textContent = o.label + (o.retired ? ' (retired)' : '');
  row.appendChild(label);
  const mk = (text, fn, title) => {
    const b = document.createElement('button');
    b.textContent = text;
    b.title = title;
    b.style.cssText = 'font-size:12px;padding:1px 7px';
    b.onclick = fn;
    row.appendChild(b);
  };
  mk('↑', () => { if (i > 0) { [field.options[i - 1], field.options[i]] = [field.options[i], field.options[i - 1]]; drawFormEditor(); } }, 'Move up');
  mk('↓', () => { if (i < field.options.length - 1) { [field.options[i + 1], field.options[i]] = [field.options[i], field.options[i + 1]]; drawFormEditor(); } }, 'Move down');
  mk('Rename', () => {
    const label2 = prompt('New label (the option keeps its id, so history and stats stay together)', o.label);
    if (label2) { o.label = label2; drawFormEditor(); }
  }, 'Rename');
  mk(o.retired ? 'Restore' : 'Retire', () => {
    if (o.retired) delete o.retired;
    else o.retired = true;
    drawFormEditor();
  }, o.retired ? 'Show on new forms again' : 'Hide from new forms (history keeps it)');
  return row;
}
