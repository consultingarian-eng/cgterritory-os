'use strict';
// Object storage for the big, read-whole blobs — per-ZIP street graphs,
// parcel sets, RAM-store snapshots — on Cloudflare R2 (any S3-compatible
// store works). No SDK: SigV4 is ~60 lines and fetch is built in. When the
// CGT_S3_* variables are not set every call reports `enabled: false` and
// callers keep their Mongo path.
//
//   CGT_S3_ENDPOINT          https://<account>.r2.cloudflarestorage.com
//   CGT_S3_BUCKET            your-bucket-name
//   CGT_S3_ACCESS_KEY_ID
//   CGT_S3_SECRET_ACCESS_KEY
//   CGT_S3_REGION            auto (R2 default)

const crypto = require('crypto');
const zlib   = require('zlib');

const cfg = {
  endpoint: (process.env.CGT_S3_ENDPOINT || '').replace(/\/$/, ''),
  bucket:   process.env.CGT_S3_BUCKET || '',
  key:      process.env.CGT_S3_ACCESS_KEY_ID || '',
  secret:   process.env.CGT_S3_SECRET_ACCESS_KEY || '',
  region:   process.env.CGT_S3_REGION || 'auto',
};
const enabled = !!(cfg.endpoint && cfg.bucket && cfg.key && cfg.secret);

const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
const encodeSeg = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// Signed request against the bucket (path-style, as R2 expects).
async function s3(method, key, { body = null, headers = {}, timeoutMs = 60_000, retries = 2, bucket = cfg.bucket, query = '' } = {}) {
  const url = new URL(cfg.endpoint);
  const path = '/' + [bucket, ...String(key || '').split('/').filter(Boolean)].map(encodeSeg).join('/');
  const payloadHash = sha256(body || '');
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, '');   // 20260923T181500Z
    const date = amzDate.slice(0, 8);
    const hdrs = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)])) };
    const signedHeaders = Object.keys(hdrs).sort().join(';');
    const canonicalHeaders = Object.keys(hdrs).sort().map(k => `${k}:${hdrs[k].trim()}\n`).join('');
    const canonical = [method, path, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = `${date}/${cfg.region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
    const kSigning = hmac(hmac(hmac(hmac('AWS4' + cfg.secret, date), cfg.region), 's3'), 'aws4_request');
    const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');
    const authorization = `AWS4-HMAC-SHA256 Credential=${cfg.key}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(`${cfg.endpoint}${path}${query ? '?' + query : ''}`, { method, headers: { ...hdrs, authorization }, body, signal: ctrl.signal });
      if (r.status >= 500 && attempt < retries) throw new Error(`HTTP ${r.status}`);
      return r;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise(res => setTimeout(res, 800 * (attempt + 1)));
    } finally { clearTimeout(timer); }
  }
  throw lastErr;
}

async function putJson(key, obj) {
  if (!enabled) return false;
  const body = zlib.gzipSync(Buffer.from(JSON.stringify(obj)), { level: 6 });
  const r = await s3('PUT', key, { body, headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': String(body.length) } });
  if (!r.ok) throw new Error(`R2 put ${key}: HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
  return true;
}

// null when the object does not exist.
async function getJson(key) {
  if (!enabled) return null;
  const r = await s3('GET', key);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`R2 get ${key}: HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const raw = buf.length > 1 && buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf;
  return JSON.parse(raw.toString('utf8'));
}

// Raw bytes in and out — for bodies already encoded by the caller (the
// nightly backup streams its own gzip).
async function putBuffer(key, body, headers = {}) {
  if (!enabled) return false;
  const r = await s3('PUT', key, { body, headers: { ...headers, 'content-length': String(body.length) }, timeoutMs: 300_000 });
  if (!r.ok) throw new Error(`R2 put ${key}: HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
  return true;
}

// null when the object does not exist.
async function getBuffer(key) {
  if (!enabled) return null;
  const r = await s3('GET', key, { timeoutMs: 300_000 });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`R2 get ${key}: HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
  return Buffer.from(await r.arrayBuffer());
}

async function head(key) {
  if (!enabled) return null;
  const r = await s3('HEAD', key);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`R2 head ${key}: HTTP ${r.status}`);
  return { size: +r.headers.get('content-length') || 0, lastModified: r.headers.get('last-modified') };
}

async function del(key) {
  if (!enabled) return false;
  const r = await s3('DELETE', key);
  if (!r.ok && r.status !== 404) throw new Error(`R2 delete ${key}: HTTP ${r.status}`);
  return true;
}

// Keys under a prefix (first page, ≤1000): for ops checks, not the hot path.
async function list(prefix = '', max = 1000) {
  if (!enabled) return [];
  const r = await s3('GET', '', { query: `list-type=2&max-keys=${max}&prefix=${encodeURIComponent(prefix)}` });
  if (!r.ok) throw new Error(`R2 list ${prefix}: HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
  const xml = await r.text();
  return [...xml.matchAll(/<Contents>[\s\S]*?<Key>([^<]+)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>[\s\S]*?<\/Contents>/g)].map(m => ({ key: m[1], size: +m[2] }));
}

// One-off: create the bucket (needs an account-level key).
async function createBucket(name) {
  const r = await s3('PUT', '', { bucket: name });
  if (r.ok || r.status === 409) return true;   // 409: already ours
  throw new Error(`R2 create bucket ${name}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
}

module.exports = { enabled, bucket: cfg.bucket, putJson, getJson, putBuffer, getBuffer, head, del, list, createBucket };
