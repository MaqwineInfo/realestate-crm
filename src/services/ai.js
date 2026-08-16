const {
  Lead, Contact, Activity, SiteVisit, UnitShortlist, CostSheet, UnitBlock, Unit, UnitType,
  Project, Stage, SubStage, PaymentPlan, ActionType,
} = require('../db/models');
const money = require('../lib/money');
const tz = require('../lib/tz');
const pricing = require('./pricing');
const { notFound } = require('../lib/errors');

/**
 * Spec §42: practical sales AI — assistive, never autonomous.
 *
 * The driver here is deterministic and grounded: every sentence it produces is
 * assembled from rows this tenant actually has, filtered by what the asking
 * user is allowed to see (§108). That makes §42.7 structural rather than a
 * promise — there is no generative step that *could* invent a unit, a price or
 * an availability, and nothing here mutates a stage, a block, a booking or an
 * approval.
 *
 * ponytail: no model call, no API key, no cost. Swap in an LLM driver later by
 * feeding it exactly the `context()` bundle below and keeping these guardrails.
 */

/** Everything the assistant is allowed to know about one lead. */
async function context({ tenantId, leadId }) {
  const lead = await Lead.findOne({ tenantId, _id: leadId })
    .populate('stageId', 'name semanticType terminal')
    .populate('subStageId', 'name')
    .populate('projectId', 'name city possessionDate amenities configurations startingPriceMinor')
    .populate('latestSourceId', 'name')
    .lean();
  if (!lead) throw notFound('Lead not found.');

  const [contact, activities, visits, shortlist, costSheets, blocks] = await Promise.all([
    Contact.findOne({ tenantId, _id: lead.contactId }).lean(),
    Activity.find({ tenantId, leadId }).sort({ at: -1 }).limit(25).lean(),
    SiteVisit.find({ tenantId, leadId }).sort({ scheduledAt: -1 }).populate('outcomeId', 'name isNegative').lean(),
    UnitShortlist.find({ tenantId, leadId, active: true }).populate('unitId', 'unitNumber status').lean(),
    CostSheet.find({ tenantId, leadId }).sort({ createdAt: -1 }).populate('unitId', 'unitNumber').lean(),
    UnitBlock.find({ tenantId, leadId }).sort({ blockedAt: -1 }).populate('unitId', 'unitNumber').lean(),
  ]);
  return { lead, contact, activities, visits, shortlist, costSheets, blocks };
}

/**
 * §42.2: a short factual summary. Each bullet cites something that exists —
 * a stage, a logged activity, a visit outcome, a shortlisted unit.
 */
async function summarize({ tenantId, leadId, zone = 'UTC', currency = 'INR', locale = 'en-IN' }) {
  const ctx = await context({ tenantId, leadId });
  const { lead, contact, activities, visits, shortlist, costSheets, blocks } = ctx;
  const fmt = (minor) => money.formatShort(minor, { currency, locale });
  const bullets = [];

  const requirement = [
    lead.preferredConfigurations?.length ? lead.preferredConfigurations.join('/') : null,
    lead.budgetMinMinor || lead.budgetMaxMinor
      ? `budget ${[lead.budgetMinMinor && fmt(lead.budgetMinMinor), lead.budgetMaxMinor && fmt(lead.budgetMaxMinor)].filter(Boolean).join('–')}`
      : null,
    lead.purpose ? lead.purpose.replace('_', ' ').toLowerCase() : null,
    lead.projectId?.name ? `interested in ${lead.projectId.name}` : null,
  ].filter(Boolean);

  bullets.push(requirement.length
    ? `Requirement: ${requirement.join(', ')}.`
    : 'Requirement not captured yet — budget, configuration and purpose are all blank.');

  bullets.push(`Currently in ${lead.stageId?.name || 'an unknown stage'}${lead.subStageId ? ` (${lead.subStageId.name})` : ''}, `
    + `${lead.inquiryCount > 1 ? `${lead.inquiryCount} inquiries since ` : 'first inquired '}`
    + `${tz.formatDate(lead.firstInquiryAt, zone, locale)}.`);

  const completedVisits = visits.filter((v) => v.status === 'COMPLETED');
  if (completedVisits.length) {
    const latest = completedVisits[0];
    bullets.push(`Visited on ${tz.formatDate(latest.scheduledAt, zone, locale)}`
      + `${latest.outcomeId ? ` — outcome recorded as ${latest.outcomeId.name}` : ''}.`);
  } else if (visits.length) {
    bullets.push(`A site visit is scheduled for ${tz.formatDateTime(visits[0].scheduledAt, zone, locale)}.`);
  } else {
    bullets.push('No site visit has happened yet.');
  }

  if (shortlist.length) {
    bullets.push(`Shortlisted ${shortlist.length} unit(s): ${shortlist.map((s) => s.unitId?.unitNumber).filter(Boolean).join(', ')}.`);
  }
  if (costSheets.length) {
    const latest = costSheets[0];
    bullets.push(`Latest cost sheet v${latest.version} for unit ${latest.unitId?.unitNumber} at ${fmt(latest.finalConsiderationMinor)}`
      + `${latest.discountMinor ? ` including a ${latest.discountPercentage.toFixed(1)}% discount` : ''} (${latest.status.replace('_', ' ').toLowerCase()}).`);
  }
  const activeBlock = blocks.find((b) => b.status === 'ACTIVE');
  if (activeBlock) {
    bullets.push(`Unit ${activeBlock.unitId?.unitNumber} is blocked until ${tz.formatDateTime(activeBlock.expiryAt, zone, locale)}.`);
  }

  // §42.2 "main objection": taken from the lost reason or a negative visit outcome.
  const objection = lead.lostReasonSubStageId
    ? (await SubStage.findOne({ tenantId, _id: lead.lostReasonSubStageId }).lean())?.name
    : completedVisits.find((v) => v.outcomeId?.isNegative)?.outcomeId?.name;
  if (objection) bullets.push(`Recorded objection: ${objection}.`);

  const lastMeaningful = activities.find((a) => !['LEAD_ASSIGNED', 'AI_SUMMARY_REFRESHED'].includes(a.type));
  if (lastMeaningful) {
    bullets.push(`Last activity: ${lastMeaningful.title} (${tz.relative(lastMeaningful.at)}).`);
  }

  bullets.push(lead.status === 'TERMINAL'
    ? `This lead is closed${lead.bookedAt ? ' as booked' : ''}.`
    : (lead.nextActionAt
      ? `Next action is due ${tz.formatDateTime(lead.nextActionAt, zone, locale)}.`
      : 'There is no next action scheduled — that is the immediate gap.'));

  return {
    generated: true,
    generatedAt: new Date(),
    source: 'Assembled from this lead\'s own CRM records',
    bullets,
  };
}

/**
 * §42.3: what to do next. Rules read the same state a salesperson would;
 * the user still decides and still has to record it.
 */
async function suggestNextAction({ tenantId, leadId }) {
  const ctx = await context({ tenantId, leadId });
  const { lead, visits, shortlist, costSheets, blocks } = ctx;
  const semantic = lead.stageId?.semanticType;

  const suggest = (action, why) => ({ action, why, decidedBy: 'user' });

  if (lead.status === 'TERMINAL') {
    return suggest('No action needed', 'This lead is closed. Reopen it first if the customer comes back.');
  }
  if (!lead.firstGenuineActionAt) {
    return suggest('Call now', 'This lead has never been genuinely attended, and the response clock is running.');
  }
  if (blocks.some((b) => b.status === 'ACTIVE')) {
    return suggest('Confirm the booking', 'A unit is blocked and the block expires — convert it or release it.');
  }
  if (costSheets.length && !blocks.length) {
    return suggest('Block the unit', 'A cost sheet exists but no unit is held; blocking is what protects the deal.');
  }
  if (visits.some((v) => v.status === 'COMPLETED') && !costSheets.length) {
    return suggest('Share a cost sheet', 'The customer has visited but has never been given a price.');
  }
  if (shortlist.length && !visits.length) {
    return suggest('Schedule a site visit', 'Units are shortlisted but the customer has not seen them.');
  }
  if (semantic === 'CONNECTED' && !visits.length) {
    return suggest('Schedule a site visit', 'The customer is engaged; a visit is the strongest next step towards a booking.');
  }
  if (semantic === 'NOT_CONNECTED') {
    return suggest('Try another channel', 'Calls have not connected — a WhatsApp message often restarts the conversation.');
  }
  if (!shortlist.length) {
    return suggest('Share matching units', 'Nothing is shortlisted yet, so there is nothing concrete to discuss.');
  }
  return suggest('Follow up on the objection', 'Keep the conversation moving with a specific answer to their last concern.');
}

/**
 * §42.4: an assistive priority score. Signals are listed with the points they
 * contributed, so the number is explainable rather than magic.
 */
async function priority({ tenantId, leadId }) {
  const ctx = await context({ tenantId, leadId });
  const { lead, visits, shortlist, costSheets, blocks } = ctx;
  const signals = [];
  const add = (points, label) => { signals.push({ points, label }); };

  if (blocks.some((b) => b.status === 'ACTIVE')) add(35, 'A unit is blocked for this customer');
  if (costSheets.length) add(20, 'A cost sheet has been prepared');
  if (visits.some((v) => v.status === 'COMPLETED')) add(20, 'Completed a site visit');
  if (shortlist.length) add(10, `${shortlist.length} unit(s) shortlisted`);
  if (lead.inquiryCount > 1) add(10, `Re-inquired ${lead.inquiryCount} times`);
  if (lead.budgetMaxMinor) add(5, 'Budget captured');
  if (lead.purpose === 'INVESTMENT') add(5, 'Investor intent');

  const daysSinceActivity = lead.lastActivityAt
    ? Math.floor((Date.now() - new Date(lead.lastActivityAt).getTime()) / 86400000)
    : 999;
  if (daysSinceActivity <= 3) add(10, 'Active in the last three days');
  else if (daysSinceActivity > 21) add(-10, 'No activity for over three weeks');

  if (lead.slaBreached) add(-5, 'First response was late');

  const score = Math.max(0, Math.min(100, signals.reduce((sum, s) => sum + s.points, 0)));
  const level = score >= 60 ? 'HIGH' : (score >= 30 ? 'MEDIUM' : 'LOW');
  return {
    score,
    level,
    // V1.1 §100: the salesperson-facing band travels with the legacy score, which
    // stays exactly as it was so existing callers keep working.
    temperature: lead.status === 'TERMINAL' ? null : lead.temperature,
    signals,
    caveat: 'Assistive only — this is a weighted read of recorded activity, not a probability of closing.',
  };
}

/**
 * §42.5: units this customer could actually buy.
 * Only sellable inventory in projects the user may see, priced by the same
 * engine the cost sheet uses — so a recommendation can never quote a number
 * that a cost sheet would contradict.
 */
async function recommendUnits({ tenantId, leadId, limit = 5, canSeePrices = true }) {
  const { lead } = await context({ tenantId, leadId });

  const filter = { tenantId, status: 'AVAILABLE', active: true };
  if (lead.projectId) filter.projectId = lead.projectId._id || lead.projectId;
  // V1.1 §10: facing became a multi-select; the legacy single value still counts.
  const facings = lead.preferredFacings?.length ? lead.preferredFacings : [lead.preferredFacing].filter(Boolean);
  if (facings.length) filter.facing = { $in: facings.map((f) => new RegExp(`^${escapeRegex(f)}$`, 'i')) };
  if (lead.areaMin || lead.areaMax) {
    filter.saleableArea = {};
    if (lead.areaMin) filter.saleableArea.$gte = lead.areaMin;
    if (lead.areaMax) filter.saleableArea.$lte = lead.areaMax;
  }
  if (lead.preferredFloorMin != null || lead.preferredFloorMax != null) {
    filter.floorNumber = {};
    if (lead.preferredFloorMin != null) filter.floorNumber.$gte = lead.preferredFloorMin;
    if (lead.preferredFloorMax != null) filter.floorNumber.$lte = lead.preferredFloorMax;
  }

  let units = await Unit.find(filter).limit(60)
    .populate('unitTypeId', 'name bedrooms')
    .populate('towerId', 'name')
    .lean();

  // A stated configuration is a requirement, not a hint: never quietly offer a
  // 2 BHK to someone who asked for a 3 BHK — say there is nothing instead.
  let configurationMatched = true;
  if (lead.preferredConfigurations?.length) {
    const wanted = lead.preferredConfigurations.map((c) => c.toLowerCase());
    units = units.filter((u) => u.unitTypeId && wanted.some((w) => u.unitTypeId.name.toLowerCase().includes(w)));
    configurationMatched = units.length > 0;
  }

  const priced = [];
  for (const unit of units) {
    const priceMinor = await pricing.quickPrice({ tenantId, unitId: unit._id });
    // Budget is a filter, not a suggestion: never offer what they cannot buy.
    if (lead.budgetMaxMinor && priceMinor != null && priceMinor > lead.budgetMaxMinor * 1.05) continue;
    if (lead.budgetMinMinor && priceMinor != null && priceMinor < lead.budgetMinMinor * 0.8) continue;
    priced.push({ ...unit, priceMinor: canSeePrices ? priceMinor : null, rawPriceMinor: priceMinor });
  }

  priced.sort((a, b) => (a.rawPriceMinor ?? Infinity) - (b.rawPriceMinor ?? Infinity));
  return {
    units: priced.slice(0, limit).map(({ rawPriceMinor, ...u }) => u),
    basis: {
      budgetMinMinor: lead.budgetMinMinor,
      budgetMaxMinor: lead.budgetMaxMinor,
      configurations: lead.preferredConfigurations,
      facing: facings.join(', ') || undefined,
      projectId: lead.projectId?._id || lead.projectId,
    },
    note: priced.length
      ? 'Only units currently available in your inventory, priced by the cost-sheet engine.'
      : (configurationMatched
        ? 'No available unit matches this requirement right now.'
        : `No available unit in the requested configuration (${lead.preferredConfigurations.join(', ')}).`),
  };
}

/**
 * §42.6: grounded project and inventory Q&A.
 * When the tenant has not configured the data, it says so rather than guessing
 * (§42.6, §42.7).
 */
async function answer({ tenantId, question, projectId, currency = 'INR', locale = 'en-IN', zone = 'UTC', canSeePrices = true }) {
  const q = String(question || '').toLowerCase().trim();
  if (!q) return { answer: 'Ask about availability, price, possession, amenities, payment plans or a specific unit.', grounded: true };

  const project = projectId
    ? await Project.findOne({ tenantId, _id: projectId }).lean()
    : await Project.findOne({ tenantId, status: 'ACTIVE' }).sort({ createdAt: 1 }).lean();
  if (!project) return { answer: 'No project is configured yet, so there is nothing to answer from.', grounded: true };

  const fmt = (minor) => money.formatShort(minor, { currency, locale });

  // "What is the final cost of unit A-804?"
  const unitMatch = q.match(/unit\s+([a-z]{0,3}-?\d[\w-]*)/i);
  if (unitMatch) {
    const unit = await Unit.findOne({ tenantId, projectId: project._id, unitNumber: new RegExp(`^${escapeRegex(unitMatch[1])}$`, 'i') })
      .populate('unitTypeId', 'name').lean();
    if (!unit) return { answer: `There is no unit ${unitMatch[1]} in ${project.name}.`, grounded: true };
    if (!canSeePrices) return { answer: `Unit ${unit.unitNumber} is ${unit.status.toLowerCase()}. You do not have permission to view prices.`, grounded: true };
    const priceMinor = await pricing.quickPrice({ tenantId, unitId: unit._id });
    return {
      answer: priceMinor == null
        ? `Unit ${unit.unitNumber} is ${unit.status.toLowerCase()}, but pricing is not configured for this project yet.`
        : `Unit ${unit.unitNumber} (${unit.unitTypeId?.name || 'unit'}) is ${unit.status.toLowerCase()} and works out to ${fmt(priceMinor)} all-in.`,
      grounded: true,
      unit,
    };
  }

  if (/possession|handover|ready/.test(q)) {
    return {
      answer: project.possessionDate
        ? `${project.name} is scheduled for possession in ${tz.formatDate(project.possessionDate, zone, locale)}.`
        : `A possession date has not been configured for ${project.name}.`,
      grounded: true,
    };
  }

  if (/amenit|facilit/.test(q)) {
    return {
      answer: project.amenities?.length
        ? `${project.name} amenities: ${project.amenities.join(', ')}.`
        : `Amenities have not been configured for ${project.name}.`,
      grounded: true,
    };
  }

  if (/payment plan|instal|schedule of payment/.test(q)) {
    const plans = await PaymentPlan.find({ tenantId, projectId: project._id, active: true }).lean();
    return {
      answer: plans.length
        ? `${project.name} offers: ${plans.map((p) => p.name).join(', ')}.`
        : `No payment plan is configured for ${project.name} yet.`,
      grounded: true,
    };
  }

  if (/facing|east|west|north|south/.test(q)) {
    const facingMatch = q.match(/(east|west|north|south)[- ]?(east|west)?/);
    const facing = facingMatch ? facingMatch[0].trim() : null;
    const units = await Unit.find({
      tenantId, projectId: project._id, status: 'AVAILABLE', active: true,
      ...(facing ? { facing: new RegExp(facing, 'i') } : {}),
    }).select('unitNumber facing').limit(10).lean();
    return {
      answer: units.length
        ? `Available${facing ? ` ${facing}-facing` : ''} units in ${project.name}: ${units.map((u) => u.unitNumber).join(', ')}.`
        : `No available${facing ? ` ${facing}-facing` : ''} unit in ${project.name} right now.`,
      grounded: true,
      units,
    };
  }

  // "What 3BHK units are available under 80 lakh?"
  const budgetMatch = q.match(/(?:under|below|upto|up to)\s*([\d.,]+)\s*(cr|crore|l|lakh|lac)?/);
  const configMatch = q.match(/(\d)\s*bhk/);
  if (/avail|inventory|units?/.test(q) || budgetMatch || configMatch) {
    const unitFilter = { tenantId, projectId: project._id, status: 'AVAILABLE', active: true };
    let unitTypeIds = null;
    if (configMatch) {
      const types = await UnitType.find({
        tenantId, projectId: project._id, name: new RegExp(`${configMatch[1]}\\s*bhk`, 'i'),
      }).select('_id name').lean();
      unitTypeIds = types.map((t) => t._id);
      if (!types.length) {
        return { answer: `${project.name} has no ${configMatch[1]} BHK configuration configured.`, grounded: true };
      }
      unitFilter.unitTypeId = { $in: unitTypeIds };
    }

    let budgetMinor = null;
    if (budgetMatch) {
      const value = Number(String(budgetMatch[1]).replace(/,/g, ''));
      const unitWord = budgetMatch[2] || '';
      const multiplier = /cr/.test(unitWord) ? 1e7 : (/l/.test(unitWord) ? 1e5 : 1);
      budgetMinor = money.toMinor(value * multiplier);
    }

    const units = await Unit.find(unitFilter).populate('unitTypeId', 'name').limit(50).lean();
    const withPrice = [];
    for (const unit of units) {
      const priceMinor = await pricing.quickPrice({ tenantId, unitId: unit._id });
      if (budgetMinor && priceMinor != null && priceMinor > budgetMinor) continue;
      withPrice.push({ ...unit, priceMinor });
    }

    if (!withPrice.length) {
      return {
        answer: `No available unit in ${project.name} matches${configMatch ? ` ${configMatch[1]} BHK` : ''}`
          + `${budgetMinor ? ` under ${fmt(budgetMinor)}` : ''}.`,
        grounded: true,
      };
    }
    const listed = withPrice.slice(0, 8)
      .map((u) => `${u.unitNumber}${canSeePrices && u.priceMinor != null ? ` (${fmt(u.priceMinor)})` : ''}`)
      .join(', ');
    return {
      answer: `${withPrice.length} available${configMatch ? ` ${configMatch[1]} BHK` : ''} unit(s) in ${project.name}`
        + `${budgetMinor ? ` under ${fmt(budgetMinor)}` : ''}: ${listed}.`,
      grounded: true,
      units: withPrice.slice(0, 8),
    };
  }

  return {
    answer: `I can answer from ${project.name}'s configured data: availability by configuration or budget, `
      + 'the price of a specific unit, possession date, amenities, payment plans and facing. '
      + 'Anything else is not in the CRM yet.',
    grounded: true,
  };
}

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * §42.7 / §108: the assistant can read, score and suggest. It has no write
 * path at all — this list is asserted by the test suite.
 */
const GUARDRAILS = Object.freeze({
  canChangeStage: false,
  canBlockUnit: false,
  canBookUnit: false,
  canApproveDiscount: false,
  canAlterInventory: false,
  canSendCampaign: false,
  canInventFacts: false,
});

module.exports = { context, summarize, suggestNextAction, priority, recommendUnits, answer, GUARDRAILS };
