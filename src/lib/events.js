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
