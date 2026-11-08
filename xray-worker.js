// Scan the Horizon worker: terrain + places → panorama + labels, off the main thread (SPEC §5).
// Start it with new Worker('xray-worker.js', { type: 'module' }).
//
// main → worker
//   {type:'run', gen, lat, lon, agl, rangeKm|'auto', lite, source:'auto'|'mapterhorn'|'aws', facing?, summit?}
//       a new place. facing (optional, degrees true) fetches that sector of each ring first. summit
//       (default true): look from the top of a named summit listed within 150 m (targets.js summitNear).
//   {type:'eye', gen, agl, summit?}  new height above ground, or summit on or off: recompute with the DEM already held.
//   {type:'cancel', gen}       stop; in-flight tile fetches are aborted.
//   {type:'decoder', main}     from decode.js attachDecodeFallback(): the page will decode WebP
//   {type:'decoded', id, …}    for a worker without OffscreenCanvas (see decode.js).
//   Saved areas (saved.js; these carry no gen, as they aren't part of a view):
//   {type:'areas'}             → {type:'areas', areas: [summary], saving: id|null}
//   An area is lat, lon, radiusKm (1–200), or box: [south, west, north, east] (saved.js cleanBox).
//   {type:'estimate', key, …area, rangeKm}
//                              → {type:'estimate', key, tiles, places, bytes (to download, estimated), have (tiles already saved),
//                                 detail ('full' | 'lite' | 'basic': saved.js planArea), tooBig}
//   {type:'describe', key, …area} → {type:'described', key, near: {name, km}|null, towns: [name], cc}: what a link's
//                                 area is, from the place names (the town nearest a circle's centre, the biggest inside)
//   {type:'save', id, name, …area, rangeKm}
//                              → {type:'saveProgress', id, done, total, bytes} …, then {type:'saved', id, ok, area?,
//                                 missing?, stopped?, message?} and a fresh 'areas'. The same id again finishes an
//                                 unfinished area. One save at a time.
//   {type:'saveCancel', id}    stop it: a new area is forgotten with its downloads; an unfinished one stays unfinished.
//   {type:'unsave', id}        delete an area (and whatever only it used) → 'areas'.
// worker → main (each carries the gen it answers; drop stale ones)
//   progress, pano (coarse at 0.5° once the z7–z9 rings are in, then full at 0.2°), labels, error,
//   stats, and {type:'decode', id, blob} for the decode fallback. Arrays are transferred.
//   pano also carries summit: {name, dist} when the eye was put on a summit (else null), and sea: Uint8Array(n), 1 where the skyline is sea or flat ground at 0 m, 2 where
//   terrain is still rising at the range edge. Labels also carry wl (Wikipedia language count) and
//   approx: true where GeoNames has the point on a whole arc-minute (up to ~0.9 km off).
//   A 'full' pano can come twice: when the place names are late, the full drawing goes out without
//   the summit lift first, and again with it just before the labels.
//   A places error can be partial: {type:'error', code:'places', fatal:false, partial:true, missing,
//   total, message} means names from the other tiles are in the labels that follow.
//   The coarse pano is skipped when under 80% of the coarse rings loaded (it would draw holes as sea).
//
// Pipeline for 'run': decode canary (once) → ring plan by metres per pixel (dem.js), auto range
// (150 km, or 250 km when the z7 ring shows terrain above 1,500 m) → coarse rings (z7–z9) → coarse
// pano → places tiles, alongside the finer rings → summits lifted from official heights → full pano →
// labels → stats. The engine is exported so a test page can run the identical code on its main
// thread (CDP's CPU throttle can't reach workers) and Node can run it on recorded fixtures.
//
// Runs and cancelling. Each run has its own AbortController, passed down to every request it makes,
// so a cancelled run's loops stop before their next tile, and its requests are aborted. A tile request
// a later run wants too is shared only while its run is alive or once its download has finished
// (otherwise the later run would inherit the cancel and fail). A cancelled run's tile is kept only if
// the plan now in use wants it, so stale work can't refill the store after a prune.
import * as D from './dem.js';
import { computePanorama, linkRidges } from './pano.js';
import { loadPlaces, placeTileUrls, snapPeaks, liftPeaks, summitNear, buildLabels } from './targets.js';
import { canaryBlob, canaryOk, decodeBitmap, decodePNG, MainThreadDecoder } from './decode.js';
import { SavedStore, areaTiles, planArea, awsChildren, summary, cleanBox, reachKm, contains, coarserDetail, DEFAULT_RADIUS, MAX_AREAS, MAX_RADIUS_KM } from './saved.js';

export const EYE = 1.6;                    // eye above the ground, metres
export const AUTO_KM = 150, ALPS_KM = 250, ALPS_TRIGGER_M = 1500;
const CONCURRENCY = 6;
// How long, once the terrain is in, to wait for late place names before drawing without them.
export const PLACES_GRACE_MS = 1500;
// The coarse pano needs this share of the coarse rings' tiles (holes would read as flat sea).
const COARSE_MIN_SHARE = 0.8;
const PENDING = Symbol('pending');
// Saving an area: downloads at a time (fewer than a view's, so a view started meanwhile isn't
// starved), and how many Mapterhorn failures with no success at all mean it isn't answering.
const SAVE_CONCURRENCY = 4, SAVE_GIVE_UP = 6;
// For the estimate, when the view on screen holds no tile of a zoom to go by (bytes). (z9–z12 tiles in
// the Flinders Ranges were 34–144 KB, 93 KB on average, 2026-11-08.)
const EST_TILE = 100000, EST_PLACES = 20000;
const TILE_INIT = { mode: 'cors', credentials: 'omit' };

export class Engine {
	// env: { post(msg, transfer), fetch, caches, placesBase, decodeOverride?(url, blob, src),
	//        deadlines?: { tile: {headMs, maxMs}, places: {headMs, maxMs} }, placesGraceMs? }
	constructor(env) {
		this.env = env;
		const dl = env.deadlines || {};
		this.deadlines = { tile: { ...D.DEADLINES.tile, ...dl.tile }, places: { ...D.DEADLINES.places, ...dl.places } };
		this.saved = new SavedStore({ caches: env.caches || null });
		this.saving = null;                 // the save in progress: { id, ac }
		this.fineSeen = new Map();          // z13 tile URL → whether Mapterhorn has it (fineDataIn)
		this.fetcher = new D.TileFetcher({ fetch: env.fetch, caches: env.caches || null, deadline: this.deadlines.tile, pinned: this.saved });
		// Place names: a saved area's copy of a tile first (offline it may be all there is); the index
		// from the network first (it changes with the data), and the saved copy only if that fails.
		this.placesFetch = async (url, init) => {
			const index = /\/index\.json$/.test(url);
			if (!index) { const hit = await this.saved.match(url); if (hit) return hit; }
			try { return await env.fetch(url, init); } catch (e) {
				const hit = index ? await this.saved.match(url) : null;
				if (hit) return hit;
				throw e;
			}
		};
		this.store = new Map();             // tile key → { status: 'ok'|'sea'|'none', data, src, bytes }
		this.inflight = new Map();          // tile key → { p, signal, fetched }
		this.keep = null;                   // tile keys the plan in use wants (from prune)
		this.ac = null;                     // the AbortController of the run in progress
		this.runId = 0; this.gen = 0;
		this.mainDecoder = null; this.decoderP = null;
		this.held = null;                   // the last finished run, for 'eye'
		this.params = null;
		this.running = 0;                   // the runId of a run still in progress, else 0
	}

	handle(m) {
		if (!m || typeof m !== 'object') return;
		if (m.type === 'decoder') { if (!this.mainDecoder) this.mainDecoder = new MainThreadDecoder((x) => this.env.post(x)); return; }
		if (m.type === 'decoded') { if (this.mainDecoder) this.mainDecoder.answer(m); return; }
		if (m.type === 'run') return this.run(m);
		if (m.type === 'eye') return this.eye(m);
		if (m.type === 'areas') return this.sendAreas();
		if (m.type === 'estimate') return this.estimate(m);
		if (m.type === 'describe') return this.describe(m);
		if (m.type === 'save') return this.save(m);
		if (m.type === 'saveCancel') { if (this.saving && (!m.id || m.id === this.saving.id)) { this.saving.stopped = true; this.saving.ac.abort(); } return; }
		if (m.type === 'unsave') return this.unsave(m);
		if (m.type === 'cancel') {
			this.runId++; this.gen = m.gen;
			if (this.ac) { this.ac.abort(); this.ac = null; }
			this.fetcher.flush();
		}
	}

	post(msg, transfer) { this.env.post(msg, transfer || []); }
	error(code, message, fatal, extra) { this.post({ type: 'error', gen: this.gen, code, message: String(message), fatal, ...extra }); }

	// ---- Decoding ----------------------------------------------------------------------------------
	ensureDecoder() {
		if (!this.decoderP) this.decoderP = (async () => {
			if (this.env.decodeOverride) return { mode: 'override', webp: true };
			if (typeof OffscreenCanvas === 'function' && typeof createImageBitmap === 'function') {
				try { if (canaryOk(await decodeBitmap(canaryBlob()))) return { mode: 'offscreen', webp: true }; } catch (e) { /* below */ }
				return { mode: 'png', webp: false, why: 'decode canary failed' };
			}
			if (this.mainDecoder) {
				try { if (canaryOk(await this.mainDecoder.decode(canaryBlob(), 4000))) return { mode: 'main', webp: true }; } catch (e) { /* below */ }
				return { mode: 'png', webp: false, why: 'main-thread decode canary failed' };
			}
			return { mode: 'png', webp: false, why: 'no OffscreenCanvas and no main-thread decoder' };
		})();
		return this.decoderP;
	}
	// → { w, h, heights }: Float32 metres, or Int16 whole metres when int16 (Mapterhorn z ≤ 12, which
	// is stored that way anyway; AWS stays Float32 for despike).
	async decodeTile(blob, src, url, int16 = false) {
		const dec = await this.ensureDecoder();
		if (this.env.decodeOverride) { const r = await this.env.decodeOverride(url, blob, src); if (r) return r; }
		if (src.png) return dec.mode === 'offscreen' ? decodeBitmap(blob) : decodePNG(await blob.arrayBuffer());
		if (dec.mode === 'offscreen') return decodeBitmap(blob, { int16 });
		if (dec.mode === 'main') return this.mainDecoder.decode(blob);
		throw new Error('no WebP decoder');
	}

	// ---- Tiles ---------------------------------------------------------------------------------------
	// rc, the run's context: { id, signal, st (counters), source, facing, mtKept, mtDown }.
	// Fetch + decode one tile of `src` at its own zoom → { status, heights|null, bytes }. onFetched
	// runs once the bytes are in (the download can then be shared even if this run is cancelled).
	async fetchTile(src, z, x, y, rc, onFetched) {
		const st = rc.st, url = D.tileUrl(src, z, x, y);
		const t0 = now();
		const res = await this.fetcher.get(url, rc.signal);
		if (onFetched) onFetched();
		st.fetchMs += now() - t0;
		if (res.cached) st.cached++; else st.net += res.bytes;
		st.bytes += res.bytes;
		if (res.status === 404) return { status: 404, heights: null, bytes: res.bytes };
		const t1 = now();
		const r = await this.decodeTile(res.blob, src, url, !src.png && z <= 12);
		st.decodeMs += now() - t1;
		if (r.w !== src.size || r.h !== src.size) throw new Error(`tile ${z}/${x}/${y}: ${r.w}×${r.h}`);
		return { status: 200, heights: r.heights, bytes: res.bytes };
	}
	// One slot of a ring (zoom zM in Mapterhorn units), into the store. Mapterhorn failures fall back
	// to AWS (in 'auto'): its four 256 px children at z + 1 stitched into one 512 px tile. A failure
	// thrown here carries `tried` ('mapterhorn', 'aws' or 'both'), for the error message.
	loadSlot(srcId, zM, x, y, rc) {
		const st = rc.st, signal = rc.signal;
		const src = D.SOURCES[srcId], z = srcId === 'aws' ? zM + 1 : zM;
		const key = D.tileKey(srcId, z, x, y);
		const held = this.store.get(key);
		if (held) {
			// a Mapterhorn tile reused from an earlier run counts as an answer (so a re-run whose tiles
			// are all held still falls back to AWS per tile)
			if (held.src === 'mapterhorn' && held.status !== 'none') st.mtHeld++;
			return Promise.resolve(held);
		}
		const inf = this.inflight.get(key);
		if (inf && !inf.signal.aborted) return inf.p;
		// A cancelled run's download that has already arrived is taken over; its job stores the tile
		// only if the last prune's plan wants it, so the run taking it over stores it itself.
		if (inf && inf.fetched) return inf.p.then((e) => { if (!signal.aborted && !this.store.has(key)) this.store.set(key, e); return e; });
		const job = { signal, fetched: false, p: null };
		const got = () => { job.fetched = true; };
		const tag = (err, tried, more) => Object.assign(err instanceof Error ? err : new Error(String(err)), { tried }, more);
		job.p = (async () => {
			let e;
			if (srcId === 'aws') {
				let r;
				try { r = await this.fetchTile(src, z, x, y, rc, got); } catch (err) { throw signal.aborted ? err : tag(err, rc.mtDown ? 'both' : 'aws'); }
				if (r.status === 404) e = { status: 'none', data: null, src: 'aws' };
				else { D.despike(r.heights, src.size, D.mppAt(z, D.vToLat((y + 0.5) / 2 ** z), src.size)); e = { status: 'ok', data: D.toStorage(r.heights, zM), src: 'aws' }; }
			} else {
				try {
					const r = await this.fetchTile(src, z, x, y, rc, got);
					if (r.status === 404) e = z <= src.planetMaxZ ? { status: 'sea', data: D.seaTile(src.size), src: 'mapterhorn' } : { status: 'none', data: null, src: 'mapterhorn' };
					else e = { status: 'ok', data: D.toStorage(r.heights, zM), src: 'mapterhorn' };
					e.bytes = r.bytes;              // (what saving an area would download: estimate())
					st.mtOk++;
				} catch (err) {
					if (signal.aborted) throw err;
					st.mtFail++;
					if (rc.source !== 'auto') throw tag(err, 'mapterhorn');
					// Before the first batch has shown whether Mapterhorn answers at all, a failure is left
					// to run(), which either moves the whole plan to AWS (fewer requests than stitching every
					// tile) or asks for this slot again, per tile; after that, per tile straight away.
					if (!rc.mtKept) throw tag(err, 'mapterhorn', { noMtYet: true });
					try { e = { status: 'ok', data: D.toStorage(await this.stitchAws(z, x, y, rc), zM), src: 'aws' }; }
					catch (err2) { throw signal.aborted ? err2 : tag(err2, 'both'); }
				}
			}
			e.key = key; e.zM = zM;
			if (!signal.aborted || !this.keep || this.keep.has(key)) this.store.set(key, e);
			return e;
		})();
		this.inflight.set(key, job);
		const done = () => { if (this.inflight.get(key) === job) this.inflight.delete(key); };
		job.p.then(done, done);
		return job.p;
	}
	async stitchAws(zM, x, y, rc) {
		const src = D.SOURCES.aws, z = zM + 1, out = new Float32Array(512 * 512);
		await Promise.all([0, 1, 2, 3].map(async (q) => {
			const dx = q & 1, dy = q >> 1;
			const r = await this.fetchTile(src, z, 2 * x + dx, 2 * y + dy, rc);
			if (r.status === 404) throw new Error('AWS tile missing');
			for (let row = 0; row < 256; row++) out.set(r.heights.subarray(row * 256, row * 256 + 256), (dy * 256 + row) * 512 + dx * 256);
		}));
		D.despike(out, 512, D.mppAt(zM, D.vToLat((y + 0.5) / 2 ** zM), 512));
		rc.st.aws++;
		return out;
	}
	// Load every tile of these rings (in the order given, the facing sector first within a ring).
	// → the failures, [{ key, R, t, err }]. A cancelled run's loops stop before their next tile.
	async loadRings(rings, rc, onTile) {
		const jobs = [], st = rc.st, facing = rc.facing;
		for (const R of rings) {
			const ts = R.tiles.slice();
			if (facing != null) ts.sort((a, b) => (a.dKm < 1 ? 0 : angDiff(a.az, facing)) - (b.dKm < 1 ? 0 : angDiff(b.az, facing)) || a.dKm - b.dKm);
			for (const t of ts) jobs.push({ R, t });
		}
		let i = 0;
		const fail = [];
		const worker = async () => {
			while (i < jobs.length) {
				if (rc.signal.aborted) return;
				const { R, t } = jobs[i++];
				const key = D.tileKey(R.src, R.z, t.x, t.y);
				if (st.failed.has(key)) continue;        // already failed in this run
				try { await this.loadSlot(R.src, R.zM, t.x, t.y, rc); }
				catch (err) {
					if (rc.signal.aborted) return;      // cancelled: run() sees it's stale
					st.failed.add(key); fail.push({ key, R, t, err });
				}
				onTile && onTile(key);
			}
		};
		await Promise.all(Array.from({ length: CONCURRENCY }, worker));
		return fail;
	}
	// The 404 rule at z ≥ 13: no regional archive here. Mostly missing → the ring becomes z12; a few
	// missing (an archive edge) → those slots are their z12 parents upsampled.
	async fixFineRing(rings, rc, lat, lon) {
		const R = rings[0];
		if (R.src !== 'mapterhorn' || R.zM < 13) return [];
		const none = R.tiles.filter((t) => { const e = this.store.get(D.tileKey(R.src, R.z, t.x, t.y)); return e && e.status === 'none'; });
		if (!none.length) return [];
		if (none.length * 2 > R.tiles.length) {
			const R12 = D.makeRing(lat, lon, 12, R.innerKm, R.outerKm, R.nominalKm, D.SOURCES.mapterhorn);
			rings[0] = R12;
			return this.loadRings([R12], rc);
		}
		await Promise.all(none.map(async (t) => {
			const parent = await this.loadSlot('mapterhorn', 12, t.x >> 1, t.y >> 1, rc).catch(() => null);
			if (!parent || !parent.data) return;
			const e = this.store.get(D.tileKey(R.src, R.z, t.x, t.y));
			if (!e) return;
			e.data = D.upsampleQuadrant(parent.data, 512, t.x & 1, t.y & 1); e.status = 'ok'; e.derived = true;
		}));
		return [];
	}

	// ---- Runs ----------------------------------------------------------------------------------------
	async run(m) {
		const id = ++this.runId;
		// One AbortController per run; a run sent without a cancel first still stops the last one.
		if (this.ac) this.ac.abort();
		const ac = this.ac = new AbortController();
		this.gen = m.gen;
		this.running = id; this.held = null;
		const lat = +m.lat, lon = +m.lon;
		const p = this.params = {
			lat, lon, agl: Math.max(0, +m.agl || 0), lite: !!m.lite,
			source: m.source === 'aws' || m.source === 'mapterhorn' ? m.source : 'auto',
			facing: Number.isFinite(+m.facing) && m.facing !== null && m.facing !== undefined ? ((+m.facing % 360) + 360) % 360 : null,
			summit: m.summit !== false,
		};
		const T0 = now();
		const st = { fetchMs: 0, decodeMs: 0, bytes: 0, net: 0, cached: 0, aws: 0, mtOk: 0, mtHeld: 0, mtFail: 0, total: 0, keys: new Set(), failed: new Set() };
		const rc = { id, signal: ac.signal, st, source: p.source, facing: p.facing, mtKept: false, mtDown: false };
		const ms = { fetch: 0, decode: 0, coarse: 0, full: 0, labels: 0, places: 0 };
		const wall = {};
		const stale = () => id !== this.runId;
		const fatal = (fails) => Object.assign(new Error(failText(fails, st.total)), { code: 'terrain', fatal: true });
		try {
			if (!(Math.abs(lat) <= 85 && Math.abs(lon) <= 180)) throw Object.assign(new Error('bad position'), { code: 'terrain', fatal: true });
			// (the saved areas' list read again, in case another tab saved or deleted one)
			const [dec] = await Promise.all([this.ensureDecoder(), this.saved.refresh()]);
			if (stale()) return;
			let srcId = p.source === 'aws' ? 'aws' : 'mapterhorn';
			if (srcId === 'mapterhorn' && !dec.webp) {
				if (p.source === 'mapterhorn') throw Object.assign(new Error(dec.why), { code: 'decode', fatal: true });
				srcId = 'aws';
			}
			// Range: fixed, or auto (150 km, 250 km when the z7 ring shows terrain above 1,500 m).
			const autoRange = m.rangeKm === 'auto' || m.rangeKm == null;
			let rangeKm = autoRange ? AUTO_KM : Math.max(10, Math.min(300, +m.rangeKm || AUTO_KM));
			// Inside a saved area, no finer than it holds, so without signal nothing unsaved is asked for
			// (an area bigger than 20 km keeps less detail close by: saved.js).
			const areaDetail = this.saved.detailAt(lat, lon);
			const areaLess = !!areaDetail && areaDetail !== 'full' && this.saved.areas.some((x) => (x.detail || 'full') === areaDetail && x.less !== false && contains(x, lat, lon));
			const detail = coarserDetail(p.lite ? 'lite' : 'full', areaDetail || 'full');
			const plan = () => D.planFor(lat, lon, rangeKm, detail, D.SOURCES[srcId]);
			let rings = plan();
			const progress = (key) => { st.keys.add(key); if (!stale()) this.post({ type: 'progress', gen: this.gen, stage: 'terrain', done: Math.min(st.keys.size, st.total), total: st.total, bytes: st.bytes }); };
			const tF = now();
			const fails = [];
			// The first batch is the outermost ring (z7 at the default range): the auto range is read
			// from it, and if Mapterhorn didn't answer a single tile of it, the whole run moves to AWS.
			const first = async () => {
				st.total = rings.reduce((s, R) => s + R.tiles.length, 0);
				const outer = rings[rings.length - 1];
				const f = await this.loadRings([outer], rc, progress);
				D.attachTiles([outer], this.store);
				return f;
			};
			let f1 = await first();
			if (stale()) return;
			if (srcId === 'mapterhorn' && p.source === 'auto' && !st.mtOk && !st.mtHeld && st.mtFail) {
				srcId = 'aws'; rc.mtDown = true; rings = plan(); st.keys.clear();
				f1 = await first();
				if (stale()) return;
			} else if (srcId === 'mapterhorn') {
				// Mapterhorn answers. Tiles of the first batch that failed before it had (a reset or a 5xx
				// that came back first) are asked for again, now with the per-tile AWS fallback.
				rc.mtKept = true;
				const early = f1.filter((f) => f.err && f.err.noMtYet);
				if (early.length) {
					for (const f of early) st.failed.delete(f.key);
					f1 = f1.filter((f) => !(f.err && f.err.noMtYet));
					const outer = rings[rings.length - 1];
					f1.push(...await this.loadRings([{ src: outer.src, z: outer.z, zM: outer.zM, tiles: early.map((f) => f.t) }], rc, progress));
					if (stale()) return;
					D.attachTiles([outer], this.store);
				}
			}
			// Nothing of the outermost ring loaded from either source: the finer rings won't either, so
			// say so now rather than after asking for every one of them.
			if (f1.length && f1.length >= rings[rings.length - 1].tiles.length) throw fatal(f1);
			fails.push(...f1);
			if (autoRange && maxWithin(rings[rings.length - 1], lat, lon, ALPS_KM) > ALPS_TRIGGER_M) { rangeKm = ALPS_KM; rings = plan(); }
			p.rangeKm = rangeKm;
			st.total = rings.reduce((s, R) => s + R.tiles.length, 0);
			this.prune(rings);
			// Coarse rings first, then the finer ones.
			const coarse = rings.filter((R) => R.coarse), fine = rings.filter((R) => !R.coarse);
			fails.push(...await this.loadRings(coarse.slice().reverse(), rc, progress));
			if (stale()) return;
			if (fails.length * 5 > st.total) throw fatal(fails);
			if (coarse.length) {
				D.attachTiles(coarse, this.store);
				// Missing coarse tiles would draw as flat sea: no rough skyline unless most of them are in.
				if (share(coarse, this.store) >= COARSE_MIN_SHARE) {
					const t1 = now();
					const obs = this.observer(coarse);
					const pano = computePanorama(coarse, obs, { step: 0.5, profile: false, stepMin: coarse[0].mpp * 0.5, nearM: Math.max(300, 3 * coarse[0].mpp), nearAllow: Math.max(6, 0.2 * coarse[0].mpp) });
					const ridges = linkRidges(pano);
					ms.coarse = now() - t1;
					this.postPano('coarse', pano, ridges, obs, rangeKm, this.sourceOf(coarse));
					wall.coarse = now() - T0;
				}
			}
			// Places (same origin, small) now: they're needed only once all the terrain is in, so they
			// share the line with the finer rings rather than delaying the first skyline.
			const placesP = this.startPlaces(rc, lat, lon, rangeKm, ms);
			fails.push(...await this.loadRings(fine.slice().reverse(), rc, progress));
			if (stale()) return;
			fails.push(...await this.fixFineRing(rings, rc, lat, lon));
			if (stale()) return;
			ms.fetch = now() - tF - ms.coarse; ms.decode = st.decodeMs;
			if (fails.length) {
				if (fails.length * 5 > st.total) throw fatal(fails);
				this.error('terrain', failText(fails, st.total), false);
			}
			D.attachTiles(rings, this.store);
			const src = this.sourceOf(rings);
			// Places normally arrive well before the finer terrain. If not, they mustn't hold up the view:
			// after a short wait the full panorama goes out without the summit lift, and is redone (lifted)
			// when the names arrive.
			let pl = await settleWithin(placesP, this.env.placesGraceMs ?? PLACES_GRACE_MS);
			if (stale()) return;
			let early = false;
			if (pl === PENDING) {
				early = true;
				this.held = { rings, places: null, snaps: null, summit: null, rangeKm, src };
				this.computeFull(ms, now(), wall, T0);
				pl = await placesP;
				if (stale()) return;
			}
			const places = pl.places;
			const t2 = now();
			let snaps = null, lifted = 0, summit = null;
			if (places) {
				snaps = snapPeaks(places.records, rings, lat, lon, rangeKm);
				lifted = D.liftSummits(rings, liftPeaks(places.records, lat, lon, rangeKm, snaps));
				summit = summitNear(places.records, snaps, lat, lon);
			}
			this.held = { rings, places, snaps, summit, rangeKm, src };
			// (the early panorama is reused only if nothing was lifted and the eye hasn't moved since)
			const o = this.observer(rings);
			const same = early && !lifted && this.lastObs && this.lastObs.h0 === o.h0 && this.lastObs.lat === o.lat && this.lastObs.lon === o.lon;
			const full = same ? { pano: this.lastPano, obs: this.lastObs } : this.computeFull(ms, t2, wall, T0);
			if (pl.err) this.error('places', pl.err.message || pl.err, false);
			else if (places && places.failed.length) {
				this.error('places', `${places.failed.length} of ${places.total} place-name tiles didn’t load (${places.failed.slice(0, 3).join(', ')}${places.failed.length > 3 ? '…' : ''}); the names from the rest are shown`, false,
					{ partial: true, missing: places.failed.length, total: places.total });
			}
			if (places) this.labels(full, ms, wall, T0); else this.post({ type: 'labels', gen: this.gen, items: [] });
			this.post({ type: 'stats', gen: this.gen, ms: roundAll(ms), wall: roundAll(wall), tiles: st.total, bytes: st.bytes, net: st.net, cached: st.cached,
				awsTiles: st.aws, lifted, source: this.held.src, rangeKm, decoder: dec.mode, failed: fails.length, detail, areaDetail, areaLess,
				rings: rings.map((R) => ({ z: R.z, src: R.src, km: R.outerKm, mpp: Math.round(R.mpp * 10) / 10, tiles: R.tiles.length })),
				places: places ? { tiles: places.tiles, bytes: places.bytes, records: places.records.length, failed: places.failed.length } : null,
				labels: this.lastLabelStats || null, memMB: this.memMB() });
			this.releaseProfile();
		} catch (err) {
			if (stale()) return;
			this.error(err.code || 'terrain', err.message || err, err.fatal !== false);
		} finally {
			if (this.running === id) this.running = 0;
			// Anything of this run still going (the places requests after a fatal error) stops here.
			ac.abort();
			if (this.ac === ac) this.ac = null;
			this.fetcher.flush();
		}
	}
	// The places tiles for this run → Promise<{ places, err }> (never rejects).
	startPlaces(rc, lat, lon, rangeKm, ms) {
		if (!this.env.placesBase) return Promise.resolve({ places: null, err: null });
		const tP = now();
		return loadPlaces({ base: this.env.placesBase, lat, lon, rangeKm, fetch: this.placesFetch, signal: rc.signal, deadline: this.deadlines.places,
			onProgress: (done, total, bytes) => { if (rc.id === this.runId) this.post({ type: 'progress', gen: this.gen, stage: 'places', done, total, bytes }); } })
			.then((places) => { ms.places = now() - tP; return { places, err: null }; }, (err) => ({ places: null, err }));
	}
	// Height above ground, or the summit setting, changed: recompute from the held DEM (no fetching).
	eye(m) {
		this.gen = m.gen;
		if (this.params) {
			this.params.agl = Math.max(0, +m.agl || 0);
			if (typeof m.summit === 'boolean') this.params.summit = m.summit;
		}
		if (this.running || !this.held) return;   // a run in progress picks the new height up itself
		const ms = { fetch: 0, decode: 0, coarse: 0, full: 0, labels: 0, places: 0 }, wall = {}, T0 = now();
		const full = this.computeFull(ms, now(), wall, T0);
		if (this.held.places) this.labels(full, ms, wall, T0); else this.post({ type: 'labels', gen: this.gen, items: [] });
		this.post({ type: 'stats', gen: this.gen, ms: roundAll(ms), wall: roundAll(wall), tiles: 0, bytes: 0, net: 0, cached: 0, source: this.held.src, rangeKm: this.held.rangeKm, memMB: this.memMB() });
		this.releaseProfile();
	}

	// ---- Saved areas (saved.js) ------------------------------------------------------------------------
	async sendAreas() {
		const m = await this.saved.read();
		this.post({ type: 'areas', areas: m.areas.map(summary), saving: this.saving ? this.saving.id : null });
	}
	areaPlaceUrls(a) {
		if (!this.env.placesBase) return Promise.resolve([]);
		return placeTileUrls({ base: this.env.placesBase, lat: a.lat, lon: a.lon, rangeKm: Math.max(...a.ranges) + reachKm(a), fetch: this.placesFetch, deadline: this.deadlines.places });
	}
	// What an area is, for the page to say when a link offers to save one: the towns inside it, from
	// the place names (never from the link). The 1° tiles it touches, at most 16, nearest its centre
	// first. → {type:'described', key, near: {name, km} | null, towns: [name], cc}
	async describe(m) {
		// (always an answer: the page then words the area by its coordinates)
		try { await this.describeArea(m); } catch (e) { this.post({ type: 'described', key: m.key, near: null, towns: [], cc: null }); }
	}
	async describeArea(m) {
		const a = areaSpec(m), key = m.key;
		if (!a || !this.env.placesBase) return this.post({ type: 'described', key, near: null, towns: [], cc: null });
		// (the town a small circle is named by can be outside it: 25 km round at least)
		const look = Math.max(reachKm(a), 25);
		let urls = [];
		try { urls = await placeTileUrls({ base: this.env.placesBase, lat: a.lat, lon: a.lon, rangeKm: look, fetch: this.placesFetch, deadline: this.deadlines.places }); } catch (e) { /* none */ }
		const cellOf = (u) => u.match(/(-?\d+)\/(-?\d+)\.json$/).slice(1).map(Number);
		urls = urls.map((u) => { const [la, lo] = cellOf(u); return { u, d: D.haversine(a.lat, a.lon, la + 0.5, lo + 0.5) }; }).sort((x, y) => x.d - y.d).slice(0, 16).map((x) => x.u);
		const towns = [];
		// (each tile has the places deadline, so one that stalls can't hold the answer back)
		await Promise.all(urls.map(async (u) => {
			try {
				const r = await D.fetchWithDeadline(this.placesFetch, u, this.deadlines.places);
				if (!r.ok) return;
				const j = JSON.parse(await r.blob.text());
				for (const f of (j && j.f) || []) {
					const [, name, en, la, lo, code, pop, , wl, , cc] = f;
					// (Most Australian towns are PPLX in GeoNames; a city's districts carry no population here:
				// build-places.mjs DISTRICT_PARENT_POP.)
				if (!/^PPL/.test(code) || !(pop >= 50 || wl >= 5)) continue;
					const lat = la / 1e4, lon = lo / 1e4, km = D.haversine(a.lat, a.lon, lat, lon) / 1000;
					if (km <= look) towns.push({ name: en || name, lat, lon, pop: pop || 0, wl: wl || 0, cc, km, inside: contains(a, lat, lon) });
				}
			} catch (e) { /* a tile that didn't load: the rest */ }
		}));
		const big = towns.filter((t) => t.inside).sort((x, y) => y.pop - x.pop || y.wl - x.wl);
		// The town to name a circle by: the best known (people and Wikipedia languages: Interlaken, not
		// Unterseen) within a tenth of its radius (at least 10 km) of the centre, else the nearest.
		const known = (t) => Math.log10(1 + t.pop) + Math.log10(1 + t.wl);
		const close = towns.filter((t) => t.km <= Math.max(10, (a.radiusKm || 0) / 10)).sort((x, y) => known(y) - known(x) || x.km - y.km);
		// (a box is named by the towns inside it; one with none, such as a national park, by the best-known
		// town round about, as a circle is)
		const anyInside = towns.some((t) => t.inside);
		const near = a.box && anyInside ? null : (close[0] || towns.slice().sort((x, y) => (a.box ? known(y) - known(x) : 0) || x.km - y.km)[0] || null);
		// Up to three more, biggest first, each well apart from those already named (so not a big town's
		// own suburbs: "Port Pirie, Port Pirie South, Risdon Park").
		const apart = Math.max(8, reachKm(a) / 12), picked = near ? [near] : [];
		for (const t of big) {
			if (picked.length >= (near ? 4 : 3)) break;
			if (picked.every((p) => p.name !== t.name && D.haversine(p.lat, p.lon, t.lat, t.lon) / 1000 >= apart)) picked.push(t);
		}
		const ccs = new Map();
		for (const t of (big.length ? big : towns).slice(0, 20)) ccs.set(t.cc, (ccs.get(t.cc) || 0) + 1);
		const cc = [...ccs.entries()].sort((x, y) => y[1] - x[1])[0];
		// Which way the centre is from the town it is named by (when it isn't at the town).
		const dir = near && near.km >= 3 ? D.bearing(near.lat, near.lon, a.lat, a.lon) : null;
		this.post({ type: 'described', key, near: near ? { name: near.name, km: Math.round(near.km), dir } : null, towns: picked.filter((t) => t !== near).map((t) => t.name), cc: cc ? cc[0] : null });
	}
	// Does the finest layer (z13, from regional surveys only, such as SE Queensland's LiDAR) exist in this
	// area? A 'lite' area loses detail close by only where it does: elsewhere an ordinary view falls back
	// to z12 too (the 404 rule), so the Flinders Ranges lose nothing. Asked with HEAD requests (nothing
	// downloaded; Mapterhorn answers them with CORS) at the z13 tiles under up to 25 points spread over
	// the area, a held tile answering for itself. Any answer but a 404 counts as yes, and so does no
	// answer: better to say "less detail" than not. Answers are remembered for the session.
	async fineDataIn(a) {
		const pts = [];
		if (a.box) {
			const [s, w, n, e] = a.box;
			for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) pts.push([s + (n - s) * (i + 0.5) / 5, w + (e - w) * (j + 0.5) / 5]);
		} else {
			pts.push([a.lat, a.lon]);
			for (const [f, k] of [[0.4, 8], [0.8, 16]]) for (let i = 0; i < k; i++) pts.push(D.destination(a.lat, a.lon, i * 360 / k + 10, a.radiusKm * 1000 * f));
		}
		const N = 2 ** 13, src = D.SOURCES.mapterhorn, tiles = new Map();
		for (const [la, lo] of pts) {
			const x = ((Math.floor(D.lonToU(lo) * N) % N) + N) % N, y = Math.floor(D.latToV(la) * N);
			tiles.set(D.tileUrl(src, 13, x, y), D.tileKey('mapterhorn', 13, x, y));
		}
		const ask = async ([url, key]) => {
			if (this.fineSeen.has(url)) return this.fineSeen.get(url);
			const held = this.store.get(key);
			let yes;
			if (held && held.src === 'mapterhorn') yes = held.status === 'ok';
			else {
				try { yes = (await D.fetchWithDeadline(this.env.fetch, url, { headMs: 5000, maxMs: 6000, init: { ...TILE_INIT, method: 'HEAD' } })).status !== 404; }
				catch (e) { return true; } // (not remembered: it may answer next time)
			}
			this.fineSeen.set(url, yes);
			return yes;
		};
		const list = [...tiles.entries()];
		let found = false, i = 0, timer = null;
		const all = Promise.all(Array.from({ length: Math.min(6, list.length) }, async () => {
			while (!found && i < list.length) if (await ask(list[i++])) found = true;
		}));
		// (10 s at most in all, so the estimate isn't held up: unsure, it says "less detail")
		await Promise.race([all, new Promise((ok) => { timer = setTimeout(() => { found = true; ok(); }, 10000); })]);
		clearTimeout(timer);
		return found;
	}
	// Whether an area keeps less detail close by than a view there online would have.
	async lessDetail(a, detail, source = 'mapterhorn') {
		if (detail === 'basic') return true;
		// (AWS's first ring is always the lighter one's: its z14 is resampled 30 m data)
		return detail === 'lite' && source !== 'aws' ? this.fineDataIn(a) : false;
	}
	// What saving an area here would download: each tile at what the view on screen paid for it, or
	// the average for its zoom in that view (else the view's average, else EST_TILE); a tile already
	// saved costs nothing. Place-name tiles at the view's average.
	async estimate(m) {
		const a = areaSpec(m);
		if (!a) return;
		const [dec] = await Promise.all([this.ensureDecoder(), this.saved.refresh()]);
		const source = saveSource(dec);
		const { tiles, detail, tooBig } = planArea(a.lat, a.lon, { ...a, source });
		let places = [];
		try { places = await this.areaPlaceUrls(a); } catch (e) { /* no index to be had: the terrain alone */ }
		const perZ = new Map();
		let sum = 0, n = 0;
		for (const e of this.store.values()) {
			if (e.src !== source || !(e.bytes >= 0) || !e.key) continue;
			const z = +e.key.split('/')[1], s = perZ.get(z) || [0, 0];
			s[0] += e.bytes; s[1]++; perZ.set(z, s); sum += e.bytes; n++;
		}
		const avg = (z) => { const s = perZ.get(z); return s ? s[0] / s[1] : n ? sum / n : EST_TILE; };
		let bytes = 0, have = 0;
		for (const t of tiles) {
			if (this.saved.urls.has(t.url)) { have++; continue; }
			const e = this.store.get(D.tileKey(source, t.z, t.x, t.y));
			bytes += e && e.bytes >= 0 ? e.bytes : avg(t.z) / (source === 'aws' ? 4 : 1);
		}
		const pl = this.held && this.held.places, perPlace = pl && pl.tiles ? pl.bytes / pl.tiles : EST_PLACES;
		for (const u of places) if (!this.saved.urls.has(u)) bytes += perPlace;
		const less = tooBig ? true : await this.lessDetail(a, detail, source);
		this.post({ type: 'estimate', key: m.key, tiles: tiles.length, places: places.length, bytes: Math.round(bytes), have, detail, less, tooBig });
	}
	// Save an area, or finish an unfinished one (the same id again). Each response is taken from this
	// store if it's already there (another area, or an earlier try), else from the terrain cache, else
	// downloaded. A new area that is stopped, runs out of room or can't be downloaded at all is
	// forgotten with everything it brought; one with only some pieces missing is kept, unfinished.
	async save(m) {
		const id = typeof m.id === 'string' && /^[\w-]{1,40}$/.test(m.id) ? m.id : null;
		const a = areaSpec(m);
		const answer = (x) => this.post({ type: 'saved', id, ...x });
		if (!id || !a) return answer({ ok: false, message: 'Nothing to save.' });
		if (this.saving) return answer({ ok: false, message: 'Another area is still being saved.' });
		const job = this.saving = { id, ac: new AbortController(), stopped: false, deleted: false };
		const signal = job.ac.signal, store = this.saved;
		let area = null, isNew = true, urls = new Set(), bytes = 0, missing = 0, done = 0, total = 0;
		// (shared, for as long as this save runs: no tab sweeps meanwhile; saved.js)
		const release = await store.holdBusy();
		try {
			if (!(await store.cache())) throw sayable('This browser isn’t letting the page keep anything (a private window?).');
			const mf0 = await store.read(), before = mf0.areas.find((x) => x.id === id);
			// The tiles the viewer here draws from: AWS's where WebP can't be decoded (else it would be
			// listed as saved and fail offline). An unfinished area is finished from the source it started with.
			const source = before ? before.source : saveSource(await this.ensureDecoder());
			isNew = !before;
			if (isNew && mf0.areas.length >= MAX_AREAS) throw sayable(`There are already ${MAX_AREAS} saved areas: delete one first.`);
			// (an unfinished area is finished at the detail it was started with)
			const pa = before ? { detail: before.detail, tiles: areaTiles(a.lat, a.lon, { ...a, detail: before.detail, source }), tooBig: false } : planArea(a.lat, a.lon, { ...a, source });
			if (pa.tooBig) throw sayable('This area is too big to save in one go: choose a smaller one.');
			const tiles = pa.tiles;
			const less = before && typeof before.less === 'boolean' ? before.less : await this.lessDetail(a, pa.detail, source);
			let places;
			try { places = await this.areaPlaceUrls(a); } catch (e) { throw sayable('The place names couldn’t be reached. Check the connection, then try again.'); }
			const index = this.env.placesBase ? [new URL('index.json', this.env.placesBase).href] : [];
			urls = new Set([...(before ? before.urls : []), ...tiles.map((t) => t.url), ...places, ...index]);
			area = { id, name: (before && before.name) || String(m.name || '').trim().slice(0, 60) || 'A saved area', lat: a.lat, lon: a.lon, radiusKm: a.radiusKm, box: a.box, detail: pa.detail, less, source, range: a.range,
				savedAt: Date.now(), status: 'saving', urls: [...urls], bytes: 0, missing: 0 };
			// Listed before the first download, so a page closed half way leaves an unfinished area (to
			// finish or delete), never tiles that nothing lists.
			await store.update((mf) => { mf.areas = mf.areas.filter((x) => x.id !== id).concat(area); });
			total = tiles.length + places.length + index.length;
			const tick = () => this.post({ type: 'saveProgress', id, done, total, bytes });
			tick();
			const c = await store.cache();
			const keep = async (url, { deadline, init, peek = false, allow404 = false }) => {
				const had = await c.match(url).catch(() => null);
				if (had && (had.ok || allow404)) return { status: had.status, bytes: +had.headers.get('x-xray-bytes') || 0 };
				let r = peek ? await this.fetcher.peek(url) : null;
				if (!r) r = await D.fetchWithDeadline(this.env.fetch, url, { signal, ...deadline, init });
				if (!r.ok && !(allow404 && r.status === 404)) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
				if (signal.aborted) throw D.abortError();
				await c.put(url, new Response(r.blob, { status: r.status, headers: { 'content-type': r.type || 'application/octet-stream', 'x-xray-bytes': String(r.blob.size) } }));
				return { status: r.status, bytes: r.blob.size };
			};
			const fatal = (e) => signal.aborted || !!(e && (e.sayable || e.name === 'QuotaExceededError'));
			let mtOk = 0, mtFail = 0;
			const terrain = async (t) => {
				// (the size is added after the await: `bytes += await …` reads bytes first, and the four
				// downloads at a time would overwrite each other's totals)
				try { const r = await keep(t.url, { deadline: this.deadlines.tile, init: TILE_INIT, peek: true, allow404: true }); bytes += r.bytes; mtOk++; }
				catch (err) {
					if (fatal(err)) throw err;
					if (++mtFail >= SAVE_GIVE_UP && !mtOk) throw sayable('The elevation data isn’t answering just now. Try again later.');
					if (source === 'aws') { missing++; return; }
					// as the engine does online: the four AWS tiles below it, stitched in its place
					try {
						for (const u of awsChildren(t)) {
							urls.add(u);
							const r = await keep(u, { deadline: this.deadlines.tile, init: TILE_INIT, peek: true });
							bytes += r.bytes;
						}
					} catch (err2) { if (fatal(err2)) throw err2; missing++; }
				}
			};
			const place = async (u) => {
				try { const r = await keep(u, { deadline: this.deadlines.places, init: {} }); bytes += r.bytes; }
				catch (err) { if (fatal(err)) throw err; missing++; }
			};
			const jobs = [...tiles.map((t) => () => terrain(t)), ...[...places, ...index].map((u) => () => place(u))];
			let next = 0, failure = null;
			const runner = async () => {
				while (next < jobs.length && !failure && !signal.aborted) {
					const fn = jobs[next++];
					try { await fn(); } catch (e) { failure = failure || e; job.ac.abort(); return; }
					done++; tick();
				}
			};
			await Promise.all(Array.from({ length: Math.min(SAVE_CONCURRENCY, jobs.length) }, runner));
			if (failure) throw failure;
			if (signal.aborted) throw D.abortError();
			Object.assign(area, { urls: [...urls], bytes, missing, status: missing ? 'saving' : 'saved', savedAt: Date.now() });
			await store.update((mf) => { mf.areas = mf.areas.filter((x) => x.id !== id).concat(area); });
			answer({ ok: !missing, area: summary(area), missing, total, message: missing ? `${missing} of ${total} pieces didn’t download.` : '' });
		} catch (err) {
			const message = job.stopped ? 'Stopped.' : err && err.name === 'QuotaExceededError' ? 'There isn’t room on this phone for this area. Try a smaller one, or delete another saved area.'
				: err && err.sayable ? err.message : `It didn’t finish (${(err && err.message) || err}). Check the connection, then try again.`;
			try {
				if (area && !isNew && !job.deleted) {
					Object.assign(area, { urls: [...urls], bytes, missing: Math.max(1, total - done) });
					await store.update((mf) => { mf.areas = mf.areas.filter((x) => x.id !== id).concat(area); });
				} else if (area) {
					// (and the AWS stand-ins it found it needed, not listed yet: no sweep runs while it holds
					// the save lock, and once it lets go a sweep in another tab could find them first)
					await store.remove(id, [...urls]);
				}
			} catch (e) { /* storage refused: the next delete sweeps */ }
			answer({ ok: false, stopped: job.stopped, message });
		} finally {
			release();
			this.saving = null;
			await this.sendAreas();
		}
	}
	async unsave(m) {
		if (this.saving && this.saving.id === m.id) { this.saving.stopped = this.saving.deleted = true; this.saving.ac.abort(); return; } // save() tidies up
		try {
			await this.saved.remove(m.id);
			// A sweep would take a save in progress's AWS tiles, which it lists only at the end.
			if (!this.saving) await this.saved.sweep();
		} catch (e) { /* storage refused */ }
		await this.sendAreas();
	}
	// Peak memory held for the view (MB): the decoded tiles plus the full pano's running-max profile.
	memMB() {
		const seen = new Set();
		let b = 0;
		for (const e of this.store.values()) if (e.data && !seen.has(e.data)) { seen.add(e.data); b += e.data.byteLength; }
		if (this.lastPano && this.lastPano.profile) b += this.lastPano.profile.byteLength;
		return Math.round(b / 1e5) / 10;
	}
	// The profile (~7–10 MB) is only needed while the labels are built; a new height builds a new one.
	// Kept when env.keepCopies (Node tests and the fixture recorder read it afterwards).
	releaseProfile() { if (!this.env.keepCopies && this.lastPano) this.lastPano.profile = null; }
	// The eye: at the place, or on the top of a summit listed within 150 m of it, as drawn (summitNear),
	// when the setting is on. The ground is then the summit's: its official height where it was raised.
	observer(rings) {
		const { lat, lon, agl, summit } = this.params;
		const top = summit && this.held && this.held.summit;
		const at = top || { lat, lon };
		const r = D.finestAt(rings, at.lat, at.lon);
		const ground = r >= 0 ? D.sampleAt(rings, r, at.lat, at.lon) : 0;
		return { lat: at.lat, lon: at.lon, ground, h0: ground + EYE + agl, summit: top ? { name: top.name, dist: Math.round(top.dist) } : null };
	}
	computeFull(ms, t2, wall, T0) {
		const { rings, rangeKm, src } = this.held;
		const obs = this.observer(rings);
		const pano = computePanorama(rings, obs, { step: 0.2, profile: true });
		const ridges = linkRidges(pano);
		ms.full = now() - t2;
		this.lastPano = pano; this.lastObs = obs;
		this.postPano('full', pano, ridges, obs, rangeKm, src);
		wall.full = now() - T0;
		return { pano, obs };
	}
	labels({ pano, obs }, ms, wall, T0) {
		const t = now();
		const { items, stats } = buildLabels({ records: this.held.places.records, obs, rangeKm: this.held.rangeKm, rings: this.held.rings, pano, snaps: this.held.snaps });
		ms.labels = now() - t;
		this.lastLabelStats = stats; this.lastItems = items;
		this.post({ type: 'labels', gen: this.gen, items });
		wall.labels = now() - T0;
	}
	postPano(stage, pano, ridges, obs, rangeKm, source) {
		const msg = { type: 'pano', gen: this.gen, stage, step: pano.step, n: pano.n, alt: pano.alt, dist: pano.dist, sea: pano.sea,
			ground: Math.round(obs.ground * 10) / 10, eye: Math.round(obs.h0 * 10) / 10, summit: obs.summit, rangeKm, ridges, source };
		if (this.env.keepCopies) msg.alt = pano.alt.slice(), msg.dist = pano.dist.slice(), msg.sea = pano.sea.slice();
		this.post(msg, this.env.keepCopies ? [] : [pano.alt.buffer, pano.dist.buffer, pano.sea.buffer, ridges.pts.buffer, ridges.starts.buffer, ridges.dip.buffer, ridges.len.buffer, ridges.med.buffer]);
	}
	sourceOf(rings) {
		const seen = new Set();
		for (const R of rings) for (const t of R.tiles) {
			const e = this.store.get(D.tileKey(R.src, R.z, t.x, t.y)); if (e && e.data) seen.add(e.src);
		}
		return seen.size > 1 ? 'mixed' : seen.has('aws') ? 'aws' : 'mapterhorn';
	}
	// Keep only the tiles the current plan uses (plus the z12 parents of a z13 ring), to bound memory.
	prune(rings) {
		const keep = new Set();
		for (const R of rings) for (const t of R.tiles) {
			keep.add(D.tileKey(R.src, R.z, t.x, t.y));
			if (R.zM >= 13) keep.add(D.tileKey(R.src, 12, t.x >> 1, t.y >> 1));
		}
		for (const k of [...this.store.keys()]) if (!keep.has(k)) this.store.delete(k);
		this.keep = keep;
	}
}

// What failed, from what was actually tried: "3 of 39 terrain tiles failed on Mapterhorn and the
// AWS fallback: Failed to fetch".
function failText(fails, total) {
	const WHERE = { both: 'on Mapterhorn and the AWS fallback', mapterhorn: 'on Mapterhorn', aws: 'on AWS' };
	const kinds = [...new Set(fails.map((f) => (f.err && f.err.tried) || 'both'))];
	const first = fails[0] && fails[0].err;
	return `${fails.length} of ${total} terrain tiles failed ${kinds.length === 1 ? WHERE[kinds[0]] : 'on Mapterhorn and AWS'}: ${(first && first.message) || first}`;
}
// A save or estimate request's area: centre, radius, and the ranges a view there may use (an
// automatic range can be either; a smaller fixed range needs only part of a bigger one's tiles).
// A circle (lat, lon, radiusKm: 1–200 km) or a box (box: [s, w, n, e], saved.js cleanBox), as checked.
function areaSpec(m) {
	const auto = m.rangeKm === 'auto' || m.rangeKm == null, fixed = Math.max(10, Math.min(300, +m.rangeKm || AUTO_KM));
	const range = { range: auto ? 'auto' : fixed, ranges: auto ? [AUTO_KM, ALPS_KM] : [fixed] };
	if (m.box != null) {
		const box = cleanBox(Array.isArray(m.box) ? m.box.map(Number) : null);
		return box ? { lat: (box[0] + box[2]) / 2, lon: (box[1] + box[3]) / 2, radiusKm: null, box, ...range } : null;
	}
	const lat = +m.lat, lon = +m.lon, r = +m.radiusKm;
	if (!(Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 85 && Math.abs(lon) <= 180)) return null;
	const radiusKm = Number.isInteger(r) && r >= 1 && r <= MAX_RADIUS_KM ? r : DEFAULT_RADIUS;
	return { lat, lon, radiusKm, box: null, ...range };
}
const sayable = (message) => Object.assign(new Error(message), { sayable: true });
// Where a saved area's terrain comes from: as the viewer draws it (run(): AWS when WebP can't be decoded).
const saveSource = (dec) => (dec && dec.webp === false ? 'aws' : 'mapterhorn');
// Share of these rings' tiles that hold data.
function share(rings, store) {
	let n = 0, ok = 0;
	for (const R of rings) for (const t of R.tiles) { n++; const e = store.get(D.tileKey(R.src, R.z, t.x, t.y)); if (e && e.data) ok++; }
	return n ? ok / n : 0;
}
// p's value if it settles within ms, else PENDING.
function settleWithin(p, ms) {
	return new Promise((ok) => {
		const t = setTimeout(() => ok(PENDING), ms);
		p.then((v) => { clearTimeout(t); ok(v); }, () => { clearTimeout(t); ok({ places: null, err: new Error('places failed') }); });
	});
}
// Highest cell within kmMax of (lat, lon) in a ring's loaded tiles.
function maxWithin(R, lat, lon, kmMax) {
	let best = -Infinity;
	const cosl = Math.cos(lat * Math.PI / 180);
	for (const t of R.tiles) {
		const T = R.slots[(t.y - R.ty0) * R.nx + (t.ux - R.ux0)];
		if (!T) continue;
		for (let row = 0; row < R.size; row++) {
			const la = D.vToLat((t.y * R.size + row + 0.5) / R.S), dy = (la - lat) * 111.2;
			if (Math.abs(dy) > kmMax) continue;
			for (let col = 0; col < R.size; col++) {
				const h = T[row * R.size + col];
				if (h <= best) continue;
				const lo = D.uToLon((t.ux * R.size + col + 0.5) / R.S), dx = (lo - lon) * 111.2 * cosl;
				if (dx * dx + dy * dy <= kmMax * kmMax) best = h;
			}
		}
	}
	return best;
}
const angDiff = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
const roundAll = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v)]));
function now() { return (typeof performance !== 'undefined' ? performance : Date).now(); }

// In a worker: wire the engine to the message port. (Imported elsewhere, this does nothing.)
if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope) {
	// A `caches` getter that throws (some sandboxed or opaque contexts) must not stop the worker:
	// the view works without the Cache API.
	let cacheStorage = null;
	try { cacheStorage = self.caches || null; } catch (e) { /* no Cache API */ }
	const engine = new Engine({
		post: (msg, transfer) => self.postMessage(msg, transfer || []),
		fetch: (u, o) => fetch(u, o),
		caches: cacheStorage,
		placesBase: new URL('./data/places/v1/', import.meta.url).href,
	});
	self.addEventListener('message', (e) => engine.handle(e.data));
}
