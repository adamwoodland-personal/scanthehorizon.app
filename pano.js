// Scan the Horizon panorama: march rays out from the observer across the DEM rings (dem.js), with Earth
// curvature and refraction, and keep for every azimuth
//   - the skyline (the highest angle reached anywhere on the ray, and its distance);
//   - the occluding ridge crests (where terrain drops out of sight and a farther ridge rises above
//     it again), linked across azimuths into ridge lines by distance continuity;
//   - (full pano only) the running maximum of the angle at every sample, so the visibility of any
//     target is one binary search on the shared distances plus two array reads (SPEC §6.1).
// Ported from the Node prototype (scratchpad xray/proto/pano.mjs), which was checked against the
// Glass House Mountains lookout sign and the Interlaken view. No DOM; runs in the worker or Node.
//
// Angles: tan of the elevation angle t = (h − h0 − nearAllow·max(0, 1 − d/nearM))/d − d(1−k)/2R,
// k = 0.13. Azimuth i·step clockwise from true north; every ray is a great circle.
import { R_EARTH, K_REFRACTION, mppAt, ringPx, sampleUV, ringForDistance, haversine, bearing } from './dem.js';

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const INV2PI = 1 / (2 * Math.PI), INV4PI = 1 / (4 * Math.PI);
export const PROF_SCALE = 200;            // profile units per degree (Int16: ±163°, 0.005° steps)
const PROF_NONE = -32768;                 // nothing in front yet

export const DEFAULTS = {
	step: 0.2,          // degrees between rays (coarse 0.5)
	k: K_REFRACTION,
	dMin: 60,           // m, first sample (skip the observer's own DEM cell)
	stepMin: 15,        // m, smallest step (never more than cellFrac of the ring's pixel)
	stepFrac: 0.003,    // step grows as d·stepFrac …
	cellFrac: 0.8,      // … but never past cellFrac × the ring's pixel
	gapRatio: 1.08,     // a crest is kept only if the hidden ground behind it runs to ≥ d·gapRatio,
	gapMin: 150,        // ≥ gapMin metres,
	dipMin: 0.02,       // and dips at least this many degrees below the sightline
	nearM: 300,         // within nearM the terrain is lowered by up to nearAllow metres (fading to 0),
	nearAllow: 6,       // so DEM noise next to the observer can't black out the view
	profile: true,      // keep the running-max profile (full pano)
};

// Sample distances shared by every ray, and the ring each one is drawn from.
export function sampleDistances(rings, o) {
	const maxD = rings[rings.length - 1].outerKm * 1000;
	const d = [], ri = [];
	let x = o.dMin, r = 0;
	while (x <= maxD) {
		while (r < rings.length - 1 && x > rings[r].outerKm * 1000) r++;
		d.push(x); ri.push(r);
		const cell = rings[r].mpp, cap = o.cellFrac * cell;
		x += Math.max(Math.min(o.stepMin, cap), Math.min(x * o.stepFrac, cap));
	}
	return { d: Float64Array.from(d), ri: Uint8Array.from(ri) };
}

// The panorama. rings: the ring list to draw from (finest first); obs: { lat, lon, h0 }.
// Returns { n, step, alt, dist, sea, crests, profile, d, ri, ns, h0, ms }.
export function computePanorama(rings, obs, opts = {}) {
	const o = { ...DEFAULTS, ...opts };
	const t0 = now();
	const { d, ri } = sampleDistances(rings, o);
	const ns = d.length, h0 = obs.h0;
	const phi1 = obs.lat * D2R, lam1 = obs.lon * D2R, sp1 = Math.sin(phi1), cp1 = Math.cos(phi1);
	const sd = new Float64Array(ns), cd = new Float64Array(ns), inv = new Float64Array(ns), curv = new Float64Array(ns);
	for (let i = 0; i < ns; i++) {
		const del = d[i] / R_EARTH; sd[i] = Math.sin(del); cd[i] = Math.cos(del);
		inv[i] = 1 / d[i];
		curv[i] = d[i] * (1 - o.k) / (2 * R_EARTH) + (o.nearAllow * Math.max(0, 1 - d[i] / o.nearM)) / d[i];
	}
	// Per-ring constants for the inlined sampler fast path.
	const nR = rings.length;
	const rS = new Float64Array(nR), rOx = new Float64Array(nR), rOy = new Float64Array(nR), rW = new Float64Array(nR);
	const rSh = new Int32Array(nR), rMask = new Int32Array(nR), rSize = new Int32Array(nR), rNx = new Int32Array(nR), rNy = new Int32Array(nR);
	const rSlots = rings.map((R) => R.slots);
	for (let r = 0; r < nR; r++) {
		const R = rings[r];
		rS[r] = R.S; rOx[r] = 0.5 + R.ux0 * R.size; rOy[r] = 0.5 + R.ty0 * R.size; rW[r] = R.W;
		rSh[r] = R.sh; rMask[r] = R.mask; rSize[r] = R.size; rNx[r] = R.nx; rNy[r] = R.ny;
	}
	const n = Math.round(360 / o.step);
	const alt = new Float32Array(n), dist = new Float32Array(n), sea = new Uint8Array(n);
	const crests = new Array(n);
	const profile = o.profile ? new Int16Array(n * ns) : null;
	const tProf = new Float64Array(ns), hProf = new Float32Array(ns);
	// The great-circle point (one atan2 and one log) is computed exactly only every ANCHOR-th sample;
	// in between, Web Mercator (u, v) is interpolated linearly in distance. The ray is smooth in
	// Mercator: over 8 steps (≤ 3.5 km even in the 545 m ring) the chord is < 0.3 m off the great
	// circle, far below a pixel. anc = the anchor samples; ja[i], wa[i] = sample i's segment and weight.
	const ANCHOR = 8;
	const ancL = []; for (let i = 0; i < ns; i += ANCHOR) ancL.push(i); if (ancL[ancL.length - 1] !== ns - 1) ancL.push(ns - 1);
	const nA = ancL.length, ja = new Int32Array(ns), wa = new Float64Array(ns);
	for (let i = 0, j = 0; i < ns; i++) {
		while (j < nA - 2 && i >= ancL[j + 1]) j++;
		ja[i] = j; wa[i] = nA < 2 ? 0 : (d[i] - d[ancL[j]]) / (d[ancL[j + 1]] - d[ancL[j]]);
	}
	const uA = new Float64Array(nA), vA = new Float64Array(nA);
	for (let a = 0; a < n; a++) {
		const th = a * o.step * D2R, ct = Math.cos(th), st = Math.sin(th);
		for (let j = 0; j < nA; j++) {
			const i = ancL[j], sp2 = sp1 * cd[i] + cp1 * sd[i] * ct;
			uA[j] = (lam1 + Math.atan2(st * sd[i] * cp1, cd[i] - sp1 * sp2)) * INV2PI + 0.5;
			vA[j] = 0.5 - Math.log((1 + sp2) / (1 - sp2)) * INV4PI;
		}
		// ---- terrain along the ray
		for (let i = 0; i < ns; i++) {
			const j = ja[i], w = wa[i];
			const u = uA[j] + (uA[j + 1] - uA[j]) * w, v = vA[j] + (vA[j + 1] - vA[j]) * w;
			const r = ri[i], S = rS[r];
			let px = u * S - rOx[r];
			if (px < -S / 2) px += S; else if (px > rW[r] + S / 2) px -= S;
			const py = v * S - rOy[r];
			const ix = Math.floor(px), iy = Math.floor(py);
			const c = ix >> rSh[r], rr = iy >> rSh[r];
			let h;
			if (c >= 0 && rr >= 0 && c < rNx[r] && rr < rNy[r]) {
				const T = rSlots[r][rr * rNx[r] + c], m = rMask[r], lx = ix & m, ly = iy & m;
				if (T !== null && lx !== m && ly !== m) {
					const sz = rSize[r], k0 = ly * sz + lx, fx = px - ix, fy = py - iy;
					const A = T[k0], B = T[k0 + 1], C = T[k0 + sz], E = T[k0 + sz + 1];
					const p = A + (B - A) * fx;
					h = p + (C + (E - C) * fx - p) * fy;
				} else h = sampleUV(rings, r, u, v);
			} else h = sampleUV(rings, r, u, v);
			hProf[i] = h;
			tProf[i] = (h - h0) * inv[i] - curv[i];
		}
		if (o.debug && o.debug.ray === a) o.debug.h = hProf.slice();   // unit-test hook
		// ---- visibility, the running-max profile and the occluding crests along this ray
		const list = [];
		let M = -Infinity, Mq = PROF_NONE, vis = false, pend = -1, pendM = 0, minHidden = Infinity;
		const po = a * ns;
		for (let i = 0; i < ns; i++) {
			const t = tProf[i];
			if (t >= M) {
				if (!vis && pend >= 0) {
					const dip = (Math.atan(pendM) - Math.atan(minHidden)) * R2D;
					if (d[i] >= d[pend] * o.gapRatio && d[i] - d[pend] >= o.gapMin && dip >= o.dipMin)
						list.push({ d: d[pend], deg: Math.atan(pendM) * R2D, dip, sky: false, sea: hProf[pend] < 1 });
					pend = -1;
				}
				vis = true;
				if (t > M && profile) { const q = Math.round(Math.atan(t) * R2D * PROF_SCALE); Mq = q > 32767 ? 32767 : q; }
				M = t;
			} else if (vis) { pend = i - 1; pendM = M; minHidden = t; vis = false; }
			else if (t < minHidden) minHidden = t;
			if (profile) profile[po + i] = Mq;
		}
		// The skyline: the last crest that stays in view to the end of the ray, or the end of the ray
		// itself when terrain is still rising there (cut by the range).
		let sky;
		if (pend >= 0 && !vis) sky = { d: d[pend], deg: Math.atan(pendM) * R2D, dip: (Math.atan(pendM) - Math.atan(minHidden)) * R2D, sky: true, sea: hProf[pend] < 1, cut: false };
		else sky = { d: d[ns - 1], deg: Math.atan(M) * R2D, dip: 0, sky: true, sea: hProf[ns - 1] < 1, cut: true };
		list.push(sky);
		alt[a] = sky.deg; dist[a] = sky.d / 1000; sea[a] = sky.cut ? 2 : sky.sea ? 1 : 0;
		crests[a] = list;
	}
	return { n, step: o.step, alt, dist, sea, crests, profile, d, ri, ns, h0, k: o.k, nearM: o.nearM, nearAllow: o.nearAllow, ms: now() - t0 };
}

// Link crests of neighbouring azimuths into ridge lines (greedy one-to-one by cost), then pack them
// for the protocol (SPEC §5): pts = az, alt, dist(km) triples; starts[i] = first point of line i
// (length lines + 1); dip = the line's largest dip (deg), len = its angular length (deg), med = its
// median distance (km). Lines are ordered far → near. A line ends at the 0°/360° seam rather than
// crossing it, so its points' azimuths always increase.
export function linkRidges(pano, { distTol = 0.12, distAbs = 250, angTol = 1.0, minPts = 3 } = {}) {
	const done = [];
	let active = [];
	for (let a = 0; a < pano.n; a++) {
		const cs = pano.crests[a], az = a * pano.step, pairs = [];
		for (let p = 0; p < active.length; p++) {
			const last = active[p].pts[active[p].pts.length - 1];
			for (let c = 0; c < cs.length; c++) {
				const cr = cs[c];
				const dd = Math.abs(cr.d - last.d), rel = dd / Math.max(cr.d, last.d), da = Math.abs(cr.deg - last.deg);
				if ((rel > distTol && dd > distAbs) || da > angTol) continue;
				pairs.push([Math.min(rel / distTol, dd / distAbs) + da / angTol, p, c]);
			}
		}
		pairs.sort((x, y) => x[0] - y[0]);
		const usedP = new Uint8Array(active.length), usedC = new Uint8Array(cs.length), next = [];
		for (const [, p, c] of pairs) {
			if (usedP[p] || usedC[c]) continue;
			usedP[p] = usedC[c] = 1;
			active[p].pts.push({ az, ...cs[c] });
			next.push(active[p]);
		}
		for (let p = 0; p < active.length; p++) if (!usedP[p]) done.push(active[p]);
		for (let c = 0; c < cs.length; c++) if (!usedC[c]) next.push({ pts: [{ az, ...cs[c] }] });
		active = next;
	}
	done.push(...active);
	const lines = done.filter((l) => l.pts.length >= minPts).map((l) => {
		const ds = l.pts.map((p) => p.d).sort((x, y) => x - y);
		let dip = 0; for (const p of l.pts) if (p.dip > dip) dip = p.dip;
		return { pts: l.pts, med: ds[ds.length >> 1] / 1000, len: l.pts.length * pano.step, dip };
	}).sort((x, y) => y.med - x.med);
	let total = 0; for (const l of lines) total += l.pts.length;
	const pts = new Float32Array(total * 3), starts = new Uint32Array(lines.length + 1);
	const dip = new Float32Array(lines.length), len = new Float32Array(lines.length), med = new Float32Array(lines.length);
	let k = 0;
	lines.forEach((l, i) => {
		starts[i] = k / 3; dip[i] = l.dip; len[i] = l.len; med[i] = l.med;
		for (const p of l.pts) { pts[k++] = p.az; pts[k++] = p.deg; pts[k++] = p.d / 1000; }
	});
	starts[lines.length] = total;
	return { pts, starts, dip, len, med };
}

// ---- Visibility ----------------------------------------------------------------------------------
// Pixel error (m) assumed for the ring a distance falls in (SPEC §6.2): ~3 m at z13, 10 z12, 20 z11,
// 30 coarser; chosen by pixel size so it holds at any latitude and for AWS rings.
export function ringError(mpp) { return mpp <= 12 ? 3 : mpp <= 24 ? 10 : mpp <= 48 ? 20 : 30; }
// Marginal band (deg) at distance dKm.
export function band(dKm, mpp) { return 0.05 + 0.00054 * dKm + (2 + ringError(mpp)) / (dKm * 1000) * R2D; }

// Terrain this close to a target counts as the target itself (a peak's own shoulders).
export function ownMargin(kind, dist, cell) {
	return kind === 'peak' || kind === 'hill' ? Math.max(2 * cell, 0.01 * dist, 60) : Math.max(1.5 * cell, 40);
}

// Angle (deg) of a point h metres high at distance dist metres, from eye height h0.
export function altitudeOf(h, h0, dist, k = K_REFRACTION) {
	return Math.atan((h - h0) / dist - dist * (1 - k) / (2 * R_EARTH)) * R2D;
}

// Last shared-sample index with d[i] < x (−1 if none).
function lastBefore(d, x) {
	let lo = 0, hi = d.length - 1, ans = -1;
	while (lo <= hi) { const m = (lo + hi) >> 1; if (d[m] < x) { ans = m; lo = m + 1; } else hi = m - 1; }
	return ans;
}
// Running max (deg) on ray a at sample index i, or −Infinity.
function profAt(pano, a, i) {
	if (i < 0) return -Infinity;
	const q = pano.profile[a * pano.ns + i];
	return q === PROF_NONE ? -Infinity : q / PROF_SCALE;
}
// Running max (deg) at distance x (m) on the exact bearing az, interpolated between the two rays
// either side, plus the lower and higher of the two.
export function profileAt(pano, az, x, inclusive = false) {
	const i = inclusive ? lastBefore(pano.d, x + 1e-6) : lastBefore(pano.d, x);
	const f = az / pano.step, a0 = Math.floor(f) % pano.n, a1 = (a0 + 1) % pano.n, w = f - Math.floor(f);
	const m0 = profAt(pano, a0, i), m1 = profAt(pano, a1, i);
	const mid = m0 === -Infinity || m1 === -Infinity ? Math.max(m0, m1) : m0 + (m1 - m0) * w;
	return { lo: Math.min(m0, m1), hi: Math.max(m0, m1), mid, i };
}

// March the exact bearing az from the observer to distance x (m): the highest angle in front (deg)
// and where it is (m). Same angle formula as the pano, finer steps. As in computePanorama, the
// great-circle point is computed exactly only every MARCH_ANCHOR-th sample and Web Mercator (u, v) is
// interpolated linearly in distance between (under 0.3 m off the great circle): the trigonometry was
// most of the cost, and the labels step re-marches several hundred targets near the coast.
const MARCH_ANCHOR = 8;
let marchBuf = new Float64Array(4096);
export function marchBearing(rings, obs, az, x, { k = K_REFRACTION, nearM = DEFAULTS.nearM, nearAllow = DEFAULTS.nearAllow, dMin = DEFAULTS.dMin } = {}) {
	const phi1 = obs.lat * D2R, lam1 = obs.lon * D2R, sp1 = Math.sin(phi1), cp1 = Math.cos(phi1);
	const th = az * D2R, ct = Math.cos(th), st = Math.sin(th);
	// the sample distances (and each one's ring), as before
	let n = 0, r = 0;
	for (let s = dMin; s < x; n++) {
		if (n >= marchBuf.length) { const b = new Float64Array(marchBuf.length * 2); b.set(marchBuf); marchBuf = b; }
		while (r < rings.length - 1 && s > rings[r].outerKm * 1000) r++;
		marchBuf[n] = s;
		s += Math.max(5, Math.min(s * 0.002, rings[r].mpp * 0.5));
	}
	const point = (s) => {
		const del = s / R_EARTH, sd = Math.sin(del), cdl = Math.cos(del);
		const sp2 = sp1 * cdl + cp1 * sd * ct;
		return [(lam1 + Math.atan2(st * sd * cp1, cdl - sp1 * sp2)) * INV2PI + 0.5, 0.5 - Math.log((1 + sp2) / (1 - sp2)) * INV4PI];
	};
	let M = -Infinity, Md = 0;
	r = 0;
	let a0 = 0, a1 = 0, p0 = null, p1 = null;
	for (let i = 0; i < n; i++) {
		if (i === a1) {                                  // next segment between exact points
			a0 = i; p0 = i === 0 ? point(marchBuf[0]) : p1;
			a1 = Math.min(n - 1, i + MARCH_ANCHOR); p1 = a1 === a0 ? p0 : point(marchBuf[a1]);
			if (a1 === a0) a1 = n;                       // the last sample: no segment after it
		}
		const s = marchBuf[i];
		const w = a1 > a0 && a1 < n ? (s - marchBuf[a0]) / (marchBuf[a1] - marchBuf[a0]) : 0;
		while (r < rings.length - 1 && s > rings[r].outerKm * 1000) r++;
		const u = p0[0] + (p1[0] - p0[0]) * w, v = p0[1] + (p1[1] - p0[1]) * w;
		// bilinear inside one tile, as computePanorama does; sampleUV at tile edges and in holes
		const R = rings[r], S = R.S;
		let px = u * S - 0.5 - R.ux0 * R.size;
		if (px < -S / 2) px += S; else if (px > R.W + S / 2) px -= S;
		const py = v * S - 0.5 - R.ty0 * R.size, ix = Math.floor(px), iy = Math.floor(py);
		const c = ix >> R.sh, rr = iy >> R.sh, m = R.mask, lx = ix & m, ly = iy & m;
		const T = c >= 0 && rr >= 0 && c < R.nx && rr < R.ny ? R.slots[rr * R.nx + c] : null;
		let h;
		if (T !== null && lx !== m && ly !== m) {
			const sz = R.size, k0 = ly * sz + lx, fx = px - ix, fy = py - iy;
			const A = T[k0], B = T[k0 + 1], C = T[k0 + sz], E = T[k0 + sz + 1];
			const q = A + (B - A) * fx;
			h = q + (C + (E - C) * fx - q) * fy;
		} else h = sampleUV(rings, r, u, v);
		const t = (h - obs.h0 - nearAllow * Math.max(0, 1 - s / nearM)) / s - s * (1 - k) / (2 * R_EARTH);
		if (t > M) { M = t; Md = s; }
	}
	return { blockAlt: M === -Infinity ? -90 : Math.atan(M) * R2D, blockDist: Md };
}

// The blocking terrain in front of distance x on the ray nearest az, from the profile: its angle is
// the running max there, and since the profile is monotone, where it was reached is a binary search.
export function blockFromProfile(pano, az, x) {
	const a = Math.round(az / pano.step) % pano.n, i = lastBefore(pano.d, x);
	if (i < 0) return { blockAlt: -90, blockDist: 0 };
	const P = pano.profile, o = a * pano.ns, q = P[o + i];
	let lo = 0, hi = i;
	while (lo < hi) { const m = (lo + hi) >> 1; if (P[o + m] >= q) hi = m; else lo = m + 1; }
	return { blockAlt: q === PROF_NONE ? -90 : q / PROF_SCALE, blockDist: pano.d[lo] };
}

// Visibility of one target (SPEC §6.2): margin = target angle − highest terrain angle in front on
// its exact bearing. The profile of the two rays either side decides when both agree by more than
// the band plus `slack`; anything closer is re-marched on the exact bearing. A clearly hidden major
// takes its blocker (angle, distance) from the profile of the nearest ray.
// tgt: { lat, lon, h, kind, dist?, az?, major? }.
export function visibility(rings, pano, obs, tgt, { slack = 0.1 } = {}) {
	const dist = tgt.dist ?? haversine(obs.lat, obs.lon, tgt.lat, tgt.lon);
	const az = tgt.az ?? bearing(obs.lat, obs.lon, tgt.lat, tgt.lon);
	const cell = rings[ringForDistance(rings, dist)].mpp;
	const own = ownMargin(tgt.kind, dist, cell), front = Math.max(1, dist - own);
	const alt = altitudeOf(tgt.h, obs.h0, dist, pano.k);
	const b = band(dist / 1000, cell);
	const p = profileAt(pano, az, front);
	let margin, exact = false, blockAlt = null, blockDist = null;
	const lo = alt - p.hi, hi = alt - p.lo;
	if (lo >= b + slack) margin = alt - p.mid;
	else if (hi <= -b - slack) {
		margin = alt - p.mid;
		if (tgt.major) ({ blockAlt, blockDist } = blockFromProfile(pano, az, front));
	} else {
		const m = marchBearing(rings, obs, az, front, { k: pano.k, nearM: pano.nearM, nearAllow: pano.nearAllow });
		margin = alt - m.blockAlt; exact = true; blockAlt = m.blockAlt; blockDist = m.blockDist;
	}
	const status = margin >= b ? 'visible' : margin > -b ? 'marginal' : 'hidden';
	return { az, dist, alt, margin, band: b, status, exact, blockAlt, blockDist, own, profLo: lo, profHi: hi };
}

// The drawn terrain angle at a peak's bearing just beyond its summit: what the drawing shows there,
// so a flattened spire's label never floats above the line (SPEC §5 "anchor").
export function anchorAt(pano, az, x) { return profileAt(pano, az, x, true).mid; }

function now() { return (typeof performance !== 'undefined' ? performance : Date).now(); }
