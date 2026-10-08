'use strict';
// Dwelling units per building from assessor/parcel data, joined onto the
// OSM buildings that lib/osm.js turns into doors — so a triple-decker is
// three doors, a two-family two, and a locked 20-unit block stays one.
//
// Adapters live in lib/parcels/<name>.js and export
//   { name, attribution, fetch(zip, { hull, envelope, polys, meta }) → parcel[] }
// where parcel = { id, lat, lng, ring|null, nums:[...], street, u, cls, kind, approx, big, bldgs }
//   u    = units the assessor gives, before any policy (0 for a lot that holds no homes)
//   cls  = 'res' | 'condo' | 'apt' | 'mixed' | 'vacant' | 'commercial' | 'industrial'
//        | 'institutional' | 'garage' | 'parking' | 'other'   (normalised class, see POLICY)
//   big  = apartment block with an unknown or banded count
// Lots with u = 0 (vacant, commercial, garages …) are SUPPRESSORS: an OSM
// building drawn on one of them is not a door. Adapters must already have
// grouped stacked condo records into one parcel per building key.
// Everything else — ZIP filtering, policy, the join — is here.

const fs   = require('fs');
const path = require('path');
const geo  = require('./geo');
const { streetKey, numsOf } = require('./parcels_common');

const UNIT_CAP = Math.max(1, parseInt(process.env.UNIT_CAP, 10) || 6);   // units counted individually; above this a building is one door
const PARCEL_VERSION = 2;   // bump when the parcel record shape/meaning changes so cached sets refetch (2 = cls + suppressors)

// Field policy (env-overridable): what is not a door at all.
//   condos      — condo buildings are skipped ('count' to treat them like any home)
//   aptSkipMin  — apartment buildings with this many units or more (or an
//                 unknown count) are skipped; between the cap and this they
//                 are one flagged door
//   suppress    — vacant / commercial / industrial / garage / parking lots
//                 remove any OSM building drawn on them
const POLICY = {
  condos: (process.env.UNIT_POLICY_CONDOS || 'skip') === 'skip' ? 'skip' : 'count',
  aptSkipMin: Math.max(UNIT_CAP + 1, parseInt(process.env.UNIT_POLICY_APT_SKIP_MIN, 10) || 9),
  suppress: (process.env.UNIT_POLICY_SUPPRESS || 'on') !== 'off',
};
const SUPPRESS_CLS = new Set(['vacant', 'commercial', 'industrial', 'institutional', 'garage', 'parking', 'other']);

// ── Adapter registry ───────────────────────────────────────────────────────
let zipMeta = null;
function metaFor(zip) {
  if (!zipMeta) {
    zipMeta = new Map();
    try {
      for (const r of JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'data', 'master.json'), 'utf8')))
        if (r.zip) zipMeta.set(/^\d{1,5}$/.test(String(r.zip)) ? String(r.zip).padStart(5, '0') : String(r.zip), { state: r.state, county: r.county, city: r.primary_city, municipality: r.municipality, households: +r.households || null });
    } catch (e) { console.error(`[parcels] master.json: ${e.message}`); }
  }
  return zipMeta.get(zip) || null;
}

const loaded = new Map();
function load(name) {
  if (!loaded.has(name)) {
    try { loaded.set(name, require(path.join(__dirname, 'parcels', name + '.js'))); }
    catch (e) { console.warn(`[parcels] adapter ${name}: ${e.message}`); loaded.set(name, null); }
  }
  return loaded.get(name);
}

// Which adapter covers a ZIP. Null = no assessor source (OSM hints only).
function adapterNameFor(zip, meta) {
  const st = (meta?.state || '').toUpperCase(), county = (meta?.county || '').toLowerCase();
  const z3 = zip.slice(0, 3);
  if (st === 'MA') return 'massgis';
  if (st === 'RI') return (/^0290[1-9]$|^02912$|^02940$/.test(zip) || zip === '02910' || zip === '02911') ? 'pvd-cama' : 'ri-e911';
  if (st === 'CT') return 'ct-cama';
  if (st === 'NY') return /^(10[0-4]|11[0-4]|116)$/.test(z3) ? 'nyc-pluto' : (county.startsWith('nassau') ? null : 'nys-parcels');
  if (st === 'OH') {
    if (county.startsWith('cuyahoga')) return 'cuyahoga';
    if (county.startsWith('franklin')) return 'franklin';
    if (county.startsWith('delaware')) return 'delaware';
    return 'ogrip';
  }
  return null;
}

// Fetch + normalise the residential parcels of a ZIP. Throws on a source
// failure (callers fall back to OSM hints); returns null when no adapter.
async function fetchZipParcels(zip, geometry) {
  const meta = metaFor(zip);
  const name = adapterNameFor(zip, meta);
  if (!name) return null;
  const adapter = load(name);
  if (!adapter) return null;
  const polys = geo.polysOf(geometry);
  const rings = geo.outerRings(geometry);
  const hull = geo.convexHull(rings.flat());
  const envelope = geo.bboxOf(rings);
  const t0 = Date.now();
  let raw = await adapter.fetch(zip, { hull, envelope, polys, rings, meta });
  if (!Array.isArray(raw)) raw = [];
  // Keep what lies inside the ZIP (the hull over-fetches); a boundary
  // parcel whose building sits inside still joins by address later.
  const parcels = [];
  for (const p of raw) {
    if (!p || p.lat == null || p.lng == null) continue;
    const u = Math.max(0, Math.round(+p.u || 0));
    const cls = p.cls || (u >= 1 ? (p.big ? 'apt' : 'res') : 'other');
    if (u < 1 && !SUPPRESS_CLS.has(cls)) continue;                    // nothing to count, nothing to suppress
    if (u < 1 && !p.ring) continue;                                    // a suppressor needs a footprint to suppress with
    if (!geo.ptInPolys(p.lat, p.lng, polys) && !(p.ring && p.ring.some(([la, ln]) => geo.ptInPolys(la, ln, polys)))) continue;
    parcels.push({
      id: String(p.id ?? parcels.length), lat: +p.lat, lng: +p.lng, ring: p.ring || null,
      nums: (p.nums || []).map(String), street: p.street ? streetKey(p.street) : '',
      u, cls, kind: String(p.kind ?? ''), approx: !!p.approx, big: !!p.big, bldgs: Math.max(1, p.bldgs | 0),
    });
  }
  return { source: name, pv: PARCEL_VERSION, attribution: adapter.attribution || '', rollNote: adapter.rollNote || '', fetchedAt: new Date().toISOString(), ms: Date.now() - t0, raw: raw.length, parcels };
}

// ── The join ───────────────────────────────────────────────────────────────
// doors: [{lat,lng,num,street,numbered,areaM2}] (OSM buildings/address points, before snapping)
// Mutates doors (adds u / big / approx / src), may append parcel-only doors,
// returns stats. `P` is the graph's metre projector, `snapDist(lat,lng)`
// gives the distance to the nearest walkable street (or Infinity).
function applyUnits(doors, allParcels, { P, snapDist, countUnnumbered = false, unitCap = UNIT_CAP, inZip = null, policy = POLICY, bizOut = null, bigOut = null } = {}) {
  const stats = { unitsSource: null, unitCap, policy: { ...policy }, matched: { addr: 0, contain: 0, nearest: 0, parcelOnly: 0, unmatched: 0 }, multi: { two: 0, three: 0, fourToCap: 0 }, big: 0, skipped: { condo: 0, apt: 0, nonres: 0 }, units: 0, buildings: 0, unmatchedStreets: [] };
  if (!allParcels || !allParcels.length) {
    // No assessor source: OSM hints are all there is, and the field policy
    // still applies to what they flag (a 30-unit block is not 30 knocks).
    const kept = [];
    for (const d of doors) {
      if (!d.u && d.hint) { d.u = d.hint.u; if (d.hint.approx) d.approx = true; }
      if (d.u >= policy.aptSkipMin) d.big = true;
      const why = skipByPolicy({ ...d, u: d.u || 1 }, policy);
      if (why) { if (!inZip || inZip(d.lat, d.lng)) { stats.skipped[why]++; if (bigOut && (d.big || (d.u || 1) > 4)) bigOut.push({ lat: d.lat, lng: d.lng }); } continue; }
      d.u = d.u || 1; kept.push(d);
    }
    doors.length = 0; doors.push(...kept);
    finish(doors, stats, unitCap, policy, inZip); return stats;
  }
  // Homes join; suppressors only take doors away.
  const parcels = allParcels.filter(p => p.u >= 1);
  // Businesses along the streets (commercial and industrial lots), for the
  // caller to count per block: a main road lined with shops isn't a route.
  if (bizOut) for (const p of allParcels) if (p.u < 1 && (p.cls === 'commercial' || p.cls === 'industrial') && (!inZip || inZip(p.lat, p.lng))) bizOut.push({ lat: p.lat, lng: p.lng });
  const suppressors = policy.suppress ? allParcels.filter(p => p.u < 1 && p.ring) : [];
  const consumed = new Set();
  const dXY = doors.map(d => P.toXY(d.lat, d.lng));
  // A matched door inherits the lot's class so the policy can act on it.
  const inherit = (d, p) => { if (p.big) d.big = true; if (p.approx) d.approx = true; if (!d.cls || d.cls === 'res') d.cls = p.cls; };

  // Step 1 — address match
  const byKey = new Map();
  for (const p of parcels) if (p.street) for (const n of p.nums) { const k = `${n}|${p.street}`; (byKey.get(k) || byKey.set(k, []).get(k)).push(p); }
  const unmatchedKeys = new Map();
  doors.forEach((d, i) => {
    if (!d.num || !d.street) return;
    const sk = streetKey(d.street);
    let sum = 0, hit = false;
    for (const n of numsOf(d.num)) {
      for (const p of byKey.get(`${n}|${sk}`) || []) {
        if (consumed.has(p.id)) continue;
        const pxy = P.toXY(p.lat, p.lng);
        if (Math.hypot(pxy.x - dXY[i].x, pxy.y - dXY[i].y) > 60 && !(p.ring && geo.ptInRing(d.lat, d.lng, p.ring))) continue;
        consumed.add(p.id); sum += p.u; hit = true;
        inherit(d, p);
      }
    }
    if (hit) { d.u = sum; d.src = 'addr'; stats.matched.addr++; }
    else unmatchedKeys.set(sk, (unmatchedKeys.get(sk) || 0) + 1);
  });

  // Step 2 — containment: every unconsumed ring that holds a door point
  const grid = new geo.Grid(60);
  const pXY = new Map();
  for (const p of parcels) { const xy = P.toXY(p.lat, p.lng); pXY.set(p.id, xy); grid.add(xy.x, xy.y, p); }
  const holders = new Map();   // parcel id → door indexes inside its ring
  doors.forEach((d, i) => {
    if (d.u) return;
    for (const p of grid.near(dXY[i].x, dXY[i].y, 120)) {
      if (consumed.has(p.id) || !p.ring) continue;
      if (geo.ptInRing(d.lat, d.lng, p.ring)) (holders.get(p.id) || holders.set(p.id, []).get(p.id)).push(i);
    }
  });
  const dropped = new Set();
  for (const [pid, idxs] of holders) {
    const p = parcels.find(x => x.id === pid);
    consumed.add(pid);
    const k = idxs.length;
    if (k === 1) { const d = doors[idxs[0]]; d.u = (d.u || 0) + p.u; inherit(d, p); d.src = d.src || 'contain'; continue; }
    // Step 4 — one lot, several buildings
    const byArea = idxs.slice().sort((a, b) => (doors[b].areaM2 || 0) - (doors[a].areaM2 || 0));
    if (p.bldgs > 1 || p.u >= k) {
      const each = Math.floor(p.u / k); let rem = p.u - each * k;
      for (const i of byArea) { doors[i].u = (doors[i].u || 0) + each + (rem-- > 0 ? 1 : 0); doors[i].src = doors[i].src || 'contain'; inherit(doors[i], p); }
    } else {
      // fewer units than buildings: the biggest is the house, the rest are outbuildings
      doors[byArea[0]].u = (doors[byArea[0]].u || 0) + p.u; doors[byArea[0]].src = doors[byArea[0]].src || 'contain';
      inherit(doors[byArea[0]], p);
      for (const i of byArea.slice(1)) { if (countUnnumbered && !doors[i].numbered) dropped.add(i); }   // the rest stay unset: steps 6–7 decide
    }
  }
  stats.matched.contain = [...holders.values()].flat().filter(i => doors[i].src === 'contain').length;

  // Step 3 — nearest (≤ 25 m, mutual)
  const doorGrid = new geo.Grid(50);
  doors.forEach((d, i) => { if (!dropped.has(i)) doorGrid.add(dXY[i].x, dXY[i].y, i); });
  for (const p of parcels) {
    if (consumed.has(p.id)) continue;
    const pxy = pXY.get(p.id);
    let best = -1, bd = 25;
    for (const i of doorGrid.near(pxy.x, pxy.y, 25)) { const dd = Math.hypot(dXY[i].x - pxy.x, dXY[i].y - pxy.y); if (dd < bd) { bd = dd; best = i; } }
    if (best < 0 || doors[best].u) continue;
    // mutual: is this parcel the nearest parcel to that door?
    let nearestP = null, nd = Infinity;
    for (const q of grid.near(dXY[best].x, dXY[best].y, 60)) { const qxy = pXY.get(q.id); const dd = Math.hypot(qxy.x - dXY[best].x, qxy.y - dXY[best].y); if (dd < nd) { nd = dd; nearestP = q; } }
    if (nearestP !== p) continue;
    consumed.add(p.id); doors[best].u = p.u; doors[best].src = 'nearest'; inherit(doors[best], p);
    stats.matched.nearest++;
  }

  // Step 5 — parcel-only doors: a lot on the roll with no building drawn
  for (const p of parcels) {
    if (consumed.has(p.id)) continue;
    if (skipByPolicy(p, policy)) continue;                             // never conjure a door the policy would skip
    const pxy = pXY.get(p.id);
    if (doorGrid.near(pxy.x, pxy.y, 15).some(i => Math.hypot(dXY[i].x - pxy.x, dXY[i].y - pxy.y) <= 15)) continue;
    // Put the door where the lot meets the street: the ring vertex (or the
    // centroid) nearest a walkable street — a deep lot's centroid can be
    // 70 m from the road.
    let at = [p.lat, p.lng], bestD = snapDist ? snapDist(p.lat, p.lng) : 0;
    if (snapDist && p.ring) for (const [la, ln] of p.ring) { const dd = snapDist(la, ln); if (dd < bestD) { bestD = dd; at = [la, ln]; } }
    if (bestD === Infinity) continue;
    doors.push({ lat: at[0], lng: at[1], num: p.nums[0] || '', street: p.street, numbered: !!p.nums.length, areaM2: 0, u: p.u, cls: p.cls, big: p.big, approx: p.approx, src: 'parcel' });
    consumed.add(p.id); stats.matched.parcelOnly++;
  }

  // Step 6 — duplicates, defaults, drops. OSM often has both a building
  // outline and an address point for one house: the one that matched the
  // lot by address is the door; the other, sitting inside that same lot
  // within 30 m, is the same house drawn twice.
  const matchedByAddr = new Map();   // parcel id → door index it matched
  doors.forEach((d, i) => { if (d.src === 'addr') for (const n of numsOf(d.num)) for (const p of byKey.get(`${n}|${streetKey(d.street)}`) || []) if (consumed.has(p.id)) matchedByAddr.set(p.id, i); });
  doors.forEach((d, i) => {
    if (d.u || dropped.has(i)) return;
    for (const p of grid.near(dXY[i].x, dXY[i].y, 120)) {
      const j = matchedByAddr.get(p.id);
      if (j == null || j === i || !p.ring || !geo.ptInRing(d.lat, d.lng, p.ring)) continue;
      if (Math.hypot(dXY[j].x - dXY[i].x, dXY[j].y - dXY[i].y) <= 30) { dropped.add(i); stats.matched.duplicate = (stats.matched.duplicate || 0) + 1; break; }
    }
  });
  // Step 7 — suppressors: a building with no home behind it (drawn on a
  // vacant, commercial, garage … lot) is not a door.
  if (suppressors.length) {
    const sGrid = new geo.Grid(60);
    for (const p of suppressors) { const xy = P.toXY(p.lat, p.lng); sGrid.add(xy.x, xy.y, p); }
    doors.forEach((d, i) => {
      if (d.u || dropped.has(i)) return;
      for (const p of sGrid.near(dXY[i].x, dXY[i].y, 150)) {
        if (geo.ptInRing(d.lat, d.lng, p.ring)) { dropped.add(i); if (!inZip || inZip(d.lat, d.lng)) stats.skipped.nonres++; break; }
      }
    });
  }
  // Step 8 — policy: condo buildings and big apartment blocks are not doors
  doors.forEach((d, i) => {
    if (dropped.has(i) || !d.u) return;
    const why = skipByPolicy(d, policy);
    if (why) { dropped.add(i); if (!inZip || inZip(d.lat, d.lng)) { stats.skipped[why]++; if (bigOut && (d.big || d.u > 4)) bigOut.push({ lat: d.lat, lng: d.lng }); } }   // a condo triple-decker isn't a big building
  });
  if (dropped.size) { const keep = doors.filter((_, i) => !dropped.has(i)); doors.length = 0; doors.push(...keep); }
  for (const d of doors) if (!d.u && d.hint) { d.u = d.hint.u; if (d.hint.approx) d.approx = true; if (d.u >= policy.aptSkipMin) d.big = true; }
  for (const d of doors) if (!d.u) { d.u = 1; if (!inZip || inZip(d.lat, d.lng)) stats.matched.unmatched++; }
  stats.unmatchedStreets = [...unmatchedKeys.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, n]) => `${k} (${n})`);
  finish(doors, stats, unitCap, policy, inZip);
  return stats;
}

// 'condo' | 'apt' | null — why the field policy would not knock here.
function skipByPolicy(x, policy) {
  if (policy.condos === 'skip' && x.cls === 'condo') return 'condo';
  if (x.big) return 'apt';                        // count unknown or banded above the cap: a block, not a home
  if (x.u >= policy.aptSkipMin) return 'apt';
  return null;
}

// Apply the cap and tally. Above the cap a building is one door and flagged.
// The tally covers the ZIP's own doors: the fetch box also holds buildings
// past the boundary, and those never reach a route.
function finish(doors, stats, unitCap, policy = POLICY, inZip = null) {
  for (const d of doors) {
    // An adapter's big=true means "apartment block, count unknown or banded":
    // one door whatever the band floor. An exact count above the cap is one
    // door too, with the real number kept for the drawer.
    if (d.big) { if (d.u > 1) d.bigUnits = d.u; d.u = 1; }
    else if (d.u > unitCap) { d.bigUnits = d.u; d.u = 1; d.big = true; }
    if (inZip && !inZip(d.lat, d.lng)) continue;
    if (d.big) stats.big++;
    stats.buildings++; stats.units += d.u;
    if (d.u === 2) stats.multi.two++; else if (d.u === 3) stats.multi.three++; else if (d.u >= 4) stats.multi.fourToCap++;
  }
}

module.exports = { fetchZipParcels, applyUnits, adapterNameFor, metaFor, UNIT_CAP, POLICY, SUPPRESS_CLS, PARCEL_VERSION };
