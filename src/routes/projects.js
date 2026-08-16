const express = require('express');
const { z } = require('zod');
const { requireAuth, requirePermission } = require('../middleware/auth');
const validate = require('../middleware/validate');
const f = require('../lib/fields');
const config = require('../config');
const { Project } = require('../db/models');
const projectsService = require('../services/projects');
const inventoryService = require('../services/inventory');

const router = express.Router();
router.use('/app/projects', requireAuth);
router.use('/api/projects', requireAuth);

/** Spec §26: project setup powers inventory, pricing, the mini site and AI. */
const projectSchema = z.object({
  name: f.requiredText(150, 'Enter the project name.'),
  developerName: f.optionalText(120),
  code: f.optionalText(20),
  status: f.enumField(['DRAFT', 'ACTIVE', 'ON_HOLD', 'SOLD_OUT', 'ARCHIVED']),
  reraNumber: f.optionalText(60),
  reraUrl: f.optionalText(300),
  projectType: f.enumField(['RESIDENTIAL', 'COMMERCIAL', 'PLOTTING', 'VILLA', 'MIXED_USE']),
  propertyTypes: f.stringList,
  address: f.optionalText(500),
  landmark: f.optionalText(150),
  city: f.optionalText(80),
  state: f.optionalText(80),
  pincode: f.optionalText(12),
  latitude: f.optionalNumber,
  longitude: f.optionalNumber,
  mapUrl: f.optionalText(300),
  startingPriceMinor: f.moneyAmount,
  priceRangeMaxMinor: f.moneyAmount,
  configurations: f.stringList,
  areaMin: f.optionalNumber,
  areaMax: f.optionalNumber,
  possessionDate: f.optionalText(10),
  salesContactName: f.optionalText(100),
  salesContactMobile: f.optionalText(20),
  bookingTerms: f.optionalText(2000),
  keyUsps: f.stringList,
  overview: f.optionalText(5000),
  amenities: f.stringList,
  highlights: f.stringList,
});

const toProjectData = (data) => ({
  ...data,
  possessionDate: data.possessionDate ? new Date(data.possessionDate) : undefined,
});

router.get('/app/projects', requirePermission('project.view'), async (req, res, next) => {
  try {
    const projects = await projectsService.listProjects({
      tenantId: req.tenantId, includeArchived: req.query.archived === '1',
    });
    const withStats = await Promise.all(projects.map(async (project) => ({
      ...project,
      stats: await projectsService.inventoryStats({ tenantId: req.tenantId, projectId: project._id }),
    })));
    res.render('pages/projects/list', { title: 'Projects', projects: withStats });
  } catch (err) { next(err); }
});

/**
 * V1.1 §26–§27: project setup is a guided stepper, and step 1 saves a DRAFT.
 * Everything after that hangs off a real project id — uploads, towers, units and
 * pricing all need one — and the admin can leave and resume at any step (§27.2).
 */
const STEPS = ['basics', 'location', 'sales', 'media', 'inventory', 'pricing', 'review'];
const stepOf = (value) => (STEPS.includes(value) ? value : 'basics');

/** The extra bundles the stepper needs beyond the core hierarchy. */
async function projectExtras(req, project) {
  const assets = require('../services/projectAssets');
  const paymentPlans = require('../services/paymentPlans');
  const { ProjectAsset } = require('../db/models');
  const [media, documents, plans, readiness] = await Promise.all([
    assets.forProject({ tenantId: req.tenantId, projectId: project._id, assetType: 'IMAGE' }),
    assets.forProject({ tenantId: req.tenantId, projectId: project._id, assetType: 'DOCUMENT' }),
    paymentPlans.forProject({ tenantId: req.tenantId, projectId: project._id }),
    projectsService.readiness({ tenantId: req.tenantId, projectId: project._id }),
  ]);
  return {
    media,
    documents,
    plans: plans.map((p) => ({ ...p, configured: paymentPlans.isConfigured(p), total: paymentPlans.totalPercentage(p.milestones) })),
    readiness,
    imageCategories: ProjectAsset.IMAGE_CATEGORIES,
    documentCategories: ProjectAsset.DOCUMENT_CATEGORIES,
    dueRules: require('../db/models').PaymentPlan.DUE_RULES,
    generatePreview: null,
  };
}

router.get('/app/projects/new', requirePermission('project.create'), (req, res) => {
  res.render('pages/projects/form', { title: 'New project', project: null, step: 'basics' });
});

router.post('/api/projects', requirePermission('project.create'), validate(projectSchema), async (req, res, next) => {
  try {
    // §27.1: a project starts as a draft so its children have somewhere to live.
    const project = await projectsService.create({
      tenantId: req.tenantId,
      actor: req.user,
      data: { ...toProjectData(req.data), status: req.data.status || 'DRAFT' },
    });
    req.session.flash = { type: 'success', message: 'Draft created. Continue through the steps — you can leave and come back.' };
    res.redirect(`/app/projects/${project._id}?step=location`);
  } catch (err) {
    next(err.code === 11000 ? require('../lib/errors').badRequest('A project with that name already exists.') : err);
  }
});

router.get('/app/projects/:id', requirePermission('project.view'), async (req, res, next) => {
  try {
    const data = await projectsService.getWithHierarchy({ tenantId: req.tenantId, projectId: req.params.id });
    res.render('pages/projects/detail', {
      title: data.project.name,
      ...data,
      ...(await projectExtras(req, data.project)),
      appUrl: config.appUrl,
      step: stepOf(req.query.step),
    });
  } catch (err) { next(err); }
});

router.get('/app/projects/:id/edit', requirePermission('project.edit'), async (req, res, next) => {
  try {
    const project = await Project.findOne({ tenantId: req.tenantId, _id: req.params.id }).lean();
    if (!project) throw require('../lib/errors').notFound('Project not found.');
    // §27.2: every step past basics lives on the project screen itself.
    const step = stepOf(req.query.step);
    if (step !== 'basics') return res.redirect(`/app/projects/${project._id}?step=${step}`);
    res.render('pages/projects/form', { title: `Edit ${project.name}`, project, step });
  } catch (err) { next(err); }
});

router.post('/api/projects/:id', requirePermission('project.edit'), validate(projectSchema), async (req, res, next) => {
  try {
    await projectsService.update({
      tenantId: req.tenantId, actor: req.user, projectId: req.params.id, data: toProjectData(req.data),
    });
    req.session.flash = { type: 'success', message: 'Project updated.' };
    const next$ = STEPS.includes(req.body.nextStep) ? req.body.nextStep : 'location';
    res.redirect(`/app/projects/${req.params.id}?step=${next$}`);
  } catch (err) { next(err); }
});

router.post('/api/projects/:id/status', requirePermission('project.publish', 'project.edit'), async (req, res, next) => {
  try {
    await projectsService.setStatus({
      tenantId: req.tenantId, actor: req.user, projectId: req.params.id, status: req.body.status,
    });

    /**
     * §104: activation *warns*, it does not block. Setup is iterative — an admin
     * activating a project before the pricing lands is normal, and refusing them
     * only teaches them to fight the tool. Publishing a mini site is where the
     * gaps become a hard stop, because that is what a customer sees.
     */
    let message = 'Project status updated.';
    if (req.body.status === 'ACTIVE') {
      const state = await projectsService.readiness({ tenantId: req.tenantId, projectId: req.params.id });
      if (!state.ready) {
        req.session.flash = {
          type: 'warn',
          message: `Activated, but still incomplete: ${state.blockers.map((b) => b.label).join('; ')}.`,
        };
        return res.redirect(`/app/projects/${req.params.id}?step=review`);
      }
    }
    req.session.flash = { type: 'success', message };
    res.redirect(`/app/projects/${req.params.id}?step=review`);
  } catch (err) { next(err); }
});

/** §64: publish or unpublish the customer-facing mini site. */
router.post('/api/projects/:id/mini-site', requirePermission('project.manage_minisite'), async (req, res, next) => {
  try {
    const project = await Project.findOne({ tenantId: req.tenantId, _id: req.params.id });
    if (!project) throw require('../lib/errors').notFound('Project not found.');
    if (req.body.published === '1' && project.status !== 'ACTIVE') {
      throw require('../lib/errors').badRequest('Only an active project can publish a mini site.');
    }
    /**
     * §104 is deliberately a *warning*, not a gate — here and on activation.
     * Pre-launch marketing pages for projects with no inventory yet are a real
     * and legitimate workflow; the readiness panel on the review step names the
     * gaps, and the person publishing decides. Being ACTIVE stays the one hard
     * rule, because that is what the tenant controls on purpose.
     */
    project.miniSite.published = req.body.published === '1';
    // §64.2: unit-level inventory stays private unless the tenant opts in.
    project.miniSite.showAvailability = req.body.showAvailability === '1';
    project.miniSite.showConfigurationAvailability = req.body.showConfigurationAvailability === '1';
    project.miniSite.showStartingPrice = req.body.showStartingPrice === '1';
    project.miniSite.ctaHeadline = req.body.ctaHeadline;
    if (project.miniSite.published) project.miniSite.publishedAt = new Date();
    await project.save();

    const state = await projectsService.readiness({ tenantId: req.tenantId, projectId: req.params.id });
    req.session.flash = project.miniSite.published && !state.ready
      ? {
        type: 'warn',
        message: `Published, but the project is still incomplete: ${state.blockers.map((b) => b.label).join('; ')}.`,
      }
      : { type: 'success', message: 'Mini site settings saved.' };
    res.redirect(`/app/projects/${req.params.id}?step=review`);
  } catch (err) { next(err); }
});

/* -------------------------------- hierarchy ------------------------------- */

const towerSchema = z.object({
  name: f.requiredText(60, 'Name the tower or block.'),
  code: f.optionalText(20),
  type: f.enumField(['TOWER', 'BLOCK', 'WING', 'PHASE', 'CLUSTER']),
  floorCount: z.coerce.number().int().min(0).max(200).default(0),
  displayOrder: z.coerce.number().int().min(0).default(0),
});

router.post('/api/projects/:id/towers', requirePermission('inventory.edit', 'project.edit'), validate(towerSchema), async (req, res, next) => {
  try {
    await projectsService.addTower({ tenantId: req.tenantId, actor: req.user, projectId: req.params.id, data: req.data });
    req.session.flash = { type: 'success', message: 'Tower added with its floors.' };
    res.redirect(`/app/projects/${req.params.id}`);
  } catch (err) {
    next(err.code === 11000 ? require('../lib/errors').badRequest('That tower already exists in this project.') : err);
  }
});

const unitTypeSchema = z.object({
  name: f.requiredText(60, 'Name the configuration.'),
  propertyType: f.enumField(['APARTMENT', 'VILLA', 'PLOT', 'SHOP', 'OFFICE', 'PENTHOUSE', 'OTHER']),
  bedrooms: f.optionalNumber,
  bathrooms: f.optionalNumber,
  carpetArea: f.optionalNumber,
  builtUpArea: f.optionalNumber,
  superBuiltUpArea: f.optionalNumber,
  defaultBaseRateMinor: f.moneyAmount,
  description: f.optionalText(1000),
});

router.post('/api/projects/:id/unit-types', requirePermission('inventory.edit', 'project.edit'), validate(unitTypeSchema), async (req, res, next) => {
  try {
    await projectsService.addUnitType({ tenantId: req.tenantId, projectId: req.params.id, data: req.data });
    req.session.flash = { type: 'success', message: 'Unit type added.' };
    res.redirect(`/app/projects/${req.params.id}`);
  } catch (err) {
    next(err.code === 11000 ? require('../lib/errors').badRequest('That unit type already exists.') : err);
  }
});

const generateSchema = z.object({
  towerId: f.objectId,
  unitTypeId: f.objectId,
  unitsPerFloor: z.coerce.number().int().min(1).max(50),
  numberPattern: f.optionalText(40),
  startIndex: z.coerce.number().int().min(0).default(1),
});

/**
 * V1.1 §32.2: preview is mandatory before mass generation. The same request
 * produces the preview and, once confirmed, the units — so what you approved is
 * exactly what gets written.
 */
router.post('/api/projects/:id/units/generate', requirePermission('inventory.edit'), validate(generateSchema.extend({ confirm: f.optionalText(4) })), async (req, res, next) => {
  try {
    const args = {
      tenantId: req.tenantId,
      projectId: req.params.id,
      towerId: req.data.towerId,
      unitTypeId: req.data.unitTypeId,
      unitsPerFloor: req.data.unitsPerFloor,
      numberPattern: req.data.numberPattern || '{floor}{index:02}',
      startIndex: req.data.startIndex,
    };

    if (req.data.confirm !== '1') {
      const preview = await projectsService.previewUnits(args);
      const data = await projectsService.getWithHierarchy({ tenantId: req.tenantId, projectId: req.params.id });
      return res.render('pages/projects/detail', {
        title: data.project.name,
        ...data,
        ...(await projectExtras(req, data.project)),
        appUrl: config.appUrl,
        step: 'inventory',
        generatePreview: { ...preview, input: args },
      });
    }

    const result = await projectsService.generateUnits({ actor: req.user, ...args });
    req.session.flash = { type: 'success', message: `${result.created} unit(s) created.` };
    res.redirect(`/app/inventory/${req.params.id}`);
  } catch (err) { next(err); }
});

/* --------------------------------- pricing -------------------------------- */

const componentSchema = z.object({
  name: f.requiredText(80, 'Name the charge.'),
  kind: z.enum(['BASE', 'FLOOR_RISE', 'PLC', 'VIEW', 'PARKING', 'MAINTENANCE', 'CORPUS', 'CLUB',
    'INFRASTRUCTURE', 'TAX', 'STAMP_DUTY', 'REGISTRATION', 'OTHER', 'DISCOUNT']),
  calcType: z.enum(['FIXED', 'PER_AREA', 'PERCENTAGE', 'PER_UNIT_COUNT']),
  rateMinor: f.moneyAmount,
  percentage: f.optionalNumber,
  areaBasis: f.enumField(['CARPET', 'BUILT_UP', 'SALEABLE']),
  percentageBaseKinds: f.stringList,
  displayOrder: z.coerce.number().int().min(0).default(0),
  mandatory: f.checkbox,
  customerVisible: f.checkbox,
  editableBySales: f.checkbox,
});

router.post('/api/projects/:id/pricing', requirePermission('pricing.override', 'project.edit'), validate(componentSchema), async (req, res, next) => {
  try {
    await projectsService.addPricingComponent({ tenantId: req.tenantId, projectId: req.params.id, data: req.data });
    req.session.flash = { type: 'success', message: 'Pricing component added.' };
    res.redirect(`/app/projects/${req.params.id}#pricing`);
  } catch (err) { next(err); }
});

router.post('/api/projects/:id/pricing/:componentId', requirePermission('pricing.override', 'project.edit'), validate(componentSchema), async (req, res, next) => {
  try {
    await projectsService.updatePricingComponent({
      tenantId: req.tenantId, actor: req.user, componentId: req.params.componentId, data: req.data,
    });
    req.session.flash = { type: 'success', message: 'Pricing component updated.' };
    res.redirect(`/app/projects/${req.params.id}#pricing`);
  } catch (err) { next(err); }
});

/**
 * V1.1 §35: structured payment plans. Milestone rows arrive as parallel arrays
 * from the repeated form rows, exactly like the nurture step editor.
 */
const asArray = (v) => (v === undefined ? [] : (Array.isArray(v) ? v : [v]));

const readMilestones = (body) => {
  const labels = asArray(body.msLabel);
  const percentages = asArray(body.msPercentage);
  const dueRules = asArray(body.msDueRule);
  const offsets = asArray(body.msDueOffsetDays);
  const notes = asArray(body.msNote);
  return labels.map((label, i) => ({
    label,
    percentage: percentages[i],
    dueRule: dueRules[i],
    dueOffsetDays: offsets[i],
    customerNote: notes[i],
    displayOrder: i + 1,
  }));
};

const paymentPlanSchema = z.object({
  name: f.requiredText(80, 'Name the payment plan.'),
  type: f.enumField(['CONSTRUCTION_LINKED', 'DOWN_PAYMENT', 'FLEXI', 'CUSTOM']),
  description: f.optionalText(1000),
  active: f.checkbox,
}).passthrough();

router.post('/api/projects/:id/payment-plans', requirePermission('project.edit'), validate(paymentPlanSchema), async (req, res, next) => {
  try {
    await require('../services/paymentPlans').save({
      tenantId: req.tenantId,
      actor: req.user,
      projectId: req.params.id,
      data: { ...req.data, milestones: readMilestones(req.body) },
    });
    req.session.flash = { type: 'success', message: 'Payment plan saved.' };
    res.redirect(`/app/projects/${req.params.id}?step=pricing#plans`);
  } catch (err) { next(err); }
});

router.post('/api/projects/:id/payment-plans/:planId', requirePermission('project.edit'), validate(paymentPlanSchema), async (req, res, next) => {
  try {
    await require('../services/paymentPlans').save({
      tenantId: req.tenantId,
      actor: req.user,
      projectId: req.params.id,
      planId: req.params.planId,
      data: { ...req.data, milestones: readMilestones(req.body) },
    });
    req.session.flash = { type: 'success', message: 'Payment plan saved.' };
    res.redirect(`/app/projects/${req.params.id}?step=pricing#plans`);
  } catch (err) { next(err); }
});

router.post('/api/projects/:id/payment-plans/:planId/toggle', requirePermission('project.edit'), async (req, res, next) => {
  try {
    await require('../services/paymentPlans').toggle({
      tenantId: req.tenantId, actor: req.user, planId: req.params.planId,
    });
    res.redirect(`/app/projects/${req.params.id}?step=pricing#plans`);
  } catch (err) { next(err); }
});

/* ------------------- V1.1 §31: media & documents ------------------------- */

const multer = require('multer');
// Files are held in memory and written by the service, which is the only place
// that knows the storage layout. 10 MB default, from config.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes } });

router.post(
  '/api/projects/:id/assets',
  requirePermission('project.manage_media'),
  (req, res, next) => upload.single('file')(req, res, (err) => {
    if (!err) return next();
    // §68: a raw multer error is not a message a user should ever read.
    next(require('../lib/errors').badRequest(
      err.code === 'LIMIT_FILE_SIZE'
        ? `Files must be under ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB.`
        : 'That file could not be uploaded.',
    ));
  }),
  async (req, res, next) => {
    try {
      // The multipart body only exists now, so this is where its CSRF token can
      // finally be checked (see middleware/csrf.js).
      require('../middleware/csrf').verify(req);
      await require('../services/projectAssets').upload({
        tenantId: req.tenantId, actor: req.user, projectId: req.params.id, file: req.file, data: req.body,
      });
      req.session.flash = { type: 'success', message: 'File uploaded.' };
      res.redirect(`/app/projects/${req.params.id}?step=media`);
    } catch (err) { next(err); }
  },
);

router.post('/api/projects/:id/assets/:assetId', requirePermission('project.manage_media'), async (req, res, next) => {
  try {
    await require('../services/projectAssets').update({
      tenantId: req.tenantId, actor: req.user, assetId: req.params.assetId, data: req.body,
    });
    req.session.flash = { type: 'success', message: 'File updated.' };
    res.redirect(`/app/projects/${req.params.id}?step=media`);
  } catch (err) { next(err); }
});

router.post('/api/projects/:id/assets/:assetId/archive', requirePermission('project.manage_media'), async (req, res, next) => {
  try {
    await require('../services/projectAssets').archive({
      tenantId: req.tenantId, actor: req.user, assetId: req.params.assetId,
    });
    req.session.flash = { type: 'success', message: 'File archived. Anything already shared still resolves.' };
    res.redirect(`/app/projects/${req.params.id}?step=media`);
  } catch (err) { next(err); }
});

/* -------------------------------- inventory ------------------------------- */

router.get('/app/inventory', requirePermission('inventory.view'), async (req, res, next) => {
  try {
    const projects = await projectsService.listProjects({ tenantId: req.tenantId });
    if (projects.length === 1) return res.redirect(`/app/inventory/${projects[0]._id}`);
    const withStats = await Promise.all(projects.map(async (project) => ({
      ...project,
      stats: await projectsService.inventoryStats({ tenantId: req.tenantId, projectId: project._id }),
    })));
    res.render('pages/inventory/projects', { title: 'Inventory', projects: withStats });
  } catch (err) { next(err); }
});

router.use('/app/inventory', requireAuth);

router.get('/app/inventory/:projectId', requirePermission('inventory.view'), async (req, res, next) => {
  try {
    const projectId = req.params.projectId;
    const project = await Project.findOne({ tenantId: req.tenantId, _id: projectId }).lean();
    if (!project) throw require('../lib/errors').notFound('Project not found.');

    const view = req.query.view === 'grid' ? 'grid' : 'list';
    const [facets, result, grid, stats] = await Promise.all([
      inventoryService.facets({ tenantId: req.tenantId, projectId }),
      view === 'list'
        ? inventoryService.list({
          tenantId: req.tenantId, projectId, query: req.query, page: req.query.page || 1,
          withPrices: req.user.role.isAdmin || req.user.role.permissions?.['inventory.view_prices'],
        })
        : { items: [], total: 0, page: 1, pages: 1 },
      view === 'grid' ? inventoryService.floorGrid({ tenantId: req.tenantId, projectId, towerId: req.query.towerId }) : [],
      projectsService.inventoryStats({ tenantId: req.tenantId, projectId }),
    ]);

    res.render('pages/inventory/index', {
      title: `${project.name} inventory`,
      project,
      view,
      ...facets,
      ...result,
      grid,
      stats,
    });
  } catch (err) { next(err); }
});

const unitSchema = z.object({
  unitNumber: f.requiredText(20, 'Enter the unit number.'),
  towerId: f.optionalId,
  floorId: f.optionalId,
  unitTypeId: f.optionalId,
  floorNumber: f.optionalNumber,
  carpetArea: f.optionalNumber,
  builtUpArea: f.optionalNumber,
  saleableArea: f.optionalNumber,
  facing: f.optionalText(40),
  view: f.optionalText(40),
  plcCategory: f.optionalText(40),
  parkingSlots: f.optionalNumber,
  baseRateMinor: f.moneyAmount,
  baseValueOverrideMinor: f.moneyAmount,
  notes: f.optionalText(500),
});

router.post('/api/projects/:id/units', requirePermission('inventory.edit'), validate(unitSchema), async (req, res, next) => {
  try {
    await inventoryService.createUnit({
      tenantId: req.tenantId, actor: req.user, data: { projectId: req.params.id, ...req.data },
    });
    req.session.flash = { type: 'success', message: 'Unit added.' };
    res.redirect(`/app/inventory/${req.params.id}`);
  } catch (err) { next(err); }
});

router.post('/api/units/:unitId', requireAuth, requirePermission('inventory.edit'), validate(unitSchema), async (req, res, next) => {
  try {
    const unit = await inventoryService.updateUnit({
      tenantId: req.tenantId, actor: req.user, unitId: req.params.unitId, data: req.data,
    });
    req.session.flash = { type: 'success', message: 'Unit updated.' };
    res.redirect(`/app/inventory/${unit.projectId}`);
  } catch (err) { next(err); }
});

router.post('/api/units/:unitId/status', requireAuth, requirePermission('inventory.edit'), async (req, res, next) => {
  try {
    const unit = await inventoryService.setStatus({
      tenantId: req.tenantId, actor: req.user, unitId: req.params.unitId,
      status: req.body.status, reason: req.body.reason,
    });
    req.session.flash = { type: 'success', message: `Unit ${unit.unitNumber} is now ${unit.status.toLowerCase()}.` };
    res.redirect(`/app/inventory/${unit.projectId}`);
  } catch (err) { next(err); }
});

module.exports = router;
