const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * V2 §34/§35/§324.8: a partner's claim on a customer.
 *
 * The claim is a separate record from the lead precisely so a disputed
 * submission can be reviewed without touching the lead's owner or its
 * marketing source. A CONFLICT claim changes nothing until a human decides.
 */
const STATUSES = ['PENDING', 'ACCEPTED', 'REJECTED', 'CONFLICT', 'EXPIRED'];
const CONFLICT_REASONS = [
  'ANOTHER_PARTNER_ACTIVE', 'DIRECT_LEAD_ACTIVE', 'PROJECT_NOT_EMPANELLED',
  'PARTNER_NOT_ACTIVE', 'RERA_INVALID', 'OTHER',
];

const partnerLeadClaimSchema = new Schema({
  claimNumber: { type: String, index: true },
  channelPartnerId: { type: Schema.Types.ObjectId, ref: 'ChannelPartner', required: true, index: true },
  channelPartnerMemberId: { type: Schema.Types.ObjectId, ref: 'ChannelPartnerMember' },
  contactId: { type: Schema.Types.ObjectId, ref: 'Contact', index: true },
  leadId: { type: Schema.Types.ObjectId, ref: 'Lead', index: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', index: true },

  submittedAt: { type: Date, default: Date.now, index: true },
  submittedMobile: { type: String, trim: true, maxlength: 20 },
  submittedName: { type: String, trim: true, maxlength: 150 },
  status: { type: String, enum: STATUSES, default: 'PENDING', index: true },
  conflictReason: { type: String, enum: CONFLICT_REASONS },
  conflictNote: { type: String, maxlength: 500 },

  /** What the situation looked like when the claim was made (§36). */
  existingLeadId: { type: Schema.Types.ObjectId, ref: 'Lead' },
  existingOwnerUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  existingSourceId: { type: Schema.Types.ObjectId, ref: 'LeadSource' },
  existingChannelPartnerId: { type: Schema.Types.ObjectId, ref: 'ChannelPartner' },

  reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  reviewedAt: { type: Date },
  reviewNote: { type: String, maxlength: 500 },
  // §35: how long this partner's association is protected from another claim.
  protectionUntil: { type: Date, index: true },
  note: { type: String, maxlength: 1000 },
  requirement: { type: Schema.Types.Mixed },
}, { timestamps: true });

partnerLeadClaimSchema.plugin(tenantGuard);
// §238: the review queue and the protection lookup.
partnerLeadClaimSchema.index({ tenantId: 1, status: 1, submittedAt: -1 });
partnerLeadClaimSchema.index({ tenantId: 1, channelPartnerId: 1, status: 1 });
partnerLeadClaimSchema.index({ tenantId: 1, contactId: 1, projectId: 1, status: 1 });

module.exports = model('PartnerLeadClaim', partnerLeadClaimSchema);
module.exports.STATUSES = STATUSES;
module.exports.CONFLICT_REASONS = CONFLICT_REASONS;
