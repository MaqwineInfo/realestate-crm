const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * Spec §66: outbound and inbound communication metadata. Delivery status lives
 * here (campaign counters in §38.2 are built from it); the human-readable event
 * goes on the timeline. Never stores secrets.
 */
const messageLogSchema = new Schema({
  channel: { type: String, enum: ['WHATSAPP', 'SMS', 'EMAIL'], required: true, index: true },
  direction: { type: String, enum: ['OUT', 'IN'], default: 'OUT' },
  purpose: { type: String, enum: ['ACKNOWLEDGEMENT', 'CAMPAIGN', 'NURTURE', 'MANUAL'], default: 'MANUAL' },
  contactId: { type: Schema.Types.ObjectId, ref: 'Contact', index: true },
  leadId: { type: Schema.Types.ObjectId, ref: 'Lead', index: true },
  campaignId: { type: Schema.Types.ObjectId, ref: 'CommunicationCampaign', index: true },
  templateId: { type: Schema.Types.ObjectId, ref: 'Template' },
  to: { type: String },
  subject: { type: String },
  body: { type: String, maxlength: 4000 },
  status: {
    type: String,
    enum: ['QUEUED', 'SENT', 'DELIVERED', 'READ', 'REPLIED', 'FAILED', 'SKIPPED'],
    default: 'QUEUED',
    index: true,
  },
  skippedReason: { type: String },
  providerMessageId: { type: String, index: true },
  provider: { type: String },
  error: { type: String },
  sentAt: { type: Date },
  deliveredAt: { type: Date },
  readAt: { type: Date },
  sentBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

messageLogSchema.plugin(tenantGuard);
messageLogSchema.index({ tenantId: 1, campaignId: 1, status: 1 });
messageLogSchema.index({ tenantId: 1, contactId: 1, createdAt: -1 });

module.exports = model('MessageLog', messageLogSchema);
