const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/** Spec §24.2: admin-managed site visit outcomes; required on completion (§24.3). */
const visitOutcomeSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 60 },
  displayOrder: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
  // Outcomes that mean the deal is dead let the completion drawer move to Lost.
  isNegative: { type: Boolean, default: false },
}, { timestamps: true });

visitOutcomeSchema.plugin(tenantGuard);
visitOutcomeSchema.index({ tenantId: 1, name: 1 }, { unique: true });

module.exports = model('VisitOutcome', visitOutcomeSchema);
