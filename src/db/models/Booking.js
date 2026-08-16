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
  notes: { type: String, maxlength: 1000 },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  // §87: the saga marks itself complete so a partial run can be finished later.
  sagaComplete: { type: Boolean, default: false, index: true },
}, { timestamps: true });

bookingSchema.plugin(tenantGuard);
bookingSchema.index({ tenantId: 1, bookingDate: -1 });
bookingSchema.index({ tenantId: 1, projectId: 1, status: 1 });

module.exports = model('Booking', bookingSchema);
