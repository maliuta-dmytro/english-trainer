// Service worker: network-first, щоб оновлення підтягувались одразу, а офлайн працював кеш.
const CACHE = 'english-trainer-v11';
const SHELL = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest', 'icon.svg',
  'js/app.js', 'js/db.js', 'js/srs.js', 'js/diff.js', 'js/ui.js', 'js/stats.js', 'js/speech.js', 'js/starter.js',
  'js/claude.js', 'js/gemini.js', 'js/ai.js', 'js/coach.js', 'js/scenarios.js', 'js/charts.js', 'js/dictation.js', 'js/views/dictation.js', 'js/recorder.js', 'js/views/fluency.js', 'js/grammar.js', 'js/views/grammar.js', 'js/trip.js', 'js/views/trip.js', 'js/icons.js',
  'js/views/home.js', 'js/views/review.js', 'js/views/cards.js', 'js/views/settings.js',
  'js/views/talk.js', 'js/views/journal.js', 'js/views/progress.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match('index.html'))),
  );
});
