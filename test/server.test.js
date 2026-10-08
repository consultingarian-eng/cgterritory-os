'use strict';
// End-to-end security tests: boots server.js against a throwaway in-memory
// MongoDB (mongodb-memory-server, a dev dependency) with every outbound
// network call blocked, then drives the HTTP API like a browser would.
//   npm install && npm test        (or: node --test)
// Skips itself when mongodb-memory-server isn't installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

let MongoMemoryServer = null;
try { ({ MongoMemoryServer } = require('mongodb-memory-server')); } catch {}

const ROOT = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const XSS = '<img src=x onerror=alert(1)>';

test('server security (in-memory MongoDB)', { skip: !MongoMemoryServer && 'mongodb-memory-server is not installed (npm install)', timeout: 180_000 }, async (t) => {
  const mongoose = require('mongoose');
  const bcrypt = require('bcryptjs');
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri('cgt_test');
  const PORT = 3900 + Math.floor(Math.random() * 90);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, NODE_PATH: process.env.NODE_PATH || '',
    MONGODB_URI: uri, PORT: String(PORT), NODE_ENV: 'development', TRUST_PROXY: '',
    JWT_SECRET: crypto.randomBytes(32).toString('hex'),
    ADMIN_EMAIL: 'admin@example.com', ADMIN_NAME: 'Test Admin', INITIAL_ADMIN_PASSWORD: 'test-admin-pass-123',
    FIELD_APP_TOKEN: crypto.randomBytes(24).toString('hex'), AI_DAILY_LIMIT: '5',
    CGT_SETTINGS_FILE: path.join(ROOT, 'config', 'territory.json'),
  };
  const preload = ['-r', path.join(ROOT, 'scripts', 'lib', 'block-net.js')];
  let srv, log = '';
  const boot = (extra = {}, port = PORT) => {
    const p = spawn(process.execPath, [...preload, 'server.js'], { cwd: ROOT, env: { ...env, ...extra, PORT: String(port) } });
    p.stdout.on('data', d => { log += d; }); p.stderr.on('data', d => { log += d; });
    return p;
  };
  const waitHealthy = async (base) => {
    for (let i = 0; i < 80; i++) { await sleep(250); try { if ((await fetch(base + '/healthz')).status === 200) return true; } catch {} }
    return false;
  };

  t.after(async () => {
    try { srv?.kill('SIGTERM'); } catch {}
    await sleep(300); await mongoose.disconnect().catch(() => {}); await mongod.stop();
    // The server precompresses assets at boot (git-ignored *.br files); tidy them away.
    const fs = require('fs');
    for (const rel of ['js/app.js', 'css/style.css', 'data/master.json', 'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css'])
      fs.rmSync(path.join(ROOT, 'public', rel + '.br'), { force: true });
    for (const f of fs.readdirSync(path.join(ROOT, 'public', 'data'))) if (f.endsWith('.br')) fs.rmSync(path.join(ROOT, 'public', 'data', f), { force: true });
  });

  await t.test('refuses to start without a strong JWT_SECRET', () => {
    const r = spawnSync(process.execPath, [...preload, 'server.js'], { cwd: ROOT, env: { ...env, JWT_SECRET: 'short' }, timeout: 20_000 });
    assert.equal(r.status, 1);
  });

  srv = boot();
  assert.ok(await waitHealthy(BASE), 'server became healthy\n' + log);
  await mongoose.connect(uri);
  const Users = mongoose.connection.collection('users');

  // Accounts with known passwords, written straight to the database.
  const hash = await bcrypt.hash('password-123', 4);
  const mk = async (email, role, extra = {}) => {
    await Users.insertOne({ email, name: email.split('@')[0], role, office: 'both', passwordHash: hash, active: true, demo: false,
                            emailVerified: true, tokenVersion: 0, createdAt: new Date(), ...extra });
    return (await Users.findOne({ email }))._id.toString();
  };
  const leaderId = await mk('leader@example.com', 'sector_leader');
  await mk('client@example.com', 'client');
  const newAdminId = await mk('admin2@example.com', 'admin');

  const req = (p, { method = 'GET', cookie, body, headers = {} } = {}) => fetch(BASE + p, {
    method, redirect: 'manual',
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
  const login = async (email, password = 'password-123') => {
    const r = await req('/api/auth/login', { method: 'POST', body: { email, password } });
    assert.equal(r.status, 200, `login ${email}`);
    return (r.headers.get('set-cookie') || '').split(';')[0];
  };
  const admin = await login('admin@example.com', 'test-admin-pass-123');
  const leader = await login('leader@example.com');
  const client = await login('client@example.com');

  await t.test('security headers on pages and API', async () => {
    const r = await req('/login');
    const csp = r.headers.get('content-security-policy') || '';
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /'sha256-/);                        // the login page's inline script, by hash
    assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
    assert.doesNotMatch(csp, /https:\/\/unpkg\.com[ ;']/);   // one CDN file, never the whole origin
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('x-powered-by'), null);
    const ex = await req('/export-map.html?zip=01001', { cookie: admin });
    assert.equal(ex.status, 200);
    const html = await ex.text();
    assert.doesNotMatch(html, /unpkg\.com\/leaflet|onclick=/);
    assert.match(ex.headers.get('content-security-policy') || '', /'sha256-/);
  });

  await t.test('first admin is seeded once and never resurrected', async () => {
    assert.equal(await Users.countDocuments({ email: 'admin@example.com' }), 1);
    const port2 = PORT + 100;
    const s2 = boot({ ADMIN_EMAIL: 'other-admin@example.com' }, port2);
    try { assert.ok(await waitHealthy(`http://127.0.0.1:${port2}`)); }
    finally { s2.kill('SIGTERM'); }
    await sleep(300);
    assert.equal(await Users.countDocuments({ email: 'other-admin@example.com' }), 0);
  });

  await t.test('H3: a Client cannot store markup in place names or figures the board draws', async () => {
    const PAY = `<iframe srcdoc="<script src='https://unpkg.com/x/x.js'></script>"></iframe>`;
    for (const f of ['county', 'state', 'households', 'dist_miles_west', 'drive_mins_west', 'transit_mins_west'])
      assert.equal((await req('/api/edits', { method: 'POST', cookie: client, body: { '01095': { [f]: PAY } } })).status, 400, f);
    assert.equal((await req('/api/edits', { method: 'POST', cookie: client, body: { '01095': { households: '4100' } } })).status, 200);
    const edits = await (await req('/api/edits', { cookie: admin })).json();
    assert.equal(edits['01095'].households, 4100);
    assert.equal(edits['01095'].county, undefined);
  });

  await t.test('H1: incident markup is neutralised and bad coordinates dropped (sector leader)', async () => {
    const r = await req('/api/edits', { method: 'POST', cookie: leader, body: { '01001': { incidents: [
      { type: XSS, date: '2026-10-08' + XSS, notes: 'x', lat: 'abc', lng: -72 },
      { type: 'weapons', date: '2026-10-07', lat: 42.07, lng: -72.62 },
    ] } } });
    assert.equal(r.status, 200);
    const edits = await (await req('/api/edits', { cookie: admin })).json();
    const inc = edits['01001'].incidents;
    assert.equal(inc[0].type, 'other');
    assert.match(inc[0].date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal('lat' in inc[0], false);
    assert.equal(inc[1].type, 'weapons');
    assert.equal(edits['01001'].color, 'RED');            // critical incident escalation still applies
    // still only incidents for a sector leader
    assert.equal((await req('/api/edits', { method: 'POST', cookie: leader, body: { '01001': { color: 'GREEN' } } })).status, 403);
  });

  await t.test('edits: operator/dotted field names and malformed dates refused', async () => {
    for (const bad of [{ $where: 1 }, { 'a.b': 1 }, { work_date: XSS }, { day_change: { to: 'mon', on: XSS } }]) {
      const r = await req('/api/edits', { method: 'POST', cookie: admin, body: { '01013': bad } });
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
  });

  await t.test('edits: Object.prototype names and list/object values in text fields refused', async () => {
    for (const f of ['constructor', 'toString', 'hasOwnProperty', 'valueOf'])
      assert.equal((await req('/api/edits', { method: 'POST', cookie: client, body: { '01030': { [f]: 'x' } } })).status, 400, f);
    assert.equal((await req('/api/edits', { method: 'POST', cookie: client, body: { '01030': { constraints: { constructor: true } } } })).status, 400);
    for (const v of [5, ['x'], { a: 1 }]) {
      const r = await req('/api/edits', { method: 'POST', cookie: client, body: { '01030': { authority: v } } });
      assert.equal(r.status, typeof v === 'number' ? 200 : 400, JSON.stringify(v));
    }
    assert.equal((await req('/api/edits', { method: 'POST', cookie: client, body: { '01030': { permit_summary: 'x'.repeat(4001) } } })).status, 400);
  });

  await t.test('incidents: a sector leader can add and remove their own, never anyone else\'s', async () => {
    const other = await login((await mk('leader2@example.com', 'sector_leader'), 'leader2@example.com'));
    const get = async () => (await (await req('/api/edits', { cookie: admin })).json())['01040']?.incidents || [];
    // A client logs a weapons incident.
    assert.equal((await req('/api/edits', { method: 'POST', cookie: client, body: { '01040': { incidents: [{ type: 'weapons', date: '2026-10-01', notes: 'client-logged' }] } } })).status, 200);
    // A leader tries to wipe it, and to unset the list: refused / ignored.
    assert.equal((await req('/api/edits', { method: 'POST', cookie: leader, body: { '01040': { incidents: null } } })).status, 403);
    assert.equal((await req('/api/edits', { method: 'POST', cookie: leader, body: { '01040': { incidents: [] } } })).status, 200);
    assert.deepEqual((await get()).map(i => i.notes), ['client-logged']);
    // The leader appends one (sent as the whole list, as the board does) and it is attributed.
    const withMine = [...await get(), { type: 'moved_on', date: '2026-10-02', notes: 'leader-logged', by: 'forged' }];
    assert.equal((await req('/api/edits', { method: 'POST', cookie: leader, body: { '01040': { incidents: withMine } } })).status, 200);
    const now = await get();
    assert.deepEqual(now.map(i => i.notes), ['client-logged', 'leader-logged']);
    assert.equal(now[1].by, leaderId);
    // Another leader can't remove it; the author can.
    await req('/api/edits', { method: 'POST', cookie: other, body: { '01040': { incidents: [now[0]] } } });
    assert.equal((await get()).length, 2);
    await req('/api/edits', { method: 'POST', cookie: leader, body: { '01040': { incidents: [now[0]] } } });
    assert.deepEqual((await get()).map(i => i.notes), ['client-logged']);
    // A client edits freely; attribution survives a re-save.
    await req('/api/edits', { method: 'POST', cookie: client, body: { '01040': { incidents: [] } } });
    assert.deepEqual(await get(), []);
  });

  await t.test('hub goals: only configured hubs', async () => {
    for (const hub of ['__proto__', '<b>x</b>', 'x'.repeat(100000)])
      assert.equal((await req('/api/hub-goals', { method: 'POST', cookie: client, body: { hub, cap: 10 } })).status, 400, hub.slice(0, 20));
    assert.equal((await req('/api/hub-goals', { method: 'POST', cookie: client, body: { hub: 'riverside', cap: 10 } })).status, 200);
  });

  await t.test('service token: a same-length multi-byte token is a plain 401', async () => {
    const r = await req('/api/integrations/users', { headers: { 'x-service-token': 'é'.repeat(env.FIELD_APP_TOKEN.length) } });
    // Same character count as the real token, twice the bytes in UTF-8: used to throw (500).
    assert.equal(r.status, 401);
  });

  await t.test('H2/L2: coverage strokes need a real date, bounded points, allow-listed style', async () => {
    assert.equal((await req('/api/knocks', { method: 'POST', cookie: leader, body: { zip: '01001', date: '2026-10-08' + XSS, latlngs: [[42.07, -72.62]] } })).status, 400);
    const many = Array.from({ length: 5001 }, (_, i) => [42 + i * 1e-4, -72]);
    assert.equal((await req('/api/knocks', { method: 'POST', cookie: leader, body: { zip: '01001', date: '2026-10-08', latlngs: many } })).status, 400);
    const ok = await req('/api/knocks', { method: 'POST', cookie: leader, body: { zip: '01001', date: '2026-10-08', latlngs: [[42.07, -72.62], [42.071, -72.621]], style: { color: '#f97316', weight: 5, className: XSS } } });
    assert.equal(ok.status, 200);
    const k = (await (await req('/api/knocks', { cookie: admin })).json()).knocks.find(x => x.date === '2026-10-08');
    assert.deepEqual(k.style, { color: '#f97316', weight: 5 });
    assert.equal((await req('/api/knocks/not-an-id', { method: 'DELETE', cookie: admin })).status, 404);
  });

  await t.test('M3: prefs cannot be planted on another account; unknown keys and bad dates dropped', async () => {
    const r = await req('/api/prefs', { method: 'POST', cookie: leader, body: { userId: newAdminId, coverageFrom: '"><script>x</script>', coverageTo: '2026-10-01', showHelpers: false, evil: XSS } });
    assert.equal(r.status, 200);
    const mine = await (await req('/api/prefs', { cookie: leader })).json();
    assert.deepEqual(mine, { showHelpers: false, coverageTo: '2026-10-01' });
    const theirs = await mongoose.connection.collection('prefs').findOne({ userId: newAdminId });
    assert.equal(theirs, null);
  });

  await t.test('M7: AI endpoints role-gated and size-capped', async () => {
    assert.equal((await req('/api/parse-territories', { method: 'POST', cookie: leader, body: { text: '01001' } })).status, 403);
    assert.equal((await req('/api/analyze-permits', { method: 'POST', cookie: leader, body: { zips: [{ zip: '01001' }] } })).status, 403);
    const six = Array.from({ length: 6 }, () => ({ zip: '01001', municipality: 'X', state: 'MA' }));
    assert.equal((await req('/api/analyze-permits', { method: 'POST', cookie: client, body: { zips: six } })).status, 400);
    assert.equal((await req('/api/analyze-permits', { method: 'POST', cookie: client, body: { sheetText: 'x'.repeat(20001) } })).status, 400);
    // Rows share the 40,000-character ceiling with pasted text (checked before the key).
    assert.equal((await req('/api/parse-territories', { method: 'POST', cookie: client, body: { rows: ['x'.repeat(50000)] } })).status, 413);
    // No ANTHROPIC_API_KEY in tests: refused before any call is attempted.
    assert.equal((await req('/api/analyze-permits', { method: 'POST', cookie: client, body: { zips: [{ zip: '01001' }] } })).status, 503);
  });

  await t.test('L3: CSRF — form posts, foreign origins and cross-site fetches are refused', async () => {
    const form = await fetch(BASE + '/api/users', { method: 'POST', headers: { Cookie: admin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'name=x&email=x%40example.com&role=admin' });
    assert.equal(form.status, 415);
    const foreign = await req('/api/users', { method: 'POST', cookie: admin, body: { name: 'x', email: 'x@example.com' }, headers: { Origin: 'https://evil.example.net' } });
    assert.equal(foreign.status, 403);
    const sibling = await req('/api/users', { method: 'POST', cookie: admin, body: { name: 'x', email: 'x@example.com' }, headers: { 'Sec-Fetch-Site': 'same-site' } });
    assert.equal(sibling.status, 403);
    assert.equal(await Users.countDocuments({ email: 'x@example.com' }), 0);
  });

  await t.test('L5/L6: generic errors and role validation', async () => {
    const bad = await req('/api/edits', { method: 'POST', cookie: admin, body: '{"01001": ' });
    assert.equal(bad.status, 400);
    const text = await bad.text();
    assert.doesNotMatch(text, /at .*\.js:\d+|SyntaxError/);
    assert.equal((await req(`/api/users/${leaderId}`, { method: 'PUT', cookie: admin, body: { role: 'superuser' } })).status, 400);
    assert.equal((await req('/api/users/not-an-id', { method: 'PUT', cookie: admin, body: { name: 'x' } })).status, 404);
  });

  await t.test('routes: the sample street map generates a plan with no OpenStreetMap call', async () => {
    const { SAMPLE_ZIP, buildFixtureGraph } = require('../scripts/lib/street-fixture');
    const graph = buildFixtureGraph(SAMPLE_ZIP);
    await mongoose.connection.collection('osmcaches').insertOne({ zip: SAMPLE_ZIP, fetchedAt: new Date(), stats: graph.stats, v: graph.v, pv: 0, fixture: true, blob: '', graph });
    const r = await req('/api/routes/generate', { method: 'POST', cookie: client, body: { zip: SAMPLE_ZIP, pairings: 1, solos: 1, doorsPerPerson: 100, near: graph.centre } });
    assert.equal(r.status, 200);
    let j = await r.json();
    for (let i = 0; i < 40 && j.pending; i++) { await sleep(250); j = await (await req(`/api/routes/generate/status?zip=${SAMPLE_ZIP}`, { cookie: client })).json(); }
    assert.equal(j.error, undefined);
    assert.equal(j.plan.routes.length, 2);
    assert.deepEqual(j.plan.routes.map(rt => rt.people), [2, 1]);
    assert.ok(j.plan.routes.every(rt => rt.doors > 0 && rt.steps?.length), 'each route has doors and steps');
    const cov = await (await req(`/api/routes/coverage?zip=${SAMPLE_ZIP}`, { cookie: client })).json();
    assert.equal(cov.mapped, true);
    assert.ok(cov.reservedBlocks > 0, 'the new plan reserves its blocks');
  });

  await t.test('worked doors: a door sent with lat/lng but no zip gets its area from the map; a re-send never blanks it', async () => {
    const WD = mongoose.connection.collection('workeddoors');
    const post = doors => req('/api/integrations/worked-doors', { method: 'POST', body: { doors }, headers: { 'x-service-token': env.FIELD_APP_TOKEN } });
    // Inside sample ZIP 01108 (the street-fixture grid's centre).
    assert.equal((await post([{ id: 'wd-1', date: '2026-10-07', lat: 42.08124, lng: -72.5625 }])).status, 200);
    assert.equal((await WD.findOne({ externalId: 'wd-1' })).zip, '01108');
    // Explicit zip wins; a later blank one leaves it alone.
    await post([{ id: 'wd-2', date: '2026-10-07', lat: 42.08124, lng: -72.5625, zip: '01001' }]);
    await post([{ id: 'wd-2', date: '2026-10-08', lat: 42.08124, lng: -72.5625, zip: '' }]);
    assert.equal((await WD.findOne({ externalId: 'wd-2' })).zip, '01108');   // blank → from the polygon, not ''
    await post([{ id: 'wd-3', date: '2026-10-07', lat: 42.08124, lng: -72.5625, zip: '01001' }]);
    await post([{ id: 'wd-3', date: '2026-10-08', lat: 10, lng: 10 }]);      // outside every area on file
    assert.equal((await WD.findOne({ externalId: 'wd-3' })).zip, '01001');
  });

  await t.test('M8: route plans carry no creator email', async () => {
    await mongoose.connection.collection('routeplans').insertOne({ zip: '01001', status: 'active', createdAt: new Date(),
      createdBy: { id: leaderId, name: 'leader', email: 'leader@example.com' }, params: {}, meeting: [42.07, -72.62], routes: [], segIds: [] });
    const r = await (await req('/api/routes?zip=01001', { cookie: client })).json();
    assert.equal(r.plans.length, 1);
    assert.deepEqual(r.plans[0].createdBy, { id: leaderId, name: 'leader' });
  });

  await t.test('M6: sign-out revokes the token itself', async () => {
    const c = await login('client@example.com');
    assert.equal((await req('/api/auth/logout', { method: 'POST', cookie: c })).status, 200);
    assert.equal((await req('/api/auth/me', { cookie: c })).status, 401);
    assert.equal((await req('/data/master.json', { cookie: c })).status, 302);
    assert.equal((await req('/api/auth/me', { cookie: client })).status, 200);   // other sessions unaffected
  });

  await t.test('M6: a password change ends every other session; this one continues', async () => {
    const other = await login('admin2@example.com');
    const self = await login('admin2@example.com');
    const r = await req('/api/auth/change-password', { method: 'POST', cookie: self, body: { currentPassword: 'password-123', newPassword: 'new-password-456' } });
    assert.equal(r.status, 200);
    const fresh = (r.headers.get('set-cookie') || '').split(';')[0];
    assert.equal((await req('/api/auth/me', { cookie: other })).status, 401);
    assert.equal((await req('/data/dnk.json', { cookie: other })).status, 302);
    assert.equal((await req('/api/auth/me', { cookie: fresh })).status, 200);
  });

  await t.test('owner settings (/config.js: office addresses, hubs) need a sign-in', async () => {
    assert.equal((await req('/config.js')).status, 302);
    const r = await req('/config.js', { cookie: admin });
    assert.equal(r.status, 200);
  });

  await t.test('M5: deactivation locks /data (incl. the Do-Not-Knock list) as well as the API', async () => {
    assert.equal((await req('/data/dnk.json', { cookie: leader })).status, 200);
    assert.equal((await req(`/api/users/${leaderId}`, { method: 'PUT', cookie: admin, body: { active: false } })).status, 200);
    assert.equal((await req('/api/edits', { cookie: leader })).status, 401);
    assert.equal((await req('/data/dnk.json', { cookie: leader })).status, 302);
    assert.equal((await req('/data/master.json', { cookie: leader })).status, 302);
    // Reactivating does not bring the old session back (tokenVersion moved on).
    await req(`/api/users/${leaderId}`, { method: 'PUT', cookie: admin, body: { active: true } });
    assert.equal((await req('/api/edits', { cookie: leader })).status, 401);
  });

  await t.test('M4: login failures are throttled per account (checked before bcrypt)', async () => {
    await mk('target@example.com', 'client');
    const codes = [];
    for (let i = 0; i < 9; i++) codes.push((await req('/api/auth/login', { method: 'POST', body: { email: 'target@example.com', password: 'wrong-' + i } })).status);
    assert.deepEqual(codes.slice(0, 8), Array(8).fill(401));
    assert.equal(codes[8], 429);
    // even the right password waits out the lockout
    const r = await req('/api/auth/login', { method: 'POST', body: { email: 'target@example.com', password: 'password-123' } });
    assert.equal(r.status, 429);
    assert.ok(+r.headers.get('retry-after') > 0);
    // …but only from that address: the owner signing in from elsewhere isn't locked out.
    // (The test talks over loopback, which counts as a trusted proxy hop.)
    const elsewhere = await req('/api/auth/login', { method: 'POST', headers: { 'X-Forwarded-For': '203.0.113.9' }, body: { email: 'target@example.com', password: 'password-123' } });
    assert.equal(elsewhere.status, 200);
    // forgot-password answers the same whether or not the account exists
    const a = await (await req('/api/auth/forgot-password', { method: 'POST', body: { email: 'target@example.com' } })).json();
    const b = await (await req('/api/auth/forgot-password', { method: 'POST', body: { email: 'nobody@example.com' } })).json();
    assert.deepEqual(a, b);
  });

  await t.test('locked-out recovery: scripts/admin-reset-link.js prints a working one-hour link', async () => {
    await mk('reset@example.com', 'admin');
    const before = await login('reset@example.com');
    const r = spawnSync(process.execPath, ['scripts/admin-reset-link.js', 'reset@example.com'], { cwd: ROOT, env: { ...env, APP_URL: BASE }, encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 0, r.stderr);
    const token = (r.stdout.match(/token=([0-9a-f]{64})&mode=reset/) || [])[1];
    assert.ok(token);
    const set = await req('/api/auth/set-password', { method: 'POST', body: { token, password: 'recovered-pass-789', mode: 'reset' } });
    assert.equal(set.status, 200);
    assert.equal((await req('/api/auth/me', { cookie: before })).status, 401);      // old sessions ended
    await login('reset@example.com', 'recovered-pass-789');
    // single use
    assert.equal((await req('/api/auth/set-password', { method: 'POST', body: { token, password: 'again-pass-000', mode: 'reset' } })).status, 400);
  });

  assert.doesNotMatch(log, /network blocked in tests/, 'no test reached the network');
});
