const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * Spec §18: the heart of the CRM.
 *
 * `nextFollowupId` is the proof of the non-negotiable rule (§55.2): an active
 * lead's completed follow-up must point at the follow-up that replaced it.
 * §18.5: MISSED is derived from `dueAt < now` for display and reconciled to a
 * stored status by the scheduler so reporting is deterministic.
 */
const followupSchema = new Schema({
  leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true, index: true },
  contactId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
  actionTypeId: { type: Schema.Types.ObjectId, ref: 'ActionType', required: true },
  dueAt: { type: Date, required: true, index: true },
  assignedUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  status: {
    type: String,
    enum: ['PENDING', 'COMPLETED', 'CANCELLED', 'MISSED'],
    default: 'PENDING',
    index: true,
  },
  priority: { type: String, enum: ['LOW', 'NORMAL', 'HIGH'], default: 'NORMAL' },
  note: { type: String, maxlength: 2000 },
  siteVisitId: { type: Schema.Types.ObjectId, ref: 'SiteVisit' },
  completedAt: { type: Date },
  completedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  completionOutcome: { type: String },
  completionSubStageId: { type: Schema.Types.ObjectId, ref: 'SubStage' },
  completionNote: { type: String, maxlength: 2000 },
  nextFollowupId: { type: Schema.Types.ObjectId, ref: 'Followup' },
  // True when this follow-up was on time relative to its due date (§92).
  completedOnTime: { type: Boolean },
  cancelledReason: { type: String },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  createdVia: { type: String, default: 'MANUAL' },
}, { timestamps: true });

followupSchema.plugin(tenantGuard);
// Work queues: today's follow-ups and missed follow-ups per user (§8.2).
followupSchema.index({ tenantId: 1, assignedUserId: 1, status: 1, dueAt: 1 });
followupSchema.index({ tenantId: 1, status: 1, dueAt: 1 });
followupSchema.index({ tenantId: 1, leadId: 1, status: 1 });

module.exports = model('Followup', followupSchema);
