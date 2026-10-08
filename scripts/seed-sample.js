#!/usr/bin/env node
'use strict';
/**
 * Fill an EMPTY database with the fictional sample territory's working state,
 * so every board (Map, Pipeline, Schedule, Balance) has something on it the
 * first time you open it:
 *   - pipeline stages, offices, work dates, targets, notes and hold-ups on
 *     the 12 sample ZIPs in public/data/master.json
 *   - hub + delivery day per ZIP (from samples/hubs.sample.csv)
 *   - one sample incident, with no map pin
 *   - delivery-day targets for the two sample hubs (Balance board)
 *   - a made-up street map for sample ZIP 01108 (scripts/lib/street-fixture.js),
 *     so Routes → Generate works with no OpenStreetMap call: park the pin
 *     near the printed centre. It is flagged `fixture` and never refreshed.
 * Everything here is made up. Sales come from samples/sales.sample.csv when
 * the server runs with SALES_CSV_FILE=samples/sales.sample.csv.
 *
 * Usage:
 *   MONGODB_URI="mongodb://localhost:27017/cgterritory" node scripts/seed-sample.js
 *   … --force    write even if the edits collection already has documents
 *
 * Refuses to touch a database that already holds edits unless --force, so it
 * can't overwrite a real territory by accident.
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { settings } = require('../lib/settings');
const { readSheet } = require('./import-hubs');
const { SAMPLE_ZIP, buildFixtureGraph } = require('./lib/street-fixture');

const FORCE = process.argv.includes('--force');
const today = new Intl.DateTimeFormat('en-CA', { timeZone: settings.timezone }).format(new Date());
const addDays = (iso, n) => { const t = new Date(iso + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

// Fictional working state per sample ZIP.
const STATE = {
  '01001': { pipeline_stage: 'active',         office: 'west', work_date: addDays(today, -3), sales_target: '25', client_notes: 'Sample: start on the river side.' },
  '01013': { pipeline_stage: 'flagged',        office: 'east', constraints: { permit_pending: addDays(today, -6) } },
  '01020': { pipeline_stage: 'research' },
  '01028': { pipeline_stage: 'permit_secured', office: 'east', permitted_who: 'Sample Rep (fictional)', work_date: addDays(today, 4) },
  '01030': { pipeline_stage: 'ready',          office: 'west', work_date: addDays(today, 2), sales_target: '15' },
  '01040': { pipeline_stage: 'flagged',        incidents: [{ date: addDays(today, -10), type: 'moved_on', notes: 'Fictional example incident: asked to leave the area by a town officer.' }] },
  '01056': { pipeline_stage: 'active',         office: 'east', work_date: addDays(today, -1), sales_target: '20' },
  '01089': { pipeline_stage: 'incoming',       constraints: { awaiting_date: true } },
  '01095': { pipeline_stage: 'incoming' },
  '01108': { pipeline_stage: 'completed',      office: 'west', work_date: addDays(today, -20) },
  '01129': { pipeline_stage: 'ready',          office: 'west', constraints: { needs_cars: true } },
};

const GOALS = [
  { hub: 'riverside', cap: 12, caps: { mon: 12, tue: 10, wed: 8 }, cycle: 1, cycleStart: addDays(today, -45) },
  { hub: 'hilltop',   cap: 10, caps: { mon: 8, tue: 6, wed: 10, thu: 12, fri: 6 }, cycle: 1, cycleStart: addDays(today, -45) },
];

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI not set'); process.exit(1); }
  const master = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'data', 'master.json'), 'utf8'));
  const known = new Set(master.map(r => r.zip));

  const Edit = mongoose.model('Edit', new mongoose.Schema({ zip: { type: String, required: true, unique: true } }, { strict: false }));
  const HubGoal = mongoose.model('HubGoal', new mongoose.Schema({ hub: { type: String, required: true, unique: true } }, { strict: false }));

  await mongoose.connect(uri);
  if (!FORCE && await Edit.estimatedDocumentCount()) {
    console.error('The edits collection already has documents — not seeding (pass --force to write anyway).');
    await mongoose.disconnect(); process.exit(1);
  }

  const hubRows = readSheet(path.join(__dirname, '..', 'samples', 'hubs.sample.csv'));
  const byZip = {};
  for (const r of hubRows) byZip[r.zip] = { hub: r.hub, delivery_day: r.day };
  for (const [zip, st] of Object.entries(STATE)) byZip[zip] = { ...(byZip[zip] || {}), ...st };

  const offices = new Set(settings.officeKeys);
  const ops = Object.entries(byZip).filter(([zip]) => known.has(zip)).map(([zip, set]) => {
    if (set.office && !offices.has(set.office)) delete set.office;   // settings changed: let distance decide
    return { updateOne: { filter: { zip }, update: { $set: { zip, ...set } }, upsert: true } };
  });
  const r = await Edit.bulkWrite(ops);
  console.log(`edits: ${ops.length} sample ZIPs (upserted ${r.upsertedCount}, modified ${r.modifiedCount})`);

  const hubs = new Set(settings.hubKeys);
  for (const g of GOALS) {
    if (!hubs.has(g.hub)) continue;
    await HubGoal.updateOne({ hub: g.hub }, { $set: { ...g, plan: {}, history: [], updatedAt: new Date(), updatedBy: 'seed-sample.js' } }, { upsert: true });
  }
  console.log(`hub goals: ${GOALS.filter(g => hubs.has(g.hub)).length}`);

  // Made-up street map for one sample ZIP: route generation without Overpass.
  const OsmCache = mongoose.connection.collection('osmcaches');
  if (!known.has(SAMPLE_ZIP)) {
    console.log(`street map: sample ZIP ${SAMPLE_ZIP} is not in this territory — skipped`);
  } else if (!FORCE && await OsmCache.findOne({ zip: SAMPLE_ZIP, fixture: { $ne: true } })) {
    console.log(`street map: ${SAMPLE_ZIP} already has a real OpenStreetMap graph — left alone (--force replaces it)`);
  } else {
    try {
      const graph = buildFixtureGraph(SAMPLE_ZIP);
      await OsmCache.updateOne({ zip: SAMPLE_ZIP }, { $set: {
        zip: SAMPLE_ZIP, fetchedAt: new Date(), stats: graph.stats, v: graph.v, pv: 0, fixture: true, blob: '', graph,
      } }, { upsert: true });
      console.log(`street map: made-up grid for ${SAMPLE_ZIP} (${graph.stats.segs} blocks, ${graph.stats.doors} doors); park the pin near ${graph.centre.join(', ')}`);
    } catch (e) { console.log(`street map: skipped (${e.message})`); }
  }

  await mongoose.disconnect();
  if (process.env.CGT_DEV_MEM) console.log('Sample loaded.');   // scripts/dev-mem.js starts the server next
  else console.log('Done. Start the server (npm start) to see the sample. If it was already running, restart it, or wait up to 30 minutes for it to pick up the new state.');
}

main().catch(e => { console.error(e); process.exit(1); });
