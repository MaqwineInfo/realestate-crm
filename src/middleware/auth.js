const authService = require('../services/auth');
const { can, scopeOf } = require('../lib/access');
const { unauthorized, forbidden } = require('../lib/errors');

/**
 * Spec §4.2: tenant context is resolved from the session, never from a client
 * parameter. Everything downstream reads req.tenantId.
 */
async function currentUser(req, res, next) {
  res.locals.currentUser = null;
  res.locals.tenant = null;
  if (!req.session?.userId) return next();

  const user = await authService.loadSessionUser(req.session.userId);
  if (!user) {
    // Deactivated mid-session, or role/tenant disabled: drop the session (§5.2).
    req.session.destroy(() => {});
    return next();
  }
  req.user = user;
  req.tenant = user.tenant;
  req.tenantId = user.tenantId;
  res.locals.currentUser = user;
  res.locals.tenant = user.tenant;
  res.locals.can = (key) => can(user, key);
  res.locals.scopeOf = (key) => scopeOf(user, key);
  next();
}

function requireAuth(req, res, next) {
  if (req.user) return next();
  if (req.accepts('html') && !req.xhr && !req.path.startsWith('/api/')) {
    const target = encodeURIComponent(req.originalUrl);
    return res.redirect(`/login?next=${target}`);
  }
  next(unauthorized());
}

/** Spec §74: RBAC is enforced on the server for every route that mutates. */
function requirePermission(...keys) {
  return (req, res, next) => {
    if (!req.user) return next(unauthorized());
    if (keys.some((key) => can(req.user, key))) return next();
    next(forbidden());
  };
}

module.exports = { currentUser, requireAuth, requirePermission };
