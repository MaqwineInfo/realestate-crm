const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * Spec §39: ad spend and the funnel it produced. This is the record that lets
 * management stop wasting money on campaigns that generate leads but no
 * bookings (§91, §110.6).
 *
 * The funnel numbers are computed from attributed leads at read time, not
 * stored here — only spend and platform metadata are entered or synced.
 */
const marketingCampaignSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 150 },
  platform: {
    type: String,
    enum: ['META', 'GOOGLE', 'LINKEDIN', 'PROPERTY_PORTAL', 'OFFLINE', 'OTHER'],
    default: 'OTHER',
    index: true,
  },
  externalCampaignId: { type: String, index: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', index: true },
  sourceId: { type: Schema.Types.ObjectId, ref: 'LeadSource' },
  startDate: { type: Date },
  endDate: { type: Date },
  spendMinor: { type: Number, default: 0, min: 0 },
  impressions: { type: Number },
  clicks: { type: Number },
  trackingCode: { type: String, index: true },
  status: { type: String, enum: ['ACTIVE', 'PAUSED', 'COMPLETED'], default: 'ACTIVE' },
  // §105: external data shows when it was last refreshed.
  lastSyncAt: { type: Date },
  isManual: { type: Boolean, default: true },
  notes: { type: String, maxlength: 1000 },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

marketingCampaignSchema.plugin(tenantGuard);
marketingCampaignSchema.index({ tenantId: 1, platform: 1, startDate: -1 });
marketingCampaignSchema.index({ tenantId: 1, externalCampaignId: 1 });

module.exports = model('MarketingCampaign', marketingCampaignSchema);
