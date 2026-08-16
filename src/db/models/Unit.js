const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * Spec §27.4 + §28: sales inventory, not ERP inventory.
 *
 * `status` is the contended field in the whole product. Every transition runs as
 * a conditional `findOneAndUpdate` that names the expected current status, which
 * is atomic in MongoDB without a transaction (§32.5, §86, §87).
 */
const STATUSES = ['AVAILABLE', 'HOLD', 'BLOCKED', 'BOOKED', 'REGISTERED', 'NOT_FOR_SALE'];

const unitSchema = new Schema({
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  towerId: { type: Schema.Types.ObjectId, ref: 'Tower', index: true },
  floorId: { type: Schema.Types.ObjectId, ref: 'Floor', index: true },
  unitTypeId: { type: Schema.Types.ObjectId, ref: 'UnitType', index: true },
  unitNumber: { type: String, required: true, trim: true, maxlength: 20 },
  floorNumber: { type: Number },

  carpetArea: { type: Number, min: 0 },
  builtUpArea: { type: Number, min: 0 },
  saleableArea: { type: Number, min: 0 },
  areaUnit: { type: String, default: 'sqft' },

  facing: { type: String, trim: true },
  view: { type: String, trim: true },
  plcCategory: { type: String, trim: true },
  parkingSlots: { type: Number, default: 0 },

  baseRateMinor: { type: Number, min: 0 },
  baseValueOverrideMinor: { type: Number, min: 0 },
  floorRiseMinor: { type: Number, min: 0 },

  status: { type: String, enum: STATUSES, default: 'AVAILABLE', index: true },
  currentBlockId: { type: Schema.Types.ObjectId, ref: 'UnitBlock' },
  currentBookingId: { type: Schema.Types.ObjectId, ref: 'Booking' },
  heldForLeadId: { type: Schema.Types.ObjectId, ref: 'Lead' },

  notes: { type: String, maxlength: 500 },
  active: { type: Boolean, default: true },
}, { timestamps: true });

unitSchema.plugin(tenantGuard);
// §27: unit numbers are unique inside their place in the hierarchy.
unitSchema.index({ tenantId: 1, projectId: 1, towerId: 1, unitNumber: 1 }, { unique: true });
unitSchema.index({ tenantId: 1, status: 1 });
unitSchema.index({ tenantId: 1, projectId: 1, status: 1 });
unitSchema.index({ tenantId: 1, projectId: 1, unitTypeId: 1, status: 1 });

module.exports = model('Unit', unitSchema);
module.exports.STATUSES = STATUSES;
