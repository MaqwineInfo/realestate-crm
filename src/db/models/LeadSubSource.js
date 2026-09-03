const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * Spec §12.1, second level. "Facebook" answers where a lead came from; it does
 * not answer *which* campaign, page or agent — which is the question reporting
 * actually gets asked. Shaped exactly like Stage → SubStage (§11.4) so the
 * setup screen, the capture form and the filters reuse patterns that exist.
 *
 * A sub-source always belongs to exactly one source.
 */
const leadSubSourceSchema = new Schema({
  sourceId: { type: Schema.Types.ObjectId, ref: 'LeadSource', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 80 },
  displayOrder: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
}, { timestamps: true });

leadSubSourceSchema.plugin(tenantGuard);
leadSubSourceSchema.index({ tenantId: 1, sourceId: 1, name: 1 }, { unique: true });

module.exports = model('LeadSubSource', leadSubSourceSchema);
