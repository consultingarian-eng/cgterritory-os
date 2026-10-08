#!/usr/bin/env node
'use strict';
// Rebuild one night of the nightly R2/S3 backup (lib/backup.js). Examples use
// `railway run --` to borrow the deployed env vars; with a local .env holding
// the CGT_S3_* variables, plain `node scripts/restore-backup.js …` works too.
//
//   railway run -- node scripts/restore-backup.js list
//       nights available, and each big collection's newest full copy
//
//   railway run -- node scripts/restore-backup.js 2026-10-01 --out ./restore
//       write that night's data as plain EJSON-lines files, one per
//       collection, without touching any database — for a look, or a diff
//
//   railway run -- node scripts/restore-backup.js 2026-10-01 --target <mongodb-uri> [--only knocks,edits] [--drop]
//       load it into a database. A collection that already holds documents
//       is refused unless --drop (empty it first). Indexes come back when
//       the app next boots against that database (mongoose autoIndex).
//
// For the big collections a night may hold only that night's changes; the
// restore loads the newest full copy on or before the night, then every
// changes file after it in date order, upserting by _id (later wins).
//
// Needs the CGT_S3_* variables. --target is
// always explicit: point it at the live MONGODB_URI only when that is truly
// the intent. The free-tier cluster's 512 MB cap includes every database
// on it, so a second full copy beside the live one will not fit there.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const mongoose = require('mongoose');
const blobs = require('../lib/blobstore');
const sec = require('../lib/security');
const ENC_KEY = sec.backupKey(process.env.BACKUP_ENCRYPTION_KEY || '');

const EJSON = mongoose.mongo.BSON.EJSON;
const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i >= 0 ? (args[i + 1] || true) : null; };

function die(msg) { console.error(msg); process.exit(1); }

async function manifests() {
  const keys = await blobs.list('backups/');
  const dates = keys.map(k => k.key.match(/^backups\/(\d{4}-\d{2}-\d{2})\/manifest\.json$/)).filter(Boolean).map(m => m[1]).sort();
  const out = [];
  for (const d of dates) out.push(await blobs.getJson(`backups/${d}/manifest.json`));
  return out;
}

// The files that rebuild `coll` as of `night`, oldest first.
function chainFor(coll, night, all) {
  const upto = all.filter(m => m.date <= night && m.collections[coll]);
  const lastFull = upto.map(m => m.date).filter(d => upto.find(m => m.date === d).collections[coll].mode === 'full').pop();
  if (!lastFull) return null;
  return upto.filter(m => m.date >= lastFull).map(m => ({ date: m.date, ...m.collections[coll] }));
}

async function* docsFrom(key) {
  let buf = await blobs.getBuffer(key);
  if (!buf) throw new Error(`missing ${key}`);
  // Encrypted night (BACKUP_ENCRYPTION_KEY was set when it was written)
  if (sec.isEncrypted(buf)) {
    if (!ENC_KEY) throw new Error(`${key} is encrypted — set BACKUP_ENCRYPTION_KEY to the key the backup was written with`);
    buf = sec.decryptBuffer(buf, ENC_KEY);
  }
  // fetch may already have undone the gzip (the object carries content-encoding: gzip)
  if (buf.length > 1 && buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  for (const line of buf.toString('utf8').split('\n')) if (line) yield EJSON.parse(line, { relaxed: false });
}

(async () => {
  if (!blobs.enabled) die('CGT_S3_* variables are not set (put them in .env, or run under your host\'s env, e.g. `railway run --`).');
  const all = await manifests();
  const night = args[0];

  if (!night || night === 'list') {
    if (!all.length) return console.log('No complete backup nights yet.');
    for (const m of all) {
      const total = Object.values(m.collections).reduce((s, c) => s + c.bytes, 0);
      const changes = Object.entries(m.collections).filter(([, c]) => c.mode === 'changes').map(([n]) => n);
      console.log(`${m.date}  ${Object.keys(m.collections).length} collections  ${(total / 1e6).toFixed(1)} MB gz` +
        (changes.length ? `  (changes only: ${changes.join(', ')})` : '  (all full)'));
    }
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(night)) die('Usage: restore-backup.js list | <YYYY-MM-DD> (--out <dir> | --target <mongodb-uri>) [--only a,b] [--drop]');
  const m = all.find(x => x.date === night);
  if (!m) die(`No complete backup for ${night}. Run with "list" to see the nights available.`);

  const only = flag('--only');
  const colls = Object.keys(m.collections).filter(c => !only || only.split(',').includes(c));
  const out = flag('--out'), target = flag('--target'), drop = args.includes('--drop');
  if (!!out === !!target) die('Pass exactly one of --out <dir> or --target <mongodb-uri>.');

  let db = null;
  if (target) {
    const conn = await mongoose.createConnection(target).asPromise();
    db = conn.db;
    for (const c of colls) {
      const n = await db.collection(c).estimatedDocumentCount();
      if (n && !drop) die(`${c} in the target already holds ${n} documents — pass --drop to replace it.`);
    }
  } else fs.mkdirSync(out, { recursive: true });

  for (const c of colls) {
    const chain = chainFor(c, night, all);
    if (!chain) { console.warn(`${c}: no full copy on or before ${night} — skipped`); continue; }
    const docs = new Map();
    for (const f of chain) for await (const d of docsFrom(f.key)) docs.set(EJSON.stringify(d._id), d);
    const label = chain.length > 1 ? `full ${chain[0].date} + ${chain.length - 1} night(s) of changes` : `full ${chain[0].date}`;
    if (db) {
      if (drop) await db.collection(c).deleteMany({});
      const list = [...docs.values()];
      for (let i = 0; i < list.length; i += 1000)
        await db.collection(c).bulkWrite(list.slice(i, i + 1000).map(d => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } })), { ordered: false });
      console.log(`${c}: ${docs.size} documents loaded (${label})`);
    } else {
      const file = path.join(out, `${c}.ndjson`);
      fs.writeFileSync(file, [...docs.values()].map(d => EJSON.stringify(d, { relaxed: false })).join('\n') + (docs.size ? '\n' : ''));
      console.log(`${c}: ${docs.size} documents → ${file} (${label})`);
    }
  }
  process.exit(0);
})().catch(e => die(e.stack || e.message));
