const { crud } = require('./factory');
const { badRequest, notFound, conflict } = require('../../lib/errors');
const {
  SocietyParking, SocietyParkingLevel, SocietyParkingAllocation, SocietyVehicle,
  SocietyUnit, SocietyUnitOccupancy,
} = require('../../db/models/society');

/**
 * Parking: levels, slots, who holds them, and the vehicles that park in them.
 *
 * **A slot is allocated by a conditional update, not a read-then-write.** Every
 * transition names the status it expects — `AVAILABLE → PENDING_REQUEST →
 * ALLOCATED → AVAILABLE` — so a `findOneAndUpdate` that matches nothing means
 * somebody else moved first, and the caller gets a 409. That is the same
 * single-document atomic discipline `Unit.status` uses on the sales side (§87),
 * and it is what makes two residents requesting the last slot safe without a
 * transaction.
 *
 * `SocietyParking` holds only the *current* holder. The audit trail — requested,
 * approved, transferred, released — is `SocietyParkingAllocation`, which is why
 * that legacy collection survived the façade (SOCIETY-PLAN.md §2.2).
 */

const levels = crud({
  Model: SocietyParkingLevel,
  listKey: 'levels',
  searchFields: ['levelName'],
  filterFields: ['levelType', 'status'],
  unique: ['levelName'],
  pageParam: 'limit',
  sort: { levelNumber: 1, levelName: 1 },
});

const slots = crud({
  Model: SocietyParking,
  listKey: 'slots',
  filterFields: ['parkingLevelId', 'status', 'slotType', 'unitId'],
  populate: ['parkingLevelId'],
  pageParam: 'limit',
  sort: { slotNumber: 1 },
});

const vehicles = crud({
  Model: SocietyVehicle,
  listKey: 'vehicles',
  searchFields: ['vehicleNumber', 'vehicleName'],
  filterFields: ['vehicleType', 'unitId', 'userId', 'vehicleCategory'],
  unique: ['vehicleNumber'],
  pageParam: 'limit',
  sort: { createdAt: -1 },
});

/** Deleting a level takes its slots, unless somebody still parks there. */
async function removeLevel(ctx, id, actorId) {
  const held = await SocietyParking.countDocuments({
    societyId: ctx.societyId, parkingLevelId: id, isDeleted: false, status: 'ALLOCATED',
  });
  if (held) throw conflict(`Cannot delete this level — ${held} slot(s) are still allocated.`);

  await SocietyParking.updateMany(
    { societyId: ctx.societyId, parkingLevelId: id, isDeleted: false },
    { $set: { isDeleted: true, deletedAt: new Date() } },
  );
  return levels.remove(ctx, id, actorId);
}

/**
 * Adds a run of slots to a level.
 *
 * Idempotent through the partial unique index on (level, slotNumber), so
 * extending a level from 20 to 40 slots inserts the missing twenty rather than
 * failing on the first collision.
 */
async function addSlots(ctx, levelId, { from, to, slotType = 'CAR' }, actorId) {
  const level = await SocietyParkingLevel.findOne({
    societyId: ctx.societyId, _id: levelId, isDeleted: false,
  }).lean();
  if (!level) throw badRequest('That parking level does not exist in this society.');

  const start = Number(from);
  const end = Number(to);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) {
    throw badRequest('Give a valid slot range.');
  }
  if (end - start > 500) throw badRequest('That is more than 500 slots — split the range.');

  const docs = [];
  for (let n = start; n <= end; n += 1) {
    docs.push({
      societyId: ctx.societyId,
      parkingLevelId: levelId,
      slotNumber: n,
      slotType,
      status: 'AVAILABLE',
      createdBy: actorId || null,
    });
  }

  try {
    const made = await SocietyParking.insertMany(docs, { ordered: false });
    return { inserted: made.length, skipped: 0 };
  } catch (err) {
    const dupes = (err.writeErrors || []).filter((e) => (e.err?.code || e.code) === 11000);
    if (dupes.length !== (err.writeErrors || []).length) throw err;
    return { inserted: docs.length - dupes.length, skipped: dupes.length };
  }
}

/* -------------------------------- allocation -------------------------------- */

/** Records a movement in the audit trail, denormalised so it survives renames. */
async function trail(ctx, slot, { action, unitId, vehicle, actorId, allocationStatus }) {
  const level = slot.parkingLevelId
    ? await SocietyParkingLevel.findById(slot.parkingLevelId).select('levelName levelNumber').lean()
    : null;

  return SocietyParkingAllocation.create({
    societyId: ctx.societyId,
    slotId: slot._id,
    levelId: slot.parkingLevelId,
    unitId: unitId || slot.unitId || null,
    vehicleId: vehicle?._id || null,
    action,
    allocationStatus: allocationStatus || slot.status,
    slotNumber: slot.slotNumber,
    levelNumber: level?.levelNumber ?? null,
    locationAssigned: level ? `${level.levelName} / ${slot.slotNumber}` : String(slot.slotNumber),
    section: slot.section,
    floor: slot.floor,
    area: slot.area,
    vehicleNumber: vehicle?.vehicleNumber || null,
    vehicleType: vehicle?.vehicleType || null,
    createdBy: actorId || null,
  });
}

/**
 * A resident asks for a slot.
 *
 * The conditional update is the lock: only a row still `AVAILABLE` moves to
 * `PENDING_REQUEST`, so of two simultaneous requests exactly one succeeds.
 */
async function request(ctx, slotId, actor) {
  const occupancy = await SocietyUnitOccupancy.findOne({
    societyId: ctx.societyId, userId: actor.userId, isCurrent: true, isDeleted: false,
  }).select('unitId').lean();
  if (!occupancy) throw badRequest('You are not registered as a resident of this society.');

  const slot = await SocietyParking.findOneAndUpdate(
    {
      societyId: ctx.societyId, _id: slotId, isDeleted: false, status: 'AVAILABLE',
    },
    { $set: { status: 'PENDING_REQUEST', requestedBy: actor.userId } },
    { new: true },
  ).lean();
  if (!slot) throw conflict('That slot is no longer available.');

  await trail(ctx, slot, {
    action: 'REQUESTED', unitId: occupancy.unitId, actorId: actor.userId,
  });
  return slot;
}

/** An admin approves or rejects a pending request. */
async function processRequest(ctx, slotId, { approve, unitId, vehicleId }, actorId) {
  const pending = await SocietyParking.findOne({
    societyId: ctx.societyId, _id: slotId, isDeleted: false, status: 'PENDING_REQUEST',
  }).lean();
  if (!pending) throw notFound('No pending request on that slot.');

  if (!approve) {
    const released = await SocietyParking.findOneAndUpdate(
      { societyId: ctx.societyId, _id: slotId, status: 'PENDING_REQUEST' },
      { $set: { status: 'AVAILABLE', requestedBy: null } },
      { new: true },
    ).lean();
    await trail(ctx, released, { action: 'REQUEST_REJECTED', actorId });
    return released;
  }

  const targetUnit = unitId || await unitOfRequester(ctx, pending.requestedBy);
  if (!targetUnit) throw badRequest('Name the unit this slot is for.');

  const vehicle = vehicleId
    ? await SocietyVehicle.findOne({
      societyId: ctx.societyId, _id: vehicleId, isDeleted: false,
    }).lean()
    : null;

  const allocated = await SocietyParking.findOneAndUpdate(
    { societyId: ctx.societyId, _id: slotId, status: 'PENDING_REQUEST' },
    {
      $set: {
        status: 'ALLOCATED', unitId: targetUnit, assignedAt: new Date(), requestedBy: null, updatedBy: actorId,
      },
    },
    { new: true },
  ).lean();
  if (!allocated) throw conflict('That request has already been dealt with.');

  await trail(ctx, allocated, {
    action: 'REQUEST_APPROVED', unitId: targetUnit, vehicle, actorId,
  });
  return allocated;
}

async function unitOfRequester(ctx, userId) {
  if (!userId) return null;
  const row = await SocietyUnitOccupancy.findOne({
    societyId: ctx.societyId, userId, isCurrent: true, isDeleted: false,
  }).select('unitId').lean();
  return row?.unitId || null;
}

/** An admin allocates directly, skipping the request step. */
async function allocate(ctx, slotId, { unitId, vehicleId }, actorId) {
  const unit = await SocietyUnit.findOne({
    societyId: ctx.societyId, _id: unitId, isDeleted: false,
  }).select('_id').lean();
  if (!unit) throw badRequest('That unit does not exist in this society.');

  const vehicle = vehicleId
    ? await SocietyVehicle.findOne({
      societyId: ctx.societyId, _id: vehicleId, isDeleted: false,
    }).lean()
    : null;

  // Only a free slot may be taken — naming the expected status is the lock.
  const slot = await SocietyParking.findOneAndUpdate(
    {
      societyId: ctx.societyId,
      _id: slotId,
      isDeleted: false,
      status: { $in: ['AVAILABLE', 'PENDING_REQUEST'] },
    },
    {
      $set: {
        status: 'ALLOCATED', unitId, assignedAt: new Date(), requestedBy: null, updatedBy: actorId,
      },
    },
    { new: true },
  ).lean();
  if (!slot) throw conflict('That slot is already allocated.');

  await trail(ctx, slot, { action: 'ALLOCATED', unitId, vehicle, actorId });
  return slot;
}

/** Gives a slot back. Closes the open allocation row with an end time. */
async function release(ctx, slotId, actorId) {
  const slot = await SocietyParking.findOneAndUpdate(
    {
      societyId: ctx.societyId,
      _id: slotId,
      isDeleted: false,
      status: { $in: ['ALLOCATED', 'PENDING_REQUEST'] },
    },
    {
      $set: {
        status: 'AVAILABLE', unitId: null, assignedAt: null, requestedBy: null, updatedBy: actorId,
      },
    },
    { new: true },
  ).lean();
  if (!slot) throw conflict('That slot is not currently held.');

  await SocietyParkingAllocation.updateMany(
    {
      societyId: ctx.societyId, slotId, actualEndTime: null, isDeleted: false,
    },
    { $set: { actualEndTime: new Date() } },
  );
  await trail(ctx, slot, { action: 'DEALLOCATED', actorId, allocationStatus: 'AVAILABLE' });
  return slot;
}

/** A resident may only release a slot their own unit holds. */
async function releaseOwn(ctx, slotId, actor) {
  const occupancy = await SocietyUnitOccupancy.findOne({
    societyId: ctx.societyId, userId: actor.userId, isCurrent: true, isDeleted: false,
  }).select('unitId').lean();
  if (!occupancy) throw badRequest('You are not registered as a resident of this society.');

  const slot = await SocietyParking.findOne({
    societyId: ctx.societyId, _id: slotId, isDeleted: false,
  }).lean();
  if (!slot) throw notFound('Slot not found');

  const ownsIt = String(slot.unitId) === String(occupancy.unitId)
    || String(slot.requestedBy) === String(actor.userId);
  if (!ownsIt) throw notFound('Slot not found');

  return release(ctx, slotId, actor.userId);
}

/* ---------------------------------- reads ------------------------------------ */

/** The whole car park as a grid: levels, each with its slots. */
async function grid(ctx) {
  const [allLevels, allSlots] = await Promise.all([
    SocietyParkingLevel.find({ societyId: ctx.societyId, isDeleted: false })
      .sort({ levelNumber: 1, levelName: 1 }).lean(),
    SocietyParking.find({ societyId: ctx.societyId, isDeleted: false })
      .populate('unitId', 'unitNumber').sort({ slotNumber: 1 }).lean(),
  ]);

  const byLevel = new Map();
  for (const s of allSlots) {
    const k = String(s.parkingLevelId);
    if (!byLevel.has(k)) byLevel.set(k, []);
    byLevel.get(k).push(s);
  }

  const counts = (rows) => ({
    total: rows.length,
    available: rows.filter((r) => r.status === 'AVAILABLE').length,
    allocated: rows.filter((r) => r.status === 'ALLOCATED').length,
    pending: rows.filter((r) => r.status === 'PENDING_REQUEST').length,
  });

  const withSlots = allLevels.map((l) => {
    const rows = byLevel.get(String(l._id)) || [];
    return { ...l, slots: rows, counts: counts(rows) };
  });

  return { levels: withSlots, totals: counts(allSlots) };
}

const pendingRequests = (ctx) => SocietyParking.find({
  societyId: ctx.societyId, isDeleted: false, status: 'PENDING_REQUEST',
}).populate('parkingLevelId', 'levelName').sort({ updatedAt: -1 }).lean();

/** The slots one resident's unit holds. */
async function mine(ctx, actor) {
  const own = await SocietyUnitOccupancy.find({
    societyId: ctx.societyId, userId: actor.userId, isCurrent: true, isDeleted: false,
  }).select('unitId').lean();
  if (!own.length) return { slots: [] };

  const rows = await SocietyParking.find({
    societyId: ctx.societyId, unitId: { $in: own.map((o) => o.unitId) }, isDeleted: false,
  }).populate('parkingLevelId', 'levelName levelType').lean();
  return { slots: rows };
}

const myRequests = (ctx, actor) => SocietyParking.find({
  societyId: ctx.societyId, requestedBy: actor.userId, status: 'PENDING_REQUEST', isDeleted: false,
}).populate('parkingLevelId', 'levelName').lean();

/** Allocations whose expected end time has passed but were never released. */
const expiredAllocations = (ctx, now = new Date()) => SocietyParkingAllocation.find({
  societyId: ctx.societyId,
  isDeleted: false,
  actualEndTime: null,
  expectedEndTime: { $ne: null, $lte: now },
}).populate('slotId', 'slotNumber status').sort({ expectedEndTime: 1 }).lean();

/** Allocations that never got a physical location written on them. */
const pendingLocations = (ctx) => SocietyParkingAllocation.find({
  societyId: ctx.societyId,
  isDeleted: false,
  actualEndTime: null,
  $or: [{ locationAssigned: null }, { locationAssigned: '' }],
}).lean();

/** Where each vehicle is parked right now. */
async function tracking(ctx) {
  const rows = await SocietyParking.find({
    societyId: ctx.societyId, isDeleted: false, status: 'ALLOCATED',
  })
    .populate('parkingLevelId', 'levelName')
    .populate('unitId', 'unitNumber')
    .lean();

  const unitIds = rows.map((r) => r.unitId?._id || r.unitId).filter(Boolean);
  const cars = await SocietyVehicle.find({
    societyId: ctx.societyId, unitId: { $in: unitIds }, isDeleted: false,
  }).lean();
  const byUnit = new Map();
  for (const v of cars) {
    const k = String(v.unitId);
    if (!byUnit.has(k)) byUnit.set(k, []);
    byUnit.get(k).push(v);
  }

  return {
    parked: rows.map((r) => ({
      slotId: r._id,
      slotNumber: r.slotNumber,
      level: r.parkingLevelId?.levelName,
      unitNumber: r.unitId?.unitNumber,
      vehicles: byUnit.get(String(r.unitId?._id || r.unitId)) || [],
    })),
  };
}

const allocations = (ctx, query = {}) => {
  const filter = { societyId: ctx.societyId, isDeleted: false };
  if (query.slotId) filter.slotId = query.slotId;
  if (query.unitId) filter.unitId = query.unitId;
  if (query.action) filter.action = query.action;
  return SocietyParkingAllocation.find(filter).sort({ createdAt: -1 }).limit(200).lean();
};

/* --------------------------------- vehicles ----------------------------------- */

/** A resident registers a vehicle against their own unit. */
async function addVehicle(ctx, data, actor) {
  const occupancy = await SocietyUnitOccupancy.findOne({
    societyId: ctx.societyId, userId: actor.userId, isCurrent: true, isDeleted: false,
  }).lean();
  if (!occupancy) throw badRequest('You are not registered as a resident of this society.');

  return vehicles.create(ctx, {
    ...data,
    unitId: occupancy.unitId,
    userId: actor.userId,
    memberId: occupancy.memberId || null,
  }, actor.userId);
}

const myVehicles = (ctx, actor) => SocietyVehicle.find({
  societyId: ctx.societyId, userId: actor.userId, isDeleted: false,
}).sort({ createdAt: -1 }).lean();

/** A resident may only touch their own vehicle. */
async function assertOwnVehicle(ctx, id, actor) {
  const vehicle = await SocietyVehicle.findOne({
    societyId: ctx.societyId, _id: id, userId: actor.userId, isDeleted: false,
  }).lean();
  if (!vehicle) throw notFound('Vehicle not found');
  return vehicle;
}

module.exports = {
  levels: { ...levels, remove: removeLevel, addSlots },
  slots,
  vehicles: { ...vehicles, add: addVehicle, mine: myVehicles, assertOwn: assertOwnVehicle },
  request,
  processRequest,
  allocate,
  release,
  releaseOwn,
  grid,
  pendingRequests,
  mine,
  myRequests,
  expiredAllocations,
  pendingLocations,
  tracking,
  allocations,
};
