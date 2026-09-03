const { AppError, notFound } = require('../lib/errors');

/**
 * The same /api/* endpoints serve both browser form posts and fetch calls
 * (§62 keeps the API resource shape, §103 keeps the UI on plain forms), so the
 * Accept header decides the response format — not the path prefix.
 */
function wantsJson(req) {
  const accept = req.get('accept') || '';
  if (accept.includes('text/html')) return false;
  return req.xhr || accept.includes('application/json') || req.path.startsWith('/api/');
}

function notFoundHandler(req, res, next) {
  next(notFound('That page could not be found.'));
}

/**
 * Spec §68: users never see raw technical errors. Anything that is not a
 * deliberate AppError becomes a generic message; the real detail goes to the log.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  /**
   * A path segment that is not a valid ObjectId reaches Mongoose as a CastError
   * and used to surface as a 500. It is not a server fault — the record simply
   * cannot exist — so every `/:id` route answers "not found" instead. Handled
   * here rather than in each route, because they all fail the same way.
   */
  if (err.name === 'CastError' && err.kind === 'ObjectId') {
    err = notFound('That record could not be found.');
  }

  const isAppError = err instanceof AppError;
  const status = isAppError ? err.status : (err.status === 404 ? 404 : 500);
  const message = isAppError ? err.message : 'Something went wrong. Please try again.';

  if (!isAppError || status >= 500) {
    console.error(JSON.stringify({
      level: 'error', scope: 'request', method: req.method, path: req.originalUrl,
      userId: req.user?._id, tenantId: req.tenantId, message: err.message, stack: err.stack,
    }));
  }

  if (wantsJson(req)) {
    return res.status(status).json({
      ok: false,
      error: { code: isAppError ? err.code : 'INTERNAL_ERROR', message, details: isAppError ? err.details : undefined },
    });
  }

  // Form posts: bounce back with a flash rather than dumping an error page.
  if (req.method !== 'GET' && req.get('referer') && status < 500) {
    req.session.flash = { type: 'error', message, details: isAppError ? err.details : undefined };
    return res.redirect(req.get('referer'));
  }

  res.status(status).render('pages/error', {
    title: status === 404 ? 'Not found' : 'Something went wrong',
    status,
    message,
  });
}

module.exports = { notFoundHandler, errorHandler };
