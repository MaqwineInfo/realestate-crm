const { crud } = require('./factory');
const messages = require('../../lib/society/messages');
const { notFound } = require('../../lib/errors');
const {
  SocietyUser, SocietyUnit, SocietyUnitOccupancy, SocietyAdmin,
} = require('../../db/models/society');

/**
 * Two things share the `/super-admin/users/*` prefix, and they are not the same
 * thing (SOCIETY-PLAN.md §2.3):
 *
 *  - `/users/service-users*` is the **identity** directory — `SocietyUser`.
 *  - `/users/society/:societyId*` and `/users/:id` are **unit** queries wearing
 *    a users URL, left over from before `units` existed. Their own route
 *    comments say so ("Get all units listing", "Get unit statistics"). They are
 *    served from `SocietyUnit` through a façade, so the URLs and response
 *    shapes survive while the data comes from the right collection.
 *
 * This module also internalises the twelve `user-services` HTTP endpoints the
 * society services used to call on every request (§3.6). They are local reads
 * now; nothing here makes a network call.
 */

const identity = crud({
  Model: SocietyUser,
  listKey: 'users',
  searchFields: ['firstName', 'lastName', 'mobileNumber', 'email'],
  filterFields: ['status', 'role', 'societyId', 'isSocietyAdmin'],
  unique: ['mobileNumber'],
  pageParam: 'perPage',
  hasNextPage: true,
  societyScoped: false,
  sort: { createdAt: -1 },
});

/* ------------------------- the unit-shaped façade ------------------------- */

const unitsForSociety = crud({
  Model: SocietyUnit,
  listKey: 'users',
  searchFields: ['unitNumber', 'blockNumber'],
  filterFields: ['status', 'occupancyStatus', 'residentType', 'blockId', 'floorId', 'booked'],
  pageParam: 'perPage',
  hasNextPage: true,
  sort: { unitNumber: 1 },
});

/**
 * Units with their current residents attached, under the legacy `users` key.
 *
 * The occupancy join is what the old flat `users` document used to hold inline.
 * It is fetched in one query for the whole page and stitched in memory rather
 * than per row, so a 400-unit society is two queries, not four hundred.
 */
async function listBySociety(ctx, societyId, query) {
  const page = await unitsForSociety.list({ societyId }, query);
  const unitIds = page.users.map((u) => u._id);

  const occupancies = await SocietyUnitOccupancy.find({
    societyId, unitId: { $in: unitIds }, isCurrent: true, isDeleted: false,
  }).lean();

  const byUnit = new Map();
  for (const o of occupancies) {
    const k = String(o.unitId);
    if (!byUnit.has(k)) byUnit.set(k, []);
    byUnit.get(k).push(o);
  }

  page.users = page.users.map((unit) => {
    const residents = byUnit.get(String(unit._id)) || [];
    const primary = residents.find((r) => r.isPrimary) || residents[0] || null;
    return {
      ...unit,
      residents,
      residentName: primary ? [primary.firstName, primary.lastName].filter(Boolean).join(' ') : null,
      mobileNumber: primary?.mobileNumber || null,
      email: primary?.email || null,
    };
  });
  return page;
}

/** Unpaginated units, for dropdowns — the source's `/society/:id/all`. */
const allUnits = (ctx, societyId) => unitsForSociety.all({ societyId }, {});

async function unitStats(societyId) {
  const [total, occupied, owner, tenant, booked] = await Promise.all([
    SocietyUnit.countDocuments({ societyId, isDeleted: false }),
    SocietyUnit.countDocuments({ societyId, isDeleted: false, occupancyStatus: 'OCCUPIED' }),
    SocietyUnit.countDocuments({ societyId, isDeleted: false, residentType: 'Owner' }),
    SocietyUnit.countDocuments({ societyId, isDeleted: false, residentType: 'Tenant' }),
    SocietyUnit.countDocuments({ societyId, isDeleted: false, booked: true }),
  ]);
  return {
    totalUnits: total,
    occupiedUnits: occupied,
    vacantUnits: total - occupied,
    ownerOccupied: owner,
    tenantOccupied: tenant,
    bookedUnits: booked,
  };
}

async function unitByNumber(societyId, unitNumber) {
  const unit = await SocietyUnit.findOne({ societyId, unitNumber, isDeleted: false }).lean();
  if (!unit) throw notFound('Unit not found');
  const residents = await SocietyUnitOccupancy.find({
    societyId, unitId: unit._id, isCurrent: true, isDeleted: false,
  }).lean();
  return { ...unit, residents };
}

/** `/users/:id` — an id-anchored unit read, so no society pin is needed. */
async function unitById(id) {
  const unit = await SocietyUnit.findOne({ _id: id, isDeleted: false }).lean();
  if (!unit) throw notFound('Unit not found');
  return unit;
}

async function updateUnit(id, data, actorId) {
  const unit = await SocietyUnit.findOne({ _id: id, isDeleted: false }).select('societyId').lean();
  if (!unit) throw notFound('Unit not found');
  return unitsForSociety.update({ societyId: unit.societyId }, id, data, actorId);
}

/* --------------------------- identity directory --------------------------- */

async function serviceUserById(userId) {
  const user = await SocietyUser.findOne({ _id: userId, isDeleted: false }).lean();
  if (!user) throw notFound(messages.en.user.user_not_found);
  delete user.otp;
  return user;
}

/**
 * Grant or revoke the society-admin flag.
 *
 * Revoking also deactivates the matching `SocietyAdmin` rows: leaving the flag
 * off while the admin record stays active would let the person keep signing in,
 * which is the opposite of what "remove society admin" means.
 */
async function setSocietyAdminFlag(userId, { value, societyId }, actorId) {
  const user = await SocietyUser.findOneAndUpdate(
    { _id: userId, isDeleted: false },
    { $set: { isSocietyAdmin: Boolean(value), ...(societyId ? { societyId } : {}) } },
    { new: true },
  ).lean();
  if (!user) throw notFound(messages.en.user.user_not_found);

  if (!value) {
    await SocietyAdmin.updateMany(
      { userId, isDeleted: false },
      { $set: { isActive: false, updatedBy: actorId || null } },
    );
  }
  delete user.otp;
  return user;
}

/** The `user-services` lookup the middleware used to make over HTTP. */
async function detail(userId) {
  return serviceUserById(userId);
}

/**
 * `users/create/public-user` — an identity for someone who has only ever
 * submitted an enquiry. Upsert on mobile number, because the same person
 * enquiring twice is one user.
 */
async function createPublicUser({ mobileNumber, countryCode = '+91', firstName, lastName, email }) {
  await SocietyUser.updateOne(
    { mobileNumber },
    {
      $setOnInsert: { mobileNumber, countryCode },
      $set: {
        firstName: firstName || '', lastName: lastName || '', email: email || null,
      },
    },
    { upsert: true },
  );
  return SocietyUser.findOne({ mobileNumber }).lean();
}

module.exports = {
  identity,
  list: identity.list,
  listBySociety,
  allUnits,
  unitStats,
  unitByNumber,
  unitById,
  updateUnit,
  serviceUserById,
  setSocietyAdminFlag,
  detail,
  createPublicUser,
};
