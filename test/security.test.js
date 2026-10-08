'use strict';
// Unit tests for lib/security.js — no database, no network.
//   node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const sec = require('../lib/security');

const XSS = '<img src=x onerror=alert(1)>';
const isAreaId = v => /^(\d{5}|[A-Z]{1,2}\d[A-Z\d]? \d)$/.test(v);
const round = pts => pts.map(p => [Math.round(+p[0] * 1e5) / 1e5, Math.round(+p[1] * 1e5) / 1e5]).filter(p => p.every(Number.isFinite));

test('isDate accepts real calendar dates only', () => {
  assert.equal(sec.isDate('2026-10-08'), true);
  assert.equal(sec.isDate('2026-02-30'), false);
  assert.equal(sec.isDate('2026-10-08' + XSS), false);
  assert.equal(sec.isDate(20261008), false);
});

test('incidents: markup in type/date cannot survive, bad coordinates are dropped', () => {
  const r = sec.sanitizeIncidents([
    { type: XSS, date: '2026-10-08' + XSS, notes: 'n', address: '1 Main St', lat: 'abc', lng: -72.6, extra: XSS },
    { type: 'weapons', date: '2026-10-01', lat: 42.1, lng: -72.6 },
    'not an object',
  ], '2026-10-08');
  assert.equal(r.value.length, 2);
  const [a, b] = r.value;
  assert.equal(a.type, 'other');
  assert.equal(a.date, '2026-10-08');           // unreadable date → today
  assert.equal('lat' in a, false);
  assert.equal('extra' in a, false);
  assert.deepEqual(b, { date: '2026-10-01', type: 'weapons', notes: '', lat: 42.1, lng: -72.6 });
});

test('incidents: list length capped', () => {
  assert.ok(sec.sanitizeIncidents(new Array(501).fill({}), '2026-10-08').error);
  assert.ok(sec.sanitizeIncidents('x', '2026-10-08').error);
});

test('validateEditPatch: operator field names and malformed scheduling fields are refused', () => {
  const ctx = { today: '2026-10-08', hubKeys: ['riverside'], officeKeys: ['east'], isAreaId };
  assert.ok(sec.validateEditPatch({ $where: 1 }, ctx).error);
  assert.ok(sec.validateEditPatch({ 'a.b': 1 }, ctx).error);
  assert.ok(sec.validateEditPatch({ work_date: '2026-10-08' + XSS }, ctx).error);
  assert.ok(sec.validateEditPatch({ day_change: { to: 'mon', on: XSS } }, ctx).error);
  assert.ok(sec.validateEditPatch({ hub: 'nowhere' }, ctx).error);
  assert.ok(sec.validateEditPatch({ color: XSS }, ctx).error);
  assert.ok(sec.validateEditPatch({ notes: { $gt: '' } }, ctx).error);
  const ok = sec.validateEditPatch({ zip: 'x', color: 'RED', hub: 'riverside', work_date: '', notes: 'hi', blocked_by: null }, ctx);
  assert.deepEqual(ok, { set: { color: 'RED', hub: 'riverside', work_date: '', notes: 'hi' }, unset: { blocked_by: '' } });
});

test('validateEditPatch: figures stay numbers and place names stay plain text', () => {
  const ctx = { today: '2026-10-08', hubKeys: [], officeKeys: [], isAreaId };
  // The fields the drawer, popup and pipeline card draw without markup.
  for (const f of ['households', 'dist_miles', 'dist_miles_west', 'drive_mins_east', 'transit_mins_west'])
    assert.ok(sec.validateEditPatch({ [f]: XSS }, ctx).error, f);
  for (const f of ['county', 'state', 'primary_city', 'municipality'])
    assert.ok(sec.validateEditPatch({ [f]: `<iframe srcdoc="x"></iframe>` }, ctx).error, f);
  assert.ok(sec.validateEditPatch({ sales_target: '12' + XSS }, ctx).error);
  assert.ok(sec.validateEditPatch({ difficulty: '9' }, ctx).error);
  assert.deepEqual(sec.validateEditPatch({ households: '4100', drive_mins_west: 22, county: 'Hampden County', sales_target: '25', internal_notes: '<5 min walk' }, ctx),
    { set: { households: 4100, drive_mins_west: 22, county: 'Hampden County', sales_target: '25', internal_notes: '<5 min walk' }, unset: {} });
});

test('sanitizeKnock: strict date, point cap, style allow-list', () => {
  const deps = { isAreaId, round };
  assert.ok(sec.sanitizeKnock({ date: '2026-10-08' + XSS, latlngs: [[42, -72]] }, deps).error);
  assert.ok(sec.sanitizeKnock({ date: '2026-10-08', latlngs: new Array(5001).fill([42, -72]) }, deps).error);
  assert.ok(sec.sanitizeKnock({ date: '2026-10-08', latlngs: [[42, -72]], zip: XSS }, deps).error);
  const v = sec.sanitizeKnock({ date: '2026-10-08', zip: '01001', latlngs: [[42, -72], [91, 0]],
    style: { color: '#f97316', weight: 5, opacity: 0.8, lineCap: 'round', className: XSS, color2: 'x' } }, deps);
  assert.deepEqual(v.value, { zip: '01001', latlngs: [[42, -72]], date: '2026-10-08',
    style: { color: '#f97316', weight: 5, opacity: 0.8, lineCap: 'round' } });
});

test('sanitizePrefs: known keys and types only, userId never kept', () => {
  const p = sec.sanitizePrefs({
    userId: 'someone-else', coverageFrom: '"><script>x</script>', coverageTo: '2026-10-01',
    showHelpers: true, showSalesPins: 'yes', overlayOpacity: 0.4, hubFilter: XSS,
    activeStates: ['MA', XSS], $set: { a: 1 },
  });
  assert.deepEqual(p, { showHelpers: true, coverageTo: '2026-10-01', overlayOpacity: 0.4, activeStates: ['MA'] });
});

test('rate limiter: blocks over the limit, window resets, reset() clears', () => {
  const rl = sec.createRateLimiter({ windowMs: 1000, max: 3 });
  const t = 1_000_000;
  for (let i = 0; i < 3; i++) assert.equal(rl.hit('k', t).limited, false);
  assert.equal(rl.hit('k', t).limited, true);
  assert.equal(rl.check('k', t).limited, true);
  assert.equal(rl.check('k', t + 1001).limited, false);
  rl.reset('k');
  assert.equal(rl.check('k', t).limited, false);
});

test('csrfGuard: cross-site and non-JSON writes refused; same-origin JSON and service routes pass', () => {
  const guard = sec.csrfGuard({ allowedHosts: ['board.example.com'] });
  const run = ({ method = 'POST', path = '/api/users', headers = {}, json = true }) => {
    const h = Object.fromEntries(Object.entries({ host: 'board.example.com', ...headers }).map(([k, v]) => [k.toLowerCase(), v]));
    let status = 0, passed = false;
    const req = { method, path, get: k => h[k.toLowerCase()], is: () => json };
    const res = { status(s) { status = s; return this; }, json() { return this; } };
    guard(req, res, () => { passed = true; });
    return passed ? 'next' : status;
  };
  assert.equal(run({ method: 'GET' }), 'next');
  assert.equal(run({ headers: { 'content-length': '10', 'content-type': 'application/json', origin: 'https://board.example.com', 'sec-fetch-site': 'same-origin' } }), 'next');
  assert.equal(run({ headers: { 'content-length': '10', origin: 'https://evil.example.net' } }), 403);
  assert.equal(run({ headers: { 'content-length': '10', 'sec-fetch-site': 'same-site' } }), 403);
  assert.equal(run({ headers: { origin: 'null' } }), 403);
  assert.equal(run({ headers: { 'content-length': '10' }, json: false }), 415);
  assert.equal(run({ headers: { 'content-length': '0' }, json: false }), 'next');   // body-less POST (sign out)
  assert.equal(run({ path: '/api/integrations/worked-doors', headers: { 'content-length': '10' }, json: false }), 'next');
});

test('CSP: inline scripts are allowed by exact hash only', () => {
  const html = '<script src="/a.js"></script><script>alert(1)</script>';
  const hashes = sec.inlineScriptHashes(html);
  assert.equal(hashes.length, 1);
  const csp = sec.cspHeader(hashes);
  assert.match(csp, /script-src 'self' https:\/\/unpkg\.com\/xlsx@0\.18\.5\/dist\/xlsx\.full\.min\.js 'sha256-[A-Za-z0-9+/=]+'/);
  // Never the whole CDN origin (it serves any published package).
  assert.doesNotMatch(csp, /https:\/\/unpkg\.com[ ;']/);
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
  assert.match(csp, /frame-ancestors 'none'/);
});

test('sendError: 4xx keeps its message, 5xx is generic', () => {
  const mk = () => ({ code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
  const a = mk(); sec.sendError(a, Object.assign(new Error('No boundary on file'), { status: 404 }));
  assert.deepEqual([a.code, a.body.error], [404, 'No boundary on file']);
  const b = mk();
  const orig = console.error; console.error = () => {};
  try { sec.sendError(b, new Error('Cast to ObjectId failed for value "x" at path "_id"')); } finally { console.error = orig; }
  assert.equal(b.code, 500);
  assert.doesNotMatch(b.body.error, /ObjectId|_id/);
});

test('backup encryption round-trips and detects tampering', () => {
  const key = sec.backupKey('a long passphrase for the test');
  const hexKey = sec.backupKey('00'.repeat(32));
  assert.equal(hexKey.length, 32);
  const plain = Buffer.from('{"_id":1}\n'.repeat(100));
  const enc = sec.encryptBuffer(plain, key);
  assert.equal(sec.isEncrypted(enc), true);
  assert.equal(sec.isEncrypted(plain), false);
  assert.deepEqual(sec.decryptBuffer(enc, key), plain);
  enc[enc.length - 1] ^= 1;
  assert.throws(() => sec.decryptBuffer(enc, key));
  assert.equal(sec.backupKey(''), null);
});

test('validateEditPatch: Object.prototype names refused; text fields hold one plain value', () => {
  const ctx = { today: '2026-10-08', hubKeys: [], officeKeys: [], isAreaId };
  for (const f of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf'])
    assert.ok(sec.validateEditPatch({ [f]: 'x' }, ctx).error, f);
  assert.ok(sec.validateEditPatch({ constraints: { toString: true } }, ctx).error);
  assert.ok(sec.validateEditPatch({ authority: ['x'] }, ctx).error);
  assert.ok(sec.validateEditPatch({ permit_summary: { a: 1 } }, ctx).error);
  assert.ok(sec.validateEditPatch({ notes: 'x'.repeat(4001) }, ctx).error);
  assert.deepEqual(sec.validateEditPatch({ fee: 25, permit_needed: true, hours: '9–5' }, ctx),
    { set: { fee: 25, permit_needed: true, hours: '9–5' }, unset: {} });
});

test('mergeIncidents: attribution is the server\'s; leaders only add or remove their own', () => {
  const a = { date: '2026-10-01', type: 'weapons', notes: 'a', by: 'u1' };
  const b = { date: '2026-10-02', type: 'other', notes: 'b' };                 // older, unattributed
  const mine = { date: '2026-10-03', type: 'other', notes: 'm', by: 'L' };
  const strip = ({ by, ...i }) => i;
  // Leader sends an empty list: nothing of anyone else's goes, their own does.
  assert.deepEqual(sec.mergeIncidents([a, b, mine], [], { userId: 'L', leaderOnly: true }).list, [a, b]);
  // Leader appends one; a forged `by` never survives sanitising, the server stamps it.
  const add = { date: '2026-10-04', type: 'moved_on', notes: 'n' };
  const r = sec.mergeIncidents([a, b], [strip(a), strip(b), add], { userId: 'L', leaderOnly: true });
  assert.deepEqual(r.list, [a, b, { ...add, by: 'L' }]);
  assert.deepEqual(r.added, [{ ...add, by: 'L' }]);
  // Admin/client: their list wins, stored attribution carried over.
  assert.deepEqual(sec.mergeIncidents([a, b], [strip(b)], { userId: 'C', leaderOnly: false }).list, [b]);
  assert.deepEqual(sec.mergeIncidents([a], [strip(a), add], { userId: 'C', leaderOnly: false }).list, [a, { ...add, by: 'C' }]);
});
