const { crud } = require('./factory');
const { conflict } = require('../../lib/errors');
const {
  SocietyBlock, SocietyFloor, SocietyUnit,
} = require('../../db/models/society');

/**
 * Blocks — the wings of a society. Mostly factory CRUD; the interesting part is
 * that deleting one has to account for what hangs off it.
 */
const base = crud({
  Model: SocietyBlock,
  listKey: 'blocks',
  searchFields: ['blockName'],
  sort: { orderBy: 1, orderNo: 1 },
  unique: ['blockName'],
  pageParam: 'limit',
});

/** `orderNo` is required and must not collide, so it is assigned, not asked for. */
async function create(ctx, data, actorId) {
  if (data.orderNo === undefined || data.orderNo === null || data.orderNo === '') {
    const last = await SocietyBlock.findOne({ societyId: ctx.societyId, isDeleted: false })
      .sort({ orderNo: -1 }).select('orderNo').lean();
    return base.create(ctx, { ...data, orderNo: (last?.orderNo || 0) + 1 }, actorId);
  }
  return base.create(ctx, data, actorId);
}

/**
 * A block with occupied units underneath cannot be removed — the residents,
 * their bills and their complaints all point through it.
 */
async function remove(ctx, id, actorId) {
  const occupied = await SocietyUnit.countDocuments({
    societyId: ctx.societyId, blockId: id, isDeleted: false, occupancyStatus: 'OCCUPIED',
  });
  if (occupied > 0) {
    throw conflict(`Cannot delete this block — ${occupied} unit(s) are still occupied.`);
  }
  // Its floors and units go with it, or they become unreachable orphans.
  const at = new Date();
  await Promise.all([
    SocietyFloor.updateMany({ societyId: ctx.societyId, blockId: id, isDeleted: false },
      { $set: { isDeleted: true, deletedAt: at } }),
    SocietyUnit.updateMany({ societyId: ctx.societyId, blockId: id, isDeleted: false },
      { $set: { isDeleted: true, deletedAt: at } }),
  ]);
  return base.remove(ctx, id, actorId);
}

/** `{ _id, blockName }` only — for the block pickers on every other screen. */
async function dropdown(ctx) {
  return SocietyBlock.find({ societyId: ctx.societyId, isDeleted: false })
    .select('blockName orderNo').sort({ orderNo: 1 }).lean();
}

async function stats(ctx) {
  const [blocks, floors, units, occupied] = await Promise.all([
    SocietyBlock.countDocuments({ societyId: ctx.societyId, isDeleted: false }),
    SocietyFloor.countDocuments({ societyId: ctx.societyId, isDeleted: false }),
    SocietyUnit.countDocuments({ societyId: ctx.societyId, isDeleted: false }),
    SocietyUnit.countDocuments({ societyId: ctx.societyId, isDeleted: false, occupancyStatus: 'OCCUPIED' }),
  ]);
  return {
    totalBlocks: blocks, totalFloors: floors, totalUnits: units,
    occupiedUnits: occupied, vacantUnits: units - occupied,
  };
}

/** Blocks with their floors nested — two queries, not one per block. */
async function withFloors(ctx) {
  const [blocks, floors] = await Promise.all([
    SocietyBlock.find({ societyId: ctx.societyId, isDeleted: false }).sort({ orderNo: 1 }).lean(),
    SocietyFloor.find({ societyId: ctx.societyId, isDeleted: false }).sort({ floorNumber: 1 }).lean(),
  ]);
  const byBlock = new Map();
  for (const f of floors) {
    const k = String(f.blockId);
    if (!byBlock.has(k)) byBlock.set(k, []);
    byBlock.get(k).push(f);
  }
  return blocks.map((b) => ({ ...b, floors: byBlock.get(String(b._id)) || [] }));
}

module.exports = {
  ...base, create, remove, dropdown, stats, withFloors,
};
