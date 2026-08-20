const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { scopeFilter, can } = require('../lib/access');
const { forbidden, badRequest } = require('../lib/errors');
const { Project, User, Stage, LeadSource, Contact, Lead, Unit } = require('../db/models');
const reports = require('../services/reports');
const ai = require('../services/ai');
const audit = require('../services/audit');
const money = require('../lib/money');
const tz = require('../lib/tz');

/** Spec §43 reports, §8.5 management view, §46 search, §76 export, §42 AI. */
const router = express.Router();
router.use('/app/reports', requireAuth);
router.use('/app/search', requireAuth);
router.use('/api/ai', requireAuth);

const REPORTS = ['leads', 'sales', 'projects', 'campaigns', 'activities'];

async function commonFilters(req) {
  const [projects, users, stages, sources] = await Promise.all([
    Project.find({ tenantId: req.tenantId, archived: { $ne: true } }).select('name').sort({ name: 1 }).lean(),
    User.find({ tenantId: req.tenantId }).select('name').sort({ name: 1 }).lean(),
    Stage.find({ tenantId: req.tenantId }).select('name').sort({ displayOrder: 1 }).lean(),
    LeadSource.find({ tenantId: req.tenantId, active: true }).select('name').sort({ name: 1 }).lean(),
  ]);
  return { projects, users, stages, sources };
}

router.get('/app/reports', requirePermission('report.view'), (req, res) => res.redirect('/app/reports/leads'));

/* ------------------- V2 §168–§170: post-booking reports ------------------- */

/**
 * These sit on their own permissions (`booking.report` / `collection.report`)
 * rather than on `report.view`, because a collections user needs the money
 * reports without being handed the whole sales pipeline (§276).
 */
/** V2 §51/§260: the channel partner report family. */
const CP_REPORTS = {
  'channel-partners': { title: 'Channel partner performance', run: 'performanceReport' },
  'cp-invoices': { title: 'Channel partner invoices', run: 'invoiceReport' },
};

for (const [kind, meta] of Object.entries(CP_REPORTS)) {
  router.get(`/app/reports/${kind}`, requirePermission('cp.report.view'), async (req, res, next) => {
    try {
      const partnerReports = require('../services/partnerReports');
      const { ChannelPartner } = require('../db/models');
      const [data, projects, partners] = await Promise.all([
        partnerReports[meta.run]({ tenantId: req.tenantId, query: req.query, zone: res.locals.zone }),
        Project.find({ tenantId: req.tenantId, archived: { $ne: true } }).select('name').sort({ name: 1 }).lean(),
        ChannelPartner.find({ tenantId: req.tenantId }).select('profile partnerCode').lean(),
      ]);
      res.render(`pages/reports/${kind}`, { title: `${meta.title} report`, kind, data, projects, partners });
    } catch (err) { next(err); }
  });

  router.get(`/app/reports/${kind}/export`, requirePermission('cp.report.view'), async (req, res, next) => {
    try {
      const partnerReports = require('../services/partnerReports');
      const data = await partnerReports[meta.run]({
        tenantId: req.tenantId, query: req.query, zone: res.locals.zone,
      });
      const fmt = (minor) => (minor == null ? '' : money.toMajor(minor));
      const csv = kind === 'channel-partners'
        ? reports.toCsv(data.rows, [
          { label: 'Partner', value: (r) => r.name },
          { label: 'Type', value: (r) => r.partnerType },
          { label: 'City', value: (r) => r.city },
          { label: 'Status', value: (r) => r.status },
          { label: 'RERA status', value: (r) => r.reraStatus },
          { label: 'RERA expiry', value: (r) => (r.reraExpiryDate ? tz.formatDate(r.reraExpiryDate, res.locals.zone) : '') },
          { label: 'Leads', value: (r) => r.leads },
          { label: 'Connected', value: (r) => r.connected },
          { label: 'Visits', value: (r) => r.visits },
          { label: 'Blocks', value: (r) => r.blocks },
          { label: 'Bookings', value: (r) => r.bookings },
          { label: 'Booking value', value: (r) => fmt(r.bookingValueMinor) },
          { label: 'Lead to visit %', value: (r) => r.leadToVisit },
          { label: 'Visit to booking %', value: (r) => r.visitToBooking },
          { label: 'Lead to booking %', value: (r) => r.leadToBooking },
          // §206: four columns, never one.
          { label: 'Commission accrued', value: (r) => fmt(r.accruedMinor) },
          { label: 'Commission eligible', value: (r) => fmt(r.eligibleMinor) },
          { label: 'Commission invoiced', value: (r) => fmt(r.invoicedMinor) },
          { label: 'Commission paid', value: (r) => fmt(r.paidMinor) },
        ])
        : reports.toCsv(data.rows, [
          { label: 'Invoice ref', value: (r) => r.invoiceRef },
          { label: 'Invoice number', value: (r) => r.invoiceNumber },
          { label: 'Partner', value: (r) => r.partnerName },
          { label: 'Invoice date', value: (r) => (r.invoiceDate ? tz.formatDate(r.invoiceDate, res.locals.zone) : '') },
          { label: 'Submitted', value: (r) => (r.submittedAt ? tz.formatDate(r.submittedAt, res.locals.zone) : '') },
          { label: 'Taxable value', value: (r) => fmt(r.taxableValueMinor) },
          { label: 'GST', value: (r) => fmt(r.gstAmountMinor) },
          { label: 'Total', value: (r) => fmt(r.invoiceTotalMinor) },
          { label: 'Paid', value: (r) => fmt(r.paidAmountMinor) },
          { label: 'Outstanding', value: (r) => fmt(r.outstandingMinor) },
          { label: 'Status', value: (r) => r.status },
        ]);

      await audit.record({
        tenantId: req.tenantId, actor: req.user, entity: 'Report', action: 'EXPORT',
        after: { kind, filters: req.query, rows: data.rows.length }, req,
      });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${kind}-report.csv"`);
      res.send(csv);
    } catch (err) { next(err); }
  });
}

const POST_BOOKING_REPORTS = {
  bookings: { permission: 'booking.report', title: 'Bookings & KYC', run: 'bookingReport' },
  collections: { permission: 'collection.report', title: 'Collections', run: 'collectionReport' },
  'collection-performance': { permission: 'collection.report', title: 'Collection performance', run: 'collectionPerformanceReport' },
};

async function postBookingArgs(req, res) {
  const postBookingReports = require('../services/postBookingReports');
  const scope = await postBookingReports.scopeFor({ user: req.user });
  if (!scope) throw forbidden('You do not have permission to view this report.');
  return {
    args: { tenantId: req.tenantId, query: req.query, zone: res.locals.zone, scope },
    postBookingReports,
  };
}

for (const [kind, meta] of Object.entries(POST_BOOKING_REPORTS)) {
  router.get(`/app/reports/${kind}`, requirePermission(meta.permission), async (req, res, next) => {
    try {
      const { args, postBookingReports } = await postBookingArgs(req, res);
      const data = await postBookingReports[meta.run](args);
      const [projects, users] = await Promise.all([
        Project.find({ tenantId: req.tenantId, archived: { $ne: true } }).select('name').sort({ name: 1 }).lean(),
        User.find({ tenantId: req.tenantId }).select('name').sort({ name: 1 }).lean(),
      ]);
      res.render(`pages/reports/${kind}`, {
        title: `${meta.title} report`, kind, data, projects, users,
      });
    } catch (err) { next(err); }
  });

  /** §321/§76: exports carry the same filters, the same scope, and an audit row. */
  router.get(`/app/reports/${kind}/export`, requirePermission(meta.permission), async (req, res, next) => {
    try {
      const { args, postBookingReports } = await postBookingArgs(req, res);
      const data = await postBookingReports[meta.run](args);
      const fmt = (minor) => (minor == null ? '' : money.toMajor(minor));
      const date = (value) => (value ? tz.formatDate(value, res.locals.zone) : '');
      let csv;

      if (kind === 'bookings') {
        csv = reports.toCsv(data.rows, [
          { label: 'Booking no.', value: (r) => r.bookingNumber },
          { label: 'Customer', value: (r) => r.contactId?.displayName },
          { label: 'Mobile', value: (r) => r.contactId?.primaryMobile },
          { label: 'Project', value: (r) => r.projectId?.name },
          { label: 'Unit', value: (r) => r.unitId?.unitNumber },
          { label: 'Booking date', value: (r) => date(r.bookingDate) },
          { label: 'Booking value', value: (r) => fmt(r.finalPriceMinor) },
          { label: 'Quotation', value: (r) => r.costSheetId?.quotationNumber },
          { label: 'Payment plan', value: (r) => r.paymentPlanName },
          // §321: a KYC *status* may be exported; a KYC document never can.
          { label: 'KYC status', value: (r) => r.kycStatus },
          { label: 'Collected', value: (r) => fmt(r.totalReceivedMinor) },
          { label: 'Outstanding', value: (r) => fmt(r.outstandingMinor) },
          { label: 'Next due', value: (r) => date(r.nextDueAt) },
          { label: 'Overdue', value: (r) => fmt(r.overdueMinor) },
          { label: 'Salesperson', value: (r) => r.salespersonId?.name },
          { label: 'Collection owner', value: (r) => r.collectionOwnerUserId?.name },
        ]);
      } else if (kind === 'collections') {
        csv = reports.toCsv(data.rows, [
          { label: 'Booking no.', value: (r) => r.booking?.bookingNumber },
          { label: 'Customer', value: (r) => r.booking?.contactId?.displayName },
          { label: 'Project', value: (r) => r.booking?.projectId?.name },
          { label: 'Unit', value: (r) => r.booking?.unitId?.unitNumber },
          { label: 'Seq', value: (r) => r.sequence },
          { label: 'Milestone', value: (r) => r.milestone },
          { label: 'Scheduled', value: (r) => fmt(r.scheduledAmountMinor) },
          { label: 'Due date', value: (r) => (r.dueDate ? date(r.dueDate) : 'TBD') },
          { label: 'Received', value: (r) => fmt(r.amountReceivedMinor) },
          { label: 'Outstanding', value: (r) => fmt(r.outstandingMinor) },
          { label: 'Status', value: (r) => r.status },
          { label: 'Overdue days', value: (r) => r.overdueDays },
          { label: 'Aging', value: (r) => r.aging },
          { label: 'Collection owner', value: (r) => r.booking?.collectionOwnerUserId?.name },
        ]);
      } else {
        csv = reports.toCsv(data.rows, [
          { label: 'Collection owner', value: (r) => r.owner },
          { label: 'Bookings', value: (r) => r.bookings },
          { label: 'Scheduled', value: (r) => fmt(r.scheduledMinor) },
          { label: 'Received', value: (r) => fmt(r.receivedMinor) },
          { label: 'Collection %', value: (r) => r.collectionPct },
          { label: 'Outstanding', value: (r) => fmt(r.outstandingMinor) },
          { label: 'Overdue', value: (r) => fmt(r.overdueMinor) },
          { label: 'Received in range', value: (r) => fmt(r.receiptsInRangeMinor) },
          { label: 'Follow-ups completed', value: (r) => r.followupsCompleted },
          { label: 'Follow-ups missed', value: (r) => r.followupsMissed },
          { label: 'Promises', value: (r) => r.promises },
          { label: 'Promises kept %', value: (r) => r.ptpFulfilledPct },
          { label: 'Payment links', value: (r) => r.paymentLinks },
        ]);
      }

      await audit.record({
        tenantId: req.tenantId, actor: req.user, entity: 'Report', action: 'EXPORT',
        after: { kind, filters: req.query, rows: data.rows.length }, req,
      });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${kind}-report.csv"`);
      res.send(csv);
    } catch (err) { next(err); }
  });
}

router.get('/app/reports/:kind', requirePermission('report.view'), async (req, res, next) => {
  try {
    const kind = req.params.kind;
    if (!REPORTS.includes(kind)) return next();

    // §43: a report never shows more than the user's data scope allows (§6.3).
    const scope = await scopeFilter(req.user, 'report.view');
    if (!scope) throw forbidden('You do not have permission to view reports.');

    const args = { tenantId: req.tenantId, tenant: req.tenant, query: req.query, zone: res.locals.zone, scope };
    const data = await {
      leads: () => reports.leadReport(args),
      sales: () => reports.salesReport(args),
      projects: () => reports.projectReport(args),
      campaigns: () => reports.campaignReport(args),
      activities: () => reports.activityReport(args),
    }[kind]();

    res.render(`pages/reports/${kind}`, {
      title: `${kind[0].toUpperCase()}${kind.slice(1)} report`,
      kind,
      data,
      ...(await commonFilters(req)),
    });
  } catch (err) { next(err); }
});

/** §76: exports respect the same scope and filters, and are audited. */
router.get('/app/reports/:kind/export', requirePermission('report.export'), async (req, res, next) => {
  try {
    const kind = req.params.kind;
    if (!REPORTS.includes(kind)) throw badRequest('Unknown report.');
    const scope = await scopeFilter(req.user, 'report.view');
    if (!scope) throw forbidden('You do not have permission to export reports.');

    const args = { tenantId: req.tenantId, tenant: req.tenant, query: req.query, zone: res.locals.zone, scope };
    const fmt = (minor) => (minor == null ? '' : money.toMajor(minor));
    let csv;

    if (kind === 'leads') {
      const { rows } = await reports.leadReport(args);
      csv = reports.toCsv(rows, [
        { label: 'Lead ID', value: (r) => r._id },
        { label: 'Contact', value: (r) => r.contactId?.displayName },
        { label: 'Mobile', value: (r) => r.contactId?.primaryMobile },
        { label: 'Project', value: (r) => r.projectId?.name },
        { label: 'Owner', value: (r) => r.ownerUserId?.name },
        { label: 'Stage', value: (r) => r.stageId?.name },
        { label: 'Sub-stage', value: (r) => r.subStageId?.name },
        // V1.1 §99
        { label: 'Temperature', value: (r) => (r.status === 'ACTIVE' ? r.temperature : '') },
        { label: 'Temperature mode', value: (r) => (r.status === 'ACTIVE' ? r.temperatureMode : '') },
        { label: 'Purchase timeline', value: (r) => r.purchaseTimeline },
        { label: 'Funding', value: (r) => r.fundingType },
        { label: 'Next action', value: (r) => r.nextActionTypeId?.name },
        { label: 'Next action due', value: (r) => (r.nextActionAt ? tz.formatDate(r.nextActionAt, res.locals.zone) : '') },
        { label: 'Source', value: (r) => r.latestSourceId?.name },
        { label: 'First inquiry', value: (r) => tz.formatDate(r.firstInquiryAt, res.locals.zone) },
        { label: 'Latest inquiry', value: (r) => tz.formatDate(r.latestInquiryAt, res.locals.zone) },
        { label: 'First response (s)', value: (r) => r.firstResponseSeconds },
        { label: 'SLA', value: (r) => r.slaStatus },
        { label: 'Visits', value: (r) => r.completedVisitCount },
        { label: 'Shortlisted', value: (r) => r.shortlistCount },
        { label: 'Block status', value: (r) => r.blockStatus },
        { label: 'Booking value', value: (r) => fmt(r.bookingValueMinor) },
      ]);
    } else if (kind === 'sales') {
      const { rows } = await reports.salesReport(args);
      csv = reports.toCsv(rows, [
        { label: 'User', value: (r) => r.name },
        { label: 'Leads', value: (r) => r.leads },
        { label: 'Median response (s)', value: (r) => r.medianResponseSeconds },
        { label: 'SLA compliance %', value: (r) => r.slaCompliancePct },
        { label: 'Follow-ups due', value: (r) => r.followupsDue },
        { label: 'Completed', value: (r) => r.followupsCompleted },
        { label: 'Missed', value: (r) => r.followupsMissed },
        { label: 'Discipline %', value: (r) => r.followupDisciplinePct },
        { label: 'Visits completed', value: (r) => r.visitsCompleted },
        // V1.1 §99: the shape of the book, alongside the execution numbers.
        { label: 'Hot active', value: (r) => r.hot },
        { label: 'Warm active', value: (r) => r.warm },
        { label: 'Cold active', value: (r) => r.cold },
        { label: 'Blocks', value: (r) => r.blocks },
        { label: 'Bookings', value: (r) => r.bookings },
        { label: 'Revenue', value: (r) => fmt(r.revenueMinor) },
        { label: 'Lead to booking %', value: (r) => r.leadToBookingPct },
      ]);
    } else if (kind === 'projects') {
      const { rows } = await reports.projectReport(args);
      csv = reports.toCsv(rows, [
        { label: 'Project', value: (r) => r.project.name },
        { label: 'Leads', value: (r) => r.leads },
        { label: 'Connected', value: (r) => r.connected },
        { label: 'Visits', value: (r) => r.visits },
        { label: 'Blocks', value: (r) => r.blocks },
        { label: 'Bookings', value: (r) => r.bookings },
        { label: 'Revenue', value: (r) => fmt(r.revenueMinor) },
        { label: 'Available units', value: (r) => r.available },
        { label: 'Blocked units', value: (r) => r.blockedUnits },
        { label: 'Booked units', value: (r) => r.bookedUnits },
      ]);
    } else if (kind === 'campaigns') {
      const { rows, attributionModel } = await reports.campaignReport(args);
      csv = reports.toCsv(rows, [
        { label: 'Campaign', value: (r) => r.name },
        { label: 'Platform', value: (r) => r.platform },
        { label: 'Attribution model', value: () => attributionModel },
        { label: 'Spend', value: (r) => fmt(r.spendMinor) },
        { label: 'Leads', value: (r) => r.leads },
        { label: 'CPL', value: (r) => fmt(r.cplMinor) },
        { label: 'Visits', value: (r) => r.visits },
        { label: 'Cost per visit', value: (r) => fmt(r.costPerVisitMinor) },
        { label: 'Bookings', value: (r) => r.bookings },
        { label: 'Cost per booking', value: (r) => fmt(r.costPerBookingMinor) },
        { label: 'Revenue', value: (r) => fmt(r.revenueMinor) },
        { label: 'ROAS', value: (r) => r.roas },
      ]);
    } else {
      const data = await reports.activityReport(args);
      csv = reports.toCsv(data.byType, [
        { label: 'Activity type', value: (r) => r.type },
        { label: 'Count', value: (r) => r.count },
      ]);
    }

    await audit.record({
      tenantId: req.tenantId, actor: req.user, entity: 'Report', action: 'EXPORT',
      after: { report: kind, filters: req.query }, req,
    });
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${kind}-report.csv"`);
    res.send(csv);
  } catch (err) { next(err); }
});

/** §8.5: the management outcome view. */
router.get('/app/dashboard/management', requireAuth, requirePermission('dashboard.management'), async (req, res, next) => {
  try {
    const summary = await reports.managementSummary({
      tenantId: req.tenantId, tenant: req.tenant, zone: res.locals.zone, query: req.query,
    });
    res.render('pages/dashboard/management', { title: 'Management', ...summary });
  } catch (err) { next(err); }
});

/** §46: global search across the things a salesperson actually looks up. */
router.get('/app/search', async (req, res, next) => {
  try {
    const term = String(req.query.q || '').trim();
    if (!term) return res.render('pages/search', { title: 'Search', term, results: null });

    const phone = require('../lib/phone');
    const normalized = phone.normalizeMobile(term, req.tenant?.callingCode);
    const rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    const contactScope = await scopeFilter(req.user, 'contact.view');
    const leadScope = await scopeFilter(req.user, 'lead.view');

    const [contacts, leads, projects, units] = await Promise.all([
      contactScope
        ? Contact.find({
          tenantId: req.tenantId,
          ...contactScope,
          $or: [
            { displayName: rx }, { email: rx }, { primaryMobile: rx },
            ...(normalized ? [{ normalizedMobile: normalized }] : []),
          ],
        }).limit(10).select('displayName primaryMobile email city').lean()
        : [],
      leadScope && /^[a-f\d]{24}$/i.test(term)
        ? Lead.find({ tenantId: req.tenantId, ...leadScope, _id: term })
          .populate('contactId', 'displayName').populate('stageId', 'name').limit(5).lean()
        : [],
      can(req.user, 'project.view')
        ? Project.find({ tenantId: req.tenantId, name: rx }).limit(5).select('name city status').lean()
        : [],
      can(req.user, 'inventory.view')
        ? Unit.find({ tenantId: req.tenantId, unitNumber: rx }).limit(10)
          .populate('projectId', 'name').select('unitNumber status projectId').lean()
        : [],
    ]);

    // Leads for the matched contacts, so searching a mobile lands on the work.
    const contactLeads = contacts.length && leadScope
      ? await Lead.find({ tenantId: req.tenantId, ...leadScope, contactId: { $in: contacts.map((c) => c._id) } })
        .populate('contactId', 'displayName').populate('stageId', 'name').populate('projectId', 'name').limit(10).lean()
      : [];

    res.render('pages/search', {
      title: `Search: ${term}`,
      term,
      results: { contacts, leads: [...leads, ...contactLeads], projects, units },
    });
  } catch (err) { next(err); }
});

/* ------------------------- V1.1 §5: search suggestions -------------------- */

/**
 * `GET /api/search?q=` — the dashboard lookup a salesperson uses while the phone
 * is still ringing (§5.2).
 *
 * The one deliberate widening of data scope in the product: an **exact** normalized
 * mobile is matched tenant-wide (§5.4), because "does this customer already exist
 * and who owns them" has to be answerable or the team creates duplicate contacts.
 * It does not widen access — a lead outside the caller's scope comes back as
 * `OWNERSHIP_ONLY` carrying only name, project, stage and owner (§5.6), never the
 * timeline, notes, pricing, requirement or source history.
 *
 * Fuzzy name/email/project/unit search keeps normal scope (§5.4).
 */
router.get('/api/search', requireAuth, async (req, res, next) => {
  try {
    const term = String(req.query.q || '').trim();
    const phone = require('../lib/phone');
    const digits = term.replace(/\D/g, '');
    const normalized = digits.length >= 4 ? phone.normalizeMobile(term, req.tenant?.callingCode) : null;
    const isMobileLookup = !!normalized && digits.length >= 4;

    // §5.3: don't fire on every keystroke.
    if (!isMobileLookup && term.length < 2) return res.json({ query: term, results: [] });

    const leadScope = await scopeFilter(req.user, 'lead.view');
    const contactScope = await scopeFilter(req.user, 'contact.view');
    const canEdit = can(req.user, 'lead.edit');

    const accessFor = async (lead) => {
      const ownerId = lead.ownerUserId?._id || lead.ownerUserId;
      const { canActOn } = require('../lib/access');
      const visible = await canActOn(req.user, 'lead.view', ownerId)
        || (!ownerId && scopeOfLead(req.user) !== 'own');
      if (!visible) return 'OWNERSHIP_ONLY';
      return canEdit ? 'EDIT' : 'READ';
    };

    let leads = [];
    if (isMobileLookup) {
      // Exact identity match, tenant-wide (§5.4).
      const contacts = await Contact.find({
        tenantId: req.tenantId,
        $or: [{ normalizedMobile: normalized }, { normalizedAltMobile: normalized }],
      }).select('displayName primaryMobile normalizedMobile').limit(5).lean();

      if (contacts.length) {
        leads = await Lead.find({ tenantId: req.tenantId, contactId: { $in: contacts.map((c) => c._id) } })
          .sort({ latestInquiryAt: -1 })
          .limit(10)
          .populate('contactId', 'displayName primaryMobile normalizedMobile')
          .populate('projectId', 'name')
          .populate('stageId', 'name semanticType')
          .populate('subStageId', 'name')
          .populate('ownerUserId', 'name')
          .lean();
      }
    } else if (leadScope) {
      const rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const matched = contactScope
        ? await Contact.find({ tenantId: req.tenantId, ...contactScope, displayName: rx })
          .select('_id').limit(20).lean()
        : [];
      if (matched.length) {
        leads = await Lead.find({
          tenantId: req.tenantId, ...leadScope, contactId: { $in: matched.map((c) => c._id) },
        })
          .sort({ latestInquiryAt: -1 })
          .limit(10)
          .populate('contactId', 'displayName primaryMobile normalizedMobile')
          .populate('projectId', 'name')
          .populate('stageId', 'name semanticType')
          .populate('subStageId', 'name')
          .populate('ownerUserId', 'name')
          .lean();
      }
    }

    const results = [];
    for (const lead of leads) {
      const access = await accessFor(lead);
      const base = {
        type: 'lead',
        leadId: String(lead._id),
        contactName: lead.contactId?.displayName || 'Unknown',
        mobile: lead.contactId?.normalizedMobile || '',
        projectName: lead.projectId?.name || null,
        stage: lead.stageId?.name || null,
        owner: lead.ownerUserId
          ? { id: String(lead.ownerUserId._id), name: lead.ownerUserId.name }
          : null,
        access,
      };
      // §5.6: an out-of-scope lead reveals ownership and nothing else.
      results.push(access === 'OWNERSHIP_ONLY' ? base : {
        ...base,
        subStage: lead.subStageId?.name || null,
        temperature: lead.status === 'TERMINAL' ? null : lead.temperature,
        isNew: lead.status === 'ACTIVE' && !lead.firstGenuineActionAt,
        reinquiry: !!lead.reinquiryPendingAt,
        latestInquiryAt: lead.latestInquiryAt,
        nextActionAt: lead.nextActionAt || null,
        status: lead.status,
      });
    }

    // §5.8: nothing found on a real mobile → offer capture with it prefilled.
    res.json({
      query: term,
      normalizedMobile: normalized || undefined,
      results,
      createLeadHref: isMobileLookup && !results.length && can(req.user, 'lead.create')
        ? `/app/leads/new?mobile=${encodeURIComponent(digits)}`
        : undefined,
    });
  } catch (err) { next(err); }
});

const scopeOfLead = (user) => require('../lib/access').scopeOf(user, 'lead.view');

/* ----------------------------------- AI ---------------------------------- */

/** §42: assistive endpoints. Every one is read-only by construction (§42.7). */
router.get('/api/ai/leads/:id/summary', requirePermission('lead.view'), async (req, res, next) => {
  try {
    await assertLeadVisible(req);
    const summary = await ai.summarize({
      tenantId: req.tenantId, leadId: req.params.id, zone: res.locals.zone,
      currency: req.tenant.currency, locale: req.tenant.locale,
    });
    res.json({ ok: true, ...summary });
  } catch (err) { next(err); }
});

router.get('/api/ai/leads/:id/next-action', requirePermission('lead.view'), async (req, res, next) => {
  try {
    await assertLeadVisible(req);
    res.json({ ok: true, ...(await ai.suggestNextAction({ tenantId: req.tenantId, leadId: req.params.id })) });
  } catch (err) { next(err); }
});

router.get('/api/ai/leads/:id/priority', requirePermission('lead.view'), async (req, res, next) => {
  try {
    await assertLeadVisible(req);
    res.json({ ok: true, ...(await ai.priority({ tenantId: req.tenantId, leadId: req.params.id })) });
  } catch (err) { next(err); }
});

router.get('/api/ai/leads/:id/units', requirePermission('lead.view'), async (req, res, next) => {
  try {
    await assertLeadVisible(req);
    const result = await ai.recommendUnits({
      tenantId: req.tenantId,
      leadId: req.params.id,
      canSeePrices: can(req.user, 'inventory.view_prices'),
    });
    res.json({ ok: true, ...result });
  } catch (err) { next(err); }
});

router.get('/api/ai/ask', requirePermission('project.view'), async (req, res, next) => {
  try {
    const result = await ai.answer({
      tenantId: req.tenantId,
      question: req.query.q,
      projectId: req.query.projectId,
      currency: req.tenant.currency,
      locale: req.tenant.locale,
      zone: res.locals.zone,
      canSeePrices: can(req.user, 'inventory.view_prices'),
    });
    res.json({ ok: true, ...result });
  } catch (err) { next(err); }
});

/** §108: the assistant sees exactly what the asking user may see. */
async function assertLeadVisible(req) {
  const leadsService = require('../services/leads');
  const lead = await leadsService.get({ tenantId: req.tenantId, leadId: req.params.id });
  await leadsService.assertCanView(req.user, lead);
  return lead;
}

module.exports = router;
