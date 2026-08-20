const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * V2 §40/§41: how much a partner earns, and when it becomes payable.
 *
 * Scope resolution is most-specific-wins (§40): a rule naming this partner AND
 * this project beats one naming only the project, which beats an organization
 * default. §306: a rule change applies to future bookings — an existing
 * booking keeps the snapshot it was sold under.
 */
const BASES = ['FINAL_BOOKING_PRICE', 'BASE_VALUE', 'FIXED_AMOUNT'];
const RATE_TYPES = ['PERCENTAGE', 'FIXED'];
const TRIGGERS = ['ON_BOOKING', 'ON_TOKEN_RECEIVED', 'ON_COLLECTION_PERCENT', 'ON_FULL_PAYMENT', 'MANUAL'];

const partnerCommissionRuleSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', default: null, index: true },
  channelPartnerId: { type: Schema.Types.ObjectId, ref: 'ChannelPartner', default: null, index: true },
  // A rule may target a whole partner type rather than one partner (§40).
  partnerType: { type: String, enum: ['COMPANY', 'INDIVIDUAL'], default: null },

  basis: { type: String, enum: BASES, default: 'FINAL_BOOKING_PRICE' },
  rateType: { type: String, enum: RATE_TYPES, default: 'PERCENTAGE' },
  rate: { type: Number, required: true, min: 0 },
  fixedAmountMinor: { type: Number, min: 0 },

  eligibilityTrigger: { type: String, enum: TRIGGERS, default: 'ON_BOOKING' },
  collectionThresholdPct: { type: Number, min: 0, max: 100 },

  effectiveFrom: { type: Date },
  effectiveTo: { type: Date },
  active: { type: Boolean, default: true, index: true },
  notes: { type: String, maxlength: 1000 },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

partnerCommissionRuleSchema.plugin(tenantGuard);
partnerCommissionRuleSchema.index({ tenantId: 1, active: 1, projectId: 1, channelPartnerId: 1 });

/**
 * §40: how specific this rule is. Higher wins. Partner+project is the most
 * specific thing a tenant can express in this version.
 */
partnerCommissionRuleSchema.virtual('specificity').get(function specificity() {
  return (this.channelPartnerId ? 4 : 0) + (this.projectId ? 2 : 0) + (this.partnerType ? 1 : 0);
});

/** A human-readable summary, used on the booking's CP card (§227). */
partnerCommissionRuleSchema.methods.describe = function describe() {
  const amount = this.rateType === 'PERCENTAGE' ? `${this.rate}%` : 'a fixed amount';
  if (this.eligibilityTrigger === 'ON_COLLECTION_PERCENT') {
    return `${amount} after ${this.collectionThresholdPct}% collection`;
  }
  const when = {
    ON_BOOKING: 'on booking',
    ON_TOKEN_RECEIVED: 'once the token is received',
    ON_FULL_PAYMENT: 'on full payment',
    MANUAL: 'on manual release',
  }[this.eligibilityTrigger];
  return `${amount} ${when}`;
};

module.exports = model('PartnerCommissionRule', partnerCommissionRuleSchema);
module.exports.BASES = BASES;
module.exports.RATE_TYPES = RATE_TYPES;
module.exports.TRIGGERS = TRIGGERS;
