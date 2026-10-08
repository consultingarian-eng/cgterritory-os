#!/usr/bin/env node
'use strict';
// Locked out, with no working email? Print a one-hour password-reset link for
// an existing, active account straight from the database:
//
//   railway run -- node scripts/admin-reset-link.js you@yourcompany.co.uk
//
// Needs MONGODB_URI (and APP_URL for the link's address). The link is a
// secret: open it yourself, don't paste it anywhere. Using it ends every
// existing session of that account. (The server only creates an admin from
// INITIAL_ADMIN_PASSWORD when there are no users at all, so this is the way
// back in once anyone exists.)

require('dotenv').config({ quiet: true });
const crypto = require('crypto');
const mongoose = require('mongoose');

const email = String(process.argv[2] || '').toLowerCase().trim();
if (!email || !email.includes('@')) { console.error('Usage: node scripts/admin-reset-link.js <email>'); process.exit(1); }
if (!process.env.MONGODB_URI) { console.error('MONGODB_URI is not set'); process.exit(1); }
const APP_URL = String(process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const users = mongoose.connection.collection('users');
  const user = await users.findOne({ email, active: true });
  if (!user) { console.error(`No active account with the email ${email}`); process.exit(1); }
  const token = crypto.randomBytes(32).toString('hex');
  await users.updateOne({ _id: user._id }, { $set: {
    resetToken: crypto.createHash('sha256').update(token).digest('hex'),
    resetTokenExpiry: new Date(Date.now() + 60 * 60 * 1000),
  } });
  console.log(`Reset link for ${email} (${user.role}), valid for one hour:\n\n  ${APP_URL}/set-password?token=${token}&mode=reset\n`);
  await mongoose.disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });
