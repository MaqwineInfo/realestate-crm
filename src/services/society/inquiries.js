const { crud } = require('./factory');
const seams = require('./seams');
const messages = require('../../lib/society/messages');
const { notFound, badRequest } = require('../../lib/errors');
const {
  SocietyInquiry, SocietyInquiryHistory, SocietyAdmin,
  SocietyStage, SocietySubStage, SocietyChildStage,
} = require('../../db/models/society');

const M = messages.en.society;

/**
 * Society enquiries — the platform's own pipeline for signing up societies.
 *
 * Every stage move, reassignment and follow-up is recorded in
 * `SocietyInquiryHistory` with both the old and new value, so the timeline
 * reads on its own without replaying the chain.
 */
const base = crud({
  Model: SocietyInquiry,
  listKey: 'inquiries',
  searchFields: ['societyName', 'firstName', 'lastName', 'mobileNumber', 'email', 'societyAddress'],
  filterFields: ['status', 'stageId', 'subStageId', 'childStageId', 'currentOwnerId', 'isAction'],
  populate: ['stageId', 'subStageId', 'childStageId'],
  pageParam: 'limit',
  sort: { createdAt: -1 },
});

/** A child stage without its parent sub-stage is not a position in the pipeline. */
async function validateStagePath({ stageId, subStageId, childStageId }) {
  if (childStageId && !subStageId) throw badRequest(M.inquiry_child_requires_sub);
  if (stageId && !await SocietyStage.findOne({ _id: stageId, isDeleted: false }).select('_id').lean()) {
    throw notFound(M.inquiry_stage_not_found);
  }
  if (subStageId && !await SocietySubStage.findOne({ _id: subStageId, isDeleted: false }).select('_id').lean()) {
    throw notFound(M.inquiry_stage_not_found);
  }
  if (childStageId && !await SocietyChildStage.findOne({ _id: childStageId, isDeleted: false }).select('_id').lean()) {
    throw notFound(M.inquiry_stage_not_found);
  }
}

async function load(id) {
  const inquiry = await SocietyInquiry.findOne({ _id: id, isDeleted: false });
  if (!inquiry) throw notFound(M.inquiry_not_found);
  return inquiry;
}

/**
 * Update an enquiry and record what moved.
 *
 * The history row is written from the diff between the document before and
 * after, so a caller cannot update the enquiry and forget to log it — the two
 * happen in one place.
 */
async function update(ctx, id, data, actorId) {
  const before = await load(id);
  await validateStagePath(data);

  const updated = await base.update(ctx, id, {
    ...data, lastActionAt: new Date(),
  }, actorId);

  const moved = ['stageId', 'subStageId', 'childStageId', 'currentOwnerId']
    .some((k) => data[k] !== undefined && String(data[k] ?? '') !== String(before[k] ?? ''));

  await SocietyInquiryHistory.create({
    inquiryId: id,
    actionBy: actorId || null,
    actionType: moved ? 'STAGE_CHANGE' : 'UPDATE',
    previousStageId: before.stageId,
    newStageId: updated.stageId,
    previousSubStageId: before.subStageId,
    newSubStageId: updated.subStageId,
    previousChildStageId: before.childStageId,
    newChildStageId: updated.childStageId,
    previousOwnerId: before.currentOwnerId,
    newOwnerId: updated.currentOwnerId,
    updatedObject: moved ? undefined : data,
  });

  return updated;
}

/**
 * A society enquiry raised from the resident app.
 *
 * Three things happen together, in this order, and the order matters: the
 * enquiry lands at the pipeline's first stage, a `Create` history row records
 * it, then an executive is assigned and *both* rows are stamped with them. The
 * source did the same, over four HTTP calls to a user service.
 *
 * Assignment is least-loaded rather than the source's stored counter. A counter
 * has to be seeded, kept in step when an executive leaves, and reset when the
 * pipeline is cleared; counting open enquiries needs none of that and cannot
 * drift from the thing it is meant to describe. It is a read-then-write, which
 * under simultaneous submissions can hand two enquiries to the same person —
 * an imbalance of one, self-correcting on the next enquiry, which is why it is
 * not worth a lock.
 */
async function assignExecutive() {
  const pool = await SocietyAdmin.find({ isDeleted: false, isActive: true })
    .select('_id userId').lean();
  if (!pool.length) return null;

  const load = await SocietyInquiry.aggregate([
    { $match: { isDeleted: false, currentOwnerId: { $ne: null } } },
    { $group: { _id: '$currentOwnerId', n: { $sum: 1 } } },
  ]);
  const byOwner = new Map(load.map((r) => [String(r._id), r.n]));

  // Ties break on the earliest-created admin, so the choice is deterministic
  // and a test can assert it rather than tolerate either answer.
  return pool
    .map((a) => ({ id: a.userId || a._id, n: byOwner.get(String(a.userId || a._id)) || 0 }))
    .sort((a, b) => a.n - b.n || String(a.id).localeCompare(String(b.id)))[0].id;
}

async function submitFromApp(data, userId) {
  const stage = await SocietyStage.findOne({ title: 'New Inquiry', isDeleted: false })
    .select('_id').lean();

  const inquiry = await SocietyInquiry.create({
    societyName: data.societyName,
    societyAddress: data.societyAddress,
    firstName: data.firstName || '',
    lastName: data.lastName || '',
    mobileNumber: data.mobileNumber || '',
    countryCode: data.countryCode || '',
    email: data.email || '',
    noOfUnit: data.noOfUnit,
    notes: data.notes,
    userId,
    createdBy: userId,
    status: data.status || 'Pending',
    sourceName: data.sourceName || '',
    subSourceName: data.subSourceName || '',
    ...(stage && { stageId: stage._id }),
    isAction: false,
  });

  const history = await SocietyInquiryHistory.create({
    inquiryId: inquiry._id,
    newStageId: stage?._id,
    actionType: 'Create',
    actionBy: userId,
    regUserId: userId,
    updatedObject: {
      societyName: inquiry.societyName,
      firstName: inquiry.firstName,
      lastName: inquiry.lastName,
      sourceName: inquiry.sourceName,
      subSourceName: inquiry.subSourceName,
    },
  });

  // Seam 2 (D4): a society enquiry is a sales lead. Returns null until joined,
  // which is why the small pipeline below still runs.
  await seams.leadFromInquiry({ inquiryId: inquiry._id, actorId: userId });

  const owner = await assignExecutive();
  if (!owner) return inquiry.toObject();

  const [assigned] = await Promise.all([
    SocietyInquiry.findOneAndUpdate(
      { _id: inquiry._id },
      { $set: { originalOwnerId: owner, currentOwnerId: owner, assignedAt: new Date() } },
      { new: true },
    ).lean(),
    // `SocietyInquiryHistory` names its columns previous/new, not
    // original/current — writing the enquiry's names here drops them silently.
    SocietyInquiryHistory.updateOne({ _id: history._id }, { $set: { newOwnerId: owner } }),
  ]);
  return assigned;
}

/** A dated note plus the next follow-up, which is what the work queue reads. */
async function addFollowup(ctx, { inquiryId, comments, followupDate, ...rest }, actorId) {
  const inquiry = await load(inquiryId);
  await validateStagePath(rest);

  const patch = {
    comments: comments ?? inquiry.comments,
    followupDate: followupDate ?? inquiry.followupDate,
    isAction: true,
    lastActionAt: new Date(),
    updatedBy: actorId || null,
  };
  for (const k of ['stageId', 'subStageId', 'childStageId']) {
    if (rest[k] !== undefined) patch[k] = rest[k];
  }

  const updated = await SocietyInquiry.findOneAndUpdate(
    { _id: inquiryId, isDeleted: false }, { $set: patch }, { new: true },
  ).lean();

  await SocietyInquiryHistory.create({
    inquiryId,
    actionBy: actorId || null,
    actionType: 'FOLLOWUP',
    previousStageId: inquiry.stageId,
    newStageId: updated.stageId,
    previousSubStageId: inquiry.subStageId,
    newSubStageId: updated.subStageId,
    previousChildStageId: inquiry.childStageId,
    newChildStageId: updated.childStageId,
    updatedObject: { comments, followupDate },
  });

  return updated;
}

/** Counts for the pipeline header: how much work is due, and how much is late. */
async function followupCount(ctx, { ownerId } = {}) {
  const filter = { isDeleted: false };
  if (ownerId) filter.currentOwnerId = ownerId;

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = new Date(startOfToday);
  endOfToday.setDate(endOfToday.getDate() + 1);

  const [total, pending, dueToday, overdue] = await Promise.all([
    SocietyInquiry.countDocuments(filter),
    SocietyInquiry.countDocuments({ ...filter, status: 'Pending' }),
    SocietyInquiry.countDocuments({ ...filter, followupDate: { $gte: startOfToday, $lt: endOfToday } }),
    SocietyInquiry.countDocuments({ ...filter, followupDate: { $lt: startOfToday }, status: 'Pending' }),
  ]);
  return {
    total, pending, dueToday, overdue,
  };
}

/** Rows for the CSV export, flattened and already resolved. */
async function exportRows(ctx, query = {}) {
  const filter = { isDeleted: false };
  for (const f of ['status', 'stageId', 'currentOwnerId']) {
    if (query[f]) filter[f] = query[f];
  }
  const rows = await SocietyInquiry.find(filter)
    .populate('stageId', 'title')
    .populate('subStageId', 'title')
    .populate('childStageId', 'title')
    .sort({ createdAt: -1 })
    .lean();

  return rows.map((r) => ({
    'Society Name': r.societyName,
    Address: r.societyAddress,
    'Contact Person': [r.firstName, r.lastName].filter(Boolean).join(' '),
    Mobile: `${r.countryCode || ''}${r.mobileNumber || ''}`,
    Email: r.email,
    Units: r.noOfUnit,
    Status: r.status,
    Stage: r.stageId?.title || '',
    'Sub Stage': r.subStageId?.title || '',
    'Child Stage': r.childStageId?.title || '',
    'Follow-up': r.followupDate ? new Date(r.followupDate).toISOString().slice(0, 10) : '',
    Source: r.sourceName,
    Notes: r.notes,
    Created: new Date(r.createdAt).toISOString().slice(0, 10),
  }));
}

async function history(inquiryId) {
  return SocietyInquiryHistory.find({ inquiryId, isDeleted: false })
    .sort({ createdAt: -1 })
    .lean();
}

module.exports = {
  ...base, update, addFollowup, submitFromApp, assignExecutive, followupCount, exportRows, history, load, validateStagePath,
};
