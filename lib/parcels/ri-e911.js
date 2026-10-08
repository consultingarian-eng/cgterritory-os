'use strict';
// Rhode Island outside Providence — RI E-911 address points (RIGIS).
// Points only, class only: no unit counts anywhere in the data, so a
// multi-family point is floored to 2 (approx) and single-family classes are
// 1. Sub-address rows (unitid set) at one structure are grouped and counted.
//
// Layer: FACILITY_AddressPoints_E911domains/5 (annual "E911_2026" roll).
// pointtype domain: R1 single-family, R2 multi-family, R3 mobile home,
// R4 other residential, R5 bungalow, R6 seasonal; A1/A2 garages/abandoned
// and every C/I/P class are not doors. Every record is a home with
// cls 'res' (R2 is a multi-family of unknown size, still a home, not an
// 'apt' block). Points have no footprint, so this source never returns a
// suppressor: an A1/A2 or commercial point is simply left out.

const { arcgisAll, ringInfo, str, streetKey, numsOf } = require('../parcels_common');
const geo = require('../geo');

const URL = 'https://services2.arcgis.com/S8zZg9pg23JUEexQ/arcgis/rest/services/FACILITY_AddressPoints_E911domains/FeatureServer/5/query';
const WHERE = "pointtype IN ('R1','R2','R3','R4','R5','R6') AND status='Current'";
const FIELDS = ['OBJECTID', 'fulladdr', 'addrnum', 'addrnumsuf', 'fullname', 'pointtype', 'unittype', 'unitid', 'municipality', 'zipcode', 'status'];
const DUP_M = 8;            // two Current points at one address this close together are the same structure drawn twice

// Street numbers for the join. A letter suffix stays on the number ('162A'
// → ['162A','162']); a lot number ('242 -12 EXAMPLE ST', a mobile-home park)
// or a half ('198 1/2') would collide with a neighbour's number, so those
// points join by position only.
function numsFor(a) {
  const n = str(a.addrnum), suf = str(a.addrnumsuf).toUpperCase();
  if (!n) return [];
  if (!suf) return numsOf(n);
  if (/^[A-Z]{1,2}$/.test(suf)) return numsOf(n + suf);
  return [];
}

function unitsFor(pointtype) { return pointtype === 'R2' ? { u: 2, approx: true } : { u: 1, approx: false }; }

async function fetch(zip, { hull, envelope }) {
  const opts = { where: WHERE, outFields: FIELDS, pageSize: 2000, maxPages: 60 };
  let feats = await arcgisAll(URL, { ...opts, ring: hull });
  if (!feats.length && envelope) feats = await arcgisAll(URL, { ...opts, envelope });

  // One row per point, keyed by the address without its unit so that
  // "12 MAIN ST APT 1/2/3" collapses onto "12 MAIN ST".
  const rows = [];
  const seen = new Set();
  for (const f of feats) {
    const a = f.attributes || {};
    const oid = a.OBJECTID;
    if (oid == null || seen.has(oid)) continue;
    seen.add(oid);
    const pt = ringInfo(f.geometry);
    if (!pt) continue;
    const type = str(a.pointtype).toUpperCase();
    if (!/^R[1-6]$/.test(type) || str(a.status) !== 'Current') continue;
    const street = str(a.fullname);
    const nums = numsFor(a);
    const key = nums.length && street ? `${nums[0]}|${streetKey(street)}` : `#${oid}`;
    rows.push({ oid, lat: pt.lat, lng: pt.lng, type, street, nums, unit: str(a.unitid), muni: str(a.municipality).toUpperCase(), key });
  }

  const groups = new Map();
  for (const r of rows) (groups.get(r.key) || groups.set(r.key, []).get(r.key)).push(r);

  const out = [];
  const emit = (r, u, approx, kind, extra = {}) => out.push({
    id: `E${r.oid}`, lat: r.lat, lng: r.lng, ring: null, nums: r.nums, street: r.street,
    u, cls: 'res', kind, approx, big: false, bldgs: 1, muni: r.muni, ...extra,
  });

  for (const rs of groups.values()) {
    const subs = rs.filter(r => r.unit), bases = rs.filter(r => !r.unit);
    if (subs.length) {
      // Sub-addresses: one structure, count the units we can see (floor 2).
      const at = bases[0] || subs[0];
      const u = Math.max(2, subs.length);
      const kind = (bases[0] || subs[0]).type;
      emit(at, u, subs.length < 2, kind);
      continue;
    }
    // Plain points at one address: a duplicate drawn twice becomes one
    // record; distinct structures (front house + rear cottage) stay apart
    // and the address join sums them.
    const used = new Set();
    for (let i = 0; i < bases.length; i++) {
      if (used.has(i)) continue;
      let best = unitsFor(bases[i].type), kind = bases[i].type;
      for (let j = i + 1; j < bases.length; j++) {
        if (used.has(j)) continue;
        if (geo.distM(bases[i].lat, bases[i].lng, bases[j].lat, bases[j].lng) > DUP_M) continue;
        used.add(j);
        const uj = unitsFor(bases[j].type);
        if (uj.u > best.u) { best = uj; kind = bases[j].type; }
      }
      emit(bases[i], best.u, best.approx, kind);
    }
  }
  return out;
}

module.exports = {
  name: 'ri-e911',
  attribution: 'RIGIS / Rhode Island E 9-1-1 Uniform Emergency Telephone System — E-911 address points',
  rollNote: 'RI E-911 address points (2026 roll): residential class only, no unit counts; multi-family floored to 2',
  fetch,
};
