const { Lead, Followup, SiteVisit } = require('../db/models');
const tz = require('../lib/tz');
const visitsService = require('./visits');

/**
 * Spec §8: the dashboard is a work queue, not a report. Every tile is defined
 * by exactly one filter, and the tile list uses that same filter — so a count
 * and its records can never disagree (§101 "counts match underlying filters").
 */

const POPULATE_LEAD = [
  { path: 'contactId', select: 'displayName primaryMobile normalizedMobile' },
  { path: 'projectId', select: 'name' },
  { path: 'stageId', select: 'name colorToken semanticType' },
  { path: 'subStageId', select: 'name' },
  { path: 'ownerUserId', select: 'name' },
  { path: 'latestSourceId', select: 'name' },
  { path: 'nextActionTypeId', select: 'name semantic' },
];

/**
 * §8.2 New Leads: assigned, still active, and never genuinely attended.
 * A lead leaves this tile only when a genuine action AND a next action were
 * saved — which is exactly what `firstGenuineActionAt` records (§55.3).
 */
const newLeadsFilter = (tenantId, ownerScope) => ({
  tenantId, ...ownerScope, status: 'ACTIVE', firstGenuineActionAt: null, archived: { $ne: true },
});

/** §8.2 Today's Follow-ups: incomplete, due inside the tenant's today. */
const todayFollowupsFilter = (tenantId, userScope, zone, now) => {
  const { start, end } = tz.todayRange(zone, now);
  return { tenantId, ...userScope, status: 'PENDING', dueAt: { $gte: start, $lt: end } };
};

/** §8.2 Missed: incomplete and already past due. */
const missedFollowupsFilter = (tenantId, userScope, now) => ({
  tenantId, ...userScope, status: { $in: ['PENDING', 'MISSED'] }, dueAt: { $lt: now },
});

/** §8.2 Re-Inquiry: an existing contact inquired again and it is unacknowledged. */
const reinquiryFilter = (tenantId, ownerScope) => ({
  tenantId, ...ownerScope, status: 'ACTIVE', reinquiryPendingAt: { $ne: null },
});

async function salesTiles({ tenantId, user, zone, now = new Date() }) {
  const ownerScope = { ownerUserId: user._id };
  const userScope = { assignedUserId: user._id };

  const [newLeads, todayFollowups, todayVisits, missed, reinquiries] = await Promise.all([
    Lead.countDocuments(newLeadsFilter(tenantId, ownerScope)),
    Followup.countDocuments(todayFollowupsFilter(tenantId, userScope, zone, now)),
    SiteVisit.countDocuments(visitsService.todayFilter({ tenantId, userIds: [user._id], zone, now })),
    Followup.countDocuments(missedFollowupsFilter(tenantId, userScope, now)),
    Lead.countDocuments(reinquiryFilter(tenantId, ownerScope)),
  ]);

  // §8.1: the five primary work tiles, in the order the spec lists them.
  return [
    { key: 'new', label: 'New leads', count: newLeads, tone: 't-new' },
    { key: 'today', label: "Today's follow-ups", count: todayFollowups, tone: 't-due' },
    { key: 'visits', label: "Today's visits", count: todayVisits, tone: 't-visit' },
    { key: 'missed', label: 'Missed follow-ups', count: missed, tone: 't-missed' },
    { key: 'reinquiry', label: 'Re-inquiries', count: reinquiries, tone: 't-reinq' },
  ];
}

/** The records behind a tile. Same filters as the counts above. */
async function salesQueue({ tenantId, user, zone, key, now = new Date(), limit = 50 }) {
  const ownerScope = { ownerUserId: user._id };
  const userScope = { assignedUserId: user._id };

  if (key === 'new') {
    const leads = await Lead.find(newLeadsFilter(tenantId, ownerScope))
      .sort({ latestInquiryAt: 1 }).limit(limit).populate(POPULATE_LEAD).lean();
    return { kind: 'LEADS', items: leads };
  }

  if (key === 'reinquiry') {
    const leads = await Lead.find(reinquiryFilter(tenantId, ownerScope))
      .sort({ reinquiryPendingAt: 1 }).limit(limit).populate(POPULATE_LEAD).lean();
    return { kind: 'LEADS', items: leads };
  }

  if (key === 'visits') {
    const items = await visitsService.todayVisits({ tenantId, userIds: [user._id], zone, now });
    return { kind: 'VISITS', items };
  }

  // §8.2 sort: overdue first, then due time ascending, then priority.
  const filter = key === 'missed'
    ? missedFollowupsFilter(tenantId, userScope, now)
    : todayFollowupsFilter(tenantId, userScope, zone, now);

  const followups = await Followup.find(filter)
    .sort({ dueAt: 1 })
    .limit(limit)
    .populate('actionTypeId', 'name semantic')
    .populate({ path: 'leadId', populate: POPULATE_LEAD })
    .lean();

  const live = followups.filter((f) => f.leadId && f.leadId.status === 'ACTIVE');
  live.sort((a, b) => {
    const pr = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    return new Date(a.dueAt) - new Date(b.dueAt)
      || (pr[a.leadId?.priority] ?? 1) - (pr[b.leadId?.priority] ?? 1);
  });
  return { kind: 'FOLLOWUPS', items: live };
}

/* ------------------------------ manager view ------------------------------ */

/**
 * §8.4: the manager home screen is an exception list, not a report. Every tile
 * is one filter over the manager's team, and clicking it shows exactly those
 * records — no reconstructing exceptions from reports (§89).
 */
async function managerScope({ tenantId, user }) {
  const { scopeOf, teamUserIds } = require('../lib/access');
  const scope = scopeOf(user, 'lead.view');
  if (scope === 'all') {
    const { User } = require('../db/models');
    const users = await User.find({ tenantId, status: 'ACTIVE' }).select('_id name').lean();
    return users.map((u) => u._id);
  }
  return teamUserIds(user);
}

async function managerTiles({ tenantId, user, zone, now = new Date() }) {
  const userIds = await managerScope({ tenantId, user });
  const ownerScope = { ownerUserId: { $in: userIds } };
  const assigneeScope = { assignedUserId: { $in: userIds } };

  const [unattended, slaMissed, todayTeam, todayVisits, teamMissed, reinquiries, unassigned] = await Promise.all([
    Lead.countDocuments(newLeadsFilter(tenantId, ownerScope)),
    Lead.countDocuments({ tenantId, ...ownerScope, status: 'ACTIVE', slaBreached: true, firstGenuineActionAt: null }),
    Followup.countDocuments(todayFollowupsFilter(tenantId, assigneeScope, zone, now)),
    SiteVisit.countDocuments(visitsService.todayFilter({ tenantId, userIds, zone, now })),
    Followup.countDocuments(missedFollowupsFilter(tenantId, assigneeScope, now)),
    Lead.countDocuments(reinquiryFilter(tenantId, ownerScope)),
    Lead.countDocuments({ tenantId, status: 'ACTIVE', ownerUserId: null, archived: { $ne: true } }),
  ]);

  return [
    { key: 'unattended', label: 'Unattended new leads', count: unattended, tone: 't-new' },
    { key: 'sla', label: 'SLA missed', count: slaMissed, tone: 't-missed' },
    { key: 'today', label: "Today's team follow-ups", count: todayTeam, tone: 't-due' },
    { key: 'visits', label: "Today's visits", count: todayVisits, tone: 't-visit' },
    { key: 'missed', label: 'Team missed follow-ups', count: teamMissed, tone: 't-missed' },
    { key: 'reinquiry', label: 'Re-inquiries', count: reinquiries, tone: 't-reinq' },
    { key: 'unassigned', label: 'Unassigned', count: unassigned, tone: 't-visit' },
  ];
}

async function managerQueue({ tenantId, user, zone, key, now = new Date(), limit = 50 }) {
  const userIds = await managerScope({ tenantId, user });
  const ownerScope = { ownerUserId: { $in: userIds } };
  const assigneeScope = { assignedUserId: { $in: userIds } };

  const leadQuery = {
    unattended: newLeadsFilter(tenantId, ownerScope),
    sla: { tenantId, ...ownerScope, status: 'ACTIVE', slaBreached: true, firstGenuineActionAt: null },
    reinquiry: reinquiryFilter(tenantId, ownerScope),
    unassigned: { tenantId, status: 'ACTIVE', ownerUserId: null, archived: { $ne: true } },
  }[key];

  if (leadQuery) {
    const items = await Lead.find(leadQuery).sort({ latestInquiryAt: 1 }).limit(limit).populate(POPULATE_LEAD).lean();
    return { kind: 'LEADS', items };
  }

  if (key === 'visits') {
    const items = await visitsService.todayVisits({ tenantId, userIds, zone, now });
    return { kind: 'VISITS', items };
  }

  const filter = key === 'missed'
    ? missedFollowupsFilter(tenantId, assigneeScope, now)
    : todayFollowupsFilter(tenantId, assigneeScope, zone, now);

  const followups = await Followup.find(filter)
    .sort({ dueAt: 1 })
    .limit(limit)
    .populate('actionTypeId', 'name semantic')
    .populate('assignedUserId', 'name')
    .populate({ path: 'leadId', populate: POPULATE_LEAD })
    .lean();
  return { kind: 'FOLLOWUPS', items: followups.filter((x) => x.leadId && x.leadId.status === 'ACTIVE') };
}

/** §8.4 secondary snapshot + exception panels. */
async function managerSnapshot({ tenantId, user, zone, now = new Date() }) {
  const userIds = await managerScope({ tenantId, user });
  const { start, end } = tz.todayRange(zone, now);
  const ownerScope = { ownerUserId: { $in: userIds } };

  const [received, connected, responded, breachedToday, missedByUser, atRisk] = await Promise.all([
    Lead.countDocuments({ tenantId, ...ownerScope, latestInquiryAt: { $gte: start, $lt: end } }),
    Lead.countDocuments({ tenantId, ...ownerScope, firstGenuineActionAt: { $gte: start, $lt: end } }),
    Lead.countDocuments({ tenantId, ...ownerScope, firstResponseSeconds: { $ne: null }, firstGenuineActionAt: { $gte: start, $lt: end } }),
    Lead.countDocuments({ tenantId, ...ownerScope, slaBreached: true, latestInquiryAt: { $gte: start, $lt: end } }),
    Followup.aggregate([
      { $match: { tenantId: toObjectId(tenantId), assignedUserId: { $in: userIds }, status: { $in: ['PENDING', 'MISSED'] }, dueAt: { $lt: now } } },
      { $group: { _id: '$assignedUserId', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 },
    ]),
    Lead.find({ tenantId, ...ownerScope, status: 'ACTIVE', firstGenuineActionAt: null, slaStatus: 'AT_RISK' })
      .sort({ assignedAt: 1 }).limit(5).populate(POPULATE_LEAD).lean(),
  ]);

  const { User } = require('../db/models');
  const users = await User.find({ tenantId, _id: { $in: missedByUser.map((m) => m._id) } }).select('name').lean();
  const nameById = new Map(users.map((u) => [String(u._id), u.name]));

  // §8.4 exception panel: blocks that expire in the next day.
  const blocksExpiring = await require('./blocks').expiringSoon({ tenantId, userIds, hours: 24, now });

  return {
    receivedToday: received,
    connectedToday: connected,
    respondedToday: responded,
    breachedToday,
    missedByUser: missedByUser.map((m) => ({ name: nameById.get(String(m._id)) || 'Unknown', count: m.count })),
    atRiskLeads: atRisk,
    blocksExpiring,
  };
}

const toObjectId = (value) => (typeof value === 'string'
  ? new (require('mongoose').Types.ObjectId)(value)
  : value);

module.exports = {
  salesTiles, salesQueue, managerTiles, managerQueue, managerSnapshot, managerScope,
  newLeadsFilter, todayFollowupsFilter, missedFollowupsFilter, reinquiryFilter,
};
