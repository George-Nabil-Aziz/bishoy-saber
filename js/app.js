// ---------- Login (Supabase Auth) ----------
// supabase-js keeps the session in localStorage; the user's row is cached under "user" so the app opens offline
const USER_COLS = 'id, name, email, avatar_url, role, auth_id';
const authKeys = () => { try { return Object.keys(localStorage).filter((k) => /^sb-.*-auth-token/.test(k)); } catch { return []; } };

// Signs out locally (works offline) and forgets the cached user and lists
async function dropSession() {
  authed = false;
  try { await db.auth.signOut({ scope: 'local' }); } catch {}
  try {
    authKeys().forEach((k) => localStorage.removeItem(k));
    Object.keys(localStorage).filter((k) => k.startsWith('cache:')).forEach((k) => localStorage.removeItem(k));
  } catch {}
  store.del('user');
  store.del('loggedIn');
}

// Loads the signed-in user's row and opens the app; returns an error text, or null when in
async function enterSession(session) {
  let r;
  try { r = await db.from('users').select(USER_COLS).eq('auth_id', session.user.id).maybeSingle(); } catch (error) { r = { error }; }
  let row = r.data;
  if (r.error) {
    const old = currentUser();
    if (isNetErr(r.error) && old.auth_id === session.user.id) row = old; // offline: use the cached row
    else { await dropSession(); return isNetErr(r.error) ? t('conn_unreachable') : t('error') + r.error.message; }
  } else if (!row) {
    await dropSession();
    return t('noAccount');
  }
  authed = true;
  saveSession(row);
  return null;
}

// Runs once at start: restores the session (no network needed) before the first render
async function initAuth() {
  store.del('loggedIn'); // left over from the old fake login
  let session = null;
  try { session = (await db.auth.getSession()).data.session; } catch {}
  if (recovering && session) return; // render() shows the new-password form
  const cached = currentUser();
  if (session && cached.auth_id === session.user.id) authed = true; // refreshMe() re-checks the row once online
  else if (session) {
    const err = await enterSession(session);
    if (err) setText('loginMsg', err, 'err');
  } else if (!navigator.onLine && cached.auth_id && authKeys().length) authed = true; // offline with an expired token
  else if (cached.auth_id) await dropSession();
}

db.auth.onAuthStateChange((event) => {
  if (event === 'PASSWORD_RECOVERY') { recovering = true; setTimeout(() => render()); }
  else if (event === 'SIGNED_OUT' && authed) setTimeout(async () => { await dropSession(); location.hash = '#/login'; render(); }); // e.g. signed out in another tab
});

// The login page shows either the sign-in form or the new-password form
const showAuthForm = (which) => { $('loginForm').classList.toggle('hidden', which !== 'login'); $('resetForm').classList.toggle('hidden', which !== 'reset'); };

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  setText('loginMsg', '');
  const { data, error } = await db.auth.signInWithPassword({ email: $('email').value.trim().toLowerCase(), password: $('password').value });
  const err = error ? (error.status === 400 ? t('badLogin') : t('error') + error.message) : await enterSession(data.session);
  btn.disabled = false;
  if (err) return setText('loginMsg', err, 'err');
  net = 'online';
  updateWho();
  audit('login', 'session', null, null);
  location.hash = '#/notes';
  checkStatus();
});

$('forgotBtn').addEventListener('click', async () => {
  const email = $('email').value.trim().toLowerCase();
  if (!email) return setText('loginMsg', t('enterEmail'), 'err');
  const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
  setText('loginMsg', error ? t('error') + error.message : t('resetSent'), error ? 'err' : 'ok');
});

// Opened from the reset email: the link already signed the user in, they only pick a new password
$('resetForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { error } = await db.auth.updateUser({ password: $('newPassword').value });
  if (error) return setText('resetMsg', t('error') + error.message, 'err');
  const { data } = await db.auth.getSession();
  const err = data.session ? await enterSession(data.session) : t('badLogin');
  recovering = false;
  $('resetForm').reset();
  setText('resetMsg', '');
  if (err) setText('loginMsg', err, 'err');
  else { net = 'online'; audit('password.reset', 'session', null, null); checkStatus(); }
  history.replaceState(null, '', err ? '#/login' : '#/notes');
  render();
});

// Mobile: the sidebar is a slide-in drawer
const setSidebar = (open) => {
  $('app').classList.toggle('sidebar-open', open);
  $('menuBtn').setAttribute('aria-expanded', open);
};
$('menuBtn').addEventListener('click', () => setSidebar(!$('app').classList.contains('sidebar-open')));
$('sidebarBackdrop').addEventListener('click', () => setSidebar(false));
$('nav').addEventListener('click', (e) => { if (e.target.closest('a')) setSidebar(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setSidebar(false); });

$('signout').addEventListener('click', async () => {
  await audit('logout', 'session', null, null); // while the session still exists
  await dropSession();
  $('loginForm').reset();
  location.hash = '#/';
});

// ---------- Navigation (differs per role) ----------
const NAVS = { admin: ['notes', 'users', 'history', 'sync', 'whatsNew', 'profile', 'install'], user: ['notes', 'profile', 'sync', 'install'] };
// Admins change any note; a user only the notes they created
const canEditNote = (n) => isAdmin() || (!!n.created_by && n.created_by.toLowerCase() === currentUser().email.toLowerCase());
const NAV_ICON = { notes: 'file', users: 'users', history: 'clock', sync: 'sync', whatsNew: 'star', profile: 'user', install: 'download' };
let curNav = null;

function buildNav() {
  const nav = $('nav');
  nav.innerHTML = '';
  for (const k of NAVS[isAdmin() ? 'admin' : 'user']) {
    const a = el('a');
    a.href = '#/' + (k === 'whatsNew' ? 'whats-new' : k);
    a.dataset.nav = k;
    a.title = t(k);
    a.classList.toggle('active', k === curNav);
    a.append(el('span'), el('span', 'nav-label', t(k)));
    a.firstChild.innerHTML = ICONS[NAV_ICON[k]];
    if (k === 'sync') a.append(el('span', 'count'));
    nav.append(a);
  }
  refreshPending();
}

// ---------- Routing ----------
// #/notes, #/notes/new, #/notes/edit/<id>, #/notes/view/<id>, #/users, #/users/new, #/users/edit/<id>,
// #/history, #/sync, #/profile, #/whats-new, #/install
let curSection = null, curRun = null;
const SECTIONS = ['notes', 'editor', 'viewer', 'users', 'userEditor', 'history', 'sync', 'profile', 'whatsNew', 'install'];
const SECTION_NAV = { notes: 'notes', editor: 'notes', viewer: 'notes', users: 'users', userEditor: 'users', history: 'history', sync: 'sync', profile: 'profile', whatsNew: 'whatsNew', install: 'install' };

function show(view) {
  for (const v of ['landing', 'login', 'app']) $(v).classList.toggle('hidden', v !== view);
  window.scrollTo(0, 0);
  document.querySelector('main').scrollTop = 0; // the app's content scrolls inside <main>
}

function render() {
  const [, page, sub, id] = location.hash.split('/');
  const loggedIn = isLoggedIn();
  if (recovering) return (show('login'), showAuthForm('reset'));
  document.querySelectorAll('[data-enter]').forEach((a) => {
    a.href = loggedIn ? '#/notes' : '#/login';
    a.textContent = t(loggedIn ? 'openApp' : 'startNow');
  });

  if (!page) return show('landing');
  if (page === 'login') return loggedIn ? (location.hash = '#/notes') : (show('login'), showAuthForm('login'));
  if (!loggedIn) return (location.hash = '#/login');

  const admin = isAdmin();
  let sec = null, run = null;
  const route = (s, r) => { sec = s; run = r; };
  if (page === 'notes') {
    if (!sub) route('notes', loadNotes);
    else if (sub === 'view' && id) route('viewer', () => openView(id));
    else if (sub === 'new') route('editor', openAdd);
    else if (sub === 'edit' && id) route('editor', () => openEdit(id));
  } else if (admin && page === 'users') {
    if (!sub) route('users', loadUsers);
    else if (sub === 'new') route('userEditor', () => openUserEditor(null));
    else if (sub === 'edit' && id) route('userEditor', () => openUserEditor(id));
  } else if (admin && page === 'history') route('history', loadHistory);
  else if (page === 'sync') route('sync', renderSync);
  else if (page === 'profile') route('profile', loadProfile);
  else if (page === 'install') route('install', renderInstall);
  else if (admin && page === 'whats-new') route('whatsNew', renderNews);
  // Unknown pages, and admin pages for a normal user, go to Notes
  if (!sec) return (location.hash = '#/notes');

  show('app');
  curSection = sec;
  curRun = run;
  curNav = SECTION_NAV[sec];
  for (const s of SECTIONS) $(s).classList.toggle('hidden', s !== sec);
  buildNav(); // sets the active item and the pending count
  run();
}

window.addEventListener('hashchange', (e) => {
  // In-page anchor links like #features: scroll, don't route
  if (location.hash && !location.hash.startsWith('#/')) {
    const target = document.querySelector(location.hash);
    history.replaceState(null, '', new URL(e.oldURL).hash || '#/');
    if (target) target.scrollIntoView({ behavior: 'smooth' });
    return;
  }
  render();
});

// ---------- Shared table helpers ----------
const setText = (id, text, cls = '') => { $(id).textContent = text; $(id).className = 'msg ' + cls; };
const pendingBadge = () => el('span', 'badge pending', t('pending'));

// cols: [{ h: i18nKey, cls, cell(row, tr) -> Node | string }]
function makeTable(cols, rows, emptyKey) {
  const wrap = el('div', 'table-wrap');
  const table = el('table');
  const head = el('tr');
  for (const c of cols) head.append(el('th', c.cls, c.h ? t(c.h) : ''));
  table.createTHead().append(head);
  const body = table.createTBody();
  if (!rows.length) {
    const td = el('td', 'empty-row', t(emptyKey));
    td.colSpan = cols.length;
    body.insertRow().append(td);
  }
  for (const r of rows) {
    const tr = body.insertRow();
    if (r._pending === 'delete') tr.className = 'is-deleted';
    for (const c of cols) {
      const td = el('td', c.cls);
      const v = c.cell(r, tr);
      if (v instanceof Node) td.append(v);
      else td.textContent = v == null || v === '' ? '—' : v;
      tr.append(td);
    }
  }
  wrap.append(table);
  return wrap;
}

const actions = (...btns) => { const d = el('div'); d.append(...btns.filter(Boolean)); return d; };
function iconLink(href, icon, titleKey) {
  const a = el('a', 'icon-btn edit');
  a.href = href; a.title = t(titleKey); a.innerHTML = ICONS[icon];
  return a;
}
function iconBtn(icon, titleKey, cls, onclick) {
  const b = el('button', 'icon-btn ' + cls);
  b.type = 'button'; b.title = t(titleKey); b.innerHTML = ICONS[icon];
  b.addEventListener('click', onclick);
  return b;
}

// First click arms the button ("Sure?") and returns false; second click within 3s returns true
function confirmed(btn) {
  if (!btn.classList.contains('confirm')) {
    btn.classList.add('confirm');
    btn.textContent = t('confirmDel');
    btn._timer = setTimeout(() => { btn.classList.remove('confirm'); btn.innerHTML = ICONS.trash; }, 3000);
    return false;
  }
  clearTimeout(btn._timer);
  return true;
}

// Loads a list from the server (and caches it); when unreachable falls back to the saved copy
async function cached(key, run) {
  if (net === 'online') {
    try {
      const { data, error } = await run();
      if (!error) { cacheSet(key, data); return { data }; }
      if (!isNetErr(error)) return { error };
    } catch {}
  }
  const c = cacheGet(key);
  return c ? { data: c, stale: true } : { error: { message: t('conn_' + (net === 'online' ? 'unreachable' : net)) } };
}

// Name for an email, from the cached users list
function nameOf(email) {
  if (!email) return '—';
  const u = [...(cacheGet('users') || []), ...(cacheGet('names') || [])].find((x) => x.email.toLowerCase() === email.toLowerCase());
  return u ? displayName(u) : email;
}
