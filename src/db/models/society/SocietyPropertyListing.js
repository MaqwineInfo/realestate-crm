const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');
const enums = require('./enums');

/**
 * A resident listing their flat to rent or sell, visible to the community.
 * Price is integer paise (SOCIETY-PLAN.md §3.9).
 *
 * Integration seam (§3.10): this is the record that would feed the CRM's
 * `ResaleOpportunity` / `RentalOpportunity` if the two are ever joined.
 */
const propertyListingSchema = new Schema({
  unitId: { type: Schema.Types.ObjectId, ref: 'SocietyUnit', required: true, index: true },
  listedBy: { type: Schema.Types.ObjectId, ref: 'SocietyUnitOccupancy', required: true, index: true },

  type: { type: String, enum: enums.propertyListingType, required: true, index: true },
  priceMinor: { type: Number, required: true },
  negotiable: { type: Boolean, default: false },
  maintenanceIncluded: { type: Boolean, default: false },
  availableFrom: { type: Date, default: Date.now },

  description: { type: String, trim: true },
  photos: { type: [String], default: [] },
  furnishing: { type: String, enum: enums.furnishingStatus, default: 'UNFURNISHED' },

  status: { type: String, enum: enums.propertyListingStatus, default: 'ACTIVE', index: true },
  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
  deletedBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser', default: null },
}, { timestamps: true, collection: 'society_propertylistings' });

propertyListingSchema.plugin(societyGuard);
propertyListingSchema.index({ societyId: 1, type: 1, status: 1, isDeleted: 1 });
propertyListingSchema.index({ societyId: 1, createdAt: -1 });
propertyListingSchema.index({ societyId: 1, listedBy: 1, isDeleted: 1 });

/**
 * One live listing per flat, enforced by the database.
 *
 * The source disagreed with itself here: its unique index was on
 * `{unitId, type}`, which would let a flat be advertised for sale and for rent
 * at the same time, while its controller rejected *any* second active listing
 * on the unit — then caught the resulting duplicate-key error as a "race
 * condition fallback". The controller's rule is the observable behaviour, so it
 * is the one made structural; the check-then-write in front of it is now
 * belt-and-braces rather than the only thing standing between two tabs and two
 * listings.
 */
propertyListingSchema.index(
  { societyId: 1, unitId: 1 },
  { unique: true, partialFilterExpression: { status: 'ACTIVE', isDeleted: false } },
);

module.exports = model('SocietyPropertyListing', propertyListingSchema);
module.exports.MONEY_FIELDS = ['priceMinor'];
