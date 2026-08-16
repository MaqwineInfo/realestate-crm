const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * Spec §31.1: configurable multi-level discount approval by amount or
 * percentage. §95: rules are archived, never deleted, so historical approvals
 * keep their meaning.
 */
const approvalRuleSchema = new Schema({
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', default: null, index: true },
  name: { type: String, trim: true, maxlength: 80 },
  triggerType: { type: String, enum: ['DISCOUNT_PERCENTAGE', 'DISCOUNT_AMOUNT'], required: true },
  minThreshold: { type: Number, required: true, min: 0 },
  maxThreshold: { type: Number },
  level: { type: Number, default: 1, min: 1 },
  sequence: { type: Number, default: 1 },
  approverRoleId: { type: Schema.Types.ObjectId, ref: 'Role' },
  approverUserIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  active: { type: Boolean, default: true },
}, { timestamps: true });

approvalRuleSchema.plugin(tenantGuard);
approvalRuleSchema.index({ tenantId: 1, projectId: 1, triggerType: 1, minThreshold: 1 });

module.exports = model('ApprovalRule', approvalRuleSchema);
