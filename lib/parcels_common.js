'use strict';
// Shared plumbing for the assessor/parcel adapters in lib/parcels/*.js:
// a paging ArcGIS REST fetcher, typed-field helpers and the address
// normaliser both sides of the parcel↔OSM join use.

const { USER_AGENT: UA } = require('./settings');

async function postJson(url, params, { timeoutMs = 60_000, retries = 2, backoffMs = 4000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, Accept: 'application/json' },
        body: params.toString(),
        signal: ctrl.signal,
      });
      const txt = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${txt.slice(0, 120)}`);
      const j = JSON.parse(txt);
      if (j.error) throw new Error(`${url.split('/')[2]}: ${j.error.message || JSON.stringify(j.error).slice(0, 120)}`);   // some servers put errors inside HTTP 200
      return j;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise(res => setTimeout(res, backoffMs * (attempt + 1)));
    } finally { clearTimeout(timer); }
  }
  throw lastErr;
}

// Signed area of a [lng,lat] ring — positive = counter-clockwise.
function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return a / 2;
}

// ArcGIS treats a counter-clockwise outer ring as a hole on some servers:
// hand it a closed, clockwise [lng,lat] ring.
function esriRing(latLngRing) {
  let r = latLngRing.map(([lat, lng]) => [lng, lat]);
  if (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1])) r.push(r[0]);
  if (ringArea(r) > 0) r.reverse();
  return r;
}

// Page through an ArcGIS REST layer query. `ring` is a [lat,lng] polygon
// (the ZIP hull); pass `attrOnly` for views that refuse geometry filters and
// filter client-side instead.
async function arcgisAll(url, { where = '1=1', outFields = ['*'], ring = null, envelope = null, oid = 'OBJECTID', pageSize = 2000, geometry = true, attrOnly = false, timeoutMs = 60_000, extra = {}, maxPages = 40 } = {}) {
  const feats = [];
  for (let page = 0; page < maxPages; page++) {
    const offset = page * pageSize;
    const p = new URLSearchParams({
      f: 'json', where, outFields: outFields.join(','),
      returnGeometry: String(geometry), outSR: '4326', geometryPrecision: '6', maxAllowableOffset: '0.00003',
      orderByFields: oid, resultOffset: String(offset), resultRecordCount: String(pageSize),
      ...extra,
    });
    if (!attrOnly) {
      if (ring) {
        p.set('geometry', JSON.stringify({ rings: [esriRing(ring)], spatialReference: { wkid: 4326 } }));
        p.set('geometryType', 'esriGeometryPolygon');
      } else if (envelope) {
        p.set('geometry', JSON.stringify({ xmin: envelope.w, ymin: envelope.s, xmax: envelope.e, ymax: envelope.n, spatialReference: { wkid: 4326 } }));
        p.set('geometryType', 'esriGeometryEnvelope');
      }
      p.set('inSR', '4326'); p.set('spatialRel', 'esriSpatialRelIntersects');
    }
    const j = await postJson(url, p, { timeoutMs });
    const got = j.features || [];
    feats.push(...got);
    if (!j.exceededTransferLimit && got.length < pageSize) break;
    if (!got.length) break;
  }
  return feats;
}

// Typed-field helpers: assessor fields arrive as "3", 3.0, null, 0 …
const int = v => { const n = parseInt(String(v ?? '').trim(), 10); return Number.isFinite(n) && n > 0 ? n : 0; };
const str = v => String(v ?? '').trim();

// Centroid (planar mean of vertices) of an esri polygon geometry, as [lat,lng];
// also returns the outer ring as [lat,lng] rounded to 5 dp.
function ringInfo(geometry) {
  const rings = geometry?.rings || (geometry?.x != null ? null : null);
  if (!rings || !rings.length) {
    if (geometry && geometry.x != null) return { lat: +geometry.y.toFixed(6), lng: +geometry.x.toFixed(6), ring: null };
    return null;
  }
  const outer = rings.reduce((best, r) => Math.abs(ringArea(r)) > Math.abs(ringArea(best)) ? r : best, rings[0]);
  let lat = 0, lng = 0, n = 0;
  for (const [x, y] of outer) { lng += x; lat += y; n++; }
  return { lat: +(lat / n).toFixed(6), lng: +(lng / n).toFixed(6), ring: outer.map(([x, y]) => [+y.toFixed(5), +x.toFixed(5)]) };
}

// ── Address normalisation ──────────────────────────────────────────────────
const SUFFIX = { STREET: 'ST', ST: 'ST', AVENUE: 'AVE', AVE: 'AVE', AV: 'AVE', ROAD: 'RD', RD: 'RD', DRIVE: 'DR', DR: 'DR', LANE: 'LN', LN: 'LN', COURT: 'CT', CT: 'CT', PLACE: 'PL', PL: 'PL', TERRACE: 'TER', TERR: 'TER', TER: 'TER', CIRCLE: 'CIR', CIR: 'CIR', BOULEVARD: 'BLVD', BLVD: 'BLVD', PARKWAY: 'PKWY', PKWY: 'PKWY', HIGHWAY: 'HWY', HWY: 'HWY', SQUARE: 'SQ', SQ: 'SQ', TRAIL: 'TRL', TRL: 'TRL', WAY: 'WAY', PLAZA: 'PLZ', PLZ: 'PLZ', ALLEY: 'ALY', ALY: 'ALY', EXTENSION: 'EXT', EXT: 'EXT', TURNPIKE: 'TPKE', TPKE: 'TPKE', ROW: 'ROW', PATH: 'PATH', PARK: 'PARK', WALK: 'WALK', LOOP: 'LOOP', RUN: 'RUN', HILL: 'HILL', HEIGHTS: 'HTS', HTS: 'HTS', CRESCENT: 'CRES', CRES: 'CRES', GREEN: 'GRN', GRN: 'GRN', COMMONS: 'CMNS', CMNS: 'CMNS', MANOR: 'MNR', MNR: 'MNR', COVE: 'CV', CV: 'CV', POINT: 'PT', PT: 'PT', RIDGE: 'RDG', RDG: 'RDG', VIEW: 'VW', VW: 'VW' };
const DIR = { NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W', NORTHEAST: 'NE', NORTHWEST: 'NW', SOUTHEAST: 'SE', SOUTHWEST: 'SW', N: 'N', S: 'S', E: 'E', W: 'W', NE: 'NE', NW: 'NW', SE: 'SE', SW: 'SW' };
const UNIT_TOKENS = new Set(['APT', 'UNIT', 'STE', 'SUITE', 'FL', 'FLOOR', 'REAR', 'FRONT', 'BSMT', 'LOWER', 'UPPER', '#']);

// 'Example Street' / 'EXAMPLE ST' / 'East 999th Street' / 'EAST 999 STREET' → one key
function streetKey(s) {
  let t = String(s || '').toUpperCase().replace(/[.,'’]/g, '').replace(/#/g, ' # ').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  let toks = t.split(' ');
  // drop a trailing unit designator and whatever follows it
  const ui = toks.findIndex((tok, i) => i > 0 && UNIT_TOKENS.has(tok));
  if (ui > 0) toks = toks.slice(0, ui);
  toks = toks.map(tok => DIR[tok] || tok).map(tok => tok.replace(/^(\d+)(ST|ND|RD|TH)$/, '$1'));
  // a bare unit after the suffix ('EXAMPLE ST 1', 'MAIN ST A') is not part of the street
  while (toks.length > 2 && /^\d+[A-Z]?$|^[A-Z]$/.test(toks[toks.length - 1]) && !DIR[toks[toks.length - 1]] && SUFFIX[toks[toks.length - 2]]) toks.pop();
  if (toks.length > 1) { const last = toks[toks.length - 1]; if (SUFFIX[last]) toks[toks.length - 1] = SUFFIX[last]; }
  // suffix followed by a directional ('MAIN ST N'): keep both, normalised
  if (toks.length > 2) { const pen = toks[toks.length - 2]; if (SUFFIX[pen] && DIR[toks[toks.length - 1]]) toks[toks.length - 2] = SUFFIX[pen]; }
  return toks.join(' ');
}

// '30 32' → ['30','32']; '64-66' → ['64','66'] (never expanded); '32;34' / '67,69' → both;
// '12A' → ['12A','12']; '38 EXAMPLE ST 1' → ['38'] (caller strips street first)
function numsOf(s) {
  const out = [];
  for (const tok of String(s || '').toUpperCase().split(/[\s;,&\/\-–]+/)) {
    if (!/^\d/.test(tok)) continue;
    const clean = tok.replace(/[^0-9A-Z]/g, '');
    if (!clean) continue;
    out.push(clean);
    const digits = clean.replace(/[A-Z]+$/, '');
    if (digits !== clean && digits) out.push(digits);
  }
  return [...new Set(out)];
}

// 'ADDR_NUM' + 'FULL_STR' style pairs → { nums, street }; or a single line
// '154 SAMPLE AV ' → nums ['154'], street 'SAMPLE AVE'
function splitAddress(line) {
  const t = String(line || '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^([\d][\dA-Z\-;,&\/ ]*?)\s+([A-Z].*)$/i);
  if (!m) return { nums: numsOf(t), street: '' };
  // the number part may be '30 32' or '64-66'; the street may end in a unit token
  return { nums: numsOf(m[1]), street: streetKey(m[2]) };
}

module.exports = { UA, postJson, arcgisAll, esriRing, ringArea, ringInfo, int, str, streetKey, numsOf, splitAddress };
