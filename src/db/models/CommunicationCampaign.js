const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * Spec §38: WhatsApp / SMS / Email campaigns to a Contact Book audience.
 * Counters are derived from MessageLog rows, which double as the recipient
 * snapshot taken at send time (§37.3, §38.2).
 */
const communicationCampaignSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  channel: { type: String, enum: ['WHATSAPP', 'SMS', 'EMAIL'], required: true },
  templateId: { type: Schema.Types.ObjectId, ref: 'Template', required: true },
  segmentId: { type: Schema.Types.ObjectId, ref: 'SavedSegment' },
  filters: { type: Schema.Types.Mixed, default: () => ({}) },
  status: {
    type: String,
    enum: ['DRAFT', 'SCHEDULED', 'SENDING', 'SENT', 'PAUSED', 'FAILED', 'CANCELLED'],
    default: 'DRAFT',
    index: true,
  },
  scheduledAt: { type: Date, index: true },
  sentAt: { type: Date },
  // Snapshot counters, written when the send completes.
  recipientCount: { type: Number, default: 0 },
  sentCount: { type: Number, default: 0 },
  failedCount: { type: Number, default: 0 },
  // §102: opted-out contacts are excluded and the count is reported.
  excludedCount: { type: Number, default: 0 },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  sentBy: { type: Schema.Types.ObjectId, ref: 'User' },
  lastError: { type: String },
}, { timestamps: true });

communicationCampaignSchema.plugin(tenantGuard);
communicationCampaignSchema.index({ tenantId: 1, status: 1, createdAt: -1 });

module.exports = model('CommunicationCampaign', communicationCampaignSchema);
