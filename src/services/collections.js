const {
  Booking, BookingInstallment, CollectionFollowUp, CollectionPromise, User, Contact,
} = require('../db/models');
const { badRequest, notFound, forbidden } = require('../lib/errors');
const { EVENTS, emit } = require('../lib/events');
const { can, scopeFilter, teamUserIds } = require('../lib/access');
const tzLib = require('../lib/tz');
const installmentsService = require('./installments');
const distribution = require('./distribution');
const timeline = require('./timeline');
const notifications = require('./notifications');
const audit = require('./audit');

/**
 * V2 §147–§153 + §222–§223: collections as a work queue, the same shape as the
 * lead queue — own work first, exact tiles, quick actions, a next action.
 *
 * Every tile count and every list row comes from `filterFor()` below, which is
 * the only way §279 (tile count must equal drilldown count) can be guaranteed
 * rather than hoped for.
 *
 * Queue rows are BOOKINGS, not installments: one customer is one piece of work,
 * and the booking carries the denormalized totals (§242) so a queue read never
 * scans a schedule.
 */

/* -------------------------------- ownership ------------------------------- */

/**
 * §148: project collection pool → default collection pool → the booking's
 * salesperson → unassigned. The lead rotation is untouched (§148: separate
 * cursors), which `poolType` guarantees.
 */
async function resolveOwner({ tenantId, booking }) {
  const { user } = await distribution.nextOwner({
    tenantId, projectId: booking.projectId, poolType: 'COLLECTION',
  });
  if (user) return user;
  if (booking.salespersonId) {
    const salesperson = await User.findOne({ tenantId, _id: booking.salespersonId, status: 'ACTIVE' })
      .select('name').lean();
    if (salesperson) return salesperson;
  }
  return null; // §294: unassigned is a visible state, not an invented owner.
}

/**
 * §220: transfer collection work. §183/§324.6 — the salesperson keeps the sale,
 * always. Nothing here touches `salespersonId` or the lead's owner.
 */
async function transferOwner({
  tenantId, actor, bookingId, newOwnerUserId, reason, includePending = true,
}) {
  const booking = await Booking.findOne({ tenantId, _id: bookingId }).lean();
  if (!booking) throw notFound('Booking not found.');
  if (!newOwnerUserId) throw badRequest('Choose who should take over collection.');
  if (!reason || !String(reason).trim()) throw badRequest('Give a reason for the transfer.');

  const target = await User.findOne({ tenantId, _id: newOwnerUserId, status: 'ACTIVE' })
    .populate('roleId').lean();
  if (!target) throw badRequest('Collection can only be transferred to an active user.');
  // §149: whoever holds the work must be able to do it.
  const targetUser = { ...target, role: target.roleId };
  if (!can(targetUser, 'collection.followup') && !can(targetUser, 'collection.view')) {
    throw badRequest(`${target.name} does not have collection permission. Grant it in Setup → Roles first.`);
  }

  const previousOwnerId = booking.collectionOwnerUserId;
  await Booking.updateOne({ tenantId, _id: booking._id }, {
    $set: { collectionOwnerUserId: target._id, collectionAssignedAt: new Date() },
  });
  if (includePending) {
    await CollectionFollowUp.updateMany(
      { tenantId, bookingId: booking._id, status: { $in: ['PENDING', 'MISSED'] } },
      { $set: { assignedUserId: target._id } },
    );
    await CollectionPromise.updateMany(
      { tenantId, bookingId: booking._id, status: 'OPEN' },
      { $set: { assignedUserId: target._id } },
    );
  }

  await timeline.log({
    tenantId,
    bookingId: booking._id,
    type: 'COLLECTION_ASSIGNED',
    title: `Collection transferred to ${target.name}`,
    body: reason,
    actor,
    meta: {
      from: previousOwnerId ? String(previousOwnerId) : null,
      to: String(target._id),
      pendingWorkMoved: includePending,
    },
  });
  await notifications.notify({
    tenantId,
    userId: target._id,
    domain: 'COLLECTION',
    type: 'COLLECTION_ASSIGNED',
    title: 'Collection assigned to you',
    body: reason,
    link: `/app/bookings/${booking._id}`,
    bookingId: booking._id,
  });
  await audit.record({
    tenantId, actor, entity: 'Booking', entityId: booking._id, action: 'TRANSFER_COLLECTION',
    before: { collectionOwnerUserId: previousOwnerId }, after: { collectionOwnerUserId: target._id, reason },
  });
  return Booking.findOne({ tenantId, _id: booking._id }).lean();
}

/* --------------------------------- totals --------------------------------- */

/**
 * §242: the single writer of the denormalized collection totals. Called after
 * every receipt, reversal, due-date change and by the daily overdue refresh.
 *
 * `nextDueAt` is the EARLIEST unpaid installment with a known date — so a
 * booking that is both overdue and due today appears once, under the more
 * urgent of the two. That is deliberate: one customer is one row of work.
 */
async function recalcBooking({ tenantId, bookingId, tz = 'UTC', now = new Date() }) {
  const booking = await Booking.findOne({ tenantId, _id: bookingId }).lean();
  if (!booking) throw notFound('Booking not found.');

  await installmentsService.refreshStatuses({ tenantId, bookingId, tz, now });
  const rows = await BookingInstallment.find({ tenantId, bookingId }).sort({ sequence: 1 }).lean();
  const live = rows.filter((r) => r.status !== 'CANCELLED');

  const scheduledTotalMinor = live.reduce((sum, r) => sum + r.scheduledAmountMinor, 0);
  const totalReceivedMinor = live.reduce((sum, r) => sum + (r.amountReceivedMinor || 0), 0);
  const outstandingMinor = live.reduce((sum, r) => sum + Math.max(0, r.outstandingMinor || 0), 0);

  const unpaidWithDate = live
    .filter((r) => r.outstandingMinor > 0 && installmentsService.dueDateOf(r))
    .sort((a, b) => installmentsService.dueDateOf(a) - installmentsService.dueDateOf(b));
  const next = unpaidWithDate[0] || null;

  const overdue = live.filter((r) => installmentsService.isOverdue(r, { tz, now }));
  const overdueMinor = overdue.reduce((sum, r) => sum + r.outstandingMinor, 0);
  const overdueDaysMax = overdue.reduce(
    (max, r) => Math.max(max, installmentsService.overdueDays(r, { tz, now })), 0,
  );

  const update = {
    scheduledTotalMinor,
    totalReceivedMinor,
    outstandingMinor,
    nextDueAt: next ? installmentsService.dueDateOf(next) : null,
    nextDueAmountMinor: next ? next.outstandingMinor : 0,
    overdueMinor,
    overdueDaysMax,
    paymentProgressPct: scheduledTotalMinor > 0
      ? Math.round((totalReceivedMinor / scheduledTotalMinor) * 100)
      : 0,
  };
  update.postBookingStatus = require('./postBooking').derivePostBookingStatus({ ...booking, ...update });

  await Booking.updateOne({ tenantId, _id: bookingId }, { $set: update });

  const wasPaid = booking.postBookingStatus === 'FULLY_PAID';
  if (!wasPaid && update.postBookingStatus === 'FULLY_PAID') {
    await timeline.log({
      tenantId, bookingId, type: 'BOOKING_FULLY_PAID',
      title: 'Booking fully paid', actorType: 'SYSTEM',
      meta: { totalReceivedMinor },
    });
    emit(EVENTS.COLLECTION_BOOKING_FULLY_PAID, { tenantId, bookingId, totalReceivedMinor });
  }
  return { ...booking, ...update };
}

/**
 * §188 `collection.overdue_refresh`. Nothing happens on the day an installment
 * becomes overdue to fire an event, so the transition has to be swept for.
 */
async function overdueRefresh({ tenantId = null, limit = 500, now = new Date() } = {}) {
  const filter = { postBookingInitAt: { $ne: null }, outstandingMinor: { $gt: 0 }, status: { $ne: 'CANCELLED' } };
  if (tenantId) filter.tenantId = tenantId;
  const bookings = await Booking.find(filter).setOptions({ allowCrossTenant: !tenantId })
    .select('_id tenantId overdueMinor nextDueAt').limit(limit).lean();

  // One timezone lookup per tenant, not per booking — the sweep runs every minute.
  const zones = new Map();
  const zoneFor = async (id) => {
    const key = String(id);
    if (!zones.has(key)) {
      const tenant = await require('../db/models').Tenant.findById(id).select('timezone').lean();
      zones.set(key, tenant?.timezone || 'UTC');
    }
    return zones.get(key);
  };

  let refreshed = 0;
  for (const booking of bookings) {
    const tz = await zoneFor(booking.tenantId);
    const before = booking.overdueMinor;
    const after = await recalcBooking({ tenantId: booking.tenantId, bookingId: booking._id, tz, now });
    if (before === 0 && after.overdueMinor > 0) {
      await timeline.log({
        tenantId: booking.tenantId, bookingId: booking._id, type: 'INSTALLMENT_OVERDUE',
        title: 'Installment is overdue', actorType: 'SYSTEM',
        meta: { overdueMinor: after.overdueMinor, days: after.overdueDaysMax },
      });
      emit(EVENTS.COLLECTION_INSTALLMENT_OVERDUE, {
        tenantId: booking.tenantId, bookingId: booking._id, overdueMinor: after.overdueMinor,
      });
      if (after.collectionOwnerUserId) {
        await notifications.notify({
          tenantId: booking.tenantId,
          userId: after.collectionOwnerUserId,
          domain: 'COLLECTION',
          type: 'INSTALLMENT_OVERDUE',
          title: 'Payment is overdue',
          body: 'An installment passed its due date with money outstanding.',
          link: `/app/bookings/${booking._id}`,
          bookingId: booking._id,
          severity: 'WARNING',
        });
      }
    }
    refreshed += 1;
  }
  return { scanned: bookings.length, refreshed };
}

/* ------------------------------- work queue ------------------------------- */

const TABS = ['due-today', 'overdue', 'upcoming', 'ptp-today', 'missed-followup', 'all'];

const TAB_LABELS = {
  'due-today': 'Due today',
  overdue: 'Overdue',
  upcoming: 'Upcoming 7 days',
  'ptp-today': 'Promise to pay today',
  'missed-followup': 'Missed follow-ups',
  all: 'All my bookings',
};

/** §201 aging buckets. */
function agingBucket(days) {
  if (!days || days <= 0) return 'CURRENT';
  if (days <= 30) return '1-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  return '90+';
}

/**
 * The one definition of every tab, used by both the tiles and the list (§279).
 * `ptp-today` and `missed-followup` need an id lookup first; that lookup is part
 * of the filter so the two readers cannot drift.
 */
async function filterFor({ tenantId, tab, scope, zone = 'UTC', now = new Date() }) {
  const today = tzLib.todayRange(zone, now);
  const base = {
    tenantId,
    ...scope,
    status: { $ne: 'CANCELLED' },
    postBookingInitAt: { $ne: null },
  };

  switch (tab) {
    case 'due-today':
      return { ...base, outstandingMinor: { $gt: 0 }, nextDueAt: { $gte: today.start, $lt: today.end } };
    case 'overdue':
      return { ...base, overdueMinor: { $gt: 0 } };
    case 'upcoming':
      return {
        ...base,
        outstandingMinor: { $gt: 0 },
        nextDueAt: { $gte: today.end, $lte: tzLib.addLocalDays(now, 8, zone) },
      };
    case 'ptp-today': {
      const promises = await CollectionPromise.find({
        tenantId, status: 'OPEN', promisedDate: { $gte: today.start, $lt: today.end },
      }).select('bookingId').lean();
      return { ...base, _id: { $in: promises.map((p) => p.bookingId) } };
    }
    case 'missed-followup': {
      const followups = await CollectionFollowUp.find({
        tenantId, status: { $in: ['PENDING', 'MISSED'] }, dueAt: { $lt: now },
      }).select('bookingId').lean();
      return { ...base, _id: { $in: followups.map((f) => f.bookingId) } };
    }
    case 'all':
    default:
      return base;
  }
}

/** Scope fragment for the current user, or null when they may see nothing. */
async function ownerScope({ user }) {
  return scopeFilter(user, 'collection.view', 'collectionOwnerUserId');
}

/**
 * §202 queue priority: missed promises first, then deepest overdue, then due
 * today, then everything else by outstanding. Sort is overridable by the user.
 */
const SORTS = {
  priority: { overdueDaysMax: -1, nextDueAt: 1, outstandingMinor: -1 },
  due: { nextDueAt: 1 },
  outstanding: { outstandingMinor: -1 },
  aging: { overdueDaysMax: -1 },
};

async function queue({
  tenantId, user, tab = 'due-today', query = {}, page = 1, limit = 25, zone = 'UTC', now = new Date(),
}) {
  const scope = await ownerScope({ user });
  if (!scope) throw forbidden('You do not have permission to view collections.');
  const activeTab = TABS.includes(tab) ? tab : 'due-today';

  const filter = await filterFor({ tenantId, tab: activeTab, scope, zone, now });
  if (query.projectId) filter.projectId = query.projectId;
  if (query.collectionOwnerUserId) filter.collectionOwnerUserId = query.collectionOwnerUserId;
  if (query.q) {
    const contacts = await Contact.find({
      tenantId,
      $or: [
        { displayName: new RegExp(String(query.q).trim(), 'i') },
        { normalizedMobile: new RegExp(String(query.q).replace(/\D/g, '')) },
      ],
    }).select('_id').limit(200).lean();
    const byNumber = { bookingNumber: new RegExp(String(query.q).trim(), 'i') };
    filter.$or = [{ contactId: { $in: contacts.map((c) => c._id) } }, byNumber];
  }

  const sort = SORTS[query.sortBy] || SORTS.priority;
  const skip = (Math.max(1, Number(page)) - 1) * limit;
  const [items, total] = await Promise.all([
    Booking.find(filter).sort(sort).skip(skip).limit(limit)
      .populate('contactId', 'displayName primaryMobile')
      .populate('projectId', 'name')
      .populate('unitId', 'unitNumber')
      .populate('collectionOwnerUserId', 'name')
      .lean(),
    Booking.countDocuments(filter),
  ]);

  // The work row needs "what happened last / what is next" (§152).
  const bookingIds = items.map((b) => b._id);
  const [pending, lastDone, promises] = await Promise.all([
    CollectionFollowUp.find({
      tenantId, bookingId: { $in: bookingIds }, status: { $in: ['PENDING', 'MISSED'] },
    }).sort({ dueAt: 1 }).lean(),
    CollectionFollowUp.find({
      tenantId, bookingId: { $in: bookingIds }, status: 'COMPLETED',
    }).sort({ completedAt: -1 }).lean(),
    CollectionPromise.find({ tenantId, bookingId: { $in: bookingIds }, status: 'OPEN' })
      .sort({ promisedDate: 1 }).lean(),
  ]);
  const firstBy = (rows) => rows.reduce((map, row) => {
    const key = String(row.bookingId);
    if (!map.has(key)) map.set(key, row);
    return map;
  }, new Map());
  const nextByBooking = firstBy(pending);
  const lastByBooking = firstBy(lastDone);
  const promiseByBooking = firstBy(promises);

  const rows = items.map((booking) => ({
    ...booking,
    nextFollowUp: nextByBooking.get(String(booking._id)) || null,
    lastFollowUp: lastByBooking.get(String(booking._id)) || null,
    openPromise: promiseByBooking.get(String(booking._id)) || null,
    aging: agingBucket(booking.overdueDaysMax),
  }));

  return {
    items: rows, total, page: Number(page), pages: Math.ceil(total / limit) || 1, limit,
    tab: activeTab, tabLabel: TAB_LABELS[activeTab],
  };
}

/**
 * §150/§151 tiles. Each count runs the identical filter its tab's list runs, so
 * a tile can never promise records the drilldown does not show (§279).
 *
 * "Payments received today" arrives with receipts in Phase 2 — a tile with no
 * data source behind it would be a lie, not a placeholder.
 */
async function tiles({ tenantId, user, zone = 'UTC', now = new Date() }) {
  const scope = await ownerScope({ user });
  if (!scope) throw forbidden('You do not have permission to view collections.');

  const counts = await Promise.all(TABS.map(async (tab) => {
    const filter = await filterFor({ tenantId, tab, scope, zone, now });
    return { tab, label: TAB_LABELS[tab], count: await Booking.countDocuments(filter) };
  }));

  const tones = {
    'due-today': 'warn', overdue: 'bad', upcoming: '', 'ptp-today': 'warn',
    'missed-followup': 'bad', all: '',
  };
  return counts.map((tile) => ({ ...tile, tone: tones[tile.tab] || '' }));
}

/** §150 financial snapshot for the queue header. */
async function snapshot({ tenantId, user, zone = 'UTC', now = new Date() }) {
  const scope = await ownerScope({ user });
  if (!scope) throw forbidden('You do not have permission to view collections.');
  const { year, month } = tzLib.localParts(now, zone);
  const monthStart = tzLib.localMidnight(year, month, 1, zone);
  const monthEnd = tzLib.localMidnight(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1, 1, zone);

  const base = { tenantId, ...scope, status: { $ne: 'CANCELLED' }, postBookingInitAt: { $ne: null } };
  const totals = await Booking.aggregate([
    { $match: base },
    {
      $group: {
        _id: null,
        outstanding: { $sum: '$outstandingMinor' },
        received: { $sum: '$totalReceivedMinor' },
        overdue: { $sum: '$overdueMinor' },
        bookings: { $sum: 1 },
      },
    },
  ]);

  /**
   * "Due this month" is an installment question, so it is asked of the
   * schedule — but only for the bookings this user may see, which is why the
   * booking scope is applied to the joined document rather than trusted from
   * the installment row.
   */
  const dueThisMonth = await BookingInstallment.aggregate([
    { $match: { tenantId, status: { $nin: ['PAID', 'CANCELLED'] }, outstandingMinor: { $gt: 0 } } },
    {
      $addFields: {
        dueOn: { $ifNull: ['$actualDueDate', '$expectedDueDate'] },
      },
    },
    { $match: { dueOn: { $gte: monthStart, $lt: monthEnd } } },
    { $lookup: { from: 'bookings', localField: 'bookingId', foreignField: '_id', as: 'booking' } },
    { $unwind: '$booking' },
    {
      $match: Object.fromEntries(
        Object.entries(base).map(([key, value]) => (key === 'tenantId'
          ? ['booking.tenantId', value]
          : [`booking.${key}`, value])),
      ),
    },
    { $group: { _id: null, amount: { $sum: '$outstandingMinor' } } },
  ]);

  const t = totals[0] || {};
  return {
    outstandingMinor: t.outstanding || 0,
    receivedMinor: t.received || 0,
    overdueMinor: t.overdue || 0,
    bookings: t.bookings || 0,
    dueThisMonthMinor: dueThisMonth[0]?.amount || 0,
  };
}

/** §153/§201: manager view — aging spread across the bookings they can see. */
async function aging({ tenantId, user, zone = 'UTC', now = new Date() }) {
  const scope = await ownerScope({ user });
  if (!scope) throw forbidden('You do not have permission to view collections.');
  const bookings = await Booking.find({
    tenantId, ...scope, status: { $ne: 'CANCELLED' }, overdueMinor: { $gt: 0 },
  }).select('overdueMinor overdueDaysMax').lean();

  const buckets = { CURRENT: 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
  const counts = { CURRENT: 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
  for (const booking of bookings) {
    const bucket = agingBucket(booking.overdueDaysMax);
    buckets[bucket] += booking.overdueMinor;
    counts[bucket] += 1;
  }
  return { buckets, counts };
}

/** Booking workspace collection card (§225) + the schedule timeline (§137). */
async function bookingDetail({ tenantId, bookingId, zone = 'UTC', now = new Date() }) {
  const booking = await Booking.findOne({ tenantId, _id: bookingId })
    .populate('contactId', 'displayName primaryMobile email')
    .populate('projectId', 'name')
    .populate('unitId', 'unitNumber')
    .populate('salespersonId', 'name')
    .populate('collectionOwnerUserId', 'name')
    .populate('paymentPlanId', 'name')
    .lean();
  if (!booking) throw notFound('Booking not found.');

  const [rows, followups, promises, events] = await Promise.all([
    installmentsService.forBooking({ tenantId, bookingId }),
    CollectionFollowUp.find({ tenantId, bookingId }).sort({ dueAt: -1 })
      .populate('assignedUserId', 'name').lean(),
    CollectionPromise.find({ tenantId, bookingId }).sort({ promisedDate: -1 }).lean(),
    timeline.forBooking({ tenantId, bookingId, limit: 60 }),
  ]);

  return {
    booking,
    installments: rows.map((row) => ({
      ...row,
      dueDate: installmentsService.dueDateOf(row),
      overdue: installmentsService.isOverdue(row, { tz: zone, now }),
      overdueDays: installmentsService.overdueDays(row, { tz: zone, now }),
    })),
    followups,
    nextFollowUp: followups.find((f) => ['PENDING', 'MISSED'].includes(f.status)) || null,
    promises,
    openPromise: promises.find((p) => p.status === 'OPEN') || null,
    events,
    aging: agingBucket(booking.overdueDaysMax),
  };
}

/** Guard for routes: may this user work this booking's collection? */
async function assertCanWork({ user, booking }) {
  const scope = await scopeFilter(user, 'collection.view', 'collectionOwnerUserId');
  if (!scope) throw forbidden('You do not have permission to work collections.');
  if (!Object.keys(scope).length) return true;                     // 'all'
  const owner = booking.collectionOwnerUserId?._id || booking.collectionOwnerUserId;
  if (!owner) throw forbidden('This booking has no collection owner yet.');
  if (String(owner) === String(user._id)) return true;
  const ids = await teamUserIds(user);
  if (ids.some((id) => String(id) === String(owner))) return true;
  throw forbidden('This collection belongs to another user.');
}

module.exports = {
  resolveOwner, transferOwner, recalcBooking, overdueRefresh,
  queue, tiles, snapshot, aging, bookingDetail, filterFor, assertCanWork,
  agingBucket, TABS, TAB_LABELS,
};
