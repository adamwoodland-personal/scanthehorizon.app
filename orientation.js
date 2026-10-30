// COPY of orrery.live/night-sky/orientation.js (2026-10-29) for Through the Earth: the two sites
// are separate origins, so it can't be imported from there. Keep the two in step.
//
// Phone orientation for the /night-sky/ AR view: turns DeviceOrientation readings into a
// three.js camera quaternion so whatever the back of the phone points at is in the middle
// of the screen, the right way up.
//
// No dependencies and no three.js import (quaternions are plain [x, y, z, w] arrays in
// three.js order), and nothing touches `window`/`screen` at import time, so the maths can be
// tested under Node.
//
// Frames (shared contract with the astronomy and renderer modules):
//   ENU      [east, north, up]; azimuth clockwise from north, altitude up, both in degrees.
//   scene    three.js: x = east, y = up, z = south (so -z = north); enuToScene([e,n,u]) = [e,u,-n].
//   camera   looks along its local -Z with local +Y up (three.js).
//   device   W3C DeviceOrientation: x = right edge of the screen, y = top edge (natural,
//            portrait), z = out of the screen towards the user. R = Rz(alpha)·Rx(beta)·Ry(gamma)
//            maps device coordinates to earth coordinates (x east, y north, z up).
//
// Neat coincidence that does most of the work: the three.js camera frame and the W3C device
// frame are the same shape. The back camera looks along device -z, the top edge is device +y,
// the right edge device +x. So with the screen in its natural orientation the camera's
// rotation into ENU *is* R, and only two fix-ups are needed: the screen-rotation angle (the
// picture's "up" is no longer the device's top edge in landscape) and the ENU→scene basis
// change.
//
// Both iOS's webkitCompassHeading and Android's absolute orientation are referenced to
// MAGNETIC north. The caller passes declination(...) (plus any manual nudge) as the heading
// offset to turn that into true north.

const DEG = Math.PI / 180;

const wrap360 = (d) => ((d % 360) + 360) % 360;
const wrap180 = (d) => { const w = wrap360(d); return w > 180 ? w - 360 : w; };

// ---- Quaternions ([x, y, z, w], Hamilton product, same as three.js) --------------------

// Rotation by `deg` about the unit axis (ax, ay, az), right-handed (counter-clockwise when
// the axis points at the viewer).
function qAxis(ax, ay, az, deg) {
	const h = deg * DEG / 2, s = Math.sin(h);
	return [ax * s, ay * s, az * s, Math.cos(h)];
}
// a ⊗ b: rotate by b first, then by a (three.js multiplyQuaternions(a, b)).
function qMul(a, b) {
	const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
	return [
		aw * bx + ax * bw + ay * bz - az * by,
		aw * by - ax * bz + ay * bw + az * bx,
		aw * bz + ax * by - ay * bx + az * bw,
		aw * bw - ax * bx - ay * by - az * bz,
	];
}
function qNorm(q) {
	const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
	return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}
const qDot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
// Angle (degrees) of the rotation taking a to b; q and -q are the same rotation.
const qAngle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(qDot(a, b)))) / DEG;
// Spherical interpolation, taking the short way round.
function qSlerp(a, b, t) {
	let d = qDot(a, b);
	if (d < 0) { b = [-b[0], -b[1], -b[2], -b[3]]; d = -d; }
	if (d > 0.99995) return qNorm(a.map((v, i) => v + (b[i] - v) * t));
	const th = Math.acos(d), s = Math.sin(th);
	const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
	return a.map((v, i) => v * wa + b[i] * wb);
}

// ENU → scene is a proper rotation: -90° about east (north tips down to -z, up comes to +y).
const Q_ENU_TO_SCENE = qAxis(1, 0, 0, -90);

// R = Rz(alpha)·Rx(beta)·Ry(gamma) as a quaternion: the device's attitude, device → ENU.
export function deviceToEnuQuat(alpha, beta, gamma) {
	return qNorm(qMul(qMul(qAxis(0, 0, 1, alpha), qAxis(1, 0, 0, beta)), qAxis(0, 1, 0, gamma)));
}

// The same R as a row-major 3×3 (R[row*3+col]). Its columns are the device's axes in ENU:
// x = (R0, R3, R6), y = (R1, R4, R7), z = (R2, R5, R8).
function rotMatrix(alpha, beta, gamma) {
	const a = alpha * DEG, b = beta * DEG, g = gamma * DEG;
	const cA = Math.cos(a), sA = Math.sin(a), cB = Math.cos(b), sB = Math.sin(b), cG = Math.cos(g), sG = Math.sin(g);
	return [
		cA * cG - sA * sB * sG, -sA * cB, cA * sG + sA * sB * cG,
		sA * cG + cA * sB * sG, cA * cB, sA * sG - cA * sB * cG,
		-cB * sG, sB, cB * cG,
	];
}

const finite = (...v) => v.every((x) => typeof x === 'number' && Number.isFinite(x));

// ---- Camera quaternion -------------------------------------------------------------------

// Camera quaternion in the SCENE frame for a camera looking out of the back of the phone,
// with "up" = the current top edge of the picture on screen.
//
// screenAngleDeg is the screen-orientation angle, positive COUNTER-clockwise: 90 means the
// phone has been turned a quarter-turn anticlockwise (top edge to the left, iPhone home
// button / gesture bar on the right) and the browser has rotated its content clockwise by 90°
// to stay upright. That is the Screen Orientation spec ("the angle ... the screen is rotated
// counter-clockwise from its natural orientation"; portrait-natural: landscape-primary = 90),
// Android's Display rotation, and window.orientation (whose -90 is our 270); see
// readScreenAngle() for which to read. So the picture's up/right axes are the device's y/x
// axes turned clockwise by s in the screen plane, which is Rz(-s) in device coordinates —
// applied first, on the right.
//
// headingOffsetDeg turns the whole view about the vertical so that a positive offset ADDS to
// every azimuth (magnetic → true: pass the declination, plus the user's nudge). A rotation
// about ENU up by +θ is counter-clockwise seen from above, which *decreases* azimuth, hence
// Rz(-offset), applied last, on the left.
//
//   q = q(ENU→scene) · Rz(-offset) · Rz(alpha)·Rx(beta)·Ry(gamma) · Rz(-screenAngle)
export function cameraQuatSky(alpha, beta, gamma, screenAngleDeg, headingOffsetDeg = 0) {
	const q = qMul(qMul(qMul(Q_ENU_TO_SCENE, qAxis(0, 0, 1, -headingOffsetDeg)),
		deviceToEnuQuat(alpha, beta, gamma)), qAxis(0, 0, 1, -(screenAngleDeg || 0)));
	return qNorm(q);
}

// ---- Facing heading ----------------------------------------------------------------------

// The compass heading (degrees clockwise from the alpha reference — north for an absolute
// reading) the user is facing. Same idea as whatsacross.com's absHeading(), which was checked
// on real phones: the user faces square to the screen's left-to-right axis, so it is right
// flat, upright and anywhere between, and tipping or rolling the phone does not swing it.
// Only when that axis is near vertical (phone on its side with the picture not rotated) does
// it fail; then the back-camera axis gives the direction instead. (Those two are orthonormal
// neighbours, so when one has < 0.3 of horizontal length the other has > 0.95: the fallback
// never fails.) Returns null for missing readings.
export function facingHeading(alpha, beta, gamma, screenAngleDeg = 0) {
	if (!finite(alpha, beta, gamma)) return null;
	const R = rotMatrix(alpha, beta, gamma), s = (screenAngleDeg || 0) * DEG;
	// Screen right = device x turned clockwise by the screen angle (east/north parts only).
	const rE = Math.cos(s) * R[0] - Math.sin(s) * R[1], rN = Math.cos(s) * R[3] - Math.sin(s) * R[4];
	// Facing = up × right, i.e. right turned 90° anticlockwise seen from above.
	let east = -rN, north = rE;
	if (Math.hypot(east, north) < 0.3) { east = -R[2]; north = -R[5]; } // back camera (-z)
	return wrap360(Math.atan2(east, north) / DEG);
}

// ---- Screen angle ------------------------------------------------------------------------

// The screen-orientation angle in degrees (0, 90, 180, 270; counter-clockwise, as above).
// window.orientation is read first when it is a number: it is deprecated but still present
// on iOS and Android, and it was never wrong, whereas iOS 16.4–16.x shipped screen.orientation
// with the two landscape cases swapped (WebKit bug 255388, fixed for iOS 17). Chromium and
// Gecko derive window.orientation from the same angle (270 reported as -90), so the order
// costs nothing there; desktop browsers have no window.orientation and fall through.
export function readScreenAngle(win = (typeof window !== 'undefined' ? window : undefined)) {
	if (!win) return 0;
	const wo = win.orientation;
	if (typeof wo === 'number' && Number.isFinite(wo)) return wrap360(Math.round(wo / 90) * 90);
	const so = win.screen && win.screen.orientation;
	if (so && typeof so.angle === 'number' && Number.isFinite(so.angle)) return wrap360(so.angle);
	return 0;
}

// ---- iOS heading calibration -------------------------------------------------------------

// iOS gives alpha from an arbitrary reference (CoreMotion's xArbitraryCorrectedZVertical)
// plus a separate magnetic heading, webkitCompassHeading. An unknown alpha offset is a
// rotation about the vertical — Rz(alpha + θ) = Rz(θ)·Rz(alpha) — so it shifts every
// heading worked out from the raw attitude by the same amount. Comparing iOS's heading with
// the heading of the same device axis in the raw attitude therefore gives the offset:
//
//   offset = webkitCompassHeading − heading_raw(axis)        (clockwise degrees)
//
// and the true attitude is the raw one turned clockwise by `offset`: true alpha = raw alpha
// − offset (alpha is counter-clockwise), or equivalently pass `offset` as an extra heading
// offset to cameraQuatSky.
//
// Which axis? webkitCompassHeading is CoreLocation's heading for the default portrait
// heading orientation: the direction of the device's top edge (y), tilt-compensated, falling
// back to the back of the device (-z) when the top edge points near straight up. That is
// also why whatsacross.com adds the screen angle to it. Apple does not document the blend
// between the two, nor what happens with the screen facing the ground (pointing the camera
// at the sky), where the top-edge projection points *behind* the user. So samples are only
// used where the convention is unambiguous:
//   - top edge within 30° of horizontal (|y·up| ≤ 0.5) and the screen not facing down:
//     heading of y's horizontal projection (phone flat, tilted, or upright in landscape);
//   - top edge within ~25° of straight up (y·up ≥ 0.9): heading of -z, the back camera
//     (phone upright in portrait);
// everything else is skipped. Neither depends on the screen angle: both sides of the
// comparison are in the device frame. Also skipped: samples taken while the phone turns
// faster than maxRate (the compass lags the gyro), an uncalibrated compass
// (webkitCompassAccuracy < 0) or a poor one (> maxAccuracy degrees), and — once ready —
// samples more than `outlier` degrees from the estimate (magnetic disturbance). A run of
// `resetAfter` rejected samples that agree with each other re-seeds the estimate, in case
// iOS re-zeroed alpha.
//
// The estimate is a circular mean of the per-sample offsets, weighted by 1/accuracy², with
// exponential forgetting over ~`memory` samples so it follows slow gyro drift (5 s at 60 Hz).
export class HeadingCalibrator {
	constructor(opts = {}) {
		this.minSamples = opts.minSamples ?? 15;
		this.maxAccuracy = opts.maxAccuracy ?? 25;
		this.maxRate = opts.maxRate ?? 60;     // degrees per second
		this.outlier = opts.outlier ?? 20;     // degrees
		this.resetAfter = opts.resetAfter ?? 45;
		this.memory = opts.memory ?? 300;      // samples
		this.reset();
	}

	reset() {
		this._sx = 0; this._sy = 0; this._w = 0;
		this._seed = [];
		this._rejects = [];
		this._prev = null;
		this._ready = false;
		this.accuracy = null;
		this.accepted = 0;
	}

	get ready() { return this._ready; }
	// Clockwise degrees in (-180, 180]: true heading = raw heading + offset.
	get offset() { return this._w > 0 ? wrap180(Math.atan2(this._sy, this._sx) / DEG) : 0; }

	// The heading iOS reports for this attitude, worked out from the raw (offset) attitude,
	// or null where the convention is unclear.
	static modelHeading(alpha, beta, gamma) {
		const R = rotMatrix(alpha, beta, gamma);
		const yUp = R[7], zUp = R[8];
		if (Math.abs(yUp) <= 0.5 && zUp >= -0.1) return wrap360(Math.atan2(R[1], R[4]) / DEG);
		if (yUp >= 0.9) return wrap360(Math.atan2(-R[2], -R[5]) / DEG);
		return null;
	}

	// Feed one reading. screenAngleDeg is accepted for symmetry with the other calls but not
	// needed (see above). tMs defaults to now. Returns true if the sample was used.
	ingest(alpha, beta, gamma, screenAngleDeg, compassHeading, compassAccuracy, tMs) {
		if (!finite(alpha, beta, gamma, compassHeading) || compassHeading < 0 || compassHeading > 360) return false;
		const t = finite(tMs) ? tMs : nowMs();
		// Turn rate since the previous reading (whether or not that one was used).
		const q = deviceToEnuQuat(alpha, beta, gamma), prev = this._prev;
		this._prev = { q, t };
		if (prev) {
			const dt = (t - prev.t) / 1000;
			if (dt > 0 && dt < 0.5 && qAngle(prev.q, q) / dt > this.maxRate) return false;
		}
		let acc = finite(compassAccuracy) ? compassAccuracy : null;
		if (acc !== null && (acc < 0 || acc > this.maxAccuracy)) return false;
		const model = HeadingCalibrator.modelHeading(alpha, beta, gamma);
		if (model === null) return false;
		const sample = wrap180(compassHeading - model);
		if (acc === null) acc = 15;
		const w = 1 / Math.max(acc, 5) ** 2;

		if (!this._ready) {
			// Seed: wait for minSamples, then keep those near their circular mean.
			this._seed.push({ d: sample, w, acc });
			if (this._seed.length > 3 * this.minSamples) this._seed.shift();
			if (this._seed.length < this.minSamples) return true;
			const m = circMean(this._seed);
			const near = this._seed.filter((s) => Math.abs(wrap180(s.d - m)) <= this.outlier / 2);
			if (near.length < 0.75 * this._seed.length) return true;
			this._start(near);
			return true;
		}
		if (Math.abs(wrap180(sample - this.offset)) > this.outlier) {
			this._rejects.push({ d: sample, w, acc });
			if (this._rejects.length >= this.resetAfter) {
				const m = circMean(this._rejects);
				if (this._rejects.every((s) => Math.abs(wrap180(s.d - m)) <= 5)) this._start(this._rejects);
				else this._rejects.shift();
			}
			return false;
		}
		this._rejects = [];
		const keep = 1 - 1 / this.memory;
		this._sx = this._sx * keep + w * Math.cos(sample * DEG);
		this._sy = this._sy * keep + w * Math.sin(sample * DEG);
		this._w = this._w * keep + w;
		this.accuracy = acc;
		this.accepted++;
		return true;
	}

	_start(samples) {
		this._sx = 0; this._sy = 0; this._w = 0;
		for (const s of samples) {
			this._sx += s.w * Math.cos(s.d * DEG);
			this._sy += s.w * Math.sin(s.d * DEG);
			this._w += s.w;
		}
		this.accuracy = samples[samples.length - 1].acc;
		this.accepted += samples.length;
		this._seed = []; this._rejects = [];
		this._ready = true;
	}
}

function circMean(samples) {
	let x = 0, y = 0;
	for (const s of samples) { x += s.w * Math.cos(s.d * DEG); y += s.w * Math.sin(s.d * DEG); }
	return Math.atan2(y, x) / DEG;
}

function nowMs() {
	return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

// ---- Live source (browser) ---------------------------------------------------------------

// Wraps the DeviceOrientation events. Lessons from whatsacross.com's compass (fixed and
// checked on Android Chrome 151 and iPhone, 2026-10-10):
//  - Chrome 151 added DeviceOrientationEvent.requestPermission on Android AND desktop (it
//    resolves per the Motion sensors site setting), so its presence no longer means iOS. Call
//    it wherever it exists, from a user gesture, and stop only on an explicit 'denied'.
//  - On Android the plain `deviceorientation` event is RELATIVE (alpha has no north); the
//    compass is `deviceorientationabsolute` (Chrome, Samsung Internet, Firefox 110+), or any
//    reading with absolute === true.
//  - iOS has no absolute event; its plain event carries webkitCompassHeading and an
//    arbitrary alpha, corrected here by HeadingCalibrator.
//
// status: 'idle' → start() → 'waiting' → 'ok', or 'denied' | 'unsupported' |
// 'relative-only' (only relative readings after 1.5 s; flips to 'ok' if an absolute one
// arrives later). On iOS it stays 'waiting', with `calibrating` true, until the calibrator is
// ready: that needs the phone flat, or upright facing the horizon, for a moment — pointing
// straight at the sky gives it nothing to use, so the page should ask for that pose.
//
// Options (all optional; for tests): window, now() in ms, setTimeout/clearTimeout,
// tau (smoothing time constant, ms), deadband (degrees), calibrator (a HeadingCalibrator).
export class OrientationSource {
	constructor(opts = {}) {
		this._win = opts.window !== undefined ? opts.window : (typeof window !== 'undefined' ? window : null);
		this._now = opts.now || nowMs;
		const w = this._win;
		this._setTimeout = opts.setTimeout || ((f, ms) => (w && w.setTimeout ? w.setTimeout(f, ms) : setTimeout(f, ms)));
		this._clearTimeout = opts.clearTimeout || ((id) => (w && w.clearTimeout ? w.clearTimeout(id) : clearTimeout(id)));
		this.tau = opts.tau ?? 80;
		this.deadband = opts.deadband ?? 0.3;
		this.calibrator = opts.calibrator || new HeadingCalibrator();
		this.status = 'idle';
		this.accuracy = null;      // latest iOS webkitCompassAccuracy in degrees (180 = uncalibrated); null elsewhere
		this.calibrating = false;  // iOS readings arriving, calibrator not ready yet
		this.onstatus = null;
		this._session = 0;          // bumped by start()/stop(): a stale start() resuming after its prompt bows out
		this._reset();
	}

	_reset() {
		this._events = [];
		this._listener = null;
		this._screenListener = null;
		this._timers = [];
		this._seen = { abs: false, ios: false, rel: false, nul: false };
		this._permError = false;
		this._raw = null;           // latest usable reading {alpha, beta, gamma}
		this._target = null;        // q(ENU→scene)·R for that reading
		this._smooth = null;
		this._lastT = 0;
		this._corr = 0;             // iOS heading correction (clockwise degrees)
		this._screen = readScreenAngle(this._win);
	}

	_set(status) {
		if (this.status === status) return;
		this.status = status;
		if (typeof this.onstatus === 'function') {
			try { this.onstatus(status); } catch (e) { /* the page's problem, not ours */ }
		}
	}

	// Must be called from a user gesture (iOS shows its permission prompt here). A no-op while
	// already 'waiting', 'ok' or 'relative-only'; after 'denied'/'unsupported' it starts afresh
	// (e.g. a "try again" button after the user changed the site setting).
	async start() {
		if (this.status === 'waiting' || this.status === 'ok' || this.status === 'relative-only') return this.status;
		this._detach();
		const w = this._win;
		if (!w || typeof w.addEventListener !== 'function' || !w.DeviceOrientationEvent) {
			this._set('unsupported');
			return this.status;
		}
		const session = ++this._session;
		this._reset();
		this.calibrator.reset(); // a new listening session may bring a new arbitrary iOS alpha zero
		this.calibrating = false;
		this.accuracy = null;
		this._set('waiting');
		const DOE = w.DeviceOrientationEvent;
		if (typeof DOE.requestPermission === 'function') {
			// `true` asks for the magnetometer too, which a compass needs (whatsacross).
			try {
				const state = await DOE.requestPermission(true);
				if (state === 'denied') { this._set('denied'); return this.status; }
			} catch (e) {
				// Usually "not from a user gesture" on iOS. Listen anyway; if nothing arrives
				// this ends as 'denied' rather than 'unsupported'.
				this._permError = true;
			}
			if (session !== this._session || this.status !== 'waiting') return this.status; // stop()/restart during the prompt
		}
		this._listener = (e) => this._onReading(e);
		this._events = ('ondeviceorientationabsolute' in w) ? ['deviceorientationabsolute', 'deviceorientation'] : ['deviceorientation'];
		for (const ev of this._events) w.addEventListener(ev, this._listener);
		this._screenListener = () => { this._screen = readScreenAngle(w); };
		const so = w.screen && w.screen.orientation;
		if (so && typeof so.addEventListener === 'function') so.addEventListener('change', this._screenListener);
		w.addEventListener('orientationchange', this._screenListener);
		this._screen = readScreenAngle(w);
		this._timers.push(this._setTimeout(() => this._check(false), 1500));
		this._timers.push(this._setTimeout(() => this._check(true), 3000));
		return this.status;
	}

	_check(final) {
		if (this.status !== 'waiting') return;
		if (this._seen.abs || this._seen.ios) return;      // 'ok', or iOS still calibrating
		if (this._seen.rel) this._set('relative-only');
		else if (this._seen.nul) this._set('unsupported'); // e.g. desktop Chrome: one all-null event
		else if (final) this._set(this._permError ? 'denied' : 'unsupported');
	}

	_onReading(e) {
		if (!e) return;
		const { alpha, beta, gamma } = e;
		if (!finite(alpha, beta, gamma)) { this._seen.nul = true; return; }
		const t = this._now();
		this._screen = readScreenAngle(this._win);
		if (e.absolute === true) {
			this._seen.abs = true;
			this._corr = 0;
			this.accuracy = null;
			this._use(alpha, beta, gamma);
			return;
		}
		if (this._seen.abs) return; // once a compass reading has been seen, relative ones only mislead
		const wch = e.webkitCompassHeading;
		if (typeof wch === 'number' && !Number.isNaN(wch)) {
			this._seen.ios = true;
			const cal = this.calibrator, acc = e.webkitCompassAccuracy;
			// The latest reported accuracy, so the page can ask for a figure of eight when it is
			// poor; iOS's -1 (uncalibrated) becomes 180, "could be anywhere".
			this.accuracy = finite(acc) ? (acc < 0 ? 180 : acc) : null;
			cal.ingest(alpha, beta, gamma, this._screen, wch, acc, t);
			if (!cal.ready) { this.calibrating = true; return; }
			this.calibrating = false;
			this._corr = cal.offset;
			this._use(alpha, beta, gamma);
			return;
		}
		this._seen.rel = true; // relative only: no north, unusable for a sky map
	}

	_use(alpha, beta, gamma) {
		this._raw = { alpha, beta, gamma };
		this._target = qMul(Q_ENU_TO_SCENE, deviceToEnuQuat(alpha, beta, gamma));
		this._set('ok');
	}

	// Smoothed camera quaternion [x, y, z, w] in the scene frame (see cameraQuatSky), or null
	// until a usable reading has arrived. Call once per rendered frame: the smoothing advances
	// with the time between calls. It is a slerp low-pass on the device attitude, time constant
	// `tau` (80 ms), shortened as the gap grows (tau / (1 + gap/3°)) so a quick swing does not
	// trail far behind; below `deadband` (0.3°) the step is scaled down by (gap/deadband)², a
	// soft dead-band that holds the sky still against sensor jitter without making slow pans
	// stick. The screen rotation and the heading offset (plus the iOS correction) are applied
	// after the smoothing, exactly, so a nudge or declination change shows at once.
	getCameraQuat(headingOffsetDeg = 0) {
		if (this.status !== 'ok' || !this._target) return null;
		const t = this._now();
		if (!this._smooth) this._smooth = this._target.slice();
		else {
			const dt = Math.min(Math.max(t - this._lastT, 0), 1000);
			const gap = qAngle(this._smooth, this._target);
			let k = 1 - Math.exp(-dt / (this.tau / (1 + gap / 3)));
			if (gap < this.deadband) k *= (gap / this.deadband) ** 2;
			this._smooth = qNorm(qSlerp(this._smooth, this._target, k));
		}
		this._lastT = t;
		const off = (headingOffsetDeg || 0) + this._corr;
		return qNorm(qMul(qMul(qAxis(0, 1, 0, -off), this._smooth), qAxis(0, 0, 1, -this._screen)));
	}

	// The heading the user faces (see facingHeading) with the same offsets applied, unsmoothed;
	// null until a usable reading has arrived.
	getFacingHeading(headingOffsetDeg = 0) {
		if (this.status !== 'ok' || !this._raw) return null;
		const { alpha, beta, gamma } = this._raw;
		const h = facingHeading(alpha, beta, gamma, this._screen);
		return h === null ? null : wrap360(h + (headingOffsetDeg || 0) + this._corr);
	}

	// Remove every listener and timer; status goes back to 'idle'.
	stop() {
		this._session++;
		this._detach();
		this.calibrator.reset();
		this.calibrating = false;
		this.accuracy = null;
		this._reset();
		this._set('idle');
	}

	_detach() {
		const w = this._win;
		if (w && this._listener) for (const ev of this._events) w.removeEventListener(ev, this._listener);
		if (w && this._screenListener) {
			const so = w.screen && w.screen.orientation;
			if (so && typeof so.removeEventListener === 'function') so.removeEventListener('change', this._screenListener);
			w.removeEventListener('orientationchange', this._screenListener);
		}
		for (const id of this._timers) this._clearTimeout(id);
		this._listener = null; this._screenListener = null; this._timers = [];
	}
}

// ---- Magnetic declination: World Magnetic Model WMM2025 ----------------------------------

// Decimal year for a Date (UTC), e.g. 2026-10-19 → 2026.8.
export function decimalYear(date = new Date()) {
	const y = date.getUTCFullYear(), t0 = Date.UTC(y, 0, 1), t1 = Date.UTC(y + 1, 0, 1);
	return y + (date.getTime() - t0) / (t1 - t0);
}

// WMM2025 Gauss coefficients (NOAA NCEI / BGS, public domain), epoch 2025.0, valid
// 2025.0–2030.0, generated by script from the official WMM.COF (header "2025.0 WMM-2025
// 11/13/2024", sha256 dfa85978…5582f). For n = 1..12 (one line each), m = 0..n:
// g, h (nT), g-dot, h-dot (nT/year).
export const WMM2025_COEFFS = Object.freeze([
	-29351.8,0,12,0, -1410.8,4545.4,9.7,-21.5,
	-2556.6,0,-11.6,0, 2951.1,-3133.6,-5.2,-27.7, 1649.3,-815.1,-8,-12.1,
	1361,0,-1.3,0, -2404.1,-56.6,-4.2,4, 1243.8,237.5,0.4,-0.3, 453.6,-549.5,-15.6,-4.1,
	895,0,-1.6,0, 799.5,278.6,-2.4,-1.1, 55.7,-133.9,-6,4.1, -281.1,212,5.6,1.6, 12.1,-375.6,-7,-4.4,
	-233.2,0,0.6,0, 368.9,45.4,1.4,-0.5, 187.2,220.2,0,2.2, -138.7,-122.9,0.6,0.4, -142,43,2.2,1.7, 20.9,106.1,0.9,1.9,
	64.4,0,-0.2,0, 63.8,-18.4,-0.4,0.3, 76.9,16.8,0.9,-1.6, -115.7,48.8,1.2,-0.4, -40.9,-59.8,-0.9,0.9, 14.9,10.9,0.3,0.7, -60.7,72.7,0.9,0.9,
	79.5,0,0,0, -77,-48.9,-0.1,0.6, -8.8,-14.4,-0.1,0.5, 59.3,-1,0.5,-0.8, 15.8,23.4,-0.1,0, 2.5,-7.4,-0.8,-1, -11.1,-25.1,-0.8,0.6, 14.2,-2.3,0.8,-0.2,
	23.2,0,-0.1,0, 10.8,7.1,0.2,-0.2, -17.5,-12.6,0,0.5, 2,11.4,0.5,-0.4, -21.7,-9.7,-0.1,0.4, 16.9,12.7,0.3,-0.5, 15,0.7,0.2,-0.6, -16.8,-5.2,0,0.3, 0.9,3.9,0.2,0.2,
	4.6,0,0,0, 7.8,-24.8,-0.1,-0.3, 3,12.2,0.1,0.3, -0.2,8.3,0.3,-0.3, -2.5,-3.3,-0.3,0.3, -13.1,-5.2,0,0.2, 2.4,7.2,0.3,-0.1, 8.6,-0.6,-0.1,-0.2, -8.7,0.8,0.1,0.4, -12.9,10,-0.1,0.1,
	-1.3,0,0.1,0, -6.4,3.3,0,0, 0.2,0,0.1,0, 2,2.4,0.1,-0.2, -1,5.3,0,0.1, -0.6,-9.1,-0.3,-0.1, -0.9,0.4,0,0.1, 1.5,-4.2,-0.1,0, 0.9,-3.8,-0.1,-0.1, -2.7,0.9,0,0.2, -3.9,-9.1,0,0,
	2.9,0,0,0, -1.5,0,0,0, -2.5,2.9,0,0.1, 2.4,-0.6,0,0, -0.6,0.2,0,0.1, -0.1,0.5,-0.1,0, -0.6,-0.3,0,0, -0.1,-1.2,0,0.1, 1.1,-1.7,-0.1,0, -1,-2.9,-0.1,0, -0.2,-1.8,-0.1,0, 2.6,-2.3,-0.1,0,
	-2,0,0,0, -0.2,-1.3,0,0, 0.3,0.7,0,0, 1.2,1,0,-0.1, -1.3,-1.4,0,0.1, 0.6,0,0,0, 0.6,0.6,0.1,0, 0.5,-0.1,0,0, -0.1,0.8,0,0, -0.4,0.1,0,0, -0.2,-1,-0.1,0, -1.3,0.1,0,0, -0.7,0.2,-0.1,-0.1,
]);
const WMM_EPOCH = 2025.0, WMM_NMAX = 12;
const WMM_A = 6371.2;                                         // geomagnetic reference radius, km
const WGS84_A = 6378.137, WGS84_F = 1 / 298.257223563;        // ellipsoid, km
const WGS84_E2 = WGS84_F * (2 - WGS84_F);

// Schmidt semi-normalisation factors, index n(n+1)/2 + m, computed once:
// S(0,0) = 1, S(n,0) = S(n-1,0)·(2n-1)/n, S(n,m) = S(n,m-1)·√((n-m+1)(m=1 ? 2 : 1)/(n+m)).
const WMM_SCHMIDT = (() => {
	const S = new Float64Array((WMM_NMAX + 1) * (WMM_NMAX + 2) / 2);
	S[0] = 1;
	for (let n = 1; n <= WMM_NMAX; n++) {
		const i0 = n * (n + 1) / 2;
		S[i0] = S[(n - 1) * n / 2] * (2 * n - 1) / n;
		for (let m = 1; m <= n; m++) S[i0 + m] = S[i0 + m - 1] * Math.sqrt((n - m + 1) * (m === 1 ? 2 : 1) / (n + m));
	}
	return S;
})();

// The main field at a point, following the WMM technical report (and NOAA's reference C
// code, step for step): geodetic → geocentric spherical coordinates, Schmidt semi-normalised
// associated Legendre functions of sin(geocentric latitude) and their latitude derivatives,
// the spherical-harmonic sums for the field in the geocentric frame, then a rotation back to
// the geodetic (ellipsoid) frame. Returns {x, y, z} in nT (north, east, down), declination
// and inclination in degrees. altKm is height above the WGS84 ellipsoid. The model is only
// defined for 2025.0–2030.0: other years are clamped to that range, so the result there is
// the 2025.0 or 2030.0 field (declination drifts by up to ~0.2°/year at mid latitudes, more
// near the poles).
export function wmmField(latDeg, lonDeg, decimalYearValue, altKm = 0) {
	const dt = Math.min(Math.max(decimalYearValue, WMM_EPOCH), WMM_EPOCH + 5) - WMM_EPOCH;
	// Exactly at a pole east/north are undefined; a hair away the series is well behaved.
	const lat = Math.max(-89.99999, Math.min(89.99999, latDeg)) * DEG, lon = lonDeg * DEG;

	// Geodetic → geocentric: radius r and geocentric latitude phic.
	const sLat = Math.sin(lat), cLat = Math.cos(lat);
	const Rc = WGS84_A / Math.sqrt(1 - WGS84_E2 * sLat * sLat); // prime vertical radius
	const p = (Rc + altKm) * cLat, zc = (Rc * (1 - WGS84_E2) + altKm) * sLat;
	const r = Math.hypot(p, zc), phic = Math.asin(zc / r);

	// Associated Legendre functions P(n,m) of x = sin(phic) (z = cos(phic)), first in Gauss
	// normalisation by the usual recurrences, with derivatives with respect to colatitude...
	const x = Math.sin(phic), zz = Math.cos(phic);
	const N = WMM_SCHMIDT.length, P = new Float64Array(N), dP = new Float64Array(N);
	P[0] = 1;
	for (let n = 1; n <= WMM_NMAX; n++) {
		for (let m = 0; m <= n; m++) {
			const i = n * (n + 1) / 2 + m;
			if (n === m) {
				const i1 = (n - 1) * n / 2 + m - 1;
				P[i] = zz * P[i1];
				dP[i] = zz * dP[i1] + x * P[i1];
			} else if (n === 1 || m > n - 2) {
				const i2 = (n - 1) * n / 2 + m;
				P[i] = x * P[i2];
				dP[i] = x * dP[i2] - zz * P[i2];
			} else {
				const i1 = (n - 2) * (n - 1) / 2 + m, i2 = (n - 1) * n / 2 + m;
				const k = ((n - 1) * (n - 1) - m * m) / ((2 * n - 1) * (2 * n - 3));
				P[i] = x * P[i2] - k * P[i1];
				dP[i] = x * dP[i2] - zz * P[i2] - k * dP[i1];
			}
		}
	}
	// ...then to Schmidt semi-normalisation, and the derivative to latitude (sign flip).
	for (let i = 0; i < N; i++) { P[i] *= WMM_SCHMIDT[i]; dP[i] = -dP[i] * WMM_SCHMIDT[i]; }

	// Sums. Coefficients at the requested time: g + gdot·dt, h + hdot·dt.
	let Bx = 0, By = 0, Bz = 0, c = 0;
	for (let n = 1; n <= WMM_NMAX; n++) {
		const rr = Math.pow(WMM_A / r, n + 2);
		for (let m = 0; m <= n; m++, c += 4) {
			const i = n * (n + 1) / 2 + m;
			const g = WMM2025_COEFFS[c] + WMM2025_COEFFS[c + 2] * dt;
			const h = WMM2025_COEFFS[c + 1] + WMM2025_COEFFS[c + 3] * dt;
			const cm = Math.cos(m * lon), sm = Math.sin(m * lon);
			Bx -= rr * (g * cm + h * sm) * dP[i];                // north, geocentric
			By += rr * (g * sm - h * cm) * m * P[i];             // east (÷ cos phic below)
			Bz -= rr * (g * cm + h * sm) * (n + 1) * P[i];       // down, geocentric
		}
	}
	By /= Math.cos(phic);

	// Rotate north/down from the geocentric to the geodetic frame.
	const psi = phic - lat;
	const X = Bx * Math.cos(psi) - Bz * Math.sin(psi);
	const Z = Bx * Math.sin(psi) + Bz * Math.cos(psi);
	const Y = By;
	return {
		x: X, y: Y, z: Z,
		declination: Math.atan2(Y, X) / DEG,
		inclination: Math.atan2(Z, Math.hypot(X, Y)) / DEG,
	};
}

// Magnetic declination in degrees, east positive: true heading = magnetic heading +
// declination. Pass it (plus any manual nudge) as headingOffsetDeg.
export function declination(latDeg, lonDeg, decimalYearValue, altKm = 0) {
	if (!finite(latDeg, lonDeg, decimalYearValue)) return 0;
	return wmmField(latDeg, lonDeg, decimalYearValue, finite(altKm) ? altKm : 0).declination;
}
