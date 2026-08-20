const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * V2 §154: collection follow-up is deliberately NOT the sales `Followup`.
 *
 * A sales follow-up chases a decision and ends when the lead closes; this one
 * chases money against a specific installment and ends when the outstanding
 * reaches zero. Same discipline though (§157): completing one while money is
 * still owed requires the next one.
 */
const ACTION_TYPES = ['CALL', 'WHATSAPP', 'EMAIL', 'PAYMENT_LINK', 'MEETING', 'OTHER'];
const STATUSES = ['PENDING', 'COMPLETED', 'MISSED', 'CANCELLED'];
const OUTCOMES = [
  'CONNECTED', 'NO_ANSWER', 'CALL_LATER', 'PROMISE_TO_PAY', 'PAYMENT_LINK_SENT',
  'PARTIAL_PAYMENT', 'PAID', 'DISPUTE', 'OTHER',
];

const collectionFollowUpSchema = new Schema({
  bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true, index: true },
  installmentId: { type: Schema.Types.ObjectId, ref: 'BookingInstallment' },
  contactId: { type: Schema.Types.ObjectId, ref: 'Contact' },
  assignedUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  actionType: { type: String, enum: ACTION_TYPES, required: true },
  dueAt: { type: Date, required: true, index: true },
  status: { type: String, enum: STATUSES, default: 'PENDING', index: true },
  note: { type: String, maxlength: 2000 },

  outcome: { type: String, enum: OUTCOMES },
  completionNote: { type: String, maxlength: 2000 },
  completedAt: { type: Date },
  completedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  completedOnTime: { type: Boolean },
  promiseId: { type: Schema.Types.ObjectId, ref: 'CollectionPromise' },
  nextFollowUpId: { type: Schema.Types.ObjectId, ref: 'CollectionFollowUp' },
  cancelledReason: { type: String, maxlength: 300 },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

collectionFollowUpSchema.plugin(tenantGuard);
// §240: the work-queue read — one user's pending work, soonest first.
collectionFollowUpSchema.index({ tenantId: 1, assignedUserId: 1, status: 1, dueAt: 1 });
collectionFollowUpSchema.index({ tenantId: 1, bookingId: 1, dueAt: -1 });

module.exports = model('CollectionFollowUp', collectionFollowUpSchema);
module.exports.ACTION_TYPES = ACTION_TYPES;
module.exports.STATUSES = STATUSES;
module.exports.OUTCOMES = OUTCOMES;
