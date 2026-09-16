const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');
const enums = require('./enums');

/**
 * One parking slot, and who currently holds it.
 *
 * This document is the *current* state only. The allocation history — who had
 * it before, when it was requested, approved, transferred or released — lives
 * in `SocietyParkingAllocation`, which is why that legacy collection survived
 * the façade (SOCIETY-PLAN.md §2.2) instead of being folded in here.
 *
 * `status` is the contended field: allocation must be a single conditional
 * `findOneAndUpdate` naming the expected current status, which is atomic in
 * MongoDB without a transaction (§87) — the same discipline `Unit.status` uses
 * on the sales side.
 *
 * The physical-location fields (`slotType`, `section`, `floor`, `area`,
 * `coordinates`, `hasEVCharging`) absorb the legacy `parkingslots` shape.
 */
const parkingSchema = new Schema({
  parkingLevelId: { type: Schema.Types.ObjectId, ref: 'SocietyParkingLevel', required: true, index: true },
  slotNumber: { type: Number, required: true, index: true },

  status: { type: String, enum: enums.PARKING_STATUS, default: 'AVAILABLE', index: true },
  unitId: { type: Schema.Types.ObjectId, ref: 'SocietyUnit', default: null, index: true },
  assignedAt: { type: Date, default: null },
  requestedBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser', default: null },

  slotType: { type: String, enum: [...enums.PARKING_SLOT_TYPE, null], default: null },
  ownershipType: { type: String, enum: [...enums.PARKING_OWNERSHIP_TYPE, null], default: null },
  section: { type: String, trim: true, default: null },
  floor: { type: String, trim: true, default: null },
  area: { type: String, trim: true, default: null },
  locationDetails: { type: String, trim: true, default: null },
  coordinates: { type: Schema.Types.Mixed, default: null },
  hasEVCharging: { type: Boolean, default: false },

  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
  createdBy: { type: Schema.Types.ObjectId, ref: 'SocietyAdmin', default: null },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'SocietyAdmin', default: null },
}, { timestamps: true, collection: 'society_parkings' });

parkingSchema.plugin(societyGuard);
/**
 * The source had no uniqueness on slot number at all, so a level could hold two
 * "Slot 12"s and an allocation could not say which one it meant.
 */
parkingSchema.index(
  { parkingLevelId: 1, slotNumber: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } },
);
parkingSchema.index({ societyId: 1, isDeleted: 1 });
parkingSchema.index({ parkingLevelId: 1, status: 1 });
parkingSchema.index({ societyId: 1, status: 1, isDeleted: 1 });
parkingSchema.index({ status: 1, requestedBy: 1 });
parkingSchema.index({ societyId: 1, unitId: 1, isDeleted: 1 });

module.exports = model('SocietyParking', parkingSchema);
