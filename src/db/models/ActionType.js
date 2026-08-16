const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * Spec §18.2: admin-managed follow-up action types.
 * `semantic` lets automation recognise the ones with behaviour attached —
 * SITE_VISIT must link to a real Site Visit entity, not free text (§18.6).
 */
const actionTypeSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 60 },
  semantic: {
    type: String,
    enum: ['CALL', 'WHATSAPP', 'MEETING', 'SITE_VISIT', 'COST_SHEET', 'BROCHURE', 'VIDEO_CALL', 'EMAIL', 'OTHER'],
    default: 'OTHER',
  },
  displayOrder: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
  isSystem: { type: Boolean, default: false },
}, { timestamps: true });

actionTypeSchema.plugin(tenantGuard);
actionTypeSchema.index({ tenantId: 1, name: 1 }, { unique: true });

module.exports = model('ActionType', actionTypeSchema);
