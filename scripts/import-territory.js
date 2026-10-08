#!/usr/bin/env node
'use strict';
/**
 * Build the territory master (public/data/master.json) and the polygon files
 * the map draws (public/data/<region>.geojson) from YOUR list of areas.
 *
 *   node scripts/import-territory.js --areas my-areas.csv --geojson boundaries.geojson
 *
 * --areas    CSV, one row per territory unit. Recognised columns (any order,
 *            case-insensitive):
 *              zip | postcode | sector | area   the id (US ZIP or UK sector)
 *              state | region                   region code, must match a
 *                                               "regions" entry in config/territory.json
 *              county, city (or primary_city / town), municipality, households
 *            Any other column (color, permit_required, authority, hours,
 *            internal_notes, …) is copied onto the record as-is.
 * --geojson  Boundary file holding a polygon per area (US: Census ZCTA, e.g.
 *            scripts/fetch-zcta-geojson.js; UK: a postcode-sector boundary set).
 *            Only the areas in the CSV are kept.
 * --id-prop  Feature property holding the area id, if it isn't one of
 *            POSTCODE / ZCTA5CE20 / ZCTA5CE10 / ZIP / GEOID20 / name.
 * --region   Region code for rows without a state/region column.
 * --merge    Keep master records that are not in this CSV (default: replace).
 * --out-dir  Where to write (default public/data).
 *
 * For every office in config/territory.json with lat/lng, each record gets
 * dist_miles_<key> (straight line from the area's centroid) and
 * drive_mins_<key> (distance × 1.25 road factor at 45 mph — an estimate;
 * overwrite with real drive times if you have them). The board uses these to
 * pick the nearer office and to show "x mi from …".
 *
 * After running, bump DATA_V in public/js/app.js so phones fetch the new files.
 */

const fs   = require('fs');
const path = require('path');
const { settings, normalizeAreaId } = require('../lib/settings');
const { parseCsv } = require('./lib/csv');

const args = process.argv.slice(2);
const arg = (name, dflt = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const AREAS   = arg('--areas');
const GEOJSON = arg('--geojson');
const ID_PROP = arg('--id-prop');
const REGION  = arg('--region');
const MERGE   = args.includes('--merge');
const OUT_DIR = path.resolve(arg('--out-dir', path.join(__dirname, '..', 'public', 'data')));

if (!AREAS || !GEOJSON) {
  console.error('Usage: node scripts/import-territory.js --areas <csv> --geojson <file> [--id-prop NAME] [--region CODE] [--merge] [--out-dir DIR]');
  process.exit(1);
}

const r5 = n => Math.round(n * 1e5) / 1e5;   // ~1 m — keeps the files small
const simplifyRing = ring => ring.map(([x, y]) => [r5(x), r5(y)]);
const simplifyGeom = g =>
  g.type === 'Polygon'      ? { type: 'Polygon',      coordinates: g.coordinates.map(simplifyRing) }
: g.type === 'MultiPolygon' ? { type: 'MultiPolygon', coordinates: g.coordinates.map(p => p.map(simplifyRing)) }
: g;

function haversineMi(a, b) {
  const R = 3958.8, toRad = x => x * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
// Vertex average of the largest outer ring — close enough for "how far away".
function centroid(geom) {
  const rings = geom.type === 'Polygon' ? [geom.coordinates[0]] : geom.type === 'MultiPolygon' ? geom.coordinates.map(p => p[0]) : [];
  const ring = rings.sort((a, b) => b.length - a.length)[0];
  if (!ring) return null;
  let la = 0, lo = 0;
  for (const [lng, lat] of ring) { la += lat; lo += lng; }
  return { lat: la / ring.length, lng: lo / ring.length };
}
const featureId = p => normalizeAreaId(
  ID_PROP ? p[ID_PROP] : (p.POSTCODE ?? p.ZCTA5CE20 ?? p.ZCTA5CE10 ?? p.ZIP ?? p.GEOID20 ?? p.name));

// ── read the CSV ─────────────────────────────────────────────────────────────
const rows = parseCsv(fs.readFileSync(AREAS, 'utf8'));
if (rows.length < 2) { console.error(`${AREAS}: no data rows`); process.exit(1); }
const headers = rows[0].map(h => h.trim());
const lower = headers.map(h => h.toLowerCase());
const col = (...names) => lower.findIndex(h => names.includes(h));
const idCol = col('zip', 'zipcode', 'zip code', 'postcode', 'sector', 'postcode sector', 'area');
if (idCol < 0) { console.error(`${AREAS}: needs a zip / postcode / sector / area column (found: ${headers.join(', ')})`); process.exit(1); }
const known = {
  state: col('state', 'region'), county: col('county'),
  primary_city: col('city', 'primary_city', 'town', 'post town'), municipality: col('municipality'),
  households: col('households', 'hh'),
};
const regionCodes = new Set(settings.regions.map(r => r.code));

const records = new Map();
for (const r of rows.slice(1)) {
  const id = normalizeAreaId(r[idCol]);
  if (!id) { console.warn(`  ! skipped row with id "${r[idCol]}" (not a valid area id for areaIdPattern)`); continue; }
  const state = String((known.state >= 0 ? r[known.state] : '') || REGION || '').trim().toUpperCase();
  if (!regionCodes.has(state)) { console.warn(`  ! ${id}: region "${state}" is not in config/territory.json regions — skipped`); continue; }
  const rec = { zip: id, state };
  if (known.county >= 0)       rec.county = r[known.county] || '';
  if (known.primary_city >= 0) rec.primary_city = r[known.primary_city] || '';
  rec.municipality = (known.municipality >= 0 && r[known.municipality]) || rec.primary_city || '';
  if (known.households >= 0)   rec.households = parseInt(String(r[known.households]).replace(/[^\d]/g, ''), 10) || null;
  const used = new Set([idCol, ...Object.values(known)]);
  headers.forEach((h, i) => {
    if (used.has(i) || !h) return;
    const v = String(r[i] ?? '').trim();
    if (v === '') return;
    rec[h] = /^-?\d+(\.\d+)?$/.test(v) ? +v : v;
  });
  if (!rec.color) rec.color = 'GREY';   // Not Reviewed until someone researches it
  records.set(id, rec);
}
console.log(`${AREAS}: ${records.size} areas`);

// ── polygons ─────────────────────────────────────────────────────────────────
const src = JSON.parse(fs.readFileSync(GEOJSON, 'utf8'));
const byRegion = {};
let matched = 0;
for (const f of src.features || []) {
  if (!f.geometry) continue;
  const id = featureId(f.properties || {});
  const rec = records.get(id);
  if (!rec) continue;
  const geometry = simplifyGeom(f.geometry);
  (byRegion[rec.state] ||= []).push({
    type: 'Feature',
    properties: { POSTCODE: id, PC_NAME: rec.primary_city || rec.municipality || '', Municipality: rec.municipality || '', State: rec.state, County: rec.county || '' },
    geometry,
  });
  const c = centroid(geometry);
  if (c) {
    for (const o of settings.offices) {
      if (!Number.isFinite(o.lat) || !Number.isFinite(o.lng)) continue;
      const d = haversineMi(o, c);
      rec[`dist_miles_${o.key}`] = +d.toFixed(1);
      rec[`drive_mins_${o.key}`] = Math.round(d * 1.25 / 45 * 60);
    }
  }
  matched++;
}
const missing = [...records.keys()].filter(id => !Object.values(byRegion).some(fs_ => fs_.some(f => f.properties.POSTCODE === id)));
console.log(`${GEOJSON}: matched ${matched} polygons${missing.length ? ` · no polygon for ${missing.length}: ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? '…' : ''}` : ''}`);

// ── write ────────────────────────────────────────────────────────────────────
fs.mkdirSync(OUT_DIR, { recursive: true });
const masterPath = path.join(OUT_DIR, 'master.json');
let master = [...records.values()];
if (MERGE && fs.existsSync(masterPath)) {
  const prev = JSON.parse(fs.readFileSync(masterPath, 'utf8')).filter(r => !records.has(r.zip));
  master = prev.concat(master);
}
master.sort((a, b) => String(a.zip).localeCompare(String(b.zip)));
fs.writeFileSync(masterPath, JSON.stringify(master, null, 2) + '\n');
console.log(`✓ ${path.relative(process.cwd(), masterPath)} — ${master.length} records`);

for (const [code, features] of Object.entries(byRegion)) {
  const region = settings.regions.find(r => r.code === code);
  const out = path.join(OUT_DIR, path.basename(region.file.split('?')[0]));
  let all = features;
  if (MERGE && fs.existsSync(out)) {
    const keep = new Set(features.map(f => f.properties.POSTCODE));
    all = JSON.parse(fs.readFileSync(out, 'utf8')).features.filter(f => !keep.has(featureId(f.properties || {}))).concat(features);
  }
  fs.writeFileSync(out, JSON.stringify({ type: 'FeatureCollection', features: all }));
  console.log(`✓ ${path.relative(process.cwd(), out)} — ${all.length} polygons`);
}
console.log('Now bump DATA_V in public/js/app.js so installed apps pick up the new files.');
