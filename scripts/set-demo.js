#!/usr/bin/env node
'use strict';
// Turn an existing account into a demo account (sees everything its role
// sees, changes nothing), or back:
//
//   node scripts/set-demo.js someone@example.com on
//   node scripts/set-demo.js someone@example.com off
//   (live database: railway run -- node scripts/set-demo.js … — docs/SETUP.md)
//
// Needs MONGODB_URI. Add the person in Manage Users first. Give a demo
// account the Client or Sector Leader role: an Admin demo can still read
// Manage Users (everyone's name and email). Takes effect within a minute.

require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');

const email = String(process.argv[2] || '').toLowerCase().trim();
const mode = String(process.argv[3] || '').toLowerCase();
if (!email.includes('@') || !['on', 'off'].includes(mode)) {
  console.error('Usage: node scripts/set-demo.js <email> on|off'); process.exit(1);
}
if (!process.env.MONGODB_URI) { console.error('MONGODB_URI is not set'); process.exit(1); }

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const users = mongoose.connection.collection('users');
  const user = await users.findOne({ email });
  if (!user) { console.error(`No account with the email ${email} — add them in Manage Users first`); process.exit(1); }
  await users.updateOne({ _id: user._id }, { $set: { demo: mode === 'on' } });
  console.log(`${email} (${user.role}) is ${mode === 'on' ? 'now a demo account' : 'no longer a demo account'}.`);
  if (mode === 'on' && user.role === 'admin') console.log('Warning: an Admin demo can still read Manage Users. Consider the Client or Sector Leader role.');
  await mongoose.disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });
