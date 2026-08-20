const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * V2 §25/§26/§307: which projects a partner is approved to sell.
 *
 * A partner is not automatically approved for every project. Expiry disables
 * NEW lead submission for that project only — existing leads, bookings and
 * commission continue under the historical agreement (§307).
 */
const STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED', 'EXPIRED'];

const partnerProjectEmpanelmentSchema = new Schema({
  channelPartnerId: { type: Schema.Types.ObjectId, ref: 'ChannelPartner', required: true, index: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  status: { type: String, enum: STATUSES, default: 'PENDING', index: true },
  effectiveFrom: { type: Date },
  effectiveTo: { type: Date },
  commissionRuleId: { type: Schema.Types.ObjectId, ref: 'PartnerCommissionRule' },
  notes: { type: String, maxlength: 1000 },
  approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  approvedAt: { type: Date },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

partnerProjectEmpanelmentSchema.plugin(tenantGuard);
// §238: one row per partner per project.
partnerProjectEmpanelmentSchema.index({ tenantId: 1, channelPartnerId: 1, projectId: 1 }, { unique: true });
partnerProjectEmpanelmentSchema.index({ tenantId: 1, projectId: 1, status: 1 });

/** §26/§307: approved, in date, and not suspended. */
partnerProjectEmpanelmentSchema.methods.isLive = function isLive(now = new Date()) {
  if (this.status !== 'APPROVED') return false;
  if (this.effectiveFrom && this.effectiveFrom > now) return false;
  if (this.effectiveTo && this.effectiveTo < now) return false;
  return true;
};

module.exports = model('PartnerProjectEmpanelment', partnerProjectEmpanelmentSchema);
module.exports.STATUSES = STATUSES;
