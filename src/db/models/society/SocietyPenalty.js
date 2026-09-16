const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');
const enums = require('./enums');

/**
 * A fine levied against a unit — illegal parking, noise, unpaid dues.
 *
 * Carries its own GST breakdown rather than deferring to the bill engine,
 * because a penalty is raised ad hoc by an admin and posted straight to a
 * ledger account. `baseAmount` + `gstAmount` = `totalAmount`, all in integer
 * paise, computed once in `services/society/penalties.js` so the three can
 * never disagree.
 *
 * `photos` are evidence and are public files (they are shown in the app).
 */
const penaltySchema = new Schema({
  unitId: { type: Schema.Types.ObjectId, ref: 'SocietyUnit', required: true },

  description: { type: String, required: true, trim: true },
  penaltyDate: { type: Date, required: true },
  amountMinor: { type: Number, required: true },

  balanceSheet: { type: String, default: '' },
  balanceSheetId: { type: Schema.Types.ObjectId, ref: 'SocietyBalanceSheet' },

  billType: { type: String, enum: ['TAXABLE', 'NON_TAXABLE'], default: 'TAXABLE' },
  gstAmountType: { type: String, enum: ['INCLUDED', 'EXCLUDED'], default: 'INCLUDED' },
  gstType: { type: String, enum: ['CGST_SGST', 'IGST'], default: 'CGST_SGST' },
  taxValue: { type: Number, enum: [0, 5, 12, 18, 28], default: 18 },

  baseAmountMinor: { type: Number, default: 0 },
  gstAmountMinor: { type: Number, default: 0 },
  totalAmountMinor: { type: Number, default: 0 },

  photos: { type: [String], default: [] },
  receiveDate: { type: Date },

  status: { type: String, enum: enums.commonStatus, default: 'ACTIVE' },
  paymentStatus: { type: String, enum: enums.paidStatus, default: 'UNPAID' },

  createdBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser' },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser' },
  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
}, { timestamps: true, collection: 'society_penalties' });

penaltySchema.plugin(societyGuard);
penaltySchema.index({ societyId: 1, isDeleted: 1 });
penaltySchema.index({ societyId: 1, unitId: 1, isDeleted: 1 });
penaltySchema.index({ societyId: 1, paymentStatus: 1, penaltyDate: -1 });

module.exports = model('SocietyPenalty', penaltySchema);
module.exports.MONEY_FIELDS = [
  'amountMinor', 'baseAmountMinor', 'gstAmountMinor', 'totalAmountMinor',
];
