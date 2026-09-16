const { crud } = require('./factory');
const { badRequest, notFound, conflict } = require('../../lib/errors');
const messages = require('../../lib/society/messages');
const { SocietyRole, SocietyAdmin } = require('../../db/models/society');

/**
 * The society RBAC catalog.
 *
 * Factory CRUD plus three rules the source enforced in its controller, kept
 * here so every caller gets them rather than only the one route that had them:
 *
 *  - a role key is unique among live roles
 *  - a system role can be neither modified nor deleted
 *  - a role still assigned to an active admin cannot be deleted, and the error
 *    names how many admins hold it
 */
const base = crud({
  Model: SocietyRole,
  listKey: 'roles',
  searchFields: ['key', 'name', 'displayName'],
  filterFields: ['scope', 'isActive'],
  unique: ['key'],
  sort: { level: 1 },
});

const M = messages.en.role;

async function load(id) {
  const role = await SocietyRole.findOne({ _id: id, isDeleted: false });
  if (!role) throw notFound(M.not_found);
  return role;
}

/** List with a live count of admins per role, which the roles screen shows. */
async function list(ctx, query) {
  const page = await base.list(ctx, query);
  const counts = await SocietyAdmin.aggregate([
    { $match: { isDeleted: false, isActive: true } },
    { $group: { _id: '$roleId', count: { $sum: 1 } } },
  ]);
  const byRole = new Map(counts.map((c) => [String(c._id), c.count]));
  page.roles = page.roles.map((r) => ({ ...r, adminCount: byRole.get(String(r._id)) || 0 }));
  return page;
}

async function create(ctx, data, actorId) {
  if (await SocietyRole.findOne({ key: data.key, isDeleted: false }).select('_id').lean()) {
    throw conflict(M.already_exists);
  }
  // A role minted through the API is never a system role, whatever was posted.
  return base.create(ctx, { ...data, isSystem: false }, actorId);
}

async function update(ctx, id, data, actorId) {
  const role = await load(id);
  if (role.isSystem) throw badRequest(M.system_role_modify);
  return base.update(ctx, id, { ...data, isSystem: undefined }, actorId);
}

async function remove(ctx, id, actorId) {
  const role = await load(id);
  if (role.isSystem) throw badRequest(M.system_role_delete);

  const adminCount = await SocietyAdmin.countDocuments({
    roleId: id, isDeleted: false, isActive: true,
  });
  if (adminCount > 0) {
    // Deleting it would leave those admins with no resolvable permissions.
    throw conflict(M.in_use.replace('{count}', adminCount));
  }
  return base.remove(ctx, id, actorId);
}

module.exports = {
  ...base, list, create, update, remove, load,
};
