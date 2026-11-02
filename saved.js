// Scan the Horizon saved areas ("Use it without signal" in the place sheet): everything needed to
// look from anywhere within a few km of a place with no connection, kept in Cache API
// 'xray-saved-v1' until the visitor deletes it. The terrain cache (dem.js TileFetcher: about 400
// tiles, 180 days) and the service worker's place-name tiles (the newest 300) clear out on their
// own; nothing here does. No DOM and no worker globals: the worker (xray-worker.js) uses it, and so
// do the Node tests (ReferenceFiles/scanthehorizon/unit-test.mjs).
//
// What an area holds, for a centre and a radius (RADII):
//  - Terrain, Mapterhorn only: every ring of the view's plan, widened by the radius, so a view from
//    any spot inside finds all its rings saved. Plans are made at the centre and at the area's north
//    and south edges (a ring's zoom depends on the latitude and can step inside the area), for each
//    range a view there could use (an automatic range is 150 or 250 km, decided by the terrain round
//    each spot), and with and without "Lighter download". The lighter plan's first ring is the z12
//    ring the engine falls back to where a z13 tile is missing (its 404 rule), so that is covered too.
//    A tile Mapterhorn fails on while saving is kept as its four AWS tiles instead, which the engine
//    stitches in its place, as it does online.
//  - Place names: the 1° tiles the index lists within the largest range plus the radius, and the
//    index itself.
// The list of areas (the manifest) is kept in the same cache. A new area goes into it, with every
// URL it will need, before the first download, as 'saving', and becomes 'saved' once everything has
// arrived; a page closed half way leaves it unfinished, for the page to offer to finish or delete.
// Anything in the cache that no area lists is swept away after a delete or a stopped save.
import * as D from './dem.js';

export const SAVED_CACHE = 'xray-saved-v1';
export const MANIFEST_KEY = 'https://xray.invalid/saved-areas';
export const RADII = [2, 5, 10, 20];
export const DEFAULT_RADIUS = 5;
export const MAX_AREAS = 50;

// The Mapterhorn tiles for looking from anywhere within radiusKm of (lat, lon), coarsest first.
// ranges: the ranges a view there may use (km). → [{ z, x, y, url }]
export function areaTiles(lat, lon, { radiusKm, ranges }) {
	const src = D.SOURCES.mapterhorn, out = new Map(), dLat = radiusKm / 111.2;
	const lats = [lat, Math.min(85, lat + dLat), Math.max(-85, lat - dLat)];
	for (const la of lats) for (const rangeKm of ranges) for (const lite of [false, true]) {
		for (const R of D.planRings(la, lon, rangeKm, { lite, src })) {
			const g = D.makeRing(lat, lon, R.zM, 0, R.outerKm + radiusKm, R.nominalKm, src);
			for (const t of g.tiles) {
				const k = D.tileKey('mapterhorn', g.z, t.x, t.y);
				if (!out.has(k)) out.set(k, { z: g.z, x: t.x, y: t.y, url: D.tileUrl(src, g.z, t.x, t.y) });
			}
		}
	}
	return [...out.values()].sort((a, b) => a.z - b.z);
}
// The four AWS tiles (256 px, one zoom finer) that stand in for a Mapterhorn tile.
export const awsChildren = (t) => [0, 1, 2, 3].map((q) => D.tileUrl(D.SOURCES.aws, t.z + 1, 2 * t.x + (q & 1), 2 * t.y + (q >> 1)));

// ---- The manifest ---------------------------------------------------------------------------------
// Everything read back is checked: a damaged or foreign manifest becomes an empty list, and an area
// that doesn't fit is dropped (its tiles are then swept at the next delete).
const isUrl = (u) => typeof u === 'string' && /^https?:\/\//.test(u) && u.length < 400;
function cleanArea(a) {
	if (!a || typeof a !== 'object') return null;
	if (typeof a.id !== 'string' || !/^[\w-]{1,40}$/.test(a.id)) return null;
	if (!(Number.isFinite(a.lat) && Math.abs(a.lat) <= 85 && Number.isFinite(a.lon) && Math.abs(a.lon) <= 180)) return null;
	if (!RADII.includes(a.radiusKm) || !Array.isArray(a.urls) || !a.urls.every(isUrl)) return null;
	return {
		id: a.id, name: typeof a.name === 'string' && a.name.trim() ? a.name.slice(0, 60) : 'A saved area', lat: a.lat, lon: a.lon, radiusKm: a.radiusKm,
		range: a.range === 'auto' || (Number.isFinite(a.range) && a.range >= 10 && a.range <= 300) ? a.range : 'auto',
		savedAt: Number.isFinite(a.savedAt) ? a.savedAt : 0, status: a.status === 'saved' ? 'saved' : 'saving',
		urls: a.urls, bytes: Number.isFinite(a.bytes) && a.bytes >= 0 ? a.bytes : 0, missing: Number.isInteger(a.missing) && a.missing >= 0 ? a.missing : 0,
	};
}
export function cleanManifest(raw) {
	const areas = raw && typeof raw === 'object' && raw.v === 1 && Array.isArray(raw.areas) ? raw.areas.map(cleanArea).filter(Boolean) : [];
	const seen = new Set();
	return { v: 1, areas: areas.filter((a) => !seen.has(a.id) && seen.add(a.id)).slice(0, MAX_AREAS) };
}
// What the page is told about an area (not its URL list).
export const summary = (a) => ({ id: a.id, name: a.name, lat: a.lat, lon: a.lon, radiusKm: a.radiusKm, range: a.range, savedAt: a.savedAt, status: a.status, bytes: a.bytes, missing: a.missing, pieces: a.urls.length });
const urlsOf = (m) => new Set(m.areas.flatMap((a) => a.urls));

// ---- The store ------------------------------------------------------------------------------------
// One Cache API cache. `urls` (every URL some area lists) is held in memory, so the engine's lookups
// skip the cache for anything not saved; refresh() reads it again (the worker does at each run, in
// case another tab saved or deleted an area). Every Cache API call is guarded: a private window can
// refuse storage, and the page must work without it.
export class SavedStore {
	constructor({ caches = null, name = SAVED_CACHE } = {}) {
		this.caches = caches; this.name = name; this.cacheP = null; this.urls = new Set();
	}
	cache() {
		if (!this.caches) return Promise.resolve(null);
		if (!this.cacheP) this.cacheP = Promise.resolve().then(() => this.caches.open(this.name)).catch(() => null);
		return this.cacheP;
	}
	async read() {
		const c = await this.cache();
		if (!c) return cleanManifest(null);
		try { const r = await c.match(MANIFEST_KEY); return cleanManifest(r ? await r.json() : null); } catch (e) { return cleanManifest(null); }
	}
	async write(m) {
		const c = await this.cache();
		if (!c) throw new Error('no storage');
		await c.put(MANIFEST_KEY, new Response(JSON.stringify(m), { headers: { 'content-type': 'application/json' } }));
		this.urls = urlsOf(m);
	}
	// Read, change and write the manifest (read fresh each time: another tab may have changed it).
	async update(fn) { const m = await this.read(); fn(m); await this.write(m); return m; }
	async refresh() { this.urls = urlsOf(await this.read()); return this.urls; }
	// A saved response, or null (only for URLs an area lists).
	async match(url) {
		if (!this.urls.has(url)) return null;
		const c = await this.cache();
		if (!c) return null;
		try { return (await c.match(url)) || null; } catch (e) { return null; }
	}
	// Forget an area, deleting what only it used before the manifest is written, so a full store has
	// room for the write.
	async remove(id) {
		const c = await this.cache();
		if (!c) return;
		const m = await this.read(), gone = m.areas.find((a) => a.id === id);
		m.areas = m.areas.filter((a) => a.id !== id);
		const others = urlsOf(m);
		if (gone) for (const u of gone.urls) if (!others.has(u)) { try { await c.delete(u); } catch (e) { /* ignore */ } }
		await this.write(m);
	}
	// Delete everything no area lists. → how many entries went.
	async sweep() {
		const c = await this.cache();
		if (!c || typeof c.keys !== 'function') return 0;
		const keep = urlsOf(await this.read());
		let n = 0;
		for (const q of await c.keys()) {
			const u = typeof q === 'string' ? q : q.url;
			if (u === MANIFEST_KEY || keep.has(u)) continue;
			try { if (await c.delete(u)) n++; } catch (e) { /* ignore */ }
		}
		this.urls = keep;
		return n;
	}
}
