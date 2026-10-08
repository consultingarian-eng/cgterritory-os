'use strict';
// The field app's admin screen sets a leader up as a sector leader through
// here (POST /api/integrations/sector-leaders). One call
// either creates the account (they get the invite email to set a password) or
// brings an existing one in line: sector leader role, the leader's office view,
// active again, and a fresh invite if they never set a password. Admin
// accounts are never changed.
//
// The account is found by email first, then by name — the board and the field
// app are separate logins and some people sign up here with another address.
// A name only counts when exactly one account carries it.

const OFFICES = require('./settings').settings.officeKeys;
const INVITE_MS = 7 * 24 * 60 * 60 * 1000;

const norm = s => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

async function findAccount(User, email, name) {
  const byEmail = await User.findOne({ email });
  if (byEmail) return { user: byEmail, matchedBy: 'email' };
  const words = norm(name).split(' ').filter(Boolean);
  if (!words.length) return { user: null };
  const rx = new RegExp('^\\s*' + words.map(escapeRe).join('\\s+') + '\\s*$', 'i');
  const byName = await User.find({ name: rx }).limit(2);
  return byName.length === 1 ? { user: byName[0], matchedBy: 'name' } : { user: null };
}

// makeInvite() -> { raw, hash }: the raw token goes in the email, the hash in Mongo.
async function setupSectorLeader(User, body, { makeInvite }) {
  const email = String(body.email || '').toLowerCase().trim();
  // Same clean-up as the admin user route (server.js cleanName): no markup or
  // control characters, at most 120 characters.
  const name = String(body.name ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 120);
  if (email.length > 254) throw badRequest('A valid email is required');
  const office = body.office;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('A valid email is required');
  if (!name) throw badRequest('Name is required');
  if (!OFFICES.includes(office)) throw badRequest(`office must be one of: ${OFFICES.join(', ')}`);

  const { user: found, matchedBy } = await findAccount(User, email, name);
  if (!found) {
    const invite = makeInvite();
    const user = await User.create({
      name, email, role: 'sector_leader', office,
      inviteToken: invite.hash, inviteTokenExpiry: new Date(Date.now() + INVITE_MS),
    });
    return { status: 'invited', changed: [], user, rawToken: invite.raw, matchedBy: null };
  }
  if (found.role === 'admin') return { status: 'admin', changed: [], user: found, rawToken: null, matchedBy };

  const changed = [];
  if (found.role !== 'sector_leader') { found.role = 'sector_leader'; changed.push('role'); }
  if (found.office !== office)        { found.office = office;        changed.push('office'); }
  if (!found.active)                  { found.active = true;          changed.push('active'); }
  let rawToken = null;
  if (!found.passwordHash) {
    const invite = makeInvite();
    found.inviteToken = invite.hash;
    found.inviteTokenExpiry = new Date(Date.now() + INVITE_MS);
    rawToken = invite.raw;
  }
  if (changed.length || rawToken) await found.save();
  const status = rawToken ? 'reinvited' : changed.length ? 'updated' : 'unchanged';
  return { status, changed, user: found, rawToken, matchedBy };
}

module.exports = { setupSectorLeader, OFFICES };
