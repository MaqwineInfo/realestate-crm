const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');

/**
 * What one unit actually owes — the fanned-out line item.
 *
 * Produced either by publishing a `SocietyBill` (`type: 'BILL'`) or by a
 * maintenance run (`type: 'MAINTENANCE'`), which is why exactly one of `billId`
 * / `maintenanceId` is set.
 *
 * The two unique indexes are what make generation **idempotent**, and they
 * matter more than they look:
 *  - one row per (bill, unit)
 *  - one row per (maintenance, unit, billing period start)
 * A maintenance run is a scheduled job that can be retried after a partial
 * failure; without the second index a retry double-bills every resident it
 * already reached. Both are partial on the id being a real ObjectId so the
 * unused half does not collide on nulls.
 *
 * Money is integer paise (SOCIETY-PLAN.md §3.9).
 */
const unitBillSchema = new Schema({
  billId: { type: Schema.Types.ObjectId, ref: 'SocietyBill', default: null },
  maintenanceId: { type: Schema.Types.ObjectId, ref: 'SocietyMaintenance', default: null },
  type: { type: String, enum: ['BILL', 'MAINTENANCE'], default: 'BILL' },
  unitId: { type: Schema.Types.ObjectId, ref: 'SocietyUnit', required: true },

  amountMinor: { type: Number, required: true, min: 0 },
  baseAmountMinor: { type: Number, default: 0, min: 0 },
  gstAmountMinor: { type: Number, default: 0, min: 0 },
  gstPercentage: { type: Number, default: 0, min: 0, max: 100 },
  gstAmountType: { type: String, enum: ['INCLUDED', 'EXCLUDED', null], default: null },
  /** Kept when a late fee is applied, so the original charge is still legible. */
  originalAmountMinor: { type: Number, default: null },

  status: { type: String, enum: ['PAID', 'UNPAID'], default: 'UNPAID' },
  dueDate: { type: Date, default: null },
  billingPeriod: {
    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null },
  },

  lateFeeConfig: {
    enabled: { type: Boolean, default: false },
    amountMinor: { type: Number, default: 0 },
    type: { type: String, enum: ['FIXED'], default: 'FIXED' },
  },
  lateFeeApplied: { type: Boolean, default: false },
  lateFeeAmountMinor: { type: Number, default: 0, min: 0 },

  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
}, { timestamps: true, collection: 'society_unitbills' });

unitBillSchema.plugin(societyGuard);
unitBillSchema.index(
  { billId: 1, unitId: 1 },
  { unique: true, partialFilterExpression: { billId: { $type: 'objectId' } } },
);
unitBillSchema.index(
  { maintenanceId: 1, unitId: 1, 'billingPeriod.startDate': 1 },
  {
    unique: true,
    partialFilterExpression: {
      maintenanceId: { $type: 'objectId' },
      'billingPeriod.startDate': { $type: 'date' },
    },
    name: 'maintenance_unit_period_unique',
  },
);
unitBillSchema.index({ unitId: 1, status: 1 });
unitBillSchema.index({ societyId: 1, status: 1 });
unitBillSchema.index({ societyId: 1, dueDate: 1, status: 1 });

module.exports = model('SocietyUnitBill', unitBillSchema);
module.exports.MONEY_FIELDS = [
  'amountMinor', 'baseAmountMinor', 'gstAmountMinor', 'originalAmountMinor',
  'lateFeeAmountMinor', 'lateFeeConfig.amountMinor',
];
