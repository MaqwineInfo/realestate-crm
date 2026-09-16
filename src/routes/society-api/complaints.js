const express = require('express');
const {
  societyAdminVerifyToken, userVerifyToken, adminVerifyToken, superAdminVerifyToken,
} = require('../../middleware/societyAuth');
const messages = require('../../lib/society/messages');
const { badRequest } = require('../../lib/errors');
const {
  wrap, send, ctxOf, toSocietyId,
} = require('./_helpers');
const complaints = require('../../services/society/complaints');

/**
 * Complaints across all three surfaces.
 *
 * Every write lands on `complaints.transition()`, so a status change made from
 * the admin panel, the resident app or the legacy API produces the same history
 * row and the same notification.
 */
const router = express.Router();
const M = messages.en;

const A = '/api/v1/society-admin/complaints';
const R = '/api/v1/app/complaints';
const L = '/api/v1/complaints';

router.use(A, societyAdminVerifyToken);
router.use(R, userVerifyToken);
router.use(L, adminVerifyToken);

/** Who is acting, in the shape the service's history logger expects. */
const adminActor = (req) => ({
  adminId: req.societyAdminId,
  adminUserId: req.societyAdmin?.userId,
  name: req.societyAdmin?.fullName,
});
const residentActor = (req) => ({
  userId: req.societyUserId,
  name: [req.societyUser?.firstName, req.societyUser?.lastName].filter(Boolean).join(' '),
});

function residentCtx(req) {
  const societyId = req.query.societyId || req.body?.societyId || req.societyUser.societyId;
  if (!societyId) throw badRequest('societyId is required');
  return { societyId: toSocietyId(societyId), actorId: req.societyUserId };
}
function legacyCtx(req) {
  const societyId = req.query.societyId || req.body?.societyId;
  if (!societyId) throw badRequest('societyId is required');
  return { societyId: toSocietyId(societyId), actorId: req.societyAdminId || null };
}

/* ------------------------------ admin surface ------------------------------- */

// Types and the literal paths, before `/:id`.
router.get(`${A}/type/getAll`, wrap(async (req, res) => send(
  res, M.common.list_success, await complaints.types.list(ctxOf(req), req.query),
)));
router.post(`${A}/type/create`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.create_success, await complaints.types.create(c, req.body, c.actorId), 201);
}));
router.get(`${A}/type/getById/:id`, wrap(async (req, res) => send(
  res, M.common.detail_success, await complaints.types.detail(ctxOf(req), req.params.id),
)));
router.put(`${A}/type/update/:id`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await complaints.types.update(c, req.params.id, req.body, c.actorId));
}));
router.delete(`${A}/type/delete/:id`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await complaints.types.remove(c, req.params.id, c.actorId));
}));

router.get(`${A}/stats`, wrap(async (req, res) => send(
  res, M.society.statistics_fetched_successfully, await complaints.stats(ctxOf(req)),
)));
router.post(`${A}/generate-id`, wrap(async (req, res) => send(
  res, M.common.create_success, { complaintId: await complaints.generateId(ctxOf(req)) },
)));
router.get(`${A}/code/:complaintId`, wrap(async (req, res) => send(
  res, M.common.detail_success, await complaints.byCode(ctxOf(req), req.params.complaintId),
)));

router.get(A, wrap(async (req, res) => send(
  res, M.common.list_success, await complaints.list(ctxOf(req), req.query),
)));
router.post(A, wrap(async (req, res) => send(
  res, M.common.create_success, await complaints.create(ctxOf(req), req.body, adminActor(req)), 201,
)));
router.get(`${A}/:id`, wrap(async (req, res) => send(
  res, M.common.detail_success, await complaints.detail(ctxOf(req), req.params.id),
)));
router.put(`${A}/:id`, wrap(async (req, res) => send(
  res, M.common.update_success, await complaints.transition(ctxOf(req), req.params.id, req.body, adminActor(req)),
)));
router.patch(`${A}/:id/status`, wrap(async (req, res) => send(
  res, M.common.update_success,
  await complaints.transition(ctxOf(req), req.params.id, {
    status: req.body.status, comment: req.body.comment, resolutionNotes: req.body.resolutionNotes,
  }, adminActor(req)),
)));
router.delete(`${A}/:id`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await complaints.remove(c, req.params.id, c.actorId));
}));

/* ---------------------------- resident surface ------------------------------ */

router.get(`${R}/types`, wrap(async (req, res) => send(
  res, M.common.list_success, await complaints.types.list(residentCtx(req), { ...req.query, status: 'ACTIVE' }),
)));
router.get(`${R}/getMyComplaints`, wrap(async (req, res) => send(
  res, M.common.list_success, await complaints.mine(residentCtx(req), residentActor(req), req.query),
)));
router.get(`${R}/stats`, wrap(async (req, res) => {
  const c = residentCtx(req);
  const { SocietyUnitOccupancy } = require('../../db/models/society');
  const own = await SocietyUnitOccupancy.find({
    societyId: c.societyId, userId: req.societyUserId, isCurrent: true, isDeleted: false,
  }).select('unitId').lean();
  return send(res, M.society.statistics_fetched_successfully,
    await complaints.stats(c, { unitIds: own.map((o) => o.unitId) }));
}));
router.post(`${R}/create`, wrap(async (req, res) => send(
  res, M.common.create_success, await complaints.create(residentCtx(req), req.body, residentActor(req)), 201,
)));
router.get(`${R}/:id`, wrap(async (req, res) => send(
  res, M.common.detail_success, await complaints.detail(residentCtx(req), req.params.id),
)));
router.put(`${R}/:id`, wrap(async (req, res) => send(
  res, M.common.update_success,
  await complaints.residentUpdate(residentCtx(req), req.params.id, req.body, residentActor(req)),
)));
router.delete(`${R}/:id`, wrap(async (req, res) => send(
  res, M.common.update_success,
  await complaints.residentRemove(residentCtx(req), req.params.id, residentActor(req)),
)));

/* ------------------------------ legacy surface ------------------------------ */

router.get(`${L}/stats`, wrap(async (req, res) => send(
  res, M.society.statistics_fetched_successfully, await complaints.stats(legacyCtx(req)),
)));
router.get(`${L}/units/dropdown`, wrap(async (req, res) => send(
  res, M.common.list_success, { units: await complaints.unitsDropdown(legacyCtx(req)) },
)));
router.get(L, wrap(async (req, res) => send(
  res, M.common.list_success, await complaints.list(legacyCtx(req), req.query),
)));
router.post(L, [superAdminVerifyToken], wrap(async (req, res) => send(
  res, M.common.create_success, await complaints.create(legacyCtx(req), req.body, adminActor(req)), 201,
)));
router.get(`${L}/:complaintId`, wrap(async (req, res) => send(
  res, M.common.detail_success, await complaints.detail(legacyCtx(req), req.params.complaintId),
)));
router.put(`${L}/:complaintId`, wrap(async (req, res) => send(
  res, M.common.update_success,
  await complaints.transition(legacyCtx(req), req.params.complaintId, req.body, adminActor(req)),
)));
router.put(`${L}/:complaintId/status`, wrap(async (req, res) => send(
  res, M.common.update_success,
  await complaints.transition(legacyCtx(req), req.params.complaintId, {
    status: req.body.status, comment: req.body.comment,
  }, adminActor(req)),
)));
router.put(`${L}/:complaintId/assign`, wrap(async (req, res) => send(
  res, M.common.update_success,
  await complaints.transition(legacyCtx(req), req.params.complaintId, {
    assignedTo: req.body.assignedTo || req.body.employeeId, comment: req.body.comment,
  }, adminActor(req)),
)));
router.put(`${L}/:complaintId/resolve`, wrap(async (req, res) => send(
  res, M.common.update_success,
  await complaints.transition(legacyCtx(req), req.params.complaintId, {
    status: 'Close',
    resolutionNotes: req.body.resolutionNotes || req.body.notes,
  }, adminActor(req)),
)));
router.delete(`${L}/:complaintId`, [superAdminVerifyToken], wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.update_success, await complaints.remove(c, req.params.complaintId, c.actorId));
}));
router.post(`${L}/:complaintId/comments`, wrap(async (req, res) => send(
  res, M.common.create_success,
  await complaints.addComment(legacyCtx(req), req.params.complaintId, req.body, adminActor(req)), 201,
)));

module.exports = router;
