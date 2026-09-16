const express = require('express');
const { superAdminVerifyToken, adminVerifyToken } = require('../../middleware/societyAuth');
const messages = require('../../lib/society/messages');
const { wrap, send, ctxOf, handlers } = require('./_helpers');

const developers = require('../../services/society/developers');
const roles = require('../../services/society/roles');
const admins = require('../../services/society/admins');
const stages = require('../../services/society/stages');
const inquiries = require('../../services/society/inquiries');
const societies = require('../../services/society/societies');
const users = require('../../services/society/users');

/**
 * `/api/v1/super-admin/*` — the platform surface (51 endpoints).
 *
 * Paths are reproduced exactly, including the oddities: the admin routes mount
 * `/society-admins` and then declare `/society-admins` again inside it, so the
 * real path really is `/super-admin/society-admins/society-admins`. Contract
 * parity (D2) means keeping it rather than tidying it.
 *
 * Routes stay thin — every rule lives in `services/society/*`.
 */
const router = express.Router();
const M = messages.en;
const B = '/api/v1/super-admin';

router.use(B, superAdminVerifyToken);

/* ------------------------------ developers ------------------------------- */
const dev = handlers(developers, {
  list: M.developer.list_success,
  detail: M.developer.detail_success,
  create: M.developer.create_success,
  update: M.developer.update_success,
  remove: M.developer.delete_success,
  idParam: 'developerId',
});
router.post(`${B}/developers/create`, dev.create);
router.get(`${B}/developers/list`, dev.list);
router.get(`${B}/developers/detail/:developerId`, dev.detail);
router.put(`${B}/developers/update/:developerId`, dev.update);
router.delete(`${B}/developers/delete/:developerId`, dev.remove);

/* --------------------------------- roles --------------------------------- */
const role = handlers(roles, {
  list: M.role.list_success,
  detail: M.role.detail_success,
  create: M.role.create_success,
  update: M.role.update_success,
  remove: M.role.delete_success,
  idParam: 'roleId',
});
router.get(`${B}/roles/list`, role.list);
router.post(`${B}/roles/create`, role.create);
router.put(`${B}/roles/update/:roleId`, role.update);
router.delete(`${B}/roles/delete/:roleId`, role.remove);

/* ----------------------------- society admins ----------------------------- */
const adm = handlers(admins, {
  list: M.common.list_success,
  detail: M.common.detail_success,
  create: M.common.create_success,
  update: M.common.update_success,
  remove: M.common.update_success,
});
// `/profile` is the signed-in admin, so it authenticates as any admin rather
// than requiring the super-admin role, and must precede `/society-admin/:id`.
router.get(`${B}/society-admins/profile`, adminVerifyToken, wrap(async (req, res) => send(
  res, M.common.detail_success, await admins.profile(req.societyAdminId),
)));
router.get(`${B}/society-admins/society-admins`, adm.list);
router.get(`${B}/society-admins/society-admin/:id`, adm.detail);
router.post(`${B}/society-admins/society-admin`, adm.create);
router.put(`${B}/society-admins/society-admin/:id`, adm.update);
router.delete(`${B}/society-admins/society-admin/:id`, adm.remove);

/* --------------------------------- stages --------------------------------- */
router.post(`${B}/stages/create`, wrap(async (req, res) => {
  const ctx = ctxOf(req);
  return send(res, M.common.create_success, await stages.stages.create(ctx, req.body, ctx.actorId), 201);
}));
router.post(`${B}/stages/sub-stages/create`, wrap(async (req, res) => {
  const ctx = ctxOf(req);
  return send(res, M.common.create_success, await stages.createSubStage(ctx, req.body, ctx.actorId), 201);
}));
router.post(`${B}/stages/child-stages/create`, wrap(async (req, res) => {
  const ctx = ctxOf(req);
  return send(res, M.common.create_success, await stages.createChildStage(ctx, req.body, ctx.actorId), 201);
}));
router.get(`${B}/stages/list`, wrap(async (req, res) => send(
  res, M.common.list_success, { stages: await stages.tree() },
)));

/* ------------------------------ enquiry leads ----------------------------- */
router.get(`${B}/leads/list`, wrap(async (req, res) => send(
  res, M.common.list_success, await inquiries.list(ctxOf(req), req.query),
)));
router.get(`${B}/leads/detail/:inquiryId`, wrap(async (req, res) => send(
  res, M.common.detail_success, {
    inquiry: await inquiries.detail(ctxOf(req), req.params.inquiryId),
    history: await inquiries.history(req.params.inquiryId),
  },
)));
router.post(`${B}/leads/add-followup`, wrap(async (req, res) => {
  const ctx = ctxOf(req);
  return send(res, M.common.update_success, await inquiries.addFollowup(ctx, req.body, ctx.actorId));
}));
router.post(`${B}/leads/followup-count`, wrap(async (req, res) => send(
  res, M.common.count_success, await inquiries.followupCount(ctxOf(req), req.body),
)));
/**
 * The source named this `download-excel` and shipped an .xlsx via `exceljs`.
 * It emits CSV here — the same rows, opened by the same spreadsheet, without a
 * dependency whose only job is a binary container. The path is unchanged.
 */
router.get(`${B}/leads/download-excel`, wrap(async (req, res) => {
  const rows = await inquiries.exportRows(ctxOf(req), req.query);
  const columns = rows.length ? Object.keys(rows[0]) : [];
  const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [
    columns.join(','),
    ...rows.map((r) => columns.map((c) => escape(r[c])).join(',')),
  ].join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="society-enquiries.csv"');
  return res.send(csv);
}));

/* -------------------------------- societies ------------------------------- */
router.get(`${B}/society/inquiry-list`, wrap(async (req, res) => send(
  res, M.common.list_success, await inquiries.list(ctxOf(req), req.query),
)));
router.get(`${B}/society/inquiry-detail/:id`, wrap(async (req, res) => send(
  res, M.common.detail_success, await inquiries.detail(ctxOf(req), req.params.id),
)));
router.put(`${B}/society/update-society-request/:id`, wrap(async (req, res) => {
  const ctx = ctxOf(req);
  return send(res, M.common.update_success, await inquiries.update(ctx, req.params.id, req.body, ctx.actorId));
}));

router.post(`${B}/society/generate-code`, wrap(async (req, res) => send(
  res, M.society.society_code_generated_successfully, { societyCode: await societies.generateCode() },
)));
router.get(`${B}/society/stats`, wrap(async (req, res) => send(
  res, M.society.statistics_fetched_successfully, await societies.platformStats(),
)));
router.get(`${B}/society/society-details/pincode`, wrap(async (req, res) => send(
  res, M.society.society_details_fetched_successfully, { societies: await societies.byPincode(req.query.pincode) },
)));
router.get(`${B}/society/code/:code`, wrap(async (req, res) => send(
  res, M.society.society_fetched_successfully, await societies.byCode(req.params.code),
)));

router.get(`${B}/society`, wrap(async (req, res) => send(
  res, M.society.societies_fetched_successfully, await societies.list(ctxOf(req), req.query),
)));
router.post(`${B}/society`, wrap(async (req, res) => {
  const ctx = ctxOf(req);
  return send(res, M.society.society_created_successfully, await societies.create(ctx, req.body, ctx.actorId), 201);
}));

// The `:id`-prefixed specifics must precede the bare `/:id`.
router.get(`${B}/society/:id/details`, wrap(async (req, res) => send(
  res, M.society.society_details_fetched_successfully, await societies.details(req.params.id),
)));
router.get(`${B}/society/:id/statistics`, wrap(async (req, res) => send(
  res, M.society.statistics_fetched_successfully, await societies.statistics(req.params.id),
)));
router.get(`${B}/society/:id/blocks/:blockLetter/floors/:floorNumber`, wrap(async (req, res) => send(
  res, M.society.society_details_fetched_successfully,
  await societies.floorDetails(req.params.id, req.params.blockLetter, req.params.floorNumber),
)));
router.get(`${B}/society/:id/blocks/:blockLetter`, wrap(async (req, res) => send(
  res, M.society.society_details_fetched_successfully,
  await societies.blockDetails(req.params.id, req.params.blockLetter),
)));
router.get(`${B}/society/:id`, wrap(async (req, res) => send(
  res, M.society.society_fetched_successfully, await societies.detail(ctxOf(req), req.params.id),
)));
router.put(`${B}/society/:id`, wrap(async (req, res) => {
  const ctx = ctxOf(req);
  return send(res, M.society.society_updated_successfully, await societies.update(ctx, req.params.id, req.body, ctx.actorId));
}));
router.delete(`${B}/society/:id`, wrap(async (req, res) => {
  const ctx = ctxOf(req);
  return send(res, M.society.society_deleted_successfully, await societies.remove(ctx, req.params.id, ctx.actorId));
}));

/* ---------------------------------- users ---------------------------------- */
// `/service-users` is the identity directory; everything under `/society/:id`
// is a unit query behind a users URL (SOCIETY-PLAN.md §2.3). Both are declared
// before `/:id` so neither is swallowed by it.
router.get(`${B}/users/service-users`, wrap(async (req, res) => send(
  res, M.common.list_success, await users.list(ctxOf(req), req.query),
)));
router.get(`${B}/users/service-users/:userId`, wrap(async (req, res) => send(
  res, M.common.detail_success, await users.serviceUserById(req.params.userId),
)));
router.get(`${B}/users/society/:societyId/all`, wrap(async (req, res) => send(
  res, M.common.list_success, { users: await users.allUnits(ctxOf(req), req.params.societyId) },
)));
router.get(`${B}/users/society/:societyId/stats`, wrap(async (req, res) => send(
  res, M.society.statistics_fetched_successfully, await users.unitStats(req.params.societyId),
)));
router.get(`${B}/users/society/:societyId/unit/:unitNumber`, wrap(async (req, res) => send(
  res, M.common.detail_success, await users.unitByNumber(req.params.societyId, req.params.unitNumber),
)));
router.get(`${B}/users/society/:societyId`, wrap(async (req, res) => send(
  res, M.common.list_success, await users.listBySociety(ctxOf(req), req.params.societyId, req.query),
)));
router.put(`${B}/users/:userId/society-admin`, wrap(async (req, res) => send(
  res, M.user.update_success,
  await users.setSocietyAdminFlag(req.params.userId, { value: true, societyId: req.body.societyId }, req.societyAdminId),
)));
router.delete(`${B}/users/:userId/society-admin`, wrap(async (req, res) => send(
  res, M.user.update_success,
  await users.setSocietyAdminFlag(req.params.userId, { value: false }, req.societyAdminId),
)));
router.get(`${B}/users/:id`, wrap(async (req, res) => send(
  res, M.common.detail_success, await users.unitById(req.params.id),
)));
router.put(`${B}/users/:id`, wrap(async (req, res) => send(
  res, M.user.update_success, await users.updateUnit(req.params.id, req.body, req.societyAdminId),
)));

module.exports = router;
