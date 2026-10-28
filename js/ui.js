// ---------- Password eye ----------
function syncEye(btn) {
  const shown = btn.previousElementSibling.type === 'text';
  btn.innerHTML = shown ? ICONS.eyeOff : ICONS.eye;
  btn.title = t(shown ? 'hidePw' : 'showPw');
  btn.setAttribute('aria-label', btn.title);
}
function addEye(input) {
  const wrap = el('div', 'pw-wrap');
  input.replaceWith(wrap);
  const btn = el('button', 'pw-eye');
  btn.type = 'button';
  btn.addEventListener('click', () => {
    input.type = input.type === 'password' ? 'text' : 'password';
    syncEye(btn);
  });
  wrap.append(input, btn);
}
addEye($('password'));
addEye($('newPassword'));

// ---------- Theme ----------
const isDark = () => {
  const set = document.documentElement.dataset.theme;
  return set ? set === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
};
function applyTheme() {
  document.querySelectorAll('[data-action="theme"]').forEach((b) => { b.innerHTML = isDark() ? ICONS.sun : ICONS.moon; });
}

// Mount toggles + static icons
document.querySelectorAll('[data-toggles]').forEach((slot) => slot.replaceWith($('togglesTpl').content.cloneNode(true)));
document.querySelectorAll('[data-icon]').forEach((el) => { el.innerHTML = ICONS[el.dataset.icon]; });
$('year').textContent = new Date().getFullYear();

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  if (btn.dataset.action === 'lang') {
    lang = lang === 'ar' ? 'en' : 'ar';
    store.set('lang', lang);
    applyLang();
  } else if (btn.dataset.action === 'theme') {
    const next = isDark() ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    store.set('theme', next);
    applyTheme();
  }
});

// ---------- Toasts ----------
// toast('text', 'ok' | 'warn' | 'err', { href, text })
function toast(text, kind = '', link) {
  const box = el('div', 'toast ' + kind);
  box.append(el('span', null, text));
  if (link) {
    const a = el('a', null, link.text);
    a.href = link.href;
    box.append(a);
  }
  $('toasts').append(box);
  setTimeout(() => box.remove(), 6500);
}

// ---------- Session / roles ----------
// True once the Supabase session is confirmed (see initAuth in app.js)
let authed = false;
const isLoggedIn = () => authed;

// Logged-in user's row { id, name, email, avatar_url, role, auth_id }, cached in localStorage for offline use
function currentUser() {
  try { return JSON.parse(store.get('user')) || { email: '' }; } catch { return { email: '' }; }
}
const isOwner = (email) => (email || '').toLowerCase() === OWNER_EMAIL;
const isAdmin = () => { const u = currentUser(); return u.role === 'admin' || isOwner(u.email); };
const isMe = (u) => u.email.toLowerCase() === currentUser().email.toLowerCase();
// The owner's default name is translated; a renamed owner shows the new name
const displayName = (u) => (isOwner(u.email) && (!u.name || u.name === 'Bishoy Saber') ? t('userName') : u.name || u.email);
const rawName = (u) => u.name || (isOwner(u.email) ? 'Bishoy Saber' : u.email);

function saveSession(u) {
  store.set('user', JSON.stringify(u));
  updateWho();
}

// Shows the user's photo inside an .avatar element, or their first letter
function fillAvatar(el, u) {
  el.textContent = '';
  if (u.avatar_url) {
    const img = document.createElement('img');
    img.src = u.avatar_url;
    img.alt = '';
    el.append(img);
  } else {
    el.textContent = displayName(u).charAt(0).toUpperCase();
  }
}

function updateWho() {
  const u = currentUser();
  $('whoName').textContent = displayName(u);
  fillAvatar($('whoInitial'), u);
}

// Re-reads the signed-in user's row (role, photo...) once the server is reachable
async function refreshMe() {
  if (net !== 'online') return;
  const { data, error } = await db.from('users').select(USER_COLS).eq('id', currentUser().id).maybeSingle();
  if (error) return;
  if (!data) { await dropSession(); setText('loginMsg', t('noAccount'), 'err'); location.hash = '#/login'; return render(); } // row removed
  const wasAdmin = isAdmin();
  saveSession(data);
  if (wasAdmin !== isAdmin()) { buildNav(); render(); }
}

// ---------- Connection status ----------
let net = navigator.onLine ? 'online' : 'offline'; // online | offline | unreachable
const isNetErr = (e) => /fetch|network|timeout|load failed/i.test((e && e.message) || '');

function updateConn() {
  document.querySelectorAll('.conn-dot').forEach((d) => { d.className = 'conn-dot ' + net; d.title = t('conn_' + net); });
  $('connText').textContent = t('conn_' + net);
}

async function checkStatus() {
  if (!isLoggedIn()) return;
  let s = 'online';
  if (!navigator.onLine) {
    s = 'offline';
  } else {
    const ping = db.from('users').select('id').limit(1);
    const timeout = new Promise((r) => setTimeout(() => r({ error: { message: 'timeout' } }), 6000));
    const res = await Promise.race([ping, timeout]).catch((error) => ({ error }));
    if (res.error && isNetErr(res.error)) s = 'unreachable';
  }
  net = s;
  updateConn();
  if (s === 'online') syncNow();
}
window.addEventListener('online', checkStatus);
window.addEventListener('offline', checkStatus);
setInterval(checkStatus, 20000);
