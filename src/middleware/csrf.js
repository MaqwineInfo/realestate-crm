const crypto = require('node:crypto');
const { forbidden } = require('../lib/errors');

/**
 * Spec §74: CSRF protection. Synchroniser token kept in the session and echoed
 * back either as a `_csrf` form field or an `x-csrf-token` header (drawers post
 * with fetch). `csurf` is deprecated, and this is the whole mechanism.
 *
 * Webhook and public-form routes are mounted before this middleware — they
 * authenticate by integration key/token instead and have no session to forge.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Routes that parse their own body and therefore verify their own token. */
const DEFERRED = [/^\/api\/projects\/[a-f\d]{24}\/assets$/i];

const tokensMatch = (sent, expected) => !!expected && !!sent
  && sent.length === expected.length
  && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected));

/** Throws unless this request carries the session's token. */
function verify(req) {
  const sent = req.get('x-csrf-token') || req.body?._csrf;
  if (!tokensMatch(sent, req.session?.csrfToken)) {
    throw forbidden('Your session expired. Refresh the page and try again.');
  }
  return true;
}

function csrf(req, res, next) {
  if (req.session && !req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('base64url');
  }
  res.locals.csrfToken = req.session?.csrfToken || '';

  if (SAFE_METHODS.has(req.method)) return next();

  /**
   * A multipart body has not been parsed yet — the file parser runs inside the
   * route that expects a file, so `_csrf` is still unread bytes here. Those
   * routes call `verify()` themselves once the body exists.
   *
   * The deferral is an explicit allowlist rather than "any multipart request",
   * so a future upload route cannot accidentally inherit an unchecked path by
   * setting a content type.
   */
  const isMultipart = (req.get('content-type') || '').startsWith('multipart/form-data');
  if (isMultipart && DEFERRED.some((re) => re.test(req.path))) {
    req.csrfDeferred = true;
    return next();
  }

  try {
    verify(req);
    req.csrfVerified = true;
    next();
  } catch (err) { next(err); }
}

module.exports = csrf;
module.exports.verify = (req) => {
  verify(req);
  req.csrfVerified = true;
  return true;
};
