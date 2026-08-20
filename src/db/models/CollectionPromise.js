const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * V2 §158/§159: a promise to pay is a commitment with a date, so it is its own
 * record rather than two fields on the follow-up that completed it — the
 * history of what a customer promised and whether they kept it is the point.
 */
const STATUSES = ['OPEN', 'FULFILLED', 'PARTIAL', 'MISSED', 'CANCELLED'];

const collectionPromiseSchema = new Schema({
  bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true, index: true },
  installmentId: { type: Schema.Types.ObjectId, ref: 'BookingInstallment' },
  promisedAmountMinor: { type: Number, required: true, min: 1 },
  promisedDate: { type: Date, required: true, index: true },
  createdFromFollowUpId: { type: Schema.Types.ObjectId, ref: 'CollectionFollowUp' },
  assignedUserId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
  status: { type: String, enum: STATUSES, default: 'OPEN', index: true },
  /** Received against the booking since the promise was made (§160). */
  fulfilledAmountMinor: { type: Number, default: 0, min: 0 },
  baselineReceivedMinor: { type: Number, default: 0, min: 0 },
  fulfilledAt: { type: Date },
  missedAt: { type: Date },
  note: { type: String, maxlength: 500 },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

collectionPromiseSchema.plugin(tenantGuard);
collectionPromiseSchema.index({ tenantId: 1, status: 1, promisedDate: 1 });

module.exports = model('CollectionPromise', collectionPromiseSchema);
module.exports.STATUSES = STATUSES;
