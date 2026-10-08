'use strict';
// Nightly backup of the whole database to R2 (or any S3-compatible bucket).
// Free database tiers keep no backups of their own, so without this a bad
// script or a dropped collection is unrecoverable.
//
// Every collection is copied each night as gzipped EJSON lines (types such
// as ObjectId and Date survive the round trip) under
//   backups/<date>/<collection>.<full|changes>.ndjson.gz
// and backups/<date>/manifest.json is written last — a night without a
// manifest never finished and doesn't count.
//
// The two big collections are copied whole once a week and as each night's
// changes in between: a full copy of every worked door every night would
// add heavily to the transfer that gets a shared-tier cluster
// throttled. "Changes" are the docs whose stamp field moved in the last two
// days (overlapping nights are harmless — a restore upserts by _id). An
// update that doesn't touch the stamp (a geocode filling lat/lng) waits for
// the next weekly copy; the geo worker re-places such a door from GeoCache.
//
// scripts/restore-backup.js rebuilds any night: latest full + changes since.
//
// The copies include the users collection (password hashes, invite tokens).
// Set BACKUP_ENCRYPTION_KEY and every data file is AES-256-GCM encrypted
// before it leaves the server (lib/security.js); keep that key somewhere
// other than the server's own variables too, or the backups can't be read.
// BACKUP_PRUNE=off leaves old nights to the bucket's own lifecycle rule, so
// the app needs no delete permission on the backup prefix. See SECURITY.md.

const zlib = require('zlib');
const { once } = require('events');
const blobs = require('./blobstore');
const sec = require('./security');
const ENC_KEY = sec.backupKey(process.env.BACKUP_ENCRYPTION_KEY || '');
const PRUNE = !/^(0|false|off|no)$/i.test(process.env.BACKUP_PRUNE || '');

const PREFIX = 'backups/';
const KEEP_DAYS = 30;
const FULL_EVERY_DAYS = 7;
const CHANGES_WINDOW_MS = 48 * 3600 * 1000;
const RUN_AFTER_ET_HOUR = 3;   // 03:00 board time — the field day and its syncs are done
const INCREMENTAL = { workeddoors: 'syncedAt', geocaches: 'createdAt' };

function daysBetween(a, b) {   // YYYY-MM-DD strings, b - a
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

// What's already in the bucket: complete nights and the newest full copy of
// each incremental collection.
async function inventory() {
  const keys = await blobs.list(PREFIX);
  const nights = new Set();
  const fulls = {};   // collection -> [dates with a full copy]
  for (const { key } of keys) {
    const m = key.match(/^backups\/(\d{4}-\d{2}-\d{2})\/(.+)$/);
    if (!m) continue;
    const [, date, file] = m;
    if (file === 'manifest.json') nights.add(date);
    const f = file.match(/^(.+)\.full\.ndjson\.gz$/);
    if (f) (fulls[f[1]] ||= []).push(date);
  }
  const fullDates = {}, latestFull = {};
  for (const [coll, dates] of Object.entries(fulls)) {
    const done = dates.filter(d => nights.has(d)).sort();
    if (done.length) { fullDates[coll] = done; latestFull[coll] = done[done.length - 1]; }
  }
  return { keys, nights: [...nights].sort(), fullDates, latestFull };
}

// Stream one query into a gzipped EJSON-lines buffer.
async function dumpQuery(coll, query, EJSON) {
  const gz = zlib.createGzip({ level: 6 });
  const chunks = [];
  gz.on('data', c => chunks.push(c));
  const ended = once(gz, 'end');
  let count = 0;
  const cursor = coll.find(query).batchSize(5000);
  for await (const doc of cursor) {
    if (!gz.write(EJSON.stringify(doc, { relaxed: false }) + '\n')) await once(gz, 'drain');
    count++;
  }
  gz.end();
  await ended;
  return { body: Buffer.concat(chunks), count };
}

module.exports = function createBackup({ mongoose, etToday, timezone = require('./settings').settings.timezone, notify = async () => {} }) {
  const EJSON = mongoose.mongo.BSON.EJSON;
  const status = { running: false, lastRun: null, lastError: null, lastErrorMailed: null };

  async function runBackup({ date = etToday(), force = false } = {}) {
    if (!blobs.enabled) throw new Error('R2 is not configured (CGT_S3_* variables)');
    const db = mongoose.connection.db;
    if (!db) throw new Error('MongoDB is not connected');
    const t0 = Date.now();
    const inv = await inventory();
    if (inv.nights.includes(date) && !force) return { skipped: true, date };

    const names = (await db.listCollections({}, { nameOnly: true }).toArray())
      .map(c => c.name).filter(n => !n.startsWith('system.')).sort();
    const manifest = { date, startedAt: new Date(t0).toISOString(), collections: {} };
    for (const name of names) {
      const stamp = INCREMENTAL[name];
      const last = inv.latestFull[name];
      const full = !stamp || !last || daysBetween(last, date) >= FULL_EVERY_DAYS || last === date;
      const query = full ? {} : { [stamp]: { $gte: new Date(t0 - CHANGES_WINDOW_MS) } };
      const { body: gz, count } = await dumpQuery(db.collection(name), query, EJSON);
      const key = `${PREFIX}${date}/${name}.${full ? 'full' : 'changes'}.ndjson.gz`;
      // Encrypted files are opaque bytes: no content-encoding, or a client
      // would try to gunzip ciphertext.
      const body = ENC_KEY ? sec.encryptBuffer(gz, ENC_KEY) : gz;
      await blobs.putBuffer(key, body, ENC_KEY ? { 'content-type': 'application/octet-stream' }
                                               : { 'content-type': 'application/x-ndjson', 'content-encoding': 'gzip' });
      manifest.collections[name] = { mode: full ? 'full' : 'changes', count, bytes: body.length, key, encrypted: !!ENC_KEY,
        ...(full ? {} : { since: query[stamp].$gte.toISOString(), stamp, fullFrom: last }) };
    }
    manifest.finishedAt = new Date().toISOString();
    await blobs.putJson(`${PREFIX}${date}/manifest.json`, manifest);

    // Prune nights older than KEEP_DAYS — but keep the full copy the oldest
    // kept night's changes chain from, so every kept night stays restorable.
    const after = await inventory();
    const cutoff = new Date(Date.parse(date + 'T00:00:00Z') - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
    let keepFrom = cutoff;
    for (const dates of Object.values(after.fullDates)) {
      const anchor = dates.filter(d => d <= cutoff).pop();
      if (anchor && anchor < keepFrom) keepFrom = anchor;
    }
    let pruned = 0;
    if (PRUNE) for (const { key } of after.keys) {
      const m = key.match(/^backups\/(\d{4}-\d{2}-\d{2})\//);
      if (m && m[1] < keepFrom) { await blobs.del(key); pruned++; }
    }

    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    const total = Object.values(manifest.collections).reduce((s, c) => s + c.bytes, 0);
    console.log(`[backup] ${date}: ${names.length} collections, ${(total / 1e6).toFixed(1)} MB gz in ${secs}s` +
      (pruned ? `, pruned ${pruned} old files` : ''));
    return manifest;
  }

  // Called every 20 minutes: runs once per board day after 03:00, and retries
  // on the next tick if a run fails. Failure mails go out once a day at most.
  async function tick() {
    if (status.running || !blobs.enabled || mongoose.connection.readyState !== 1) return;
    const hour = +new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hourCycle: 'h23' }).format(new Date());
    if (hour < RUN_AFTER_ET_HOUR) return;
    status.running = true;
    try {
      const r = await runBackup();
      if (!r.skipped) { status.lastRun = r; status.lastError = null; }
    } catch (e) {
      status.lastError = { at: new Date().toISOString(), message: e.message };
      console.error('[backup] FAILED:', e.message);
      const today = etToday();
      if (status.lastErrorMailed !== today) {
        status.lastErrorMailed = today;
        await notify(e).catch(err => console.error('[backup] could not send the failure mail:', err.message));
      }
    } finally { status.running = false; }
  }

  async function listNights() {
    if (!blobs.enabled) return { enabled: false, nights: [], latestFull: {} };
    const inv = await inventory();
    return { enabled: true, nights: inv.nights, latestFull: inv.latestFull };
  }

  return { runBackup, tick, listNights, status };
};
