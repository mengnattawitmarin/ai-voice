// Offline cache for the app shell only. API calls (Pollinations, Hugging Face, CDNs) always go to the network.
const CACHE = 'ai-voice-v25';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'studio.js', 'sfx.js', 'voicefx.js', 'cover.js', 'video.js', 'tools.js', 'voicetrain.js', 'train/sentences-th.txt', 'logo.svg', 'vendor/mp4-muxer.mjs', 'vendor/lame.min.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(new Request(u, {cache: 'reload'})).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // network first, fall back to cache when offline
  e.respondWith(
    fetch(e.request, {cache: 'no-cache'}).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request).then(r => r || caches.match('index.html')))
  );
});
