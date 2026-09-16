const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');
const enums = require('./enums');

/**
 * Versioned terms — society-wide or attached to one amenity.
 *
 * A legacy-only concept kept as a real collection (SOCIETY-PLAN.md §2.2). The
 * canonical `SocietyAmenity.termsAndConditions` is a single free-text field
 * with no version, no cancellation policy and no refund rules, so the legacy
 * booking-terms contract had nowhere to live.
 *
 * `version` matters: a booking made under last year's cancellation policy has
 * to stay governed by it.
 */
const termsAndConditionsSchema = new Schema({
  amenityId: { type: Schema.Types.ObjectId, ref: 'SocietyAmenity', default: null, index: true },

  title: { type: String, trim: true, required: true },
  termsContent: { type: String, default: '' },
  version: { type: Number, default: 1 },
  isMandatory: { type: Boolean, default: false },
  enabled: { type: Boolean, default: true },

  rules: [{
    ruleTitle: { type: String, trim: true },
    ruleDescription: { type: String, trim: true },
  }],
  usageRules: { type: Schema.Types.Mixed, default: null },
  conditions: { type: Schema.Types.Mixed, default: null },

  cancellationPolicy: { type: String, default: null },
  refundPolicy: { type: String, default: null },
  defaultRefundPercentage: { type: Number, min: 0, max: 100, default: 0 },
  securityDepositMinor: { type: Number, min: 0, default: 0 },

  bookingDurationLimits: {
    minimumDuration: { type: Number, min: 0, default: null },
    maximumDuration: { type: Number, min: 0, default: null },
  },

  status: { type: String, enum: enums.commonStatus, default: 'ACTIVE' },
  isActive: { type: Boolean, default: true },
  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
  createdBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser', default: null },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser', default: null },
}, { timestamps: true, collection: 'society_termsandconditions' });

termsAndConditionsSchema.plugin(societyGuard);
termsAndConditionsSchema.index({ societyId: 1, amenityId: 1, isDeleted: 1 });
termsAndConditionsSchema.index({ societyId: 1, amenityId: 1, version: -1 });

module.exports = model('SocietyTermsAndConditions', termsAndConditionsSchema);
module.exports.MONEY_FIELDS = ['securityDepositMinor'];
