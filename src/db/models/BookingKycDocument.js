const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * V2 §126–§128: one uploaded KYC file.
 *
 * A replacement never overwrites: the old row stays with `active: false` and
 * points forward via `supersededById`, because "what did the customer send us
 * on the 3rd" is exactly the question an audit asks (§128).
 *
 * The bytes live outside public/ (lib/privateFiles) and are only reachable
 * through the permission-checked download route (§131).
 */
const REVIEW_STATUSES = ['UPLOADED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'RESUBMISSION_REQUIRED'];

const bookingKycDocumentSchema = new Schema({
  bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true, index: true },
  bookingApplicantId: { type: Schema.Types.ObjectId, ref: 'BookingApplicant', required: true, index: true },
  documentTypeId: { type: Schema.Types.ObjectId, ref: 'KycDocumentType', required: true },

  storageKey: { type: String, required: true },
  fileLabel: { type: String, maxlength: 120 },
  mimeType: { type: String, required: true },
  bytes: { type: Number },
  // §131: masked for display, sealed for storage, never both in the open.
  documentNumberMasked: { type: String, maxlength: 24 },
  documentNumberSealed: { type: String },
  expiryDate: { type: Date },

  uploadedByType: { type: String, enum: ['CUSTOMER', 'INTERNAL_USER'], required: true },
  uploadedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  uploadedAt: { type: Date, default: Date.now },

  reviewStatus: { type: String, enum: REVIEW_STATUSES, default: 'UPLOADED', index: true },
  reviewNote: { type: String, maxlength: 500 },
  reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  reviewedAt: { type: Date },

  active: { type: Boolean, default: true, index: true },
  supersededById: { type: Schema.Types.ObjectId, ref: 'BookingKycDocument' },
}, { timestamps: true });

bookingKycDocumentSchema.plugin(tenantGuard);
bookingKycDocumentSchema.index({ tenantId: 1, bookingId: 1, active: 1 });
bookingKycDocumentSchema.index({ tenantId: 1, bookingApplicantId: 1, documentTypeId: 1, active: 1 });

module.exports = model('BookingKycDocument', bookingKycDocumentSchema);
module.exports.REVIEW_STATUSES = REVIEW_STATUSES;
