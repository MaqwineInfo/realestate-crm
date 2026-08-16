const {
  Lead, UnitBlock, CostSheet, SiteVisit, UnitShortlist, Followup, SubStage, Stage,
} = require('../db/models');
const { badRequest, notFound } = require('../lib/errors');
const timeline = require('./timeline');
const audit = require('./audit');

/**
 * V1.1 §14: HOT / WARM / COLD lead temperature.
 *
 * This is the salesperson-facing layer over the same explainable signal model the
 * AI priority endpoint already used (§100). It is deliberately NOT the existing
 * `lead.priority` field — that one is a manual queue-sort control (§98 fallback),
 * so repurposing it would silently change how follow-up queues order themselves.
 *
 * Every score carries the signals that produced it. A number a salesperson cannot
 * argue with is a number they will not trust.
 */
const BANDS = { HOT: 60, WARM: 30 };

/** §14.3 signal weights, kept in one table so the score stays auditable. */
const WEIGHTS = {
  ACTIVE_BLOCK: 35,
  QUOTATION: 20,
  COMPLETED_VISIT: 20,
  SHORTLIST: 10,
  REINQUIRY: 10,
  BUDGET: 5,
  INVESTMENT: 5,
  RECENT_ACTIVITY: 10,
  FAILED_ATTEMPTS: -10,
  STALE_7: -10,
  STALE_21: -20,
  SLA_BREACHED: -5,
};

const bandFor = (score) => (score >= BANDS.HOT ? 'HOT' : (score >= BANDS.WARM ? 'WARM' : 'COLD'));

/** §14.2: mid-WARM, so an unworked lead never reads as cold or as a false HOT. */
const UNATTENDED_SCORE = 45;

/** Everything the score is allowed to look at, read in one pass. */
async function signalsFor({ tenantId, lead, now = new Date() }) {
  const notConnectedStages = await Stage.find({ tenantId, semanticType: 'NOT_CONNECTED' }).select('_id').lean();
  const notConnectedSubIds = notConnectedStages.length
    ? (await SubStage.find({ tenantId, stageId: { $in: notConnectedStages.map((s) => s._id) } }).select('_id').lean())
      .map((s) => s._id)
    : [];

  const [activeBlock, quotation, visit, shortlisted, failedAttempts] = await Promise.all([
    UnitBlock.countDocuments({ tenantId, leadId: lead._id, status: 'ACTIVE' }),
    CostSheet.countDocuments({ tenantId, leadId: lead._id, status: { $in: ['APPROVED', 'SHARED'] } }),
    SiteVisit.countDocuments({ tenantId, leadId: lead._id, status: 'COMPLETED' }),
    UnitShortlist.countDocuments({ tenantId, leadId: lead._id, active: true }),
    notConnectedSubIds.length
      ? Followup.countDocuments({
        tenantId, leadId: lead._id, status: 'COMPLETED', completionSubStageId: { $in: notConnectedSubIds },
      })
      : 0,
  ]);

  const daysIdle = lead.lastActivityAt
    ? Math.floor((now.getTime() - new Date(lead.lastActivityAt).getTime()) / 86400000)
    : 999;

  const signals = [];
  const add = (points, label) => { if (points) signals.push({ points, label }); };

  if (activeBlock) add(WEIGHTS.ACTIVE_BLOCK, 'A unit is blocked for this customer');
  if (quotation) add(WEIGHTS.QUOTATION, 'A quotation has been approved or shared');
  if (visit) add(WEIGHTS.COMPLETED_VISIT, 'Completed a site visit');
  if (shortlisted) add(WEIGHTS.SHORTLIST, `${shortlisted} unit(s) shortlisted`);
  if (lead.inquiryCount > 1) add(WEIGHTS.REINQUIRY, `Re-inquired ${lead.inquiryCount} times`);
  if (lead.budgetMaxMinor || lead.budgetMinMinor) add(WEIGHTS.BUDGET, 'Budget captured');
  if (lead.purpose === 'INVESTMENT') add(WEIGHTS.INVESTMENT, 'Investor intent');

  if (daysIdle <= 3) add(WEIGHTS.RECENT_ACTIVITY, 'Meaningful activity in the last three days');
  else if (daysIdle >= 21) add(WEIGHTS.STALE_21, 'No meaningful activity for over three weeks');
  else if (daysIdle >= 7) add(WEIGHTS.STALE_7, `No meaningful activity for ${daysIdle} days`);

  if (failedAttempts >= 3) add(WEIGHTS.FAILED_ATTEMPTS, `${failedAttempts} unsuccessful contact attempts`);
  if (lead.slaBreached) add(WEIGHTS.SLA_BREACHED, 'First response was late');

  return signals;
}

/** Pure: signals in, score out. Clamped to 0–100 (§14.3). */
function scoreFrom(signals) {
  const raw = signals.reduce((sum, s) => sum + s.points, 0);
  return Math.max(0, Math.min(100, raw));
}

/**
 * §14.2: a brand-new lead is WARM, never COLD. It has no sales activity because
 * nobody has worked it yet — that is urgency, not disinterest, and the NEW badge
 * already carries the urgency.
 */
async function evaluate({ tenantId, lead, now = new Date() }) {
  if (!lead.firstGenuineActionAt) {
    return {
      score: UNATTENDED_SCORE,
      temperature: 'WARM',
      unattended: true,
      signals: [{ points: 0, label: 'New lead — not attended yet, so scoring has not started' }],
    };
  }
  const signals = await signalsFor({ tenantId, lead, now });
  const score = scoreFrom(signals);
  return { score, temperature: bandFor(score), unattended: false, signals };
}

/**
 * Recalculates and stores, unless the tenant has pinned this lead manually.
 * Safe to call from anywhere — a failure here must never fail a sale action, so
 * callers fire it without awaiting the result where it is not on the critical path.
 */
async function recalculate({ tenantId, leadId, now = new Date() }) {
  const lead = await Lead.findOne({ tenantId, _id: leadId }).lean();
  if (!lead) return null;
  // §14.5: a closed lead shows BOOKED or LOST, not a temperature.
  if (lead.status === 'TERMINAL') return null;
  // §14.6: a manual override stands until someone returns it to auto.
  if (lead.temperatureMode === 'MANUAL') return null;

  const result = await evaluate({ tenantId, lead, now });
  await Lead.updateOne({ tenantId, _id: leadId }, {
    $set: {
      temperatureScore: result.score,
      temperature: result.temperature,
      temperatureUpdatedAt: now,
    },
  });
  return result;
}

/** §14.6: manual pin. Requires a reason, and is both logged and audited. */
async function override({ tenantId, actor, leadId, temperature, reason }) {
  if (!['HOT', 'WARM', 'COLD'].includes(temperature)) throw badRequest('Choose hot, warm or cold.');
  if (!reason || !String(reason).trim()) throw badRequest('Give a reason for the manual temperature.');

  const lead = await Lead.findOne({ tenantId, _id: leadId });
  if (!lead) throw notFound('Lead not found.');
  const before = { temperature: lead.temperature, mode: lead.temperatureMode };

  lead.temperature = temperature;
  lead.temperatureMode = 'MANUAL';
  lead.temperatureOverrideBy = actor?._id;
  lead.temperatureOverrideAt = new Date();
  lead.temperatureOverrideReason = String(reason).trim();
  lead.temperatureUpdatedAt = new Date();
  await lead.save();

  await timeline.log({
    tenantId, leadId: lead._id, contactId: lead.contactId, type: 'TEMPERATURE_CHANGED',
    title: `Lead marked ${temperature.toLowerCase()} manually`, body: reason, actor,
    meta: { temperature, mode: 'MANUAL' },
  });
  await audit.record({
    tenantId, actor, entity: 'Lead', entityId: lead._id, action: 'TEMPERATURE_OVERRIDE',
    before, after: { temperature, mode: 'MANUAL', reason },
  });
  return lead;
}

/** §14.6: hand the lead back to automatic scoring and recompute immediately. */
async function returnToAuto({ tenantId, actor, leadId }) {
  const lead = await Lead.findOne({ tenantId, _id: leadId });
  if (!lead) throw notFound('Lead not found.');
  const before = { temperature: lead.temperature, mode: lead.temperatureMode };

  lead.temperatureMode = 'AUTO';
  lead.temperatureOverrideBy = undefined;
  lead.temperatureOverrideAt = undefined;
  lead.temperatureOverrideReason = undefined;
  await lead.save();

  const result = await recalculate({ tenantId, leadId });
  await timeline.log({
    tenantId, leadId: lead._id, contactId: lead.contactId, type: 'TEMPERATURE_CHANGED',
    title: `Temperature returned to automatic (${result?.temperature || lead.temperature})`, actor,
    meta: { mode: 'AUTO' },
  });
  await audit.record({
    tenantId, actor, entity: 'Lead', entityId: lead._id, action: 'TEMPERATURE_AUTO',
    before, after: { mode: 'AUTO', temperature: result?.temperature },
  });
  return result;
}

/**
 * §14.7 last trigger: inactivity. Nothing happens to a neglected lead to fire an
 * event, so the decay has to be swept. Idempotent — it only ever recomputes.
 */
async function sweep({ tenantId = null, now = new Date(), staleHours = 12, limit = 500 } = {}) {
  const filter = {
    status: 'ACTIVE',
    temperatureMode: 'AUTO',
    firstGenuineActionAt: { $ne: null },
    $or: [
      { temperatureUpdatedAt: null },
      { temperatureUpdatedAt: { $lt: new Date(now.getTime() - staleHours * 3600000) } },
    ],
  };
  if (tenantId) filter.tenantId = tenantId;

  const leads = await Lead.find(filter).setOptions({ allowCrossTenant: !tenantId })
    .select('_id tenantId').limit(limit).lean();
  let changed = 0;
  for (const lead of leads) {
    const result = await recalculate({ tenantId: lead.tenantId, leadId: lead._id, now });
    if (result) changed += 1;
  }
  return { scanned: leads.length, recalculated: changed };
}

module.exports = {
  BANDS, WEIGHTS, UNATTENDED_SCORE, bandFor, signalsFor, scoreFrom, evaluate,
  recalculate, override, returnToAuto, sweep,
};
