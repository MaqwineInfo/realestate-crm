const jwtLib = require('../../lib/society/jwt');
const messages = require('../../lib/society/messages');
const { badRequest, notFound, forbidden } = require('../../lib/errors');
const otp = require('./otp');
const {
  Society, SocietyAdmin, SocietyTokenBlacklist,
} = require('../../db/models/society');

const M = messages.en;

/** Strip the formatting people paste in from a contacts app. */
const normalizePhone = (phone) => String(phone || '').replace(/[\s\-()]/g, '').trim();

/**
 * Society admin sign-in: OTP to a phone, scoped to one society by its code.
 *
 * The society code is not decoration. An admin's phone number is unique only
 * within a society (`SocietyAdmin`'s partial unique index), so the code is part
 * of the identity being claimed — and it is re-checked on verify, not just on
 * send, so a code cannot be sent for one society and redeemed for another.
 */

async function findAdmin({ societyCode, countryCode, phoneNumber }) {
  const society = await Society.findOne({ societyCode: String(societyCode || '').toUpperCase() });
  if (!society) throw notFound(M.auth.un_authenticate);

  const admin = await SocietyAdmin.findOne({
    phoneNumber: normalizePhone(phoneNumber),
    countryCode,
    societyId: society._id,
    isDeleted: false,
    isActive: true,
  })
    // `otp` and `otpDatetime` are `select: false` on the model, so the one place
    // that legitimately needs them asks for them by name.
    .select('+otp +otpDatetime')
    .populate('societyId', 'societyCode societyName planExpiryDate status');

  if (!admin) throw notFound(M.auth.un_authenticate);
  return { society, admin };
}

/**
 * A super admin may hold no society; anyone else must match the one they asked
 * for. Ported from the source's `verifySocietyAccess`.
 */
function assertSocietyAccess(admin, societyCode) {
  if (!admin.societyId) {
    if (admin.role === 'SuperAdmin') return;
    throw forbidden('Admin is not assigned to any society');
  }
  if (!admin.societyId.societyCode) throw forbidden('Society data not found');
  if (admin.societyId.societyCode !== societyCode) {
    throw forbidden('You are not authorized to access this society');
  }
}

async function sendPhoneOtp({ societyCode, countryCode, phoneNumber }) {
  const { admin } = await findAdmin({ societyCode, countryCode, phoneNumber });
  assertSocietyAccess(admin, societyCode);

  const { code, fields } = await otp.issue();
  await SocietyAdmin.updateOne({ _id: admin._id }, { $set: fields });
  await otp.send({ countryCode, phoneNumber, code });

  return { message: M.user.otp_send_success };
}

const resendOtp = sendPhoneOtp;

async function verifyPhoneOtp({ societyCode, countryCode, phoneNumber, otp: submitted }) {
  const { admin } = await findAdmin({ societyCode, countryCode, phoneNumber });
  assertSocietyAccess(admin, societyCode);

  if (!admin.otp) throw badRequest(M.user.otp_invalid);
  // Expiry is checked before the code so a stale code cannot be brute-forced
  // indefinitely against a row whose window closed.
  if (!otp.withinWindow(admin.otpDatetime)) throw badRequest(M.user.otp_expired);
  if (!await otp.verify(submitted, admin.otp)) throw badRequest(M.user.otp_invalid);

  await SocietyAdmin.updateOne({ _id: admin._id }, {
    $set: { otpVerified: true, lastLoginAt: new Date(), lastActivityAt: new Date() },
    $unset: { otp: '', otpDatetime: '' },
  });

  /**
   * Payload shape is contract (D2): `id` is the admin's SocietyUser id and
   * `adminId` the admin row — see `middleware/societyAuth.js`, which resolves
   * either. Signed with the admin secret, so this token cannot be replayed
   * against the resident surface.
   */
  const accessToken = jwtLib.sign('admin', {
    id: admin.userId,
    adminId: admin._id,
    role: admin.role,
    role_id: admin.roleId,
    society_id: admin.societyId?._id || null,
    society_code: admin.societyId?.societyCode || null,
  });

  return {
    message: M.user.otp_verify_sucess,
    admin: {
      _id: admin._id,
      userId: admin.userId,
      phoneNumber: admin.phoneNumber,
      countryCode: admin.countryCode,
      email: admin.email,
      fullName: admin.fullName,
      role: [admin.role],
      roleId: admin.roleId,
      societyId: admin.societyId?._id || null,
      societyCode: admin.societyId?.societyCode || null,
      societyName: admin.societyId?.societyName || admin.societyName,
      planExpiryDate: admin.societyId?.planExpiryDate || null,
      accessToken,
    },
  };
}

/**
 * Logout. A bearer token cannot be withdrawn, so it is recorded as revoked and
 * `middleware/societyAuth.js` refuses it from then on. `expiresAt` lets Mongo
 * drop the row once the token could no longer have worked anyway.
 */
async function logout({ token, adminId }) {
  if (!token) return { message: M.user.logout_success };
  const payload = jwtLib.verify('admin', token) || jwtLib.verify('user', token);
  await SocietyTokenBlacklist.create({
    token,
    adminId: adminId || payload?.adminId || null,
    expiresAt: payload?.exp ? new Date(payload.exp * 1000) : null,
  });
  return { message: M.user.logout_success };
}

module.exports = {
  sendPhoneOtp, resendOtp, verifyPhoneOtp, logout, normalizePhone, assertSocietyAccess,
};
