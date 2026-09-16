/**
 * Mongoose schemas → OpenAPI component schemas.
 *
 * Derived, not written. Sixty models with several hundred fields between them
 * cannot be described by hand and stay true for a week — the first field
 * somebody adds makes the document a lie. Reading the schema means the spec is
 * wrong only if the code is.
 *
 * Two transformations are applied on the way out, because the document has to
 * describe the wire, not the collection:
 *
 *  - **Money is renamed and retyped.** Storage is integer paise in `priceMinor`;
 *    the wire carries a decimal string in `price` (SOCIETY-PLAN.md §3.9). The
 *    model's own `MONEY_FIELDS` drives it, so a new money column is documented
 *    correctly without touching this file.
 *  - **`select: false` fields are dropped.** `otp` and `otpExpiresAt` never
 *    reach a client, and a documented field is an invitation to look for it.
 */

const { examples } = require('./catalog');

/** A Mongoose path instance → an OpenAPI type. */
const TYPES = {
  String: { type: 'string' },
  Number: { type: 'number' },
  Boolean: { type: 'boolean' },
  Date: { type: 'string', format: 'date-time' },
  ObjectId: { type: 'string', pattern: '^[0-9a-f]{24}$', example: '6a9fa4f2660a9babaf76744d' },
  Decimal128: { type: 'string' },
  Map: { type: 'object', additionalProperties: true },
  // A genuinely free-form column. OpenAPI's way of saying "any JSON" is an
  // empty schema, which reads as an oversight unless it says so.
  Mixed: { description: 'Any JSON value — this column is deliberately untyped.' },
  Buffer: { type: 'string', format: 'byte' },
};

const MONEY_NOTE = 'Rupees as a decimal string. Stored as integer paise; converted at the API boundary.';

/** Strips the `Minor` suffix a money column carries in storage. */
const wireName = (field) => field.replace(/Minor$/, '');

function scalar(path) {
  const base = { ...(TYPES[path.instance] || {}) };
  if (path.enumValues?.length) base.enum = [...path.enumValues].filter((v) => v !== null);
  if (path.options?.maxlength) base.maxLength = path.options.maxlength;
  if (path.options?.minlength) base.minLength = path.options.minlength;
  if (typeof path.options?.min === 'number') base.minimum = path.options.min;
  if (typeof path.options?.max === 'number') base.maximum = path.options.max;
  if (path.options?.ref) {
    base.description = `\`${path.options.ref}\` id.`
      + ' Populated to the full object on endpoints that say so.';
  }
  return base;
}

/**
 * One path, which may itself be an array or an embedded document.
 *
 * Mongoose 9 exposes an array's element type as `embeddedSchemaType` (v6-v8
 * called it `caster` / `$embeddedSchemaType`), and a document array carries its
 * sub-schema on `path.schema`. All three are checked, so this keeps working
 * across the upgrade rather than silently emitting `items: {}` — which is what
 * it did, and which is exactly the kind of quiet degradation a generated
 * document is supposed to prevent.
 */
function elementType(path) {
  if (typeof path.getEmbeddedSchemaType === 'function') {
    const t = path.getEmbeddedSchemaType();
    if (t) return t;
  }
  return path.embeddedSchemaType || path.caster || path.$embeddedSchemaType || null;
}

function fromPath(path) {
  if (path.instance === 'Array') {
    // A document array: `[{ unitId, status }]`.
    if (path.schema) return { type: 'array', items: fromSchema(path.schema) };
    const of = elementType(path);
    if (of?.schema) return { type: 'array', items: fromSchema(of.schema) };
    return { type: 'array', items: of ? scalar(of) : {} };
  }
  if (path.schema) return fromSchema(path.schema);
  return scalar(path);
}

/**
 * Walks a schema into an object schema.
 *
 * Mongoose reports a nested object as dotted leaf paths — `lateFeeConfig.type`,
 * not a `lateFeeConfig` branch — so the nesting has to be rebuilt here.
 * Emitting the dotted names verbatim would produce a schema describing a
 * property literally called "lateFeeConfig.type", which no generated client
 * could ever match against the real response.
 *
 * `dropped` collects the field names withheld, so the caller can say so in the
 * description rather than leave a silent gap.
 */
function fromSchema(schema, { money = [], dropped = [] } = {}) {
  const root = { type: 'object', properties: {} };
  const required = [];
  const moneyFields = new Set(money);

  /**
   * Walks (creating as it goes) the branch a dotted path lives on, or null when
   * the path descends into something that has no properties of its own — a Map
   * or a Mixed column. Those are already fully described by the node itself.
   */
  function branch(parts) {
    let node = root;
    for (const part of parts) {
      if (!node.properties) return null;
      if (!node.properties[part]) node.properties[part] = { type: 'object', properties: {} };
      node = node.properties[part];
      // A money column inside an array of subdocuments hangs off `items`.
      if (node.type === 'array' && node.items) node = node.items;
    }
    return node?.properties ? node : null;
  }

  schema.eachPath((name, path) => {
    if (name === '__v') return;
    if (path.options?.select === false) { dropped.push(name); return; }

    // `payload.$*` is how Mongoose names a Map's value type. The Map itself is
    // already documented as an object with free-form keys, so its value type is
    // not a property to enumerate.
    if (name.includes('$*')) return;

    const parts = name.split('.');
    const leaf = parts.pop();
    const parent = branch(parts);
    if (!parent) return;

    if (moneyFields.has(name)) {
      parent.properties[wireName(leaf)] = {
        type: 'string', description: MONEY_NOTE, example: '2500',
      };
      return;
    }

    const built = fromPath(path);
    const sample = examples.valueFor(name, path);
    if (sample !== undefined && built.example === undefined) built.example = sample;
    parent.properties[leaf] = built;
    if (path.isRequired && parts.length === 0) required.push(leaf);
  });

  /**
   * Money inside an array of subdocuments — `featurePricing.amountMinor` — is
   * not a path Mongoose reports at this level; the sub-schema was built by
   * `fromPath` and the column is still under its storage name in there.
   */
  for (const field of money) {
    const parts = field.split('.');
    const leaf = parts.pop();
    if (!parts.length) continue;
    let node = root;
    for (const part of parts) {
      node = node.properties?.[part];
      if (node?.type === 'array') node = node.items;
      if (!node) break;
    }
    if (!node?.properties?.[leaf]) continue;
    delete node.properties[leaf];
    node.properties[wireName(leaf)] = {
      type: 'string', description: MONEY_NOTE, example: '2500',
    };
  }

  if (required.length) root.required = required;
  return root;
}

/** A model → a named component schema, with its own doc comment as description. */
function fromModel(Model, { description } = {}) {
  const dropped = [];
  const schema = fromSchema(Model.schema, { money: Model.MONEY_FIELDS || [], dropped });

  schema.description = [
    description,
    `Collection \`${Model.collection.collectionName}\`.`,
    Model.schema.$societyScoped
      ? 'Society-scoped: every row belongs to one society and no query may cross that line.'
      : 'Platform-scoped: sits above societies and carries no `societyId`.',
    dropped.length
      ? `Never serialized: ${dropped.map((d) => `\`${d}\``).join(', ')}.`
      : null,
  ].filter(Boolean).join(' ');

  return schema;
}

/**
 * A concrete record from a built schema.
 *
 * Swagger UI can synthesise an example from per-field `example` values, but it
 * renders `_id` and every timestamp as the same placeholder and drops anything
 * without one. Building it here means the document carries one coherent record
 * per resource — the thing a reader actually wants to see before writing a
 * client — and that the record is generated from the same schema the endpoint
 * returns, so it cannot describe fields that no longer exist.
 *
 * Capped at `maxDepth` because a few schemas nest three levels of subdocument
 * and a wall of JSON teaches nobody anything.
 */
function exampleFrom(schema, { maxDepth = 3, depth = 0 } = {}) {
  if (!schema || depth > maxDepth) return undefined;

  if (schema.type === 'array') {
    const item = exampleFrom(schema.items, { maxDepth, depth: depth + 1 });
    return item === undefined ? [] : [item];
  }

  if (schema.type === 'object' || schema.properties) {
    const out = {};
    for (const [name, prop] of Object.entries(schema.properties || {})) {
      const value = prop.example !== undefined
        ? prop.example
        : exampleFrom(prop, { maxDepth, depth: depth + 1 });
      if (value !== undefined) out[name] = value;
    }
    return Object.keys(out).length ? out : undefined;
  }

  return schema.example;
}

/**
 * Every record carries these, and none of them is declared on the schema —
 * Mongoose adds `_id` and, with `timestamps: true`, the two dates.
 */
function withEnvelopeFields(sample, { societyScoped }) {
  return {
    _id: '6a9fa4f2660a9babaf76744d',
    ...(societyScoped ? { societyId: '6a9fa4f2660a9babaf76744d' } : {}),
    ...sample,
    createdAt: '2026-09-08T09:30:00.000Z',
    updatedAt: '2026-09-08T09:30:00.000Z',
  };
}

module.exports = {
  fromModel, fromSchema, wireName, MONEY_NOTE, exampleFrom, withEnvelopeFields,
};
