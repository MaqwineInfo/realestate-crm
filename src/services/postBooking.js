const {
  Booking, CostSheet, PaymentPlan, Project, Unit, Contact, Tenant,
} = require('../db/models');
const { notFound } = require('../lib/errors');
const { EVENTS, emit } = require('../lib/events');
const installments = require('./installments');
const timeline = require('./timeline');
const notifications = require('./notifications');

/**
 * V2 §108 / §266: everything that has to exist before a booking can be
 * collected on.
 *
 * Two rules shape this file, both non-negotiable (§324.1, §344.5-6):
 *
 *   1. a valid booking is NEVER undone because post-booking setup failed;
 *   2. initialization is idempotent, so the retry sweep can finish a run that
 *      died half way without doubling a schedule.
 *
 * `Booking.postBookingInitAt` is the marker. It is set last.
 */

/** §105/§110: BKG-<project code>-<year>-<sequence>. The id stays authoritative. */
async function nextBookingNumber({ tenantId, project }) {
  const code = (project?.code || project?.name || 'BKG')
    .replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase() || 'BKG';
  const year = new Date().getFullYear();
  const prefix = `BKG-${code}-${year}-`;
  const latest = await Booking.findOne({ tenantId, bookingNumber: new RegExp(`^${prefix}`) })
    .sort({ bookingNumber: -1 }).select('bookingNumber').lean();
  const nextSeq = latest ? Number(String(latest.bookingNumber).slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(nextSeq).padStart(5, '0')}`;
}

/**
 * §115: the plan as it was sold. The quotation's snapshot is authoritative
 * because that is the document the customer agreed to; the plan master is only
 * consulted when the booking was made without a quotation.
 */
async function planSnapshotFor({ tenantId, booking }) {
  if (booking.paymentPlanRows?.length) {
    return { paymentPlanName: booking.paymentPlanName, paymentPlanRows: booking.paymentPlanRows };
  }
  if (booking.costSheetId) {
    const sheet = await CostSheet.findOne({ tenantId, _id: booking.costSheetId })
      .select('paymentPlanName paymentPlanRows').lean();
    if (sheet?.paymentPlanRows?.length) {
      return { paymentPlanName: sheet.paymentPlanName, paymentPlanRows: sheet.paymentPlanRows };
    }
  }
  const plan = await PaymentPlan.findOne({ tenantId, _id: booking.paymentPlanId })
    .select('name milestones').lean();
  if (!plan) return { paymentPlanName: undefined, paymentPlanRows: [] };
  const rows = [...(plan.milestones || [])]
    .sort((a, b) => (a.sequence || a.displayOrder || 0) - (b.sequence || b.displayOrder || 0))
    .map((m, index) => ({
      sequence: m.sequence || index + 1,
      label: m.label,
      percentage: m.percentage,
      dueRule: m.dueRule,
      dueOffsetDays: m.dueOffsetDays,
      customerNote: m.customerNote || m.note,
    }));
  return { paymentPlanName: plan.name, paymentPlanRows: rows };
}

/**
 * §112: operational status, derived — never typed in. Kept out of the
 * commercial `Booking.status`, which stays the sales record (§112 recommendation).
 */
function derivePostBookingStatus(booking) {
  if (booking.status === 'CANCELLED') return 'CANCELLED';
  if (booking.scheduledTotalMinor > 0 && booking.outstandingMinor === 0) return 'FULLY_PAID';
  switch (booking.kycStatus) {
    case 'VERIFIED': return 'ACTIVE_COLLECTION';
    case 'SUBMITTED':
    case 'UNDER_REVIEW': return 'KYC_SUBMITTED';
    default: return 'KYC_PENDING';
  }
}

/**
 * §266, in that order. Safe to call any number of times.
 *
 * Callers must treat a thrown error as "try again later", never as a reason to
 * touch the booking itself.
 */
async function initialize({ tenantId, bookingId, actor = null, tz = null, force = false }) {
  const booking = await Booking.findOne({ tenantId, _id: bookingId }).lean();
  if (!booking) throw notFound('Booking not found.');
  // §207: due dates are calendar dates in the tenant's timezone, never server UTC.
  const zone = tz || (await Tenant.findById(tenantId).select('timezone').lean())?.timezone || 'UTC';
  if (booking.postBookingInitAt && !force) return booking;              // 2. marker
  if (booking.status === 'CANCELLED') return booking;

  const [project, unit] = await Promise.all([
    Project.findOne({ tenantId, _id: booking.projectId }).select('name code possessionDate').lean(),
    Unit.findOne({ tenantId, _id: booking.unitId }).select('unitNumber').lean(),
  ]);

  // 3. Freeze the plan onto the booking, so the schedule never needs the master again.
  const snapshot = await planSnapshotFor({ tenantId, booking });
  const bookingNumber = booking.bookingNumber || await nextBookingNumber({ tenantId, project });
  await Booking.updateOne({ tenantId, _id: booking._id }, {
    $set: { ...snapshot, bookingNumber },
  });
  const withSnapshot = { ...booking, ...snapshot, bookingNumber };

  // 4. The schedule itself.
  const rows = await installments.generate({ tenantId, booking: withSnapshot, tz: zone });

  // 5. Collection ownership (§147/§148). Required before 7, which reads the totals.
  const collections = require('./collections');
  const owner = await collections.resolveOwner({ tenantId, booking: withSnapshot });

  // 6 + 7. KYC starts NOT_STARTED (schema default); totals and status are derived.
  await Booking.updateOne({ tenantId, _id: booking._id }, {
    $set: {
      collectionOwnerUserId: owner?._id || null,
      ...(owner ? { collectionAssignedAt: new Date() } : {}),
    },
  });
  await collections.recalcBooking({ tenantId, bookingId: booking._id, tz: zone });

  // 8. Timeline, on the booking's own anchor.
  await timeline.log({
    tenantId,
    bookingId: booking._id,
    contactId: booking.contactId,
    type: 'POST_BOOKING_INITIALIZED',
    title: `Post-booking started — ${rows.length} installment${rows.length === 1 ? '' : 's'} scheduled`,
    actor,
    actorType: actor ? 'USER' : 'SYSTEM',
    meta: { bookingNumber, installments: rows.length, unit: unit?.unitNumber },
  });
  if (rows.length) {
    await timeline.log({
      tenantId,
      bookingId: booking._id,
      type: 'SCHEDULE_GENERATED',
      title: `Payment schedule generated from ${snapshot.paymentPlanName || 'the selected plan'}`,
      actorType: 'SYSTEM',
      meta: { installments: rows.length },
    });
  }
  if (owner) {
    await timeline.log({
      tenantId,
      bookingId: booking._id,
      type: 'COLLECTION_ASSIGNED',
      title: 'Collection assigned',
      body: owner.name,
      actor,
      actorType: actor ? 'USER' : 'SYSTEM',
      meta: { collectionOwnerUserId: String(owner._id) },
    });
  }

  /**
   * 9. §266 step 9 / §42: accrue the channel-partner commission, if this sale
   * came through a partner. Inside its own try/catch for the same reason as
   * everything else here — a commission problem must not stop a booking from
   * being collectable. The `cp.commission_eligibility` job retries.
   */
  try {
    const tenantDoc = await Tenant.findById(tenantId).lean();
    await require('./commissions').accrueForBooking({
      tenantId, tenant: tenantDoc, bookingId: booking._id, actor,
    });
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error', scope: 'cp-commission-accrual', bookingId: String(booking._id), message: err.message,
    }));
  }

  // 10. Tell whoever now owns the money.
  const contact = await Contact.findOne({ tenantId, _id: booking.contactId }).select('displayName').lean();
  if (owner) {
    await notifications.notify({
      tenantId,
      userId: owner._id,
      domain: 'COLLECTION',
      type: 'COLLECTION_ASSIGNED',
      title: 'Collection assigned to you',
      body: `${contact?.displayName || 'Customer'} · ${project?.name || ''} ${unit?.unitNumber || ''}`.trim(),
      link: `/app/bookings/${booking._id}`,
      bookingId: booking._id,
      severity: 'INFO',
    });
  } else {
    // §294: an unassigned collection is a manager's problem, not a silent gap.
    await notifications.notifyMany({
      tenantId,
      userIds: await notifications.adminUserIds(tenantId),
      domain: 'COLLECTION',
      type: 'COLLECTION_UNASSIGNED',
      title: 'Booking has no collection owner',
      body: `${contact?.displayName || 'Customer'} · assign someone to chase this schedule.`,
      link: `/app/bookings/${booking._id}`,
      bookingId: booking._id,
      severity: 'WARNING',
    });
  }

  await Booking.updateOne({ tenantId, _id: booking._id }, { $set: { postBookingInitAt: new Date() } });
  emit(EVENTS.BOOKING_POST_INITIALIZED, { tenantId, bookingId: booking._id, installments: rows.length });
  return Booking.findOne({ tenantId, _id: booking._id }).lean();
}

/**
 * §188 `booking.post_initialize_retry`. A booking whose initialization failed
 * still collects nothing, so this has to be a job and not a hope.
 */
async function retrySweep({ tenantId = null, limit = 25 } = {}) {
  const filter = { postBookingInitAt: null, sagaComplete: true, status: { $ne: 'CANCELLED' } };
  if (tenantId) filter.tenantId = tenantId;
  const pending = await Booking.find(filter).setOptions({ allowCrossTenant: !tenantId })
    .select('_id tenantId').limit(limit).lean();

  let initialized = 0;
  for (const booking of pending) {
    try {
      await initialize({ tenantId: booking.tenantId, bookingId: booking._id });
      initialized += 1;
    } catch (err) {
      console.error(JSON.stringify({
        level: 'error', scope: 'post-booking', bookingId: String(booking._id), message: err.message,
      }));
    }
  }
  return { scanned: pending.length, initialized };
}

/**
 * §110/§183: who may open a booking. Two owners can grant access — the
 * salesperson who sold it and the user who collects on it — because they are
 * deliberately different people (§183). Scope is resolved from whichever
 * permission the user actually holds.
 */
async function assertCanView({ user, booking }) {
  const { scopeOf, teamUserIds } = require('../lib/access');
  const salesScope = scopeOf(user, 'booking.view');
  const collectionScope = scopeOf(user, 'collection.view');
  if (salesScope === 'none' && collectionScope === 'none') {
    throw require('../lib/errors').forbidden('You do not have permission to view bookings.');
  }
  if (salesScope === 'all' || collectionScope === 'all') return true;

  const salesperson = String(booking.salespersonId?._id || booking.salespersonId || '');
  const collector = String(booking.collectionOwnerUserId?._id || booking.collectionOwnerUserId || '');
  const me = String(user._id);
  if ((salesScope !== 'none' && salesperson === me) || (collectionScope !== 'none' && collector === me)) return true;

  if (salesScope === 'team' || collectionScope === 'team') {
    const team = (await teamUserIds(user)).map(String);
    if (salesScope === 'team' && team.includes(salesperson)) return true;
    if (collectionScope === 'team' && team.includes(collector)) return true;
  }
  throw require('../lib/errors').forbidden('This booking belongs to another user.');
}

/**
 * §110/§111: the booking list. Reads only the denormalized totals (§242), so a
 * hundred bookings is one query and no schedule scan.
 */
async function list({ tenantId, scope, query = {}, page = 1, limit = 25, tz = 'UTC' }) {
  const { Contact } = require('../db/models');
  const tzLib = require('../lib/tz');
  const filter = { tenantId, ...scope };

  if (query.projectId) filter.projectId = query.projectId;
  if (query.unitId) filter.unitId = query.unitId;
  if (query.kycStatus) filter.kycStatus = query.kycStatus;
  if (query.postBookingStatus) filter.postBookingStatus = query.postBookingStatus;
  if (query.collectionOwnerUserId) filter.collectionOwnerUserId = query.collectionOwnerUserId;
  if (query.buyerPurpose) filter.buyerPurpose = query.buyerPurpose;
  if (query.overdue === '1') filter.overdueMinor = { $gt: 0 };
  if (query.overdue === '0') filter.overdueMinor = 0;
  if (query.unassigned === '1') filter.collectionOwnerUserId = null;

  if (query.from || query.to) {
    filter.bookingDate = {};
    if (query.from) filter.bookingDate.$gte = tzLib.fromLocalInput(query.from, '00:00', tz);
    if (query.to) filter.bookingDate.$lte = tzLib.fromLocalInput(query.to, '23:59', tz);
  }
  if (query.dueFrom || query.dueTo) {
    filter.nextDueAt = {};
    if (query.dueFrom) filter.nextDueAt.$gte = tzLib.fromLocalInput(query.dueFrom, '00:00', tz);
    if (query.dueTo) filter.nextDueAt.$lte = tzLib.fromLocalInput(query.dueTo, '23:59', tz);
  }
  if (query.q) {
    const term = String(query.q).trim();
    const digits = term.replace(/\D/g, '');
    const contacts = await Contact.find({
      tenantId,
      $or: [
        { displayName: new RegExp(term, 'i') },
        ...(digits ? [{ normalizedMobile: new RegExp(digits) }] : []),
      ],
    }).select('_id').limit(200).lean();
    const units = await Unit.find({ tenantId, unitNumber: new RegExp(term, 'i') }).select('_id').limit(200).lean();
    filter.$or = [
      { contactId: { $in: contacts.map((c) => c._id) } },
      { unitId: { $in: units.map((u) => u._id) } },
      { bookingNumber: new RegExp(term, 'i') },
    ];
  }

  const sort = { [query.sortBy || 'bookingDate']: query.sortDir === 'asc' ? 1 : -1 };
  const skip = (Math.max(1, Number(page)) - 1) * limit;
  const [items, total] = await Promise.all([
    Booking.find(filter).sort(sort).skip(skip).limit(limit)
      .populate('contactId', 'displayName primaryMobile')
      .populate('projectId', 'name')
      .populate('unitId', 'unitNumber')
      .populate('collectionOwnerUserId', 'name')
      .populate('salespersonId', 'name')
      .populate('costSheetId', 'quotationNumber version')
      .lean(),
    Booking.countDocuments(filter),
  ]);
  return { items, total, page: Number(page), pages: Math.ceil(total / limit) || 1, limit };
}

module.exports = {
  initialize, retrySweep, list, assertCanView, planSnapshotFor, derivePostBookingStatus, nextBookingNumber,
};
