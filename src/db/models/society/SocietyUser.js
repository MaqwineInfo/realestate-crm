const { Schema, model } = require('mongoose');
const platformScoped = require('../../platformScoped');
const enums = require('./enums');

/**
 * The identity a resident, gatekeeper or chairman logs in as.
 *
 * Platform-scoped on purpose: a person exists before they belong to a society
 * (they submit an enquiry first), and `societyId` here is a convenience pointer
 * to their primary society, not an isolation boundary. Residency itself lives
 * in `SocietyUnitOccupancy`, which can hold several units for one person.
 *
 * Ported from the source's `user-services` users collection, which
 * `society-admin-services/models/userServiceUsers.js` and
 * `society-user-services/models/users.js` both mirror.
 *
 * NOT ported: `society-admin-services/models/users.js`. That declared a second,
 * incompatible shape on this same collection — societyId + unitNumber + a full
 * cost sheet — with a `{societyId, unitNumber}` unique index that would collide
 * with this model's null values. It is a pre-`units` leftover: its fields are
 * `SocietyUnit`'s fields, and the endpoints that read it are unit queries
 * wearing a `/users/*` URL (their own route comments say "Get all units
 * listing", "Get unit statistics"). Those endpoints are served from
 * `SocietyUnit` through the façade. See SOCIETY-PLAN.md §2.3.
 *
 * Auth is OTP-on-mobile; there is no password. `otp` is stored hashed and
 * cleared on use.
 */
const userSchema = new Schema({
  mobileNumber: { type: String, required: true, unique: true, trim: true, index: true },
  countryCode: { type: String, required: true, default: '+91' },

  /**
   * `select: false` — a credential must not ride along on ordinary reads. It is
   * hashed, but a hash in a list response is still a hash somebody can attack
   * offline, and the admin directory endpoint returned it before this was set.
   * Auth asks for it explicitly with `.select('+otp')`.
   */
  otp: { type: String, default: null, select: false },
  otpExpiresAt: { type: Date, default: null, select: false },
  isMobileVerified: { type: Boolean, default: false },

  firstName: { type: String, default: '', trim: true },
  lastName: { type: String, default: '', trim: true },
  email: { type: String, default: null, sparse: true, trim: true, lowercase: true },
  image: { type: String, default: null, trim: true },
  gender: { type: String, enum: [...enums.gender, null], default: null },

  /** The source's spelling of the gate role is `gateKepper`; kept for contract parity. */
  role: { type: String, enum: ['owner', 'tenant', 'gateKepper', null], default: null, index: true },
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', default: null, index: true },
  isSocietyAdmin: { type: Boolean, default: false, index: true },

  /** Firebase device token. Push sends resolve through services/messaging.js. */
  fcmToken: { type: String, default: null, trim: true, index: true },
  ownershipProof: { type: String, default: null },

  status: { type: String, enum: enums.commonStatus, default: 'ACTIVE', index: true },
  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
}, { timestamps: true, collection: 'society_users' });

userSchema.plugin(platformScoped);
userSchema.index({ isSocietyAdmin: 1, isDeleted: 1 });
userSchema.index({ societyId: 1, isSocietyAdmin: 1 });
userSchema.index({ societyId: 1, role: 1, isDeleted: 1 });

module.exports = model('SocietyUser', userSchema);
