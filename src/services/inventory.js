const { Unit, Tower, Floor, UnitType, UnitShortlist, Lead } = require('../db/models');
const { badRequest, notFound, conflict } = require('../lib/errors');
const { EVENTS, emit } = require('../lib/events');
const pricing = require('./pricing');
const timeline = require('./timeline');
const audit = require('./audit');

/**
 * Spec §28 + §53: live sales inventory and its state machine.
 *
 * Every status change goes through `claim()`, a single conditional update that
 * names the status it expects to find. On a standalone mongod that atomic
 * compare-and-set — not a transaction — is what stops two users blocking the
 * same unit (§32.5, §86, §87).
 */
const ALLOWED_TRANSITIONS = {
  AVAILABLE: ['HOLD', 'BLOCKED', 'BOOKED', 'NOT_FOR_SALE'],
  HOLD: ['AVAILABLE', 'BLOCKED'],
  BLOCKED: ['AVAILABLE', 'BOOKED'],
  BOOKED: ['REGISTERED'],
  REGISTERED: [],
  NOT_FOR_SALE: ['AVAILABLE'],
};

/**
 * Atomically move a unit from one of `fromStatuses` to `toStatus`.
 * @returns the updated unit, or null when another user got there first.
 */
async function claim({ tenantId, unitId, fromStatuses, toStatus, set = {} }) {
  for (const from of fromStatuses) {
    if (!ALLOWED_TRANSITIONS[from]?.includes(toStatus)) {
      throw badRequest(`A unit cannot move from ${from} to ${toStatus}.`);
    }
  }
  return Unit.findOneAndUpdate(
    { tenantId, _id: unitId, status: { $in: fromStatuses }, active: true },
    { $set: { status: toStatus, ...set } },
    { returnDocument: 'after' },
  );
}

/** Undo helper for saga recovery (§87): only if the unit is still where we left it. */
const releaseClaim = ({ tenantId, unitId, expectedStatus, toStatus, unset = [] }) => Unit.findOneAndUpdate(
  { tenantId, _id: unitId, status: expectedStatus },
  { $set: { status: toStatus }, ...(unset.length ? { $unset: Object.fromEntries(unset.map((k) => [k, ''])) } : {}) },
  { returnDocument: 'after' },
);

/** §28.3: the inventory list with all the filters the spec asks for. */
async function list({ tenantId, projectId, query = {}, page = 1, limit = 60, withPrices = true }) {
  const filter = { tenantId, projectId, active: true };
  if (query.towerId) filter.towerId = query.towerId;
  if (query.floorId) filter.floorId = query.floorId;
  if (query.unitTypeId) filter.unitTypeId = query.unitTypeId;
  if (query.status) filter.status = query.status;
  if (query.facing) filter.facing = query.facing;
  if (query.q) filter.unitNumber = { $regex: String(query.q).trim(), $options: 'i' };
  if (query.areaMin || query.areaMax) {
    filter.saleableArea = {};
    if (query.areaMin) filter.saleableArea.$gte = Number(query.areaMin);
    if (query.areaMax) filter.saleableArea.$lte = Number(query.areaMax);
  }

  const skip = (Math.max(1, Number(page)) - 1) * limit;
  const [items, total] = await Promise.all([
    Unit.find(filter)
      .sort({ towerId: 1, floorNumber: -1, unitNumber: 1 })
      .skip(skip).limit(limit)
      .populate('towerId', 'name code')
      .populate('unitTypeId', 'name propertyType bedrooms')
      .lean(),
    Unit.countDocuments(filter),
  ]);

  // Price range filtering needs the computed price, so it is applied after.
  let priced = items;
  if (withPrices) {
    priced = await Promise.all(items.map(async (unit) => ({
      ...unit,
      priceMinor: await pricing.quickPrice({ tenantId, unitId: unit._id }),
    })));
    if (query.priceMin) priced = priced.filter((u) => u.priceMinor != null && u.priceMinor >= Number(query.priceMin));
    if (query.priceMax) priced = priced.filter((u) => u.priceMinor != null && u.priceMinor <= Number(query.priceMax));
  }

  return { items: priced, total, page: Number(page), pages: Math.ceil(total / limit) || 1 };
}

/** §28.3 visual mode 2: units grouped by floor for the grid view. */
async function floorGrid({ tenantId, projectId, towerId }) {
  const filter = { tenantId, projectId, active: true, ...(towerId ? { towerId } : {}) };
  const units = await Unit.find(filter)
    .sort({ floorNumber: -1, unitNumber: 1 })
    .populate('unitTypeId', 'name')
    .lean();

  const byFloor = new Map();
  for (const unit of units) {
    const key = unit.floorNumber ?? 0;
    if (!byFloor.has(key)) byFloor.set(key, []);
    byFloor.get(key).push(unit);
  }
  return [...byFloor.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([floorNumber, floorUnits]) => ({ floorNumber, units: floorUnits }));
}

async function getUnit({ tenantId, unitId }) {
  const unit = await Unit.findOne({ tenantId, _id: unitId })
    .populate('towerId', 'name code')
    .populate('unitTypeId')
    .populate('projectId', 'name')
    .lean();
  if (!unit) throw notFound('Unit not found.');
  return unit;
}

async function createUnit({ tenantId, actor, data }) {
  try {
    const unit = await Unit.create({ tenantId, ...data });
    await audit.record({ tenantId, actor, entity: 'Unit', entityId: unit._id, action: 'CREATE', after: { unitNumber: unit.unitNumber } });
    return unit;
  } catch (err) {
    if (err.code === 11000) throw conflict('A unit with that number already exists in this tower.');
    throw err;
  }
}

async function updateUnit({ tenantId, actor, unitId, data }) {
  const unit = await Unit.findOne({ tenantId, _id: unitId });
  if (!unit) throw notFound('Unit not found.');
  const before = unit.toObject();
  // Status is only ever moved by the block/booking services (§55.12, §83).
  delete data.status;
  Object.assign(unit, data);
  await unit.save();
  await audit.record({
    tenantId, actor, entity: 'Unit', entityId: unit._id, action: 'UPDATE',
    ...audit.diff(before, unit.toObject(), Object.keys(data)),
  });
  return unit;
}

/** §28.2 / §53: an authorized manual status correction, fully audited. */
async function setStatus({ tenantId, actor, unitId, status, reason }) {
  const unit = await Unit.findOne({ tenantId, _id: unitId }).lean();
  if (!unit) throw notFound('Unit not found.');
  if (['BLOCKED', 'BOOKED'].includes(unit.status)) {
    throw badRequest('Release the block or cancel the booking before changing this unit by hand.');
  }
  if (!ALLOWED_TRANSITIONS[unit.status]?.includes(status)) {
    throw badRequest(`A unit cannot move from ${unit.status} to ${status}.`);
  }
  const updated = await claim({
    tenantId, unitId, fromStatuses: [unit.status], toStatus: status,
    set: status === 'HOLD' ? {} : { heldForLeadId: null },
  });
  if (!updated) throw conflict('This unit changed while you were working. Refresh and try again.');
  await audit.record({
    tenantId, actor, entity: 'Unit', entityId: unitId, action: 'STATUS_CHANGE',
    before: { status: unit.status }, after: { status, reason },
  });
  return updated;
}

/* -------------------------------- shortlist -------------------------------- */

/** §29.2: available, held, or blocked-by-this-lead units may be shortlisted. */
async function shortlist({ tenantId, actor, leadId, unitId, note }) {
  const [lead, unit] = await Promise.all([
    Lead.findOne({ tenantId, _id: leadId }).lean(),
    Unit.findOne({ tenantId, _id: unitId }).lean(),
  ]);
  if (!lead) throw notFound('Lead not found.');
  if (!unit) throw notFound('Unit not found.');

  const blockedByThisLead = unit.status === 'BLOCKED' && String(unit.heldForLeadId || '') === String(leadId);
  if (!['AVAILABLE', 'HOLD'].includes(unit.status) && !blockedByThisLead) {
    throw badRequest(`Unit ${unit.unitNumber} is ${unit.status.toLowerCase()} and cannot be shortlisted.`);
  }

  const existing = await UnitShortlist.findOne({ tenantId, leadId, unitId });
  if (existing) {
    if (existing.active) return existing;
    existing.active = true;
    existing.removedAt = undefined;
    await existing.save();
    return existing;
  }

  const entry = await UnitShortlist.create({
    tenantId, leadId, unitId, projectId: unit.projectId, note, shortlistedBy: actor?._id,
  });
  await Lead.updateOne({ tenantId, _id: leadId }, { $inc: { shortlistCount: 1 } });
  await timeline.log({
    tenantId, leadId, contactId: lead.contactId, type: 'UNIT_SHORTLISTED',
    title: `Unit ${unit.unitNumber} shortlisted`, actor,
    meta: { unitId: String(unitId), unitNumber: unit.unitNumber },
  });
  emit(EVENTS.UNIT_SHORTLISTED, { tenantId, leadId, unitId });
  return entry;
}

/** §29.2: removing a shortlist never changes inventory status. */
async function removeShortlist({ tenantId, actor, leadId, unitId }) {
  const entry = await UnitShortlist.findOne({ tenantId, leadId, unitId });
  if (!entry || !entry.active) return null;
  entry.active = false;
  entry.removedAt = new Date();
  await entry.save();
  await Lead.updateOne({ tenantId, _id: leadId }, { $inc: { shortlistCount: -1 } });

  const unit = await Unit.findOne({ tenantId, _id: unitId }).select('unitNumber').lean();
  const lead = await Lead.findOne({ tenantId, _id: leadId }).select('contactId').lean();
  await timeline.log({
    tenantId, leadId, contactId: lead?.contactId, type: 'UNIT_SHORTLIST_REMOVED',
    title: `Unit ${unit?.unitNumber || ''} removed from shortlist`.trim(), actor,
    meta: { unitId: String(unitId) },
  });
  return entry;
}

async function shortlistFor({ tenantId, leadId, includeRemoved = false }) {
  const entries = await UnitShortlist.find({ tenantId, leadId, ...(includeRemoved ? {} : { active: true }) })
    .sort({ rank: 1, createdAt: 1 })
    .populate({ path: 'unitId', populate: [{ path: 'towerId', select: 'name' }, { path: 'unitTypeId', select: 'name' }] })
    .lean();
  return Promise.all(entries.map(async (entry) => ({
    ...entry,
    priceMinor: entry.unitId ? await pricing.quickPrice({ tenantId, unitId: entry.unitId._id }) : null,
  })));
}

/** Filter helpers for the inventory screens. */
const facets = async ({ tenantId, projectId }) => {
  const [towers, floors, unitTypes] = await Promise.all([
    Tower.find({ tenantId, projectId }).sort({ displayOrder: 1, name: 1 }).lean(),
    Floor.find({ tenantId, projectId }).sort({ number: 1 }).lean(),
    UnitType.find({ tenantId, projectId, active: true }).sort({ name: 1 }).lean(),
  ]);
  return { towers, floors, unitTypes };
};

module.exports = {
  ALLOWED_TRANSITIONS, claim, releaseClaim, list, floorGrid, getUnit, createUnit, updateUnit,
  setStatus, shortlist, removeShortlist, shortlistFor, facets,
};
