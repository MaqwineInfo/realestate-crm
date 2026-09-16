const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');
const enums = require('./enums');

/**
 * Rich, rule-based amenity pricing — per time slot, per season, with discounts.
 *
 * A legacy-only concept kept as a real collection (SOCIETY-PLAN.md §2.2): the
 * canonical model prices an amenity through flat `SocietyAmenityPackage` tiers,
 * which cannot express "₹500 an hour on weekday mornings, ₹2000 on a Saturday
 * evening, 10% off for members". Folding this into packages would have silently
 * dropped that from the legacy contract.
 *
 * All amounts are integer paise; percentages are plain numbers.
 */
const amenityPricingSchema = new Schema({
  amenityId: { type: Schema.Types.ObjectId, ref: 'SocietyAmenity', required: true, index: true },

  pricingName: { type: String, trim: true, required: true },
  description: { type: String, trim: true, default: null },
  baseRateMinor: { type: Number, min: 0, default: 0 },
  additionalChargeMinor: { type: Number, min: 0, default: 0 },
  securityDepositMinor: { type: Number, min: 0, default: 0 },

  /** Per-slot overrides, all in paise. */
  timeSlotRates: {
    morning: { type: Number, min: 0, default: null },
    afternoon: { type: Number, min: 0, default: null },
    evening: { type: Number, min: 0, default: null },
    weekend: { type: Number, min: 0, default: null },
    holiday: { type: Number, min: 0, default: null },
  },
  specialDayRates: { type: Schema.Types.Mixed, default: null },
  featurePricing: [{
    featureName: { type: String, trim: true },
    amountMinor: { type: Number, min: 0, default: 0 },
  }],

  memberDiscount: { type: Number, min: 0, max: 100, default: 0 },
  earlyBirdDiscount: { type: Number, min: 0, max: 100, default: 0 },
  longTermDiscount: { type: Number, min: 0, max: 100, default: 0 },
  discountRules: { type: Schema.Types.Mixed, default: null },

  minimumBookingDuration: { type: Number, min: 0, default: null },
  maximumBookingDuration: { type: Number, min: 0, default: null },

  status: { type: String, enum: enums.commonStatus, default: 'ACTIVE' },
  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
  createdBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser', default: null },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser', default: null },
}, { timestamps: true, collection: 'society_amenitypricings' });

amenityPricingSchema.plugin(societyGuard);
amenityPricingSchema.index({ societyId: 1, amenityId: 1, isDeleted: 1 });

module.exports = model('SocietyAmenityPricing', amenityPricingSchema);
module.exports.MONEY_FIELDS = [
  'baseRateMinor', 'additionalChargeMinor', 'securityDepositMinor',
  'timeSlotRates.morning', 'timeSlotRates.afternoon', 'timeSlotRates.evening',
  'timeSlotRates.weekend', 'timeSlotRates.holiday',
  // One amount per feature, inside an array of subdocuments. Declared here
  // like any other money column; `serialize.js` walks the array.
  'featurePricing.amountMinor',
];
