const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * V2 §18/§217/§324.11: the RERA certificate, versioned.
 *
 * A renewal creates version n+1; the previous certificate is never overwritten,
 * because "what were they registered as in March" is a compliance question with
 * a real answer. The active VERIFIED version is the current one.
 */
const VERIFICATION_STATUSES = ['PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED'];

const partnerReraDocumentSchema = new Schema({
  channelPartnerId: { type: Schema.Types.ObjectId, ref: 'ChannelPartner', index: true },
  registrationId: { type: Schema.Types.ObjectId, ref: 'ChannelPartnerRegistration', index: true },
  channelPartnerMemberId: { type: Schema.Types.ObjectId, ref: 'ChannelPartnerMember' },
  version: { type: Number, required: true, default: 1 },

  authority: { type: String, default: 'GujRERA', trim: true, maxlength: 80 },
  registrationNumber: { type: String, required: true, trim: true, maxlength: 80 },
  reraName: { type: String, trim: true, maxlength: 200 },
  reraType: { type: String, trim: true, maxlength: 80 },
  issueDate: { type: Date },
  expiryDate: { type: Date, index: true },

  // §18: the certificate itself is private, like every other sensitive upload.
  certificate: {
    storageKey: { type: String },
    fileLabel: { type: String, maxlength: 120 },
    mimeType: { type: String },
    bytes: { type: Number },
  },

  verificationStatus: { type: String, enum: VERIFICATION_STATUSES, default: 'PENDING', index: true },
  verificationNote: { type: String, maxlength: 500 },
  verifiedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  verifiedAt: { type: Date },
  active: { type: Boolean, default: true, index: true },
  supersededById: { type: Schema.Types.ObjectId, ref: 'PartnerReraDocument' },
  uploadedByType: { type: String, enum: ['INTERNAL_USER', 'PARTNER'], default: 'INTERNAL_USER' },
  uploadedBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

partnerReraDocumentSchema.plugin(tenantGuard);
partnerReraDocumentSchema.index({ tenantId: 1, channelPartnerId: 1, version: -1 });
// §216: one RERA number cannot belong to two partners.
partnerReraDocumentSchema.index({ tenantId: 1, registrationNumber: 1 });

module.exports = model('PartnerReraDocument', partnerReraDocumentSchema);
module.exports.VERIFICATION_STATUSES = VERIFICATION_STATUSES;
