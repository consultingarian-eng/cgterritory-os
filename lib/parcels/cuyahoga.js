'use strict';
// Cuyahoga County OH (Lakewood, Cleveland and its suburbs) — the county's own
// Open_Data_Parcels service, the only Ohio source with a real unit count
// (com_living_units on apartment and mixed-use parcels). Layer 1 holds every
// parcel outside Cleveland, layer 0 Cleveland's; a ZIP whose hull reaches
// into Cleveland (Lakewood's does) is queried on both and deduped on
// parcelpin.
//
// tax_luc (4-char string) → homes:
//   5100/5133 → 1   5200/5233 → 2   5300/5333 → 3   (x133/x233/x333 are the
//        LIHTC twins of the same classes)   5600 mobile home on its own lot → 1
//   5500 residential condo → one row per unit, grouped by condo_complex_id +
//        street number (oh_common.groupCondos), cls 'condo'
//   4xxx → com_living_units when the assessor counted them; otherwise the
//        band floor: 4090 "4-6 unit" → 4 approx (cls 'res'); 4010/4040/4093
//        "7-19" → 7 big; 4020/4050/4060 "20-39" → 20 big; 4030/4070/4080
//        "40+" → 40 big (cls 'apt'); 4970 store with walk-up apartments → 1
//        approx (cls 'mixed'). Any other commercial code with a living-unit
//        count (offices and stores with flats above) keeps that count as
//        'mixed'.
// tax_luc → suppressors (u = 0; a building OSM drew on the lot is not a door):
//   5000 vacant, 5990 other residential (hundreds of lots in some suburbs, every one with
//   res_bldg_count 0: side yards, garages, pools) → 'vacant'; 5799 listed with
//   a neighbour, 5800 common area → 'other'; 4000 → 'vacant'; 4550 → 'garage';
//   4560/4565 → 'parking'; convalescent, nursing, day care, independent living
//   → 'institutional'; hotels, motels and all remaining 4xxx → 'commercial';
//   3xxx → 'industrial' (3000 → 'vacant'); 6xxx–8xxx → 'institutional'.
//   Exempt lots (schools, churches, city land) carry a NULL tax_luc with the
//   class in ext_luc, so the query ORs ext_luc in and the rule reads whichever
//   is set. 4150 mobile home park and 645x CMHA (metropolitan housing) are
//   left alone: their homes are doors when OSM draws them.
// com_bldg_count is 1 on every residential row, so bldgs is res_bldg_count
// for 5xxx and com_bldg_count for 4xxx — never their sum.

const { arcgisAll, int, str, numsOf } = require('../parcels_common');
const { shape, inZip, groupCondos, familyClass, dteWhere, suppressor } = require('./oh_common');

const BASE = 'https://gis.cuyahogacounty.gov/server/rest/services/Open_Data_Parcels/MapServer';
const LAYER_SUBURBS = 1, LAYER_CLEVELAND = 0;
const WHERE = `${dteWhere('tax_luc')} OR ext_luc LIKE '6%' OR ext_luc LIKE '7%' OR ext_luc LIKE '8%'`;
const OUT = ['OBJECTID', 'parcelpin', 'par_addr', 'par_predir', 'par_street', 'par_suffix', 'par_unit', 'par_city', 'par_zip', 'tax_luc', 'ext_luc', 'res_bldg_count', 'com_bldg_count', 'com_living_units', 'condo_complex_id'];

// Cleveland's extent, generously: a hull that misses this box needs layer 1 only.
const CLEVELAND = { s: 41.39, n: 41.61, w: -81.88, e: -81.52 };

const ONE = new Set(['5100', '5110', '5130', '5133', '5600']);
const APT_BAND = { 4090: [4, 'approx'], 4010: [7, 'big'], 4040: [7, 'big'], 4093: [7, 'big'], 4020: [20, 'big'], 4050: [20, 'big'], 4060: [20, 'big'], 4030: [40, 'big'], 4070: [40, 'big'], 4080: [40, 'big'], 4970: [1, 'approx'] };
const APT = new Set(['4010', '4020', '4030', '4040', '4050', '4060', '4070', '4080', '4093']);
// 4xxx lots that hold no front doors whatever com_living_units says
// (convalescent, day care, motel, hotel, nursing home, independent living,
// campground, other commercial housing, vacant, parking); null = leave alone.
const NONRES = { 4000: 'vacant', 4092: 'institutional', 4094: 'institutional', 4095: 'institutional', 4100: 'commercial', 4110: 'commercial', 4120: 'institutional', 4130: 'institutional', 4150: null, 4160: 'commercial', 4190: 'commercial', 4550: 'garage', 4560: 'parking', 4565: 'parking' };
const RES_NONRES = { 5000: 'vacant', 5990: 'vacant', 5799: 'other', 5800: 'other' };

function rule(luc, units) {
  if (luc[0] === '5') {
    if (ONE.has(luc)) return { u: 1, cls: 'res' };
    if (luc === '5200' || luc === '5210' || luc === '5233') return { u: 2, cls: 'res' };
    if (luc === '5300' || luc === '5333') return { u: 3, cls: 'res' };
    if (luc === '5500') return { u: 1, cls: 'condo', condo: true };
    return { u: 0, cls: RES_NONRES[luc] || 'other' };
  }
  if (luc[0] === '4') {
    if (luc in NONRES) return NONRES[luc] ? { u: 0, cls: NONRES[luc] } : null;
    const cls = APT.has(luc) ? 'apt' : luc === '4090' ? 'res' : 'mixed';
    if (units > 0) return { u: units, cls };
    const band = APT_BAND[luc];
    if (band) return { u: band[0], cls, approx: band[1] === 'approx', big: band[1] === 'big' };
    return { u: 0, cls: 'commercial' };
  }
  if (luc === '3000') return { u: 0, cls: 'vacant' };
  // 645x CMHA (metropolitan housing): 6452 CMHA-RESIDENTIAL is 324 occupied
  // scattered-site houses in Cleveland — homes on an exempt lot, left alone
  // like dteRule's 645, never a suppressor.
  if (luc.startsWith('645')) return null;
  const cls = familyClass(luc[0]);
  return cls ? { u: 0, cls } : null;
}

function touchesCleveland(hull, meta) {
  if (/cleveland/i.test(meta?.city || '') || /cleveland/i.test(meta?.municipality || '')) return true;
  let s = 90, n = -90, w = 180, e = -180;
  for (const [la, ln] of hull) { if (la < s) s = la; if (la > n) n = la; if (ln < w) w = ln; if (ln > e) e = ln; }
  return !(n < CLEVELAND.s || s > CLEVELAND.n || e < CLEVELAND.w || w > CLEVELAND.e);
}

async function fetch(zip, { hull, polys, meta }) {
  const layers = [LAYER_SUBURBS];
  if (touchesCleveland(hull, meta)) layers.push(LAYER_CLEVELAND);
  const pages = await Promise.all(layers.map(l => arcgisAll(`${BASE}/${l}/query`, { where: WHERE, outFields: OUT, ring: hull, pageSize: 2000 })));

  const seen = new Set();
  const parcels = [], condos = [], suppressors = [];
  let features = 0, outside = 0, dropped = 0;
  for (const feats of pages) for (const f of feats) {
    features++;
    const a = f.attributes || {};
    const pin = str(a.parcelpin) || `oid:${a.OBJECTID}`;
    if (seen.has(pin)) continue;
    seen.add(pin);
    const luc = str(a.tax_luc) || str(a.ext_luc);
    const r = rule(luc, int(a.com_living_units));
    if (!r) { dropped++; continue; }
    const s = shape(f.geometry);
    if (!inZip(s, polys)) { outside++; continue; }
    // 'CLIFTON (REAR)', 'SLIPPERY ROCK (PRIVATE)', 'DETROIT  (EXT)': the roll
    // annotates a street name in parentheses (sometimes unclosed); streetKey()
    // cannot see REAR through them, so drop the annotation here.
    const street = [str(a.par_predir), str(a.par_street).replace(/\s*\([^)]*\)?/g, ' '), str(a.par_suffix)].join(' ').replace(/\s+/g, ' ').trim();
    const row = { id: pin, lat: s.lat, lng: s.lng, ring: s.ring, nums: numsOf(a.par_addr), street, kind: luc };
    if (r.u < 1) { if (s.ring) suppressors.push(suppressor(row, r.cls)); else dropped++; continue; }
    if (r.condo) { condos.push({ ...row, complex: str(a.condo_complex_id) || null }); continue; }
    const bldgs = luc[0] === '5' ? int(a.res_bldg_count) : int(a.com_bldg_count);
    parcels.push({ ...row, u: r.u, cls: r.cls, approx: !!r.approx, big: !!r.big, bldgs: Math.max(1, bldgs) });
  }
  const grouped = groupCondos(condos);
  module.exports.last = { zip, layers, features, unique: seen.size, dropped, outside, condoRows: condos.length, condoBuildings: grouped.length, suppressors: suppressors.length, parcels: parcels.length + grouped.length };
  return parcels.concat(grouped, suppressors);
}

module.exports = {
  name: 'cuyahoga',
  attribution: 'Cuyahoga County Fiscal Office parcel data (gis.cuyahogacounty.gov)',
  fetch,
  last: null,
};
