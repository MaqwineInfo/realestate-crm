const { User } = require('../db/models');
const { SCOPE_RANK } = require('./permissions');

/**
 * Spec §6.3 / §74: authorization is resolved on the server, from the session
 * user's role — never from anything the client sends.
 */

/** Does the user hold this permission at all? */
function can(user, key) {
  if (!user || !user.role) return false;
  if (user.role.isAdmin) return true;
  const value = user.role.permissions?.[key];
  return value === true || (typeof value === 'string' && value !== 'none');
}

/** 'none' | 'own' | 'team' | 'all' for a scoped permission (§6.3). */
function scopeOf(user, key) {
  if (!user || !user.role) return 'none';
  if (user.role.isAdmin) return 'all';
  const value = user.role.permissions?.[key];
  if (value === true) return 'own';
  if (typeof value === 'string' && SCOPE_RANK[value] !== undefined) return value;
  return 'none';
}

/** The user's team: themselves plus their direct reports (§6.3). */
async function teamUserIds(user) {
  const reports = await User.find({ tenantId: user.tenantId, managerId: user._id }).select('_id').lean();
  return [user._id, ...reports.map((r) => r._id)];
}

/**
 * Mongo filter fragment restricting a collection to what the user may see.
 * Returns null when the user may see nothing — callers must treat null as
 * "deny", never as "no filter".
 */
async function scopeFilter(user, key, field = 'ownerUserId') {
  const scope = scopeOf(user, key);
  if (scope === 'all') return {};
  if (scope === 'own') return { [field]: user._id };
  if (scope === 'team') return { [field]: { $in: await teamUserIds(user) } };
  return null;
}

/** Can this user act on a record owned by `ownerUserId`? */
async function canActOn(user, key, ownerUserId) {
  const scope = scopeOf(user, key);
  if (scope === 'all') return true;
  if (scope === 'none') return false;
  if (!ownerUserId) return scope === 'all';
  if (String(ownerUserId) === String(user._id)) return true;
  if (scope === 'team') {
    const ids = await teamUserIds(user);
    return ids.some((id) => String(id) === String(ownerUserId));
  }
  return false;
}

module.exports = { can, scopeOf, teamUserIds, scopeFilter, canActOn };
