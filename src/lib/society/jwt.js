const jwt = require('jsonwebtoken');
const config = require('../../config');

/**
 * Token signing and verification for the society API surfaces.
 *
 * The society services authenticate with a bearer JWT rather than this
 * codebase's session cookie, because the resident mobile app and the gate
 * device cannot hold one. That contract is matched (SOCIETY-PLAN.md D2); the
 * signing keys are this project's own (§6.3), read from env and enforced in
 * production the way `SESSION_SECRET` already is.
 *
 * Two audiences, two keys, deliberately not interchangeable — a resident token
 * must not verify against the admin surface even if a route is mounted by
 * mistake. The source used one shared fallback secret for both, hardcoded in
 * `config/common.js`.
 *
 * The source also reads the raw `Authorization` header value with no `Bearer `
 * prefix stripping, so a token is sent bare. `readHeaderToken` accepts both:
 * bare (what the app sends today, kept working) and `Bearer <token>` (what
 * every HTTP client will try first).
 */
const AUDIENCES = {
  user: { secret: () => config.society.jwtSecretUser, expiresIn: config.society.jwtUserExpiry },
  admin: { secret: () => config.society.jwtSecretAdmin, expiresIn: config.society.jwtAdminExpiry },
};

function sign(audience, payload) {
  const spec = AUDIENCES[audience];
  if (!spec) throw new Error(`unknown society token audience: ${audience}`);
  return jwt.sign(payload, spec.secret(), { expiresIn: spec.expiresIn });
}

/** Returns the decoded payload, or null. Never throws — callers map null to 401. */
function verify(audience, token) {
  const spec = AUDIENCES[audience];
  if (!spec || !token) return null;
  try {
    return jwt.verify(token, spec.secret());
  } catch {
    return null;
  }
}

/** Accepts `Bearer <token>` or the bare token the source's clients send. */
function readHeaderToken(req) {
  const raw = req.header('Authorization');
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.toLowerCase().startsWith('bearer ') ? trimmed.slice(7).trim() : trimmed;
}

module.exports = { sign, verify, readHeaderToken };
