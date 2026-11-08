// Scan the Horizon saved areas ("Use it without signal" in the place sheet): everything needed to
// look from anywhere within a few km of a place with no connection, kept in Cache API
// 'xray-saved-v1' until the visitor deletes it. The terrain cache (dem.js TileFetcher: about 400
// tiles, 180 days) and the service worker's place-name tiles (the newest 300) clear out on their
// own; nothing here does. No DOM and no worker globals: the worker (xray-worker.js) uses it, and so
// do the Node tests (ReferenceFiles/scanthehorizon/unit-test.mjs).
//
// What an area holds. An area is a circle (a centre and a radius: RADII in the page, 1–200 km from a
// link) or a box (south, west, north, east: from a link only, at most MAX_SIDE_KM a side):
//  - Terrain, Mapterhorn only: every ring of the view's plan, widened by the area (the radius, or the
//    box grown by the ring's reach), so a view from any spot inside finds all its rings saved. Plans
//    are made at the area's north and south edges, its centre and every 0.5° of latitude between (a
//    ring's zoom depends on the latitude and can step inside the area), for each range a view there
//    could use (an automatic range is 150 or 250 km, decided by the terrain round each spot).
//  - How much detail close by (DETAILS): circles up to FULL_MAX_KM keep 'full', the view's own plan
//    and the Lighter download one, whose first ring is the z12 ring the engine falls back to where a
//    z13 tile is missing (its 404 rule), so that is covered too. Bigger areas would be thousands of
//    z13 tiles (about 8,000 for 200 km), so they keep 'lite' (the Lighter download plan, z12 near by)
//    while that is at most TILE_BUDGET.lite tiles, else 'basic' (z11 near by) up to TILE_BUDGET.basic;
//    anything bigger is refused. A view from inside an area plans no finer than the area holds
//    (xray-worker.js run), so without signal it never asks for a tile that wasn't saved.
//    A tile Mapterhorn fails on while saving is kept as its four AWS tiles instead, which the engine
//    stitches in its place, as it does online.
//  - Place names: the 1° tiles the index lists within the largest range of the area, and the index.
// The list of areas (the manifest) is kept in the same cache. A new area goes into it, with every
// URL it will need, before the first download, as 'saving', and becomes 'saved' once everything has
// arrived; a page closed half way leaves it unfinished, for the page to offer to finish or delete.
// Anything in the cache that no area lists is swept away after a delete or a stopped save.
import * as D from './dem.js';

export const SAVED_CACHE = 'xray-saved-v1';
export const MANIFEST_KEY = 'https://xray.invalid/saved-areas';
export const RADII = [2, 5, 10, 20, 50, 100, 200];
export const DEFAULT_RADIUS = 5;
export const MAX_AREAS = 50;
export const DETAILS = ['full', 'lite', 'basic'];          // finest first
export const FULL_MAX_KM = 20;
export const TILE_BUDGET = { lite: 1600, basic: 2500 };
export const MAX_RADIUS_KM = 200, MAX_SIDE_KM = 500;
const KM_DEG = 111.2, D2R = Math.PI / 180;
// The coarser of two details.
export const coarserDetail = (a, b) => (DETAILS.indexOf(a) >= DETAILS.indexOf(b) ? a : b);

// A box [south, west, north, east] in degrees, or null: in range, the right way round (an area
// across the 180° meridian isn't supported), and at most MAX_SIDE_KM a side.
export function cleanBox(b) {
	if (!Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite)) return null;
	const [s, w, n, e] = b;
	if (!(s < n && w < e && s >= -85 && n <= 85 && w >= -180 && e <= 180)) return null;
	const { wKm, hKm } = boxSize(b);
	return wKm <= MAX_SIDE_KM && hKm <= MAX_SIDE_KM ? [s, w, n, e] : null;
}
// Width (at its widest latitude) and height of a box, km.
export function boxSize([s, w, n, e]) {
	const widest = s < 0 && n > 0 ? 0 : Math.min(Math.abs(s), Math.abs(n));
	return { wKm: (e - w) * KM_DEG * Math.cos(widest * D2R), hKm: (n - s) * KM_DEG };
}
// The box round a circle.
function boundsOf(lat, lon, rKm) {
	const dLat = rKm / KM_DEG, dLon = rKm / (KM_DEG * Math.max(0.02, Math.cos(Math.min(85, Math.abs(lat) + dLat) * D2R)));
	return [lat - dLat, lon - dLon, lat + dLat, lon + dLon];
}
// How far from its centre an area reaches, km (for the place names).
export function reachKm(a) {
	if (!a.box) return a.radiusKm;
	const [s, w, n, e] = a.box;
	return Math.max(...[[s, w], [s, e], [n, w], [n, e]].map(([la, lo]) => D.haversine(a.lat, a.lon, la, lo))) / 1000;
}
export function contains(a, lat, lon) {
	if (a.box) { const [s, w, n, e] = a.box; return lat >= s && lat <= n && lon >= w && lon <= e; }
	return D.haversine(a.lat, a.lon, lat, lon) <= a.radiusKm * 1000 + 1;
}
// Does area a hold everything area b needs: all of b inside a, at no less detail? (A 'lite' area where
// there is no finer data, less: false, is as good as full there.)
export function covers(a, b) {
	const da = a.detail === 'lite' && a.less === false ? 'full' : a.detail || 'full';
	if (DETAILS.indexOf(da) > DETAILS.indexOf(b.detail || 'full')) return false;
	if (a.box) {
		const [s, w, n, e] = b.box || boundsOf(b.lat, b.lon, b.radiusKm);
		return s >= a.box[0] && n <= a.box[2] && w >= a.box[1] && e <= a.box[3];
	}
	if (b.box) return [[b.box[0], b.box[1]], [b.box[0], b.box[3]], [b.box[2], b.box[1]], [b.box[2], b.box[3]]].every(([la, lo]) => contains(a, la, lo));
	return D.haversine(a.lat, a.lon, b.lat, b.lon) / 1000 + b.radiusKm <= a.radiusKm + 0.05;
}
// The finest detail any of these areas holds at (lat, lon), or null where none does.
export function detailAt(areas, lat, lon) {
	let best = null;
	for (const a of areas) {
		const d = a.detail || 'full';
		if (contains(a, lat, lon) && (!best || DETAILS.indexOf(d) < DETAILS.indexOf(best))) best = d;
	}
	return best;
}

// The Mapterhorn tiles for looking from anywhere in an area, coarsest first.
// opts: { radiusKm } or { box }, ranges (the ranges a view there may use, km), detail. → [{ z, x, y, url }]
export function areaTiles(lat, lon, { radiusKm, box = null, ranges, detail = 'full' }) {
	const src = D.SOURCES.mapterhorn, out = new Map();
	const [s, w, n, e] = box || boundsOf(lat, lon, radiusKm);
	const lats = [Math.max(-85, s), Math.min(85, n), lat];
	for (let x = Math.ceil(s * 2) / 2; x < n; x += 0.5) lats.push(x);
	const plans = detail === 'full' ? [{ lite: false }, { lite: true }] : [{ lite: true, ladder: detail === 'basic' ? D.BASIC_LADDER : D.LADDER }];
	const add = (z, x, y) => { const k = D.tileKey('mapterhorn', z, x, y); if (!out.has(k)) out.set(k, { z, x, y, url: D.tileUrl(src, z, x, y) }); };
	for (const la of lats) for (const rangeKm of ranges) for (const pl of plans) {
		for (const R of D.planRings(la, lon, rangeKm, { ...pl, src })) {
			if (!box) {
				const g = D.makeRing(lat, lon, R.zM, 0, R.outerKm + radiusKm, R.nominalKm, src);
				for (const t of g.tiles) add(g.z, t.x, t.y);
				continue;
			}
			// The box grown by the ring's reach (and the bilinear pad makeRing adds), corners and all.
			const z = R.zM, N = 2 ** z, E = R.outerKm + Math.max(0.5, 3 * D.mppAt(z, la) / 1000);
			const dLat = E / KM_DEG, dLon = E / (KM_DEG * Math.max(0.02, Math.cos(Math.min(85, Math.max(Math.abs(s), Math.abs(n)) + dLat) * D2R)));
			const x0 = Math.floor(D.lonToU(w - dLon) * N), x1 = Math.floor(D.lonToU(e + dLon) * N);
			const y0 = Math.max(0, Math.floor(D.latToV(n + dLat) * N)), y1 = Math.min(N - 1, Math.floor(D.latToV(s - dLat) * N));
			for (let y = y0; y <= y1; y++) for (let ux = x0; ux <= x1; ux++) add(z, ((ux % N) + N) % N, y);
		}
	}
	return [...out.values()].sort((a, b) => a.z - b.z);
}
// The detail an area gets, and its tiles: 'full' for circles up to FULL_MAX_KM, else the finest that
// fits the tile budget. → { detail, tiles, tooBig }
export function planArea(lat, lon, opts) {
	if (!opts.box && opts.radiusKm <= FULL_MAX_KM) return { detail: 'full', tiles: areaTiles(lat, lon, { ...opts, detail: 'full' }), tooBig: false };
	let tiles = null;
	for (const detail of ['lite', 'basic']) {
		tiles = areaTiles(lat, lon, { ...opts, detail });
		if (tiles.length <= TILE_BUDGET[detail]) return { detail, tiles, tooBig: false };
	}
	return { detail: 'basic', tiles, tooBig: true };
}

// ---- Links that offer to save an area ------------------------------------------------------------
// #save=lat,lon,km (a circle) or #save=lat1,lon1,lat2,lon2 (a box, two opposite corners), with an
// optional &name=. The page always asks first, showing what the area is (from the place names, not
// the link) and how big the download is. → null (no save=), { error: 'bad' | 'big' }, or an area
// { lat, lon, radiusKm } or { lat, lon, box } (lat, lon: its centre), with name ('' if none).
const NUM = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;
// A name from a link is someone else's text: no control, format or invisible characters (which can
// reorder or hide what is shown), single spaces, at most 40 characters.
const HIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g;
export function cleanName(v) {
	const t = String(v == null ? '' : v).replace(HIDDEN_CHARS, ' ').replace(/\s+/g, ' ').trim();
	return [...t].slice(0, 40).join('').trim();
}
export function parseSaveLink(hash) {
	const q = new URLSearchParams(String(hash || '').replace(/^#/, ''));
	if (!q.has('save')) return null;
	const parts = (q.get('save') || '').split(',').map((x) => x.trim());
	if (!(parts.length === 3 || parts.length === 4) || !parts.every((x) => NUM.test(x))) return { error: 'bad' };
	const v = parts.map(Number), name = cleanName(q.get('name'));
	if (v.length === 3) {
		const [lat, lon, km] = v;
		if (!(Math.abs(lat) <= 85 && Math.abs(lon) <= 180) || !(km > 0)) return { error: 'bad' };
		if (km > MAX_RADIUS_KM) return { error: 'big' };
		return { lat, lon, radiusKm: Math.max(1, Math.round(km)), name };
	}
	const [la1, lo1, la2, lo2] = v, raw = [Math.min(la1, la2), Math.min(lo1, lo2), Math.max(la1, la2), Math.max(lo1, lo2)];
	if (!(raw[0] >= -85 && raw[2] <= 85 && raw[1] >= -180 && raw[3] <= 180 && raw[0] < raw[2] && raw[1] < raw[3])) return { error: 'bad' };
	const box = cleanBox(raw);
	if (!box) return { error: 'big' };
	return { lat: (box[0] + box[2]) / 2, lon: (box[1] + box[3]) / 2, box, name };
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
	const box = a.box == null ? null : cleanBox(a.box);
	if (a.box != null && !box) return null;
	if (!box && !(Number.isInteger(a.radiusKm) && a.radiusKm >= 1 && a.radiusKm <= MAX_RADIUS_KM)) return null;
	if (!Array.isArray(a.urls) || !a.urls.every(isUrl)) return null;
	return {
		id: a.id, name: typeof a.name === 'string' && a.name.trim() ? a.name.slice(0, 60) : 'A saved area', lat: a.lat, lon: a.lon, radiusKm: box ? null : a.radiusKm, box,
		detail: DETAILS.includes(a.detail) ? a.detail : 'full',
		// (less: whether that is less than a view online would have there; xray-worker.js fineDataIn)
		less: typeof a.less === 'boolean' ? a.less : DETAILS.includes(a.detail) && a.detail !== 'full',
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
export const summary = (a) => ({ id: a.id, name: a.name, lat: a.lat, lon: a.lon, radiusKm: a.radiusKm, box: a.box, detail: a.detail, less: a.less, range: a.range, savedAt: a.savedAt, status: a.status, bytes: a.bytes, missing: a.missing, pieces: a.urls.length });
const urlsOf = (m) => new Set(m.areas.flatMap((a) => a.urls));

// ---- The store ------------------------------------------------------------------------------------
// One Cache API cache. `urls` (every URL some area lists) is held in memory, so the engine's lookups
// skip the cache for anything not saved; refresh() reads it again (the worker does at each run, in
// case another tab saved or deleted an area). Every Cache API call is guarded: a private window can
// refuse storage, and the page must work without it.
export class SavedStore {
	constructor({ caches = null, name = SAVED_CACHE } = {}) {
		this.caches = caches; this.name = name; this.cacheP = null; this.urls = new Set(); this.areas = [];
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
		this.urls = urlsOf(m); this.areas = m.areas;
	}
	// Read, change and write the manifest (read fresh each time: another tab may have changed it).
	async update(fn) { const m = await this.read(); fn(m); await this.write(m); return m; }
	async refresh() { const m = await this.read(); this.urls = urlsOf(m); this.areas = m.areas; return this.urls; }
	// The finest detail an area saved here holds at (lat, lon), or null (as of the last read).
	detailAt(lat, lon) { return detailAt(this.areas, lat, lon); }
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
