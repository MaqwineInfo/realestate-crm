const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * V2 §50/§344.14: operational payout tracking. Deliberately NOT an accounting
 * ledger — it records that money left, with its reference, so the CP team can
 * answer "has ABC Realty been paid" without opening the finance system.
 *
 * Deduction is informational (§50, §272): nothing here computes TDS.
 */
const payoutSchema = new Schema({
  channelPartnerId: { type: Schema.Types.ObjectId, ref: 'ChannelPartner', required: true, index: true },
  partnerInvoiceId: { type: Schema.Types.ObjectId, ref: 'PartnerInvoice', required: true, index: true },
  payoutDate: { type: Date, required: true },
  amountMinor: { type: Number, required: true, min: 1 },
  transactionReference: { type: String, trim: true, maxlength: 120 },
  deductionMinor: { type: Number, default: 0, min: 0 },
  deductionNote: { type: String, maxlength: 300 },
  note: { type: String, maxlength: 500 },
  enteredBy: { type: Schema.Types.ObjectId, ref: 'User' },
  reversedAt: { type: Date },
  reversalReason: { type: String, maxlength: 500 },
}, { timestamps: true });

payoutSchema.plugin(tenantGuard);
payoutSchema.index({ tenantId: 1, channelPartnerId: 1, payoutDate: -1 });

module.exports = model('PartnerPayout', payoutSchema);
