const {
  ChannelPartner, ChannelPartnerRegistration, PartnerLeadClaim, PartnerCommissionEntitlement,
  PartnerInvoice, PartnerPayout, Booking, SiteVisit, UnitBlock, Lead,
} = require('../db/models');
const tzLib = require('../lib/tz');
const reports = require('./reports');
const channelPartners = require('./channelPartners');

/**
 * V2 §9–§11, §51, §204–§206: the channel partner dashboard and reports.
 *
 * Two definitions are load-bearing here:
 *   §204 — only ACCEPTED claims count as CP leads. Rejected and conflicted
 *   submissions are not performance, and counting them would reward disputes.
 *   §206 — accrued, eligible, invoiced and paid stay four separate columns.
 */

/** Everything one partner's funnel is made of, from the accepted claims out. */
async function funnelFor({ tenantId, channelPartnerId = null, projectId = null, start, end }) {
  const claimFilter = { tenantId, status: 'ACCEPTED' };
  if (channelPartnerId) claimFilter.channelPartnerId = channelPartnerId;
  if (projectId) claimFilter.projectId = projectId;
  if (start || end) {
    claimFilter.submittedAt = {};
    if (start) claimFilter.submittedAt.$gte = start;
    if (end) claimFilter.submittedAt.$lte = end;
  }

  const claims = await PartnerLeadClaim.find(claimFilter)
    .select('channelPartnerId channelPartnerMemberId leadId projectId submittedAt').lean();
  const leadIds = claims.map((c) => c.leadId).filter(Boolean);

  const [leads, visits, blocks, bookings] = await Promise.all([
    Lead.find({ tenantId, _id: { $in: leadIds } }).select('firstGenuineActionAt channelPartnerId').lean(),
    SiteVisit.find({ tenantId, leadId: { $in: leadIds } }).select('leadId status channelPartnerId').lean(),
    UnitBlock.find({ tenantId, leadId: { $in: leadIds } }).select('leadId channelPartnerId').lean(),
    Booking.find({
      tenantId,
      ...(channelPartnerId ? { channelPartnerId } : { channelPartnerId: { $ne: null } }),
      ...(projectId ? { projectId } : {}),
      ...(start || end ? { bookingDate: { ...(start ? { $gte: start } : {}), ...(end ? { $lte: end } : {}) } } : {}),
    }).select('channelPartnerId finalPriceMinor leadId projectId').lean(),
  ]);

  const completedVisitLeads = new Set(visits.filter((v) => v.status === 'COMPLETED').map((v) => String(v.leadId)));
  return {
    claims,
    leads: claims.length,
    connected: leads.filter((l) => l.firstGenuineActionAt).length,
    visits: completedVisitLeads.size,
    blocks: new Set(blocks.map((b) => String(b.leadId))).size,
    bookings: bookings.length,
    // §205: the booking's own frozen price, never today's list price.
    bookingValueMinor: bookings.reduce((sum, b) => sum + (b.finalPriceMinor || 0), 0),
    bookingRows: bookings,
    completedVisitLeads,
  };
}

/** §204: the three conversion rates, from the definitions given. */
const conversions = ({ leads, visits, bookings }) => ({
  leadToVisit: leads ? Math.round((visits / leads) * 100) : 0,
  visitToBooking: visits ? Math.round((bookings / visits) * 100) : 0,
  leadToBooking: leads ? Math.round((bookings / leads) * 100) : 0,
});

/** §9/§10/§11: the internal CP dashboard. */
async function dashboard({ tenantId, query = {}, zone = 'UTC', now = new Date() }) {
  const { start, end } = reports.rangeFor({ from: query.from, to: query.to, zone });
  const projectId = query.projectId || null;

  const partnerFilter = { tenantId };
  if (query.partnerType) partnerFilter['profile.partnerType'] = query.partnerType;

  const [partners, registrations, funnel, commissionRows, invoices, payouts] = await Promise.all([
    ChannelPartner.find(partnerFilter).select('status profile reraExpiryDate reraStatus').lean(),
    ChannelPartnerRegistration.find({ tenantId, status: { $in: ['SUBMITTED', 'UNDER_REVIEW', 'CORRECTION_REQUIRED'] } })
      .select('status').lean(),
    funnelFor({ tenantId, projectId, start, end }),
    PartnerCommissionEntitlement.find({ tenantId }).select(
      'channelPartnerId calculatedCommissionMinor eligibleAmountMinor invoicedAmountMinor paidAmountMinor status',
    ).lean(),
    PartnerInvoice.find({ tenantId }).select('status invoiceTotalMinor paidAmountMinor channelPartnerId').lean(),
    PartnerPayout.find({ tenantId }).select('amountMinor payoutDate').lean(),
  ]);

  const expirySoon = partners.filter((p) => p.reraExpiryDate
    && new Date(p.reraExpiryDate) <= tzLib.addLocalDays(now, 60, zone)
    && new Date(p.reraExpiryDate) >= tzLib.startOfDay(now, zone)).length;

  const sum = (rows, pick) => rows.reduce((total, row) => total + (pick(row) || 0), 0);
  const commission = {
    accruedMinor: sum(commissionRows, (r) => r.calculatedCommissionMinor),
    eligibleMinor: sum(commissionRows, (r) => r.eligibleAmountMinor),
    invoicedMinor: sum(commissionRows, (r) => r.invoicedAmountMinor),
    paidMinor: sum(commissionRows, (r) => r.paidAmountMinor),
  };

  return {
    tiles: {
      totalPartners: partners.length,
      activeCompany: partners.filter((p) => p.status === 'ACTIVE' && p.profile?.partnerType === 'COMPANY').length,
      activeIndividual: partners.filter((p) => p.status === 'ACTIVE' && p.profile?.partnerType === 'INDIVIDUAL').length,
      suspended: partners.filter((p) => p.status === 'SUSPENDED').length,
      pendingRegistrations: registrations.length,
      reraExpiringSoon: expirySoon,
      reraExpired: partners.filter((p) => p.reraStatus === 'EXPIRED').length,
      leadsSubmitted: funnel.leads,
      visitsCompleted: funnel.visits,
      bookings: funnel.bookings,
      bookingValueMinor: funnel.bookingValueMinor,
      commissionEligibleMinor: Math.max(0, commission.eligibleMinor - commission.invoicedMinor),
      invoicesPendingApproval: invoices.filter((i) => ['SUBMITTED', 'UNDER_REVIEW'].includes(i.status)).length,
      payoutPendingMinor: invoices
        .filter((i) => ['APPROVED', 'PAYMENT_PROCESSING', 'PARTIALLY_PAID'].includes(i.status))
        .reduce((total, i) => total + (i.invoiceTotalMinor - (i.paidAmountMinor || 0)), 0),
    },
    // §11: the funnel, drillable to the records behind it.
    funnel: {
      leads: funnel.leads,
      connected: funnel.connected,
      visits: funnel.visits,
      blocks: funnel.blocks,
      bookings: funnel.bookings,
      bookingValueMinor: funnel.bookingValueMinor,
    },
    commission,
    payoutsInRangeMinor: payouts
      .filter((p) => p.payoutDate >= start && p.payoutDate <= end)
      .reduce((total, p) => total + p.amountMinor, 0),
    start,
    end,
  };
}

/**
 * §10: the top-performer table. Ranked by whichever column was asked for —
 * §10 is explicit that one mysterious combined score is not the default.
 */
async function topPerformers({ tenantId, query = {}, zone = 'UTC', limit = 20 }) {
  const { start, end } = reports.rangeFor({ from: query.from, to: query.to, zone });
  const partnerFilter = { tenantId };
  if (query.partnerType) partnerFilter['profile.partnerType'] = query.partnerType;
  const partners = await ChannelPartner.find(partnerFilter).select('profile partnerCode status').lean();

  const rows = await Promise.all(partners.map(async (partner) => {
    const funnel = await funnelFor({
      tenantId, channelPartnerId: partner._id, projectId: query.projectId || null, start, end,
    });
    return {
      partner,
      name: channelPartners.displayNameOf(partner.profile),
      partnerType: partner.profile?.partnerType,
      leads: funnel.leads,
      visits: funnel.visits,
      bookings: funnel.bookings,
      bookingValueMinor: funnel.bookingValueMinor,
      ...conversions(funnel),
    };
  }));

  const sorters = {
    bookings: (a, b) => b.bookings - a.bookings || b.bookingValueMinor - a.bookingValueMinor,
    value: (a, b) => b.bookingValueMinor - a.bookingValueMinor,
    leads: (a, b) => b.leads - a.leads,
    visits: (a, b) => b.visits - a.visits,
    conversion: (a, b) => b.leadToBooking - a.leadToBooking,
  };
  return rows
    .filter((r) => r.leads || r.bookings)
    .sort(sorters[query.rankBy] || sorters.bookings)
    .slice(0, limit);
}

/** §51: the CP performance report — one row per partner, with commission. */
async function performanceReport({ tenantId, query = {}, zone = 'UTC' }) {
  const { start, end } = reports.rangeFor({ from: query.from, to: query.to, zone });
  const filter = { tenantId };
  if (query.partnerType) filter['profile.partnerType'] = query.partnerType;
  if (query.reraStatus) filter.reraStatus = query.reraStatus;
  if (query.city) filter['profile.city'] = new RegExp(String(query.city).trim(), 'i');
  if (query.channelPartnerId) filter._id = query.channelPartnerId;

  const partners = await ChannelPartner.find(filter).lean();
  const rows = await Promise.all(partners.map(async (partner) => {
    const funnel = await funnelFor({
      tenantId, channelPartnerId: partner._id, projectId: query.projectId || null, start, end,
    });
    const entitlements = await PartnerCommissionEntitlement.find({ tenantId, channelPartnerId: partner._id }).lean();
    const sum = (pick) => entitlements.reduce((total, e) => total + (pick(e) || 0), 0);
    return {
      partner,
      name: channelPartners.displayNameOf(partner.profile),
      partnerType: partner.profile?.partnerType,
      city: partner.profile?.city,
      status: partner.status,
      reraStatus: partner.reraStatus,
      reraExpiryDate: partner.reraExpiryDate,
      leads: funnel.leads,
      connected: funnel.connected,
      visits: funnel.visits,
      blocks: funnel.blocks,
      bookings: funnel.bookings,
      bookingValueMinor: funnel.bookingValueMinor,
      ...conversions(funnel),
      // §206: four separate columns, never one.
      accruedMinor: sum((e) => e.calculatedCommissionMinor),
      eligibleMinor: sum((e) => e.eligibleAmountMinor),
      invoicedMinor: sum((e) => e.invoicedAmountMinor),
      paidMinor: sum((e) => e.paidAmountMinor),
    };
  }));

  const totals = rows.reduce((acc, row) => ({
    leads: acc.leads + row.leads,
    visits: acc.visits + row.visits,
    bookings: acc.bookings + row.bookings,
    bookingValueMinor: acc.bookingValueMinor + row.bookingValueMinor,
    accruedMinor: acc.accruedMinor + row.accruedMinor,
    eligibleMinor: acc.eligibleMinor + row.eligibleMinor,
    invoicedMinor: acc.invoicedMinor + row.invoicedMinor,
    paidMinor: acc.paidMinor + row.paidMinor,
  }), {
    leads: 0, visits: 0, bookings: 0, bookingValueMinor: 0,
    accruedMinor: 0, eligibleMinor: 0, invoicedMinor: 0, paidMinor: 0,
  });

  return {
    rows: rows.sort((a, b) => b.bookingValueMinor - a.bookingValueMinor),
    totals: { ...totals, ...conversions(totals) },
    start,
    end,
  };
}

/** §51: the invoice and payout report. */
async function invoiceReport({ tenantId, query = {}, zone = 'UTC' }) {
  const { start, end } = reports.rangeFor({ from: query.from, to: query.to, zone });
  const filter = { tenantId };
  if (query.status) filter.status = query.status;
  if (query.channelPartnerId) filter.channelPartnerId = query.channelPartnerId;
  if (query.dateBasis !== 'none') {
    filter.$or = [
      { submittedAt: { $gte: start, $lte: end } },
      { submittedAt: null, createdAt: { $gte: start, $lte: end } },
    ];
  }

  const invoices = await PartnerInvoice.find(filter)
    .sort({ submittedAt: -1, createdAt: -1 })
    .populate('channelPartnerId', 'profile partnerCode status')
    .lean();
  const payouts = await PartnerPayout.find({
    tenantId, partnerInvoiceId: { $in: invoices.map((i) => i._id) },
  }).lean();

  const rows = invoices.map((invoice) => ({
    ...invoice,
    partnerName: channelPartners.displayNameOf(invoice.channelPartnerId?.profile || {}),
    payouts: payouts.filter((p) => String(p.partnerInvoiceId) === String(invoice._id)),
    outstandingMinor: Math.max(0, invoice.invoiceTotalMinor - (invoice.paidAmountMinor || 0)),
  }));

  return {
    rows,
    totals: {
      invoices: rows.length,
      claimedMinor: rows.reduce((sum, r) => sum + r.invoiceTotalMinor, 0),
      paidMinor: rows.reduce((sum, r) => sum + (r.paidAmountMinor || 0), 0),
      outstandingMinor: rows.reduce((sum, r) => sum + r.outstandingMinor, 0),
      pending: rows.filter((r) => ['SUBMITTED', 'UNDER_REVIEW'].includes(r.status)).length,
    },
    start,
    end,
  };
}

module.exports = { funnelFor, conversions, dashboard, topPerformers, performanceReport, invoiceReport };
