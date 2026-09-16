const { toJson } = require('../../lib/society/envelope');

/**
 * Route-side glue for the society API surfaces.
 *
 * Keeps controllers to one line each where the behaviour is generic, so the
 * interesting endpoints are the ones that look different — a file with thirty
 * hand-rolled try/catch blocks hides the two that matter.
 */

/**
 * The society API's request context. Deliberately reads only what
 * `middleware/societyAuth.js` sets, never `req.user` — an internal CRM session
 * must not be able to drive these routes.
 */
/**
 * Coerces a society id to an ObjectId.
 *
 * `find()` casts a string against a schema path, but `aggregate()` does not —
 * a `$match` on a string `societyId` matches nothing and returns zero rows,
 * silently. Every context is built through here so an id arriving as a query
 * parameter behaves the same as one set by the auth middleware.
 */
const { Types } = require('mongoose');

function toSocietyId(value) {
  if (!value) return value;
  if (value instanceof Types.ObjectId) return value;
  return Types.ObjectId.isValid(String(value)) ? new Types.ObjectId(String(value)) : value;
}

const ctxOf = (req) => ({
  societyId: toSocietyId(req.societyId),
  society: req.society,
  admin: req.societyAdmin,
  user: req.societyUser,
  employee: req.societyEmployee,
  actorId: req.societyAdminId || req.societyUserId || null,
});

/**
 * Wraps an async handler so a rejected promise reaches `middleware/errors.js`
 * instead of hanging the request. Express 5 forwards rejections on its own, but
 * being explicit keeps these routes readable next to the rest of the codebase.
 */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** `res.send(toJson(msg, result))`, with the source's status codes. */
const send = (res, message, result, status = 200) => res.status(status).send(toJson(message, result));

/**
 * Builds the five standard handlers from a crud service.
 *
 * `messages` carries the source's exact strings — they are part of the contract
 * (D2), so they are passed in per resource rather than generated.
 */
function handlers(service, messages) {
  return {
    list: wrap(async (req, res) => send(res, messages.list, await service.list(ctxOf(req), req.query))),
    all: wrap(async (req, res) => send(res, messages.list, await service.all(ctxOf(req), req.query))),
    detail: wrap(async (req, res) => send(res, messages.detail, await service.detail(ctxOf(req), req.params[messages.idParam || 'id']))),
    create: wrap(async (req, res) => {
      const ctx = ctxOf(req);
      return send(res, messages.create, await service.create(ctx, req.body, ctx.actorId), 201);
    }),
    update: wrap(async (req, res) => {
      const ctx = ctxOf(req);
      const id = req.params[messages.idParam || 'id'];
      return send(res, messages.update, await service.update(ctx, id, req.body, ctx.actorId));
    }),
    remove: wrap(async (req, res) => {
      const ctx = ctxOf(req);
      const id = req.params[messages.idParam || 'id'];
      return send(res, messages.remove, await service.remove(ctx, id, ctx.actorId));
    }),
  };
}

module.exports = {
  ctxOf, wrap, send, handlers, toSocietyId,
};
