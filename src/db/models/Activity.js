const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * Spec §21: the unified timeline. Append-oriented — system events are immutable
 * (§99); only user notes may be edited, and then the `edited` flag is set.
 */
const TYPES = [
  'LEAD_CREATED', 'LEAD_ASSIGNED', 'LEAD_REASSIGNED', 'LEAD_TRANSFERRED', 'REINQUIRY',
  'SLA_WARNING', 'SLA_BREACHED',
  'CALL_STARTED', 'CALL_COMPLETED', 'CALL_INCOMING', 'CALL_MISSED', 'CALL_RECORDING',
  'WHATSAPP_SENT', 'WHATSAPP_RECEIVED', 'SMS_SENT', 'EMAIL_SENT',
  'NOTE_ADDED', 'USER_MENTIONED',
  'FOLLOWUP_CREATED', 'FOLLOWUP_COMPLETED', 'FOLLOWUP_MISSED', 'FOLLOWUP_CANCELLED',
  'STAGE_CHANGED', 'SUBSTAGE_CHANGED',
  'VISIT_SCHEDULED', 'VISIT_RESCHEDULED', 'VISIT_COMPLETED', 'VISIT_CANCELLED', 'VISIT_NO_SHOW',
  'UNIT_SHORTLISTED', 'UNIT_SHORTLIST_REMOVED',
  'COSTSHEET_CREATED', 'DISCOUNT_REQUESTED', 'DISCOUNT_APPROVED', 'DISCOUNT_REJECTED',
  'UNIT_BLOCKED', 'BLOCK_EXPIRY_REMINDER', 'BLOCK_EXPIRED', 'BLOCK_RELEASED',
  'BOOKING_COMPLETED', 'LEAD_LOST', 'LEAD_REOPENED',
  'RESALE_OPPORTUNITY_CREATED', 'RENTAL_OPPORTUNITY_CREATED',
  'AI_SUMMARY_REFRESHED', 'ACKNOWLEDGEMENT_SENT', 'ACKNOWLEDGEMENT_FAILED',
  'NURTURE_STEP_SENT',
  // V1.1 §14.6: a manual temperature pin is a decision, so it belongs on the timeline.
  'TEMPERATURE_CHANGED',
];

const activitySchema = new Schema({
  leadId: { type: Schema.Types.ObjectId, ref: 'Lead', index: true },
  contactId: { type: Schema.Types.ObjectId, ref: 'Contact', index: true },
  type: { type: String, enum: TYPES, required: true },
  actorType: { type: String, enum: ['USER', 'SYSTEM', 'INTEGRATION', 'AI'], default: 'USER' },
  actorUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  actorLabel: { type: String },
  at: { type: Date, default: Date.now, index: true },
  title: { type: String, required: true, maxlength: 250 },
  body: { type: String, maxlength: 5000 },
  meta: { type: Schema.Types.Mixed, default: () => ({}) },
  mentionUserIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  attachments: [{ name: String, url: String, mime: String, size: Number }],
  visibility: { type: String, enum: ['INTERNAL', 'CUSTOMER_VISIBLE'], default: 'INTERNAL' },
  // Only NOTE_ADDED is ever editable (§99).
  editable: { type: Boolean, default: false },
  edited: { type: Boolean, default: false },
}, { timestamps: true });

activitySchema.plugin(tenantGuard);
activitySchema.index({ tenantId: 1, leadId: 1, at: -1 });
activitySchema.index({ tenantId: 1, at: -1 });
activitySchema.index({ tenantId: 1, type: 1, at: -1 });
activitySchema.index({ tenantId: 1, actorUserId: 1, at: -1 });

module.exports = model('Activity', activitySchema);
module.exports.TYPES = TYPES;
