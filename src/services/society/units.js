const { crud } = require('./factory');
const occupancy = require('./occupancy');
const { conflict, notFound, badRequest } = require('../../lib/errors');
const {
  SocietyUnit, SocietyUnitOccupancy, SocietyBlock, SocietyFloor,
} = require('../../db/models/society');

/**
 * Units — the leaf of the hierarchy, and the thing everything else points at.
 *
 * Occupancy is deliberately not writable through the CRUD surface: assigning a
 * resident goes through `services/society/occupancy.js`, which is the only
 * place that knows the one-owner rule and keeps the unit's cached fields in
 * step. `update()` strips those fields for that reason.
 */
const base = crud({
  Model: SocietyUnit,
  listKey: 'units',
  searchFields: ['unitNumber', 'blockNumber'],
  filterFields: ['blockId', 'floorId', 'status', 'occupancyStatus', 'residentType', 'booked'],
  sort: { unitNumber: 1 },
  pageParam: 'limit',
});

/** Fields only the occupancy service may set. */
const OCCUPANCY_OWNED = [
  'currentOwnerId', 'currentTenantId', 'residentType',
  'isOccupied', 'occupancyStatus', 'booked',
];

async function update(ctx, id, data, actorId) {
  const clean = { ...data };
  for (const k of OCCUPANCY_OWNED) delete clean[k];
  return base.update(ctx, id, clean, actorId);
}

/** Units with their current residents attached — one extra query for the page. */
async function list(ctx, query) {
  const page = await base.list(ctx, query);
  const ids = page.units.map((u) => u._id);
  const rows = await SocietyUnitOccupancy.find({
    societyId: ctx.societyId, unitId: { $in: ids }, isCurrent: true, isDeleted: false,
  }).lean();

  const byUnit = new Map();
  for (const o of rows) {
    const k = String(o.unitId);
    if (!byUnit.has(k)) byUnit.set(k, []);
    byUnit.get(k).push(o);
  }
  page.units = page.units.map((u) => ({ ...u, residents: byUnit.get(String(u._id)) || [] }));
  return page;
}

async function detail(ctx, id) {
  const unit = await base.detail(ctx, id);
  return { ...unit, residents: await occupancy.forUnit(ctx.societyId, id) };
}

async function remove(ctx, id, actorId) {
  const live = await SocietyUnitOccupancy.countDocuments({
    societyId: ctx.societyId, unitId: id, isCurrent: true, isDeleted: false,
  });
  if (live > 0) throw conflict('Cannot delete a unit that still has residents.');
  return base.remove(ctx, id, actorId);
}

const dropdown = (ctx, query = {}) => {
  const filter = { societyId: ctx.societyId, isDeleted: false };
  if (query.blockId) filter.blockId = query.blockId;
  if (query.floorId) filter.floorId = query.floorId;
  return SocietyUnit.find(filter).select('unitNumber blockId floorId occupancyStatus')
    .sort({ unitNumber: 1 }).lean();
};

/** Units grouped by floor, for the floor-plan grid. */
async function byFloors(ctx, floorIds = []) {
  const ids = Array.isArray(floorIds) ? floorIds : String(floorIds).split(',').filter(Boolean);
  const filter = { societyId: ctx.societyId, isDeleted: false };
  if (ids.length) filter.floorId = { $in: ids };

  const units = await SocietyUnit.find(filter).sort({ unitNumber: 1 }).lean();
  const grouped = {};
  for (const u of units) {
    const k = String(u.floorId);
    (grouped[k] = grouped[k] || []).push(u);
  }
  return grouped;
}

/**
 * Adds a unit, deriving what the caller did not give.
 *
 * `blockNumber` / `floorNumber` / `societyCode` are denormalised onto the unit
 * so list screens do not join three collections per row; they are looked up
 * here rather than trusted from the request, where they would drift.
 */
async function create(ctx, data, actorId) {
  const payload = { ...data };
  if (payload.floorId) {
    const floor = await SocietyFloor.findOne({
      societyId: ctx.societyId, _id: payload.floorId, isDeleted: false,
    }).lean();
    if (!floor) throw badRequest('That floor does not exist in this society.');
    payload.floorNumber = floor.floorNumber;
    payload.blockId = payload.blockId || floor.blockId;
  }
  if (payload.blockId) {
    const block = await SocietyBlock.findOne({
      societyId: ctx.societyId, _id: payload.blockId, isDeleted: false,
    }).lean();
    if (!block) throw badRequest('That block does not exist in this society.');
    payload.blockNumber = block.blockName;
  }
  payload.societyCode = ctx.society?.societyCode || payload.societyCode;
  if (!payload.societyCode) {
    const { Society } = require('../../db/models/society');
    payload.societyCode = (await Society.findById(ctx.societyId).select('societyCode').lean())?.societyCode;
  }
  return base.create(ctx, payload, actorId);
}

/** Legacy `POST /units/:unitId/assign`, routed through the one occupancy path. */
async function assignResident(ctx, unitId, body, actorId) {
  const residentType = body.residentType || 'Owner';
  const member = body.memberId
    ? null
    : await occupancy.ensureMember({
      societyId: ctx.societyId, userId: body.userId, person: body, actorId,
    });

  return occupancy.assign({
    societyId: ctx.societyId,
    unitId,
    userId: body.userId || null,
    memberId: body.memberId || member?._id || null,
    residentType,
    person: body,
    actorId,
  });
}

/** Legacy `POST /units/:unitId/unassign`: ends every current tenure on the unit. */
async function unassign(ctx, unitId, actorId) {
  const current = await SocietyUnitOccupancy.find({
    societyId: ctx.societyId, unitId, isCurrent: true, isDeleted: false, memberRole: 'PRIMARY',
  }).lean();
  if (!current.length) throw badRequest('Unit is not assigned to any member.');

  for (const row of current) {
    await occupancy.release({ societyId: ctx.societyId, occupancyId: row._id, actorId });
  }
  return occupancy.syncUnit(ctx.societyId, unitId);
}

/** Everyone renting in the society — `GET /society-admin/society/tenants`. */
async function tenants(ctx, query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const size = Math.max(1, parseInt(query.limit, 10) || 10);
  const filter = {
    societyId: ctx.societyId, isDeleted: false, isCurrent: true, residentType: 'Tenant',
  };
  if (query.search?.trim()) {
    const safe = query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      { firstName: new RegExp(safe, 'i') },
      { lastName: new RegExp(safe, 'i') },
      { mobileNumber: new RegExp(safe, 'i') },
    ];
  }
  const [rows, total] = await Promise.all([
    SocietyUnitOccupancy.find(filter)
      .populate('unitId', 'unitNumber blockNumber floorNumber')
      .sort({ createdAt: -1 }).skip((page - 1) * size).limit(size)
      .lean(),
    SocietyUnitOccupancy.countDocuments(filter),
  ]);
  return {
    tenants: rows,
    pagination: { total, page, limit: size, totalPages: Math.ceil(total / size) },
  };
}

module.exports = {
  ...base,
  list,
  detail,
  create,
  update,
  remove,
  dropdown,
  byFloors,
  assignResident,
  unassign,
  tenants,
};
