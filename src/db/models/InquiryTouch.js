const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * Spec §40: every inquiry touch is preserved so attribution can be recomputed
 * under either model without losing history. Changing the reporting model must
 * never delete a touch (§40.2).
 */
const inquiryTouchSchema = new Schema({
  contactId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true, index: true },
  leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true, index: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project' },
  sourceId: { type: Schema.Types.ObjectId, ref: 'LeadSource', required: true },
  sourceDetail: { type: String },
  campaignId: { type: Schema.Types.ObjectId, ref: 'MarketingCampaign' },
  externalCampaignId: { type: String },
  adSetExternalId: { type: String },
  adExternalId: { type: String },
  formExternalId: { type: String },
  at: { type: Date, required: true, index: true },
  isFirstTouch: { type: Boolean, default: false },
  landingUrl: { type: String },
  utm: {
    source: String, medium: String, campaign: String, term: String, content: String,
  },
  message: { type: String, maxlength: 2000 },
  webhookEventId: { type: Schema.Types.ObjectId, ref: 'WebhookEvent' },
}, { timestamps: true });

inquiryTouchSchema.plugin(tenantGuard);
inquiryTouchSchema.index({ tenantId: 1, leadId: 1, at: 1 });
inquiryTouchSchema.index({ tenantId: 1, campaignId: 1, at: 1 });
inquiryTouchSchema.index({ tenantId: 1, sourceId: 1, at: 1 });

module.exports = model('InquiryTouch', inquiryTouchSchema);
