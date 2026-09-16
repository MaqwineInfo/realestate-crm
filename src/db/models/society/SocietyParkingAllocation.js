const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');
const enums = require('./enums');

/**
 * The audit trail of parking: every request, approval, allocation, transfer
 * and release.
 *
 * Kept as a real collection rather than façaded away, because the canonical
 * `SocietyParking` holds only the slot's *current* holder — there is nowhere
 * else to record that unit 402 gave up B-14 in March and took B-02 in April
 * (SOCIETY-PLAN.md §2.2).
 *
 * The location fields are denormalised on purpose: a historical row must still
 * read correctly after the slot is renumbered or the level is renamed.
 */
const parkingAllocationSchema = new Schema({
  slotId: { type: Schema.Types.ObjectId, ref: 'SocietyParking', required: true, index: true },
  levelId: { type: Schema.Types.ObjectId, ref: 'SocietyParkingLevel', index: true },
  societyMemberId: { type: Schema.Types.ObjectId, ref: 'SocietyMember', index: true },
  unitId: { type: Schema.Types.ObjectId, ref: 'SocietyUnit', index: true },
  vehicleId: { type: Schema.Types.ObjectId, ref: 'SocietyVehicle', default: null },

  action: { type: String, enum: enums.PARKING_ALLOCATION_ACTION, required: true },
  allocationStatus: { type: String, enum: [...enums.PARKING_STATUS, null], default: null },
  assignmentType: { type: String, enum: [...enums.PARKING_ASSIGNMENT_TYPE, null], default: null },

  allocatedAt: { type: Date, default: Date.now },
  expectedEndTime: { type: Date, default: null },
  actualEndTime: { type: Date, default: null },
  duration: { type: Number, default: null },

  /** Denormalised so history survives renumbering. */
  slotNumber: { type: Number, default: null },
  levelNumber: { type: Number, default: null },
  section: { type: String, trim: true, default: null },
  floor: { type: String, trim: true, default: null },
  area: { type: String, trim: true, default: null },
  locationAssigned: { type: String, trim: true, default: null },
  locationDetails: { type: String, trim: true, default: null },
  vehicleNumber: { type: String, trim: true, uppercase: true, default: null },
  vehicleType: { type: String, enum: [...enums.VEHICLE_TYPE, null], default: null },

  isReserved: { type: Boolean, default: false },
  isVisitor: { type: Boolean, default: false },

  status: { type: String, enum: enums.commonStatus, default: 'ACTIVE' },
  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
  createdBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser', default: null },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser', default: null },
}, { timestamps: true, collection: 'society_parkingallocations' });

parkingAllocationSchema.plugin(societyGuard);
parkingAllocationSchema.index({ societyId: 1, slotId: 1, createdAt: -1 });
parkingAllocationSchema.index({ societyId: 1, unitId: 1, createdAt: -1 });
parkingAllocationSchema.index({ societyId: 1, action: 1, createdAt: -1 });

module.exports = model('SocietyParkingAllocation', parkingAllocationSchema);
