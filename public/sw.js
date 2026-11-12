// Offline support: the network is asked first (so an update is live at once), the copy kept
// from the last visit answers when there is no connection. Only this app's own files.
const CACHE = 'murmur-1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
	const url = new URL(e.request.url);
	if (e.request.method !== 'GET' || url.origin !== location.origin) return;
	e.respondWith((async () => {
		const cache = await caches.open(CACHE);
		try {
			const fresh = await fetch(e.request);
			if (fresh.ok) cache.put(e.request, fresh.clone());
			return fresh;
		} catch (err) {
			const kept = await cache.match(e.request, { ignoreSearch: true });
			if (kept) return kept;
			throw err;
		}
	})());
});
