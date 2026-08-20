const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');
const partnerProfile = require('./partnerProfile');

/**
 * V2 §7 + §235: the approved partner.
 *
 * §218: a partner is suspended or expired, never deleted — historical leads,
 * bookings and attribution stay exactly as they were.
 */
const STATUSES = ['ACTIVE', 'SUSPENDED', 'EXPIRED', 'INACTIVE'];

const channelPartnerSchema = new Schema({
  partnerCode: { type: String, index: true },
  profile: { type: partnerProfile, required: true },
  status: { type: String, enum: STATUSES, default: 'ACTIVE', index: true },
  registrationId: { type: Schema.Types.ObjectId, ref: 'ChannelPartnerRegistration' },
  activatedAt: { type: Date },
  suspendedAt: { type: Date },
  suspensionReason: { type: String, maxlength: 500 },

  /**
   * §18/§217: the RERA position, denormalized from the active certificate
   * version so a list can be filtered by expiry without joining. The
   * `PartnerReraDocument` history stays authoritative.
   */
  reraNumber: { type: String, trim: true, index: true },
  reraExpiryDate: { type: Date, index: true },
  reraStatus: { type: String, enum: ['PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED', 'NONE'], default: 'NONE', index: true },
  activeReraDocumentId: { type: Schema.Types.ObjectId, ref: 'PartnerReraDocument' },

  ownerUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  notes: { type: String, maxlength: 2000 },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

channelPartnerSchema.plugin(tenantGuard);
// §238: duplicate detection and the expiry sweep.
channelPartnerSchema.index({ tenantId: 1, 'profile.pan': 1 });
channelPartnerSchema.index({ tenantId: 1, 'profile.gstin': 1 });
channelPartnerSchema.index({ tenantId: 1, 'profile.normalizedMobile': 1 });
channelPartnerSchema.index({ tenantId: 1, reraNumber: 1 });
channelPartnerSchema.index({ tenantId: 1, status: 1, reraExpiryDate: 1 });

/** §218: may this partner submit a new lead at all? */
channelPartnerSchema.methods.canSubmitLeads = function canSubmit() {
  return this.status === 'ACTIVE';
};

module.exports = model('ChannelPartner', channelPartnerSchema);
module.exports.STATUSES = STATUSES;
