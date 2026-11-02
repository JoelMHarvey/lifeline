'use strict';

// Shared side menu, so the same navigation follows you onto every page.
// Include with <script src="nav.js"> right after <body>: it inserts the menu
// synchronously (no flash of a menu-less page), then reveals the role-gated
// links once /api/me answers. On wide screens it is a fixed column down the
// left; on phone-width screens it falls back to a bar across the top.
// window.tellNav.refresh() re-reads /api/me (the console calls it after an
// in-page login); window.tellNav.setUnread(n) updates the noticeboard count.
// Signed-in people also get "Report a problem" (a small form that files a
// TL-#### report with the page they're on) and "My problem reports".

(() => {
  const PAGES = [
    // href, label, minimum role (null = everyone), module (null = core)
    ['console.html', 'Console', null, 'helpline'],
    ['schedule.html', 'Schedule', null, 'schedule'],
    ['board.html', 'Noticeboard', null, 'board'],
    ['wallboard.html', 'Wallboard', 'supervisor', 'helpline'],
    ['review.html', 'Review', 'supervisor', 'helpline'],
    ['reports.html', 'Reports', 'supervisor', 'helpline'],
    ['resources.html', 'Resources', null, 'helpline'],
    ['admin.html', 'Admin', 'coordinator'],
    ['ops.html', 'Ops', 'coordinator'],
    ['help.html', 'Help', null],
    ['profile.html', 'My profile', null],
  ];
  const RANK = { trainee: 0, worker: 1, supervisor: 2, coordinator: 3 };
  const here = location.pathname.split('/').pop() || 'index.html';
  // Pages reached from another page's menu entry light that entry up.
  const PARENT = { 'canned.html': 'admin.html' };
  // Pages that belong to a module, beyond those in the menu. console.html is
  // also the sign-in page, so it is never redirected away from here — it
  // sends people on after they sign in.
  const PAGE_MODULE = Object.fromEntries(PAGES.filter((p) => p[3]).map((p) => [p[0], p[3]]));
  Object.assign(PAGE_MODULE, { 'canned.html': 'helpline', 'caller.html': 'helpline', 'console.html': null });

  const nav = document.createElement('nav');
  nav.className = 'sidenav';
  const link = (href, label) => {
    const a = document.createElement('a');
    a.href = href; a.textContent = label;
    if (href === here || href === PARENT[here]) a.className = 'current';
    return a;
  };
  const brand = link('console.html', '{{name}}');
  brand.className = 'brand';
  nav.appendChild(brand);
  // Phones: the links fold away behind a Menu button so a page starts with
  // its own content, not a screenful of navigation.
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'navToggle';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.textContent = '☰ Menu';
  toggle.onclick = () => {
    const open = nav.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = open ? '✕ Close' : '☰ Menu';
  };
  nav.appendChild(toggle);
  const links = document.createElement('div');
  links.className = 'navlinks';
  for (const [href, label, minRole, mod] of PAGES) {
    const a = link(href, label);
    if (minRole) { a.dataset.minRole = minRole; a.style.display = 'none'; }
    if (mod) a.dataset.module = mod;
    links.appendChild(a);
  }
  // Hide what this installation doesn't run, and leave a page whose module
  // is off for the schedule (the scheduler-only install's home).
  const applyModules = (mods) => {
    if (!Array.isArray(mods)) return;
    for (const a of links.querySelectorAll('a[data-module]')) {
      if (!mods.includes(a.dataset.module)) { a.remove(); }
    }
    if (!mods.includes('helpline')) brand.href = mods.includes('schedule') ? 'schedule.html' : 'profile.html';
    const mod = PAGE_MODULE[here];
    if (mod && !mods.includes(mod)) location.replace(mods.includes('schedule') ? 'schedule.html' : 'profile.html');
  };
  fetch('/api/modules').then((r) => (r.ok ? r.json() : null))
    .then((d) => d && applyModules(d.modules)).catch(() => {});
  nav.appendChild(links);
  const foot = document.createElement('div');
  foot.className = 'navfoot';
  const who = document.createElement('span');
  who.className = 'badge'; who.style.display = 'none';
  const out = link('#', 'Log out');
  out.style.display = 'none';
  out.onclick = async (e) => {
    e.preventDefault();
    await fetch('/api/logout', { method: 'POST' }).catch(() => {});
    location.href = 'console.html';
  };
  const login = link('console.html', 'Log in');
  login.style.display = 'none';
  const report = document.createElement('button');
  report.type = 'button';
  report.className = 'reportBtn';
  report.textContent = 'Report a problem';
  report.style.display = 'none';
  report.onclick = openReport;
  const mine = link('issues.html', 'My problem reports');
  mine.style.display = 'none';
  foot.append(report, mine, who, out, login);
  nav.appendChild(foot);
  document.documentElement.classList.add('has-sidenav');
  document.body.prepend(nav);

  const setUnread = (n) => {
    const a = links.querySelector('a[href="board.html"]');
    if (a) a.textContent = n > 0 ? `Noticeboard (${n})` : 'Noticeboard';
  };

  async function refresh() {
    try {
      const res = await fetch('/api/me');
      if (!res.ok) {
        // Not logged in (e.g. reading Help): just offer the way in.
        who.style.display = out.style.display = 'none';
        report.style.display = mine.style.display = 'none';
        login.style.display = here === 'console.html' ? 'none' : 'block';
        return;
      }
      const me = await res.json();
      who.textContent = `${me.name} (${me.role})`;
      who.style.display = 'inline-block';
      out.style.display = 'block';
      login.style.display = 'none';
      report.style.display = 'block';
      mine.style.display = 'block';
      applyModules(me.modules);
      for (const a of links.querySelectorAll('a[data-min-role]')) {
        a.style.display = RANK[me.role] >= RANK[a.dataset.minRole] ? '' : 'none';
      }
      if (!me.modules || me.modules.includes('board')) {
        const r = await (await fetch('/api/board/unread')).json().catch(() => ({ unread: 0 }));
        setUnread(r.unread);
      }
    } catch { /* nav stays usable without /api/me */ }
  }

  // The report form: built on first use, files to /api/issues with the page
  // and browser attached, and answers with the TL-#### reference.
  let dlg = null;
  function openReport() {
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.className = 'reportDlg';
      dlg.innerHTML = `
        <form method="dialog">
          <h2>Report a problem or ask for something</h2>
          <p class="muted">Goes to the coordinators. Please don't include caller details.</p>
          <div class="rRow">
            <label>What is it?
              <select name="kind">
                <option value="bug">Something isn't working</option>
                <option value="request">A request or idea</option>
                <option value="question">A question</option>
              </select></label>
            <label class="rSev">How much does it get in the way?
              <select name="severity">
                <option value="normal">It's a nuisance</option>
                <option value="blocking">I can't do my job</option>
                <option value="minor">Minor</option>
              </select></label>
          </div>
          <label>Short title
            <input name="title" maxlength="140" required
              placeholder="e.g. The Take it button does nothing on my phone"></label>
          <label>Details
            <textarea name="body" rows="6" maxlength="5000"
              placeholder="What did you do, what did you expect, and what happened instead?"></textarea></label>
          <p class="muted rPage"></p>
          <p class="rErr"></p>
          <div class="rFoot">
            <button type="button" value="cancel" class="rCancel">Cancel</button>
            <button type="submit" class="primary">Send report</button>
          </div>
        </form>
        <div class="rDone" hidden>
          <h2>Thank you</h2>
          <p>Your reference is <strong class="rRef"></strong>. You'll get an email when
            it's updated, and you can follow it under <a href="issues.html">My problem reports</a>.</p>
          <div class="rFoot"><button type="button" class="primary rClose">Close</button></div>
        </div>`;
      document.body.append(dlg);
      const form = dlg.querySelector('form');
      const kind = form.elements.kind;
      kind.onchange = () => {
        dlg.querySelector('.rSev').style.display = kind.value === 'bug' ? '' : 'none';
      };
      dlg.querySelector('.rCancel').onclick = () => dlg.close();
      dlg.querySelector('.rClose').onclick = () => dlg.close();
      form.onsubmit = async (e) => {
        e.preventDefault();
        const send = form.querySelector('button[type=submit]');
        send.disabled = true;
        const err = dlg.querySelector('.rErr');
        err.textContent = '';
        try {
          const res = await fetch('/api/issues', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              kind: kind.value,
              severity: kind.value === 'bug' ? form.elements.severity.value : 'normal',
              title: form.elements.title.value,
              body: form.elements.body.value,
              page: location.pathname + location.search,
              client: `${navigator.userAgent} · ${innerWidth}×${innerHeight}`,
            }),
          });
          const r = await res.json().catch(() => ({}));
          if (!res.ok) { err.textContent = r.error || 'That didn\'t send — try again.'; return; }
          dlg.querySelector('.rRef').textContent = r.ref;
          form.hidden = true;
          dlg.querySelector('.rDone').hidden = false;
        } catch {
          err.textContent = 'That didn\'t send — check the connection and try again.';
        } finally {
          send.disabled = false;
        }
      };
    }
    const form = dlg.querySelector('form');
    form.reset();
    form.elements.kind.onchange();
    form.hidden = false;
    dlg.querySelector('.rDone').hidden = true;
    dlg.querySelector('.rErr').textContent = '';
    dlg.querySelector('.rPage').textContent = `Page: ${location.pathname.replace(/^\//, '') || 'home'}` +
      ' — this and your browser details are attached.';
    dlg.showModal();
  }

  window.tellNav = { refresh, setUnread, openReport };
  refresh();
})();
