const { crud } = require('./factory');
const { SocietyDeveloper } = require('../../db/models/society');

/**
 * Developers — the builders that own societies. Pure CRUD, so it is entirely
 * the factory plus the two uniqueness rules the source enforced by hand
 * (`mobile_exists` / `email_exists`).
 *
 * Platform-scoped: a developer exists before any of its societies.
 */
module.exports = crud({
  Model: SocietyDeveloper,
  listKey: 'developers',
  searchFields: ['firstName', 'lastName', 'companyName', 'email', 'mobileNumber'],
  filterFields: ['status'],
  unique: ['mobileNumber', 'email'],
  pageParam: 'perPage',
  hasNextPage: true,
  sort: { createdAt: -1 },
});
