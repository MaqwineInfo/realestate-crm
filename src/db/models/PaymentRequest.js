const { Schema, model } = require('mongoose');
const crypto = require('node:crypto');
const tenantGuard = require('../tenantGuard');

/**
 * V2 §140/§344.26: a payment LINK. Creating one is not a payment, and nothing
 * here ever moves an installment — only a confirmed receipt does that.
 *
 * `status` tracks what the provider tells us. Where a provider cannot report
 * "opened", the field simply stays empty rather than being guessed at (§291).
 */
const STATUSES = ['CREATED', 'SENT', 'OPEN', 'PAID', 'EXPIRED', 'CANCELLED', 'FAILED'];

const paymentRequestSchema = new Schema({
  bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true, index: true },
  installmentId: { type: Schema.Types.ObjectId, ref: 'BookingInstallment', index: true },
  amountMinor: { type: Number, required: true, min: 1 },
  currency: { type: String, default: 'INR' },

  provider: { type: String, required: true },
  driver: { type: String, default: 'mock' },
  integrationId: { type: Schema.Types.ObjectId, ref: 'Integration' },
  providerLinkId: { type: String, index: true },
  paymentUrl: { type: String },
  // Our own hosted page carries a token, hashed for the same reason the
  // customer-link token is (§117).
  tokenHash: { type: String, index: true },

  status: { type: String, enum: STATUSES, default: 'CREATED', index: true },
  expiresAt: { type: Date },
  sharedAt: { type: Date },
  sharedChannel: { type: String, enum: ['WHATSAPP', 'SMS', 'EMAIL', 'COPY'] },
  openedAt: { type: Date },
  paidAt: { type: Date },
  failureReason: { type: String, maxlength: 300 },
  receiptId: { type: Schema.Types.ObjectId, ref: 'BookingReceipt' },
  gatewayPaymentId: { type: String },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

paymentRequestSchema.plugin(tenantGuard);
paymentRequestSchema.index({ tenantId: 1, bookingId: 1, status: 1 });
paymentRequestSchema.index({ tenantId: 1, status: 1, expiresAt: 1 });

paymentRequestSchema.statics.hash = (token) => crypto
  .createHash('sha256').update(String(token)).digest('hex');

module.exports = model('PaymentRequest', paymentRequestSchema);
module.exports.STATUSES = STATUSES;
