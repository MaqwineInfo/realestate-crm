const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * V2 §24: the external partner's login.
 *
 * A deliberately separate account layer from the internal `User` (§23: "Do not
 * reuse internal CRM role permissions for Partner Portal"). A partner session
 * can never resolve an internal route, because internal authorization reads
 * `req.user` and this identity never sets it.
 */
const STATUSES = ['INVITED', 'ACTIVE', 'SUSPENDED', 'INACTIVE'];
const ROLES = ['COMPANY_ADMIN', 'SALES_MEMBER'];

const partnerPortalUserSchema = new Schema({
  channelPartnerId: { type: Schema.Types.ObjectId, ref: 'ChannelPartner', required: true, index: true },
  channelPartnerMemberId: { type: Schema.Types.ObjectId, ref: 'ChannelPartnerMember', index: true },
  name: { type: String, required: true, trim: true, maxlength: 150 },
  email: { type: String, trim: true, lowercase: true, maxlength: 150 },
  mobile: { type: String, trim: true, maxlength: 20 },
  normalizedMobile: { type: String, trim: true, maxlength: 20 },
  passwordHash: { type: String },
  role: { type: String, enum: ROLES, default: 'SALES_MEMBER' },
  status: { type: String, enum: STATUSES, default: 'INVITED', index: true },

  // Activation / reset, hashed like every other token in this codebase.
  inviteTokenHash: { type: String, index: true },
  inviteExpiresAt: { type: Date },
  lastLoginAt: { type: Date },
  failedLoginCount: { type: Number, default: 0 },
  lockedUntil: { type: Date },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

partnerPortalUserSchema.plugin(tenantGuard);
// One login per email per tenant; a partner staffer is not two accounts.
partnerPortalUserSchema.index({ tenantId: 1, email: 1 }, { unique: true, sparse: true });
partnerPortalUserSchema.index({ tenantId: 1, channelPartnerId: 1, status: 1 });

module.exports = model('PartnerPortalUser', partnerPortalUserSchema);
module.exports.STATUSES = STATUSES;
module.exports.ROLES = ROLES;
