const { BookingInstallment, Project } = require('../db/models');
const { badRequest, notFound } = require('../lib/errors');
const money = require('../lib/money');
const tzLib = require('../lib/tz');
const timeline = require('./timeline');
const audit = require('./audit');

/**
 * V2 §132–§136 + §267: the booking payment schedule.
 *
 * Everything here reads the FROZEN plan snapshot on the booking. Nothing reads
 * the live PaymentPlan master, which is the whole point of §114/§344.7 — a
 * project changing its plan next month must not move an existing customer's
 * receivables.
 */

/**
 * §133. The V1.1 PaymentPlan enum stays exactly as it is so the existing
 * payment-plan setup screen keeps working; it is translated here instead.
 */
const DUE_RULE_FROM_PLAN = {
  ON_BOOKING: 'BOOKING_DATE',
  DAYS_AFTER_BOOKING: 'DAYS_AFTER_BOOKING',
  CONSTRUCTION: 'EXPECTED_MILESTONE_DATE',
  ON_POSSESSION: 'POSSESSION_DATE',
  CUSTOM: 'MANUAL_TRIGGER',
};

const translateDueRule = (planRule) => DUE_RULE_FROM_PLAN[planRule] || 'MANUAL_TRIGGER';

/**
 * §135. Returns null for "TBD" — a construction milestone with no known date.
 * A date is never invented; the collection user sets it when the milestone
 * actually happens (§268).
 */
function resolveDueDate({ dueRule, dueOffsetDays, bookingDate, project, tz = 'UTC' }) {
  const booked = new Date(bookingDate);
  switch (dueRule) {
    case 'BOOKING_DATE':
      return tzLib.startOfDay(booked, tz);
    case 'DAYS_AFTER_BOOKING':
      return dueOffsetDays == null ? null : tzLib.addLocalDays(booked, Number(dueOffsetDays), tz);
    case 'POSSESSION_DATE':
      return project?.possessionDate ? tzLib.startOfDay(new Date(project.possessionDate), tz) : null;
    case 'FIXED_DATE':
    case 'EXPECTED_MILESTONE_DATE':
    case 'MANUAL_TRIGGER':
    default:
      return null;
  }
}

/**
 * §267: amounts are integer minor units and the schedule must sum to the plan
 * basis exactly, so the rounding remainder lands on the final installment.
 *
 * When a plan's percentages do not add up to 100 the shortfall is NOT quietly
 * absorbed — that would invent money the customer never agreed to. The schedule
 * is generated as configured and `scheduledTotalMinor` on the booking then
 * differs from the booking value, which the workspace shows plainly.
 */
function amountsFor({ rows, basisMinor }) {
  const amounts = rows.map((row) => money.percentOf(basisMinor, row.percentage || 0));
  const totalPct = rows.reduce((sum, row) => sum + Number(row.percentage || 0), 0);
  if (rows.length && Math.abs(totalPct - 100) < 0.005) {
    const others = amounts.slice(0, -1).reduce((a, b) => a + b, 0);
    amounts[amounts.length - 1] = basisMinor - others;
  }
  return amounts;
}

/**
 * §266 step 3–4. Idempotent: the unique (tenantId, bookingId, sequence) index
 * plus this early return mean a retried initialization cannot double a schedule.
 */
async function generate({ tenantId, booking, tz = 'UTC' }) {
  const existing = await BookingInstallment.find({ tenantId, bookingId: booking._id })
    .sort({ sequence: 1 }).lean();
  if (existing.length) return existing;

  const rows = [...(booking.paymentPlanRows || [])]
    .sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
  if (!rows.length) return [];

  const project = await Project.findOne({ tenantId, _id: booking.projectId })
    .select('possessionDate').lean();
  const amounts = amountsFor({ rows, basisMinor: booking.finalPriceMinor });

  const docs = rows.map((row, index) => {
    const dueRule = translateDueRule(row.dueRule);
    const expectedDueDate = resolveDueDate({
      dueRule, dueOffsetDays: row.dueOffsetDays, bookingDate: booking.bookingDate, project, tz,
    });
    return {
      tenantId,
      bookingId: booking._id,
      projectId: booking.projectId,
      sequence: row.sequence || index + 1,
      milestone: row.label || `Installment ${index + 1}`,
      percentage: row.percentage,
      scheduledAmountMinor: amounts[index],
      dueRule,
      dueOffsetDays: row.dueOffsetDays,
      expectedDueDate,
      outstandingMinor: amounts[index],
      customerNote: row.customerNote,
      status: 'UPCOMING',
    };
  });

  try {
    await BookingInstallment.insertMany(docs, { ordered: true });
  } catch (err) {
    // A concurrent initialization won the race; its rows are the ones that count.
    if (err.code !== 11000 && err.writeErrors?.[0]?.code !== 11000) throw err;
  }
  return BookingInstallment.find({ tenantId, bookingId: booking._id }).sort({ sequence: 1 }).lean();
}

/** The date an installment is payable on, or null while TBD. */
const dueDateOf = (installment) => installment.actualDueDate || installment.expectedDueDate || null;

/** §136: OVERDUE is derived, never stored — it changes with the clock. */
function isOverdue(installment, { tz = 'UTC', now = new Date() } = {}) {
  const due = dueDateOf(installment);
  if (!due || installment.status === 'CANCELLED') return false;
  return due < tzLib.startOfDay(now, tz) && installment.outstandingMinor > 0;
}

function overdueDays(installment, { tz = 'UTC', now = new Date() } = {}) {
  if (!isOverdue(installment, { tz, now })) return 0;
  const due = tzLib.startOfDay(dueDateOf(installment), tz);
  return Math.floor((tzLib.startOfDay(now, tz) - due) / 86400000);
}

/** §136 stored status, from what has been received and whether the date has arrived. */
function statusFor(installment, { tz = 'UTC', now = new Date() } = {}) {
  if (installment.status === 'CANCELLED') return 'CANCELLED';
  const received = installment.amountReceivedMinor || 0;
  if (received >= installment.scheduledAmountMinor) return 'PAID';
  if (received > 0) return 'PARTIAL';
  const due = dueDateOf(installment);
  if (due && due <= tzLib.endOfDay(now, tz)) return 'DUE';
  return 'UPCOMING';
}

/**
 * Reconciles stored status with the clock. Idempotent, and the only writer of
 * `status` outside receipt allocation.
 */
async function refreshStatuses({ tenantId, bookingId, tz = 'UTC', now = new Date() }) {
  const rows = await BookingInstallment.find({ tenantId, bookingId }).sort({ sequence: 1 }).lean();
  const changed = [];
  for (const row of rows) {
    const next = statusFor(row, { tz, now });
    const outstanding = Math.max(0, row.scheduledAmountMinor - (row.amountReceivedMinor || 0));
    if (next === row.status && outstanding === row.outstandingMinor) continue;
    await BookingInstallment.updateOne({ tenantId, _id: row._id }, {
      $set: {
        status: next,
        outstandingMinor: outstanding,
        ...(next === 'PAID' && !row.paidAt ? { paidAt: now } : {}),
      },
    });
    changed.push({ installmentId: row._id, from: row.status, to: next });
  }
  return changed;
}

const forBooking = ({ tenantId, bookingId }) => BookingInstallment
  .find({ tenantId, bookingId }).sort({ sequence: 1 }).lean();

/**
 * §268: the one schedule change V2 allows. Amounts and percentages are never
 * editable here — a commercial amendment is a different, privileged flow (§200).
 */
async function setDueDate({ tenantId, actor, bookingId, installmentId, actualDueDate, reason, tz = 'UTC' }) {
  const installment = await BookingInstallment.findOne({ tenantId, _id: installmentId, bookingId }).lean();
  if (!installment) throw notFound('Installment not found.');
  if (installment.status === 'PAID') throw badRequest('This installment is already paid.');
  if (!actualDueDate) throw badRequest('Choose the new due date.');
  if (!reason || !String(reason).trim()) throw badRequest('Give a reason for the due date change.');

  const to = tzLib.fromLocalInput(actualDueDate, '00:00', tz);
  if (!to || Number.isNaN(to.getTime())) throw badRequest('Choose a valid due date.');

  const from = dueDateOf(installment);
  await BookingInstallment.updateOne({ tenantId, _id: installment._id }, {
    $set: { actualDueDate: to, note: reason },
  });
  await timeline.log({
    tenantId,
    bookingId,
    type: 'INSTALLMENT_DUE_DATE_CHANGED',
    title: `${installment.milestone} due date changed`,
    body: reason,
    actor,
    meta: { installmentId: String(installment._id), from, to },
  });
  await audit.record({
    tenantId, actor, entity: 'BookingInstallment', entityId: installment._id, action: 'UPDATE',
    before: { dueDate: from }, after: { dueDate: to, reason },
  });
  return BookingInstallment.findOne({ tenantId, _id: installment._id }).lean();
}

module.exports = {
  generate, forBooking, refreshStatuses, setDueDate,
  resolveDueDate, translateDueRule, amountsFor, statusFor, isOverdue, overdueDays, dueDateOf,
  DUE_RULE_FROM_PLAN,
};
