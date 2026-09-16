const crypto = require('node:crypto');
const QRCode = require('qrcode');
const { crud } = require('./factory');
const messaging = require('./messaging');
const { badRequest, notFound, conflict } = require('../../lib/errors');
const {
  SocietyVisitor, SocietyVisitorLog, SocietyVisitorPass, SocietyUnit,
  SocietyUnitOccupancy, SocietyNotification, SocietyUser, SocietyCounter,
} = require('../../db/models/society');

/**
 * Visitors, the gate, and the passes that get people through it.
 *
 * Three things carry the design:
 *
 * 1. **A visitor is a person, a visit is an event.** `SocietyVisitor` is keyed
 *    on mobile number so a returning courier is recognised and their details
 *    prefill; `SocietyVisitorLog` is one arrival.
 *
 * 2. **Approval is per unit.** A contractor visiting three flats needs three
 *    answers, so `unitApprovals` is an array and the scalar `approvalStatus` is
 *    the rolled-up view the gate reads. One resident approving does not admit
 *    the visitor to the other two.
 *
 * 3. **Auto-approval is the resident's own setting**, read from their
 *    occupancy (`settings.visitor.*`, Phase 3). A guest for someone who has
 *    switched guest auto-approval on is admitted without waking them.
 */

const visitors = crud({
  Model: SocietyVisitor,
  listKey: 'visitors',
  searchFields: ['firstName', 'lastName', 'mobileNumber', 'vehicleNumber'],
  filterFields: ['visitorType'],
  pageParam: 'limit',
  sort: { createdAt: -1 },
});

const logs = crud({
  Model: SocietyVisitorLog,
  listKey: 'visits',
  filterFields: ['status', 'visitorType', 'approvalStatus', 'createdBy', 'isFrequentPass'],
  populate: ['visitorId'],
  pageParam: 'limit',
  sort: { createdAt: -1 },
});

/** Finds the person by number, or records them. Returning visitors are not duplicated. */
async function upsertVisitor(ctx, data, actorId) {
  const mobileNumber = String(data.mobileNumber || '').trim();
  if (!mobileNumber) throw badRequest('A visitor mobile number is required.');

  await SocietyVisitor.updateOne(
    { societyId: ctx.societyId, mobileNumber, isDeleted: false },
    {
      $setOnInsert: { societyId: ctx.societyId, mobileNumber },
      $set: {
        firstName: data.firstName,
        lastName: data.lastName || '',
        countryCode: data.countryCode || '+91',
        visitorType: data.visitorType || 'GUEST',
        ...(data.vehicleNumber ? { vehicleNumber: data.vehicleNumber } : {}),
        ...(data.vehicleType ? { vehicleType: data.vehicleType } : {}),
        ...(data.photo ? { photo: data.photo } : {}),
      },
    },
    { upsert: true },
  );
  return SocietyVisitor.findOne({ societyId: ctx.societyId, mobileNumber, isDeleted: false }).lean();
}

/**
 * Whether a unit's residents have said this kind of visitor may come straight
 * in. Any current resident of the unit having the flag on is enough — a
 * household speaks with one voice at the gate.
 */
async function autoApproves(ctx, unitId, visitorType) {
  const flag = {
    GUEST: 'guestAutoApproval',
    CAB_AUTO: 'cabAutoApproval',
  }[visitorType];
  if (!flag) return false;

  const any = await SocietyUnitOccupancy.findOne({
    societyId: ctx.societyId,
    unitId,
    isCurrent: true,
    isDeleted: false,
    [`settings.visitor.${flag}`]: true,
  }).select('_id').lean();
  return Boolean(any);
}

/**
 * Records an arrival at the gate.
 *
 * Each named unit gets its own approval row, pre-answered where that
 * household's settings allow it. The visit is only ENTERED once at least one
 * unit has said yes.
 */
async function recordEntry(ctx, data, actor = {}) {
  const unitIds = (Array.isArray(data.unitIds) ? data.unitIds : [data.unitId]).filter(Boolean);
  if (!unitIds.length) throw badRequest('Name at least one unit the visitor is here for.');

  const valid = await SocietyUnit.countDocuments({
    societyId: ctx.societyId, _id: { $in: unitIds }, isDeleted: false,
  });
  if (valid !== unitIds.length) throw badRequest('One of those units does not exist in this society.');

  const visitor = await upsertVisitor(ctx, data, actor.employeeId);
  const visitorType = data.visitorType || visitor.visitorType || 'GUEST';

  const unitApprovals = [];
  for (const unitId of unitIds) {
    // eslint-disable-next-line no-await-in-loop
    const auto = await autoApproves(ctx, unitId, visitorType);
    unitApprovals.push({
      unitId,
      status: auto ? 'APPROVED' : 'PENDING',
      approvedAt: auto ? new Date() : undefined,
    });
  }

  const anyApproved = unitApprovals.some((u) => u.status === 'APPROVED');
  const log = await SocietyVisitorLog.create({
    societyId: ctx.societyId,
    visitorId: visitor._id,
    unitIds,
    unitApprovals,
    visitorType,
    visitorCount: data.visitorCount || 1,
    vehicleNumber: data.vehicleNumber || null,
    vehicleType: data.vehicleType || null,
    photo: data.photo || null,
    purposeOfVisit: data.purposeOfVisit || null,
    visitFrequency: data.visitFrequency || 'ONCE',
    expectedDate: data.expectedDate || null,
    expectedTime: data.expectedTime || null,
    validTill: data.validTill || '24_HOURS',
    fromDate: data.fromDate || null,
    toDate: data.toDate || null,
    isFrequentPass: Boolean(data.isFrequentPass),
    parentPassId: data.parentPassId || null,
    status: anyApproved ? 'ENTERED' : 'PENDING_APPROVAL',
    approvalStatus: anyApproved ? 'APPROVED' : 'PENDING',
    createdBy: actor.userId ? 'MEMBER' : (actor.employeeId ? 'GATEKEEPER' : 'ADMIN'),
    createdByMemberId: actor.memberId || null,
    inTime: anyApproved ? new Date() : null,
    enteredBy: anyApproved ? actor.employeeId || null : null,
  });

  if (!anyApproved) await askResidents(ctx, log, visitor);
  return log.toObject();
}

/** Wakes the households that have not pre-approved this kind of visitor. */
async function askResidents(ctx, log, visitor) {
  const pending = log.unitApprovals.filter((u) => u.status === 'PENDING').map((u) => u.unitId);
  if (!pending.length) return { notified: 0 };

  const residents = await SocietyUnitOccupancy.find({
    societyId: ctx.societyId, unitId: { $in: pending }, isCurrent: true, isDeleted: false,
    userId: { $ne: null },
  }).select('userId unitId memberId').lean();
  if (!residents.length) return { notified: 0 };

  const name = [visitor.firstName, visitor.lastName].filter(Boolean).join(' ');
  const title = 'Visitor at the gate';
  const body = `${name} is here${log.purposeOfVisit ? ` — ${log.purposeOfVisit}` : ''}.`;

  await SocietyNotification.insertMany(residents.map((r) => ({
    societyId: ctx.societyId,
    userId: r.userId,
    unitId: r.unitId,
    memberId: r.memberId || undefined,
    title,
    body,
    type: 'VISITOR',
    subType: 'APPROVAL_REQUESTED',
    referenceId: log._id,
  })));

  const users = await SocietyUser.find({
    _id: { $in: residents.map((r) => r.userId) }, isDeleted: false,
  }).select('fcmToken').lean();
  await messaging.push({
    tokens: users.map((u) => u.fcmToken),
    title,
    body,
    data: { type: 'VISITOR', visitorLogId: String(log._id) },
  });
  return { notified: residents.length };
}

/**
 * A resident answers for their own unit.
 *
 * The update is positional on the approval row for THEIR unit, so approving
 * says nothing about the other flats the visitor named.
 */
async function decide(ctx, logId, { unitId, approve }, actor) {
  const occupancy = await SocietyUnitOccupancy.findOne({
    societyId: ctx.societyId, userId: actor.userId, isCurrent: true, isDeleted: false,
    ...(unitId ? { unitId } : {}),
  }).select('unitId memberId').lean();
  if (!occupancy) throw badRequest('You are not registered as a resident of this society.');

  const status = approve ? 'APPROVED' : 'REJECTED';
  const updated = await SocietyVisitorLog.findOneAndUpdate(
    {
      societyId: ctx.societyId,
      _id: logId,
      isDeleted: false,
      unitApprovals: { $elemMatch: { unitId: occupancy.unitId, status: 'PENDING' } },
    },
    {
      $set: {
        'unitApprovals.$.status': status,
        'unitApprovals.$.approvedBy': occupancy.memberId || null,
        'unitApprovals.$.approvedAt': new Date(),
      },
    },
    { new: true },
  ).lean();
  if (!updated) throw notFound('No pending approval for your unit on that visit.');

  return rollUp(ctx, updated, actor);
}

/**
 * Recomputes the visit's overall state from its per-unit answers.
 *
 * Approved by anyone means the visitor comes in. Rejected by everyone means
 * they do not. Anything else is still waiting.
 */
async function rollUp(ctx, log, actor = {}) {
  const answers = log.unitApprovals.map((u) => u.status);
  const anyApproved = answers.includes('APPROVED');
  const allAnswered = !answers.includes('PENDING');

  const $set = {};
  if (anyApproved) {
    $set.approvalStatus = 'APPROVED';
    if (log.status === 'PENDING_APPROVAL') {
      $set.status = 'ENTERED';
      $set.inTime = new Date();
      $set.approvedAt = new Date();
      $set.enteredBy = actor.employeeId || null;
    }
  } else if (allAnswered) {
    $set.approvalStatus = 'REJECTED';
    $set.status = 'REJECTED';
  }

  if (!Object.keys($set).length) return log;
  return SocietyVisitorLog.findOneAndUpdate(
    { societyId: ctx.societyId, _id: log._id }, { $set }, { new: true },
  ).lean();
}

/** The gate letting someone in after an approval came through. */
async function allowEntry(ctx, logId, actor) {
  const log = await SocietyVisitorLog.findOneAndUpdate(
    {
      societyId: ctx.societyId,
      _id: logId,
      isDeleted: false,
      status: { $in: ['PENDING_APPROVAL', 'APPROVED', 'NOT_ARRIVED'] },
    },
    {
      $set: {
        status: 'ENTERED',
        approvalStatus: 'APPROVED',
        inTime: new Date(),
        enteredBy: actor.employeeId || null,
      },
    },
    { new: true },
  ).lean();
  if (!log) throw conflict('That visit cannot be admitted from its current state.');
  return log;
}

/** Marks the visitor out. Only somebody who is in can leave. */
async function recordExit(ctx, logId, actor) {
  const log = await SocietyVisitorLog.findOneAndUpdate(
    {
      societyId: ctx.societyId, _id: logId, isDeleted: false, status: 'ENTERED',
    },
    { $set: { status: 'EXITED', outTime: new Date(), exitBy: actor.employeeId || null } },
    { new: true },
  ).lean();
  if (!log) throw conflict('That visitor is not currently inside.');
  return log;
}

/* --------------------------------- passes ------------------------------------ */

/**
 * Issues a QR gate pass for a visit.
 *
 * Single-use and expiring: `redeem()` flips `isUsed` with a conditional update
 * naming `isUsed: false`, so two guards scanning the same code cannot both
 * admit the holder.
 */
async function issuePass(ctx, logId, { validHours = 24 } = {}, actorId) {
  const log = await SocietyVisitorLog.findOne({
    societyId: ctx.societyId, _id: logId, isDeleted: false,
  }).populate('visitorId').lean();
  if (!log) throw notFound('Visit not found');

  const societyCode = ctx.society?.societyCode
    || (await require('../../db/models/society').Society.findById(ctx.societyId)
      .select('societyCode').lean())?.societyCode;

  const passNumber = await SocietyCounter.nextRef({
    societyCode, kind: 'visitor-pass', date: 'ALL', prefix: 'VP', width: 4,
  });
  // Unguessable on its own, so a leaked pass number is not a way in.
  const token = crypto.randomBytes(16).toString('base64url');
  const units = await SocietyUnit.find({
    societyId: ctx.societyId, _id: { $in: log.unitIds },
  }).select('unitNumber').lean();

  const pass = await SocietyVisitorPass.create({
    societyId: ctx.societyId,
    visitorLogId: log._id,
    passNumber,
    visitorName: [log.visitorId?.firstName, log.visitorId?.lastName].filter(Boolean).join(' '),
    hostUnit: units.map((u) => u.unitNumber).join(', '),
    purposeOfVisit: log.purposeOfVisit,
    passType: log.visitorType,
    qrCode: token,
    qrCodeImage: await QRCode.toDataURL(`${passNumber}:${token}`),
    expiresAt: new Date(Date.now() + validHours * 3600 * 1000),
  });
  return pass.toObject();
}

const passByNumber = (ctx, passNumber) => SocietyVisitorPass.findOne({
  societyId: ctx.societyId, passNumber, isDeleted: false,
}).lean().then((p) => {
  if (!p) throw notFound('Pass not found');
  return p;
});

const passById = (ctx, id) => SocietyVisitorPass.findOne({
  societyId: ctx.societyId, _id: id, isDeleted: false,
}).lean().then((p) => {
  if (!p) throw notFound('Pass not found');
  return p;
});

/** Scans a pass at the gate. Single-use, enforced by the conditional update. */
async function redeem(ctx, passNumber, actor) {
  const pass = await SocietyVisitorPass.findOneAndUpdate(
    {
      societyId: ctx.societyId,
      passNumber,
      isDeleted: false,
      isUsed: false,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
    },
    { $set: { isUsed: true, usedAt: new Date() } },
    { new: true },
  ).lean();
  if (!pass) throw conflict('That pass has already been used or has expired.');

  await allowEntry(ctx, pass.visitorLogId, actor).catch(() => null);
  return pass;
}

/* ---------------------------------- reads -------------------------------------- */

/** Who is expected today but has not arrived — the gate's watch list. */
async function expected(ctx, { date } = {}) {
  const day = date ? new Date(date) : new Date();
  const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);

  return SocietyVisitorLog.find({
    societyId: ctx.societyId,
    isDeleted: false,
    status: { $in: ['PENDING_APPROVAL', 'APPROVED', 'NOT_ARRIVED'] },
    $or: [
      { expectedDate: { $gte: start, $lt: end } },
      { fromDate: { $lte: end }, toDate: { $gte: start } },
    ],
  }).populate('visitorId').sort({ expectedDate: 1 }).lean();
}

/** Everyone currently inside. */
const inside = (ctx) => SocietyVisitorLog.find({
  societyId: ctx.societyId, isDeleted: false, status: 'ENTERED',
}).populate('visitorId').sort({ inTime: -1 }).lean();

async function stats(ctx) {
  const day = new Date();
  const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));

  const [byStatus, todayIn, currentlyIn] = await Promise.all([
    SocietyVisitorLog.aggregate([
      { $match: { societyId: ctx.societyId, isDeleted: false } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]),
    SocietyVisitorLog.countDocuments({
      societyId: ctx.societyId, isDeleted: false, inTime: { $gte: start },
    }),
    SocietyVisitorLog.countDocuments({
      societyId: ctx.societyId, isDeleted: false, status: 'ENTERED',
    }),
  ]);

  const counts = Object.fromEntries(byStatus.map((s) => [s._id, s.n]));
  return {
    total: byStatus.reduce((a, s) => a + s.n, 0),
    entriesToday: todayIn,
    currentlyInside: currentlyIn,
    awaitingApproval: counts.PENDING_APPROVAL || 0,
    byStatus: counts,
  };
}

/** A resident's own visitors, across the units they hold. */
async function forResident(ctx, actor, query = {}) {
  const own = await SocietyUnitOccupancy.find({
    societyId: ctx.societyId, userId: actor.userId, isCurrent: true, isDeleted: false,
  }).select('unitId').lean();
  if (!own.length) {
    return { visits: [], pagination: { total: 0, page: 1, limit: 10, totalPages: 0 } };
  }
  return logs.list(ctx, { ...query, unitIds: { $in: own.map((o) => o.unitId) } });
}

/** Members at a unit — what the gate screen shows the guard before they call up. */
async function membersForGate(ctx, query = {}) {
  const filter = {
    societyId: ctx.societyId, isCurrent: true, isDeleted: false, memberRole: 'PRIMARY',
  };
  if (query.unitId) filter.unitId = query.unitId;
  if (query.search?.trim()) {
    const safe = query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      { firstName: new RegExp(safe, 'i') },
      { lastName: new RegExp(safe, 'i') },
      { mobileNumber: new RegExp(safe, 'i') },
    ];
  }
  return SocietyUnitOccupancy.find(filter)
    .populate('unitId', 'unitNumber blockNumber')
    .limit(100)
    .lean();
}

module.exports = {
  visitors,
  rollUp,
  logs,
  upsertVisitor,
  autoApproves,
  recordEntry,
  decide,
  allowEntry,
  recordExit,
  issuePass,
  passByNumber,
  passById,
  redeem,
  expected,
  inside,
  stats,
  forResident,
  membersForGate,
};
