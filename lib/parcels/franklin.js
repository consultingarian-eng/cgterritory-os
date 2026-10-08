'use strict';
// Franklin County OH (Columbus and its suburbs) — the auditor's hosted
// Parcel_Features layer. CLASSCD carries the Ohio DTE land-use class (USECD
// is always null); the rule table is oh_common.dteRule. Condominium rows
// (550–553) are one row per unit with the unit appended to SITEADDRESS
// ('4210 EXECUTIVE  PW UNIT 112', '6150 HARBOUR PT 102'); CNVYNAME is null
// county-wide, so the building key is the street number + street.
//
// Lots with no homes (vacant, commercial, industrial, exempt) come back as
// suppressors: their rings remove an OSM building drawn on them.
//
// Paging: this server returns zero features when a polygon filter and
// resultRecordCount / resultOffset arrive together (returnCountOnly and the
// unpaged query both work), so the hull is walked by OBJECTID instead
// (oh_common.oidWalk): 3000 features a call, ordered by OID, next call asks
// for OID > last. SITEADDRESS uses run-on spaces and two-letter suffixes
// (BL, WY, PW, CR, LP …) that the shared normaliser does not know.

const { str } = require('../parcels_common');
const { dteRule, dteWhere, suppressor, addrOf, stripUnit, shape, inZip, uniqueIds, groupCondos, oidWalk } = require('./oh_common');

const URL = 'https://gis.franklincountyohio.gov/hosting/rest/services/ParcelFeatures/Parcel_Features/FeatureServer/0/query';
const WHERE = dteWhere('CLASSCD');
const OUT = ['OBJECTID', 'PARCELID', 'SITEADDRESS', 'ZIPCD', 'CLASSCD', 'CLASSDSCRP', 'CNVYNAME', 'PCLASS', 'RENTAL'];

// Franklin's two-letter street suffixes → what OSM and streetKey() use
const SUFFIX2 = { BL: 'BLVD', WY: 'WAY', PW: 'PKWY', CR: 'CIR', LP: 'LOOP', AL: 'ALY', TR: 'TRL', TE: 'TER', HW: 'HWY', PZ: 'PLZ', PK: 'PARK', PI: 'PIKE', CK: 'CREEK', XG: 'XING' };
const DIRS = new Set(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW', 'NORTH', 'SOUTH', 'EAST', 'WEST']);

// '2 EXAMPLE BL 1' → '2 EXAMPLE BLVD 1': expand the suffix that sits
// before any trailing directional / bare unit, then let addrOf() split it.
function parseAddress(raw) {
  const toks = stripUnit(raw).split(' ');
  let i = toks.length - 1;
  while (i > 1 && (DIRS.has(toks[i]) || /^\d+[A-Z]?$|^[A-Z]$/.test(toks[i]))) i--;
  if (i > 0 && SUFFIX2[toks[i]]) toks[i] = SUFFIX2[toks[i]];
  return addrOf(toks.join(' '));
}

async function fetch(zip, { hull, polys }) {
  const feats = await oidWalk(URL, { where: WHERE, outFields: OUT, ring: hull });
  const parcels = [], condos = [], suppressors = [], ids = uniqueIds();
  let dropped = 0, outside = 0;
  for (const f of feats) {
    const a = f.attributes || {};
    const code = str(a.CLASSCD);
    const r = dteRule(code);
    if (!r) { dropped++; continue; }
    const s = shape(f.geometry);
    if (!inZip(s, polys)) { outside++; continue; }
    const { nums, street } = parseAddress(a.SITEADDRESS);
    const row = { id: ids.take(str(a.PARCELID) || `oid:${a.OBJECTID}`, a.OBJECTID), lat: s.lat, lng: s.lng, ring: s.ring, nums, street, kind: code };
    if (r.u < 1) { if (s.ring) suppressors.push(suppressor(row, r.cls)); else dropped++; continue; }
    if (r.condo) { condos.push({ ...row, complex: str(a.CNVYNAME) || null }); continue; }
    parcels.push({ ...row, u: r.u, cls: r.cls, approx: !!r.approx, big: !!r.big, bldgs: 1 });
  }
  const grouped = groupCondos(condos);
  module.exports.last = { zip, features: feats.length, dropped, outside, dupIds: ids.dups, condoRows: condos.length, condoBuildings: grouped.length, suppressors: suppressors.length, parcels: parcels.length + grouped.length };
  return parcels.concat(grouped, suppressors);
}

module.exports = {
  name: 'franklin',
  attribution: 'Franklin County Auditor parcel data (gis.franklincountyohio.gov)',
  fetch,
  parseAddress,   // exported for tooling/tests
  last: null,
};
