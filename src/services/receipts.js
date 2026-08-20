const {
  Booking, BookingInstallment, BookingReceipt, ReceiptAllocation, PaymentRequest,
  Contact, Project, Unit, Tenant,
} = require('../db/models');
const { badRequest, notFound } = require('../lib/errors');
const { EVENTS, emit } = require('../lib/events');
const money = require('../lib/money');
const privateFiles = require('../lib/privateFiles');
const installmentsService = require('./installments');
const collections = require('./collections');
const timeline = require('./timeline');
const messaging = require('./messaging');
const notifications = require('./notifications');
const audit = require('./audit');

/**
 * V2 §143–§146: money received.
 *
 * Two invariants hold this file together:
 *
 *   1. §145 — allocations must sum to the receipt exactly. There is no
 *      unallocated advance and no customer credit ledger in this version, so a
 *      payment that does not map onto installments is refused rather than
 *      parked somewhere it would be forgotten.
 *   2. §146/§324.5 — a receipt is reversed, never deleted. Every "how much has
 *      been received" figure is recomputed by summing live allocations, so a
 *      reversal cannot leave a stale total behind anywhere.
 */

/** §144: RCP-<year>-<sequence>, per tenant. The id stays authoritative. */
async function nextReceiptNo({ tenantId }) {
  const year = new Date().getFullYear();
  const prefix = `RCP-${year}-`;
  const latest = await BookingReceipt.findOne({ tenantId, receiptNo: new RegExp(`^${prefix}`) })
    .sort({ receiptNo: -1 }).select('receiptNo').lean();
  const next = latest ? Number(String(latest.receiptNo).slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(next).padStart(5, '0')}`;
}

/**
 * Recomputes an installment's received/outstanding from its LIVE allocations —
 * the single source of truth for "how much has this installment been paid".
 */
async function recalcInstallments({ tenantId, bookingId, installmentIds = null, tz = 'UTC' }) {
  const filter = { tenantId, bookingId };
  if (installmentIds?.length) filter._id = { $in: installmentIds };
  const rows = await BookingInstallment.find(filter).lean();

  for (const row of rows) {
    const allocations = await ReceiptAllocation.find({
      tenantId, installmentId: row._id, active: true,
    }).select('amountMinor').lean();
    const received = allocations.reduce((sum, a) => sum + a.amountMinor, 0);
    await BookingInstallment.updateOne({ tenantId, _id: row._id }, {
      $set: {
        amountReceivedMinor: received,
        outstandingMinor: Math.max(0, row.scheduledAmountMinor - received),
      },
    });
  }
  await installmentsService.refreshStatuses({ tenantId, bookingId, tz });
  return rows.length;
}

/**
 * §145: spread an amount across the unpaid installments, oldest due first.
 * Used when a receipt arrives without explicit allocations — a bank transfer
 * against the booking rather than against a named milestone.
 */
function autoAllocate({ installments, amountMinor, tz = 'UTC' }) {
  const payable = installments
    .filter((i) => i.status !== 'CANCELLED' && i.outstandingMinor > 0)
    .sort((a, b) => {
      const da = installmentsService.dueDateOf(a);
      const db = installmentsService.dueDateOf(b);
      // A dated installment is always collected before a TBD one.
      if (da && db) return da - db;
      if (da) return -1;
      if (db) return 1;
      return a.sequence - b.sequence;
    });

  const allocations = [];
  let left = amountMinor;
  for (const installment of payable) {
    if (left <= 0) break;
    const take = Math.min(left, installment.outstandingMinor);
    allocations.push({ installmentId: installment._id, amountMinor: take });
    left -= take;
  }
  return { allocations, unallocatedMinor: left };
}

/**
 * §143/§144: record a payment. Same path for a collections user entering a
 * bank transfer and for a gateway callback — only `createdByType` differs.
 */
async function record({
  tenantId, tenant, actor, bookingId, amountMinor, paymentDate, mode = 'BANK_TRANSFER',
  reference, bank, note, allocations = null, proofFile = null,
  gatewayPaymentId, paymentRequestId, createdByType = 'INTERNAL_USER', tz = null,
}) {
  const booking = await Booking.findOne({ tenantId, _id: bookingId }).lean();
  if (!booking) throw notFound('Booking not found.');
  if (booking.status === 'CANCELLED') throw badRequest('This booking is cancelled.');
  if (!booking.postBookingInitAt) throw badRequest('This booking has no payment schedule yet.');

  const settings = tenant?.settings || (await Tenant.findById(tenantId).lean())?.settings || {};
  const zone = tz || tenant?.timezone || 'UTC';

  if (!BookingReceipt.MODES.includes(mode)) throw badRequest('Choose a valid payment mode.');
  // §143: a tenant may forbid cash outright.
  if (mode === 'CASH' && settings.collectionAllowCash === false) {
    throw badRequest('Cash receipts are switched off for this organization.');
  }
  const amount = Number(amountMinor);
  if (!Number.isInteger(amount) || amount <= 0) throw badRequest('Enter the amount received.');
  const when = paymentDate ? new Date(paymentDate) : new Date();
  if (Number.isNaN(when.getTime())) throw badRequest('Enter a valid payment date.');
  if (when.getTime() > Date.now() + 86400000) throw badRequest('A payment cannot be dated in the future.');

  const installments = await installmentsService.forBooking({ tenantId, bookingId });
  if (!installments.length) throw badRequest('This booking has no installments to allocate against.');

  // §145: full allocation, or the receipt is refused.
  let resolved = allocations;
  if (!resolved?.length) {
    const auto = autoAllocate({ installments, amountMinor: amount, tz: zone });
    if (auto.unallocatedMinor > 0) {
      throw badRequest(`This payment is ${money.format(auto.unallocatedMinor, { currency: tenant?.currency, locale: tenant?.locale })} more than the outstanding amount on this booking. Reduce it, or record the excess against a future installment once it exists.`);
    }
    resolved = auto.allocations;
  }

  const byId = new Map(installments.map((i) => [String(i._id), i]));
  let allocated = 0;
  for (const line of resolved) {
    const installment = byId.get(String(line.installmentId));
    if (!installment) throw badRequest('An allocation points at an installment on another booking.');
    const lineAmount = Number(line.amountMinor);
    if (!Number.isInteger(lineAmount) || lineAmount <= 0) throw badRequest('Every allocation needs a positive amount.');
    if (lineAmount > installment.outstandingMinor) {
      throw badRequest(`${installment.milestone} only has ${money.format(installment.outstandingMinor, { currency: tenant?.currency, locale: tenant?.locale })} outstanding.`);
    }
    allocated += lineAmount;
  }
  if (allocated !== amount) {
    throw badRequest('The allocated amounts must add up to the amount received.');
  }

  let proof;
  if (proofFile?.buffer?.length) {
    privateFiles.assertAcceptable({ mimeType: proofFile.mimetype, size: proofFile.size });
    const stored = await privateFiles.store({
      tenantId, scope: 'receipts', mimeType: proofFile.mimetype, buffer: proofFile.buffer,
    });
    proof = {
      storageKey: stored.storageKey,
      fileLabel: `Payment proof ${reference || ''}`.trim(),
      mimeType: proofFile.mimetype,
      bytes: stored.bytes,
    };
  }

  const receipt = await BookingReceipt.create({
    tenantId,
    bookingId,
    receiptNo: await nextReceiptNo({ tenantId }),
    paymentDate: when,
    amountMinor: amount,
    mode,
    reference,
    bank,
    note,
    proof,
    gatewayPaymentId,
    paymentRequestId,
    status: 'CONFIRMED',
    createdByType,
    createdBy: actor?._id,
  });

  await ReceiptAllocation.insertMany(resolved.map((line) => ({
    tenantId,
    receiptId: receipt._id,
    bookingId,
    installmentId: line.installmentId,
    amountMinor: Number(line.amountMinor),
    active: true,
  })));

  await recalcInstallments({
    tenantId, bookingId, installmentIds: resolved.map((l) => l.installmentId), tz: zone,
  });
  const refreshed = await collections.recalcBooking({ tenantId, bookingId, tz: zone });

  await timeline.log({
    tenantId,
    bookingId,
    type: 'PAYMENT_RECEIVED',
    title: `${money.format(amount, { currency: tenant?.currency, locale: tenant?.locale })} received — ${mode.replace(/_/g, ' ').toLowerCase()}`,
    body: [receipt.receiptNo, reference].filter(Boolean).join(' · '),
    actor,
    actorType: createdByType === 'GATEWAY' ? 'INTEGRATION' : 'USER',
    at: when,
    meta: {
      receiptId: String(receipt._id),
      amountMinor: amount,
      mode,
      allocations: resolved.length,
      outstandingAfterMinor: refreshed.outstandingMinor,
    },
  });
  // Installments that just closed deserve their own line on the timeline.
  for (const line of resolved) {
    const installment = await BookingInstallment.findOne({ tenantId, _id: line.installmentId }).lean();
    if (installment?.status === 'PAID') {
      await timeline.log({
        tenantId, bookingId, type: 'INSTALLMENT_PAID',
        title: `${installment.milestone} paid in full`,
        actorType: 'SYSTEM',
        meta: { installmentId: String(installment._id) },
      });
    }
  }

  await audit.record({
    tenantId, actor, entity: 'BookingReceipt', entityId: receipt._id, action: 'CREATE',
    after: { receiptNo: receipt.receiptNo, amountMinor: amount, mode, bookingId: String(bookingId) },
  });
  emit(EVENTS.COLLECTION_PAYMENT_RECEIVED, {
    tenantId, bookingId, receiptId: receipt._id, amountMinor: amount,
  });

  if (booking.collectionOwnerUserId && createdByType === 'GATEWAY') {
    await notifications.notify({
      tenantId,
      userId: booking.collectionOwnerUserId,
      domain: 'COLLECTION',
      type: 'PAYMENT_RECEIVED',
      title: 'Payment received',
      body: `${money.format(amount, { currency: tenant?.currency, locale: tenant?.locale })} against ${booking.bookingNumber || 'a booking'}.`,
      link: `/app/bookings/${bookingId}?tab=collections`,
      bookingId,
    });
  }

  // §297: the acknowledgement. Deliberately not called a tax receipt.
  if (settings.receiptAcknowledgementEnabled !== false) {
    await acknowledge({ tenantId, tenant, receipt, booking: refreshed, actor });
  }
  return BookingReceipt.findOne({ tenantId, _id: receipt._id }).lean();
}

/** §297: "Payment Acknowledgement" — amount, date, booking, remaining outstanding. */
async function acknowledge({ tenantId, tenant, receipt, booking, actor }) {
  const [contact, project, unit] = await Promise.all([
    Contact.findOne({ tenantId, _id: booking.contactId }).lean(),
    Project.findOne({ tenantId, _id: booking.projectId }).select('name').lean(),
    Unit.findOne({ tenantId, _id: booking.unitId }).select('unitNumber').lean(),
  ]);
  if (!contact) return null;
  const fmt = (minor) => money.format(minor, { currency: tenant?.currency, locale: tenant?.locale });

  const result = await messaging.send({
    tenantId,
    channel: 'WHATSAPP',
    contact,
    purpose: 'ACKNOWLEDGEMENT',
    body: 'Payment Acknowledgement — we have received {{payment.amount}} on {{payment.date}} for {{project.name}} {{unit.number}}. Remaining outstanding: {{payment.outstanding}}. This is not a tax receipt.',
    vars: {
      contact: { first_name: contact.firstName || contact.displayName },
      project: { name: project?.name },
      unit: { number: unit?.unitNumber },
      booking: { number: booking.bookingNumber },
      payment: {
        amount: fmt(receipt.amountMinor),
        date: receipt.paymentDate.toISOString().slice(0, 10),
        outstanding: fmt(booking.outstandingMinor),
      },
    },
    sentBy: actor?._id,
  });
  await BookingReceipt.updateOne({ tenantId, _id: receipt._id }, { $set: { acknowledgedAt: new Date() } });
  return result;
}

/**
 * §146: reversal. The receipt stays, its allocations go dead, and every derived
 * figure is recomputed — including, in Phase 3, channel-partner commission
 * eligibility, which is why the recalculation happens here rather than in the
 * route that asked for it.
 */
async function reverse({ tenantId, tenant, actor, receiptId, reason, tz = null }) {
  const receipt = await BookingReceipt.findOne({ tenantId, _id: receiptId }).lean();
  if (!receipt) throw notFound('Receipt not found.');
  if (receipt.status === 'REVERSED') throw badRequest('That receipt has already been reversed.');
  if (!String(reason || '').trim()) throw badRequest('Give a reason for the reversal.');

  const zone = tz || tenant?.timezone || 'UTC';
  const allocations = await ReceiptAllocation.find({ tenantId, receiptId: receipt._id, active: true }).lean();

  await BookingReceipt.updateOne({ tenantId, _id: receipt._id }, {
    $set: {
      status: 'REVERSED',
      reversedAt: new Date(),
      reversedBy: actor?._id,
      reversalReason: reason,
    },
  });
  await ReceiptAllocation.updateMany({ tenantId, receiptId: receipt._id }, { $set: { active: false } });

  await recalcInstallments({
    tenantId,
    bookingId: receipt.bookingId,
    installmentIds: allocations.map((a) => a.installmentId),
    tz: zone,
  });
  const refreshed = await collections.recalcBooking({ tenantId, bookingId: receipt.bookingId, tz: zone });

  // A reversal invalidates the payment link that produced it, if there was one.
  if (receipt.paymentRequestId) {
    await PaymentRequest.updateOne({ tenantId, _id: receipt.paymentRequestId }, {
      $set: { status: 'FAILED', failureReason: `Receipt ${receipt.receiptNo} reversed` },
    });
  }

  await timeline.log({
    tenantId,
    bookingId: receipt.bookingId,
    type: 'RECEIPT_REVERSED',
    title: `Receipt ${receipt.receiptNo} reversed — ${money.format(receipt.amountMinor, { currency: tenant?.currency, locale: tenant?.locale })}`,
    body: reason,
    actor,
    meta: { receiptId: String(receipt._id), outstandingAfterMinor: refreshed.outstandingMinor },
  });
  await audit.record({
    tenantId, actor, entity: 'BookingReceipt', entityId: receipt._id, action: 'REVERSE',
    before: { status: receipt.status, amountMinor: receipt.amountMinor },
    after: { status: 'REVERSED', reason },
  });
  emit(EVENTS.COLLECTION_RECEIPT_REVERSED, {
    tenantId, bookingId: receipt.bookingId, receiptId: receipt._id, amountMinor: receipt.amountMinor,
  });
  return BookingReceipt.findOne({ tenantId, _id: receipt._id }).lean();
}

/** Receipts with their allocations, for the workspace and the reports. */
async function forBooking({ tenantId, bookingId }) {
  const receipts = await BookingReceipt.find({ tenantId, bookingId })
    .sort({ paymentDate: -1, createdAt: -1 })
    .populate('createdBy', 'name')
    .lean();
  if (!receipts.length) return [];
  const allocations = await ReceiptAllocation.find({
    tenantId, receiptId: { $in: receipts.map((r) => r._id) },
  }).populate('installmentId', 'sequence milestone').lean();
  return receipts.map((receipt) => ({
    ...receipt,
    allocations: allocations.filter((a) => String(a.receiptId) === String(receipt._id)),
  }));
}

module.exports = {
  record, reverse, acknowledge, forBooking, recalcInstallments, autoAllocate, nextReceiptNo,
};
