const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * V2 §22/§23: a person inside a company partner.
 *
 * §219: an exited member is deactivated, never removed — their historical lead
 * submissions stay under their name and still count in company reporting.
 */
const PORTAL_ROLES = ['COMPANY_ADMIN', 'SALES_MEMBER'];

const channelPartnerMemberSchema = new Schema({
  channelPartnerId: { type: Schema.Types.ObjectId, ref: 'ChannelPartner', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 150 },
  mobile: { type: String, trim: true, maxlength: 20 },
  normalizedMobile: { type: String, trim: true, maxlength: 20 },
  email: { type: String, trim: true, lowercase: true, maxlength: 150 },
  designation: { type: String, trim: true, maxlength: 120 },
  portalRole: { type: String, enum: PORTAL_ROLES, default: 'SALES_MEMBER' },

  // §22: a member may hold their own RERA registration.
  reraNumber: { type: String, trim: true, maxlength: 60 },
  reraDocumentId: { type: Schema.Types.ObjectId, ref: 'PartnerReraDocument' },

  active: { type: Boolean, default: true, index: true },
  canSubmitLeads: { type: Boolean, default: true },
  canViewCompanyLeads: { type: Boolean, default: false },
  canCreateInvoice: { type: Boolean, default: false },
  portalLoginEnabled: { type: Boolean, default: false },
  exitedAt: { type: Date },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

channelPartnerMemberSchema.plugin(tenantGuard);
channelPartnerMemberSchema.index({ tenantId: 1, channelPartnerId: 1, active: 1 });
channelPartnerMemberSchema.index({ tenantId: 1, normalizedMobile: 1 });

module.exports = model('ChannelPartnerMember', channelPartnerMemberSchema);
module.exports.PORTAL_ROLES = PORTAL_ROLES;
