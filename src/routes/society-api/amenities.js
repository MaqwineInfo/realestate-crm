const express = require('express');
const { societyAdminVerifyToken, userVerifyToken } = require('../../middleware/societyAuth');
const messages = require('../../lib/society/messages');
const { badRequest } = require('../../lib/errors');
const {
  wrap, send, ctxOf, toSocietyId,
} = require('./_helpers');
const amenities = require('../../services/society/amenities');

/**
 * Amenities across all three surfaces.
 *
 * They share one service, so the resident booking a hall and the admin booking
 * it on their behalf go through the same slot-conflict guard and the same
 * pricing. Only the identity and the response envelope differ.
 */
const router = express.Router();
const M = messages.en;

const A = '/api/v1/society-admin/amenities';
const R = '/api/v1/app/amenity';
const L = '/api/v1/amenity';

router.use(A, societyAdminVerifyToken);
router.use(R, userVerifyToken);

/* ------------------------------ admin surface ------------------------------- */

// Types. Declared before `/:id` so "type" is not read as an amenity id.
router.get(`${A}/type/list`, wrap(async (req, res) => send(
  res, M.common.list_success, await amenities.types.list(ctxOf(req), req.query),
)));
router.post(`${A}/type/create`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.create_success, await amenities.types.create(c, req.body, c.actorId), 201);
}));
router.get(`${A}/type/get-details/:id`, wrap(async (req, res) => send(
  res, M.common.detail_success, await amenities.types.detail(ctxOf(req), req.params.id),
)));
router.put(`${A}/type/:id`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await amenities.types.update(c, req.params.id, req.body, c.actorId));
}));
router.delete(`${A}/type/:id`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await amenities.types.remove(c, req.params.id, c.actorId));
}));

// Bookings. Also before `/:id`, for the same reason.
router.get(`${A}/bookings/calendar`, wrap(async (req, res) => send(
  res, M.common.list_success, await amenities.calendar(ctxOf(req), req.query),
)));
router.get(`${A}/bookings`, wrap(async (req, res) => send(
  res, M.common.list_success, await amenities.bookings.list(ctxOf(req), req.query),
)));
router.post(`${A}/bookings/create`, wrap(async (req, res) => {
  const c = ctxOf(req);
  // No `actor.userId`: an admin books on behalf of a unit, not as themselves.
  return send(res, M.common.create_success, await amenities.book(c, req.body, {}), 201);
}));
router.get(`${A}/bookings/:id`, wrap(async (req, res) => send(
  res, M.common.detail_success, await amenities.bookings.detail(ctxOf(req), req.params.id),
)));
router.patch(`${A}/bookings/:id/cancel`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await amenities.cancel(c, req.params.id, req.body, c.actorId));
}));
router.patch(`${A}/bookings/:id/status`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success,
    await amenities.setBookingStatus(c, req.params.id, req.body.status, c.actorId));
}));
router.patch(`${A}/bookings/:id/verify-payment`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await amenities.verifyPayment(c, req.params.id, req.body, c.actorId));
}));

// Amenities.
router.get(`${A}/list`, wrap(async (req, res) => send(
  res, M.common.list_success, await amenities.list(ctxOf(req), req.query),
)));
router.post(`${A}/create`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.create_success, await amenities.create(c, req.body, c.actorId), 201);
}));
router.get(`${A}/get-details/:id`, wrap(async (req, res) => send(
  res, M.common.detail_success, await amenities.detail(ctxOf(req), req.params.id),
)));
router.get(`${A}/check-availability/:id`, wrap(async (req, res) => send(
  res, M.common.detail_success, await amenities.availability(ctxOf(req), req.params.id, req.query.date),
)));

// Slots and packages hang off one amenity.
router.get(`${A}/:id/slots`, wrap(async (req, res) => send(
  res, M.common.list_success, await amenities.slots.list(ctxOf(req), { ...req.query, amenityId: req.params.id }),
)));
router.post(`${A}/:id/slots`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.create_success, await amenities.addSlot(c, req.params.id, req.body, c.actorId), 201);
}));
router.put(`${A}/:id/slots/:slotId`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await amenities.slots.update(c, req.params.slotId, req.body, c.actorId));
}));
router.delete(`${A}/:id/slots/:slotId`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await amenities.slots.remove(c, req.params.slotId, c.actorId));
}));

router.get(`${A}/:id/packages`, wrap(async (req, res) => send(
  res, M.common.list_success, await amenities.packages.list(ctxOf(req), { ...req.query, amenityId: req.params.id }),
)));
router.post(`${A}/:id/packages`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.create_success, await amenities.addPackage(c, req.params.id, req.body, c.actorId), 201);
}));
router.get(`${A}/:id/packages/:packageId`, wrap(async (req, res) => send(
  res, M.common.detail_success, await amenities.packages.detail(ctxOf(req), req.params.packageId),
)));
router.put(`${A}/:id/packages/:packageId`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success,
    await amenities.packages.update(c, req.params.packageId, req.body, c.actorId));
}));
router.delete(`${A}/:id/packages/:packageId`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await amenities.packages.remove(c, req.params.packageId, c.actorId));
}));

router.patch(`${A}/:id/status`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await amenities.setStatus(c, req.params.id, req.body.status, c.actorId));
}));
router.put(`${A}/:id`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await amenities.update(c, req.params.id, req.body, c.actorId));
}));
router.delete(`${A}/:id`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await amenities.remove(c, req.params.id, c.actorId));
}));

/* ---------------------------- resident surface ------------------------------ */

/** The resident's society, from their own record — never from the request. */
function residentCtx(req) {
  const societyId = req.query.societyId || req.body?.societyId || req.societyUser.societyId;
  if (!societyId) throw badRequest('societyId is required');
  return { societyId: toSocietyId(societyId), actorId: req.societyUserId };
}

router.get(`${R}/types/list`, wrap(async (req, res) => send(
  res, M.common.list_success, await amenities.types.list(residentCtx(req), req.query),
)));
router.get(`${R}/list`, wrap(async (req, res) => send(
  res, M.common.list_success, await amenities.list(residentCtx(req), { ...req.query, status: 'ACTIVE' }),
)));
router.get(`${R}/list-bookings`, wrap(async (req, res) => send(
  res, M.common.list_success,
  await amenities.bookings.list(residentCtx(req), { ...req.query, userId: String(req.societyUserId) }),
)));
router.get(`${R}/get-details/:id`, wrap(async (req, res) => send(
  res, M.common.detail_success, await amenities.detail(residentCtx(req), req.params.id),
)));
router.get(`${R}/availability/:id`, wrap(async (req, res) => send(
  res, M.common.detail_success, await amenities.availability(residentCtx(req), req.params.id, req.query.date),
)));
router.post(`${R}/create-booking`, wrap(async (req, res) => send(
  res, M.common.create_success,
  await amenities.book(residentCtx(req), req.body, { userId: req.societyUserId }), 201,
)));
router.get(`${R}/bookings/:id/invoice`, wrap(async (req, res) => send(
  res, M.common.detail_success, await amenities.invoice(residentCtx(req), req.params.id),
)));

/* ----------------------------- legacy surface ------------------------------- */

const legacyPricing = require('../../services/society/amenityPricing');

function legacyCtx(req) {
  const societyId = req.query.societyId || req.body?.societyId;
  if (!societyId) throw badRequest('societyId is required');
  return { societyId: toSocietyId(societyId), actorId: req.societyAdminId || null };
}

router.use(L, societyAdminVerifyToken);

router.get(`${L}/amenities`, wrap(async (req, res) => send(
  res, M.common.list_success, await amenities.list(legacyCtx(req), req.query),
)));
router.post(`${L}/amenities`, wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.create_success, await amenities.create(c, req.body, c.actorId), 201);
}));
router.get(`${L}/check-availability`, wrap(async (req, res) => send(
  res, M.common.detail_success,
  await amenities.availability(legacyCtx(req), req.query.amenityId, req.query.date),
)));
router.get(`${L}/calculate-price`, wrap(async (req, res) => send(
  res, M.common.detail_success, await amenities.quote(legacyCtx(req), req.query),
)));
router.get(`${L}/bookings`, wrap(async (req, res) => send(
  res, M.common.list_success, await amenities.bookings.list(legacyCtx(req), req.query),
)));
router.post(`${L}/bookings`, wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.create_success, await amenities.book(c, req.body, {}), 201);
}));
router.get(`${L}/pricing`, wrap(async (req, res) => send(
  res, M.common.list_success, await legacyPricing.list(legacyCtx(req), req.query),
)));
router.post(`${L}/pricing`, wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.create_success, await legacyPricing.create(c, req.body, c.actorId), 201);
}));
router.put(`${L}/pricing/:id`, wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.update_success, await legacyPricing.update(c, req.params.id, req.body, c.actorId));
}));
router.get(`${L}/terms`, wrap(async (req, res) => send(
  res, M.common.list_success, await legacyPricing.terms.list(legacyCtx(req), req.query),
)));
router.post(`${L}/terms`, wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.create_success, await legacyPricing.terms.create(c, req.body, c.actorId), 201);
}));
router.put(`${L}/terms/:id`, wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.update_success, await legacyPricing.terms.update(c, req.params.id, req.body, c.actorId));
}));
router.get(`${L}/bookings/:id`, wrap(async (req, res) => send(
  res, M.common.detail_success, await amenities.bookings.detail(legacyCtx(req), req.params.id),
)));
router.put(`${L}/bookings/:id/cancel`, wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.update_success, await amenities.cancel(c, req.params.id, req.body, c.actorId));
}));
router.put(`${L}/bookings/:id/action`, wrap(async (req, res) => {
  const c = legacyCtx(req);
  // The legacy verb: Approve | Reject | Modify.
  const map = { Approve: 'CONFIRMED', Reject: 'CANCELLED', Modify: 'CONFIRMED' };
  const status = map[req.body.action];
  if (!status) throw badRequest('action must be Approve, Reject or Modify');
  return send(res, M.common.update_success, await amenities.setBookingStatus(c, req.params.id, status, c.actorId));
}));
router.put(`${L}/bookings/:id/accept-modification`, wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.update_success, await amenities.setBookingStatus(c, req.params.id, 'CONFIRMED', c.actorId));
}));
router.get(`${L}/amenities/:id`, wrap(async (req, res) => send(
  res, M.common.detail_success, await amenities.detail(legacyCtx(req), req.params.id),
)));
router.put(`${L}/amenities/:id`, wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.update_success, await amenities.update(c, req.params.id, req.body, c.actorId));
}));
router.delete(`${L}/amenities/:id`, wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.update_success, await amenities.remove(c, req.params.id, c.actorId));
}));

module.exports = router;
