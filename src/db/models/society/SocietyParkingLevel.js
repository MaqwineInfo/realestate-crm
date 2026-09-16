const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');
const enums = require('./enums');

/** A parking floor — Basement 1, Ground, Podium. Holds `SocietyParking` slots. */
const parkingLevelSchema = new Schema({
  levelName: { type: String, required: true, trim: true },
  levelType: { type: String, enum: [...enums.PARKING_LEVEL_TYPE, null], default: null },
  levelNumber: { type: Number, default: null },
  namingType: { type: String, enum: [...enums.PARKING_NAMING_TYPE, null], default: null },
  capacity: { type: Number, default: 0, min: 0 },

  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
  createdBy: { type: Schema.Types.ObjectId, ref: 'SocietyAdmin', default: null },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'SocietyAdmin', default: null },
}, { timestamps: true, collection: 'society_parkinglevels' });

parkingLevelSchema.plugin(societyGuard);
parkingLevelSchema.index({ societyId: 1, isDeleted: 1 });
/**
 * Partial on `isDeleted: false` — the source made this unique outright, which
 * permanently burns a level name the moment the level is soft-deleted.
 */
parkingLevelSchema.index(
  { societyId: 1, levelName: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } },
);

module.exports = model('SocietyParkingLevel', parkingLevelSchema);
