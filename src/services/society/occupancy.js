const seams = require('./seams');
const { badRequest, notFound, conflict } = require('../../lib/errors');
const {
  SocietyUnit, SocietyUnitOccupancy, SocietyMember, SocietyUser,
} = require('../../db/models/society');

/**
 * The single write path for "who lives in this unit".
 *
 * Three flows need it — a super admin assigning a unit, a chairman approving an
 * onboarding request, and a resident's tenancy ending — and the source
 * implemented the rules separately in each. They drifted: the legacy assign
 * endpoint overwrote `unit.memberId` with no history and no owner check, while
 * the onboarding path closed prior tenants and refused a second owner. Both
 * routes come through here now, so a unit cannot end up with two owners
 * depending on which screen was used.
 *
 * The rules, in one place:
 *  - a unit has at most ONE current owner
 *  - a new tenant ends the previous tenancy rather than coexisting with it
 *  - nothing is deleted: an ended tenure keeps `isCurrent: false` and an
 *    `endDate`, so last year's complaint still resolves to who raised it
 *  - the unit's denormalised `residentType` / `isOccupied` / `occupancyStatus`
 *    are recomputed from the occupancy rows, never set by hand
 */

/** Recomputes the unit's cached occupancy fields from its live occupancy rows. */
async function syncUnit(societyId, unitId) {
  const current = await SocietyUnitOccupancy.find({
    societyId, unitId, isCurrent: true, isDeleted: false,
  }).lean();

  const owner = current.find((o) => o.residentType === 'Owner');
  const tenant = current.find((o) => o.residentType === 'Tenant');
  // A tenant in residence is what the unit reads as, even when an owner exists.
  const residentType = tenant ? 'Tenant' : (owner ? 'Owner' : 'Vacant');

  await SocietyUnit.updateOne({ societyId, _id: unitId }, {
    $set: {
      currentOwnerId: owner?._id || null,
      currentTenantId: tenant?._id || null,
      residentType,
      isOccupied: current.length > 0,
      occupancyStatus: current.length > 0 ? 'OCCUPIED' : 'VACANT',
      booked: current.length > 0,
    },
  });

  return { owner, tenant, count: current.length };
}

/**
 * Places a resident in a unit and returns the new occupancy row.
 *
 * `memberRole: 'PRIMARY'` unless a `parentOccupancyId` is given, which is how
 * family members attach to the resident who registered them.
 */
async function assign({
  societyId, unitId, userId = null, memberId = null, residentType,
  person = {}, parentOccupancyId = null, relation = null, documents = {}, actorId = null,
}) {
  const unit = await SocietyUnit.findOne({ societyId, _id: unitId, isDeleted: false }).lean();
  if (!unit) throw notFound('Unit not found or does not belong to this society.');
  if (!['Owner', 'Tenant'].includes(residentType)) throw badRequest('residentType must be Owner or Tenant.');

  /**
   * Both rules below apply to PRIMARY residents only.
   *
   * A family member is stored with the household's own `residentType` — an
   * owner's son is an 'Owner' row with a `parentOccupancyId` — so without this
   * exemption, adding a family member to an owned unit trips the one-owner
   * check against the very resident they belong to, and closes their own
   * household's tenancy.
   */
  if (!parentOccupancyId && residentType === 'Owner') {
    const existing = await SocietyUnitOccupancy.findOne({
      societyId, unitId, residentType: 'Owner', memberRole: 'PRIMARY', isCurrent: true, isDeleted: false,
    }).lean();
    // Two owners is not a state the rest of the module can represent, so it is
    // refused rather than silently replacing whoever was there.
    if (existing) throw conflict('Unit already has an active owner');
  }

  if (residentType === 'Tenant' && !parentOccupancyId) {
    // Ends the outgoing tenancy AND the family attached to it — leaving their
    // rows current would keep a departed household's visitors auto-approved.
    const outgoing = await SocietyUnitOccupancy.find({
      societyId, unitId, residentType: 'Tenant', memberRole: 'PRIMARY', isCurrent: true, isDeleted: false,
    }).select('_id').lean();
    const ids = outgoing.map((o) => o._id);
    if (ids.length) {
      await SocietyUnitOccupancy.updateMany(
        {
          societyId,
          unitId,
          isCurrent: true,
          isDeleted: false,
          $or: [{ _id: { $in: ids } }, { parentOccupancyId: { $in: ids } }],
        },
        { $set: { isCurrent: false, endDate: new Date() } },
      );
    }
  }

  const occupancy = await SocietyUnitOccupancy.create({
    societyId,
    unitId,
    userId,
    memberId,
    residentType,
    memberRole: parentOccupancyId ? 'FAMILY' : 'PRIMARY',
    parentOccupancyId,
    relation,
    isPrimary: !parentOccupancyId,
    isCurrent: true,
    startDate: new Date(),
    firstName: person.firstName || null,
    lastName: person.lastName || null,
    mobileNumber: person.mobileNumber || null,
    countryCode: person.countryCode || '+91',
    email: person.email || null,
    gender: person.gender || null,
    age: person.age || null,
    bloodGroup: person.bloodGroup || null,
    profilePhoto: person.profilePhoto || null,
    rentAgreement: documents.rentAgreement || null,
    policeVerification: documents.policeVerification || null,
    agreementStartDate: documents.agreementStartDate || null,
    agreementEndDate: documents.agreementEndDate || null,
    agreementStatus: documents.agreementEndDate ? 'ACTIVE' : null,
    createdBy: actorId,
  });

  await syncUnit(societyId, unitId);

  /**
   * Seam 3 (D4): the same person is a resident here and a CRM contact when they
   * come to sell. Deliberately not awaited into the result — moving in must not
   * fail because the sales side is unreachable.
   */
  if (userId) {
    seams.contactFromResident({
      societyUserId: userId, mobileNumber: person.mobileNumber || null,
    }).catch(() => {});
  }

  return occupancy.toObject();
}

/**
 * Ends a tenure. Family members attached to it end with it — leaving them
 * `isCurrent` would keep a moved-out household's visitors auto-approved.
 */
async function release({ societyId, occupancyId, actorId = null }) {
  const occupancy = await SocietyUnitOccupancy.findOne({
    societyId, _id: occupancyId, isCurrent: true, isDeleted: false,
  });
  if (!occupancy) throw notFound('That occupancy is not current.');

  const endedAt = new Date();
  await SocietyUnitOccupancy.updateMany(
    {
      societyId,
      isCurrent: true,
      isDeleted: false,
      $or: [{ _id: occupancyId }, { parentOccupancyId: occupancyId }],
    },
    { $set: { isCurrent: false, endDate: endedAt, updatedBy: actorId } },
  );

  await syncUnit(societyId, occupancy.unitId);
  return { unitId: occupancy.unitId, endedAt };
}

/** Everyone currently in a unit, primary residents first. */
async function forUnit(societyId, unitId) {
  return SocietyUnitOccupancy.find({
    societyId, unitId, isCurrent: true, isDeleted: false,
  }).sort({ memberRole: 1, createdAt: 1 }).lean();
}

/**
 * Ensures the person has a `SocietyMember` profile, creating one if this is
 * their first unit. Upsert on mobile number: the same person taking a second
 * flat is one member, not two.
 */
async function ensureMember({ societyId, userId, person = {}, actorId = null }) {
  const mobileNumber = person.mobileNumber
    || (userId ? (await SocietyUser.findById(userId).lean())?.mobileNumber : null);
  if (!mobileNumber) throw badRequest('A mobile number is required to create a member.');

  await SocietyMember.updateOne(
    { societyId, mobileNumber, isDeleted: false },
    {
      $setOnInsert: { societyId, mobileNumber, createdBy: actorId },
      $set: {
        // Only set when known: writing an explicit null would still occupy a
        // slot in any index that treats null as a value.
        ...(userId ? { userId } : {}),
        firstName: person.firstName || '',
        lastName: person.lastName || '',
        email: person.email || null,
        countryCode: person.countryCode || '+91',
        gender: person.gender || null,
        status: 'ACTIVE',
      },
    },
    { upsert: true },
  );
  return SocietyMember.findOne({ societyId, mobileNumber, isDeleted: false }).lean();
}

module.exports = {
  assign, release, syncUnit, forUnit, ensureMember,
};
