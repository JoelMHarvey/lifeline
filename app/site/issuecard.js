'use strict';

// One problem report as a folding card: reference, title, status and the
// note history. Shared by issues.html (the reporter's own, with "Still not
// fixed") and ops.html (coordinators, with status + note).

(() => {
  const KIND = { bug: 'Problem', request: 'Request', question: 'Question' };
  const SEV = { blocking: "Can't do my job", normal: 'Nuisance', minor: 'Minor' };
  const STATUS = [
    ['new', 'New'], ['in_progress', 'In progress'], ['fixed', 'Fixed — please check it'],
    ['done', 'Done'], ['wont_fix', "Won't fix"],
  ];
  const when = (at) => new Date(at).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const el = (tag, props = {}, ...kids) => {
    const e = Object.assign(document.createElement(tag), props);
    for (const k of kids) if (k != null) e.append(k);
    return e;
  };
  const post = (url, body, method = 'POST') => fetch(url, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

  function renderIssue(it, { coordinator = false, manageLink = false, onChange = () => {} } = {}) {
    // id = the reference, so ops.html#TL-0007 (the link in emails) opens it.
    const card = el('details', { className: 'issue s-' + it.status, id: it.ref });
    if (location.hash === '#' + it.ref) {
      card.open = true;
      requestAnimationFrame(() => card.scrollIntoView({ block: 'start' }));
    }
    card.append(el('summary', {},
      el('span', { className: 'iRef', textContent: it.ref }),
      el('span', { className: 'iTitle', textContent: it.title }),
      el('span', { className: 'iStatus', textContent: it.statusWords }),
      el('span', { className: 'iMeta muted', textContent:
        `${KIND[it.kind]}${it.kind === 'bug' ? ' · ' + SEV[it.severity] : ''}` +
        `${coordinator ? ' · ' + it.reporterName : ''} · ${when(it.createdAt)}` })));

    const body = el('div', { className: 'iBody' });
    body.append(el('p', { className: 'iText', textContent: it.body || '(no details given)' }));
    if (it.page || (coordinator && it.client)) {
      body.append(el('p', { className: 'muted iWhere', textContent:
        [it.page ? `Page: ${it.page}` : null, coordinator && it.client ? `Browser: ${it.client}` : null]
          .filter(Boolean).join(' · ') }));
    }
    if (it.notes.length) {
      const thread = el('ol', { className: 'iThread' });
      for (const n of it.notes) {
        thread.append(el('li', {},
          el('span', { className: 'muted', textContent: `${when(n.at)} · ${n.author}` +
            (n.statusWords ? ` → ${n.statusWords}` : '') }),
          n.body ? el('div', { textContent: n.body }) : null));
      }
      body.append(thread);
    }

    const err = el('p', { className: 'iErr' });
    if (coordinator) {
      const status = el('select');
      for (const [v, label] of STATUS) status.append(new Option(label, v, false, v === it.status));
      const note = el('textarea', { rows: 3, maxLength: 5000,
        placeholder: 'Note for the reporter (they are emailed it with the status)' });
      const save = el('button', { type: 'button', className: 'primary', textContent: 'Save' });
      save.onclick = async () => {
        save.disabled = true;
        err.textContent = '';
        const res = await post('/api/issues/' + it.id,
          { status: status.value, note: note.value }, 'PATCH').catch(() => null);
        save.disabled = false;
        if (!res || !res.ok) {
          err.textContent = (res && (await res.json().catch(() => ({}))).error) || 'That didn\'t save.';
          return;
        }
        onChange();
      };
      body.append(el('div', { className: 'iForm' },
        el('label', { className: 'muted iHint', textContent: 'Status' }), status, note,
        el('div', {}, save,
          el('span', { className: 'muted iHint', textContent:
            '  The reporter is emailed the status and your note.' }))), err);
    } else if (['new', 'in_progress'].includes(it.status)) {
      // The reporter's own open report: add more detail, or close it.
      const note = el('textarea', { rows: 2, maxLength: 5000,
        placeholder: 'Add more detail or a comment for the coordinators' });
      const add = el('button', { type: 'button', className: 'primary', textContent: 'Add comment' });
      const close = el('button', { type: 'button', textContent: 'It\'s sorted — close it' });
      const send = async (closeIt) => {
        add.disabled = close.disabled = true;
        err.textContent = '';
        const res = await post(`/api/issues/${it.id}/comment`,
          { note: note.value, close: closeIt }).catch(() => null);
        add.disabled = close.disabled = false;
        if (!res || !res.ok) {
          err.textContent = (res && (await res.json().catch(() => ({}))).error) ||
            'That didn\'t go through — try again.';
          return;
        }
        onChange();
      };
      add.onclick = () => send(false);
      close.onclick = () => send(true);
      body.append(el('div', { className: 'iForm' }, note, el('div', { className: 'iBtns' }, add, close)), err);
    } else if (['fixed', 'done', 'wont_fix'].includes(it.status)) {
      const note = el('textarea', { rows: 2, maxLength: 5000,
        placeholder: 'What still isn\'t right? (optional)' });
      const again = el('button', { type: 'button', textContent: 'Still not fixed — reopen' });
      again.onclick = async () => {
        again.disabled = true;
        const res = await post(`/api/issues/${it.id}/reopen`, { note: note.value }).catch(() => null);
        again.disabled = false;
        if (!res || !res.ok) { err.textContent = 'That didn\'t go through — try again.'; return; }
        onChange();
      };
      body.append(el('div', { className: 'iForm' }, note, el('div', {}, again)), err);
    }
    if (manageLink) {
      body.append(el('p', { className: 'iManage' }, el('a', {
        href: 'ops.html#' + it.ref, textContent: 'Manage this on the Ops page →' })));
    }
    card.append(body);
    return card;
  }

  window.renderIssue = renderIssue;
})();
