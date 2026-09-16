const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');

/**
 * A society event, and who registered for it.
 *
 * Internalised from the source's separate `event-services`
 * (SOCIETY-PLAN.md §3.6). The society services reached it over HTTP for exactly
 * two things — listing a society's events and fetching one event's public
 * detail — so only the slice those need is modelled here, not the whole
 * multi-tenant events product (categories, source keys, reminder logs and
 * community events are left where they are).
 *
 * `registrationLimit` with `waitingCount` is why registration is a counter
 * rather than a length: the wait-list opens the moment the count reaches the
 * limit, and both are moved with atomic `$inc` in
 * `services/society/events.js`.
 */
const eventSchema = new Schema({
  title: { type: String, required: true, trim: true },
  description: { type: String, trim: true, default: null },
  eventImage: { type: String, default: null },
  eventType: { type: String, trim: true, default: null },

  eventStart: { type: Date, required: true, index: true },
  eventEnd: { type: Date, default: null },

  venue: { type: String, trim: true, default: null },
  landmark: { type: String, trim: true, default: null },
  area: { type: String, trim: true, default: null },
  pincode: { type: String, trim: true, default: null },

  registrationLimit: { type: Number, default: null, min: 0 },
  registrationCount: { type: Number, default: 0, min: 0 },
  waitingCount: { type: Number, default: 0, min: 0 },
  attendeesCount: { type: Number, default: 0, min: 0 },

  eventLink: { type: String, default: null },
  qrType: { type: String, trim: true, default: null },

  status: { type: String, enum: ['DRAFT', 'PUBLISHED', 'CANCELLED', 'COMPLETED'], default: 'DRAFT', index: true },
  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
  createdBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser', default: null },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser', default: null },
}, { timestamps: true, collection: 'society_events' });

eventSchema.plugin(societyGuard);
eventSchema.index({ societyId: 1, eventStart: -1, isDeleted: 1 });
eventSchema.index({ societyId: 1, status: 1, eventStart: -1 });

module.exports = model('SocietyEvent', eventSchema);
