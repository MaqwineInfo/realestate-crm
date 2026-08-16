const { UnitBlock, Unit, Lead, Tenant, Project, Contact, CostSheet } = require('../db/models');
const { badRequest, notFound, conflict } = require('../lib/errors');
const { EVENTS, emit } = require('../lib/events');
const inventory = require('./inventory');
const leadsService = require('./leads');
const stagesService = require('./stages');
const timeline = require('./timeline');
const notifications = require('./notifications');
const audit = require('./audit');
const costsheets = require('./costsheets');

/**
 * Spec §32 + §86: blocking a unit.
 *
 * The whole flow hangs on one atomic compare-and-set: the unit moves
 * AVAILABLE → BLOCKED only if it is still AVAILABLE. Two users clicking Block
 * on the same unit at the same moment produce exactly one block and one
 * friendly "someone just took it" (§68) — no transaction required (§87).
 */

/** §32.3 / §96: resolve the duration now and store the deadline on the block. */
async function resolveExpiry({ tenantId, tenant, project, at = new Date(), overrideHours }) {
  const hours = overrideHours
    || project?.blockDurationHours
    || (tenant || await Tenant.findById(tenantId).lean()).settings.blockDurationHours
    || 48;
  return new Date(at.getTime() + hours * 3600000);
}

async function block({
  tenantId, tenant, actor, leadId, unitId, costSheetId, tokenAmountMinor, notes, expiryHours,
}) {
  const [lead, unit] = await Promise.all([
    Lead.findOne({ tenantId, _id: leadId }).lean(),
    Unit.findOne({ tenantId, _id: unitId }).lean(),
  ]);
  if (!lead) throw notFound('Lead not found.');
  if (!unit) throw notFound('Unit not found.');
  if (lead.status === 'TERMINAL') throw badRequest('This lead is closed. Reopen it before blocking a unit.');

  // §86: validate everything we can before touching inventory.
  let costSheet = null;
  if (costSheetId) {
    costSheet = await CostSheet.findOne({ tenantId, _id: costSheetId, leadId }).lean();
    if (!costSheet) throw badRequest('That cost sheet does not belong to this lead.');
    if (String(costSheet.unitId) !== String(unitId)) throw badRequest('That cost sheet is for a different unit.');
    costsheets.assertBookable(costSheet);
  }

  const project = await Project.findOne({ tenantId, _id: unit.projectId }).lean();
  const at = new Date();
  const expiryAt = await resolveExpiry({ tenantId, tenant, project, at, overrideHours: expiryHours });

  // The contended step. Nothing before this wrote anything.
  const claimed = await inventory.claim({
    tenantId,
    unitId,
    fromStatuses: ['AVAILABLE', 'HOLD'],
    toStatus: 'BLOCKED',
    set: { heldForLeadId: leadId },
  });
  if (!claimed) {
    // §68: the exact wording the spec asks for.
    throw conflict('This unit was just blocked by another user. Refresh inventory and select another unit.');
  }

  let blockRecord;
  try {
    blockRecord = await UnitBlock.create({
      tenantId,
      leadId,
      contactId: lead.contactId,
      projectId: unit.projectId,
      unitId,
      costSheetId: costSheet?._id,
      proposedPriceMinor: costSheet?.finalConsiderationMinor,
      tokenAmountMinor,
      blockedBy: actor._id,
      blockedAt: at,
      expiryAt,
      notes,
    });
    await Unit.updateOne({ tenantId, _id: unitId }, { $set: { currentBlockId: blockRecord._id } });
  } catch (err) {
    // Hand the unit back rather than leaving it blocked with no block record.
    await inventory.releaseClaim({
      tenantId, unitId, expectedStatus: 'BLOCKED', toStatus: 'AVAILABLE', unset: ['heldForLeadId'],
    });
    throw err;
  }

  // §55.12: Block Unit is also a lead stage, reached only through this action (§83).
  const blockStage = await stagesService.bySemantic({ tenantId, semanticType: 'BLOCKED' });
  if (blockStage) {
    await leadsService.changeStage({
      tenantId, actor, leadId, stageId: blockStage._id, viaAction: true, sourceAction: 'UNIT_BLOCKED',
      note: `Unit ${unit.unitNumber} blocked`,
    });
  }
  await Lead.updateOne({ tenantId, _id: leadId }, { $set: { activeBlockId: blockRecord._id } });

  await timeline.log({
    tenantId, leadId, contactId: lead.contactId, type: 'UNIT_BLOCKED',
    title: `Unit ${unit.unitNumber} blocked until ${expiryAt.toISOString()}`,
    actor,
    meta: { unitId: String(unitId), blockId: String(blockRecord._id), expiryAt, tokenAmountMinor },
  });
  emit(EVENTS.UNIT_BLOCKED, { tenantId, leadId, unitId, blockId: blockRecord._id, expiryAt });
  await audit.record({
    tenantId, actor, entity: 'UnitBlock', entityId: blockRecord._id, action: 'CREATE',
    after: { unitId, leadId, expiryAt },
  });
  return blockRecord;
}

/** §32.2: a manual release hands the unit straight back to inventory. */
async function release({ tenantId, actor, blockId, reason, status = 'RELEASED' }) {
  const blockRecord = await UnitBlock.findOne({ tenantId, _id: blockId });
  if (!blockRecord) throw notFound('Block not found.');
  if (blockRecord.status !== 'ACTIVE') return blockRecord;

  blockRecord.status = status;
  blockRecord.releasedAt = new Date();
  blockRecord.releasedBy = actor?._id;
  blockRecord.releaseReason = reason;
  await blockRecord.save();

  await inventory.releaseClaim({
    tenantId, unitId: blockRecord.unitId, expectedStatus: 'BLOCKED', toStatus: 'AVAILABLE',
    unset: ['heldForLeadId', 'currentBlockId'],
  });
  await Lead.updateOne({ tenantId, _id: blockRecord.leadId }, { $unset: { activeBlockId: '' } });

  const unit = await Unit.findOne({ tenantId, _id: blockRecord.unitId }).select('unitNumber').lean();
  await timeline.log({
    tenantId,
    leadId: blockRecord.leadId,
    contactId: blockRecord.contactId,
    type: status === 'EXPIRED' ? 'BLOCK_EXPIRED' : 'BLOCK_RELEASED',
    title: status === 'EXPIRED'
      ? `Block on unit ${unit?.unitNumber} expired — unit back in inventory`
      : `Block on unit ${unit?.unitNumber} released`,
    body: reason,
    actor,
    actorType: actor ? 'USER' : 'SYSTEM',
    meta: { unitId: String(blockRecord.unitId), blockId: String(blockRecord._id) },
  });

  if (status === 'EXPIRED') emit(EVENTS.UNIT_BLOCK_EXPIRED, { tenantId, blockId: blockRecord._id });
  await audit.record({
    tenantId, actor, entity: 'UnitBlock', entityId: blockRecord._id, action: status,
    after: { reason },
  });
  return blockRecord;
}

/**
 * §32.4: the expiry sweep. Reminders first, then release.
 * Idempotent — a repeated run cannot double-remind or double-release (§106).
 */
async function expirySweep({ tenantId = null, now = new Date() } = {}) {
  const scope = tenantId ? { tenantId } : {};
  const result = { reminded: 0, expired: 0 };

  const tenants = new Map();
  const tenantFor = async (id) => {
    const key = String(id);
    if (!tenants.has(key)) tenants.set(key, await Tenant.findById(id).lean());
    return tenants.get(key);
  };

  // 1. Reminders, inside the configured window before expiry.
  const upcoming = await UnitBlock.find({ ...scope, status: 'ACTIVE', reminderSentAt: null, expiryAt: { $gt: now } })
    .setOptions({ allowCrossTenant: !tenantId })
    .limit(200)
    .lean();

  for (const blockRecord of upcoming) {
    const tenant = await tenantFor(blockRecord.tenantId);
    const windowHours = tenant?.settings?.blockReminderHours ?? 6;
    if (new Date(blockRecord.expiryAt).getTime() - now.getTime() > windowHours * 3600000) continue;

    await UnitBlock.updateOne({ tenantId: blockRecord.tenantId, _id: blockRecord._id }, { $set: { reminderSentAt: now } });
    const unit = await Unit.findOne({ tenantId: blockRecord.tenantId, _id: blockRecord.unitId }).select('unitNumber').lean();
    await notifications.notify({
      tenantId: blockRecord.tenantId,
      userId: blockRecord.blockedBy,
      type: 'BLOCK_EXPIRING',
      title: 'Unit block expiring soon',
      body: `Unit ${unit?.unitNumber} is released automatically at ${new Date(blockRecord.expiryAt).toISOString()}.`,
      link: `/app/leads/${blockRecord.leadId}`,
      leadId: blockRecord.leadId,
      severity: 'WARNING',
    });
    await timeline.log({
      tenantId: blockRecord.tenantId, leadId: blockRecord.leadId, contactId: blockRecord.contactId,
      type: 'BLOCK_EXPIRY_REMINDER', title: `Block on unit ${unit?.unitNumber} expires soon`,
      actorType: 'SYSTEM', at: now, meta: { blockId: String(blockRecord._id) },
    });
    emit(EVENTS.UNIT_BLOCK_EXPIRING, { tenantId: blockRecord.tenantId, blockId: blockRecord._id });
    result.reminded += 1;
  }

  // 2. Expiry: the unit goes back to AVAILABLE and the lead stays active (§32.4.7).
  const due = await UnitBlock.find({ ...scope, status: 'ACTIVE', expiryAt: { $lte: now } })
    .setOptions({ allowCrossTenant: !tenantId })
    .limit(200)
    .lean();

  for (const blockRecord of due) {
    await release({
      tenantId: blockRecord.tenantId, actor: null, blockId: blockRecord._id,
      reason: 'Block expired automatically', status: 'EXPIRED',
    });
    await notifications.notify({
      tenantId: blockRecord.tenantId,
      userId: blockRecord.blockedBy,
      type: 'BLOCK_EXPIRED',
      title: 'Unit block expired',
      body: 'The unit is back in inventory. The lead still needs a next action.',
      link: `/app/leads/${blockRecord.leadId}`,
      leadId: blockRecord.leadId,
      severity: 'CRITICAL',
    });
    result.expired += 1;
  }
  return result;
}

const activeFor = ({ tenantId, leadId }) => UnitBlock.find({ tenantId, leadId, status: 'ACTIVE' })
  .populate('unitId', 'unitNumber status')
  .lean();

/** §8.4 manager panel: blocks expiring soon. */
const expiringSoon = ({ tenantId, userIds, hours = 24, now = new Date() }) => UnitBlock.find({
  tenantId,
  status: 'ACTIVE',
  expiryAt: { $gte: now, $lte: new Date(now.getTime() + hours * 3600000) },
  ...(userIds ? { blockedBy: { $in: userIds } } : {}),
})
  .sort({ expiryAt: 1 })
  .populate('unitId', 'unitNumber')
  .populate('contactId', 'displayName')
  .populate('blockedBy', 'name')
  .lean();

module.exports = { block, release, expirySweep, resolveExpiry, activeFor, expiringSoon };
