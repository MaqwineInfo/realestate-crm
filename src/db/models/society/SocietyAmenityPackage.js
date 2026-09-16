const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');
const enums = require('./enums');

/**
 * A capacity/price tier on an amenity — "Hall, up to 100 guests, ₹5000".
 * Price is integer paise (SOCIETY-PLAN.md §3.9).
 */
const amenityPackageSchema = new Schema({
  amenityId: { type: Schema.Types.ObjectId, ref: 'SocietyAmenity', required: true },

  name: { type: String, required: true, trim: true, maxlength: 100 },
  description: { type: String, trim: true, maxlength: 500, default: '' },
  capacity: { type: Number, required: true, min: 1 },
  priceMinor: { type: Number, required: true, min: 0, default: 0 },

  status: { type: String, enum: enums.commonStatus, default: 'ACTIVE' },
  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
  createdBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser', default: null },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser', default: null },
}, { timestamps: true, collection: 'society_amenitypackages' });

amenityPackageSchema.plugin(societyGuard);
amenityPackageSchema.index({ amenityId: 1, isDeleted: 1 });
amenityPackageSchema.index({ amenityId: 1, name: 1 }, { unique: true, partialFilterExpression: { isDeleted: false } });

module.exports = model('SocietyAmenityPackage', amenityPackageSchema);
module.exports.MONEY_FIELDS = ['priceMinor'];
