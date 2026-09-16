const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');
const enums = require('./enums');

/**
 * A ledger account — the society's chart of accounts.
 *
 * Every bill, maintenance run and penalty posts against one of these, which is
 * what makes the money reports add up. `balanceSheetType` says whether the
 * account is society-wide (COMMON) or belongs to one block, so a block can
 * hold its own sinking fund.
 *
 * Balances are integer paise (SOCIETY-PLAN.md §3.9).
 */
const balanceSheetSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  accountCode: { type: String, trim: true, default: null },
  type: { type: String, enum: enums.balanceSheetAccountType, default: 'INCOME' },
  balanceSheetType: { type: String, enum: enums.balanceSheetType, default: 'COMMON' },
  blockId: { type: Schema.Types.ObjectId, ref: 'SocietyBlock', default: null },

  paymentGatewayId: { type: Schema.Types.ObjectId, default: null },
  onlinePayment: { type: Boolean, default: false },
  /** Whether residents see this account in the app. */
  shareWithUser: { type: Boolean, default: false },

  openingBalanceMinor: { type: Number, default: 0 },
  currentBalanceMinor: { type: Number, default: 0 },

  description: { type: String, trim: true, maxlength: 500, default: null },
  status: { type: String, enum: enums.commonStatus, default: 'ACTIVE' },
  createdBy: { type: Schema.Types.ObjectId, ref: 'SocietyAdmin', default: null },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'SocietyAdmin', default: null },
  deletedBy: { type: Schema.Types.ObjectId, ref: 'SocietyAdmin', default: null },
  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
}, { timestamps: true, collection: 'society_balancesheets' });

balanceSheetSchema.plugin(societyGuard);
balanceSheetSchema.index({ societyId: 1, isDeleted: 1, status: 1 });
balanceSheetSchema.index({ societyId: 1, accountCode: 1 });
balanceSheetSchema.index({ societyId: 1, balanceSheetType: 1, blockId: 1 });

module.exports = model('SocietyBalanceSheet', balanceSheetSchema);
module.exports.MONEY_FIELDS = ['openingBalanceMinor', 'currentBalanceMinor'];
