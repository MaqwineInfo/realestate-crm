const {
  Lead, Followup, Activity, SiteVisit, UnitBlock, Booking, Unit, User, Project,
  Contact, MessageLog, CostSheet,
} = require('../db/models');
const tz = require('../lib/tz');
const attribution = require('./attribution');

/**
 * Spec §43 + §44 + §92: five reports, no more (§111 "too many report types").
 *
 * Two rules shape every function here. Metric definitions come straight from
 * §92/§93 so a number always means one thing; and every metric returns the ids
 * behind it, so §118's "click the number, see the records" works from the same
 * query that produced the number.
 */

function rangeFor({ from, to, zone }) {
  const start = from ? tz.fromLocalInput(from, '00:00', zone) : tz.addLocalDays(new Date(), -30, zone);
  // The default range ends at the end of today in the tenant's timezone, not at
  // this instant. A booking dated today sits at midday; ending the range at "now"
  // hid every one of them from the morning reports.
  const end = to ? tz.fromLocalInput(to, '23:59', zone) : tz.endOfDay(new Date(), zone);
  return { start, end };
}

/** §43.1 filters, shared by every report. */
function leadFilter({ tenantId, query = {}, zone, scope = {} }) {
  const { start, end } = rangeFor({ from: query.from, to: query.to, zone });
  const filter = { tenantId, ...scope, firstInquiryAt: { $gte: start, $lte: end } };
  if (query.projectId) filter.projectId = query.projectId;
  if (query.ownerUserId) filter.ownerUserId = query.ownerUserId;
  if (query.stageId) filter.stageId = query.stageId;
  if (query.sourceId) filter.latestSourceId = query.sourceId;
  if (query.campaignId) filter.campaignId = query.campaignId;
  if (query.purpose) filter.purpose = query.purpose;
  if (query.status) filter.status = query.status;
  // V1.1 §99: temperature is a reporting dimension, not just a badge.
  if (query.temperature) filter.temperature = query.temperature;
  if (query.subStageId && query.stageId) filter.subStageId = query.subStageId;
  return { filter, start, end };
}

/** §43.2 Lead report: one row per lead, with the journey attached. */
async function leadReport({ tenantId, query, zone, scope }) {
  const { filter, start, end } = leadFilter({ tenantId, query, zone, scope });

  const leads = await Lead.find(filter)
    .sort({ firstInquiryAt: -1 })
    .limit(1000)
    .populate('contactId', 'displayName primaryMobile city')
    .populate('projectId', 'name')
    .populate('ownerUserId', 'name')
    .populate('stageId', 'name')
    .populate('subStageId', 'name')
    .populate('latestSourceId', 'name')
    .populate('nextActionTypeId', 'name')
    .lean();

  const ids = leads.map((l) => l._id);
  const [blocks, bookings] = await Promise.all([
    UnitBlock.find({ tenantId, leadId: { $in: ids } }).select('leadId status').lean(),
    Booking.find({ tenantId, leadId: { $in: ids } }).select('leadId finalPriceMinor').lean(),
  ]);
  const blockByLead = new Map(blocks.map((b) => [String(b.leadId), b.status]));
  const bookingByLead = new Map(bookings.map((b) => [String(b.leadId), b]));

  const rows = leads.map((lead) => ({
    ...lead,
    blockStatus: blockByLead.get(String(lead._id)) || null,
    bookingValueMinor: bookingByLead.get(String(lead._id))?.finalPriceMinor || null,
  }));

  return { rows, range: { start, end }, total: rows.length };
}

/**
 * §43.3 Sales report + §44: execution and outcome per user.
 * Denominators follow §92 exactly.
 */
async function salesReport({ tenantId, query, zone, scope }) {
  const { filter, start, end } = leadFilter({ tenantId, query, zone, scope });
  const [leads, users] = await Promise.all([
    Lead.find(filter).select('ownerUserId firstResponseSeconds slaBreached firstGenuineActionAt completedVisitCount bookedAt slaTargetSeconds temperature status').lean(),
    User.find({ tenantId }).select('name status').lean(),
  ]);

  const leadIds = leads.map((l) => l._id);
  const [followups, visits, blocks, bookings] = await Promise.all([
    Followup.find({ tenantId, dueAt: { $gte: start, $lte: end } })
      .select('assignedUserId status completedOnTime').lean(),
    SiteVisit.find({ tenantId, leadId: { $in: leadIds } }).select('salesUserId status').lean(),
    UnitBlock.find({ tenantId, leadId: { $in: leadIds } }).select('blockedBy leadId').lean(),
    Booking.find({ tenantId, leadId: { $in: leadIds }, status: { $ne: 'CANCELLED' } })
      .select('salespersonId finalPriceMinor leadId').lean(),
  ]);

  const rows = new Map();
  const row = (userId) => {
    const key = String(userId || 'unassigned');
    if (!rows.has(key)) {
      rows.set(key, {
        userId: key,
        name: users.find((u) => String(u._id) === key)?.name || 'Unassigned',
        leads: 0, responded: 0, responseSecondsTotal: 0, responseSamples: [], slaWithin: 0, slaRequired: 0,
        followupsDue: 0, followupsCompleted: 0, followupsOnTime: 0, followupsMissed: 0,
        visitsPlanned: 0, visitsCompleted: 0, leadsWithVisit: new Set(),
        blocks: 0, bookings: 0, revenueMinor: 0,
        // V1.1 §99: the shape of a book, not a verdict on the salesperson.
        hot: 0, warm: 0, cold: 0,
      });
    }
    return rows.get(key);
  };

  for (const lead of leads) {
    const r = row(lead.ownerUserId);
    r.leads += 1;
    r.slaRequired += 1;
    if (lead.firstGenuineActionAt) {
      r.responded += 1;
      if (lead.firstResponseSeconds != null) r.responseSamples.push(lead.firstResponseSeconds);
      if (!lead.slaBreached) r.slaWithin += 1;
    }
    if (lead.completedVisitCount > 0) r.leadsWithVisit.add(String(lead._id));
    // §14.5: a closed lead has an outcome, not a temperature.
    if (lead.status === 'ACTIVE' && lead.temperature) r[lead.temperature.toLowerCase()] += 1;
  }
  for (const followup of followups) {
    const r = row(followup.assignedUserId);
    r.followupsDue += 1;
    if (followup.status === 'COMPLETED') {
      r.followupsCompleted += 1;
      if (followup.completedOnTime !== false) r.followupsOnTime += 1;
    }
    if (followup.status === 'MISSED') r.followupsMissed += 1;
  }
  for (const visit of visits) {
    const r = row(visit.salesUserId);
    r.visitsPlanned += 1;
    if (visit.status === 'COMPLETED') r.visitsCompleted += 1;
  }
  for (const block of blocks) row(block.blockedBy).blocks += 1;
  for (const booking of bookings) {
    const r = row(booking.salespersonId);
    r.bookings += 1;
    r.revenueMinor += booking.finalPriceMinor || 0;
  }

  const finished = [...rows.values()].map((r) => {
    const pct = (num, den) => (den > 0 ? Number(((num / den) * 100).toFixed(1)) : null);
    const sorted = [...r.responseSamples].sort((a, b) => a - b);
    return {
      ...r,
      leadsWithVisit: r.leadsWithVisit.size,
      // §92: median is the honest average for response time.
      medianResponseSeconds: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
      avgResponseSeconds: sorted.length ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : null,
      slaCompliancePct: pct(r.slaWithin, r.slaRequired),
      followupDisciplinePct: pct(r.followupsOnTime, r.followupsDue),
      leadToVisitPct: pct(r.leadsWithVisit.size, r.leads),
      visitToBookingPct: pct(r.bookings, r.leadsWithVisit.size),
      leadToBookingPct: pct(r.bookings, r.leads),
    };
  }).sort((a, b) => b.bookings - a.bookings || b.leads - a.leads);

  return { rows: finished, range: { start, end } };
}

/** §43.4 Project report: funnel plus live inventory. */
async function projectReport({ tenantId, query, zone, scope }) {
  const { filter, start, end } = leadFilter({ tenantId, query, zone, scope });
  const [projects, leads] = await Promise.all([
    Project.find({ tenantId, archived: { $ne: true } }).select('name city').lean(),
    Lead.find(filter).select('projectId firstGenuineActionAt completedVisitCount bookedAt').lean(),
  ]);

  const leadIds = leads.map((l) => l._id);
  const [blocks, bookings, units] = await Promise.all([
    UnitBlock.find({ tenantId, leadId: { $in: leadIds } }).select('projectId leadId').lean(),
    Booking.find({ tenantId, status: { $ne: 'CANCELLED' }, bookingDate: { $gte: start, $lte: end } })
      .select('projectId finalPriceMinor').lean(),
    Unit.aggregate([
      { $match: { tenantId: toObjectId(tenantId), active: true } },
      { $group: { _id: { project: '$projectId', status: '$status' }, count: { $sum: 1 } } },
    ]),
  ]);

  const rows = projects.map((project) => {
    const key = String(project._id);
    const own = leads.filter((l) => String(l.projectId) === key);
    const ownBookings = bookings.filter((b) => String(b.projectId) === key);
    const inventory = units.filter((u) => String(u._id.project) === key)
      .reduce((acc, u) => ({ ...acc, [u._id.status]: u.count }), {});
    const pct = (num, den) => (den > 0 ? Number(((num / den) * 100).toFixed(1)) : null);

    const visits = own.filter((l) => l.completedVisitCount > 0).length;
    const blocked = new Set(blocks.filter((b) => String(b.projectId) === key).map((b) => String(b.leadId))).size;
    const booked = own.filter((l) => l.bookedAt).length;
    const revenueMinor = ownBookings.reduce((sum, b) => sum + (b.finalPriceMinor || 0), 0);

    return {
      project,
      leads: own.length,
      connected: own.filter((l) => l.firstGenuineActionAt).length,
      visits,
      blocks: blocked,
      bookings: booked,
      revenueMinor,
      avgBookingValueMinor: ownBookings.length ? Math.round(revenueMinor / ownBookings.length) : 0,
      available: inventory.AVAILABLE || 0,
      blockedUnits: inventory.BLOCKED || 0,
      bookedUnits: (inventory.BOOKED || 0) + (inventory.REGISTERED || 0),
      leadToVisitPct: pct(visits, own.length),
      leadToBookingPct: pct(booked, own.length),
    };
  }).sort((a, b) => b.revenueMinor - a.revenueMinor);

  return { rows, range: { start, end } };
}

/** §43.5 Campaign report — the attribution service already computes it. */
const campaignReport = ({ tenantId, tenant, query, zone }) => attribution.performance({
  tenantId, tenant, from: query.from, to: query.to, projectId: query.projectId, zone,
});

/** §43.6 Activity report: what the team actually did. */
async function activityReport({ tenantId, query, zone, scope }) {
  const { start, end } = rangeFor({ from: query.from, to: query.to, zone });
  const match = { tenantId, at: { $gte: start, $lte: end } };
  if (query.ownerUserId) match.actorUserId = toObjectId(query.ownerUserId);

  const [byType, byUser, followups, visits, messages] = await Promise.all([
    Activity.aggregate([{ $match: match }, { $group: { _id: '$type', count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
    Activity.aggregate([
      { $match: { ...match, actorUserId: { $ne: null } } },
      { $group: { _id: '$actorUserId', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 20 },
    ]),
    Followup.aggregate([
      { $match: { tenantId: toObjectId(tenantId), dueAt: { $gte: start, $lte: end } } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    SiteVisit.aggregate([
      { $match: { tenantId: toObjectId(tenantId), scheduledAt: { $gte: start, $lte: end } } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    MessageLog.aggregate([
      { $match: { tenantId: toObjectId(tenantId), createdAt: { $gte: start, $lte: end } } },
      { $group: { _id: { channel: '$channel', status: '$status' }, count: { $sum: 1 } } },
    ]),
  ]);

  const users = await User.find({ tenantId, _id: { $in: byUser.map((u) => u._id) } }).select('name').lean();
  const nameById = new Map(users.map((u) => [String(u._id), u.name]));

  return {
    range: { start, end },
    byType: byType.map((r) => ({ type: r._id, count: r.count })),
    byUser: byUser.map((r) => ({ name: nameById.get(String(r._id)) || 'Unknown', count: r.count })),
    followups: Object.fromEntries(followups.map((r) => [r._id, r.count])),
    visits: Object.fromEntries(visits.map((r) => [r._id, r.count])),
    messages: messages.map((r) => ({ channel: r._id.channel, status: r._id.status, count: r.count })),
  };
}

/**
 * §8.5 management dashboard: the business outcome view.
 * Same numbers as the reports, assembled into the funnel §8.5 asks for.
 */
async function managementSummary({ tenantId, tenant, zone, query = {} }) {
  const { start, end } = rangeFor({ from: query.from, to: query.to, zone });

  const [leads, bookings, campaignPerf, projects, opportunities] = await Promise.all([
    Lead.find({ tenantId, firstInquiryAt: { $gte: start, $lte: end } })
      .select('firstGenuineActionAt completedVisitCount bookedAt projectId').lean(),
    Booking.find({ tenantId, status: { $ne: 'CANCELLED' }, bookingDate: { $gte: start, $lte: end } })
      .select('finalPriceMinor projectId').lean(),
    attribution.performance({ tenantId, tenant, from: query.from, to: query.to, zone }),
    projectReport({ tenantId, query, zone, scope: {} }),
    require('./opportunities').summary({ tenantId, zone }),
  ]);

  const leadIds = leads.map((l) => l._id);
  const blockedLeads = await UnitBlock.find({ tenantId, leadId: { $in: leadIds } }).distinct('leadId');

  const funnel = {
    leads: leads.length,
    connected: leads.filter((l) => l.firstGenuineActionAt).length,
    visits: leads.filter((l) => l.completedVisitCount > 0).length,
    blocks: blockedLeads.length,
    bookings: bookings.length,
    revenueMinor: bookings.reduce((sum, b) => sum + (b.finalPriceMinor || 0), 0),
  };

  return {
    range: { start, end },
    funnel,
    marketing: campaignPerf.totals,
    attributionModel: campaignPerf.attributionModel,
    projects: projects.rows,
    opportunities,
  };
}

/** §76: CSV export of any report row set, respecting the caller's scope. */
function toCsv(rows, columns) {
  const escape = (value) => {
    if (value === null || value === undefined) return '';
    const str = String(value);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const header = columns.map((c) => escape(c.label)).join(',');
  const body = rows.map((row) => columns.map((c) => escape(c.value(row))).join(',')).join('\n');
  return `${header}\n${body}\n`;
}

const toObjectId = (value) => (typeof value === 'string'
  ? new (require('mongoose').Types.ObjectId)(value)
  : value);

module.exports = {
  leadReport, salesReport, projectReport, campaignReport, activityReport,
  managementSummary, toCsv, rangeFor, leadFilter,
};
