const express = require('express');
const { superAdminVerifyToken, adminVerifyToken } = require('../../../middleware/societyAuth');
const messages = require('../../../lib/society/messages');
const { badRequest } = require('../../../lib/errors');
const { wrap, send, toSocietyId } = require('../_helpers');

const blocks = require('../../../services/society/blocks');
const floors = require('../../../services/society/floors');
const units = require('../../../services/society/units');

/**
 * The legacy `/api/v1/{blocks,floors,units}` surface — a compatibility façade
 * (SOCIETY-PLAN.md §2.2).
 *
 * These are the first-generation service's URLs. They keep their exact paths
 * and response shapes but are backed by the canonical models, so there is one
 * copy of the data and one set of rules. Two differences from the newer
 * surface are load-bearing:
 *
 *  1. The society comes from a `?societyId=` **query parameter**, not the
 *     `x-society-id` header. That is how these clients were written.
 *  2. Ids are `:blockId` / `:floorId` / `:unitId`, not `:id`.
 *
 * Everything else — the one-owner rule, soft delete, cascade on block delete —
 * is the shared service layer, so this façade cannot drift from the newer
 * surface the way the two source generations did.
 */
const router = express.Router();
const M = messages.en;

/**
 * The society scope for a legacy call. Required: without it the services would
 * throw a less helpful error deeper in, and a missing scope must never widen
 * into a cross-society read.
 */
function legacyCtx(req) {
  const societyId = req.query.societyId || req.body?.societyId;
  if (!societyId) throw badRequest('societyId is required');
  return { societyId: toSocietyId(societyId), actorId: req.societyAdminId || null };
}

const auth = [adminVerifyToken];

/* --------------------------------- blocks --------------------------------- */

router.get('/api/v1/blocks/dropdown', auth, wrap(async (req, res) => send(
  res, M.common.list_success, { blocks: await blocks.dropdown(legacyCtx(req)) },
)));
router.get('/api/v1/blocks/stats', auth, wrap(async (req, res) => send(
  res, M.society.statistics_fetched_successfully, await blocks.stats(legacyCtx(req)),
)));
router.get('/api/v1/blocks', auth, wrap(async (req, res) => send(
  res, M.common.list_success, await blocks.list(legacyCtx(req), req.query),
)));
router.post('/api/v1/blocks/create', [superAdminVerifyToken], wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.create_success, await blocks.create(c, req.body, c.actorId), 201);
}));
router.get('/api/v1/blocks/:blockId', auth, wrap(async (req, res) => send(
  res, M.common.detail_success, await blocks.detail(legacyCtx(req), req.params.blockId),
)));
router.put('/api/v1/blocks/:blockId', [superAdminVerifyToken], wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.update_success, await blocks.update(c, req.params.blockId, req.body, c.actorId));
}));
router.delete('/api/v1/blocks/:blockId', [superAdminVerifyToken], wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.update_success, await blocks.remove(c, req.params.blockId, c.actorId));
}));

/* --------------------------------- floors --------------------------------- */

router.get('/api/v1/floors/dropdown', auth, wrap(async (req, res) => send(
  res, M.common.list_success, { floors: await floors.dropdown(legacyCtx(req), req.query) },
)));
router.get('/api/v1/floors/stats', auth, wrap(async (req, res) => send(
  res, M.society.statistics_fetched_successfully, await floors.stats(legacyCtx(req)),
)));
router.get('/api/v1/floors/block/:blockId', auth, wrap(async (req, res) => send(
  res, M.common.list_success, { floors: await floors.byBlock(legacyCtx(req), req.params.blockId) },
)));
router.get('/api/v1/floors', auth, wrap(async (req, res) => send(
  res, M.common.list_success, await floors.list(legacyCtx(req), req.query),
)));
router.post('/api/v1/floors/create', [superAdminVerifyToken], wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.create_success, await floors.create(c, req.body, c.actorId), 201);
}));
router.get('/api/v1/floors/:floorId', auth, wrap(async (req, res) => send(
  res, M.common.detail_success, await floors.detail(legacyCtx(req), req.params.floorId),
)));
router.put('/api/v1/floors/:floorId', [superAdminVerifyToken], wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.update_success, await floors.update(c, req.params.floorId, req.body, c.actorId));
}));
router.delete('/api/v1/floors/:floorId', [superAdminVerifyToken], wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.update_success, await floors.remove(c, req.params.floorId, c.actorId));
}));

/* ---------------------------------- units ---------------------------------- */

router.get('/api/v1/units/dropdown', auth, wrap(async (req, res) => send(
  res, M.common.list_success, { units: await units.dropdown(legacyCtx(req), req.query) },
)));
router.get('/api/v1/units', auth, wrap(async (req, res) => send(
  res, M.common.list_success, await units.list(legacyCtx(req), req.query),
)));
router.post('/api/v1/units/create', [superAdminVerifyToken], wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.create_success, await units.create(c, req.body, c.actorId), 201);
}));
router.post('/api/v1/units/:unitId/assign', [superAdminVerifyToken], wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.update_success,
    await units.assignResident(c, req.params.unitId, req.body, c.actorId));
}));
router.post('/api/v1/units/:unitId/unassign', [superAdminVerifyToken], wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.update_success, await units.unassign(c, req.params.unitId, c.actorId));
}));
router.get('/api/v1/units/:unitId', auth, wrap(async (req, res) => send(
  res, M.common.detail_success, await units.detail(legacyCtx(req), req.params.unitId),
)));
router.put('/api/v1/units/:unitId', [superAdminVerifyToken], wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.update_success, await units.update(c, req.params.unitId, req.body, c.actorId));
}));
router.delete('/api/v1/units/:unitId', [superAdminVerifyToken], wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.update_success, await units.remove(c, req.params.unitId, c.actorId));
}));

module.exports = router;
