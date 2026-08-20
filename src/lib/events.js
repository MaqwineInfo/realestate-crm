const { EventEmitter } = require('node:events');

/**
 * Spec §61: the internal business event model. Services emit, and notifications,
 * audit, nurture and analytics subscribe — nothing calls those directly.
 * Event names are taken verbatim from the spec.
 */
const EVENTS = {
  LEAD_CREATED: 'lead.created',
  LEAD_ASSIGNED: 'lead.assigned',
  LEAD_REINQUIRY_RECEIVED: 'lead.reinquiry_received',
  LEAD_FIRST_ACTION_COMPLETED: 'lead.first_action_completed',
  LEAD_SLA_WARNING: 'lead.sla_warning',
  LEAD_SLA_BREACHED: 'lead.sla_breached',
  LEAD_REASSIGNED: 'lead.reassigned',
  LEAD_STAGE_CHANGED: 'lead.stage_changed',

  FOLLOWUP_CREATED: 'followup.created',
  FOLLOWUP_COMPLETED: 'followup.completed',
  FOLLOWUP_MISSED: 'followup.missed',

  VISIT_CREATED: 'visit.created',
  VISIT_COMPLETED: 'visit.completed',
  VISIT_CANCELLED: 'visit.cancelled',

  UNIT_SHORTLISTED: 'unit.shortlisted',
  UNIT_BLOCKED: 'unit.blocked',
  UNIT_BLOCK_EXPIRING: 'unit.block_expiring',
  UNIT_BLOCK_EXPIRED: 'unit.block_expired',
  UNIT_BOOKED: 'unit.booked',

  COSTSHEET_CREATED: 'costsheet.created',
  DISCOUNT_APPROVAL_REQUESTED: 'discount.approval_requested',
  DISCOUNT_APPROVED: 'discount.approved',
  DISCOUNT_REJECTED: 'discount.rejected',

  BOOKING_CREATED: 'booking.created',

  // V2 §187 — post-booking & collections.
  BOOKING_POST_INITIALIZED: 'booking.post_initialized',
  COLLECTION_INSTALLMENT_DUE: 'collection.installment_due',
  COLLECTION_INSTALLMENT_OVERDUE: 'collection.installment_overdue',
  COLLECTION_FOLLOWUP_DUE: 'collection.followup_due',
  COLLECTION_PROMISE_CREATED: 'collection.promise_created',
  COLLECTION_PROMISE_MISSED: 'collection.promise_missed',
  COLLECTION_PAYMENT_RECEIVED: 'collection.payment_received',
  COLLECTION_BOOKING_FULLY_PAID: 'collection.booking_fully_paid',
  BOOKING_CUSTOMER_LINK_CREATED: 'booking.customer_link_created',
  BOOKING_FORM_SUBMITTED: 'booking.form_submitted',
  BOOKING_KYC_SUBMITTED: 'booking.kyc_submitted',
  BOOKING_KYC_VERIFIED: 'booking.kyc_verified',
  BOOKING_KYC_CORRECTION_REQUIRED: 'booking.kyc_correction_required',
  COLLECTION_PAYMENT_LINK_CREATED: 'collection.payment_link_created',
  COLLECTION_RECEIPT_REVERSED: 'collection.receipt_reversed',

  // V2 §187 — channel partner.
  CP_REGISTRATION_SUBMITTED: 'cp.registration_submitted',
  CP_REGISTRATION_APPROVED: 'cp.registration_approved',
  CP_REGISTRATION_REJECTED: 'cp.registration_rejected',
  CP_RERA_EXPIRING: 'cp.rera_expiring',
  CP_RERA_EXPIRED: 'cp.rera_expired',
  CP_LEAD_SUBMITTED: 'cp.lead_submitted',
  CP_CLAIM_CONFLICT: 'cp.claim_conflict',
  CP_CLAIM_ACCEPTED: 'cp.claim_accepted',
  CP_BOOKING_CREATED: 'cp.booking_created',
  CP_COMMISSION_ELIGIBLE: 'cp.commission_eligible',
  CP_INVOICE_SUBMITTED: 'cp.invoice_submitted',
  CP_INVOICE_APPROVED: 'cp.invoice_approved',
  CP_INVOICE_PAID: 'cp.invoice_paid',

  CAMPAIGN_SENT: 'campaign.sent',
  CAMPAIGN_DELIVERY_UPDATED: 'campaign.delivery_updated',

  CONTACT_TAG_ADDED: 'contact.tag_added',

  RESALE_OPPORTUNITY_DUE: 'resale.opportunity_due',
  RENTAL_OPPORTUNITY_DUE: 'rental.opportunity_due',

  USER_MENTIONED: 'user.mentioned',
  INTEGRATION_FAILED: 'integration.failed',
};

const bus = new EventEmitter();
bus.setMaxListeners(50);

/**
 * Listeners must never break the business action that emitted the event.
 * ponytail: in-process, at-most-once. Move to an outbox collection + worker if
 * this ever runs on more than one node.
 */
function emit(name, payload) {
  setImmediate(() => {
    try {
      bus.emit(name, payload);
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', scope: 'events', event: name, message: err.message }));
    }
  });
}

function on(name, handler) {
  bus.on(name, async (payload) => {
    try {
      await handler(payload);
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', scope: 'event-handler', event: name, message: err.message, stack: err.stack }));
    }
  });
}

module.exports = { EVENTS, emit, on, bus };
