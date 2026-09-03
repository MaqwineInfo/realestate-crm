const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * Spec §26.1: the project type list, configurable per tenant.
 *
 * The five built-in values stay on `Project.projectType` because reporting and
 * the mini site key off them; `semantic` maps a tenant's own label back to one
 * of those, exactly as Stage does with `semanticType` (§11.3). So a developer
 * can call it "Row House" and everything downstream still knows it is a villa.
 */
const SEMANTICS = ['RESIDENTIAL', 'COMMERCIAL', 'PLOTTING', 'VILLA', 'MIXED_USE'];

const projectTypeSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 60 },
  semantic: { type: String, enum: SEMANTICS, required: true, default: 'RESIDENTIAL' },
  displayOrder: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
  isSystem: { type: Boolean, default: false },
}, { timestamps: true });

projectTypeSchema.plugin(tenantGuard);
projectTypeSchema.index({ tenantId: 1, name: 1 }, { unique: true });

module.exports = model('ProjectType', projectTypeSchema);
module.exports.SEMANTICS = SEMANTICS;
