const config = require('../config');

/**
 * The absolute base URL to put in a link somebody opens outside the app —
 * an invite, a password reset, a customer booking form, a walk-in QR code.
 *
 * APP_URL wins when it is set to something real, because that is the address
 * the operator has decided is canonical. When it is missing or still pointing at
 * localhost, the incoming request is a better answer than a link nobody can
 * open: a QR printed from a laptop was showing `http://localhost:3000`.
 *
 * Honours X-Forwarded-* so it stays correct behind a proxy (`trust proxy` is
 * what makes req.protocol and req.hostname reflect the original request).
 */
const isLocal = (url) => !url || /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/i.test(url);

function publicUrl(req) {
  if (!isLocal(config.appUrl)) return config.appUrl.replace(/\/+$/, '');
  if (req?.headers?.host) return `${req.protocol}://${req.get('host')}`;
  return (config.appUrl || 'http://localhost:3000').replace(/\/+$/, '');
}

/** True when links would still be generated against localhost — worth warning about. */
const isLocalOnly = (req) => isLocal(publicUrl(req));

module.exports = { publicUrl, isLocalOnly, isLocal };
