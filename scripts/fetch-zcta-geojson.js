#!/usr/bin/env node
'use strict';
/**
 * Download one US state's ZIP (ZCTA) boundaries — public US Census data,
 * republished per state by the OpenDataDE/State-zip-code-GeoJSON project —
 * and save it as a source file for scripts/import-territory.js.
 *
 *   node scripts/fetch-zcta-geojson.js CT                 → boundaries/ct-zcta.geojson
 *   node scripts/fetch-zcta-geojson.js CT --out some/file.geojson
 *
 * The download is the WHOLE state (tens of MB for a big state). Don't serve it
 * as-is: run import-territory.js with your area list, which keeps only your
 * ZIPs, rounds the coordinates and writes public/data/<region>.geojson.
 *
 * Outside the US: get postcode-sector (or district) boundaries from your
 * national mapping agency or an open-data mirror, then feed that file to
 * import-territory.js with --id-prop naming the property that holds the id.
 */

const fs = require('fs');
const path = require('path');

const STATES = {
  AL:'alabama', AK:'alaska', AZ:'arizona', AR:'arkansas', CA:'california', CO:'colorado', CT:'connecticut',
  DE:'delaware', DC:'district_of_columbia', FL:'florida', GA:'georgia', HI:'hawaii', ID:'idaho', IL:'illinois',
  IN:'indiana', IA:'iowa', KS:'kansas', KY:'kentucky', LA:'louisiana', ME:'maine', MD:'maryland',
  MA:'massachusetts', MI:'michigan', MN:'minnesota', MS:'mississippi', MO:'missouri', MT:'montana',
  NE:'nebraska', NV:'nevada', NH:'new_hampshire', NJ:'new_jersey', NM:'new_mexico', NY:'new_york',
  NC:'north_carolina', ND:'north_dakota', OH:'ohio', OK:'oklahoma', OR:'oregon', PA:'pennsylvania',
  RI:'rhode_island', SC:'south_carolina', SD:'south_dakota', TN:'tennessee', TX:'texas', UT:'utah',
  VT:'vermont', VA:'virginia', WA:'washington', WV:'west_virginia', WI:'wisconsin', WY:'wyoming',
};

async function main() {
  const args = process.argv.slice(2);
  const st = String(args[0] || '').toUpperCase();
  if (!STATES[st]) { console.error('Usage: node scripts/fetch-zcta-geojson.js <STATE> [--out file]   e.g. CT'); process.exit(1); }
  const oi = args.indexOf('--out');
  const out = path.resolve(oi >= 0 ? args[oi + 1] : path.join(__dirname, '..', 'boundaries', `${st.toLowerCase()}-zcta.geojson`));
  const url = `https://raw.githubusercontent.com/OpenDataDE/State-zip-code-GeoJSON/master/${st.toLowerCase()}_${STATES[st]}_zip_codes_geo.min.json`;
  console.log(`Fetching ${url}`);
  const r = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const text = await r.text();
  const n = (JSON.parse(text).features || []).length;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text);
  console.log(`✓ ${path.relative(process.cwd(), out)} — ${n} ZIP polygons (${(text.length / 1e6).toFixed(1)} MB)`);
  console.log(`Next: node scripts/import-territory.js --areas your-areas.csv --geojson ${path.relative(process.cwd(), out)}`);
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
