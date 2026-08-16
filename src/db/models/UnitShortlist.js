const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/** Spec §29: one lead may shortlist many units. Removing one never touches inventory. */
const unitShortlistSchema = new Schema({
  leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true, index: true },
  unitId: { type: Schema.Types.ObjectId, ref: 'Unit', required: true, index: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
  rank: { type: Number, default: 0 },
  note: { type: String, maxlength: 500 },
  active: { type: Boolean, default: true },
  shortlistedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  removedAt: { type: Date },
}, { timestamps: true });

unitShortlistSchema.plugin(tenantGuard);
unitShortlistSchema.index({ tenantId: 1, leadId: 1, unitId: 1 }, { unique: true });

module.exports = model('UnitShortlist', unitShortlistSchema);
