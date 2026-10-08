'use strict';
// Massachusetts — MassGIS L3 parcels joined to the assessing extract, one
// statewide service that covers all 351 towns including Boston.
//
// Condo units arrive as stacked duplicate polygons sharing a LOC_ID: a 995
// "condo main" row (UNITS filled in Boston, often 0 in Medford) plus one
// 102/1021/1020 row per unit. Grouping by LOC_ID first is what stops a
// six-unit building becoming seven parcels. Outside condos the towns are
// inconsistent about UNITS (Malden fills it, Medford writes 0, Boston
// leaves it null) so the use code carries the count when UNITS is empty.
//
// Returns the raw count; parcels.js applies UNIT_CAP. `big` here means only
// "apartment block, count unknown" (112/113/114/121/125 without UNITS).
//
// Every parcel carries a normalised `cls` (see clsOf). Lots that hold no
// home — vacant land, shops, factories, exempt/institutional, parking — come
// back too, as SUPPRESSORS: u = 0 with the ring kept, so parcels.js can
// remove an OSM building drawn on one of them. A lot that might still hold
// a home but gives no count (a mixed-use or apartment row with UNITS empty,
// a condo main with no unit rows, an exempt lot whose STYLE is a house) is
// not returned: never a door, never a suppressor.

const { arcgisAll, ringInfo, int, str, numsOf, streetKey } = require('../parcels_common');

const URL = 'https://arcgisserver.digital.mass.gov/arcgisserver/rest/services/AGOL/L3_Parcels_FeatureService_4326/FeatureServer/1/query';
const FIELDS = ['OBJECTID', 'LOC_ID', 'PROP_ID', 'SITE_ADDR', 'ADDR_NUM', 'FULL_STR', 'CITY', 'ZIP', 'USE_CODE', 'UNITS', 'STYLE', 'STORIES', 'TOWN_ID', 'POLY_TYPE', 'FY'];
const MAX_RING = 12;   // vertices kept per ring, closing vertex included

// ── Use-code rule (3-char class; Medford-style 4-char codes are sliced) ────
// Land classes that never hold a dwelling even when a town types a UNITS
// value on them (accessory land, vacant lots, developable land).
const NON_DWELLING = new Set(['106', '108', '130', '131', '132', '996']);
const UNKNOWN_BIG  = new Set(['112', '113', '114', '120', '121', '125', '126', '127']);   // apartment blocks with no count (120/126/127: Boston "APT 7-30", luxury, subsidised)

// Does a UNITS value on this class mean dwelling units? 1xx residential,
// 013/031 mixed use, 995 condo main, or a row with no code at all.
function trustsUnits(c3) {
  if (NON_DWELLING.has(c3)) return false;
  return /^1\d\d$/.test(c3) || c3 === '013' || c3 === '031' || c3 === '995' || c3 === '';
}

// One non-condo row → { u, approx, big } or null (not a dwelling).
function rowUnits(row) {
  if (row.c3 === '102' && !isCondoUnit(row)) return null;   // parking space / vacant condo record
  if (row.units > 0 && trustsUnits(row.c3)) return { u: row.units, approx: false, big: false };
  switch (row.c3) {
    case '101': case '103': return { u: 1, approx: false, big: false };
    case '104': return { u: 2, approx: false, big: false };
    case '105': return { u: 3, approx: false, big: false };
    case '109': return { u: 2, approx: true, big: false };    // multiple houses on one lot
    case '111': return { u: 4, approx: true, big: false };    // "APT 4-8" band: floor
    case '013': return { u: 2, approx: true, big: false };    // mixed use, primarily residential
    default:
      if (UNKNOWN_BIG.has(row.c3)) return { u: 1, approx: false, big: true };
      return null;
  }
}

// A condo unit row: 102, Medford 1021, Somerville 1020 — but not the alpha
// suffixed 102P (parking space) / 102V (vacant) records.
const isCondoUnit = row => row.c3 === '102' && !/[A-Z]$/i.test(row.code);

// ── Class rule ─────────────────────────────────────────────────────────────
// DOR use code → the normalised class parcels.js keys its policy on. The
// count rule above decides whether a lot is a home; this decides what kind
// of lot it is. 111 (4–8 units) is 'apt' even though it counts as four
// doors: it is an apartment building. Boston's 120s (rooming houses,
// "APT 7-30", subsidised housing) are apartments too.
const APT = /^11[1-4]$|^12\d$/;
const SUPPRESS = new Set(['vacant', 'commercial', 'industrial', 'institutional', 'garage', 'parking', 'other']);
// Medford/Somerville write mixed-use homes as 0101 / 0104 / 0105 / 0109 /
// 0111 / 0112 ("2 Family", "3 Family", "Apartments" with something else on
// the lot): the home behind the leading 0 is what gets counted.
function resC3(code) {
  return /^01(0[1459]|1[12])/.test(code) ? code.slice(1, 4) : code.slice(0, 3);
}

function clsOf(c3) {
  if (c3 === '102' || c3 === '995') return 'condo';
  if (c3 === '013' || c3 === '031') return 'mixed';
  if (c3 === '996') return 'other';                                          // condo common land
  if (c3 === '108') return 'parking';                                        // Boston: deeded parking spaces
  if (c3 === '106' || c3 === '130' || c3 === '131' || c3 === '132') return 'vacant';   // accessory / developable / undevelopable land
  if (APT.test(c3)) return 'apt';
  if (/^1\d\d$/.test(c3) || c3 === '' || c3 === '908') return 'res';        // 908: Boston's housing-authority two-family stacks and town houses — homes, no count
  if (c3[0] === '0') return 'mixed';                                         // 01x res + something, 03x/04x commercial/industrial primary
  if (c3[0] === '3') return 'commercial';
  if (c3[0] === '4') return 'industrial';
  if (c3[0] === '9') return 'institutional';                                 // government, church, school, charitable
  if (c3[0] === '6' || c3[0] === '7' || c3[0] === '8') return 'other';       // chapter 61/61A/61B land (a farmhouse is 018, not 7xx)
  return null;                                                               // 2xx, 5xx: not a lot this rule knows
}

// The class of a lot with no home on it: a suppressor class when every
// classified row is one, null when any row could still hold a home (a
// 031 shop with apartments and no count, a 120 block with UNITS empty).
function suppressorCls(rows) {
  let cls = null;
  for (const r of rows) {
    const c = clsOf(r.c3);
    if (c === null) continue;
    if (!SUPPRESS.has(c)) return null;
    if (!cls) cls = c;
  }
  return cls;
}

// An exempt (9xx) code says who owns the lot — city, church, charity — not
// what stands on it: a 905 lot can be a "Two Fam Stack", a 970 a "Colonial",
// a 906 a "Decker" (triple-decker). A lot like that may well hold a
// home, so it is never a suppressor: it is left alone, as it was before the
// class rule. The vocabulary is Boston's and Medford's; a style this misses
// only leaves that lot suppressed.
const DWELLING_STYLE = /^(CONVENTIONAL|CONVENT[\/`]|COLONIAL|COL\/|COL REV|DECKER|\d[- ]?DECKER|TWO FAM|THREE FAM|\d ?FAM|SEMI[- ]?DET|CAPE|RANCH|RAISED RANCH|DUPLEX|FAMILY DUPLEX|VICTORIAN|ROW ?(HOUSE|MID|END)|BUNGALOW|COTTAGE|TOWN ?HOUSE|SPLIT|TUDOR|CONTEMPOR|MODERN|GARRISON|GAMBREL|MANSARD|OLD STYLE|ANTIQUE|MULTI-(CONV|GRD|GARDEN|TNHS))/i;
const NOT_DWELLING_STYLE = /APT|APARTMENT|ROOMING|DORM|ELDERLY|NURSING|CONDO|RECTORY/i;
const isDwellingStyle = s => DWELLING_STYLE.test(s) && !NOT_DWELLING_STYLE.test(s);

// ── Address ────────────────────────────────────────────────────────────────
const DIR = new Set(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW']);
const UNIT_WORDS = new Set(['UNIT', 'APT', 'STE', 'SUITE', 'FL', 'FLOOR', 'REAR', 'FRONT', 'BSMT', 'GAR']);

// Condo rows carry the unit on the street: 'EXAMPLE ST 1', 'SAMPLE AV UA',
// 'MAPLE TR U', 'RIVER AV GAR #7'. Peel those off; leave 'PARKWAY W'
// (a directional) and two-token streets like 'ROUTE 28' alone.
function stripUnit(s) {
  const toks = str(s).toUpperCase().replace(/\s+/g, ' ').split(' ').filter(Boolean);
  while (toks.length > 1) {
    const t = toks[toks.length - 1], prev = toks[toks.length - 2];
    if (t.startsWith('#')) { toks.pop(); continue; }
    if (UNIT_WORDS.has(t)) { toks.pop(); continue; }
    if (UNIT_WORDS.has(prev) || prev.startsWith('#')) { toks.pop(); toks.pop(); continue; }
    if (/^U[A-Z0-9]{0,2}$/.test(t) && toks.length > 2) { toks.pop(); continue; }
    if ((/^\d+[A-Z]?$/.test(t) || (/^[A-Z]$/.test(t) && !DIR.has(t))) && toks.length > 2) { toks.pop(); continue; }
    break;
  }
  return toks.join(' ');
}

// ── Geometry ───────────────────────────────────────────────────────────────
// maxAllowableOffset already generalises to ~3 m, but an irregular lot can
// still come back with 20–60 vertices. Visvalingam: drop the vertex whose
// triangle with its neighbours is smallest until the ring fits.
function simplifyRing(ring, max = MAX_RING) {
  if (!ring || ring.length <= max) return ring;
  const pts = ring.slice();
  const closed = pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];
  if (closed) pts.pop();
  const limit = closed ? max - 1 : max;
  while (pts.length > limit && pts.length > 3) {
    let bi = 0, ba = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[(i + pts.length - 1) % pts.length], q = pts[i], r = pts[(i + 1) % pts.length];
      const a = Math.abs((q[0] - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (q[1] - p[1]));
      if (a < ba) { ba = a; bi = i; }
    }
    pts.splice(bi, 1);
  }
  if (closed) pts.push(pts[0]);
  return pts;
}

// ── Rows → parcels ─────────────────────────────────────────────────────────
function rowOf(feature) {
  const a = feature.attributes || {};
  const code = str(a.USE_CODE).toUpperCase();
  return {
    oid: a.OBJECTID, loc: str(a.LOC_ID), code, c3: resC3(code), units: int(a.UNITS), style: str(a.STYLE),
    num: str(a.ADDR_NUM), fullStr: str(a.FULL_STR), geometry: feature.geometry || null,
  };
}

// One LOC_ID group → home parcel, suppressor (u = 0) or null.
function groupParcel(loc, rows) {
  let u = 0, approx = false, big = false, bldgs = 1, kind = '', cls = '', main = null;
  const condoRows = rows.filter(isCondoUnit);
  const mains = rows.filter(r => r.c3 === '995');
  const counted = mains.filter(r => r.units > 0).sort((a, b) => b.units - a.units);
  if (counted.length) {
    // condo main carries the count; never also count the unit rows (Boston
    // lists parking spaces as 102 rows too)
    main = counted[0]; u = main.units; kind = main.code; cls = 'condo';
  } else if (condoRows.length) {
    main = mains[0] || condoRows[0]; u = condoRows.length; kind = condoRows[0].code; cls = 'condo';
  } else {
    // one polygon, one or more assessed properties (distinct PROP_IDs): sum
    let n = 0;
    for (const r of rows) {
      const x = rowUnits(r);
      if (!x) continue;
      u += x.u; approx = approx || x.approx; big = big || x.big; n++;
      if (!main) { main = r; kind = r.code; cls = clsOf(r.c3) || 'res'; }
    }
    bldgs = Math.max(1, n);
  }
  const home = u >= 1;
  if (!home) {
    // No home on the lot: a suppressor when every row says so, else nothing.
    cls = suppressorCls(rows);
    if (!cls) return null;
    if (cls === 'institutional' && rows.some(r => isDwellingStyle(r.style))) return null;   // an exempt-owned house
    kind = rows[0].code;
  } else if (big) cls = 'apt';   // a 101 sharing its polygon with a 125 block

  // Address: the street most rows agree on (a corner lot's condo main may say
  // 'R MYSTIC AV U' while its units say 'MYSTIC AV'); numbers from every row
  // on that street. Condo rows get their unit token peeled first.
  const isCondoGroup = condoRows.length > 0 || mains.length > 0;
  const streets = new Map();   // key → { raw, n }
  const rowStreet = new Map();
  for (const r of rows) {
    const raw = isCondoGroup && (isCondoUnit(r) || r.c3 === '995' || /^102/.test(r.c3)) ? stripUnit(r.fullStr) : r.fullStr.replace(/\s+/g, ' ');
    const k = streetKey(raw);
    rowStreet.set(r, k);
    if (!k) continue;
    const e = streets.get(k) || streets.set(k, { raw, n: 0 }).get(k);
    e.n++;
    if (r === main) e.n += 0.5;   // tie → the main row
  }
  let street = '', streetK = '';
  for (const [k, e] of streets) if (!streetK || e.n > streets.get(streetK).n) { streetK = k; street = e.raw; }
  const nums = new Set();
  for (const r of rows) {
    if (streetK && rowStreet.get(r) !== streetK) continue;
    for (const n of numsOf(r.num)) if (!/^0+$/.test(n)) nums.add(n);
  }

  const geomRow = rows.find(r => r.geometry) || main;
  const g = geomRow && geomRow.geometry ? ringInfo(geomRow.geometry) : null;
  if (!g) return null;
  const ring = simplifyRing(g.ring);
  if (!home) {
    if (!ring) return null;   // a suppressor with no footprint suppresses nothing
    return { id: loc, lat: g.lat, lng: g.lng, ring, nums: [...nums], street, u: 0, cls, kind };
  }
  return {
    id: loc, lat: g.lat, lng: g.lng, ring,
    nums: [...nums], street, u, cls, kind, approx, big, bldgs,
  };
}

// Pure: ArcGIS features → parcels. Exported so fixtures can drive the rule.
function normalise(features) {
  const seen = new Set();
  const groups = new Map();
  for (const f of features) {
    const r = rowOf(f);
    if (r.oid != null) { if (seen.has(r.oid)) continue; seen.add(r.oid); }
    const key = r.loc || `OID${r.oid}`;
    (groups.get(key) || groups.set(key, []).get(key)).push(r);
  }
  const out = [];
  for (const [loc, rows] of groups) {
    const p = groupParcel(loc, rows);
    if (p) out.push(p);
  }
  return out;
}

// POLY_TYPE: FEE is the fee-simple lot; TAX is a lot a town assesses without
// a fee polygon of its own (some towns keep hundreds of dwellings that way, 195
// towns do it, none of them share a LOC_ID/PROP_ID with a FEE row). Both are
// lots; ROW/PRIV_ROW/RAIL_ROW/WATER never are. No use-code filter: the
// non-residential lots are wanted too, as suppressors.
const WHERE = "POLY_TYPE IN ('FEE','TAX')";

async function fetch(zip, { hull, envelope }) {
  const opts = { where: WHERE, outFields: FIELDS, pageSize: 2000, maxPages: 50 };
  let feats = await arcgisAll(URL, { ...opts, ring: hull });
  if (!feats.length && envelope) feats = await arcgisAll(URL, { ...opts, envelope });   // a hull the server rejects → envelope
  return normalise(feats);
}

module.exports = {
  name: 'massgis',
  attribution: 'MassGIS (Bureau of Geographic Information), Commonwealth of Massachusetts, EOTSS',
  rollNote: 'MassGIS L3 assessing extract; fiscal year varies by town (Boston FY2023, Medford FY2026)',
  fetch,
  // for tests / fixtures
  normalise, rowUnits, clsOf, isDwellingStyle, stripUnit, simplifyRing,
};
