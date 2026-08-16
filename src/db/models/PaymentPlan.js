const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * Spec §34 + V1.1 §35: the sales payment plan.
 *
 * V1.1 makes the schedule structured, because it now appears on the customer's
 * quotation with real amounts against each milestone. It still deliberately does
 * not create receivables, reminders or a ledger (§34.2, §35.4) — this is a sales
 * document, not an accounting one.
 */
const DUE_RULES = ['ON_BOOKING', 'DAYS_AFTER_BOOKING', 'CONSTRUCTION', 'ON_POSSESSION', 'CUSTOM'];

const installmentSchema = new Schema({
  sequence: { type: Number, required: true },
  label: { type: String, required: true, trim: true, maxlength: 120 },
  percentage: { type: Number, min: 0, max: 100, required: true },
  dueRule: { type: String, enum: DUE_RULES, default: 'CONSTRUCTION' },
  dueOffsetDays: { type: Number, min: 0 },
  customerNote: { type: String, maxlength: 300 },
  displayOrder: { type: Number, default: 0 },
  // Legacy V1 rows only carried label/percentage/note.
  note: { type: String },
}, { _id: true });

const paymentPlanSchema = new Schema({
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 80 },
  type: { type: String, enum: ['CONSTRUCTION_LINKED', 'DOWN_PAYMENT', 'FLEXI', 'CUSTOM'], default: 'CUSTOM' },
  description: { type: String, maxlength: 1000 },
  // §35.1: V1 charges the schedule against the final consideration.
  basis: { type: String, enum: ['FINAL_CONSIDERATION'], default: 'FINAL_CONSIDERATION' },
  milestones: [installmentSchema],
  displayOrder: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
}, { timestamps: true });

paymentPlanSchema.plugin(tenantGuard);
paymentPlanSchema.index({ tenantId: 1, projectId: 1, name: 1 }, { unique: true });

/** §35.3: a plan is only "configured" once its percentages add up. */
paymentPlanSchema.virtual('totalPercentage').get(function total() {
  return (this.milestones || []).reduce((sum, m) => sum + (m.percentage || 0), 0);
});

module.exports = model('PaymentPlan', paymentPlanSchema);
module.exports.DUE_RULES = DUE_RULES;
