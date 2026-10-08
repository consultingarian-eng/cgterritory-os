'use strict';
// Delaware County OH (Columbus's northern suburbs) — the
// county GIS parcel layer. CLASS is the Ohio DTE land-use class (rule table
// in oh_common.dteRule); ADDR1 is the situs line ('7825 EXAMPLE CIR',
// 'CENTER VILLAGE RD' for an unnumbered lot), ADDR2 the city/ZIP line.
// Condominium rows (550–553) are one row per unit and CONDO names the
// declaration ('EXAMPLE CONDO 2ND AMEND'); most are attached homes with
// their own number, a few (dozens of rows on one '705 N EXAMPLE ST') are stacked — the building
// key is CONDO + street number, so both come out right. Class 403 complexes
// appear as several parcels sharing one address (one per building); each
// stays its own big parcel. Lots with no homes (vacant, commercial,
// industrial, exempt) come back as suppressors: their rings remove an OSM
// building drawn on them.

const { arcgisAll, str } = require('../parcels_common');
const { dteRule, dteWhere, suppressor, addrOf, shape, inZip, uniqueIds, groupCondos } = require('./oh_common');

const URL = 'https://maps.delco-gis.org/arcgiswebadaptor/rest/services/DelawareCountyData/MapServer/0/query';
const WHERE = dteWhere('CLASS');
const OUT = ['OBJECTID', 'PARCEL_NO', 'ADDR1', 'ADDR2', 'CLASS', 'CONDO', 'MUN_NAME'];

async function fetch(zip, { hull, polys }) {
  const feats = await arcgisAll(URL, { where: WHERE, outFields: OUT, ring: hull, pageSize: 1000, maxPages: 80 });
  const parcels = [], condos = [], suppressors = [], ids = uniqueIds();
  let dropped = 0, outside = 0;
  for (const f of feats) {
    const a = f.attributes || {};
    const code = str(a.CLASS);
    const r = dteRule(code);
    if (!r) { dropped++; continue; }
    const s = shape(f.geometry);
    if (!inZip(s, polys)) { outside++; continue; }
    const { nums, street } = addrOf(a.ADDR1);
    const row = { id: ids.take(str(a.PARCEL_NO) || `oid:${a.OBJECTID}`, a.OBJECTID), lat: s.lat, lng: s.lng, ring: s.ring, nums, street, kind: code };
    if (r.u < 1) { if (s.ring) suppressors.push(suppressor(row, r.cls)); else dropped++; continue; }
    if (r.condo) { condos.push({ ...row, complex: str(a.CONDO) || null }); continue; }
    parcels.push({ ...row, u: r.u, cls: r.cls, approx: !!r.approx, big: !!r.big, bldgs: 1 });
  }
  const grouped = groupCondos(condos);
  module.exports.last = { zip, features: feats.length, dropped, outside, dupIds: ids.dups, condoRows: condos.length, condoBuildings: grouped.length, suppressors: suppressors.length, parcels: parcels.length + grouped.length };
  return parcels.concat(grouped, suppressors);
}

module.exports = {
  name: 'delaware',
  attribution: 'Delaware County Auditor / GIS parcel data (maps.delco-gis.org)',
  fetch,
  last: null,
};
