const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * Spec §19: simple, admin-configurable cadence. Explicitly NOT a no-code
 * workflow canvas (§19, §111) — a trigger, ordered steps, and stop conditions.
 */
const stepSchema = new Schema({
  stepNumber: { type: Number, required: true },
  // Days after the trigger (or after the previous step) that this step fires.
  delayDays: { type: Number, required: true, min: 0 },
  // A step either sends a message or creates a task for the lead owner (§19.4).
  kind: { type: String, enum: ['MESSAGE', 'TASK'], default: 'MESSAGE' },
  channel: { type: String, enum: ['WHATSAPP', 'SMS', 'EMAIL'] },
  templateId: { type: Schema.Types.ObjectId, ref: 'Template' },
  actionTypeId: { type: Schema.Types.ObjectId, ref: 'ActionType' },
  note: { type: String, maxlength: 300 },
  active: { type: Boolean, default: true },
}, { _id: true });

const nurtureSequenceSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', default: null, index: true },
  stageId: { type: Schema.Types.ObjectId, ref: 'Stage', default: null, index: true },
  subStageId: { type: Schema.Types.ObjectId, ref: 'SubStage', default: null },
  tagId: { type: Schema.Types.ObjectId, ref: 'Tag', default: null },
  steps: [stepSchema],
  // §19.3 stop conditions.
  stopOnStageIds: [{ type: Schema.Types.ObjectId, ref: 'Stage' }],
  stopOnBooked: { type: Boolean, default: true },
  stopOnLost: { type: Boolean, default: true },
  active: { type: Boolean, default: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

nurtureSequenceSchema.plugin(tenantGuard);
nurtureSequenceSchema.index({ tenantId: 1, name: 1 }, { unique: true });

module.exports = model('NurtureSequence', nurtureSequenceSchema);
