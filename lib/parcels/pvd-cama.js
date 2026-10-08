'use strict';
// Providence, RI — city parcel polygons joined to the assessor's CAMA roll
// (Parcels_with_CAMA, AGOL). Every CAMA figure is a string. A condo is one
// row per unit stacked on the same lot polygon (MAP_PAR_ID), and a spatial
// query can hand back a multi-polygon lot twice under one PROPID.
//
// Two kinds of record come back. A HOME (u ≥ 1) for the residential use
// codes, with its class: 01/02 res, 03 apt, 04 mixed, 23 condo, 12/71/78/80
// apt (public / subsidised housing, only when the roll counts units). A
// SUPPRESSOR (u = 0, ring) for every other coded lot — vacant, commercial,
// industrial, institutional … — so an OSM building drawn on one of them is
// not a door. Rows with no MuniUseCode at all are neither: they stay out.
//
// The layer covers Providence only, but parcels.js routes ZIPs that straddle
// the city line here too (02910 Cranston, 02911 North Providence, and the
// 0290x ZIPs that spill into Johnston / Pawtucket). Those slivers get the
// RI E-911 class floors instead of nothing: the E-911 points are fetched
// alongside and kept only where the E-911 municipality is not Providence.

const { arcgisAll, ringInfo, ringArea, int, str, splitAddress } = require('../parcels_common');
const { slimRing } = require('./_ring');
const e911 = require('./ri-e911');

const URL = 'https://services6.arcgis.com/wv9mHoqblhTsnqdG/arcgis/rest/services/Parcels_with_CAMA/FeatureServer/0/query';
const RES_CODES = new Set(['01', '02', '03', '04', '23', '12', '71', '78', '80']);
// Every coded parcel polygon: homes and suppressors alike (ROW / WATER /
// OTHER polygons and uncoded lots are not lots anyone knocks or suppresses with).
const WHERE = "(POLY_TYPE='PARCEL' OR POLY_TYPE IS NULL) AND MuniUseCode IS NOT NULL";
const FIELDS = ['OBJECTID', 'PROPID', 'MAP_PAR_ID', 'ParcAddress', 'ZIP_POSTAL', 'MuniUseCode', 'NumBldgs', 'NumUnits', 'UnitNum', 'TaxRollYear'];

// MuniUseCode → normalised class (from the layer's MuniUseCodeDesc domain).
const CLS = {
  '01': 'res', '02': 'res',                                   // Single Family, 2-5 Family
  '03': 'apt',                                                // Apartments
  '04': 'mixed',                                              // Combination
  '23': 'condo',                                              // Residential Condo
  '12': 'apt', '71': 'apt', '78': 'apt', '80': 'apt',         // Other Improved Land, Charitable, Municipal, State — housing when the roll counts units
  '05': 'commercial', '06': 'commercial',                     // Commercial I / II
  '24': 'commercial',                                         // Commercial Condo (one row per unit, like 23)
  '83': 'commercial',                                         // TSA — tax-stabilised developments
  '07': 'industrial', '10': 'industrial', '84': 'industrial', // Industrial, Utility and RR, RR
  '13': 'vacant', '14': 'vacant',                             // Residential Vacant, Commercial Ind Vct
  '72': 'institutional', '73': 'institutional', '74': 'institutional', '75': 'institutional',   // Church, Exempt by Charter, Federal, Hospital
  '76': 'institutional', '79': 'institutional', '82': 'institutional',                          // Library, School, Vote of City
  '33': 'other', '70': 'other',                               // Farm Forest, Cemeteries
};
// A 12/71/78/80 lot the roll gives no unit count for is not housing: the
// city building, church hall or state lot the code was really about.
const NO_UNITS_CLS = { '12': 'other', '71': 'institutional', '78': 'institutional', '80': 'institutional' };

let rollNote = 'Providence assessor CAMA roll 2024 (parcel layer last edited 2025-05-30)';

// Door rule per use code → { u, approx, big } or null to drop. A '23' condo
// row is handled by the caller (one unit per row).
function unitsFor(code, numUnits) {
  const n = int(numUnits);
  switch (code) {
    case '01': return { u: Math.max(1, n), approx: false, big: false };
    case '02': return { u: Math.max(2, n), approx: false, big: false };            // "2-5 Family": 98 rows say "1", the class says ≥ 2
    case '03': return n ? { u: n, approx: false, big: false } : { u: 1, approx: true, big: true };   // count unknown: the class starts at 6, so it is an apartment block — one flagged door (§3), never 6 doors AND the flag
    case '04': return { u: n || 1, approx: true, big: false };                    // mixed use; NumUnits may include the shop
    case '12': case '71': case '78': case '80': return n ? { u: n, approx: false, big: false } : null;   // public / subsidised housing only when the roll counts units
    default: return null;
  }
}

// Suppressor class of a lot that holds no home, or null when the code is a
// residential one that simply gave no units (nothing to suppress with either).
function suppressorCls(code) {
  if (NO_UNITS_CLS[code]) return NO_UNITS_CLS[code];
  if (RES_CODES.has(code)) return null;
  return CLS[code] || 'other';
}

// "532 Example Ave Unit 100" / "… Bldg 501" / "64-66 Sample St" → { nums, street }.
// Only a designator that ends in the row's own UnitNum is stripped: "Unit St"
// is a street in Providence, and streetKey would otherwise drop it.
function addressOf(a) {
  let line = str(a.ParcAddress);
  const unit = str(a.UnitNum);
  if (unit) line = line.replace(new RegExp(`\\s+(unit|bldg|apt|ste|suite|fl|floor|#)\\s*${unit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'), '');
  return splitAddress(line);
}

// Largest |area| among a geometry's rings, for choosing between duplicates.
function areaOf(geometry) {
  const rings = geometry?.rings || [];
  return rings.reduce((m, r) => Math.max(m, Math.abs(ringArea(r))), 0);
}

function mostCommon(values) {
  const n = new Map();
  let best = '', bn = 0;
  for (const v of values) { if (!v) continue; const k = (n.get(v) || 0) + 1; n.set(v, k); if (k > bn) { bn = k; best = v; } }
  return best;
}

async function fetchCama({ hull, envelope }) {
  const opts = { where: WHERE, outFields: FIELDS, pageSize: 2000, maxPages: 40 };
  let feats = await arcgisAll(URL, { ...opts, ring: hull });
  if (!feats.length && envelope) feats = await arcgisAll(URL, { ...opts, envelope });

  // Dedupe on PROPID, keeping the biggest polygon of a lot that came back twice.
  const byProp = new Map();
  const years = [];
  for (const f of feats) {
    const a = f.attributes || {};
    const pid = str(a.PROPID) || `O${a.OBJECTID}`;
    const area = areaOf(f.geometry);
    const cur = byProp.get(pid);
    if (!cur || area > cur.area) byProp.set(pid, { a, geometry: f.geometry, area });
    if (a.TaxRollYear) years.push(str(a.TaxRollYear));
  }
  const year = mostCommon(years);
  if (year) rollNote = `Providence assessor CAMA roll ${year} (parcel layer last edited 2025-05-30)`;

  // Group by lot (MAP_PAR_ID). Unit records — UnitNum set: condo units, the
  // per-unit rows of subsidised housing, a TX/EX split — stack on one lot and
  // become one parcel. A row with no UnitNum describes a whole parcel, so two
  // of them under one lot id (21 and 23 on the same street) are two houses, not one.
  const lots = new Map();
  for (const rec of byProp.values()) {
    const lotId = str(rec.a.MAP_PAR_ID) || str(rec.a.PROPID) || `O${rec.a.OBJECTID}`;
    (lots.get(lotId) || lots.set(lotId, []).get(lotId)).push(rec);
  }
  const groups = [];   // [id, recs]
  for (const [lotId, recs] of lots) {
    const units = recs.filter(r => str(r.a.UnitNum)), whole = recs.filter(r => !str(r.a.UnitNum));
    if (units.length) groups.push([lotId, units]);
    for (const r of whole) groups.push([units.length || whole.length > 1 ? `${lotId}:${str(r.a.PROPID) || r.a.OBJECTID}` : lotId, [r]]);
  }

  const out = [];
  for (const [id, recs] of groups) {
    const condo = recs.some(r => str(r.a.MuniUseCode) === '23');
    let u = 0, approx = false, big = false, kind = condo ? '23' : '', bldgs = 0;
    const members = [];
    for (const r of recs) {
      const code = str(r.a.MuniUseCode);
      // A '23' row is one unit whatever NumUnits says ("1" or "0" — never
      // summed). A unit row under another code on the same lot ('71'
      // Charitable for two of a building's units) goes through its
      // own rule, so the lot is not short of those units; a '71'/'80' row
      // with no count drops as usual.
      const d = code === '23' ? { u: 1, approx: false, big: false } : unitsFor(code, r.a.NumUnits);
      if (!d) continue;
      u += d.u; approx = approx || d.approx; big = big || d.big;
      bldgs = Math.max(bldgs, int(r.a.NumBldgs));   // stacked rows describe the same building(s)
      if (!kind) kind = code;
      members.push(r);
    }

    if (!members.length || !(u >= 1)) {
      // No home on the lot: a suppressor, if the code says what the lot is
      // and the polygon survives slimming (a footprint is what it suppresses with).
      const cls = mostCommon(recs.map(r => suppressorCls(str(r.a.MuniUseCode))));
      if (!cls) continue;
      const geomRec = recs.reduce((b, r) => r.area > b.area ? r : b, recs[0]);
      const info = ringInfo(geomRec.geometry);
      const ring = info?.ring ? slimRing(info.ring) : null;
      if (!ring) continue;
      const ad = addressOf(geomRec.a);
      out.push({ id, lat: info.lat, lng: info.lng, ring, nums: ad.nums, street: ad.street, u: 0, cls, kind: str(geomRec.a.MuniUseCode) });
      continue;
    }

    const geomRec = members.reduce((b, r) => r.area > b.area ? r : b, members[0]);
    const info = ringInfo(geomRec.geometry);
    if (!info) continue;
    const nums = new Set(); const streets = [];
    for (const r of members) { const ad = addressOf(r.a); for (const n of ad.nums) nums.add(n); if (ad.street) streets.push(ad.street); }
    out.push({
      id, lat: info.lat, lng: info.lng, ring: info.ring ? slimRing(info.ring) : null,
      nums: [...nums], street: mostCommon(streets), u, cls: condo ? 'condo' : (CLS[kind] || 'res'), kind, approx, big, bldgs: Math.max(1, bldgs),
    });
  }
  return out;
}

async function fetch(zip, ctx) {
  const [cama, points] = await Promise.all([
    fetchCama(ctx),
    e911.fetch(zip, ctx).catch(e => { console.warn(`[parcels] pvd-cama: E-911 supplement failed: ${e.message}`); return []; }),
  ]);
  // Outside the city line the CAMA layer has nothing; E-911 floors fill in.
  const outside = points.filter(p => p.muni && p.muni !== 'PROVIDENCE');
  for (const p of outside) { p.kind = `e911:${p.kind}`; delete p.muni; }
  return cama.concat(outside);
}

module.exports = {
  name: 'pvd-cama',
  attribution: 'City of Providence GIS / Assessor CAMA (Parcels_with_CAMA); RIGIS / RI E 9-1-1 address points outside the city line',
  get rollNote() { return rollNote; },
  fetch,
};
