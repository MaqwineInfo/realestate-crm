const crypto = require('node:crypto');
const { CostSheet, Lead, Unit, PaymentPlan } = require('../db/models');
const { badRequest, notFound } = require('../lib/errors');
const { EVENTS, emit } = require('../lib/events');
const pricing = require('./pricing');
const approvalsService = require('./approvals');
const timeline = require('./timeline');
const audit = require('./audit');

/**
 * Spec §30.3–§30.5: creating, versioning and sharing a cost sheet.
 *
 * §30.5 is the rule that shapes this file: a shared sheet is never edited. Any
 * change produces a new version and marks the old one superseded, so the
 * customer's copy always matches a record that still exists.
 */

async function create({
  tenantId, actor, leadId, unitId, discountMinor = 0, overrides = {},
  paymentPlanId, notes, validUntil, supersedesId,
}) {
  const lead = await Lead.findOne({ tenantId, _id: leadId }).lean();
  if (!lead) throw notFound('Lead not found.');
  if (lead.status === 'TERMINAL') throw badRequest('This lead is closed. Reopen it before quoting again.');

  const unit = await Unit.findOne({ tenantId, _id: unitId }).lean();
  if (!unit) throw notFound('Unit not found.');
  if (['BOOKED', 'REGISTERED', 'NOT_FOR_SALE'].includes(unit.status)) {
    throw badRequest(`Unit ${unit.unitNumber} is ${unit.status.toLowerCase()} and cannot be quoted.`);
  }
  let plan = null;
  if (paymentPlanId) {
    plan = await PaymentPlan.findOne({ tenantId, _id: paymentPlanId, projectId: unit.projectId }).lean();
    if (!plan) throw badRequest('Choose a payment plan that belongs to this project.');
  }

  // §85: the totals come from the engine, never from the form.
  const computed = await pricing.compute({ tenantId, unitId, discountMinor, overrides });

  const previous = await CostSheet.findOne({ tenantId, leadId, unitId }).sort({ version: -1 }).lean();
  const version = (previous?.version || 0) + 1;

  // §44: freeze the schedule onto the quotation. A later plan edit must never
  // change a number a customer has already been given.
  const planSnapshot = require('./paymentPlans').snapshotOf(plan);

  const sheet = await CostSheet.create({
    tenantId,
    leadId,
    contactId: lead.contactId,
    projectId: unit.projectId,
    unitId,
    version,
    // §105: QTN-<project code>-<year>-<sequence>. The id stays authoritative.
    quotationNumber: await nextQuotationNumber({ tenantId, unit, version }),
    supersedesId: supersedesId || previous?._id,
    ...(planSnapshot ? {
      paymentPlanName: planSnapshot.paymentPlanName,
      paymentPlanBasis: planSnapshot.paymentPlanBasis,
      paymentPlanRows: planSnapshot.paymentPlanRows,
    } : {}),
    lines: computed.lines,
    basePriceMinor: computed.basePriceMinor,
    grossAmountMinor: computed.grossAmountMinor,
    discountMinor: computed.discountMinor,
    discountPercentage: computed.discountPercentage,
    taxAndChargesMinor: computed.taxAndChargesMinor,
    finalConsiderationMinor: computed.finalConsiderationMinor,
    paymentPlanId,
    validUntil,
    notes,
    createdBy: actor?._id,
  });

  if (previous && ['DRAFT', 'APPROVAL_PENDING', 'APPROVED', 'SHARED'].includes(previous.status)) {
    await CostSheet.updateOne({ tenantId, _id: previous._id }, { $set: { status: 'SUPERSEDED' } });
    // §31.3: a pending or granted approval does not carry over to new numbers.
    await approvalsService.invalidateFor({ tenantId, costSheetId: previous._id, reason: 'Superseded by a new version' });
  }

  // §31: does this discount need sign-off?
  const rule = await approvalsService.resolveRule({
    tenantId,
    projectId: unit.projectId,
    discountMinor: sheet.discountMinor,
    discountPercentage: sheet.discountPercentage,
  });
  if (rule) await approvalsService.request({ tenantId, actor, costSheet: sheet, rule });

  await timeline.log({
    tenantId,
    leadId,
    contactId: lead.contactId,
    type: 'COSTSHEET_CREATED',
    title: `Cost sheet v${version} for unit ${unit.unitNumber}`,
    actor,
    meta: {
      costSheetId: String(sheet._id),
      unitId: String(unitId),
      finalConsiderationMinor: sheet.finalConsiderationMinor,
      discountMinor: sheet.discountMinor,
      approvalRequired: !!rule,
    },
  });
  emit(EVENTS.COSTSHEET_CREATED, { tenantId, leadId, costSheetId: sheet._id });
  await audit.record({
    tenantId, actor, entity: 'CostSheet', entityId: sheet._id, action: 'CREATE',
    after: { version, unitId, finalConsiderationMinor: sheet.finalConsiderationMinor, discountMinor: sheet.discountMinor },
  });

  return CostSheet.findOne({ tenantId, _id: sheet._id }).lean();
}

/**
 * V1.1 §105: a human-readable quotation number, e.g. QTN-RFH-2026-00042.
 *
 * The ObjectId stays the identity; this is what gets read out on a phone call.
 * The counter is per project per year and derived from the highest existing
 * number, so it never needs its own sequence collection.
 */
async function nextQuotationNumber({ tenantId, unit, version }) {
  const { Project } = require('../db/models');
  const project = await Project.findOne({ tenantId, _id: unit.projectId }).select('code name').lean();
  const code = (project?.code || project?.name || 'QTN')
    .replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase() || 'QTN';
  const year = new Date().getFullYear();
  const prefix = `QTN-${code}-${year}-`;

  const latest = await CostSheet.findOne({ tenantId, quotationNumber: new RegExp(`^${prefix}`) })
    .sort({ quotationNumber: -1 }).select('quotationNumber').lean();
  const nextSeq = latest ? Number(String(latest.quotationNumber).slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(nextSeq).padStart(5, '0')}${version > 1 ? ` V${version}` : ''}`;
}

/** §30.3 step 10: a shareable link. Sharing locks the version (§30.5). */
async function share({ tenantId, actor, costSheetId }) {
  const sheet = await CostSheet.findOne({ tenantId, _id: costSheetId });
  if (!sheet) throw notFound('Cost sheet not found.');
  if (sheet.status === 'APPROVAL_PENDING') {
    throw badRequest('This discount is still waiting for approval. Share it once approved.');
  }
  if (sheet.status === 'REJECTED') throw badRequest('The discount on this cost sheet was rejected. Create a new version.');
  if (sheet.status === 'SUPERSEDED') throw badRequest('A newer version of this cost sheet exists.');
  // Belt and braces: a sheet that needed approval must actually carry one (§31).
  if (sheet.approvalRequired && !sheet.approvedAt) {
    throw badRequest('This cost sheet still needs discount approval.');
  }

  if (!sheet.shareToken) sheet.shareToken = crypto.randomBytes(18).toString('base64url');
  sheet.status = 'SHARED';
  sheet.sharedAt = new Date();
  await sheet.save();

  await timeline.log({
    tenantId, leadId: sheet.leadId, contactId: sheet.contactId, type: 'COSTSHEET_CREATED',
    title: `Cost sheet v${sheet.version} shared with the customer`, actor,
    meta: { costSheetId: String(sheet._id), shareToken: sheet.shareToken },
  });
  return sheet;
}

const forLead = ({ tenantId, leadId }) => CostSheet.find({ tenantId, leadId })
  .sort({ createdAt: -1 })
  .populate('unitId', 'unitNumber')
  .populate('createdBy', 'name')
  .lean();

async function get({ tenantId, costSheetId }) {
  const sheet = await CostSheet.findOne({ tenantId, _id: costSheetId })
    .populate('unitId')
    .populate('projectId', 'name city currency')
    .populate('contactId', 'displayName primaryMobile email')
    .populate('paymentPlanId')
    .populate('createdBy', 'name')
    .lean();
  if (!sheet) throw notFound('Cost sheet not found.');
  return sheet;
}

/** Public share view (§30.3): resolved by token, no session. */
const getByToken = (token) => CostSheet.findOne({ shareToken: token })
  .setOptions({ allowCrossTenant: true })
  .populate('unitId')
  .populate('projectId')
  .populate('contactId', 'displayName')
  .populate('paymentPlanId')
  .populate('tenantId')
  .lean();

/**
 * §33.3: the price a booking may use. An approved sheet locks its numbers; a
 * sheet that needed approval and did not get it cannot be booked against.
 */
function assertBookable(sheet) {
  if (!sheet) return;
  if (sheet.approvalRequired && !sheet.approvedAt) {
    throw badRequest('This cost sheet needs discount approval before the unit can be booked.');
  }
  if (sheet.status === 'SUPERSEDED') throw badRequest('This cost sheet has been superseded by a newer version.');
  if (sheet.status === 'REJECTED') throw badRequest('The discount on this cost sheet was rejected.');
}

/**
 * V1.1 §41/§80: the installment amounts for a sheet, from its own frozen
 * snapshot rather than the project's current plan.
 */
function scheduleFor(sheet) {
  if (!sheet?.paymentPlanRows?.length) return [];
  return require('./paymentPlans').schedule({
    plan: { milestones: sheet.paymentPlanRows },
    basisMinor: sheet.finalConsiderationMinor,
  });
}

module.exports = {
  create, share, forLead, get, getByToken, assertBookable, scheduleFor, nextQuotationNumber,
};
