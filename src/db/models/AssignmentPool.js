const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * Spec §14.1: the round-robin assignment pool. One pool per project where
 * configured, otherwise the organization default pool.
 *
 * `cursor` is advanced by an atomic $inc inside findOneAndUpdate, which is what
 * makes distribution safe under concurrency (§14.2) without a transaction —
 * two simultaneous captures cannot read the same cursor value.
 */
const assignmentPoolSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', default: null, index: true },
  isDefault: { type: Boolean, default: false },
  memberIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  cursor: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
  // §14.3 / §16.1: who hears about unassigned leads and SLA escalations.
  escalationUserIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
}, { timestamps: true });

assignmentPoolSchema.plugin(tenantGuard);
assignmentPoolSchema.index({ tenantId: 1, projectId: 1 });
assignmentPoolSchema.index({ tenantId: 1, isDefault: 1 });

module.exports = model('AssignmentPool', assignmentPoolSchema);
