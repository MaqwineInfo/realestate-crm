const { Schema, model } = require('mongoose');
const platformScoped = require('../../platformScoped');

/**
 * A chairman, society admin, finance admin or platform super admin — the
 * identity behind `/api/v1/super-admin/*` and `/api/v1/society-admin/*`.
 *
 * Platform-scoped rather than society-scoped, for two reasons: a super admin
 * has no single `societyId` (they hold a `societies[]` list instead), and the
 * login lookup happens by phone number before any society is known. Requests
 * are pinned to one society by the `x-society-id` header, which
 * `middleware/societyAuth.js` validates against this row on every call.
 *
 * Auth is OTP-on-phone, like `SocietyUser`. There is no password.
 *
 * `customPermissions` overrides the role's catalog per admin. A Map of
 * permission key to boolean, so an override can grant *or* explicitly revoke —
 * an absent key means "defer to the role", which a plain array could not say.
 *
 * The unique index is partial on `isDeleted: false` so a phone number becomes
 * reusable once an admin is removed.
 */
const adminSchema = new Schema({
  phoneNumber: { type: String, required: true, trim: true, index: true },
  countryCode: { type: String, default: '+91', trim: true },
  userId: { type: Schema.Types.ObjectId, ref: 'SocietyUser', index: true },
  email: { type: String, lowercase: true, trim: true, sparse: true },
  fullName: { type: String, trim: true },

  /** `select: false`: see the note on `SocietyUser.otp`. */
  otp: { type: String, default: null, select: false },
  otpDatetime: { type: Date, default: null, select: false },
  otpVerified: { type: Boolean, default: false },

  roleId: { type: Schema.Types.ObjectId, ref: 'SocietyRole', required: true, index: true },
  /** Denormalised role name the source kept for backward compatibility. */
  role: { type: String, default: 'Admin' },

  societyId: { type: Schema.Types.ObjectId, ref: 'Society', default: null, index: true },
  societyName: { type: String },
  committeeMemberId: {
    type: Schema.Types.ObjectId, ref: 'SocietyCommitteeMember', default: null, index: true, sparse: true,
  },

  /** Multi-society access, for admins above a single society. */
  societies: [{
    societyId: { type: Schema.Types.ObjectId, ref: 'Society' },
    societyName: String,
    assignedAt: { type: Date, default: Date.now },
  }],

  customPermissions: { type: Map, of: Boolean },

  lastLoginAt: { type: Date },
  lastActivityAt: { type: Date },

  isActive: { type: Boolean, default: true },
  isDeleted: { type: Boolean, default: false },
  deletedAt: { type: Date, default: null },
  metadata: { type: Schema.Types.Mixed, default: {} },
}, { timestamps: true, versionKey: false, collection: 'society_admins' });

adminSchema.plugin(platformScoped);
adminSchema.index(
  { phoneNumber: 1, countryCode: 1, societyId: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } },
);
adminSchema.index({ phoneNumber: 1, isDeleted: 1 });
adminSchema.index({ roleId: 1, isActive: 1 });
adminSchema.index({ societyId: 1, isDeleted: 1 });

module.exports = model('SocietyAdmin', adminSchema);
