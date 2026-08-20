const {
  ChannelPartner, PartnerInvoice, PartnerCommissionEntitlement, PartnerPayout, Booking, Contact,
} = require('../db/models');
const { badRequest, notFound } = require('../lib/errors');
const { EVENTS, emit } = require('../lib/events');
const money = require('../lib/money');
const privateFiles = require('../lib/privateFiles');
const commissions = require('./commissions');
const channelPartners = require('./channelPartners');
const timeline = require('./timeline');
const notifications = require('./notifications');
const audit = require('./audit');

/**
 * V2 §44–§50, §313–§315: the partner's invoice against eligible commission.
 *
 * The rule that everything else defends (§48/§324.10): the total claimed against
 * an entitlement can never exceed its eligible-but-uninvoiced amount. Checked on
 * submit and again on approval, because the eligible figure can move between the
 * two when a receipt is reversed.
 *
 * §50/§344.14: payouts are tracked operationally — date, amount, reference — and
 * this is deliberately not an accounting ledger.
 */

/** §48: the ceiling for one entitlement, excluding this invoice's own claim. */
async function claimCeiling({ tenantId, entitlement, excludeInvoiceId = null }) {
  const invoices = await PartnerInvoice.find({
    tenantId,
    'lines.commissionEntitlementId': entitlement._id,
    status: { $nin: ['DRAFT', 'REJECTED', 'CANCELLED'] },
    ...(excludeInvoiceId ? { _id: { $ne: excludeInvoiceId } } : {}),
  }).select('lines').lean();

  const claimedElsewhere = invoices.reduce((sum, invoice) => sum + invoice.lines
    .filter((line) => String(line.commissionEntitlementId) === String(entitlement._id))
    .reduce((lineSum, line) => lineSum + line.invoiceClaimAmountMinor, 0), 0);

  return Math.max(0, (entitlement.eligibleAmountMinor || 0) - claimedElsewhere);
}

/**
 * §45/§314: create or replace the invoice draft. One invoice may carry lines
 * from several bookings, as long as they all belong to this partner and none is
 * over-claimed.
 */
async function saveDraft({
  tenantId, tenant, channelPartnerId, invoiceId = null, data = {}, lines = [],
  actor = null, portalUser = null,
}) {
  const partner = await ChannelPartner.findOne({ tenantId, _id: channelPartnerId }).lean();
  if (!partner) throw notFound('Channel partner not found.');

  let invoice = null;
  if (invoiceId) {
    invoice = await PartnerInvoice.findOne({ tenantId, _id: invoiceId, channelPartnerId }).lean();
    if (!invoice) throw notFound('Invoice not found.');
    if (!['DRAFT', 'CORRECTION_REQUIRED'].includes(invoice.status)) {
      throw badRequest('This invoice can no longer be edited. Ask for a correction first.');
    }
  }

  if (!lines.length) throw badRequest('Add at least one eligible commission line.');

  const resolved = [];
  for (const line of lines) {
    const entitlement = await PartnerCommissionEntitlement.findOne({
      tenantId, _id: line.commissionEntitlementId, channelPartnerId,
    }).lean();
    // §314: every line must belong to this partner.
    if (!entitlement) throw badRequest('One of those commission lines does not belong to this partner.');
    if (!['ELIGIBLE', 'PARTIALLY_INVOICED', 'PARTIALLY_PAID'].includes(entitlement.status)) {
      throw badRequest('No eligible commission is available for one of the selected bookings.');
    }
    const amount = Number(line.invoiceClaimAmountMinor);
    if (!Number.isInteger(amount) || amount <= 0) throw badRequest('Enter a claim amount for every line.');

    const ceiling = await claimCeiling({ tenantId, entitlement, excludeInvoiceId: invoiceId });
    if (amount > ceiling) {
      throw badRequest(`The claim for this booking exceeds the eligible uninvoiced commission of ${money.format(ceiling, { currency: tenant?.currency, locale: tenant?.locale })}.`);
    }
    resolved.push({
      bookingId: entitlement.bookingId,
      commissionEntitlementId: entitlement._id,
      eligibleCommissionMinor: entitlement.eligibleAmountMinor,
      invoiceClaimAmountMinor: amount,
      note: line.note,
    });
  }

  const taxableValueMinor = resolved.reduce((sum, line) => sum + line.invoiceClaimAmountMinor, 0);
  /**
   * Callers pass minor units, already parsed by the route's field validators.
   * Converting again here is how ₹5,000 of GST became ₹5,00,000 — so this takes
   * minor units and says so in the name.
   */
  const gstAmountMinor = Math.max(0, Number(data.gstAmountMinor || 0));
  const otherAdjustmentMinor = Number(data.otherAdjustmentMinor || 0);

  const payload = {
    invoiceNumber: data.invoiceNumber,
    invoiceDate: data.invoiceDate ? new Date(data.invoiceDate) : undefined,
    billingEntityName: data.billingEntityName || partner.profile.legalName || partner.profile.tradeName,
    gstin: data.gstin || partner.profile.gstin,
    pan: data.pan || partner.profile.pan,
    lines: resolved,
    taxableValueMinor,
    gstAmountMinor,
    otherAdjustmentMinor,
    // §272: values as supplied and reviewed. Nothing here computes tax.
    invoiceTotalMinor: taxableValueMinor + gstAmountMinor + otherAdjustmentMinor,
    taxMode: data.taxMode || partner.profile.defaultInvoiceTaxMode,
    note: data.note,
    // §46/§21: whose account this was to be paid into, as it stood.
    bankSnapshot: {
      accountHolderName: partner.profile.bank?.accountHolderName,
      bankName: partner.profile.bank?.bankName,
      accountNumberMasked: partner.profile.bank?.accountNumberMasked,
      ifsc: partner.profile.bank?.ifsc,
      branch: partner.profile.bank?.branch,
    },
  };

  if (invoice) {
    await PartnerInvoice.updateOne({ tenantId, _id: invoice._id }, { $set: payload });
    return PartnerInvoice.findOne({ tenantId, _id: invoice._id }).lean();
  }
  return PartnerInvoice.create({
    tenantId,
    channelPartnerId,
    invoiceRef: await channelPartners.nextNumber({
      tenantId, model: PartnerInvoice, field: 'invoiceRef', prefix: 'CPI',
    }),
    status: 'DRAFT',
    createdByType: portalUser ? 'PARTNER' : 'INTERNAL_USER',
    createdByUserId: actor?._id,
    createdByPortalUserId: portalUser?._id,
    ...payload,
  });
}

/** §194: the invoice PDF, stored privately (§298). */
async function attachPdf({ tenantId, invoiceId, channelPartnerId, file, actor = null }) {
  const invoice = await PartnerInvoice.findOne({ tenantId, _id: invoiceId, channelPartnerId }).lean();
  if (!invoice) throw notFound('Invoice not found.');
  if (!['DRAFT', 'CORRECTION_REQUIRED'].includes(invoice.status)) {
    throw badRequest('This invoice can no longer be edited.');
  }
  if (!file?.buffer?.length) throw badRequest('Choose the invoice PDF.');
  privateFiles.assertAcceptable({ mimeType: file.mimetype, size: file.size });

  const stored = await privateFiles.store({
    tenantId, scope: 'cp-invoice', mimeType: file.mimetype, buffer: file.buffer,
  });
  await PartnerInvoice.updateOne({ tenantId, _id: invoiceId }, {
    $set: {
      invoicePdf: {
        storageKey: stored.storageKey,
        fileLabel: `Invoice ${invoice.invoiceNumber || invoice.invoiceRef}`,
        mimeType: file.mimetype,
        bytes: stored.bytes,
      },
    },
  });
  return PartnerInvoice.findOne({ tenantId, _id: invoiceId }).lean();
}

/** §45: submit for internal review. */
async function submit({ tenantId, tenant, invoiceId, channelPartnerId, actor = null, portalUser = null }) {
  const invoice = await PartnerInvoice.findOne({ tenantId, _id: invoiceId, channelPartnerId }).lean();
  if (!invoice) throw notFound('Invoice not found.');
  if (!['DRAFT', 'CORRECTION_REQUIRED'].includes(invoice.status)) {
    throw badRequest('This invoice has already been submitted.');
  }
  if (!invoice.lines?.length) throw badRequest('Add at least one commission line.');
  if (!invoice.invoiceNumber) throw badRequest('Enter your invoice number.');
  if (!invoice.invoiceDate) throw badRequest('Enter the invoice date.');

  // §48: re-check the ceiling at submission — eligibility can move.
  for (const line of invoice.lines) {
    const entitlement = await PartnerCommissionEntitlement.findOne({
      tenantId, _id: line.commissionEntitlementId,
    }).lean();
    const ceiling = await claimCeiling({ tenantId, entitlement, excludeInvoiceId: invoice._id });
    if (line.invoiceClaimAmountMinor > ceiling) {
      throw badRequest('The eligible commission has changed since this invoice was drafted. Review the lines and try again.');
    }
  }

  // §315: keep what was submitted before, so a correction cycle is auditable.
  const version = invoice.status === 'CORRECTION_REQUIRED' ? [{
    submittedAt: invoice.submittedAt,
    invoiceNumber: invoice.invoiceNumber,
    invoiceTotalMinor: invoice.invoiceTotalMinor,
    storageKey: invoice.invoicePdf?.storageKey,
    correctionNote: invoice.reviewNote,
  }] : [];

  await PartnerInvoice.updateOne({ tenantId, _id: invoiceId }, {
    $set: { status: 'SUBMITTED', submittedAt: new Date() },
    ...(version.length ? { $push: { previousVersions: { $each: version } } } : {}),
  });
  await applyInvoicedAmounts({ tenantId, invoiceId });

  const partner = await ChannelPartner.findOne({ tenantId, _id: channelPartnerId }).lean();
  await timeline.log({
    tenantId,
    channelPartnerId,
    type: 'CP_INVOICE_SUBMITTED',
    title: `Invoice ${invoice.invoiceNumber} submitted — ${money.format(invoice.invoiceTotalMinor, { currency: tenant?.currency, locale: tenant?.locale })}`,
    actor,
    actorType: portalUser ? 'INTEGRATION' : 'USER',
    actorLabel: portalUser?.name,
    meta: { invoiceId: String(invoiceId), lines: invoice.lines.length },
  });
  emit(EVENTS.CP_INVOICE_SUBMITTED, { tenantId, invoiceId, channelPartnerId });
  await notifications.notifyMany({
    tenantId,
    userIds: await notifications.adminUserIds(tenantId),
    domain: 'CHANNEL_PARTNER',
    type: 'CP_INVOICE_SUBMITTED',
    title: 'Partner invoice submitted',
    body: `${channelPartners.displayNameOf(partner?.profile || {})} · ${money.format(invoice.invoiceTotalMinor, { currency: tenant?.currency, locale: tenant?.locale })}`,
    link: `/app/channel-partners/invoices/${invoiceId}`,
  });
  return PartnerInvoice.findOne({ tenantId, _id: invoiceId }).lean();
}

/**
 * Recomputes `invoicedAmountMinor` on every entitlement this invoice touches,
 * by summing live invoice lines — so a rejection or cancellation releases the
 * amount without a second bookkeeping path.
 */
async function applyInvoicedAmounts({ tenantId, invoiceId }) {
  const invoice = await PartnerInvoice.findOne({ tenantId, _id: invoiceId }).lean();
  if (!invoice) return;
  for (const line of invoice.lines) {
    const invoices = await PartnerInvoice.find({
      tenantId,
      'lines.commissionEntitlementId': line.commissionEntitlementId,
      status: { $nin: ['DRAFT', 'REJECTED', 'CANCELLED'] },
    }).select('lines status paidAmountMinor').lean();

    const invoiced = invoices.reduce((sum, inv) => sum + inv.lines
      .filter((l) => String(l.commissionEntitlementId) === String(line.commissionEntitlementId))
      .reduce((lineSum, l) => lineSum + l.invoiceClaimAmountMinor, 0), 0);

    await PartnerCommissionEntitlement.updateOne(
      { tenantId, _id: line.commissionEntitlementId },
      { $set: { invoicedAmountMinor: invoiced } },
    );
    await commissions.refreshStatus({ tenantId, entitlementId: line.commissionEntitlementId });
  }
}

/** §49: the internal decision. */
async function review({ tenantId, tenant, actor, invoiceId, decision, note }) {
  const allowed = ['UNDER_REVIEW', 'APPROVED', 'REJECTED', 'CORRECTION_REQUIRED'];
  if (!allowed.includes(decision)) throw badRequest('Choose a review decision.');
  const invoice = await PartnerInvoice.findOne({ tenantId, _id: invoiceId }).lean();
  if (!invoice) throw notFound('Invoice not found.');
  if (!['SUBMITTED', 'UNDER_REVIEW'].includes(invoice.status)) {
    throw badRequest('This invoice is not awaiting review.');
  }
  if (decision !== 'APPROVED' && decision !== 'UNDER_REVIEW' && !String(note || '').trim()) {
    throw badRequest('Tell the partner what needs to change.');
  }

  if (decision === 'APPROVED') {
    // §48 again: the last check before money is committed.
    for (const line of invoice.lines) {
      const entitlement = await PartnerCommissionEntitlement.findOne({
        tenantId, _id: line.commissionEntitlementId,
      }).lean();
      if (entitlement.status === 'REVIEW_REQUIRED') {
        throw badRequest('One of these commission lines is flagged for review. Resolve it before approving.');
      }
      const ceiling = await claimCeiling({ tenantId, entitlement, excludeInvoiceId: invoice._id });
      if (line.invoiceClaimAmountMinor > ceiling) {
        throw badRequest('The eligible commission has fallen below what this invoice claims. Ask the partner for a correction.');
      }
    }
  }

  await PartnerInvoice.updateOne({ tenantId, _id: invoiceId }, {
    $set: {
      status: decision,
      reviewedAt: new Date(),
      reviewedBy: actor?._id,
      reviewNote: note,
      ...(decision === 'APPROVED' ? { approvedAt: new Date(), approvedBy: actor?._id } : {}),
      ...(decision === 'REJECTED' ? { rejectionReason: note } : {}),
    },
  });
  await applyInvoicedAmounts({ tenantId, invoiceId });

  await timeline.log({
    tenantId,
    channelPartnerId: invoice.channelPartnerId,
    type: decision === 'APPROVED' ? 'CP_INVOICE_APPROVED' : 'CP_INVOICE_REVIEWED',
    title: `Invoice ${invoice.invoiceNumber || invoice.invoiceRef} ${decision.replace(/_/g, ' ').toLowerCase()}`,
    body: note,
    actor,
    meta: { invoiceId: String(invoiceId), decision },
  });
  // §196: invoice review is audited.
  await audit.record({
    tenantId, actor, entity: 'PartnerInvoice', entityId: invoiceId, action: 'REVIEW',
    before: { status: invoice.status }, after: { status: decision, note },
  });
  if (decision === 'APPROVED') emit(EVENTS.CP_INVOICE_APPROVED, { tenantId, invoiceId });
  return PartnerInvoice.findOne({ tenantId, _id: invoiceId }).lean();
}

/** §50: record that money left, with its reference. Not an accounting entry. */
async function recordPayout({
  tenantId, tenant, actor, invoiceId, amountMinor, payoutDate, transactionReference,
  deductionMinor = 0, deductionNote, note,
}) {
  const invoice = await PartnerInvoice.findOne({ tenantId, _id: invoiceId }).lean();
  if (!invoice) throw notFound('Invoice not found.');
  if (!['APPROVED', 'PAYMENT_PROCESSING', 'PARTIALLY_PAID'].includes(invoice.status)) {
    throw badRequest('Only an approved invoice can be paid.');
  }
  const amount = Number(amountMinor);
  if (!Number.isInteger(amount) || amount <= 0) throw badRequest('Enter the amount paid.');
  const remaining = invoice.invoiceTotalMinor - (invoice.paidAmountMinor || 0);
  if (amount > remaining) {
    throw badRequest(`That is more than the ${money.format(remaining, { currency: tenant?.currency, locale: tenant?.locale })} still outstanding on this invoice.`);
  }
  const when = payoutDate ? new Date(payoutDate) : new Date();
  if (Number.isNaN(when.getTime())) throw badRequest('Enter a valid payout date.');

  const payout = await PartnerPayout.create({
    tenantId,
    channelPartnerId: invoice.channelPartnerId,
    partnerInvoiceId: invoice._id,
    payoutDate: when,
    amountMinor: amount,
    transactionReference,
    deductionMinor: Number(deductionMinor || 0),
    deductionNote,
    note,
    enteredBy: actor?._id,
  });

  const paidTotal = (invoice.paidAmountMinor || 0) + amount;
  const fullyPaid = paidTotal >= invoice.invoiceTotalMinor;
  await PartnerInvoice.updateOne({ tenantId, _id: invoiceId }, {
    $set: {
      paidAmountMinor: paidTotal,
      status: fullyPaid ? 'PAID' : 'PARTIALLY_PAID',
      ...(fullyPaid ? { paidAt: when } : {}),
    },
  });

  // Spread the payout across the invoice's entitlements, proportionally.
  for (const line of invoice.lines) {
    const share = Math.round((line.invoiceClaimAmountMinor / invoice.taxableValueMinor) * amount);
    await PartnerCommissionEntitlement.updateOne(
      { tenantId, _id: line.commissionEntitlementId },
      { $inc: { paidAmountMinor: share } },
    );
    await commissions.refreshStatus({ tenantId, entitlementId: line.commissionEntitlementId });
  }

  await timeline.log({
    tenantId,
    channelPartnerId: invoice.channelPartnerId,
    type: 'CP_INVOICE_PAID',
    title: `Payout ${money.format(amount, { currency: tenant?.currency, locale: tenant?.locale })}${fullyPaid ? ' — invoice fully paid' : ''}`,
    body: transactionReference,
    actor,
    meta: { invoiceId: String(invoiceId), payoutId: String(payout._id) },
  });
  // §196: marking a payout is audited.
  await audit.record({
    tenantId, actor, entity: 'PartnerPayout', entityId: payout._id, action: 'CREATE',
    after: { invoiceId: String(invoiceId), amountMinor: amount, transactionReference },
  });
  if (fullyPaid) emit(EVENTS.CP_INVOICE_PAID, { tenantId, invoiceId, channelPartnerId: invoice.channelPartnerId });
  return payout;
}

async function markProcessing({ tenantId, actor, invoiceId }) {
  const invoice = await PartnerInvoice.findOne({ tenantId, _id: invoiceId });
  if (!invoice) throw notFound('Invoice not found.');
  if (invoice.status !== 'APPROVED') throw badRequest('Only an approved invoice can move to payment processing.');
  invoice.status = 'PAYMENT_PROCESSING';
  await invoice.save();
  await audit.record({
    tenantId, actor, entity: 'PartnerInvoice', entityId: invoiceId, action: 'MARK_PROCESSING',
  });
  return invoice;
}

/** §44: the internal invoice queue. */
async function list({ tenantId, query = {}, page = 1, limit = 25 }) {
  const filter = { tenantId };
  if (query.status) filter.status = query.status;
  if (query.channelPartnerId) filter.channelPartnerId = query.channelPartnerId;
  const skip = (Math.max(1, Number(page)) - 1) * limit;
  const [items, total, counts] = await Promise.all([
    PartnerInvoice.find(filter).sort({ submittedAt: -1, createdAt: -1 }).skip(skip).limit(limit)
      .populate('channelPartnerId', 'profile partnerCode status reraStatus')
      .lean(),
    PartnerInvoice.countDocuments(filter),
    Promise.all(PartnerInvoice.STATUSES.map(async (status) => ({
      status, count: await PartnerInvoice.countDocuments({ tenantId, status }),
    }))),
  ]);
  return { items, total, page: Number(page), pages: Math.ceil(total / limit) || 1, limit, counts };
}

/** §49: everything the reviewer needs on one screen. */
async function detail({ tenantId, invoiceId }) {
  const invoice = await PartnerInvoice.findOne({ tenantId, _id: invoiceId })
    .populate('channelPartnerId')
    .populate('reviewedBy', 'name')
    .populate('approvedBy', 'name')
    .lean();
  if (!invoice) throw notFound('Invoice not found.');

  const lines = await Promise.all(invoice.lines.map(async (line) => {
    const [booking, entitlement] = await Promise.all([
      Booking.findOne({ tenantId, _id: line.bookingId })
        .select('bookingNumber finalPriceMinor totalReceivedMinor scheduledTotalMinor contactId unitId projectId')
        .populate('unitId', 'unitNumber').populate('projectId', 'name').lean(),
      PartnerCommissionEntitlement.findOne({ tenantId, _id: line.commissionEntitlementId }).lean(),
    ]);
    const contact = booking?.contactId
      ? await Contact.findOne({ tenantId, _id: booking.contactId }).select('displayName').lean()
      : null;
    const basis = booking?.scheduledTotalMinor || booking?.finalPriceMinor || 0;
    return {
      ...line,
      booking,
      entitlement,
      customerName: contact?.displayName,
      collectedPct: basis ? Math.round(((booking.totalReceivedMinor || 0) / basis) * 100) : 0,
    };
  }));

  const payouts = await PartnerPayout.find({ tenantId, partnerInvoiceId: invoiceId })
    .sort({ payoutDate: -1 }).populate('enteredBy', 'name').lean();
  return { invoice, lines, payouts };
}

module.exports = {
  claimCeiling, saveDraft, attachPdf, submit, review, recordPayout, markProcessing,
  applyInvoicedAmounts, list, detail,
};
