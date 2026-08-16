const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/** Spec §11.4. A sub-stage always belongs to exactly one stage (§52.2). */
const subStageSchema = new Schema({
  stageId: { type: Schema.Types.ObjectId, ref: 'Stage', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 60 },
  displayOrder: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
  defaultActionTypeId: { type: Schema.Types.ObjectId, ref: 'ActionType' },
  defaultFollowupOffsetHours: { type: Number },
  requiresNote: { type: Boolean, default: false },
}, { timestamps: true });

subStageSchema.plugin(tenantGuard);
subStageSchema.index({ tenantId: 1, stageId: 1, name: 1 }, { unique: true });

module.exports = model('SubStage', subStageSchema);
