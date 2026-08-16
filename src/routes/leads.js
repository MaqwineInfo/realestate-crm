const express = require('express');
const { z } = require('zod');
const { requireAuth, requirePermission } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { scopeFilter } = require('../lib/access');
const { forbidden, badRequest } = require('../lib/errors');
const { Lead, Project, User, Followup } = require('../db/models');
const leadsService = require('../services/leads');
const contactsService = require('../services/contacts');
const stagesService = require('../services/stages');
const timeline = require('../services/timeline');

const router = express.Router();
router.use('/app/leads', requireAuth);
router.use('/api/leads', requireAuth);

const f = require('../lib/fields');

const PURPOSES = ['SELF_USE', 'INVESTMENT', 'RENTAL_INCOME', 'OTHER'];

/** V1.1 §10.1 option sets, shared by the form and its validation. */
const TIMELINES = ['IMMEDIATE', 'DAYS_0_30', 'MONTHS_1_3', 'MONTHS_3_6', 'MONTHS_6_PLUS', 'EXPLORING'];
const FUNDING = ['SELF_FUNDED', 'HOME_LOAN', 'MIXED', 'UNKNOWN'];
const LOAN_STATUS = ['NOT_STARTED', 'EXPLORING', 'PRE_APPROVED', 'APPROVED'];
const DECISION_MAKERS = ['SELF', 'SPOUSE', 'FAMILY', 'BUSINESS_PARTNER', 'OTHER'];
const POSSESSION = ['READY', 'NEAR_POSSESSION', 'UNDER_CONSTRUCTION', 'ANY'];
const AREA_BASIS = ['CARPET', 'BUILT_UP', 'SALEABLE'];

const createSchema = z.object({
  contactId: f.optionalId,
  firstName: f.optionalText(80),
  lastName: f.optionalText(80),
  primaryMobile: f.optionalText(20),
  altMobile: f.optionalText(20),
  email: f.email,
  city: f.optionalText(80),
  state: f.optionalText(80),
  pincode: f.optionalText(12),

  // Inquiry & source (§9)
  projectId: f.optionalId,
  sourceId: f.objectId,
  sourceDetail: f.optionalText(120),
  campaignId: f.optionalId,
  referrerName: f.optionalText(120),
  referrerMobile: f.optionalText(20),
  portalLeadId: f.optionalText(80),
  listingReference: f.optionalText(120),

  // Assignment (§11.3)
  assignmentMode: f.enumField(['AUTO', 'MANUAL']),
  ownerUserId: f.optionalId,

  // Requirement (§10)
  budgetMinMinor: f.moneyAmount,
  budgetMaxMinor: f.moneyAmount,
  areaMin: f.optionalNumber,
  areaMax: f.optionalNumber,
  areaBasis: f.enumField(AREA_BASIS),
  preferredFloorMin: f.optionalNumber,
  preferredFloorMax: f.optionalNumber,
  purpose: f.enumField(PURPOSES),
  possessionPreference: f.enumField(POSSESSION),
  preferredLocation: f.optionalText(200),
  preferredConfigurations: f.stringList,
  preferredFacings: f.stringList,
  requirementNote: f.optionalText(2000),

  // Qualification (§10.1)
  purchaseTimeline: f.enumField(TIMELINES),
  fundingType: f.enumField(FUNDING),
  loanStatus: f.enumField(LOAN_STATUS),
  decisionMaker: f.enumField(DECISION_MAKERS),

  // §13: what to do when the mobile already exists.
  intent: f.enumField(['NEW_INQUIRY', 'REINQUIRY']),
}).refine((d) => d.contactId || (d.firstName && d.primaryMobile), {
  message: 'Choose an existing contact, or enter a name and mobile number.',
  path: ['primaryMobile'],
// §12.5–12.7: ranges have to make sense before anything is written.
}).refine((d) => !(d.budgetMinMinor != null && d.budgetMaxMinor != null && d.budgetMaxMinor < d.budgetMinMinor), {
  message: 'Maximum budget cannot be lower than the minimum.', path: ['budgetMaxMinor'],
}).refine((d) => !(d.areaMin != null && d.areaMax != null && d.areaMax < d.areaMin), {
  message: 'Maximum area cannot be lower than the minimum.', path: ['areaMax'],
}).refine((d) => !(d.preferredFloorMin != null && d.preferredFloorMax != null && d.preferredFloorMax < d.preferredFloorMin), {
  message: 'The top floor cannot be lower than the bottom floor.', path: ['preferredFloorMax'],
});

/* ---------------------------------- list --------------------------------- */

router.get('/app/leads', requirePermission('lead.view'), async (req, res, next) => {
  try {
    const scope = await scopeFilter(req.user, 'lead.view');
    if (!scope) throw forbidden('You do not have permission to view leads.');

    const page = Number(req.query.page || 1);
    const result = await leadsService.list({
      tenantId: req.tenantId, scope, query: req.query, page, tz: res.locals.zone,
    });
    const [stages, subStages, sources, projects, owners] = await Promise.all([
      stagesService.listStages({ tenantId: req.tenantId }),
      stagesService.listSubStages({ tenantId: req.tenantId }),
      stagesService.listSources({ tenantId: req.tenantId }),
      Project.find({ tenantId: req.tenantId, archived: { $ne: true } }).select('name').sort({ name: 1 }).lean(),
      User.find({ tenantId: req.tenantId, status: 'ACTIVE' }).select('name').sort({ name: 1 }).lean(),
    ]);

    res.render('pages/leads/list', {
      title: 'Leads',
      ...result,
      stages,
      subStages,
      sources,
      projects,
      owners,
    });
  } catch (err) { next(err); }
});

/* --------------------------------- create -------------------------------- */

/** Everything the capture form needs to render, with or without a prefill. */
async function newLeadContext(req, values = {}) {
  const { MarketingCampaign } = require('../db/models');
  const [sources, projects, owners, campaigns] = await Promise.all([
    stagesService.listSources({ tenantId: req.tenantId }),
    Project.find({ tenantId: req.tenantId, status: { $ne: 'ARCHIVED' } })
      .select('name configurations').sort({ name: 1 }).lean(),
    User.find({ tenantId: req.tenantId, status: 'ACTIVE' }).select('name').sort({ name: 1 }).lean(),
    MarketingCampaign.find({ tenantId: req.tenantId }).select('name platform').sort({ startDate: -1 }).limit(50).lean(),
  ]);
  return {
    title: 'New lead',
    sources,
    projects,
    owners,
    campaigns,
    // §11.3: manual assignment is a permission, not a default.
    canAssign: require('../lib/access').can(req.user, 'lead.transfer') || req.user.role?.isAdmin,
    values,
    existing: null,
  };
}

router.get('/app/leads/new', requirePermission('lead.create'), async (req, res, next) => {
  try {
    // §5.8: search found nothing, so capture starts with the number already typed.
    const values = req.query.mobile ? { primaryMobile: String(req.query.mobile) } : {};
    res.render('pages/leads/new', await newLeadContext(req, values));
  } catch (err) { next(err); }
});

/** §8.2: live duplicate lookup while the mobile is still being typed. */
router.get('/api/contacts/lookup', requireAuth, requirePermission('lead.create'), async (req, res, next) => {
  try {
    const captureService = require('../services/capture');
    const found = await captureService.inspectExisting({
      tenantId: req.tenantId,
      tenant: req.tenant,
      mobile: req.query.mobile,
      projectId: req.query.projectId || null,
    });
    if (!found) return res.json({ found: false });

    res.json({
      found: true,
      kind: found.kind,
      contactId: String(found.contact._id),
      displayName: found.contact.displayName,
      mobile: found.contact.primaryMobile,
      inquiryCount: found.contact.inquiryCount || 0,
      leadCount: found.leadCount,
      bookedHere: found.bookedHere,
      lead: found.lead ? { id: String(found.lead._id), status: found.lead.status } : null,
    });
  } catch (err) { next(err); }
});

router.post('/api/leads', requirePermission('lead.create'), validate(createSchema), async (req, res, next) => {
  try {
    const captureService = require('../services/capture');
    const d = req.data;

    /**
     * §11.3 / §12.9–12.10: Auto Allocate is the default, and manual assignment
     * needs both the permission and an active target. Anything else falls to
     * round robin rather than quietly landing on whoever filled the form.
     */
    // An explicit owner is a manual assignment even when the form did not say so,
    // which keeps the API contract stable for existing integrations.
    const wantsManual = !!d.ownerUserId && d.assignmentMode !== 'AUTO';
    if (wantsManual && !require('../lib/access').can(req.user, 'lead.transfer') && !req.user.role?.isAdmin) {
      throw forbidden('You do not have permission to assign leads to another user.');
    }
    if (wantsManual) {
      const target = await User.findOne({ tenantId: req.tenantId, _id: d.ownerUserId, status: 'ACTIVE' }).lean();
      if (!target) throw badRequest('Leads can only be assigned to an active user.');
    }

    /**
     * §13: the existing-contact decision tree. The capture service has always
     * known this; the form now has to *ask* rather than silently produce a second
     * active lead on the same project.
     */
    if (!d.contactId && d.primaryMobile) {
      const existing = await captureService.inspectExisting({
        tenantId: req.tenantId, tenant: req.tenant, mobile: d.primaryMobile, projectId: d.projectId,
      });

      const needsDecision = existing
        && ['ACTIVE_SAME_PROJECT', 'LOST_SAME_PROJECT'].includes(existing.kind)
        && !d.intent;

      if (needsDecision) {
        // Nothing is written. The user picks: open the lead, or record a re-inquiry.
        return res.status(200).render('pages/leads/new', {
          ...(await newLeadContext(req, req.body)),
          existing,
        });
      }

      // §13.2/§13.3: a re-inquiry appends a touch (and revives a lost lead) —
      // it never creates a competing second lead.
      if (existing && d.intent === 'REINQUIRY') {
        const result = await captureService.handleInquiry({
          tenantId: req.tenantId,
          tenant: req.tenant,
          actor: req.user,
          createdVia: 'MANUAL',
          payload: {
            firstName: d.firstName, lastName: d.lastName, mobile: d.primaryMobile, email: d.email,
            city: d.city, projectId: d.projectId, sourceId: d.sourceId, sourceDetail: d.sourceDetail,
            campaignId: d.campaignId, message: d.requirementNote,
          },
        });
        if (wantsJson(req)) return res.status(201).json({ ok: true, leadId: result.lead._id, reinquiry: true });
        req.session.flash = { type: 'success', message: 'Re-inquiry recorded on the existing lead.' };
        return res.redirect(`/app/leads/${result.lead._id}`);
      }
    }

    const { lead } = await leadsService.create({
      tenantId: req.tenantId,
      tenant: req.tenant,
      actor: req.user,
      data: { ...d, ownerUserId: wantsManual ? d.ownerUserId : null },
      createdVia: 'MANUAL',
    });

    // §74: with no manual owner, the lead goes through the same round robin an
    // inbound lead does — project pool first, default pool second.
    if (!wantsManual) {
      const fresh = await Lead.findOne({ tenantId: req.tenantId, _id: lead._id }).lean();
      const sla = require('../services/sla');
      await sla.startClock({ tenantId: req.tenantId, tenant: req.tenant, lead: fresh });
      await require('../services/distribution').assignLead({
        tenantId: req.tenantId, lead: fresh, actor: req.user,
      });
    }

    if (wantsJson(req)) return res.status(201).json({ ok: true, leadId: lead._id });
    req.session.flash = { type: 'success', message: 'Lead created. Log your first action to clear it from New Leads.' };
    res.redirect(`/app/leads/${lead._id}`);
  } catch (err) { next(err); }
});

/* -------------------------------- workspace ------------------------------- */

router.get('/app/leads/:id', requirePermission('lead.view'), async (req, res, next) => {
  try {
    const lead = await leadsService.get({ tenantId: req.tenantId, leadId: req.params.id });
    await leadsService.assertCanView(req.user, lead);

    const inventoryService = require('../services/inventory');
    const visitsService = require('../services/visits');
    const costsheetsService = require('../services/costsheets');
    const blocksService = require('../services/blocks');

    const stageHistoryService = require('../services/stageHistory');

    const [
      activities, stages, subStages, actionTypes, visitOutcomes, owners, followups, siblingLeads,
      shortlist, visits, costSheets, activeBlocks, projects, funnel, stageHistory,
    ] = await Promise.all([
      timeline.forLead({ tenantId: req.tenantId, leadId: lead._id }),
      stagesService.listStages({ tenantId: req.tenantId }),
      stagesService.listSubStages({ tenantId: req.tenantId }),
      stagesService.listActionTypes({ tenantId: req.tenantId }),
      stagesService.listVisitOutcomes({ tenantId: req.tenantId }),
      User.find({ tenantId: req.tenantId, status: 'ACTIVE' }).select('name').sort({ name: 1 }).lean(),
      Followup.find({ tenantId: req.tenantId, leadId: lead._id })
        .sort({ dueAt: 1 }).populate('actionTypeId', 'name semantic').populate('assignedUserId', 'name').lean(),
      Lead.find({ tenantId: req.tenantId, contactId: lead.contactId._id, _id: { $ne: lead._id } })
        .select('projectId stageId status latestInquiryAt')
        .populate('projectId', 'name').populate('stageId', 'name').lean(),
      inventoryService.shortlistFor({ tenantId: req.tenantId, leadId: lead._id }),
      visitsService.forLead({ tenantId: req.tenantId, leadId: lead._id }),
      costsheetsService.forLead({ tenantId: req.tenantId, leadId: lead._id }),
      blocksService.activeFor({ tenantId: req.tenantId, leadId: lead._id }),
      Project.find({ tenantId: req.tenantId, status: 'ACTIVE' }).select('name').sort({ name: 1 }).lean(),
      // V1.1 §17: the journey funnel, built from real history — not list order.
      stageHistoryService.funnel({ tenantId: req.tenantId, lead }),
      stageHistoryService.forLead({ tenantId: req.tenantId, leadId: lead._id }),
    ]);

    res.render('pages/leads/workspace', {
      title: lead.contactId.displayName,
      lead,
      activities,
      stages,
      subStages,
      actionTypes,
      visitOutcomes,
      owners,
      followups,
      siblingLeads,
      shortlist,
      visits,
      costSheets,
      activeBlocks,
      projects,
      funnel,
      stageHistory,
      pendingFollowup: followups.find((f) => f.status === 'PENDING'),
      openVisits: visits.filter((v) => ['PLANNED', 'CONFIRMED', 'IN_PROGRESS'].includes(v.status)),
    });
  } catch (err) { next(err); }
});

/* --------------------------------- actions -------------------------------- */

const detailsSchema = z.object({
  projectId: f.optionalId,
  budgetMinMinor: f.moneyAmount,
  budgetMaxMinor: f.moneyAmount,
  purpose: f.enumField(PURPOSES),
  priority: f.enumField(['LOW', 'MEDIUM', 'HIGH']),
  preferredConfigurations: f.stringList,
  preferredFacing: f.optionalText(40),
  areaMin: f.optionalNumber,
  areaMax: f.optionalNumber,
  requirementNote: f.optionalText(2000),
});

router.post('/api/leads/:id', requirePermission('lead.edit'), validate(detailsSchema), async (req, res, next) => {
  try {
    await assertOwnedAccess(req, req.params.id, 'lead.edit');
    await leadsService.updateDetails({
      tenantId: req.tenantId, actor: req.user, leadId: req.params.id, payload: req.data,
    });
    respond(req, res, 'Lead updated.', `/app/leads/${req.params.id}`);
  } catch (err) { next(err); }
});

const stageSchema = z.object({
  stageId: f.objectId,
  subStageId: f.optionalId,
  note: f.optionalText(2000),
});

router.post('/api/leads/:id/stage', requirePermission('lead.edit', 'lead.mark_lost'), validate(stageSchema), async (req, res, next) => {
  try {
    await assertOwnedAccess(req, req.params.id, 'lead.edit');
    await leadsService.changeStage({
      tenantId: req.tenantId, actor: req.user, leadId: req.params.id, ...req.data,
    });
    respond(req, res, 'Stage updated.', `/app/leads/${req.params.id}`);
  } catch (err) { next(err); }
});

const transferSchema = z.object({
  toUserId: f.objectId,
  reason: f.requiredText(120, 'Give a transfer reason.'),
  note: f.optionalText(1000),
});

router.post('/api/leads/:id/transfer', requirePermission('lead.transfer'), validate(transferSchema), async (req, res, next) => {
  try {
    await leadsService.transfer({
      tenantId: req.tenantId, actor: req.user, leadId: req.params.id, ...req.data,
    });
    respond(req, res, 'Lead transferred.', `/app/leads/${req.params.id}`);
  } catch (err) { next(err); }
});

const reopenSchema = z.object({
  stageId: f.objectId,
  ownerUserId: f.optionalId,
  reason: f.requiredText(500, 'Give a reason for reopening.'),
  // V1.1 §84: reopening and scheduling the next action are one flow.
  nextActionTypeId: f.optionalId,
  nextDate: f.optionalText(10),
  nextTime: f.optionalText(5),
  nextNote: f.optionalText(500),
});

router.post('/api/leads/:id/reopen', requirePermission('lead.reopen_lost'), validate(reopenSchema), async (req, res, next) => {
  try {
    const d = req.data;
    await leadsService.reopen({
      tenantId: req.tenantId,
      actor: req.user,
      leadId: req.params.id,
      stageId: d.stageId,
      ownerUserId: d.ownerUserId,
      reason: d.reason,
      tz: res.locals.zone,
      next: d.nextActionTypeId
        ? { actionTypeId: d.nextActionTypeId, date: d.nextDate, time: d.nextTime, note: d.nextNote }
        : null,
    });
    respond(req, res,
      d.nextActionTypeId ? 'Lead reopened and the next action is set.' : 'Lead reopened. Add the next action to keep it moving.',
      `/app/leads/${req.params.id}`);
  } catch (err) { next(err); }
});

/**
 * V1.1 §96: manual temperature pin, or a return to automatic scoring.
 * `lead.edit` is the gate — §113 says not to add a permission just for naming.
 */
const temperatureSchema = z.object({
  mode: z.enum(['AUTO', 'MANUAL']),
  temperature: f.enumField(['HOT', 'WARM', 'COLD']),
  reason: f.optionalText(500),
});

router.post('/api/leads/:id/temperature', requirePermission('lead.edit'), validate(temperatureSchema), async (req, res, next) => {
  try {
    await assertOwnedAccess(req, req.params.id, 'lead.edit');
    const temperature = require('../services/temperature');

    if (req.data.mode === 'AUTO') {
      await temperature.returnToAuto({ tenantId: req.tenantId, actor: req.user, leadId: req.params.id });
      return respond(req, res, 'Temperature is back on automatic scoring.', `/app/leads/${req.params.id}`);
    }
    await temperature.override({
      tenantId: req.tenantId,
      actor: req.user,
      leadId: req.params.id,
      temperature: req.data.temperature,
      reason: req.data.reason,
    });
    respond(req, res, `Lead marked ${req.data.temperature.toLowerCase()}.`, `/app/leads/${req.params.id}`);
  } catch (err) { next(err); }
});

const noteSchema = z.object({ body: f.requiredText(5000, 'Write a note first.') });

router.post('/api/leads/:id/notes', requirePermission('note.create'), validate(noteSchema), async (req, res, next) => {
  try {
    const lead = await assertOwnedAccess(req, req.params.id, 'lead.view');
    const mentionUserIds = await timeline.resolveMentions({ tenantId: req.tenantId, body: req.data.body });
    await timeline.addNote({
      tenantId: req.tenantId, leadId: lead._id, contactId: lead.contactId,
      actor: req.user, body: req.data.body, mentionUserIds,
    });
    respond(req, res, 'Note added.', `/app/leads/${req.params.id}`);
  } catch (err) { next(err); }
});

/* --------------------------------- helpers -------------------------------- */

async function assertOwnedAccess(req, leadId, permission) {
  const lead = await Lead.findOne({ tenantId: req.tenantId, _id: leadId }).lean();
  if (!lead) throw badRequest('Lead not found.');
  const { canActOn } = require('../lib/access');
  const allowed = await canActOn(req.user, permission === 'lead.view' ? 'lead.view' : 'lead.view', lead.ownerUserId);
  if (!allowed && lead.ownerUserId) throw forbidden('This lead belongs to another user.');
  return lead;
}

const wantsJson = (req) => (req.get('accept') || '').includes('application/json');

function respond(req, res, message, redirectTo) {
  if (wantsJson(req)) return res.json({ ok: true, message });
  req.session.flash = { type: 'success', message };
  res.redirect(redirectTo);
}

module.exports = router;
