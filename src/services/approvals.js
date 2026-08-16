const { ApprovalRule, Approval, CostSheet, User, Role } = require('../db/models');
const { badRequest, notFound, forbidden } = require('../lib/errors');
const { EVENTS, emit } = require('../lib/events');
const { can } = require('../lib/access');
const notifications = require('./notifications');
const timeline = require('./timeline');
const audit = require('./audit');

/**
 * Spec §31: discount approval.
 *
 * Three rules do the work: an approver may never edit the requested figures
 * (§31.3), nobody self-approves without explicit permission (§31.3), and
 * changing an approved discount invalidates the approval and starts again.
 */

/** §31.1: the first matching rule by threshold, lowest level first. */
async function resolveRule({ tenantId, projectId, discountMinor, discountPercentage }) {
  const rules = await ApprovalRule.find({
    tenantId, active: true, projectId: { $in: [projectId || null, null] },
  }).sort({ level: 1, sequence: 1 }).lean();

  const matches = rules.filter((rule) => {
    const value = rule.triggerType === 'DISCOUNT_AMOUNT' ? discountMinor : discountPercentage;
    if (value <= 0) return false;
    if (value < rule.minThreshold) return false;
    if (rule.maxThreshold != null && value > rule.maxThreshold) return false;
    return true;
  });
  if (!matches.length) return null;
  // Project-specific rules beat organization-wide ones at the same level.
  return matches.sort((a, b) => (b.projectId ? 1 : 0) - (a.projectId ? 1 : 0) || a.level - b.level)[0];
}

async function approverIdsFor({ tenantId, rule }) {
  if (rule.approverUserIds?.length) return rule.approverUserIds;
  if (rule.approverRoleId) {
    const users = await User.find({ tenantId, roleId: rule.approverRoleId, status: 'ACTIVE' }).select('_id').lean();
    if (users.length) return users.map((u) => u._id);
  }
  // Fall back to anyone who actually holds the approve permission.
  const roles = await Role.find({ tenantId, active: true }).lean();
  const approverRoleIds = roles
    .filter((role) => role.isAdmin || role.permissions?.['discount.approve'])
    .map((role) => role._id);
  const users = await User.find({ tenantId, roleId: { $in: approverRoleIds }, status: 'ACTIVE' }).select('_id').lean();
  return users.map((u) => u._id);
}

/** §31.2: raise the request and park the cost sheet until it is decided. */
async function request({ tenantId, actor, costSheet, rule }) {
  const approverUserIds = await approverIdsFor({ tenantId, rule });

  const approval = await Approval.create({
    tenantId,
    entity: 'CostSheet',
    entityId: costSheet._id,
    leadId: costSheet.leadId,
    ruleId: rule._id,
    level: rule.level,
    requestedDiscountMinor: costSheet.discountMinor,
    requestedDiscountPercentage: costSheet.discountPercentage,
    requestedFinalMinor: costSheet.finalConsiderationMinor,
    requestedBy: actor._id,
    approverUserIds,
  });

  await CostSheet.updateOne({ tenantId, _id: costSheet._id }, {
    $set: { status: 'APPROVAL_PENDING', approvalRequired: true, approvalId: approval._id },
  });

  await notifications.notifyMany({
    tenantId,
    userIds: approverUserIds,
    type: 'DISCOUNT_APPROVAL_REQUESTED',
    title: 'Discount approval requested',
    body: `${actor.name} needs sign-off on a ${costSheet.discountPercentage.toFixed(2)}% discount.`,
    link: `/app/approvals`,
    leadId: costSheet.leadId,
    severity: 'WARNING',
  });

  await timeline.log({
    tenantId, leadId: costSheet.leadId, contactId: costSheet.contactId, type: 'DISCOUNT_REQUESTED',
    title: `Discount approval requested (${costSheet.discountPercentage.toFixed(2)}%)`, actor,
    meta: { approvalId: String(approval._id), costSheetId: String(costSheet._id) },
  });

  emit(EVENTS.DISCOUNT_APPROVAL_REQUESTED, { tenantId, approvalId: approval._id, costSheetId: costSheet._id });
  await audit.record({
    tenantId, actor, entity: 'Approval', entityId: approval._id, action: 'REQUEST',
    after: { discountMinor: costSheet.discountMinor, costSheetId: costSheet._id },
  });
  return approval;
}

/** §31.2/§31.3: record a decision. The requested figures are never editable here. */
async function decide({ tenantId, actor, approvalId, decision, note }) {
  const approval = await Approval.findOne({ tenantId, _id: approvalId });
  if (!approval) throw notFound('Approval request not found.');
  if (approval.status !== 'PENDING') throw badRequest('This request has already been decided.');
  if (!can(actor, 'discount.approve')) throw forbidden('You cannot approve discounts.');

  // §31.3: no self-approval unless the role explicitly allows it.
  if (String(approval.requestedBy) === String(actor._id) && !actor.role?.permissions?.['discount.approve_own']) {
    throw forbidden('You cannot approve your own discount request.');
  }
  if (approval.approverUserIds?.length
    && !approval.approverUserIds.some((id) => String(id) === String(actor._id))
    && !actor.role?.isAdmin) {
    throw forbidden('This request is waiting on a different approver.');
  }

  approval.status = { APPROVE: 'APPROVED', REJECT: 'REJECTED', CHANGE: 'CHANGE_REQUESTED' }[decision];
  if (!approval.status) throw badRequest('Choose approve, reject or request change.');
  approval.decidedBy = actor._id;
  approval.decidedAt = new Date();
  approval.decisionNote = note;
  await approval.save();

  const costSheet = await CostSheet.findOne({ tenantId, _id: approval.entityId });
  if (costSheet) {
    // §31.3: the discount that was requested is the discount that gets locked in.
    if (approval.status === 'APPROVED') {
      costSheet.status = 'APPROVED';
      costSheet.approvedAt = approval.decidedAt;
      costSheet.approvedBy = actor._id;
    } else {
      costSheet.status = approval.status === 'REJECTED' ? 'REJECTED' : 'DRAFT';
    }
    await costSheet.save();

    await timeline.log({
      tenantId,
      leadId: costSheet.leadId,
      contactId: costSheet.contactId,
      type: approval.status === 'APPROVED' ? 'DISCOUNT_APPROVED' : 'DISCOUNT_REJECTED',
      title: approval.status === 'APPROVED'
        ? `Discount approved by ${actor.name}`
        : `Discount ${approval.status === 'REJECTED' ? 'rejected' : 'sent back'} by ${actor.name}`,
      body: note,
      actor,
      meta: { approvalId: String(approval._id), costSheetId: String(costSheet._id) },
    });

    await notifications.notify({
      tenantId,
      userId: approval.requestedBy,
      type: approval.status === 'APPROVED' ? 'DISCOUNT_APPROVED' : 'DISCOUNT_REJECTED',
      title: approval.status === 'APPROVED' ? 'Discount approved' : 'Discount not approved',
      body: note,
      link: `/app/leads/${costSheet.leadId}`,
      leadId: costSheet.leadId,
      severity: approval.status === 'APPROVED' ? 'INFO' : 'WARNING',
    });

    emit(approval.status === 'APPROVED' ? EVENTS.DISCOUNT_APPROVED : EVENTS.DISCOUNT_REJECTED, {
      tenantId, approvalId: approval._id, costSheetId: costSheet._id,
    });
  }

  await audit.record({
    tenantId, actor, entity: 'Approval', entityId: approval._id, action: approval.status,
    before: { status: 'PENDING' }, after: { status: approval.status, note },
  });
  return approval;
}

/**
 * §31.3 / §102: a discount changed after approval invalidates that approval.
 * Called by the cost-sheet service whenever a new version is produced.
 */
async function invalidateFor({ tenantId, costSheetId, reason = 'Discount changed' }) {
  const open = await Approval.find({ tenantId, entityId: costSheetId, status: 'PENDING' });
  for (const approval of open) {
    approval.status = 'INVALIDATED';
    approval.decisionNote = reason;
    approval.decidedAt = new Date();
    await approval.save();
  }
  return open.length;
}

const pendingFor = ({ tenantId, user }) => Approval.find({
  tenantId,
  status: 'PENDING',
  ...(user.role?.isAdmin ? {} : { approverUserIds: user._id }),
})
  .sort({ requestedAt: 1 })
  .populate('requestedBy', 'name')
  .populate({ path: 'leadId', populate: { path: 'contactId', select: 'displayName primaryMobile' } })
  .lean();

module.exports = { resolveRule, approverIdsFor, request, decide, invalidateFor, pendingFor };
