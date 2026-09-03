const crypto = require('node:crypto');
const { User, Role, Tenant } = require('../db/models');
const phone = require('../lib/phone');
const messaging = require('./messaging');
const password = require('../lib/password');
const { unauthorized, badRequest, notFound } = require('../lib/errors');
const audit = require('./audit');

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

/**
 * Spec §5. Email is unique per tenant, so one address can legitimately exist in
 * two organizations. Candidates are verified first and the org chooser only
 * appears if more than one actually matches — checking before verification
 * would leak which organizations an address belongs to.
 */
async function login(email, plain) {
  const candidates = await User.find({ email: String(email || '').trim().toLowerCase() })
    .setOptions({ allowCrossTenant: true })
    .populate('tenantId', 'name status');

  const matched = [];
  for (const user of candidates) {
    if (!user.passwordHash) continue;
    if (await password.verify(plain, user.passwordHash)) matched.push(user);
  }
  if (!matched.length) throw unauthorized('Incorrect email or password.');

  const usable = matched.filter((u) => u.status === 'ACTIVE' && u.tenantId?.status === 'ACTIVE');
  if (!usable.length) {
    // §5.2: inactive/suspended users cannot log in, but their history stays intact.
    throw unauthorized('This account is not active. Contact your administrator.');
  }
  if (usable.length > 1) {
    return { needsOrgChoice: true, options: usable.map((u) => ({ userId: u._id, tenantName: u.tenantId.name })) };
  }
  return { user: usable[0] };
}

/* ------------------------------ OTP sign-in ------------------------------- */

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_RESEND_MS = 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;

const hashOtp = (code) => crypto.createHash('sha256').update(String(code)).digest('hex');

/**
 * §5.4: sign in with a mobile number and a one-time code.
 *
 * Deliberately the same shape as the customer booking-form OTP (§117) —
 * hashed code, short expiry, hard attempt ceiling — because a six-digit code
 * without those three is not a second factor, it is a short brute force.
 *
 * The response never says whether the number is registered. A login screen that
 * distinguishes "unknown number" from "code sent" is a directory of who works
 * here, readable by anyone.
 */
async function requestLoginOtp(mobile, { tenantCallingCode, now = new Date() } = {}) {
  const normalized = phone.normalizeMobile(mobile, tenantCallingCode);
  if (!normalized) throw badRequest('Enter a valid mobile number.');

  const candidates = await User.find({ normalizedMobile: normalized })
    .setOptions({ allowCrossTenant: true })
    .populate('tenantId', 'name status');
  const usable = candidates.filter((u) => u.canLoginWithOtp() && u.tenantId?.status === 'ACTIVE');

  // Nothing is sent and nothing is revealed — the caller says "if that number
  // is registered, a code is on its way" either way.
  if (!usable.length) return { sent: false, codes: [] };

  const codes = [];
  for (const user of usable) {
    // §192-style throttle: one code a minute, so the send path is not a free
    // SMS pump for anyone who knows a colleague's number.
    if (user.loginOtpSentAt && now.getTime() - new Date(user.loginOtpSentAt).getTime() < OTP_RESEND_MS) {
      continue;
    }
    const code = String(crypto.randomInt(100000, 999999));
    user.loginOtpHash = hashOtp(code);
    user.loginOtpExpiresAt = new Date(now.getTime() + OTP_TTL_MS);
    user.loginOtpAttempts = 0;
    user.loginOtpSentAt = now;
    await user.save();

    await messaging.send({
      tenantId: user.tenantId._id || user.tenantId,
      channel: 'SMS',
      to: normalized,
      purpose: 'ACKNOWLEDGEMENT',
      body: `${code} is your sign-in code. It expires in 10 minutes. Do not share it with anyone.`,
    });
    codes.push({ userId: user._id, code });
  }
  return { sent: true, codes };
}

/**
 * Verifies the code. Every candidate account on that number is checked, so a
 * user who belongs to two organizations reaches the same chooser the password
 * path uses.
 */
async function verifyLoginOtp(mobile, code, { tenantCallingCode, now = new Date() } = {}) {
  const normalized = phone.normalizeMobile(mobile, tenantCallingCode);
  if (!normalized) throw badRequest('Enter a valid mobile number.');
  const supplied = String(code || '').trim();
  if (!/^\d{6}$/.test(supplied)) throw unauthorized('That code is not right. Check it and try again.');

  const candidates = await User.find({ normalizedMobile: normalized })
    .setOptions({ allowCrossTenant: true })
    .populate('tenantId', 'name status');

  const matched = [];
  let sawLockout = false;
  for (const user of candidates) {
    if (!user.loginOtpHash || !user.loginOtpExpiresAt || new Date(user.loginOtpExpiresAt) < now) continue;
    if (user.loginOtpAttempts >= OTP_MAX_ATTEMPTS) { sawLockout = true; continue; }
    if (hashOtp(supplied) === user.loginOtpHash) {
      matched.push(user);
    } else {
      user.loginOtpAttempts += 1;
      await user.save();
    }
  }

  if (!matched.length) {
    if (sawLockout) throw unauthorized('Too many incorrect codes. Ask for a new one.');
    throw unauthorized('That code is not right, or it has expired.');
  }

  // The code is single-use whichever account it opened.
  for (const user of matched) {
    user.loginOtpHash = undefined;
    user.loginOtpExpiresAt = undefined;
    user.loginOtpAttempts = 0;
    await user.save();
  }

  const usable = matched.filter((u) => u.status === 'ACTIVE' && u.tenantId?.status === 'ACTIVE');
  if (!usable.length) throw unauthorized('This account is not active. Contact your administrator.');
  if (usable.length > 1) {
    return { needsOrgChoice: true, options: usable.map((u) => ({ userId: u._id, tenantName: u.tenantId.name })) };
  }
  return { user: usable[0] };
}

/**
 * Completes an organization choice. The candidate ids come from the session
 * entry written by login(), so the password is verified exactly once and never
 * has to be round-tripped through the chooser form.
 */
async function completeOrgChoice(pendingUserIds, chosenUserId) {
  if (!pendingUserIds?.some((id) => String(id) === String(chosenUserId))) {
    throw unauthorized('Please sign in again.');
  }
  const user = await User.findById(chosenUserId).setOptions({ allowCrossTenant: true }).populate('tenantId', 'name status');
  if (!user || user.status !== 'ACTIVE' || user.tenantId?.status !== 'ACTIVE') {
    throw unauthorized('This account is not active. Contact your administrator.');
  }
  return { user };
}

/** Loads the session user with role attached; used on every authenticated request. */
async function loadSessionUser(userId) {
  const user = await User.findById(userId).setOptions({ allowCrossTenant: true }).lean();
  if (!user || user.status !== 'ACTIVE') return null;
  const [role, tenant] = await Promise.all([
    Role.findOne({ tenantId: user.tenantId, _id: user.roleId }).lean(),
    Tenant.findById(user.tenantId).lean(),
  ]);
  if (!role || !role.active || !tenant || tenant.status !== 'ACTIVE') return null;
  return { ...user, role, tenant };
}

/** §5.1: admin-created invitation. Returns the raw token for the invite link. */
async function createInviteToken(user) {
  const { raw, hash } = password.newToken();
  await User.updateOne(
    { tenantId: user.tenantId, _id: user._id },
    { $set: { inviteTokenHash: hash, inviteExpiresAt: new Date(Date.now() + INVITE_TTL_MS), status: 'INVITED' } },
  );
  return raw;
}

async function acceptInvite(rawToken, newPassword) {
  const strengthError = password.validateStrength(newPassword);
  if (strengthError) throw badRequest(strengthError);

  const user = await User.findOne({
    inviteTokenHash: password.hashToken(rawToken),
    inviteExpiresAt: { $gt: new Date() },
  }).setOptions({ allowCrossTenant: true });
  if (!user) throw badRequest('This invitation link is invalid or has expired.');

  user.passwordHash = await password.hash(newPassword);
  user.status = 'ACTIVE';
  user.inviteTokenHash = undefined;
  user.inviteExpiresAt = undefined;
  await user.save();
  await audit.record({ tenantId: user.tenantId, actor: user, entity: 'User', entityId: user._id, action: 'INVITE_ACCEPTED' });
  return user;
}

/**
 * §5.1 forgot password. Always resolves the same way whether or not the address
 * exists, so the response cannot be used to enumerate accounts.
 */
async function requestPasswordReset(email) {
  const users = await User.find({ email: String(email || '').trim().toLowerCase(), status: 'ACTIVE' })
    .setOptions({ allowCrossTenant: true });
  const links = [];
  for (const user of users) {
    const { raw, hash } = password.newToken();
    user.resetTokenHash = hash;
    user.resetExpiresAt = new Date(Date.now() + RESET_TTL_MS);
    await user.save();
    links.push({ user, token: raw });
  }
  return links;
}

async function resetPassword(rawToken, newPassword) {
  const strengthError = password.validateStrength(newPassword);
  if (strengthError) throw badRequest(strengthError);

  const user = await User.findOne({
    resetTokenHash: password.hashToken(rawToken),
    resetExpiresAt: { $gt: new Date() },
  }).setOptions({ allowCrossTenant: true });
  if (!user) throw badRequest('This reset link is invalid or has expired.');

  user.passwordHash = await password.hash(newPassword);
  user.resetTokenHash = undefined;
  user.resetExpiresAt = undefined;
  await user.save();
  await audit.record({ tenantId: user.tenantId, actor: user, entity: 'User', entityId: user._id, action: 'PASSWORD_RESET' });
  return user;
}

async function changePassword(user, currentPassword, newPassword) {
  const full = await User.findOne({ tenantId: user.tenantId, _id: user._id });
  if (!full) throw notFound('User not found.');
  if (!(await password.verify(currentPassword, full.passwordHash))) {
    throw badRequest('Your current password is incorrect.');
  }
  const strengthError = password.validateStrength(newPassword);
  if (strengthError) throw badRequest(strengthError);
  full.passwordHash = await password.hash(newPassword);
  await full.save();
  await audit.record({ tenantId: user.tenantId, actor: user, entity: 'User', entityId: user._id, action: 'PASSWORD_CHANGED' });
}

module.exports = {
  requestLoginOtp, verifyLoginOtp,
  login, completeOrgChoice, loadSessionUser, createInviteToken, acceptInvite,
  requestPasswordReset, resetPassword, changePassword,
};
