const {
  Booking, BookingInstallment, CollectionFollowUp, CollectionPromise, User,
} = require('../db/models');
const { badRequest, notFound } = require('../lib/errors');
const { EVENTS, emit } = require('../lib/events');
const tzLib = require('../lib/tz');
const timeline = require('./timeline');
const notifications = require('./notifications');
const audit = require('./audit');

/**
 * V2 §154–§161: collection follow-up.
 *
 * This carries the same non-negotiable rule as sales (§157/§324.18) but for
 * money instead of a decision:
 *
 *   while a booking still owes something, closing a collection follow-up
 *   requires the next one.
 *
 * The exceptions are honest ones: the booking is fully paid, or it was
 * cancelled. Nothing else lets a collection queue quietly empty itself.
 */

const ACTION_LABELS = {
  CALL: 'Call', WHATSAPP: 'WhatsApp', EMAIL: 'Email',
  PAYMENT_LINK: 'Payment link', MEETING: 'Meeting', OTHER: 'Other',
};

/** §161: the next-action half of the drawer, validated before anything is written. */
function resolveNextDueAt({ next, tz, now = new Date() }) {
  if (!next) return null;
  if (next.dueAt) return new Date(next.dueAt);
  if (!next.date) return null;
  return tzLib.fromLocalInput(next.date, next.time || '10:00', tz);
}

async function requireNextAction({ booking, next, tz, now = new Date() }) {
  // §157: no outstanding money, no obligation to keep chasing.
  if (booking.outstandingMinor <= 0 || booking.status === 'CANCELLED') return null;

  if (!next || !next.actionType) {
    throw badRequest('Set the next collection action — money is still outstanding on this booking.');
  }
  if (!CollectionFollowUp.ACTION_TYPES.includes(next.actionType)) {
    throw badRequest('Choose a valid next action.');
  }
  const dueAt = resolveNextDueAt({ next, tz, now });
  if (!dueAt || Number.isNaN(dueAt.getTime())) throw badRequest('Set the date and time for the next action.');
  if (dueAt.getTime() <= now.getTime() - 60000) throw badRequest('The next action must be scheduled in the future.');
  return { actionType: next.actionType, dueAt, note: next.note, assignedUserId: next.assignedUserId };
}

/** §154: schedule collection work. */
async function create({
  tenantId, actor, bookingId, installmentId, actionType, dueAt, assignedUserId, note,
  allowPast = false, silent = false,
}) {
  const booking = await Booking.findOne({ tenantId, _id: bookingId }).lean();
  if (!booking) throw notFound('Booking not found.');
  if (booking.status === 'CANCELLED') throw badRequest('This booking is cancelled.');
  if (!CollectionFollowUp.ACTION_TYPES.includes(actionType)) throw badRequest('Choose a valid action.');

  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime())) throw badRequest('Set the date and time for the follow-up.');
  if (!allowPast && due.getTime() <= Date.now() - 60000) {
    throw badRequest('The next action must be scheduled in the future.');
  }

  const owner = assignedUserId || booking.collectionOwnerUserId;
  if (!owner) throw badRequest('Assign a collection owner to this booking first.');
  if (assignedUserId && String(assignedUserId) !== String(booking.collectionOwnerUserId || '')) {
    const target = await User.findOne({ tenantId, _id: assignedUserId, status: 'ACTIVE' }).lean();
    if (!target) throw badRequest('Collection work can only be assigned to an active user.');
  }
  if (installmentId) {
    const installment = await BookingInstallment.findOne({ tenantId, _id: installmentId, bookingId }).lean();
    if (!installment) throw badRequest('That installment does not belong to this booking.');
  }

  const followup = await CollectionFollowUp.create({
    tenantId,
    bookingId,
    installmentId,
    contactId: booking.contactId,
    assignedUserId: owner,
    actionType,
    dueAt: due,
    note,
    createdBy: actor?._id,
  });

  if (!silent) {
    await timeline.log({
      tenantId,
      bookingId,
      type: 'COLLECTION_FOLLOWUP_CREATED',
      title: `${ACTION_LABELS[actionType]} scheduled`,
      body: note,
      actor,
      meta: { followUpId: String(followup._id), dueAt: due, actionType },
    });
  }
  emit(EVENTS.COLLECTION_FOLLOWUP_DUE, { tenantId, bookingId, followUpId: followup._id, dueAt: due });
  return followup;
}

/**
 * §161: the quick action drawer, in one save — what happened, what the customer
 * promised, and what happens next.
 *
 * Ordering mirrors the sales `applyOutcome()` for the same reason (§87): the
 * next action is validated first and written before the current one closes, so
 * an interrupted run can only ever leave an extra pending follow-up — never a
 * booking that owes money and has nobody chasing it.
 */
async function complete({
  tenantId, actor, followUpId, outcome, note, promise, next, tz = 'UTC', now = new Date(),
}) {
  const followup = await CollectionFollowUp.findOne({ tenantId, _id: followUpId }).lean();
  if (!followup) throw notFound('Collection follow-up not found.');
  if (!['PENDING', 'MISSED'].includes(followup.status)) {
    throw badRequest('This follow-up has already been closed.');
  }
  if (!outcome || !CollectionFollowUp.OUTCOMES.includes(outcome)) {
    throw badRequest('Choose what happened on this contact.');
  }
  const booking = await Booking.findOne({ tenantId, _id: followup.bookingId }).lean();
  if (!booking) throw notFound('Booking not found.');

  // §158: a promise to pay is not a note — it needs an amount and a date.
  let promiseDoc = null;
  if (outcome === 'PROMISE_TO_PAY') {
    const amountMinor = Number(promise?.amountMinor || 0);
    if (!(amountMinor > 0)) throw badRequest('Enter the amount the customer promised to pay.');
    if (amountMinor > booking.outstandingMinor) {
      throw badRequest('The promised amount is higher than the outstanding amount on this booking.');
    }
    const promisedDate = promise?.date ? tzLib.fromLocalInput(promise.date, '23:59', tz) : null;
    if (!promisedDate || Number.isNaN(promisedDate.getTime())) throw badRequest('Enter the date the customer promised to pay by.');
    if (promisedDate.getTime() < tzLib.startOfDay(now, tz).getTime()) {
      throw badRequest('A promise to pay cannot be dated in the past.');
    }
    promiseDoc = { amountMinor, promisedDate };
  }

  // 1. Validate the next action before writing anything.
  const validatedNext = await requireNextAction({ booking, next, tz, now });

  // 2. Write the next action first.
  let nextFollowUp = null;
  if (validatedNext) {
    nextFollowUp = await CollectionFollowUp.create({
      tenantId,
      bookingId: booking._id,
      installmentId: followup.installmentId,
      contactId: booking.contactId,
      assignedUserId: validatedNext.assignedUserId || followup.assignedUserId,
      actionType: validatedNext.actionType,
      dueAt: validatedNext.dueAt,
      note: validatedNext.note,
      createdBy: actor?._id,
    });
  }

  // 3. The promise, if one was made.
  let promiseRecord = null;
  if (promiseDoc) {
    promiseRecord = await CollectionPromise.create({
      tenantId,
      bookingId: booking._id,
      installmentId: followup.installmentId,
      promisedAmountMinor: promiseDoc.amountMinor,
      promisedDate: promiseDoc.promisedDate,
      createdFromFollowUpId: followup._id,
      assignedUserId: followup.assignedUserId,
      // §160 measures fulfilment against what had been received when the
      // promise was made, so an earlier payment cannot fulfil a later promise.
      baselineReceivedMinor: booking.totalReceivedMinor,
      note,
      createdBy: actor?._id,
    });
    emit(EVENTS.COLLECTION_PROMISE_CREATED, {
      tenantId, bookingId: booking._id, promiseId: promiseRecord._id,
    });
  }

  // 4. Close the current piece of work.
  await CollectionFollowUp.updateOne({ tenantId, _id: followup._id }, {
    $set: {
      status: 'COMPLETED',
      outcome,
      completionNote: note,
      completedAt: now,
      completedBy: actor?._id,
      completedOnTime: now <= new Date(followup.dueAt),
      promiseId: promiseRecord?._id,
      nextFollowUpId: nextFollowUp?._id,
    },
  });

  // 5. Timeline: what happened, then what is next.
  await timeline.log({
    tenantId,
    bookingId: booking._id,
    type: 'COLLECTION_FOLLOWUP_COMPLETED',
    title: `${ACTION_LABELS[followup.actionType]} — ${outcome.replace(/_/g, ' ').toLowerCase()}`,
    body: note,
    actor,
    at: now,
    meta: { followUpId: String(followup._id), outcome },
  });
  if (promiseRecord) {
    await timeline.log({
      tenantId,
      bookingId: booking._id,
      type: 'PROMISE_CREATED',
      title: 'Promise to pay recorded',
      actor,
      at: now,
      meta: {
        promiseId: String(promiseRecord._id),
        promisedAmountMinor: promiseRecord.promisedAmountMinor,
        promisedDate: promiseRecord.promisedDate,
      },
    });
  }
  if (nextFollowUp) {
    await timeline.log({
      tenantId,
      bookingId: booking._id,
      type: 'COLLECTION_FOLLOWUP_CREATED',
      title: `Next action: ${ACTION_LABELS[nextFollowUp.actionType]}`,
      actor,
      at: now,
      meta: { followUpId: String(nextFollowUp._id), dueAt: nextFollowUp.dueAt },
    });
  }
  await audit.record({
    tenantId, actor, entity: 'CollectionFollowUp', entityId: followup._id, action: 'COMPLETE',
    after: { outcome, promiseId: promiseRecord?._id, nextFollowUpId: nextFollowUp?._id },
  });

  return { followup, nextFollowUp, promise: promiseRecord };
}

/** §154: move collection work without closing it. */
async function reschedule({ tenantId, actor, followUpId, dueAt, note, tz = 'UTC' }) {
  const followup = await CollectionFollowUp.findOne({ tenantId, _id: followUpId });
  if (!followup) throw notFound('Collection follow-up not found.');
  if (!['PENDING', 'MISSED'].includes(followup.status)) throw badRequest('This follow-up is already closed.');
  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime())) throw badRequest('Choose a new date and time.');
  if (due.getTime() <= Date.now() - 60000) throw badRequest('Reschedule to a time in the future.');

  const previous = followup.dueAt;
  followup.dueAt = due;
  followup.status = 'PENDING';
  if (note) followup.note = note;
  await followup.save();

  await timeline.log({
    tenantId, bookingId: followup.bookingId, type: 'COLLECTION_FOLLOWUP_CREATED',
    title: 'Collection follow-up rescheduled', body: note, actor,
    meta: { followUpId: String(followup._id), from: previous, to: due },
  });
  return followup;
}

/**
 * §188 `collection.followups_missed`. Same discipline as sales: a pending
 * follow-up whose time has passed is Missed, stored so reporting is
 * deterministic. Idempotent.
 */
async function markMissed({ tenantId = null, now = new Date(), limit = 500 } = {}) {
  const filter = { status: 'PENDING', dueAt: { $lt: now } };
  if (tenantId) filter.tenantId = tenantId;
  const due = await CollectionFollowUp.find(filter).setOptions({ allowCrossTenant: !tenantId })
    .limit(limit).lean();

  let missed = 0;
  for (const followup of due) {
    const booking = await Booking.findOne({ tenantId: followup.tenantId, _id: followup.bookingId })
      .select('status outstandingMinor').lean();
    if (!booking || booking.status === 'CANCELLED') continue;
    await CollectionFollowUp.updateOne(
      { tenantId: followup.tenantId, _id: followup._id }, { $set: { status: 'MISSED' } },
    );
    await timeline.log({
      tenantId: followup.tenantId, bookingId: followup.bookingId,
      type: 'COLLECTION_FOLLOWUP_MISSED', title: 'Collection follow-up missed', actorType: 'SYSTEM',
      meta: { followUpId: String(followup._id), dueAt: followup.dueAt },
    });
    await notifications.notify({
      tenantId: followup.tenantId,
      userId: followup.assignedUserId,
      domain: 'COLLECTION',
      type: 'COLLECTION_FOLLOWUP_MISSED',
      title: 'Collection follow-up missed',
      body: 'The scheduled collection contact was not completed.',
      link: `/app/bookings/${followup.bookingId}`,
      bookingId: followup.bookingId,
      severity: 'WARNING',
    });
    missed += 1;
  }
  return { scanned: due.length, missed };
}

/**
 * §160 `collection.promise_missed`. At the end of the promised day, a promise
 * that did not bring the money in is Missed — the single most useful collection
 * exception a manager has.
 */
async function promiseSweep({ tenantId = null, now = new Date(), limit = 500 } = {}) {
  const filter = { status: 'OPEN' };
  if (tenantId) filter.tenantId = tenantId;
  const open = await CollectionPromise.find(filter).setOptions({ allowCrossTenant: !tenantId })
    .limit(limit).lean();

  let missed = 0;
  let fulfilled = 0;
  for (const promise of open) {
    const booking = await Booking.findOne({ tenantId: promise.tenantId, _id: promise.bookingId })
      .select('totalReceivedMinor status').lean();
    if (!booking) continue;
    const receivedSince = Math.max(0, booking.totalReceivedMinor - promise.baselineReceivedMinor);

    if (receivedSince >= promise.promisedAmountMinor) {
      await CollectionPromise.updateOne({ tenantId: promise.tenantId, _id: promise._id }, {
        $set: { status: 'FULFILLED', fulfilledAmountMinor: receivedSince, fulfilledAt: now },
      });
      await timeline.log({
        tenantId: promise.tenantId, bookingId: promise.bookingId, type: 'PROMISE_FULFILLED',
        title: 'Promise to pay kept', actorType: 'SYSTEM',
        meta: { promiseId: String(promise._id), receivedSince },
      });
      fulfilled += 1;
      continue;
    }

    // Still inside the promised day: nothing to decide yet.
    if (new Date(promise.promisedDate).getTime() > now.getTime()) continue;

    await CollectionPromise.updateOne({ tenantId: promise.tenantId, _id: promise._id }, {
      $set: {
        status: receivedSince > 0 ? 'PARTIAL' : 'MISSED',
        fulfilledAmountMinor: receivedSince,
        missedAt: now,
      },
    });
    await timeline.log({
      tenantId: promise.tenantId, bookingId: promise.bookingId, type: 'PROMISE_MISSED',
      title: receivedSince > 0 ? 'Promise to pay only partly kept' : 'Promise to pay missed',
      actorType: 'SYSTEM',
      meta: {
        promiseId: String(promise._id),
        promisedAmountMinor: promise.promisedAmountMinor,
        receivedSince,
      },
    });
    emit(EVENTS.COLLECTION_PROMISE_MISSED, {
      tenantId: promise.tenantId, bookingId: promise.bookingId, promiseId: promise._id,
    });
    if (promise.assignedUserId) {
      await notifications.notify({
        tenantId: promise.tenantId,
        userId: promise.assignedUserId,
        domain: 'COLLECTION',
        type: 'COLLECTION_PROMISE_MISSED',
        title: 'Promise to pay missed',
        body: 'The customer did not pay what they promised by the promised date.',
        link: `/app/bookings/${promise.bookingId}`,
        bookingId: promise.bookingId,
        severity: 'WARNING',
      });
    }
    missed += 1;
  }
  return { scanned: open.length, missed, fulfilled };
}

module.exports = {
  create, complete, reschedule, markMissed, promiseSweep, requireNextAction, resolveNextDueAt,
  ACTION_LABELS,
};
