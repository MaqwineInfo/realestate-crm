const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * V2 §44–§49 + §272: the partner's invoice against eligible commission.
 *
 * Lines are embedded: a line is never queried independently of its invoice, and
 * embedding keeps the claimed-vs-eligible check in one document.
 *
 * §272: tax fields are stored as supplied and reviewed. This is not a tax
 * engine — nothing here computes a statutory obligation.
 */
const STATUSES = [
  'DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'CORRECTION_REQUIRED', 'APPROVED',
  'REJECTED', 'PAYMENT_PROCESSING', 'PARTIALLY_PAID', 'PAID', 'CANCELLED',
];

const lineSchema = new Schema({
  bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true },
  commissionEntitlementId: { type: Schema.Types.ObjectId, ref: 'PartnerCommissionEntitlement', required: true },
  // What was eligible at the moment of claiming, for the reviewer's context.
  eligibleCommissionMinor: { type: Number, required: true, min: 0 },
  invoiceClaimAmountMinor: { type: Number, required: true, min: 1 },
  note: { type: String, maxlength: 300 },
}, { _id: true });

const partnerInvoiceSchema = new Schema({
  invoiceRef: { type: String, index: true },
  channelPartnerId: { type: Schema.Types.ObjectId, ref: 'ChannelPartner', required: true, index: true },
  // §46: the partner's own invoice number, which is theirs to set.
  invoiceNumber: { type: String, trim: true, maxlength: 60 },
  invoiceDate: { type: Date },

  billingEntityName: { type: String, trim: true, maxlength: 200 },
  gstin: { type: String, trim: true, uppercase: true, maxlength: 20 },
  pan: { type: String, trim: true, uppercase: true, maxlength: 12 },
  lines: [lineSchema],

  taxableValueMinor: { type: Number, default: 0, min: 0 },
  gstAmountMinor: { type: Number, default: 0, min: 0 },
  otherAdjustmentMinor: { type: Number, default: 0 },
  invoiceTotalMinor: { type: Number, default: 0, min: 0 },
  taxMode: { type: String, maxlength: 30 },

  // §298: the PDF is private. Partners download their own; nobody else's.
  invoicePdf: {
    storageKey: { type: String },
    fileLabel: { type: String, maxlength: 120 },
    mimeType: { type: String },
    bytes: { type: Number },
  },
  /** §315: previous submissions are preserved, not overwritten. */
  previousVersions: [{
    submittedAt: { type: Date },
    invoiceNumber: { type: String },
    invoiceTotalMinor: { type: Number },
    storageKey: { type: String },
    correctionNote: { type: String },
  }],

  // §46/§21: whose bank account this was to be paid into, as it stood then.
  bankSnapshot: {
    accountHolderName: { type: String },
    bankName: { type: String },
    accountNumberMasked: { type: String },
    ifsc: { type: String },
    branch: { type: String },
  },

  status: { type: String, enum: STATUSES, default: 'DRAFT', index: true },
  note: { type: String, maxlength: 1000 },
  submittedAt: { type: Date },
  reviewedAt: { type: Date },
  reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  reviewNote: { type: String, maxlength: 1000 },
  approvedAt: { type: Date },
  approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  rejectionReason: { type: String, maxlength: 1000 },
  paidAmountMinor: { type: Number, default: 0, min: 0 },
  paidAt: { type: Date },
  createdByType: { type: String, enum: ['INTERNAL_USER', 'PARTNER'], default: 'PARTNER' },
  createdByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  createdByPortalUserId: { type: Schema.Types.ObjectId, ref: 'PartnerPortalUser' },
}, { timestamps: true });

partnerInvoiceSchema.plugin(tenantGuard);
partnerInvoiceSchema.index({ tenantId: 1, channelPartnerId: 1, status: 1 });
partnerInvoiceSchema.index({ tenantId: 1, status: 1, submittedAt: -1 });

/** The sum a partner is claiming across every line. */
partnerInvoiceSchema.virtual('claimedMinor').get(function claimed() {
  return (this.lines || []).reduce((sum, line) => sum + (line.invoiceClaimAmountMinor || 0), 0);
});

module.exports = model('PartnerInvoice', partnerInvoiceSchema);
module.exports.STATUSES = STATUSES;
