const { crud } = require('./factory');
const seams = require('./seams');
const structure = require('./structure');
const messages = require('../../lib/society/messages');
const { notFound, conflict } = require('../../lib/errors');
const {
  Society, SocietyCounter, SocietyAdmin, SocietyRole, SocietyUser,
  SocietyCommitteeMember, SocietyEmployeeType, SocietyBlock, SocietyFloor,
  SocietyUnit, SocietyUnitOccupancy,
} = require('../../db/models/society');

const M = messages.en.society;

/** Seeded on every new society. Ported from the source's `systemEmployeeTypes.js`. */
const SYSTEM_EMPLOYEE_TYPES = [
  { typeName: 'Security Guard', roleKey: 'security_guard', description: 'Handles gate entries and visitor management' },
  { typeName: 'Technician', roleKey: 'technician', description: 'Handles maintenance and repair work orders' },
];

const base = crud({
  Model: Society,
  listKey: 'societies',
  searchFields: ['societyName', 'societyCode', 'address.city', 'contactPersonName', 'email'],
  filterFields: ['status', 'projectType', 'developerId'],
  pageParam: 'limit',
  sort: { createdAt: -1 },
});

/**
 * Mint the next society code.
 *
 * The source built `SOC-{year}-{3 random digits}` and re-rolled until the code
 * was free — a birthday-problem loop over a 1000-value space that gets slower
 * with every society and cannot terminate at all past the thousandth in a year.
 * `SocietyCounter` is a single atomic `$inc`: collision-free, ordered, and it
 * simply grows to four digits when it needs to.
 */
async function generateCode() {
  const year = new Date().getFullYear();
  const seq = await SocietyCounter.next({ societyCode: 'PLATFORM', kind: 'society-code', date: String(year) });
  return `SOC-${year}-${String(seq).padStart(3, '0')}`;
}

/**
 * Create a society and everything it cannot function without.
 *
 * An ordered, idempotent saga (§87) rather than a transaction, because this
 * runs on a standalone `mongod`. Each step is safe to repeat, so a failure
 * halfway can be retried by calling again with the same code:
 *
 *   1. the society row (unique `societyCode` is the idempotency key)
 *   2. its physical structure — blocks, floors, units
 *   3. the chairman: a `SocietyUser` login, a `SocietyAdmin`, a committee seat
 *   4. the two system employee types
 *
 * The chairman is created last on purpose: an admin account pointing at a
 * society with no units is a worse half-state than a society nobody can log
 * into yet, because the first is invisible and the second is obvious.
 */
async function create(ctx, data, actorId) {
  const societyCode = String(data.societyCode || await generateCode()).toUpperCase();

  if (await Society.findOne({ societyCode }).select('_id').lean()) {
    throw conflict(M.society_code_already_exists);
  }

  /**
   * Seam 1 (D4): a completed CRM project becoming a managed society brings its
   * own structure. Returns null until joined, so the form-driven generation
   * below stays the only path.
   */
  const fromProject = data.projectId
    ? await seams.societyFromProject({ projectId: data.projectId, actorId })
    : null;
  if (fromProject) return fromProject;

  const society = await Society.create({
    ...data, societyCode, createdBy: actorId || null,
  });

  const generated = await structure.generateAll({ ...society.toObject(), createdBy: actorId });
  await seedEmployeeTypes(society._id, actorId);
  const chairman = await createChairman(society, data, actorId);

  return {
    society: society.toObject(),
    structure: generated,
    chairman,
  };
}

async function seedEmployeeTypes(societyId, actorId) {
  const roles = await SocietyRole.find({
    key: { $in: SYSTEM_EMPLOYEE_TYPES.map((t) => t.roleKey) }, isDeleted: false,
  }).lean();
  const byKey = new Map(roles.map((r) => [r.key, r._id]));

  for (const type of SYSTEM_EMPLOYEE_TYPES) {
    await SocietyEmployeeType.updateOne(
      { societyId, typeName: type.typeName, isDeleted: false },
      {
        $setOnInsert: {
          societyId,
          typeName: type.typeName,
          description: type.description,
          roleId: byKey.get(type.roleKey) || null,
          isSystem: true,
          createdBy: actorId || null,
        },
      },
      { upsert: true },
    );
  }
}

/**
 * The chairman: a login, an admin record and a committee seat.
 *
 * Every step is an upsert keyed on something naturally unique (mobile number,
 * then phone+society), so re-running the saga adopts the existing rows rather
 * than failing on their unique indexes or minting a second chairman.
 */
async function createChairman(society, data, actorId) {
  const mobileNumber = data.contactNumber || data.mobileNumber;
  const countryCode = data.countryCode || '+91';
  if (!mobileNumber) return null;

  const role = await SocietyRole.findOne({ key: 'chairman', isDeleted: false }).lean();

  await SocietyUser.updateOne(
    { mobileNumber },
    {
      $setOnInsert: { mobileNumber, countryCode, isMobileVerified: false },
      $set: {
        firstName: data.contactPersonName || '',
        email: data.email || null,
        societyId: society._id,
        isSocietyAdmin: true,
      },
    },
    { upsert: true },
  );
  const user = await SocietyUser.findOne({ mobileNumber }).lean();

  await SocietyAdmin.updateOne(
    { phoneNumber: mobileNumber, countryCode, societyId: society._id, isDeleted: false },
    {
      $setOnInsert: {
        phoneNumber: mobileNumber,
        countryCode,
        societyId: society._id,
        roleId: role?._id || null,
      },
      $set: {
        userId: user._id,
        fullName: data.contactPersonName || '',
        email: data.email || null,
        role: 'Chairman',
        societyName: society.societyName,
      },
    },
    { upsert: true },
  );
  const admin = await SocietyAdmin.findOne({
    phoneNumber: mobileNumber, countryCode, societyId: society._id, isDeleted: false,
  }).lean();

  await SocietyCommitteeMember.updateOne(
    { societyId: society._id, userId: user._id, isDeleted: false },
    {
      $setOnInsert: {
        societyId: society._id,
        userId: user._id,
        firstName: data.contactPersonName || '',
        lastName: '',
        email: data.email,
        countryCode,
        phoneNumber: mobileNumber,
        designation: 'Chairman',
        roleId: role?._id || null,
        createdBy: actorId || null,
      },
    },
    { upsert: true },
  );

  await Society.updateOne({ _id: society._id }, { $set: { adminUserId: user._id } });
  return { userId: user._id, adminId: admin?._id, mobileNumber, countryCode };
}

/**
 * The societies one admin may act on: their own, plus any in `societies[]`.
 *
 * This is what the app's society switcher reads, and it is the same list
 * `middleware/societyAuth.js` validates `x-society-id` against — so a society
 * that does not appear here cannot be reached by setting the header by hand.
 */
async function assignedTo(admin) {
  if (!admin) return [];
  const ids = [
    ...(admin.societyId ? [admin.societyId] : []),
    ...(admin.societies || []).map((s) => s.societyId).filter(Boolean),
  ];
  if (!ids.length) return [];
  return Society.find({ _id: { $in: ids }, isDeleted: false })
    .select('societyName societyCode logo status projectType address planExpiryDate')
    .sort({ societyName: 1 })
    .lean();
}

async function byCode(code) {
  const society = await Society.findOne({
    societyCode: String(code).toUpperCase(), isDeleted: false,
  }).lean();
  if (!society) throw notFound(M.not_found);
  return society;
}

async function byPincode(pincode) {
  return Society.find({ 'address.pincode': pincode, isDeleted: false, status: 'Active' })
    .select('societyName societyCode address projectType logo').lean();
}

/** Platform-wide counts for the super-admin dashboard. */
async function platformStats() {
  const [total, active, inactive, pending, units] = await Promise.all([
    Society.countDocuments({ isDeleted: false }),
    Society.countDocuments({ isDeleted: false, status: 'Active' }),
    Society.countDocuments({ isDeleted: false, status: 'Inactive' }),
    Society.countDocuments({ isDeleted: false, status: 'Pending' }),
    SocietyUnit.countDocuments({ isDeleted: false }).setOptions({ allowCrossSociety: true }),
  ]);
  return {
    totalSocieties: total, activeSocieties: active, inactiveSocieties: inactive,
    pendingSocieties: pending, totalUnits: units,
  };
}

/** One society's occupancy and structure counts. */
async function statistics(societyId) {
  const society = await Society.findOne({ _id: societyId, isDeleted: false }).lean();
  if (!society) throw notFound(M.not_found);

  const [blocks, floors, units, occupied, owners, tenants] = await Promise.all([
    SocietyBlock.countDocuments({ societyId, isDeleted: false }),
    SocietyFloor.countDocuments({ societyId, isDeleted: false }),
    SocietyUnit.countDocuments({ societyId, isDeleted: false }),
    SocietyUnit.countDocuments({ societyId, isDeleted: false, occupancyStatus: 'OCCUPIED' }),
    SocietyUnitOccupancy.countDocuments({ societyId, isDeleted: false, isCurrent: true, residentType: 'Owner' }),
    SocietyUnitOccupancy.countDocuments({ societyId, isDeleted: false, isCurrent: true, residentType: 'Tenant' }),
  ]);

  return {
    societyId,
    societyName: society.societyName,
    societyCode: society.societyCode,
    totalBlocks: blocks,
    totalFloors: floors,
    totalUnits: units,
    occupiedUnits: occupied,
    vacantUnits: units - occupied,
    owners,
    tenants,
    occupancyRate: units ? Number(((occupied / units) * 100).toFixed(2)) : 0,
  };
}

/** Society plus its block/floor tree, for the setup screen. */
async function details(societyId) {
  const society = await Society.findOne({ _id: societyId, isDeleted: false }).lean();
  if (!society) throw notFound(M.not_found);

  const [blocks, floors] = await Promise.all([
    SocietyBlock.find({ societyId, isDeleted: false }).sort({ orderNo: 1 }).lean(),
    SocietyFloor.find({ societyId, isDeleted: false }).sort({ floorNumber: 1 }).lean(),
  ]);
  const byBlock = new Map();
  for (const f of floors) {
    const k = String(f.blockId);
    if (!byBlock.has(k)) byBlock.set(k, []);
    byBlock.get(k).push(f);
  }
  return {
    society,
    blocks: blocks.map((b) => ({ ...b, floors: byBlock.get(String(b._id)) || [] })),
  };
}

/** Units on one block, addressed by its letter — the source's `/blocks/:blockLetter`. */
async function blockDetails(societyId, blockLetter) {
  const block = await SocietyBlock.findOne({
    societyId, blockName: new RegExp(`^Block\\s*${blockLetter}$`, 'i'), isDeleted: false,
  }).lean();
  if (!block) throw notFound('Block not found');

  const [floors, units] = await Promise.all([
    SocietyFloor.find({ societyId, blockId: block._id, isDeleted: false }).sort({ floorNumber: 1 }).lean(),
    SocietyUnit.find({ societyId, blockId: block._id, isDeleted: false }).sort({ unitNumber: 1 }).lean(),
  ]);
  return { block, floors, units };
}

async function floorDetails(societyId, blockLetter, floorNumber) {
  const { block } = await blockDetails(societyId, blockLetter);
  const floor = await SocietyFloor.findOne({
    societyId, blockId: block._id, floorNumber: Number(floorNumber), isDeleted: false,
  }).lean();
  if (!floor) throw notFound('Floor not found');

  const units = await SocietyUnit.find({ societyId, floorId: floor._id, isDeleted: false })
    .sort({ unitNumber: 1 }).lean();
  return { block, floor, units };
}

module.exports = {
  ...base,
  create,
  generateCode,
  byCode,
  byPincode,
  platformStats,
  statistics,
  details,
  blockDetails,
  floorDetails,
  createChairman,
  seedEmployeeTypes,
  assignedTo,
  SYSTEM_EMPLOYEE_TYPES,
};
