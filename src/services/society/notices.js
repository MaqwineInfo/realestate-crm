const { crud } = require('./factory');
const messaging = require('./messaging');
const { badRequest, notFound } = require('../../lib/errors');
const {
  SocietyNotice, SocietyUnitOccupancy, SocietyNotification, SocietyUser,
} = require('../../db/models/society');

/**
 * Notices: the society noticeboard, with targeting and scheduling.
 *
 * Two status fields, both real (see the model): `publishStatus` is the
 * lifecycle the scheduler drives, `status` is the admin's visibility toggle on
 * an already-published notice.
 *
 * Targeting is by block, floor, unit and resident type, and the arrays accept
 * either ObjectIds or the literal string "All" — the source's clients send
 * both. `audienceFilter()` normalises that in one place so no read has to
 * remember the quirk.
 */
const base = crud({
  Model: SocietyNotice,
  listKey: 'notices',
  searchFields: ['title', 'text'],
  filterFields: ['category', 'publishStatus', 'status', 'residentType'],
  pageParam: 'limit',
  sort: { createdAt: -1 },
});

/** "All", "all" and an empty array all mean everyone. */
const isEveryone = (list) => !list?.length || list.some((v) => String(v).toLowerCase() === 'all');

/**
 * Whether a notice is addressed to a given occupancy.
 *
 * Evaluated in memory rather than as a query, because the target arrays are
 * `Mixed` and a Mongo-side `$or` over three of them plus the "All" sentinel is
 * both slower and much harder to read than this.
 */
function targets(notice, occupancy) {
  if (notice.residentType && notice.residentType !== 'ALL'
      && occupancy.residentType?.toUpperCase() !== notice.residentType) return false;

  const byBlock = isEveryone(notice.targetBlocks)
    || notice.targetBlocks.some((b) => String(b) === String(occupancy.blockId));
  const byFloor = isEveryone(notice.targetFloors)
    || notice.targetFloors.some((f) => String(f) === String(occupancy.floorId));
  const byUnit = isEveryone(notice.targetUnits)
    || notice.targetUnits.some((u) => String(u) === String(occupancy.unitId));

  return byBlock && byFloor && byUnit;
}

/** The occupancies a notice is addressed to, with their unit's place resolved. */
async function audience(ctx, notice) {
  const rows = await SocietyUnitOccupancy.find({
    societyId: ctx.societyId, isCurrent: true, isDeleted: false, userId: { $ne: null },
  }).populate('unitId', 'blockId floorId').lean();

  return rows
    .map((r) => ({
      ...r,
      blockId: r.unitId?.blockId,
      floorId: r.unitId?.floorId,
      unitId: r.unitId?._id || r.unitId,
    }))
    .filter((r) => targets(notice, r));
}

/**
 * Publishes a notice and tells its audience once.
 *
 * `notificationSent` is the idempotency flag: the scheduler can retry a failed
 * run without notifying twice, which matters because a duplicate push at 6am
 * is the kind of thing residents remember.
 */
async function publish(ctx, id, actorId) {
  const notice = await SocietyNotice.findOne({
    societyId: ctx.societyId, _id: id, isDeleted: false,
  });
  if (!notice) throw notFound('Notice not found');

  const updated = await SocietyNotice.findOneAndUpdate(
    { societyId: ctx.societyId, _id: id, isDeleted: false },
    {
      $set: {
        publishStatus: 'PUBLISHED',
        publishedAt: notice.publishedAt || new Date(),
        publishedBy: actorId || notice.publishedBy || null,
      },
    },
    { new: true },
  ).lean();

  if (!notice.notificationSent) await notifyAudience(ctx, updated);
  return updated;
}

async function notifyAudience(ctx, notice) {
  const recipients = await audience(ctx, notice);
  if (recipients.length) {
    await SocietyNotification.insertMany(recipients.map((r) => ({
      societyId: ctx.societyId,
      userId: r.userId,
      unitId: r.unitId,
      memberId: r.memberId || undefined,
      title: notice.title || 'New notice',
      body: notice.text,
      type: 'NOTICE',
      subType: notice.category || 'General',
      referenceId: notice._id,
    })));

    const users = await SocietyUser.find({
      _id: { $in: recipients.map((r) => r.userId) }, isDeleted: false,
    }).select('fcmToken').lean();

    await messaging.push({
      tokens: users.map((u) => u.fcmToken),
      title: notice.title || 'New notice',
      body: notice.text,
      data: { type: 'NOTICE', noticeId: String(notice._id) },
    });
  }

  // Set last: a crash before this point retries, a crash after does not.
  await SocietyNotice.updateOne(
    { societyId: ctx.societyId, _id: notice._id },
    { $set: { notificationSent: true } },
  );
  return { notified: recipients.length };
}

/** Creating with `publishStatus: PUBLISHED` publishes immediately. */
async function create(ctx, data, actorId) {
  const notice = await base.create(ctx, data, actorId);
  if (data.publishStatus === 'PUBLISHED') return publish(ctx, notice._id, actorId);
  if (data.publishStatus === 'SCHEDULED' && !data.scheduledAt) {
    throw badRequest('A scheduled notice needs a scheduledAt time.');
  }
  return notice;
}

/** What one resident should see: published, visible, and addressed to them. */
async function forResident(ctx, { userId, unitId }, query = {}) {
  const occupancy = await SocietyUnitOccupancy.findOne({
    societyId: ctx.societyId, userId, isCurrent: true, isDeleted: false,
    ...(unitId ? { unitId } : {}),
  }).populate('unitId', 'blockId floorId').lean();
  if (!occupancy) throw notFound('You are not registered as a resident of this society.');

  const filter = {
    societyId: ctx.societyId, isDeleted: false, publishStatus: 'PUBLISHED', status: 'ACTIVE',
  };
  if (query.category) filter.category = query.category;

  const all = await SocietyNotice.find(filter).sort({ publishedAt: -1, createdAt: -1 }).lean();
  const place = {
    ...occupancy,
    blockId: occupancy.unitId?.blockId,
    floorId: occupancy.unitId?.floorId,
    unitId: occupancy.unitId?._id || occupancy.unitId,
  };
  const visible = all.filter((n) => targets(n, place));

  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const size = Math.max(1, parseInt(query.limit, 10) || 20);
  return {
    notices: visible.slice((page - 1) * size, page * size),
    pagination: {
      total: visible.length, page, limit: size, totalPages: Math.ceil(visible.length / size),
    },
  };
}

/**
 * The scheduler's sweep: publish everything whose time has come.
 *
 * Driven by `jobs/scheduler.js` rather than the source's RabbitMQ worker
 * (SOCIETY-PLAN.md §3.7). Cross-society by design — it runs for the platform,
 * not inside one society — so it opts out of the guard explicitly.
 */
async function publishDue(now = new Date()) {
  const due = await SocietyNotice.find({
    publishStatus: 'SCHEDULED',
    scheduledAt: { $lte: now },
    isDeleted: false,
  }).setOptions({ allowCrossSociety: true }).lean();

  let published = 0;
  for (const notice of due) {
    // eslint-disable-next-line no-await-in-loop
    await publish({ societyId: notice.societyId }, notice._id, notice.scheduledBy);
    published += 1;
  }
  return { published };
}

async function stats(ctx) {
  const rows = await SocietyNotice.aggregate([
    { $match: { societyId: ctx.societyId, isDeleted: false } },
    { $group: { _id: '$publishStatus', n: { $sum: 1 } } },
  ]);
  const counts = Object.fromEntries(rows.map((r) => [r._id, r.n]));
  return {
    total: rows.reduce((a, r) => a + r.n, 0),
    draft: counts.DRAFT || 0,
    scheduled: counts.SCHEDULED || 0,
    published: counts.PUBLISHED || 0,
  };
}

module.exports = {
  ...base, create, publish, forResident, publishDue, stats, audience, targets, isEveryone,
};
