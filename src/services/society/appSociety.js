const { notFound, badRequest } = require('../../lib/errors');
const messages = require('../../lib/society/messages');
const {
  Society, SocietyUnit, SocietyBlock, SocietyFloor, SocietyUnitOccupancy,
} = require('../../db/models/society');

const M = messages.en;

/**
 * What the resident app sees of societies — `/api/v1/app/society/*`.
 *
 * These are the only society reads that are NOT pinned to one society by the
 * `x-society-id` header: a resident browsing for the building they live in has
 * not joined one yet. So every model touched here is either platform-scoped
 * (`Society`) or read with an explicit cross-society opt-out, and each query
 * narrows by something the caller genuinely owns — their own `userId`, or a
 * society id they passed and which is public anyway.
 */

/** Live counts, because the stored totals on `Society` are a creation-time estimate. */
async function countsFor(societyIds) {
  const ids = societyIds.map(String);
  const tally = async (Model) => {
    const rows = await Model.aggregate([
      { $match: { societyId: { $in: societyIds }, isDeleted: false } },
      { $group: { _id: '$societyId', n: { $sum: 1 } } },
    ]).option({ allowCrossSociety: true });
    return Object.fromEntries(rows.map((r) => [String(r._id), r.n]));
  };
  const [blocks, floors, units] = await Promise.all([
    tally(SocietyBlock), tally(SocietyFloor), tally(SocietyUnit),
  ]);
  const pick = (map) => Object.fromEntries(ids.map((id) => [id, map[id] || 0]));
  return { blocks: pick(blocks), floors: pick(floors), units: pick(units) };
}

/**
 * The browse list. Societies the caller already lives in are excluded — this
 * screen exists to join a new one, and their own are on `my-societies`.
 */
async function browse(userId, query = {}) {
  const {
    page = 1, perPage = 10, search, status, projectType,
    sortBy = 'createdAt', sortOrder = 'desc',
  } = query;
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.max(1, parseInt(perPage, 10) || 10);

  const filter = { isDeleted: false };
  if (status) filter.status = status;
  if (projectType) filter.projectType = projectType;
  if (search) {
    const safe = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      { societyName: new RegExp(safe, 'i') },
      { societyCode: new RegExp(safe, 'i') },
      { 'address.city': new RegExp(safe, 'i') },
    ];
  }

  const mine = await SocietyUnitOccupancy.find({ userId, isCurrent: true, isDeleted: false })
    .setOptions({ allowCrossSociety: true }).distinct('societyId');
  if (mine.length) filter._id = { $nin: mine };

  const sort = { [sortBy]: String(sortOrder).toLowerCase() === 'asc' ? 1 : -1 };
  const [total, rows] = await Promise.all([
    Society.countDocuments(filter),
    Society.find(filter).sort(sort).skip((pageNum - 1) * limitNum).limit(limitNum).lean(),
  ]);

  const counts = await countsFor(rows.map((r) => r._id));
  const members = await SocietyUnitOccupancy.aggregate([
    { $match: { societyId: { $in: rows.map((r) => r._id) }, isCurrent: true } },
    { $group: { _id: '$societyId', users: { $addToSet: '$userId' } } },
  ]).option({ allowCrossSociety: true });
  const memberCount = Object.fromEntries(members.map((m) => [String(m._id), m.users.length]));

  const totalPages = Math.ceil(total / limitNum);
  return {
    societies: rows.map((s) => ({
      ...s,
      totalMembers: memberCount[String(s._id)] || 0,
      totalBlocks: counts.blocks[String(s._id)],
      totalFloors: counts.floors[String(s._id)],
      totalUnits: counts.units[String(s._id)],
    })),
    pagination: {
      total,
      page: pageNum,
      limit: limitNum,
      totalPages,
      hasNextPage: pageNum < totalPages,
      hasPrevPage: pageNum > 1,
    },
  };
}

/**
 * The unit picker: every flat in the building, grouped block → floor, with
 * whether it is already spoken for. This is what a resident taps through to say
 * "that one is mine".
 */
async function structureOf(societyId) {
  const society = await Society.findOne({ _id: societyId, isDeleted: false }).lean();
  if (!society) throw notFound(M.society.not_found);

  const ctx = { societyId: society._id };
  const [units, occupancies] = await Promise.all([
    SocietyUnit.find({ ...ctx, isDeleted: false })
      .select('_id unitNumber blockNumber floorNumber booked isOccupied currentOwnerId currentTenantId')
      .sort({ blockNumber: 1, floorNumber: 1, unitNumber: 1 }).lean(),
    SocietyUnitOccupancy.find({ ...ctx, isCurrent: true, isDeleted: false })
      .select('unitId residentType').lean(),
  ]);

  const residentTypeOf = new Map(occupancies.map((o) => [String(o.unitId), o.residentType]));
  const blocksMap = new Map();

  for (const unit of units) {
    const key = unit.blockNumber;
    if (!blocksMap.has(key)) {
      blocksMap.set(key, {
        blockName: `Block ${key}`,
        blockLetter: key,
        totalFloors: 0,
        totalUnits: 0,
        bookedUnits: 0,
        floors: new Map(),
      });
    }
    const block = blocksMap.get(key);
    block.totalUnits += 1;
    if (unit.booked) block.bookedUnits += 1;

    if (!block.floors.has(unit.floorNumber)) {
      block.floors.set(unit.floorNumber, { floorNumber: unit.floorNumber, units: [] });
    }
    block.floors.get(unit.floorNumber).units.push({
      _id: unit._id,
      unitNumber: unit.unitNumber,
      booked: unit.booked,
      isOccupied: unit.isOccupied,
      residentType: residentTypeOf.get(String(unit._id)) || null,
      hasOwner: Boolean(unit.currentOwnerId),
      hasTenant: Boolean(unit.currentTenantId),
    });
  }

  const blocks = [...blocksMap.values()].map((block) => {
    const floors = [...block.floors.values()].sort((a, b) => a.floorNumber - b.floorNumber);
    return { ...block, totalFloors: floors.length, floors };
  }).sort((a, b) => String(a.blockLetter).localeCompare(String(b.blockLetter)));

  const counts = await countsFor([society._id]);
  const id = String(society._id);
  return {
    societyInfo: {
      id: society._id,
      name: society.societyName,
      code: society.societyCode,
      status: society.status,
      totalBlocks: counts.blocks[id],
      totalUnits: counts.units[id],
      floorsPerBlock: counts.floors[id],
      description: society.description,
      logo: society.logo,
      projectType: society.projectType,
      developerName: society.developerName,
      address: society.address
        ? `${society.address.street}, ${society.address.city}, ${society.address.state} - ${society.address.pincode}`
        : '',
    },
    blocks,
  };
}

/**
 * The society the caller actually lives in.
 *
 * The source resolved it from `Unit.currentOwnerId` / `currentTenantId`, which
 * only ever finds the primary occupant — a family member added to a flat got a
 * 404 on their own building. Resolved from the occupancy instead, which is
 * where every resident is recorded, family included.
 */
async function assigned(userId) {
  const occupancy = await SocietyUnitOccupancy.findOne({
    userId, isCurrent: true, isDeleted: false,
  }).setOptions({ allowCrossSociety: true })
    .sort({ isPrimary: -1, createdAt: 1 }).lean();
  if (!occupancy) throw notFound(M.society.not_found);
  return structureOf(occupancy.societyId);
}

/** Every society the caller holds a unit in, with the units they hold. */
async function mySocieties(userId, query = {}) {
  const {
    page = 1, perPage = 12, search, status, projectType, residentType, memberRole,
    sortBy = 'createdAt', sortOrder = 'desc',
  } = query;
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.max(1, parseInt(perPage, 10) || 12);

  const filter = { userId, isCurrent: true, isDeleted: false };
  if (['PRIMARY', 'FAMILY'].includes(memberRole)) filter.memberRole = memberRole;
  if (['Owner', 'Tenant'].includes(residentType)) filter.residentType = residentType;

  const occupancies = await SocietyUnitOccupancy.find(filter)
    .setOptions({ allowCrossSociety: true })
    .populate('societyId', 'societyName societyCode status totalBlocks totalUnits totalFloors description logo projectType developerName address createdAt')
    .populate('unitId', 'unitNumber blockNumber floorNumber')
    .lean();

  if (!occupancies.length) {
    return {
      empty: true,
      societies: [],
      pagination: { total: 0, page: pageNum, perPage: limitNum, totalPages: 0 },
    };
  }

  const byId = new Map();
  for (const occ of occupancies) {
    if (!occ.societyId || !occ.unitId) continue;
    const key = String(occ.societyId._id);
    if (!byId.has(key)) byId.set(key, { ...occ.societyId, myUnits: [] });
    byId.get(key).myUnits.push({
      unitId: occ.unitId._id,
      occupancyId: occ._id,
      unitNumber: occ.unitId.unitNumber,
      blockNumber: occ.unitId.blockNumber,
      floorNumber: occ.unitId.floorNumber,
      residentType: occ.residentType,
      memberRole: occ.memberRole,
      relation: occ.relation,
      isPrimary: occ.isPrimary,
      startDate: occ.startDate,
      memberId: occ.memberId || null,
      firstName: occ.firstName || null,
      lastName: occ.lastName || null,
    });
  }

  let societies = [...byId.values()].filter((s) => s.myUnits.length);
  const counts = await countsFor(societies.map((s) => s._id));
  const members = await SocietyUnitOccupancy.aggregate([
    { $match: { societyId: { $in: societies.map((s) => s._id) }, isCurrent: true } },
    { $group: { _id: '$societyId', users: { $addToSet: '$userId' } } },
  ]).option({ allowCrossSociety: true });
  const memberCount = Object.fromEntries(members.map((m) => [String(m._id), m.users.length]));

  societies = societies.map((s) => ({
    ...s,
    totalBlocks: counts.blocks[String(s._id)],
    totalFloors: counts.floors[String(s._id)],
    totalUnits: counts.units[String(s._id)],
    totalMembers: memberCount[String(s._id)] || 0,
  }));

  if (search) {
    const needle = String(search).toLowerCase();
    societies = societies.filter((s) => s.societyName?.toLowerCase().includes(needle)
      || s.societyCode?.toLowerCase().includes(needle));
  }
  if (status) societies = societies.filter((s) => s.status === status);
  if (projectType) societies = societies.filter((s) => s.projectType === projectType);

  const dir = String(sortOrder).toLowerCase() === 'asc' ? 1 : -1;
  societies.sort((a, b) => {
    if (sortBy === 'societyName') return dir * (a.societyName || '').localeCompare(b.societyName || '');
    if (sortBy === 'societyCode') return dir * (a.societyCode || '').localeCompare(b.societyCode || '');
    return dir * (new Date(a.createdAt) - new Date(b.createdAt));
  });

  const total = societies.length;
  return {
    societies: societies.slice((pageNum - 1) * limitNum, pageNum * limitNum),
    pagination: { total, page: pageNum, perPage: limitNum, totalPages: Math.ceil(total / limitNum) },
  };
}

/**
 * "That flat is mine" — raises an onboarding request for an admin to approve.
 *
 * Nothing here grants residency: it writes a Pending row and stops. The
 * unit-level checks live in `onboarding.submit`, which is also what the admin
 * screens post to, so the two cannot drift apart.
 */
async function registerResident(userId, data) {
  const { societyId, unitId, residentType } = data;
  if (!societyId) throw badRequest(M.society.societyId_required);

  const unit = await SocietyUnit.findOne({ societyId, _id: unitId, isDeleted: false }).lean();
  if (!unit) throw notFound(M.society.unit_not_found);

  // Every other check — already living here, dual role, flat already taken —
  // is `onboarding.submit`'s, which is also what the admin screens post to.
  const onboarding = require('./onboarding');
  const request = await onboarding.submit({ societyId: unit.societyId }, {
    unitId: unit._id,
    residentType,
    ownershipProofUrl: data.ownershipProof || data.ownershipProofUrl || null,
    firstName: data.firstName,
    lastName: data.lastName,
    email: data.email || null,
    countryCode: data.countryCode || '+91',
    mobileNumber: data.mobileNumber,
    gender: data.gender || null,
    bloodGroup: data.bloodGroup || null,
    rentAgreement: data.rentAgreement || null,
    policeVerification: data.policeVerification || null,
    agreementStartDate: data.agreementStartDate || null,
    agreementEndDate: data.agreementEndDate || null,
  }, userId);

  return { requestId: request._id };
}

module.exports = {
  browse, structureOf, assigned, mySocieties, registerResident, countsFor,
};
