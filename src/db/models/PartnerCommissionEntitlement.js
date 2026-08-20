const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * V2 §42/§43/§206/§324.9: what one booking owes one partner.
 *
 * The rule is SNAPSHOTTED here (§306/§324.9), so editing or deactivating a
 * commission rule tomorrow cannot change what was earned yesterday.
 *
 * The four money figures are kept apart on purpose (§206): accrued is not
 * eligible, eligible is not invoiced, and invoiced is not paid. Management
 * confusing accrued with payable is the exact failure this prevents.
 */
const STATUSES = [
  'ACCRUED', 'NOT_YET_ELIGIBLE', 'ELIGIBLE', 'PARTIALLY_INVOICED', 'INVOICED',
  'PARTIALLY_PAID', 'PAID', 'CANCELLED', 'REVIEW_REQUIRED',
];

const partnerCommissionEntitlementSchema = new Schema({
  bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true, index: true },
  channelPartnerId: { type: Schema.Types.ObjectId, ref: 'ChannelPartner', required: true, index: true },
  channelPartnerMemberId: { type: Schema.Types.ObjectId, ref: 'ChannelPartnerMember' },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', index: true },

  commissionRuleId: { type: Schema.Types.ObjectId, ref: 'PartnerCommissionRule' },
  commissionRuleSnapshot: {
    name: { type: String },
    basis: { type: String },
    rateType: { type: String },
    rate: { type: Number },
    fixedAmountMinor: { type: Number },
    eligibilityTrigger: { type: String },
    collectionThresholdPct: { type: Number },
    description: { type: String },
  },

  commissionBasisAmountMinor: { type: Number, required: true, min: 0 },
  calculatedCommissionMinor: { type: Number, required: true, min: 0 },
  eligibleAmountMinor: { type: Number, default: 0, min: 0 },
  invoicedAmountMinor: { type: Number, default: 0, min: 0 },
  paidAmountMinor: { type: Number, default: 0, min: 0 },

  status: { type: String, enum: STATUSES, default: 'ACCRUED', index: true },
  eligibleAt: { type: Date },
  // §43: what the collection stood at when eligibility was last evaluated.
  collectionPctAtEvaluation: { type: Number, default: 0 },
  // §228: set when a reversal dropped collection below a threshold that had
  // already been invoiced or paid. A human decides; nothing is clawed back.
  reviewReason: { type: String, maxlength: 500 },
  cancelledReason: { type: String, maxlength: 500 },
}, { timestamps: true });

partnerCommissionEntitlementSchema.plugin(tenantGuard);
// One entitlement per booking per partner: §42 is a per-booking accrual.
partnerCommissionEntitlementSchema.index({ tenantId: 1, bookingId: 1, channelPartnerId: 1 }, { unique: true });
partnerCommissionEntitlementSchema.index({ tenantId: 1, channelPartnerId: 1, status: 1 });

/** §48: what an invoice may still claim against this entitlement. */
partnerCommissionEntitlementSchema.virtual('uninvoicedEligibleMinor').get(function uninvoiced() {
  return Math.max(0, (this.eligibleAmountMinor || 0) - (this.invoicedAmountMinor || 0));
});

module.exports = model('PartnerCommissionEntitlement', partnerCommissionEntitlementSchema);
module.exports.STATUSES = STATUSES;
