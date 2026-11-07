// Service worker for scanthehorizon.app (the pattern of lookupanddown.com and whatsacross.com).
//
//  - The page's code and navigations: NETWORK-FIRST, cache fallback. The shell (the page, its
//    styles, every JS module including the worker's, the icons and the place-names index) is
//    precached, so the page opens without a connection once it has been opened.
//  - Place-name tiles (/data/places/v1/<lat>/<lon>.json, fetched by the page's worker): CACHE-FIRST,
//    kept as they arrive (the newest PLACES_MAX) in their own cache, PLACES, which a deploy leaves
//    alone: their URL carries the data's version (v1), so they can't go stale, and a view opened
//    before keeps its names offline after an update. (Until sth-v2 they lived in the versioned cache
//    and every deploy threw them away; activate moves any found in an older cache across.) If the
//    data's version changes, rename PLACES with it, and activate deletes the old one.
//  - Cross-origin requests are never touched. The terrain tiles (Mapterhorn, AWS) are cached by the
//    page's worker itself, in Cache API 'xray-dem-v1' (180 days, about 400 tiles), and saved areas
//    in 'xray-saved-v1' (saved.js, until the visitor deletes them): this worker never deletes either.
//    The place search needs a connection anyway.
//  - On activate, only this site's older caches (names starting 'sth-') are deleted.
//  - Bump CACHE on every deploy that changes a precached file.
const CACHE = 'sth-v6';
const PLACES = 'sth-places-v1';
const PLACES_MAX = 300;
const CORE = [
	'/',
	'/index.html',
	'/xray.css',
	'/app.js',
	'/draw.js',
	'/attitude.js',
	'/orientation.js',
	'/geocode.js',
	'/decode.js',
	'/xray-worker.js',
	'/dem.js',
	'/pano.js',
	'/targets.js',
	'/saved.js',
	'/favicon.svg',
	'/manifest.json',
	'/icon-192.png',
	'/icon-512.png',
	'/icon-maskable-512.png',
	'/apple-touch-icon.png',
	'/data/places/v1/index.json'
];
const PLACE_TILE = /^\/data\/places\/v1\/-?\d+\/-?\d+\.json$/;
const isPlaceTile = (r) => PLACE_TILE.test(new URL(r.url).pathname);

self.addEventListener('install', (e) => {
	// cache: 'no-cache' revalidates each file with the server (a 304 costs no body), so a deploy never
	// precaches a copy the browser's HTTP cache still holds from the version before.
	e.waitUntil(caches.open(CACHE)
		.then((c) => c.addAll(CORE.map((u) => new Request(u, { cache: 'no-cache' }))))
		.then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
	e.waitUntil((async () => {
		const old = (await caches.keys()).filter((k) => k.startsWith('sth-') && k !== CACHE && k !== PLACES);
		const keep = await caches.open(PLACES);
		for (const k of old) {
			try {
				const c = await caches.open(k);
				for (const r of (await c.keys()).filter(isPlaceTile)) {
					if (await keep.match(r)) continue;
					const res = await c.match(r);
					if (res) await keep.put(r, res);
				}
			} catch (err) { /* storage full or refused: those names are fetched again when needed */ }
			await caches.delete(k);
		}
		await trim(keep).catch(() => {});
		await self.clients.claim();
	})());
});

self.addEventListener('fetch', (e) => {
	const req = e.request;
	if (req.method !== 'GET') return;
	const url = new URL(req.url);
	if (url.origin !== location.origin) return;
	if (PLACE_TILE.test(url.pathname)) e.respondWith(placeTile(e, req));
	else e.respondWith(networkFirst(e, req));
});

async function placeTile(e, req) {
	const c = await caches.open(PLACES);
	const hit = await c.match(req, { ignoreSearch: true });
	if (hit) return hit;
	const res = await fetch(req);
	// waitUntil, so the worker isn't stopped before the write lands.
	if (res.ok) e.waitUntil(c.put(req, res.clone()).then(() => trim(c)).catch(() => { /* storage full: carry on */ }));
	return res;
}

// Keep the newest PLACES_MAX place tiles (a cache's keys come back in the order they were stored).
async function trim(c) {
	const tiles = (await c.keys()).filter(isPlaceTile);
	for (const r of tiles.slice(0, Math.max(0, tiles.length - PLACES_MAX))) await c.delete(r);
}

async function networkFirst(e, req) {
	try {
		const res = await fetch(req);
		if (res.ok) {
			const copy = res.clone();
			e.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}));
		}
		return res;
	} catch (err) {
		const c = await caches.open(CACHE);
		// ignoreSearch: a navigation can carry a query; the shell is the same page.
		const hit = await c.match(req, { ignoreSearch: req.mode === 'navigate' });
		if (hit) return hit;
		if (req.mode === 'navigate') { const shell = await c.match('/index.html'); if (shell) return shell; }
		return Response.error();
	}
}
