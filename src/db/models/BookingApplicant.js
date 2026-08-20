const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * V2 §122/§123: who is actually buying, as declared on the booking form.
 *
 * Deliberately NOT a CRM Contact (§185): a co-applicant is a party to this
 * booking, not a sales lead, and creating contacts for them would put spouses
 * and parents into the marketing pipeline.
 *
 * There is no Aadhaar number field anywhere in this build (a documented product
 * decision) — the document image is enough, and a number nobody stores cannot
 * leak. PAN is masked for display and sealed for storage (§131).
 */
const ROLES = ['PRIMARY', 'CO_APPLICANT', 'AUTHORIZED_SIGNATORY'];
const TYPES = ['INDIVIDUAL', 'COMPANY'];
const KYC_STATUSES = ['NOT_STARTED', 'PARTIAL', 'SUBMITTED', 'UNDER_REVIEW', 'CORRECTION_REQUIRED', 'VERIFIED'];

const bookingApplicantSchema = new Schema({
  bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true, index: true },
  applicantRole: { type: String, enum: ROLES, required: true },
  type: { type: String, enum: TYPES, default: 'INDIVIDUAL' },
  displayOrder: { type: Number, default: 0 },

  // §120 individual
  name: { type: String, required: true, trim: true, maxlength: 150 },
  mobile: { type: String, trim: true, maxlength: 20 },
  normalizedMobile: { type: String, trim: true, maxlength: 20 },
  email: { type: String, trim: true, lowercase: true, maxlength: 150 },
  dateOfBirth: { type: Date },
  panMasked: { type: String, maxlength: 20 },
  panSealed: { type: String },
  occupation: { type: String, maxlength: 120 },
  employerName: { type: String, maxlength: 150 },
  nationality: { type: String, maxlength: 60 },
  maritalStatus: { type: String, enum: ['SINGLE', 'MARRIED', 'OTHER'] },
  relationship: { type: String, maxlength: 60 },
  permanentAddress: { type: String, maxlength: 500 },
  correspondenceAddress: { type: String, maxlength: 500 },
  city: { type: String, maxlength: 80 },
  state: { type: String, maxlength: 80 },
  pincode: { type: String, maxlength: 12 },
  fundingType: { type: String, enum: ['SELF_FUNDED', 'HOME_LOAN', 'MIXED', 'UNKNOWN'] },
  loanBank: { type: String, maxlength: 120 },

  // §121 company
  companyLegalName: { type: String, maxlength: 200 },
  gstin: { type: String, maxlength: 20 },
  cin: { type: String, maxlength: 30 },
  registeredAddress: { type: String, maxlength: 500 },
  signatoryName: { type: String, maxlength: 150 },
  signatoryMobile: { type: String, maxlength: 20 },
  signatoryEmail: { type: String, maxlength: 150 },

  kycStatus: { type: String, enum: KYC_STATUSES, default: 'NOT_STARTED' },
  updatedByType: { type: String, enum: ['CUSTOMER', 'INTERNAL_USER'], default: 'INTERNAL_USER' },
}, { timestamps: true });

bookingApplicantSchema.plugin(tenantGuard);
bookingApplicantSchema.index({ tenantId: 1, bookingId: 1, applicantRole: 1 });

module.exports = model('BookingApplicant', bookingApplicantSchema);
module.exports.ROLES = ROLES;
module.exports.TYPES = TYPES;
module.exports.KYC_STATUSES = KYC_STATUSES;
