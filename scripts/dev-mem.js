#!/usr/bin/env node
'use strict';
/**
 * Try the app with no database account: starts a throwaway MongoDB in memory
 * (mongodb-memory-server, a dev dependency — `npm install` brings it), loads
 * the fictional sample into it, then starts the server against it.
 *
 *   npm run dev:mem
 *
 * Everything is lost when you stop it (Ctrl+C). Settings come from your .env
 * when you have one; MONGODB_URI is always the in-memory one. With no .env,
 * a random JWT_SECRET and a first admin (admin@example.com, random password,
 * printed below) are made up for this run only. The first start downloads a
 * MongoDB binary (~100 MB) into your npm cache; later starts reuse it.
 *
 * For a database that survives restarts, use Atlas (docs/SETUP.md step 4) or
 * a local mongod, and put its URI in MONGODB_URI.
 */
require('dotenv').config({ quiet: true });
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

let MongoMemoryServer;
try { ({ MongoMemoryServer } = require('mongodb-memory-server')); }
catch { console.error('mongodb-memory-server is not installed — run `npm install` (not `npm install --production`) first.'); process.exit(1); }

const ROOT = path.join(__dirname, '..');

(async () => {
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri('cgterritory');
  const madeUp = {};
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) madeUp.JWT_SECRET = crypto.randomBytes(32).toString('hex');
  if (!process.env.ADMIN_EMAIL) madeUp.ADMIN_EMAIL = 'admin@example.com';
  if (!process.env.INITIAL_ADMIN_PASSWORD) madeUp.INITIAL_ADMIN_PASSWORD = crypto.randomBytes(9).toString('base64url');
  if (!process.env.SALES_CSV_FILE && !process.env.SALES_CSV_URL && !process.env.SALES_SHEET_ID) madeUp.SALES_CSV_FILE = 'samples/sales.sample.csv';
  // A local, plain-http run: development mode, so the sign-in cookie isn't marked
  // Secure (Safari won't keep a Secure cookie on http://localhost).
  const env = { NODE_ENV: 'development', ...process.env, ...madeUp, MONGODB_URI: uri, CGT_DEV_MEM: '1' };

  console.log(`In-memory MongoDB: ${uri}  (gone when you stop this)`);
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'seed-sample.js')], { cwd: ROOT, env, stdio: 'inherit' });

  const port = env.PORT || 3000;
  console.log(`\nOpen http://localhost:${port} and sign in as ${env.ADMIN_EMAIL}` +
    (madeUp.INITIAL_ADMIN_PASSWORD ? ` with the password ${madeUp.INITIAL_ADMIN_PASSWORD} (made up for this run)` : ' with your INITIAL_ADMIN_PASSWORD') + '.\n');
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: 'inherit' });
  const stop = async () => { srv.kill('SIGTERM'); await mongod.stop().catch(() => {}); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  srv.on('exit', async code => { await mongod.stop().catch(() => {}); process.exit(code ?? 0); });
})().catch(e => { console.error(e.message); process.exit(1); });
