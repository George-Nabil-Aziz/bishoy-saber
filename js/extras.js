// ---------- What's new ----------
function renderNews() {
  $('newsList').replaceChildren(...t('news').map((n) => {
    const li = el('li');
    li.append(el('div', 'date', formatDate(n.d)), el('h3', null, n.h), el('p', null, n.p));
    return li;
  }));
}

// ---------- Install app (PWA) ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

let installPrompt = null;
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
let appInstalled = isStandalone;
const setI18n = (node, key) => { node.dataset.i18n = key; node.textContent = t(key); };
function showInstallBar(ios) {
  if (isStandalone || store.get('installDismissed') === '1') return;
  setI18n($('installHint'), ios ? 'installIos' : 'installHint');
  $('installBtn').classList.toggle('hidden', ios);
  $('installBar').classList.remove('hidden');
}
// Mobile app page: always available, even after the bar was closed
function renderInstall() {
  const key = appInstalled ? 'installDone' : installPrompt ? 'installHint' : isIos ? 'installIos' : 'installMenu';
  setI18n($('installState'), key);
  $('installBtn2').classList.toggle('hidden', !installPrompt || appInstalled);
}
async function installApp() {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  $('installBar').classList.add('hidden');
  renderInstall();
}
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  showInstallBar(false);
  renderInstall();
});
if (isIos) showInstallBar(true);
renderInstall();
$('installBtn').addEventListener('click', installApp);
$('installBtn2').addEventListener('click', installApp);
$('installClose').addEventListener('click', () => {
  store.set('installDismissed', '1');
  $('installBar').classList.add('hidden');
});
window.addEventListener('appinstalled', () => {
  appInstalled = true;
  $('installBar').classList.add('hidden');
  renderInstall();
});
