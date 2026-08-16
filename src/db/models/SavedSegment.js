const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * Spec §37.3: a saved contact filter for campaign audiences.
 * V1 keeps segments dynamic — they are recalculated at send time — and the
 * campaign stores the recipient snapshot it actually sent to.
 */
const savedSegmentSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  description: { type: String, maxlength: 300 },
  // The §37.2 filter set, stored as submitted.
  filters: { type: Schema.Types.Mixed, default: () => ({}) },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  active: { type: Boolean, default: true },
}, { timestamps: true });

savedSegmentSchema.plugin(tenantGuard);
savedSegmentSchema.index({ tenantId: 1, name: 1 }, { unique: true });

module.exports = model('SavedSegment', savedSegmentSchema);
