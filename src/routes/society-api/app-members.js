const express = require('express');
const { userVerifyToken } = require('../../middleware/societyAuth');
const messages = require('../../lib/society/messages');
const { badRequest } = require('../../lib/errors');
const { wrap, send, toSocietyId } = require('./_helpers');
const members = require('../../services/society/members');

/**
 * `/api/v1/app/members/*` — the resident app's people surface.
 *
 * The first router on the resident identity: `userVerifyToken` sets
 * `req.societyUser` and never `req.user`, so nothing reachable here can cross
 * into the internal `/app/society/*` admin.
 *
 * The society and unit come from query parameters, as the source's clients
 * send them — but they are never trusted on their own. Every write resolves the
 * caller's own PRIMARY occupancy in that unit first, so passing someone else's
 * `unitId` finds no occupancy and 404s rather than editing their household.
 */
const router = express.Router();
const M = messages.en;
const B = '/api/v1/app/members';

router.use(B, userVerifyToken);

/** The resident's own identity plus the unit they are acting in. */
function scope(req) {
  const societyId = req.query.societyId || req.body?.societyId || req.societyUser.societyId;
  if (!societyId) throw badRequest('societyId is required');
  return {
    ctx: { societyId: toSocietyId(societyId), actorId: req.societyUserId },
    who: { userId: req.societyUserId, unitId: req.query.unitId || req.body?.unitId },
  };
}

router.get(`${B}/committee`, wrap(async (req, res) => {
  const { ctx } = scope(req);
  return send(res, M.common.list_success, { committeeMembers: await members.committee(ctx) });
}));

router.get(`${B}/society`, wrap(async (req, res) => {
  const { ctx } = scope(req);
  return send(res, M.common.list_success, await members.societyMembers(ctx, req.query));
}));

router.get(`${B}/settings`, wrap(async (req, res) => {
  const { ctx, who } = scope(req);
  return send(res, M.common.detail_success, await members.getSettings(ctx, who));
}));

router.put(`${B}/settings`, wrap(async (req, res) => {
  const { ctx, who } = scope(req);
  return send(res, M.common.update_success, await members.updateSettings(ctx, who, req.body));
}));

router.get(`${B}/family/list`, wrap(async (req, res) => {
  const { ctx, who } = scope(req);
  return send(res, M.common.list_success, await members.listFamily(ctx, who));
}));

router.get(`${B}/family/get-details/:id`, wrap(async (req, res) => {
  const { ctx, who } = scope(req);
  return send(res, M.common.detail_success, await members.familyById(ctx, req.params.id, who));
}));

router.post(`${B}/family/create`, wrap(async (req, res) => {
  const { ctx, who } = scope(req);
  return send(res, M.common.create_success, await members.createFamily(ctx, req.body, who), 201);
}));

router.put(`${B}/family/update/:id`, wrap(async (req, res) => {
  const { ctx, who } = scope(req);
  return send(res, M.common.update_success, await members.updateFamily(ctx, req.params.id, req.body, who));
}));

router.delete(`${B}/family/delete/:id`, wrap(async (req, res) => {
  const { ctx, who } = scope(req);
  return send(res, M.common.update_success, await members.deleteFamily(ctx, req.params.id, who));
}));

module.exports = router;
