/**
 * Society isolation, enforced the way tenant isolation already is.
 *
 * Societies are platform-level in this build (SOCIETY-PLAN.md §2, D3): they sit
 * ABOVE tenants, so society collections deliberately carry no `tenantId` and
 * `db/tenantGuard.js` does not cover them. That removes the guarantee the rest
 * of this codebase relies on, so it is replaced rather than dropped: any query
 * against a society-scoped collection that does not constrain `societyId`
 * throws before it reaches Mongo.
 *
 * A missed `.where()` in a new feature becomes a loud crash in development,
 * not one society reading another society's residents.
 *
 * Genuine cross-society work — the super-admin society list, platform
 * analytics, background sweeps — opts out explicitly with
 * `.setOptions({ allowCrossSociety: true })`.
 *
 * Collections that are genuinely global (societies themselves, developers,
 * roles, platform admins, enquiries) use `db/platformScoped.js` instead. Every
 * model under `db/models/society/` carries exactly one of the two, which
 * `tests/society/model-parity.test.js` asserts.
 */
const QUERY_HOOKS = [
  'find', 'findOne', 'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace',
  'countDocuments', 'estimatedDocumentCount', 'distinct',
  'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'replaceOne',
];

/**
 * Same allowance tenantGuard makes, for the same reason: Mongoose `populate()`
 * issues `find({ _id: { $in: [...] } })` with no marker we can recognise, so an
 * id-anchored read has to pass or every join breaks. An id-anchored read still
 * has to know a 12-byte ObjectId, and the leak that actually scales is a list
 * or report query that forgot its scope — which this still catches.
 */
const isIdAnchored = (filter) => !!filter && Object.prototype.hasOwnProperty.call(filter, '_id');

function hasSocietyFilter(filter) {
  if (!filter || typeof filter !== 'object') return false;
  if (filter.societyId) return true;
  for (const key of ['$and', '$or']) {
    const branches = filter[key];
    if (Array.isArray(branches) && branches.length) {
      const check = key === '$and' ? branches.some(hasSocietyFilter) : branches.every(hasSocietyFilter);
      if (check) return true;
    }
  }
  return false;
}

module.exports = function societyGuard(schema) {
  schema.add({
    societyId: {
      type: require('mongoose').Schema.Types.ObjectId, ref: 'Society', required: true, index: true,
    },
  });

  schema.pre(QUERY_HOOKS, function guardQuery() {
    if (this.getOptions?.().allowCrossSociety) return;
    if (this.op === 'estimatedDocumentCount') {
      throw new Error(`${this.model.modelName}: estimatedDocumentCount cannot be society-scoped — use countDocuments`);
    }
    const filter = this.getFilter();
    if (!hasSocietyFilter(filter) && !isIdAnchored(filter)) {
      throw new Error(`${this.model.modelName}: query is missing a societyId filter (society isolation, SOCIETY-PLAN.md §2.1)`);
    }
  });

  schema.pre('aggregate', function guardAggregate() {
    if (this.options?.allowCrossSociety) return;
    const first = this.pipeline()[0];
    if (!first || !first.$match || !hasSocietyFilter(first.$match)) {
      throw new Error(`${this.model().modelName}: aggregation must start with a $match on societyId (SOCIETY-PLAN.md §2.1)`);
    }
  });

  schema.pre('save', function guardSave() {
    if (!this.societyId) throw new Error(`${this.constructor.modelName}: societyId is required (SOCIETY-PLAN.md §2.1)`);
  });

  schema.pre('insertMany', function guardInsertMany(docs) {
    const list = Array.isArray(docs) ? docs : [];
    if (!list.length || list.some((d) => !d.societyId)) {
      throw new Error(`${this.modelName}: every inserted document needs a societyId (SOCIETY-PLAN.md §2.1)`);
    }
  });

  schema.$societyScoped = true;
};

module.exports.hasSocietyFilter = hasSocietyFilter;
module.exports.isIdAnchored = isIdAnchored;
