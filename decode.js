// Scan the Horizon tile decoding: Terrarium-encoded WebP (Mapterhorn) and PNG (AWS) to heights in metres.
//
// Three paths, chosen once per worker by xray-worker.js:
//   1. In the worker: createImageBitmap(blob, {premultiplyAlpha:'none', colorSpaceConversion:'none'})
//      → OffscreenCanvas 2D → getImageData. Exact in Chromium, Firefox and Safari 16.4+.
//   2. On the main thread, where the worker has no OffscreenCanvas (Playwright's Windows WebKit;
//      Safari < 16.4). The page calls attachDecodeFallback(worker) once, right after creating the
//      worker; the worker then posts {type:'decode', id, blob} and the page answers
//      {type:'decoded', id, w, h, heights} (heights: Float32Array, transferred) or
//      {type:'decoded', id, error}. attachDecodeFallback also posts {type:'decoder', main:true} so
//      the worker knows it is there. These messages carry no gen; the page's own message handler
//      should ignore types it doesn't know.
//   3. A pure-JS PNG decoder (DecompressionStream('deflate')) for AWS tiles: no canvas and no colour
//      management at all, so it is exact anywhere (Safari 16.4+, Chrome 80+, Firefox 113+, Node 18+).
// The decode canary: an 82-byte lossless WebP (VP8L, no colour profile) of 4×2 pixels with known
// Terrarium heights. If the chosen path doesn't reproduce them exactly, the worker switches to AWS
// PNG + path 3, so a browser that colour-manages or premultiplies can never draw wrong heights.

export const CANARY_WEBP = 'UklGRkoAAABXRUJQVlA4TD0AAAAvA0AAAD+gIJIN6n1QRmRdRNFCFwIBCsVu2wkCSEYbJZTRQhll/iPPB0Ux0cyh5WaCUACNzQhSCaCI/scGAA==';
// RGB (128,0,0) (129,44,128) (130,10,64) (127,250,192) / (131,200,32) (128,1,0) (135,99,224) (126,5,96)
export const CANARY_HEIGHTS = [0, 300.5, 522.25, -5.25, 968.125, 1, 1891.875, -506.625];
export function canaryBlob() {
	const s = atob(CANARY_WEBP), b = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
	return new Blob([b], { type: 'image/webp' });
}
export function canaryOk(res) {
	if (!res || res.w !== 4 || res.h !== 2) return false;
	return CANARY_HEIGHTS.every((h, i) => res.heights[i] === h);
}

// Terrarium: h = R·256 + G + B/256 − 32768 (RGBA bytes in, metres out).
export function terrarium(rgba, n, out = new Float32Array(n)) {
	for (let i = 0, j = 0; i < n; i++, j += 4) out[i] = rgba[j] * 256 + rgba[j + 1] + rgba[j + 2] / 256 - 32768;
	return out;
}
// The same, rounded to whole metres as Int16 (the storage for z ≤ 12) in one integer pass:
// round(R·256 + G − 32768 + B/256) adds 1 when B ≥ 128, exactly as Math.round does.
export function terrariumInt16(rgba, n, out = new Int16Array(n)) {
	for (let i = 0, j = 0; i < n; i++, j += 4) out[i] = rgba[j] * 256 + rgba[j + 1] - 32768 + (rgba[j + 2] >> 7);
	return out;
}

// Path 1 (and the page side of path 2): image → canvas → heights (Float32, or Int16 with int16).
// One canvas per tile size is kept and reused.
export const canBitmapDecode = () => typeof createImageBitmap === 'function' && (typeof OffscreenCanvas === 'function' || typeof document !== 'undefined');
const canvases = new Map();
function canvas2d(w, h) {
	const k = w + 'x' + h;
	if (!canvases.has(k)) {
		let ctx;
		if (typeof OffscreenCanvas === 'function') ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
		else { const c = document.createElement('canvas'); c.width = w; c.height = h; ctx = c.getContext('2d', { willReadFrequently: true }); }
		canvases.set(k, ctx);
	}
	return canvases.get(k);
}
export async function decodeBitmap(blob, { int16 = false } = {}) {
	const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
	const w = bmp.width, h = bmp.height;                   // read before close(), which zeroes them
	const ctx = canvas2d(w, h);
	ctx.clearRect(0, 0, w, h);
	ctx.drawImage(bmp, 0, 0);
	if (bmp.close) bmp.close();
	const px = ctx.getImageData(0, 0, w, h).data;
	return { w, h, heights: int16 ? terrariumInt16(px, w * h) : terrarium(px, w * h) };
}

// Path 3: 8-bit, non-interlaced RGB or RGBA PNG → heights. AWS tiles are colour type 2.
export async function decodePNG(buf) {
	const b = new Uint8Array(buf), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
	if (dv.getUint32(0) !== 0x89504e47) throw new Error('not a PNG');
	let p = 8, w = 0, h = 0, ctype = 0;
	const parts = [];
	while (p + 8 <= b.length) {
		const n = dv.getUint32(p), id = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
		if (id === 'IHDR') {
			w = dv.getUint32(p + 8); h = dv.getUint32(p + 12); ctype = b[p + 17];
			if (b[p + 16] !== 8 || b[p + 20] !== 0 || (ctype !== 2 && ctype !== 6)) throw new Error('unsupported PNG');
		} else if (id === 'IDAT') parts.push(b.subarray(p + 8, p + 8 + n));
		else if (id === 'IEND') break;
		p += 12 + n;
	}
	const raw = new Uint8Array(await new Response(new Blob(parts).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
	const bpp = ctype === 6 ? 4 : 3, stride = w * bpp;
	let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
	const out = new Float32Array(w * h);
	for (let y = 0; y < h; y++) {
		const o = y * (stride + 1), ft = raw[o];
		for (let i = 0; i < stride; i++) {
			const a = i >= bpp ? cur[i - bpp] : 0, up = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
			let v = raw[o + 1 + i];
			if (ft === 1) v += a;
			else if (ft === 2) v += up;
			else if (ft === 3) v += (a + up) >> 1;
			else if (ft === 4) { const pp = a + up - c, pa = Math.abs(pp - a), pb = Math.abs(pp - up), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
			else if (ft !== 0) throw new Error('bad PNG filter');
			cur[i] = v;
		}
		for (let x = 0, q = y * w; x < w; x++) out[q + x] = cur[x * bpp] * 256 + cur[x * bpp + 1] + cur[x * bpp + 2] / 256 - 32768;
		const t = prev; prev = cur; cur = t;
	}
	return { w, h, heights: out };
}

// Path 2, page side: call once with the worker, before posting 'run'.
export function attachDecodeFallback(worker) {
	worker.addEventListener('message', async (e) => {
		const m = e.data;
		if (!m || m.type !== 'decode') return;
		try {
			const r = await decodeBitmap(m.blob);
			worker.postMessage({ type: 'decoded', id: m.id, w: r.w, h: r.h, heights: r.heights }, [r.heights.buffer]);
		} catch (err) {
			worker.postMessage({ type: 'decoded', id: m.id, error: String(err && err.message || err) });
		}
	});
	worker.postMessage({ type: 'decoder', main: true });
}

// Path 2, worker side: ask the page to decode and wait (up to timeoutMs) for the answer.
export class MainThreadDecoder {
	constructor(post) { this.post = post; this.next = 1; this.wait = new Map(); }
	decode(blob, timeoutMs = 15000) {
		const id = this.next++;
		return new Promise((ok, fail) => {
			const t = setTimeout(() => { this.wait.delete(id); fail(new Error('main-thread decode timed out')); }, timeoutMs);
			this.wait.set(id, { ok, fail, t });
			this.post({ type: 'decode', id, blob });
		});
	}
	// Feed every {type:'decoded'} message from the page here.
	answer(m) {
		const w = this.wait.get(m.id);
		if (!w) return;
		this.wait.delete(m.id); clearTimeout(w.t);
		if (m.error) w.fail(new Error(m.error)); else w.ok({ w: m.w, h: m.h, heights: m.heights });
	}
}
