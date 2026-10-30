// Scan the Horizon: quaternion helpers for the camera view, without three.js.
//
// orientation.js (the shared copy) gives the phone's attitude as a quaternion [x, y, z, w] in the
// "scene" frame: x east, y up, z south, with the camera looking along its own −Z and +Y up the
// picture. It keeps its quaternion maths private, so the few pieces the camera view needs are
// here. Checked against three.js r186 and orientation.js's own cameraQuatSky in the research
// (reuse report §a: project() agrees with PerspectiveCamera + Vector3.project to 9e-9 px, and the
// az/alt/roll split round-trips to 2e-13°).
//
// Units: degrees; azimuth clockwise from true north (0 ≤ az < 360); altitude up from the
// observer's horizontal plane; roll + when the picture's right edge is raised.

export const DEG = Math.PI / 180;
export const wrap360 = (d) => ((d % 360) + 360) % 360;
export const wrap180 = (d) => wrap360(d + 180) - 180;

export const qAxis = (ax, ay, az, deg) => { const h = deg * DEG / 2, s = Math.sin(h); return [ax * s, ay * s, az * s, Math.cos(h)]; };
export const qMul = (a, b) => {
	const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
	return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
};
export const qConj = (q) => [-q[0], -q[1], -q[2], q[3]];
// Rotate the vector v by the unit quaternion q.
export function qRot(q, v) {
	const [x, y, z, w] = q, [vx, vy, vz] = v;
	const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
	return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// Where the view centre points, and how the picture is turned about it. Straight up or down the
// azimuth is undefined (NaN): the caller then uses OrientationSource.getFacingHeading().
export function attitude(q) {
	const f = qRot(q, [0, 0, -1]), r = qRot(q, [1, 0, 0]);
	const az = wrap360(Math.atan2(f[0], -f[2]) / DEG), alt = Math.asin(Math.max(-1, Math.min(1, f[1]))) / DEG;
	const n = Math.hypot(f[0], f[2]);
	if (n < 1e-6) return { az: NaN, alt, roll: NaN };
	const r0 = [-f[2] / n, 0, f[0] / n], u0 = cross(r0, f); // the level right, and the level up
	return { az, alt, roll: Math.atan2(dot(r, u0), dot(r, r0)) / DEG };
}
// And back: turn to the azimuth, tip up by the altitude, then roll about the view axis. This is
// also the attitude used when the view is dragged rather than following the compass.
export const fromAttitude = (az, alt, roll = 0) => qMul(qMul(qAxis(0, 1, 0, -az), qAxis(1, 0, 0, alt)), qAxis(0, 0, 1, roll));
// Unit vector (scene frame) for an azimuth and altitude.
export const dirFromAzAlt = (az, alt) => { const c = Math.cos(alt * DEG); return [c * Math.sin(az * DEG), Math.sin(alt * DEG), -c * Math.cos(az * DEG)]; };

// A true pinhole camera: the direction d (scene frame) to CSS pixels on a w × h screen whose
// vertical field of view is vfovDeg. Null when the point is behind the camera. `out` is reused.
export function project(q, d, w, h, vfovDeg, out = {}) {
	const c = qRot(qConj(q), d);
	if (c[2] > -1e-6) return null;
	const fpx = (h / 2) / Math.tan(vfovDeg * DEG / 2);
	out.x = w / 2 + fpx * c[0] / -c[2];
	out.y = h / 2 - fpx * c[1] / -c[2];
	out.depth = -c[2];
	return out;
}
// The same for many points at once: the view's inverse rotation is worked out once, and the
// focal length too. Returns a function (az, alt) → {x, y} | null, reusing one object.
export function projector(q, w, h, vfovDeg) {
	const qi = qConj(q), fpx = (h / 2) / Math.tan(vfovDeg * DEG / 2), cx = w / 2, cy = h / 2;
	const [x, y, z, ww] = qi, out = { x: 0, y: 0, depth: 0 };
	return (az, alt) => {
		const ca = Math.cos(alt * DEG), vx = ca * Math.sin(az * DEG), vy = Math.sin(alt * DEG), vz = -ca * Math.cos(az * DEG);
		const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
		const c0 = vx + ww * tx + (y * tz - z * ty), c1 = vy + ww * ty + (z * tx - x * tz), c2 = vz + ww * tz + (x * ty - y * tx);
		if (c2 > -1e-3) return null; // behind, or so far off-axis it would blow up
		out.x = cx + fpx * c0 / -c2; out.y = cy - fpx * c1 / -c2; out.depth = -c2;
		return out;
	};
}

// Vertical field of view of the camera picture as shown. A phone's main camera sees about 67°
// along the long side of its frame (longDeg: pinching the camera view changes it); with
// object-fit: cover the screen shows all of the long side (portrait video on a portrait screen) or
// a crop of it (orrery.live/night-sky autoCamFov).
export function autoCamFov(videoW, videoH, screenW, screenH, longDeg = 67) {
	const vw = videoW || 1080, vh = videoH || 1920;
	const long = longDeg * DEG, va = vw / vh, sa = screenW / screenH;
	const vFovV = vh >= vw ? long : 2 * Math.atan(Math.tan(long / 2) / va); // the video's own vertical FOV
	const shown = sa < va ? vFovV : 2 * Math.atan(Math.tan(vFovV / 2) * va / sa); // after the cover crop
	return Math.min(100, Math.max(10, shown / DEG));
}
// Without a picture: longDeg (67°) along the screen's long side, as a phone camera would see.
export function screenFov(w, h, longDeg = 67) {
	const half = longDeg / 2 * DEG;
	return 2 * Math.atan(h >= w ? Math.tan(half) : Math.tan(half) * h / w) / DEG;
}
