const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');
const enums = require('./enums');

/**
 * A one-off charge raised against some or all units — the *definition*, not the
 * per-unit debt. Publishing one fans out `SocietyUnitBill` rows, which is where
 * a resident's actual liability lives.
 *
 * Three prices because what a unit owes depends on who is in it: an owner, a
 * tenant, or nobody (`priceCloseUnit`, for a vacant flat that still owes a
 * share of common costs).
 *
 * `selectionType` decides the fan-out: ALL units, the units in `blockIds`, or
 * exactly `targetUnitIds`.
 *
 * Money is integer paise (SOCIETY-PLAN.md §3.9); the source used floats, which
 * is how a percentage late fee across four hundred units drifts.
 */
const billSchema = new Schema({
  billCategoryId: { type: Schema.Types.ObjectId, ref: 'SocietyBillCategory', required: true, index: true },
  balanceSheetId: { type: Schema.Types.ObjectId, ref: 'SocietyBalanceSheet', required: true },

  name: { type: String, required: true, trim: true, maxlength: 200 },
  description: { type: String, maxlength: 1000, default: null, trim: true },
  billType: { type: String, default: null, trim: true },

  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  dueDate: { type: Date, required: true },

  priceOwnerMinor: { type: Number, default: 0, min: 0 },
  priceTenantMinor: { type: Number, default: 0, min: 0 },
  priceCloseUnitMinor: { type: Number, default: 0, min: 0 },

  lateFee: { type: Boolean, default: false },
  lateFeeAmountMinor: { type: Number, default: 0, min: 0 },
  lateFeeType: { type: String, enum: ['FIXED', 'PERCENTAGE'], default: 'FIXED' },

  selectionType: { type: String, enum: enums.billSelectionType, default: 'ALL', required: true },
  blockIds: [{ type: Schema.Types.ObjectId, ref: 'SocietyBlock' }],
  targetUnitIds: [{ type: Schema.Types.ObjectId, ref: 'SocietyUnit' }],
  applyToAllUnits: { type: Boolean, default: true },

  publishStatus: { type: String, enum: enums.publishStatus, default: 'DRAFT' },
  publishedAt: { type: Date, default: null },

  status: { type: String, enum: enums.commonStatus, default: 'ACTIVE' },
  createdBy: { type: Schema.Types.ObjectId, ref: 'SocietyAdmin', default: null },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'SocietyAdmin', default: null },
  deletedBy: { type: Schema.Types.ObjectId, ref: 'SocietyAdmin', default: null },
  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
}, { timestamps: true, collection: 'society_bills' });

billSchema.plugin(societyGuard);
billSchema.index({ societyId: 1, isDeleted: 1, publishStatus: 1 });
billSchema.index({ societyId: 1, billCategoryId: 1, isDeleted: 1 });
billSchema.index({ societyId: 1, dueDate: 1 });

module.exports = model('SocietyBill', billSchema);
module.exports.MONEY_FIELDS = [
  'priceOwnerMinor', 'priceTenantMinor', 'priceCloseUnitMinor', 'lateFeeAmountMinor',
];
