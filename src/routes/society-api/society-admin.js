const express = require('express');
const { societyAdminVerifyToken } = require('../../middleware/societyAuth');
const messages = require('../../lib/society/messages');
const { wrap, send, ctxOf } = require('./_helpers');

const societies = require('../../services/society/societies');
const blocks = require('../../services/society/blocks');
const floors = require('../../services/society/floors');
const units = require('../../services/society/units');
const employees = require('../../services/society/employees');
const onboarding = require('../../services/society/onboarding');

/**
 * `/api/v1/society-admin/society/*` — the chairman's own surface.
 *
 * Every route here is pinned to one society by the `x-society-id` header, which
 * `societyAdminVerifyToken` validates against the admin's assignments on every
 * request. `ctxOf(req)` carries that `societyId` into the services, and
 * `societyGuard` throws if any query somehow loses it.
 *
 * Route order matters: the literal paths (`/blocks/stats`, `/units/dropdown`)
 * are declared before their `/:id` siblings, or Express matches "stats" as an
 * id and every one of them 404s.
 */
const router = express.Router();
const M = messages.en;
const B = '/api/v1/society-admin/society';

/**
 * Every prefix on this surface is authenticated and society-pinned.
 *
 * Listing them explicitly rather than guarding only `B`: the committee, users
 * and society-admin routes hang off sibling prefixes, and mounting the guard on
 * one of them left the other three open to anyone. A route added under a new
 * prefix must be added here too, which
 * `tests/society/phase3-members.test.js` asserts by calling each unauthenticated.
 */
const GUARDED = [
  '/api/v1/society-admin/society',
  '/api/v1/society-admin/committee-members',
  '/api/v1/society-admin/society-admins',
  '/api/v1/society-admin/users',
];
for (const prefix of GUARDED) router.use(prefix, societyAdminVerifyToken);

/* ------------------------------ the society ------------------------------- */

router.get(`${B}/assigned-societies`, wrap(async (req, res) => send(
  res, M.common.list_success, { societies: await societies.assignedTo(req.societyAdmin) },
)));

router.get(`${B}/details`, wrap(async (req, res) => send(
  res, M.society.society_details_fetched_successfully, await societies.details(req.societyId),
)));

router.get(`${B}/stats`, wrap(async (req, res) => send(
  res, M.society.statistics_fetched_successfully, await societies.statistics(req.societyId),
)));

/* --------------------------------- blocks --------------------------------- */

router.get(`${B}/blocks-with-floors`, wrap(async (req, res) => send(
  res, M.common.list_success, { blocks: await blocks.withFloors(ctxOf(req)) },
)));
router.get(`${B}/blocks`, wrap(async (req, res) => send(
  res, M.common.list_success, await blocks.list(ctxOf(req), req.query),
)));
router.post(`${B}/blocks`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.create_success, await blocks.create(c, req.body, c.actorId), 201);
}));
router.get(`${B}/blocks/:id`, wrap(async (req, res) => send(
  res, M.common.detail_success, await blocks.detail(ctxOf(req), req.params.id),
)));
router.put(`${B}/blocks/:id`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await blocks.update(c, req.params.id, req.body, c.actorId));
}));
router.delete(`${B}/blocks/:id`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await blocks.remove(c, req.params.id, c.actorId));
}));

/* --------------------------------- floors --------------------------------- */

router.get(`${B}/floors/by-blocks`, wrap(async (req, res) => send(
  res, M.common.list_success, await floors.byBlocks(ctxOf(req), req.query.blockIds || []),
)));
router.get(`${B}/floors`, wrap(async (req, res) => send(
  res, M.common.list_success, await floors.list(ctxOf(req), req.query),
)));
router.post(`${B}/floors/bulk`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.create_success, await floors.bulkCreate(c, req.body, c.actorId), 201);
}));
router.post(`${B}/floors`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.create_success, await floors.create(c, req.body, c.actorId), 201);
}));
router.get(`${B}/floors/:id`, wrap(async (req, res) => send(
  res, M.common.detail_success, await floors.detail(ctxOf(req), req.params.id),
)));
router.put(`${B}/floors/:id`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await floors.update(c, req.params.id, req.body, c.actorId));
}));
router.delete(`${B}/floors/:id`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await floors.remove(c, req.params.id, c.actorId));
}));

/* ---------------------------------- units ---------------------------------- */

router.get(`${B}/units/dropdown`, wrap(async (req, res) => send(
  res, M.common.list_success, { units: await units.dropdown(ctxOf(req), req.query) },
)));
router.get(`${B}/units/by-floors`, wrap(async (req, res) => send(
  res, M.common.list_success, await units.byFloors(ctxOf(req), req.query.floorIds || []),
)));
router.get(`${B}/units`, wrap(async (req, res) => send(
  res, M.common.list_success, await units.list(ctxOf(req), req.query),
)));
router.post(`${B}/units`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.create_success, await units.create(c, req.body, c.actorId), 201);
}));
/** The source updates by id in the BODY here, not the path. */
router.put(`${B}/units`, wrap(async (req, res) => {
  const c = ctxOf(req);
  const { unitId, _id, ...rest } = req.body;
  return send(res, M.common.update_success, await units.update(c, unitId || _id, rest, c.actorId));
}));
router.get(`${B}/units/:id`, wrap(async (req, res) => send(
  res, M.common.detail_success, await units.detail(ctxOf(req), req.params.id),
)));
router.delete(`${B}/units/:id`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await units.remove(c, req.params.id, c.actorId));
}));

/* -------------------------------- tenants ---------------------------------- */

router.get(`${B}/tenants`, wrap(async (req, res) => send(
  res, M.common.list_success, await units.tenants(ctxOf(req), req.query),
)));

/* ------------------------------ employee types ------------------------------ */

router.get(`${B}/employee-types`, wrap(async (req, res) => send(
  res, M.common.list_success, await employees.types.list(ctxOf(req), req.query),
)));
router.post(`${B}/employee-types`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.create_success, await employees.types.create(c, req.body, c.actorId), 201);
}));
router.get(`${B}/employee-types/:id`, wrap(async (req, res) => send(
  res, M.common.detail_success, await employees.types.detail(ctxOf(req), req.params.id),
)));
router.put(`${B}/employee-types/:id`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await employees.types.update(c, req.params.id, req.body, c.actorId));
}));
router.delete(`${B}/employee-types/:id`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await employees.types.remove(c, req.params.id, c.actorId));
}));

/* -------------------------------- employees --------------------------------- */

router.get(`${B}/employees/:employeeId/attendance/monthly`, wrap(async (req, res) => send(
  res, M.common.list_success,
  await employees.monthlyAttendance(ctxOf(req), req.params.employeeId, req.query),
)));
router.get(`${B}/attendance/monthly-report`, wrap(async (req, res) => send(
  res, M.common.list_success, await employees.monthlyReport(ctxOf(req), req.query),
)));
router.get(`${B}/employees`, wrap(async (req, res) => send(
  res, M.common.list_success, await employees.list(ctxOf(req), req.query),
)));
router.post(`${B}/employees`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.create_success, await employees.create(c, req.body, c.actorId), 201);
}));
router.get(`${B}/employees/:id`, wrap(async (req, res) => send(
  res, M.common.detail_success, await employees.detail(ctxOf(req), req.params.id),
)));
router.put(`${B}/employees/:id`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await employees.update(c, req.params.id, req.body, c.actorId));
}));
router.delete(`${B}/employees/:id`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await employees.remove(c, req.params.id, c.actorId));
}));

/* -------------------------- resident onboarding ----------------------------- */

router.get(`${B}/resident-onboarding-requests`, wrap(async (req, res) => send(
  res, M.common.list_success, await onboarding.list(ctxOf(req), req.query),
)));
router.put(`${B}/resident-onboarding-requests/:requestId`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success,
    await onboarding.process(c, req.params.requestId, req.body, c.actorId));
}));

/* ---------------------------- committee members ----------------------------- */

const committee = require('../../services/society/committee');
const members = require('../../services/society/members');
const users = require('../../services/society/users');
const admins = require('../../services/society/admins');

const C = '/api/v1/society-admin/committee-members';

router.get(`${C}/roles`, wrap(async (req, res) => send(
  res, M.common.list_success, { roles: await committee.roles() },
)));
router.get(`${C}/list`, wrap(async (req, res) => send(
  res, M.common.list_success, await committee.list(ctxOf(req), req.query),
)));
router.post(`${C}/create`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.create_success, await committee.create(c, req.body, c.actorId), 201);
}));
router.put(`${C}/update/:id`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await committee.update(c, req.params.id, req.body, c.actorId));
}));
router.delete(`${C}/delete/:id`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await committee.remove(c, req.params.id, c.actorId));
}));

/* ------------------------- society admins (chairman) ------------------------- */

const A = '/api/v1/society-admin/society-admins';

router.get(`${A}/profile`, wrap(async (req, res) => send(
  res, M.common.detail_success, await admins.profile(req.societyAdminId),
)));
router.get(`${A}/society-admins`, wrap(async (req, res) => send(
  res, M.common.list_success,
  await admins.list({ actorId: req.societyAdminId }, { ...req.query, societyId: String(req.societyId) }),
)));
router.post(`${A}/society-admin`, wrap(async (req, res) => send(
  res, M.common.create_success,
  // A chairman may only create admins inside their own society.
  await admins.create({}, { ...req.body, societyId: req.societyId }, req.societyAdminId), 201,
)));
router.get(`${A}/society-admin/:id`, wrap(async (req, res) => send(
  res, M.common.detail_success, await admins.detail({}, req.params.id),
)));
router.put(`${A}/society-admin/:id`, wrap(async (req, res) => send(
  res, M.common.update_success, await admins.update({}, req.params.id, req.body, req.societyAdminId),
)));
router.delete(`${A}/society-admin/:id`, wrap(async (req, res) => send(
  res, M.common.update_success, await admins.remove({}, req.params.id, req.societyAdminId),
)));

/* ---------------------------------- users ------------------------------------ */

const U = '/api/v1/society-admin/users';

router.get(`${U}/service-users`, wrap(async (req, res) => send(
  res, M.common.list_success, await users.list({}, { ...req.query, societyId: String(req.societyId) }),
)));
router.get(`${U}/service-users/:userId`, wrap(async (req, res) => send(
  res, M.common.detail_success, await users.serviceUserById(req.params.userId),
)));
router.get(`${U}/internal-users/get-society-user-ids/:societyId`, wrap(async (req, res) => send(
  res, M.common.list_success, { userIds: await members.societyUserIds(req.params.societyId) },
)));
router.get(`${U}/internal-users/get-user-occupancy`, wrap(async (req, res) => send(
  res, M.common.list_success,
  { occupancies: await members.userOccupancy(ctxOf(req), { userId: req.query.userId, unitId: req.query.unitId }) },
)));
router.get(`${U}/society/:societyId/all`, wrap(async (req, res) => send(
  res, M.common.list_success, { users: await users.allUnits(ctxOf(req), req.params.societyId) },
)));
router.get(`${U}/society/:societyId/stats`, wrap(async (req, res) => send(
  res, M.society.statistics_fetched_successfully, await users.unitStats(req.params.societyId),
)));
router.get(`${U}/society/:societyId/unit/:unitNumber`, wrap(async (req, res) => send(
  res, M.common.detail_success, await users.unitByNumber(req.params.societyId, req.params.unitNumber),
)));
router.get(`${U}/society/:societyId`, wrap(async (req, res) => send(
  res, M.common.list_success, await users.listBySociety(ctxOf(req), req.params.societyId, req.query),
)));
router.put(`${U}/assign-member/:id`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await members.assignMemberToUnit(c, req.params.id, req.body, c.actorId));
}));
router.put(`${U}/:userId/society-admin`, wrap(async (req, res) => send(
  res, M.user.update_success,
  await users.setSocietyAdminFlag(req.params.userId, { value: true, societyId: req.societyId }, req.societyAdminId),
)));
router.delete(`${U}/:userId/society-admin`, wrap(async (req, res) => send(
  res, M.user.update_success,
  await users.setSocietyAdminFlag(req.params.userId, { value: false }, req.societyAdminId),
)));
router.get(`${U}/:id`, wrap(async (req, res) => send(
  res, M.common.detail_success, await users.unitById(req.params.id),
)));
router.put(`${U}/:id`, wrap(async (req, res) => send(
  res, M.user.update_success, await users.updateUnit(req.params.id, req.body, req.societyAdminId),
)));

module.exports = router;
