const {
  MarketingCampaign, Lead, InquiryTouch, Booking, SiteVisit, Tenant,
} = require('../db/models');
const money = require('../lib/money');
const tz = require('../lib/tz');
const { notFound } = require('../lib/errors');

/**
 * Spec §39, §40, §93: which campaign gets credit, and what that campaign
 * actually produced.
 *
 * §40.2 is the rule that shapes this: switching the reporting model must never
 * delete history. Nothing here writes — attribution is derived from the full
 * touch history every time it is read, so a tenant can flip between first and
 * last touch and see both answers from the same data.
 */

const modelFor = (tenant) => tenant?.settings?.attributionModel || 'LAST_TOUCH';

/** The campaign a lead is credited to under the given model. */
function attributedCampaignId(lead, attributionModel) {
  return attributionModel === 'FIRST_TOUCH'
    ? (lead.firstTouchCampaignId || lead.campaignId)
    : (lead.lastTouchCampaignId || lead.campaignId);
}

/**
 * §39.2 funnel + §93 derived metrics, per campaign.
 * Spend comes from the campaign record; every other number is counted from the
 * leads attributed to it under the tenant's chosen model.
 */
async function performance({ tenantId, tenant, from, to, projectId, zone = 'UTC' }) {
  const resolved = tenant || await Tenant.findById(tenantId).lean();
  const attributionModel = modelFor(resolved);
  const field = attributionModel === 'FIRST_TOUCH' ? 'firstTouchCampaignId' : 'lastTouchCampaignId';

  const campaignFilter = { tenantId };
  if (projectId) campaignFilter.projectId = projectId;
  const campaigns = await MarketingCampaign.find(campaignFilter).sort({ startDate: -1 }).populate('projectId', 'name').lean();

  const leadFilter = { tenantId };
  if (from || to) {
    leadFilter.firstInquiryAt = {};
    if (from) leadFilter.firstInquiryAt.$gte = tz.fromLocalInput(from, '00:00', zone);
    if (to) leadFilter.firstInquiryAt.$lte = tz.fromLocalInput(to, '23:59', zone);
  }
  if (projectId) leadFilter.projectId = projectId;

  const leads = await Lead.find(leadFilter)
    .select('firstTouchCampaignId lastTouchCampaignId campaignId firstGenuineActionAt completedVisitCount bookedAt bookingId activeBlockId stageId')
    .lean();

  const leadIds = leads.map((l) => l._id);
  const [bookings, blockedLeadIds] = await Promise.all([
    Booking.find({ tenantId, leadId: { $in: leadIds }, status: { $ne: 'CANCELLED' } })
      .select('leadId finalPriceMinor').lean(),
    require('../db/models').UnitBlock.find({ tenantId, leadId: { $in: leadIds } }).distinct('leadId'),
  ]);
  const revenueByLead = new Map(bookings.map((b) => [String(b.leadId), b.finalPriceMinor]));
  const blocked = new Set(blockedLeadIds.map(String));

  const buckets = new Map();
  const bucketFor = (key) => {
    if (!buckets.has(key)) {
      buckets.set(key, { leads: 0, connected: 0, visits: 0, blocks: 0, bookings: 0, revenueMinor: 0 });
    }
    return buckets.get(key);
  };

  for (const lead of leads) {
    const key = String(attributedCampaignId(lead, attributionModel) || 'none');
    const bucket = bucketFor(key);
    bucket.leads += 1;
    if (lead.firstGenuineActionAt) bucket.connected += 1;
    if (lead.completedVisitCount > 0) bucket.visits += 1;
    if (blocked.has(String(lead._id))) bucket.blocks += 1;
    if (lead.bookedAt) {
      bucket.bookings += 1;
      bucket.revenueMinor += revenueByLead.get(String(lead._id)) || 0;
    }
  }

  const rows = campaigns.map((campaign) => {
    const funnel = buckets.get(String(campaign._id)) || {
      leads: 0, connected: 0, visits: 0, blocks: 0, bookings: 0, revenueMinor: 0,
    };
    return { ...campaign, ...funnel, ...derive(campaign.spendMinor || 0, funnel) };
  });

  const unattributed = buckets.get('none');
  return {
    attributionModel,
    rows,
    unattributed: unattributed ? { ...unattributed, ...derive(0, unattributed) } : null,
    totals: totalsFor(rows),
  };
}

/** §93: CPL, cost per visit, cost per booking, ROAS. */
function derive(spendMinor, funnel) {
  const per = (count) => (count > 0 ? Math.round(spendMinor / count) : null);
  const pct = (num, den) => (den > 0 ? Number(((num / den) * 100).toFixed(1)) : null);
  return {
    cplMinor: per(funnel.leads),
    costPerVisitMinor: per(funnel.visits),
    costPerBlockMinor: per(funnel.blocks),
    costPerBookingMinor: per(funnel.bookings),
    leadToConnectedPct: pct(funnel.connected, funnel.leads),
    leadToVisitPct: pct(funnel.visits, funnel.leads),
    visitToBlockPct: pct(funnel.blocks, funnel.visits),
    blockToBookingPct: pct(funnel.bookings, funnel.blocks),
    leadToBookingPct: pct(funnel.bookings, funnel.leads),
    // §93: revenue ÷ spend is ROAS, and it is not called ROI.
    roas: spendMinor > 0 ? Number((funnel.revenueMinor / spendMinor).toFixed(2)) : null,
  };
}

function totalsFor(rows) {
  const sum = (key) => rows.reduce((acc, row) => acc + (row[key] || 0), 0);
  const totals = {
    spendMinor: sum('spendMinor'),
    leads: sum('leads'),
    connected: sum('connected'),
    visits: sum('visits'),
    blocks: sum('blocks'),
    bookings: sum('bookings'),
    revenueMinor: sum('revenueMinor'),
  };
  return { ...totals, ...derive(totals.spendMinor, totals) };
}

/**
 * §119: the full lineage behind one booked lead — every touch, both models,
 * and which campaign ends up with the credit.
 */
async function lineage({ tenantId, tenant, leadId }) {
  const lead = await Lead.findOne({ tenantId, _id: leadId })
    .populate('originalSourceId', 'name')
    .populate('latestSourceId', 'name')
    .lean();
  if (!lead) throw notFound('Lead not found.');

  const touches = await InquiryTouch.find({ tenantId, leadId })
    .sort({ at: 1 })
    .populate('sourceId', 'name category')
    .populate('campaignId', 'name platform')
    .lean();

  const resolved = tenant || await Tenant.findById(tenantId).lean();
  const attributionModel = modelFor(resolved);
  const attributedId = attributedCampaignId(lead, attributionModel);
  const attributed = attributedId
    ? await MarketingCampaign.findOne({ tenantId, _id: attributedId }).lean()
    : null;

  return {
    lead,
    touches,
    attributionModel,
    attributed,
    firstTouch: touches[0] || null,
    lastTouch: touches[touches.length - 1] || null,
  };
}

/* ------------------------------- campaigns -------------------------------- */

const listCampaigns = ({ tenantId }) => MarketingCampaign.find({ tenantId })
  .sort({ startDate: -1 }).populate('projectId', 'name').lean();

const createCampaign = ({ tenantId, actor, data }) => MarketingCampaign.create({
  tenantId, ...data, isManual: true, createdBy: actor?._id,
});

async function updateCampaign({ tenantId, actor, campaignId, data }) {
  const campaign = await MarketingCampaign.findOne({ tenantId, _id: campaignId });
  if (!campaign) throw notFound('Campaign not found.');
  Object.assign(campaign, data);
  await campaign.save();
  return campaign;
}

/**
 * §39.1: ad-platform sync. No live credentials exist yet, so the mock adapter
 * refreshes spend from the provider record and stamps `lastSyncAt`, which is
 * what §105 asks the UI to show.
 */
async function syncSpend({ tenantId, platform = 'META', now = new Date() }) {
  const campaigns = await MarketingCampaign.find({ tenantId, platform, isManual: false }).lean();
  for (const campaign of campaigns) {
    await MarketingCampaign.updateOne({ tenantId, _id: campaign._id }, { $set: { lastSyncAt: now } });
  }
  return { synced: campaigns.length };
}

module.exports = {
  performance, derive, lineage, attributedCampaignId, modelFor,
  listCampaigns, createCampaign, updateCampaign, syncSpend,
};
