// ---------- Login ----------
// Demo accounts: every user, click to fill the form (falls back to the owner when offline)
async function loadPersonas() {
  const { data } = await db.from('users').select('name, email, password, avatar_url, role').order('created_at');
  const users = data && data.length ? data : [{ ...USER, role: 'admin' }];
  $('personas').replaceChildren(...users.map((u) => {
    const b = el('button', 'persona');
    b.type = 'button';
    const avatar = el('span', 'avatar');
    fillAvatar(avatar, u);
    const info = el('span', 'persona-info');
    info.append(el('strong', null, displayName(u)), el('small', null, u.email));
    const role = el('span', 'badge' + (u.role === 'admin' ? ' admin' : ''), t(u.role === 'admin' ? 'roleAdmin' : 'roleUser'));
    b.append(avatar, info, role);
    b.addEventListener('click', () => { $('email').value = u.email; $('password').value = u.password; });
    return b;
  }));
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('email').value.trim().toLowerCase();
  const password = $('password').value;
  const btn = e.submitter;
  btn.disabled = true;

  const { data, error } = await db.from('users').select('id, name, email, avatar_url, role')
    .eq('email', email).eq('password', password).maybeSingle();
  btn.disabled = false;

  // Owner can still sign in with the default password if the users table is unreachable
  const user = data || (error && email === USER.email && password === USER.password ? { email } : null);
  if (user) {
    store.set('loggedIn', '1');
    store.set('user', JSON.stringify(user));
    $('loginMsg').textContent = '';
    net = 'online';
    updateWho();
    audit('login', 'session', null, null);
    location.hash = '#/notes';
    checkStatus();
  } else {
    $('loginMsg').textContent = error ? t('error') + error.message : t('badLogin');
    $('loginMsg').className = 'msg err';
  }
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

$('signout').addEventListener('click', () => {
  audit('logout', 'session', null, null);
  store.del('loggedIn');
  store.del('user');
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
  document.querySelectorAll('[data-enter]').forEach((a) => {
    a.href = loggedIn ? '#/notes' : '#/login';
    a.textContent = t(loggedIn ? 'openApp' : 'startNow');
  });

  if (!page) return show('landing');
  if (page === 'login') return loggedIn ? (location.hash = '#/notes') : (show('login'), loadPersonas());
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
