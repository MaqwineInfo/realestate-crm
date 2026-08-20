const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/** Spec §12.1: tenant-maintained source names over fixed system categories. */
const CATEGORIES = [
  'META', 'GOOGLE', 'LINKEDIN', 'PROPERTY_PORTAL', 'WEBSITE', 'LANDING_PAGE',
  'IVR', 'WHATSAPP', 'CHATBOT', 'QR', 'WALK_IN', 'REFERRAL', 'MANUAL', 'API',
  // V2 §33: how the inquiry arrived when a channel partner submitted it. This is
  // the marketing-source dimension; the partner itself is recorded separately on
  // the lead, because a lead can have both a campaign and a partner.
  'CHANNEL_PARTNER',
  'OTHER',
];

const leadSourceSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  category: { type: String, enum: CATEGORIES, default: 'OTHER', index: true },
  active: { type: Boolean, default: true },
  isSystem: { type: Boolean, default: false },
  displayOrder: { type: Number, default: 0 },
}, { timestamps: true });

leadSourceSchema.plugin(tenantGuard);
leadSourceSchema.index({ tenantId: 1, name: 1 }, { unique: true });

module.exports = model('LeadSource', leadSourceSchema);
module.exports.CATEGORIES = CATEGORIES;
