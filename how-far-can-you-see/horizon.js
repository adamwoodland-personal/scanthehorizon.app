// The two calculators on /how-far-can-you-see/. Same constants as the app (dem.js): the Earth's mean radius,
// and refraction k = 0.13, so a curve drops d²(1−k)/2R below a level line over a distance d. The page carries
// the answers for the default values, so it reads the same before this runs or without it.
const R = 6371008.8, K = 0.13;
const horizonM = (h, k = K) => Math.sqrt(2 * R * Math.max(0, h) / (1 - k));
const hiddenM = (h1, dKm, k = K) => { const x = dKm * 1000 - horizonM(h1, k); return x <= 0 ? 0 : x * x * (1 - k) / (2 * R); };
const kmText = (m) => { const k = m / 1000; return (k < 10 ? k.toFixed(1) : Math.round(k).toLocaleString('en-GB')) + ' km'; };
const mText = (m) => Math.round(m).toLocaleString('en-GB') + ' m';
const num = (el) => { const v = parseFloat(String(el.value).replace(',', '.')); return Number.isFinite(v) && v >= 0 ? v : null; };

function line(big, small, sub) {
	const out = document.createElement('span'); out.className = 'out'; out.textContent = big + ' ';
	const s = document.createElement('small'); s.textContent = small; out.append(s);
	const note = document.createElement('span'); note.className = 'small'; note.textContent = sub;
	return [out, note];
}

document.addEventListener('DOMContentLoaded', () => {
	const eye = document.getElementById('eye'), eyeOut = document.getElementById('eyeOut');
	const h1 = document.getElementById('h1'), dist = document.getElementById('dist'), tall = document.getElementById('tall'), hidOut = document.getElementById('hidOut');
	if (!eye || !h1) return;

	const one = () => {
		const h = num(eye);
		if (h === null) { eyeOut.replaceChildren(...line('–', 'to the horizon', 'Enter a height in metres.')); return; }
		eyeOut.replaceChildren(...line(kmText(horizonM(h)), 'to the horizon', `${kmText(horizonM(h, 0))} if light travelled in straight lines`));
	};
	const two = () => {
		const a = num(h1), d = num(dist), t = num(tall);
		if (a === null || d === null || t === null) { hidOut.replaceChildren(...line('–', 'hidden by the curve', 'Enter all three numbers.')); return; }
		const hid = hiddenM(a, d);
		const sub = hid === 0 ? `It is nearer than your horizon (${kmText(horizonM(a))}), so the curve hides none of it.`
			: hid >= t ? `All of it is below your horizon: it would need to be over ${mText(hid)} tall to show.`
				: `The top ${mText(t - hid)} of it shows above the horizon.`;
		hidOut.replaceChildren(...line(mText(hid), 'hidden by the curve', sub));
	};
	eye.addEventListener('input', one);
	for (const el of [h1, dist, tall]) el.addEventListener('input', two);
	one(); two();
});
