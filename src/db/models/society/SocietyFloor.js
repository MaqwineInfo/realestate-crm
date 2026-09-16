const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');
const enums = require('./enums');

/**
 * A floor inside a block. Floor 0 is the ground floor when the society was
 * created with `includeGroundFloor`.
 *
 * `lastUnitSequence` is the atomic allocation counter for generating unit
 * numbers: structure generation bumps it with a conditional update rather than
 * counting existing units, so two concurrent generations cannot mint the same
 * unit number (the same single-document-atomic approach §87 takes elsewhere).
 *
 * `unitNamingPattern` was `unitType` in the source — renamed because it holds
 * "101,102" / "Block+Floor+1,2,3", a naming scheme, not a 2BHK/3BHK unit type.
 */
const floorSchema = new Schema({
  blockId: { type: Schema.Types.ObjectId, ref: 'SocietyBlock', required: true, index: true },

  floorNumber: { type: Number, required: true, min: 0 },
  floorName: {
    type: String,
    trim: true,
    default: function defaultFloorName() {
      return this.floorNumber === 0 ? 'Ground Floor' : `Floor ${this.floorNumber}`;
    },
  },

  totalUnits: { type: Number, default: 0, min: 0 },
  unitNamingPattern: { type: String, enum: [...enums.unitNamingPattern, null], default: null },
  unitsPerFloor: { type: Number, default: 0, min: 0 },
  lastUnitSequence: { type: Number, default: 0 },

  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
  createdBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser', default: null },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser', default: null },
}, { timestamps: true, collection: 'society_floors' });

floorSchema.plugin(societyGuard);
floorSchema.index({ societyId: 1, isDeleted: 1 });
floorSchema.index({ blockId: 1, isDeleted: 1 });
floorSchema.index({ blockId: 1, floorNumber: 1 });
floorSchema.index({ societyId: 1, blockId: 1, floorNumber: 1 }, { unique: true, partialFilterExpression: { isDeleted: false } });

module.exports = model('SocietyFloor', floorSchema);
