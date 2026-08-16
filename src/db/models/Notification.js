const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/** Spec §45: V1 ships in-app notifications; email/WhatsApp are opt-in per user. */
const notificationSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: { type: String, required: true },
  title: { type: String, required: true, maxlength: 200 },
  body: { type: String, maxlength: 1000 },
  link: { type: String },
  leadId: { type: Schema.Types.ObjectId, ref: 'Lead' },
  readAt: { type: Date },
  at: { type: Date, default: Date.now },
  severity: { type: String, enum: ['INFO', 'WARNING', 'CRITICAL'], default: 'INFO' },
}, { timestamps: true });

notificationSchema.plugin(tenantGuard);
notificationSchema.index({ tenantId: 1, userId: 1, readAt: 1, at: -1 });

module.exports = model('Notification', notificationSchema);
