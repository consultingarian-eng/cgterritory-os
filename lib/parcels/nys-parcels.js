'use strict';
// New York State outside NYC — NYS Tax Parcels Public (ITS GIS / ORPTS),
// Westchester (Yonkers) and the 37 other released counties. No unit field:
// the count comes from the property class plus NBR_KITCHENS.
//
//   K = NBR_KITCHENS (0 when null)
//   210, 250, 283            → 1
//   215, 220                 → max(2, K)
//   230                      → max(3, K)
//   240, 280, 281, 482       → max(2, K), approx
//   411 condo units          → 1 per row, grouped into one parcel per building
//   411 rental block         → big, count unknown
//   481, 483                 → 1, approx (retail below, unknown apartments above)
//
// Condo units are one row each, stacked on the building. In some cities the
// unit designator is in LOC_UNIT for only a minority of the rows: the rest
// have LOC_UNIT null with DUP_GEO='Y' (dozens of identical full-footprint
// rows at one address), or a metre-square placeholder polygon, or the unit
// number folded into LOC_ST_NBR ("130-85 Example Ave"). So a row is a stacked unit when it has a LOC_UNIT (other
// than REAR/FRONT, which name a second house on the lot), DUP_GEO='Y' or a
// placeholder footprint, whatever its class — condo-converted two- and
// three-families carry 210/220/230 rows per unit ("21 Example Pl Unit 1/2/3",
// all 230). Stacked rows are grouped by first street number + street.
//
// The roll usually also carries the building's own lot at the same address
// (the condo's common lot, or the rental building a few units were carved
// out of: an "Example Condominium" lot under its units, an "Example Lofts
// LLC" lot under a few carved-out ones). That lot is the group's footprint, never a unit of
// its own — one parcel per building key, or the join counts the building
// twice. A 411 lot under a group means the roll sees an apartment building
// whose unit rows are only part of the picture: unknown count, big. A house
// class lot under a group (the 230 shell under three 230 units) caps the
// count from below: u = max(unit rows, class count). A 411 row that is
// neither stacked nor under a group is a distinct lot: an unknown-count
// block.
//
// cls — the house classes are res, 411 is apt, 481/482/483 mixed; a group
// built from unit rows (LOC_UNIT or placeholder polygons) is a condo, a
// group of DUP_GEO duplicates alone is not. Every class from 300 up comes
// back too, with u = 0, as a SUPPRESSOR: an OSM building drawn on it is not
// a door. 3xx vacant · 4xx commercial (437/439 garage, 438 parking, 44x
// industrial) · 5xx commercial, 59x parks other · 6xx institutional ·
// 7xx/8xx industrial · 9xx other. Farms (1xx), seasonal and mobile homes
// (26x/27x, 416/417) are neither: homes the rule can't count, never
// suppressors, so they stay out. Non-home rows never join a home group —
// not as a unit, not as its footprint (the parking lot at the condo's
// address is a suppressor of its own, not the condo's ring); stacked
// non-home rows (retail condo units, a duplicated store polygon) fold into
// one suppressor per address on their largest footprint.
//
// Server notes: geometry must be the JSON form (arcgisAll always sends it);
// with a spatial filter this MapServer pages over the spatial-index
// candidates and applies the exact intersect per page, so a page comes back
// short with exceededTransferLimit=true and the boundary OID repeats — keep
// paging and dedupe on OBJECTID. Never the Westchester mirror (it lacks
// LOC_ST_NBR/LOC_STREET). PROP_CLASS is text: `>= '300'` is a string compare
// the server accepts.

const { arcgisAll, ringInfo, int, str, numsOf, streetKey, splitAddress } = require('../parcels_common');
const { slimRing } = require('./_ring');

const URL = 'https://gisservices.its.ny.gov/arcgis/rest/services/NYS_Tax_Parcels_Public/MapServer/1/query';
const FIELDS = ['OBJECTID', 'SWIS_SBL_ID', 'PARCEL_ADDR', 'LOC_ST_NBR', 'LOC_STREET', 'LOC_UNIT', 'LOC_ZIP', 'PROP_CLASS', 'NBR_KITCHENS', 'DUP_GEO', 'CALC_ACRES', 'MUNI_NAME', 'ROLL_YR'];
const PLACEHOLDER_ACRES = 0.001;   // ≈ 4 m²: a condo unit's stand-in polygon, not a lot
const POSITION_UNIT = /^(REAR|FRONT|BACK|SIDE)\b/i;   // a LOC_UNIT that names a second structure on the lot, not a stacked unit
const CLASSES = ['210', '215', '220', '230', '240', '250', '280', '281', '283', '411', '481', '482', '483'];
const WHERE = `PROP_CLASS IN (${CLASSES.map(c => `'${c}'`).join(',')}) OR PROP_CLASS >= '300'`;
const HOME = new Set(['res', 'apt', 'mixed', 'condo']);

function unitsFor(cls, K) {
  switch (cls) {
    case '210': case '250': case '283': return { u: 1, approx: false };
    case '215': case '220':             return { u: Math.max(2, K), approx: false };
    case '230':                         return { u: Math.max(3, K), approx: false };
    case '240': case '280': case '281': case '482': return { u: Math.max(2, K), approx: true };
    case '481': case '483':             return { u: 1, approx: true };
    default: return null;
  }
}

// Normalised class of a roll class (see the header); null = a class the
// adapter says nothing about. Condo is decided by the grouping, not here.
function clsOf(cls) {
  if (cls === '411') return 'apt';
  if (cls === '481' || cls === '482' || cls === '483') return 'mixed';
  if (CLASSES.includes(cls)) return 'res';
  switch (cls.charAt(0)) {
    case '3': return 'vacant';
    case '4':
      if (cls === '416' || cls === '417') return null;      // mobile-home parks, bungalow colonies
      if (cls === '438') return 'parking';
      if (cls === '437' || cls === '439') return 'garage';
      return cls.startsWith('44') ? 'industrial' : 'commercial';   // 44x storage / warehouse / distribution
    case '5': return cls.startsWith('59') ? 'other' : 'commercial';   // parks and playgrounds vs paid recreation
    case '6': return 'institutional';
    case '7': case '8': return 'industrial';
    case '9': return 'other';
    default: return null;
  }
}

// A class-derived count feeding a stacked group: exact and approx floors kept apart.
function feed(g, r) {
  if (!r) return;
  if (r.approx) g.approxU = Math.max(g.approxU, r.u); else g.exactU = Math.max(g.exactU, r.u);
}

// The group's geometry is its largest footprint (the building's lot, not a
// placeholder); kind and cls follow it (a home group's cls is settled again
// once its rows are in, a folded suppressor's stays with its footprint).
function footprint(g, acres, base, cls) {
  if (acres <= g.acres) return;
  g.acres = acres; g.p.id = base.id; g.p.lat = base.lat; g.p.lng = base.lng; g.p.ring = base.ring; g.p.kind = cls; g.p.cls = base.cls;
}

const adapter = {
  name: 'nys-parcels',
  attribution: 'NYS ITS GIS Program Office / Office of Real Property Tax Services, NYS Tax Parcels Public',
  rollNote: 'NYS Tax Parcels',

  async fetch(zip, { hull, envelope }) {
    let feats = await arcgisAll(URL, { where: WHERE, outFields: FIELDS, ring: hull, pageSize: 5000 });
    if (!feats.length && envelope) feats = await arcgisAll(URL, { where: WHERE, outFields: FIELDS, envelope, pageSize: 5000 });

    const seen = new Set();
    const out = [];
    const groups = new Map();   // building key → { p (the grouped parcel, already in out), acres, units, n411, hasUnit, exactU, approxU, parent411, cat, common, first }
    const lots = [];            // home rows with a footprint of their own; resolved after the loop, since one may be the parent lot of a group seen later
    const nonres = new Map();   // key → { p (a suppressor, already in out), acres }: stacked non-home rows folded per address
    for (const f of feats) {
      const a = f.attributes || {};
      if (seen.has(a.OBJECTID)) continue;                 // boundary OID repeats between pages
      seen.add(a.OBJECTID);
      const cls = str(a.PROP_CLASS);
      const cat = clsOf(cls);
      if (!cat) continue;
      const home = HOME.has(cat);
      const ri = ringInfo(f.geometry);
      if (!ri) continue;
      if (a.ROLL_YR && adapter.rollNote === 'NYS Tax Parcels') adapter.rollNote = `NYS Tax Parcels ${a.ROLL_YR} roll`;

      let nums = numsOf(a.LOC_ST_NBR), street = str(a.LOC_STREET);
      if (!nums.length && !street) ({ nums, street } = splitAddress(str(a.PARCEL_ADDR)));
      const id = str(a.SWIS_SBL_ID) || `oid${a.OBJECTID}`;
      const ring = slimRing(ri.ring);
      const base = { id, lat: ri.lat, lng: ri.lng, ring, nums, street, cls: cat, kind: cls, approx: false, big: false, bldgs: 1 };
      const acres = +a.CALC_ACRES || 0;
      const unitTag = str(a.LOC_UNIT);
      const hasUnit = !!unitTag && !POSITION_UNIT.test(unitTag);
      const placeholder = (acres > 0 && acres < PLACEHOLDER_ACRES) || !ring;   // a metre-square stand-in, or one that collapsed at 5 dp
      const stacked = hasUnit || placeholder || str(a.DUP_GEO).toUpperCase() === 'Y';
      if (!home) {   // a lot with no homes on it: a suppressor, never part of a home group
        if (!stacked) { out.push({ ...base, u: 0 }); continue; }
        const key = keyOf(nums, nums.length ? street : '', ri);   // an unnumbered lot must not fold onto every other unnumbered lot of its street
        let s = nonres.get(key);
        if (!s) { s = { p: { ...base, u: 0 }, acres: -1 }; nonres.set(key, s); out.push(s.p); }
        footprint(s, acres, base, cls);
        continue;
      }
      const r = cls === '411' ? null : unitsFor(cls, int(a.NBR_KITCHENS));
      const key = keyOf(nums, street, ri);
      if (!stacked) { lots.push({ key, cls, cat, acres, base, r }); continue; }

      // stacked unit → the building it stands on ("130-85 Example Ave" is unit 85 of 130, so the first number keys it)
      let g = groups.get(key);
      if (!g) { g = { p: { ...base, u: 0 }, acres: -1, units: 0, n411: 0, hasUnit: false, exactU: 0, approxU: 0, parent411: false, cat, common: nums.slice(), first: nums }; groups.set(key, g); out.push(g.p); }
      if (cls === '411') g.n411++;
      else { feed(g, r); if (hasUnit || placeholder) g.units++; }   // a DUP_GEO-only house row is the shell or a duplicate, not a unit of its own
      if (hasUnit) g.hasUnit = true;
      g.common = g.common.filter(n => nums.includes(n));
      footprint(g, acres, base, cls);
    }
    for (const l of lots) {
      const g = groups.get(l.key);
      if (g) {   // the parent lot of a stacked group: its footprint, never a unit of its own
        if (l.cls === '411') g.parent411 = true; else { feed(g, l.r); g.cat = l.cat; }   // the shell says what the building is
        footprint(g, l.acres, l.base, l.cls);
        continue;
      }
      if (l.cls === '411') out.push({ ...l.base, u: 1, big: true });   // a lot of its own: rental block, count unknown
      else if (l.r) out.push({ ...l.base, u: l.r.u, approx: l.r.approx });
    }
    for (const g of groups.values()) {
      g.p.nums = g.common.length ? g.common : g.first;    // 130-85 / 130-87 / … → ['130']
      if (g.parent411) { g.p.u = 1; g.p.big = true; g.p.kind = '411'; g.p.cls = 'apt'; }   // the roll carries the building as a block too: its unit rows are a subset
      else if (g.n411) {
        g.p.u = g.n411; g.p.kind = '411';
        if (g.n411 === 1 && !g.hasUnit) { g.p.big = true; g.p.cls = 'apt'; }   // one stacked row alone is no condo: unknown-count block
        else g.p.cls = 'condo';
      }
      else {
        const u = Math.max(1, g.units, g.exactU, g.approxU);
        g.p.u = u; g.p.approx = g.exactU < u && g.approxU >= u;
        g.p.cls = g.units > 0 ? 'condo' : g.cat;          // unit rows make a condo; duplicates alone are one house
      }
    }
    return out;
  },
  clsOf, unitsFor,
};

function keyOf(nums, street, ri) {
  return nums.length || street ? `${nums[0] || ''}|${streetKey(street)}` : `geo|${ri.lat.toFixed(4)},${ri.lng.toFixed(4)}`;
}

module.exports = adapter;
