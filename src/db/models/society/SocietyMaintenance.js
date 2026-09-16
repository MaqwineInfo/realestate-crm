const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');
const enums = require('./enums');

/**
 * A recurring maintenance charge — the *rule*, not the debt.
 *
 * This is the distinction the legacy service did not make: there, one
 * `maintenances` document was a single unit's bill with payment fields on it.
 * Here the rule lives once and `SocietyUnitBill` rows are generated from it,
 * which is what makes "raise this month's maintenance for 400 units" one write
 * plus a fan-out instead of 400 hand-made documents. The legacy shape is served
 * from the join of the two (SOCIETY-PLAN.md §2.2).
 *
 * `autoGenerate` + `nextRunDate` drive the scheduled run in
 * `jobs/society/maintenanceRun.js`. `lastRunDate` is advanced only after the
 * fan-out completes; a retry is safe because `SocietyUnitBill` has a unique
 * index on (maintenance, unit, period).
 *
 * Three prices, as on `SocietyBill`: owner, tenant, and vacant unit.
 * Money is integer paise (SOCIETY-PLAN.md §3.9).
 */
const maintenanceSchema = new Schema({
  balanceSheetId: { type: Schema.Types.ObjectId, ref: 'SocietyBalanceSheet', default: null },

  title: { type: String, required: true, trim: true, maxlength: 200 },
  description: { type: String, maxlength: 1000, default: null, trim: true },
  maintenanceType: { type: String, enum: enums.maintenanceType, required: true, default: 'FIXED' },
  billType: { type: String, trim: true, default: null },
  amountType: { type: String, enum: enums.maintenanceAmountType, default: 'FIXED' },

  priceOwnerMinor: { type: Number, default: 0, min: 0 },
  priceTenantMinor: { type: Number, default: 0, min: 0 },
  priceCloseUnitMinor: { type: Number, default: 0, min: 0 },

  startDate: { type: Date, default: null },
  endDate: { type: Date, default: null },
  /** MONTH_WISE schedules are expressed as month/year rather than dates. */
  startMonth: { type: Number, min: 1, max: 12, default: null },
  startYear: { type: Number, min: 2000, default: null },
  endMonth: { type: Number, min: 1, max: 12, default: null },
  endYear: { type: Number, min: 2000, default: null },
  dueDate: { type: Date, required: true },

  lateFee: { type: Boolean, default: false },
  lateFeeAmountMinor: { type: Number, default: 0, min: 0 },
  lateFeeType: { type: String, enum: enums.maintenanceLateFeeType, default: 'FIXED' },

  gstType: { type: String, enum: ['CGST_SGST', 'IGST'], default: 'CGST_SGST' },
  gstAmountType: { type: String, enum: ['INCLUDED', 'EXCLUDED'], default: 'EXCLUDED' },
  gstPercentage: { type: Number, default: 0, min: 0, max: 100 },

  autoGenerate: { type: Boolean, default: false },
  nextRunDate: { type: Date, default: null },
  lastRunDate: { type: Date, default: null },

  selectionType: { type: String, enum: enums.billSelectionType, default: 'ALL', required: true },
  blockIds: [{ type: Schema.Types.ObjectId, ref: 'SocietyBlock' }],
  targetUnitIds: [{ type: Schema.Types.ObjectId, ref: 'SocietyUnit' }],
  unitIds: [{ type: Schema.Types.ObjectId, ref: 'SocietyUnit' }],
  applyToAllUnits: { type: Boolean, default: true },

  publishStatus: { type: String, enum: enums.publishStatus, default: 'DRAFT' },
  publishedAt: { type: Date, default: null },

  status: { type: String, enum: enums.commonStatus, default: 'ACTIVE' },
  createdBy: { type: Schema.Types.ObjectId, ref: 'SocietyAdmin', default: null },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'SocietyAdmin', default: null },
  deletedBy: { type: Schema.Types.ObjectId, ref: 'SocietyAdmin', default: null },
  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
}, { timestamps: true, collection: 'society_maintenances' });

maintenanceSchema.plugin(societyGuard);
maintenanceSchema.index({ societyId: 1, isDeleted: 1, publishStatus: 1 });
maintenanceSchema.index({ societyId: 1, maintenanceType: 1, isDeleted: 1 });
maintenanceSchema.index({ societyId: 1, dueDate: 1, isDeleted: 1 });
maintenanceSchema.index({ societyId: 1, autoGenerate: 1, nextRunDate: 1, status: 1 });
maintenanceSchema.index({ societyId: 1, balanceSheetId: 1, isDeleted: 1 });

module.exports = model('SocietyMaintenance', maintenanceSchema);
module.exports.MONEY_FIELDS = [
  'priceOwnerMinor', 'priceTenantMinor', 'priceCloseUnitMinor', 'lateFeeAmountMinor',
];
