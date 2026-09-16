const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');
const enums = require('./enums');

/** Clubhouse, Gym, Party Hall — the amenity categories a society defines. */
const amenityTypeSchema = new Schema({
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
  image: { type: String, trim: true },
  description: { type: String, trim: true, maxlength: 500, default: null },

  status: { type: String, enum: enums.commonStatus, default: 'ACTIVE', index: true },
  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
  createdBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser', default: null },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser', default: null },
}, { timestamps: true, collection: 'society_amenitytypes' });

amenityTypeSchema.plugin(societyGuard);
amenityTypeSchema.index({ societyId: 1, isDeleted: 1 });
amenityTypeSchema.index({ societyId: 1, name: 1 }, { unique: true, partialFilterExpression: { isDeleted: false } });

module.exports = model('SocietyAmenityType', amenityTypeSchema);
