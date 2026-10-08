#!/usr/bin/env node
// Build a ZIP's street graph with assessor units and print the join
// breakdown plus per-street doors/buildings for a few streets.
//   node scripts/parcel-check.js 01001 "MAIN ST" "ELM ST"
const osm = require('../lib/osm');
const geo = require('../lib/geo');
const parcels = require('../lib/parcels');
(async () => {
  const [zip, ...streets] = process.argv.slice(2);
  if (!zip) { console.error('usage: parcel-check <zip> [STREET ...]'); process.exit(1); }
  const geom = osm.zipGeometry(zip);
  const rings = geo.outerRings(geom);
  const t0 = Date.now();
  // RAW_CACHE=<dir> keeps the Overpass pull on disk so re-runs don't wait on it
  const fs = require('fs'), cacheFile = process.env.RAW_CACHE ? `${process.env.RAW_CACHE}/raw${zip}.json` : null;
  const rawP = cacheFile && fs.existsSync(cacheFile) ? Promise.resolve(JSON.parse(fs.readFileSync(cacheFile))) : osm.fetchRaw(rings).then(r => { if (cacheFile) fs.writeFileSync(cacheFile, JSON.stringify(r)); return r; });
  const [raw, pinfo] = await Promise.all([rawP, parcels.fetchZipParcels(zip, geom).catch(e => { console.warn('parcels failed:', e.message); return null; })]);
  const t1 = Date.now();
  const g = osm.buildGraph(zip, rings, raw, null, geo.polysOf(geom), pinfo);
  const s = g.stats;
  console.log(`${zip}: fetch ${((t1 - t0) / 1000).toFixed(1)}s (parcels ${pinfo ? pinfo.parcels.length + ' via ' + pinfo.source + ' in ' + (pinfo.ms / 1000).toFixed(1) + 's' : 'none'}), build ${Date.now() - t1} ms`);
  console.log(`  blocks ${s.segs} · buildings ${s.buildings} · doors ${s.doors} (units ${s.units}${s.synthetic ? ' + ' + s.synthetic + ' synthetic' : ''}) · households ${s.households} · source ${s.unitsSource}`);
  console.log(`  multi: ${JSON.stringify(s.multi)} · big ${s.big} · matched ${JSON.stringify(s.matched)}`);
  if (s.skipped) console.log(`  skipped: ${JSON.stringify(s.skipped)} · policy ${JSON.stringify(s.policy)}`);
  if (s.unmatchedStreets?.length) console.log(`  unmatched streets: ${s.unmatchedStreets.slice(0, 8).join(', ')}`);
  for (const st of streets) {
    const segs = g.segs.filter(x => x.name && x.name.toUpperCase().replace(/\bSTREET\b/, 'ST').replace(/\bAVENUE\b/, 'AVE').replace(/\bROAD\b/, 'RD') === st.toUpperCase());
    const doors = segs.flatMap(x => x.doors);
    const units = doors.reduce((n, d) => n + (d.u || 1), 0);
    console.log(`  ${st}: ${segs.length} blocks · ${doors.length} buildings · ${units} doors · big ${doors.filter(d => d.big).length} · sample ${doors.slice(0, 6).map(d => (d.num || '?') + (d.u ? '×' + d.u : '') + (d.big ? 'B' : '')).join(' ')}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
