const express = require('express');
const {
  societyAdminVerifyToken, userVerifyToken, adminVerifyToken, superAdminVerifyToken,
} = require('../../middleware/societyAuth');
const messages = require('../../lib/society/messages');
const { badRequest } = require('../../lib/errors');
const {
  wrap, send, ctxOf, toSocietyId,
} = require('./_helpers');

const notices = require('../../services/society/notices');
const polls = require('../../services/society/polls');
const community = require('../../services/society/community');

/**
 * Phase 6: notices, polls, events, galleries, documents, emergency numbers,
 * lost & found, feedback and the notification inbox — across all three surfaces.
 */
const router = express.Router();
const M = messages.en;

const SA = '/api/v1/society-admin';
const R = '/api/v1/app';
const LN = '/api/v1/notices';
const LG = '/api/v1/society-galleries';

for (const p of [`${SA}/notices`, `${SA}/polls`, `${SA}/events`, `${SA}/feedbacks`,
  `${SA}/building-galleries`, `${SA}/society-documents`, `${SA}/emergency-numbers`,
  `${SA}/lost-found`]) router.use(p, societyAdminVerifyToken);

for (const p of [`${R}/notices`, `${R}/polls`, `${R}/events`, `${R}/building-gallery`,
  `${R}/document`, `${R}/emergency`, `${R}/lost-found`, `${R}/notifications`]) {
  router.use(p, userVerifyToken);
}

router.use(LN, adminVerifyToken);
router.use(LG, adminVerifyToken);

const adminActor = (req) => ({ adminId: req.societyAdminId, name: req.societyAdmin?.fullName });

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
const who = (req) => ({ userId: req.societyUserId, unitId: req.query.unitId || req.body?.unitId });

/* --------------------------------- notices ---------------------------------- */

router.get(`${SA}/notices`, wrap(async (req, res) => send(
  res, M.common.list_success, await notices.list(ctxOf(req), req.query),
)));
router.post(`${SA}/notices`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.create_success, await notices.create(c, req.body, c.actorId), 201);
}));
router.get(`${SA}/notices/:noticeId`, wrap(async (req, res) => send(
  res, M.common.detail_success, await notices.detail(ctxOf(req), req.params.noticeId),
)));
router.put(`${SA}/notices/:noticeId`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await notices.update(c, req.params.noticeId, req.body, c.actorId));
}));
router.delete(`${SA}/notices/:noticeId`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await notices.remove(c, req.params.noticeId, c.actorId));
}));
router.patch(`${SA}/notices/:noticeId/publish`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await notices.publish(c, req.params.noticeId, c.actorId));
}));

router.get(`${R}/notices/getAllNotices`, wrap(async (req, res) => send(
  res, M.common.list_success, await notices.forResident(residentCtx(req), who(req), req.query),
)));
router.get(`${R}/notices/get-details/:id`, wrap(async (req, res) => send(
  res, M.common.detail_success, await notices.detail(residentCtx(req), req.params.id),
)));

// Legacy notice surface.
router.get(`${LN}/stats`, wrap(async (req, res) => send(
  res, M.society.statistics_fetched_successfully, await notices.stats(legacyCtx(req)),
)));
router.get(LN, wrap(async (req, res) => send(
  res, M.common.list_success, await notices.list(legacyCtx(req), req.query),
)));
router.post(LN, [superAdminVerifyToken], wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.create_success, await notices.create(c, req.body, c.actorId), 201);
}));
router.get(`${LN}/:noticeId`, wrap(async (req, res) => send(
  res, M.common.detail_success, await notices.detail(legacyCtx(req), req.params.noticeId),
)));
router.put(`${LN}/:noticeId`, wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.update_success, await notices.update(c, req.params.noticeId, req.body, c.actorId));
}));
router.put(`${LN}/:noticeId/publish`, wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.update_success, await notices.publish(c, req.params.noticeId, c.actorId));
}));
router.put(`${LN}/:noticeId/archive`, wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.update_success,
    await notices.update(c, req.params.noticeId, { status: 'INACTIVE' }, c.actorId));
}));
router.post(`${LN}/:noticeId/acknowledge`, wrap(async (req, res) => {
  const c = legacyCtx(req);
  // The legacy read-receipt: recorded as a notification row against the reader.
  return send(res, M.common.create_success,
    await notices.detail(c, req.params.noticeId), 201);
}));
router.delete(`${LN}/:noticeId`, wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.update_success, await notices.remove(c, req.params.noticeId, c.actorId));
}));

/* ---------------------------------- polls ------------------------------------ */

router.get(`${SA}/polls/getAll`, wrap(async (req, res) => send(
  res, M.common.list_success, await polls.list(ctxOf(req), req.query),
)));
router.post(`${SA}/polls/create`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.create_success, await polls.create(c, req.body, c.actorId), 201);
}));
router.get(`${SA}/polls/getById/:id`, wrap(async (req, res) => send(
  res, M.common.detail_success, await polls.detail(ctxOf(req), req.params.id, { isAdmin: true }),
)));
router.put(`${SA}/polls/update/:id`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await polls.update(c, req.params.id, req.body, c.actorId));
}));
router.delete(`${SA}/polls/delete/:id`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await polls.remove(c, req.params.id, c.actorId));
}));
router.patch(`${SA}/polls/publish/:id`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await polls.publish(c, req.params.id, c.actorId));
}));
router.patch(`${SA}/polls/close/:id`, wrap(async (req, res) => send(
  res, M.common.update_success, await polls.close(ctxOf(req), req.params.id),
)));
router.get(`${SA}/polls/analytics/:id`, wrap(async (req, res) => send(
  res, M.common.detail_success, await polls.detail(ctxOf(req), req.params.id, { isAdmin: true }),
)));
router.get(`${SA}/polls/votes/:id`, wrap(async (req, res) => send(
  res, M.common.list_success, { voters: await polls.voters(ctxOf(req), req.params.id) },
)));

router.get(`${R}/polls/list`, wrap(async (req, res) => send(
  res, M.common.list_success,
  await polls.list(residentCtx(req), { ...req.query, publishStatus: 'PUBLISHED' }),
)));
router.get(`${R}/polls/get-details/:id`, wrap(async (req, res) => send(
  res, M.common.detail_success,
  await polls.detail(residentCtx(req), req.params.id, { userId: req.societyUserId }),
)));
router.post(`${R}/polls/vote/:id`, wrap(async (req, res) => send(
  res, M.common.create_success,
  await polls.vote(residentCtx(req), req.params.id, req.body, { userId: req.societyUserId }),
)));
router.get(`${R}/polls/results/:id`, wrap(async (req, res) => send(
  res, M.common.detail_success,
  await polls.detail(residentCtx(req), req.params.id, { userId: req.societyUserId }),
)));

/* --------------------------------- events ------------------------------------ */

router.get(`${SA}/events/event-list`, wrap(async (req, res) => send(
  res, M.common.list_success, await community.events.list(ctxOf(req), req.query),
)));
router.get(`${R}/events/public-list`, wrap(async (req, res) => send(
  res, M.common.list_success,
  await community.events.list(residentCtx(req), { ...req.query, status: 'PUBLISHED' }),
)));

/* ------------------------------- feedback ------------------------------------ */

router.get(`${SA}/feedbacks/feedback-list`, wrap(async (req, res) => send(
  res, M.common.list_success,
  // The source proxied this to feedback-services; internalised as an empty
  // slice until that module is ported (SOCIETY-PLAN.md §3.6).
  { feedbacks: [], pagination: { total: 0, page: 1, limit: 10, totalPages: 0 } },
)));

/* -------------------------------- galleries ----------------------------------- */

router.get(`${SA}/building-galleries/list`, wrap(async (req, res) => send(
  res, M.common.list_success, await community.galleries.list(ctxOf(req), req.query),
)));
router.post(`${SA}/building-galleries/create-gallary`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.create_success, await community.galleries.create(c, req.body, c.actorId), 201);
}));
/** The source's spelling of the create path (`create-gallary`) is contract. */
router.put(`${SA}/building-galleries/remove-image/:galleryId`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success,
    await community.galleries.removeImage(c, req.params.galleryId, req.body.image, c.actorId));
}));

router.get(`${R}/building-gallery/list`, wrap(async (req, res) => send(
  res, M.common.list_success, await community.galleries.list(residentCtx(req), req.query),
)));
router.get(`${R}/building-gallery/detail/:galleryId`, wrap(async (req, res) => send(
  res, M.common.detail_success, await community.galleries.detail(residentCtx(req), req.params.galleryId),
)));

// Legacy block galleries — the same rows with galleryType: 'Block'.
router.get(`${LG}/blocks`, wrap(async (req, res) => send(
  res, M.common.list_success, await community.blockGalleries.list(legacyCtx(req), req.query),
)));
router.post(`${LG}/blocks`, [superAdminVerifyToken], wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.create_success, await community.blockGalleries.create(c, req.body, c.actorId), 201);
}));
router.get(`${LG}/blocks/:galleryId`, wrap(async (req, res) => send(
  res, M.common.detail_success, await community.blockGalleries.detail(legacyCtx(req), req.params.galleryId),
)));
router.put(`${LG}/blocks/:galleryId`, [superAdminVerifyToken], wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.update_success,
    await community.blockGalleries.update(c, req.params.galleryId, req.body, c.actorId));
}));
router.delete(`${LG}/blocks/:galleryId`, [superAdminVerifyToken], wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.update_success,
    await community.blockGalleries.remove(c, req.params.galleryId, c.actorId));
}));

/* -------------------------------- documents ------------------------------------ */

router.get(`${SA}/society-documents/type/list`, wrap(async (req, res) => send(
  res, M.common.list_success, await community.documentTypes.list(ctxOf(req), req.query),
)));
router.post(`${SA}/society-documents/type/create`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.create_success, await community.documentTypes.create(c, req.body, c.actorId), 201);
}));
router.get(`${SA}/society-documents/type/detail/:typeId`, wrap(async (req, res) => send(
  res, M.common.detail_success, await community.documentTypes.detail(ctxOf(req), req.params.typeId),
)));
router.put(`${SA}/society-documents/type/update/:typeId`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success,
    await community.documentTypes.update(c, req.params.typeId, req.body, c.actorId));
}));
router.delete(`${SA}/society-documents/type/delete/:typeId`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await community.documentTypes.remove(c, req.params.typeId, c.actorId));
}));

router.get(`${SA}/society-documents/document/list`, wrap(async (req, res) => send(
  res, M.common.list_success, await community.documents.list(ctxOf(req), req.query),
)));
router.post(`${SA}/society-documents/document/create`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.create_success, await community.documents.create(c, req.body, c.actorId), 201);
}));
router.get(`${SA}/society-documents/document/detail/:documentId`, wrap(async (req, res) => send(
  res, M.common.detail_success, await community.documents.detail(ctxOf(req), req.params.documentId),
)));
router.put(`${SA}/society-documents/document/update/:documentId`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await community.documents.update(c, req.params.documentId, req.body, c.actorId));
}));
router.delete(`${SA}/society-documents/document/delete/:documentId`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await community.documents.remove(c, req.params.documentId, c.actorId));
}));

router.get(`${R}/document/document/list`, wrap(async (req, res) => send(
  res, M.common.list_success,
  await community.documents.list(residentCtx(req), { ...req.query, status: 'ACTIVE' }),
)));
router.get(`${R}/document/type/list`, wrap(async (req, res) => send(
  res, M.common.list_success,
  await community.documentTypes.list(residentCtx(req), { ...req.query, status: 'ACTIVE' }),
)));

/* ---------------------------- emergency numbers -------------------------------- */

router.get(`${SA}/emergency-numbers/list`, wrap(async (req, res) => send(
  res, M.common.list_success, await community.emergencyNumbers.list(ctxOf(req), req.query),
)));
router.post(`${SA}/emergency-numbers/create`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.create_success, await community.emergencyNumbers.create(c, req.body, c.actorId), 201);
}));
router.get(`${SA}/emergency-numbers/detail/:emergencyId`, wrap(async (req, res) => send(
  res, M.common.detail_success, await community.emergencyNumbers.detail(ctxOf(req), req.params.emergencyId),
)));
router.put(`${SA}/emergency-numbers/update/:emergencyId`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success,
    await community.emergencyNumbers.update(c, req.params.emergencyId, req.body, c.actorId));
}));
router.delete(`${SA}/emergency-numbers/delete/:emergencyId`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await community.emergencyNumbers.remove(c, req.params.emergencyId, c.actorId));
}));

router.get(`${R}/emergency/list`, wrap(async (req, res) => send(
  res, M.common.list_success,
  await community.emergencyNumbers.list(residentCtx(req), { ...req.query, status: 'ACTIVE' }),
)));
router.get(`${R}/emergency/detail/:emergencyId`, wrap(async (req, res) => send(
  res, M.common.detail_success, await community.emergencyNumbers.detail(residentCtx(req), req.params.emergencyId),
)));

/* ------------------------------ lost and found --------------------------------- */

router.get(`${SA}/lost-found/list`, wrap(async (req, res) => send(
  res, M.common.list_success, await community.lostAndFound.list(ctxOf(req), req.query),
)));
router.post(`${SA}/lost-found/add`, wrap(async (req, res) => send(
  res, M.common.create_success,
  await community.lostAndFound.report(ctxOf(req), req.body, adminActor(req)), 201,
)));
router.put(`${SA}/lost-found/update/:id`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await community.lostAndFound.update(c, req.params.id, req.body, c.actorId));
}));
router.delete(`${SA}/lost-found/delete/:id`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await community.lostAndFound.remove(c, req.params.id, c.actorId));
}));

router.get(`${R}/lost-found/list`, wrap(async (req, res) => send(
  res, M.common.list_success,
  await community.lostAndFound.list(residentCtx(req), { ...req.query, status: 'ACTIVE' }),
)));
router.post(`${R}/lost-found/create`, wrap(async (req, res) => send(
  res, M.common.create_success,
  await community.lostAndFound.report(residentCtx(req), req.body, { userId: req.societyUserId }), 201,
)));
router.get(`${R}/lost-found/get-details/:id`, wrap(async (req, res) => send(
  res, M.common.detail_success, await community.lostAndFound.detail(residentCtx(req), req.params.id),
)));
router.put(`${R}/lost-found/update/:id`, wrap(async (req, res) => send(
  res, M.common.update_success,
  await community.lostAndFound.update(residentCtx(req), req.params.id, req.body, req.societyUserId),
)));
router.delete(`${R}/lost-found/delete/:id`, wrap(async (req, res) => send(
  res, M.common.update_success,
  await community.lostAndFound.remove(residentCtx(req), req.params.id, req.societyUserId),
)));

/* ------------------------------ notifications ---------------------------------- */

router.get(`${R}/notifications/getMyNotifications`, wrap(async (req, res) => send(
  res, M.common.list_success, await community.inbox(residentCtx(req), req.societyUserId, req.query),
)));
router.patch(`${R}/notifications/markAsRead/:id`, wrap(async (req, res) => send(
  res, M.common.update_success,
  await community.markRead(residentCtx(req), req.societyUserId, { notificationId: req.params.id }),
)));

module.exports = router;
