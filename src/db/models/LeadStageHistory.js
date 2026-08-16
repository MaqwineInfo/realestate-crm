const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * V1.1 §18: entered/exited pairs per stage.
 *
 * The stage funnel (§17.3) must distinguish "actually went through this stage"
 * from "is simply earlier in the list". Activity rows are append-only prose and
 * cannot answer that, so the journey is recorded as its own fact here.
 */
const SOURCE_ACTIONS = [
  'CAPTURE', 'MANUAL_OUTCOME', 'FOLLOWUP_COMPLETE', 'VISIT_SCHEDULED', 'VISIT_COMPLETED',
  'UNIT_BLOCKED', 'BOOKING', 'REOPEN', 'REINQUIRY', 'BLOCK_RELEASED',
];

const leadStageHistorySchema = new Schema({
  leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true, index: true },
  stageId: { type: Schema.Types.ObjectId, ref: 'Stage', required: true },
  subStageId: { type: Schema.Types.ObjectId, ref: 'SubStage' },
  enteredAt: { type: Date, required: true },
  exitedAt: { type: Date, default: null },
  changedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  sourceAction: { type: String, enum: SOURCE_ACTIONS, default: 'MANUAL_OUTCOME' },
  note: { type: String, maxlength: 2000 },
}, { timestamps: true });

leadStageHistorySchema.plugin(tenantGuard);
leadStageHistorySchema.index({ tenantId: 1, leadId: 1, enteredAt: 1 });
// The open row for a lead is the one the next transition has to close.
leadStageHistorySchema.index({ tenantId: 1, leadId: 1, exitedAt: 1 });

module.exports = model('LeadStageHistory', leadStageHistorySchema);
module.exports.SOURCE_ACTIONS = SOURCE_ACTIONS;
