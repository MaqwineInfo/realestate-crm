const express = require('express');
const {
  societyAdminVerifyToken, userVerifyToken, adminVerifyToken,
  superAdminVerifyToken, securityGuardVerifyToken, societyAdminOrSecurityGuard,
} = require('../../middleware/societyAuth');
const messages = require('../../lib/society/messages');
const { badRequest } = require('../../lib/errors');
const {
  wrap, send, ctxOf, toSocietyId,
} = require('./_helpers');
const visitors = require('../../services/society/visitors');
const community = require('../../services/society/community');
const employees = require('../../services/society/employees');

/**
 * Visitors, the gate device and staff attendance.
 *
 * `/gatekeeper/*` is the guard's own surface — `securityGuardVerifyToken`
 * checks that their posting to this society is still live, so removing a guard
 * takes effect immediately rather than when their token expires.
 */
const router = express.Router();
const M = messages.en;

const G = '/api/v1/gatekeeper';
const AT = '/api/v1/attendance';
const A = '/api/v1/society-admin/visitors';
const R = '/api/v1/app/visitors';
const L = '/api/v1/visitor';

router.use(G, securityGuardVerifyToken);
router.use(AT, societyAdminOrSecurityGuard);
router.use(A, societyAdminVerifyToken);
router.use(R, userVerifyToken);
router.use(L, adminVerifyToken);

const guard = (req) => ({ employeeId: req.societyEmployee?._id });
const resident = (req) => ({ userId: req.societyUserId });

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
/** The gate is already pinned to one society by `x-society-id`. */
const gateCtx = (req) => ({ societyId: req.societyId, society: req.society, actorId: req.societyEmployee?._id });

/* ------------------------------ gate surface --------------------------------- */

router.get(`${G}/stats`, wrap(async (req, res) => send(
  res, M.society.statistics_fetched_successfully, await visitors.stats(gateCtx(req)),
)));
router.get(`${G}/expected`, wrap(async (req, res) => send(
  res, M.common.list_success, { expected: await visitors.expected(gateCtx(req), req.query) },
)));
router.get(`${G}/list`, wrap(async (req, res) => send(
  res, M.common.list_success, await visitors.logs.list(gateCtx(req), req.query),
)));
router.get(`${G}/members`, wrap(async (req, res) => send(
  res, M.common.list_success, { members: await visitors.membersForGate(gateCtx(req), req.query) },
)));
router.post(`${G}/entry`, wrap(async (req, res) => send(
  res, M.common.create_success, await visitors.recordEntry(gateCtx(req), req.body, guard(req)), 201,
)));
router.put(`${G}/exit`, wrap(async (req, res) => send(
  res, M.common.update_success,
  await visitors.recordExit(gateCtx(req), req.body.visitorLogId || req.body.id, guard(req)),
)));
router.put(`${G}/allow-entry`, wrap(async (req, res) => send(
  res, M.common.update_success,
  await visitors.allowEntry(gateCtx(req), req.body.visitorLogId || req.body.id, guard(req)),
)));
router.delete(`${G}/entry`, wrap(async (req, res) => {
  const c = gateCtx(req);
  return send(res, M.common.update_success,
    await visitors.logs.remove(c, req.body.visitorLogId || req.query.visitorLogId, c.actorId));
}));

// The guard can log things handed in at the gate.
router.get(`${G}/lost-found/list`, wrap(async (req, res) => send(
  res, M.common.list_success, await community.lostAndFound.list(gateCtx(req), req.query),
)));
router.post(`${G}/lost-found/create`, wrap(async (req, res) => send(
  res, M.common.create_success,
  await community.lostAndFound.report(gateCtx(req), req.body, { adminId: req.societyEmployee?._id }), 201,
)));
router.get(`${G}/lost-found/get-details/:id`, wrap(async (req, res) => send(
  res, M.common.detail_success, await community.lostAndFound.detail(gateCtx(req), req.params.id),
)));
router.put(`${G}/lost-found/update/:id`, wrap(async (req, res) => {
  const c = gateCtx(req);
  return send(res, M.common.update_success,
    await community.lostAndFound.update(c, req.params.id, req.body, c.actorId));
}));
router.delete(`${G}/lost-found/delete/:id`, wrap(async (req, res) => {
  const c = gateCtx(req);
  return send(res, M.common.update_success, await community.lostAndFound.remove(c, req.params.id, c.actorId));
}));

/* ------------------------------- attendance ----------------------------------- */

const attendanceCtx = (req) => ({
  societyId: req.societyId,
  actorId: req.societyEmployee?._id || req.societyAdminId,
});

router.post(`${AT}/clock-in`, wrap(async (req, res) => {
  const c = attendanceCtx(req);
  const { SocietyEmployeeAttendance } = require('../../db/models/society');
  const employeeId = req.body.employeeId || req.societyEmployee?._id;
  if (!employeeId) throw badRequest('employeeId is required');

  // An open row IS "on site", so a second clock-in is refused rather than
  // opening a parallel shift.
  const open = await SocietyEmployeeAttendance.findOne({
    societyId: c.societyId, employeeId, status: 'IN',
  }).lean();
  if (open) throw badRequest('That employee is already clocked in.');

  const row = await SocietyEmployeeAttendance.create({
    societyId: c.societyId, employeeId, clockInTime: new Date(), status: 'IN', enteredBy: c.actorId,
  });
  return send(res, M.common.create_success, row.toObject(), 201);
}));

router.put(`${AT}/clock-out`, wrap(async (req, res) => {
  const c = attendanceCtx(req);
  const { SocietyEmployeeAttendance } = require('../../db/models/society');
  const employeeId = req.body.employeeId || req.societyEmployee?._id;

  const open = await SocietyEmployeeAttendance.findOne({
    societyId: c.societyId, employeeId, status: 'IN',
  });
  if (!open) throw badRequest('That employee is not clocked in.');

  const out = new Date();
  const row = await SocietyEmployeeAttendance.findOneAndUpdate(
    { societyId: c.societyId, _id: open._id, status: 'IN' },
    {
      $set: {
        status: 'EXIT',
        clockOutTime: out,
        totalSeconds: Math.max(0, Math.round((out - open.clockInTime) / 1000)),
        exitBy: c.actorId,
      },
    },
    { new: true },
  ).lean();
  return send(res, M.common.update_success, row);
}));

router.get(`${AT}/status`, wrap(async (req, res) => {
  const c = attendanceCtx(req);
  const { SocietyEmployeeAttendance } = require('../../db/models/society');
  const employeeId = req.query.employeeId || req.societyEmployee?._id;
  const open = await SocietyEmployeeAttendance.findOne({
    societyId: c.societyId, employeeId, status: 'IN',
  }).lean();
  return send(res, M.common.detail_success, { onSite: Boolean(open), since: open?.clockInTime || null });
}));

router.get(`${AT}/employees`, wrap(async (req, res) => send(
  res, M.common.list_success, await employees.list(attendanceCtx(req), req.query),
)));
router.get(`${AT}/monthly-report`, wrap(async (req, res) => send(
  res, M.common.list_success, await employees.monthlyReport(attendanceCtx(req), req.query),
)));

/* ------------------------------ admin surface --------------------------------- */

router.get(`${A}/list`, wrap(async (req, res) => send(
  res, M.common.list_success, await visitors.logs.list(ctxOf(req), req.query),
)));

/* ---------------------------- resident surface -------------------------------- */

router.get(`${R}/list`, wrap(async (req, res) => send(
  res, M.common.list_success, await visitors.forResident(residentCtx(req), resident(req), req.query),
)));
router.post(`${R}/create`, wrap(async (req, res) => {
  const c = residentCtx(req);
  const occupancy = await require('../../db/models/society').SocietyUnitOccupancy.findOne({
    societyId: c.societyId, userId: req.societyUserId, isCurrent: true, isDeleted: false,
  }).select('unitId memberId').lean();
  if (!occupancy) throw badRequest('You are not registered as a resident of this society.');

  // A resident pre-approves a visitor for their OWN unit.
  return send(res, M.common.create_success, await visitors.recordEntry(c, {
    ...req.body, unitIds: [occupancy.unitId],
  }, { userId: req.societyUserId, memberId: occupancy.memberId }), 201);
}));
router.put(`${R}/process-entry`, wrap(async (req, res) => send(
  res, M.common.update_success,
  await visitors.decide(residentCtx(req), req.body.visitorLogId || req.body.id, {
    unitId: req.body.unitId,
    approve: req.body.approve !== false && req.body.action !== 'reject',
  }, resident(req)),
)));
router.put(`${R}/update/:id`, wrap(async (req, res) => {
  const c = residentCtx(req);
  return send(res, M.common.update_success,
    await visitors.logs.update(c, req.params.id, req.body, req.societyUserId));
}));
router.delete(`${R}/delete/:id`, wrap(async (req, res) => {
  const c = residentCtx(req);
  return send(res, M.common.update_success,
    await visitors.logs.remove(c, req.params.id, req.societyUserId));
}));

/* ------------------------------ legacy surface --------------------------------- */

router.get(`${L}/passes/number/:passNumber`, wrap(async (req, res) => send(
  res, M.common.detail_success, await visitors.passByNumber(legacyCtx(req), req.params.passNumber),
)));
router.get(`${L}/passes/:id`, wrap(async (req, res) => send(
  res, M.common.detail_success, await visitors.passById(legacyCtx(req), req.params.id),
)));

router.get(L, wrap(async (req, res) => send(
  res, M.common.list_success, await visitors.logs.list(legacyCtx(req), req.query),
)));
router.post(L, [superAdminVerifyToken], wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.create_success, await visitors.recordEntry(c, req.body, {}), 201);
}));
router.get(`${L}/:id`, wrap(async (req, res) => send(
  res, M.common.detail_success, await visitors.logs.detail(legacyCtx(req), req.params.id),
)));
router.put(`${L}/:id`, [superAdminVerifyToken], wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.update_success, await visitors.logs.update(c, req.params.id, req.body, c.actorId));
}));
router.delete(`${L}/:id`, [superAdminVerifyToken], wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.update_success, await visitors.logs.remove(c, req.params.id, c.actorId));
}));
router.put(`${L}/:id/approve-reject`, [superAdminVerifyToken], wrap(async (req, res) => {
  const c = legacyCtx(req);
  const approve = req.body.approve !== false && req.body.status !== 'REJECTED';
  // An admin answers on behalf of every unit that has not answered yet.
  const { SocietyVisitorLog } = require('../../db/models/society');
  const log = await SocietyVisitorLog.findOne({
    societyId: c.societyId, _id: req.params.id, isDeleted: false,
  });
  if (!log) throw badRequest('Visit not found');

  log.unitApprovals.forEach((u) => {
    if (u.status === 'PENDING') {
      u.status = approve ? 'APPROVED' : 'REJECTED';
      u.approvedAt = new Date();
    }
  });
  await log.save();
  const { rollUp } = require('../../services/society/visitors');
  return send(res, M.common.update_success,
    await (rollUp ? rollUp(c, log.toObject(), {}) : log.toObject()));
}));
router.put(`${L}/:id/check-in`, [superAdminVerifyToken], wrap(async (req, res) => send(
  res, M.common.update_success, await visitors.allowEntry(legacyCtx(req), req.params.id, {}),
)));
router.put(`${L}/:id/check-out`, [superAdminVerifyToken], wrap(async (req, res) => send(
  res, M.common.update_success, await visitors.recordExit(legacyCtx(req), req.params.id, {}),
)));

module.exports = router;
