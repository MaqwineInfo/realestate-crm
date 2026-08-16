const { Lead, SlaRule, Tenant, Contact, AssignmentPool } = require('../db/models');
const businessHours = require('../lib/businessHours');
const { EVENTS, emit } = require('../lib/events');
const timeline = require('./timeline');
const notifications = require('./notifications');
const distribution = require('./distribution');

/**
 * Spec §16: lead response SLA is an operational capability, not a report
 * (§110.2). This service resolves the applicable rule, evaluates where a lead
 * stands, and drives warn → escalate → auto-reassign from the scheduler.
 *
 * The clock stops only on a genuine first action plus a next action, which is
 * recorded by the follow-up engine (§16.2, §55.3) — never by a click.
 */

/** §16.1: project override first, organization default second. */
async function resolveRule({ tenantId, tenant, projectId }) {
  if (projectId) {
    const override = await SlaRule.findOne({ tenantId, projectId, active: true }).lean();
    if (override) return normalize(override, tenant);
  }
  const orgRule = await SlaRule.findOne({ tenantId, projectId: null, active: true }).lean();
  if (orgRule) return normalize(orgRule, tenant);

  const s = (tenant || await Tenant.findById(tenantId).lean()).settings;
  return normalize({
    responseMinutes: s.slaResponseMinutes,
    warningMinutes: s.slaWarningMinutes,
    escalationMinutes: s.slaEscalationMinutes,
    autoReassignMinutes: s.slaAutoReassignMinutes,
    maxAutoReassignments: s.slaMaxAutoReassignments,
    businessHoursOnly: s.slaBusinessHoursOnly,
    escalationUserIds: [],
  }, tenant);
}

function normalize(rule, tenant) {
  return {
    ...rule,
    targetSeconds: rule.responseMinutes * 60,
    warningSeconds: rule.warningMinutes * 60,
    escalationSeconds: rule.escalationMinutes * 60,
    reassignSeconds: rule.autoReassignMinutes ? rule.autoReassignMinutes * 60 : null,
    businessHours: rule.businessHoursOnly ? (tenant?.settings?.businessHours || null) : null,
  };
}

/** Seconds a lead has been waiting, honouring the business-hours setting (§72). */
function waitedSeconds({ lead, rule, tenant, now = new Date() }) {
  const from = lead.assignedAt || lead.capturedAt;
  return businessHours.elapsedSeconds(from, now, tenant?.timezone || 'UTC', rule.businessHours);
}

/** §16.3: pure state calculation — no writes, so it is safe to call from views. */
function evaluate({ lead, rule, tenant, now = new Date() }) {
  if (lead.firstGenuineActionAt) {
    return { status: lead.slaBreached ? 'BREACHED' : 'WITHIN_SLA', seconds: lead.firstResponseSeconds, done: true };
  }
  const seconds = waitedSeconds({ lead, rule, tenant, now });
  let status = 'PENDING';
  if (seconds >= rule.escalationSeconds) status = 'BREACHED';
  else if (seconds >= rule.warningSeconds) status = 'AT_RISK';

  return {
    seconds,
    status,
    done: false,
    needsWarning: seconds >= rule.warningSeconds && !lead.slaWarningSentAt,
    needsEscalation: seconds >= rule.escalationSeconds && !lead.slaEscalatedAt,
    needsReassign: !!rule.reassignSeconds
      && seconds >= rule.reassignSeconds
      && (lead.reassignmentCount || 0) < rule.maxAutoReassignments,
  };
}

/** Stamps the resolved target on the lead so later rule edits cannot rewrite it (§96). */
async function startClock({ tenantId, tenant, lead }) {
  const rule = await resolveRule({ tenantId, tenant, projectId: lead.projectId });
  await Lead.updateOne({ tenantId, _id: lead._id }, {
    $set: { slaTargetSeconds: rule.targetSeconds, slaStatus: 'PENDING' },
  });
  return rule;
}

/**
 * §16.4: one pass of the SLA workflow across every waiting lead.
 * Each step is guarded by a stored timestamp, so a repeated run cannot send a
 * duplicate warning or reassign twice — the job is safe to retry (§106).
 */
async function tick({ now = new Date(), tenantId = null } = {}) {
  const filter = {
    status: 'ACTIVE',
    firstGenuineActionAt: null,
    assignedAt: { $ne: null },
    // BREACHED must stay in scope: escalation happens before the auto-reassign
    // threshold, so dropping breached leads here would make §16.4 step 7 dead code.
    slaStatus: { $in: ['PENDING', 'AT_RISK', 'BREACHED', 'REASSIGNED'] },
  };
  if (tenantId) filter.tenantId = tenantId;

  const leads = await Lead.find(filter).setOptions({ allowCrossTenant: !tenantId }).limit(500).lean();
  const tenants = new Map();
  const result = { scanned: leads.length, warned: 0, escalated: 0, reassigned: 0 };

  for (const lead of leads) {
    const key = String(lead.tenantId);
    if (!tenants.has(key)) tenants.set(key, await Tenant.findById(lead.tenantId).lean());
    const tenant = tenants.get(key);
    if (!tenant || tenant.status !== 'ACTIVE') continue;

    const rule = await resolveRule({ tenantId: lead.tenantId, tenant, projectId: lead.projectId });
    const state = evaluate({ lead, rule, tenant, now });
    const contact = await Contact.findOne({ tenantId: lead.tenantId, _id: lead.contactId }).select('displayName').lean();

    if (state.needsWarning) {
      await Lead.updateOne({ tenantId: lead.tenantId, _id: lead._id }, {
        $set: { slaStatus: 'AT_RISK', slaWarningSentAt: now },
      });
      await notifications.notify({
        tenantId: lead.tenantId,
        userId: lead.ownerUserId,
        type: 'SLA_WARNING',
        title: 'Respond now — SLA at risk',
        body: `${contact?.displayName || 'A new lead'} has been waiting ${Math.round(state.seconds / 60)} min.`,
        link: `/app/leads/${lead._id}`,
        leadId: lead._id,
        severity: 'WARNING',
      });
      await timeline.log({
        tenantId: lead.tenantId, leadId: lead._id, contactId: lead.contactId, type: 'SLA_WARNING',
        title: 'SLA warning — lead still unattended', actorType: 'SYSTEM', at: now,
        meta: { waitedSeconds: state.seconds },
      });
      emit(EVENTS.LEAD_SLA_WARNING, { tenantId: lead.tenantId, lead, seconds: state.seconds });
      result.warned += 1;
    }

    if (state.needsEscalation) {
      await Lead.updateOne({ tenantId: lead.tenantId, _id: lead._id }, {
        $set: {
          slaStatus: 'BREACHED',
          slaEscalatedAt: now,
          slaBreached: true,
          slaBreachSeconds: Math.max(0, state.seconds - rule.targetSeconds),
        },
      });
      const managers = await escalationRecipients({ tenantId: lead.tenantId, rule, lead });
      await notifications.notifyMany({
        tenantId: lead.tenantId,
        userIds: managers,
        type: 'SLA_BREACHED',
        title: 'SLA breached',
        body: `${contact?.displayName || 'A lead'} has waited ${Math.round(state.seconds / 60)} min without a response.`,
        link: `/app/leads/${lead._id}`,
        leadId: lead._id,
        severity: 'CRITICAL',
      });
      await timeline.log({
        tenantId: lead.tenantId, leadId: lead._id, contactId: lead.contactId, type: 'SLA_BREACHED',
        title: 'SLA breached — escalated to management', actorType: 'SYSTEM', at: now,
        meta: { waitedSeconds: state.seconds },
      });
      emit(EVENTS.LEAD_SLA_BREACHED, { tenantId: lead.tenantId, lead, seconds: state.seconds });
      result.escalated += 1;
    }

    if (state.needsReassign) {
      const previousOwnerId = lead.ownerUserId;
      const { ownerUserId } = await distribution.reassignLead({
        tenantId: lead.tenantId, lead, contact, reason: 'SLA_BREACH',
      });
      if (ownerUserId) {
        // §16.4 step 7: previous owner, new owner and the manager all hear about it.
        await notifications.notify({
          tenantId: lead.tenantId, userId: previousOwnerId, type: 'LEAD_REASSIGNED_AWAY',
          title: 'Lead reassigned away from you',
          body: `${contact?.displayName || 'A lead'} went unattended and has been passed on.`,
          link: `/app/leads/${lead._id}`, leadId: lead._id, severity: 'WARNING',
        });
        await notifications.notify({
          tenantId: lead.tenantId, userId: ownerUserId, type: 'LEAD_ASSIGNED',
          title: 'Lead reassigned to you — call now',
          body: `${contact?.displayName || 'A lead'} is waiting for a first response.`,
          link: `/app/leads/${lead._id}`, leadId: lead._id, severity: 'CRITICAL',
        });
        const managers = await escalationRecipients({ tenantId: lead.tenantId, rule, lead });
        await notifications.notifyMany({
          tenantId: lead.tenantId, userIds: managers, type: 'LEAD_REASSIGNED',
          title: 'Lead auto-reassigned',
          body: `${contact?.displayName || 'A lead'} was reassigned after no response.`,
          link: `/app/leads/${lead._id}`, leadId: lead._id, severity: 'WARNING',
        });
        result.reassigned += 1;
      }
    }
  }
  return result;
}

async function escalationRecipients({ tenantId, rule, lead }) {
  if (rule.escalationUserIds?.length) return rule.escalationUserIds;
  const pool = await AssignmentPool.findOne({
    tenantId,
    ...(lead.assignmentPoolId ? { _id: lead.assignmentPoolId } : { isDefault: true }),
  }).lean();
  if (pool?.escalationUserIds?.length) return pool.escalationUserIds;
  return notifications.adminUserIds(tenantId);
}

module.exports = { resolveRule, evaluate, waitedSeconds, startClock, tick, escalationRecipients };
