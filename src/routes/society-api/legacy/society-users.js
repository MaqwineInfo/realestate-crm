const express = require('express');
const { adminVerifyToken, superAdminVerifyToken } = require('../../../middleware/societyAuth');
const messages = require('../../../lib/society/messages');
const { badRequest } = require('../../../lib/errors');
const { wrap, send, toSocietyId } = require('../_helpers');

const members = require('../../../services/society/members');
const committee = require('../../../services/society/committee');
const employees = require('../../../services/society/employees');
const occupancy = require('../../../services/society/occupancy');
const { SocietyUnitOccupancy } = require('../../../db/models/society');

/**
 * The legacy `/api/v1/society-users/*` surface — a compatibility façade
 * (SOCIETY-PLAN.md §2.2).
 *
 * The first-generation service kept residents, committee members and staff in
 * one `societyadminmanagers` collection distinguished by a `role` field. That
 * collection is not ported: the three are genuinely different things here
 * (`SocietyUnitOccupancy`, `SocietyCommitteeMember`, `SocietyEmployee`), so
 * these URLs read from whichever one the `role` filter asks for.
 *
 * Scope comes from `?societyId=`, as these clients send it.
 */
const router = express.Router();
const M = messages.en;

function legacyCtx(req) {
  const societyId = req.query.societyId || req.body?.societyId;
  if (!societyId) throw badRequest('societyId is required');
  return { societyId: toSocietyId(societyId), actorId: req.societyAdminId || null };
}

/** The legacy `role` values, mapped to where that population actually lives. */
const POPULATIONS = {
  Member: (ctx, query) => members.societyMembers(ctx, query),
  Resident: (ctx, query) => members.societyMembers(ctx, query),
  User: (ctx, query) => members.societyMembers(ctx, query),
  Committee: async (ctx) => ({ members: await committee.roles().then(() => committee.list(ctx, {})) }),
  Employee: (ctx, query) => employees.list(ctx, query),
};

router.get('/api/v1/society-users/members', [adminVerifyToken], wrap(async (req, res) => send(
  res, M.common.list_success, await members.societyMembers(legacyCtx(req), req.query),
)));

router.get('/api/v1/society-users/committee', [adminVerifyToken], wrap(async (req, res) => send(
  res, M.common.list_success, { committeeMembers: await committee.list(legacyCtx(req), req.query) },
)));

router.get('/api/v1/society-users/employees', [adminVerifyToken], wrap(async (req, res) => send(
  res, M.common.list_success, await employees.list(legacyCtx(req), req.query),
)));

/** The undifferentiated list the legacy clients call, filtered by `role`. */
router.get('/api/v1/society-users', [adminVerifyToken], wrap(async (req, res) => {
  const ctx = legacyCtx(req);
  const population = POPULATIONS[req.query.role] || POPULATIONS.Member;
  return send(res, M.common.list_success, await population(ctx, req.query));
}));

router.post('/api/v1/society-users/create', [superAdminVerifyToken], wrap(async (req, res) => {
  const ctx = legacyCtx(req);
  const member = await occupancy.ensureMember({
    societyId: ctx.societyId, userId: req.body.userId, person: req.body, actorId: ctx.actorId,
  });
  // A legacy "society user" only becomes a resident once attached to a unit.
  if (req.body.unitId) {
    await occupancy.assign({
      societyId: ctx.societyId,
      unitId: req.body.unitId,
      userId: req.body.userId || member.userId || null,
      memberId: member._id,
      residentType: req.body.residentType || 'Owner',
      person: req.body,
      actorId: ctx.actorId,
    });
  }
  return send(res, M.common.create_success, member, 201);
}));

router.get('/api/v1/society-users/:userId', [adminVerifyToken], wrap(async (req, res) => send(
  res, M.common.detail_success,
  { occupancies: await members.userOccupancy(legacyCtx(req), { userId: req.params.userId }) },
)));

router.put('/api/v1/society-users/:userId', [superAdminVerifyToken], wrap(async (req, res) => {
  const ctx = legacyCtx(req);
  const $set = {};
  for (const k of ['firstName', 'lastName', 'email', 'gender', 'age', 'bloodGroup', 'profilePhoto']) {
    if (req.body[k] !== undefined) $set[k] = req.body[k];
  }
  if (!Object.keys($set).length) throw badRequest('Nothing to update.');

  await SocietyUnitOccupancy.updateMany(
    { societyId: ctx.societyId, userId: req.params.userId, isCurrent: true, isDeleted: false },
    { $set },
  );
  return send(res, M.common.update_success,
    { occupancies: await members.userOccupancy(ctx, { userId: req.params.userId }) });
}));

/** Ends every current tenure this user holds in the society. */
router.delete('/api/v1/society-users/:userId', [superAdminVerifyToken], wrap(async (req, res) => {
  const ctx = legacyCtx(req);
  const rows = await SocietyUnitOccupancy.find({
    societyId: ctx.societyId, userId: req.params.userId, isCurrent: true, isDeleted: false, memberRole: 'PRIMARY',
  }).select('_id').lean();

  for (const row of rows) {
    await occupancy.release({ societyId: ctx.societyId, occupancyId: row._id, actorId: ctx.actorId });
  }
  return send(res, M.common.update_success, { released: rows.length });
}));

module.exports = router;
