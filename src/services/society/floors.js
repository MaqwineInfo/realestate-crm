const { crud } = require('./factory');
const { conflict, badRequest } = require('../../lib/errors');
const { SocietyFloor, SocietyUnit, SocietyBlock } = require('../../db/models/society');

/** Floors within a block. */
const base = crud({
  Model: SocietyFloor,
  listKey: 'floors',
  searchFields: ['floorName'],
  filterFields: ['blockId'],
  sort: { floorNumber: 1 },
  pageParam: 'limit',
});

async function remove(ctx, id, actorId) {
  const occupied = await SocietyUnit.countDocuments({
    societyId: ctx.societyId, floorId: id, isDeleted: false, occupancyStatus: 'OCCUPIED',
  });
  if (occupied > 0) {
    throw conflict(`Cannot delete this floor — ${occupied} unit(s) are still occupied.`);
  }
  await SocietyUnit.updateMany(
    { societyId: ctx.societyId, floorId: id, isDeleted: false },
    { $set: { isDeleted: true, deletedAt: new Date() } },
  );
  return base.remove(ctx, id, actorId);
}

const byBlock = (ctx, blockId) => SocietyFloor.find({
  societyId: ctx.societyId, blockId, isDeleted: false,
}).sort({ floorNumber: 1 }).lean();

/** Floors for several blocks at once, keyed by block — the setup grid's read. */
async function byBlocks(ctx, blockIds = []) {
  const ids = Array.isArray(blockIds) ? blockIds : String(blockIds).split(',').filter(Boolean);
  const filter = { societyId: ctx.societyId, isDeleted: false };
  if (ids.length) filter.blockId = { $in: ids };

  const floors = await SocietyFloor.find(filter).sort({ floorNumber: 1 }).lean();
  const grouped = {};
  for (const f of floors) {
    const k = String(f.blockId);
    (grouped[k] = grouped[k] || []).push(f);
  }
  return grouped;
}

const dropdown = (ctx, query = {}) => {
  const filter = { societyId: ctx.societyId, isDeleted: false };
  if (query.blockId) filter.blockId = query.blockId;
  return SocietyFloor.find(filter).select('floorName floorNumber blockId').sort({ floorNumber: 1 }).lean();
};

async function stats(ctx) {
  const [floors, units] = await Promise.all([
    SocietyFloor.countDocuments({ societyId: ctx.societyId, isDeleted: false }),
    SocietyUnit.countDocuments({ societyId: ctx.societyId, isDeleted: false }),
  ]);
  return { totalFloors: floors, totalUnits: units };
}

/**
 * Adds a run of floors to a block in one call.
 *
 * `ordered: false` plus the partial unique index on
 * `(societyId, blockId, floorNumber)` makes this idempotent: adding floors 1–10
 * to a block that already has 1–5 inserts the missing five rather than failing
 * on the first collision.
 */
async function bulkCreate(ctx, { blockId, from, to, unitsPerFloor = 0 }, actorId) {
  const block = await SocietyBlock.findOne({
    societyId: ctx.societyId, _id: blockId, isDeleted: false,
  }).lean();
  if (!block) throw badRequest('That block does not exist in this society.');

  const start = Number(from);
  const end = Number(to);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) {
    throw badRequest('Give a valid floor range.');
  }
  if (end - start > 200) throw badRequest('That is more than 200 floors — split the range.');

  const docs = [];
  for (let n = start; n <= end; n += 1) {
    docs.push({
      societyId: ctx.societyId,
      blockId,
      floorNumber: n,
      floorName: n === 0 ? 'Ground Floor' : `Floor ${n}`,
      unitsPerFloor,
      totalUnits: unitsPerFloor,
      createdBy: actorId || null,
    });
  }

  try {
    const created = await SocietyFloor.insertMany(docs, { ordered: false });
    return { inserted: created.length, skipped: 0 };
  } catch (err) {
    const dupes = (err.writeErrors || []).filter((e) => (e.err?.code || e.code) === 11000);
    if (dupes.length !== (err.writeErrors || []).length) throw err;
    return { inserted: docs.length - dupes.length, skipped: dupes.length };
  }
}

module.exports = {
  ...base, remove, byBlock, byBlocks, dropdown, stats, bulkCreate,
};
