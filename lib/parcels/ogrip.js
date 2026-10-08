'use strict';
// Ohio statewide parcels (OGRIP / Ohio Geographically Referenced Information
// Program view) — every Ohio county without its own adapter, including Lorain
// County, whose own service is licence-restricted. Band only: StateLUC
// is the DTE class with a label ('530: Res-Three Family'), the rule table is
// oh_common.dteRule. SitusAddressAll is what each county chose to publish:
// Lorain publishes blanks, Lake/Hamilton '555  EXAMPLE AVE   ', Montgomery
// '2819  SAMPLE DR  SAMPLETOWN 45400' — fields are separated by two or more
// spaces. With no address the join falls back to containment/nearest, and
// condo rows group by their stacked ring.
//
// Two pulls run side by side: the dwelling families (4xx/5xx homes) and the
// lots that suppress a building drawn on them (vacant, commercial,
// industrial, exempt). A cold page of this view takes 20 s, so splitting the
// hull across two queries roughly halves the wall time rather than doubling
// it. The view pages fine under a polygon filter today (2000 features a page;
// ≈1 s warm, 20–25 s cold); should that stop, the fallback is attribute-only
// paging on the county plus the ZIP in the situs line, filtered here on the
// centroid. CurrentTo (the county's roll date; Cuyahoga's is 2023 here, which
// is why Cuyahoga has its own adapter) is surfaced as rollNote.

const { arcgisAll, str } = require('../parcels_common');
const { dteRule, suppressor, addrOf, shape, inZip, uniqueIds, groupCondos } = require('./oh_common');

const URL = 'https://services2.arcgis.com/MlJ0G8iWUyC7jAmu/arcgis/rest/services/OhioStatewidePacels_full_view/FeatureServer/0/query';
const OUT = ['OBJECTID', 'LocalParcelID', 'StateLUC', 'SitusAddressAll', 'CurrentTo', 'County'];

function countyOf(meta) {
  return str(meta?.county).replace(/\s+county$/i, '').replace(/'/g, "''").trim();
}

// '2819  SAMPLE DR  SAMPLETOWN 45400' → { nums:['2819'], street:'SAMPLE DR' }
function situs(line) {
  const parts = str(line).split(/\s{2,}/).map(s => s.trim()).filter(Boolean);
  if (!parts.length) return { nums: [], street: '' };
  if (parts.length === 1) return addrOf(parts[0]);
  if (/^\d/.test(parts[0])) return addrOf(`${parts[0]} ${parts[1]}`);
  return addrOf(parts[0]);
}

const like = prefixes => `(${prefixes.map(p => `StateLUC LIKE '${p}%'`).join(' OR ')})`;
// The class families dteRule() turns into homes …
const HOMES = like(['51', '52', '53', '55', '56', '59', '40', '43', '47', '49']);
// … and the rest of 3xx–8xx, which it turns into suppressors (1xx
// agricultural and 2xx mineral are left alone).
const NONRES = like(['3', '41', '42', '44', '45', '46', '48', '50', '54', '57', '58', '6', '7', '8']);

async function fetch(zip, { hull, polys, meta }) {
  const county = countyOf(meta);
  const modes = [];
  const pull = async (luc) => {
    const where = county ? `County='${county}' AND ${luc}` : luc;
    try {
      const feats = await arcgisAll(URL, { where, outFields: OUT, ring: hull, pageSize: 2000, maxPages: 60 });
      modes.push('hull');
      return feats;
    } catch (e) {
      modes.push('attrOnly');
      return arcgisAll(URL, { where: `${where} AND SitusAddressAll LIKE '%${zip}%'`, outFields: OUT, attrOnly: true, pageSize: 2000, maxPages: 60 });
    }
  };
  const feats = (await Promise.all([pull(HOMES), pull(NONRES)])).flat();
  const parcels = [], condos = [], suppressors = [], ids = uniqueIds();
  let dropped = 0, outside = 0, currentTo = 0;
  for (const f of feats) {
    const a = f.attributes || {};
    const code = String(parseInt(str(a.StateLUC), 10));
    const r = dteRule(code);
    if (!r) { dropped++; continue; }
    const s = shape(f.geometry);
    if (!inZip(s, polys)) { outside++; continue; }
    if (+a.CurrentTo > currentTo) currentTo = +a.CurrentTo;
    const { nums, street } = situs(a.SitusAddressAll);
    const row = { id: ids.take(str(a.LocalParcelID) || `oid:${a.OBJECTID}`, a.OBJECTID), lat: s.lat, lng: s.lng, ring: s.ring, nums, street, kind: code };
    if (r.u < 1) { if (s.ring) suppressors.push(suppressor(row, r.cls)); else dropped++; continue; }
    if (r.condo) { condos.push({ ...row, complex: null }); continue; }
    parcels.push({ ...row, u: r.u, cls: r.cls, approx: !!r.approx, big: !!r.big, bldgs: 1 });
  }
  const grouped = groupCondos(condos);
  module.exports.rollNote = currentTo ? `${county || 'County'} roll current to ${new Date(currentTo).toISOString().slice(0, 10)} (Ohio statewide parcel view; land-use band only, no unit counts)` : '';
  module.exports.last = { zip, county, mode: modes.every(m => m === 'hull') ? 'hull' : modes.join('+'), features: feats.length, dropped, outside, dupIds: ids.dups, condoRows: condos.length, condoBuildings: grouped.length, suppressors: suppressors.length, parcels: parcels.length + grouped.length, withAddress: parcels.filter(p => p.nums.length).length };
  return parcels.concat(grouped, suppressors);
}

module.exports = {
  name: 'ogrip',
  attribution: 'Ohio Statewide Parcels (OGRIP / county auditors)',
  rollNote: '',
  fetch,
  last: null,
};
