const occupancy = require('./occupancy');
const { badRequest, notFound } = require('../../lib/errors');
const {
  SocietyResidentOnboardingRequest, SocietyUser, SocietyUnit, SocietyUnitOccupancy,
} = require('../../db/models/society');

/**
 * Resident onboarding: someone claims a unit in the app, a chairman decides.
 *
 * Nothing about this request grants access. Approval is the only thing that
 * creates the `SocietyMember` and `SocietyUnitOccupancy` rows the rest of the
 * module reads, and it does so through `services/society/occupancy.js` — so the
 * one-owner rule and the close-the-previous-tenant rule apply here exactly as
 * they do to an admin assigning a unit by hand.
 */

async function list(ctx, query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const size = Math.max(1, parseInt(query.limit, 10) || 10);

  const filter = { societyId: ctx.societyId, isDeleted: false };
  if (query.status) filter.status = query.status;
  if (query.unitId) filter.unitId = query.unitId;

  const [rows, total] = await Promise.all([
    SocietyResidentOnboardingRequest.find(filter)
      .populate('unitId', 'unitNumber blockNumber floorNumber')
      .sort({ createdAt: -1 }).skip((page - 1) * size).limit(size)
      .lean(),
    SocietyResidentOnboardingRequest.countDocuments(filter),
  ]);

  return {
    requests: rows,
    pagination: { total, page, limit: size, totalPages: Math.ceil(total / size) },
  };
}

async function load(ctx, requestId) {
  const request = await SocietyResidentOnboardingRequest.findOne({
    societyId: ctx.societyId, _id: requestId, isDeleted: false,
  });
  if (!request) throw notFound('Request not found');
  return request;
}

/**
 * Approve or reject.
 *
 * An already-processed request is refused rather than re-run: approving twice
 * would create a second occupancy for the same person, and the source guarded
 * this the same way.
 */
async function process(ctx, requestId, { action, rejectedReason }, actorId) {
  const request = await load(ctx, requestId);
  if (request.status !== 'Pending') throw badRequest('Request already processed');

  if (action === 'reject') {
    request.status = 'Rejected';
    request.rejectedReason = rejectedReason || 'No reason provided';
    await request.save();
    return { requestId, status: 'Rejected' };
  }

  if (action !== 'approve') throw badRequest('action must be approve or reject');

  const person = {
    firstName: request.firstName,
    lastName: request.lastName,
    email: request.email,
    mobileNumber: request.mobileNumber,
    countryCode: request.countryCode,
    gender: request.gender,
    bloodGroup: request.bloodGroup,
  };

  const member = await occupancy.ensureMember({
    societyId: ctx.societyId, userId: request.userId, person, actorId,
  });

  // Throws if the unit already has an owner, which leaves the request Pending
  // rather than half-approved.
  const primary = await occupancy.assign({
    societyId: ctx.societyId,
    unitId: request.unitId,
    userId: request.userId,
    memberId: member._id,
    residentType: request.residentType,
    person,
    documents: {
      rentAgreement: request.rentAgreement,
      policeVerification: request.policeVerification,
      agreementStartDate: request.agreementStartDate,
      agreementEndDate: request.agreementEndDate,
    },
    actorId,
  });

  for (const f of request.familyMembers || []) {
    await occupancy.assign({
      societyId: ctx.societyId,
      unitId: request.unitId,
      residentType: request.residentType,
      parentOccupancyId: primary._id,
      relation: f.relation || null,
      person: f,
      actorId,
    });
  }

  // The app gates the society tab on this flag.
  if (request.userId) {
    await SocietyUser.updateOne(
      { _id: request.userId },
      { $set: { societyId: ctx.societyId, role: request.residentType.toLowerCase() } },
    );
  }

  request.status = 'Approved';
  request.approvedBy = actorId || null;
  request.approvedAt = new Date();
  await request.save();

  return {
    requestId,
    status: 'Approved',
    occupancyId: primary._id,
    memberId: member._id,
    familyMembersCreated: (request.familyMembers || []).length,
  };
}

/** The app-side half: a resident submitting the claim. */
async function submit(ctx, data, userId) {
  const unit = await SocietyUnit.findOne({
    societyId: ctx.societyId, _id: data.unitId, isDeleted: false,
  }).lean();
  if (!unit) throw badRequest('That unit does not exist in this society.');

  const pending = await SocietyResidentOnboardingRequest.findOne({
    societyId: ctx.societyId, unitId: data.unitId, userId, status: 'Pending', isDeleted: false,
  }).lean();
  if (pending) throw badRequest('You already have a pending request for this unit.');

  /**
   * Somebody who already lives here has nothing to request.
   *
   * Only PRIMARY occupancies count: a family member is recorded against the
   * household's own `residentType`, so an owner's son holds an `Owner` row and
   * would otherwise be told he is already the owner when he claims a flat of
   * his own — the same trap the one-owner rule fell into in Phase 3.
   */
  const already = await SocietyUnitOccupancy.findOne({
    societyId: ctx.societyId, unitId: data.unitId, userId,
    memberRole: 'PRIMARY', isCurrent: true, isDeleted: false,
  }).select('residentType').lean();

  if (already) {
    if (already.residentType === data.residentType) {
      throw badRequest('You are already registered for this unit');
    }
    // Owner and tenant of the same flat is not a thing.
    throw badRequest(
      `You are already registered as ${already.residentType} for this unit. `
      + `Cannot register as ${data.residentType}.`,
    );
  }

  /**
   * Only now: is the flat taken by someone else?
   *
   * The source asked this first, which meant the actual owner of a flat, asking
   * to be registered as its owner, was told "This unit already has an owner.
   * Please register as Tenant." Answering the personal questions first turns
   * that into a message about them rather than about a stranger.
   */
  if (data.residentType === 'Owner' && unit.currentOwnerId) {
    throw badRequest('This unit already has an owner. Please register as Tenant.');
  }
  if (data.residentType === 'Tenant' && unit.currentTenantId) {
    throw badRequest('This unit already has a tenant.');
  }

  const created = await SocietyResidentOnboardingRequest.create({
    ...data, societyId: ctx.societyId, userId, status: 'Pending',
  });
  return created.toObject();
}

module.exports = {
  list, load, process, submit,
};
