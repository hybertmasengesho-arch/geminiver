// nav.js — injects the shared top bar into #siteNav on every page,
// guards pages that require login, handles the dark/light toggle, and pops
// up any unread admin messages as toasts.
(function () {
  function getToken() { return localStorage.getItem('rh_token'); }

  // Small HTML-escape helper — user.name is editable via the profile form,
  // so (unlike the mostly-format-checked email) it needs escaping before
  // being dropped into innerHTML.
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  async function fetchMe() {
    const token = getToken();
    if (!token) return null;
    try {
      const res = await fetch('/api/auth/me', { headers: { Authorization: 'Bearer ' + token } });
      if (!res.ok) return null;
      const data = await res.json();
      return data.user;
    } catch (e) { return null; }
  }

  /* ---------------- dark mode ---------------- */

  function getTheme() { return localStorage.getItem('rh_theme') === 'dark' ? 'dark' : 'light'; }

  function applyTheme(theme) {
    if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
  }

  function toggleTheme() {
    const next = getTheme() === 'dark' ? 'light' : 'dark';
    localStorage.setItem('rh_theme', next);
    applyTheme(next);
    const btn = document.getElementById('hubThemeToggle');
    if (btn) btn.textContent = next === 'dark' ? '☀' : '☾';
  }

  /* ---------------- admin message toasts ---------------- */

  function ensureToastWrap() {
    let wrap = document.getElementById('hubToastWrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'hubToastWrap';
      wrap.className = 'hub-toast-wrap';
      document.body.appendChild(wrap);
    }
    return wrap;
  }

  function showToast(msg, token) {
    const wrap = ensureToastWrap();
    const el = document.createElement('div');
    el.className = 'hub-toast';
    const title = msg.sender_role === 'admin' ? 'Message from admin' : 'Message from ' + (msg.sender_name || 'a teammate');
    el.innerHTML =
      '<button class="hub-toast-close" aria-label="Dismiss">✕</button>' +
      '<div class="hub-toast-title"></div>' +
      '<div class="hub-toast-body"></div>' +
      (msg.sender_id ? '<button class="hub-toast-reply">↩ Reply</button>' : '');
    el.querySelector('.hub-toast-title').textContent = title;
    el.querySelector('.hub-toast-body').textContent = msg.body; // textContent, not innerHTML — avoids XSS from message content
    el.querySelector('.hub-toast-close').addEventListener('click', function () {
      el.remove();
      fetch('/api/messages/' + msg.id + '/read', { method: 'POST', headers: { Authorization: 'Bearer ' + token } }).catch(function () {});
    });
    var replyBtn = el.querySelector('.hub-toast-reply');
    if (replyBtn) {
      replyBtn.addEventListener('click', function () {
        fetch('/api/messages/' + msg.id + '/read', { method: 'POST', headers: { Authorization: 'Bearer ' + token } }).catch(function () {});
        window.location.href = '/messages.html?to=' + msg.sender_id;
      });
    }
    wrap.appendChild(el);
  }

  async function checkMessages(token) {
    try {
      const res = await fetch('/api/messages/unread', { headers: { Authorization: 'Bearer ' + token } });
      if (!res.ok) return;
      const data = await res.json();
      (data.messages || []).forEach(function (m) { showToast(m, token); });
      var msgLink = document.querySelector('.hub-nav-links a[href="/messages.html"]');
      if (msgLink) msgLink.classList.toggle('has-unread', (data.messages || []).length > 0);
    } catch (e) { /* silent — a missed popup isn't worth surfacing an error for */ }
  }

  /* ---------------- nav bar ---------------- */

  function render(user, activePage) {
    const mount = document.getElementById('siteNav');
    if (!mount) return;
    const links = [
      { href: '/dashboard.html', label: 'Home', key: 'home' },
      { href: '/courses.html', label: 'Courses', key: 'courses' },
      { href: '/exercises.html', label: 'Exercises', key: 'exercises' },
      { href: '/notes.html', label: 'Notes', key: 'notes' },
      { href: '/reader.html', label: 'Reader', key: 'reader' },
      { href: '/messages.html', label: 'Messages', key: 'messages' }
    ];
    // Related pages are grouped into one dropdown button instead of each
    // getting its own top-level slot — keeps the bar to one line instead of
    // wrapping into a second row of pills.
    const filesGroup = [
      { href: '/files.html', label: 'My Files', key: 'files' },
      { href: '/public-files.html', label: 'Public Files', key: 'public-files' }
    ];
    // matrix/reasoning/prep30 pages still pass their own key (e.g. 'matrix')
    // as activePage — treat those as "Courses" for nav highlighting since
    // they no longer have their own top-level link.
    if (['matrix', 'reasoning', 'prep30'].indexOf(activePage) !== -1) activePage = 'courses';
    const manageGroup = [];
    if (user && user.role === 'admin') manageGroup.push({ href: '/admin.html', label: 'Admin', key: 'admin' });
    if (user && (user.role === 'admin' || user.role === 'facilitator')) manageGroup.push({ href: '/content.html', label: 'Content', key: 'content' });

    function dropdown(id, label, items) {
      const isActive = items.some(function (i) { return i.key === activePage; });
      return (
        '<div class="hub-nav-dropdown">' +
          '<button type="button" class="hub-nav-dropdown-btn' + (isActive ? ' active' : '') + '" data-dropdown="' + id + '">' + label + ' ▾</button>' +
          '<div class="hub-nav-dropdown-menu" id="dd-' + id + '">' +
            items.map(function (l) {
              return '<a href="' + l.href + '" class="' + (l.key === activePage ? 'active' : '') + '">' + l.label + '</a>';
            }).join('') +
          '</div>' +
        '</div>'
      );
    }

    // Links + user info live inside a collapsible panel on narrow screens
    // (see theme.css @media rule) so the top bar stays one short row on
    // phones instead of wrapping into a tall stack of pills.
    // Teams now lives as a small "T" chip right next to My Account instead
    // of taking its own full-width slot in the link row.
    // Name shown in the bar: prefer the profile name, fall back to the
    // email's local part (before @) if no name has been set.
    var displayName = user ? (user.name && user.name.trim() ? user.name.trim() : (user.email || '').split('@')[0]) : '';

    // Mobile-only layout: menu, "Reasoning Hub", and the Account icon
    // cluster on the left; "Team" (as a text label, not an icon) pinned to
    // the right with a small flexible gap between the two groups — see the
    // max-width:760px block in theme.css for the actual positions (flex
    // `order`), since this markup order doesn't matter once that applies.
    mount.innerHTML =
      '<div class="hub-nav-inner">' +
        '<button id="hubNavToggle" class="hub-nav-toggle" type="button" aria-label="Toggle menu" aria-expanded="false">☰</button>' +
        '<a class="hub-nav-brand" href="/dashboard.html">Reasoning Hub</a>' +
        (user ? '<a class="hub-nav-quick-btn qa-account' + (activePage === 'account' ? ' active' : '') + '" href="/account.html" title="My Account" aria-label="My Account">👤</a>' : '') +
        (user ? '<a class="hub-nav-quick-team-text' + (activePage === 'teams' ? ' active' : '') + '" href="/teams.html">Team</a>' : '') +
        '<div class="hub-nav-collapse" id="hubNavCollapse">' +
          '<div class="hub-nav-links">' +
            links.map(function (l) {
              return '<a href="' + l.href + '" class="' + (l.key === activePage ? 'active' : '') + '">' + l.label + '</a>';
            }).join('') +
            dropdown('files', 'Files', filesGroup) +
            (manageGroup.length ? dropdown('manage', 'Manage', manageGroup) : '') +
          '</div>' +
          '<div class="hub-nav-user">' +
            '<button id="hubThemeToggle" type="button" aria-label="Toggle dark mode">' + (getTheme() === 'dark' ? '☀' : '☾') + '</button>' +
            (user ? (
              '<a class="hub-nav-account' + (activePage === 'account' ? ' active' : '') + '" href="/account.html" title="My Account">My Account</a>' +
              '<a class="hub-nav-team-btn' + (activePage === 'teams' ? ' active' : '') + '" href="/teams.html" title="Teams">👥 Team</a>' +
              '<span class="hub-nav-email" title="' + escapeHtml(user.email) + '">' + escapeHtml(displayName) + (user.role === 'admin' ? ' <em>admin</em>' : '') + '</span><button id="hubLogoutBtn">Log out</button>'
            ) : '<a href="/login.html">Log in</a>') +
          '</div>' +
        '</div>' +
      '</div>';

    var logoutBtn = document.getElementById('hubLogoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', function () {
        localStorage.removeItem('rh_token');
        location.href = '/logout.html';
      });
    }
    var themeBtn = document.getElementById('hubThemeToggle');
    if (themeBtn) themeBtn.addEventListener('click', toggleTheme);

    // Dropdown groups (Files / Manage) — click to open, click elsewhere to close.
    mount.querySelectorAll('.hub-nav-dropdown-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var menu = document.getElementById('dd-' + btn.getAttribute('data-dropdown'));
        var willOpen = !menu.classList.contains('open');
        mount.querySelectorAll('.hub-nav-dropdown-menu.open').forEach(function (m) { m.classList.remove('open'); });
        if (willOpen) menu.classList.add('open');
      });
    });
    document.addEventListener('click', function () {
      mount.querySelectorAll('.hub-nav-dropdown-menu.open').forEach(function (m) { m.classList.remove('open'); });
    });

    var navToggle = document.getElementById('hubNavToggle');
    var navCollapse = document.getElementById('hubNavCollapse');
    if (navToggle && navCollapse) {
      navToggle.addEventListener('click', function () {
        var open = navCollapse.classList.toggle('open');
        navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      // Tapping a link closes the menu so it doesn't stay open across navigation.
      navCollapse.querySelectorAll('a').forEach(function (a) {
        a.addEventListener('click', function () { navCollapse.classList.remove('open'); navToggle.setAttribute('aria-expanded', 'false'); });
      });
    }
  }

  /* ---------------- floating study helper launcher ---------------- */
  // A small round button pinned to the bottom-right corner of the screen —
  // separate from the nav bar entirely, so it never competes for space
  // there. It hides itself while the chat panel is open (the panel has its
  // own close button), and reappears the moment the panel closes, so
  // there's always exactly one obvious way to open or dismiss the helper.
  function ensureFloatingLauncher() {
    if (document.getElementById('hubHelperLauncher')) return;
    var btn = document.createElement('button');
    btn.id = 'hubHelperLauncher';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Open study helper');
    btn.title = 'Study helper';
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M12 2c.6 4.9 2.1 6.9 7.5 7.5-5.4.6-6.9 2.6-7.5 7.5-.6-4.9-2.1-6.9-7.5-7.5C9.9 8.9 11.4 6.9 12 2z"/><path d="M19 15.5c.25 2 .85 2.75 2.85 3-2 .25-2.6 1-2.85 3-.25-2-.85-2.75-2.85-3 2-.25 2.6-1 2.85-3z"/></svg>';
    btn.addEventListener('click', toggleAssistant);
    document.body.appendChild(btn);
  }

  /* ---------------- study assistant, opened on demand ---------------- */
  // No more floating on-screen circle — the study helper only exists once
  // someone taps the 💬 button in the top nav. Its script loads lazily on
  // that first tap (instead of on every page load) since most visits never
  // touch it; see public/js/study-helper.js for the widget itself.

  function loadScriptOnce(src) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[src="' + src + '"]')) return resolve();
      var s = document.createElement('script');
      s.src = src;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('Could not load ' + src)); };
      document.body.appendChild(s);
    });
  }

  var assistantLoading = null;
  function ensureAssistantLoaded() {
    if (window.StudyHelper) return Promise.resolve();
    if (!assistantLoading) {
      assistantLoading = loadScriptOnce('/js/screenshare.js')
        .then(function () { return loadScriptOnce('/js/study-helper.js'); })
        .catch(function (e) { assistantLoading = null; throw e; });
    }
    return assistantLoading;
  }

  async function toggleAssistant() {
    var btn = document.getElementById('hubHelperLauncher');
    if (btn) btn.disabled = true;
    try {
      await ensureAssistantLoaded();
      if (window.StudyHelper) window.StudyHelper.toggle();
      else console.error('[nav] StudyHelper script loaded but window.StudyHelper is missing.');
    } catch (e) {
      // widget is a nice-to-have — a failed load shouldn't break the page,
      // but log it loudly so it's obvious in the console instead of the
      // button silently doing nothing.
      console.error('[nav] study helper failed to load:', e);
    }
    if (btn) btn.disabled = false;
  }

  window.HubNav = {
    // Call once per page. requireAuth=true redirects to /login.html if not signed in.
    init: async function (activePage, requireAuthFlag) {
      applyTheme(getTheme());
      const user = await fetchMe();
      if (requireAuthFlag && !user) {
        // Includes the query string too (not just the path) — so a scanned
        // QR/share-code link (e.g. /redeem.html?code=ABCD1234) still works
        // right after logging in, instead of losing the code.
        const next = encodeURIComponent(location.pathname + location.search);
        location.href = '/login.html?next=' + next;
        return null;
      }
      render(user, activePage);
      if (user) {
        ensureFloatingLauncher();
        var token = getToken();
        if (token) checkMessages(token);
      }
      return user;
    }
  };
})();
