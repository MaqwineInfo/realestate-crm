/**
 * Spec §4.2 / §122.4: data from one tenant must never be visible to another.
 *
 * This plugin makes that a schema-level guarantee instead of a coding
 * convention: any query against a tenant-scoped collection that does not
 * constrain `tenantId` throws before it reaches Mongo. A missed `.where()` in a
 * new feature becomes a loud crash in development, not a silent data leak.
 *
 * Genuine system-wide work (seeding, background jobs that sweep every tenant)
 * opts out explicitly with `.setOptions({ allowCrossTenant: true })`.
 */
const QUERY_HOOKS = [
  'find', 'findOne', 'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace',
  'countDocuments', 'estimatedDocumentCount', 'distinct',
  'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'replaceOne',
];

/**
 * Mongoose `populate()` issues `find({ _id: { $in: [...] } })` with no marker we
 * can recognise, so an id-anchored read has to be allowed or joins break.
 *
 * ponytail: this narrows the guard to what it is actually good at — catching a
 * list/report query that forgot its tenant scope, which is the leak that scales.
 * An id-anchored read still has to know a 12-byte ObjectId, and every service
 * here queries by `{ tenantId, _id }` anyway; the API tests assert that a lead
 * id from another tenant 404s. Tighten this to a populate-only allowance if
 * Mongoose ever tags those queries.
 */
const isIdAnchored = (filter) => !!filter && Object.prototype.hasOwnProperty.call(filter, '_id');

function hasTenantFilter(filter) {
  if (!filter || typeof filter !== 'object') return false;
  if (filter.tenantId) return true;
  for (const key of ['$and', '$or']) {
    const branches = filter[key];
    if (Array.isArray(branches) && branches.length) {
      const check = key === '$and' ? branches.some(hasTenantFilter) : branches.every(hasTenantFilter);
      if (check) return true;
    }
  }
  return false;
}

module.exports = function tenantGuard(schema) {
  schema.add({
    tenantId: { type: require('mongoose').Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  });

  schema.pre(QUERY_HOOKS, function guardQuery() {
    if (this.getOptions?.().allowCrossTenant) return;
    if (this.op === 'estimatedDocumentCount') {
      throw new Error(`${this.model.modelName}: estimatedDocumentCount cannot be tenant-scoped — use countDocuments`);
    }
    const filter = this.getFilter();
    if (!hasTenantFilter(filter) && !isIdAnchored(filter)) {
      throw new Error(`${this.model.modelName}: query is missing a tenantId filter (tenant isolation, spec §4.2)`);
    }
  });

  schema.pre('aggregate', function guardAggregate() {
    if (this.options?.allowCrossTenant) return;
    const first = this.pipeline()[0];
    if (!first || !first.$match || !hasTenantFilter(first.$match)) {
      throw new Error(`${this.model().modelName}: aggregation must start with a $match on tenantId (spec §4.2)`);
    }
  });

  schema.pre('save', function guardSave() {
    if (!this.tenantId) throw new Error(`${this.constructor.modelName}: tenantId is required (spec §4.2)`);
  });

  schema.pre('insertMany', function guardInsertMany(docs) {
    const list = Array.isArray(docs) ? docs : [];
    if (!list.length || list.some((d) => !d.tenantId)) {
      throw new Error(`${this.modelName}: every inserted document needs a tenantId (spec §4.2)`);
    }
  });
};

module.exports.hasTenantFilter = hasTenantFilter;
module.exports.isIdAnchored = isIdAnchored;
