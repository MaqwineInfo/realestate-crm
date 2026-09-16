const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');
const enums = require('./enums');

/**
 * A resident's vehicle. The gate matches an arriving number plate against this
 * to tell a resident's car from a visitor's.
 */
const vehicleSchema = new Schema({
  unitId: { type: Schema.Types.ObjectId, ref: 'SocietyUnit', required: true, index: true },
  userId: { type: Schema.Types.ObjectId, ref: 'SocietyUser', required: true, index: true },
  memberId: { type: Schema.Types.ObjectId, ref: 'SocietyMember', index: true, default: null },

  vehicleNumber: { type: String, required: true, uppercase: true, trim: true },
  vehicleType: { type: String, enum: enums.VEHICLE_TYPE, required: true },
  vehicleName: { type: String, trim: true, maxlength: 100 },
  vehicleCategory: { type: String, enum: [...enums.VEHICLE_CATEGORY, null], default: 'MEMBER' },
  vehicleImages: { type: [String], default: [] },

  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
  createdBy: { type: Schema.Types.ObjectId, ref: 'SocietyAdmin', default: null },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'SocietyAdmin', default: null },
}, { timestamps: true, collection: 'society_vehicles' });

vehicleSchema.plugin(societyGuard);
/** Partial on `isDeleted: false`: a sold car's plate must be reusable. */
vehicleSchema.index(
  { societyId: 1, vehicleNumber: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } },
);
vehicleSchema.index({ societyId: 1, isDeleted: 1 });
vehicleSchema.index({ unitId: 1, isDeleted: 1 });
vehicleSchema.index({ userId: 1, isDeleted: 1 });

module.exports = model('SocietyVehicle', vehicleSchema);
