const crypto = require('node:crypto');
const express = require('express');
const { z } = require('zod');
const { requireAuth, requirePermission } = require('../middleware/auth');
const validate = require('../middleware/validate');
const f = require('../lib/fields');
const { badRequest, notFound } = require('../lib/errors');
const {
  Tenant, SlaRule, Template, AckRule, Integration, Project, LeadSource, User, WebhookEvent,
} = require('../db/models');
const audit = require('../services/audit');
const secretbox = require('../lib/secretbox');
const config = require('../config');

/**
 * Setup screens for the operational rules: §16 SLA, §17 acknowledgement
 * templates and §49 integrations. Kept out of routes/setup.js so that file
 * stays about masters and people.
 */
const router = express.Router();
router.use('/app/setup', requireAuth);
router.use('/api/setup', requireAuth);

/* ----------------------------------- SLA ---------------------------------- */

router.get('/app/setup/sla', requirePermission('setup.sla'), async (req, res, next) => {
  try {
    const [tenant, rules, projects, users] = await Promise.all([
      Tenant.findById(req.tenantId).lean(),
      SlaRule.find({ tenantId: req.tenantId }).populate('projectId', 'name').sort({ createdAt: 1 }).lean(),
      Project.find({ tenantId: req.tenantId, archived: { $ne: true } }).select('name').sort({ name: 1 }).lean(),
      User.find({ tenantId: req.tenantId, status: 'ACTIVE' }).select('name').sort({ name: 1 }).lean(),
    ]);
    res.render('pages/setup/sla', { title: 'Response SLA', org: tenant, rules, projects, users });
  } catch (err) { next(err); }
});

const slaDefaultsSchema = z.object({
  slaResponseMinutes: z.coerce.number().int().min(1).max(1440),
  slaWarningMinutes: z.coerce.number().int().min(1).max(1440),
  slaEscalationMinutes: z.coerce.number().int().min(1).max(1440),
  slaAutoReassignMinutes: z.coerce.number().int().min(1).max(1440),
  slaMaxAutoReassignments: z.coerce.number().int().min(0).max(10),
  slaBusinessHoursOnly: f.checkbox,
  businessStart: f.optionalText(5),
  businessEnd: f.optionalText(5),
  reinquiryRestartsSla: f.checkbox,
});

router.post('/api/setup/sla/defaults', requirePermission('setup.sla'), validate(slaDefaultsSchema), async (req, res, next) => {
  try {
    const d = req.data;
    if (d.slaWarningMinutes > d.slaEscalationMinutes || d.slaEscalationMinutes > d.slaAutoReassignMinutes) {
      throw badRequest('Thresholds must run in order: warning ≤ escalation ≤ auto-reassign.');
    }
    const tenant = await Tenant.findById(req.tenantId);
    const before = { ...tenant.settings.toObject?.() ?? tenant.settings };
    Object.assign(tenant.settings, {
      slaResponseMinutes: d.slaResponseMinutes,
      slaWarningMinutes: d.slaWarningMinutes,
      slaEscalationMinutes: d.slaEscalationMinutes,
      slaAutoReassignMinutes: d.slaAutoReassignMinutes,
      slaMaxAutoReassignments: d.slaMaxAutoReassignments,
      slaBusinessHoursOnly: d.slaBusinessHoursOnly,
      reinquiryRestartsSla: d.reinquiryRestartsSla,
    });
    if (d.businessStart) tenant.settings.businessHours.start = d.businessStart;
    if (d.businessEnd) tenant.settings.businessHours.end = d.businessEnd;
    await tenant.save();

    await audit.record({
      tenantId: req.tenantId, actor: req.user, entity: 'Tenant', entityId: tenant._id,
      action: 'SLA_SETTINGS_CHANGE', before, after: tenant.settings, req,
    });
    req.session.flash = { type: 'success', message: 'SLA settings updated.' };
    res.redirect('/app/setup/sla');
  } catch (err) { next(err); }
});

const slaRuleSchema = z.object({
  projectId: f.objectId,
  responseMinutes: z.coerce.number().int().min(1),
  warningMinutes: z.coerce.number().int().min(1),
  escalationMinutes: z.coerce.number().int().min(1),
  autoReassignMinutes: z.coerce.number().int().min(1),
  maxAutoReassignments: z.coerce.number().int().min(0),
  businessHoursOnly: f.checkbox,
  escalationUserIds: f.stringList,
});

router.post('/api/setup/sla/rules', requirePermission('setup.sla'), validate(slaRuleSchema), async (req, res, next) => {
  try {
    const project = await Project.findOne({ tenantId: req.tenantId, _id: req.data.projectId }).lean();
    if (!project) throw badRequest('Choose a valid project.');
    await SlaRule.findOneAndUpdate(
      { tenantId: req.tenantId, projectId: project._id },
      { tenantId: req.tenantId, ...req.data, name: `${project.name} override`, active: true, createdBy: req.user._id },
      { upsert: true, returnDocument: 'after' },
    );
    req.session.flash = { type: 'success', message: 'Project SLA override saved.' };
    res.redirect('/app/setup/sla');
  } catch (err) { next(err); }
});

router.post('/api/setup/sla/rules/:id/toggle', requirePermission('setup.sla'), async (req, res, next) => {
  try {
    const rule = await SlaRule.findOne({ tenantId: req.tenantId, _id: req.params.id });
    if (!rule) throw notFound('Rule not found.');
    rule.active = !rule.active;
    await rule.save();
    res.redirect('/app/setup/sla');
  } catch (err) { next(err); }
});

/* --------------------- V1.1 §66–§76: lead allocation ---------------------- */

router.get('/app/setup/lead-allocation', requirePermission('setup.distribution'), async (req, res, next) => {
  try {
    const allocation = require('../services/allocation');
    const [pools, projects, users] = await Promise.all([
      allocation.overview({ tenantId: req.tenantId }),
      Project.find({ tenantId: req.tenantId, archived: { $ne: true } }).select('name').sort({ name: 1 }).lean(),
      User.find({ tenantId: req.tenantId, status: 'ACTIVE' }).select('name email').sort({ name: 1 }).lean(),
    ]);
    res.render('pages/setup/lead-allocation', {
      title: 'Lead allocation',
      pools,
      projects,
      users,
      defaultPool: pools.find((p) => p.isDefault) || null,
    });
  } catch (err) { next(err); }
});

const poolSchema = z.object({
  name: f.requiredText(80, 'Name this pool.'),
  scopeType: z.enum(['DEFAULT', 'PROJECT']).default('PROJECT'),
  projectId: f.optionalId,
  memberUserIds: f.stringList,
  escalationUserIds: f.stringList,
}).passthrough();

router.post('/api/setup/assignment-pools', requirePermission('setup.distribution'), validate(poolSchema), async (req, res, next) => {
  try {
    await require('../services/allocation').create({ tenantId: req.tenantId, actor: req.user, data: req.data });
    req.session.flash = { type: 'success', message: 'Allocation rule created.' };
    res.redirect('/app/setup/lead-allocation');
  } catch (err) { next(err); }
});

router.post('/api/setup/assignment-pools/:id', requirePermission('setup.distribution'), validate(poolSchema), async (req, res, next) => {
  try {
    await require('../services/allocation').update({
      tenantId: req.tenantId, actor: req.user, poolId: req.params.id, data: req.data,
    });
    req.session.flash = { type: 'success', message: 'Allocation rule saved.' };
    res.redirect('/app/setup/lead-allocation');
  } catch (err) { next(err); }
});

router.post('/api/setup/assignment-pools/:id/toggle', requirePermission('setup.distribution'), async (req, res, next) => {
  try {
    await require('../services/allocation').toggle({ tenantId: req.tenantId, actor: req.user, poolId: req.params.id });
    res.redirect('/app/setup/lead-allocation');
  } catch (err) { next(err); }
});

router.post('/api/setup/assignment-pools/:id/reorder', requirePermission('setup.distribution'), async (req, res, next) => {
  try {
    const raw = req.body.memberUserIds;
    await require('../services/allocation').reorder({
      tenantId: req.tenantId,
      actor: req.user,
      poolId: req.params.id,
      memberUserIds: Array.isArray(raw) ? raw : String(raw || '').split(',').filter(Boolean),
    });
    req.session.flash = { type: 'success', message: 'Rotation order updated.' };
    res.redirect('/app/setup/lead-allocation');
  } catch (err) { next(err); }
});

/* ------------------------- templates + acknowledgement -------------------- */

router.get('/app/setup/templates', requirePermission('setup.templates'), async (req, res, next) => {
  try {
    const [templates, ackRules, projects, sources] = await Promise.all([
      Template.find({ tenantId: req.tenantId }).sort({ channel: 1, name: 1 }).lean(),
      AckRule.find({ tenantId: req.tenantId })
        .populate('projectId', 'name').populate('sourceId', 'name').populate('templateId', 'name channel')
        .sort({ createdAt: 1 }).lean(),
      Project.find({ tenantId: req.tenantId, archived: { $ne: true } }).select('name').sort({ name: 1 }).lean(),
      LeadSource.find({ tenantId: req.tenantId, active: true }).select('name').sort({ name: 1 }).lean(),
    ]);
    res.render('pages/setup/templates', { title: 'Templates & acknowledgement', templates, ackRules, projects, sources });
  } catch (err) { next(err); }
});

const templateSchema = z.object({
  name: f.requiredText(100, 'Enter a template name.'),
  channel: z.enum(['WHATSAPP', 'SMS', 'EMAIL']),
  purpose: z.enum(['ACKNOWLEDGEMENT', 'CAMPAIGN', 'NURTURE', 'GENERAL']),
  subject: f.optionalText(200),
  body: f.requiredText(4000, 'Write the message body.'),
});

router.post('/api/setup/templates', requirePermission('setup.templates'), validate(templateSchema), async (req, res, next) => {
  try {
    await Template.create({ tenantId: req.tenantId, ...req.data, createdBy: req.user._id });
    req.session.flash = { type: 'success', message: 'Template saved.' };
    res.redirect('/app/setup/templates');
  } catch (err) {
    next(err.code === 11000 ? badRequest('A template with that name already exists.') : err);
  }
});

router.post('/api/setup/templates/:id', requirePermission('setup.templates'), validate(templateSchema), async (req, res, next) => {
  try {
    const template = await Template.findOne({ tenantId: req.tenantId, _id: req.params.id });
    if (!template) throw notFound('Template not found.');
    Object.assign(template, req.data);
    await template.save();
    req.session.flash = { type: 'success', message: 'Template updated.' };
    res.redirect('/app/setup/templates');
  } catch (err) { next(err); }
});

const ackRuleSchema = z.object({
  projectId: f.optionalId,
  sourceId: f.optionalId,
  channel: z.enum(['WHATSAPP', 'SMS', 'EMAIL']),
  templateId: f.objectId,
  fallbackChannel: f.enumField(['WHATSAPP', 'SMS', 'EMAIL']),
  fallbackTemplateId: f.optionalId,
  sendDelayMinutes: z.coerce.number().int().min(0).default(0),
});

router.post('/api/setup/ack-rules', requirePermission('setup.templates'), validate(ackRuleSchema), async (req, res, next) => {
  try {
    const template = await Template.findOne({ tenantId: req.tenantId, _id: req.data.templateId, active: true }).lean();
    if (!template) throw badRequest('Choose an active template.');
    if (template.channel !== req.data.channel) throw badRequest('The template channel must match the rule channel.');
    await AckRule.create({ tenantId: req.tenantId, ...req.data, projectId: req.data.projectId || null, sourceId: req.data.sourceId || null });
    req.session.flash = { type: 'success', message: 'Acknowledgement rule saved.' };
    res.redirect('/app/setup/templates');
  } catch (err) { next(err); }
});

router.post('/api/setup/ack-rules/:id/toggle', requirePermission('setup.templates'), async (req, res, next) => {
  try {
    const rule = await AckRule.findOne({ tenantId: req.tenantId, _id: req.params.id });
    if (!rule) throw notFound('Rule not found.');
    rule.active = !rule.active;
    await rule.save();
    res.redirect('/app/setup/templates');
  } catch (err) { next(err); }
});

/* ------------------------------- integrations ----------------------------- */

router.get('/app/setup/integrations', requirePermission('setup.integrations'), async (req, res, next) => {
  try {
    const [integrations, projects, sources, failures] = await Promise.all([
      Integration.find({ tenantId: req.tenantId })
        .populate('defaultProjectId', 'name').populate('defaultSourceId', 'name').sort({ category: 1 }).lean(),
      Project.find({ tenantId: req.tenantId, archived: { $ne: true } }).select('name').sort({ name: 1 }).lean(),
      LeadSource.find({ tenantId: req.tenantId, active: true }).select('name').sort({ name: 1 }).lean(),
      WebhookEvent.countDocuments({ tenantId: req.tenantId, status: 'FAILED' }),
    ]);
    res.render('pages/setup/integrations', {
      title: 'Integrations',
      integrations,
      projects,
      sources,
      failures,
      appUrl: config.appUrl,
      categories: Integration.CATEGORIES,
    });
  } catch (err) { next(err); }
});

const integrationSchema = z.object({
  category: z.enum(Integration.CATEGORIES),
  provider: f.requiredText(60, 'Name the provider.'),
  name: f.optionalText(100),
  defaultProjectId: f.optionalId,
  defaultSourceId: f.optionalId,
  signingSecret: f.optionalText(200),
});

router.post('/api/setup/integrations', requirePermission('setup.integrations'), validate(integrationSchema), async (req, res, next) => {
  try {
    const inbound = ['META_LEAD_ADS', 'GOOGLE_ADS', 'LINKEDIN_ADS', 'PROPERTY_PORTAL', 'WEBSITE_WEBHOOK'].includes(req.data.category);
    const doc = {
      tenantId: req.tenantId,
      category: req.data.category,
      provider: req.data.provider,
      name: req.data.name || req.data.provider,
      defaultProjectId: req.data.defaultProjectId,
      defaultSourceId: req.data.defaultSourceId,
      connectedBy: req.user._id,
      connectedAt: new Date(),
      webhookKey: inbound ? crypto.randomBytes(18).toString('base64url') : undefined,
    };
    // §49.1: the secret is sealed on the way in and never rendered again.
    if (req.data.signingSecret) doc.secrets = { signingSecret: secretbox.seal(req.data.signingSecret) };

    const created = await Integration.create(doc);
    await audit.record({
      tenantId: req.tenantId, actor: req.user, entity: 'Integration', entityId: created._id,
      action: 'CREATE', after: { category: created.category, provider: created.provider }, req,
    });
    req.session.flash = { type: 'success', message: 'Integration added.' };
    res.redirect('/app/setup/integrations');
  } catch (err) { next(err); }
});

router.post('/api/setup/integrations/:id/rotate-key', requirePermission('setup.integrations'), async (req, res, next) => {
  try {
    const integration = await Integration.findOne({ tenantId: req.tenantId, _id: req.params.id });
    if (!integration) throw notFound('Integration not found.');
    integration.webhookKey = crypto.randomBytes(18).toString('base64url');
    await integration.save();
    await audit.record({
      tenantId: req.tenantId, actor: req.user, entity: 'Integration', entityId: integration._id,
      action: 'ROTATE_WEBHOOK_KEY', req,
    });
    req.session.flash = { type: 'success', message: 'Webhook key rotated. Update the provider with the new URL.' };
    res.redirect('/app/setup/integrations');
  } catch (err) { next(err); }
});

/**
 * V1.1 §64: the test console.
 *
 * There is deliberately no dry-run mode. A capture that does not assign, does not
 * acknowledge and does not appear on a dashboard proves nothing about the thing
 * you are trying to test — so this sends a genuine delivery through the real
 * capture path, and the UI says so in as many words before you press it.
 */
router.post('/api/setup/integrations/:id/test', requirePermission('setup.integrations'), async (req, res, next) => {
  try {
    const integration = await Integration.findOne({ tenantId: req.tenantId, _id: req.params.id }).lean();
    if (!integration) throw notFound('Integration not found.');
    if (!integration.webhookKey) throw badRequest('This integration has no inbound endpoint.');

    const result = await require('../services/capture').handleInquiry({
      tenantId: req.tenantId,
      tenant: req.tenant,
      actor: req.user,
      createdVia: `TEST:${integration.provider}`,
      payload: {
        name: req.body.name || 'API Test Lead',
        mobile: req.body.mobile,
        sourceId: integration.defaultSourceId,
        projectId: integration.defaultProjectId,
        sourceDetail: 'Integration test console',
        message: 'Created from the integration test console.',
      },
    });

    const lead = await require('../db/models').Lead.findOne({ tenantId: req.tenantId, _id: result.lead._id })
      .populate('ownerUserId', 'name').populate('latestSourceId', 'name').populate('projectId', 'name')
      .lean();

    req.session.flash = {
      type: 'success',
      message: `Test lead created — ${result.isReinquiry ? 're-inquiry on an existing lead' : 'new lead'}`
        + ` · source ${lead.latestSourceId?.name || 'unresolved'}`
        + ` · project ${lead.projectId?.name || 'none'}`
        + ` · owner ${lead.ownerUserId?.name || 'unassigned'}`,
      details: { leadId: String(lead._id), contactId: String(result.contact._id) },
    };
    res.redirect('/app/setup/integrations');
  } catch (err) { next(err); }
});

router.post('/api/setup/integrations/:id/toggle', requirePermission('setup.integrations'), async (req, res, next) => {
  try {
    const integration = await Integration.findOne({ tenantId: req.tenantId, _id: req.params.id });
    if (!integration) throw notFound('Integration not found.');
    integration.active = !integration.active;
    integration.status = integration.active ? 'CONNECTED' : 'DISABLED';
    await integration.save();
    res.redirect('/app/setup/integrations');
  } catch (err) { next(err); }
});

module.exports = router;
