'use strict';
// New York City — MapPLUTO (Department of City Planning), one record per tax
// lot. Covers the five boroughs (ZIP prefixes 100–104, 110–114, 116).
//
//   u = UnitsRes, exact — no code translation. Condominiums are already one
//   billing-lot record per building, so the only grouping needed is a dedupe
//   on BBL (a lot can come back twice from a spatial query when it straddles
//   a page boundary). The cap is not applied here: parcels.js flags
//   u > UNIT_CAP as `big`.
//
//   cls — a lot with homes is classed by LandUse: 01 one/two-family → res,
//   02/03 walk-up/elevator → apt (u stays UnitsRes), 04 → mixed; a condo
//   BldgClass (R…) → condo whatever the LandUse. Homes the roll counts on a
//   store/garage/church lot (K4, G9, M9 …) are mixed: still counted.
//   Every other lot comes back too, with u = 0, as a SUPPRESSOR: an OSM
//   building drawn on it is not a door. What it is comes from the BldgClass
//   letter (V vacant · G garage, G6/G7 parking · E/F/L industrial ·
//   H/J/K/O commercial · I/M/N/P/W/Y institutional · Q/T/U/Z other), then
//   LandUse (05 commercial · 06 industrial · 08 institutional · 10 parking ·
//   11 vacant · 07/09 other). A residential-class lot with no units (A/B/C/D
//   or S, LandUse 01–04 with no class) contradicts itself: it keeps a home
//   class so parcels.js drops it instead of suppressing a house on a roll
//   error. A lot with no record behind it at all (PLUTOMapID 3: a tax-map
//   polygon with no BldgClass, LandUse or units — 459 city-wide) is unknown,
//   not a suppressor: clsOf returns null and the lot stays out. Those
//   polygons can overlap live house lots, so as suppressors they would
//   erase houses.

const { arcgisAll, ringInfo, int, str, splitAddress } = require('../parcels_common');
const { slimRing } = require('./_ring');

const URL = 'https://services5.arcgis.com/GfwWNkhOj9bNBqoJ/arcgis/rest/services/MAPPLUTO/FeatureServer/0/query';
const FIELDS = ['OBJECTID', 'BBL', 'Address', 'ZipCode', 'BldgClass', 'LandUse', 'UnitsRes', 'UnitsTotal', 'NumBldgs', 'NumFloors', 'Version'];
const WHERE = '1=1';   // every lot: homes join, the rest suppress

// BldgClass letter → class of a lot with no homes on it.
const NONRES_BY_LETTER = {
  V: 'vacant', G: 'garage', E: 'industrial', F: 'industrial', L: 'industrial',
  H: 'commercial', J: 'commercial', K: 'commercial', O: 'commercial',
  I: 'institutional', M: 'institutional', N: 'institutional', P: 'institutional', W: 'institutional', Y: 'institutional',
  Q: 'other', T: 'other', U: 'other', Z: 'other',
};
const HOME_BY_LETTER = { A: 'res', B: 'res', C: 'apt', D: 'apt', S: 'mixed', R: 'condo' };
const BY_LANDUSE = { '01': 'res', '02': 'apt', '03': 'apt', '04': 'mixed', '05': 'commercial', '06': 'industrial', '07': 'other', '08': 'institutional', '09': 'other', '10': 'parking', '11': 'vacant' };

// Normalised class of a lot (see the header); null = a lot the roll says
// nothing about (no class, no land use, no units). Exported for fixtures.
function clsOf(landUse, bldgClass, u) {
  const L = landUse ? String(landUse).padStart(2, '0') : '';
  const letter = str(bldgClass).toUpperCase().charAt(0);
  if (u >= 1) {
    if (letter === 'R') return 'condo';
    if (L === '01' || L === '02' || L === '03' || L === '04') return BY_LANDUSE[L];
    if (L) return 'mixed';                                    // homes the roll counts on a non-residential lot
    return HOME_BY_LETTER[letter] || 'mixed';
  }
  if (!letter && !L) return null;                             // a tax-map polygon with no record: neither a home nor a suppressor
  if (L === '11' || letter === 'V') return 'vacant';
  if (letter === 'G') return /^G[67]$/i.test(str(bldgClass)) ? 'parking' : 'garage';
  if (NONRES_BY_LETTER[letter]) return NONRES_BY_LETTER[letter];
  if (letter === 'R') return BY_LANDUSE[L] && !/^0[1-4]$/.test(L) ? BY_LANDUSE[L] : 'condo';   // a garage/retail/office condo lot: what its LandUse says
  if (HOME_BY_LETTER[letter]) return HOME_BY_LETTER[letter];  // residential class, no units: contradictory, not a suppressor
  return BY_LANDUSE[L] || 'other';
}

const adapter = {
  name: 'nyc-pluto',
  attribution: 'NYC Department of City Planning, MapPLUTO',
  rollNote: 'MapPLUTO',   // refined to the release version once a fetch has seen one

  async fetch(zip, { hull, envelope }) {
    // Hull first (over-fetches a little, parcels.js trims to the ZIP); a hull
    // that yields nothing is retried once as the envelope (§1.1).
    let feats = await arcgisAll(URL, { where: WHERE, outFields: FIELDS, ring: hull, pageSize: 2000 });
    if (!feats.length && envelope) feats = await arcgisAll(URL, { where: WHERE, outFields: FIELDS, envelope, pageSize: 2000 });

    const seen = new Set();
    const out = [];
    for (const f of feats) {
      const a = f.attributes || {};
      const u = int(a.UnitsRes);
      // BBL arrives as a Double (2048250066); stringify without exponent/decimals
      const bbl = a.BBL != null && Number.isFinite(+a.BBL) ? String(Math.round(+a.BBL)) : '';
      const id = bbl || `oid${a.OBJECTID}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const ri = ringInfo(f.geometry);
      if (!ri) continue;
      const ring = slimRing(ri.ring);
      if (!u && !ring) continue;                            // a suppressor is nothing without a footprint
      const cls = clsOf(a.LandUse, a.BldgClass, u);
      if (!cls) continue;                                   // no record behind the polygon: nothing to count, nothing to suppress with
      if (a.Version && adapter.rollNote === 'MapPLUTO') adapter.rollNote = `MapPLUTO ${str(a.Version)}`;
      // "646 EAST 999 STREET" / "1234-1240 EXAMPLE ROAD" (ranges stay two endpoints)
      const { nums, street } = splitAddress(str(a.Address).toUpperCase());
      out.push({
        id, lat: ri.lat, lng: ri.lng, ring,
        nums, street,
        u, cls, kind: str(a.BldgClass), approx: false, big: false,
        bldgs: int(a.NumBldgs) || 1,
      });
    }
    return out;
  },
  clsOf,
};

module.exports = adapter;
