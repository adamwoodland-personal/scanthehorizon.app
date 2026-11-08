# Scan the Horizon

**https://scanthehorizon.app/**

Hold up your phone and see what's on your horizon: the hills, mountains and coast around you drawn like the sign at a lookout, with the towns, peaks, islands, lakes and landmarks named and how far away each one is. The drawing turns with the phone's compass (drag it on a computer), works indoors, and the Camera button shows it over the live picture. A Detail slider chooses how many names to show; the List has them all.

Everything is worked out in the browser. Your exact position stays on your phone: the page downloads elevation tiles for the area around you and place names from this site, and only the words you type into the place search go to Photon or Open-Meteo.

## How it's built

Static files, no framework, no build step, no backend ("xray" in the file names is the project's working title):

- `index.html`, `xray.css`: the page, its sheets and the questions in About (the FAQPage JSON-LD in `<head>` says the same, word for word).
- `app.js`: the page: the place (GPS, a search, a `#at=lat,lon` link), the compass, the camera, the Detail slider, the card, the List and the settings.
- `draw.js`: the drawing: the sign view (a strip, bearing across and height up, hills exaggerated) and the camera view (true-scale pinhole), the ridges, the labels and their leaders.
- `xray-worker.js`: a module worker that does the heavy part off the main thread, with
  - `dem.js`: the elevation tiles: rings of tiles chosen by metres per pixel, Mapterhorn first and the AWS terrain tiles as a fallback, kept in the Cache API (`xray-dem-v1`, up to 180 days);
  - `decode.js`: the tiles (Terrarium-encoded WebP and PNG) to heights, in the worker or, where the worker can't, on the page;
  - `pano.js`: the panorama: the skyline and the ridge lines, bearing by bearing, with the curve of the Earth and refraction;
  - `targets.js`: the place names round the observer, which of them can be seen, and how they rank.
- `attitude.js`: quaternion helpers for the camera view. `orientation.js`: the phone's attitude, the iPhone compass calibration and the World Magnetic Model 2025 (a copy of the one on [lookupanddown.com](https://lookupanddown.com/)). `geocode.js`: the place search (Photon, then Open-Meteo).
  - `saved.js`: saved areas ("Use it without signal" in the place sheet): which tiles a view from anywhere within 2 to 200 km of a place (or in a box from a #save= link) needs, at full detail up to 20 km and a little less close by beyond, kept in the Cache API (`xray-saved-v1`) until deleted.
- `sw.js`, `manifest.json` and the icons: an installable app that works offline once opened. Bump `CACHE` in `sw.js` whenever a precached file changes; place-name tiles are kept in their own cache (`sth-places-v1`), which a new `CACHE` leaves alone.

No three.js or other library: the drawing is a 2D canvas.

## The place names (`data/places/`, not in this repository)

The place names are about 19,000 small JSON files (some 350 MB), built from the GeoNames dumps and uploaded with the site, but not kept in git (see `.gitignore`). They are built by a script kept outside this repository (`build-places.mjs`, run with Node from the GeoNames `allCountries.zip` and `alternateNamesV2.zip`). The format, should you want to make your own:

- `data/places/v1/index.json`: `{"v":1,"bits":"<base64>"}`, a 360 × 180 bitset (least significant bit first) with bit `(floorLat + 90) * 360 + (floorLon + 180)` set where a tile exists, so the page never asks for a missing one.
- `data/places/v1/<floorLat>/<floorLon>.json`: one tile per 1° cell, `{"v":1,"lat":-27,"lon":152,"f":[record, …]}`, records in order of importance, at most a few thousand per tile.
- A record is `[geonameid, name, englishName|0, lat×1e4, lon×1e4, featureCode, population, elevation, wl, wiki, countryCode]`, where `wl` is how many languages GeoNames has a name or Wikipedia link in (a measure of how well known it is) and `wiki` is `1` when the English Wikipedia title is the name, the title when it differs, or `0`.
- Kept feature codes: populated places (`PPL`, `PPLA`…`PPLA5`, `PPLC`, `PPLG`, `PPLS`, `PPLF`, `PPLR`, `PPLL`, `PPLX`); mountains, peaks, hills, volcanoes and nunataks; islands, atolls, capes, points, headlands, peninsulas and bays; lakes, reservoirs and waterfalls; lighthouses, towers, lookouts, dams, castles and monuments.

## Data and credits

- Terrain: © [Mapterhorn](https://mapterhorn.com/attribution), from Copernicus GLO-30 (© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the European Union and ESA), Geoscience Australia 5 m LiDAR DEM (© Commonwealth of Australia, CC BY 4.0), swissALTI3D (© swisstopo) and other open national datasets.
- Fallback terrain: Mapzen terrain tiles on AWS Open Data; 3DEP, GMTED2010 and SRTM courtesy of the U.S. Geological Survey; ETOPO1 (NOAA); Australia © Commonwealth of Australia (Geoscience Australia) 2017; EU-DEM (Copernicus).
- Place names: [GeoNames](https://www.geonames.org/), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- Place search: [Photon](https://photon.komoot.io/) (komoot; © OpenStreetMap contributors) and [Open-Meteo](https://open-meteo.com/)'s geocoding API.
- Magnetic declination: NOAA World Magnetic Model 2025 (public domain).

## Licence

The code is MIT-licensed (see `LICENSE`). The data keeps its own licences, listed above.

Design, code and content developed with the assistance of AI (Anthropic Claude).
