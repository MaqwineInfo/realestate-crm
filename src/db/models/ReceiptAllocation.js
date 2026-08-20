const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * V2 §145: which installments a receipt paid, and by how much.
 *
 * `BookingInstallment.amountReceivedMinor` is derived by summing the live
 * allocations for that installment — so a reversal cannot leave a stale figure
 * behind, and there is no second place where "how much was received" is decided.
 *
 * V2 requires full allocation (§145): no unallocated advance, no customer
 * credit ledger. A payment that does not correspond to installments is a
 * finance-system problem, not a CRM one.
 */
const receiptAllocationSchema = new Schema({
  receiptId: { type: Schema.Types.ObjectId, ref: 'BookingReceipt', required: true, index: true },
  bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true, index: true },
  installmentId: { type: Schema.Types.ObjectId, ref: 'BookingInstallment', required: true, index: true },
  amountMinor: { type: Number, required: true, min: 1 },
  // Reversal keeps the row and marks it dead, matching the receipt it belongs to.
  active: { type: Boolean, default: true, index: true },
}, { timestamps: true });

receiptAllocationSchema.plugin(tenantGuard);
receiptAllocationSchema.index({ tenantId: 1, installmentId: 1, active: 1 });

module.exports = model('ReceiptAllocation', receiptAllocationSchema);
