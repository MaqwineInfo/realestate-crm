const {
  SocietyBlock, SocietyFloor, SocietyUnit,
} = require('../../db/models/society');

/**
 * Generates a society's physical structure: blocks, then floors, then units.
 *
 * Run once when a society is created. The source did this over RabbitMQ as
 * three chained background jobs; here it is a plain async saga (§3.7) that the
 * create call awaits, because a society with no units is not usable and the
 * operator should learn that immediately rather than from an empty screen.
 *
 * **Idempotent by construction.** Every insert relies on the partial unique
 * indexes — `(societyId, blockName)`, `(societyId, blockId, floorNumber)`,
 * `(societyId, unitNumber)` — and runs `insertMany(..., { ordered: false })`,
 * so re-running after a partial failure inserts only what is missing instead of
 * duplicating or aborting. That is what makes it safe to retry, which matters
 * for a 400-unit society where the third batch is the one that failed.
 */

const BATCH = 500;
const blockLetter = (i) => String.fromCharCode(65 + i);

/** `A-101` — block letter, floor number, then the unit's index on that floor. */
const unitNumberFor = (blockIndex, floorNumber, indexOnFloor) => `${blockLetter(blockIndex)}-${floorNumber}${String(indexOnFloor).padStart(2, '0')}`;

/**
 * Inserts ignoring duplicates. A re-run must not fail on rows that already
 * exist, and `ordered: false` means one duplicate does not abandon the batch.
 */
async function insertIgnoringDuplicates(Model, docs) {
  let inserted = 0;
  let skipped = 0;
  for (let i = 0; i < docs.length; i += BATCH) {
    const batch = docs.slice(i, i + BATCH);
    try {
      const res = await Model.insertMany(batch, { ordered: false });
      inserted += res.length;
    } catch (err) {
      // E11000 on a re-run is the expected path, not a failure.
      const dupes = (err.writeErrors || []).filter((e) => e.err?.code === 11000 || e.code === 11000);
      if (dupes.length !== (err.writeErrors || []).length) throw err;
      inserted += batch.length - dupes.length;
      skipped += dupes.length;
    }
  }
  return { inserted, skipped };
}

async function generateBlocks(society) {
  const docs = Array.from({ length: society.totalBlocks || 0 }, (_, i) => ({
    societyId: society._id,
    blockName: `Block ${blockLetter(i)}`,
    orderNo: i + 1,
    createdBy: society.createdBy || null,
  }));
  return insertIgnoringDuplicates(SocietyBlock, docs);
}

/**
 * `totalFloors` floors per block either way; `includeGroundFloor` only decides
 * whether numbering starts at 0 (Ground) or 1.
 */
async function generateFloors(society) {
  const blocks = await SocietyBlock.find({ societyId: society._id, isDeleted: false })
    .sort({ orderNo: 1 }).lean();
  if (!blocks.length) return { inserted: 0, skipped: 0 };

  const start = society.includeGroundFloor ? 0 : 1;
  const count = society.totalFloors || 0;
  const docs = [];

  for (const block of blocks) {
    for (let n = start; n < start + count; n += 1) {
      docs.push({
        societyId: society._id,
        blockId: block._id,
        floorNumber: n,
        floorName: n === 0 ? 'Ground Floor' : `Floor ${n}`,
        totalUnits: society.totalUnits || 0,
        unitsPerFloor: society.totalUnits || 0,
        createdBy: society.createdBy || null,
      });
    }
  }
  return insertIgnoringDuplicates(SocietyFloor, docs);
}

/**
 * `totalUnits` on the society means units **per floor**, matching the source's
 * generator — not the building's total, which the field name suggests.
 *
 * Each unit is stamped with the society's `unitConfiguration` rate card, so an
 * operator sets pricing once instead of on every flat.
 */
async function generateUnits(society) {
  const blocks = await SocietyBlock.find({ societyId: society._id, isDeleted: false })
    .sort({ orderNo: 1 }).lean();
  if (!blocks.length) return { inserted: 0, skipped: 0 };

  const floors = await SocietyFloor.find({ societyId: society._id, isDeleted: false })
    .sort({ floorNumber: 1 }).lean();
  const floorsByBlock = new Map();
  for (const f of floors) {
    const k = String(f.blockId);
    if (!floorsByBlock.has(k)) floorsByBlock.set(k, []);
    floorsByBlock.get(k).push(f);
  }

  const config = society.unitConfiguration || {};
  const perFloor = society.totalUnits || 0;
  const docs = [];

  blocks.forEach((block, blockIndex) => {
    for (const floor of floorsByBlock.get(String(block._id)) || []) {
      for (let n = 1; n <= perFloor; n += 1) {
        docs.push({
          societyId: society._id,
          societyCode: society.societyCode,
          blockId: block._id,
          floorId: floor._id,
          blockNumber: block.blockName,
          floorNumber: floor.floorNumber,
          unitNumber: unitNumberFor(blockIndex, floor.floorNumber, n),
          createdBy: society.createdBy || null,
          ...stampConfiguration(config),
        });
      }
    }
  });

  return insertIgnoringDuplicates(SocietyUnit, docs);
}

/** Copies the society's default rate card onto a unit. */
function stampConfiguration(c) {
  const copy = {};
  for (const [k, v] of Object.entries(c)) {
    if (k === '_id' || v === null || v === undefined || v === '') continue;
    copy[k] = v;
  }
  // `unitStatus` on the template is `status` on the unit.
  if (copy.unitStatus) { copy.status = copy.unitStatus; delete copy.unitStatus; }
  return copy;
}

/** The whole saga, in order. Safe to re-run. */
async function generateAll(society) {
  const blocks = await generateBlocks(society);
  const floors = await generateFloors(society);
  const units = await generateUnits(society);
  return { blocks, floors, units };
}

module.exports = {
  generateAll, generateBlocks, generateFloors, generateUnits, unitNumberFor, blockLetter,
};
