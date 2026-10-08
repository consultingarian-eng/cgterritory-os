'use strict';
// Streets and front doors for one ZIP, from OpenStreetMap via Overpass.
//
// What comes back is a walkable graph: every residential street is cut into
// short segments (≤ SEG_MAX_M, and always at intersections) and every
// residential building is snapped to the segment it fronts, with the side of
// the street it sits on. That is the unit the route generator hands out —
// "this block of Example St, 14 doors, 9 on the left".
//
// Overpass is public and slow (5–40 s for a ZIP), so callers cache the result
// (server keeps it in Mongo + RAM for 30 days; streets don't move).

const fs   = require('fs');
const path = require('path');
const geo  = require('./geo');
const parcels = require('./parcels');
const { settings, normalizeAreaId, USER_AGENT } = require('./settings');

// Order = observed reliability (Sep 2026): mail.ru answers a full ZIP in ~5 s
// every time; overpass-api.de throws transient "open64" 504s; kumi and
// private.coffee stall for minutes under load.
const OVERPASS_URLS = [
  process.env.OVERPASS_URL,
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
].filter(Boolean);

const GRAPH_VERSION = 5;     // bump when the graph's shape/meaning changes so cached graphs rebuild (3 = field policy: condos/9+/vacant skipped)
const SEG_MAX_M     = 120;   // longest block handed out as one unit
const SNAP_MAX_M    = 70;    // a door further than this from any street is not on a walkable street
const WALK_HIGHWAYS = ['residential', 'living_street', 'unclassified', 'tertiary', 'secondary', 'primary', 'tertiary_link', 'secondary_link'];

// Residential building classes. `yes` is included because the MassGIS /
// statewide imports tag every structure `building=yes` — the address check
// below separates houses from their garages.
const RES_BUILDING = new Set(['yes', 'house', 'residential', 'detached', 'semidetached_house', 'terrace', 'bungalow', 'duplex', 'apartments', 'static_caravan', 'cabin', 'farm']);
const NON_RES_KEYS = ['amenity', 'shop', 'office', 'tourism', 'leisure', 'industrial', 'craft', 'healthcare', 'public_transport', 'railway', 'power', 'man_made', 'military', 'emergency'];
const NON_RES_USE  = new Set(['commercial', 'industrial', 'retail', 'warehouse', 'school', 'church', 'government', 'civic', 'public', 'hospital', 'office']);

// ── ZIP polygons (same files the client draws: settings.regions) ─────────────
let zipIndex = null;
function loadZipIndex() {
  if (zipIndex) return zipIndex;
  zipIndex = new Map();
  const dir = path.join(__dirname, '..', 'public');
  for (const region of settings.regions) {
    const f = path.join(dir, String(region.file).split('?')[0].replace(/^\/+/, ''));
    if (!f.startsWith(dir) || !fs.existsSync(f)) continue;
    try {
      const gj = JSON.parse(fs.readFileSync(f, 'utf8'));
      for (const feat of gj.features || []) {
        const p = feat.properties || {};
        const zip = normalizeAreaId(p.POSTCODE || p.ZCTA5CE10 || p.ZCTA5CE20 || p.ZIP || '');
        if (!zip || !feat.geometry) continue;
        // A ZIP can be several features (the town plus a sliver across a
        // river) — keep every polygon, or a lookup lands on the sliver.
        const polys = feat.geometry.type === 'Polygon' ? [feat.geometry.coordinates] : feat.geometry.type === 'MultiPolygon' ? feat.geometry.coordinates : [];
        const prev = zipIndex.get(zip);
        zipIndex.set(zip, { type: 'MultiPolygon', coordinates: (prev ? prev.coordinates : []).concat(polys) });
      }
    } catch (e) { console.error(`[osm] ${region.file}: ${e.message}`); }
  }
  return zipIndex;
}
function zipGeometry(zip) { return loadZipIndex().get(zip) || null; }

// The area (ZIP / postcode sector) whose polygon holds a point, or '' when
// none on file does. Bounding boxes are cached; the polygon test runs only
// for the few areas whose box contains the point.
let areaBoxes = null;
function areaAt(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return '';
  if (!areaBoxes) areaBoxes = [...loadZipIndex()].map(([zip, g]) => ({ zip, polys: geo.polysOf(g), bb: geo.bboxOf(geo.outerRings(g)) }));
  for (const a of areaBoxes) {
    if (lat < a.bb.s || lat > a.bb.n || lng < a.bb.w || lng > a.bb.e) continue;
    if (geo.ptInPolys(lat, lng, a.polys)) return a.zip;
  }
  return '';
}

let hhIndex = null;
function zipHouseholds(zip) {
  if (!hhIndex) {
    hhIndex = new Map();
    try {
      for (const r of JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'data', 'master.json'), 'utf8')))
        if (r.zip && +r.households > 0) hhIndex.set(normalizeAreaId(r.zip) || String(r.zip), +r.households);
    } catch (e) { console.error(`[osm] master.json: ${e.message}`); }
  }
  return hhIndex.get(zip) || null;
}

// ── Overpass ─────────────────────────────────────────────────────────────────
function polyFilter(rings) {
  // Convex hull of all rings keeps the query tiny and never clips the ZIP;
  // results are filtered against the exact polygon afterwards.
  const hull = geo.convexHull(rings.flat());
  return `(poly:"${hull.map(([lat, lng]) => `${lat.toFixed(5)} ${lng.toFixed(5)}`).join(' ')}")`;
}

// The public mirrors are individually flaky and take turns being the healthy
// one (overpass-api.de throws transient "open64" 504s, the others stall for
// minutes). So: hedge. Ask the preferred mirror first, and every HEDGE_MS
// without an answer add the next one; the first good reply wins and the rest
// are aborted. A ZIP is fetched once a month, so the extra load is nothing.
const HEDGE_MS = 10_000, MIRROR_TIMEOUT_MS = 90_000;
let preferredUrl = null;
function overpass(query) {
  const urls = preferredUrl ? [preferredUrl, ...OVERPASS_URLS.filter(u => u !== preferredUrl)] : OVERPASS_URLS.slice();
  return new Promise((resolve, reject) => {
    const ctrls = [];
    let pending = 0, started = 0, done = false, lastErr = null, timer = null;
    const finish = (err, val) => {
      if (done) return; done = true;
      clearTimeout(timer);
      for (const c of ctrls) c.abort();
      err ? reject(err) : resolve(val);
    };
    const attempt = async url => {
      const ctrl = new AbortController(); ctrls.push(ctrl);
      const to = setTimeout(() => ctrl.abort(), MIRROR_TIMEOUT_MS);
      pending++;
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
          body: 'data=' + encodeURIComponent(query),
          signal: ctrl.signal,
        });
        const txt = await r.text();
        if (!r.ok || !txt.trimStart().startsWith('{')) throw new Error(`Overpass ${r.status}: ${txt.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)}`);
        const json = JSON.parse(txt);
        // A mirror that ran out of time or memory still answers 200 with
        // valid JSON — and a "remark" saying the result is incomplete.
        if (json.remark && /runtime error|timed out|out of memory|memory/i.test(json.remark)) throw new Error(`Overpass incomplete: ${json.remark.slice(0, 120)}`);
        preferredUrl = url;
        finish(null, json);
      } catch (e) {
        if (!done) { lastErr = e; console.warn(`[osm] ${url.split('/')[2]}: ${e.message}`); }
      } finally {
        clearTimeout(to); pending--;
        if (!done && pending === 0 && started >= urls.length) finish(lastErr || new Error('Overpass unavailable'));
        else if (!done && pending === 0) startNext();   // everyone failed fast — don't wait out the hedge timer
      }
    };
    const startNext = () => {
      clearTimeout(timer);
      if (done || started >= urls.length) return;
      attempt(urls[started++]);
      if (started < urls.length) timer = setTimeout(startNext, HEDGE_MS);
    };
    startNext();
  });
}

// One more full round after a pause: the mirrors' bad moments are short.
async function overpassRetry(query) {
  try { return await overpass(query); }
  catch (e) {
    console.warn(`[osm] all mirrors failed (${e.message}) — retrying in 5 s`);
    await new Promise(r => setTimeout(r, 5000));
    return overpass(query);
  }
}

async function fetchRaw(rings) {
  const poly = polyFilter(rings);
  const q = `[out:json][timeout:80];
way["highway"~"^(${WALK_HIGHWAYS.join('|')})$"]${poly}->.s;
.s out geom qt;
(
  way["building"]${poly};
  node["addr:housenumber"]${poly};
)->.b;
.b out bb qt;`;
  const j = await overpassRetry(q);
  const ways = [], buildings = [], addrNodes = [];
  for (const el of j.elements || []) {
    if (el.type === 'way' && el.tags?.highway) ways.push(el);
    else if (el.type === 'way' && el.tags?.building && el.bounds) {
      // `out bb` is far lighter than full geometry; the bbox midpoint is the
      // door and the bbox area (×0.75) approximates the footprint.
      const b = el.bounds;
      const w = geo.distM(b.minlat, b.minlon, b.minlat, b.maxlon), h = geo.distM(b.minlat, b.minlon, b.maxlat, b.minlon);
      buildings.push({ ...el, center: { lat: (b.minlat + b.maxlat) / 2, lon: (b.minlon + b.maxlon) / 2 }, areaM2: Math.round(w * h * 0.75) });
    }
    else if (el.type === 'node' && el.tags?.['addr:housenumber']) addrNodes.push(el);
  }
  return { ways, buildings, addrNodes };
}

// ── Classification ───────────────────────────────────────────────────────────
function isResidential(tags) {
  if (!tags) return false;
  const b = tags.building;
  if (b && !RES_BUILDING.has(b)) return false;
  if (NON_RES_USE.has(tags['building:use'])) return false;
  for (const k of NON_RES_KEYS) if (tags[k]) return false;
  return true;
}

function streetName(tags) {
  return tags.name || tags['name:en'] || (tags.ref ? `Route ${tags.ref}` : '') || '';
}

// Point a fraction t along a polyline of [lat,lng].
function pointAlong(coords, t) {
  const lens = []; let total = 0;
  for (let i = 1; i < coords.length; i++) { const d = geo.distM(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]); lens.push(d); total += d; }
  let want = t * total;
  for (let i = 0; i < lens.length; i++) {
    if (want <= lens[i] || i === lens.length - 1) {
      const f = lens[i] ? Math.min(1, want / lens[i]) : 0;
      return [coords[i][0] + (coords[i + 1][0] - coords[i][0]) * f, coords[i][1] + (coords[i + 1][1] - coords[i][1]) * f];
    }
    want -= lens[i];
  }
  return coords[0];
}

// ── Graph build ──────────────────────────────────────────────────────────────
// graph = {
//   origin: [lat,lng],
//   nodes: { id: [lat,lng] },
//   segs:  [{ id, a, b, name, hw, coords:[[lat,lng]...], len, doors:[{lat,lng,num,side,t}] }],
//   stats: {...}
// }
// Enough normalisation to group address points: case, punctuation, spaces.
const streetKeyLite = v => String(v || '').toUpperCase().replace(/[.,']/g, '').replace(/\s+/g, ' ').trim();

// OpenStreetMap's own multi-family signals — rare, but exact when present.
function hintUnits(tags) {
  if (!tags) return null;
  const n = parseInt(tags['building:flats'] || tags['building:units'] || '', 10);
  if (n > 1) return { u: n };
  const hn = String(tags['addr:housenumber'] || '');
  if (/[;,]/.test(hn)) { const k = hn.split(/[;,]/).filter(x => x.trim()).length; if (k > 1) return { u: k }; }
  if (/^\d+[A-Z]?\s*[-–]\s*\d+[A-Z]?$/.test(hn)) return { u: 2 };
  const units = String(tags['addr:unit'] || tags['addr:flats'] || '');
  if (/[;,]/.test(units)) { const k = units.split(/[;,]/).filter(x => x.trim()).length; if (k > 1) return { u: k }; }
  if (tags.building === 'apartments') { const lv = parseInt(tags['building:levels'] || '', 10); return { u: lv > 0 ? Math.max(2, lv * 2) : 2, approx: true }; }
  return null;
}

function buildGraph(zip, rings, raw, householdsHint, polys = null, parcelInfo = null) {
  const bb = geo.bboxOf(rings);
  const origin = [(bb.s + bb.n) / 2, (bb.w + bb.e) / 2];
  const P = geo.projector(origin[0], origin[1]);
  const inZip = polys ? (lat, lng) => geo.ptInPolys(lat, lng, polys) : (lat, lng) => geo.ptInGeometry(lat, lng, rings);

  // Nodes shared by ≥2 ways are intersections — segments always break there.
  const useCount = new Map();
  for (const w of raw.ways) for (const n of w.nodes || []) useCount.set(n, (useCount.get(n) || 0) + 1);

  const nodes = {};
  const segs = [];
  let synth = 0;
  for (const w of raw.ways) {
    const g = w.geometry || [], ids = w.nodes || [];
    if (g.length < 2 || ids.length !== g.length) continue;
    if (w.tags.access === 'private' || w.tags.access === 'no') continue;
    const name = streetName(w.tags), hw = w.tags.highway;
    // Break the polyline into pieces at intersections, then at SEG_MAX_M.
    let cur = [{ id: ids[0], lat: g[0].lat, lng: g[0].lon }];
    let curLen = 0, piece = 0;
    const flush = () => {
      if (cur.length < 2) return;
      const a = cur[0], b = cur[cur.length - 1];
      nodes[a.id] = [a.lat, a.lng]; nodes[b.id] = [b.lat, b.lng];
      const coords = cur.map(p => [+p.lat.toFixed(6), +p.lng.toFixed(6)]);
      // Block ids are `way:piece`, stable across the monthly re-fetch as long
      // as the street itself is unchanged — reservations point at them.
      segs.push({ id: `${w.id}:${piece++}`, a: String(a.id), b: String(b.id), name, hw, coords, len: Math.round(curLen), doors: [] });
      cur = [b]; curLen = 0;
    };
    for (let i = 1; i < g.length; i++) {
      const prev = cur[cur.length - 1];
      let pLat = prev.lat, pLng = prev.lng;
      let d = geo.distM(pLat, pLng, g[i].lat, g[i].lon);
      // Long straight stretches get synthetic break points so a 600 m road
      // becomes five blocks, not one.
      while (curLen + d > SEG_MAX_M * 1.5) {
        const need = Math.max(20, SEG_MAX_M - curLen);
        const f = Math.max(0.05, Math.min(0.95, need / d));
        const mLat = pLat + (g[i].lat - pLat) * f, mLng = pLng + (g[i].lon - pLng) * f;
        cur.push({ id: `s${++synth}`, lat: mLat, lng: mLng });
        curLen += need; flush();
        pLat = mLat; pLng = mLng; d = geo.distM(pLat, pLng, g[i].lat, g[i].lon);
      }
      cur.push({ id: ids[i], lat: g[i].lat, lng: g[i].lon });
      curLen += d;
      if (useCount.get(ids[i]) > 1 || i === g.length - 1) flush();
    }
  }
  // Drop segments entirely outside the ZIP (hull over-fetch), keep boundary ones.
  const kept = segs.filter(s => s.coords.some(([la, ln]) => inZip(la, ln)));

  // Index segment pieces for snapping.
  const grid = new geo.Grid(80);
  kept.forEach((s, si) => {
    for (let i = 1; i < s.coords.length; i++) {
      const a = P.toXY(s.coords[i - 1][0], s.coords[i - 1][1]), b = P.toXY(s.coords[i][0], s.coords[i][1]);
      const item = { si, a, b, i };
      grid.add((a.x + b.x) / 2, (a.y + b.y) / 2, item);
    }
  });
  const snap = (lat, lng) => {
    const p = P.toXY(lat, lng);
    let best = null;
    for (const it of grid.near(p.x, p.y, SNAP_MAX_M + 80)) {
      const pr = geo.projectToSegment(p, it.a, it.b);
      if (pr.d <= SNAP_MAX_M && (!best || pr.d < best.d)) best = { ...pr, si: it.si, i: it.i };
    }
    return best;
  };

  // Doors. Numbered residential buildings are houses; unnumbered ones are
  // usually garages/sheds where the import numbered the houses, so they only
  // count where numbering is sparse (older imports, CT/NY suburbs).
  const cands = [];
  for (const b of raw.buildings) {
    if (!b.center || !isResidential(b.tags)) continue;
    cands.push({ lat: b.center.lat, lng: b.center.lon, num: b.tags['addr:housenumber'] || '', street: b.tags['addr:street'] || '', numbered: !!b.tags['addr:housenumber'], areaM2: b.areaM2 || 0, hint: hintUnits(b.tags) });
  }
  const numberedBuildings = cands.filter(c => c.numbered).length;
  const numberedShare = cands.length ? numberedBuildings / cands.length : 0;
  const countUnnumbered = numberedShare < 0.4;
  // Without numbers, footprint size is the only thing separating a house
  // from its garage: sheds/garages sit under ~45 m², houses above.
  const HOUSE_MIN_M2 = 45;
  let doors = cands.filter(c => c.numbered || (countUnnumbered && c.areaM2 >= HOUSE_MIN_M2));
  const smallSkipped = countUnnumbered ? cands.filter(c => !c.numbered && c.areaM2 < HOUSE_MIN_M2).length : 0;

  // Standalone address points (no building drawn, or the point is the
  // address and the building isn't numbered) — add unless a numbered
  // building already sits within 15 m.
  const dGrid = new geo.Grid(50);
  for (const d of doors) { const p = P.toXY(d.lat, d.lng); dGrid.add(p.x, p.y, p); }
  // Some imports (NYS SAM) put one address point per apartment: collapse
  // points to one door per house number + street, and remember how many
  // units they stood for — that count is the unit hint when no assessor
  // parcel matches.
  const byAddr = new Map();
  for (const n of raw.addrNodes) {
    if (!isResidential(n.tags)) continue;
    const key = `${String(n.tags['addr:housenumber'] || '').toUpperCase()}|${streetKeyLite(n.tags['addr:street'])}|${Math.round(n.lat / 0.00054)}:${Math.round(n.lon / 0.0007)}`;
    let g = byAddr.get(key);
    if (!g) { g = { first: n, units: new Set(), count: 0 }; byAddr.set(key, g); }
    g.count++;
    if (n.tags['addr:unit']) g.units.add(String(n.tags['addr:unit']).toUpperCase());
  }
  let addrCollapsed = 0;
  for (const g of byAddr.values()) {
    const n = g.first;
    const p = P.toXY(n.lat, n.lon);
    const dup = dGrid.near(p.x, p.y, 15).some(q => Math.hypot(q.x - p.x, q.y - p.y) <= 15);
    addrCollapsed += g.count - 1;
    if (dup) continue;
    const unitPts = g.units.size;
    const hint = hintUnits(n.tags) || (unitPts > 1 ? { u: unitPts } : null);
    doors.push({ lat: n.lat, lng: n.lon, num: n.tags['addr:housenumber'] || '', street: n.tags['addr:street'] || '', numbered: true, hint });
    dGrid.add(p.x, p.y, p);
  }

  // Units per building: assessor parcels joined onto the buildings where a
  // source exists (a triple-decker = 3 doors), OpenStreetMap's own sparse
  // hints otherwise. Above the cap a building is one door, flagged.
  const snapDist = (lat, lng) => { const r = snap(lat, lng); return r ? r.d : Infinity; };
  if (!parcelInfo?.parcels?.length) for (const d of doors) if (d.hint) { d.u = d.hint.u; if (d.hint.approx) d.approx = true; }
  const bizPts = [], bigPts = [];
  const unitStats = parcels.applyUnits(doors, parcelInfo?.parcels || null, { P, snapDist, countUnnumbered, inZip, bizOut: bizPts, bigOut: bigPts });
  unitStats.unitsSource = parcelInfo?.parcels?.length ? parcelInfo.source : 'osm-hints';
  unitStats.unitsFetchedAt = parcelInfo?.fetchedAt || null;
  unitStats.rollNote = parcelInfo?.rollNote || '';
  unitStats.attribution = parcelInfo?.attribution || '';
  unitStats.parcels = parcelInfo?.parcels?.length || 0;

  let snapped = 0, outside = 0, unsnapped = 0, unitsSnapped = 0;
  for (const d of doors) {
    if (!inZip(d.lat, d.lng)) { outside++; continue; }
    const s = snap(d.lat, d.lng);
    if (!s) { unsnapped++; continue; }
    const seg = kept[s.si];
    // Position along the whole segment (0..1) for ordering; side relative to a→b.
    const before = seg.coords.slice(0, s.i).reduce((acc, c, k) => k ? acc + geo.distM(seg.coords[k - 1][0], seg.coords[k - 1][1], c[0], c[1]) : 0, 0);
    const pieceLen = geo.distM(seg.coords[s.i - 1][0], seg.coords[s.i - 1][1], seg.coords[s.i][0], seg.coords[s.i][1]);
    const t = seg.len ? Math.min(1, (before + s.t * pieceLen) / seg.len) : 0;
    const door = { lat: +d.lat.toFixed(6), lng: +d.lng.toFixed(6), num: d.num, side: s.side, t: +t.toFixed(3) };
    if (d.u > 1) door.u = d.u;
    if (d.big) { door.big = true; if (d.bigUnits) door.bu = d.bigUnits; }
    if (d.approx) door.approx = true;
    if (d.cls === 'mixed') door.mx = 1;                 // shop downstairs, homes above
    seg.doors.push(door);
    snapped++; unitsSnapped += d.u || 1;
  }
  // Business lots onto the street they front — how shop-lined a main road
  // is decides whether it's handed out (routegen).
  for (const b of bizPts) { const s = snap(b.lat, b.lng); if (s) kept[s.si].biz = (kept[s.si].biz || 0) + 1; }
  // …and the condo / apartment buildings the policy skipped, so a street
  // that's mostly big buildings can be left out whole (routegen).
  for (const b of bigPts) { const s = snap(b.lat, b.lng); if (s) kept[s.si].bigB = (kept[s.si].bigB || 0) + 1; }
  for (const s of kept) s.doors.sort((x, y) => x.t - y.t);

  // Where OSM has (almost) no buildings — Pawtucket, parts of RI/CT — spread
  // the ZIP's household count along its door-less side streets instead, so
  // routes can still be sized. Flagged: the drawer says counts are estimates.
  const households = householdsHint || zipHouseholds(zip);
  let synthetic = 0, estimated = false;
  if (households && unitsSnapped < households * 0.3 && !parcelInfo?.parcels?.length) {
    const MAIN = new Set(['primary', 'secondary', 'trunk', 'primary_link', 'secondary_link', 'trunk_link']);
    const empty = kept.filter(s => !s.doors.length && !MAIN.has(s.hw) && s.len >= 30);
    const emptyKm = empty.reduce((n, s) => n + s.len, 0) / 1000;
    if (emptyKm > 0) {
      const perKm = Math.max(20, Math.min(150, (households - unitsSnapped) / emptyKm));
      for (const s of empty) {
        const n = Math.round(s.len / 1000 * perKm);
        for (let k = 0; k < n; k++) {
          const t = (k + 0.5) / n;
          const [lat, lng] = pointAlong(s.coords, t);
          s.doors.push({ lat: +lat.toFixed(6), lng: +lng.toFixed(6), num: '', side: k % 2 ? -1 : 1, t: +t.toFixed(3), est: true });
          synthetic++;
        }
      }
      estimated = true;
    }
  }

  // Only keep nodes referenced by kept segments.
  const usedNodes = {};
  for (const s of kept) { usedNodes[s.a] = nodes[s.a]; usedNodes[s.b] = nodes[s.b]; }

  return {
    zip, v: GRAPH_VERSION, bizKnown: !!parcelInfo?.parcels?.length, origin, fetchedAt: new Date().toISOString(),
    nodes: usedNodes, segs: kept,
    stats: {
      ways: raw.ways.length, segs: kept.length, streetKm: +(kept.reduce((n, s) => n + s.len, 0) / 1000).toFixed(1),
      osmBuildings: raw.buildings.length, residential: cands.length, numberedShare: +numberedShare.toFixed(2),
      countUnnumbered, smallSkipped, doors: unitsSnapped + synthetic, buildings: snapped, doorsOutside: outside, doorsUnsnapped: unsnapped,
      households: households || null, estimated, synthetic,
      units: unitsSnapped, multi: unitStats.multi, big: unitStats.big, unitCap: unitStats.unitCap, unitsSource: unitStats.unitsSource,
      unitsFetchedAt: unitStats.unitsFetchedAt, rollNote: unitStats.rollNote, attribution: unitStats.attribution,
      parcels: unitStats.parcels, matched: unitStats.matched, unmatchedStreets: unitStats.unmatchedStreets, addrCollapsed,
      skipped: unitStats.skipped, policy: unitStats.policy,
    },
  };
}

// opts.parcels: a normalised parcel set from lib/parcels.js (or null → OSM hints).
async function fetchZipGraph(zip, householdsHint, opts = {}) {
  const geom = zipGeometry(zip);
  if (!geom) throw Object.assign(new Error(`No boundary on file for ZIP ${zip}`), { status: 404 });
  const rings = geo.outerRings(geom);
  const raw = await fetchRaw(rings);
  return buildGraph(zip, rings, raw, householdsHint, geo.polysOf(geom), opts.parcels || null);
}

module.exports = { fetchZipGraph, zipGeometry, areaAt, buildGraph, fetchRaw, isResidential, hintUnits, SEG_MAX_M, GRAPH_VERSION };
