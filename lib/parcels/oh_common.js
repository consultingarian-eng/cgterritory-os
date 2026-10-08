'use strict';
// Shared by the Ohio adapters (cuyahoga, franklin, delaware, ogrip): the DTE
// land-use table Franklin, Delaware and the statewide view all use (homes and
// the vacant / commercial / industrial / institutional lots that suppress a
// building drawn on them), the condo grouping rule, ring trimming, the in-ZIP
// test, and an OID-walk pager for the one server (Franklin) that answers with
// zero features whenever a geometry filter and resultRecordCount arrive in the
// same request. Not an adapter — parcels.js only loads the names
// adapterNameFor() returns.

const geo = require('../geo');
const { postJson, esriRing, ringInfo, str, streetKey, splitAddress } = require('../parcels_common');

const MAX_RING = 12;   // vertices kept per parcel ring (parcels.js stores them)

// ── Addresses ───────────────────────────────────────────────────────────────
// One situs line ('4210 EXAMPLE  PKWY UNIT 112', '3460 - 3476 SAMPLE VALLEY RD',
// 'EXAMPLE DR REAR') → { nums, street }. A line with no house number keeps its
// street (for the parcel-only door's label) and an empty nums. Unit
// designators are left to streetKey(), which drops them only after the first
// street word — 'UPPER CAMBRIDGE WAY' and 'FRONT ST' are street names.
function addrOf(line) {
  const t = str(line).toUpperCase().replace(/\s+/g, ' ').trim();
  if (!t) return { nums: [], street: '' };
  if (/^\d/.test(t)) {
    const a = splitAddress(t);
    a.nums = a.nums.filter(n => n !== '0');   // '0 EXAMPLE BLVD' is an unnumbered lot
    return a;
  }
  return { nums: [], street: streetKey(t) };
}

// Drop a unit clause for callers that need the bare street: a designator with
// its identifier ('UNIT 112', 'APT B', '# 4') anywhere after the first word,
// or a trailing REAR/FRONT/UPPER/LOWER — never those words mid-name.
function stripUnit(line) {
  return str(line).toUpperCase().replace(/\s+/g, ' ').replace(/\s+(UNIT|APT|STE|SUITE|BLDG|FL|FLOOR|#)\s+\S.*$/, '').replace(/\s+(REAR|FRONT|UPPER|LOWER)$/, '').trim();
}

// ── Ohio DTE land-use classes (3 digits) → { u, cls, … }, or null to ignore ──
// Homes (u ≥ 1): 510–519 single family (platted lot / by acreage), 520s
// two-family, 530s three-family, 550–553 condominium unit rows (one row per
// unit; grouped below), 560 mobile home on real estate, 591/592 affordable
// 1/2-unit, 401 apartments 4–19 (count unknown → band floor 4, approx), 402
// 20–39 and 403 40+ (big), 404/431 apartments over retail/office (mixed, big),
// 496 subsidised housing (count unknown, big), 472/473 converted dwelling with
// the apartment upstairs (mixed, 1, approx).
// Suppressors (u = 0, cls names why): a lot that holds no homes, so an OSM
// building drawn on it is not a door — 500–509/599 vacant residential, 300/400
// vacant industrial/commercial, other 3xx industrial, 455 commercial garage,
// 456 parking, 412–414 nursing/retirement, other 4xx commercial, 540 HOA
// land / 555 condo-association holdings or right of way / 556 common area /
// 585 rooming house 'other', 559 condo garages, 6xx–8xx exempt / public
// utility / railroad 'institutional'.
// Ignored (null): 415 mobile home park and 645 metropolitan housing hold
// homes on one lot — a building OSM draws there stays a door; so does every
// other 5xx code, which the DTE rule leaves to the counties (several use them
// for homes); 1xx/2xx agricultural, mineral are not fetched.
function dteRule(code) {
  const c = parseInt(String(code ?? '').trim(), 10);
  if (!Number.isFinite(c)) return null;
  if (c >= 510 && c <= 519) return { u: 1, cls: 'res' };
  if (c >= 520 && c <= 529) return { u: 2, cls: 'res' };
  if (c >= 530 && c <= 539) return { u: 3, cls: 'res' };
  if (c >= 550 && c <= 553) return { u: 1, cls: 'condo', condo: true };
  if (c === 560 || c === 591) return { u: 1, cls: 'res' };
  if (c === 592) return { u: 2, cls: 'res' };
  if (c === 401) return { u: 4, cls: 'apt', approx: true };
  if (c === 402) return { u: 20, cls: 'apt', big: true };
  if (c === 403) return { u: 40, cls: 'apt', big: true };
  if (c === 404 || c === 431) return { u: 7, cls: 'mixed', big: true };
  if (c === 496) return { u: 7, cls: 'apt', big: true };
  if (c === 472 || c === 473) return { u: 1, cls: 'mixed', approx: true };
  // no homes here
  if (c === 300 || c === 400 || (c >= 500 && c <= 509) || c === 599) return { u: 0, cls: 'vacant' };
  if (c === 415 || c === 645) return null;
  if (c === 455 || c === 559) return { u: 0, cls: 'garage' };
  if (c === 456) return { u: 0, cls: 'parking' };
  if (c >= 412 && c <= 414) return { u: 0, cls: 'institutional' };
  if (c === 540 || c === 555 || c === 556 || c === 585) return { u: 0, cls: 'other' };
  // The rest of 5xx is county-custom (the DTE rule defines only 500, 510,
  // 520, 530, 550, 560, 599): Brown's 580, Lawrence's 545, Columbiana's 570
  // are addressed house lots, Lorain's 561–563 manufactured homes. A lot that
  // may hold a home is ignored, never a suppressor.
  if (c >= 500 && c <= 599) return null;
  const cls = familyClass(String(c)[0]);
  return cls ? { u: 0, cls } : null;
}

// The suppressor class a DTE family falls back to, by its leading digit:
// 3 industrial, 4 commercial, 5 other (Cuyahoga's own 5xxx table, which is
// fully enumerated; dteRule never reaches it for 5xx), 6–8 institutional
// (exempt, public utility, railroad). Null for agricultural 1xx and mineral 2xx.
function familyClass(digit) {
  return { 3: 'industrial', 4: 'commercial', 5: 'other', 6: 'institutional', 7: 'institutional', 8: 'institutional' }[digit] || null;
}

// The class families dteRule() answers, as a WHERE clause on `field`: the
// dwelling families (4xx/5xx) plus the lots that suppress (3xx, 6xx–8xx).
function dteWhere(field) {
  return ['3', '4', '5', '6', '7', '8'].map(d => `${field} LIKE '${d}%'`).join(' OR ');
}

// A suppressor record: the lot's footprint and class, no units. parcels.js
// drops one without a ring (there is nothing to suppress with).
function suppressor(row, cls) {
  return { ...row, u: 0, cls, approx: false, big: false, bldgs: 1 };
}

// ── Geometry ────────────────────────────────────────────────────────────────
// Drop, one at a time, the vertex whose removal changes the area least until
// the ring has at most MAX_RING points (closing point included).
function trimRing(ring) {
  if (!ring || ring.length <= MAX_RING) return ring || null;
  const closed = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  const pts = closed ? ring.slice(0, -1) : ring.slice();
  const tri = (a, b, c) => Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]));
  const keep = MAX_RING - (closed ? 1 : 0);
  while (pts.length > keep) {
    let worst = -1, min = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const a = tri(pts[(i + pts.length - 1) % pts.length], pts[i], pts[(i + 1) % pts.length]);
      if (a < min) { min = a; worst = i; }
    }
    pts.splice(worst, 1);
  }
  if (closed) pts.push(pts[0]);
  return pts;
}

// Esri geometry → { lat, lng, ring } (5 dp ring, ≤ MAX_RING points) or null.
function shape(geometry) {
  const s = ringInfo(geometry);
  if (!s) return null;
  return { lat: s.lat, lng: s.lng, ring: trimRing(s.ring) };
}

// The same test parcels.js applies: centroid inside the ZIP, or any ring
// vertex inside (a boundary lot whose house sits inside still joins).
function inZip(s, polys) {
  if (!s) return false;
  if (geo.ptInPolys(s.lat, s.lng, polys)) return true;
  return !!(s.ring && s.ring.some(([la, ln]) => geo.ptInPolys(la, ln, polys)));
}

// A tax parcel drawn as several features (Delaware's apartment complexes are
// one PARCEL_NO with a polygon per building) must still give each polygon its
// own id: parcels.js consumes parcels by id.
function uniqueIds() {
  const seen = new Set();
  let dups = 0;
  return {
    get dups() { return dups; },
    take(id, oid) { let k = String(id); if (seen.has(k)) { dups++; k = `${k}#${oid}`; } seen.add(k); return k; },
  };
}

// ── Condo grouping ──────────────────────────────────────────────────────────
// One row per unit → one parcel per building. The building key is the condo
// complex (when the source names one) plus the street number: a tower's 500
// units share one number, a townhouse row has one number per door. Without a
// number (Lorain publishes no addresses; some complexes list none) the key is
// the ring's centroid to 4 dp, which merges stacked identical footprints and
// keeps separate buildings apart. Without a complex name the street is part of
// the key so two complexes on different streets with the same number stay
// apart. rows: { id, lat, lng, ring, nums, street, kind, complex }.
function groupCondos(rows) {
  const groups = new Map();
  for (const r of rows) {
    const cx = r.complex ? `c:${r.complex.toUpperCase().replace(/\s+/g, ' ').trim()}` : 'r';
    const key = r.nums.length
      ? `${cx}|${r.nums.join(',')}|${r.complex ? '' : r.street}`
      : `${cx}|${r.lat.toFixed(4)},${r.lng.toFixed(4)}`;
    let g = groups.get(key);
    if (!g) { g = { rows: [], streets: new Map() }; groups.set(key, g); }
    g.rows.push(r);
    if (r.street) g.streets.set(r.street, (g.streets.get(r.street) || 0) + 1);
  }
  const out = [];
  for (const g of groups.values()) {
    const rows = g.rows, n = rows.length;
    let lat = 0, lng = 0, ring = null, ringArea = -1;
    const nums = new Set();
    for (const r of rows) {
      lat += r.lat; lng += r.lng;
      for (const x of r.nums) nums.add(x);
      if (r.ring) { const a = approxArea(r.ring); if (a > ringArea) { ringArea = a; ring = r.ring; } }
    }
    const street = [...g.streets.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || rows[0].street || '';
    out.push({
      id: n > 1 ? `${rows[0].id}+${n - 1}` : String(rows[0].id),
      lat: +(lat / n).toFixed(6), lng: +(lng / n).toFixed(6), ring,
      nums: [...nums], street, u: n, cls: 'condo', kind: rows[0].kind, approx: false, big: false, bldgs: 1,
    });
  }
  return out;
}

function approxArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][1] + ring[i][1]) * (ring[j][0] - ring[i][0]);
  return Math.abs(a / 2);
}

// ── OID-walk pager ──────────────────────────────────────────────────────────
// For a server that honours a polygon filter only when no resultRecordCount /
// resultOffset is present: each request returns the server's maxRecordCount
// features ordered by OID, and the next asks for OID > the last one seen.
async function oidWalk(url, { where = '1=1', outFields = ['*'], ring, oid = 'OBJECTID', maxPages = 40, timeoutMs = 60_000 } = {}) {
  const feats = [];
  let last = -1;
  for (let page = 0; page < maxPages; page++) {
    const p = new URLSearchParams({
      f: 'json', where: `(${where}) AND ${oid} > ${last}`, outFields: outFields.join(','),
      returnGeometry: 'true', outSR: '4326', geometryPrecision: '6', maxAllowableOffset: '0.00003', orderByFields: oid,
      geometry: JSON.stringify({ rings: [esriRing(ring)], spatialReference: { wkid: 4326 } }),
      geometryType: 'esriGeometryPolygon', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
    });
    const j = await postJson(url, p, { timeoutMs });
    const got = j.features || [];
    feats.push(...got);
    if (!got.length || !j.exceededTransferLimit) break;
    let max = last;
    for (const f of got) { const v = +f.attributes[oid]; if (v > max) max = v; }
    if (max <= last) break;   // no progress: never loop on the same page
    last = max;
  }
  return feats;
}

module.exports = { MAX_RING, dteRule, familyClass, dteWhere, suppressor, addrOf, stripUnit, trimRing, shape, inZip, uniqueIds, groupCondos, oidWalk };
