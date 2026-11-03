// Scan the Horizon targets: the places round the observer (our own GeoNames tiles, SPEC §4) turned into the
// label list the page draws (SPEC §5 Label, §6.2–6.3).
//
// Steps: read the 1° tiles that touch the range disc (index.json first, so no 404s); keep the
// records in range; choose which to test (every place the detail slider can name by its kind, plus
// the best ~800 of the rest by importance and distance); give each a height (peaks: the official
// height, else the DEM's highest cell within 300 m at the finest ring there; settlements: the ground
// + 10 m; anything else: the ground); test visibility against the panorama's running-max profile
// (pano.js); score; and send at most 800, best first. Hidden places are sent only when they are
// "major", for the page's behind-arrows, and at most HIDDEN_MAX of them.
//
// Record (SPEC §4): [geonameid, name, en|0, lat×1e4, lon×1e4, code, pop, ele, wl, wiki, cc].
import { haversine, finestAt, sampleAt, maxAround, ringForDistance, fetchWithDeadline, abortError, DEADLINES } from './dem.js';
import { visibility, anchorAt } from './pano.js';

const D2R = Math.PI / 180;
export const MAX_ITEMS = 800;
// Hidden majors are only behind-arrows (three on screen) and the List's twelve biggest: from
// Interlaken some 300 of them used to fill the 800 and push visible peaks out.
export const HIDDEN_MAX = 150;
export const MIN_KM = 0.15;              // closer than this is where you stand

// ---- Kinds and importance (SPEC §6.3) --------------------------------------------------------------
const KIND = {
	MT: 'peak', PK: 'peak', VLC: 'peak', NTK: 'peak', HLL: 'hill',
	ISL: 'island', ATOL: 'island', CAPE: 'cape', PT: 'cape', HDLD: 'cape', PEN: 'cape', BAY: 'bay',
	LK: 'lake', LKN: 'lake', LKC: 'lake', RSV: 'lake', FLLS: 'waterfall',
	LTHSE: 'lighthouse', TOWR: 'tower', OBPT: 'lookout', DAM: 'dam', CSTL: 'castle', MNMT: 'monument',
};
const POPULATED = new Set(['PPL', 'PPLA', 'PPLA2', 'PPLA3', 'PPLA4', 'PPLA5', 'PPLC', 'PPLG', 'PPLS', 'PPLF', 'PPLR', 'PPLL', 'PPLX']);
const SETTLEMENT = new Set(['city', 'town', 'village', 'suburb', 'hamlet']);
// A section of a city (PPLX) is classed by its population like any other settlement: GeoNames files
// many real towns as PPLX (Buderim 28,774, Bracken Ridge 16,701 and Bongaree 7,010 round the
// lookout). Below 1,000 people, or with no population, it is a suburb. Some PPLX carry a whole
// district's or city's population (New South Memphis 641,608, Hong Kong Island 1.2 million, Puxi
// 6.7 million): build-places stores 0 for a PPLX with at least half the population of a city of
// 50,000 or more within 15 km (Adam, 2026-10-30), and here a PPLX's importance stops at a town's
// (SUBURB_MAX_I) and it is never major, unless it is well known in its own right (names in 10 or
// more languages: Kowloon, Navi Mumbai, Pest). Until 2026-10-30 every PPLX below that was a suburb,
// which dropped those towns from the lookout's labels.
export const PPLX_NOTABLE_WL = 10;
export function kindOf(code, pop, wl = 0) {
	if (POPULATED.has(code)) {
		if (code === 'PPLC' || pop >= 100000) return 'city';
		if (pop >= 10000) return 'town';
		if (pop >= 1000 || code.startsWith('PPLA')) return 'village';
		if (code === 'PPLX') return 'suburb';
		return 'hamlet';
	}
	return KIND[code] || null;
}
export const isSettlement = (kind) => SETTLEMENT.has(kind);
const isRelief = (kind) => kind === 'peak' || kind === 'hill';
const FALLBACK_I = { city: 4.7, town: 3.5, village: 2.7, suburb: 3.0, hamlet: 1.7 };
const OTHER_I = { lighthouse: 2.5, island: 2.5, lake: 2.0, bay: 2.0, cape: 2.0, waterfall: 2.0, dam: 1.8, tower: 1.8, castle: 1.8, monument: 1.8, lookout: 1.0 };
// A PPLX's own population counts up to a town's (3.5) unless it is well known (see kindOf).
export const SUBURB_MAX_I = 3.5;
export function importance(kind, pop, ele, code = null, wl = 0) {
	if (isSettlement(kind)) {
		if (!(pop > 0)) return FALLBACK_I[kind];
		const I = Math.log10(pop);
		return code === 'PPLX' && !(wl >= PPLX_NOTABLE_WL) ? Math.min(SUBURB_MAX_I, I) : I;
	}
	if (isRelief(kind)) return Math.min(4.5, 1.5 + Math.max(0, ele || 0) / 400);
	return OTHER_I[kind] ?? 1.0;
}
export const distancePenalty = (dKm) => Math.log10(1 + dKm / 5);
// Weight of notability, k·log10(1 + wl). SPEC §6.3 first had 0.6; raised to 1.0 by the integrator
// (2026-10-30) because wl here counts languages (about half Wikidata's sitelinks) and every peak above
// 1,200 m has the same capped importance, so from Interlaken the Jungfrau (wl 53) lost to its
// shoulder the Wengen Jungfrau (wl 2) on stand-out alone. At the lookout the order hardly changes.
export const WL_WEIGHT = 1.0;
export function isMajor(kind, code, pop, ele, wl) {
	if (wl >= 25) return true;
	if (code === 'PPLX' && !(wl >= PPLX_NOTABLE_WL)) return false;
	if (isSettlement(kind)) return pop >= 50000 || ((code === 'PPLC' || code === 'PPLA') && pop >= 10000);
	if (kind === 'peak') return ele >= 1000 && wl >= 3;
	return false;
}

// The runtime's ranking of one raw tile record, shared with build-places.mjs so the per-tile cap
// keeps what the app ranks highest (and with candidates() below, so the two can't drift). Pure: no
// DOM, no worker globals.
//   rec      a SPEC §4 record [geonameid, name, en|0, lat×1e4, lon×1e4, code, pop, ele, wl, wiki, cc]
//   dKm      distance from the observer in km (0 at build time: no distance term)
//   height   metres, for a peak or hill with no official height (ele 0): at runtime the DEM's top
//            within 300 m, at build time GeoNames' dem column; ignored when the record has ele
// → { kind, I, notability, pre }, pre = I + notability − distancePenalty(dKm) (the pre-filter's
//   score, SPEC §6.3), or null for a feature code the app doesn't use.
export function placeRank(rec, { dKm = 0, height = null } = {}) {
	const code = rec[5], pop = +rec[6] || 0, ele = +rec[7] || 0, wl = +rec[8] || 0;
	const kind = kindOf(code, pop, wl);
	if (!kind) return null;
	const h = ele > 0 ? ele : isRelief(kind) && height > 0 ? height : 0;
	const I = importance(kind, pop, h, code, wl);
	const notability = WL_WEIGHT * Math.log10(1 + wl);
	return { kind, I, notability, pre: I + notability - distancePenalty(dKm) };
}

// The lowest detail stop (0 Fewest … 3 More) at which the page names a place for its kind alone,
// whatever its score, or 4 if only All does: a mirror of draw.js allowed() (SPEC §6.4), keep in step.
// standOut and status are known only after the visibility test; before it (pre: true) the place's
// best case is assumed, so the test set covers everything the slider could name.
export function kindStop(c, { pre = false, standOut = 0, status = 'visible' } = {}) {
	const k = c.kind, d = c.dKm, pop = c.pop || 0, so = pre ? Infinity : standOut;
	if (k === 'city' || k === 'town' || (k === 'peak' && so >= 1)) return 0;
	if ((isSettlement(k) && k !== 'suburb' && k !== 'hamlet' && pop >= 1000) || (k === 'peak' && ((c.wl || 0) >= 1 || so >= 0.5))) return 1;
	if ((k === 'village' && d <= 50) || (k === 'peak' && status === 'visible' && d <= 60) || k === 'lake' || k === 'island' || k === 'lighthouse') return 2;
	if (((k === 'suburb' || k === 'hamlet') && d <= 15) || k === 'hill' || k === 'cape' || k === 'dam' || k === 'tower' || k === 'lookout') return 3;
	return 4;
}
// The lowest stop whose minimum score this score reaches (4.5 / 3.5 / 2.5 / 1.5, SPEC §6.4).
const scoreStop = (s) => (s >= 4.5 ? 0 : s >= 3.5 ? 1 : s >= 2.5 ? 2 : s >= 1.5 ? 3 : 4);
// Behind-arrows go to the hidden majors with the best score (app.js). These two terms let a famous
// peak hidden nearby outrank a city far off: a distance term, and a little more for a place below the
// sea horizon itself (the Earth hides it, whatever stands in front). From Interlaken facing 150° the
// arrows were Milan, Turin (170–180 km, both over the horizon) and the Eiger; now the Eiger, the
// Schilthorn and Milan. Facing north the cities stay (Bern, Zürich, Lucerne, Basel, Thun), and round
// Brisbane nothing changes (Brisbane still leads from the lookout and Narangba). A stronger distance
// term, 2·log10(1 + d/10), swapped Lausanne, Basel and Lucerne for minor peaks (Schwarzhorn,
// Dreispitz), so it wasn't used. Only hidden places carry these: the slider never names them.
export const ARROW_DIST_KM = 20, ARROW_OVER_HORIZON = 0.3;
export const arrowPenalty = (dKm, overHorizon = false) => Math.log10(1 + dKm / ARROW_DIST_KM) + (overHorizon ? ARROW_OVER_HORIZON : 0);
// The dip of the sea horizon (deg) for an eye h0 metres above the sea, with refraction.
const seaDip = (h0) => Math.sqrt(2 * Math.max(0, h0) * (1 - 0.13) / 6371008.8) * 180 / Math.PI;
// GeoNames points on whole arc-minutes (12.5% of Australian peaks) can be up to 0.9 km off the
// summit; their bearing is approximate and they are never used to lift the DEM.
export function arcMinuteRounded(lat, lon) {
	const a = lat * 60, b = lon * 60;
	return Math.abs(a - Math.round(a)) < 0.004 && Math.abs(b - Math.round(b)) < 0.004;
}

// ---- Tiles ---------------------------------------------------------------------------------------
// 1° cells (floorLat, floorLon) that touch the disc of radius rangeKm.
export function placeCells(lat, lon, rangeKm) {
	const dLat = rangeKm / 111.2, dLon = rangeKm / (111.2 * Math.max(0.02, Math.cos(lat * D2R)));
	const out = [];
	for (let fy = Math.floor(Math.max(-90, lat - dLat)); fy <= Math.min(89, Math.floor(lat + dLat)); fy++) {
		for (let fxu = Math.floor(lon - dLon); fxu <= Math.floor(lon + dLon); fxu++) {
			const fx = ((fxu + 180) % 360 + 360) % 360 - 180;
			const cLat = Math.min(fy + 1, Math.max(fy, lat)), cLon = Math.min(fxu + 1, Math.max(fxu, lon));
			if (haversine(lat, lon, cLat, cLon) / 1000 > rangeKm) continue;
			if (!out.some((c) => c.lat === fy && c.lon === fx)) out.push({ lat: fy, lon: fx });
		}
	}
	return out;
}
// Every request here has a deadline (dem.js fetchWithDeadline: no answer in 10 s, or 13 s in all),
// and each failed tile is asked for once more; a stalled or failed tile then costs only its own names.
const idxCache = new Map();               // base → Promise<Uint8Array>
export const PLACES_POOL = 6;
const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));
async function getText(fetchFn, url, opts, what) {
	const r = await fetchWithDeadline(fetchFn, url, opts);
	if (!r.ok) throw new Error(`${what}: HTTP ${r.status}`);
	return r.blob.text();
}
// The index is shared by every run, so it is fetched without any one run's signal (a cancelled run
// must not fail the next one's places): only its deadline stops it.
function indexBits(base, fetchFn, deadline) {
	if (!idxCache.has(base)) {
		const p = (async () => {
			const url = new URL('index.json', base).href;
			let text;
			try { text = await getText(fetchFn, url, deadline, 'places index'); }
			catch (e) { await pause(300); text = await getText(fetchFn, url, deadline, 'places index'); }
			const j = JSON.parse(text);
			if (j.v !== 1 || typeof j.bits !== 'string') throw new Error('places index: unknown format');
			const s = atob(j.bits), b = new Uint8Array(s.length);
			for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
			return b;
		})();
		p.catch(() => idxCache.delete(base));  // try again next time
		idxCache.set(base, p);
	}
	return idxCache.get(base);
}
export const hasCell = (bits, fLat, fLon) => { const i = (fLat + 90) * 360 + (fLon + 180); return ((bits[i >> 3] >> (i & 7)) & 1) === 1; };
// The URLs of the tiles that exist for the disc (for saving an area: saved.js). Throws if the index
// can't be had.
export async function placeTileUrls({ base, lat, lon, rangeKm, fetch: fetchFn, deadline = DEADLINES.places }) {
	const bits = await indexBits(base, fetchFn, deadline);
	return placeCells(lat, lon, rangeKm).filter((c) => hasCell(bits, c.lat, c.lon)).map((c) => new URL(`${c.lat}/${c.lon}.json`, base).href);
}

// Read the tiles for the disc. base: the URL of data/places/v1/; signal: the run's (a cancel stops
// it with an AbortError). One failed tile out of a dozen or more used to remove every name; now the
// names from the tiles that loaded are kept, a failed tile is asked for once more, and what is still
// missing is reported. Throws only when the index or every tile failed.
// → { records, tiles (loaded), total, bytes, failed: ['lat/lon', …] }.
export async function loadPlaces({ base, lat, lon, rangeKm, fetch: fetchFn, signal = null, deadline = DEADLINES.places, onProgress }) {
	const bits = await indexBits(base, fetchFn, deadline);
	if (signal && signal.aborted) throw abortError();
	const cells = placeCells(lat, lon, rangeKm).filter((c) => hasCell(bits, c.lat, c.lon));
	let done = 0, bytes = 0, lastErr = null;
	const records = [];
	onProgress && onProgress(0, cells.length, 0);
	const one = async (c) => {
		const text = await getText(fetchFn, new URL(`${c.lat}/${c.lon}.json`, base).href, { signal, ...deadline }, `places tile ${c.lat}/${c.lon}`);
		const j = JSON.parse(text);
		bytes += text.length;
		for (const f of j.f || []) records.push(f);
		onProgress && onProgress(++done, cells.length, bytes);
	};
	// At most PLACES_POOL at a time (34 cells at Interlaken): all at once beside the terrain, each
	// would get so small a share of a slow link that it could miss its deadline.
	const settleAll = async (list) => {
		const res = new Array(list.length);
		let i = 0;
		const worker = async () => {
			while (i < list.length) {
				const k = i++;
				try { await one(list[k]); res[k] = null; } catch (e) { res[k] = e || new Error('failed'); }
			}
		};
		await Promise.all(Array.from({ length: Math.min(PLACES_POOL, list.length) }, worker));
		return res;
	};
	let left = cells;
	for (let attempt = 0; attempt < 2 && left.length; attempt++) {
		if (attempt) await pause(300);
		const res = await settleAll(left);
		if (signal && signal.aborted) throw abortError();
		left = left.filter((c, k) => { if (!res[k]) return false; lastErr = res[k]; return true; });
	}
	if (left.length && left.length === cells.length) throw lastErr;
	if (left.length) onProgress && onProgress(cells.length, cells.length, bytes);   // so the bar doesn't stick
	return { records, tiles: cells.length - left.length, total: cells.length, bytes, failed: left.map((c) => `${c.lat}/${c.lon}`) };
}

// Summit positions. A GeoNames peak point is often 50–150 m from the summit the DEM draws (Mount
// Tibrogargan's is ~130 m off the surveyed top: 0.8° of bearing from the Glass House lookout). The
// spec already takes a peak's height from the DEM's highest cell within 300 m; where the finest ring
// there is fine enough to place that cell (≤ 40 m pixels) the label's position moves to it too, so
// the leader lands on the drawn summit, and so does the summit lift. Never for arc-minute-rounded
// points (up to 0.9 km off: 300 m can't reach), and never onto a cell another named peak is nearer.
// → Map geonameid → { lat, lon, dem } for the peaks and hills in range.
export const SNAP_M = 300, SNAP_MAX_PX = 40;
export function snapPeaks(records, rings, lat, lon, rangeKm) {
	const peaks = [];
	for (const f of records) {
		const kind = KIND[f[5]];
		if (kind !== 'peak' && kind !== 'hill') continue;
		const pl = f[3] / 1e4, pn = f[4] / 1e4;
		if (haversine(lat, lon, pl, pn) > rangeKm * 1000 + 2000) continue;
		peaks.push({ id: f[0], lat: pl, lon: pn });
	}
	const grid = new Map(), cellKey = (a, b) => Math.floor(a * 100) + ':' + Math.floor(b * 100);   // ~1 km cells
	for (const p of peaks) { const k = cellKey(p.lat, p.lon); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(p); }
	const nearest = (la, lo) => {
		let best = null, bd = Infinity;
		for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
			for (const q of grid.get(Math.floor(la * 100 + i) + ':' + Math.floor(lo * 100 + j)) || []) {
				const d = haversine(la, lo, q.lat, q.lon); if (d < bd) { bd = d; best = q; }
			}
		}
		return best;
	};
	const out = new Map();
	for (const p of peaks) {
		const r = finestAt(rings, p.lat, p.lon);
		if (r < 0) continue;
		const m = maxAround(rings, r, p.lat, p.lon, SNAP_M);
		if (!(m.h > -1e9)) continue;
		const e = { lat: p.lat, lon: p.lon, dem: m.h };
		if (rings[r].mpp <= SNAP_MAX_PX && !arcMinuteRounded(p.lat, p.lon) && nearest(m.lat, m.lon) === p) { e.lat = m.lat; e.lon = m.lon; e.snapped = true; }
		out.set(p.id, e);
	}
	return out;
}

// Peaks with an official height and trustworthy coordinates, for liftSummits (dem.js), at their
// snapped positions when `snaps` (from snapPeaks) is given.
export function liftPeaks(records, lat, lon, rangeKm, snaps = null) {
	const out = [];
	for (const f of records) {
		const kind = KIND[f[5]];
		if (!(kind === 'peak' || kind === 'hill') || !(f[7] > 0)) continue;
		let pl = f[3] / 1e4, pn = f[4] / 1e4;
		if (arcMinuteRounded(pl, pn)) continue;
		if (haversine(lat, lon, pl, pn) > rangeKm * 1000 + 2000) continue;
		const s = snaps && snaps.get(f[0]);
		if (s && s.snapped) { pl = s.lat; pn = s.lon; }
		out.push({ lat: pl, lon: pn, ele: f[7], name: f[2] || f[1] });
	}
	return out;
}

// Standing on a summit (the setting "Stand on a summit within 150 m", on by default): the named
// peak or hill whose listed position is nearest the place and within radiusM (MIN_KM, where you
// stand, so it is never one of the names), at its top as drawn: moved to the DEM's top where
// snapPeaks moved it, which is also where liftSummits raised it to its official height. A summit
// picked from the search is given at its real top, but on coarse data the drawn top can be 100 m
// away: Everest's is 105 m NNE (the data's 8,736 m, raised to 8,848), which put the eye 85 m down
// the side of the rebuilt summit under a 37° slope. Never for arc-minute-rounded points.
// → { id, name, lat, lon, ele, dist (m, to the listed position) } or null.
export const SUMMIT_M = MIN_KM * 1000;
export function summitNear(records, snaps, lat, lon, radiusM = SUMMIT_M) {
	let best = null;
	for (const f of records) {
		const kind = KIND[f[5]];
		if (kind !== 'peak' && kind !== 'hill') continue;
		const pl = f[3] / 1e4, pn = f[4] / 1e4;
		if (arcMinuteRounded(pl, pn)) continue;
		const d = haversine(lat, lon, pl, pn);
		if (d > radiusM || (best && d >= best.dist)) continue;
		const s = snaps && snaps.get(f[0]), top = s && s.snapped ? s : { lat: pl, lon: pn };
		best = { id: f[0], name: f[2] || f[1], lat: top.lat, lon: top.lon, ele: f[7] > 0 ? f[7] : null, dist: d };
	}
	return best;
}

// ---- The label list ------------------------------------------------------------------------------
// The records in range as targets, pre-filtered, each with the height its visibility is tested at
// (h) and whether it could be a behind-arrow (major). The test set is every place the slider can name
// for its kind alone at some stop up to More (kindStop with pre: true: cities and towns, every peak
// and hill, villages within 50 km or of 1,000 people, lakes, islands, lighthouses, capes, dams,
// towers, lookouts, bays, waterfalls, castles, monuments, suburbs and hamlets within 15 km), plus the
// best PRE_EXTRA of the rest (far hamlets and suburbs) by the pre-filter score. It used to be the best
// 800 plus peaks within 20 km, which left visible named peaks the slider promises untested and
// unnamed (Mount Tibrogargan from Narangba, 30.6 km). all: test everything in range (tests).
// snaps: from snapPeaks (computed here if not given).
export const PRE_EXTRA = 800;
export function candidates({ records, obs, rangeKm, rings, snaps = null, all = false }) {
	snaps = snaps || snapPeaks(records, rings, obs.lat, obs.lon, rangeKm);
	const cands = [];
	const seen = new Set();
	for (const f of records) {
		const [id, name, en, latE4, lonE4, code, pop, ele, wl, wiki, cc] = f;
		if (seen.has(id)) continue;
		seen.add(id);
		const kind = kindOf(code, pop || 0, wl || 0);
		if (!kind) continue;
		let lat = latE4 / 1e4, lon = lonE4 / 1e4;
		const rounded = arcMinuteRounded(lat, lon);
		let eleOut = ele > 0 ? ele : null, eleSrc = eleOut ? 'official' : null;
		if (isRelief(kind)) {
			const s = snaps.get(id);
			if (s) {
				if (s.snapped) { lat = s.lat; lon = s.lon; }
				if (!eleOut && s.dem > -1e9) { eleOut = Math.round(s.dem); eleSrc = 'dem'; }
			}
		}
		const dist = haversine(obs.lat, obs.lon, lat, lon);
		if (dist < MIN_KM * 1000 || dist > rangeKm * 1000) continue;
		const dKm = dist / 1000;
		const rk = placeRank(f, { dKm, height: eleSrc === 'dem' ? eleOut : null });
		cands.push({ id, name: en || name, sub: en && en !== name ? name : null, kind, code, lat, lon, dist, dKm, pop: pop || 0,
			ele: eleOut, eleSrc, wl: wl || 0, wiki: wiki === 1 ? (en || name) : (typeof wiki === 'string' && wiki ? wiki : null),
			cc, I: rk.I, pre: rk.pre, rounded });
	}
	cands.sort((a, b) => b.pre - a.pre);
	const keep = [];
	let extra = 0;
	for (const c of cands) {
		if (!(all || kindStop(c, { pre: true }) <= 3 || extra++ < PRE_EXTRA)) continue;
		// Height of the target itself: a peak's summit (the official height, or the DEM's own top if
		// that is higher, so a near hill's drawn flank can't hide its own summit); the ground (+ 10 m
		// for a settlement) otherwise.
		if (isRelief(c.kind) && c.ele != null) { const s = snaps.get(c.id); c.h = Math.max(c.ele, s && s.dem > -1e9 ? s.dem : -Infinity); }
		else {
			// from the ring the drawing uses at that distance, so a place on a plain in view isn't
			// "hidden" by a few metres of difference between rings
			c.h = sampleAt(rings, ringForDistance(rings, c.dist), c.lat, c.lon) + (isSettlement(c.kind) ? 10 : 0);
		}
		c.major = isMajor(c.kind, c.code, c.pop, c.ele || 0, c.wl);
		keep.push(c);
	}
	return { keep, inRange: cands.length };
}

// ctx: { records, obs: {lat, lon, h0}, rangeKm, rings, pano (the full one, with its profile), snaps }.
// → { items, stats }. At most MAX_ITEMS go out, at most HIDDEN_MAX of them hidden majors. If more
// places are in view than fit, those the slider names at the lowest stops (for their kind or their
// score, as kindStop/scoreStop) are kept first, then by score; the list goes out by score.
export function buildLabels({ records, obs, rangeKm, rings, pano, snaps = null, slack = 0.1, all = false }) {
	const { keep, inRange } = candidates({ records, obs, rangeKm, rings, snaps, all });
	let exact = 0;
	const items = [], stop = new Map(), dip = seaDip(obs.h0);
	for (const c of keep) {
		const major = c.major;
		const v = visibility(rings, pano, obs, { lat: c.lat, lon: c.lon, h: c.h, kind: c.kind, dist: c.dist, major }, { slack });
		if (v.exact) exact++;
		if (v.status === 'hidden' && !major) continue;
		const standOut = v.margin;
		let score = c.I + WL_WEIGHT * Math.log10(1 + c.wl) - distancePenalty(c.dKm);
		if (isRelief(c.kind) && v.status !== 'hidden') score += Math.max(0, Math.min(3, standOut));
		if (v.status === 'marginal') score -= 0.5;
		// below the sea horizon itself: it couldn't be seen even with nothing in between
		const overHorizon = v.status === 'hidden' && v.alt < -dip;
		if (v.status === 'hidden') score -= arrowPenalty(c.dKm, overHorizon);
		// The anchor: a visible or marginal peak sits on the drawn terrain at its bearing; anything
		// else at its own angle.
		let alt = v.alt;
		if (isRelief(c.kind) && v.status !== 'hidden') {
			const a = anchorAt(pano, v.az, c.dist + v.own);
			if (a > -90) alt = a;
		}
		const L = {
			id: c.id, name: c.name, sub: c.sub, kind: c.kind, az: round(v.az, 3), alt: round(alt, 3), dist: round(c.dKm, 3),
			ele: c.ele, eleSrc: c.eleSrc, pop: c.pop, status: v.status, margin: round(v.margin, 3), standOut: round(standOut, 3),
			score: round(score, 3), major, blockAlt: v.status === 'hidden' ? round(v.blockAlt, 3) : null,
			blockDist: v.status === 'hidden' ? round(v.blockDist / 1000, 3) : null, wiki: c.wiki, cc: c.cc,
			wl: c.wl, approx: c.rounded || undefined,
			overHorizon: overHorizon || undefined,
		};
		items.push(L);
		if (v.status !== 'hidden') {
			// the lowest stop that names it (marginal places come in at Normal or More, as allowed())
			const s = Math.min(kindStop(c, { standOut, status: v.status }), scoreStop(score));
			stop.set(L, v.status === 'marginal' ? Math.max(s, v.margin >= 0 ? 2 : 3) : s);
		}
	}
	const hidden = items.filter((L) => L.status === 'hidden').sort((a, b) => b.score - a.score);
	if (hidden.length > HIDDEN_MAX) hidden.length = HIDDEN_MAX;
	const shown = items.filter((L) => L.status !== 'hidden');
	if (shown.length + hidden.length > MAX_ITEMS) {
		shown.sort((a, b) => stop.get(a) - stop.get(b) || b.score - a.score);
		shown.length = MAX_ITEMS - hidden.length;
	}
	const out = shown.concat(hidden).sort((a, b) => b.score - a.score);
	return { items: out, stats: { records: records.length, inRange, tested: keep.length, exact, inView: items.length - items.filter((L) => L.status === 'hidden').length,
		hiddenMajors: items.filter((L) => L.status === 'hidden').length, sent: out.length } };
}
const round = (x, n) => x == null ? x : Math.round(x * 10 ** n) / 10 ** n;
