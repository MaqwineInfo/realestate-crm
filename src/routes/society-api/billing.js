const express = require('express');
const {
  societyAdminVerifyToken, userVerifyToken, adminVerifyToken, superAdminVerifyToken,
} = require('../../middleware/societyAuth');
const messages = require('../../lib/society/messages');
const { badRequest } = require('../../lib/errors');
const {
  wrap, send, ctxOf, toSocietyId,
} = require('./_helpers');

const billing = require('../../services/society/billing');
const penalties = require('../../services/society/penalties');

/**
 * Money: bills, bill categories, maintenance rules, penalties, the balance
 * sheet, and the resident's own view of what they owe.
 */
const router = express.Router();
const M = messages.en;

const B = '/api/v1/society-admin/bill';
const MT = '/api/v1/society-admin/maintenance';
const P = '/api/v1/society-admin/penalties';
const BS = '/api/v1/society-admin/balance-sheet';
const R = '/api/v1/app';
const LM = '/api/v1/maintenances';
const LP = '/api/v1/penalties';

for (const p of [B, MT, P, BS]) router.use(p, societyAdminVerifyToken);
for (const p of [`${R}/bills`, `${R}/penalty`]) router.use(p, userVerifyToken);
router.use(LM, adminVerifyToken);
router.use(LP, adminVerifyToken);

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

/* ----------------------------- bill categories ------------------------------- */
// Declared before `/:id` so "category" is not read as a bill id.

router.get(`${B}/category/list`, wrap(async (req, res) => send(
  res, M.common.list_success, await billing.categories.list(ctxOf(req), req.query),
)));
router.post(`${B}/category/create`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.create_success, await billing.categories.create(c, req.body, c.actorId), 201);
}));
router.get(`${B}/category/get-details/:id`, wrap(async (req, res) => send(
  res, M.common.detail_success, await billing.categories.detail(ctxOf(req), req.params.id),
)));
router.put(`${B}/category/update/:id`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await billing.categories.update(c, req.params.id, req.body, c.actorId));
}));
router.delete(`${B}/category/delete/:id`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await billing.categories.remove(c, req.params.id, c.actorId));
}));

/* ---------------------------------- bills ------------------------------------- */

router.get(`${B}/list`, wrap(async (req, res) => send(
  res, M.common.list_success, await billing.bills.list(ctxOf(req), req.query),
)));
router.post(`${B}/create`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.create_success, await billing.bills.create(c, req.body, c.actorId), 201);
}));
router.get(`${B}/payment-status/:id`, wrap(async (req, res) => send(
  res, M.common.detail_success, await billing.paymentStatus(ctxOf(req), { billId: req.params.id }),
)));
router.get(`${B}/get-details/:id`, wrap(async (req, res) => send(
  res, M.common.detail_success, await billing.bills.detail(ctxOf(req), req.params.id),
)));
router.put(`${B}/update/:id`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await billing.bills.update(c, req.params.id, req.body, c.actorId));
}));
router.delete(`${B}/delete/:id`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await billing.bills.remove(c, req.params.id, c.actorId));
}));

/* -------------------------------- maintenance --------------------------------- */

router.get(`${MT}/list`, wrap(async (req, res) => send(
  res, M.common.list_success, await billing.maintenances.list(ctxOf(req), req.query),
)));
router.post(`${MT}/create`, wrap(async (req, res) => {
  const c = ctxOf(req);
  const created = await billing.maintenances.create(c, req.body, c.actorId);
  // Publishing on create is what generates this period's bills.
  if (req.body.publishStatus === 'PUBLISHED') {
    const out = await billing.maintenances.run(c, created._id, { actorId: c.actorId });
    return send(res, M.common.create_success, { ...created, generated: out }, 201);
  }
  return send(res, M.common.create_success, created, 201);
}));
router.get(`${MT}/payment-status/:id`, wrap(async (req, res) => send(
  res, M.common.detail_success, await billing.paymentStatus(ctxOf(req), { maintenanceId: req.params.id }),
)));
router.get(`${MT}/get-details/:id`, wrap(async (req, res) => send(
  res, M.common.detail_success, await billing.maintenances.detail(ctxOf(req), req.params.id),
)));
router.put(`${MT}/update/:id`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await billing.maintenances.update(c, req.params.id, req.body, c.actorId));
}));
router.delete(`${MT}/delete/:id`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await billing.maintenances.remove(c, req.params.id, c.actorId));
}));

/* ------------------------------- balance sheet --------------------------------- */

router.get(`${BS}/list`, wrap(async (req, res) => send(
  res, M.common.list_success, await billing.balanceSheets.list(ctxOf(req), req.query),
)));
router.post(`${BS}/create`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.create_success, await billing.balanceSheets.create(c, req.body, c.actorId), 201);
}));
router.get(`${BS}/get-details/:id`, wrap(async (req, res) => send(
  res, M.common.detail_success, await billing.balanceSheets.detail(ctxOf(req), req.params.id),
)));
router.put(`${BS}/update/:id`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await billing.balanceSheets.update(c, req.params.id, req.body, c.actorId));
}));
router.delete(`${BS}/delete/:id`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await billing.balanceSheets.remove(c, req.params.id, c.actorId));
}));

/* --------------------------------- penalties ----------------------------------- */

router.get(`${P}/list`, wrap(async (req, res) => send(
  res, M.common.list_success, await penalties.list(ctxOf(req), req.query),
)));
router.post(`${P}/create`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.create_success, await penalties.create(c, req.body, c.actorId), 201);
}));
router.get(`${P}/detail/:penaltyId`, wrap(async (req, res) => send(
  res, M.common.detail_success, await penalties.detail(ctxOf(req), req.params.penaltyId),
)));
router.put(`${P}/update/:penaltyId`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await penalties.update(c, req.params.penaltyId, req.body, c.actorId));
}));
router.delete(`${P}/delete/:penaltyId`, wrap(async (req, res) => {
  const c = ctxOf(req);
  return send(res, M.common.update_success, await penalties.remove(c, req.params.penaltyId, c.actorId));
}));
router.post(`${P}/resend-notification/:penaltyId`, wrap(async (req, res) => send(
  res, M.common.update_success, await penalties.resendNotification(ctxOf(req), req.params.penaltyId),
)));

/* --------------------------------- resident ------------------------------------ */

router.get(`${R}/bills/list`, wrap(async (req, res) => send(
  res, M.common.list_success, await billing.forResident(residentCtx(req), req.societyUserId, req.query),
)));
router.get(`${R}/bills/get-details/:id`, wrap(async (req, res) => send(
  res, M.common.detail_success, await billing.unitBillDetail(residentCtx(req), req.params.id),
)));
router.get(`${R}/bills/download-invoice/:id`, wrap(async (req, res) => send(
  res, M.common.detail_success, await billing.unitBillDetail(residentCtx(req), req.params.id),
)));
router.get(`${R}/penalty/list`, wrap(async (req, res) => send(
  res, M.common.list_success, await penalties.forResident(residentCtx(req), req.societyUserId, req.query),
)));
router.get(`${R}/penalty/download-invoice/:penaltyId`, wrap(async (req, res) => send(
  res, M.common.detail_success, await penalties.invoice(residentCtx(req), req.params.penaltyId),
)));

/* ---------------------------------- legacy -------------------------------------- */

router.get(`${LM}/statistics`, wrap(async (req, res) => send(
  res, M.society.statistics_fetched_successfully, await billing.societyStats(legacyCtx(req)),
)));
router.get(`${LM}/unit`, wrap(async (req, res) => send(
  res, M.common.list_success,
  await billing.paymentStatus(legacyCtx(req), { maintenanceId: req.query.maintenanceId }),
)));
router.get(LM, wrap(async (req, res) => send(
  res, M.common.list_success, await billing.maintenances.list(legacyCtx(req), req.query),
)));
router.post(LM, [superAdminVerifyToken], wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.create_success, await billing.maintenances.create(c, req.body, c.actorId), 201);
}));
router.get(`${LM}/:id`, wrap(async (req, res) => send(
  res, M.common.detail_success, await billing.maintenances.detail(legacyCtx(req), req.params.id),
)));
router.put(`${LM}/:id`, [superAdminVerifyToken], wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.update_success, await billing.maintenances.update(c, req.params.id, req.body, c.actorId));
}));
router.delete(`${LM}/:id`, [superAdminVerifyToken], wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.update_success, await billing.maintenances.remove(c, req.params.id, c.actorId));
}));
router.post(`${LM}/:id/publish`, [superAdminVerifyToken], wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.update_success, await billing.maintenances.run(c, req.params.id, { actorId: c.actorId }));
}));

router.get(LP, wrap(async (req, res) => send(
  res, M.common.list_success, await penalties.list(legacyCtx(req), req.query),
)));
router.post(LP, [superAdminVerifyToken], wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.create_success, await penalties.create(c, req.body, c.actorId), 201);
}));
router.get(`${LP}/:id`, wrap(async (req, res) => send(
  res, M.common.detail_success, await penalties.detail(legacyCtx(req), req.params.id),
)));
router.put(`${LP}/:id`, [superAdminVerifyToken], wrap(async (req, res) => {
  const c = legacyCtx(req);
  return send(res, M.common.update_success, await penalties.update(c, req.params.id, req.body, c.actorId));
}));

module.exports = router;
