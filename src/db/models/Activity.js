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
  /**
   * V2 §162/§189: the post-booking timeline. Same collection, different anchor
   * (`bookingId`) — the lead timeline stays a sales story and is not flooded
   * with collection detail, because every read filters by the anchor it wants.
   */
  'POST_BOOKING_INITIALIZED', 'SCHEDULE_GENERATED', 'COLLECTION_ASSIGNED',
  'COLLECTION_FOLLOWUP_CREATED', 'COLLECTION_FOLLOWUP_COMPLETED', 'COLLECTION_FOLLOWUP_MISSED',
  'PROMISE_CREATED', 'PROMISE_FULFILLED', 'PROMISE_MISSED',
  'INSTALLMENT_DUE', 'INSTALLMENT_OVERDUE', 'INSTALLMENT_PAID', 'INSTALLMENT_DUE_DATE_CHANGED',
  'BOOKING_FULLY_PAID',
  // §296: customer-facing post-booking communications and their outcomes.
  'CUSTOMER_LINK_CREATED', 'CUSTOMER_LINK_SENT', 'CUSTOMER_LINK_REVOKED', 'CUSTOMER_LINK_OPENED',
  'BOOKING_FORM_SUBMITTED', 'BOOKING_FORM_REOPENED', 'BOOKING_FORM_ISSUE_REPORTED',
  'KYC_DOCUMENT_UPLOADED', 'KYC_DOCUMENT_REVIEWED', 'KYC_SUBMITTED', 'KYC_VERIFIED',
  'KYC_CORRECTION_REQUIRED',
  'PAYMENT_LINK_CREATED', 'PAYMENT_LINK_SENT', 'PAYMENT_LINK_CANCELLED',
  'PAYMENT_RECEIVED', 'RECEIPT_REVERSED', 'PAYMENT_REMINDER_SENT',
  /**
   * V2 §189: the channel-partner timeline — registration, compliance, claims,
   * commission and payout. Anchored on `channelPartnerId`, so it is a separate
   * story from the lead's and the booking's.
   */
  'CP_REGISTRATION_SUBMITTED', 'CP_REGISTRATION_REVIEWED', 'CP_REGISTRATION_APPROVED',
  'CP_REGISTRATION_REJECTED', 'CP_PARTNER_ACTIVATED', 'CP_PARTNER_SUSPENDED',
  'CP_RERA_UPLOADED', 'CP_RERA_VERIFIED', 'CP_RERA_EXPIRING', 'CP_RERA_EXPIRED',
  'CP_TEAM_CHANGED', 'CP_PORTAL_INVITED',
  'CP_EMPANELMENT_CHANGED',
  'CP_LEAD_SUBMITTED', 'CP_CLAIM_ACCEPTED', 'CP_CLAIM_REJECTED', 'CP_CLAIM_CONFLICT',
  'CP_COMMISSION_ACCRUED', 'CP_COMMISSION_ELIGIBLE', 'CP_COMMISSION_REVIEW',
  'CP_INVOICE_SUBMITTED', 'CP_INVOICE_REVIEWED', 'CP_INVOICE_APPROVED', 'CP_INVOICE_PAID',
];

const activitySchema = new Schema({
  leadId: { type: Schema.Types.ObjectId, ref: 'Lead', index: true },
  contactId: { type: Schema.Types.ObjectId, ref: 'Contact', index: true },
  bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', index: true },
  channelPartnerId: { type: Schema.Types.ObjectId, ref: 'ChannelPartner', index: true },
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
activitySchema.index({ tenantId: 1, bookingId: 1, at: -1 });
activitySchema.index({ tenantId: 1, channelPartnerId: 1, at: -1 });
activitySchema.index({ tenantId: 1, at: -1 });
activitySchema.index({ tenantId: 1, type: 1, at: -1 });
activitySchema.index({ tenantId: 1, actorUserId: 1, at: -1 });

module.exports = model('Activity', activitySchema);
module.exports.TYPES = TYPES;
