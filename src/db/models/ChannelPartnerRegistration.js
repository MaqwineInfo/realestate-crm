const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');
const partnerProfile = require('./partnerProfile');

/**
 * V2 §12–§15 + §186: the application. Kept separate from the approved
 * `ChannelPartner` so a rejected or half-finished application never behaves
 * like an active partner, and so the review trail survives approval.
 */
const STATUSES = [
  'DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'CORRECTION_REQUIRED',
  'APPROVED', 'REJECTED', 'SUSPENDED', 'EXPIRED',
];
const SOURCES = ['INTERNAL', 'INVITE', 'PUBLIC_SELF'];

const channelPartnerRegistrationSchema = new Schema({
  registrationNumber: { type: String, index: true },
  profile: { type: partnerProfile, required: true },
  status: { type: String, enum: STATUSES, default: 'DRAFT', index: true },
  submissionSource: { type: String, enum: SOURCES, default: 'INTERNAL' },

  // §15: the stepper's progress, so a half-finished application can be resumed.
  completedSteps: [{ type: Number }],

  submittedAt: { type: Date },
  reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  reviewedAt: { type: Date },
  reviewNote: { type: String, maxlength: 1000 },
  correctionNote: { type: String, maxlength: 1000 },
  rejectionReason: { type: String, maxlength: 1000 },

  // Set on approval — the partner this application became (§13).
  channelPartnerId: { type: Schema.Types.ObjectId, ref: 'ChannelPartner', index: true },
  approvedAt: { type: Date },
  approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },

  /**
   * §216: possible duplicates found at submission. Never auto-merged — an admin
   * decides, because two partners with one PAN is a commercial dispute, not a
   * data-cleaning task.
   */
  possibleDuplicates: [{
    channelPartnerId: { type: Schema.Types.ObjectId, ref: 'ChannelPartner' },
    registrationId: { type: Schema.Types.ObjectId, ref: 'ChannelPartnerRegistration' },
    matchedOn: [{ type: String }],
  }],
  duplicateDecision: { type: String, enum: ['NOT_A_DUPLICATE', 'MERGED_MANUALLY'], default: undefined },

  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  // §14: an invite link lets a partner fill their own application in.
  inviteTokenHash: { type: String, index: true },
  inviteExpiresAt: { type: Date },
}, { timestamps: true });

channelPartnerRegistrationSchema.plugin(tenantGuard);
// §238: the duplicate-detection reads.
channelPartnerRegistrationSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
channelPartnerRegistrationSchema.index({ tenantId: 1, 'profile.pan': 1 });
channelPartnerRegistrationSchema.index({ tenantId: 1, 'profile.normalizedMobile': 1 });

module.exports = model('ChannelPartnerRegistration', channelPartnerRegistrationSchema);
module.exports.STATUSES = STATUSES;
module.exports.SOURCES = SOURCES;
