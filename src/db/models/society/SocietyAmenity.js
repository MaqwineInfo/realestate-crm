const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');
const enums = require('./enums');

/**
 * A bookable facility. Collection `amenity` (singular) — the source's naming,
 * kept because the wire contract and the legacy `amenities` collection are
 * different things (SOCIETY-PLAN.md §2.2).
 *
 * Distinct from this codebase's `Amenity` model, which is a checklist label on
 * a sales project ("has a gym") with no booking behaviour at all.
 *
 * Bookable time is not stored here: `SocietyAmenitySlot` holds the windows and
 * `SocietyAmenityPackage` the capacity/price tiers, so a hall can be let by the
 * morning or by the hundred-guest package without either concept bloating this
 * document.
 *
 * `advanceBookingDays` caps how far ahead residents may book.
 */
const amenitySchema = new Schema({
  amenityTypeId: { type: Schema.Types.ObjectId, ref: 'SocietyAmenityType', required: true },

  name: { type: String, required: true, trim: true, maxlength: 100 },
  description: { type: String, required: true, trim: true, maxlength: 2000 },
  photos: [{ type: String, trim: true }],

  pricingType: { type: String, enum: ['FREE', 'PAID'], default: 'FREE' },
  bookingType: { type: String, enum: ['ONE_TIME'], default: 'ONE_TIME' },
  advanceBookingDays: { type: Number, default: 7, min: 1 },
  requiresApproval: { type: Boolean, default: false },
  termsAndConditions: { type: String, trim: true, default: '' },
  calendarColor: { type: String, trim: true, default: '#3B82F6' },

  billType: { type: String, enum: ['TAXABLE', 'NON_TAXABLE'], default: 'TAXABLE' },
  gstAmountType: { type: String, enum: ['INCLUDED', 'EXCLUDED'], default: 'INCLUDED' },
  gstType: { type: String, enum: ['CGST_SGST', 'IGST'], default: 'CGST_SGST' },
  taxValue: { type: Number, enum: [0, 5, 12, 18, 28], default: 18 },

  status: { type: String, enum: enums.commonStatus, default: 'ACTIVE' },
  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
  createdBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser', default: null },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser', default: null },
}, { timestamps: true, collection: 'society_amenity' });

amenitySchema.plugin(societyGuard);
amenitySchema.index({ societyId: 1, isDeleted: 1 });
amenitySchema.index({ societyId: 1, name: 1 }, { unique: true, partialFilterExpression: { isDeleted: false } });
amenitySchema.index({ societyId: 1, amenityTypeId: 1, isDeleted: 1 });

module.exports = model('SocietyAmenity', amenitySchema);
