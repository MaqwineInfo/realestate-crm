const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/** Spec §56: immutable to normal users. No app route ever updates or deletes these. */
const auditLogSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User' },
  userName: { type: String },
  at: { type: Date, default: Date.now, index: true },
  entity: { type: String, required: true },
  entityId: { type: Schema.Types.ObjectId },
  action: { type: String, required: true },
  before: { type: Schema.Types.Mixed },
  after: { type: Schema.Types.Mixed },
  ip: { type: String },
  userAgent: { type: String },
  sessionId: { type: String },
}, { timestamps: { createdAt: true, updatedAt: false } });

auditLogSchema.plugin(tenantGuard);
auditLogSchema.index({ tenantId: 1, entity: 1, entityId: 1, at: -1 });
auditLogSchema.index({ tenantId: 1, at: -1 });

module.exports = model('AuditLog', auditLogSchema);
