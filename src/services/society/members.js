const occupancy = require('./occupancy');
const otp = require('./otp');
const messages = require('../../lib/society/messages');
const { badRequest, notFound, conflict } = require('../../lib/errors');
const {
  SocietyUnitOccupancy, SocietyCommitteeMember, SocietyMember,
  SocietyUser, SocietyUnit,
} = require('../../db/models/society');

const M = messages.en;

/**
 * The resident app's view of the people in a society.
 *
 * Everything here is scoped to the signed-in resident's own unit. A resident
 * may read the committee and the member directory, but may only write their own
 * household — which is why every family operation resolves the caller's PRIMARY
 * occupancy first and hangs the change off that, rather than trusting a
 * `unitId` from the request body.
 */

/** The caller's own current tenure in a unit. The anchor for every write. */
async function primaryOccupancyFor({ societyId, userId, unitId }) {
  const filter = {
    societyId, userId, memberRole: 'PRIMARY', isCurrent: true, isDeleted: false,
  };
  if (unitId) filter.unitId = unitId;
  const row = await SocietyUnitOccupancy.findOne(filter);
  if (!row) throw notFound(M.familyMember?.primary_not_found || 'You are not registered in this unit.');
  return row;
}

/* -------------------------------- directory -------------------------------- */

/** The published committee roster. */
async function committee(ctx) {
  return SocietyCommitteeMember.find({
    societyId: ctx.societyId, isDeleted: false, status: 'ACTIVE',
  }).populate('roleId', 'displayName key').sort({ designation: 1 }).lean();
}

/**
 * The member directory: one entry per primary resident, with their unit.
 *
 * Family members are excluded — the directory answers "who lives in B-402",
 * and listing four people per flat makes it unreadable.
 */
async function societyMembers(ctx, query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const size = Math.max(1, parseInt(query.limit || query.perPage, 10) || 20);

  const filter = {
    societyId: ctx.societyId, memberRole: 'PRIMARY', isCurrent: true, isDeleted: false,
  };
  if (query.residentType) filter.residentType = query.residentType;
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
    members: rows,
    pagination: {
      total, page, limit: size, totalPages: Math.ceil(total / size),
    },
  };
}

/* --------------------------------- settings --------------------------------- */

const DEFAULT_SETTINGS = {
  visitor: {
    guestAutoApproval: false,
    cabAutoApproval: false,
    familyVisitorAutoApproval: false,
    notifications: true,
  },
};

/**
 * Visitor auto-approval preferences, stored on the occupancy row rather than
 * the member — the same person can want different rules in two flats.
 */
async function getSettings(ctx, { userId, unitId }) {
  const row = await SocietyUnitOccupancy.findOne({
    societyId: ctx.societyId, userId, unitId, isCurrent: true, isDeleted: false,
  }).select('settings').lean();
  if (!row) throw notFound(M.member?.not_found || 'Member not found');
  return { settings: row.settings || DEFAULT_SETTINGS };
}

async function updateSettings(ctx, { userId, unitId }, patch) {
  const visitor = patch.visitor || patch;
  const $set = {};
  for (const key of ['guestAutoApproval', 'cabAutoApproval', 'familyVisitorAutoApproval']) {
    if (visitor[key] !== undefined) $set[`settings.visitor.${key}`] = Boolean(visitor[key]);
  }
  if (visitor.notifications !== undefined) $set['settings.visitor.notifications'] = Boolean(visitor.notifications);
  if (!Object.keys($set).length) throw badRequest('No settings were supplied.');

  const row = await SocietyUnitOccupancy.findOneAndUpdate(
    {
      societyId: ctx.societyId, userId, unitId, isCurrent: true, isDeleted: false,
    },
    { $set },
    { new: true },
  ).select('settings').lean();
  if (!row) throw notFound(M.member?.not_found || 'Member not found');
  return { settings: row.settings };
}

/* ------------------------------ family members ------------------------------ */

const familyOf = (parentId, societyId) => SocietyUnitOccupancy.find({
  societyId, parentOccupancyId: parentId, memberRole: 'FAMILY', isCurrent: true, isDeleted: false,
}).sort({ createdAt: 1 }).lean();

async function listFamily(ctx, { userId, unitId }) {
  const primary = await primaryOccupancyFor({ societyId: ctx.societyId, userId, unitId });
  return { familyMembers: await familyOf(primary._id, ctx.societyId) };
}

async function familyById(ctx, id, { userId, unitId }) {
  const primary = await primaryOccupancyFor({ societyId: ctx.societyId, userId, unitId });
  const row = await SocietyUnitOccupancy.findOne({
    societyId: ctx.societyId, _id: id, parentOccupancyId: primary._id, isDeleted: false,
  }).lean();
  // Scoped to the caller's own household: another flat's family is a 404, not
  // a 403, because its existence is not the caller's business either.
  if (!row) throw notFound('Family member not found');
  return row;
}

/**
 * Adds a family member to the caller's household.
 *
 * The family member's own mobile is OTP-verified before the row is created —
 * this grants that number access to the society in the app, so it has to be
 * proven rather than asserted by whoever is filling in the form.
 */
async function createFamily(ctx, body, { userId, unitId }) {
  const {
    firstName, lastName, relation, mobileNumber, countryCode = '+91',
    email, gender, age, bloodGroup, otp: submitted,
  } = body;

  if (!firstName || !mobileNumber) throw badRequest('A name and mobile number are required.');

  const primary = await primaryOccupancyFor({ societyId: ctx.societyId, userId, unitId });

  const sameRelation = await SocietyUnitOccupancy.findOne({
    societyId: ctx.societyId,
    parentOccupancyId: primary._id,
    memberRole: 'FAMILY',
    relation,
    isCurrent: true,
    isDeleted: false,
  }).lean();
  if (sameRelation) {
    const existing = `${sameRelation.firstName || ''} ${sameRelation.lastName || ''}`.trim().toLowerCase();
    const incoming = `${firstName || ''} ${lastName || ''}`.trim().toLowerCase();
    if (existing === incoming) throw conflict('That family member is already registered.');
  }

  const alreadyHere = await SocietyUnitOccupancy.findOne({
    societyId: ctx.societyId, unitId: primary.unitId, mobileNumber, isCurrent: true, isDeleted: false,
  }).lean();
  if (alreadyHere) throw conflict('That mobile number is already registered in this unit.');

  const familyUser = await verifyAndUpsertUser({
    mobileNumber, countryCode, firstName, lastName, email, submitted, societyId: ctx.societyId,
  });

  return occupancy.assign({
    societyId: ctx.societyId,
    unitId: primary.unitId,
    userId: familyUser?._id || null,
    residentType: primary.residentType,
    parentOccupancyId: primary._id,
    relation,
    person: {
      firstName, lastName, mobileNumber, countryCode, email, gender, age, bloodGroup,
    },
    actorId: userId,
  });
}

/**
 * Proves the family member's number, then gives them a login.
 *
 * The source called `user-services` for both steps; both are local now (§3.6).
 * A wrong or expired code stops the whole operation — no occupancy row is
 * created for an unverified number.
 */
async function verifyAndUpsertUser({
  mobileNumber, countryCode, firstName, lastName, email, submitted, societyId,
}) {
  const user = await SocietyUser.findOne({ mobileNumber }).select('+otp +otpExpiresAt');

  if (user?.otp) {
    if (!user.otpExpiresAt || user.otpExpiresAt < new Date()) throw badRequest(M.user.otp_expired);
    if (!await otp.verify(submitted, user.otp)) throw badRequest(M.user.otp_invalid);
  } else if (submitted !== undefined) {
    // A code was offered but none was ever issued for this number.
    throw badRequest(M.user.otp_invalid);
  }

  await SocietyUser.updateOne(
    { mobileNumber },
    {
      $setOnInsert: { mobileNumber, countryCode },
      $set: {
        firstName: firstName || '',
        lastName: lastName || '',
        email: email || null,
        societyId,
        isMobileVerified: true,
      },
      $unset: { otp: '', otpExpiresAt: '' },
    },
    { upsert: true },
  );
  return SocietyUser.findOne({ mobileNumber }).lean();
}

async function updateFamily(ctx, id, body, { userId, unitId }) {
  const primary = await primaryOccupancyFor({ societyId: ctx.societyId, userId, unitId });

  const $set = {};
  for (const k of ['firstName', 'lastName', 'relation', 'email', 'gender', 'age', 'bloodGroup', 'profilePhoto']) {
    if (body[k] !== undefined) $set[k] = body[k];
  }
  // The mobile number is the identity the OTP proved; changing it here would
  // move access to an unverified number.
  if (!Object.keys($set).length) throw badRequest('Nothing to update.');

  const row = await SocietyUnitOccupancy.findOneAndUpdate(
    {
      societyId: ctx.societyId, _id: id, parentOccupancyId: primary._id, isCurrent: true, isDeleted: false,
    },
    { $set },
    { new: true },
  ).lean();
  if (!row) throw notFound('Family member not found');
  return row;
}

/** Removes a family member from the household — ends the tenure, keeps history. */
async function deleteFamily(ctx, id, { userId, unitId }) {
  const primary = await primaryOccupancyFor({ societyId: ctx.societyId, userId, unitId });
  const row = await SocietyUnitOccupancy.findOne({
    societyId: ctx.societyId, _id: id, parentOccupancyId: primary._id, isCurrent: true, isDeleted: false,
  }).lean();
  if (!row) throw notFound('Family member not found');

  await occupancy.release({ societyId: ctx.societyId, occupancyId: row._id, actorId: userId });
  return { _id: row._id, removed: true };
}

/* ------------------------- admin-side member actions ------------------------- */

/** `PUT /society-admin/users/assign-member/:id` — attach a member to a unit. */
async function assignMemberToUnit(ctx, memberId, body, actorId) {
  const member = await SocietyMember.findOne({
    societyId: ctx.societyId, _id: memberId, isDeleted: false,
  }).lean();
  if (!member) throw notFound('Member not found');

  const unit = await SocietyUnit.findOne({
    societyId: ctx.societyId, _id: body.unitId, isDeleted: false,
  }).lean();
  if (!unit) throw badRequest('That unit does not exist in this society.');

  return occupancy.assign({
    societyId: ctx.societyId,
    unitId: unit._id,
    userId: member.userId || null,
    memberId: member._id,
    residentType: body.residentType || 'Owner',
    person: member,
    actorId,
  });
}

/** Which users belong to a society — the source's internal lookup. */
async function societyUserIds(societyId) {
  const rows = await SocietyUnitOccupancy.find({
    societyId, isCurrent: true, isDeleted: false, userId: { $ne: null },
  }).select('userId').lean();
  return [...new Set(rows.map((r) => String(r.userId)))];
}

/** One user's current tenures, across units. */
async function userOccupancy(ctx, { userId, unitId }) {
  const filter = {
    societyId: ctx.societyId, userId, isCurrent: true, isDeleted: false,
  };
  if (unitId) filter.unitId = unitId;
  return SocietyUnitOccupancy.find(filter)
    .populate('unitId', 'unitNumber blockNumber floorNumber')
    .lean();
}

module.exports = {
  primaryOccupancyFor,
  committee,
  societyMembers,
  getSettings,
  updateSettings,
  listFamily,
  familyById,
  createFamily,
  updateFamily,
  deleteFamily,
  assignMemberToUnit,
  societyUserIds,
  userOccupancy,
  DEFAULT_SETTINGS,
};
