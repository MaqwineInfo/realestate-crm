const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * Spec §17: automatic lead acknowledgement is configured by Project + Source.
 * A null projectId or sourceId means "any", so a tenant can set one blanket
 * rule and override it for a specific campaign source.
 */
const ackRuleSchema = new Schema({
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', default: null, index: true },
  sourceId: { type: Schema.Types.ObjectId, ref: 'LeadSource', default: null, index: true },
  channel: { type: String, enum: ['WHATSAPP', 'SMS', 'EMAIL'], required: true },
  templateId: { type: Schema.Types.ObjectId, ref: 'Template', required: true },
  // §17.1: SMS/email fallback when the preferred channel cannot deliver.
  fallbackChannel: { type: String, enum: ['WHATSAPP', 'SMS', 'EMAIL'] },
  fallbackTemplateId: { type: Schema.Types.ObjectId, ref: 'Template' },
  sendDelayMinutes: { type: Number, default: 0, min: 0 },
  businessHoursOnly: { type: Boolean, default: false },
  active: { type: Boolean, default: true },
  priority: { type: Number, default: 0 },
}, { timestamps: true });

ackRuleSchema.plugin(tenantGuard);
ackRuleSchema.index({ tenantId: 1, projectId: 1, sourceId: 1, active: 1 });

module.exports = model('AckRule', ackRuleSchema);
