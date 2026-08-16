const express = require('express');
const { z } = require('zod');
const { requireAuth, requirePermission } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { badRequest, notFound, forbidden } = require('../lib/errors');
const permissionsCatalog = require('../lib/permissions');
const phone = require('../lib/phone');
const {
  User, Role, Stage, SubStage, ActionType, VisitOutcome, LeadSource, Tag, Tenant, Lead, Followup,
} = require('../db/models');
const authService = require('../services/auth');
const audit = require('../services/audit');
const config = require('../config');

const router = express.Router();
router.use('/app/setup', requireAuth);
router.use('/api/setup', requireAuth);

/**
 * Spec §47. The four flat masters below differ only in labels, so they share one
 * CRUD implementation rather than four near-identical route files.
 * Stages, users, roles and the organization have real behaviour and keep their own.
 */
const MASTERS = {
  'action-types': {
    model: ActionType, label: 'Action types', singular: 'Action type', permission: 'setup.action_types',
    help: 'The follow-up actions your team can schedule (§18.2).',
    extra: { key: 'semantic', label: 'Behaviour', options: ['CALL', 'WHATSAPP', 'MEETING', 'SITE_VISIT', 'COST_SHEET', 'BROCHURE', 'VIDEO_CALL', 'EMAIL', 'OTHER'] },
  },
  'visit-outcomes': {
    model: VisitOutcome, label: 'Visit outcomes', singular: 'Visit outcome', permission: 'setup.visit_outcomes',
    help: 'Required when a site visit is completed (§24.2).',
  },
  sources: {
    model: LeadSource, label: 'Lead sources', singular: 'Lead source', permission: 'setup.sources',
    help: 'Where your leads come from. The category drives capture and reporting (§12.1).',
    extra: { key: 'category', label: 'Category', options: LeadSource.CATEGORIES },
  },
  tags: {
    model: Tag, label: 'Contact tags', singular: 'Tag', permission: 'setup.tags',
    help: 'Dynamic tags for segmenting the contact book (§9.3).',
  },
};

// Express 5 has no inline regex in paths, so unknown masters fall through to
// the dedicated routes below via next().
router.get('/app/setup/:master', async (req, res, next) => {
  try {
    const spec = MASTERS[req.params.master];
    if (!spec) return next();
    requireCan(req, spec.permission);
    const items = await spec.model.find({ tenantId: req.tenantId }).sort({ displayOrder: 1, name: 1 }).lean();
    res.render('pages/setup/master', { title: spec.label, slug: req.params.master, spec, items });
  } catch (err) { next(err); }
});

router.post('/api/setup/:master', async (req, res, next) => {
  try {
    const spec = MASTERS[req.params.master];
    if (!spec) return next();
    requireCan(req, spec.permission);
    const name = String(req.body.name || '').trim();
    if (!name) throw badRequest('Enter a name.');

    const doc = { tenantId: req.tenantId, name, displayOrder: Number(req.body.displayOrder || 0) };
    if (spec.extra) doc[spec.extra.key] = req.body[spec.extra.key];
    if (spec.model === Tag) doc.createdBy = req.user._id;

    const created = await spec.model.create(doc);
    await audit.record({ tenantId: req.tenantId, actor: req.user, entity: spec.model.modelName, entityId: created._id, action: 'CREATE', after: doc, req });
    req.session.flash = { type: 'success', message: `${spec.singular} added.` };
    res.redirect(`/app/setup/${req.params.master}`);
  } catch (err) {
    next(err.code === 11000 ? badRequest('That name is already in use.') : err);
  }
});

/** §95: masters that appear in history are deactivated, never deleted. */
router.post('/api/setup/:master/:id/toggle', async (req, res, next) => {
  try {
    const spec = MASTERS[req.params.master];
    if (!spec) return next();
    requireCan(req, spec.permission);
    const item = await spec.model.findOne({ tenantId: req.tenantId, _id: req.params.id });
    if (!item) throw notFound('That record no longer exists.');
    item.active = !item.active;
    await item.save();
    await audit.record({ tenantId: req.tenantId, actor: req.user, entity: spec.model.modelName, entityId: item._id, action: item.active ? 'ACTIVATE' : 'DEACTIVATE', req });
    res.redirect(`/app/setup/${req.params.master}`);
  } catch (err) { next(err); }
});

/* --------------------------------- stages -------------------------------- */

router.get('/app/setup/stages', requirePermission('setup.stages'), async (req, res, next) => {
  try {
    const [stages, subStages, actionTypes] = await Promise.all([
      Stage.find({ tenantId: req.tenantId }).sort({ displayOrder: 1 }).lean(),
      SubStage.find({ tenantId: req.tenantId }).sort({ displayOrder: 1 }).lean(),
      ActionType.find({ tenantId: req.tenantId, active: true }).sort({ name: 1 }).lean(),
    ]);
    res.render('pages/setup/stages', {
      title: 'Lead stages',
      stages,
      subStages,
      actionTypes,
      semanticTypes: Stage.SEMANTIC_TYPES,
    });
  } catch (err) { next(err); }
});

const stageSchema = z.object({
  name: z.string().trim().min(1, 'Enter a stage name.').max(60),
  semanticType: z.enum(Stage.SEMANTIC_TYPES),
  displayOrder: z.coerce.number().int().min(0).default(0),
  colorToken: z.string().trim().max(20).default('slate'),
  terminal: z.coerce.boolean().default(false),
  requiresSubStage: z.coerce.boolean().default(false),
  requiresNextAction: z.coerce.boolean().default(true),
});

router.post('/api/setup/stages', requirePermission('setup.stages'), validate(stageSchema), async (req, res, next) => {
  try {
    // §11.5: a terminal stage must not demand a next action.
    const payload = { ...req.data, requiresNextAction: req.data.terminal ? false : req.data.requiresNextAction };
    const stage = await Stage.create({ tenantId: req.tenantId, ...payload, createdBy: req.user._id });
    await audit.record({ tenantId: req.tenantId, actor: req.user, entity: 'Stage', entityId: stage._id, action: 'CREATE', after: payload, req });
    req.session.flash = { type: 'success', message: 'Stage added.' };
    res.redirect('/app/setup/stages');
  } catch (err) {
    next(err.code === 11000 ? badRequest('A stage with that name already exists.') : err);
  }
});

router.post('/api/setup/stages/:id', requirePermission('setup.stages'), validate(stageSchema), async (req, res, next) => {
  try {
    const stage = await Stage.findOne({ tenantId: req.tenantId, _id: req.params.id });
    if (!stage) throw notFound('Stage not found.');
    const before = stage.toObject();
    Object.assign(stage, req.data, { requiresNextAction: req.data.terminal ? false : req.data.requiresNextAction, updatedBy: req.user._id });
    await stage.save();
    await audit.record({ tenantId: req.tenantId, actor: req.user, entity: 'Stage', entityId: stage._id, action: 'UPDATE', ...audit.diff(before, stage.toObject()), req });
    req.session.flash = { type: 'success', message: 'Stage updated.' };
    res.redirect('/app/setup/stages');
  } catch (err) { next(err); }
});

/** §95: a stage that has been used is deactivated, never deleted. */
router.post('/api/setup/stages/:id/toggle', requirePermission('setup.stages'), async (req, res, next) => {
  try {
    const stage = await Stage.findOne({ tenantId: req.tenantId, _id: req.params.id });
    if (!stage) throw notFound('Stage not found.');
    if (stage.active) {
      const inUse = await Lead.countDocuments({ tenantId: req.tenantId, stageId: stage._id, status: 'ACTIVE' });
      if (inUse) throw badRequest(`${inUse} active lead(s) still sit in this stage. Move them first.`);
    }
    stage.active = !stage.active;
    await stage.save();
    req.session.flash = { type: 'success', message: `Stage ${stage.active ? 'activated' : 'deactivated'}.` };
    res.redirect('/app/setup/stages');
  } catch (err) { next(err); }
});

const subStageSchema = z.object({
  stageId: z.string().regex(/^[a-f\d]{24}$/i),
  name: z.string().trim().min(1, 'Enter a sub-stage name.').max(60),
  displayOrder: z.coerce.number().int().min(0).default(0),
  defaultActionTypeId: z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(/^[a-f\d]{24}$/i).optional()),
  defaultFollowupOffsetHours: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().min(0).optional()),
  requiresNote: z.coerce.boolean().default(false),
});

router.post('/api/setup/sub-stages', requirePermission('setup.substages', 'setup.stages'), validate(subStageSchema), async (req, res, next) => {
  try {
    const stage = await Stage.findOne({ tenantId: req.tenantId, _id: req.data.stageId }).lean();
    if (!stage) throw badRequest('Select a valid stage.');
    await SubStage.create({ tenantId: req.tenantId, ...req.data });
    req.session.flash = { type: 'success', message: 'Sub-stage added.' };
    res.redirect('/app/setup/stages');
  } catch (err) {
    next(err.code === 11000 ? badRequest('That sub-stage already exists for this stage.') : err);
  }
});

router.post('/api/setup/sub-stages/:id/toggle', requirePermission('setup.substages', 'setup.stages'), async (req, res, next) => {
  try {
    const sub = await SubStage.findOne({ tenantId: req.tenantId, _id: req.params.id });
    if (!sub) throw notFound('Sub-stage not found.');
    sub.active = !sub.active;
    await sub.save();
    res.redirect('/app/setup/stages');
  } catch (err) { next(err); }
});

/* ---------------------------------- users -------------------------------- */

router.get('/app/setup/users', requirePermission('setup.users'), async (req, res, next) => {
  try {
    const [users, roles] = await Promise.all([
      User.find({ tenantId: req.tenantId }).populate('roleId', 'name').populate('managerId', 'name').sort({ name: 1 }).lean(),
      Role.find({ tenantId: req.tenantId, active: true }).sort({ name: 1 }).lean(),
    ]);
    res.render('pages/setup/users', {
      title: 'Users',
      users,
      roles,
      inviteLink: req.session.inviteLink || null,
      appUrl: config.appUrl,
    });
    delete req.session.inviteLink;
  } catch (err) { next(err); }
});

const inviteSchema = z.object({
  name: z.string().trim().min(2, 'Enter the full name.').max(100),
  email: z.string().trim().email('Enter a valid email address.'),
  mobile: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().optional()),
  roleId: z.string().regex(/^[a-f\d]{24}$/i, 'Select a role.'),
  managerId: z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(/^[a-f\d]{24}$/i).optional()),
});

router.post('/api/setup/users', requirePermission('setup.users'), validate(inviteSchema), async (req, res, next) => {
  try {
    const role = await Role.findOne({ tenantId: req.tenantId, _id: req.data.roleId, active: true }).lean();
    if (!role) throw badRequest('Select an active role.');

    const user = await User.create({
      tenantId: req.tenantId,
      name: req.data.name,
      email: req.data.email.toLowerCase(),
      mobile: req.data.mobile,
      normalizedMobile: req.data.mobile ? phone.normalizeMobile(req.data.mobile, req.tenant.callingCode) : undefined,
      roleId: role._id,
      managerId: req.data.managerId,
      status: 'INVITED',
    });
    const token = await authService.createInviteToken(user);
    // No email provider is configured yet, so the invite link is handed to the
    // admin to share rather than being silently dropped (§17.4 behaviour).
    req.session.inviteLink = `${config.appUrl}/accept-invite?token=${token}`;
    await audit.record({ tenantId: req.tenantId, actor: req.user, entity: 'User', entityId: user._id, action: 'INVITE', after: { email: user.email, roleId: role._id }, req });
    req.session.flash = { type: 'success', message: `${user.name} invited. Share the activation link below.` };
    res.redirect('/app/setup/users');
  } catch (err) {
    next(err.code === 11000 ? badRequest('A user with that email already exists in this organization.') : err);
  }
});

/** §5.2 / §95: users with history are deactivated, never deleted. */
router.post('/api/setup/users/:id/status', requirePermission('setup.users'), async (req, res, next) => {
  try {
    const status = req.body.status;
    if (!['ACTIVE', 'SUSPENDED', 'INACTIVE'].includes(status)) throw badRequest('Choose a valid status.');
    const user = await User.findOne({ tenantId: req.tenantId, _id: req.params.id });
    if (!user) throw notFound('User not found.');
    if (String(user._id) === String(req.user._id)) throw badRequest('You cannot change your own status.');

    if (status !== 'ACTIVE') {
      // §102 "Owner Deactivated": never orphan open work silently.
      const openLeads = await Lead.countDocuments({ tenantId: req.tenantId, ownerUserId: user._id, status: 'ACTIVE' });
      const openFollowups = await Followup.countDocuments({ tenantId: req.tenantId, assignedUserId: user._id, status: 'PENDING' });
      if (openLeads || openFollowups) {
        throw badRequest(`${user.name} still owns ${openLeads} active lead(s) and ${openFollowups} pending follow-up(s). Transfer them first.`);
      }
    }
    const before = user.status;
    user.status = status;
    await user.save();
    await audit.record({ tenantId: req.tenantId, actor: req.user, entity: 'User', entityId: user._id, action: 'STATUS_CHANGE', before: { status: before }, after: { status }, req });
    req.session.flash = { type: 'success', message: `${user.name} is now ${status.toLowerCase()}.` };
    res.redirect('/app/setup/users');
  } catch (err) { next(err); }
});

router.post('/api/setup/users/:id/role', requirePermission('setup.users'), async (req, res, next) => {
  try {
    const role = await Role.findOne({ tenantId: req.tenantId, _id: req.body.roleId, active: true }).lean();
    if (!role) throw badRequest('Select an active role.');
    const user = await User.findOne({ tenantId: req.tenantId, _id: req.params.id });
    if (!user) throw notFound('User not found.');
    const before = user.roleId;
    user.roleId = role._id;
    user.managerId = req.body.managerId || undefined;
    await user.save();
    await audit.record({ tenantId: req.tenantId, actor: req.user, entity: 'User', entityId: user._id, action: 'ROLE_CHANGE', before: { roleId: before }, after: { roleId: role._id }, req });
    req.session.flash = { type: 'success', message: 'User updated.' };
    res.redirect('/app/setup/users');
  } catch (err) { next(err); }
});

/* ---------------------------------- roles -------------------------------- */

router.get('/app/setup/roles', requirePermission('setup.roles'), async (req, res, next) => {
  try {
    const roles = await Role.find({ tenantId: req.tenantId }).sort({ name: 1 }).lean();
    const counts = await User.aggregate([
      { $match: { tenantId: req.user.tenantId } },
      { $group: { _id: '$roleId', count: { $sum: 1 } } },
    ]);
    const countByRole = Object.fromEntries(counts.map((c) => [String(c._id), c.count]));
    res.render('pages/setup/roles', { title: 'Roles & permissions', roles, countByRole });
  } catch (err) { next(err); }
});

router.get('/app/setup/roles/:id', requirePermission('setup.roles'), async (req, res, next) => {
  try {
    const role = await Role.findOne({ tenantId: req.tenantId, _id: req.params.id }).lean();
    if (!role) throw notFound('Role not found.');
    res.render('pages/setup/role-edit', {
      title: role.name,
      role,
      catalog: permissionsCatalog.CATALOG,
      isScoped: permissionsCatalog.isScoped,
    });
  } catch (err) { next(err); }
});

router.post('/api/setup/roles', requirePermission('setup.roles'), async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) throw badRequest('Enter a role name.');
    let permissions = {};
    if (req.body.cloneFromId) {
      const source = await Role.findOne({ tenantId: req.tenantId, _id: req.body.cloneFromId }).lean();
      if (source) permissions = source.permissions || {};
    }
    const role = await Role.create({
      tenantId: req.tenantId, name, description: req.body.description, permissions, createdBy: req.user._id,
    });
    await audit.record({ tenantId: req.tenantId, actor: req.user, entity: 'Role', entityId: role._id, action: 'CREATE', after: { name }, req });
    res.redirect(`/app/setup/roles/${role._id}`);
  } catch (err) {
    next(err.code === 11000 ? badRequest('A role with that name already exists.') : err);
  }
});

router.post('/api/setup/roles/:id', requirePermission('setup.roles'), async (req, res, next) => {
  try {
    const role = await Role.findOne({ tenantId: req.tenantId, _id: req.params.id });
    if (!role) throw notFound('Role not found.');
    const before = { permissions: role.permissions, name: role.name };

    const next$ = {};
    for (const key of permissionsCatalog.KEYS) {
      const raw = req.body[`perm.${key}`];
      if (raw === undefined || raw === '' || raw === 'none') continue;
      next$[key] = permissionsCatalog.isScoped(key) ? raw : true;
    }
    role.permissions = next$;
    if (req.body.name) role.name = String(req.body.name).trim();
    if (req.body.description !== undefined) role.description = req.body.description;
    role.updatedBy = req.user._id;
    await role.save();

    await audit.record({
      tenantId: req.tenantId, actor: req.user, entity: 'Role', entityId: role._id,
      action: 'PERMISSIONS_CHANGE', before, after: { permissions: next$, name: role.name }, req,
    });
    req.session.flash = { type: 'success', message: 'Role updated.' };
    res.redirect(`/app/setup/roles/${role._id}`);
  } catch (err) { next(err); }
});

/* ------------------------------ organization ------------------------------ */

router.get('/app/setup/organization', requirePermission('setup.organization'), async (req, res, next) => {
  try {
    const tenant = await Tenant.findById(req.tenantId).lean();
    res.render('pages/setup/organization', { title: 'Organization', org: tenant });
  } catch (err) { next(err); }
});

const orgSchema = z.object({
  name: z.string().trim().min(2).max(120),
  legalName: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().max(150).optional()),
  timezone: z.string().trim().min(1),
  currency: z.string().trim().min(3).max(3),
  locale: z.string().trim().min(2).max(10),
  website: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().url('Enter a valid URL.').optional()),
  address: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().max(500).optional()),
});

router.post('/api/setup/organization', requirePermission('setup.organization'), validate(orgSchema), async (req, res, next) => {
  try {
    const tenant = await Tenant.findById(req.tenantId);
    const before = tenant.toObject();
    Object.assign(tenant, req.data);
    await tenant.save();
    await audit.record({ tenantId: req.tenantId, actor: req.user, entity: 'Tenant', entityId: tenant._id, action: 'UPDATE', ...audit.diff(before, tenant.toObject(), Object.keys(req.data)), req });
    req.session.flash = { type: 'success', message: 'Organization updated.' };
    res.redirect('/app/setup/organization');
  } catch (err) { next(err); }
});

/** A permission failure is a 403, not a bad request (§68, §74). */
function requireCan(req, key) {
  const { can } = require('../lib/access');
  if (!can(req.user, key)) throw forbidden('You do not have permission to open this setup screen.');
}

module.exports = router;
