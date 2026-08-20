const { AssignmentPool, User, Lead } = require('../db/models');
const { EVENTS, emit } = require('../lib/events');
const timeline = require('./timeline');
const notifications = require('./notifications');

/**
 * Spec §14: V1 distribution is simple round robin.
 *
 * The pointer is advanced with an atomic `$inc` inside `findOneAndUpdate`, so
 * two leads captured at the same instant read different cursor values and can
 * never be handed to the same user by accident (§14.2) — no transaction needed,
 * which matters on a standalone mongod (§87).
 *
 * Manual transfers deliberately do not touch the cursor (§14.2).
 */

/**
 * V2 §148: `poolType` keeps the lead rotation and the collection rotation in
 * separate documents, so they cannot share a cursor. Pools created before V2
 * have no `poolType` field at all, hence the $ne match rather than an equality
 * one — a missing field means the original lead pool.
 */
const typeFilter = (poolType) => (poolType === 'COLLECTION'
  ? { poolType: 'COLLECTION' }
  : { poolType: { $ne: 'COLLECTION' } });

/** Project pool if one is configured, otherwise the organization default. */
async function resolvePool({ tenantId, projectId, poolType = 'LEAD' }) {
  if (projectId) {
    const projectPool = await AssignmentPool.findOne({
      tenantId, projectId, active: true, ...typeFilter(poolType),
    }).lean();
    if (projectPool) return projectPool;
  }
  return defaultPool({ tenantId, poolType });
}

const defaultPool = ({ tenantId, poolType = 'LEAD' }) => AssignmentPool.findOne({
  tenantId, isDefault: true, active: true, ...typeFilter(poolType),
}).lean();

/** Active members only — suspended and inactive users are skipped (§14.2). */
async function eligibleMembers({ tenantId, pool }) {
  if (!pool || !pool.memberIds?.length) return [];
  const users = await User.find({
    tenantId, _id: { $in: pool.memberIds }, status: 'ACTIVE',
  }).select('_id name').lean();
  // Preserve the configured order so the rotation is predictable.
  const byId = new Map(users.map((u) => [String(u._id), u]));
  return pool.memberIds.map((id) => byId.get(String(id))).filter(Boolean);
}

/**
 * Picks the next owner. Returns null when nobody is eligible — the caller then
 * leaves the lead in the Unassigned queue rather than inventing an owner.
 */
async function nextOwner({ tenantId, projectId, excludeUserIds = [], poolType = 'LEAD' }) {
  const pool = await resolvePool({ tenantId, projectId, poolType });
  if (!pool) return { pool: null, user: null };

  const picked = await pickFrom({ tenantId, pool, excludeUserIds });
  if (picked) return { pool, user: picked };

  /**
   * V1.1 §72: a project pool whose members are all suspended must not black-hole
   * the project's leads. Fall back to the organization default before giving up,
   * and say so in the log — a silent fallback is how "why did Priya get a Green
   * Avenue lead" becomes unanswerable.
   */
  if (pool.projectId) {
    const fallback = await defaultPool({ tenantId, poolType });
    if (fallback && String(fallback._id) !== String(pool._id)) {
      const user = await pickFrom({ tenantId, pool: fallback, excludeUserIds });
      if (user) {
        console.log(JSON.stringify({
          level: 'info',
          scope: 'distribution',
          message: 'project pool had no eligible member, fell back to the default pool',
          projectId: String(projectId),
          poolId: String(pool._id),
        }));
        return { pool: fallback, user, fellBack: true };
      }
    }
  }
  return { pool, user: null };
}

/** Advances one pool's cursor atomically and returns the member it lands on. */
async function pickFrom({ tenantId, pool, excludeUserIds = [] }) {
  const members = await eligibleMembers({ tenantId, pool });
  const candidates = members.filter((m) => !excludeUserIds.some((id) => String(id) === String(m._id)));
  if (!candidates.length) return null;

  const advanced = await AssignmentPool.findOneAndUpdate(
    { tenantId, _id: pool._id },
    { $inc: { cursor: 1 } },
    { returnDocument: 'after' },
  ).lean();

  const index = ((advanced.cursor - 1) % candidates.length + candidates.length) % candidates.length;
  return candidates[index];
}

/**
 * §71: "who gets the next six leads", for the setup screen. Read-only — it never
 * advances the cursor, so looking at the preview cannot change the rotation.
 */
async function preview({ tenantId, pool, count = 6 }) {
  const members = await eligibleMembers({ tenantId, pool });
  if (!members.length) return [];
  return Array.from({ length: count }, (_, i) => {
    const index = ((pool.cursor + i) % members.length + members.length) % members.length;
    return { position: i + 1, user: members[index] };
  });
}

/**
 * Assigns a captured lead. §14.3: with no eligible user the lead stays in the
 * Unassigned queue, the SLA clock still runs, and a manager is told.
 */
async function assignLead({ tenantId, lead, contact, actor = null, excludeUserIds = [] }) {
  const { pool, user } = await nextOwner({ tenantId, projectId: lead.projectId, excludeUserIds });

  if (!user) {
    await Lead.updateOne({ tenantId, _id: lead._id }, { $set: { assignmentPoolId: pool?._id, ownerUserId: null } });
    await timeline.log({
      tenantId, leadId: lead._id, contactId: lead.contactId, type: 'LEAD_ASSIGNED',
      title: 'No active sales user available — moved to Unassigned',
      actorType: 'SYSTEM',
      meta: { poolId: pool ? String(pool._id) : null },
    });
    const managers = pool?.escalationUserIds?.length
      ? pool.escalationUserIds
      : await notifications.adminUserIds(tenantId);
    await notifications.notifyMany({
      tenantId,
      userIds: managers,
      type: 'LEAD_UNASSIGNED',
      title: 'Lead could not be assigned',
      body: `${contact?.displayName || 'A new lead'} is waiting in the Unassigned queue.`,
      link: `/app/leads?unassigned=1`,
      leadId: lead._id,
      severity: 'CRITICAL',
    });
    return { ownerUserId: null, pool };
  }

  await Lead.updateOne({ tenantId, _id: lead._id }, { $set: { assignmentPoolId: pool._id } });
  const leadsService = require('./leads');
  await leadsService.recordAssignment({
    tenantId, lead, ownerUserId: user._id, contact, actor, reason: 'ROUND_ROBIN',
  });
  return { ownerUserId: user._id, pool };
}

/**
 * §16.4 step 7: hand an unattended lead to the next user in the rotation.
 * The current owner is excluded so it genuinely moves on.
 */
async function reassignLead({ tenantId, lead, contact, reason = 'SLA_BREACH' }) {
  const previousOwnerId = lead.ownerUserId;
  const { user } = await nextOwner({
    tenantId, projectId: lead.projectId, excludeUserIds: previousOwnerId ? [previousOwnerId] : [],
  });
  if (!user) return { ownerUserId: null };

  await Lead.updateOne({ tenantId, _id: lead._id }, {
    $set: {
      ownerUserId: user._id,
      previousOwnerUserId: previousOwnerId,
      assignedAt: new Date(),
      slaStatus: 'REASSIGNED',
    },
    $inc: { reassignmentCount: 1 },
  });

  await timeline.log({
    tenantId, leadId: lead._id, contactId: lead.contactId, type: 'LEAD_REASSIGNED',
    title: `Lead auto-reassigned to ${user.name} after no response`,
    actorType: 'SYSTEM',
    meta: { fromUserId: previousOwnerId ? String(previousOwnerId) : null, toUserId: String(user._id), reason },
  });

  emit(EVENTS.LEAD_REASSIGNED, {
    tenantId, lead, previousOwnerId, ownerUserId: user._id,
    contactName: contact?.displayName, reason,
  });
  return { ownerUserId: user._id, user };
}

module.exports = {
  resolvePool, defaultPool, eligibleMembers, pickFrom, nextOwner, preview, assignLead, reassignLead,
};
