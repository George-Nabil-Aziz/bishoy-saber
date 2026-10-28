// Network-first app shell: always serve the latest files online, fall back to the cache offline.
const CACHE = 'notes-v4';
const SHELL = ['./', 'index.html', 'css/base.css', 'css/landing.css', 'css/login.css', 'css/app.css', 'css/header.css', 'css/status.css', 'css/tables.css', 'css/pages.css', 'css/toasts.css', 'css/install.css', 'css/mobile.css', 'config.js', 'js/core.js', 'js/i18n.js', 'js/ui.js', 'js/data.js', 'js/app.js', 'js/notes.js', 'js/users.js', 'js/history.js', 'js/sync-page.js', 'js/extras.js', 'js/main.js', 'favicon.svg', 'manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Only the app's own files and the supabase-js script; API calls go straight to the network
  const cacheable = url.origin === location.origin || url.hostname === 'cdn.jsdelivr.net';
  if (e.request.method !== 'GET' || !cacheable) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
  );
});
