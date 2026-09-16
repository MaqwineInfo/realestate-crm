const { crud } = require('./factory');
const messaging = require('./messaging');
const { badRequest, notFound, conflict } = require('../../lib/errors');
const {
  SocietyComplaint, SocietyComplaintType, SocietyComplaintHistory,
  SocietyCounter, SocietyUnit, SocietyUnitOccupancy, SocietyEmployee,
  SocietyNotification, SocietyUser,
} = require('../../db/models/society');

/**
 * Complaints, from raised to closed.
 *
 * **Every state change goes through `transition()`.** That is the whole design:
 * a complaint's status, its assignee and its resolution can only move by
 * calling one function, which writes the `SocietyComplaintHistory` row and
 * notifies the resident in the same step. The source changed status in five
 * different controllers and logged history in three of them, so the timeline
 * had holes that depended on which screen was used — the same failure mode the
 * CRM avoids by routing every close through `services/followups.applyOutcome`.
 *
 * History lives in ONE collection. The source declared it twice under names
 * differing only in case (`complainthistories` / `complaintHistories`), so the
 * admin panel wrote a timeline the resident app could not read. See
 * SOCIETY-PLAN.md §6.1.
 */

const OPEN_STATUSES = ['Open', 'In Progress', 'On Hold', 'Reopen'];
const CLOSED_STATUSES = ['Close', 'Dismiss'];
const ALL_STATUSES = [...OPEN_STATUSES, ...CLOSED_STATUSES];

const types = crud({
  Model: SocietyComplaintType,
  listKey: 'complaintTypes',
  searchFields: ['typeName'],
  filterFields: ['status'],
  unique: ['typeName'],
  pageParam: 'limit',
  sort: { typeName: 1 },
});

const base = crud({
  Model: SocietyComplaint,
  listKey: 'complaints',
  searchFields: ['title', 'description', 'complaintId'],
  filterFields: ['status', 'priority', 'complaintTypeId', 'unitId', 'assignedTo', 'createdByRole'],
  populate: ['complaintTypeId'],
  pageParam: 'limit',
  sort: { createdAt: -1 },
});

/**
 * `CM-001`, minted atomically.
 *
 * The source read the most recent complaint and added one, which hands the
 * same id to two complaints filed in the same second — and the unique index
 * then rejects one of them. See `SocietyCounter`.
 */
async function generateId(ctx) {
  const societyCode = await codeFor(ctx);
  return SocietyCounter.nextRef({
    societyCode, kind: 'complaint', date: 'ALL', prefix: 'CM', width: 3,
  });
}

async function codeFor(ctx) {
  if (ctx.society?.societyCode) return ctx.society.societyCode;
  const { Society } = require('../../db/models/society');
  const s = await Society.findById(ctx.societyId).select('societyCode').lean();
  if (!s) throw notFound('Society not found');
  return s.societyCode;
}

/* --------------------------------- create ---------------------------------- */

async function create(ctx, data, actor = {}) {
  const type = await SocietyComplaintType.findOne({
    societyId: ctx.societyId, _id: data.complaintTypeId, isDeleted: false,
  }).lean();
  if (!type) throw badRequest('That complaint type does not exist in this society.');

  const unitId = await resolveUnit(ctx, data, actor);

  const complaint = await SocietyComplaint.create({
    societyId: ctx.societyId,
    complaintId: await generateId(ctx),
    unitId,
    complaintTypeId: type._id,
    title: data.title,
    description: data.description,
    contentType: data.contentType || 'TEXT',
    contentData: data.contentData || null,
    priority: data.priority || 'Medium',
    status: 'Open',
    createdBy: actor.adminId || null,
    createdByRole: actor.userId ? 'MEMBER' : 'ADMIN',
  });

  await log(ctx, complaint, {
    action: 'CREATED', newStatus: 'Open', actor, comment: data.description,
  });

  return complaint.toObject();
}

/**
 * A resident raises a complaint against their own unit; an admin names one.
 * The resident's unit is looked up rather than taken from the request.
 */
async function resolveUnit(ctx, data, actor) {
  if (actor.userId) {
    const own = await SocietyUnitOccupancy.findOne({
      societyId: ctx.societyId, userId: actor.userId, isCurrent: true, isDeleted: false,
    }).select('unitId').lean();
    if (!own) throw badRequest('You are not registered as a resident of this society.');
    return own.unitId;
  }
  if (!data.unitId) return null;
  const unit = await SocietyUnit.findOne({
    societyId: ctx.societyId, _id: data.unitId, isDeleted: false,
  }).select('_id').lean();
  if (!unit) throw badRequest('That unit does not exist in this society.');
  return unit._id;
}

/* ------------------------------- transitions -------------------------------- */

/**
 * The single mutation path.
 *
 * Takes the change, applies it, writes the history row and notifies — in that
 * order, so a failure to notify never loses the change. Nothing else in this
 * module writes `status`, `assignedTo` or `resolution`.
 */
async function transition(ctx, id, change, actor = {}) {
  const before = await SocietyComplaint.findOne({
    societyId: ctx.societyId, _id: id, isDeleted: false,
  });
  if (!before) throw notFound('Complaint not found');

  const $set = {};
  let action = 'UPDATED';

  if (change.status !== undefined) {
    if (!ALL_STATUSES.includes(change.status)) throw badRequest('Unknown complaint status.');
    if (CLOSED_STATUSES.includes(before.status) && change.status === before.status) {
      throw conflict(`This complaint is already ${before.status.toLowerCase()}d.`);
    }
    $set.status = change.status;
    action = before.status === change.status ? 'UPDATED'
      : (change.status === 'Reopen' ? 'REOPENED' : 'STATUS_CHANGED');

    if (CLOSED_STATUSES.includes(change.status)) {
      $set.closedAt = new Date();
      $set.closedBy = actor.adminId || null;
    } else if (CLOSED_STATUSES.includes(before.status)) {
      // Reopening clears the closure, or the timeline reads as still closed.
      $set.closedAt = null;
      $set.closedBy = null;
    }
  }

  if (change.assignedTo !== undefined) {
    if (change.assignedTo) {
      const employee = await SocietyEmployee.findOne({
        _id: change.assignedTo, isDeleted: false, isActive: true,
      }).select('_id').lean();
      if (!employee) throw badRequest('That employee does not exist.');
    }
    $set.assignedTo = change.assignedTo || null;
    $set.assignedAt = change.assignedTo ? new Date() : null;
    $set.assignedBy = actor.adminId || null;
    action = 'ASSIGNED';
  }

  if (change.resolutionNotes !== undefined) {
    $set['resolution.notes'] = change.resolutionNotes;
    $set['resolution.resolvedBy'] = actor.adminId || null;
    $set['resolution.resolvedAt'] = new Date();
  }

  for (const k of ['title', 'description', 'priority', 'complaintTypeId', 'notes', 'contentType', 'contentData']) {
    if (change[k] !== undefined) $set[k] = change[k];
  }

  if (!Object.keys($set).length) throw badRequest('Nothing to change.');
  $set.updatedBy = actor.adminId || null;

  const after = await SocietyComplaint.findOneAndUpdate(
    { societyId: ctx.societyId, _id: id, isDeleted: false },
    { $set },
    { new: true },
  ).lean();

  await log(ctx, after, {
    action,
    previousStatus: before.status,
    newStatus: after.status,
    comment: change.comment || change.resolutionNotes || null,
    actor,
  });

  await notifyResident(ctx, after, before.status);
  return after;
}

/** Appends to the timeline. The only writer of `SocietyComplaintHistory`. */
async function log(ctx, complaint, {
  action, previousStatus = null, newStatus = null, comment = null, actor = {},
}) {
  return SocietyComplaintHistory.create({
    societyId: ctx.societyId,
    complaintId: complaint._id,
    action,
    previousStatus,
    newStatus,
    comment,
    changedBy: actor.userId || actor.adminUserId || null,
    changedByName: actor.name || null,
    changedByRole: actor.userId ? 'User' : (actor.adminId ? 'SocietyAdmin' : 'System'),
  });
}

/**
 * Tells the resident their complaint moved.
 *
 * Best-effort: a dead FCM token must not fail the status change an admin just
 * made, so the notification row is written first and the push is fire-safe.
 */
async function notifyResident(ctx, complaint, previousStatus) {
  if (!complaint.unitId || complaint.status === previousStatus) return;

  const residents = await SocietyUnitOccupancy.find({
    societyId: ctx.societyId, unitId: complaint.unitId, isCurrent: true, isDeleted: false,
    userId: { $ne: null },
  }).select('userId memberId').lean();
  if (!residents.length) return;

  const title = `Complaint ${complaint.complaintId} is now ${complaint.status}`;
  const body = complaint.title;

  await SocietyNotification.insertMany(residents.map((r) => ({
    societyId: ctx.societyId,
    userId: r.userId,
    unitId: complaint.unitId,
    memberId: r.memberId || undefined,
    title,
    body,
    type: 'COMPLAINT',
    subType: 'STATUS_CHANGED',
    referenceId: complaint._id,
  })));

  const users = await SocietyUser.find({
    _id: { $in: residents.map((r) => r.userId) }, isDeleted: false,
  }).select('fcmToken').lean();

  await messaging.push({
    tokens: users.map((u) => u.fcmToken),
    title,
    body,
    data: { type: 'COMPLAINT', complaintId: String(complaint._id) },
  });
}

/* --------------------------------- reads ----------------------------------- */

async function detail(ctx, id) {
  const complaint = await base.detail(ctx, id);
  return { ...complaint, history: await history(ctx, id) };
}

async function byCode(ctx, complaintId) {
  const complaint = await SocietyComplaint.findOne({
    societyId: ctx.societyId, complaintId, isDeleted: false,
  }).populate('complaintTypeId').lean();
  if (!complaint) throw notFound('Complaint not found');
  return { ...complaint, history: await history(ctx, complaint._id) };
}

const history = (ctx, complaintId) => SocietyComplaintHistory.find({
  societyId: ctx.societyId, complaintId, isDeleted: false,
}).sort({ createdAt: -1 }).lean();

/** A resident sees only their own household's complaints. */
async function mine(ctx, actor, query = {}) {
  const own = await SocietyUnitOccupancy.find({
    societyId: ctx.societyId, userId: actor.userId, isCurrent: true, isDeleted: false,
  }).select('unitId').lean();
  if (!own.length) return { complaints: [], pagination: { total: 0, page: 1, limit: 10, totalPages: 0 } };

  return base.list(ctx, { ...query, unitId: { $in: own.map((o) => o.unitId) } });
}

/** Counts for the dashboard tiles: open vs closed, and what is overdue. */
async function stats(ctx, { unitIds } = {}) {
  const match = { societyId: ctx.societyId, isDeleted: false };
  if (unitIds) match.unitId = { $in: unitIds };

  const byStatus = await SocietyComplaint.aggregate([
    { $match: match },
    { $group: { _id: '$status', n: { $sum: 1 } } },
  ]);
  const counts = Object.fromEntries(byStatus.map((s) => [s._id, s.n]));
  const total = byStatus.reduce((a, s) => a + s.n, 0);
  const open = OPEN_STATUSES.reduce((a, s) => a + (counts[s] || 0), 0);

  const [unassigned, byPriority] = await Promise.all([
    SocietyComplaint.countDocuments({ ...match, assignedTo: null, status: { $in: OPEN_STATUSES } }),
    SocietyComplaint.aggregate([
      { $match: { ...match, status: { $in: OPEN_STATUSES } } },
      { $group: { _id: '$priority', n: { $sum: 1 } } },
    ]),
  ]);

  return {
    total,
    open,
    closed: total - open,
    unassigned,
    byStatus: counts,
    byPriority: Object.fromEntries(byPriority.map((p) => [p._id, p.n])),
  };
}

/** Units that have raised a complaint — the legacy filter dropdown. */
async function unitsDropdown(ctx) {
  const ids = await SocietyComplaint.distinct('unitId', {
    societyId: ctx.societyId, isDeleted: false, unitId: { $ne: null },
  });
  return SocietyUnit.find({ societyId: ctx.societyId, _id: { $in: ids }, isDeleted: false })
    .select('unitNumber blockNumber').sort({ unitNumber: 1 }).lean();
}

/** A free-text comment: history, with no state change. */
async function addComment(ctx, id, { comment }, actor = {}) {
  if (!comment?.trim()) throw badRequest('Enter a comment.');
  const complaint = await SocietyComplaint.findOne({
    societyId: ctx.societyId, _id: id, isDeleted: false,
  }).lean();
  if (!complaint) throw notFound('Complaint not found');

  await log(ctx, complaint, { action: 'COMMENT_ADDED', comment: comment.trim(), actor });
  return { complaintId: complaint._id, comment: comment.trim() };
}

/** A resident may edit their own complaint only while it is still open. */
async function residentUpdate(ctx, id, data, actor) {
  const complaint = await SocietyComplaint.findOne({
    societyId: ctx.societyId, _id: id, isDeleted: false,
  }).lean();
  if (!complaint) throw notFound('Complaint not found');
  await assertOwn(ctx, complaint, actor);
  if (CLOSED_STATUSES.includes(complaint.status)) {
    throw badRequest('This complaint is closed and can no longer be edited.');
  }

  const allowed = {};
  for (const k of ['title', 'description', 'priority', 'contentType', 'contentData']) {
    if (data[k] !== undefined) allowed[k] = data[k];
  }
  return transition(ctx, id, allowed, actor);
}

async function residentRemove(ctx, id, actor) {
  const complaint = await SocietyComplaint.findOne({
    societyId: ctx.societyId, _id: id, isDeleted: false,
  }).lean();
  if (!complaint) throw notFound('Complaint not found');
  await assertOwn(ctx, complaint, actor);
  return base.remove(ctx, id, actor.adminId || null);
}

/** A complaint belongs to the resident whose unit it names. */
async function assertOwn(ctx, complaint, actor) {
  if (!actor.userId) return;
  const own = await SocietyUnitOccupancy.findOne({
    societyId: ctx.societyId, userId: actor.userId, unitId: complaint.unitId,
    isCurrent: true, isDeleted: false,
  }).select('_id').lean();
  if (!own) throw notFound('Complaint not found');
}

module.exports = {
  types,
  ...base,
  create,
  detail,
  byCode,
  transition,
  history,
  mine,
  stats,
  unitsDropdown,
  addComment,
  residentUpdate,
  residentRemove,
  generateId,
  log,
  OPEN_STATUSES,
  CLOSED_STATUSES,
  ALL_STATUSES,
};
