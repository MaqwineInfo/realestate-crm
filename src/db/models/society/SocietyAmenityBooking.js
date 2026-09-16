const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');

/**
 * A resident's booking of one or more slots on an amenity for a given date.
 *
 * **Double booking is prevented by an index, not by a check.** The source
 * carried an index literally commented "Double booking prevention - used in
 * transaction" which was not unique — so the guarantee rested entirely on an
 * application-level read inside a MongoDB transaction. This codebase runs
 * against a standalone `mongod` by default, where there are no multi-document
 * transactions (§87), and that check races: two residents tapping Book at the
 * same moment both read "free" and both write.
 *
 * The unique index below is multikey over `slotIds`, so no two live bookings
 * can hold the same slot on the same date for the same amenity — the database
 * rejects the second write whatever the application believed. It is partial on
 * CONFIRMED and not-deleted, so cancelling a booking releases the slot.
 *
 * Money is integer paise (SOCIETY-PLAN.md §3.9). Payment is UPI-first: the
 * society's own UPI id from `Society.upiDetails` builds `upiLink`, the resident
 * pays and uploads a screenshot, and an admin verifies — which is why both
 * `transactionId` and `verifiedBy` exist.
 */
const amenityBookingSchema = new Schema({
  amenityId: { type: Schema.Types.ObjectId, ref: 'SocietyAmenity', required: true },
  slotIds: [{ type: Schema.Types.ObjectId, ref: 'SocietyAmenitySlot', required: true }],
  packageId: { type: Schema.Types.ObjectId, ref: 'SocietyAmenityPackage', default: null },

  memberId: { type: Schema.Types.ObjectId, ref: 'SocietyUnitOccupancy', required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'SocietyUser', required: true },
  unitId: { type: Schema.Types.ObjectId, ref: 'SocietyUnit', required: true },

  bookingDate: { type: Date, required: true },
  status: {
    type: String, enum: ['CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW'], default: 'CONFIRMED',
  },

  pricingType: { type: String, enum: ['FREE', 'PAID'], required: true },
  totalAmountMinor: { type: Number, default: 0, min: 0 },
  baseAmountMinor: { type: Number, default: 0 },
  gstAmountMinor: { type: Number, default: 0 },
  gstPercentage: { type: Number, default: 0 },

  paymentStatus: { type: String, enum: ['PENDING', 'PAID', 'FAILED', 'REFUNDED'], default: 'PENDING' },
  paymentType: { type: String, enum: ['UPI', 'CARD', 'CASH', 'WALLET', 'NET_BANKING', null], default: null },
  paymentId: { type: String, default: null },
  paidAt: { type: Date, default: null },
  upiLink: { type: String, default: null },
  transactionId: { type: String, default: null },
  paymentScreenshot: { type: String, default: null },
  verifiedBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser', default: null },
  verifiedAt: { type: Date, default: null },

  cancelledBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser', default: null },
  cancelledAt: { type: Date, default: null },
  cancellationReason: { type: String, default: null },

  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
}, { timestamps: true, collection: 'society_amenitybookings' });

amenityBookingSchema.plugin(societyGuard);

/** The rule that actually prevents a double booking. See the note above. */
amenityBookingSchema.index(
  { amenityId: 1, bookingDate: 1, slotIds: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'CONFIRMED', isDeleted: false },
    name: 'slot_double_booking_guard',
  },
);
amenityBookingSchema.index(
  { amenityId: 1, bookingDate: 1, status: 1, isDeleted: 1 }, { name: 'availability_check_idx' },
);
amenityBookingSchema.index(
  { userId: 1, societyId: 1, bookingDate: -1, isDeleted: 1 }, { name: 'user_bookings_idx' },
);
amenityBookingSchema.index({ slotIds: 1 }, { name: 'slot_lookup_idx' });
amenityBookingSchema.index(
  { memberId: 1, amenityId: 1, bookingDate: 1, status: 1 }, { name: 'member_booking_check_idx' },
);
amenityBookingSchema.index({ societyId: 1, paymentStatus: 1, bookingDate: -1 });

module.exports = model('SocietyAmenityBooking', amenityBookingSchema);
module.exports.MONEY_FIELDS = ['totalAmountMinor', 'baseAmountMinor', 'gstAmountMinor'];
