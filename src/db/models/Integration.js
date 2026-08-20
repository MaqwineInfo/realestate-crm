const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * Spec §49: one record per connected provider. Secrets are stored sealed and
 * never rendered back (§49.1); §97 needs the health fields so Setup can show
 * "Connected / Attention required".
 */
const CATEGORIES = [
  'META_LEAD_ADS', 'GOOGLE_ADS', 'LINKEDIN_ADS', 'PROPERTY_PORTAL', 'WEBSITE_WEBHOOK',
  'WHATSAPP', 'SMS', 'EMAIL', 'TELEPHONY', 'AI',
  // V2 §139: provider-agnostic payment gateway.
  'PAYMENT_GATEWAY',
];

const integrationSchema = new Schema({
  category: { type: String, enum: CATEGORIES, required: true, index: true },
  provider: { type: String, required: true, trim: true },
  name: { type: String, trim: true },
  // Until real credentials exist a mock driver records realistic delivery state.
  driver: { type: String, default: 'mock' },
  status: { type: String, enum: ['CONNECTED', 'ATTENTION_REQUIRED', 'DISABLED'], default: 'CONNECTED', index: true },
  // Inbound webhooks authenticate on this key, not on a session (§63).
  webhookKey: { type: String, index: true },
  secrets: { type: Map, of: String, default: () => new Map() },
  config: { type: Schema.Types.Mixed, default: () => ({}) },
  scopes: [{ type: String }],
  defaultProjectId: { type: Schema.Types.ObjectId, ref: 'Project' },
  defaultSourceId: { type: Schema.Types.ObjectId, ref: 'LeadSource' },
  connectedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  connectedAt: { type: Date },
  lastSyncAt: { type: Date },
  lastSuccessAt: { type: Date },
  lastError: { type: String },
  lastErrorAt: { type: Date },
  failureCount: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
}, { timestamps: true });

integrationSchema.plugin(tenantGuard);
integrationSchema.index({ tenantId: 1, category: 1, provider: 1 });

/** Secrets never leave the server (§49.1). */
integrationSchema.set('toJSON', {
  transform(doc, ret) {
    delete ret.secrets;
    return ret;
  },
});

module.exports = model('Integration', integrationSchema);
module.exports.CATEGORIES = CATEGORIES;
