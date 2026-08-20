const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * Spec §33: the final sales stage in V1. §33.1 lists the mandatory data and
 * §33.3 the validations; both are enforced in services/bookings.js.
 *
 * Attribution is copied onto the booking at the moment of sale so campaign
 * reporting (§39, §119) cannot drift when a lead's latest source changes later.
 */
const bookingSchema = new Schema({
  leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true, index: true },
  contactId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true, index: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  unitId: { type: Schema.Types.ObjectId, ref: 'Unit', required: true, unique: true, sparse: true },
  blockId: { type: Schema.Types.ObjectId, ref: 'UnitBlock' },
  costSheetId: { type: Schema.Types.ObjectId, ref: 'CostSheet' },

  bookingDate: { type: Date, required: true, index: true },
  finalPriceMinor: { type: Number, required: true, min: 0 },
  bookingAmountMinor: { type: Number, required: true, min: 0 },
  discountMinor: { type: Number, default: 0, min: 0 },
  paymentPlanId: { type: Schema.Types.ObjectId, ref: 'PaymentPlan', required: true },

  // §33.2 buyer purpose is mandatory and drives §35/§36 opportunities.
  buyerPurpose: { type: String, enum: ['SELF_USE', 'INVESTMENT', 'RENTAL_INCOME', 'OTHER'], required: true },
  investment: {
    expectedExitDate: { type: Date },
    expectedExitPriceMinor: { type: Number, min: 0 },
    expectedRoiPercentage: { type: Number },
    resaleInterest: { type: Boolean, default: false },
    notes: { type: String, maxlength: 500 },
  },
  rental: {
    expectedRentalStartDate: { type: Date },
    expectedRentMinor: { type: Number, min: 0 },
    furnishing: { type: String, enum: ['FURNISHED', 'SEMI_FURNISHED', 'UNFURNISHED'] },
    rentalInterest: { type: Boolean, default: false },
    notes: { type: String, maxlength: 500 },
  },

  salespersonId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  // Attribution snapshot (§119).
  sourceId: { type: Schema.Types.ObjectId, ref: 'LeadSource' },
  originalSourceId: { type: Schema.Types.ObjectId, ref: 'LeadSource' },
  campaignId: { type: Schema.Types.ObjectId, ref: 'MarketingCampaign' },
  firstTouchCampaignId: { type: Schema.Types.ObjectId, ref: 'MarketingCampaign' },
  lastTouchCampaignId: { type: Schema.Types.ObjectId, ref: 'MarketingCampaign' },

  status: { type: String, enum: ['BOOKED', 'REGISTERED', 'CANCELLED'], default: 'BOOKED', index: true },

  /* ------------------------- V2 post-booking (Part C) ----------------------- */

  // §105/§110: a number a human can read out over the phone. The id stays authoritative.
  bookingNumber: { type: String, index: true },
  /**
   * §115: the payment plan exactly as it was sold, copied from the quotation
   * (or the plan master when the booking had no quotation). The schedule is
   * generated from this and from nothing else, so a later plan edit cannot
   * rewrite an existing booking's receivables.
   */
  paymentPlanName: { type: String },
  paymentPlanRows: [{
    sequence: Number,
    label: String,
    percentage: Number,
    dueRule: String,
    dueOffsetDays: Number,
    customerNote: String,
  }],

  /**
   * §39/§324.9: the partner attribution frozen at the moment of sale. A later
   * edit to the partner master must not rewrite the commercial history of a
   * booking that has already been sold.
   */
  channelPartnerId: { type: Schema.Types.ObjectId, ref: 'ChannelPartner', default: null, index: true },
  channelPartnerMemberId: { type: Schema.Types.ObjectId, ref: 'ChannelPartnerMember', default: null },
  partnerLeadClaimId: { type: Schema.Types.ObjectId, ref: 'PartnerLeadClaim', default: null },
  partnerCommissionRuleId: { type: Schema.Types.ObjectId, ref: 'PartnerCommissionRule', default: null },

  // §183: collection ownership is separate from sales credit, always.
  collectionOwnerUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  collectionAssignedAt: { type: Date },
  // §112: operational status, kept apart from the commercial `status` above.
  postBookingStatus: {
    type: String,
    enum: ['BOOKED', 'KYC_PENDING', 'KYC_SUBMITTED', 'KYC_VERIFIED', 'ACTIVE_COLLECTION', 'FULLY_PAID', 'CANCELLED'],
    default: 'BOOKED',
    index: true,
  },
  kycStatus: {
    type: String,
    enum: ['NOT_STARTED', 'PARTIAL', 'SUBMITTED', 'UNDER_REVIEW', 'CORRECTION_REQUIRED', 'VERIFIED'],
    default: 'NOT_STARTED',
    index: true,
  },
  // §108: set once post-booking initialization has run. Makes the job idempotent.
  postBookingInitAt: { type: Date, default: null, index: true },

  // §124: the customer's own confirmation of their data. A data confirmation,
  // deliberately NOT described as an e-signature.
  customerFormSubmittedAt: { type: Date, default: null, index: true },
  customerDeclaration: {
    confirmedAt: { type: Date },
    ip: { type: String },
    userAgent: { type: String },
    formVersion: { type: String },
  },

  /**
   * §242: denormalized collection totals. Every queue, tile and list row reads
   * these instead of scanning installments and receipts.
   *
   * Exactly one writer: services/collections.recalcBooking().
   */
  totalReceivedMinor: { type: Number, default: 0 },
  outstandingMinor: { type: Number, default: 0 },
  nextDueAt: { type: Date, default: null, index: true },
  nextDueAmountMinor: { type: Number, default: 0 },
  overdueMinor: { type: Number, default: 0 },
  overdueDaysMax: { type: Number, default: 0 },
  paymentProgressPct: { type: Number, default: 0 },
  scheduledTotalMinor: { type: Number, default: 0 },
  notes: { type: String, maxlength: 1000 },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  // §87: the saga marks itself complete so a partial run can be finished later.
  sagaComplete: { type: Boolean, default: false, index: true },
}, { timestamps: true });

bookingSchema.plugin(tenantGuard);
bookingSchema.index({ tenantId: 1, bookingDate: -1 });
bookingSchema.index({ tenantId: 1, projectId: 1, status: 1 });
// §240: the collection work queue — one owner's bookings, most urgent due first.
bookingSchema.index({ tenantId: 1, collectionOwnerUserId: 1, nextDueAt: 1 });

module.exports = model('Booking', bookingSchema);
