// Scan the Horizon: drawing. Two projections of one panorama (SPEC §7):
//  - the sign view, a cylindrical strip like a lookout's sign: x follows the bearing, y the
//    altitude times the vertical exaggeration; pitch and roll are ignored;
//  - the camera view, a true pinhole camera through the phone's attitude (attitude.js), at true
//    scale, to line up with the live picture.
// Both draw the skyline and the ridge lines the slider keeps; the sign view also fills the bands
// between them in greys, darker near and lighter far, as aerial perspective does on the sign.
// Names sit above the drawing in ovals (DOM elements, so they can be tapped), each with a
// vertical leader down to what it names; when no row above has room, a name hangs below the
// skyline instead, in the ground, with its leader up to what it names. They are laid out in rows:
// each takes the free row nearest its anchor, and a label is dropped rather than let a leader
// cross another label, so the leaders never cross and the names stay in bearing order, left to
// right.
//
// Units as in the worker protocol (SPEC §5): azimuth in degrees clockwise from true north,
// altitude in degrees above the horizontal, distance in km.
import { wrap180, projector } from './attitude.js';

// ---- Theme ----------------------------------------------------------------------------------------
// The colours live in xray.css as custom properties (light, dark and camera sets); read them
// whenever the theme or the view changes.
function parseColor(s) {
	s = (s || '').trim();
	let m = s.match(/^#([0-9a-f]{3})$/i);
	if (m) return m[1].split('').map((h) => parseInt(h + h, 16));
	m = s.match(/^#([0-9a-f]{6})$/i);
	if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
	m = s.match(/rgba?\(([^)]+)\)/i);
	if (m) return m[1].split(',').slice(0, 3).map((v) => parseFloat(v));
	return [128, 128, 128];
}
let FONT = 'system-ui, sans-serif';
export function readTheme(el = document.body) {
	const cs = getComputedStyle(el), get = (n) => cs.getPropertyValue(n).trim();
	FONT = cs.fontFamily || FONT;
	const c = (n) => parseColor(get(n)), pc = c('--panel');
	return {
		// a dark board (the dark theme): the ridge lines are toned down there, as light lines on navy
		// read much heavier than dark lines on the light board
		dark: (0.2126 * pc[0] + 0.7152 * pc[1] + 0.0722 * pc[2]) / 255 < 0.4,
		panel: get('--panel'), bandNear: c('--band-near'), bandFar: c('--band-far'), ridge: c('--ridge'), skyline: get('--skyline'),
		sea: get('--sea'), leader: get('--leader'), tick: get('--tick'), ink: get('--ink'), muted: get('--muted'), accent: get('--accent'),
		labelBg: get('--label-bg'), labelLine: get('--label-line'),
	};
}
const rgb = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
// 0 near → 1 far, on a log scale from 0.7 km to the range edge.
const farness = (dKm, rangeKm) => Math.min(1, Math.max(0, Math.log(Math.max(dKm, 0.7) / 0.7) / Math.log(Math.max(rangeKm, 5) / 0.7)));

// ---- The detail slider (SPEC §6.4) ------------------------------------------------------------------
// Five stops; the numbers between stops are interpolated, the kinds of place considered switch at
// each stop. Ridge lines are kept when they dip at least `dip` degrees in front of what's behind
// them, or run at least `len` degrees; at the first stop only the skyline is drawn.
export const STOPS = [
	{ v: 0, name: 'Fewest', minScore: 4.5, per390: 5, dip: null, len: null },
	{ v: 25, name: 'Few', minScore: 3.5, per390: 9, dip: 0.4, len: 8 },
	{ v: 50, name: 'Normal', minScore: 2.5, per390: 15, dip: 0.15, len: 3 },
	{ v: 75, name: 'More', minScore: 1.5, per390: 25, dip: 0.05, len: 1 },
	{ v: 100, name: 'All', minScore: -Infinity, per390: 40, dip: 0.02, len: 0.5 },
];
// Marginal places (within the uncertainty band either side of the line of sight) come in at
// Normal when the line of sight clears the ground in front (margin ≥ 0, "just in view"), and at
// More when it doesn't; both get a dashed leader. A town on flat ground seen from above is always
// marginal (its +10 m is ~0.02–0.04° at 15–30 km, inside the band), so admitting marginal places
// only from More left Normal with almost no towns: Caloundra, on the lookout's sign, is one. Not
// from the lowest stops: labels that come in at a lower stop are laid out first at every stop
// (see layoutOrder in app.js), and the coast's many small towns would then crowd the sign's peaks
// off a phone screen. (SPEC §6.4, changed 2026-10-30 by the integrator.)
export const MARGINAL_FROM = 3, MARGINAL_CLEAR_FROM = 2;
export function stopName(v) { return STOPS.reduce((a, s) => (Math.abs(s.v - v) < Math.abs(a.v - v) ? s : a)).name; }
// relax: how much the minimum score drops with zoom, 0.5·log2(default field / field now).
// air: the Airports setting (0 none, 1 major, 2 and regional, 3 and every airfield: AIR_STOPS), which
// names airports up to that size whatever the stop; they have a budget of their own, AIR_SHARE of the
// names', so they come in where there's room without pushing the rest out, and never crowd a screen.
export const AIR_STOPS = ['None', 'Major only', 'Major and regional', 'All, with airfields'];
export const AIR_SHARE = 1 / 3;
export function detailParams(v, width, relax = 0, air = 0) {
	v = Math.min(100, Math.max(0, +v || 0));
	const i = Math.min(3, Math.floor(v / 25)), a = STOPS[i], b = STOPS[i + 1], t = (v - a.v) / 25;
	const level = v >= 100 ? 4 : i;
	const lerp = (x, y) => x + (y - x) * t, geo = (x, y) => x * Math.pow(y / x, t);
	let minScore = b.minScore === -Infinity ? (t >= 1 ? -Infinity : lerp(a.minScore, -1)) : lerp(a.minScore, b.minScore);
	if (v >= 100) minScore = -Infinity;
	let dip = null, len = null;
	if (v > 0) {
		const ad = a.dip ?? 2, al = a.len ?? 30; // just above the first stop: only the boldest ridges
		dip = geo(ad, b.dip); len = geo(al, b.len);
		if (t === 0 && a.dip !== null) { dip = a.dip; len = a.len; }
	}
	const budget = Math.max(1, Math.round(lerp(a.per390, b.per390) * width / 390));
	air = Math.min(3, Math.max(0, Math.round(+air) || 0));
	return { v, level, minScore: minScore - relax, budget, dip, len, air, airBudget: Math.max(1, Math.round(budget * AIR_SHARE)) };
}
const SETTLEMENT = new Set(['city', 'town', 'village', 'suburb', 'hamlet']);
// Is this place named at this setting? The kinds the stop considers are always eligible; anything
// else must reach the minimum score. Hidden places never are (majors get a behind-arrow instead).
// An airport is named by its size alone (the Airports setting, p.air), once in view as anything else
// is: one only just in view comes in at Normal or More, as a town does.
export function allowed(L, p) {
	if (L.status === 'hidden') return false;
	if (L.status === 'marginal' && p.level < (L.margin >= 0 ? MARGINAL_CLEAR_FROM : MARGINAL_FROM)) return false;
	if (L.kind === 'airport') return (L.air || 3) <= (p.air || 0);
	if (L.score >= p.minScore) return true;
	const k = L.kind, lv = p.level, pop = L.pop || 0, so = L.standOut || 0;
	if (lv >= 4) return true;
	if ((k === 'city' || k === 'town') || (k === 'peak' && so >= 1)) return true;
	if (lv >= 1 && ((SETTLEMENT.has(k) && k !== 'suburb' && k !== 'hamlet' && pop >= 1000) || (k === 'peak' && ((L.wl ?? (L.wiki ? 1 : 0)) >= 1 || so >= 0.5)))) return true;
	if (lv >= 2 && ((k === 'village' && L.dist <= 50) || (k === 'peak' && L.status === 'visible' && L.dist <= 60) || k === 'lake' || k === 'island' || k === 'lighthouse')) return true;
	if (lv >= 3 && (((k === 'suburb' || k === 'hamlet') && L.dist <= 15) || ['hill', 'cape', 'dam', 'tower', 'lookout'].includes(k))) return true;
	return false;
}
export const keepRidge = (dip, len, p) => p.dip !== null && (dip >= p.dip || len >= p.len);

// ---- Projections ----------------------------------------------------------------------------------
// g: the drawing area in CSS px { left, top, right, bottom, w, h, W, H } (W, H: the whole canvas).
// Each projection has pt(az, alt) → {x, y} or null (off to the side or behind), and breaks(a, b):
// whether a line between two consecutive bearings must be broken (the sign's back seam).
export function signProjection(g, centreAz, widthDeg, exag, horizonY) {
	const ppd = g.w / widthDeg, cx = g.left + g.w / 2, half = widthDeg / 2 + 8, out = { x: 0, y: 0 };
	return {
		kind: 'sign', ppd, exag, cx, hy: horizonY, centreAz, widthDeg,
		x: (az) => cx + wrap180(az - centreAz) * ppd,
		y: (alt) => horizonY - alt * ppd * exag,
		pt(az, alt) {
			const d = wrap180(az - centreAz);
			if (Math.abs(d) > half) return null;
			out.x = cx + d * ppd; out.y = horizonY - alt * ppd * exag;
			return out;
		},
		breaks: (a, b) => Math.abs(wrap180(a - centreAz) - wrap180(b - centreAz)) > 90,
		// the bearing under a screen x
		azAt: (x) => ((centreAz + (x - cx) / ppd) % 360 + 360) % 360,
	};
}
export function cameraProjection(g, q, vfov, view) {
	const f = projector(q, g.W, g.H, vfov), hfov = 2 * Math.atan(Math.tan(vfov * Math.PI / 360) * g.W / g.H) * 180 / Math.PI;
	return {
		kind: 'camera', q, vfov, hfov, centreAz: view.az, cx: g.W / 2,
		ppd: g.H / vfov, exag: 1,
		pt: (az, alt) => f(az, alt),
		breaks: () => false,
		x: (az) => { const p = f(az, view.alt); return p ? p.x : NaN; },
	};
}

// ---- The terrain ------------------------------------------------------------------------------------
// Which skyline samples are the sea horizon or flat ground (1), or cut off by the end of the range
// (2): drawn faint and dashed. The engine says so in pano.sea; failing that, the sea horizon is
// guessed: it sits at the dip angle for the eye's height above the sea, at the matching distance.
const masks = new WeakMap();
function skyMask(pano) {
	let m = masks.get(pano);
	if (m) return m;
	if (pano.sea && pano.sea.length === pano.n) { masks.set(pano, pano.sea); return pano.sea; }
	m = new Uint8Array(pano.n);
	const R = 6371008.8, k = 0.13, h = Math.max(1, pano.eye || 1);
	const dip = Math.sqrt(2 * h * (1 - k) / R) * 180 / Math.PI, dH = Math.sqrt(2 * R * h / (1 - k)) / 1000;
	for (let i = 0; i < pano.n; i++) {
		const a = pano.alt[i], d = pano.dist[i];
		if (d >= pano.rangeKm - 1.5) m[i] = 2;
		else if (Math.abs(a + dip) < 0.02 + 0.08 * dip && Math.abs(d - dH) < 0.3 * dH) m[i] = 1;
	}
	masks.set(pano, m);
	return m;
}

// (Filling the bands between crests column by column was tried and dropped: the fills left hard
// vertical edges wherever a ridge line starts or stops. The soft strokes below replaced them.)

// Draw the panorama. Returns skyTop: for each CSS px column, the highest (smallest y) terrain point
// drawn there, so the labels can keep to the sky.
export function drawTerrain(ctx, P, pano, ridgeParams, theme, g) {
	const W = Math.ceil(g.W), skyTop = new Float32Array(W).fill(Infinity);
	if (!pano) return skyTop;
	const sign = P.kind === 'sign', bottom = g.bottom, range = pano.rangeKm || 150, n = pano.n, step = pano.step;
	const mask = skyMask(pano);
	const tone = (d) => mix(theme.bandNear, theme.bandFar, Math.pow(farness(d, range), 0.85));

	// The skyline as runs of screen points (a run breaks behind the camera or at the sign's seam).
	const runs = [];
	{
		let run = null, prevAz = null;
		const push = () => { if (run && run.length > 1) runs.push(run); run = null; };
		let k0 = 0, k1 = n;
		if (sign) { const half = P.widthDeg / 2 + 2; k0 = Math.floor((P.centreAz - half) / step); k1 = Math.ceil((P.centreAz + half) / step) + 1; }
		for (let k = k0; k < k1; k++) {
			const i = ((k % n) + n) % n, az = i * step;
			let p;
			if (sign) p = { x: P.cx + (k * step - P.centreAz) * P.ppd, y: P.hy - pano.alt[i] * P.ppd * P.exag };
			else { const q = P.pt(az, pano.alt[i]); p = q && { x: q.x, y: q.y }; }
			if (!p || (prevAz !== null && !sign && P.breaks(prevAz, az))) { push(); prevAz = az; if (!p) continue; }
			(run = run || []).push({ x: p.x, y: p.y, d: pano.dist[i], m: mask[i] });
			prevAz = az;
		}
		push();
		// the camera view wraps round: join the last run to the first when they meet at north
		if (!sign && runs.length > 1) {
			const a = runs[runs.length - 1], b = runs[0];
			if (Math.hypot(a[a.length - 1].x - b[0].x, a[a.length - 1].y - b[0].y) < 40) { runs[0] = a.concat(b); runs.pop(); }
		}
	}
	for (const run of runs) for (let j = 1; j < run.length; j++) {
		const a = run[j - 1], b = run[j], x0 = Math.max(0, Math.floor(Math.min(a.x, b.x))), x1 = Math.min(W - 1, Math.ceil(Math.max(a.x, b.x)));
		for (let x = x0; x <= x1; x++) { const y = Math.min(a.y, b.y); if (y < skyTop[x]) skyTop[x] = y; }
	}

	// Sign view: the ground below the skyline in one smooth wash, the far grey where it meets the
	// sky and darker towards the bottom (lower in the picture is nearer: the sign's aerial
	// perspective). Each ridge line then gets a soft band of its own grey just below it (see
	// below), so the layers read darker near and lighter far without hard edges where a ridge stops.
	if (sign) {
		let yTop = Infinity;
		for (const run of runs) for (const p of run) if (p.y < yTop) yTop = p.y;
		if (Number.isFinite(yTop)) {
			const base = ctx.createLinearGradient(0, yTop, 0, bottom);
			base.addColorStop(0, rgb(theme.bandFar));
			base.addColorStop(Math.min(0.9, Math.max(0.1, (P.hy + 0.3 * (bottom - P.hy) - yTop) / Math.max(1, bottom - yTop))), rgb(mix(theme.bandNear, theme.bandFar, 0.55)));
			base.addColorStop(1, rgb(mix(theme.bandNear, theme.bandFar, 0.4)));
			ctx.fillStyle = base;
			for (const run of runs) {
				ctx.beginPath();
				ctx.moveTo(run[0].x, bottom);
				for (const p of run) ctx.lineTo(p.x, p.y);
				ctx.lineTo(run[run.length - 1].x, bottom);
				ctx.closePath();
				ctx.fill();
			}
		}
	}

	// The ridge lines the slider keeps, far to near; darker and heavier near. In the sign view a
	// ridge must also run at least 40 px across the screen or stand clearly (0.5°) in front of what's
	// behind it: the many short fragments in the foreground otherwise fill the lower half with
	// scribble, where the sign has a few clean bands.
	const r = pano.ridges;
	if (r && ridgeParams.dip !== null) {
		const pts = r.pts, order = [];
		for (let j = 0; j + 1 < r.starts.length; j++) {
			if (!keepRidge(r.dip[j], r.len[j], ridgeParams)) continue;
			if (sign && !(r.len[j] * P.ppd >= 40 || r.dip[j] >= 0.5)) continue;
			order.push(j);
		}
		order.sort((a, b) => r.med[b] - r.med[a]);
		ctx.lineJoin = 'round';
		for (const j of order) {
			const s = r.starts[j], e = r.starts[j + 1];
			// Quick reject: sign view, the first and last bearings both well outside the view, same side.
			if (sign) {
				const d0 = wrap180(pts[s * 3] - P.centreAz), d1 = wrap180(pts[(e - 1) * 3] - P.centreAz), lim = P.widthDeg / 2 + 8;
				if (Math.abs(d0) > lim && Math.abs(d1) > lim && Math.sign(d0) === Math.sign(d1) && r.len[j] < 180) continue;
			}
			const f = farness(r.med[j], range);
			// A Path2D, so it can be stroked again shifted down (the transform applies at stroke time).
			const path = new Path2D();
			let open = false, prevAz = null, x0 = Infinity, x1 = -Infinity;
			for (let k = s; k < e; k++) {
				const az = pts[k * 3], p = P.pt(az, pts[k * 3 + 1]);
				if (!p) { open = false; prevAz = az; continue; }
				if (!open || (prevAz !== null && P.breaks(prevAz, az))) path.moveTo(p.x, p.y); else path.lineTo(p.x, p.y);
				if (p.x < x0) x0 = p.x;
				if (p.x > x1) x1 = p.x;
				open = true; prevAz = az;
			}
			if (sign) {
				// Each layer: a soft band of the near grey just below the crest, strongest at the line
				// and gone ~16 px down, so the ground steps darker under every crest and the layers
				// read near-dark, far-light like the sign's. Three widening strokes, each starting at
				// the line, stack up to the fade; round caps let a ridge that stops end softly. (Not a
				// fill down to the bottom: those left hard vertical edges where ridges start and stop.)
				if (x1 - x0 > 6) {
					ctx.save();
					ctx.lineCap = 'round';
					ctx.strokeStyle = rgb(theme.bandNear, 0.075 - 0.03 * f);
					let off = 0;
					for (const w of [4, 9, 16]) {
						ctx.translate(0, w / 2 - off); off = w / 2;
						ctx.lineWidth = w;
						ctx.stroke(path);
					}
					ctx.restore();
				}
			} else { ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = 2.6 - 1.2 * f; ctx.stroke(path); }
			ctx.strokeStyle = rgb(theme.ridge, sign ? (0.8 - 0.45 * f) * (theme.dark ? 0.6 : 1) : 0.95 - 0.4 * f);
			ctx.lineWidth = sign ? 1.25 - 0.55 * f : 1.4 - 0.6 * f;
			ctx.stroke(path);
		}
	}

	// The skyline on top: the heaviest line, faint and dashed where it is the sea horizon or just
	// the end of the range over flat ground.
	ctx.lineJoin = 'round'; ctx.lineCap = 'round';
	for (const run of runs) {
		let j = 0;
		while (j < run.length - 1) {
			const faint = run[j].m !== 0 && run[j + 1].m !== 0;
			let e = j + 1;
			while (e < run.length - 1 && (run[e].m !== 0 && run[e + 1].m !== 0) === faint) e++;
			ctx.beginPath();
			ctx.moveTo(run[j].x, run[j].y);
			for (let k = j + 1; k <= e; k++) ctx.lineTo(run[k].x, run[k].y);
			if (faint) {
				ctx.setLineDash([5, 4]);
				ctx.strokeStyle = run[j].m === 1 ? theme.sea : theme.muted;
				ctx.lineWidth = 1.2;
				ctx.stroke();
				ctx.setLineDash([]);
			} else {
				if (!sign) { ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 4; ctx.stroke(); }
				ctx.strokeStyle = theme.skyline;
				ctx.lineWidth = sign ? 2 : 2.2;
				ctx.stroke();
			}
			j = e;
		}
	}
	return skyTop;
}

// ---- Compass ticks ------------------------------------------------------------------------------------
const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const point = (az) => POINTS[Math.round(((az % 360) + 360) % 360 / 22.5) % 16];
const CARD = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
// A strip along the bottom of the drawing: a tick every 10° (5° when zoomed in), numbers or the
// cardinal letters, and the bearing at the centre mark.
export function drawTicks(ctx, P, g, theme, centreAz) {
	const y0 = g.ticksTop, y1 = g.ticksTop + g.ticksH, cx = P.cx;
	ctx.save();
	ctx.fillStyle = theme.panel;
	ctx.globalAlpha = P.kind === 'sign' ? 0.9 : 0;
	ctx.fillRect(0, y0, g.W, y1 - y0);
	ctx.globalAlpha = 1;
	ctx.strokeStyle = theme.tick; ctx.fillStyle = theme.tick;
	ctx.lineWidth = 1;
	ctx.beginPath(); ctx.moveTo(0, y0 + 0.5); ctx.lineTo(g.W, y0 + 0.5); ctx.stroke();
	const ppd = P.kind === 'sign' ? P.ppd : g.W / P.hfov;
	const minor = ppd * 5 >= 14 ? 5 : 10, every = ppd * 10 >= 34 ? 10 : ppd * 30 >= 34 ? 30 : 90;
	const span = g.W / ppd / 2 + 10;
	const label = `${Math.round(((centreAz % 360) + 360) % 360) % 360}° ${point(centreAz)}`;
	ctx.font = '700 12px ' + FONT;
	const cw = ctx.measureText(label).width + 14;
	ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
	const sign = P.kind === 'sign';
	for (let a = Math.ceil((centreAz - span) / minor) * minor; a <= centreAz + span; a += minor) {
		const az = ((a % 360) + 360) % 360;
		// The camera view is a pinhole, not a linear strip: each tick sits where the horizon at its
		// bearing is drawn, so it lines up with the labels and ridges at that bearing.
		let x = cx + (a - centreAz) * ppd;
		if (!sign) { const p = P.pt(az, 0); if (!p) continue; x = p.x; }
		if (x < -20 || x > g.W + 20) continue;
		const major = az % 10 === 0, txt = az % every === 0 ? (CARD[az] || `${az}°`) : null;
		ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y0 + (major ? 6 : 3)); ctx.stroke();
		if (txt && Math.abs(x - cx) > cw / 2 + 12) {
			ctx.font = (CARD[az] ? '700 12px ' : '500 11px ') + FONT;
			ctx.fillText(txt, x, y1 - 5);
		}
	}
	// the centre mark and the bearing under it
	ctx.beginPath(); ctx.moveTo(cx - 6, y0); ctx.lineTo(cx + 6, y0); ctx.lineTo(cx, y0 + 7); ctx.closePath();
	ctx.fillStyle = theme.accent; ctx.fill();
	ctx.font = '700 12px ' + FONT;
	ctx.fillStyle = theme.ink;
	ctx.fillText(label, cx, y1 - 5);
	ctx.restore();
}

// ---- Labels -----------------------------------------------------------------------------------------
export const LAB_H = 22, ROW_H = 27;
// Width of a label's oval, measured once per text with the font xray.css gives .lab (the name
// at weight 600, the distance at 500), plus padding and border.
const widths = new Map();
let mctx = null;
export function labelWidth(name, h) {
	const key = name + '\u0000' + h;
	let w = widths.get(key);
	if (w !== undefined) return w;
	mctx = mctx || document.createElement('canvas').getContext('2d');
	const fam = FONT;
	mctx.font = `600 12.5px ${fam}`;
	w = mctx.measureText(name).width;
	if (h) { mctx.font = `500 12.5px ${fam}`; w += mctx.measureText(' ' + h).width; }
	w = Math.ceil(w + 16 + 3 + 4); // padding, border, and slack: canvas and DOM text widths differ a little
	widths.set(key, w);
	return w;
}

// Lay the labels out. cands: [{ key, ax, ay, w, behind }] in priority order. ahead: the labels
// that could be shown at any Detail setting, in the same order ({ key, ax, ay }), for the
// look-ahead below; it doesn't depend on the slider, so turning the slider up only adds names
// after those already placed and never moves them.
//
// Each label sits in a row above its anchor with a vertical leader down to it, as on the sign. When
// no row above has room (on a phone held upright the names over a crowded coast run out of room
// long before the sky does: two ovals can't both sit over anchors closer than an oval is wide), it
// may hang below the skyline instead, in the ground, with its leader up to its anchor. Hanging rows
// are counted up from the bottom of the drawing, so the hanging names line up with each other. The
// rules are the same either way: the oval doesn't touch another, no other label's leader passes
// through it, and its own leader passes through no other label, so leaders never cross a name, no
// two leaders share a line, and the names stay in bearing order.
//
// Among the allowed places a label takes the cheapest: the row nearest its anchor (above if at all
// possible: hanging costs HANG), the oval centred on its leader, clear of the terrain, and the row
// it had last frame (so names don't hop about as the view turns), but above all one that leaves
// room for the labels still to come: an oval over a later label's anchor should leave that label a
// free row below itself (whose leader then passes beside this oval), or room to hang, or it costs
// a lot. Ovals slide sideways to manage that, the leader still meeting them at least INSET px in
// from either end (clear of the rounded ends). Labels with no place are left out. budget: how many
// (besides behind-arrows and airports) may be placed; airBudget: how many airports (cands with air
// set), counted apart. A placed label's row is ≥ 0 above (counted down from the top) and < 0 hanging
// (−1 is the lowest hanging row); `hang` says which.
const HANG = 25, INSET = 10;
export function layoutLabels(cands, g, skyTop, budget, prevRows, ahead = cands, airBudget = 0) {
	const placed = [], top0 = (g.labelTop ?? g.top) + 8; // below any note floating under the bar
	const maxRow = Math.max(0, Math.floor((g.bottom - 30 - top0 - LAB_H) / ROW_H));
	const hangBase = g.bottom - 6; // the lowest hanging oval's bottom edge
	// The highest (hi false) or lowest (hi true) terrain drawn over a span of columns.
	const skyScan = (l, r, hi) => {
		let m = hi ? -Infinity : Infinity;
		for (let x = Math.max(0, Math.floor(l)); x <= Math.min(skyTop.length - 1, Math.ceil(r)); x++) {
			const v = skyTop[x];
			if (hi ? (v !== Infinity && v > m) : v < m) m = v;
		}
		return m;
	};
	// A leader is the vertical line at ax between the anchor and the oval's near edge: its bottom
	// edge above the anchor, its top edge when hanging.
	const free = (c, l, r, t, b, hang) => {
		const c0 = hang ? c.ay : b, c1 = hang ? t : c.ay;
		for (const p of placed) {
			if (l < p.r + 4 && r + 4 > p.l && t < p.b + 2 && b + 2 > p.t) return false;          // ovals touch
			const p0 = p.hang ? p.ay : p.b, p1 = p.hang ? p.t : p.ay;
			if (p.ax >= l - 3 && p.ax <= r + 3 && p0 < b && p1 > t) return false;                // its leader through this oval
			if (c.ax >= p.l - 3 && c.ax <= p.r + 3 && c0 < p.b && c1 > p.t) return false;         // this leader through its oval
			if (Math.abs(c.ax - p.ax) < 3) return false;                                          // two leaders on top of each other
		}
		return true;
	};
	const gapOf = (c) => (c.behind ? 30 : 7); // a behind-arrow needs room to be an arrow
	const lowRow = (c) => Math.min(maxRow, Math.floor((c.ay - gapOf(c) - LAB_H - top0) / ROW_H)); // the row nearest the anchor
	const hangRow = (c) => Math.floor((hangBase - LAB_H - c.ay - gapOf(c)) / ROW_H);           // the hanging row nearest it (−1: none)
	const rank = new Map(ahead.map((o, i) => [o.key, i]));
	let normal = 0, airs = 0;
	for (let ci = 0; ci < cands.length; ci++) {
		const c = cands[ci];
		if (c.air ? airs >= airBudget : !c.behind && normal >= budget) continue;
		if (c.ax < g.left + 4 || c.ax > g.right - 4 || c.ay < g.top + LAB_H + 14 || c.ay > g.bottom + 2) continue;
		const w = Math.min(c.w, g.right - g.left - 8);
		const lo = Math.max(g.left + 4, c.ax - w + INSET), hi = Math.min(g.right - 4 - w, c.ax - INSET);
		const low = lowRow(c), hk = c.behind ? -1 : hangRow(c); // behind-arrows point up, so never hang
		if (lo > hi || (low < 0 && hk < 0)) continue;
		// What its own leader rules out, wherever the oval goes: no place at all if it would lie on
		// another leader; and a placed oval across the leader's line, on the anchor's side, must stay
		// between the anchor and this oval, which bounds the rows (above: this oval's bottom no higher
		// than that one's; hanging: its top no lower). The same rule free() applies, worked out once
		// here: labels that find no place are the slow ones, and a crowded coast has many.
		let kAbove = 0, kHang = 0, lost = false;
		for (const p of placed) {
			if (Math.abs(c.ax - p.ax) < 3) { lost = true; break; }
			if (c.ax < p.l - 3 || c.ax > p.r + 3) continue;
			if (p.t < c.ay) kAbove = Math.max(kAbove, Math.ceil((p.b - LAB_H - top0) / ROW_H));
			if (p.b > c.ay) kHang = Math.max(kHang, Math.ceil((hangBase - LAB_H - p.t) / ROW_H));
		}
		if (lost || (kAbove > low && kHang > hk)) continue;
		const ideal = Math.min(hi, Math.max(lo, c.ax - w / 2));
		// later labels near enough to be covered: their anchor, the lowest row above it they could
		// use, and whether they could hang
		const others = [];
		for (let j = (rank.has(c.key) ? rank.get(c.key) : -1) + 1; j < ahead.length; j++) {
			const o = ahead[j];
			if (Math.abs(o.ax - c.ax) >= 3 && Math.abs(o.ax - c.ax) < w + 6) others.push([o.ax, o.ay, lowRow(o), hangRow(o) >= 0]);
		}
		const tries = [ideal, ideal - w / 4, ideal + w / 4, lo, hi];
		for (const [x] of others) tries.push(x + 4, x - 4 - w); // just clear of a neighbour's leader
		for (const p of placed) if (p.r > c.ax - w - 10 && p.l < c.ax + w + 10) tries.push(p.r + 5, p.l - 5 - w, p.ax + 4, p.ax - 4 - w); // just clear of one already placed
		const lefts = tries.map((x) => Math.min(hi, Math.max(lo, x))).filter((x, i, a) => a.findIndex((y) => Math.abs(y - x) < 2) === i);
		const prev = prevRows && prevRows.get(c.key);
		let row = 0, l = 0, best = Infinity, hang = false;
		// Above.
		for (const x of lefts) {
			const clear = skyScan(x, x + w, false) - 3;
			for (let k = low; k >= kAbove; k--) {
				if (low - k - 0.6 >= best) break; // every row from here on costs at least this much
				const t = top0 + k * ROW_H, b = t + LAB_H;
				let cost = (low - k) + Math.abs(x - ideal) / 400 + (b > clear ? 6 : 0) + (prev === k ? -0.6 : 0);
				for (const [ox, oy, orow, oh] of others) {
					if (ox < x - 3 || ox > x + w + 3) continue;
					if (oy > t - 2 && oy < b + 2) cost += 40;  // its anchor under this oval
					else if (k >= orow) cost += oh ? 6 : 40;  // no row left above it: it must hang, if it can
					else cost += 1.5;
				}
				if (cost >= best) continue;
				if (free(c, x, x + w, t, b, false)) { best = cost; row = k; l = x; hang = false; }
			}
		}
		// Hanging, only when that could beat the best place above.
		if (hk >= kHang && best > HANG) for (const x of lefts) {
			const under = skyScan(x, x + w, true) + 3; // the oval keeps below the skyline across its width
			for (let k = hk; k >= kHang; k--) {
				if (HANG + (hk - k) - 0.6 >= best) break;
				const b = hangBase - k * ROW_H, t = b - LAB_H;
				if (t < under) continue;
				let cost = HANG + (hk - k) + Math.abs(x - ideal) / 400 + (prev === -1 - k ? -0.6 : 0);
				for (const [ox, oy] of others) {
					if (ox < x - 3 || ox > x + w + 3) continue;
					cost += oy > t - 2 && oy < b + 2 ? 40 : 1.5; // its anchor under this oval, or its leader must pass beside it
				}
				if (cost >= best) continue;
				if (free(c, x, x + w, t, b, true)) { best = cost; row = -1 - k; l = x; hang = true; }
			}
		}
		if (best === Infinity) continue;
		const t = hang ? hangBase - (-1 - row) * ROW_H - LAB_H : top0 + row * ROW_H;
		placed.push({ ...c, w, l, r: l + w, t, b: t + LAB_H, row, hang });
		if (c.air) airs++; else if (!c.behind) normal++;
	}
	return placed;
}

// Leaders: thin vertical lines from each oval to its anchor (down from a name above, up from one
// hanging below), with a dot there; dashed for a place only just in view. A behind-arrow is a
// heavier arrow standing on the ridge that hides the place, pointing up at its label.
export function drawLeaders(ctx, placed, theme) {
	ctx.save();
	ctx.lineCap = 'butt';
	for (const p of placed) {
		const x = Math.round(p.ax) + 0.5;
		if (p.behind) {
			const y0 = p.ay, y1 = p.b + 1;
			ctx.strokeStyle = theme.accent; ctx.fillStyle = theme.accent; ctx.lineWidth = 2.5;
			ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1 + 9); ctx.stroke();
			ctx.beginPath(); ctx.moveTo(x - 6, y1 + 10); ctx.lineTo(x + 6, y1 + 10); ctx.lineTo(x, y1); ctx.closePath(); ctx.fill();
			ctx.beginPath(); ctx.arc(x, y0, 3, 0, Math.PI * 2); ctx.fill();
			continue;
		}
		ctx.strokeStyle = theme.leader; ctx.fillStyle = theme.leader; ctx.lineWidth = 1;
		ctx.setLineDash(p.dashed ? [3, 3] : []);
		ctx.beginPath();
		if (p.hang) { ctx.moveTo(x, p.t); ctx.lineTo(x, p.ay + 2); } else { ctx.moveTo(x, p.b); ctx.lineTo(x, p.ay - 2); }
		ctx.stroke();
		ctx.setLineDash([]);
		ctx.beginPath(); ctx.arc(x, p.ay, 2, 0, Math.PI * 2); ctx.fill();
	}
	ctx.restore();
}
