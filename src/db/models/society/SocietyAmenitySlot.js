const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');

/**
 * A bookable time window on an amenity — "06:00–09:00".
 *
 * Times are `HH:mm` strings, not Dates, because a slot is a daily recurring
 * window rather than an instant. `isOvernight` marks a window whose end time is
 * numerically before its start (22:00–02:00); without it, every overlap check
 * would silently treat that slot as negative-length.
 */
const amenitySlotSchema = new Schema({
  amenityId: { type: Schema.Types.ObjectId, ref: 'SocietyAmenity', required: true },

  startTime: { type: String, required: true, match: /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/ },
  endTime: { type: String, required: true, match: /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/ },
  isOvernight: { type: Boolean, default: false },

  status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
  createdBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser', default: null },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser', default: null },
}, { timestamps: true, collection: 'society_amenityslots' });

amenitySlotSchema.plugin(societyGuard);
amenitySlotSchema.index({ amenityId: 1, isDeleted: 1 });
amenitySlotSchema.index(
  { amenityId: 1, startTime: 1, endTime: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } },
);

module.exports = model('SocietyAmenitySlot', amenitySlotSchema);
