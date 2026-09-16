const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');

/**
 * A registration for a society event.
 *
 * Three booleans rather than one status, because they are independent:
 * `isRegistration` (signed up), `isWaiting` (over the limit) and `isAttendees`
 * (actually turned up). Someone can be registered and absent, or wait-listed
 * and admitted at the door.
 *
 * The unique index is what stops a double registration; the source relied on
 * an application check.
 */
const eventUserSchema = new Schema({
  eventId: { type: Schema.Types.ObjectId, ref: 'SocietyEvent', required: true, index: true },
  userId: { type: Schema.Types.ObjectId, ref: 'SocietyUser', index: true },

  firstName: { type: String, trim: true, default: null },
  lastName: { type: String, trim: true, default: null },
  email: { type: String, trim: true, lowercase: true, default: null },
  countryCode: { type: String, default: '+91' },
  phoneNumber: { type: String, trim: true, default: null },
  designation: { type: String, trim: true, default: null },

  unitId: { type: Schema.Types.ObjectId, ref: 'SocietyUnit', default: null },
  unitNumber: { type: String, trim: true, default: null },
  blockId: { type: Schema.Types.ObjectId, ref: 'SocietyBlock', default: null },
  floorId: { type: Schema.Types.ObjectId, ref: 'SocietyFloor', default: null },

  isRegistration: { type: Boolean, default: true },
  isWaiting: { type: Boolean, default: false },
  isAttendees: { type: Boolean, default: false },

  qrCodeImagePath: { type: String, default: null },
  token: { type: String, default: null },

  status: { type: String, enum: ['ACTIVE', 'CANCELLED'], default: 'ACTIVE' },
  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
}, { timestamps: true, collection: 'society_eventusers' });

eventUserSchema.plugin(societyGuard);
eventUserSchema.index(
  { eventId: 1, userId: 1 },
  { unique: true, partialFilterExpression: { userId: { $type: 'objectId' }, isDeleted: false } },
);
eventUserSchema.index({ societyId: 1, eventId: 1, isRegistration: 1 });
eventUserSchema.index({ societyId: 1, eventId: 1, isWaiting: 1 });

module.exports = model('SocietyEventUser', eventUserSchema);
