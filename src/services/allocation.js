const { AssignmentPool, User, Project } = require('../db/models');
const { badRequest, notFound } = require('../lib/errors');
const audit = require('./audit');
const distribution = require('./distribution');

/**
 * V1.1 §66–§76: managing the round-robin pools that already drive distribution.
 *
 * The rotation itself is untouched — the atomic cursor in `services/distribution`
 * stays the authority (§71). This module only exists so an admin can see and
 * edit the configuration instead of it being invisible database state.
 *
 * The cursor is deliberately not editable (§68). "Who is next" is a consequence
 * of the rotation, not a setting; letting an admin type it in is how the same
 * salesperson silently gets every lead.
 */
const METHODS = ['ROUND_ROBIN'];

/**
 * V2 §148: the same screens and rules now manage two rotations — leads and
 * collections — kept apart by `poolType`. Pools created before V2 have no
 * `poolType` field, so "the lead pools" means "not the collection ones".
 */
const typeFilter = (poolType) => (poolType === 'COLLECTION'
  ? { poolType: 'COLLECTION' }
  : { poolType: { $ne: 'COLLECTION' } });

/** §76: everything that has to be true before a pool can go live. */
async function validate({ tenantId, data, poolId = null, poolType = 'LEAD' }) {
  const name = String(data.name || '').trim();
  if (!name) throw badRequest('Name this pool.');
  if (data.method && !METHODS.includes(data.method)) {
    throw badRequest('Round robin is the only allocation method in this version.');
  }

  const memberIds = [...new Set((data.memberUserIds || []).map(String))];
  if (memberIds.length !== (data.memberUserIds || []).length) {
    throw badRequest('The same user cannot appear twice in a pool.');
  }

  let projectId = null;
  if (data.scopeType === 'PROJECT') {
    if (!data.projectId) throw badRequest('Choose the project this rule applies to.');
    const project = await Project.findOne({ tenantId, _id: data.projectId }).lean();
    if (!project) throw badRequest('Choose a project in this organization.');
    projectId = project._id;

    // §76: one active pool per project per type, so "which rule applied" is
    // never ambiguous — and a project may have both a lead and a collection rule.
    const clash = await AssignmentPool.findOne({
      tenantId, projectId, active: true, ...typeFilter(poolType), ...(poolId ? { _id: { $ne: poolId } } : {}),
    }).lean();
    if (clash) throw badRequest(`${project.name} already has an active allocation rule.`);
  }

  if (memberIds.length) {
    const active = await User.find({ tenantId, _id: { $in: memberIds }, status: 'ACTIVE' })
      .select('_id name').populate('roleId').lean();
    if (active.length !== memberIds.length) {
      throw badRequest('Every member must be an active user in this organization.');
    }
    // §149: a collection pool member who cannot work collections is a silent
    // black hole — the booking would be assigned to someone with no queue.
    if (poolType === 'COLLECTION') {
      const { can } = require('../lib/access');
      const unable = active.filter((u) => {
        const asUser = { ...u, role: u.roleId };
        return !can(asUser, 'collection.followup') && !can(asUser, 'collection.view');
      });
      if (unable.length) {
        throw badRequest(`${unable.map((u) => u.name).join(', ')} cannot work collections. Grant collection permission in Setup → Roles first.`);
      }
    }
  }
  return { name, projectId, memberIds, escalationUserIds: [...new Set((data.escalationUserIds || []).map(String))] };
}

async function create({ tenantId, actor, data, poolType = 'LEAD' }) {
  const clean = await validate({ tenantId, data, poolType });
  if (!clean.memberIds.length) throw badRequest('Add at least one member before creating a pool.');

  const pool = await AssignmentPool.create({
    tenantId,
    name: clean.name,
    projectId: clean.projectId,
    poolType,
    isDefault: false,
    memberIds: clean.memberIds,
    escalationUserIds: clean.escalationUserIds,
    active: true,
  });
  await audit.record({
    tenantId, actor, entity: 'AssignmentPool', entityId: pool._id, action: 'CREATE',
    after: { name: pool.name, projectId: clean.projectId, members: clean.memberIds.length },
  });
  return pool;
}

async function update({ tenantId, actor, poolId, data }) {
  const pool = await AssignmentPool.findOne({ tenantId, _id: poolId });
  if (!pool) throw notFound('Allocation pool not found.');

  // The default pool is the organization's safety net — it cannot become
  // project-scoped, and it cannot be left without anyone in it (§72).
  const scopeType = pool.isDefault ? 'DEFAULT' : data.scopeType;
  const clean = await validate({
    tenantId, data: { ...data, scopeType }, poolId: pool._id, poolType: pool.poolType || 'LEAD',
  });
  if (pool.isDefault && !clean.memberIds.length) {
    throw badRequest('The default pool must keep at least one member — it is the fallback for every project.');
  }

  const before = {
    name: pool.name, members: pool.memberIds.map(String), escalation: pool.escalationUserIds.map(String),
  };
  pool.name = clean.name;
  pool.memberIds = clean.memberIds;
  pool.escalationUserIds = clean.escalationUserIds;
  if (!pool.isDefault) pool.projectId = clean.projectId;
  await pool.save();

  await audit.record({
    tenantId, actor, entity: 'AssignmentPool', entityId: pool._id, action: 'UPDATE',
    before, after: { name: pool.name, members: clean.memberIds, escalation: clean.escalationUserIds },
  });
  return pool;
}

/** §76: historical configuration is deactivated, never deleted. */
async function toggle({ tenantId, actor, poolId }) {
  const pool = await AssignmentPool.findOne({ tenantId, _id: poolId });
  if (!pool) throw notFound('Allocation pool not found.');
  if (pool.isDefault && pool.active) {
    throw badRequest('The default pool cannot be switched off — every unmatched lead falls back to it.');
  }
  pool.active = !pool.active;
  await pool.save();
  await audit.record({
    tenantId, actor, entity: 'AssignmentPool', entityId: pool._id,
    action: pool.active ? 'ACTIVATE' : 'DEACTIVATE',
  });
  return pool;
}

/** §70: member order is the rotation order, so it is a first-class edit. */
async function reorder({ tenantId, actor, poolId, memberUserIds }) {
  const pool = await AssignmentPool.findOne({ tenantId, _id: poolId });
  if (!pool) throw notFound('Allocation pool not found.');

  const current = pool.memberIds.map(String);
  const next = [...new Set((memberUserIds || []).map(String))];
  if (next.length !== current.length || next.some((id) => !current.includes(id))) {
    throw badRequest('Reordering cannot add or remove members — save the pool for that.');
  }
  pool.memberIds = next;
  await pool.save();
  await audit.record({
    tenantId, actor, entity: 'AssignmentPool', entityId: pool._id, action: 'REORDER',
    before: { members: current }, after: { members: next },
  });
  return pool;
}

/** Everything the setup screen needs, including the read-only next-up preview. */
async function overview({ tenantId, poolType = 'LEAD' }) {
  const pools = await AssignmentPool.find({ tenantId, ...typeFilter(poolType) })
    .sort({ isDefault: -1, name: 1 })
    .populate('projectId', 'name')
    .populate('memberIds', 'name email status')
    .populate('escalationUserIds', 'name')
    .lean();

  return Promise.all(pools.map(async (pool) => ({
    ...pool,
    // A member who has since been suspended is shown, flagged, and skipped at
    // runtime (§70) — quietly dropping them hides a broken rotation.
    inactiveMembers: (pool.memberIds || []).filter((m) => m.status !== 'ACTIVE').length,
    upcoming: await distribution.preview({ tenantId, pool }),
  })));
}

module.exports = { METHODS, validate, create, update, toggle, reorder, overview, typeFilter };
