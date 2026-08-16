const express = require('express');
const { z } = require('zod');
const { requireAuth, requirePermission } = require('../middleware/auth');
const validate = require('../middleware/validate');
const f = require('../lib/fields');
const tzLib = require('../lib/tz');
const money = require('../lib/money');
const { badRequest } = require('../lib/errors');
const {
  Template, Project, LeadSource, Tag, Stage, NurtureSequence, ActionType,
} = require('../db/models');
const segments = require('../services/segments');
const campaignsService = require('../services/campaigns');
const attribution = require('../services/attribution');
const nurture = require('../services/nurture');

/** Spec §37–§40: contact segments, communication campaigns, ad performance. */
const router = express.Router();
router.use('/app/campaigns', requireAuth);
router.use('/api/campaigns', requireAuth);
router.use('/app/setup/nurture', requireAuth);
router.use('/api/setup/nurture', requireAuth);

const AUDIENCE_FIELDS = [
  'tagId', 'city', 'ownerUserId', 'projectId', 'stageId', 'sourceId', 'campaignId',
  'purpose', 'leadStatus', 'hasVisited', 'hasBooked', 'createdFrom', 'createdTo',
  'lastActivityWithinDays',
];

const pickFilters = (source) => Object.fromEntries(
  AUDIENCE_FIELDS.filter((key) => source[key]).map((key) => [key, source[key]]),
);

router.get('/app/campaigns', requirePermission('campaign.view'), (req, res) => {
  res.redirect('/app/campaigns/communication');
});

/* --------------------------- communication (§38) -------------------------- */

router.get('/app/campaigns/communication', requirePermission('campaign.view'), async (req, res, next) => {
  try {
    const campaigns = await campaignsService.list({ tenantId: req.tenantId });
    res.render('pages/campaigns/list', { title: 'Communication campaigns', campaigns });
  } catch (err) { next(err); }
});

/** §38.1: build the audience and see the recipient count before sending. */
router.get('/app/campaigns/communication/new', requirePermission('campaign.create'), async (req, res, next) => {
  try {
    const filters = pickFilters(req.query);
    const [templates, savedSegments, projects, stages, sources, tags, preview] = await Promise.all([
      Template.find({ tenantId: req.tenantId, active: true }).sort({ channel: 1, name: 1 }).lean(),
      segments.list({ tenantId: req.tenantId }),
      Project.find({ tenantId: req.tenantId, archived: { $ne: true } }).select('name').lean(),
      Stage.find({ tenantId: req.tenantId, active: true }).select('name').sort({ displayOrder: 1 }).lean(),
      LeadSource.find({ tenantId: req.tenantId, active: true }).select('name').lean(),
      Tag.find({ tenantId: req.tenantId, active: true }).select('name').lean(),
      segments.preview({ tenantId: req.tenantId, filters, zone: res.locals.zone }),
    ]);
    res.render('pages/campaigns/new', {
      title: 'New campaign',
      templates, savedSegments, projects, stages, sources, tags,
      filters, preview,
    });
  } catch (err) { next(err); }
});

const campaignSchema = z.object({
  name: f.requiredText(120, 'Name the campaign.'),
  channel: z.enum(['WHATSAPP', 'SMS', 'EMAIL']),
  templateId: f.objectId,
  scheduledDate: f.optionalText(10),
  scheduledTime: f.optionalText(5),
  saveSegmentAs: f.optionalText(80),
}).passthrough();

router.post('/api/campaigns/communication', requirePermission('campaign.create'), validate(campaignSchema), async (req, res, next) => {
  try {
    const filters = pickFilters(req.body);
    if (req.data.saveSegmentAs) {
      await segments.save({
        tenantId: req.tenantId, actor: req.user, name: req.data.saveSegmentAs, filters,
      });
    }
    const campaign = await campaignsService.create({
      tenantId: req.tenantId,
      actor: req.user,
      data: {
        name: req.data.name,
        channel: req.data.channel,
        templateId: req.data.templateId,
        filters,
        scheduledAt: req.data.scheduledDate
          ? tzLib.fromLocalInput(req.data.scheduledDate, req.data.scheduledTime || '10:00', res.locals.zone)
          : undefined,
      },
    });
    req.session.flash = { type: 'success', message: 'Campaign saved. Review the audience, then send.' };
    res.redirect(`/app/campaigns/${campaign._id}`);
  } catch (err) { next(err); }
});

router.get('/app/campaigns/performance', requirePermission('campaign.view_performance'), async (req, res, next) => {
  try {
    const [result, projects] = await Promise.all([
      attribution.performance({
        tenantId: req.tenantId,
        tenant: req.tenant,
        from: req.query.from,
        to: req.query.to,
        projectId: req.query.projectId,
        zone: res.locals.zone,
      }),
      Project.find({ tenantId: req.tenantId, archived: { $ne: true } }).select('name').lean(),
    ]);
    res.render('pages/campaigns/performance', { title: 'Campaign performance', ...result, projects });
  } catch (err) { next(err); }
});

const marketingSchema = z.object({
  name: f.requiredText(150, 'Name the campaign.'),
  platform: z.enum(['META', 'GOOGLE', 'LINKEDIN', 'PROPERTY_PORTAL', 'OFFLINE', 'OTHER']),
  projectId: f.optionalId,
  externalCampaignId: f.optionalText(80),
  trackingCode: f.optionalText(60),
  startDate: f.optionalText(10),
  endDate: f.optionalText(10),
  spend: f.optionalText(24),
  notes: f.optionalText(1000),
});

/** §39.4: manual campaign entry, for spend that no API will ever deliver. */
router.post('/api/campaigns/marketing', requirePermission('campaign.edit_spend'), validate(marketingSchema), async (req, res, next) => {
  try {
    await attribution.createCampaign({
      tenantId: req.tenantId,
      actor: req.user,
      data: {
        name: req.data.name,
        platform: req.data.platform,
        projectId: req.data.projectId,
        externalCampaignId: req.data.externalCampaignId,
        trackingCode: req.data.trackingCode,
        startDate: req.data.startDate ? new Date(req.data.startDate) : undefined,
        endDate: req.data.endDate ? new Date(req.data.endDate) : undefined,
        spendMinor: req.data.spend ? money.toMinor(req.data.spend) : 0,
        notes: req.data.notes,
      },
    });
    req.session.flash = { type: 'success', message: 'Campaign added.' };
    res.redirect('/app/campaigns/performance');
  } catch (err) { next(err); }
});

router.post('/api/campaigns/marketing/:id/spend', requirePermission('campaign.edit_spend'), async (req, res, next) => {
  try {
    await attribution.updateCampaign({
      tenantId: req.tenantId,
      actor: req.user,
      campaignId: req.params.id,
      data: { spendMinor: money.toMinor(req.body.spend || 0) },
    });
    req.session.flash = { type: 'success', message: 'Spend updated.' };
    res.redirect('/app/campaigns/performance');
  } catch (err) { next(err); }
});

/** §40: the tenant picks the reporting model; history is never rewritten. */
router.post('/api/campaigns/attribution', requirePermission('setup.attribution'), async (req, res, next) => {
  try {
    const model = req.body.attributionModel;
    if (!['FIRST_TOUCH', 'LAST_TOUCH'].includes(model)) throw badRequest('Choose first touch or last touch.');
    const { Tenant } = require('../db/models');
    await Tenant.updateOne({ _id: req.tenantId }, { $set: { 'settings.attributionModel': model } });
    req.session.flash = { type: 'success', message: `Reporting now uses ${model.replace('_', ' ').toLowerCase()} attribution.` };
    res.redirect('/app/campaigns/performance');
  } catch (err) { next(err); }
});

router.get('/app/campaigns/:id', requirePermission('campaign.view'), async (req, res, next) => {
  try {
    const data = await campaignsService.get({ tenantId: req.tenantId, campaignId: req.params.id });
    res.render('pages/campaigns/detail', { title: data.campaign.name, ...data });
  } catch (err) { next(err); }
});

/** §38.4: sending needs its own permission and shows the count first. */
router.post('/api/campaigns/:id/send', requirePermission('campaign.send'), async (req, res, next) => {
  try {
    const campaign = await campaignsService.send({
      tenantId: req.tenantId, actor: req.user, campaignId: req.params.id, zone: res.locals.zone,
    });
    req.session.flash = {
      type: 'success',
      message: `Sent to ${campaign.sentCount} contact(s). ${campaign.excludedCount} excluded for opt-out, ${campaign.failedCount} failed.`,
    };
    res.redirect(`/app/campaigns/${req.params.id}`);
  } catch (err) { next(err); }
});

/* ------------------------------ nurture (§19) ----------------------------- */

router.get('/app/setup/nurture', requirePermission('setup.nurture'), async (req, res, next) => {
  try {
    const [sequences, projects, stages, templates, actionTypes] = await Promise.all([
      nurture.list({ tenantId: req.tenantId }),
      Project.find({ tenantId: req.tenantId, archived: { $ne: true } }).select('name').lean(),
      Stage.find({ tenantId: req.tenantId, active: true }).select('name').sort({ displayOrder: 1 }).lean(),
      Template.find({ tenantId: req.tenantId, active: true }).select('name channel').lean(),
      ActionType.find({ tenantId: req.tenantId, active: true }).select('name').lean(),
    ]);
    res.render('pages/setup/nurture', { title: 'Nurture sequences', sequences, projects, stages, templates, actionTypes });
  } catch (err) { next(err); }
});

const sequenceSchema = z.object({
  name: f.requiredText(100, 'Name the sequence.'),
  projectId: f.optionalId,
  stageId: f.optionalId,
  stopOnBooked: f.checkbox,
  stopOnLost: f.checkbox,
}).passthrough();

router.post('/api/setup/nurture', requirePermission('setup.nurture'), validate(sequenceSchema), async (req, res, next) => {
  try {
    // Steps arrive as parallel arrays from the repeated form rows.
    const asArray = (v) => (v === undefined ? [] : (Array.isArray(v) ? v : [v]));
    const delays = asArray(req.body.stepDelay);
    const kinds = asArray(req.body.stepKind);
    const templateIds = asArray(req.body.stepTemplateId);
    const actionTypeIds = asArray(req.body.stepActionTypeId);
    const notes = asArray(req.body.stepNote);

    const steps = delays.map((delay, i) => ({
      stepNumber: i + 1,
      // A browser sends repeated fields; anything else is user error, not a crash.
      delayDays: Number.isFinite(Number(delay)) ? Number(delay) : NaN,
      kind: kinds[i] === 'TASK' ? 'TASK' : 'MESSAGE',
      templateId: kinds[i] === 'TASK' ? undefined : (templateIds[i] || undefined),
      actionTypeId: kinds[i] === 'TASK' ? (actionTypeIds[i] || undefined) : undefined,
      note: notes[i] || undefined,
    })).filter((step) => step.templateId || step.actionTypeId);

    if (steps.some((step) => !Number.isFinite(step.delayDays) || step.delayDays < 0)) {
      throw badRequest('Each step needs a whole number of days.');
    }
    if (!steps.length) throw badRequest('Add at least one step with a template or an action type.');

    await NurtureSequence.create({
      tenantId: req.tenantId,
      name: req.data.name,
      projectId: req.data.projectId || null,
      stageId: req.data.stageId || null,
      stopOnBooked: req.data.stopOnBooked,
      stopOnLost: req.data.stopOnLost,
      steps,
      createdBy: req.user._id,
    });
    req.session.flash = { type: 'success', message: 'Nurture sequence saved.' };
    res.redirect('/app/setup/nurture');
  } catch (err) {
    next(err.code === 11000 ? badRequest('A sequence with that name already exists.') : err);
  }
});

router.post('/api/setup/nurture/:id/toggle', requirePermission('setup.nurture'), async (req, res, next) => {
  try {
    const sequence = await NurtureSequence.findOne({ tenantId: req.tenantId, _id: req.params.id });
    if (!sequence) throw badRequest('Sequence not found.');
    sequence.active = !sequence.active;
    await sequence.save();
    res.redirect('/app/setup/nurture');
  } catch (err) { next(err); }
});

module.exports = router;
