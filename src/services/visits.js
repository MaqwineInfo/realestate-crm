const { SiteVisit, Lead, Project, VisitOutcome, Unit, Contact, Tenant } = require('../db/models');
const { badRequest, notFound } = require('../lib/errors');
const { EVENTS, emit } = require('../lib/events');
const tz = require('../lib/tz');
const timeline = require('./timeline');
const stagesService = require('./stages');
const leadsService = require('./leads');
const followupsService = require('./followups');
const notifications = require('./notifications');
const inventory = require('./inventory');
const audit = require('./audit');

/**
 * Spec §24 + §84: site visits.
 *
 * Two rules matter: completion requires an outcome (§24.3, §52.4), and an
 * active lead still needs its next action afterwards — which is enforced by
 * the same follow-up engine every other outcome flows through (§55.1).
 */

async function schedule({
  tenantId, tenant, actor, leadId, projectId, scheduledAt, salesUserId, visitingWith = 'DIRECT',
  channelPartnerName, channelPartnerMobile, channelPartnerContactId, visitorCount, notes, viaQr = false,
  status = 'PLANNED',
}) {
  const lead = await Lead.findOne({ tenantId, _id: leadId }).lean();
  if (!lead) throw notFound('Lead not found.');
  if (lead.status === 'TERMINAL' && !viaQr) {
    throw badRequest('This lead is closed. Reopen it before scheduling a visit.');
  }
  const project = await Project.findOne({ tenantId, _id: projectId || lead.projectId }).lean();
  if (!project) throw badRequest('Choose the project being visited.');
  if (!scheduledAt) throw badRequest('Choose the visit date and time.');

  // §25.1: channel-partner details are mandatory when the tenant says so.
  if (visitingWith === 'CHANNEL_PARTNER') {
    if (!channelPartnerName && !channelPartnerContactId) throw badRequest('Enter the channel partner name.');
    const requireMobile = (tenant || await Tenant.findById(tenantId).lean()).settings?.qrRequireCpMobile;
    if (requireMobile && !channelPartnerMobile && !channelPartnerContactId) {
      throw badRequest('Enter the channel partner mobile number.');
    }
  }

  const visit = await SiteVisit.create({
    tenantId,
    leadId,
    contactId: lead.contactId,
    projectId: project._id,
    scheduledAt: new Date(scheduledAt),
    salesUserId: salesUserId || lead.ownerUserId || actor?._id,
    createdBy: actor?._id,
    status,
    visitingWith,
    channelPartnerContactId,
    channelPartnerName,
    channelPartnerMobile,
    visitorCount,
    notes,
    viaQr,
  });

  await Lead.updateOne({ tenantId, _id: leadId }, { $inc: { visitCount: 1 } });

  // §84: semantic mapping moves the stage, and only if the tenant wants it.
  const settings = (tenant || await Tenant.findById(tenantId).lean()).settings;
  if (settings?.autoStageOnVisit && lead.status === 'ACTIVE') {
    const stage = await stagesService.bySemantic({ tenantId, semanticType: 'VISIT_PLANNED' });
    if (stage && String(stage._id) !== String(lead.stageId)) {
      await leadsService.changeStage({
        tenantId, actor, leadId, stageId: stage._id,
        sourceAction: 'VISIT_SCHEDULED', note: 'Site visit scheduled',
      });
    }
  }

  await timeline.log({
    tenantId, leadId, contactId: lead.contactId, type: 'VISIT_SCHEDULED',
    title: `Site visit at ${project.name} scheduled`, actor, actorType: actor ? 'USER' : 'SYSTEM',
    meta: { visitId: String(visit._id), scheduledAt: visit.scheduledAt, viaQr },
  });

  if (visit.salesUserId && String(visit.salesUserId) !== String(actor?._id)) {
    await notifications.notify({
      tenantId,
      userId: visit.salesUserId,
      type: 'VISIT_UPCOMING',
      title: 'Site visit scheduled for you',
      body: `${project.name} — ${new Date(visit.scheduledAt).toISOString()}`,
      link: `/app/leads/${leadId}`,
      leadId,
    });
  }

  emit(EVENTS.VISIT_CREATED, { tenantId, leadId, visitId: visit._id });
  return visit;
}

async function reschedule({ tenantId, actor, visitId, scheduledAt, note }) {
  const visit = await SiteVisit.findOne({ tenantId, _id: visitId });
  if (!visit) throw notFound('Site visit not found.');
  if (['COMPLETED', 'CANCELLED'].includes(visit.status)) throw badRequest('This visit is already closed.');

  const from = visit.scheduledAt;
  visit.scheduledAt = new Date(scheduledAt);
  visit.status = 'PLANNED';
  if (note) visit.notes = note;
  await visit.save();

  await timeline.log({
    tenantId, leadId: visit.leadId, contactId: visit.contactId, type: 'VISIT_RESCHEDULED',
    title: 'Site visit rescheduled', body: note, actor,
    meta: { visitId: String(visit._id), from, to: visit.scheduledAt },
  });
  return visit;
}

/**
 * §24.3: completing a visit. The outcome is mandatory, units shown can be
 * captured and shortlisted in the same step, and an active lead leaves with a
 * next action because `applyOutcome` will not let it do otherwise.
 */
async function complete({
  tenantId, tenant, actor, visitId, outcomeId, notes, unitsShownIds = [], shortlistUnitIds = [],
  stageId, next, tz: zone,
}) {
  const visit = await SiteVisit.findOne({ tenantId, _id: visitId });
  if (!visit) throw notFound('Site visit not found.');
  if (visit.status === 'COMPLETED') throw badRequest('This visit is already completed.');

  const outcome = await VisitOutcome.findOne({ tenantId, _id: outcomeId, active: true }).lean();
  if (!outcome) throw badRequest('Select the visit outcome.');

  const lead = await Lead.findOne({ tenantId, _id: visit.leadId }).lean();
  if (!lead) throw notFound('Lead not found.');

  // Work out the resulting stage before anything is written (§84).
  let resultingStageId = stageId;
  if (!resultingStageId && lead.status === 'ACTIVE') {
    const settings = (tenant || await Tenant.findById(tenantId).lean()).settings;
    if (settings?.autoStageOnVisit) {
      const stage = await stagesService.bySemantic({ tenantId, semanticType: 'VISIT_DONE' });
      if (stage) resultingStageId = stage._id;
    }
  }

  // The next-action gate runs first; nothing below happens if it rejects.
  if (lead.status === 'ACTIVE') {
    const targetStage = await stagesService.requireStage({ tenantId, stageId: resultingStageId || lead.stageId });
    await followupsService.requireNextAction({ tenantId, resultingStage: targetStage, next, tz: zone });
  }

  visit.status = 'COMPLETED';
  visit.completedAt = new Date();
  visit.completedBy = actor?._id;
  visit.outcomeId = outcome._id;
  if (notes) visit.notes = notes;
  if (unitsShownIds.length) visit.unitsShownIds = unitsShownIds;
  await visit.save();

  await Lead.updateOne({ tenantId, _id: visit.leadId }, { $inc: { completedVisitCount: 1 } });

  // §24.3 step 4: shortlist straight from the visit.
  for (const unitId of shortlistUnitIds) {
    await inventory.shortlist({ tenantId, actor, leadId: visit.leadId, unitId }).catch(() => {});
  }

  await timeline.log({
    tenantId, leadId: visit.leadId, contactId: visit.contactId, type: 'VISIT_COMPLETED',
    title: `Site visit completed — ${outcome.name}`, body: notes, actor,
    meta: { visitId: String(visit._id), outcome: outcome.name, unitsShown: unitsShownIds.length },
  });
  emit(EVENTS.VISIT_COMPLETED, { tenantId, leadId: visit.leadId, visitId: visit._id, outcomeId: outcome._id });

  // Stage move + next action, through the one path that enforces the rule.
  if (lead.status === 'ACTIVE') {
    await followupsService.applyOutcome({
      tenantId,
      tenant,
      actor,
      lead,
      followup: null,
      stageId: resultingStageId,
      note: notes,
      next,
      tz: zone,
      skipInteractionActivity: true,
      sourceAction: 'VISIT_COMPLETED',
    });
  }

  await audit.record({
    tenantId, actor, entity: 'SiteVisit', entityId: visit._id, action: 'COMPLETE',
    after: { outcome: outcome.name },
  });
  return visit;
}

async function cancel({ tenantId, actor, visitId, reason, noShow = false }) {
  const visit = await SiteVisit.findOne({ tenantId, _id: visitId });
  if (!visit) throw notFound('Site visit not found.');
  if (['COMPLETED', 'CANCELLED'].includes(visit.status)) throw badRequest('This visit is already closed.');

  visit.status = noShow ? 'NO_SHOW' : 'CANCELLED';
  visit.cancelledReason = reason;
  await visit.save();

  await timeline.log({
    tenantId, leadId: visit.leadId, contactId: visit.contactId,
    type: noShow ? 'VISIT_NO_SHOW' : 'VISIT_CANCELLED',
    title: noShow ? 'Customer did not show up' : 'Site visit cancelled',
    body: reason, actor,
    meta: { visitId: String(visit._id) },
  });
  emit(EVENTS.VISIT_CANCELLED, { tenantId, leadId: visit.leadId, visitId: visit._id, noShow });
  return visit;
}

/** §8.2 Today's Visits tile. Completed and cancelled are hidden unless asked for. */
function todayFilter({ tenantId, userIds, zone, now = new Date(), includeClosed = false }) {
  const { start, end } = tz.todayRange(zone, now);
  return {
    tenantId,
    scheduledAt: { $gte: start, $lt: end },
    ...(userIds ? { salesUserId: { $in: userIds } } : {}),
    ...(includeClosed ? {} : { status: { $in: ['PLANNED', 'CONFIRMED', 'IN_PROGRESS'] } }),
  };
}

const todayVisits = (args) => SiteVisit.find(todayFilter(args))
  .sort({ scheduledAt: 1 })
  .populate('contactId', 'displayName primaryMobile normalizedMobile')
  .populate('projectId', 'name')
  .populate('salesUserId', 'name')
  .populate('outcomeId', 'name')
  .populate({ path: 'leadId', populate: { path: 'stageId', select: 'name colorToken' } })
  .lean();

const forLead = ({ tenantId, leadId }) => SiteVisit.find({ tenantId, leadId })
  .sort({ scheduledAt: -1 })
  .populate('projectId', 'name')
  .populate('salesUserId', 'name')
  .populate('outcomeId', 'name')
  .populate('unitsShownIds', 'unitNumber')
  .lean();

module.exports = { schedule, reschedule, complete, cancel, todayFilter, todayVisits, forLead };
