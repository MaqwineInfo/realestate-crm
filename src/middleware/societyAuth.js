const jwt = require('../lib/society/jwt');
const { toJson } = require('../lib/society/envelope');
const {
  Society, SocietyAdmin, SocietyUser, SocietyRole,
  SocietyEmployee, SocietyEmployeeAssignment, SocietyTokenBlacklist,
} = require('../db/models/society');

/**
 * The society API's own identity layer.
 *
 * Follows the `/cp/*` precedent in this codebase exactly: none of these
 * verifiers ever sets `req.user`. Internal authorization (`middleware/auth`,
 * `lib/access`) reads `req.user`, so a resident or gate token cannot satisfy an
 * internal `/app/*` route even if one were mounted here by mistake — which the
 * tests assert rather than assume.
 *
 * What each verifier sets:
 *   superAdminVerifyToken     -> req.societyAdmin  (no society pin)
 *   societyAdminVerifyToken   -> req.societyAdmin + req.societyId + req.society
 *   securityGuardVerifyToken  -> req.societyEmployee + req.societyId
 *   userVerifyToken           -> req.societyUser
 *   adminVerifyToken          -> req.societyAdmin  (platform admin, any society)
 *
 * Error messages and status codes are reproduced from the source, because a
 * client that branches on them is part of the contract (D2). The source's
 * shapes: 401 for a missing/expired/blacklisted token, 400 for a missing
 * `x-society-id`, 401 for "you do not administer that society".
 *
 * Two things the source did over HTTP that are local reads here (§3.6): the
 * token blacklist check and the user lookup. It called `user-services` on every
 * single request, with an LRU cache in front to survive it.
 */

const MSG = {
  empty_token: 'Token is required',
  token_expired: 'Token is expired',
  blacklist: 'Token is blacklisted',
  not_auth: 'You are not authorized',
  un_authenticate: 'Unauthenticated',
  society_required: 'SocietyId (x-society-id) header is required',
  access_denied: 'Access denied for this society',
};

const deny = (res, status, message) => res.status(status).send(toJson(message));

/** Reads and verifies a bearer token for one audience, or null. */
async function decode(req, audience) {
  const token = jwt.readHeaderToken(req);
  if (!token) return { error: [401, MSG.empty_token] };

  // Logout has to be honoured for the life of the token; there is no session
  // store to drop it from.
  const revoked = await SocietyTokenBlacklist.exists({ token, isDeleted: false });
  if (revoked) return { error: [401, MSG.blacklist] };

  const payload = jwt.verify(audience, token);
  if (!payload) return { error: [401, MSG.token_expired] };
  return { token, payload };
}

/** Resolves and validates the `x-society-id` pin. */
async function resolveSociety(req) {
  const societyId = req.header('x-society-id');
  if (!societyId) return { error: [400, MSG.society_required] };
  const society = await Society.findOne({ _id: societyId, isDeleted: false });
  if (!society) return { error: [401, MSG.access_denied] };
  return { society };
}

/** An admin acting inside one society: theirs, or one they are assigned. */
function administers(admin, societyId) {
  const id = String(societyId);
  if (admin.societyId && String(admin.societyId) === id) return true;
  return (admin.societies || []).some((s) => String(s.societyId) === id);
}

/**
 * The admin token signs `id` as the admin's **SocietyUser** id and `adminId` as
 * the admin row's own `_id` — not the other way round. Resolving by `_id`
 * alone silently authenticates nobody, so both are accepted.
 */
async function loadAdmin(payload) {
  const or = [];
  if (payload.adminId) or.push({ _id: payload.adminId });
  if (payload.id) or.push({ userId: payload.id }, { _id: payload.id });
  if (!or.length) return null;
  return SocietyAdmin.findOne({ $or: or, isDeleted: false, isActive: true }).populate('roleId');
}

/* -------------------------------------------------------------------------- */

/** Platform admin. Not pinned to a society. */
async function adminVerifyToken(req, res, next) {
  try {
    const { error, payload } = await decode(req, 'admin');
    if (error) return deny(res, ...error);

    const admin = await loadAdmin(payload);
    if (!admin) return deny(res, 401, MSG.not_auth);

    req.societyAdmin = admin;
    req.societyAdminId = admin._id;
    return next();
  } catch (err) { return next(err); }
}

/** Super admin: platform scope, `global` role. */
async function superAdminVerifyToken(req, res, next) {
  try {
    const { error, payload } = await decode(req, 'admin');
    if (error) return deny(res, ...error);

    const admin = await loadAdmin(payload);
    if (!admin) return deny(res, 401, MSG.not_auth);
    if (admin.roleId?.scope !== 'global') return deny(res, 401, MSG.not_auth);

    req.societyAdmin = admin;
    req.societyAdminId = admin._id;
    return next();
  } catch (err) { return next(err); }
}

/**
 * Chairman / society admin, pinned to `x-society-id`.
 *
 * The pin is validated against the admin's own assignments on every request —
 * possessing a valid token is not enough to reach a society you do not
 * administer.
 */
async function societyAdminVerifyToken(req, res, next) {
  try {
    const { error, payload } = await decode(req, 'admin');
    if (error) return deny(res, ...error);

    const { error: sErr, society } = await resolveSociety(req);
    if (sErr) return deny(res, ...sErr);

    const admin = await loadAdmin(payload);
    if (!admin) return deny(res, 401, MSG.not_auth);
    if (!administers(admin, society._id)) return deny(res, 401, MSG.access_denied);

    req.societyAdmin = admin;
    req.societyAdminId = admin._id;
    req.society = society;
    req.societyId = society._id;
    return next();
  } catch (err) { return next(err); }
}

/** Resident. The mobile app's identity. */
async function userVerifyToken(req, res, next) {
  try {
    const { error, payload } = await decode(req, 'user');
    if (error) return deny(res, 401, MSG.un_authenticate);

    const user = await SocietyUser.findOne({ _id: payload.id, isDeleted: false });
    if (!user) return deny(res, 401, MSG.un_authenticate);

    req.societyUser = user;
    req.societyUserId = user._id;
    if (user.societyId) req.societyId = user.societyId;
    return next();
  } catch (err) { return next(err); }
}

/**
 * Security guard at the gate.
 *
 * A guard's authority is their *posting*, not their account: the assignment to
 * this society must be live, which is what makes removing a guard take effect
 * immediately rather than when their 30-day token expires.
 */
async function securityGuardVerifyToken(req, res, next) {
  try {
    const { error, payload } = await decode(req, 'user');
    if (error) return deny(res, 401, MSG.un_authenticate);

    const { error: sErr, society } = await resolveSociety(req);
    if (sErr) return deny(res, ...sErr);

    const employee = await SocietyEmployee.findOne({
      $or: [{ _id: payload.id }, { userId: payload.id }],
      isDeleted: false,
      isActive: true,
    });
    if (!employee) return deny(res, 401, MSG.not_auth);

    const assignment = await SocietyEmployeeAssignment.findOne({
      societyId: society._id,
      employeeId: employee._id,
      isDeleted: false,
      status: 'ACTIVE',
    }).populate('employeeTypeId');
    if (!assignment) return deny(res, 401, MSG.access_denied);

    req.societyEmployee = employee;
    req.societyEmployeeAssignment = assignment;
    req.society = society;
    req.societyId = society._id;
    return next();
  } catch (err) { return next(err); }
}

/** Either a society admin or a guard — the attendance surface accepts both. */
async function societyAdminOrSecurityGuard(req, res, next) {
  const token = jwt.readHeaderToken(req);
  if (!token) return deny(res, 401, MSG.empty_token);
  // An admin token verifies only against the admin secret, so trying that
  // first is unambiguous rather than a guess.
  if (jwt.verify('admin', token)) return societyAdminVerifyToken(req, res, next);
  return securityGuardVerifyToken(req, res, next);
}

/**
 * Permission gate for society admins, mirroring the source's
 * `resource:action` catalog with its three wildcard forms. `customPermissions`
 * on the admin overrides the role — including an explicit revoke, which is why
 * it is a Map of booleans rather than a list.
 */
function requireSocietyPermission(permission) {
  return (req, res, next) => {
    const admin = req.societyAdmin;
    if (!admin) return deny(res, 401, MSG.not_auth);

    const override = admin.customPermissions?.get?.(permission);
    if (override === true) return next();
    if (override === false) return deny(res, 403, MSG.not_auth);

    const role = admin.roleId;
    if (role && typeof role.hasPermission === 'function' && role.hasPermission(permission)) {
      return next();
    }
    return deny(res, 403, MSG.not_auth);
  };
}

module.exports = {
  adminVerifyToken,
  superAdminVerifyToken,
  societyAdminVerifyToken,
  userVerifyToken,
  securityGuardVerifyToken,
  societyAdminOrSecurityGuard,
  requireSocietyPermission,
  MSG,
};
