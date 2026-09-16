const jwtLib = require('../../lib/society/jwt');
const messages = require('../../lib/society/messages');
const { badRequest, notFound } = require('../../lib/errors');
const otp = require('./otp');
const {
  Society, SocietyUser, SocietyUnitOccupancy, SocietyTokenBlacklist,
} = require('../../db/models/society');

const M = messages.en;

/**
 * The resident app's front door — `/api/v1/app/users/*`.
 *
 * Distinct from `services/society/auth.js`, which signs *admins* in: that one
 * is scoped by society code and issues a token on the admin secret. A resident
 * has only a phone number, may belong to several societies, and gets a token on
 * the user secret. Two audiences, two secrets, no crossover — a resident token
 * replayed against an admin route fails signature verification, not just a role
 * check.
 *
 * "Register" is a misnomer inherited from the source: it does not create
 * anybody. A resident exists because an admin added them or their onboarding
 * request was approved, so this only sends a code to a number already on file.
 * The source's own error message says as much — "Please contact admin to add
 * property."
 *
 * Two departures, both already made for the admin path and kept here for the
 * same reasons (see `otp.js`): the code is stored hashed, and the response does
 * NOT echo it. The source returned `otp` in the JSON body of `register`, which
 * makes every login a one-request account takeover for anyone who can reach the
 * endpoint. `SOCIETY_OTP_DEV_CODE` covers local development.
 */

const normalizePhone = (phone) => String(phone || '').replace(/[\s\-()]/g, '').trim();

/**
 * The source matched `register` on the mobile number alone (its country-code
 * check is commented out) but `resend`/`verify` on number + country code. That
 * inconsistency lets a code be sent and then be unredeemable, so all three
 * match the same way: number first, country code only when one was supplied.
 */
function findQuery({ mobileNumber, countryCode }) {
  const q = { mobileNumber: normalizePhone(mobileNumber), isDeleted: false };
  if (countryCode) q.countryCode = countryCode;
  return q;
}

async function issueOtpTo(user, { countryCode, mobileNumber, fcmToken }) {
  const { code, fields } = await otp.issueForUser();
  const set = { ...fields };
  if (fcmToken !== undefined) set.fcmToken = fcmToken || null;
  await SocietyUser.updateOne({ _id: user._id }, { $set: set });
  await otp.send({ countryCode: countryCode || user.countryCode, phoneNumber: mobileNumber, code });

  return {
    mobileNumber: user.mobileNumber,
    countryCode: countryCode || user.countryCode,
    message: 'OTP generated successfully. Please verify to complete registration.',
  };
}

async function register(data) {
  const user = await SocietyUser.findOne(findQuery(data));
  // The source's wording, kept: it tells the resident what to actually do.
  if (!user) throw badRequest('Please contact admin to add property.');
  return { message: M.user.otp_send_success, result: await issueOtpTo(user, data) };
}

async function resend(data) {
  const user = await SocietyUser.findOne(findQuery(data));
  if (!user) throw notFound(M.user.not_found);
  const result = await issueOtpTo(user, data);
  result.message = 'OTP resent successfully. Please verify to complete registration.';
  return { message: M.user.otp_send_success, result };
}

/** Filled in only when the fields are all there; the app gates onboarding on it. */
const profileComplete = (u) => Boolean(
  u.firstName?.trim() && u.lastName?.trim() && u.email?.trim(),
);

const PROPERTY_FIELDS = 'societyName societyCode description logo projectType totalUnits address status';

async function propertyOf(societyId) {
  if (!societyId) return null;
  const society = await Society.findOne({ _id: societyId, isDeleted: false })
    .select(PROPERTY_FIELDS).lean();
  if (!society) return null;
  return {
    _id: society._id,
    societyName: society.societyName,
    societyCode: society.societyCode,
    description: society.description || null,
    logo: society.logo || null,
    projectType: society.projectType,
    totalUnits: society.totalUnits,
    address: society.address || null,
    status: society.status,
  };
}

/**
 * The source read `unitNumber` off the user row. That column belonged to the
 * duplicate `users` schema this port did not carry (SOCIETY-PLAN.md §2.3), so
 * the field is answered from where residency actually lives — the occupancy —
 * and the wire shape is unchanged.
 */
async function primaryUnitNumber(userId) {
  const occupancy = await SocietyUnitOccupancy.findOne({
    userId, isCurrent: true, isDeleted: false,
  }).setOptions({ allowCrossSociety: true })
    .sort({ isPrimary: -1, createdAt: 1 })
    .populate('unitId', 'unitNumber')
    .lean();
  return occupancy?.unitId?.unitNumber || null;
}

async function identity(user) {
  const [property, unitNumber] = await Promise.all([
    propertyOf(user.societyId),
    primaryUnitNumber(user._id),
  ]);
  return {
    mobileNumber: user.mobileNumber,
    countryCode: user.countryCode,
    isMobileVerified: user.isMobileVerified,
    isProfileComplete: profileComplete(user),
    societyId: user.societyId || null,
    unitNumber,
    isSocietyAdmin: user.isSocietyAdmin || false,
    property,
  };
}

async function verify({ mobileNumber, countryCode, otp: submitted }) {
  const user = await SocietyUser.findOne(findQuery({ mobileNumber, countryCode }))
    .select('+otp +otpExpiresAt');
  if (!user) throw notFound(M.user.not_found);

  if (!user.otp) throw badRequest(M.user.otp_invalid);
  // Expiry before code, so a closed window cannot be brute-forced.
  if (!user.otpExpiresAt || new Date() > user.otpExpiresAt) throw badRequest(M.user.otp_expired);
  if (!await otp.verify(submitted, user.otp)) throw badRequest(M.user.otp_invalid);

  await SocietyUser.updateOne(
    { _id: user._id },
    { $set: { isMobileVerified: true }, $unset: { otp: '', otpExpiresAt: '' } },
  );
  user.isMobileVerified = true;

  const token = jwtLib.sign('user', {
    id: user._id,
    mobileNumber: user.mobileNumber,
    countryCode: user.countryCode,
  });

  return {
    message: M.user.otp_verify_sucess,
    result: {
      ...await identity(user),
      token,
      message: 'Mobile number verified successfully. Token generated.',
    },
  };
}

async function logout({ token }) {
  if (!token) return { message: M.user.logout_success };
  const payload = jwtLib.verify('user', token) || jwtLib.verify('admin', token);
  await SocietyTokenBlacklist.create({
    token,
    expiresAt: payload?.exp ? new Date(payload.exp * 1000) : null,
  });
  return { message: M.user.logout_success };
}

const profile = async (user) => identity(user);

/** Editable by the resident. Phone number is identity and is not among them. */
const EDITABLE = ['firstName', 'lastName', 'email', 'role', 'fcmToken', 'image', 'gender'];

async function updateProfile(userId, data) {
  const user = await SocietyUser.findOne({ _id: userId, isDeleted: false });
  if (!user) throw notFound(M.user.user_not_found);

  const patch = {};
  for (const key of EDITABLE) if (data[key] !== undefined) patch[key] = data[key];

  if (patch.email && patch.email !== user.email) {
    const taken = await SocietyUser.exists({
      email: patch.email, _id: { $ne: userId }, isDeleted: false,
    });
    if (taken) throw badRequest(M.user.email_already_exists);
  }

  const updated = await SocietyUser.findOneAndUpdate(
    { _id: userId, isDeleted: false }, { $set: patch }, { new: true, runValidators: true },
  );
  return { message: M.user.profile_update_success, result: await identity(updated) };
}

module.exports = {
  register, resend, verify, logout, profile, updateProfile,
  identity, profileComplete, propertyOf, normalizePhone,
};
