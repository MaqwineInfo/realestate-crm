const { PaymentPlan, Project } = require('../db/models');
const { badRequest, notFound } = require('../lib/errors');
const audit = require('./audit');

/**
 * V1.1 §35 + §41 + §80: structured payment plans and the schedule they produce.
 *
 * Two rules carry the weight. A plan cannot go live until its percentages add up
 * to exactly 100 (§35.3) — a schedule that does not total the price is worse than
 * no schedule, because the customer will add it up. And the amounts are computed
 * in integer minor units with the **final installment absorbing the rounding
 * remainder** (§41), so the schedule always sums to the consideration exactly.
 */
const PERCENT_SCALE = 10000; // percentages are compared at 4 decimal places

const totalPercentage = (milestones = []) => milestones.reduce((sum, m) => sum + Number(m.percentage || 0), 0);

/** §101: a legacy plan with no rows is usable but honestly labelled. */
const isConfigured = (plan) => !!plan
  && Array.isArray(plan.milestones)
  && plan.milestones.length > 0
  && Math.round(totalPercentage(plan.milestones) * PERCENT_SCALE) === 100 * PERCENT_SCALE;

function normalizeMilestones(rows = []) {
  const clean = rows
    .filter((r) => r && String(r.label || '').trim() && r.percentage !== undefined && r.percentage !== '')
    .map((r, i) => ({
      sequence: Number(r.sequence) || i + 1,
      label: String(r.label).trim(),
      percentage: Number(r.percentage),
      dueRule: PaymentPlan.DUE_RULES.includes(r.dueRule) ? r.dueRule : 'CONSTRUCTION',
      dueOffsetDays: r.dueOffsetDays === '' || r.dueOffsetDays === undefined ? undefined : Number(r.dueOffsetDays),
      customerNote: r.customerNote || undefined,
      displayOrder: Number(r.displayOrder) || i + 1,
    }))
    .sort((a, b) => a.displayOrder - b.displayOrder);

  if (clean.some((r) => !Number.isFinite(r.percentage) || r.percentage < 0)) {
    throw badRequest('Every milestone needs a percentage of zero or more.');
  }
  return clean.map((r, i) => ({ ...r, sequence: i + 1, displayOrder: i + 1 }));
}

async function save({ tenantId, actor, projectId, planId, data }) {
  const project = await Project.findOne({ tenantId, _id: projectId }).lean();
  if (!project) throw notFound('Project not found.');

  const milestones = normalizeMilestones(data.milestones);

  // Activation is its own decision, made with the Activate button, so editing a
  // live plan never silently takes it offline. A new plan starts active, which
  // is what every caller before V1.1 assumed.
  const current = planId ? await PaymentPlan.findOne({ tenantId, _id: planId }).select('active').lean() : null;
  const wantsActive = current ? current.active : true;

  /**
   * §35.3: a schedule that does not add up is worse than no schedule, because the
   * customer will add it up. §101 keeps legacy plans — a plan with *no* rows is a
   * name only, still selectable, and honestly labelled "schedule not configured".
   */
  if (wantsActive && milestones.length && Math.round(totalPercentage(milestones) * PERCENT_SCALE) !== 100 * PERCENT_SCALE) {
    throw badRequest(`The schedule totals ${totalPercentage(milestones).toFixed(2)}%. An active plan must total exactly 100%.`);
  }

  const payload = {
    tenantId,
    projectId,
    name: String(data.name || '').trim(),
    type: data.type || 'CUSTOM',
    description: data.description,
    milestones,
    displayOrder: Number(data.displayOrder) || 0,
    active: wantsActive,
  };
  if (!payload.name) throw badRequest('Name the payment plan.');

  const plan = planId
    ? await PaymentPlan.findOneAndUpdate({ tenantId, _id: planId }, { $set: payload }, { returnDocument: 'after' })
    : await PaymentPlan.create(payload);
  if (!plan) throw notFound('Payment plan not found.');

  await audit.record({
    tenantId, actor, entity: 'PaymentPlan', entityId: plan._id, action: planId ? 'UPDATE' : 'CREATE',
    after: { name: plan.name, milestones: milestones.length, total: totalPercentage(milestones) },
  });
  return plan;
}

async function toggle({ tenantId, actor, planId }) {
  const plan = await PaymentPlan.findOne({ tenantId, _id: planId });
  if (!plan) throw notFound('Payment plan not found.');
  if (!plan.active && !isConfigured(plan)) {
    throw badRequest('Complete the schedule to 100% before activating this plan.');
  }
  plan.active = !plan.active;
  await plan.save();
  await audit.record({
    tenantId, actor, entity: 'PaymentPlan', entityId: plan._id, action: plan.active ? 'ACTIVATE' : 'DEACTIVATE',
  });
  return plan;
}

/**
 * §41/§80: the customer-facing schedule.
 *
 * Percentages of an integer amount do not divide evenly, so every row is floored
 * to a whole minor unit and the last row takes whatever is left. The schedule
 * therefore always sums to `basisMinor` exactly — which is the only property a
 * customer will actually check.
 */
function schedule({ plan, basisMinor }) {
  const rows = [...(plan?.milestones || [])].sort((a, b) => a.sequence - b.sequence);
  if (!rows.length || !basisMinor) return [];

  let allocated = 0;
  return rows.map((row, i) => {
    const isLast = i === rows.length - 1;
    const amountMinor = isLast
      ? basisMinor - allocated
      : Math.round((basisMinor * Number(row.percentage)) / 100);
    if (!isLast) allocated += amountMinor;
    return {
      sequence: row.sequence,
      label: row.label,
      percentage: row.percentage,
      dueRule: row.dueRule,
      dueOffsetDays: row.dueOffsetDays,
      customerNote: row.customerNote || row.note,
      amountMinor,
    };
  });
}

/** §44: what gets frozen onto a quotation so a later plan edit cannot rewrite it. */
const snapshotOf = (plan) => (plan ? {
  paymentPlanId: plan._id,
  paymentPlanName: plan.name,
  paymentPlanBasis: plan.basis || 'FINAL_CONSIDERATION',
  paymentPlanRows: (plan.milestones || []).map((m) => ({
    sequence: m.sequence,
    label: m.label,
    percentage: m.percentage,
    dueRule: m.dueRule,
    dueOffsetDays: m.dueOffsetDays,
    customerNote: m.customerNote || m.note,
  })),
} : null);

const forProject = ({ tenantId, projectId, activeOnly = false }) => PaymentPlan.find({
  tenantId, projectId, ...(activeOnly ? { active: true } : {}),
}).sort({ displayOrder: 1, name: 1 }).lean();

module.exports = {
  totalPercentage, isConfigured, normalizeMilestones, save, toggle, schedule, snapshotOf, forProject,
};
