const { crud } = require('./factory');
const messages = require('../../lib/society/messages');
const { notFound, conflict } = require('../../lib/errors');
const { SocietyAdmin, SocietyRole } = require('../../db/models/society');

/**
 * Society admins — chairman, facility manager, finance admin.
 *
 * Platform-scoped for lookup (an admin's row is found by phone before any
 * society is known), but every admin still belongs to one society through
 * `societyId` or the `societies[]` list.
 */
const base = crud({
  Model: SocietyAdmin,
  listKey: 'admins',
  searchFields: ['fullName', 'phoneNumber', 'email'],
  filterFields: ['societyId', 'isActive', 'role'],
  populate: ['roleId'],
  sort: { createdAt: -1 },
});

async function create(ctx, data, actorId) {
  const clash = await SocietyAdmin.findOne({
    phoneNumber: data.phoneNumber,
    countryCode: data.countryCode || '+91',
    societyId: data.societyId || null,
    isDeleted: false,
  }).select('_id').lean();
  if (clash) throw conflict('An admin with that phone number already exists for this society.');

  if (data.roleId && !await SocietyRole.findOne({ _id: data.roleId, isDeleted: false }).select('_id').lean()) {
    throw notFound(messages.en.role.not_found);
  }
  return base.create(ctx, data, actorId);
}

/** The signed-in admin's own record — `GET /super-admin/society-admins/profile`. */
async function profile(adminId) {
  const admin = await SocietyAdmin.findOne({ _id: adminId, isDeleted: false })
    .populate('roleId')
    .populate('societyId', 'societyCode societyName planExpiryDate status')
    .lean();
  if (!admin) throw notFound(messages.en.auth.not_auth);
  delete admin.otp;
  delete admin.otpDatetime;
  return admin;
}

module.exports = { ...base, create, profile };
