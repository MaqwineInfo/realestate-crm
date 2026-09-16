const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');
const enums = require('./enums');

/**
 * A payment against a unit bill.
 *
 * The one canonical collection the port had to *add* rather than map
 * (SOCIETY-PLAN.md §2.2). The legacy maintenance document carried `paidAmount`,
 * `paidDate`, `paymentMethod` and `transactionId` inline; the canonical
 * `SocietyUnitBill` has a `status` and no payment record at all, so the legacy
 * façade had nowhere to read those from.
 *
 * Kept as its own collection rather than fields on the bill because part
 * payment is real: a resident may settle a bill across several transactions,
 * and a single `paidAmount` cannot say when each arrived or how.
 * `services/society/payments.js` is the only writer, and it flips the bill's
 * status when the outstanding balance reaches zero.
 */
const paymentSchema = new Schema({
  unitBillId: { type: Schema.Types.ObjectId, ref: 'SocietyUnitBill', required: true, index: true },
  unitId: { type: Schema.Types.ObjectId, ref: 'SocietyUnit', required: true, index: true },

  amountMinor: { type: Number, required: true, min: 0 },
  paidDate: { type: Date, required: true, default: Date.now },
  paymentMethod: { type: String, enum: enums.paymentMethod, default: 'Cash' },
  /** Provider reference for online payments; unique when present. */
  transactionId: { type: String, trim: true, default: null },
  notes: { type: String, maxlength: 500, default: null },
  receiptNumber: { type: String, trim: true, default: null },

  recordedBy: { type: Schema.Types.ObjectId, ref: 'SocietyAdmin', default: null },
  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
}, { timestamps: true, collection: 'society_unitbillpayments' });

paymentSchema.plugin(societyGuard);
paymentSchema.index({ societyId: 1, unitBillId: 1, isDeleted: 1 });
paymentSchema.index({ societyId: 1, paidDate: -1 });
/** A gateway retry must not book the same money twice. */
paymentSchema.index(
  { societyId: 1, transactionId: 1 },
  { unique: true, partialFilterExpression: { transactionId: { $type: 'string' } } },
);
/**
 * Partial, not sparse: `sparse` still indexes an explicit `null`, so every
 * document that leaves this unset would collide with the first. See the note
 * on `SocietyMember.userId`.
 */
paymentSchema.index(
  { receiptNumber: 1 },
  { unique: true, partialFilterExpression: { receiptNumber: { $type: 'string' } } },
);

module.exports = model('SocietyUnitBillPayment', paymentSchema);
module.exports.MONEY_FIELDS = ['amountMinor'];
