#!/usr/bin/env node
'use strict';
/**
 * Import a Do-Not-Knock address list as `dnk_issue` incidents on each ZIP's
 * edits record, so every address shows as an ✕ pin at the house on the map.
 *
 * Input: a CSV or JSON file (default public/data/dnk.json, which ships empty).
 *   CSV columns: address, city, state, zip, notes, scope, lat, lng
 *   The area column may be called zip, postcode or sector (headers are not
 *   case-sensitive). It may hold a US ZIP, a UK postcode sector ("LS6 3") or a
 *   full UK postcode ("LS6 3AB", folded to its sector; the full postcode is
 *   still used for the address lookup). state is optional (UK lists have none).
 *   JSON: an array of objects with the same keys
 * See samples/dnk.sample.csv. Rows that carry lat/lng are placed as given;
 * the rest are geocoded (US Census geocoder for US boards, then Nominatim).
 *
 * - Dedupes by normalized address within each ZIP — safe to re-run
 * - Only appends to the `incidents` array (read-modify-write $set); no other
 *   field is touched
 *
 * Usage (the flag works the same on Mac, Linux and Windows):
 *   node scripts/import-dnk.js --dry-run my-dnk-list.csv   # look addresses up + preview only
 *   node scripts/import-dnk.js my-dnk-list.csv             # write
 *
 * MONGODB_URI comes from the environment (.env locally; `railway run --` for
 * the live database, docs/SETUP.md) — never commit it. DRY_RUN=1 also works.
 * A DNK list is residents' addresses: keep yours out of git (public/data/dnk.json
 * is served to signed-in users only, and is best left empty — import instead).
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const mongoose = require('mongoose');
const path = require('path');
const { settings, normalizeAreaId, USER_AGENT } = require('../lib/settings');
const { readCsvObjects } = require('./lib/csv');

const DRY_RUN = !!process.env.DRY_RUN || process.argv.includes('--dry-run');
const SRC = process.argv.slice(2).find(a => !a.startsWith('--')) || path.join(__dirname, '..', 'public', 'data', 'dnk.json');
const raw = fs.readFileSync(SRC, 'utf8');
const dnkList = /\.json$/i.test(SRC) ? JSON.parse(raw) : readCsvObjects(raw);

const Edit = mongoose.model('Edit',
  new mongoose.Schema({ zip: { type: String, required: true, unique: true } }, { strict: false })
);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm  = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// Today in the board's timezone, like every other date on the board.
const today = new Intl.DateTimeFormat('en-CA', { timeZone: settings.timezone }).format(new Date());

async function censusGeocode(q) {
  const url = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodeURIComponent(q)}&benchmark=Public_AR_Current&format=json`;
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) return null;
  const m = (await r.json())?.result?.addressMatches?.[0];
  if (!m?.coordinates) return null;
  return { lat: m.coordinates.y, lng: m.coordinates.x, src: 'census' };
}

async function nominatimGeocode(q) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&countrycodes=${encodeURIComponent(settings.countryCodes.join(','))}`;
  const r = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) return null;
  const hit = (await r.json())?.[0];
  if (!hit?.lat) return null;
  return { lat: parseFloat(hit.lat), lng: parseFloat(hit.lon), src: 'nominatim' };
}

async function main() {
  if (!DRY_RUN && !process.env.MONGODB_URI) { console.error('Set MONGODB_URI (or pass --dry-run)'); process.exit(1); }
  if (process.env.MONGODB_URI) await mongoose.connect(process.env.MONGODB_URI);
  console.log(`${dnkList.length} DNK rows from ${SRC}${DRY_RUN ? ' (DRY RUN)' : ''}.\n`);

  const newByZip = {};
  let pinned = 0, unpinned = 0, dupes = 0;
  const useCensus = settings.countryCodes.includes('us');

  for (const row of dnkList) {
    const areaText = String(row.zip ?? row.postcode ?? row.sector ?? '').trim();
    const zip = normalizeAreaId(areaText);
    if (!zip || !row.address) { console.log(`  SKIP (bad row): ${JSON.stringify(row)}`); continue; }

    let geo = null;
    const lat = parseFloat(row.lat), lng = parseFloat(row.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng)) geo = { lat, lng, src: 'given' };
    else {
      // A full postcode is a better lookup than its sector.
      const q = [row.address, row.city, row.state, areaText.length > zip.length ? areaText : zip].filter(Boolean).join(', ');
      if (useCensus) { try { geo = await censusGeocode(q); } catch {} }
      if (!geo) {
        await sleep(1100); // Nominatim usage policy: max 1 req/s
        try { geo = await nominatimGeocode(q); } catch {}
      }
    }

    const existing = [
      ...((mongoose.connection.readyState === 1 ? (await Edit.findOne({ zip }).lean())?.incidents : null) || []),
      ...(newByZip[zip] || []),
    ];
    if (existing.some(inc => inc.address && norm(inc.address) === norm(row.address))) {
      console.log(`  DUP  ${zip}  ${row.address}`);
      dupes++;
      continue;
    }

    const entry = {
      date: today,
      type: 'dnk_issue',
      notes: [row.scope, row.notes].filter(Boolean).join(' — '),
      address: row.address,
    };
    if (geo) { entry.lat = geo.lat; entry.lng = geo.lng; pinned++; }
    else unpinned++;
    (newByZip[zip] = newByZip[zip] || []).push(entry);
    console.log(`  ${geo ? `PIN (${geo.src})` : 'NO PIN     '}  ${zip}  ${row.address}${row.city ? ', ' + row.city : ''}` +
      (geo ? `  → ${geo.lat.toFixed(5)},${geo.lng.toFixed(5)}` : '  (address not found)'));
  }

  if (!DRY_RUN) {
    for (const [zip, list] of Object.entries(newByZip)) {
      const doc = await Edit.findOne({ zip }).lean();
      const incidents = [...(doc?.incidents || []), ...list];
      await Edit.updateOne({ zip }, { $set: { zip, incidents } }, { upsert: true });
    }
  }

  const total = Object.values(newByZip).reduce((a, l) => a + l.length, 0);
  console.log(`\n${DRY_RUN ? 'Would import' : 'Imported'} ${total} incidents across ${Object.keys(newByZip).length} ZIPs ` +
    `(${pinned} pinned, ${unpinned} without coordinates) · ${dupes} duplicate(s) skipped`);
  if (mongoose.connection.readyState === 1) await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
