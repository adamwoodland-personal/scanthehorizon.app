// Scan the Horizon terrain: elevation tiles around the observer, fetched, cached, held per tile and sampled
// bilinearly. Used by xray-worker.js; no DOM and no worker globals at import time, so the same
// code runs in the worker, on a test page's main thread and in Node (ReferenceFiles/scanthehorizon).
//
// Sources (SPEC §3). Mapterhorn is the primary: Terrarium-encoded lossless WebP, 512 px, planet
// z0–12 everywhere and z13+ only inside regional archives (5 m LiDAR in south-east Queensland,
// swissALTI3D in Switzerland). AWS Terrain Tiles (Mapzen "joerd", 256 px PNG, SRTM in Queensland)
// is the fallback behind the same interface. Terrarium: h = R·256 + G + B/256 − 32768 metres.
//
// Rings. The DEM is a set of rings chosen by metres per pixel at the observer's latitude, fine
// near and coarse far, each ring a FULL DISC of tiles (not an annulus: at 2:1 ring ratios the
// annulus saves next to nothing once whole tiles are counted, and full discs let the coarse rings
// draw the first rough skyline on their own and let any sample fall back to a coarser ring where a
// finer tile is missing). Ring zooms are always in Mapterhorn's 512 px units; an AWS ring uses the
// zoom one higher with 256 px tiles, which is the same ground per pixel.
//
// The ladder (outer edge → pixel size) is plan B of the terrain report with its z13 ring extended
// to 6 km (SPEC §3): z13 0–6 km (8.5 m at −27°), then each ring's pixel is the coarsest one no
// bigger than LADDER.mrad (4 mrad) × its nominal outer edge: 11 km → 34 m, 23 → 68 m, 45 → 136 m,
// 90 → 273 m, then 545 m to the range edge (150–250 km). At −27° that is z13, z11, z10, z9, z8, z7.
// (SPEC §3's sentence reads "17 m to 11 km, 34 m to 23 km…", one zoom finer per ring; that is
// LADDER.mrad = 2 and about twice the tiles. See the engine report.)
// The first ring is chosen by pixel size too (the coarsest zoom with pixels ≤ 10 m, never finer than
// z13): a fixed z13 meant 1.7 m pixels and 217 tiles at 80° and 763 at 85°, because Mercator tiles
// shrink towards the poles. From the equator to about 58° it is still z13. LIMITS caps any plan.
//
// Storage: Int16 whole metres for z ≤ 12, Float32 for z13/14. 404 rule (Mapterhorn): at z ≤ 12 a
// 404 is sea (0 m); at z ≥ 13 it means "no archive here", and z12 is used for that area instead.

export const R_EARTH = 6371008.8;          // mean Earth radius, metres (distances, curvature)
export const K_REFRACTION = 0.13;          // refraction coefficient (drop = d²(1−k)/2R)
const MERC_CIRC = 40075016.686;            // Web Mercator circumference (WGS84 a), metres
const D2R = Math.PI / 180, R2D = 180 / Math.PI;

export const SOURCES = {
	mapterhorn: { id: 'mapterhorn', url: 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp', size: 512, planetMaxZ: 12, maxZ: 14, png: false },
	aws: { id: 'aws', url: 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png', size: 256, planetMaxZ: 15, maxZ: 15, png: true },
};
export const tileUrl = (src, z, x, y) => src.url.replace('{z}', z).replace('{x}', x).replace('{y}', y);

// Outer edges (km) of the rings after the first, and the nominal edge that picks each one's pixel.
// firstMpp / liteMpp: the largest pixel (m) the first ring may have (lite and AWS start one zoom
// coarser); firstZ / liteZ: the finest zoom it may use.
export const LADDER = { firstKm: 6, firstZ: 13, liteZ: 12, firstMpp: 10, liteMpp: 20, edges: [11, 23, 45, 90, Infinity], nominal: [11, 23, 45, 90, 180], mrad: 4 };
// One zoom coarser again close by (z11 at −27°): the plan of a saved area too big for the lighter
// one (saved.js 'basic'); used with lite.
export const BASIC_LADDER = { ...LADDER, liteZ: 11, liteMpp: 40 };
// Resource limits per plan: tiles requested and decoded megabytes held (Int16 for z ≤ 12, Float32
// finer). The fixtures need at most 60 tiles and 41 MB (Interlaken at 250 km). A plan over either
// limit is made coarser, the ring holding the most bytes first, until it fits.
export const LIMITS = { tiles: 120, mb: 96 };
// Rings at least this coarse (nominal outer edge, km) are the "coarse" group fetched first.
export const COARSE_FROM_KM = 45;

// ---- Geometry -------------------------------------------------------------------------------------
export const lonToU = (lon) => (lon + 180) / 360;          // not wrapped: may leave [0, 1)
export function latToV(lat) {
	const s = Math.sin(Math.max(-85.0511, Math.min(85.0511, lat)) * D2R);
	return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}
export const vToLat = (v) => Math.atan(Math.sinh(Math.PI * (1 - 2 * v))) * R2D;
export const uToLon = (u) => u * 360 - 180;
export const mppAt = (z, lat, size = 512) => MERC_CIRC * Math.cos(lat * D2R) / (size * 2 ** z);

export function haversine(lat1, lon1, lat2, lon2) {        // metres
	const p1 = lat1 * D2R, p2 = lat2 * D2R, dp = p2 - p1, dl = (lon2 - lon1) * D2R;
	const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
	return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}
export function bearing(lat1, lon1, lat2, lon2) {          // initial great-circle bearing, 0 ≤ az < 360
	const p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
	const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
	const b = Math.atan2(y, x) * R2D;
	return b < 0 ? b + 360 : b >= 360 ? b - 360 : b;
}
export function destination(lat, lon, az, d) {             // great circle, d in metres → [lat, lon]
	const del = d / R_EARTH, th = az * D2R, p1 = lat * D2R;
	const sp2 = Math.sin(p1) * Math.cos(del) + Math.cos(p1) * Math.sin(del) * Math.cos(th);
	const l2 = lon * D2R + Math.atan2(Math.sin(th) * Math.sin(del) * Math.cos(p1), Math.cos(del) - Math.sin(p1) * sp2);
	return [Math.asin(sp2) * R2D, ((l2 * R2D + 540) % 360) - 180];
}
export const curvatureDrop = (d, k = K_REFRACTION) => d * d * (1 - k) / (2 * R_EARTH);

// ---- Ring plan ------------------------------------------------------------------------------------
// The coarsest Mapterhorn zoom whose pixel is no bigger than `mpp` metres at this latitude.
export function zoomFor(lat, mpp, maxZ = 14) {
	const z = Math.ceil(Math.log2(MERC_CIRC * Math.cos(lat * D2R) / (512 * mpp)) - 1e-9);
	return Math.max(0, Math.min(maxZ, z));
}

// Tiles of zoom z (size px) touching the disc of radius rKm round (lat, lon), nearest first.
function discTiles(lat, lon, rKm, z, size) {
	const n = 2 ** z;
	const dLat = rKm / 111.2, dLon = rKm / (111.2 * Math.max(0.02, Math.cos(lat * D2R)));
	const ux0 = Math.floor(lonToU(lon - dLon) * n), ux1 = Math.floor(lonToU(lon + dLon) * n);
	const ty0 = Math.max(0, Math.floor(latToV(lat + dLat) * n)), ty1 = Math.min(n - 1, Math.floor(latToV(lat - dLat) * n));
	const tiles = [];
	for (let ty = ty0; ty <= ty1; ty++) for (let ux = ux0; ux <= ux1; ux++) {
		const lonW = uToLon(ux / n), lonE = uToLon((ux + 1) / n), latN = vToLat(ty / n), latS = vToLat((ty + 1) / n);
		const cLat = Math.min(latN, Math.max(latS, lat)), cLon = Math.min(lonE, Math.max(lonW, lon));
		const dKm = haversine(lat, lon, cLat, cLon) / 1000;
		if (dKm > rKm) continue;
		const az = bearing(lat, lon, (latN + latS) / 2, (lonW + lonE) / 2);
		tiles.push({ ux, x: ((ux % n) + n) % n, y: ty, dKm, az });
	}
	tiles.sort((a, b) => a.dKm - b.dKm);
	return { ux0, ty0, nx: ux1 - ux0 + 1, ny: ty1 - ty0 + 1, tiles };
}

// One ring: zoom z in Mapterhorn units, served by `src` (AWS uses z + 1 at 256 px).
export function makeRing(lat, lon, zM, innerKm, outerKm, nominalKm, src = SOURCES.mapterhorn) {
	const z = src.size === 256 ? zM + 1 : zM, size = src.size;
	const mpp = mppAt(z, lat, size);
	const pad = Math.max(0.5, 3 * mpp / 1000);              // bilinear neighbours at the edge
	const g = discTiles(lat, lon, outerKm + pad, z, size);
	return {
		z, zM, size, sh: Math.log2(size), mask: size - 1, n: 2 ** z, S: size * 2 ** z, mpp,
		innerKm, outerKm, nominalKm, src: src.id, coarse: nominalKm >= COARSE_FROM_KM,
		ux0: g.ux0, ty0: g.ty0, nx: g.nx, ny: g.ny, W: g.nx * size, tiles: g.tiles,
		slots: new Array(g.nx * g.ny).fill(null),
	};
}

// The ring plan for a place. lite (saveData / "Lighter download") starts one zoom coarser (z12 at
// −27°).
export function planRings(lat, lon, rangeKm, { lite = false, src = SOURCES.mapterhorn, ladder = LADDER, limits = LIMITS } = {}) {
	const rings = [];
	// AWS has SRTM/EU-DEM (~30 m) underneath: its z14 (8.5 m) is resampled with nothing new and four
	// times the bytes, so its first ring stops at 17 m, like the lite plan.
	const coarseStart = lite || src.id === 'aws';
	const firstZ = Math.min(coarseStart ? ladder.liteZ : ladder.firstZ, zoomFor(lat, coarseStart ? ladder.liteMpp ?? 20 : ladder.firstMpp ?? 10));
	let inner = 0;
	const first = Math.min(ladder.firstKm, rangeKm);
	rings.push(makeRing(lat, lon, firstZ, 0, first, ladder.firstKm, src));
	inner = first;
	for (let i = 0; i < ladder.edges.length && inner < rangeKm; i++) {
		if (ladder.edges[i] <= inner) continue;
		const outer = Math.min(ladder.edges[i], rangeKm);
		const zM = zoomFor(lat, ladder.mrad * ladder.nominal[i]);
		rings.push(makeRing(lat, lon, Math.max(0, Math.min(zM, firstZ - 1)), inner, outer, ladder.nominal[i], src));
		inner = outer;
	}
	// The limits: coarsen the ring holding the most bytes by one zoom until the plan fits.
	for (let guard = 0; guard < 64; guard++) {
		const c = planCost(rings);
		if (c.tiles <= limits.tiles && c.mb <= limits.mb) break;
		let w = -1, wb = -1;
		rings.forEach((R, i) => { const b = ringBytes(R); if (R.zM > 0 && b > wb) { wb = b; w = i; } });
		if (w < 0) break;
		const R = rings[w];
		rings[w] = makeRing(lat, lon, R.zM - 1, R.innerKm, R.outerKm, R.nominalKm, src);
		rings[w].degraded = true;
	}
	return rings;
}
// The plan for a level of detail close by: 'full' (the usual), 'lite' (Lighter download) or 'basic'
// (saved.js: what a big saved area holds).
export const planFor = (lat, lon, rangeKm, detail = 'full', src = SOURCES.mapterhorn) =>
	planRings(lat, lon, rangeKm, { lite: detail !== 'full', src, ladder: detail === 'basic' ? BASIC_LADDER : LADDER });
// Decoded bytes one ring holds: Int16 for z ≤ 12 (Mapterhorn units), Float32 finer (toStorage).
export const ringBytes = (R) => R.tiles.length * R.size * R.size * (R.zM >= 13 ? 4 : 2);
// Tiles and decoded megabytes of a plan, each tile counted once.
export function planCost(rings) {
	const seen = new Set();
	let tiles = 0, bytes = 0;
	for (const R of rings) for (const t of R.tiles) {
		const k = R.src + '/' + R.z + '/' + t.x + '/' + t.y;
		if (seen.has(k)) continue;
		seen.add(k); tiles++; bytes += R.size * R.size * (R.zM >= 13 ? 4 : 2);
	}
	return { tiles, mb: bytes / 2 ** 20 };
}
export const tileKey = (srcId, z, x, y) => srcId + '/' + z + '/' + x + '/' + y;

// Point the ring slots at the tiles held in `store` (Map key → entry with .data or null).
export function attachTiles(rings, store) {
	for (const R of rings) {
		R.slots.fill(null);
		for (const t of R.tiles) {
			const e = store.get(tileKey(R.src, R.z, t.x, t.y));
			if (e && e.data) R.slots[(t.y - R.ty0) * R.nx + (t.ux - R.ux0)] = e.data;
		}
	}
}

// ---- Sampling -------------------------------------------------------------------------------------
// Pixel value at ring-local integer coordinates, or NaN where the tile is missing.
function pixel(R, ix, iy) {
	const c = ix >> R.sh, r = iy >> R.sh;
	if (c < 0 || r < 0 || c >= R.nx || r >= R.ny) return NaN;
	const T = R.slots[r * R.nx + c];
	return T === null ? NaN : T[(iy & R.mask) * R.size + (ix & R.mask)];
}
// Ring-local pixel x for Web Mercator u, wrapping across the antimeridian.
export function ringPx(R, u) {
	let px = u * R.S - 0.5 - R.ux0 * R.size;
	if (px < -R.S / 2) px += R.S; else if (px > R.W + R.S / 2) px -= R.S;
	return px;
}
// Bilinear height at Web Mercator (u, v) from ring r, or from the next coarser ring where a tile is
// missing (not loaded yet, a z13 "no archive" hole, or outside the ring). 0 if no ring has it.
export function sampleUV(rings, r, u, v) {
	for (; r < rings.length; r++) {
		const R = rings[r];
		const px = ringPx(R, u), py = v * R.S - 0.5 - R.ty0 * R.size;
		const ix = Math.floor(px), iy = Math.floor(py), fx = px - ix, fy = py - iy;
		const a = pixel(R, ix, iy), b = pixel(R, ix + 1, iy), c = pixel(R, ix, iy + 1), d = pixel(R, ix + 1, iy + 1);
		if (a !== a || b !== b || c !== c || d !== d) continue;  // NaN: try a coarser ring
		const p = a + (b - a) * fx;
		return p + (c + (d - c) * fx - p) * fy;
	}
	return 0;
}
export const sampleAt = (rings, r, lat, lon) => sampleUV(rings, r, lonToU(lon), latToV(lat));

// The finest ring holding a real tile at (lat, lon) (ring order is finest first), or -1.
export function finestAt(rings, lat, lon) {
	const u = lonToU(lon), v = latToV(lat);
	for (let r = 0; r < rings.length; r++) {
		const R = rings[r], px = ringPx(R, u), py = v * R.S - 0.5 - R.ty0 * R.size;
		const h = pixel(R, Math.floor(px), Math.floor(py));
		if (h === h) return r;                                   // not NaN: a tile is there
	}
	return -1;
}
// The ring a sample at distance d (metres) is drawn from.
export function ringForDistance(rings, d) {
	const km = d / 1000;
	for (let r = 0; r < rings.length; r++) if (km <= rings[r].outerKm) return r;
	return rings.length - 1;
}

// Highest raw cell within radiusM of (lat, lon) in ring r: { h, lat, lon } (h = −Infinity if none).
export function maxAround(rings, r, lat, lon, radiusM) {
	const R = rings[r];
	const px = ringPx(R, lonToU(lon)), py = latToV(lat) * R.S - 0.5 - R.ty0 * R.size;
	const cell = mppAt(R.z, lat, R.size), rc = Math.max(1, Math.ceil(radiusM / cell));
	const lim = (radiusM / cell + 0.5) ** 2;                   // cell centres within radius + half a cell
	const cx = Math.round(px), cy = Math.round(py);
	let best = -Infinity, bx = cx, by = cy;
	for (let y = cy - rc; y <= cy + rc; y++) for (let x = cx - rc; x <= cx + rc; x++) {
		if ((x - px) * (x - px) + (y - py) * (y - py) > lim) continue;
		const h = pixel(R, x, y);
		if (h > best) { best = h; bx = x; by = y; }
	}
	const u = (bx + 0.5 + R.ux0 * R.size) / R.S, v = (by + 0.5 + R.ty0 * R.size) / R.S;
	return { h: best, lat: vToLat(v), lon: uToLon(((u % 1) + 1) % 1) };
}

// ---- Clean-up --------------------------------------------------------------------------------------
// AWS only (SPEC §3): Terrarium's overview zooms carry resampling ringing near SRTM/GMTED void
// seams (2,069 m and −4,120 m cells beside 220 m ground 25 km north of the Glass House lookout),
// and ocean cells are bathymetry. Mapterhorn is clean of both (critique §1), so this never runs on
// it. Per tile, in place on Float32 heights (size × size); cells within 2 of the tile edge are not
// examined. From the prototype: (1) an inland negative "lobe" marks a suspect zone whose cells more
// than lobeTol from their 5×5 median take the median; (2) negatives → 0; (3) isolated spikes more
// than `steep` cells of 76° slope above their 8-neighbour median are flattened.
export function despike(d, size, mpp, { steep = 4, passes = 2, zone = 3, lobeTol = 15 } = {}) {
	const W = size, H = size, nb = new Float32Array(8), w25 = new Float32Array(25);
	let lobes = 0, zoneFixed = 0, spikes = 0;
	const suspect = new Uint8Array(W * H);
	for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) {
		const o = y * W + x;
		if (d[o] >= -2) continue;
		if (d[o - 1] < 0 && d[o + 1] < 0 && d[o - W] < 0 && d[o + W] < 0) continue;   // open sea
		let neg = 0, k = 0;
		for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) { const v = d[o + j * W + i]; w25[k++] = v; if (v < 0) neg++; }
		if (neg > 5) continue;                                                      // a coastline
		w25.sort(); if (w25[12] <= 5) continue;                                     // not inland
		lobes++;
		for (let j = -zone; j <= zone; j++) for (let i = -zone; i <= zone; i++) {
			const yy = y + j, xx = x + i; if (yy >= 0 && xx >= 0 && yy < H && xx < W) suspect[yy * W + xx] = 1;
		}
	}
	if (lobes) {
		const copy = d.slice();
		for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) {
			const o = y * W + x; if (!suspect[o]) continue;
			let k = 0;
			for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) w25[k++] = Math.max(0, copy[o + j * W + i]);
			w25.sort();
			if (Math.abs(copy[o] - w25[12]) > lobeTol) { d[o] = w25[12]; zoneFixed++; }
		}
	}
	for (let o = 0; o < d.length; o++) if (d[o] < 0) d[o] = 0;
	const T = steep * mpp;
	for (let pass = 0; pass < passes; pass++) {
		let changed = 0;
		for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
			const o = y * W + x, v = d[o];
			if (v - (d[o - 1] + d[o + 1] + d[o - W] + d[o + W]) / 4 <= T) continue;   // cheap pre-check
			nb[0] = d[o - W - 1]; nb[1] = d[o - W]; nb[2] = d[o - W + 1]; nb[3] = d[o - 1];
			nb[4] = d[o + 1]; nb[5] = d[o + W - 1]; nb[6] = d[o + W]; nb[7] = d[o + W + 1];
			nb.sort();
			const med = (nb[3] + nb[4]) / 2;
			if (v - med > T) { d[o] = med; changed++; }
		}
		spikes += changed;
		if (!changed) break;
	}
	return { lobes, zoneFixed, spikes };
}

// Coarse rings flatten spires (Coonowrin −118 m at z9, −17 m at z12, −4.5 m at z13). For each peak
// with an official height, raise a cone h = max(h, ele − slope·r) round it in every ring where the
// DEM's highest cell within searchM is between minLift and maxLift low (SPEC §3, skyline report §2).
// Idempotent (max), so tiles lifted once stay right for later runs and the 'eye' recompute.
// peaks: [{ lat, lon, ele }]. Returns how many cones were raised.
export function liftSummits(rings, peaks, { slope = 0.8, maxLift = 250, minLift = 3, searchM = 150 } = {}) {
	let raised = 0;
	for (const p of peaks) {
		const u = lonToU(p.lon), v = latToV(p.lat);
		for (let r = 0; r < rings.length; r++) {
			const R = rings[r];
			const px = ringPx(R, u), py = v * R.S - 0.5 - R.ty0 * R.size;
			if (px < 2 || py < 2 || px > R.W - 3 || py > R.ny * R.size - 3) continue;
			const here = pixel(R, Math.round(px), Math.round(py));
			if (here !== here) continue;                             // NaN: no tile here
			const cell = mppAt(R.z, p.lat, R.size);
			const demMax = maxAround(rings, r, p.lat, p.lon, searchM).h;
			const lift = p.ele - demMax;
			if (!(lift > minLift && lift < maxLift)) continue;
			const rad = Math.ceil(lift / slope / cell) + 1, cx = Math.round(px), cy = Math.round(py);
			for (let y = cy - rad; y <= cy + rad; y++) for (let x = cx - rad; x <= cx + rad; x++) {
				const c = x >> R.sh, rr = y >> R.sh;
				if (c < 0 || rr < 0 || c >= R.nx || rr >= R.ny) continue;
				const Tl = R.slots[rr * R.nx + c];
				if (Tl === null || Tl.shared) continue;              // never write into the shared sea tile
				const cone = p.ele - slope * Math.hypot(x - px, y - py) * cell, o = (y & R.mask) * R.size + (x & R.mask);
				if (cone > Tl[o]) Tl[o] = Tl instanceof Int16Array ? Math.round(cone) : cone;
			}
			raised++;
		}
	}
	return raised;
}

// Storage per SPEC §3: Int16 whole metres for z ≤ 12 (Mapterhorn units), Float32 finer.
export function toStorage(heights, zM) {
	if (zM >= 13) return heights instanceof Float32Array ? heights : Float32Array.from(heights);
	if (heights instanceof Int16Array) return heights;      // already decoded to whole metres
	const out = new Int16Array(heights.length);
	for (let i = 0; i < heights.length; i++) { const h = Math.round(heights[i]); out[i] = h > 32767 ? 32767 : h < -32768 ? -32768 : h; }
	return out;
}
const ZERO = new Map();                                  // shared all-sea tiles, one per size
export function seaTile(size) {
	if (!ZERO.has(size)) { const t = new Int16Array(size * size); t.shared = true; ZERO.set(size, t); }
	return ZERO.get(size);
}

// A z13 tile from its z12 parent's quadrant, bilinearly upsampled ×2 (the 404 rule at z ≥ 13).
export function upsampleQuadrant(parent, size, qx, qy) {
	const out = new Float32Array(size * size), half = size / 2;
	for (let y = 0; y < size; y++) {
		const sy = Math.min(size - 1.000001, Math.max(0, qy * half + (y + 0.5) / 2 - 0.5)), iy = Math.floor(sy), fy = sy - iy;
		for (let x = 0; x < size; x++) {
			const sx = Math.min(size - 1.000001, Math.max(0, qx * half + (x + 0.5) / 2 - 0.5)), ix = Math.floor(sx), fx = sx - ix;
			const o = iy * size + ix, a = parent[o], b = parent[o + 1], c = parent[o + size], d = parent[o + size + 1];
			const p = a + (b - a) * fx;
			out[y * size + x] = p + (c + (d - c) * fx - p) * fy;
		}
	}
	return out;
}

// ---- Requests with deadlines ------------------------------------------------------------------------
// A request that never answers, or whose body stops arriving, would otherwise hold its ring (and with
// it the whole view) for good: stalls are ordinary on mobile data. Every tile and places request goes
// through here. It fails with a TimeoutError when the headers haven't come within headMs, or the whole
// response (body included: the timer stays armed until blob() resolves) within maxMs, so a stalled tile
// takes the normal failure path (the AWS fallback, then the failed set). The run's own signal cancels
// it with an AbortError. Each wait is also raced against the deadline, so even a fetch that ignores its
// signal can't hang the run. The body is read with the browser's own blob(), not piece by piece: a Blob
// put together in JS has to be copied back before it can be decoded or cached, which made Interlaken's
// full view ~600 ms later at CPU ×6. → { status, ok, type, blob }.
// The page's watchdog offers Try again after 30 s without a message, so a stalled request has failed
// (and fallen back) by then: a tile within 30 s (the largest recorded is 285 KB), a places tile within
// 13 s, twice over with its one retry.
export const DEADLINES = { tile: { headMs: 15000, maxMs: 30000 }, places: { headMs: 10000, maxMs: 13000 } };
export const abortError = () => Object.assign(new Error('cancelled'), { name: 'AbortError' });
export async function fetchWithDeadline(fetchFn, url, { signal = null, headMs = DEADLINES.tile.headMs, maxMs = DEADLINES.tile.maxMs, init = {} } = {}) {
	if (signal && signal.aborted) throw abortError();
	const ac = new AbortController();
	let failure = null, wake = null;
	const stop = (err) => { if (failure) return; failure = err; try { ac.abort(err); } catch (e) { /* old engines: no reason */ } if (wake) wake(err); };
	const late = (what) => Object.assign(new Error(`${what} (${url.replace(/^https?:\/\//, '')})`), { name: 'TimeoutError', timeout: true });
	const head = setTimeout(() => stop(late(`no answer in ${Math.round(headMs / 1000)} s`)), headMs);
	const whole = setTimeout(() => stop(late(`not finished in ${Math.round(maxMs / 1000)} s`)), maxMs);
	const onAbort = () => stop(abortError());
	if (signal) signal.addEventListener('abort', onAbort, { once: true });
	const guard = new Promise((ok, no) => { wake = no; });
	guard.catch(() => {});
	const race = (p) => Promise.race([p, guard]);
	try {
		const r = await race(fetchFn(url, { ...init, signal: ac.signal }));
		clearTimeout(head);
		const type = (r.headers && r.headers.get('content-type')) || '';
		const blob = await race(r.blob());
		return { status: r.status, ok: r.ok, type, blob };
	} catch (e) {
		throw failure || e;
	} finally {
		clearTimeout(head); clearTimeout(whole);
		if (signal) signal.removeEventListener('abort', onAbort);
	}
}

// ---- Fetching and the Cache API ---------------------------------------------------------------------
// Responses (200 and 404) are kept compressed in Cache API 'xray-dem-v1', keyed by tile URL, with
// our own LRU (~400 tiles) and a 180-day expiry; Mapterhorn's 7-day max-age doesn't matter for
// near-static data. Every Cache API call is in try/catch: private windows can refuse storage, and
// the app must work without it.
// The LRU index is written a few seconds after tiles arrive (or every 10 tiles), at the end of a run
// and on cancel, not only when a run finishes: a page closed while loading used to leave its tiles in
// the cache but in no index, where eviction never found them. Each write merges with the index as
// stored (another tab or worker may have written it) and with the cache's own list of keys, so a tile
// in no index is adopted as the least recently used, and the 400-tile limit holds.
// pinned: the saved areas (saved.js SavedStore, or anything with match(url) → Response|null), looked
// up before this cache: a saved tile never expires and is never evicted from here, and offline it may
// be all there is.
const INDEX_KEY = 'https://xray.invalid/dem-index';
export class TileFetcher {
	constructor({ fetch, caches = null, cacheName = 'xray-dem-v1', maxEntries = 400, maxAgeDays = 180, deadline = DEADLINES.tile, flushEvery = 10, flushAfterMs = 2000, pinned = null } = {}) {
		this.fetch = fetch; this.caches = caches; this.name = cacheName; this.pinned = pinned;
		this.maxEntries = maxEntries; this.maxAge = maxAgeDays * 864e5;
		this.deadline = deadline; this.flushEvery = flushEvery; this.flushAfterMs = flushAfterMs;
		this.cacheP = null; this.idx = new Map(); this.dirty = false;
		this.touched = 0; this.timer = 0; this.flushing = null;
	}
	async cache() {
		if (!this.caches) return null;
		if (!this.cacheP) this.cacheP = (async () => {
			try {
				const c = await this.caches.open(this.name);
				try { const r = await c.match(INDEX_KEY); this.idx = new Map(Object.entries(r ? await r.json() : {}).map(([u, t]) => [u, +t || 0])); } catch (e) { this.idx = new Map(); }
				// Tiles in the cache but in no index (a page closed before it wrote one): adopt them with
				// the time they were stored, and evict over the limit.
				try {
					if (typeof c.keys === 'function') {
						let adopted = 0;
						for (const q of await c.keys()) {
							const u = typeof q === 'string' ? q : q.url;
							if (u === INDEX_KEY || this.idx.has(u)) continue;
							let t = 0;
							try { const h = await c.match(u); t = (h && +h.headers.get('x-xray-stored')) || 0; } catch (e) { /* oldest */ }
							this.idx.set(u, t); adopted++;
						}
						if (adopted) { this.dirty = true; this.schedule(); }
					}
				} catch (e) { /* keys() refused: the next write reconciles */ }
				return c;
			} catch (e) { return null; }
		})();
		return this.cacheP;
	}
	// → { status: 200|404, blob, bytes, cached }. Throws on a network error, a stall (TimeoutError),
	// a cancel (AbortError) or any other status.
	async get(url, signal) {
		if (this.pinned) {
			try {
				const hit = await this.pinned.match(url);
				if (hit) { const blob = await hit.blob(); return { status: hit.status, blob, bytes: blob.size, cached: true }; }
			} catch (e) { /* this cache, then the network */ }
		}
		const hit = await this.peek(url);
		if (hit) { this.touch(url); return { status: hit.status, blob: hit.blob, bytes: hit.blob.size, cached: true }; }
		const c = await this.cache();
		// The cache lookup takes no signal: a run cancelled meanwhile doesn't start a download.
		if (signal && signal.aborted) throw abortError();
		const r = await fetchWithDeadline(this.fetch, url, { signal, ...this.deadline, init: { mode: 'cors', credentials: 'omit' } });
		if (!r.ok && r.status !== 404) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
		const blob = r.blob;
		if (c) {
			try {
				await c.put(url, new Response(blob, { status: r.status, headers: { 'content-type': r.type || 'application/octet-stream', 'x-xray-stored': String(Date.now()) } }));
				this.touch(url);
			} catch (e) { /* storage full or refused: carry on */ }
		}
		return { status: r.status, blob, bytes: blob.size, cached: false };
	}
	// A copy from this cache that hasn't expired, without the network → { status, ok, type, blob } or
	// null. (Saving an area takes tiles from here rather than download them again.)
	async peek(url) {
		const c = await this.cache();
		if (!c) return null;
		try {
			const hit = await c.match(url);
			const stored = hit && +hit.headers.get('x-xray-stored');
			if (hit && Date.now() - stored < this.maxAge) return { status: hit.status, ok: hit.ok, type: hit.headers.get('content-type') || '', blob: await hit.blob() };
		} catch (e) { /* not there */ }
		return null;
	}
	touch(url) {
		this.idx.set(url, Date.now()); this.dirty = true;
		if (++this.touched >= this.flushEvery) this.flush(); else this.schedule();
	}
	schedule() {
		if (this.timer) return;
		this.timer = setTimeout(() => { this.timer = 0; this.flush(); }, this.flushAfterMs);
		if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();   // Node: don't hold the process open
	}
	// Write the LRU index back (merged with the stored one and the cache's keys) and evict the least
	// recently used tiles over the limit. A call during a write waits for it and for one more if
	// tiles arrived meanwhile, so `await flush()` always means "written".
	flush() {
		if (this.timer) { clearTimeout(this.timer); this.timer = 0; }
		if (this.flushing) { this.again = true; return this.flushing; }
		this.flushing = (async () => {
			do { this.again = false; await this.writeIndex(); } while (this.again && this.dirty);
		})().finally(() => { this.flushing = null; });
		return this.flushing;
	}
	async writeIndex() {
		const c = await this.cache();
		if (!c || !this.dirty) return;
		this.dirty = false; this.touched = 0;
		try {
			// merge with the index as stored: another tab or worker may have written it since
			let stored = {};
			try { const r = await c.match(INDEX_KEY); if (r) stored = await r.json(); } catch (e) { /* none yet */ }
			for (const [u, t] of Object.entries(stored)) if (!(this.idx.get(u) >= +t)) this.idx.set(u, +t || 0);
			if (typeof c.keys === 'function') {
				const keys = new Set();
				for (const q of await c.keys()) { const u = typeof q === 'string' ? q : q.url; if (u !== INDEX_KEY) keys.add(u); }
				for (const u of keys) if (!this.idx.has(u)) this.idx.set(u, 0);          // in no index: oldest
				for (const u of [...this.idx.keys()]) if (!keys.has(u)) this.idx.delete(u); // gone (evicted elsewhere)
			}
			if (this.idx.size > this.maxEntries) {
				const old = [...this.idx.entries()].sort((a, b) => a[1] - b[1]).slice(0, this.idx.size - this.maxEntries);
				for (const [url] of old) { this.idx.delete(url); try { await c.delete(url); } catch (e) { /* ignore */ } }
			}
			await c.put(INDEX_KEY, new Response(JSON.stringify(Object.fromEntries(this.idx)), { headers: { 'content-type': 'application/json' } }));
		} catch (e) { /* ignore */ }
	}
}
