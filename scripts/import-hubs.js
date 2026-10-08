#!/usr/bin/env node
'use strict';
/**
 * Import ZIP → hub (and optionally delivery_day) from a territory sheet onto
 * the ZIP edits collection, for the Balance board and the 🏭 Hub filter.
 *
 * CSV columns (header names are matched case-insensitively):
 *   Zip (or Postcode / Sector)   the territory id; spreadsheets often drop
 *                                a ZIP's leading zero — it is restored
 *   Hub                          a hub key, label or alias from
 *                                config/territory.json "hubs"
 *   Delivery Day (or Day)        optional; Monday… / Mon… / 1–7 (1 = Monday)
 * See samples/hubs.sample.csv.
 *
 * Only `hub` is written by default. Pass --with-days (or WITH_DAYS=1) to also
 * take the sheet's delivery day as authoritative (opt-in, so re-importing never
 * clobbers corrections made in the app).
 *
 * Usage (the flags work the same on Mac, Linux and Windows):
 *   node scripts/import-hubs.js --dry-run samples/hubs.sample.csv   # preview, no connection
 *   node scripts/import-hubs.js my-hub-a.csv my-hub-b.csv           # later files win
 *   node scripts/import-hubs.js --with-days my-hubs.csv             # also set delivery_day
 *
 * MONGODB_URI comes from the environment (.env locally; `railway run --` for
 * the live database, docs/SETUP.md) — never commit it.
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const mongoose = require('mongoose');
const { settings, normalizeAreaId } = require('../lib/settings');
const { parseCsv } = require('./lib/csv');

// key / label / alias (folded) → hub key, from settings
const fold = s => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
const HUB_KEYS = {};
for (const h of settings.hubs)
  for (const name of [h.key, h.label, ...(h.aliases || [])]) HUB_KEYS[fold(name)] = h.key;

const DAY_KEYS = { mon:'mon', tue:'tue', wed:'wed', thu:'thu', fri:'fri', sat:'sat', sun:'sun',
  1:'mon', 2:'tue', 3:'wed', 4:'thu', 5:'fri', 6:'sat', 7:'sun' };
const normDay = v => DAY_KEYS[String(v || '').trim().toLowerCase().slice(0, 3)] || null;

function readSheet(path) {
  const rows = parseCsv(fs.readFileSync(path, 'utf8'));
  if (rows.length < 2) return [];
  const headers = rows[0].map(h => h.toLowerCase().trim());
  const zipCol = headers.findIndex(h => /zip|postcode|sector/.test(h));
  const hubCol = headers.findIndex(h => h === 'hub' || h === 'depot');
  const dayCol = headers.findIndex(h => (h.includes('delivery') && h.includes('day')) || h === 'day');
  if (zipCol < 0 || hubCol < 0)
    throw new Error(`${path}: needs both a "Zip" and a "Hub" column (found: ${headers.join(', ')})`);

  const out = [];
  for (const r of rows.slice(1)) {
    const zip = normalizeAreaId(r[zipCol]);
    if (!zip) continue;
    const hub = HUB_KEYS[fold(r[hubCol])];
    if (!hub) { console.warn(`  ! ${zip}: hub "${r[hubCol]}" is not in config/territory.json — skipped`); continue; }
    const day = dayCol >= 0 ? normDay(r[dayCol]) : null;
    out.push({ zip, hub, day });
  }
  return out;
}

const FLAGS = new Set(process.argv.slice(2).filter(a => a.startsWith('--')));
const DRY_RUN = !!process.env.DRY_RUN || FLAGS.has('--dry-run');
const WITH_DAYS = !!process.env.WITH_DAYS || FLAGS.has('--with-days');

async function main() {
  const paths = process.argv.slice(2).filter(a => !a.startsWith('--'));
  if (!paths.length) { console.error('Usage: node scripts/import-hubs.js <csv> [csv…]'); process.exit(1); }
  if (!settings.hubs.length) { console.error('No hubs in config/territory.json — add them first.'); process.exit(1); }

  // Later files win on conflict, so re-running a corrected sheet fixes a ZIP.
  const byZip = new Map();
  for (const p of paths) {
    const rows = readSheet(p);
    console.log(`${p}: ${rows.length} ZIPs`);
    for (const r of rows) byZip.set(r.zip, r);
  }

  const rows = [...byZip.values()];
  const byHub = {};
  for (const r of rows) byHub[r.hub] = (byHub[r.hub] || 0) + 1;
  console.log(`\n${rows.length} unique ZIPs. By hub:`, byHub);
  if (WITH_DAYS) {
    const byDay = {};
    for (const r of rows) if (r.day) byDay[r.day] = (byDay[r.day] || 0) + 1;
    console.log('--with-days — delivery_day will also be written. By day:', byDay);
  }

  if (DRY_RUN) { console.log('\nDry run — not connecting or writing.'); return; }

  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI not set'); process.exit(1); }

  // Same model/collection the app uses (mongoose pluralizes Edit → "edits").
  const Edit = mongoose.model('Edit',
    new mongoose.Schema({ zip: { type: String, required: true, unique: true } }, { strict: false })
  );

  await mongoose.connect(uri);
  console.log('\nConnected.');

  const ops = rows.map(({ zip, hub, day }) => {
    const $set = { zip, hub };
    if (WITH_DAYS && day) $set.delivery_day = day;
    return { updateOne: { filter: { zip }, update: { $set }, upsert: true } };
  });
  const res = await Edit.bulkWrite(ops);
  console.log(`Upserted: matched=${res.matchedCount} modified=${res.modifiedCount} upserted=${res.upsertedCount}`);
  console.log('The running server re-reads edits every 30 minutes; restart it to see them at once.');

  await mongoose.disconnect();
  console.log('Done.');
}

module.exports = { readSheet, HUB_KEYS };

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}
