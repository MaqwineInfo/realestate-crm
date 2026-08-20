const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * V2 §144/§146/§324.5: money received. A receipt is REVERSED, never deleted —
 * no route in this application removes one, and reversal keeps the original
 * row intact with a reason attached.
 */
const STATUSES = ['RECORDED', 'CONFIRMED', 'REVERSED'];
const MODES = ['ONLINE', 'BANK_TRANSFER', 'CHEQUE', 'CASH', 'OTHER'];

const bookingReceiptSchema = new Schema({
  bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true, index: true },
  receiptNo: { type: String, required: true },
  paymentDate: { type: Date, required: true, index: true },
  amountMinor: { type: Number, required: true, min: 1 },
  mode: { type: String, enum: MODES, required: true },
  reference: { type: String, maxlength: 120 },
  bank: { type: String, maxlength: 120 },

  gatewayPaymentId: { type: String, index: true },
  paymentRequestId: { type: Schema.Types.ObjectId, ref: 'PaymentRequest' },
  // Proof of payment is private, like every other customer document (§131).
  proof: {
    storageKey: { type: String },
    fileLabel: { type: String, maxlength: 120 },
    mimeType: { type: String },
    bytes: { type: Number },
  },

  status: { type: String, enum: STATUSES, default: 'CONFIRMED', index: true },
  note: { type: String, maxlength: 500 },
  createdByType: { type: String, enum: ['INTERNAL_USER', 'GATEWAY'], default: 'INTERNAL_USER' },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  reversedAt: { type: Date },
  reversedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  reversalReason: { type: String, maxlength: 500 },
  acknowledgedAt: { type: Date },
}, { timestamps: true });

bookingReceiptSchema.plugin(tenantGuard);
bookingReceiptSchema.index({ tenantId: 1, receiptNo: 1 }, { unique: true });
bookingReceiptSchema.index({ tenantId: 1, bookingId: 1, paymentDate: -1 });

module.exports = model('BookingReceipt', bookingReceiptSchema);
module.exports.STATUSES = STATUSES;
module.exports.MODES = MODES;
