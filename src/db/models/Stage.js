const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * Spec §11: stages are tenant-configurable, but `semanticType` (§11.3) keeps the
 * automation working when a tenant renames them. Automation reads the semantic
 * type; users only ever see `name`.
 */
const SEMANTIC_TYPES = [
  'NEW', 'NOT_CONNECTED', 'CONNECTED', 'VISIT_PLANNED', 'VISIT_DONE',
  'BLOCKED', 'BOOKED', 'LOST', 'CUSTOM_ACTIVE', 'CUSTOM_TERMINAL',
];

const stageSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 60 },
  displayOrder: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
  // §10.2: stage config decides whether the lead is Active or Terminal.
  terminal: { type: Boolean, default: false },
  semanticType: { type: String, enum: SEMANTIC_TYPES, default: 'CUSTOM_ACTIVE' },
  colorToken: { type: String, default: 'slate' },
  requiresSubStage: { type: Boolean, default: false },
  // §11.5: active stages require a next action by default; terminal ones must not.
  requiresNextAction: { type: Boolean, default: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

stageSchema.plugin(tenantGuard);
stageSchema.index({ tenantId: 1, name: 1 }, { unique: true });
stageSchema.index({ tenantId: 1, displayOrder: 1 });
stageSchema.index({ tenantId: 1, semanticType: 1 });

module.exports = model('Stage', stageSchema);
module.exports.SEMANTIC_TYPES = SEMANTIC_TYPES;
