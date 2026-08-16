/**
 * Spec §68: users never see raw technical errors. Every failure the user can
 * cause carries a friendly message; anything else becomes a generic message
 * and the real detail goes to the log only.
 */
class AppError extends Error {
  constructor(message, { status = 400, code = 'BAD_REQUEST', details = null } = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = true;
  }
}

const badRequest = (msg, details) => new AppError(msg, { status: 400, code: 'BAD_REQUEST', details });
const unauthorized = (msg = 'Please sign in to continue.') => new AppError(msg, { status: 401, code: 'UNAUTHORIZED' });
const forbidden = (msg = 'You do not have permission to do that.') => new AppError(msg, { status: 403, code: 'FORBIDDEN' });
const notFound = (msg = 'That record could not be found.') => new AppError(msg, { status: 404, code: 'NOT_FOUND' });
const conflict = (msg, details) => new AppError(msg, { status: 409, code: 'CONFLICT', details });
const unprocessable = (msg, details) => new AppError(msg, { status: 422, code: 'VALIDATION_FAILED', details });

module.exports = { AppError, badRequest, unauthorized, forbidden, notFound, conflict, unprocessable };
