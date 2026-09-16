/**
 * "This collection is global on purpose."
 *
 * Adds no field and enforces nothing. Its entire job is to make the absence of
 * a guard readable and greppable, so that a model with no isolation looks like
 * a decision instead of an oversight.
 *
 * Everywhere else in this codebase an unguarded model is a bug: `tenantGuard`
 * covers CRM collections, `societyGuard` covers society-scoped ones. These are
 * the genuine platform-level exceptions — societies themselves, the developers
 * who build them, the role catalog, platform admins, enquiries that exist
 * before any society does, and the shared user directory.
 *
 * `tests/society/model-parity.test.js` asserts every model under
 * `db/models/society/` carries exactly one of `societyGuard` or this.
 */
module.exports = function platformScoped(schema) {
  schema.$platformScoped = true;
};
