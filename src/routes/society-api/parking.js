const express = require('express');
const {
  societyAdminVerifyToken, userVerifyToken, adminVerifyToken, superAdminVerifyToken,
} = require('../../middleware/societyAuth');
const messages = require('../../lib/society/messages');
const { badRequest, notFound } = require('../../lib/errors');
const {
  wrap, send, ctxOf, toSocietyId,
} = require('./_helpers');
const parking = require('../../services/society/parking');

/**
 * Parking and vehicles across all three surfaces.
 *
 * The legacy service split slots, levels, allocations and vehicle assignments
 * into four collections; the canonical model keeps the *current* holder on the
 * slot and the history in `SocietyParkingAllocation`. These URLs are mapped
 * onto that (SOCIETY-PLAN.md §2.2) rather than being given their own tables.
 */
const router = express.Router();
const M = messages.en;

const A = '/api/v1/society-admin/parking';
const R = '/api/v1/app';
const L = '/api/v1/parking';

router.use(A, societyAdminVerifyToken);
for (const p of [`${R}/parkings`, `${R}/vehicles`]) router.use(p, userVerifyToken);
router.use(L, adminVerifyToken);

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
const resident = (req) => ({ userId: req.societyUserId });

/* ------------------------------ admin surface -------------------------------- */

router.get(`${A}/spot/grid`, wrap(async (req, res) => send(
  res, M.common.list_success, await parking.grid(ctxOf(req)),
)));
router.get(`${A}/requests`, wrap(async (req, res) => send(
  res, M.common.list_success, { requests: await parking.pendingRequests(ctxOf(req)) },
)));
router.post(`${A}/spot/:id/process`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await parking.processRequest(c, req.params.id, {
    approve: req.body.approve !== false && req.body.action !== 'reject',
    unitId: req.body.unitId,
    vehicleId: req.body.vehicleId,
  }, c.actorId));
}));
router.post(`${A}/spot/:id/deallocate`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await parking.release(c, req.params.id, c.actorId));
}));

router.get(`${A}/levels`, wrap(async (req, res) => send(
  res, M.common.list_success, await parking.levels.list(ctxOf(req), req.query),
)));
router.post(`${A}/levels`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.create_success, await parking.levels.create(c, req.body, c.actorId), 201);
}));
router.get(`${A}/levels/:id`, wrap(async (req, res) => send(
  res, M.common.detail_success, await parking.levels.detail(ctxOf(req), req.params.id),
)));
router.put(`${A}/levels/:id`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await parking.levels.update(c, req.params.id, req.body, c.actorId));
}));
router.delete(`${A}/levels/:id`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await parking.levels.remove(c, req.params.id, c.actorId));
}));

/* ---------------------------- resident surface -------------------------------- */

router.get(`${R}/parkings/levels`, wrap(async (req, res) => send(
  res, M.common.list_success, await parking.levels.list(residentCtx(req), req.query),
)));
router.get(`${R}/parkings/all`, wrap(async (req, res) => send(
  res, M.common.list_success, await parking.grid(residentCtx(req)),
)));
router.get(`${R}/parkings/my-parkings`, wrap(async (req, res) => send(
  res, M.common.list_success, await parking.mine(residentCtx(req), resident(req)),
)));
router.get(`${R}/parkings/get-allocated-parking`, wrap(async (req, res) => send(
  res, M.common.detail_success, await parking.mine(residentCtx(req), resident(req)),
)));
router.get(`${R}/parkings/my-requests`, wrap(async (req, res) => send(
  res, M.common.list_success, { requests: await parking.myRequests(residentCtx(req), resident(req)) },
)));
router.post(`${R}/parkings/:id/request`, wrap(async (req, res) => send(
  res, M.common.create_success, await parking.request(residentCtx(req), req.params.id, resident(req)), 201,
)));
router.post(`${R}/parkings/:id/release`, wrap(async (req, res) => send(
  res, M.common.update_success, await parking.releaseOwn(residentCtx(req), req.params.id, resident(req)),
)));

router.get(`${R}/vehicles/my-vehicles`, wrap(async (req, res) => send(
  res, M.common.list_success, { vehicles: await parking.vehicles.mine(residentCtx(req), resident(req)) },
)));
router.get(`${R}/vehicles/society`, wrap(async (req, res) => send(
  res, M.common.list_success, await parking.vehicles.list(residentCtx(req), req.query),
)));
router.post(`${R}/vehicles`, wrap(async (req, res) => send(
  res, M.common.create_success, await parking.vehicles.add(residentCtx(req), req.body, resident(req)), 201,
)));
router.get(`${R}/vehicles/:id`, wrap(async (req, res) => send(
  res, M.common.detail_success, await parking.vehicles.assertOwn(residentCtx(req), req.params.id, resident(req)),
)));
router.put(`${R}/vehicles/:id`, wrap(async (req, res) => {
  const c = residentCtx(req);
  await parking.vehicles.assertOwn(c, req.params.id, resident(req));
  return send(res, M.common.update_success,
    await parking.vehicles.update(c, req.params.id, req.body, req.societyUserId));
}));
router.delete(`${R}/vehicles/:id`, wrap(async (req, res) => {
  const c = residentCtx(req);
  await parking.vehicles.assertOwn(c, req.params.id, resident(req));
  return send(res, M.common.update_success,
    await parking.vehicles.remove(c, req.params.id, req.societyUserId));
}));

/* ------------------------------ legacy surface --------------------------------- */

router.get(`${L}/tracking`, wrap(async (req, res) => send(
  res, M.common.list_success, await parking.tracking(legacyCtx(req)),
)));
router.get(`${L}/expired-allocations`, wrap(async (req, res) => send(
  res, M.common.list_success, { allocations: await parking.expiredAllocations(legacyCtx(req)) },
)));
router.get(`${L}/pending-locations`, wrap(async (req, res) => send(
  res, M.common.list_success, { allocations: await parking.pendingLocations(legacyCtx(req)) },
)));

router.get(`${L}/levels`, wrap(async (req, res) => send(
  res, M.common.list_success, await parking.levels.list(legacyCtx(req), req.query),
)));
router.post(`${L}/levels`, [superAdminVerifyToken], wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.create_success, await parking.levels.create(c, req.body, c.actorId), 201);
}));
router.get(`${L}/levels/:id`, wrap(async (req, res) => send(
  res, M.common.detail_success, await parking.levels.detail(legacyCtx(req), req.params.id),
)));
router.put(`${L}/levels/:id`, [superAdminVerifyToken], wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.update_success, await parking.levels.update(c, req.params.id, req.body, c.actorId));
}));
router.delete(`${L}/levels/:id`, [superAdminVerifyToken], wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.update_success, await parking.levels.remove(c, req.params.id, c.actorId));
}));

router.get(`${L}/slots`, wrap(async (req, res) => send(
  res, M.common.list_success, await parking.slots.list(legacyCtx(req), req.query),
)));
router.post(`${L}/slots`, [superAdminVerifyToken], wrap(async (req, res) => {
  const c = legacyCtx(req);
  // The legacy shape adds a range of slots to a level in one call.
  if (req.body.from !== undefined || req.body.to !== undefined) {
    return send(res, M.common.create_success,
      await parking.levels.addSlots(c, req.body.levelId || req.body.parkingLevelId, req.body, c.actorId), 201);
  }
  return send(res, M.common.create_success, await parking.slots.create(c, {
    ...req.body, parkingLevelId: req.body.levelId || req.body.parkingLevelId,
  }, c.actorId), 201);
}));
router.get(`${L}/slots/:id`, wrap(async (req, res) => send(
  res, M.common.detail_success, await parking.slots.detail(legacyCtx(req), req.params.id),
)));
router.put(`${L}/slots/:id`, [superAdminVerifyToken], wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.update_success, await parking.slots.update(c, req.params.id, req.body, c.actorId));
}));
router.delete(`${L}/slots/:id`, [superAdminVerifyToken], wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.update_success, await parking.slots.remove(c, req.params.id, c.actorId));
}));

router.get(`${L}/allocations`, wrap(async (req, res) => send(
  res, M.common.list_success, { allocations: await parking.allocations(legacyCtx(req), req.query) },
)));
router.post(`${L}/allocations`, [superAdminVerifyToken], wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.create_success, await parking.allocate(c, req.body.slotId, {
    unitId: req.body.unitId, vehicleId: req.body.vehicleId,
  }, c.actorId), 201);
}));
router.put(`${L}/allocations/:id/release`, [superAdminVerifyToken], wrap(async (req, res) => {
  const c = legacyCtx(req);
  // The legacy id here is the allocation row; the slot is what gets released.
  const { SocietyParkingAllocation } = require('../../db/models/society');
  const row = await SocietyParkingAllocation.findOne({
    societyId: c.societyId, _id: req.params.id, isDeleted: false,
  }).select('slotId').lean();
  if (!row) throw notFound('Allocation not found');
  return send(res, M.common.update_success, await parking.release(c, row.slotId, c.actorId));
}));

router.get(`${L}/vehicles`, wrap(async (req, res) => send(
  res, M.common.list_success, await parking.vehicles.list(legacyCtx(req), req.query),
)));
router.post(`${L}/vehicles`, [superAdminVerifyToken], wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.create_success, await parking.vehicles.create(c, req.body, c.actorId), 201);
}));
router.get(`${L}/vehicles/:id/location`, wrap(async (req, res) => {
  const c = legacyCtx(req);
  const vehicle = await parking.vehicles.detail(c, req.params.id);
  const { SocietyParking } = require('../../db/models/society');
  const slot = vehicle.unitId
    ? await SocietyParking.findOne({
      societyId: c.societyId, unitId: vehicle.unitId, status: 'ALLOCATED', isDeleted: false,
    }).populate('parkingLevelId', 'levelName').lean()
    : null;
  return send(res, M.common.detail_success, { vehicle, slot });
}));
router.put(`${L}/vehicles/:id/location`, [superAdminVerifyToken], wrap(async (req, res) => {
  const c = legacyCtx(req);
  // "Setting a vehicle's location" is allocating its unit a slot.
  const vehicle = await parking.vehicles.detail(c, req.params.id);
  return send(res, M.common.update_success, await parking.allocate(c, req.body.slotId, {
    unitId: vehicle.unitId, vehicleId: vehicle._id,
  }, c.actorId));
}));

module.exports = router;
