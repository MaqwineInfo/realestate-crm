const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * Spec §16.1: response SLA is configurable, never hard-coded, with an optional
 * per-project override. The organization defaults live on Tenant.settings; a
 * row here overrides them for one project.
 *
 * §96: the resolved target is copied onto each lead (`slaTargetSeconds`), so
 * changing a rule later never rewrites the history of leads already measured.
 */
const slaRuleSchema = new Schema({
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', default: null, index: true },
  name: { type: String, trim: true, maxlength: 80 },
  responseMinutes: { type: Number, required: true, min: 1 },
  warningMinutes: { type: Number, required: true, min: 1 },
  escalationMinutes: { type: Number, required: true, min: 1 },
  autoReassignMinutes: { type: Number, min: 1 },
  maxAutoReassignments: { type: Number, default: 2, min: 0 },
  escalationUserIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  businessHoursOnly: { type: Boolean, default: false },
  active: { type: Boolean, default: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

slaRuleSchema.plugin(tenantGuard);
slaRuleSchema.index({ tenantId: 1, projectId: 1, active: 1 });

module.exports = model('SlaRule', slaRuleSchema);
