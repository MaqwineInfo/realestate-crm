const { EVENTS, on } = require('../lib/events');
const notifications = require('./notifications');
const temperature = require('./temperature');

/**
 * Spec §61: notifications and downstream automation subscribe to business
 * events instead of being called from inside the services that cause them.
 * A listener failing can never fail the sale action that emitted the event.
 */
let registered = false;

function register() {
  if (registered) return;
  registered = true;

  // §19: the nurture cadence subscribes to the same lifecycle events.
  require('./nurture').registerListeners();

  on(EVENTS.LEAD_ASSIGNED, async ({ tenantId, lead, ownerUserId, contactName }) => {
    await notifications.notify({
      tenantId,
      userId: ownerUserId,
      type: 'LEAD_ASSIGNED',
      title: 'New lead assigned',
      body: `${contactName} is waiting for a first call.`,
      link: `/app/leads/${lead._id}`,
      leadId: lead._id,
      severity: 'WARNING',
    });
  });

  on(EVENTS.USER_MENTIONED, async ({ tenantId, mentionUserIds, leadId, byName, snippet }) => {
    await notifications.notifyMany({
      tenantId,
      userIds: mentionUserIds,
      type: 'USER_MENTIONED',
      title: `${byName} mentioned you`,
      body: snippet,
      link: `/app/leads/${leadId}`,
      leadId,
    });
  });

  on(EVENTS.LEAD_REINQUIRY_RECEIVED, async ({ tenantId, lead, ownerUserId, contactName }) => {
    await notifications.notify({
      tenantId,
      userId: ownerUserId,
      type: 'REINQUIRY',
      title: 'Re-inquiry received',
      body: `${contactName} has inquired again.`,
      link: `/app/leads/${lead._id}`,
      leadId: lead._id,
      severity: 'WARNING',
    });
  });

  // V1.1 §14.7: everything that changes what a salesperson knows about a lead
  // also changes how hot it is. Recalculation is idempotent and never blocks the
  // action that emitted the event.
  const recalc = (pick) => async (payload) => {
    const leadId = pick(payload);
    if (leadId) await temperature.recalculate({ tenantId: payload.tenantId, leadId });
  };
  const byLeadId = recalc((p) => p.leadId);
  const byLead = recalc((p) => p.lead?._id);

  on(EVENTS.LEAD_FIRST_ACTION_COMPLETED, byLeadId);
  on(EVENTS.LEAD_REINQUIRY_RECEIVED, byLead);
  on(EVENTS.LEAD_STAGE_CHANGED, byLead);
  on(EVENTS.FOLLOWUP_COMPLETED, byLeadId);
  on(EVENTS.VISIT_COMPLETED, byLeadId);
  on(EVENTS.UNIT_SHORTLISTED, byLeadId);
  on(EVENTS.COSTSHEET_CREATED, byLeadId);
  on(EVENTS.UNIT_BLOCKED, byLeadId);
  on(EVENTS.LEAD_SLA_BREACHED, byLead);
  on(EVENTS.UNIT_BLOCK_EXPIRED, async ({ tenantId, blockId }) => {
    const { UnitBlock } = require('../db/models');
    const block = await UnitBlock.findOne({ tenantId, _id: blockId }).select('leadId').lean();
    if (block) await temperature.recalculate({ tenantId, leadId: block.leadId });
  });
}

module.exports = { register };
