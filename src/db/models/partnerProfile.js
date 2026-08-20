const { Schema } = require('mongoose');

/**
 * V2 §16–§21: the business identity of a channel partner.
 *
 * Shared by `ChannelPartnerRegistration` (what was applied for) and
 * `ChannelPartner` (what was approved), because they are the same 30 fields and
 * keeping two copies of the shape is how the two drift apart.
 *
 * §21: the bank account number is masked for display and sealed for storage —
 * the full value is only ever read by an explicitly permitted, audited action.
 */
const PARTNER_TYPES = ['COMPANY', 'INDIVIDUAL'];
const CONSTITUTIONS = ['PROPRIETORSHIP', 'PARTNERSHIP', 'LLP', 'PRIVATE_LIMITED', 'PUBLIC_LIMITED', 'HUF', 'OTHER'];
const TAX_MODES = ['GST_EXCLUSIVE', 'GST_INCLUSIVE', 'NO_GST'];

const partnerProfileSchema = new Schema({
  partnerType: { type: String, enum: PARTNER_TYPES, required: true },

  // §16 contact
  primaryContactName: { type: String, trim: true, maxlength: 150 },
  mobile: { type: String, trim: true, maxlength: 20 },
  normalizedMobile: { type: String, trim: true, maxlength: 20 },
  email: { type: String, trim: true, lowercase: true, maxlength: 150 },
  address: { type: String, maxlength: 500 },
  city: { type: String, trim: true, maxlength: 80 },
  state: { type: String, trim: true, maxlength: 80 },
  pincode: { type: String, trim: true, maxlength: 12 },

  // §17 business
  legalName: { type: String, trim: true, maxlength: 200 },
  tradeName: { type: String, trim: true, maxlength: 200 },
  constitutionType: { type: String, enum: CONSTITUTIONS },
  pan: { type: String, trim: true, uppercase: true, maxlength: 12 },
  gstin: { type: String, trim: true, uppercase: true, maxlength: 20 },
  companyRegistrationNumber: { type: String, trim: true, maxlength: 40 },
  registeredAddress: { type: String, maxlength: 500 },
  correspondenceAddress: { type: String, maxlength: 500 },
  website: { type: String, trim: true, maxlength: 200 },
  yearsInBusiness: { type: Number, min: 0, max: 200 },
  signatoryName: { type: String, trim: true, maxlength: 150 },
  signatoryMobile: { type: String, trim: true, maxlength: 20 },
  signatoryEmail: { type: String, trim: true, lowercase: true, maxlength: 150 },

  // §21 bank & invoice
  bank: {
    accountHolderName: { type: String, trim: true, maxlength: 150 },
    bankName: { type: String, trim: true, maxlength: 120 },
    accountNumberMasked: { type: String, maxlength: 24 },
    accountNumberSealed: { type: String },
    ifsc: { type: String, trim: true, uppercase: true, maxlength: 15 },
    branch: { type: String, trim: true, maxlength: 120 },
    cancelledCheque: {
      storageKey: { type: String },
      fileLabel: { type: String, maxlength: 120 },
      mimeType: { type: String },
      bytes: { type: Number },
    },
  },
  billingAddress: { type: String, maxlength: 500 },
  defaultInvoiceTaxMode: { type: String, enum: TAX_MODES, default: 'GST_EXCLUSIVE' },
  msmeNumber: { type: String, trim: true, maxlength: 40 },
}, { _id: false });

/** The name to show: trade name if there is one, else legal, else the contact. */
partnerProfileSchema.virtual('displayName').get(function displayName() {
  return this.tradeName || this.legalName || this.primaryContactName || 'Channel partner';
});

module.exports = partnerProfileSchema;
module.exports.PARTNER_TYPES = PARTNER_TYPES;
module.exports.CONSTITUTIONS = CONSTITUTIONS;
module.exports.TAX_MODES = TAX_MODES;
