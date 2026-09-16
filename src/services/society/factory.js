const { notFound, badRequest, conflict } = require('../../lib/errors');
const serialize = require('../../lib/society/serialize');

/**
 * CRUD factory for the society module.
 *
 * Most of the 472 ported endpoints are list / detail / create / update /
 * soft-delete over one collection with a search box and a status filter. Written
 * out by hand that is roughly three hundred near-identical handlers, which is
 * three hundred chances for one of them to forget `isDeleted`, leak a soft-deleted
 * row, or paginate off-by-one. This builds them from a description instead, so
 * those rules exist once.
 *
 * It is deliberately NOT a base class and nothing inherits from it: it returns
 * plain functions, and any resource with real behaviour writes that behaviour
 * itself and uses the factory only for the parts that are genuinely generic.
 *
 * ## Contract fidelity
 *
 * The three source services do not agree on their own list envelope — one pages
 * with `perPage` and returns `hasNextPage`, another pages with `limit` and does
 * not. Since D2 requires matching each byte-for-byte, the shape is configuration
 * rather than a house style:
 *
 *   listKey        the key the array sits under: { developers: [...] }
 *   pageParam      'perPage' | 'limit' — the query parameter this endpoint reads
 *   pageMeta       which pagination keys to emit
 *   extra          constant keys the source tacked onto the result
 *
 * ## Scoping
 *
 * `societyScoped` decides whether every query is pinned to `req.societyId`.
 * It defaults to the model's own guard, so a society-scoped model cannot
 * accidentally be queried platform-wide by leaving an option off.
 */

const DEFAULT_PAGE_SIZE = 10;

/** Builds the `$or` of case-insensitive regexes the source used for search. */
function searchFilter(fields, term) {
  const safe = String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { $or: fields.map((f) => ({ [f]: new RegExp(safe, 'i') })) };
}

function pagination({ shape, page, size, total }) {
  const totalPages = size > 0 ? Math.ceil(total / size) : 0;
  const meta = { total, page };
  if (shape.sizeKey === 'limit') meta.limit = size; else meta.perPage = size;
  meta.totalPages = totalPages;
  if (shape.hasNext) {
    meta.hasNextPage = page < totalPages;
    meta.hasPrevPage = page > 1;
  }
  return meta;
}

/**
 * @param {object} cfg
 * @param {import('mongoose').Model} cfg.Model
 * @param {string} cfg.listKey            key the array sits under in `result`
 * @param {string[]} [cfg.searchFields]   fields the `search` query param matches
 * @param {string[]} [cfg.filterFields]   query params copied straight into the filter
 * @param {object}  [cfg.sort]            default sort, e.g. { createdAt: -1 }
 * @param {string}  [cfg.pageParam]       'perPage' (default) or 'limit'
 * @param {boolean} [cfg.hasNextPage]     emit hasNextPage/hasPrevPage
 * @param {string[]} [cfg.populate]
 * @param {object}  [cfg.extra]           constant keys merged into `result`
 * @param {string[]} [cfg.unique]         fields that must not repeat among live rows
 * @param {boolean} [cfg.societyScoped]   defaults to the model's own guard
 */
function crud(cfg) {
  const {
    Model, listKey, searchFields = [], filterFields = [], sort = { createdAt: -1 },
    pageParam = 'perPage', hasNextPage = false, populate = [], extra = {}, unique = [],
  } = cfg;

  const societyScoped = cfg.societyScoped ?? (Model.schema.$societyScoped === true);
  const money = Model.MONEY_FIELDS || [];
  const shape = { sizeKey: pageParam === 'limit' ? 'limit' : 'perPage', hasNext: hasNextPage };

  /** Base filter: live rows, pinned to the society when the model is scoped. */
  const scope = (ctx) => {
    const base = { isDeleted: false };
    if (!societyScoped) return base;
    if (!ctx?.societyId) {
      // Better a loud failure here than a query the guard rejects three frames
      // deeper with no clue which caller was at fault.
      throw badRequest(`${Model.modelName}: societyId is required for this request`);
    }
    base.societyId = ctx.societyId;
    return base;
  };

  const out = (doc) => (money.length ? serialize.toWire(doc, money) : doc);

  async function assertUnique(ctx, data, excludeId) {
    for (const field of unique) {
      if (data[field] === undefined || data[field] === null || data[field] === '') continue;
      const clash = { ...scope(ctx), [field]: data[field] };
      if (excludeId) clash._id = { $ne: excludeId };
      if (await Model.findOne(clash).select('_id').lean()) {
        throw conflict(`That ${field} is already in use.`);
      }
    }
  }

  return {
    Model,

    /**
     * The resolved configuration, exposed so the OpenAPI generator can read the
     * list envelope key, the filterable fields and the page-size parameter off
     * the code that implements them instead of a hand-kept copy that drifts.
     * `scripts/society-openapi/` is the only reader; nothing at runtime uses it.
     */
    config: {
      modelName: Model.modelName,
      listKey,
      searchFields,
      filterFields,
      pageParam,
      hasNextPage,
      populate,
      unique,
      societyScoped,
      moneyFields: money,
      extraKeys: Object.keys(extra),
    },

    async list(ctx, query = {}) {
      const page = Math.max(1, parseInt(query.page, 10) || 1);
      const size = Math.max(1, parseInt(query[pageParam] ?? query.limit ?? query.perPage, 10)
        || DEFAULT_PAGE_SIZE);

      const filter = scope(ctx);
      for (const f of filterFields) {
        if (query[f] !== undefined && query[f] !== '') filter[f] = query[f];
      }
      if (query.search?.trim() && searchFields.length) {
        Object.assign(filter, searchFilter(searchFields, query.search.trim()));
      }

      const order = query.sortBy
        ? { [query.sortBy]: String(query.sortOrder).toLowerCase() === 'asc' ? 1 : -1 }
        : sort;

      let q = Model.find(filter).sort(order).skip((page - 1) * size).limit(size);
      for (const p of populate) q = q.populate(p);

      const [rows, total] = await Promise.all([q.lean(), Model.countDocuments(filter)]);

      return {
        [listKey]: rows.map(out),
        pagination: pagination({ shape, page, size, total }),
        ...extra,
      };
    },

    /** Unpaginated, for dropdowns. */
    async all(ctx, query = {}) {
      const filter = scope(ctx);
      for (const f of filterFields) {
        if (query[f] !== undefined && query[f] !== '') filter[f] = query[f];
      }
      const rows = await Model.find(filter).sort(sort).lean();
      return rows.map(out);
    },

    async detail(ctx, id) {
      const filter = { ...scope(ctx), _id: id };
      let q = Model.findOne(filter);
      for (const p of populate) q = q.populate(p);
      const doc = await q.lean();
      if (!doc) throw notFound(`${Model.modelName} not found`);
      return out(doc);
    },

    async create(ctx, data, actorId) {
      const payload = money.length ? serialize.fromWire(data, money) : { ...data };
      if (societyScoped) payload.societyId = ctx.societyId;
      await assertUnique(ctx, payload, null);
      if (actorId) payload.createdBy = actorId;
      const doc = await Model.create(payload);
      return out(doc.toObject());
    },

    async update(ctx, id, data, actorId) {
      const payload = money.length ? serialize.fromWire(data, money) : { ...data };
      // Nothing may relocate a row into another society, or resurrect one.
      delete payload.societyId;
      delete payload.isDeleted;
      delete payload._id;
      await assertUnique(ctx, payload, id);
      if (actorId) payload.updatedBy = actorId;

      const doc = await Model.findOneAndUpdate(
        { ...scope(ctx), _id: id }, { $set: payload }, { new: true, runValidators: true },
      ).lean();
      if (!doc) throw notFound(`${Model.modelName} not found`);
      return out(doc);
    },

    /**
     * Soft delete. Every list in this module filters `isDeleted: false`, and the
     * unique indexes are partial on it, so removing a row frees its name.
     */
    async remove(ctx, id, actorId) {
      const patch = { isDeleted: true, deletedAt: new Date() };
      if (Model.schema.path('status')) patch.status = 'INACTIVE';
      if (actorId && Model.schema.path('deletedBy')) patch.deletedBy = actorId;

      const doc = await Model.findOneAndUpdate(
        { ...scope(ctx), _id: id }, { $set: patch }, { new: true },
      ).lean();
      if (!doc) throw notFound(`${Model.modelName} not found`);
      return out(doc);
    },
  };
}

module.exports = { crud, searchFilter, DEFAULT_PAGE_SIZE };
