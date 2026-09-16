const express = require('express');
const {
  userVerifyToken, societyAdminVerifyToken, superAdminVerifyToken,
} = require('../../middleware/societyAuth');
const messages = require('../../lib/society/messages');
const jwtLib = require('../../lib/society/jwt');
const { badRequest } = require('../../lib/errors');
const { wrap, send, ctxOf, toSocietyId } = require('./_helpers');
const residentAuth = require('../../services/society/residentAuth');
const appSociety = require('../../services/society/appSociety');
const listings = require('../../services/society/propertyListings');
const societies = require('../../services/society/societies');
const inquiries = require('../../services/society/inquiries');

/**
 * The resident app's own surface, plus the legacy super-admin society CRUD.
 *
 * Four groups, three identities:
 *
 *   `/app/users/*`            — the front door. The first three are public by
 *                               necessity: they are how you get a token.
 *   `/app/society/*`          — browse, join, and read the buildings you live
 *                               in. Resident token; deliberately NOT pinned to
 *                               one society, because someone shopping for their
 *                               building has not joined one yet.
 *   `/app/property-listing/*` — residents advertising their own flat.
 *   `/society/*`              — the legacy super-admin society CRUD, a pure
 *                               façade over the same `societies` service the
 *                               newer `/super-admin/society/*` uses. Both URLs,
 *                               one implementation, no second copy of the data
 *                               (SOCIETY-PLAN.md §2.2).
 */
const router = express.Router();
const M = messages.en;

const U = '/api/v1/app/users';
const S = '/api/v1/app/society';
const P = '/api/v1/app/property-listing';
const AP = '/api/v1/society-admin/property-listing';
const L = '/api/v1/society';

const limited = (req, res, next) => req.app.locals.limiters.auth(req, res, next);

/* --------------------------- resident front door ---------------------------- */

/**
 * Public on purpose, and rate limited for the same reason the admin OTP routes
 * are: this is the most brute-forcible surface in the product.
 */
router.post(`${U}/register`, limited, wrap(async (req, res) => {
  const { message, result } = await residentAuth.register(req.body);
  return send(res, message, result);
}));
router.post(`${U}/resend-otp`, limited, wrap(async (req, res) => {
  const { message, result } = await residentAuth.resend(req.body);
  return send(res, message, result);
}));
router.post(`${U}/verify-otp`, limited, wrap(async (req, res) => {
  const { message, result } = await residentAuth.verify(req.body);
  return send(res, message, result);
}));

router.post(`${U}/logout`, userVerifyToken, wrap(async (req, res) => {
  const { message } = await residentAuth.logout({ token: jwtLib.readHeaderToken(req) });
  return send(res, message);
}));
router.get(`${U}/profile`, userVerifyToken, wrap(async (req, res) => send(
  res, M.user.detail_fetch_success, await residentAuth.profile(req.societyUser),
)));
router.put(`${U}/profile`, userVerifyToken, wrap(async (req, res) => {
  const { message, result } = await residentAuth.updateProfile(req.societyUserId, req.body);
  return send(res, message, result);
}));

/* ------------------------------- app society -------------------------------- */

router.use(S, userVerifyToken);

/**
 * `/user/society-details` and `/my-societies` are declared before `/:id/details`
 * so a literal segment is never eaten by the parameter.
 */
router.get(`${S}/user/society-details`, wrap(async (req, res) => send(
  res, M.society.society_details_fetched_successfully, await appSociety.assigned(req.societyUserId),
)));
router.get(`${S}/my-societies`, wrap(async (req, res) => {
  const result = await appSociety.mySocieties(req.societyUserId, req.query);
  const { empty, ...body } = result;
  return send(res, empty ? 'No societies found' : M.society.societies_fetched_successfully, body);
}));
router.post(`${S}/register-resident`, wrap(async (req, res) => send(
  res, M.society.registration_success,
  await appSociety.registerResident(req.societyUserId, req.body),
)));
router.post(`${S}/society-request`, wrap(async (req, res) => send(
  res, M.common.create_success, await inquiries.submitFromApp(req.body, req.societyUserId),
)));
router.get(`${S}/:id/details`, wrap(async (req, res) => send(
  res, M.society.society_details_fetched_successfully, await appSociety.structureOf(req.params.id),
)));
router.get(S, wrap(async (req, res) => send(
  res, M.society.societies_fetched_successfully, await appSociety.browse(req.societyUserId, req.query),
)));

/* ----------------------------- property listings ---------------------------- */

router.use(P, userVerifyToken);

/**
 * A resident's token says who they are, not which society they are looking at —
 * they may hold flats in two. The society comes from the request, as it does
 * everywhere else on the resident surface.
 */
function residentCtx(req) {
  const societyId = req.query.societyId || req.body?.societyId || req.societyUser.societyId;
  if (!societyId) throw badRequest(M.society.societyId_required);
  return { societyId: toSocietyId(societyId), actorId: req.societyUserId };
}

const IMAGE_PATH = 'society/property-listing/';

router.post(`${P}/create`, wrap(async (req, res) => send(
  res, M.propertyListing.create_success,
  await listings.create(residentCtx(req), req.body, req.societyUserId), 201,
)));
router.get(`${P}/list`, wrap(async (req, res) => send(
  res, M.propertyListing.list_success,
  { ...await listings.list(residentCtx(req), req.query), imagePath: IMAGE_PATH },
)));
router.get(`${P}/my-list`, wrap(async (req, res) => send(
  res, M.propertyListing.my_list_success,
  { ...await listings.mine(residentCtx(req), req.societyUserId, req.query), imagePath: IMAGE_PATH },
)));
router.get(`${P}/get-details/:id`, wrap(async (req, res) => send(
  res, M.propertyListing.detail_success,
  { listing: await listings.detail(residentCtx(req), req.params.id), imagePath: IMAGE_PATH },
)));
router.put(`${P}/update/:id`, wrap(async (req, res) => send(
  res, M.propertyListing.update_success,
  { ...await listings.update(residentCtx(req), req.params.id, req.body, req.societyUserId), imagePath: IMAGE_PATH },
)));
router.delete(`${P}/delete/:id`, wrap(async (req, res) => {
  await listings.remove(residentCtx(req), req.params.id, req.societyUserId);
  return send(res, M.propertyListing.delete_success);
}));

/** Read-only for the chairman: the board is the residents', not theirs to edit. */
router.get(`${AP}/list`, societyAdminVerifyToken, wrap(async (req, res) => send(
  res, M.propertyListing.list_success,
  { ...await listings.list(ctxOf(req), req.query), imagePath: IMAGE_PATH },
)));

/* --------------------------- legacy society CRUD ---------------------------- */

router.use(L, superAdminVerifyToken);

/**
 * The legacy surface answered 200 with `common.create_success` and an empty
 * result; a client branching on 201 would not recognise the newer shape, so the
 * status and message are the source's. The created society rides along as the
 * result, which the old clients ignore.
 */
router.post(`${L}/create`, wrap(async (req, res) => {
  const ctx = ctxOf(req);
  return send(res, M.common.create_success, await societies.create(ctx, req.body, ctx.actorId));
}));
router.get(L, wrap(async (req, res) => send(
  res, M.society.societies_fetched_successfully, await societies.list(ctxOf(req), req.query),
)));
router.get(`${L}/:societyId`, wrap(async (req, res) => send(
  res, M.society.society_fetched_successfully, await societies.detail(ctxOf(req), req.params.societyId),
)));
router.put(`${L}/:societyId`, wrap(async (req, res) => {
  const ctx = ctxOf(req);
  return send(res, M.society.society_updated_successfully,
    await societies.update(ctx, req.params.societyId, req.body, ctx.actorId));
}));
router.delete(`${L}/:societyId`, wrap(async (req, res) => {
  const ctx = ctxOf(req);
  return send(res, M.society.society_deleted_successfully,
    await societies.remove(ctx, req.params.societyId, ctx.actorId));
}));

module.exports = router;
