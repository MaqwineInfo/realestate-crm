const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * Spec §11.4. A sub-stage always belongs to exactly one stage (§52.2).
 *
 * A third level (§11.4b) is a sub-stage whose `parentSubStageId` points at
 * another sub-stage of the same stage — a self-reference rather than a second
 * collection, so every existing query, filter and history row keeps working and
 * the tree can deepen again later without another model.
 */
const subStageSchema = new Schema({
  stageId: { type: Schema.Types.ObjectId, ref: 'Stage', required: true, index: true },
  parentSubStageId: { type: Schema.Types.ObjectId, ref: 'SubStage', default: null, index: true },
  name: { type: String, required: true, trim: true, maxlength: 60 },
  displayOrder: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
  defaultActionTypeId: { type: Schema.Types.ObjectId, ref: 'ActionType' },
  defaultFollowupOffsetHours: { type: Number },
  requiresNote: { type: Boolean, default: false },
}, { timestamps: true });

subStageSchema.plugin(tenantGuard);
// Unique per parent, not per stage — "Budget" can sit under two different
// second-level outcomes without colliding.
subStageSchema.index({ tenantId: 1, stageId: 1, parentSubStageId: 1, name: 1 }, { unique: true });

module.exports = model('SubStage', subStageSchema);
