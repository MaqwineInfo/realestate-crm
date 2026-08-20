const {
  ChannelPartner, PartnerCommissionRule, PartnerCommissionEntitlement, PartnerProjectEmpanelment,
  Booking, Project, Contact, Tenant,
} = require('../db/models');
const { badRequest, notFound } = require('../lib/errors');
const { EVENTS, emit } = require('../lib/events');
const money = require('../lib/money');
const timeline = require('./timeline');
const notifications = require('./notifications');
const audit = require('./audit');

/**
 * V2 §40–§43, §206, §228, §306: what a partner earns.
 *
 * Three rules hold this together:
 *
 *   §324.9 — the rule is SNAPSHOTTED onto the entitlement at booking. Editing a
 *   commission rule tomorrow cannot change what was earned yesterday.
 *
 *   §206 — accrued, eligible, invoiced and paid are four different numbers and
 *   are never collapsed into one. Management mistaking accrued for payable is
 *   the exact failure this prevents.
 *
 *   §228 — a receipt reversal may un-eligible an entitlement that has not been
 *   invoiced. It never claws back one that has been invoiced or paid; that is
 *   flagged for a person.
 */

/**
 * §40: most specific rule wins — partner+project beats project beats partner
 * type beats organization default. Ties break on the most recent effective date.
 */
async function resolveRule({ tenantId, partner, projectId, at = new Date() }) {
  const candidates = await PartnerCommissionRule.find({
    tenantId,
    active: true,
    $and: [
      { $or: [{ channelPartnerId: partner?._id }, { channelPartnerId: null }] },
      { $or: [{ projectId }, { projectId: null }] },
      { $or: [{ partnerType: partner?.profile?.partnerType }, { partnerType: null }] },
      { $or: [{ effectiveFrom: null }, { effectiveFrom: { $lte: at } }] },
      { $or: [{ effectiveTo: null }, { effectiveTo: { $gte: at } }] },
    ],
  });
  if (!candidates.length) return null;

  // §25: an empanelment may name the rule for that partner on that project,
  // which is more specific than anything the rule catalogue can express.
  if (projectId && partner) {
    const empanelment = await PartnerProjectEmpanelment.findOne({
      tenantId, channelPartnerId: partner._id, projectId, commissionRuleId: { $ne: null },
    }).lean();
    if (empanelment) {
      const named = candidates.find((c) => String(c._id) === String(empanelment.commissionRuleId));
      if (named) return named;
    }
  }

  return candidates.sort((a, b) => {
    if (b.specificity !== a.specificity) return b.specificity - a.specificity;
    return new Date(b.effectiveFrom || 0) - new Date(a.effectiveFrom || 0);
  })[0];
}

/** §41: the money the rule produces for one booking. */
function calculate({ rule, booking }) {
  const basisAmount = {
    FINAL_BOOKING_PRICE: booking.finalPriceMinor,
    BASE_VALUE: booking.finalPriceMinor - (booking.discountMinor || 0),
    FIXED_AMOUNT: 0,
  }[rule.basis] ?? booking.finalPriceMinor;

  if (rule.rateType === 'FIXED' || rule.basis === 'FIXED_AMOUNT') {
    return {
      basisAmountMinor: basisAmount,
      commissionMinor: Math.max(0, Math.round(rule.fixedAmountMinor || money.toMinor(rule.rate || 0))),
    };
  }
  return { basisAmountMinor: basisAmount, commissionMinor: money.percentOf(basisAmount, rule.rate) };
}

/** How much of the booking has been collected, as a percentage (§43). */
const collectionPct = (booking) => {
  const basis = booking.scheduledTotalMinor || booking.finalPriceMinor;
  if (!basis) return 0;
  return (booking.totalReceivedMinor / basis) * 100;
};

/**
 * §42/§266 step 9: accrue the entitlement for a booking that carries partner
 * attribution. Idempotent — the unique (booking, partner) index and this early
 * return mean a retried initialization cannot double an accrual.
 */
async function accrueForBooking({ tenantId, tenant, bookingId, actor = null }) {
  const booking = await Booking.findOne({ tenantId, _id: bookingId }).lean();
  if (!booking) throw notFound('Booking not found.');
  if (!booking.channelPartnerId) return null;

  const existing = await PartnerCommissionEntitlement.findOne({
    tenantId, bookingId, channelPartnerId: booking.channelPartnerId,
  }).lean();
  if (existing) return existing;

  const partner = await ChannelPartner.findOne({ tenantId, _id: booking.channelPartnerId }).lean();
  if (!partner) return null;

  const rule = booking.partnerCommissionRuleId
    ? await PartnerCommissionRule.findOne({ tenantId, _id: booking.partnerCommissionRuleId })
    : await resolveRule({ tenantId, partner, projectId: booking.projectId, at: booking.bookingDate });

  if (!rule) {
    // No rule is a real state, not an error: the partner is attributed, the
    // money is simply not agreed yet. The CP team is told.
    await notifications.notifyMany({
      tenantId,
      userIds: await notifications.adminUserIds(tenantId),
      domain: 'CHANNEL_PARTNER',
      type: 'CP_NO_COMMISSION_RULE',
      title: 'Booking has no commission rule',
      body: `${booking.bookingNumber || 'A booking'} is attributed to a partner with no matching commission rule.`,
      link: `/app/bookings/${bookingId}?tab=overview`,
      severity: 'WARNING',
    });
    return null;
  }

  const { basisAmountMinor, commissionMinor } = calculate({ rule, booking });
  const entitlement = await PartnerCommissionEntitlement.create({
    tenantId,
    bookingId,
    channelPartnerId: partner._id,
    channelPartnerMemberId: booking.channelPartnerMemberId || undefined,
    projectId: booking.projectId,
    commissionRuleId: rule._id,
    // §306/§324.9: frozen here, on purpose.
    commissionRuleSnapshot: {
      name: rule.name,
      basis: rule.basis,
      rateType: rule.rateType,
      rate: rule.rate,
      fixedAmountMinor: rule.fixedAmountMinor,
      eligibilityTrigger: rule.eligibilityTrigger,
      collectionThresholdPct: rule.collectionThresholdPct,
      description: rule.describe(),
    },
    commissionBasisAmountMinor: basisAmountMinor,
    calculatedCommissionMinor: commissionMinor,
    status: 'ACCRUED',
  });

  if (!booking.partnerCommissionRuleId) {
    await Booking.updateOne({ tenantId, _id: bookingId }, { $set: { partnerCommissionRuleId: rule._id } });
  }

  await timeline.log({
    tenantId,
    channelPartnerId: partner._id,
    type: 'CP_COMMISSION_ACCRUED',
    title: `Commission accrued — ${money.format(commissionMinor, { currency: tenant?.currency, locale: tenant?.locale })}`,
    body: `${booking.bookingNumber || 'Booking'} · ${rule.describe()}`,
    actor,
    actorType: actor ? 'USER' : 'SYSTEM',
    meta: { entitlementId: String(entitlement._id), bookingId: String(bookingId) },
  });
  await timeline.log({
    tenantId,
    bookingId,
    type: 'CP_COMMISSION_ACCRUED',
    title: `Channel partner commission accrued — ${rule.describe()}`,
    actorType: 'SYSTEM',
    meta: { entitlementId: String(entitlement._id), channelPartnerId: String(partner._id) },
  });
  emit(EVENTS.CP_BOOKING_CREATED, { tenantId, bookingId, channelPartnerId: partner._id });

  // Evaluate straight away: an ON_BOOKING rule is eligible the moment it accrues.
  return evaluate({ tenantId, tenant, bookingId, actor });
}

/**
 * §43/§228: decide whether the accrued commission is payable yet, from the
 * booking's live collection position. Safe to run any number of times.
 */
async function evaluate({ tenantId, tenant, bookingId, actor = null, now = new Date() }) {
  const booking = await Booking.findOne({ tenantId, _id: bookingId }).lean();
  if (!booking) return null;
  const entitlement = await PartnerCommissionEntitlement.findOne({
    tenantId, bookingId, channelPartnerId: booking.channelPartnerId,
  }).lean();
  if (!entitlement) return null;
  // §228: a PAID entitlement is precisely what has to be flagged when collection
  // falls back, so it is NOT short-circuited here. Only a cancelled one is.
  if (entitlement.status === 'CANCELLED') return entitlement;

  const snapshot = entitlement.commissionRuleSnapshot || {};
  const pct = collectionPct(booking);
  const received = booking.totalReceivedMinor || 0;
  const tokenTarget = booking.bookingAmountMinor || 1;

  const eligibleNow = {
    ON_BOOKING: () => true,
    ON_TOKEN_RECEIVED: () => received >= tokenTarget,
    ON_COLLECTION_PERCENT: () => pct >= Number(snapshot.collectionThresholdPct || 0),
    ON_FULL_PAYMENT: () => booking.scheduledTotalMinor > 0 && booking.outstandingMinor === 0,
    MANUAL: () => entitlement.status === 'ELIGIBLE' || entitlement.eligibleAmountMinor > 0,
  }[snapshot.eligibilityTrigger || 'ON_BOOKING']();

  const alreadyCommitted = (entitlement.invoicedAmountMinor || 0) > 0 || (entitlement.paidAmountMinor || 0) > 0;
  const update = { collectionPctAtEvaluation: Math.round(pct * 100) / 100 };
  let becameEligible = false;

  if (eligibleNow) {
    if (entitlement.eligibleAmountMinor !== entitlement.calculatedCommissionMinor) {
      update.eligibleAmountMinor = entitlement.calculatedCommissionMinor;
      update.eligibleAt = entitlement.eligibleAt || now;
      becameEligible = true;
    }
    update.status = statusFor({
      ...entitlement,
      eligibleAmountMinor: entitlement.calculatedCommissionMinor,
    });
  } else if (alreadyCommitted) {
    /**
     * §228: the threshold fell after money was already invoiced or paid — most
     * likely a reversed receipt. Nothing is clawed back; a person decides.
     */
    update.status = 'REVIEW_REQUIRED';
    update.reviewReason = `Collection fell to ${pct.toFixed(1)}% after ${money.format(entitlement.invoicedAmountMinor || entitlement.paidAmountMinor, { currency: tenant?.currency, locale: tenant?.locale })} was already invoiced or paid.`;
  } else {
    update.status = 'NOT_YET_ELIGIBLE';
    update.eligibleAmountMinor = 0;
    update.eligibleAt = null;
  }

  if (update.status === entitlement.status && !becameEligible
      && update.collectionPctAtEvaluation === entitlement.collectionPctAtEvaluation) {
    return entitlement;
  }
  await PartnerCommissionEntitlement.updateOne({ tenantId, _id: entitlement._id }, { $set: update });

  if (becameEligible) {
    const [partner, project, contact] = await Promise.all([
      ChannelPartner.findOne({ tenantId, _id: entitlement.channelPartnerId }).lean(),
      Project.findOne({ tenantId, _id: booking.projectId }).select('name').lean(),
      Contact.findOne({ tenantId, _id: booking.contactId }).select('displayName').lean(),
    ]);
    const amount = money.format(entitlement.calculatedCommissionMinor, {
      currency: tenant?.currency, locale: tenant?.locale,
    });
    await timeline.log({
      tenantId,
      channelPartnerId: entitlement.channelPartnerId,
      type: 'CP_COMMISSION_ELIGIBLE',
      title: `Commission eligible — ${amount}`,
      body: `${booking.bookingNumber || ''} ${contact?.displayName || ''}`.trim(),
      actorType: 'SYSTEM',
      meta: { entitlementId: String(entitlement._id), collectionPct: update.collectionPctAtEvaluation },
    });
    await timeline.log({
      tenantId,
      bookingId,
      type: 'CP_COMMISSION_ELIGIBLE',
      title: `Channel partner commission became eligible — ${amount}`,
      actorType: 'SYSTEM',
      meta: { entitlementId: String(entitlement._id) },
    });
    emit(EVENTS.CP_COMMISSION_ELIGIBLE, {
      tenantId, bookingId, channelPartnerId: entitlement.channelPartnerId, entitlementId: entitlement._id,
    });
    // §52: both sides hear about it — the CP team and the partner.
    await notifications.notifyMany({
      tenantId,
      userIds: [...(await notifications.adminUserIds(tenantId)), partner?.ownerUserId].filter(Boolean),
      domain: 'CHANNEL_PARTNER',
      type: 'CP_COMMISSION_ELIGIBLE',
      title: 'Partner commission is now eligible',
      body: `${require('./channelPartners').displayNameOf(partner?.profile || {})} · ${amount} · ${project?.name || ''}`,
      link: `/app/channel-partners/${entitlement.channelPartnerId}?tab=commission`,
      severity: 'INFO',
    });
  }
  if (update.status === 'REVIEW_REQUIRED' && entitlement.status !== 'REVIEW_REQUIRED') {
    await timeline.log({
      tenantId,
      channelPartnerId: entitlement.channelPartnerId,
      type: 'CP_COMMISSION_REVIEW',
      title: 'Commission needs manual review',
      body: update.reviewReason,
      actorType: 'SYSTEM',
      meta: { entitlementId: String(entitlement._id) },
    });
    await notifications.notifyMany({
      tenantId,
      userIds: await notifications.adminUserIds(tenantId),
      domain: 'CHANNEL_PARTNER',
      type: 'CP_COMMISSION_REVIEW',
      title: 'Partner commission needs review',
      body: update.reviewReason,
      link: `/app/channel-partners/${entitlement.channelPartnerId}?tab=commission`,
      severity: 'WARNING',
    });
  }
  return PartnerCommissionEntitlement.findOne({ tenantId, _id: entitlement._id }).lean();
}

/** §42: the status that follows from the four money figures. */
function statusFor(entitlement) {
  const eligible = entitlement.eligibleAmountMinor || 0;
  const invoiced = entitlement.invoicedAmountMinor || 0;
  const paid = entitlement.paidAmountMinor || 0;
  if (paid > 0 && paid >= invoiced && invoiced >= eligible && eligible > 0) return 'PAID';
  if (paid > 0) return 'PARTIALLY_PAID';
  if (invoiced > 0 && invoiced >= eligible) return 'INVOICED';
  if (invoiced > 0) return 'PARTIALLY_INVOICED';
  if (eligible > 0) return 'ELIGIBLE';
  return 'NOT_YET_ELIGIBLE';
}

/** Recomputes status after an invoice or payout changed the figures. */
async function refreshStatus({ tenantId, entitlementId }) {
  const entitlement = await PartnerCommissionEntitlement.findOne({ tenantId, _id: entitlementId }).lean();
  if (!entitlement) return null;
  if (['CANCELLED', 'REVIEW_REQUIRED'].includes(entitlement.status)) return entitlement;
  const status = statusFor(entitlement);
  if (status === entitlement.status) return entitlement;
  await PartnerCommissionEntitlement.updateOne({ tenantId, _id: entitlementId }, { $set: { status } });
  return PartnerCommissionEntitlement.findOne({ tenantId, _id: entitlementId }).lean();
}

/** §188 `cp.commission_eligibility`: the safety net for anything an event missed. */
async function eligibilitySweep({ tenantId = null, limit = 300 } = {}) {
  const filter = { status: { $in: ['ACCRUED', 'NOT_YET_ELIGIBLE'] } };
  if (tenantId) filter.tenantId = tenantId;
  const pending = await PartnerCommissionEntitlement.find(filter)
    .setOptions({ allowCrossTenant: !tenantId }).select('_id tenantId bookingId').limit(limit).lean();

  let evaluated = 0;
  for (const entitlement of pending) {
    const tenant = await Tenant.findById(entitlement.tenantId).lean();
    await evaluate({ tenantId: entitlement.tenantId, tenant, bookingId: entitlement.bookingId });
    evaluated += 1;
  }
  return { scanned: pending.length, evaluated };
}

/** §206: the four figures, kept apart. Used by the workspace and the reports. */
async function summaryFor({ tenantId, channelPartnerId = null }) {
  const match = { tenantId };
  if (channelPartnerId) match.channelPartnerId = channelPartnerId;
  const rows = await PartnerCommissionEntitlement.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        accruedMinor: { $sum: '$calculatedCommissionMinor' },
        eligibleMinor: { $sum: '$eligibleAmountMinor' },
        invoicedMinor: { $sum: '$invoicedAmountMinor' },
        paidMinor: { $sum: '$paidAmountMinor' },
        bookings: { $sum: 1 },
      },
    },
  ]);
  const totals = rows[0] || {};
  return {
    accruedMinor: totals.accruedMinor || 0,
    eligibleMinor: totals.eligibleMinor || 0,
    invoicedMinor: totals.invoicedMinor || 0,
    paidMinor: totals.paidMinor || 0,
    // §48: what an invoice may still claim.
    uninvoicedEligibleMinor: Math.max(0, (totals.eligibleMinor || 0) - (totals.invoicedMinor || 0)),
    bookings: totals.bookings || 0,
  };
}

/** §313: the eligible lines a partner may put on an invoice. */
async function eligibleForInvoice({ tenantId, channelPartnerId }) {
  const entitlements = await PartnerCommissionEntitlement.find({
    tenantId,
    channelPartnerId,
    status: { $in: ['ELIGIBLE', 'PARTIALLY_INVOICED', 'PARTIALLY_PAID'] },
  })
    .populate('bookingId', 'bookingNumber finalPriceMinor totalReceivedMinor scheduledTotalMinor contactId projectId')
    .populate('projectId', 'name')
    .lean();

  const withContext = await Promise.all(entitlements.map(async (entitlement) => {
    const contact = entitlement.bookingId?.contactId
      ? await Contact.findOne({ tenantId, _id: entitlement.bookingId.contactId }).select('displayName').lean()
      : null;
    const booking = entitlement.bookingId || {};
    const basis = booking.scheduledTotalMinor || booking.finalPriceMinor || 0;
    return {
      ...entitlement,
      customerName: contact?.displayName,
      collectedPct: basis ? Math.round(((booking.totalReceivedMinor || 0) / basis) * 100) : 0,
      uninvoicedEligibleMinor: Math.max(0, (entitlement.eligibleAmountMinor || 0) - (entitlement.invoicedAmountMinor || 0)),
    };
  }));
  return withContext.filter((e) => e.uninvoicedEligibleMinor > 0);
}

/* ------------------------------ rule CRUD -------------------------------- */

async function saveRule({ tenantId, actor, ruleId = null, data }) {
  if (!String(data.name || '').trim()) throw badRequest('Name this rule.');
  const rateType = PartnerCommissionRule.RATE_TYPES.includes(data.rateType) ? data.rateType : 'PERCENTAGE';
  const basis = PartnerCommissionRule.BASES.includes(data.basis) ? data.basis : 'FINAL_BOOKING_PRICE';
  const trigger = PartnerCommissionRule.TRIGGERS.includes(data.eligibilityTrigger)
    ? data.eligibilityTrigger : 'ON_BOOKING';

  const rate = Number(data.rate || 0);
  if (rateType === 'PERCENTAGE' && !(rate > 0 && rate <= 100)) {
    throw badRequest('Enter a commission percentage between 0 and 100.');
  }
  if (trigger === 'ON_COLLECTION_PERCENT') {
    const threshold = Number(data.collectionThresholdPct || 0);
    if (!(threshold > 0 && threshold <= 100)) {
      throw badRequest('Enter the collection percentage that unlocks this commission.');
    }
  }

  const payload = {
    name: String(data.name).trim(),
    projectId: data.projectId || null,
    channelPartnerId: data.channelPartnerId || null,
    partnerType: data.partnerType || null,
    basis,
    rateType,
    rate,
    fixedAmountMinor: rateType === 'FIXED' ? money.toMinor(data.fixedAmount || data.rate || 0) : undefined,
    eligibilityTrigger: trigger,
    collectionThresholdPct: trigger === 'ON_COLLECTION_PERCENT' ? Number(data.collectionThresholdPct) : undefined,
    effectiveFrom: data.effectiveFrom ? new Date(data.effectiveFrom) : undefined,
    effectiveTo: data.effectiveTo ? new Date(data.effectiveTo) : undefined,
    notes: data.notes,
  };

  let rule;
  if (ruleId) {
    rule = await PartnerCommissionRule.findOne({ tenantId, _id: ruleId });
    if (!rule) throw notFound('Commission rule not found.');
    Object.assign(rule, payload);
    await rule.save();
  } else {
    rule = await PartnerCommissionRule.create({ tenantId, ...payload, createdBy: actor?._id });
  }
  // §196: commission rules are audited. §306 means the change is forward-only.
  await audit.record({
    tenantId, actor, entity: 'PartnerCommissionRule', entityId: rule._id,
    action: ruleId ? 'UPDATE' : 'CREATE', after: payload,
  });
  return rule;
}

async function toggleRule({ tenantId, actor, ruleId }) {
  const rule = await PartnerCommissionRule.findOne({ tenantId, _id: ruleId });
  if (!rule) throw notFound('Commission rule not found.');
  rule.active = !rule.active;
  await rule.save();
  await audit.record({
    tenantId, actor, entity: 'PartnerCommissionRule', entityId: rule._id,
    action: rule.active ? 'ACTIVATE' : 'DEACTIVATE',
  });
  return rule;
}

const listRules = ({ tenantId }) => PartnerCommissionRule.find({ tenantId })
  .sort({ active: -1, createdAt: -1 })
  .populate('projectId', 'name')
  .populate('channelPartnerId', 'profile partnerCode')
  .lean();

module.exports = {
  resolveRule, calculate, collectionPct, accrueForBooking, evaluate, statusFor, refreshStatus,
  eligibilitySweep, summaryFor, eligibleForInvoice, saveRule, toggleRule, listRules,
};
