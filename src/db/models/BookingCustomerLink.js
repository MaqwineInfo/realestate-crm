const { Schema, model } = require('mongoose');
const crypto = require('node:crypto');
const tenantGuard = require('../tenantGuard');

/**
 * V2 §117: the secure customer link.
 *
 * Only the SHA-256 of the token is stored — the token itself exists in the URL
 * the customer holds and nowhere else, so a database read cannot reopen a
 * customer's booking form. Same reasoning as a password hash.
 */
const STATUSES = ['ACTIVE', 'SUBMITTED', 'EXPIRED', 'REVOKED'];

const bookingCustomerLinkSchema = new Schema({
  bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  status: { type: String, enum: STATUSES, default: 'ACTIVE', index: true },
  expiresAt: { type: Date, required: true },
  lastOpenedAt: { type: Date },
  openCount: { type: Number, default: 0 },
  submittedAt: { type: Date },
  revokedAt: { type: Date },
  revokedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  sentAt: { type: Date },
  sentChannel: { type: String, enum: ['WHATSAPP', 'SMS', 'EMAIL'] },

  /**
   * §117: OTP is a tenant setting, off by default. When on, the customer proves
   * they hold the booking mobile before the form opens. The code is hashed for
   * the same reason the token is.
   */
  otpRequired: { type: Boolean, default: false },
  otpHash: { type: String },
  otpExpiresAt: { type: Date },
  otpAttempts: { type: Number, default: 0 },
  otpVerifiedAt: { type: Date },

  // §289: which sections a reopened form may edit. Empty means everything.
  reopenSections: [{ type: String, enum: ['APPLICANTS', 'KYC'] }],
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

bookingCustomerLinkSchema.plugin(tenantGuard);
bookingCustomerLinkSchema.index({ tenantId: 1, bookingId: 1, status: 1 });

/** The token is returned once, at creation; only its hash is ever stored. */
bookingCustomerLinkSchema.statics.hash = (token) => crypto
  .createHash('sha256').update(String(token)).digest('hex');

module.exports = model('BookingCustomerLink', bookingCustomerLinkSchema);
module.exports.STATUSES = STATUSES;
