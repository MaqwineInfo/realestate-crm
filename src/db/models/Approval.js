const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/** Spec §31.2: the decision record. §31.3: approval cannot silently change the ask. */
const approvalSchema = new Schema({
  entity: { type: String, default: 'CostSheet' },
  entityId: { type: Schema.Types.ObjectId, required: true, index: true },
  leadId: { type: Schema.Types.ObjectId, ref: 'Lead', index: true },
  ruleId: { type: Schema.Types.ObjectId, ref: 'ApprovalRule' },
  level: { type: Number, default: 1 },
  // The exact figures that were asked for; an approver may not edit them.
  requestedDiscountMinor: { type: Number, required: true },
  requestedDiscountPercentage: { type: Number, required: true },
  requestedFinalMinor: { type: Number, required: true },
  requestedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  requestedAt: { type: Date, default: Date.now },
  approverUserIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED', 'CHANGE_REQUESTED', 'INVALIDATED'], default: 'PENDING', index: true },
  decidedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  decidedAt: { type: Date },
  decisionNote: { type: String, maxlength: 1000 },
}, { timestamps: true });

approvalSchema.plugin(tenantGuard);
approvalSchema.index({ tenantId: 1, status: 1, requestedAt: -1 });

module.exports = model('Approval', approvalSchema);
