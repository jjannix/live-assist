const CACHE_NAME = 'static-cache-v2';

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            return cache.addAll([
                './style.css',
                './app.js',
                './manifest.json'
            ]);
        })
    );
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    // Always fetch HTML fresh from network
    if (url.pathname.endsWith('/') || url.pathname.endsWith('.html')) {
        event.respondWith(fetch(event.request).catch(() => caches.match('./index.html')));
        return;
    }
    // Cache-first for assets
    event.respondWith(
        caches.match(event.request).then(response => {
            return response || fetch(event.request);
        })
    );
});
