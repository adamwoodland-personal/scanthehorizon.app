// COPY of lookupanddown.com/places.js (2026-10-30), renamed geocode.js for Scan the Horizon so it can't be
// confused with the places tiles. Keep the two in step.
//
// Place search for "Where are you looking from?", as on weathermodels.app: Photon (OpenStreetMap
// data, run by komoot) first, Open-Meteo's GeoNames geocoder if Photon fails or finds nothing.
// Only the words typed are sent; the page's no-referrer policy keeps the page address out of it.
// Results: [{ name, where, type, lat, lon, address, locality }].
//
// (Scan the Horizon only:) `address` marks a street address: a Photon result with no name of its own, whose
// name is built from the house number and street, or a street. The page then shares and remembers
// it only as `locality`, its suburb or town, since an address is as telling as a GPS fix.
const TIMEOUT = 8000;

async function getJson(url, what) {
	const ac = new AbortController(), t = setTimeout(() => ac.abort(), TIMEOUT);
	try {
		const r = await fetch(url, { signal: ac.signal });
		if (!r.ok) throw new Error(`${what} answered ${r.status}`);
		return await r.json();
	} catch (e) {
		throw new Error(e.name === 'AbortError' ? `${what} took too long` : e.message || String(e));
	} finally { clearTimeout(t); }
}

function photonPlace(f) {
	const p = f.properties || {};
	const name = p.name || [p.housenumber, p.street].filter(Boolean).join(' ') || p.city || p.state || p.country || '?';
	const where = [];
	for (const x of [p.district, p.locality, p.city, p.county, p.state, p.country]) if (x && x !== name && !where.includes(x)) where.push(x);
	let type = p.osm_value || '';
	if (type === 'yes' || type === 'administrative') type = p.type === 'house' ? 'address' : (p.osm_key || '');
	const address = (!p.name && !!(p.housenumber || p.street)) || p.type === 'street';
	const locality = [p.district, p.city, p.county, p.state, p.country].find((x) => x && x !== name) || '';
	return { name, where: where.join(', '), type: type.replace(/_/g, ' '),
		lat: +f.geometry.coordinates[1].toFixed(4), lon: +f.geometry.coordinates[0].toFixed(4), address, locality };
}

async function photon(q) {
	const u = new URL('https://photon.komoot.io/api/');
	u.searchParams.set('q', q);
	u.searchParams.set('limit', '10');
	u.searchParams.set('lang', 'en');
	const j = await getJson(u, 'Photon');
	const seen = new Set(), out = [];
	for (const f of j.features || []) {
		if (!f.geometry || !f.geometry.coordinates) continue;
		const p = photonPlace(f), k = (p.name + '|' + p.where).toLowerCase();
		if (!seen.has(k)) { seen.add(k); out.push(p); }
	}
	return out.slice(0, 8);
}

async function openMeteo(q) {
	const u = new URL('https://geocoding-api.open-meteo.com/v1/search');
	u.searchParams.set('name', q);
	u.searchParams.set('count', '8');
	u.searchParams.set('language', 'en');
	u.searchParams.set('format', 'json');
	const j = await getJson(u, 'The place finder');
	return (j.results || []).map((r) => ({ name: r.name, where: [r.admin1, r.country].filter(Boolean).join(', '), type: '', lat: r.latitude, lon: r.longitude }));
}

export async function geocode(q) {
	try {
		const list = await photon(q);
		if (list.length) return list;
	} catch (e) { /* fall back */ }
	return openMeteo(q);
}
