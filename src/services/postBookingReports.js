const {
  Booking, BookingInstallment, BookingReceipt, ReceiptAllocation, CollectionFollowUp,
  CollectionPromise, PaymentRequest, User,
} = require('../db/models');
const tzLib = require('../lib/tz');
const installmentsService = require('./installments');
const collections = require('./collections');
const reports = require('./reports');

/**
 * V2 §168–§170: the three post-booking reports.
 *
 * Metric definitions come from §280 so a number means one thing everywhere:
 * Outstanding = scheduled − received; Overdue = outstanding past its due date;
 * Collection % = received ÷ scheduled. Amounts and percentages are always shown
 * together (§170) — a big collected number on a big book is not performance.
 */

/** Bookings the caller may see, by either ownership (§183). */
async function scopeFor({ user }) {
  const { scopeFilter } = require('../lib/access');
  const [sales, collection] = await Promise.all([
    scopeFilter(user, 'booking.view', 'salespersonId'),
    scopeFilter(user, 'collection.view', 'collectionOwnerUserId'),
  ]);
  if (!sales && !collection) return null;
  const narrow = [sales, collection].filter((sc) => sc && Object.keys(sc).length);
  const unrestricted = [sales, collection].some((sc) => sc && !Object.keys(sc).length);
  if (unrestricted) return {};
  return narrow.length > 1 ? { $or: narrow } : narrow[0];
}

function bookingFilter({ tenantId, query = {}, zone, scope = {} }) {
  const { start, end } = reports.rangeFor({ from: query.from, to: query.to, zone });
  const filter = { tenantId, ...scope, postBookingInitAt: { $ne: null } };
  // The date range applies to the booking date unless the caller asks otherwise.
  if (query.dateBasis !== 'none') filter.bookingDate = { $gte: start, $lte: end };
  if (query.projectId) filter.projectId = query.projectId;
  if (query.collectionOwnerUserId) filter.collectionOwnerUserId = query.collectionOwnerUserId;
  if (query.salespersonId) filter.salespersonId = query.salespersonId;
  if (query.kycStatus) filter.kycStatus = query.kycStatus;
  if (query.overdue === '1') filter.overdueMinor = { $gt: 0 };
  if (query.overdue === '0') filter.overdueMinor = 0;
  if (query.status) filter.postBookingStatus = query.status;
  return { filter, start, end };
}

/** §169 Booking & KYC report: one row per booking. */
async function bookingReport({ tenantId, query, zone, scope }) {
  const { filter, start, end } = bookingFilter({ tenantId, query, zone, scope });
  const rows = await Booking.find(filter)
    .sort({ bookingDate: -1 })
    .populate('contactId', 'displayName primaryMobile')
    .populate('projectId', 'name')
    .populate('unitId', 'unitNumber')
    .populate('salespersonId', 'name')
    .populate('collectionOwnerUserId', 'name')
    .populate('costSheetId', 'quotationNumber version')
    .limit(1000)
    .lean();

  const totals = rows.reduce((acc, b) => ({
    bookings: acc.bookings + 1,
    valueMinor: acc.valueMinor + b.finalPriceMinor,
    scheduledMinor: acc.scheduledMinor + (b.scheduledTotalMinor || 0),
    receivedMinor: acc.receivedMinor + (b.totalReceivedMinor || 0),
    outstandingMinor: acc.outstandingMinor + (b.outstandingMinor || 0),
    overdueMinor: acc.overdueMinor + (b.overdueMinor || 0),
  }), { bookings: 0, valueMinor: 0, scheduledMinor: 0, receivedMinor: 0, outstandingMinor: 0, overdueMinor: 0 });

  const kycBreakdown = rows.reduce((acc, b) => {
    const key = b.kycStatus || 'NOT_STARTED';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  return {
    rows,
    totals: {
      ...totals,
      collectionPct: totals.scheduledMinor
        ? Math.round((totals.receivedMinor / totals.scheduledMinor) * 100)
        : 0,
    },
    kycBreakdown,
    kycVerifiedPct: totals.bookings
      ? Math.round(((kycBreakdown.VERIFIED || 0) / totals.bookings) * 100)
      : 0,
    start,
    end,
  };
}

/**
 * §168 Collection report: one row per installment, because "what is due and
 * what came in" is an installment question, not a booking one.
 */
async function collectionReport({ tenantId, query, zone, scope, now = new Date() }) {
  const { filter, start, end } = bookingFilter({ tenantId, query, zone, scope });
  const bookings = await Booking.find(filter)
    .select('bookingNumber contactId projectId unitId collectionOwnerUserId finalPriceMinor')
    .populate('contactId', 'displayName primaryMobile')
    .populate('projectId', 'name')
    .populate('unitId', 'unitNumber')
    .populate('collectionOwnerUserId', 'name')
    .limit(1000)
    .lean();
  const byId = new Map(bookings.map((b) => [String(b._id), b]));

  const installmentFilter = { tenantId, bookingId: { $in: bookings.map((b) => b._id) } };
  if (query.installmentStatus) installmentFilter.status = query.installmentStatus;
  const installments = await BookingInstallment.find(installmentFilter)
    .sort({ expectedDueDate: 1, sequence: 1 }).lean();

  const today = tzLib.todayRange(zone, now);
  const rows = installments.map((i) => {
    const dueDate = installmentsService.dueDateOf(i);
    const overdue = installmentsService.isOverdue(i, { tz: zone, now });
    const days = installmentsService.overdueDays(i, { tz: zone, now });
    return {
      ...i,
      booking: byId.get(String(i.bookingId)) || null,
      dueDate,
      overdue,
      overdueDays: days,
      aging: collections.agingBucket(days),
      dueToday: !!dueDate && dueDate >= today.start && dueDate < today.end && i.outstandingMinor > 0,
    };
  }).filter((row) => {
    if (query.aging && row.aging !== query.aging) return false;
    if (query.dueFrom && (!row.dueDate || row.dueDate < tzLib.fromLocalInput(query.dueFrom, '00:00', zone))) return false;
    if (query.dueTo && (!row.dueDate || row.dueDate > tzLib.fromLocalInput(query.dueTo, '23:59', zone))) return false;
    return true;
  });

  // Receipts, promises and links in the same window, for the summary strip.
  const receiptFilter = {
    tenantId,
    bookingId: { $in: bookings.map((b) => b._id) },
    status: 'CONFIRMED',
    paymentDate: { $gte: start, $lte: end },
  };
  if (query.paymentMode) receiptFilter.mode = query.paymentMode;
  const [receipts, promises, links] = await Promise.all([
    BookingReceipt.find(receiptFilter).select('amountMinor mode paymentDate bookingId').lean(),
    CollectionPromise.find({ tenantId, bookingId: { $in: bookings.map((b) => b._id) } })
      .select('promisedAmountMinor status').lean(),
    PaymentRequest.find({ tenantId, bookingId: { $in: bookings.map((b) => b._id) } })
      .select('amountMinor status sharedAt').lean(),
  ]);

  const sum = (list, pick) => list.reduce((total, item) => total + (pick(item) || 0), 0);
  const scheduledMinor = sum(rows, (r) => r.scheduledAmountMinor);
  const receivedOnScheduleMinor = sum(rows, (r) => r.amountReceivedMinor);

  return {
    rows,
    totals: {
      installments: rows.length,
      scheduledMinor,
      receivedMinor: receivedOnScheduleMinor,
      outstandingMinor: sum(rows, (r) => r.outstandingMinor),
      dueTodayMinor: sum(rows.filter((r) => r.dueToday), (r) => r.outstandingMinor),
      overdueMinor: sum(rows.filter((r) => r.overdue), (r) => r.outstandingMinor),
      collectionPct: scheduledMinor ? Math.round((receivedOnScheduleMinor / scheduledMinor) * 100) : 0,
      receiptsInRangeMinor: sum(receipts, (r) => r.amountMinor),
      receiptsInRange: receipts.length,
      ptpOpenMinor: sum(promises.filter((p) => p.status === 'OPEN'), (p) => p.promisedAmountMinor),
      ptpMissed: promises.filter((p) => p.status === 'MISSED').length,
      paymentLinksSent: links.filter((l) => l.sharedAt).length,
      paymentLinksPaid: links.filter((l) => l.status === 'PAID').length,
    },
    aging: ['CURRENT', '1-30', '31-60', '61-90', '90+'].map((bucket) => ({
      bucket,
      amountMinor: sum(rows.filter((r) => r.overdue && r.aging === bucket), (r) => r.outstandingMinor),
      count: rows.filter((r) => r.overdue && r.aging === bucket).length,
    })),
    byMode: BookingReceipt.MODES.map((mode) => ({
      mode,
      amountMinor: sum(receipts.filter((r) => r.mode === mode), (r) => r.amountMinor),
      count: receipts.filter((r) => r.mode === mode).length,
    })).filter((m) => m.count),
    start,
    end,
  };
}

/** §170 Collection performance: one row per collection owner, amount AND percentage. */
async function collectionPerformanceReport({ tenantId, query, zone, scope, now = new Date() }) {
  const { filter, start, end } = bookingFilter({ tenantId, query, zone, scope });
  const bookings = await Booking.find(filter)
    .select('collectionOwnerUserId scheduledTotalMinor totalReceivedMinor outstandingMinor overdueMinor finalPriceMinor')
    .limit(2000)
    .lean();

  const owners = await User.find({
    tenantId, _id: { $in: [...new Set(bookings.map((b) => String(b.collectionOwnerUserId)).filter((id) => id !== 'null' && id !== 'undefined'))] },
  }).select('name').lean();
  const nameById = new Map(owners.map((o) => [String(o._id), o.name]));

  const bookingIds = bookings.map((b) => b._id);
  const [followups, promises, links, receipts] = await Promise.all([
    CollectionFollowUp.find({ tenantId, bookingId: { $in: bookingIds } })
      .select('assignedUserId status completedAt').lean(),
    CollectionPromise.find({ tenantId, bookingId: { $in: bookingIds } })
      .select('assignedUserId status promisedAmountMinor').lean(),
    PaymentRequest.find({ tenantId, bookingId: { $in: bookingIds } })
      .select('bookingId status sharedAt').lean(),
    BookingReceipt.find({
      tenantId, bookingId: { $in: bookingIds }, status: 'CONFIRMED', paymentDate: { $gte: start, $lte: end },
    }).select('bookingId amountMinor').lean(),
  ]);

  const ownerOfBooking = new Map(bookings.map((b) => [String(b._id), String(b.collectionOwnerUserId || 'unassigned')]));
  const groups = new Map();
  const bucket = (key) => {
    if (!groups.has(key)) {
      groups.set(key, {
        ownerUserId: key === 'unassigned' ? null : key,
        owner: key === 'unassigned' ? 'Unassigned' : (nameById.get(key) || 'Former user'),
        bookings: 0,
        scheduledMinor: 0,
        receivedMinor: 0,
        outstandingMinor: 0,
        overdueMinor: 0,
        receiptsInRangeMinor: 0,
        followupsCompleted: 0,
        followupsMissed: 0,
        promises: 0,
        promisesFulfilled: 0,
        paymentLinks: 0,
      });
    }
    return groups.get(key);
  };

  for (const booking of bookings) {
    const row = bucket(String(booking.collectionOwnerUserId || 'unassigned'));
    row.bookings += 1;
    row.scheduledMinor += booking.scheduledTotalMinor || 0;
    row.receivedMinor += booking.totalReceivedMinor || 0;
    row.outstandingMinor += booking.outstandingMinor || 0;
    row.overdueMinor += booking.overdueMinor || 0;
  }
  for (const followup of followups) {
    const row = bucket(String(followup.assignedUserId || 'unassigned'));
    if (followup.status === 'COMPLETED') row.followupsCompleted += 1;
    if (followup.status === 'MISSED') row.followupsMissed += 1;
  }
  for (const promise of promises) {
    const row = bucket(String(promise.assignedUserId || 'unassigned'));
    row.promises += 1;
    if (promise.status === 'FULFILLED') row.promisesFulfilled += 1;
  }
  for (const link of links.filter((l) => l.sharedAt)) {
    bucket(ownerOfBooking.get(String(link.bookingId)) || 'unassigned').paymentLinks += 1;
  }
  for (const receipt of receipts) {
    bucket(ownerOfBooking.get(String(receipt.bookingId)) || 'unassigned').receiptsInRangeMinor += receipt.amountMinor;
  }

  const rows = [...groups.values()].map((row) => ({
    ...row,
    collectionPct: row.scheduledMinor ? Math.round((row.receivedMinor / row.scheduledMinor) * 100) : 0,
    ptpFulfilledPct: row.promises ? Math.round((row.promisesFulfilled / row.promises) * 100) : 0,
  })).sort((a, b) => b.outstandingMinor - a.outstandingMinor);

  return { rows, start, end };
}

module.exports = { scopeFor, bookingFilter, bookingReport, collectionReport, collectionPerformanceReport };
