const {
  PartnerPortalUser, ChannelPartner, ChannelPartnerMember, PartnerLeadClaim, PartnerInvoice,
  PartnerCommissionEntitlement, PartnerProjectEmpanelment, Lead, Booking, SiteVisit, Stage,
  Project, Contact, Tenant,
} = require('../db/models');
const { unauthorized, badRequest, notFound, forbidden } = require('../lib/errors');
const password = require('../lib/password');
const money = require('../lib/money');
const commissions = require('./commissions');
const partnerLeads = require('./partnerLeads');
const rera = require('./rera');
const audit = require('./audit');

/**
 * V2 §24, §29, §30, §37, §271: the external partner's session and everything
 * their portal is allowed to know.
 *
 * The identity is deliberately its own thing (§23): it lives on
 * `req.session.partnerUserId`, sets `req.partnerUser`, and never sets
 * `req.user`. Internal authorization reads `req.user`, so a partner session
 * cannot satisfy an internal route even by accident.
 *
 * Every read here is scoped to the authenticated partner and assembled by
 * picking fields (§37) — a new internal field cannot leak into the portal by
 * being added to a model.
 */

const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60 * 1000;

async function login({ email, plain, now = new Date() }) {
  const candidates = await PartnerPortalUser.find({ email: String(email || '').trim().toLowerCase() })
    .setOptions({ allowCrossTenant: true });

  for (const candidate of candidates) {
    if (candidate.lockedUntil && candidate.lockedUntil > now) {
      throw unauthorized('Too many failed attempts. Try again in a few minutes.');
    }
    if (!candidate.passwordHash) continue;
    if (await password.verify(plain, candidate.passwordHash)) {
      if (candidate.status === 'INVITED') throw unauthorized('Activate your account from the invitation link first.');
      if (candidate.status !== 'ACTIVE') throw unauthorized('This portal account is not active. Contact the sales team.');

      const tenant = await Tenant.findById(candidate.tenantId).lean();
      if (!tenant || tenant.status !== 'ACTIVE') throw unauthorized('This portal is not available.');
      await PartnerPortalUser.updateOne({ tenantId: candidate.tenantId, _id: candidate._id }, {
        $set: { lastLoginAt: now, failedLoginCount: 0 }, $unset: { lockedUntil: '' },
      });
      return { portalUser: candidate.toObject(), tenant };
    }
    // A wrong password on a real account counts toward the lockout.
    const failures = (candidate.failedLoginCount || 0) + 1;
    await PartnerPortalUser.updateOne({ tenantId: candidate.tenantId, _id: candidate._id }, {
      $set: {
        failedLoginCount: failures,
        ...(failures >= LOCK_AFTER ? { lockedUntil: new Date(now.getTime() + LOCK_MS) } : {}),
      },
    });
  }
  throw unauthorized('Incorrect email or password.');
}

/** §308: the partner sets their own password from the invitation link. */
async function activate({ token, plain, now = new Date() }) {
  const tokenHash = password.hashToken(token);
  const portalUser = await PartnerPortalUser.findOne({ inviteTokenHash: tokenHash })
    .setOptions({ allowCrossTenant: true });
  if (!portalUser) throw notFound('This invitation link is not valid.');
  if (portalUser.inviteExpiresAt && portalUser.inviteExpiresAt < now) {
    throw forbidden('This invitation has expired. Ask the sales team for a new one.');
  }
  const weak = password.validateStrength(plain);
  if (weak) throw badRequest(weak);

  portalUser.passwordHash = await password.hash(plain);
  portalUser.status = 'ACTIVE';
  portalUser.inviteTokenHash = undefined;
  portalUser.inviteExpiresAt = undefined;
  portalUser.failedLoginCount = 0;
  await portalUser.save();
  await audit.record({
    tenantId: portalUser.tenantId, entity: 'PartnerPortalUser', entityId: portalUser._id, action: 'ACTIVATE',
  });
  return portalUser.toObject();
}

/** Resolves the session into { portalUser, partner, member, tenant }. */
async function loadSession({ portalUserId }) {
  const portalUser = await PartnerPortalUser.findById(portalUserId)
    .setOptions({ allowCrossTenant: true }).lean();
  if (!portalUser || !['ACTIVE', 'SUSPENDED'].includes(portalUser.status)) return null;

  const [partner, tenant, member] = await Promise.all([
    ChannelPartner.findOne({ tenantId: portalUser.tenantId, _id: portalUser.channelPartnerId }).lean(),
    Tenant.findById(portalUser.tenantId).lean(),
    portalUser.channelPartnerMemberId
      ? ChannelPartnerMember.findOne({
        tenantId: portalUser.tenantId, _id: portalUser.channelPartnerMemberId,
      }).lean()
      : null,
  ]);
  if (!partner || !tenant || tenant.status !== 'ACTIVE') return null;
  // §219: a deactivated member cannot log in even if their portal row survives.
  if (member && !member.active) return null;

  return {
    portalUser,
    partner,
    member,
    tenant,
    // §218: a suspended partner keeps read access and loses the ability to act.
    readOnly: partner.status !== 'ACTIVE' || portalUser.status === 'SUSPENDED',
    isCompanyAdmin: portalUser.role === 'COMPANY_ADMIN',
  };
}

/** §23/§37: which of this partner's members' work the session may see. */
function memberScope({ portalUser, member }) {
  if (portalUser.role === 'COMPANY_ADMIN') return null;          // all company work
  if (member?.canViewCompanyLeads) return null;
  return member?._id || null;                                     // own work only
}

/**
 * §29/§30: the portal dashboard. Company and individual get the same metrics;
 * only the team table is company-only (§311).
 */
async function dashboard({ session, now = new Date() }) {
  const { tenantId } = session.portalUser;
  const partnerId = session.partner._id;
  const scope = memberScope(session);
  const claimFilter = { tenantId, channelPartnerId: partnerId, ...(scope ? { channelPartnerMemberId: scope } : {}) };

  const claims = await PartnerLeadClaim.find(claimFilter).select('status leadId').lean();
  // §204: rejected and conflicted claims are not CP leads.
  const accepted = claims.filter((c) => c.status === 'ACCEPTED');
  const leadIds = accepted.map((c) => c.leadId).filter(Boolean);

  const [visits, bookings, commission, invoices, activeLeads] = await Promise.all([
    SiteVisit.find({ tenantId, leadId: { $in: leadIds } }).select('status leadId scheduledAt').lean(),
    Booking.find({ tenantId, channelPartnerId: partnerId, ...(scope ? { channelPartnerMemberId: scope } : {}) })
      .select('finalPriceMinor bookingDate bookingNumber contactId projectId unitId totalReceivedMinor scheduledTotalMinor status')
      .lean(),
    commissions.summaryFor({ tenantId, channelPartnerId: partnerId }),
    PartnerInvoice.find({ tenantId, channelPartnerId: partnerId }).select('status invoiceTotalMinor paidAmountMinor').lean(),
    Lead.find({ tenantId, _id: { $in: leadIds }, status: 'ACTIVE' }).countDocuments(),
  ]);

  const completedVisits = visits.filter((v) => v.status === 'COMPLETED');
  const bookingValueMinor = bookings.reduce((sum, b) => sum + (b.finalPriceMinor || 0), 0);

  return {
    tiles: {
      leadsSubmitted: claims.length,
      leadsAccepted: accepted.length,
      activeLeads,
      visitsPlanned: visits.filter((v) => ['PLANNED', 'CONFIRMED', 'RESCHEDULED'].includes(v.status)).length,
      visitsCompleted: completedVisits.length,
      bookings: bookings.length,
      bookingValueMinor,
      eligibleCommissionMinor: commission.uninvoicedEligibleMinor,
      invoicesPending: invoices.filter((i) => ['SUBMITTED', 'UNDER_REVIEW', 'CORRECTION_REQUIRED'].includes(i.status)).length,
      paidCommissionMinor: commission.paidMinor,
    },
    // §204: the conversion definitions, spelled out.
    conversions: {
      leadToVisit: accepted.length
        ? Math.round((new Set(completedVisits.map((v) => String(v.leadId))).size / accepted.length) * 100) : 0,
      visitToBooking: completedVisits.length
        ? Math.round((bookings.length / new Set(completedVisits.map((v) => String(v.leadId))).size) * 100) : 0,
      leadToBooking: accepted.length ? Math.round((bookings.length / accepted.length) * 100) : 0,
    },
    commission,
    reraBanner: rera.expiryBanner({
      partner: session.partner, zone: session.tenant.timezone, locale: session.tenant.locale,
    }),
  };
}

/** §37/§310: the partner's own leads, with only the fields they may see. */
async function leads({ session, query = {}, page = 1, limit = 25 }) {
  const { tenantId } = session.portalUser;
  const scope = memberScope(session);
  const filter = {
    tenantId,
    channelPartnerId: session.partner._id,
    ...(scope ? { channelPartnerMemberId: scope } : {}),
  };
  if (query.status) filter.status = query.status;

  const skip = (Math.max(1, Number(page)) - 1) * limit;
  const [claims, total] = await Promise.all([
    PartnerLeadClaim.find(filter).sort({ submittedAt: -1 }).skip(skip).limit(limit)
      .populate('projectId', 'name')
      .populate('channelPartnerMemberId', 'name')
      .lean(),
    PartnerLeadClaim.countDocuments(filter),
  ]);

  const rows = await Promise.all(claims.map(async (claim) => {
    if (!claim.leadId) {
      return {
        claim,
        // §309: never promise attribution while a conflict is unresolved.
        visible: {
          customerName: claim.submittedName,
          project: claim.projectId?.name,
          submittedAt: claim.submittedAt,
          stage: null,
          visitStatus: 'NONE',
          bookingStatus: 'NONE',
          lastUpdate: claim.submittedAt,
        },
      };
    }
    const lead = await Lead.findOne({ tenantId, _id: claim.leadId })
      .select('contactId projectId stageId status firstInquiryAt lastActivityAt')
      .populate('contactId', 'displayName')
      .populate('projectId', 'name')
      .lean();
    const [stage, visit, booking] = await Promise.all([
      lead?.stageId ? Stage.findOne({ tenantId, _id: lead.stageId }).select('name').lean() : null,
      SiteVisit.findOne({ tenantId, leadId: claim.leadId }).sort({ scheduledAt: -1 })
        .select('status scheduledAt').lean(),
      Booking.findOne({ tenantId, leadId: claim.leadId }).select('status bookingNumber').lean(),
    ]);
    return {
      claim,
      visible: partnerLeads.partnerVisibleLead({ lead: lead || {}, stage, visit, booking }),
    };
  }));

  return { rows, total, page: Number(page), pages: Math.ceil(total / limit) || 1, limit };
}

/** §271: the partner's bookings — customer, project, status, commission. */
async function bookings({ session }) {
  const { tenantId } = session.portalUser;
  const scope = memberScope(session);
  const rows = await Booking.find({
    tenantId,
    channelPartnerId: session.partner._id,
    ...(scope ? { channelPartnerMemberId: scope } : {}),
  })
    .sort({ bookingDate: -1 })
    .select('bookingNumber bookingDate finalPriceMinor totalReceivedMinor scheduledTotalMinor status contactId projectId unitId')
    .populate('projectId', 'name')
    .populate('unitId', 'unitNumber')
    .lean();

  return Promise.all(rows.map(async (booking) => {
    const [contact, entitlement] = await Promise.all([
      Contact.findOne({ tenantId, _id: booking.contactId }).select('displayName').lean(),
      PartnerCommissionEntitlement.findOne({
        tenantId, bookingId: booking._id, channelPartnerId: session.partner._id,
      }).lean(),
    ]);
    const basis = booking.scheduledTotalMinor || booking.finalPriceMinor || 0;
    const collectedPct = basis ? Math.round(((booking.totalReceivedMinor || 0) / basis) * 100) : 0;
    const threshold = entitlement?.commissionRuleSnapshot?.collectionThresholdPct;
    return {
      // §271: customer name, project, unit, date, status, commission status.
      // Deliberately no KYC, no collection notes, no receipt history.
      bookingNumber: booking.bookingNumber,
      bookingDate: booking.bookingDate,
      customerName: contact?.displayName,
      project: booking.projectId?.name,
      unit: booking.unitId?.unitNumber,
      bookingValueMinor: booking.finalPriceMinor,
      status: booking.status,
      commission: entitlement ? {
        status: entitlement.status,
        calculatedMinor: entitlement.calculatedCommissionMinor,
        eligibleMinor: entitlement.eligibleAmountMinor,
        invoicedMinor: entitlement.invoicedAmountMinor,
        paidMinor: entitlement.paidAmountMinor,
        rule: entitlement.commissionRuleSnapshot?.description,
        // §271: the collection figure only when their own commission turns on it.
        progress: threshold ? { collectedPct, requiredPct: threshold } : null,
      } : null,
    };
  }));
}

/** §311: the company team table. Company admins only. */
async function teamPerformance({ session }) {
  if (!session.isCompanyAdmin) throw forbidden('Only a company administrator can see team performance.');
  const { tenantId } = session.portalUser;
  const partnerId = session.partner._id;

  const [members, claims, bookings] = await Promise.all([
    ChannelPartnerMember.find({ tenantId, channelPartnerId: partnerId }).lean(),
    PartnerLeadClaim.find({ tenantId, channelPartnerId: partnerId, status: 'ACCEPTED' })
      .select('channelPartnerMemberId leadId').lean(),
    Booking.find({ tenantId, channelPartnerId: partnerId })
      .select('channelPartnerMemberId finalPriceMinor leadId').lean(),
  ]);
  const leadIds = claims.map((c) => c.leadId).filter(Boolean);
  const visits = await SiteVisit.find({ tenantId, leadId: { $in: leadIds }, status: 'COMPLETED' })
    .select('leadId').lean();
  const visitedLeads = new Set(visits.map((v) => String(v.leadId)));

  const row = (id, name) => {
    const mine = claims.filter((c) => String(c.channelPartnerMemberId || '') === String(id || ''));
    const myBookings = bookings.filter((b) => String(b.channelPartnerMemberId || '') === String(id || ''));
    return {
      name,
      leads: mine.length,
      visits: mine.filter((c) => visitedLeads.has(String(c.leadId))).length,
      bookings: myBookings.length,
      bookingValueMinor: myBookings.reduce((sum, b) => sum + (b.finalPriceMinor || 0), 0),
    };
  };
  // §219: an inactive member still appears — their history is company history.
  return [
    ...members.map((m) => ({ ...row(m._id, m.name), active: m.active })),
    { ...row(null, 'Company (unattributed)'), active: true },
  ].filter((r) => r.leads || r.bookings);
}

/** §30/§312: per-project performance for this partner. */
async function projectPerformance({ session }) {
  const { tenantId } = session.portalUser;
  const partnerId = session.partner._id;
  const [empanelments, claims, bookings, entitlements] = await Promise.all([
    PartnerProjectEmpanelment.find({ tenantId, channelPartnerId: partnerId })
      .populate('projectId', 'name').lean(),
    PartnerLeadClaim.find({ tenantId, channelPartnerId: partnerId, status: 'ACCEPTED' })
      .select('projectId leadId').lean(),
    Booking.find({ tenantId, channelPartnerId: partnerId }).select('projectId finalPriceMinor').lean(),
    PartnerCommissionEntitlement.find({ tenantId, channelPartnerId: partnerId })
      .select('projectId calculatedCommissionMinor').lean(),
  ]);
  const leadIds = claims.map((c) => c.leadId).filter(Boolean);
  const visits = await SiteVisit.find({ tenantId, leadId: { $in: leadIds }, status: 'COMPLETED' }).select('leadId').lean();
  const visited = new Set(visits.map((v) => String(v.leadId)));

  return empanelments.map((e) => {
    const projectId = String(e.projectId?._id || e.projectId);
    const mine = claims.filter((c) => String(c.projectId) === projectId);
    const myBookings = bookings.filter((b) => String(b.projectId) === projectId);
    return {
      project: e.projectId?.name || 'Project',
      status: e.status,
      effectiveTo: e.effectiveTo,
      leads: mine.length,
      visits: mine.filter((c) => visited.has(String(c.leadId))).length,
      bookings: myBookings.length,
      bookingValueMinor: myBookings.reduce((sum, b) => sum + (b.finalPriceMinor || 0), 0),
      commissionMinor: entitlements.filter((x) => String(x.projectId) === projectId)
        .reduce((sum, x) => sum + x.calculatedCommissionMinor, 0),
    };
  });
}

/** §25/§31: the projects this partner may actually submit against, right now. */
async function submittableProjects({ session, now = new Date() }) {
  const { tenantId } = session.portalUser;
  const settings = session.tenant.settings || {};
  if (!settings.cpRequireProjectEmpanelment) {
    return Project.find({ tenantId, archived: { $ne: true }, channelPartnerEnabled: { $ne: false } })
      .select('name').sort({ name: 1 }).lean();
  }
  const empanelments = await PartnerProjectEmpanelment.find({
    tenantId, channelPartnerId: session.partner._id, status: 'APPROVED',
  }).populate('projectId', 'name channelPartnerEnabled archived').lean();

  return empanelments
    .filter((e) => {
      if (!e.projectId || e.projectId.archived || e.projectId.channelPartnerEnabled === false) return false;
      if (e.effectiveFrom && e.effectiveFrom > now) return false;
      if (e.effectiveTo && e.effectiveTo < now) return false;
      return true;
    })
    .map((e) => ({ _id: e.projectId._id, name: e.projectId.name }));
}

module.exports = {
  login, activate, loadSession, memberScope, dashboard, leads, bookings,
  teamPerformance, projectPerformance, submittableProjects,
};
