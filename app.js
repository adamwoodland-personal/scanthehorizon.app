// Scan the Horizon (scanthehorizon.app): what's around you, drawn like the sign at a
// lookout. A module worker (xray-worker.js, SPEC §5) downloads the terrain and place names for
// the place you look from and works out the skyline, the ridge lines and which named places can
// be seen; this page draws them (draw.js) and handles everything else: the place (GPS, a search,
// a #at= link), the compass, the camera, the Detail slider, the card, the sheets and the saved areas
// (saved.js: the worker keeps them, this page lists, saves and deletes them).
//
// Two views of one panorama (SPEC §7). The sign view, the default, is a strip like the sign:
// bearing across, altitude up (exaggerated ×3 by default); it needs no sensors, and with a live
// compass it scrolls as you turn. The Camera button puts the live picture behind a true-scale
// pinhole drawing that lines up with it.
//
// The compass follows lookupanddown.com: only absolute (Android) or webkitCompassHeading (iPhone)
// readings count. Unlike there, a pause in the readings doesn't drop the view to dragging: a
// phone lying still needn't send any (the orientation events have no heartbeat), so the view
// keeps the last heading and the next reading carries on. Only "Drag instead", or a compass
// known not to work (refused, relative readings only, none at all), switches to dragging. In
// compass mode a sideways drag lines the drawing up (a nudge added to the heading, as on
// orrery.live's night sky) rather than taking over. window.__XRAY is a test hook.
import { OrientationSource, declination, decimalYear, readScreenAngle } from './orientation.js';
import { geocode } from './geocode.js';
import { attachDecodeFallback } from './decode.js';
import { parseSaveLink, covers, boxSize, cleanName, MAX_RADIUS_KM, MAX_SIDE_KM } from './saved.js';
import { attitude, fromAttitude, wrap180, wrap360, autoCamFov, screenFov, qRot, DEG } from './attitude.js';
import {
	readTheme, detailParams, allowed, stopName, signProjection, cameraProjection, drawTerrain, drawTicks,
	layoutLabels, drawLeaders, labelWidth, point, AIR_STOPS,
} from './draw.js';

const $ = (id) => document.getElementById(id);
const nf = (n) => Math.round(n).toLocaleString('en-GB');
const kmText = (d) => (d < 10 ? `${d.toFixed(1)} km` : `${nf(d)} km`);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const R_KM = 6371.0088;
function km(lat1, lon1, lat2, lon2) {
	const r = Math.PI / 180, a = Math.sin((lat2 - lat1) * r / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
	return 2 * R_KM * Math.asin(Math.sqrt(a));
}
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');
const KIND = { city: 'City', town: 'Town', village: 'Village', suburb: 'Suburb', hamlet: 'Hamlet', peak: 'Peak', hill: 'Hill', island: 'Island', cape: 'Cape',
	bay: 'Bay', lake: 'Lake', waterfall: 'Waterfall', lighthouse: 'Lighthouse', tower: 'Tower', lookout: 'Lookout', dam: 'Dam', castle: 'Castle', monument: 'Monument',
	airport: 'Airport' };
// An airport by its size (L.air: 1 OurAirports' large, 2 medium, which takes in air bases, 3 small).
const AIR_KIND = { 1: 'Major airport', 2: 'Airport', 3: 'Airfield' };
const kindWord = (L) => (L.kind === 'airport' && AIR_KIND[L.air]) || KIND[L.kind] || cap(L.kind || 'place');
// The Airports setting, as screen readers say it (the slider shows AIR_STOPS).
const AIR_SAY = ['No airports', 'Major airports only', 'Major and regional airports', 'All airports and airfields'];
const STATUS = { visible: 'in view', marginal: 'just in view', hidden: 'behind the hills' };
// The example on the start screen: the Glass House Mountains Lookout (OSM node 310543512), whose
// sign this page copies.
const DEMO = { name: 'Glass House Mountains Lookout', lat: -26.93153, lon: 152.89505, source: 'demo', az: 67 };

// ---- Preferences: kept in this browser only, each field checked on the way in -----------------------
// The keys keep the prefix of the working title, X-ray (xray-); every key this page or its worker
// stores starts with it. The last place *searched* for is kept; a GPS fix never is. Anything stored that doesn't fit is ignored.
// The hills' height is stored only once it has been chosen in Settings, so a change of default
// reaches everyone who never chose (v1 stored the ×2 default for every visitor, which is why the
// key moved to v2; v1's other settings are carried over once, its hills' height and camera zoom
// not). The camera zoom is kept as the camera's own field of view along its long side, so it
// stays right whichever way the phone is turned. The Airports setting (0 none … 3 every airfield) is
// stored, like the hills' height, only once it has been chosen.
const PREFS = 'xray-prefs-v2', OLD_PREFS = 'xray-prefs-v1';
const AGLS = [0, 3, 6, 10, 20, 50, 100, 300], EXAGS = [1, 2, 3, 4], EXAG = 3;
const SAVE_KMS = [2, 5, 10, 20, 50, 100, 200];
const AIR = 1;   // the Airports setting's default: major airports only
const DEFAULTS = { agl: 0, floor: null, exag: EXAG, exagSet: false, air: AIR, airSet: false, range: 'auto', theme: 'auto', lite: false, summit: true, detail: 50, camLong: null, place: null, saveKm: 5, diag: false };
const readStored = (key) => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; } };
function loadPrefs() {
	const p = { ...DEFAULTS };
	let raw = readStored(PREFS);
	const old = raw === null;
	if (old) raw = readStored(OLD_PREFS);
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return p;
	if (AGLS.includes(raw.agl)) p.agl = raw.agl;
	if (Number.isInteger(raw.floor) && raw.floor >= 1 && raw.floor <= 200) p.floor = raw.floor;
	if (!old && EXAGS.includes(raw.exag)) { p.exag = raw.exag; p.exagSet = true; }
	if (Number.isInteger(raw.air) && raw.air >= 0 && raw.air < AIR_STOPS.length) { p.air = raw.air; p.airSet = true; }
	if (raw.range === 'auto' || [50, 100, 150, 250].includes(raw.range)) p.range = raw.range;
	if (['auto', 'light', 'dark'].includes(raw.theme)) p.theme = raw.theme;
	if (typeof raw.lite === 'boolean') p.lite = raw.lite;
	if (typeof raw.summit === 'boolean') p.summit = raw.summit;
	if (typeof raw.diag === 'boolean') p.diag = raw.diag;
	if (Number.isInteger(raw.detail) && raw.detail >= 0 && raw.detail <= 100) p.detail = raw.detail;
	if (!old && typeof raw.camLong === 'number' && raw.camLong >= 20 && raw.camLong <= 120) p.camLong = raw.camLong;
	if (SAVE_KMS.includes(raw.saveKm)) p.saveKm = raw.saveKm;
	const pl = raw.place;
	if (pl && typeof pl === 'object' && typeof pl.name === 'string' && Number.isFinite(pl.lat) && Number.isFinite(pl.lon) && Math.abs(pl.lat) <= 90 && Math.abs(pl.lon) <= 180) {
		p.place = { name: pl.name.slice(0, 60), lat: pl.lat, lon: pl.lon, source: 'stored' };
	}
	return p;
}
const prefs = loadPrefs();
let saveTimer = 0;
function savePrefs() {
	clearTimeout(saveTimer);
	saveTimer = setTimeout(() => {
		const { place, exag, exagSet, air, airSet, ...rest } = prefs;
		const out = { ...rest, ...(exagSet ? { exag } : {}), ...(airSet ? { air } : {}), place: place ? { name: place.name, lat: place.lat, lon: place.lon } : null };
		try { localStorage.setItem(PREFS, JSON.stringify(out)); localStorage.removeItem(OLD_PREFS); } catch (e) { /* private mode: not kept */ }
	}, 200);
}
const aglMetres = () => (prefs.floor ? prefs.floor * 3 : prefs.agl);

// ---- Links: #at=lat,lon&name=…&az=… ------------------------------------------------------------------
// In the fragment, which browsers never send to the server (a ?at= query would be, so it isn't
// read). Both numbers must be present and well formed: "#at=," or "#at=12," is no place at all.
const NUM = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;
function placeFromLink(hash = location.hash) {
	const q = new URLSearchParams(hash.replace(/^#/, '')), parts = (q.get('at') || '').split(',').map((s) => s.trim());
	if (parts.length !== 2 || !parts.every((s) => NUM.test(s))) return null;
	const lat = Number(parts[0]), lon = Number(parts[1]);
	if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
	const name = (q.get('name') || '').trim().slice(0, 60);
	const azs = (q.get('az') || '').trim();
	const az = NUM.test(azs) && Number(azs) >= 0 && Number(azs) <= 360 ? Number(azs) % 360 : null;
	// So a street address never travels with coordinates rounded to hide it: an exact link to an address
	// carries its suburb or town as in= (a rounded link made from it names only that), and the name of any
	// other place from a link finer than a rounded one (more than two decimals: an exact link from before
	// in= existed, or someone else's) is left out of rounded links (linkFor).
	const fine = parts.some((v) => (v.split('.')[1] || '').length > 2);
	const inq = q.has('in') ? cleanName(q.get('in')) : null;
	return { name: name || `${lat.toFixed(2)}, ${lon.toFixed(2)}`, lat, lon, source: 'link', az, address: inq !== null, locality: inq || '', fine };
}

// ---- State ---------------------------------------------------------------------------------------------
const S = {
	place: null, decl: 0,
	view: 'sign',               // 'sign' | 'camera'
	aim: 'drag',                // 'drag' until the compass gives readings, then 'compass'
	az: 0, alt: 0,              // the dragged view: bearing, and (camera view) altitude
	nudge: 0,                   // compass mode: degrees added to the heading to line the drawing up
	widthDeg: null,             // sign view: degrees across the screen (null: the default for the shape)
	camLong: prefs.camLong,     // camera view: the camera's field of view along its long side, set by pinching (null: 67°)
	hy: null, ex: null,         // sign view: the horizon's y and the hills' exaggeration now, eased towards their targets
	detail: prefs.detail,
	gen: 0,                     // the worker run in progress; older answers are dropped
	pano: null, labels: [], order: [], labelsIn: false, placesErr: false, placesPartial: false, terrainErr: null, terrainWarn: null, stats: null, progress: null, awsUsed: false,
	ready: false, started: false, stream: null, entry: new Map(),
	selected: null,             // the label tapped, by id
	placed: [], prevRows: new Map(),
	look: { az: 0, alt: 0 },     // where the view points now (either mode)
	userMoved: false,           // the visitor has turned the view by hand (don't re-aim it)
	dirty: true,
};
const src = new OrientationSource();
let theme = null;

// ---- Theme ---------------------------------------------------------------------------------------------
function applyTheme() {
	if (prefs.theme === 'auto') document.documentElement.removeAttribute('data-theme');
	else document.documentElement.setAttribute('data-theme', prefs.theme);
	theme = readTheme();
	S.dirty = true;
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

// ---- Toasts ----------------------------------------------------------------------------------------------
const toastQ = [];
let toastBusy = false;
// ms: how long a message stays, for the longer ones (otherwise 3.2 s, or 2 s with more waiting).
function toast(msg, ms) {
	if ((toastBusy && $('toast').textContent === msg) || toastQ.some((q) => q.msg === msg)) return; // (already showing or waiting)
	toastQ.push({ msg, ms }); if (!toastBusy) nextToast();
}
function nextToast() {
	const t = $('toast'), item = toastQ.shift();
	if (!item) { toastBusy = false; t.classList.remove('show'); return; }
	toastBusy = true;
	t.textContent = item.msg;
	t.classList.add('show');
	setTimeout(() => { t.classList.remove('show'); setTimeout(nextToast, 300); }, item.ms || (toastQ.length ? 2000 : 3200));
}

// ---- The worker -------------------------------------------------------------------------------------------
// Every run carries a generation number; answers from an older run are dropped.
let worker = null;
function makeWorker() {
	try {
		worker = new Worker('xray-worker.js', { type: 'module' });
	} catch (e) {
		worker = null;
		S.terrainErr = { message: 'This browser can’t run the part of the page that works out the view.', fatal: true };
		return;
	}
	worker.onmessage = (e) => onWorker(e.data);
	// SPEC §3: a worker without OffscreenCanvas (Safari before 16.4, Playwright's Windows WebKit)
	// asks this page to decode its WebP tiles ({type:'decode'} → {type:'decoded'}); decode.js
	// handles both ends. The worker only asks when it has to.
	try { attachDecodeFallback(worker); } catch (e) { /* the worker reports a decode error if it needed this */ }
	worker.onerror = (e) => {
		e.preventDefault();
		S.terrainErr = { code: 'terrain', message: 'The part of the page that works out the view stopped.', fatal: true };
		worker.terminate(); worker = null;
		S.dirty = true; cardUi();
	};
}
function startRun() {
	if (!S.place) return;
	if (!worker) makeWorker();
	if (!worker) { cardUi(); return; }
	if (S.gen) worker.postMessage({ type: 'cancel', gen: S.gen });
	const gen = ++S.gen;
	S.ready = false; S.readyPending = false; S.labelsIn = false; S.placesErr = false; S.placesPartial = false; S.terrainErr = null; S.terrainWarn = null; S.stats = null; S.progress = null;
	S.heardAt = performance.now(); S.stalled = false;
	// Keep the old drawing while a nearby fix replaces it; clear it for somewhere new.
	if (!S.pano || !S.pano.place || km(S.pano.place.lat, S.pano.place.lon, S.place.lat, S.place.lon) > 2) { S.pano = null; S.labels = []; S.order = []; S.placed = []; }
	const conn = navigator.connection;
	const lite = prefs.lite || !!(conn && conn.saveData);
	worker.postMessage({ type: 'run', gen, lat: S.place.lat, lon: S.place.lon, agl: aglMetres(), rangeKm: prefs.range, lite, source: S.source || 'auto', facing: wrap360(S.look.az), summit: prefs.summit });
	S.dirty = true;
	progressUi(); cardUi();
}
// The eye is put on the top of a summit listed within 150 m (the setting, on by default; the worker
// does it): said once for each place and summit, unless the place is that summit by name (a peak
// picked from the search), where it goes without saying.
let summitTold = '';
function summitNote(top) {
	if (!top || !S.place) return;
	const key = `${S.place.source}|${S.place.name}|${top.name}`;
	if (key === summitTold) return;
	summitTold = key;
	const a = S.place.name.toLowerCase(), b = top.name.toLowerCase();
	if (S.place.source !== 'gps' && (a.includes(b) || b.includes(a))) return;
	toast(`Looking from the top of ${top.name}, ${nf(top.dist)} m away (you can change this in Settings)`, 6000);
}
function changeEye() {
	if (!worker || !S.pano) { startRun(); return; }
	const gen = ++S.gen;
	S.ready = false; S.readyPending = false; S.labelsIn = false;
	S.heardAt = performance.now(); S.stalled = false;
	worker.postMessage({ type: 'eye', gen, agl: aglMetres(), summit: prefs.summit });
}
// A watchdog: a run that hears nothing from the worker for STALL ms before it is finished (no
// panorama, or a first rough one and then nothing) has stalled, say on a download that never
// answers, so the card says so and offers Try again. Any message from the run clears it.
let STALL = 30000; // (the test hook can shorten it)
function checkStall(now = performance.now()) {
	const stalled = !!(S.place && worker && !S.ready && !S.readyPending && !S.terrainErr && now - (S.heardAt || now) > STALL);
	if (stalled !== !!S.stalled) { S.stalled = stalled; cardUi(); if (stalled) tryFollow(); }
}
function onWorker(m) {
	if (!m || typeof m !== 'object') return;
	if (m.type === 'decode') return; // decode.js answers these
	if (SAVED_MSGS.has(m.type)) return onSaved(m); // saved areas: not part of a view, no gen
	if (m.gen !== S.gen) return;
	S.heardAt = performance.now();
	if (S.stalled) { S.stalled = false; cardUi(); }
	switch (m.type) {
	case 'progress':
		S.progress = m;
		progressUi();
		if (!S.pano) cardUi();
		break;
	case 'pano':
		// A run's 'full' panorama can come twice: when the place names are late, the worker sends it
		// without the summit lift first, then again (lifted) just before the labels. Each simply
		// replaces the one before; the run is ready only once the labels are in too (checkReady).
		// Nothing to draw after a fatal error (a panorama of the sea all round, from no terrain).
		if (S.terrainErr && S.terrainErr.fatal) break;
		// A nearby GPS fix being worked out again: keep the full panorama until the new full one
		// comes, rather than swap in the new run's rough first one for a moment.
		if (m.stage === 'coarse' && S.pano && S.pano.stage === 'full' && S.pano.place && km(S.pano.place.lat, S.pano.place.lon, S.place.lat, S.place.lon) < 2) break;
		m.place = { lat: S.place.lat, lon: S.place.lon };
		S.pano = m;
		if (m.source === 'aws' || m.source === 'mixed') { S.awsUsed = true; $('awsCredit').hidden = false; }
		S.terrainErr = null;
		if (m.stage === 'full') { progressUi(true); summitNote(m.summit); }
		S.dirty = true;
		checkReady();
		break;
	case 'labels':
		S.labels = Array.isArray(m.items) ? m.items : [];
		S.order = layoutOrder(S.labels);
		S.labelsIn = true;
		if (!S.userMoved && S.aim === 'drag' && S.place && S.place.az == null) aimAtBest();
		S.dirty = true;
		checkReady(); cardUi();
		break;
	case 'error':
		// places: the drawing goes on without names (the worker still sends an empty label list),
		// unless only some of the place-name tiles failed (partial): then the names from the rest
		// follow, so the view is not "without names", just missing a few; a non-fatal terrain error:
		// a few tiles failed on both sources, and the view is drawn without them; anything fatal:
		// nothing to draw, so Try again.
		if (m.code === 'places' && m.partial) {
			S.placesPartial = true;
			toast('Some place names didn’t load: showing the rest');
		} else if (m.code === 'places') {
			S.placesErr = true;
			toast('The place names didn’t load: drawing the view without them');
		} else if (!m.fatal) {
			S.terrainWarn = m.message || 'error';
			toast('Part of the terrain didn’t load: the drawing may have gaps');
		} else {
			// Nothing to draw: the error card, not a panorama made from missing terrain under it.
			S.terrainErr = m;
			S.pano = null; S.labels = []; S.order = []; S.placed = [];
			progressUi(true);
		}
		S.dirty = true;
		checkReady(); cardUi();
		break;
	case 'stats':
		S.stats = m;
		aboutUi();
		if ($('placeSheet').open) askEstimate(); // a closer estimate now the view's tiles are in
		if (ASK.spec && !ASK.spec.error) toWorker({ type: 'estimate', key: ASK.key, ...askArea(ASK.spec), rangeKm: prefs.range }); // (and for a link's area)
		break;
	}
}
// The order labels claim their places in: first those the slider admits at its lowest setting,
// then by score. Turning the slider up only adds labels after the ones already shown, and as the
// layout is greedy, those keep their places: names don't vanish as the detail goes up. Airports
// come in by the Airports setting (so this is worked out again when it changes), and go ahead of
// the other names that come in at the same stop: they rank low by score, and on a crowded sign the
// places before them took every row round their anchors (Landsborough and Caloundra airports from
// the lookout found no room at all).
function layoutOrder(items) {
	const entry = new Map();
	for (const L of items) {
		let v = 101;
		if (L.status !== 'hidden') for (let d = 0; d <= 100; d++) if (allowed(L, detailParams(d, 390, 0, prefs.air))) { v = d; break; }
		entry.set(L, v);
	}
	S.entry = entry;
	const air = (L) => (L.kind === 'airport' ? 1 : 0);
	return items.filter((L) => entry.get(L) <= 100).sort((a, b) => entry.get(a) - entry.get(b) || air(b) - air(a) || b.score - a.score);
}
function checkReady() {
	S.readyPending = !!(S.pano && S.pano.stage === 'full' && (S.labelsIn || S.placesErr));
	if (S.terrainErr) S.readyPending = true;
}

// Facing at the start, without a compass: the way with the most worth naming in one screen.
function aimAtBest() {
	const p = detailParams(S.detail, innerWidth, 0, prefs.air), half = defaultWidth() / 2 * 0.8;
	const list = S.labels.filter((L) => allowed(L, p));
	if (!list.length) return;
	let best = 0, bestSum = -1;
	for (let a = 0; a < 360; a += 5) {
		let s = 0;
		for (const L of list) if (Math.abs(wrap180(L.az - a)) <= half) s += Math.max(0.2, L.score);
		if (s > bestSum) { bestSum = s; best = a; }
	}
	S.az = best;
}

// ---- Geometry and views -------------------------------------------------------------------------------------
const canvas = $('view'), ctx = canvas.getContext('2d');
let G = null, dpr = 1;
const portrait = () => innerHeight >= innerWidth;
const defaultWidth = () => (portrait() ? 60 : 100);
// The geometry is in #stage's own coordinates, where the canvas and the labels live, and comes from
// sizes only: the stage's box, the top bar's height (it is pinned to the stage's top) and the
// bottom bar's (pinned to its bottom). Not from innerHeight or the bars' positions: while an iPhone
// turns, Safari can report those from the old orientation and fire only one resize, and a bottom
// bar measured where it sat in portrait put the horizon below the screen in landscape (2026-11-03).
const stageEl = $('stage');
// After the phone turns, an iPhone (seen in the Home Screen app, 2026-11-08) can leave the page
// scrolled or the visible area shifted, and then the fixed bars are drawn in one place but answer
// taps from another: you had to tap above or below a button. The page never scrolls (xray.css pins
// it), so whenever the sizes are checked, and on any scroll, put it back.
function settleViewport() {
	const se = document.scrollingElement, vv = window.visualViewport;
	if (scrollX || scrollY) scrollTo(0, 0);
	if (se && (se.scrollTop || se.scrollLeft)) { se.scrollTop = 0; se.scrollLeft = 0; }
	if (vv && Math.abs(vv.scale - 1) < 0.01 && (Math.abs(vv.offsetTop) > 0.5 || Math.abs(vv.offsetLeft) > 0.5)) scrollTo(0, 0);
}
addEventListener('scroll', settleViewport);
if (window.visualViewport) visualViewport.addEventListener('scroll', settleViewport);
function resize() {
	settleViewport();
	const s = stageEl.getBoundingClientRect(), W = s.width || innerWidth, H = s.height || innerHeight;
	const top = $('hud').getBoundingClientRect().height, ticksH = 24, ticksTop = H - $('bottom').getBoundingClientRect().height - ticksH;
	const d = Math.min(devicePixelRatio || 1, 2.5);
	if (G && G.W === W && G.H === H && G.top === top && G.ticksTop === ticksTop && d === dpr) return;
	dpr = d;
	canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
	G = { W, H, left: 0, right: W, w: W, top, bottom: ticksTop, ticksTop, ticksH };
	G.h = G.bottom - G.top;
	S.hy = null; S.ex = null;
	notesTop();
	S.dirty = true;
}
// The notes float under the bar (xray.css), so they never move the drawing; labels just keep
// clear of them: G.labelTop is the highest a label may sit. (Measured from the bar's top, as the
// notes hang from the bar.)
function notesTop() {
	if (!G) return;
	const n = $('notes').getBoundingClientRect();
	G.labelTop = n.height > 0 ? Math.max(G.top, n.bottom - $('hud').getBoundingClientRect().top) : G.top;
	S.dirty = true;
}
// The turn itself takes about half a second on an iPhone, and the sizes can settle after the last
// event, so after anything that may be one, measure now, at the next frame and over the next second
// (resize does nothing when nothing changed).
let resizeTimers = [];
function scheduleResize() {
	resize();
	requestAnimationFrame(resize);
	for (const t of resizeTimers) clearTimeout(t);
	resizeTimers = [100, 250, 500, 1000].map((ms) => setTimeout(resize, ms));
}
addEventListener('resize', scheduleResize);
addEventListener('orientationchange', scheduleResize);
if (window.visualViewport) visualViewport.addEventListener('resize', scheduleResize);
if (screen.orientation && screen.orientation.addEventListener) screen.orientation.addEventListener('change', scheduleResize);
for (const id of ['stage', 'hud', 'bottom']) new ResizeObserver(() => resize()).observe($(id));
new ResizeObserver(notesTop).observe($('notes'));
const signWidth = () => S.widthDeg || defaultWidth();
// The camera view's vertical field of view, worked out from the video (or, with no picture, the
// screen) and the camera's field along its long side: a phone camera's 67°, unless pinched. The
// pinch is kept as that long-side angle, not as the vertical angle on screen, which halves when the
// phone turns on its side: kept that way, a zoom set upright would draw at half scale sideways.
const LONG = 67;
function fovFor(long) {
	const v = $('cam');
	return S.stream && v.videoWidth ? autoCamFov(v.videoWidth, v.videoHeight, innerWidth, innerHeight, long) : screenFov(innerWidth, innerHeight, long);
}
const camFovNow = () => fovFor(S.camLong || LONG);

// Where the view points now. Compass: the phone's attitude; drag: the dragged bearing (and
// altitude in the camera view).
//
// The two views take the heading differently. The camera view looks where the back camera looks.
// The sign view ignores pitch and roll, so it takes the way you face: square to the picture's
// right edge, levelled (orientation.js facingHeading, here from the smoothed attitude). The back
// camera's bearing would do for a phone held upright, but tipped towards flat it is set mostly
// by how the phone rocks sideways, which is how a hand-held phone wobbles: 10° of rock swung the
// sign 40° near flat, and the old switch to facingHeading at 75° jumped by as much. The right edge
// turns only as much as the phone twists in the plane of the screen, which a sign held in front
// of you hardly does. Only when that edge points nearly straight up or down (a phone on its side,
// the picture not rotated) is the camera's bearing used instead.
let lastQ = null;
function updateLook() {
	if (S.aim === 'compass') {
		const q = src.getCameraQuat(S.decl + S.nudge);
		if (q) {
			lastQ = q;
			const a = attitude(q);
			const r = qRot(q, [1, 0, 0]); // the picture's right edge, scene frame (x east, y up, z south)
			const face = Math.hypot(r[0], r[2]) >= 0.3 ? wrap360(Math.atan2(r[2], r[0]) / DEG) : NaN;
			let az = a.az;
			// (The camera view's readout and card fall back to the way you face too when the camera
			// points nearly straight up or down, where its own bearing means little.)
			if (Number.isFinite(face) && (S.view === 'sign' || !Number.isFinite(az) || Math.abs(a.alt) > 75)) az = face;
			if (Number.isFinite(az)) S.look = { az, alt: a.alt, q };
		}
		return;
	}
	S.look = { az: wrap360(S.az), alt: S.alt, q: fromAttitude(wrap360(S.az), S.alt, 0) };
}
// The sign view's horizon: 62% of the way down the drawing (60% on its side), lowered when high
// ground in view would leave no room above it for the names, eased so turning doesn't jolt it.
// If even that leaves no room (high mountains, a phone on its side), the hills are drawn less
// exaggerated than the setting, down to half height, and the readout says so.
function horizonTarget(P0) {
	const base = G.top + (portrait() ? 0.62 : 0.6) * G.h;
	if (!S.pano) return { hy: base, exag: prefs.exag };
	const { alt, n, step } = S.pano, half = signWidth() / 2 + 10;
	let maxA = -90;
	for (let a = S.look.az - half; a <= S.look.az + half; a += step) { const v = alt[((Math.round(a / step) % n) + n) % n]; if (v > maxA) maxA = v; }
	const room = G.top + 2.4 * 27 + 10, lim = G.top + 0.85 * G.h;
	let exag = prefs.exag;
	if (maxA > 0 && room + maxA * P0.ppd * exag > lim) exag = Math.max(0.5, (lim - room) / (maxA * P0.ppd));
	return { hy: Math.min(lim, Math.max(base, room + maxA * P0.ppd * exag)), exag };
}

// ---- Input: drag, pinch, wheel, keys, taps ------------------------------------------------------------------------
{
	const ptrs = new Map();
	let pinch0 = null, downAt = 0, moved = false;
	const stage = $('stage');
	stage.addEventListener('pointerdown', (e) => {
		if (e.button !== undefined && e.button > 0) return;
		ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, target: e.target });
		downAt = performance.now(); moved = false;
		if (ptrs.size === 2) {
			const [a, b] = [...ptrs.values()];
			pinch0 = { d: Math.hypot(a.x - b.x, a.y - b.y), width: signWidth(), fov: camFovNow() };
		}
	});
	addEventListener('pointermove', (e) => {
		const p = ptrs.get(e.pointerId);
		if (!p) return;
		if (ptrs.size === 2 && pinch0) {
			p.x = e.clientX; p.y = e.clientY;
			const [a, b] = [...ptrs.values()], k = pinch0.d / Math.max(20, Math.hypot(a.x - b.x, a.y - b.y));
			if (S.view === 'sign') setWidth(pinch0.width * k); else setCamFov(pinch0.fov * k);
			moved = true;
			return;
		}
		// A tap until it moves 6 px; from then on the drawing follows the finger, including those
		// first 6 px (p.x, p.y stay at the press until then), so a drag lines things up exactly.
		if (!moved && Math.hypot(e.clientX - p.x0, e.clientY - p.y0) < 6) return;
		if (!moved) { moved = true; canvas.classList.add('dragging'); }
		turnBy(e.clientX - p.x, e.clientY - p.y);
		p.x = e.clientX; p.y = e.clientY;
	});
	const end = (e) => {
		const p = ptrs.get(e.pointerId);
		if (!p) return;
		ptrs.delete(e.pointerId);
		if (ptrs.size < 2) pinch0 = null;
		if (!ptrs.size) canvas.classList.remove('dragging');
		if (e.type === 'pointerup' && !moved && performance.now() - downAt < 600) tap(p.target, e.clientX, e.clientY);
	};
	addEventListener('pointerup', end);
	addEventListener('pointercancel', end);
	stage.addEventListener('wheel', (e) => {
		e.preventDefault();
		const k = Math.exp(e.deltaY * 0.0012);
		if (S.view === 'sign') setWidth(signWidth() * k); else setCamFov(camFovNow() * k);
	}, { passive: false });
	addEventListener('keydown', (e) => {
		// Not while typing, nor while a dialog is open: there the arrow keys scroll and move focus.
		if (e.target.closest && e.target.closest('input, select, textarea, dialog')) return;
		if (document.querySelector('dialog[open]')) return;
		const step = { ArrowLeft: -3, ArrowRight: 3 }[e.key];
		if (step) { turnByDeg(step, 0); e.preventDefault(); return; }
		if (S.view === 'camera' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { turnByDeg(0, e.key === 'ArrowUp' ? 2 : -2); e.preventDefault(); return; }
		if (e.key === '+' || e.key === '=') { if (S.view === 'sign') setWidth(signWidth() / 1.25); else setCamFov(camFovNow() / 1.25); }
		if (e.key === '-' || e.key === '_') { if (S.view === 'sign') setWidth(signWidth() * 1.25); else setCamFov(camFovNow() * 1.25); }
	});
}
// A drag of (dx, dy) px: grab the drawing and move it. In compass mode a sideways drag lines it
// up instead (the nudge), and the compass keeps steering.
function turnBy(dx, dy) {
	const degPerPx = S.view === 'sign' ? 1 / (G.w / signWidth()) : camFovNow() / innerHeight;
	turnByDeg(-dx * degPerPx, S.view === 'camera' ? dy * degPerPx : 0);
}
function turnByDeg(dAz, dAlt) {
	if (S.aim === 'compass') {
		turnTry = performance.now(); // (for the quiet-compass hint)
		if (dAz) { S.nudge = wrap180(S.nudge + dAz); nudgeUi(); }
	} else {
		S.az = wrap360(S.az + dAz / (S.view === 'camera' ? Math.max(Math.cos(S.alt * Math.PI / 180), 0.25) : 1));
		S.alt = Math.min(80, Math.max(-80, S.alt + dAlt));
		S.userMoved = true;
	}
	S.dirty = true;
}
function setWidth(w) { S.widthDeg = Math.min(360, Math.max(15, w)); S.dirty = true; }
// A pinch asks for a vertical field f on screen; that is the camera's long-side field scaled by the
// same factor in tan(half-angle), whatever the crop (see fovFor), so turn it into the long side.
function setCamFov(f) {
	f = Math.min(100, Math.max(10, f));
	const k = Math.tan(fovFor(LONG) * DEG / 2) / Math.tan(LONG * DEG / 2);
	S.camLong = Math.min(120, Math.max(20, 2 * Math.atan(Math.tan(f * DEG / 2) / k) / DEG));
	prefs.camLong = Math.round(S.camLong * 10) / 10; savePrefs(); camZoomUi(); S.dirty = true;
}
function camZoomUi() { $('camZoom').hidden = !S.camLong; }
$('camZoomReset').addEventListener('click', () => { S.camLong = null; prefs.camLong = null; savePrefs(); camZoomUi(); S.dirty = true; });
// A tap on a label opens its card. The ovals are only 22 px tall (the rows are 27 px apart), so a
// tap just beside one, or on its leader, counts too: within 10 px of the oval's ends or 2 px of its
// top and bottom, or 12 px of the leader. A tap anywhere else closes the card.
function tap(target, x, y) {
	const el = target && target.closest ? target.closest('.lab') : null;
	let p = el ? S.placed[+el.dataset.i] : null;
	if (!p && Number.isFinite(x)) {
		let best = Infinity;
		for (const q of S.placed) {
			const y0 = q.hang ? q.ay : q.b, y1 = q.hang ? q.t : q.ay;
			const d = x >= q.l - 10 && x <= q.r + 10 && y >= q.t - 2 && y <= q.b + 2 ? 0
				: y >= Math.min(y0, y1) && y <= Math.max(y0, y1) ? Math.abs(x - q.ax) : Infinity;
			if (d <= 12 && d < best) { best = d; p = q; }
		}
	}
	if (p) { S.selected = p.L.id; S.dirty = true; cardUi(); return; }
	if (S.selected !== null) { S.selected = null; S.dirty = true; cardUi(); }
}

// ---- The compass ---------------------------------------------------------------------------------------------
// As lookupanddown.com: readings are timestamped here from the same events orientation.js
// listens to, so its shared copy stays as it is. Only absolute (Android) or iPhone compass-heading
// readings with all three angles count.
//
// A gap in the readings is not taken to mean the compass has stopped: the orientation events have
// no heartbeat, and a phone lying still may send none, so dropping to dragging after a few quiet
// seconds (as lookupanddown does) could take a working compass away. The view keeps the last
// heading, a drag still lines it up, and the next reading carries on. Only after QUIET ms of
// silence, and only while someone is trying to turn the view or the page has just come back, is
// there a hint (in the note under the bar) that dragging is there if the drawing seems stuck.
// Dragging takes over only on "Drag instead", or when the compass is known not to work: refused,
// relative readings only, or none at all (orientation.js's status).
let QUIET = 10000; // (the test hook can shorten it)
let lastReading = -1e9, userDrag = false, turnTry = -1e9, resumedAt = -1e9;
const reading = (e) => {
	if (Number.isFinite(e.alpha) && Number.isFinite(e.beta) && Number.isFinite(e.gamma) && (e.absolute === true || Number.isFinite(e.webkitCompassHeading))) lastReading = performance.now();
};
addEventListener('deviceorientation', reading);
addEventListener('deviceorientationabsolute', reading);
const compassOk = () => src.status === 'ok';
function toDrag() {
	if (S.aim === 'compass') { S.az = S.look.az; S.alt = Math.max(-80, Math.min(80, S.look.alt || 0)); } // keep looking where the phone pointed
	S.aim = 'drag';
	modeUi(); nudgeUi();
	S.dirty = true;
}
function toCompass() { S.aim = 'compass'; userDrag = false; modeUi(); nudgeUi(); S.dirty = true; }
function chooseDrag() {
	if (S.aim !== 'compass') return;
	userDrag = true;
	toDrag();
	toast('Dragging now: tap “Use compass” to follow the phone again');
}
function modeUi() {
	const b = $('modeBtn');
	b.hidden = !compassOk(); // only on a phone whose compass works
	b.textContent = S.aim === 'compass' ? 'Drag instead' : 'Use compass';
	b.classList.toggle('lit', S.aim !== 'compass'); // "Use compass" stands out (xray.css)
	hintUi();
}
$('modeBtn').addEventListener('click', () => {
	if (S.aim === 'compass') chooseDrag();
	else if (compassOk()) toCompass();
	else toast('The compass isn’t working here: keep dragging');
});
// Each frame: the compass mode follows orientation.js's status (onstatus below does the switching
// and the toasts; this catches anything it missed, without a toast).
function watchCompass() {
	if (S.aim === 'compass' && !compassOk()) toDrag();
	else if (S.aim === 'drag' && !userDrag && compassOk()) toCompass();
}
// The quiet-compass hint: long silent, and someone trying to turn the view or just back.
function compassQuiet(now = performance.now()) {
	return S.aim === 'compass' && now - Math.max(lastReading, resumedAt) > QUIET && (now - turnTry < 6000 || now - resumedAt < 30000);
}
let lastStatus = null;
src.onstatus = (st) => {
	const was = lastStatus;
	lastStatus = st;
	if (st === 'ok' && S.aim !== 'compass' && !userDrag) { toCompass(); if (was !== 'ok') toast(S.view === 'sign' ? 'The drawing now turns with your phone' : 'Hold the phone up facing the view'); }
	if (st === 'unsupported' || st === 'denied' || st === 'relative-only') {
		if (S.aim === 'compass') toDrag();
		// (Not on a computer: it has no compass, and the start screen already says to drag.)
		if (S.started && 'ontouchstart' in window && was !== st) toast(st === 'denied' ? 'Motion sensors are off for this site: drag the drawing instead' : 'No compass here: drag the drawing to look around');
	}
	modeUi();
};
function nudgeUi() {
	const on = S.aim === 'compass' && Math.abs(S.nudge) >= 0.5;
	$('nudgeChip').hidden = !on;
	if (on) $('nudgeVal').textContent = `${S.nudge > 0 ? '+' : '−'}${Math.abs(S.nudge).toFixed(0)}°`;
}
$('nudgeChip').addEventListener('click', () => { S.nudge = 0; nudgeUi(); S.dirty = true; toast('Back to the compass’s own north'); });
function startSensors() { return src.start(); }

// ---- The camera -------------------------------------------------------------------------------------------------
// As lookupanddown.com: one request in flight at a time (the button is disabled meanwhile), and
// each carries a token that stopCamera() moves on, so a stream arriving after the camera was
// turned off is stopped at once. A track ending by itself turns the camera off too.
let camToken = 0, camPending = false;
function camUi() {
	$('cam').classList.toggle('on', !!S.stream);
	$('camBtn').setAttribute('aria-pressed', String(S.view === 'camera'));
	$('camBtn').disabled = camPending;
}
// resume: turning the camera back on as the page comes back from the background; if that's
// refused (a browser may want a tap for it), go back to the sign view quietly.
async function startCamera(resume = false) {
	if (S.stream || camPending) return;
	if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('No camera here: showing the drawing on its own'); return; }
	const token = ++camToken;
	camPending = true; camUi();
	try {
		const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
		if (token !== camToken) { stream.getTracks().forEach((t) => t.stop()); return; } // turned off meanwhile
		S.stream = stream;
		for (const t of stream.getTracks()) t.addEventListener('ended', () => { if (S.stream === stream) { stopCamera(); toast('The camera was turned off'); } });
		const v = $('cam');
		v.srcObject = stream;
		v.addEventListener('loadedmetadata', () => { S.dirty = true; }, { once: true });
		camPending = false; camUi();
		await v.play().catch(() => {});
	} catch (e) {
		if (token !== camToken) return;
		if (resume) { camPending = false; setView('sign'); toast('Tap Camera to turn the picture back on'); } else toast('Camera unavailable or blocked: showing the drawing on its own');
	} finally {
		if (token === camToken && camPending) { camPending = false; camUi(); }
		S.dirty = true;
	}
}
function stopCamera() {
	camToken++; // any request still in flight is now stale
	camPending = false;
	const s = S.stream;
	S.stream = null;
	if (s) s.getTracks().forEach((t) => t.stop());
	const v = $('cam');
	v.pause();
	v.srcObject = null;
	camUi();
	S.dirty = true;
}
addEventListener('pagehide', stopCamera);
function setView(v) {
	S.view = v === 'camera' ? 'camera' : 'sign';
	document.body.classList.toggle('cam', S.view === 'camera');
	if (S.view === 'sign' && (S.stream || camPending)) stopCamera(); // a request still pending is dropped too
	if (S.view === 'camera' && S.aim === 'drag') S.alt = 0;
	theme = readTheme();
	S.prevRows.clear();
	camUi(); hintUi();
	S.dirty = true;
	lastDom = 0; // the readouts follow on the next frame
}
$('camBtn').addEventListener('click', () => {
	if (S.view === 'camera') { setView('sign'); return; }
	setView('camera');
	startCamera();
	if (!portrait()) return;
	toast('Tip: turn the phone on its side to see more of the view');
});

// ---- Position ----------------------------------------------------------------------------------------------------
// watchPosition with a generation number: choosing a place (a search, a link, the example) moves
// it on, so a fix that arrives later can't override the choice. The exact fix is used only here.
// While "Your location" is the place in use and the page is on screen, the watch keeps running and
// the view follows you (followFix); it stops while the page is hidden and starts again when it is
// back. With no fix at all after a minute it gives up; a slow first fix (the watch's own 15 s
// timeout) doesn't end it sooner. (Until 2026-11-07 the watch stopped for good at a ±20 m fix or after
// a minute, so on a walk or in a car the view stayed where the first fix was, Adam's report.)
let locGen = 0, watchId = null, watchTimer = 0, gpsWanted = false;
// Following: a move is worked out once the view from the last place is drawn (or has failed or
// stalled) and FOLLOW ms after the last move, so in a car the runs don't cancel each other before
// they finish; the latest fix waits meanwhile. A move keeps the way the view looks and what is
// selected. (The test hook can shorten FOLLOW.)
let FOLLOW = 10000, followAt = 0, followTimer = 0, pendingFix = null;
const IOS_APP = (/iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1))
	&& (navigator.standalone === true || matchMedia('(display-mode: standalone)').matches);
function stopGps() {
	if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
	watchId = null;
	clearTimeout(watchTimer);
	clearTimeout(followTimer); pendingFix = null;
}
function startGps() {
	if (!navigator.geolocation) { toast('Location isn’t available here: search for a place instead'); openSheet($('placeSheet')); return; }
	stopGps();
	gpsWanted = true;
	clearTrail();
	const gen = ++locGen;
	if (!S.place || S.place.source !== 'gps') { $('placeName').textContent = 'Finding your position…'; $('placeAcc').hidden = true; }
	watchId = navigator.geolocation.watchPosition((pos) => onFix(pos, gen), (err) => onGpsError(err, gen), { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 });
	watchTimer = setTimeout(() => {
		if (gen !== locGen || (S.place && S.place.source === 'gps')) return;   // a fix came: keep following
		stopGps(); gpsWanted = false;
		placeUi();
		toast('Couldn’t get your position: search for a place instead');
		if (!S.place) openSheet($('placeSheet'));
	}, 60000);
}
// A fix. When it is somewhere else, further away than the two fixes' uncertainties together and
// over 50 m (so a fix wandering about indoors at ±60 m doesn't redo the view every few seconds),
// you have moved, and the view follows (followFix). A more accurate fix is always taken, position
// and accuracy together (never the accuracy alone, which showed ±5 m beside a position from a ±25 m
// fix 40 m away), at once: the view is worked out again when it moved the position by more than
// 15 m and twice its own accuracy. A less accurate fix near the one in use is ignored, and so is a
// move it undoes.
function onFix(pos, gen) {
	if (gen !== locGen) return;
	const { latitude: lat, longitude: lon } = pos.coords, acc = Math.max(1, pos.coords.accuracy || 999);
	const cur = S.place && S.place.source === 'gps' ? S.place : null;
	const moved = cur ? km(cur.lat, cur.lon, lat, lon) * 1000 : Infinity;
	const fix = { name: 'Your location', lat, lon, acc, source: 'gps' };
	if (!cur) {
		followAt = performance.now();
		setPlace(fix);
		approxToast(acc, null);
		return;
	}
	if (moved > Math.max(50, acc + cur.acc)) { followFix(fix); return; }
	pendingFix = null;
	if (acc < cur.acc) {
		if (moved > Math.max(15, 2 * acc)) setPlace(fix, true);
		else { cur.lat = lat; cur.lon = lon; cur.acc = acc; placeUi(); }
	}
}
function approxToast(acc, was) {
	if (acc > 100 && (!was || was.acc <= 100)) toast(`Position approximate (±${nf(acc)} m): search for your address for a truer view`, 6000);
}
function followFix(fix) { pendingFix = fix; tryFollow(); }
function tryFollow() {
	clearTimeout(followTimer);
	if (!pendingFix) return;
	if (!S.place || S.place.source !== 'gps') { pendingFix = null; return; }
	if (!S.ready && !S.terrainErr && !S.stalled) return;   // the view still being worked out: its ready calls back
	const wait = followAt + FOLLOW - performance.now();
	if (wait > 0) { followTimer = setTimeout(tryFollow, wait); return; }
	const f = pendingFix, was = S.place;
	pendingFix = null; followAt = performance.now();
	S.userMoved = true;   // keep looking the same way (the best way to face is chosen for a first view only)
	setPlace(f, true);
	approxToast(f.acc, was);
}
function onGpsError(err, gen) {
	if (gen !== locGen) return;
	if (err.code === 3 && watchId !== null) return; // slow: keep waiting (the minute's timer ends it)
	if (S.place && S.place.source === 'gps' && err.code !== 1) return; // keep the fix we have
	stopGps(); gpsWanted = false;
	if (IOS_APP && (err.code === 1 || err.code === 2)) toast('Location is blocked. For an app on the Home Screen, switch on Settings › Privacy & Security › Location Services › System Services › In-App Web Browsing, then close this app fully and open it again. Meanwhile, search for a place.', 9000);
	else toast(err.code === 1 ? 'Location is off for this site: search for a place instead' : 'Couldn’t get your position: search for a place instead');
	placeUi(); // (not left at "Finding your position…" over a place chosen before)
	if (!S.place || S.place.source === 'gps') openSheet($('placeSheet'));
}
// ---- Go there: looking from a place named in the view --------------------------------------------------------
// The card of a name tapped (or picked from the List) has Go there: it looks from that place, facing
// the same way, so the view carries on past it, and GPS following stops, as for any place chosen. A
// peak is gone to at its top as drawn (and the summit setting stands you on it). The places gone from
// are kept in this page only, up to TRAIL_MAX, so the place sheet can offer "Back to …" the last one;
// choosing a place any other way (a search, your location, a link, a saved area) clears them. Back to
// your location asks the GPS again, so it is where you are now.
const trail = [], TRAIL_MAX = 20;
let wentTold = false;
function goThere(L) {
	if (!L || !S.place || !Number.isFinite(L.lat) || !Number.isFinite(L.lon)) return;
	const az = wrap360(S.look.az);
	trail.push({ ...S.place, az });
	if (trail.length > TRAIL_MAX) trail.shift();
	locGen++; stopGps(); gpsWanted = false;
	setPlace({ name: L.name.slice(0, 60), lat: L.lat, lon: L.lon, source: 'label', az });
	const tell = [];
	if (!wentTold) { wentTold = true; tell.push(`Looking from ${L.name}. To go back, tap the place name at the top.`); }
	if (L.approx) tell.push(`${tell.length ? 'Its' : `${L.name}’s`} position on the map is approximate, so this view may be a little off.`);
	if (tell.length) toast(tell.join(' '), 6000);
}
function goBack() {
	const p = trail.pop();
	closeSheet($('placeSheet'));
	if (!p) { trailUi(); return; }
	S.az = p.az; S.userMoved = true;
	if (p.source === 'gps') { startGps(); return; }   // (where you are now, followed again)
	locGen++; stopGps(); gpsWanted = false;
	setPlace(p);
}
function trailUi() {
	const p = trail[trail.length - 1];
	$('backBtn').hidden = !p;
	if (p) $('backName').textContent = p.source === 'gps' ? 'your location' : p.name;
}
function clearTrail() { trail.length = 0; trailUi(); }
$('backBtn').addEventListener('click', goBack);
$('goBtn').addEventListener('click', () => { const L = S.selected !== null && S.labels.find((x) => x.id === S.selected); if (L) goThere(L); });
function setPlace(p, follow = false) {
	S.place = p;
	S.decl = declination(p.lat, p.lon, decimalYear());
	if (!follow) S.selected = null;   // (a name gone from the new view just leaves the card)
	if (p.az != null) { S.az = p.az; S.userMoved = true; } else if (p.source !== 'gps') S.userMoved = false;
	placeUi();
	startRun();
}
// The last searched place is remembered for next time, but a searched address is remembered as its
// suburb or town, to about 100 m: the start screen shouldn't show a home address to whoever picks up
// the phone, nor keep the doorstep in storage (a GPS fix is never kept at all).
function choosePlace(p) {
	locGen++; stopGps(); gpsWanted = false;
	clearTrail();
	if (p.source === 'search') {
		const r3 = (v) => Math.round(v * 1000) / 1000;
		prefs.place = p.address ? { name: p.locality || 'Your last search', lat: r3(p.lat), lon: r3(p.lon) } : { name: p.name, lat: p.lat, lon: p.lon };
		savePrefs();
	}
	setPlace(p);
}
function placeUi() {
	const p = S.place, acc = $('placeAcc'), chip = $('placeBtn');
	$('placeName').textContent = p ? p.name : 'Choose a place';
	acc.hidden = !(p && p.source === 'gps');
	chip.classList.toggle('approx', !!(p && p.source === 'gps' && p.acc > 100));
	if (p && p.source === 'gps') acc.textContent = `±${nf(p.acc)} m`;
	const note = $('gpsNote');
	note.hidden = !(p && p.source === 'gps');
	if (p && p.source === 'gps') note.textContent = p.acc > 100 ? `Your position is approximate (±${nf(p.acc)} m). Search for your address for a truer view.` : `Your position, to ±${nf(p.acc)} m. It follows you as you move, and stays on your phone.`;
	$('gpsBtn').textContent = p && p.source === 'gps' ? 'Update my position' : 'Use my location';
	trailUi();
}
addEventListener('hashchange', () => { const a = parseSaveLink(location.hash); if (a) { openAsk(a); return; } const p = placeFromLink(); if (p) choosePlace(p); });

let wakeLock = null;
async function keepAwake() {
	try { if (navigator.wakeLock && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* optional */ }
}
// In the background the GPS watch and the camera stop (battery, and the camera light), and start
// again when the page is back (the camera only if the camera view is still on). The compass is
// left listening, as on lookupanddown.com: browsers send no orientation events to a hidden page,
// so it costs nothing, whereas stopping and starting it reset the iPhone's heading calibration
// and flipped the view to dragging and back with two toasts on every return.
let camWasOn = false;
document.addEventListener('visibilitychange', () => {
	if (document.visibilityState === 'hidden') {
		if (watchId !== null) stopGps();
		camWasOn = S.view === 'camera' && !!(S.stream || camPending);
		if (camWasOn) stopCamera();
		return;
	}
	if (!S.started) return;
	keepAwake();
	resumedAt = performance.now();
	if (gpsWanted && watchId === null) startGps();
	if (camWasOn && S.view === 'camera') startCamera(true);
	camWasOn = false;
});

// ---- Sheets ---------------------------------------------------------------------------------------------------
// Native modal dialogs (showModal): focus moves in, stays in, the rest is inert until they close,
// and Escape closes them. The start screen can't be dismissed without choosing how to start.
// Focus goes back to whatever opened a dialog.
let lastFocus = null;
function openSheet(el) {
	if (!lastFocus || !document.querySelector('dialog[open]')) lastFocus = document.activeElement;
	if (el.id === 'placeSheet') savedOpen();
	if (!el.open) el.showModal();
}
function closeSheet(el) { if (el.open) el.close(); }
for (const sh of document.querySelectorAll('dialog.sheet')) {
	sh.addEventListener('click', (e) => { if (e.target === sh && sh.id !== 'intro') closeSheet(sh); }); // the backdrop
	// The browser itself puts focus back where it was when the dialog opened; this only steps in
	// when that left it nowhere (the body, or inside a dialog now closed). It never takes focus
	// from something focused since the dialog closed: the close event comes a moment after the
	// dialog closes, and it once pulled focus back to the ⓘ button from the ⚙ just focused.
	sh.addEventListener('close', () => {
		if (document.querySelector('dialog[open]')) return;
		const a = document.activeElement, nowhere = !a || a === document.body || !!a.closest('dialog:not([open])');
		if (nowhere && lastFocus && lastFocus.isConnected && lastFocus !== document.body) lastFocus.focus();
		lastFocus = null;
	});
	const c = sh.querySelector('.close');
	if (c) c.addEventListener('click', () => closeSheet(sh));
}
$('intro').addEventListener('cancel', (e) => e.preventDefault());
$('infoBtn').addEventListener('click', () => { aboutUi(); openSheet($('about')); });
$('placeBtn').addEventListener('click', () => { placeUi(); openSheet($('placeSheet')); });
$('placeSheet').addEventListener('close', () => { disarm(); });
$('setBtn').addEventListener('click', () => { settingsUi(); openSheet($('setSheet')); });
$('listBtn').addEventListener('click', () => { listUi(); openSheet($('listSheet')); });
$('moreBtn').addEventListener('click', () => { listUi(); openSheet($('listSheet')); });
$('gpsBtn').addEventListener('click', () => { startGps(); closeSheet($('placeSheet')); });

// The start screen. Everything that needs the tap (motion permission on iPhones, location) is
// asked for before the first await. Leaving it, focus goes to the place chip at the top (the
// start screen opened before anything else had focus, so there is nothing to give it back to).
function begin() {
	S.started = true;
	startSensors();
	keepAwake();
}
const leaveIntro = () => { closeSheet($('intro')); $('placeBtn').focus(); };
$('startGps').addEventListener('click', () => { begin(); startGps(); leaveIntro(); });
// A place from a save link is only looked from once asked to (no terrain is downloaded before that).
let pendingLink = null;
$('startLink').addEventListener('click', () => { begin(); if (pendingLink) { const p = pendingLink; pendingLink = null; choosePlace(p); } leaveIntro(); });
$('startSearch').addEventListener('click', () => { begin(); leaveIntro(); openSheet($('placeSheet')); $('placeInput').focus(); });
$('startDemo').addEventListener('click', () => { begin(); choosePlace({ ...DEMO }); leaveIntro(); });

// Search: any town, peak, lookout or address, looked up online (geocode.js). Each search takes a
// number, so a slow answer can't replace a newer one.
function resultList(box, items, pick) {
	box.replaceChildren(...items.map((it) => {
		const b = document.createElement('button');
		b.type = 'button';
		b.className = 'res';
		const n = document.createElement('span'), w = document.createElement('span');
		n.className = 'rn'; n.textContent = it.name;
		w.className = 'rw'; w.textContent = it.sub;
		b.append(n, w);
		b.addEventListener('click', () => pick(it));
		return b;
	}));
}
let placeSeq = 0;
$('placeForm').addEventListener('submit', async (e) => {
	e.preventDefault();
	const q = $('placeInput').value.trim();
	if (!q) return;
	// A pasted link (a Scan the Horizon link, or its #… part) is opened here, not sent to the search:
	// an app on an iPhone's Home Screen has no address bar, so this is how a link to save an area gets in.
	const lk = q.match(/#(?:save|at)=\S*/);
	if (lk) {
		const a = parseSaveLink(lk[0]), p = a ? null : placeFromLink(lk[0]);
		if (a || p) { $('placeInput').value = ''; closeSheet($('placeSheet')); if (a) openAsk(a); else choosePlace(p); return; }
	}
	const mine = ++placeSeq, status = $('placeStatus'), box = $('placeResults');
	box.replaceChildren();
	status.textContent = `Searching for “${q}”…`;
	try {
		const list = await geocode(q);
		if (mine !== placeSeq) return;
		status.textContent = list.length ? '' : `No places found for “${q}”.`;
		resultList(box, list.map((p) => ({ ...p, sub: [p.type, p.where].filter(Boolean).join(' · ') || `${p.lat.toFixed(2)}, ${p.lon.toFixed(2)}` })), (p) => {
			choosePlace({ name: p.name.slice(0, 60), lat: p.lat, lon: p.lon, source: 'search', address: !!p.address, locality: (p.locality || '').slice(0, 60) });
			closeSheet($('placeSheet'));
		});
	} catch (err) {
		if (mine !== placeSeq) return;
		status.textContent = `The search didn't work (${err.message}). Check the connection and try again.`;
	}
});

// Links. By default the place is rounded to 0.01° (about 1 km); the exact one is behind a warning.
// A searched address ("12 Smith Street") would give the street away whatever the rounding, so
// the rounded link names only its suburb or town, and the full address goes only in the exact
// link. A GPS fix is never named.
function linkFor(exact) {
	const p = S.place;
	if (!p) return null;
	const d = exact ? 5 : 2, f = (v) => String(+v.toFixed(d));
	const label = p.source === 'gps' ? '' : exact ? p.name : p.address ? (p.locality || '') : p.source === 'link' && p.fine ? '' : p.name;
	const name = label ? `&name=${encodeURIComponent(label)}` : '';
	const within = exact && p.address ? `&in=${encodeURIComponent(p.locality || '')}` : '';
	return `${location.origin}${location.pathname}#at=${f(p.lat)},${f(p.lon)}${name}${within}&az=${Math.round(wrap360(S.look.az)) % 360}`;
}
async function copyLink(exact) {
	const url = linkFor(exact), st = $('linkStatus');
	if (!url) { st.textContent = 'Choose a place first.'; return; }
	try { await navigator.clipboard.writeText(url); st.textContent = exact ? 'Copied, with your exact position.' : 'Copied.'; } catch (e) { st.textContent = url; }
	$('exactWarn').hidden = true;
}
$('linkBtn').addEventListener('click', () => copyLink(false));
$('exactLinkBtn').addEventListener('click', () => { $('exactWarn').hidden = false; $('exactLinkGo').focus(); });
$('exactLinkGo').addEventListener('click', () => copyLink(true));

// Settings.
function settingsUi() {
	$('setAgl').value = prefs.floor ? 'floor' : String(prefs.agl);
	$('setFloor').hidden = !prefs.floor;
	if (prefs.floor) $('setFloor').value = String(prefs.floor);
	for (const r of document.querySelectorAll('input[name="exag"]')) r.checked = +r.value === prefs.exag;
	for (const r of document.querySelectorAll('input[name="theme"]')) r.checked = r.value === prefs.theme;
	$('setRange').value = String(prefs.range);
	$('setLite').checked = prefs.lite;
	$('setSummit').checked = prefs.summit;
	$('setDiag').checked = prefs.diag;
	airUi();
}
// The Airports slider: its stop's name beside it. The worker always sends the airports in range, so
// moving it only redraws.
function airUi() {
	const el = $('setAir');
	if (+el.value !== prefs.air) el.value = String(prefs.air);
	el.setAttribute('aria-valuetext', AIR_SAY[prefs.air]);
	setText('setAirName', AIR_STOPS[prefs.air]);
}
function setSetting(k, v) {
	if (k === 'agl') {
		if (v === 'floor' || (typeof v === 'object' && v && v.floor)) prefs.floor = Math.min(200, Math.max(1, Math.round((v && v.floor) || +$('setFloor').value || 5)));
		else if (AGLS.includes(+v)) { prefs.agl = +v; prefs.floor = null; } else return;
		changeEye();
	} else if (k === 'floor') { prefs.floor = Math.min(200, Math.max(1, Math.round(+v) || 1)); changeEye(); }
	else if (k === 'exag' && EXAGS.includes(+v)) { prefs.exag = +v; prefs.exagSet = true; }
	else if (k === 'range' && (v === 'auto' || [50, 100, 150, 250].includes(+v))) { prefs.range = v === 'auto' ? 'auto' : +v; startRun(); }
	else if (k === 'theme' && ['auto', 'light', 'dark'].includes(v)) { prefs.theme = v; applyTheme(); }
	else if (k === 'lite') { prefs.lite = !!v; startRun(); }
	else if (k === 'summit') { prefs.summit = !!v; changeEye(); }
	else if (k === 'diag') { prefs.diag = !!v; diagUi(); }
	else if (k === 'air' && Number.isInteger(+v) && +v >= 0 && +v < AIR_STOPS.length) {
		if (+v === prefs.air && prefs.airSet) return;
		prefs.air = +v; prefs.airSet = true;
		S.order = layoutOrder(S.labels);
		airUi();
		if ($('listSheet').open) listUi();
	}
	else if (k === 'detail') { setDetail(v); return; }
	else return;
	savePrefs();
	S.hy = null; S.ex = null; S.dirty = true;
}
$('setAgl').addEventListener('change', (e) => { const v = e.target.value; $('setFloor').hidden = v !== 'floor'; setSetting('agl', v === 'floor' ? { floor: +$('setFloor').value || 5 } : +v); });
$('setFloor').addEventListener('change', (e) => setSetting('floor', e.target.value));
for (const r of document.querySelectorAll('input[name="exag"]')) r.addEventListener('change', () => setSetting('exag', +r.value));
for (const r of document.querySelectorAll('input[name="theme"]')) r.addEventListener('change', () => setSetting('theme', r.value));
$('setRange').addEventListener('change', (e) => setSetting('range', e.target.value === 'auto' ? 'auto' : +e.target.value));
$('setLite').addEventListener('change', (e) => setSetting('lite', e.target.checked));
$('setSummit').addEventListener('change', (e) => setSetting('summit', e.target.checked));
$('setDiag').addEventListener('change', (e) => setSetting('diag', e.target.checked));
$('setAir').addEventListener('input', (e) => setSetting('air', Math.round(+e.target.value)));

// ---- Screen and compass diagnostics (Settings) -----------------------------------------------------
// For reporting a problem from a phone, in a screenshot: the sizes the page sees, where the last tap
// landed (a ring there, and what it reached), and what the compass is doing. Off unless chosen.
let lastTap = null, diagTimer = 0;
addEventListener('pointerdown', (e) => {
	if (!prefs.diag) return;
	const el = e.target && e.target.closest ? e.target.closest('[id]') : null;
	lastTap = { x: e.clientX, y: e.clientY, target: el ? '#' + el.id : String(e.target && e.target.nodeName).toLowerCase() };
	const d = $('diagDot');
	d.style.left = `${e.clientX}px`; d.style.top = `${e.clientY}px`; d.hidden = false;
	diagTick();
}, true);
function diagText() {
	const vv = window.visualViewport, sa = getComputedStyle($('saProbe')), hud = $('hud').getBoundingClientRect(), bot = $('bottom').getBoundingClientRect();
	const r = (x) => (Number.isFinite(x) ? String(Math.round(x * 10) / 10) : '–'), sg = (x) => (Number.isFinite(x) ? `${x < 0 ? '−' : '+'}${r(Math.abs(x))}` : '–');
	const cal = src.calibrator;
	return [
		`window ${innerWidth}×${innerHeight} · screen turned ${readScreenAngle()}° · ${portrait() ? 'portrait' : 'landscape'}`,
		(vv ? `visible ${r(vv.width)}×${r(vv.height)} at ${r(vv.offsetLeft)},${r(vv.offsetTop)} · zoom ×${vv.scale.toFixed(2)} · ` : '') + `scrolled ${r(scrollX)},${r(scrollY)}`,
		`safe area: top ${r(parseFloat(sa.paddingTop))} right ${r(parseFloat(sa.paddingRight))} bottom ${r(parseFloat(sa.paddingBottom))} left ${r(parseFloat(sa.paddingLeft))}`,
		`top bar ${r(hud.left)},${r(hud.top)}–${r(hud.right)},${r(hud.bottom)} · bottom bar ${r(bot.top)}–${r(bot.bottom)}`,
		lastTap ? `last tap ${r(lastTap.x)},${r(lastTap.y)} reached ${lastTap.target}` : 'last tap: none yet (tap anywhere)',
		`compass ${src.status}${src.calibrating ? ', settling' : ''} · ${S.aim === 'compass' ? 'following the phone' : 'dragging'} · facing ${r(S.look.az)}°`,
		cal.ready ? `iPhone heading correction ${sg(cal.offset)}°, from the ${cal.used === 'camera' ? 'back camera' : 'top edge'}'s heading · accuracy ${src.accuracy == null ? '–' : src.accuracy + '°'}` : 'no iPhone heading correction (Android, a computer, or not settled)',
		`true north = magnetic ${sg(S.decl)}° · lined up by ${sg(S.nudge)}°`,
	].join('\n');
}
function diagTick() { if (prefs.diag) $('diag').textContent = diagText(); }
function diagUi() {
	$('diag').hidden = !prefs.diag;
	if (!prefs.diag) $('diagDot').hidden = true;
	clearInterval(diagTimer);
	if (prefs.diag) { diagTick(); diagTimer = setInterval(diagTick, 400); }
}
diagUi();

// ---- Saved areas: "Use it without signal" in the place sheet -------------------------------------------
// The worker downloads, keeps and deletes them (saved.js); this page shows the list, an estimate of
// the download for the place on screen, the progress with Stop, and Finish and Delete (two taps).
// Their messages carry no generation number, as they aren't part of a view. Saving asks the browser
// to keep the site's storage (navigator.storage.persist(); Firefox asks the visitor), inside the tap.
const SAVED_MSGS = new Set(['areas', 'estimate', 'saveProgress', 'saved', 'described']);
const IOS_DEVICE = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const SV = { areas: null, saving: null, prog: null, est: null, estFor: '', armed: null, armTimer: 0, drawn: '' };
const mbText = (b) => `${(b / 1048576).toFixed(b < 9.95 * 1048576 ? 1 : 0)} MB`;
function toWorker(msg) { if (!worker) makeWorker(); if (worker) worker.postMessage(msg); return !!worker; }
// A searched address is named by its suburb or town, as in links; a GPS fix by the day.
function areaName(p) {
	if (p.source === 'gps') return `Your location on ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
	return p.address ? (p.locality || 'A searched address') : p.name;
}
const radiusNow = () => +$('saveRadius').value || prefs.saveKm;
// An area saved for an automatic range serves any range; one saved for a fixed range, that or less.
const rangeCovered = (a) => a.range === 'auto' || (prefs.range !== 'auto' && prefs.range <= a.range);
// Said only where it is so (the worker checks whether finer data exists there: estimate.less).
const detailWords = (e) => (!e.less ? '' : e.detail === 'basic' ? ', with less detail close by' : ', with a little less detail close by');
const wifi = (b) => (b > 50 * 1048576 ? ' Best on Wi-Fi.' : '');
const tens = (v) => nf(Math.max(10, Math.round(v / 10) * 10));
function areaExtent(a) {
	if (!a.box) return `Within ${a.radiusKm} km`;
	const { wKm, hKm } = boxSize(a.box);
	return `${tens(wKm)} × ${tens(hKm)} km`;
}
const estKey = () => (S.place ? `${S.place.lat.toFixed(5)},${S.place.lon.toFixed(5)},${radiusNow()},${prefs.range}` : '');
function savedOpen() {
	$('saveRadius').value = String(prefs.saveKm);
	toWorker({ type: 'areas' });
	askEstimate();
	savedUi();
}
function askEstimate() {
	const k = estKey();
	if (!k) return;
	if (k !== SV.estFor) SV.est = null;
	SV.estFor = k;
	toWorker({ type: 'estimate', key: k, lat: S.place.lat, lon: S.place.lon, radiusKm: radiusNow(), rangeKm: prefs.range });
}
function saveArea(a) {
	if (SV.saving) return;
	try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch (e) { /* optional */ }
	if (!toWorker({ type: 'save', ...a, rangeKm: a.range })) return;
	SV.saving = a.id; SV.prog = null; SV.resuming = (SV.areas || []).some((x) => x.id === a.id);
	$('saveStatus').textContent = `Saving “${a.name}”…`;
	savedUi();
}
$('saveBtn').addEventListener('click', () => {
	const p = S.place;
	if (!p) return;
	saveArea({ id: 'a' + Date.now().toString(36), name: areaName(p), lat: p.lat, lon: p.lon, radiusKm: radiusNow(), range: prefs.range });
});
$('saveStop').addEventListener('click', () => { if (SV.saving) toWorker({ type: 'saveCancel', id: SV.saving }); });
$('saveRadius').addEventListener('change', () => { prefs.saveKm = radiusNow(); savePrefs(); askEstimate(); savedUi(); });
function disarm() { clearTimeout(SV.armTimer); if (SV.armed) { SV.armed = null; savedUi(); } }
function onSaved(m) {
	if (m.type === 'areas') {
		SV.areas = Array.isArray(m.areas) ? m.areas : [];
		SV.saving = m.saving || null;
		if (!SV.saving) SV.prog = null;
	} else if (m.type === 'estimate') {
		if (m.key === SV.estFor) SV.est = m;
		if (m.key === ASK.key) ASK.est = m;
	} else if (m.type === 'described') {
		if (m.key === ASK.key) ASK.desc = m;
	} else if (m.type === 'saveProgress') {
		SV.saving = m.id; SV.prog = m;
	} else if (m.type === 'saved') {
		SV.saving = null; SV.prog = null;
		// (listed now: the worker's fresh list of areas comes a moment later, and until then the sheet
		// showed no area and Save still on)
		if (m.area) SV.areas = (SV.areas || []).filter((a) => a.id !== m.area.id).concat(m.area);
		const known = (SV.areas || []).find((a) => a.id === m.id), name = (m.area && m.area.name) || (known && known.name) || 'the area';
		const text = m.ok ? `Saved “${name}” (${mbText(m.area.bytes)}): it works there without signal now.`
			: m.area ? `“${name}” is saved apart from ${m.missing} of ${m.total} pieces that didn’t download. Tap Finish to try again.`
			: m.stopped ? (SV.resuming ? `Stopped. “${name}” is still not finished: tap Finish to carry on.` : 'Stopped. Nothing was kept.')
			: m.message || 'It didn’t finish.';
		$('saveStatus').textContent = text;
		if (!$('placeSheet').open) toast(text, 5000);
		askEstimate();
	}
	savedUi();
	if (ASK.spec) askUi();
}

// ---- A link offering to save an area (#save=…, saved.js parseSaveLink) ---------------------------------
// For a site such as a guide to somewhere with no signal: link here, and the visitor can save the area
// before they go. Nothing is downloaded unless "Save it" is tapped. What the area is comes from the
// place names (the town nearest a circle's centre, the biggest towns in it, the country), never from the
// link; the link's own name is only shown as what the link calls it. Answered either way, the address
// becomes an ordinary link to the middle of the area, so a reload doesn't ask again.
const ASK = { spec: null, key: '', est: null, desc: null, have: null, n: 0 };
const DIRS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
const dirWord = (b) => DIRS[Math.round((((b % 360) + 360) % 360) / 45) % 8];
const listWords = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const at2 = (p) => `${p.lat.toFixed(2)}, ${p.lon.toFixed(2)}`;
function countryName(cc) {
	try { return cc ? new Intl.DisplayNames(['en'], { type: 'region' }).of(cc) || '' : ''; } catch (e) { return ''; }
}
const askArea = (s) => (s.box ? { box: s.box } : { lat: s.lat, lon: s.lon, radiusKm: s.radiusKm });
function askWords(s, d) {
	const country = d ? countryName(d.cc) : '', towns = d && d.towns.length ? ` taking in ${listWords(d.towns)}` : '';
	const off = (n) => (n.km < 3 || n.dir == null ? n.name : `${nf(n.km)} km ${dirWord(n.dir)} of ${n.name}`);
	if (s.box) {
		const { wKm, hKm } = boxSize(s.box);
		const where = towns || (d && d.near ? ` centred ${off(d.near)}` : ` around ${at2(s)}`);
		return `An area of about ${tens(wKm)} × ${tens(hKm)} km${where}${country ? `, ${country}` : ''}.`;
	}
	const at = d && d.near ? (d.near.km < 3 || d.near.dir == null ? d.near.name : `a spot ${off(d.near)}`) : at2(s);
	return `Anywhere within ${nf(s.radiusKm)} km of ${at}${country ? `, ${country}` : ''}${towns ? `,${towns}` : ''}.`;
}
// What the saved area is called: the link's name, else one from the place names.
function askLabel(s, d) {
	if (s.name) return s.name;
	if (s.box) return d && d.towns.length ? `Around ${d.towns[0]}` : `Around ${at2(s)}`;
	return `Within ${s.radiusKm} km of ${d && d.near ? d.near.name : at2(s)}`;
}
function openAsk(s) {
	ASK.spec = s; ASK.est = null; ASK.desc = null; ASK.have = null; ASK.key = 'ask' + (++ASK.n);
	if (!s.error) {
		toWorker({ type: 'areas' });
		toWorker({ type: 'estimate', key: ASK.key, ...askArea(s), rangeKm: prefs.range });
		toWorker({ type: 'describe', key: ASK.key, ...askArea(s) });
		// (should no answer come, the area is worded by its coordinates)
		const k = ASK.key;
		setTimeout(() => { if (ASK.key === k && !ASK.desc) { ASK.desc = { near: null, towns: [], cc: null }; askUi(); } }, 20000);
	}
	askUi();
	if (!$('saveAsk').open) openSheet($('saveAsk'));
}
function askUi() {
	const s = ASK.spec;
	if (!s) return;
	const bad = !!s.error;
	const e = ASK.est, have = e && !e.tooBig && (SV.areas || []).find((a) => a.status === 'saved' && rangeCovered(a) && covers(a, { ...s, detail: e.detail }));
	ASK.have = have || null;
	$('saveAskTitle').textContent = bad ? 'This link can’t be used' : have ? 'This area is already saved' : 'Save an area to use without signal?';
	$('saveAskWhat').textContent = bad ? (s.error === 'big' ? `It asks to save an area bigger than can be saved in one go: at most ${MAX_RADIUS_KM} km round a point, or ${MAX_SIDE_KM} km a side.` : 'It asks to save an area, but its numbers can’t be read.')
		: ASK.desc ? askWords(s, ASK.desc) : 'Working out where it is…';
	$('saveAskName').hidden = bad || !s.name;
	if (s.name) $('saveAskName').textContent = `The link calls it “${s.name}”.`;
	$('saveAskSize').hidden = bad;
	$('saveAskSize').textContent = !e ? 'Working out the size…' : e.tooBig ? 'It is too big to save in one go.' : have ? `It is saved as “${have.name}”, so it works there without signal.`
		: `About ${mbText(Math.max(e.bytes, 1e5))} to download${detailWords(e)}.${wifi(e.bytes)}${SV.saving ? ' (Another area is being saved: this can start when it has finished.)' : ''}`;
	$('saveAskKeep').hidden = bad || !!(e && (e.tooBig || have));
	$('saveAskIos').hidden = bad || !(IOS_DEVICE && !IOS_APP);
	// (already saved: the button looks from there instead; it used to stay "Save it", disabled but looking
	// the same, so a tap did nothing)
	$('saveAskGo').hidden = bad || !!(e && e.tooBig);
	$('saveAskGo').textContent = have ? 'Look from there' : 'Save it';
	$('saveAskGo').disabled = !have && (!e || !!SV.saving);
	$('saveAskNo').textContent = bad || (e && (e.tooBig || have)) ? 'OK' : 'Not now';
}
// The dialog answered: the address becomes a link to the middle of the area (none for a bad link).
function askDone() {
	const s = ASK.spec, d = ASK.desc, e = ASK.est;
	ASK.spec = null; ASK.key = '';
	closeSheet($('saveAsk'));
	const at = s && !s.error ? { name: askLabel(s, d), lat: s.lat, lon: s.lon, source: 'link' } : null;
	// (rounded, as links are: the middle of someone else's area, to look from)
	try { history.replaceState(null, '', location.pathname + location.search + (at ? `#at=${+at.lat.toFixed(2)},${+at.lon.toFixed(2)}&name=${encodeURIComponent(at.name)}` : '')); } catch (err) { /* sandboxed */ }
	return { s, at, e };
}
$('saveAskGo').addEventListener('click', () => {
	const have = ASK.have, { s, at } = askDone();
	if (!s || s.error) return;
	if (!S.started) begin();
	pendingLink = null;
	if (!S.place || S.place.lat !== at.lat || S.place.lon !== at.lon) choosePlace(at); else { S.place.name = at.name; placeUi(); }
	$('startLinkName').textContent = at.name;
	if (have) return; // ("Look from there": it is saved already)
	saveArea({ id: 'a' + Date.now().toString(36), name: at.name, lat: s.lat, lon: s.lon, radiusKm: s.radiusKm || null, box: s.box || null, range: prefs.range });
	// (the progress, with Stop, is in the place sheet)
	savedOpen(); placeUi(); openSheet($('placeSheet'));
});
$('saveAskNo').addEventListener('click', () => {
	const { at } = askDone();
	if (at && !S.started) { pendingLink = at; $('startLink').hidden = false; $('startLinkName').textContent = at.name; }
	if (!S.started) openSheet($('intro'));
});
$('saveAsk').addEventListener('cancel', (e) => { e.preventDefault(); $('saveAskNo').click(); }); // Escape is "Not now"
function savedUi() {
	const p = S.place, busy = !!SV.saving, r = radiusNow(), e = SV.est && SV.est.key === estKey() ? SV.est : null;
	const areas = SV.areas || [];
	// Already inside a finished area that big, at that detail, saved for this range? (An automatic
	// range needs both 150 and 250 km; a fixed one is covered by any area saved for at least as far.)
	const need = p && { lat: p.lat, lon: p.lon, radiusKm: r, detail: e ? e.detail : r <= 20 ? 'full' : 'lite' };
	const inside = p && areas.find((a) => a.status === 'saved' && rangeCovered(a) && covers(a, need));
	$('saveBtn').disabled = !p || busy || !!inside || !!(e && e.tooBig);
	const where = !p ? '' : p.source === 'gps' ? 'where you are' : areaName(p);
	$('saveEst').textContent = !p ? 'Choose a place first.' : inside ? `Already saved, as part of “${inside.name}”.`
		: e ? (e.tooBig ? 'That is too big to save in one go: choose a smaller area.'
			: e.have >= e.tiles && e.bytes < 1e5 ? 'Already saved.'
			: `Anywhere within ${r} km of ${where}: about ${mbText(Math.max(e.bytes, 1e5))} to download${detailWords(e)}.${wifi(e.bytes)}`)
		: 'Working out the size…';
	$('saveProg').hidden = !busy;
	$('saveText').hidden = !(busy && SV.prog);
	if (busy && SV.prog) {
		const pr = SV.prog;
		$('saveBar').max = Math.max(1, pr.total); $('saveBar').value = pr.done;
		$('saveText').textContent = `${pr.done} of ${pr.total} pieces, ${mbText(pr.bytes)}`;
	}
	$('savedIos').hidden = !(IOS_DEVICE && !IOS_APP);
	// The list is rebuilt only when it changes (not on every progress message), so focus stays put.
	const sig = JSON.stringify([areas, SV.saving, SV.armed]);
	if (sig === SV.drawn) return;
	SV.drawn = sig;
	const ul = $('savedList');
	ul.hidden = !areas.length;
	const had = ul.contains(document.activeElement) ? document.activeElement.dataset.k : null;
	ul.replaceChildren(...areas.slice().sort((a, b) => b.savedAt - a.savedAt).map(areaItem));
	if (had) { const el = ul.querySelector(`[data-k="${had}"]`); if (el) el.focus(); }
}
function areaItem(a) {
	const li = document.createElement('li'), go = document.createElement('button'), n = document.createElement('span'), w = document.createElement('span');
	li.className = 'area';
	go.type = 'button'; go.className = 'res'; go.title = 'Look from here'; go.dataset.k = a.id + ':go';
	n.className = 'rn'; n.textContent = a.name;
	const when = a.savedAt ? new Date(a.savedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(new Date(a.savedAt).getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) }) : '';
	w.className = 'rw';
	w.textContent = `${areaExtent(a)}${a.detail && a.detail !== 'full' && a.less !== false ? ' · less detail close by' : ''} · ` + (a.id === SV.saving ? 'saving…' : a.status === 'saved' ? `${mbText(a.bytes)} · saved ${when}` : `not finished${a.missing ? ` (${a.missing} pieces missing)` : ''}`);
	go.append(n, w);
	go.addEventListener('click', () => { closeSheet($('placeSheet')); choosePlace({ name: a.name, lat: a.lat, lon: a.lon, source: 'saved' }); });
	li.append(go);
	const side = (label, k, fn, armed = false) => {
		const b = document.createElement('button');
		b.type = 'button'; b.className = 'side' + (armed ? ' armed' : ''); b.textContent = label; b.dataset.k = a.id + ':' + k;
		b.setAttribute('aria-label', `${label}: ${a.name}`);
		b.addEventListener('click', fn);
		return b;
	};
	if (a.id === SV.saving) return li;
	if (a.status !== 'saved') li.append(side('Finish', 'fin', () => saveArea(a)));
	const armed = SV.armed === a.id;
	li.append(side(armed ? 'Tap again' : 'Delete', 'del', () => {
		clearTimeout(SV.armTimer);
		if (armed) { SV.armed = null; toWorker({ type: 'unsave', id: a.id }); $('saveStatus').textContent = `Deleted “${a.name}”.`; }
		else { SV.armed = a.id; SV.armTimer = setTimeout(disarm, 4000); }
		savedUi();
	}, armed));
	return li;
}

// The Detail slider.
function setDetail(v) {
	S.detail = Math.min(100, Math.max(0, Math.round(+v)));
	const el = $('detail'), name = stopName(S.detail);
	if (+el.value !== S.detail) el.value = String(S.detail);
	el.setAttribute('aria-valuetext', name);
	$('detailName').textContent = name;
	prefs.detail = S.detail; savePrefs();
	S.dirty = true;
}
$('detail').addEventListener('input', (e) => setDetail(e.target.value));

// The List: what the slider names, all the way round, by bearing, plus the biggest places hidden
// behind hills (at most LIST_HIDDEN of them: from Interlaken some 240 famous peaks and cities are
// hidden, which would bury the rest). The screen-reader version of the drawing.
const LIST_HIDDEN = 12;
function listUi() {
	const p = detailParams(S.detail, G.w, zoomRelax(), prefs.air);
	const hidden = S.labels.filter((L) => L.status === 'hidden' && L.major).sort((a, b) => b.score - a.score).slice(0, LIST_HIDDEN);
	const items = S.labels.filter((L) => allowed(L, p)).concat(hidden).sort((a, b) => a.az - b.az);
	$('listNote').textContent = !S.place ? 'Choose a place first.' : !S.labelsIn ? (S.placesErr ? 'The place names didn’t load.' : 'Still working out the view…')
		: `${items.length - hidden.length} named at this detail (${stopName(S.detail)})${hidden.length ? `, and the ${hidden.length === 1 ? 'one big place' : `${hidden.length} biggest places`} hidden from view` : ''}, by bearing from north, from ${S.place.name}.${S.placesPartial ? ' Some place names didn’t load.' : ''}`;
	const ul = $('listItems');
	ul.replaceChildren(...items.map((L) => {
		const li = document.createElement('li'), b = document.createElement('button');
		b.type = 'button'; b.className = 'res' + (L.status === 'hidden' ? ' behind' : '');
		const bb = document.createElement('span'), n = document.createElement('span'), w = document.createElement('span');
		bb.className = 'rb'; bb.textContent = `${Math.round(L.az) % 360}° ${point(L.az)}`;
		n.className = 'rn'; n.textContent = L.name + (L.sub ? ` (${L.sub})` : '') + (L.iata ? ` (${L.iata})` : '');
		const h = heightText(L);
		w.className = 'rw'; w.textContent = [kindWord(L), `${kmText(L.dist)} away`, h && `${h} high`, L.status === 'hidden' ? behindWords(L) : STATUS[L.status]].filter(Boolean).join(' · ');
		b.append(bb, n, w);
		b.addEventListener('click', () => {
			closeSheet($('listSheet'));
			S.selected = L.id;
			if (S.aim === 'drag') { S.az = L.az; S.userMoved = true; } else toast(`Turn to ${Math.round(L.az) % 360}° ${point(L.az)} to face ${L.name}`);
			S.dirty = true; cardUi();
		});
		li.append(b);
		return li;
	}));
}

// About: "how this view was made".
function aboutUi() {
	const s = S.stats, p = S.pano, el = $('howMade');
	if (!s || !p) { el.textContent = S.place ? 'Still working it out…' : 'Nothing drawn yet.'; return; }
	const from = { mapterhorn: 'Mapterhorn', aws: 'the AWS terrain tiles (fallback)', mixed: 'Mapterhorn, with the AWS fallback for some tiles' }[s.source || p.source] || s.source;
	const ms = s.ms || {}, total = ['fetch', 'decode', 'coarse', 'full', 'labels'].reduce((a, k) => a + (+ms[k] || 0), 0);
	el.textContent = `From ${S.place.name}: terrain from ${from}, ${nf(s.tiles || 0)} tiles, ${((s.bytes || 0) / 1048576).toFixed(1)} MB, out to ${nf(p.rangeKm)} km. `
		+ `Worked out in ${(total / 1000).toFixed(1)} s (download ${nf(ms.fetch || 0)} ms, decoding ${nf(ms.decode || 0)} ms, first skyline ${nf(ms.coarse || 0)} ms, full panorama ${nf(ms.full || 0)} ms, names ${nf(ms.labels || 0)} ms). `
		+ (p.summit ? `Looking from the top of ${p.summit.name}, ${nf(p.summit.dist)} m from the place chosen. ` : '')
		+ (s.areaLess ? 'Inside a saved area that keeps less detail close by, so the nearest hills come from coarser data. ' : '')
		+ `Eye ${nf(p.eye)} m above sea level (the ground there is ${nf(p.ground)} m${aglMetres() ? `, plus ${aglMetres()} m up` : ''}).`;
}

// ---- The card -------------------------------------------------------------------------------------------------
// The card is redrawn ten times a second as the view turns, so it isn't a live region (a screen
// reader would read out every degree). What it names is told to screen readers through #cardSr
// instead (say() below): a place once it has stayed named for a second, a tap or a List pick at
// once, a problem at once, and never the bare bearing.
const setText = (id, v) => { const el = $(id); if (el.textContent !== v) el.textContent = v; };
let srWant = null, srSince = 0, srSaid = null;
function say(key, text, hold = 1000) {
	const now = performance.now();
	if (key !== srWant) { srWant = key; srSince = now; }
	if (key === null || key === srSaid || now - srSince < hold) return;
	srSaid = key;
	$('cardSr').textContent = text;
}
function heightText(L) {
	if (!(L.kind === 'peak' || L.kind === 'hill') || !(L.ele > 0)) return '';
	return L.eleSrc === 'dem' ? `≈ ${nf(L.ele)} m` : `${nf(L.ele)} m`;
}
const shortName = (n) => n.replace(/^Mount /, 'Mt ');
// What hides a big place: the hills, or just the curve of the Earth: when the place is below the
// sea horizon itself (the worker's overHorizon), or what stands in front of it is the sea or flat
// ground at sea level. The blocker's height comes back from its altitude and distance with the
// engine's curvature and refraction (SPEC §3: drop = d²(1 − k)/2R).
function behindWords(L) {
	if (L.overHorizon) return 'over the horizon';
	if (!S.pano || !Number.isFinite(L.blockAlt) || !(L.blockDist > 0)) return 'behind the hills';
	const d = L.blockDist * 1000, h = S.pano.eye + d * Math.tan(L.blockAlt * Math.PI / 180) + d * d * (1 - 0.13) / (2 * 6371008.8);
	return h < 4 ? 'over the horizon' : 'behind the hills';
}
// The card for one place. off: how far it is from the centre (degrees, + to the right) when it's
// named as the nearest one drawn rather than the one ahead; it then leads the kicker.
function cardFor(L, off = null, hold = 1000) {
	const kind = kindWord(L);
	const dir = off === null ? '' : `${Math.max(1, Math.round(Math.abs(off)))}° to your ${off < 0 ? 'left' : 'right'} · `;
	setText('cKicker', `${dir}${kind} · ${L.status === 'hidden' ? behindWords(L) : STATUS[L.status] || ''}`);
	setText('cName', L.name);
	setText('cSub', L.sub || '');
	const bits = [`${kmText(L.dist)} away`];
	const h = heightText(L);
	if (h) bits.push(`${h} high`);
	else if (L.pop > 0) bits.push(`about ${nf(L.pop)} people`);
	if (L.iata) bits.push(`airport code ${L.iata}`);
	bits.push(`bearing ${Math.round(L.az) % 360}° ${point(L.az)}`);
	if (L.status === 'hidden' && L.blockDist) bits.push(behindWords(L) === 'over the horizon' ? 'hidden by the curve of the Earth' : `hidden by the ground ${kmText(L.blockDist)} away`);
	if (L.approx) bits.push('its position on the map is approximate');
	setText('cDetail', bits.join(' · '));
	const wiki = $('cWiki');
	if (L.wiki) { wiki.href = `https://en.wikipedia.org/wiki/${encodeURIComponent(String(L.wiki === 1 ? L.name : L.wiki).replace(/ /g, '_'))}`; wiki.hidden = false; } else wiki.hidden = true;
	say(`${off === null ? 'at' : 'near'}:${L.id}`, `${L.name}${L.sub ? ` (${L.sub})` : ''}. ${dir}${$('cKicker').textContent.slice(dir.length)}. ${bits.join(', ')}.`, hold);
}
// Go there, on the card of a name tapped or picked from the List only (not on one the card names
// because it is ahead, which changes as the view turns). Its name for screen readers and voice
// control starts with the words it shows.
function goUi(L) {
	if (!Number.isFinite(L.lat) || !Number.isFinite(L.lon)) return;
	const b = $('goBtn'), a = `Go there: look from ${L.name}`;
	b.hidden = false;
	if (b.getAttribute('aria-label') !== a) { b.setAttribute('aria-label', a); b.title = `Look from ${L.name}, facing the same way`; }
}
// The degrees across the screen, either view.
function viewWidth() {
	if (S.view === 'sign') return signWidth();
	return 2 * Math.atan(Math.tan(camFovNow() * DEG / 2) * innerWidth / innerHeight) / DEG;
}
function cardUi() {
	const retry = $('retryBtn');
	retry.hidden = true;
	setText('cSub', '');
	$('cWiki').hidden = true;
	$('goBtn').hidden = true;
	const plain = (kicker, name, detail, key = null, hold = 0) => {
		setText('cKicker', kicker); setText('cName', name); setText('cDetail', detail);
		say(key, `${kicker}. ${name}. ${detail}`, hold);
	};
	if (!S.place) { plain('Scan the Horizon', 'Choose a place to look from', 'Tap “From” at the top, or use your location.'); return; }
	if (S.terrainErr) {
		plain('The terrain didn’t load', 'Nothing to draw yet', 'Check the connection, then try again.', 'err:' + S.gen);
		retry.hidden = false;
		return;
	}
	if (S.stalled) {
		plain('Still working out the view', 'The download has stalled', `Nothing has come in for ${STALL / 1000} seconds. Check the connection, then try again.`, 'stall:' + S.gen);
		retry.hidden = false;
		return;
	}
	if (!S.pano) {
		const pr = S.progress;
		plain('Working out the view', S.place.name, pr && pr.total ? `Terrain: ${pr.done} of ${pr.total} tiles, ${(pr.bytes / 1048576).toFixed(1)} MB` : 'Downloading the terrain…');
		return;
	}
	const sel = S.selected !== null && S.labels.find((L) => L.id === S.selected);
	if (sel) { cardFor(sel, null, 0); goUi(sel); return; }
	// What the card names comes from what is drawn, so it is always a label on screen: the best
	// within 2° of the centre (one in view before a behind-arrow, then by score), else the nearest
	// drawn within a quarter of the screen either side, with which way to look.
	const az = S.look.az;
	let best = null, near = null, nearOff = 0;
	for (const q of S.placed) {
		const L = q.L, off = wrap180(L.az - az), hid = !!q.behind;
		if (Math.abs(off) <= 2) {
			if (!best || (best.status === 'hidden') > hid || ((best.status === 'hidden') === hid && L.score > best.score)) best = L;
		} else if (Math.abs(off) <= viewWidth() / 4 && (!near || Math.abs(off) < Math.abs(nearOff))) { near = L; nearOff = off; }
	}
	if (best) { cardFor(best); return; }
	if (near) { cardFor(near, nearOff); return; }
	// Nothing named this way: say what the skyline here is (pano.sea: 1 the sea horizon, 2 cut off
	// by the end of the range over flat ground).
	const P = S.pano, i = ((Math.round(az / P.step) % P.n) + P.n) % P.n, sea = P.sea && P.sea.length === P.n ? P.sea[i] : 0;
	const what = sea === 1 ? `The sea horizon, ${kmText(P.dist[i])} away` : sea === 2 ? `Flat to the edge of the ${nf(P.rangeKm)} km range` : `The skyline here is ${kmText(P.dist[i])} away`;
	setText('cKicker', `Facing ${Math.round(az) % 360}° ${point(az)}`);
	setText('cName', S.labelsIn || S.placesErr ? 'Nothing named this way' : 'Finding the names…');
	setText('cDetail', `${what}${S.placesErr ? ' · place names didn’t load' : ''}`);
	say(S.placesErr ? 'noplaces:' + S.gen : null, 'The place names didn’t load: the drawing is shown without them.', 0);
}
$('retryBtn').addEventListener('click', () => { if (!worker) makeWorker(); startRun(); });

function progressUi(done) {
	const pr = S.progress, box = $('progress');
	// The bar shows the terrain download only, until the full panorama is in.
	if (done || !pr || !pr.total || S.terrainErr || pr.stage !== 'terrain' || (S.pano && S.pano.stage === 'full')) { box.hidden = true; return; }
	box.hidden = false;
	$('progressBar').style.width = `${Math.min(100, 100 * pr.done / pr.total).toFixed(0)}%`;
}
function hintUi() {
	const h = $('hint');
	const show = S.view === 'camera' && S.aim !== 'compass';
	h.hidden = !show;
	if (show) h.textContent = compassOk() ? 'Dragging: line the drawing up with the picture.' : 'No compass: line the drawing up by dragging it.';
}
let lastAim = '';
function exagText() {
	const e = S.ex ?? prefs.exag;
	if (e < prefs.exag - 0.05) return ` · hills ×${e.toFixed(1)} to fit`;
	return prefs.exag > 1 ? ` · hills ×${prefs.exag}` : '';
}
function readouts() {
	const L = S.look;
	const txt = S.view === 'sign'
		? `${S.aim === 'compass' ? 'Facing' : 'Looking'} ${Math.round(L.az) % 360}° ${point(L.az)} · ${Math.round(signWidth())}° across${exagText()}`
		: `Looking ${Math.round(L.az) % 360}° ${point(L.az)} · ${Math.abs(Math.round(L.alt || 0))}° ${(L.alt || 0) >= 0 ? 'up' : 'down'}`;
	if (txt !== lastAim) { $('aimText').textContent = txt; lastAim = txt; }
	// The compass note: the iPhone's compass still settling (shown whichever way the view is aimed:
	// it is what stops the compass taking over), an unsure compass, or a compass gone quiet.
	const cal = $('calib'), poor = src.accuracy !== null && src.accuracy > 25;
	const calText = src.calibrating || (S.aim === 'compass' && compassOk() && poor)
		? (poor ? 'The compass is unsure here: move the phone in a figure of eight, away from metal.' : 'Settling the compass: hold the phone upright facing the view, or flat, for a moment.')
		: compassQuiet() ? 'No compass readings for a while: if the drawing doesn’t turn with you, tap “Drag instead”.' : '';
	cal.hidden = !calText;
	if (calText && cal.textContent !== calText) cal.textContent = calText;
	// How many names the slider allows here that there was no room for: the List has them.
	const mb = $('moreBtn'), more = S.more || 0, mt = more ? `+${more} more` : '';
	if (mb.textContent !== mt) {
		mb.textContent = mt;
		mb.classList.toggle('idle', !more);
		mb.disabled = !more;
		if (more) mb.setAttribute('aria-label', `${more} more ${more === 1 ? 'name' : 'names'} here than there is room for: open the List`);
	}
	checkStall();
	cardUi();
}

// ---- Drawing ----------------------------------------------------------------------------------------------------
const pool = [], labelBox = $('labels');
function labelEl(i) {
	if (!pool[i]) {
		const d = document.createElement('div');
		const t = document.createTextNode(''), h = document.createElement('span');
		h.className = 'h';
		d.append(t, h);
		labelBox.append(d);
		pool[i] = { el: d, t, h, text: '', ht: '', cls: '' };
	}
	return pool[i];
}
const zoomRelax = () => {
	const ratio = S.view === 'sign' ? defaultWidth() / signWidth() : fovFor(LONG) / camFovNow();
	return 0.5 * Math.log2(Math.max(ratio, 1e-3));
};
function projection() {
	if (S.view === 'sign') {
		const P0 = signProjection(G, S.look.az, signWidth(), prefs.exag, 0);
		const t = horizonTarget(P0);
		if (S.hy === null || S.ex === null || REDUCED.matches) { S.hy = t.hy; S.ex = t.exag; }
		else if (Math.abs(t.hy - S.hy) > 0.5 || Math.abs(t.exag - S.ex) > 0.005) { S.hy += (t.hy - S.hy) * 0.18; S.ex += (t.exag - S.ex) * 0.18; S.dirty = true; } else { S.hy = t.hy; S.ex = t.exag; }
		return signProjection(G, S.look.az, signWidth(), S.ex, S.hy);
	}
	const q = S.aim === 'compass' && lastQ ? lastQ : fromAttitude(wrap360(S.az), S.alt, 0);
	return cameraProjection(G, q, camFovNow(), S.look);
}
function draw() {
	const t0 = performance.now();
	const P = projection();
	S.lastP = { kind: P.kind, cx: P.cx, hy: P.hy, ppd: P.ppd, exag: P.exag, centreAz: P.centreAz };
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, G.W, G.H);
	const params = detailParams(S.detail, G.w, zoomRelax(), prefs.air);
	ctx.save();
	ctx.beginPath(); ctx.rect(0, G.top, G.W, G.bottom - G.top); ctx.clip();
	const skyTop = drawTerrain(ctx, P, S.pano, params, theme, G);
	// Candidates: up to three big hidden places as behind-arrows (whatever the slider says), the
	// tapped one, then everything the slider allows, by score.
	const cands = [];
	let nb = 0;
	const behind = S.labels.filter((L) => L.status === 'hidden' && L.major && Number.isFinite(L.blockAlt)).sort((a, b) => b.score - a.score);
	for (const L of behind) {
		if (nb >= 3) break;
		const p = P.pt(L.az, L.blockAlt);
		if (!p || p.x < 4 || p.x > G.W - 4) continue;
		// The same as every other label, name then distance, with what hides it after (Adam asked for
		// the arrow to say "behind").
		const text = shortName(L.name), ht = `${kmText(L.dist)} · ${behindWords(L)}`;
		cands.push({ key: 'b' + L.id, L, ax: p.x, ay: p.y, w: labelWidth(text, ht), text, ht, behind: true });
		nb++;
	}
	const sel = S.selected;
	const base = S.order || [];
	const order = sel === null ? base : [...S.labels.filter((L) => L.id === sel), ...base.filter((L) => L.id !== sel)];
	for (const L of order) {
		if (L.status === 'hidden') continue;
		if (L.id !== sel && !allowed(L, params)) continue;
		const p = P.pt(L.az, L.alt);
		if (!p) continue;
		// Every label is the name and how far away it is, whatever it is (Adam: a height on a peak and
		// a distance on a town gave no clue which a number was). Tapping it opens the card with the rest.
		const text = shortName(L.name), ht = kmText(L.dist);
		cands.push({ key: 'l' + L.id, L, ax: p.x, ay: p.y, w: labelWidth(text, ht), text, ht, dashed: L.status === 'marginal', air: L.kind === 'airport' });
	}
	// Look-ahead for the layout: every label the slider could admit, on screen, in the same order.
	const ahead = cands.filter((c) => c.behind || c.L.id === sel);
	for (const L of base) {
		if (ahead.length > 120) break;
		const p = P.pt(L.az, L.alt);
		if (p && p.x >= 0 && p.x <= G.W && L.id !== sel) ahead.push({ key: 'l' + L.id, ax: p.x, ay: p.y });
	}
	const t1 = performance.now();
	const placed = layoutLabels(cands, G, skyTop, params.budget, S.prevRows, ahead, params.airBudget);
	S.layoutMs = performance.now() - t1;
	{
		let n = 0;
		for (const c of cands) if (!c.behind && c.ax >= G.left + 4 && c.ax <= G.right - 4 && c.ay >= G.top && c.ay <= G.bottom) n++;
		S.more = Math.max(0, n - placed.filter((p) => !p.behind).length);
	}
	S.cands = cands; // (for the test hook)
	drawLeaders(ctx, placed, theme);
	ctx.restore();
	drawTicks(ctx, P, G, theme, S.look.az);
	S.prevRows = new Map(placed.map((p) => [p.key, p.row]));
	S.placed = placed;
	for (let i = 0; i < placed.length; i++) {
		const p = placed[i], o = labelEl(i);
		const cls = 'lab' + (p.behind ? ' behind' : '') + (p.dashed ? ' marg' : '') + (p.L.id === sel ? ' sel' : '');
		if (o.text !== p.text) { o.t.data = p.text; o.text = p.text; }
		if (o.ht !== p.ht) { o.h.textContent = p.ht ? ` ${p.ht}` : ''; o.ht = p.ht; }
		if (o.cls !== cls) { o.el.className = cls; o.cls = cls; }
		o.el.dataset.i = String(i);
		o.el.style.width = `${p.r - p.l}px`;
		o.el.style.transform = `translate(${p.l.toFixed(1)}px, ${p.t.toFixed(1)}px)`;
		o.el.hidden = false;
	}
	for (let i = placed.length; i < pool.length; i++) pool[i].el.hidden = true;
	S.drawMs = performance.now() - t0;
}

// ---- The frame loop -----------------------------------------------------------------------------------------------
// Redraw only when the view moved by more than 0.03°, or something else changed (S.dirty).
let drawn = { az: NaN, alt: NaN, q: null }, lastDom = 0;
function frame(now) {
	requestAnimationFrame(frame);
	if (!G) return;
	watchCompass();
	updateLook();
	const L = S.look;
	const moved = !(Math.abs(wrap180(L.az - drawn.az)) <= 0.03) || (S.view === 'camera' && (!(Math.abs((L.alt || 0) - drawn.alt) <= 0.03) || attChanged(L.q, drawn.q)));
	if (moved || S.dirty) {
		S.dirty = false;
		draw();
		drawn = { az: L.az, alt: L.alt || 0, q: L.q };
		if (S.readyPending && !S.ready) { S.ready = true; aboutUi(); tryFollow(); }
	}
	if (now - lastDom > 100) { lastDom = now; readouts(); }
}
// Roll counts too in the camera view: compare the quaternions (the angle between them).
function attChanged(a, b) {
	if (!a || !b) return a !== b;
	const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
	return 2 * Math.acos(Math.min(1, d)) * 180 / Math.PI > 0.03;
}

// ---- Start ---------------------------------------------------------------------------------------------------------
applyTheme();
setDetail(prefs.detail);
resize();
makeWorker();
const askLink = parseSaveLink(location.hash);
{
	const link = askLink ? (askLink.error ? null : { name: askLink.name || at2(askLink), lat: askLink.lat, lon: askLink.lon, source: 'link' }) : placeFromLink();
	if (link) {
		$('startLink').hidden = false;
		$('startLinkName').textContent = link.name;
		$('startDemo').hidden = true;
		// A link to a view: the drawing gets going behind the start screen. A link offering to save an
		// area: nothing until the dialog is answered (its terrain isn't fetched without a yes).
		if (askLink) pendingLink = link; else setPlace(link);
	} else if (prefs.place) {
		$('startLink').hidden = false;
		$('startLinkName').textContent = prefs.place.name;
		$('startLink').addEventListener('click', () => choosePlace({ ...prefs.place, source: 'stored' }), { once: true });
	}
}
if (!window.DeviceOrientationEvent || !('ontouchstart' in window)) $('introHint').textContent = 'On a computer: drag the drawing to look around, and scroll to zoom. It works indoors too: the drawing is made from elevation data, as if walls, trees and buildings were glass.';
placeUi(); cardUi(); modeUi(); camUi(); camZoomUi();
if (askLink) openAsk(askLink); else openSheet($('intro'));
requestAnimationFrame(frame);

// An installable app that works offline once opened (sw.js), on https or localhost only. Registered
// after the page has loaded, so its downloads don't compete with the first view's.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
	addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => { /* the page works without it */ }); });
}

// ---- Test hook -------------------------------------------------------------------------------------------------------
window.__XRAY = {
	get ready() { return S.ready; },
	state: S,
	prefs,
	src,
	setPlace(lat, lon, name) { choosePlace({ name: name || `${(+lat).toFixed(2)}, ${(+lon).toFixed(2)}`, lat: +lat, lon: +lon, source: 'link' }); },
	// Face a bearing (drag mode; the compass, if live, takes back over unless dragging was chosen).
	setHeading(az, alt = 0) { if (S.aim === 'compass') { userDrag = true; toDrag(); } S.az = wrap360(+az); S.alt = +alt; S.userMoved = true; S.dirty = true; },
	setView,
	setDetail,
	setSetting,
	setWidth,
	labels() {
		return S.placed.map((p) => ({ name: p.L.name, text: p.text + (p.ht ? ' ' + p.ht : ''), id: p.L.id, x: p.ax, y: p.ay, box: { l: p.l, t: p.t, r: p.r, b: p.b }, row: p.row,
			status: p.L.status, kind: p.L.kind, major: !!p.L.major, behind: !!p.behind, dashed: !!p.dashed, hang: !!p.hang, az: p.L.az }));
	},
	pano() { return S.pano; },
	stats() { return S.stats; },
	// the projection of the last frame drawn: the sign view's x = cx + (az − centreAz)·ppd, y = hy − alt·ppd·exag
	proj() { return S.lastP; },
	get view() { return { view: S.view, aim: S.aim, az: S.look.az, alt: S.look.alt, width: signWidth(), camFov: camFovNow(), camAuto: fovFor(LONG), nudge: S.nudge, hy: S.hy, exag: S.ex, geom: { ...G }, drawMs: S.drawMs, layoutMs: S.layoutMs, more: S.more || 0 }; },
	// whether the compass is steering, and when it last sent a reading (performance.now() ms)
	get compass() { return { ok: compassOk(), lastReading, quiet: compassQuiet() }; },
	// shorter waits for the tests: { stall, quiet } in ms
	setTiming(t) { if (t.stall) STALL = t.stall; if (t.quiet) QUIET = t.quiet; if (t.follow) FOLLOW = t.follow; },
	get camPending() { return camPending; },
	startCamera, stopCamera,
	placeFromLink,
	select(id) { S.selected = id; S.dirty = true; cardUi(); },
	behindWords,
	link: linkFor,
	// saved areas: the page's view of them ({ areas, saving, prog, est, … })
	get saved() { return { ...SV }; },
};
