#!/usr/bin/env node
'use strict';
/**
 * Sanity-check config/territory.json against the data files, without a
 * database or the network:
 *   node scripts/check-config.js        (or: npm run check)
 *
 * Checks: every region's polygon file exists and parses; every master.json
 * record has a valid area id and a region that exists; every polygon has a
 * master record (and the other way round); office keys and hub keys are
 * unique; office regions exist. Exits 1 on an error, 0 with warnings.
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { settings, normalizeAreaId, USER_AGENT } = require('../lib/settings');

const PUB = path.join(__dirname, '..', 'public');
const errors = [], warnings = [];
const err = m => errors.push(m), warn = m => warnings.push(m);

const dupes = arr => arr.filter((k, i) => arr.indexOf(k) !== i);
if (dupes(settings.officeKeys).length) err(`duplicate office keys: ${dupes(settings.officeKeys).join(', ')}`);
if (dupes(settings.hubKeys).length) err(`duplicate hub keys: ${dupes(settings.hubKeys).join(', ')}`);
try { new Intl.DateTimeFormat('en-CA', { timeZone: settings.timezone }); } catch { err(`timezone "${settings.timezone}" is not a valid IANA zone`); }
if (!settings.regions.length) err('no regions: add at least one { "code", "file" } to config/territory.json');
const regionCodes = new Set(settings.regions.map(r => r.code));
for (const o of settings.offices) {
  for (const r of o.regions || []) if (!regionCodes.has(r)) warn(`office "${o.key}" lists region "${r}", which is not in regions`);
  if (!Number.isFinite(o.lat) || !Number.isFinite(o.lng)) warn(`office "${o.key}" has no lat/lng — import-territory.js can't compute distances from it`);
}

let master = [];
try { master = JSON.parse(fs.readFileSync(path.join(PUB, 'data', 'master.json'), 'utf8')); }
catch (e) { err(`public/data/master.json: ${e.message}`); }
if (!Array.isArray(master)) { err('public/data/master.json must be an array of records'); master = []; }
const ids = new Set();
for (const r of master) {
  if (!r || typeof r.zip !== 'string') { err(`a master record has no string "zip": ${JSON.stringify(r).slice(0, 80)}`); continue; }
  if (normalizeAreaId(r.zip) !== r.zip) err(`master id "${r.zip}" doesn't match areaIdPattern (or isn't normalised, e.g. a ZIP missing its leading zero)`);
  if (!regionCodes.has(r.state)) err(`master ${r.zip}: region "${r.state}" is not in regions`);
  if (ids.has(r.zip)) err(`master ${r.zip} appears twice`);
  ids.add(r.zip);
}

const polyIds = new Set();
for (const reg of settings.regions) {
  const f = path.join(PUB, String(reg.file).split('?')[0].replace(/^\/+/, ''));
  if (!f.startsWith(PUB)) { err(`region ${reg.code}: file must be under public/`); continue; }
  let gj;
  try { gj = JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) { err(`region ${reg.code}: ${path.relative(process.cwd(), f)}: ${e.message}`); continue; }
  for (const feat of gj.features || []) {
    const p = feat.properties || {};
    const id = normalizeAreaId(p.POSTCODE || p.ZCTA5CE10 || '');
    if (!id) { warn(`region ${reg.code}: a polygon has no usable POSTCODE / ZCTA5CE10 property`); continue; }
    polyIds.add(id);
  }
}
const noPoly = [...ids].filter(id => !polyIds.has(id));
const noRec = [...polyIds].filter(id => !ids.has(id));
if (noPoly.length) warn(`${noPoly.length} master record(s) have no polygon (they can't be clicked on the map): ${noPoly.slice(0, 10).join(', ')}`);
if (noRec.length) warn(`${noRec.length} polygon(s) have no master record (they draw grey and open no drawer): ${noRec.slice(0, 10).join(', ')}`);

// OpenStreetMap's free services (Overpass, Nominatim) ask for a contact in the
// User-Agent and may refuse anonymous or obviously fake ones.
const contact = process.env.GEOCODER_CONTACT || process.env.ADMIN_EMAIL || process.env.APP_URL || '';
if (!contact) warn('no GEOCODER_CONTACT or ADMIN_EMAIL in the environment — OpenStreetMap services get no contact address (User-Agent: ' + USER_AGENT + ')');
else if (/@example\.|\.(test|invalid|example|local)\b/i.test(contact)) warn(`contact "${contact}" is a placeholder — set GEOCODER_CONTACT to an address you read before routes or geocoding go live`);
console.log(`${settings.brand.appName}: ${settings.offices.length} office(s), ${settings.hubs.length} hub(s), ${settings.regions.length} region(s), ${master.length} areas, ${polyIds.size} polygons, timezone ${settings.timezone}`);
for (const w of warnings) console.log(`  warning: ${w}`);
for (const e of errors) console.log(`  ERROR:   ${e}`);
console.log(errors.length ? `${errors.length} error(s).` : 'OK');
process.exit(errors.length ? 1 : 0);
