const crypto = require('node:crypto');
const {
  Project, Tower, Floor, UnitType, Unit, PricingComponent, PaymentPlan, Lead,
} = require('../db/models');
const { badRequest, notFound } = require('../lib/errors');
const audit = require('./audit');

/**
 * Spec §26–§28: project setup is the source of truth for inventory, pricing,
 * the mini site, AI and campaign content (§122.16).
 */

async function create({ tenantId, actor, data }) {
  const project = await Project.create({
    tenantId,
    ...data,
    qrToken: crypto.randomBytes(16).toString('base64url'),
    createdBy: actor?._id,
  });
  await audit.record({ tenantId, actor, entity: 'Project', entityId: project._id, action: 'CREATE', after: { name: project.name } });
  return project;
}

async function update({ tenantId, actor, projectId, data }) {
  const project = await Project.findOne({ tenantId, _id: projectId });
  if (!project) throw notFound('Project not found.');
  const before = project.toObject();
  Object.assign(project, data, { updatedBy: actor?._id });
  await project.save();
  await audit.record({
    tenantId, actor, entity: 'Project', entityId: project._id, action: 'UPDATE',
    ...audit.diff(before, project.toObject(), Object.keys(data)),
  });
  return project;
}

/** §26.2: only Active projects take new inquiries and can publish a mini site. */
async function setStatus({ tenantId, actor, projectId, status }) {
  const project = await Project.findOne({ tenantId, _id: projectId });
  if (!project) throw notFound('Project not found.');
  if (status === 'ARCHIVED') {
    // §95: a project with leads is archived, never deleted, and its history stays reachable.
    project.archived = true;
  } else {
    project.archived = false;
  }
  const before = project.status;
  project.status = status;
  if (status !== 'ACTIVE') project.miniSite.published = false;
  await project.save();
  await audit.record({
    tenantId, actor, entity: 'Project', entityId: project._id, action: 'STATUS_CHANGE',
    before: { status: before }, after: { status },
  });
  return project;
}

const listProjects = ({ tenantId, includeArchived = false }) => Project.find({
  tenantId, ...(includeArchived ? {} : { archived: { $ne: true } }),
}).sort({ name: 1 }).lean();

async function getWithHierarchy({ tenantId, projectId }) {
  const project = await Project.findOne({ tenantId, _id: projectId }).lean();
  if (!project) throw notFound('Project not found.');

  const [towers, floors, unitTypes, components, paymentPlans, unitStats, leadCount] = await Promise.all([
    Tower.find({ tenantId, projectId }).sort({ displayOrder: 1, name: 1 }).lean(),
    Floor.find({ tenantId, projectId }).sort({ number: 1 }).lean(),
    UnitType.find({ tenantId, projectId }).sort({ displayOrder: 1, name: 1 }).lean(),
    PricingComponent.find({ tenantId, projectId }).sort({ displayOrder: 1 }).lean(),
    PaymentPlan.find({ tenantId, projectId }).sort({ name: 1 }).lean(),
    inventoryStats({ tenantId, projectId }),
    Lead.countDocuments({ tenantId, projectId }),
  ]);
  return { project, towers, floors, unitTypes, components, paymentPlans, unitStats, leadCount };
}

/** §43.4 / §8.5: available / blocked / booked counts for a project. */
async function inventoryStats({ tenantId, projectId }) {
  const rows = await Unit.aggregate([
    { $match: { tenantId: toObjectId(tenantId), projectId: toObjectId(projectId), active: true } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  const byStatus = Object.fromEntries(rows.map((r) => [r._id, r.count]));
  return {
    total: rows.reduce((sum, r) => sum + r.count, 0),
    available: byStatus.AVAILABLE || 0,
    hold: byStatus.HOLD || 0,
    blocked: byStatus.BLOCKED || 0,
    booked: byStatus.BOOKED || 0,
    registered: byStatus.REGISTERED || 0,
  };
}

/* ------------------------------- hierarchy -------------------------------- */

async function addTower({ tenantId, actor, projectId, data }) {
  const project = await Project.findOne({ tenantId, _id: projectId }).lean();
  if (!project) throw notFound('Project not found.');
  const tower = await Tower.create({ tenantId, projectId, ...data });

  // Floors are implied by the tower's height; creating them here keeps unit
  // creation a single step for the admin (§26 "detailed enough to power sales").
  const floors = [];
  for (let n = 1; n <= (data.floorCount || 0); n += 1) {
    floors.push({ tenantId, projectId, towerId: tower._id, number: n, name: `Floor ${n}`, displayOrder: n });
  }
  if (floors.length) await Floor.insertMany(floors);
  await audit.record({ tenantId, actor, entity: 'Tower', entityId: tower._id, action: 'CREATE', after: data });
  return tower;
}

const addUnitType = ({ tenantId, projectId, data }) => UnitType.create({ tenantId, projectId, ...data });

/**
 * §27.4: bulk unit creation. A tower of 12 floors × 4 units is 48 records that
 * nobody should type by hand. Existing unit numbers are skipped, so re-running
 * after adding a floor is safe.
 */
async function generateUnits({ tenantId, actor, projectId, towerId, unitTypeId, unitsPerFloor, numberPattern = '{floor}{index:02}', startIndex = 1, area = {} }) {
  const [tower, unitType] = await Promise.all([
    Tower.findOne({ tenantId, _id: towerId, projectId }).lean(),
    UnitType.findOne({ tenantId, _id: unitTypeId, projectId }).lean(),
  ]);
  if (!tower) throw badRequest('Choose a valid tower.');
  if (!unitType) throw badRequest('Choose a valid unit type.');

  const floors = await Floor.find({ tenantId, towerId: tower._id }).sort({ number: 1 }).lean();
  if (!floors.length) throw badRequest('This tower has no floors yet.');

  const existing = new Set(
    (await Unit.find({ tenantId, projectId, towerId: tower._id }).select('unitNumber').lean())
      .map((u) => u.unitNumber),
  );

  const docs = [];
  for (const floor of floors) {
    for (let i = 0; i < unitsPerFloor; i += 1) {
      const unitNumber = renderUnitNumber(numberPattern, { floor: floor.number, index: startIndex + i, tower: tower.code || tower.name });
      if (existing.has(unitNumber)) continue;
      docs.push({
        tenantId,
        projectId,
        towerId: tower._id,
        floorId: floor._id,
        unitTypeId: unitType._id,
        unitNumber,
        floorNumber: floor.number,
        carpetArea: area.carpetArea ?? unitType.carpetArea,
        builtUpArea: area.builtUpArea ?? unitType.builtUpArea,
        saleableArea: area.saleableArea ?? unitType.superBuiltUpArea,
        baseRateMinor: unitType.defaultBaseRateMinor,
        status: 'AVAILABLE',
      });
    }
  }
  if (!docs.length) return { created: 0 };
  await Unit.insertMany(docs);
  await audit.record({
    tenantId, actor, entity: 'Unit', entityId: tower._id, action: 'BULK_CREATE',
    after: { towerId: tower._id, count: docs.length },
  });
  return { created: docs.length };
}

/**
 * V1.1 §32.2: what generation *would* create, before it creates it.
 *
 * Bulk unit creation is the one setup action that is tedious to undo, so the
 * numbering pattern gets checked by eye first. Shares `renderUnitNumber` with the
 * real thing, so the preview cannot drift from the result.
 */
async function previewUnits({
  tenantId, projectId, towerId, unitTypeId, unitsPerFloor, numberPattern = '{floor}{index:02}', startIndex = 1,
}) {
  const [tower, unitType] = await Promise.all([
    Tower.findOne({ tenantId, _id: towerId, projectId }).lean(),
    UnitType.findOne({ tenantId, _id: unitTypeId, projectId }).lean(),
  ]);
  if (!tower) throw badRequest('Choose a valid tower.');
  if (!unitType) throw badRequest('Choose a valid unit type.');

  const floors = await Floor.find({ tenantId, towerId: tower._id }).sort({ number: 1 }).lean();
  if (!floors.length) throw badRequest('This tower has no floors yet.');

  const existing = new Set(
    (await Unit.find({ tenantId, projectId, towerId: tower._id }).select('unitNumber').lean())
      .map((u) => u.unitNumber),
  );

  let willCreate = 0;
  const rows = floors.map((floor) => {
    const units = [];
    for (let i = 0; i < unitsPerFloor; i += 1) {
      const unitNumber = renderUnitNumber(numberPattern, {
        floor: floor.number, index: Number(startIndex) + i, tower: tower.code || tower.name,
      });
      const skipped = existing.has(unitNumber);
      if (!skipped) willCreate += 1;
      units.push({ unitNumber, skipped });
    }
    return { floorNumber: floor.number, units };
  });

  return {
    tower, unitType, rows, willCreate, skipping: rows.flatMap((r) => r.units).filter((u) => u.skipped).length,
  };
}

/**
 * V1.1 §104: is this project ready to sell? Returns every check with its state so
 * the review step can show the gaps rather than a single unhelpful "not ready".
 */
async function readiness({ tenantId, projectId }) {
  const { ProjectAsset, PaymentPlan } = require('../db/models');
  const project = await Project.findOne({ tenantId, _id: projectId }).lean();
  if (!project) throw notFound('Project not found.');

  const [unitTypes, units, sellable, base, plans, planDocs, cover, brochure, towers] = await Promise.all([
    UnitType.countDocuments({ tenantId, projectId, active: true }),
    Unit.countDocuments({ tenantId, projectId, active: true }),
    Unit.countDocuments({ tenantId, projectId, active: true, status: 'AVAILABLE' }),
    PricingComponent.countDocuments({ tenantId, projectId, kind: 'BASE', active: true }),
    PaymentPlan.countDocuments({ tenantId, projectId, active: true }),
    PaymentPlan.find({ tenantId, projectId, active: true }).lean(),
    ProjectAsset.countDocuments({ tenantId, projectId, assetType: 'IMAGE', category: 'COVER', archived: { $ne: true } }),
    ProjectAsset.countDocuments({ tenantId, projectId, assetType: 'DOCUMENT', category: 'BROCHURE', archived: { $ne: true } }),
    Tower.countDocuments({ tenantId, projectId }),
  ]);

  const paymentPlans = require('./paymentPlans');
  const unconfiguredPlans = planDocs.filter((p) => !paymentPlans.isConfigured(p)).map((p) => p.name);

  // `blocking` items stop activation; the rest are recommendations (§104).
  const checks = [
    { key: 'basics', label: 'Project basics', ok: !!project.name && !!project.developerName, blocking: true },
    { key: 'location', label: 'Location', ok: !!project.city, blocking: false },
    { key: 'unitTypes', label: `${unitTypes} configuration(s)`, ok: unitTypes > 0, blocking: true },
    { key: 'towers', label: `${towers} tower(s)`, ok: towers > 0, blocking: false },
    { key: 'units', label: `${units} unit(s), ${sellable} available`, ok: sellable > 0, blocking: true },
    { key: 'pricing', label: 'Base pricing configured', ok: base > 0, blocking: true },
    { key: 'plans', label: `${plans} payment plan(s)`, ok: plans > 0, blocking: true },
    // §101: a legacy plan is a name with no schedule. It stays selectable — the
    // quotation just says so — so this is a nudge, not a gate.
    {
      key: 'planSchedules',
      label: unconfiguredPlans.length
        ? `Schedule not configured: ${unconfiguredPlans.join(', ')}`
        : 'Payment schedules total 100%',
      ok: plans > 0 && !unconfiguredPlans.length,
      blocking: false,
    },
    { key: 'salesContact', label: 'Sales contact', ok: !!project.salesContactName, blocking: false },
    { key: 'cover', label: 'Cover image', ok: cover > 0, blocking: false },
    { key: 'brochure', label: 'Brochure', ok: brochure > 0, blocking: false },
  ];

  const blockers = checks.filter((c) => c.blocking && !c.ok);
  return {
    project,
    checks,
    blockers,
    ready: blockers.length === 0,
    // §36/§104: a mini site needs the project live and something public to show.
    canPublish: blockers.length === 0 && project.status === 'ACTIVE',
  };
}

/** "{floor}{index:02}" → "301"; "{tower}-{floor}{index:02}" → "A-301". */
function renderUnitNumber(pattern, { floor, index, tower }) {
  return String(pattern)
    .replace(/\{floor\}/g, floor)
    .replace(/\{tower\}/g, tower || '')
    .replace(/\{index:(\d+)\}/g, (_, width) => String(index).padStart(Number(width), '0'))
    .replace(/\{index\}/g, index);
}

/* -------------------------------- pricing --------------------------------- */

const addPricingComponent = ({ tenantId, projectId, data }) => PricingComponent.create({ tenantId, projectId, ...data });

async function updatePricingComponent({ tenantId, actor, componentId, data }) {
  const component = await PricingComponent.findOne({ tenantId, _id: componentId });
  if (!component) throw notFound('Pricing component not found.');
  const before = component.toObject();
  Object.assign(component, data);
  await component.save();
  // §56: pricing edits are audited.
  await audit.record({
    tenantId, actor, entity: 'PricingComponent', entityId: component._id, action: 'UPDATE',
    ...audit.diff(before, component.toObject(), Object.keys(data)),
  });
  return component;
}

const addPaymentPlan = ({ tenantId, projectId, data }) => PaymentPlan.create({ tenantId, projectId, ...data });

/* --------------------------------- media ---------------------------------- */

async function addMedia({ tenantId, actor, projectId, items }) {
  const project = await Project.findOne({ tenantId, _id: projectId });
  if (!project) throw notFound('Project not found.');
  project.media.push(...items.map((item) => ({ ...item, uploadedBy: actor?._id })));
  await project.save();
  return project;
}

async function removeMedia({ tenantId, projectId, mediaId }) {
  await Project.updateOne({ tenantId, _id: projectId }, { $pull: { media: { _id: mediaId } } });
}

const toObjectId = (value) => (typeof value === 'string'
  ? new (require('mongoose').Types.ObjectId)(value)
  : value);

module.exports = {
  create, update, setStatus, listProjects, getWithHierarchy, inventoryStats,
  addTower, addUnitType, generateUnits, previewUnits, readiness, renderUnitNumber,
  addPricingComponent, updatePricingComponent, addPaymentPlan, addMedia, removeMedia,
};
