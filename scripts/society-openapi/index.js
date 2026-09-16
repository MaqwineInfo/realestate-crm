/**
 * Generates `docs/society-openapi.json` — the OpenAPI 3.1 description of all
 * 460 society endpoints.
 *
 * Run: `npm run society:openapi`
 *
 * Almost nothing here is written by hand. The endpoint list comes from walking
 * the mounted Express routers, so a route that exists is documented and a route
 * that is deleted disappears. The auth requirement for each one is read off the
 * middleware actually guarding it, not from a table somebody has to remember to
 * update — which is the only way a security note in a document is worth
 * anything. Field lists come from the Mongoose schemas. What is hand-written
 * lives in `catalog.js` and is limited to prose and sample values.
 *
 * `tests/society/openapi.test.js` asserts the output covers every endpoint the
 * contract knows about, so this cannot fall behind the port.
 */

const fs = require('node:fs');
const path = require('node:path');

const { TAGS, RESOURCES, examples, OVERRIDES } = require('./catalog');
const { fromModel, exampleFrom, withEnvelopeFields } = require('./schemas');

const ROUTER_DIR = path.join(__dirname, '..', '..', 'src', 'routes', 'society-api');
const OUT = path.join(__dirname, '..', '..', 'docs', 'society-openapi.json');

/* ───────────────────────── route introspection ───────────────────────── */

/**
 * Every mounted route, with the guards that actually protect it.
 *
 * Express 5 layers expose `match(path)` rather than a regexp, so a
 * `router.use(prefix, verifier)` guard is attributed to a route by asking the
 * layer whether it matches — the same question the router asks at request time.
 */
function routes() {
  const found = [];

  const inspect = (router) => {
    const guards = router.stack.filter(
      (l) => !l.route && l.name !== 'router' && typeof l.match === 'function',
    );
    for (const layer of router.stack) {
      if (!layer.route) continue;
      const applied = guards.filter((g) => g.match(layer.route.path)).map((g) => g.name);
      const inline = layer.route.stack
        .map((h) => h.name)
        .filter((n) => /Verify|Permission|societyAdminOr/.test(n));
      const chain = [...new Set([...applied, ...inline])];
      for (const method of Object.keys(layer.route.methods)) {
        if (method !== '_all') found.push({ method: method.toUpperCase(), path: layer.route.path, chain });
      }
    }
  };

  const load = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) load(p);
      else if (entry.name.endsWith('.js') && !entry.name.startsWith('_')) inspect(require(p));
    }
  };
  load(ROUTER_DIR);

  return found.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

/* ──────────────────────────── security ──────────────────────────── */

/**
 * The verifier a route is behind decides what the document says about it. Both
 * of the pinned identities need `x-society-id` as well as the token, which
 * OpenAPI expresses as two schemes inside one requirement object (AND).
 */
const SECURITY = {
  superAdminVerifyToken: [{ societyAdminToken: [] }],
  adminVerifyToken: [{ societyAdminToken: [] }],
  societyAdminVerifyToken: [{ societyAdminToken: [], societyId: [] }],
  userVerifyToken: [{ residentToken: [] }],
  securityGuardVerifyToken: [{ residentToken: [], societyId: [] }],
  societyAdminOrSecurityGuard: [{ societyAdminToken: [], societyId: [] }, { residentToken: [], societyId: [] }],
};

const AUTH_NOTE = {
  superAdminVerifyToken: 'Super admin only — the token holder\'s role must have `global` scope.',
  adminVerifyToken: 'Any platform admin token.',
  societyAdminVerifyToken: 'Society admin. The `x-society-id` header is checked against '
    + 'this admin\'s own assignments on **every** request, so holding a valid token is not '
    + 'enough to reach a society you do not administer.',
  userVerifyToken: 'Resident token.',
  securityGuardVerifyToken: 'Gate device. The holder must have a **live** posting to this '
    + 'society; ending the posting locks them out on the next request.',
  societyAdminOrSecurityGuard: 'Either a society admin or a posted guard.',
};

function securityFor(chain) {
  const relevant = chain.filter((n) => SECURITY[n]);
  if (!relevant.length) return { security: [], note: 'Public — no token required.' };
  // A route behind two verifiers (admin + super-admin) is reachable with either.
  const merged = relevant.flatMap((n) => SECURITY[n]);
  const seen = new Set();
  const security = merged.filter((s) => {
    const k = Object.keys(s).sort().join('+');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { security, note: relevant.map((n) => AUTH_NOTE[n]).join(' ') };
}

/* ──────────────────────────── resources ──────────────────────────── */

const BY_LENGTH = [...RESOURCES].sort((a, b) => b.prefix.length - a.prefix.length);

const resourceFor = (p) => BY_LENGTH.find((r) => p === r.prefix || p.startsWith(`${r.prefix}/`));

/**
 * A resource points at either a crud instance (`parking.levels`) or, when the
 * endpoints are hand-written and the factory never saw them, a model by name
 * (`model: 'SocietyUnitBill'`). Both resolve to the same pair — a Model to
 * describe and a list config to read query parameters from — so the rest of the
 * generator does not care which the catalog used.
 */
function modelOnly(name, listKey) {
  // eslint-disable-next-line global-require
  const Model = require('../../src/db/models/society')[name];
  if (!Model) throw new Error(`catalog.js names an unknown model: ${name}`);
  return {
    Model,
    config: {
      modelName: name,
      listKey: listKey || name.replace(/^Society/, '').replace(/^./, (c) => c.toLowerCase()).concat('s'),
      searchFields: [],
      filterFields: [],
      pageParam: 'limit',
      hasNextPage: false,
    },
  };
}

/** `parking.levels` -> the crud instance, so its config and model can be read. */
function serviceConfig(spec) {
  if (!spec) return null;
  const [moduleName, accessor] = spec.split('.');
  let mod;
  try {
    // eslint-disable-next-line import/no-dynamic-require, global-require
    mod = require(path.join(__dirname, '..', '..', 'src', 'services', 'society', moduleName));
  } catch {
    return null;
  }
  const target = accessor ? mod[accessor] : mod;
  return target?.config ? { config: target.config, Model: target.Model } : null;
}

/* ──────────────────────────── operations ──────────────────────────── */

const VERB = {
  GET: 'Get', POST: 'Create', PUT: 'Update', PATCH: 'Update', DELETE: 'Delete',
};

/** "amenityTypes" -> "amenity type" / "amenity types". */
function noun(resource, plural, svc) {
  // The service's own list envelope key is the truest name for the thing —
  // `amenities.types` emits `amenityTypes`, so "amenity type", not "type".
  const raw = (svc?.config?.listKey || resource?.service?.split('.').pop() || 'record')
    .replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  const singular = raw.replace(/ies$/, 'y').replace(/s$/, '');
  return plural ? raw : singular;
}

/**
 * A readable sentence from the method and the tail of the path.
 *
 * Three shapes cover most of the surface — a collection, a collection with a
 * verb on the end, and one record by id. Anything else falls back to the last
 * literal segment, which is nearly always the verb the endpoint performs
 * (`publish`, `process-entry`, `clock-in`).
 */
function summarise(method, p, resource, svc) {
  const segments = p.split('/').filter(Boolean).slice(2);
  const last = segments[segments.length - 1] || '';
  const endsWithId = last.startsWith(':');
  const literal = [...segments].reverse().find((s2) => !s2.startsWith(':')) || '';

  const named = {
    list: `List ${noun(resource, true, svc)}`,
    'list-all': `List every ${noun(resource)}, unpaginated`,
    dropdown: `${noun(resource, true, svc)} for a dropdown`,
    'get-details': `Get one ${noun(resource, false, svc)}`,
    detail: `Get one ${noun(resource, false, svc)}`,
    create: `Create a ${noun(resource, false, svc)}`,
    update: `Update a ${noun(resource, false, svc)}`,
    delete: `Delete a ${noun(resource, false, svc)}`,
    stats: `Statistics for ${noun(resource, true, svc)}`,
    statistics: `Statistics for ${noun(resource, true, svc)}`,
    export: `Export ${noun(resource, true, svc)}`,
    count: `Count ${noun(resource, true, svc)}`,
  };
  if (!endsWithId && named[last]) return named[last];

  // `/notices/:noticeId` — one record, addressed by id.
  if (endsWithId) {
    if (method === 'GET') return `Get one ${noun(resource, false, svc)}`;
    return `${VERB[method]} a ${noun(resource, false, svc)}`;
  }

  // `/notices` — the collection itself.
  const isCollection = literal === segments[segments.length - 1]
    && /s$/.test(literal) && segments.length <= 3;
  if (isCollection) {
    if (method === 'GET') return `List ${noun(resource, true, svc)}`;
    if (method === 'POST') return `Create a ${noun(resource, false, svc)}`;
  }

  const action = literal.replace(/-/g, ' ');
  return `${action.charAt(0).toUpperCase()}${action.slice(1)}`;
}

/** `:id` in an Express path becomes `{id}` in OpenAPI, with a parameter each. */
function pathAndParams(p) {
  const params = [];
  const templated = p.replace(/:([A-Za-z0-9_]+)/g, (_, name) => {
    params.push({
      name,
      in: 'path',
      required: true,
      schema: { type: 'string', pattern: '^[0-9a-f]{24}$' },
      example: '6a9fa4f2660a9babaf76744d',
      description: `\`${name}\` of the record. A value that is not a valid id answers 404, not 500.`,
    });
    return `{${name}}`;
  });
  return { templated, params };
}

const PAGE_PARAMS = (cfg) => [
  {
    name: 'page',
    in: 'query',
    schema: { type: 'integer', minimum: 1, default: 1 },
    description: '1-based page number.',
  },
  {
    name: cfg.pageParam,
    in: 'query',
    schema: { type: 'integer', minimum: 1, default: 10 },
    description: 'Rows per page. This surface names it '
      + `\`${cfg.pageParam}\` — the two generations of the source disagreed, and both spellings are honoured.`,
  },
  {
    name: 'sortBy',
    in: 'query',
    schema: { type: 'string' },
    description: 'Field to sort on. Defaults to newest first.',
  },
  {
    name: 'sortOrder',
    in: 'query',
    schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
  },
];

/** Query parameters a list endpoint accepts, read from the crud config. */
function listParams(svc) {
  if (!svc) return [];
  const { config } = svc;
  const out = [...PAGE_PARAMS(config)];

  if (config.searchFields?.length) {
    out.push({
      name: 'search',
      in: 'query',
      schema: { type: 'string' },
      example: examples.VALUES.search,
      description: `Case-insensitive match against ${config.searchFields.map((f) => `\`${f}\``).join(', ')}.`,
    });
  }
  for (const field of config.filterFields || []) {
    const schemaPath = svc.Model?.schema?.path(field);
    const schema = { type: 'string' };
    if (schemaPath?.enumValues?.length) schema.enum = [...schemaPath.enumValues].filter(Boolean);
    out.push({
      name: field, in: 'query', schema, description: `Exact match on \`${field}\`.`,
    });
  }
  return out;
}

/**
 * The society a resident-surface call is about.
 *
 * The resident routes are not pinned by a header — one person can hold flats in
 * two societies — so they take it as a query parameter instead.
 */
const SOCIETY_QUERY = {
  name: 'societyId',
  in: 'query',
  required: true,
  schema: { type: 'string', pattern: '^[0-9a-f]{24}$' },
  example: '6a9fa4f2660a9babaf76744d',
  description: 'The society this call is about. Required on the resident surface, which '
    + 'is not pinned by `x-society-id` because one resident may hold flats in several societies.',
};

const isListPath = (p) => /\/(list|dropdown)$/.test(p) || /\/[a-z-]+s$/.test(p);

/** `{ message, result }`, with `result` shaped for this endpoint. */
function envelope(message, result) {
  return {
    type: 'object',
    required: ['message', 'result'],
    properties: {
      message: { type: 'string', example: message },
      result: result || { type: 'object' },
    },
  };
}

function resultFor({ method, p, svc, ref }) {
  if (!svc) return { type: 'object' };
  const { config } = svc;

  if (method === 'GET' && isListPath(p)) {
    return {
      type: 'object',
      properties: {
        [config.listKey]: { type: 'array', items: { $ref: ref } },
        pagination: { $ref: '#/components/schemas/Pagination' },
      },
    };
  }
  if (method === 'DELETE') return { type: 'object', description: 'The soft-deleted record.' };
  return { $ref: ref };
}

/** The message the endpoint really returns, from `lib/society/messages.js`. */
function successMessage(method, p) {
  if (method === 'POST') return 'Created successfully';
  if (method === 'PUT' || method === 'PATCH') return 'Update successfully.';
  if (method === 'DELETE') return 'Deleted successfully';
  return isListPath(p) ? 'List fetched successfully' : 'Detail fetch successfully.';
}

/** What `result` looks like for this endpoint, given one sample record. */
function sampleResult({ method, p, svc, sample }) {
  if (!sample) return {};
  if (method === 'GET' && isListPath(p)) {
    return {
      [svc.config.listKey]: [sample],
      pagination: {
        total: 42,
        page: 1,
        [svc.config.pageParam]: 10,
        totalPages: 5,
        ...(svc.config.hasNextPage ? { hasNextPage: true, hasPrevPage: false } : {}),
      },
    };
  }
  return sample;
}

/**
 * The same record as a request body: the server owns identity, timestamps and
 * the soft-delete flag, so showing them in a body somebody is meant to copy
 * teaches the wrong thing.
 */
const SERVER_OWNED = new Set([
  '_id', 'societyId', 'createdAt', 'updatedAt', 'isDeleted', 'deletedAt', 'deletedBy',
  'createdBy', 'updatedBy', '__v',
]);

function writeExample(sample) {
  if (!sample) return {};
  return Object.fromEntries(Object.entries(sample).filter(([k]) => !SERVER_OWNED.has(k)));
}

const ERRORS = {
  400: ['Bad request', 'Some of those details are not valid.'],
  401: ['Unauthenticated, or the token does not open this society', 'You are not authorized'],
  403: ['Authenticated, but not permitted', 'You are not authorized'],
  404: ['No such record', 'That record could not be found.'],
  409: ['A conflicting write won the race', 'That slot has just been taken.'],
  500: ['Server fault. The detail is in the log, never in the response', 'Something went wrong. Please try again.'],
};

function errorResponses(hasAuth) {
  const codes = hasAuth ? [400, 401, 403, 404, 409, 500] : [400, 404, 409, 500];
  return Object.fromEntries(codes.map((code) => {
    const [description, message] = ERRORS[code];
    return [String(code), {
      description,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { message, result: {} } } },
    }];
  }));
}

/* ──────────────────────────── assembly ──────────────────────────── */

function build() {
  const all = routes();
  const paths = {};
  const schemas = {};
  const samples = {};
  const usedTags = new Set();
  const unmapped = [];

  for (const route of all) {
    const resource = resourceFor(route.path);
    if (!resource) unmapped.push(`${route.method} ${route.path}`);

    const tag = resource?.tag || 'Legacy façade';
    usedTags.add(tag);

    const svc = resource?.model
      ? modelOnly(resource.model, resource.listKey)
      : serviceConfig(resource?.service);
    let ref;
    let sample;
    if (svc?.Model) {
      const name = svc.Model.modelName;
      if (!schemas[name]) {
        schemas[name] = fromModel(svc.Model);
        samples[name] = withEnvelopeFields(exampleFrom(schemas[name]) || {}, {
          societyScoped: svc.Model.schema.$societyScoped === true,
        });
      }
      ref = `#/components/schemas/${name}`;
      sample = samples[name];
    }

    const { templated, params } = pathAndParams(route.path);
    const { security, note } = securityFor(route.chain);
    const message = successMessage(route.method, route.path);
    const hasAuth = security.length > 0;

    const query = [];
    if (route.path.startsWith('/api/v1/app/') && !route.path.startsWith('/api/v1/app/users')) {
      query.push(SOCIETY_QUERY);
    }
    if (route.method === 'GET' && isListPath(route.path)) query.push(...listParams(svc));

    const operation = {
      tags: [tag],
      summary: OVERRIDES[`${route.method} ${route.path}`]
        || summarise(route.method, route.path, resource, svc),
      description: `**Authentication.** ${note}`,
      operationId: `${route.method.toLowerCase()}${templated.replace(/[^A-Za-z0-9]+(.)/g, (_, ch) => ch.toUpperCase())}`,
      security,
      parameters: [...params, ...query],
      responses: {
        [route.method === 'POST' ? '201' : '200']: {
          description: 'Success. Every society endpoint answers in the same envelope.',
          content: {
            'application/json': {
              schema: envelope(message, resultFor({ method: route.method, p: route.path, svc, ref })),
              example: {
                message,
                result: sampleResult({ method: route.method, p: route.path, svc, sample }),
              },
            },
          },
        },
        ...errorResponses(hasAuth),
      },
    };

    if (['POST', 'PUT', 'PATCH'].includes(route.method) && ref) {
      operation.requestBody = {
        required: true,
        content: {
          'application/json': {
            schema: {
              allOf: [{ $ref: ref }],
              description: 'Server-owned fields — `_id`, `societyId`, `createdAt`, `updatedAt`, '
                + '`isDeleted` — are ignored if sent. The society comes from the '
                + '`x-society-id` header or the `societyId` query parameter, never from the body.',
            },
            example: writeExample(sample),
          },
        },
      };
    }

    paths[templated] = paths[templated] || {};
    paths[templated][route.method.toLowerCase()] = operation;
  }

  return { paths, schemas, usedTags, count: all.length, unmapped };
}

module.exports = { build, routes };

/* ──────────────────────────── entry point ──────────────────────────── */

if (require.main === module) {
  const { paths, schemas, usedTags, count, unmapped } = build();
  const doc = require('./document')({ paths, schemas, usedTags, count });

  fs.writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);

  console.log(`society OpenAPI: ${count} endpoints, ${Object.keys(paths).length} paths, `
    + `${Object.keys(schemas).length} schemas -> ${path.relative(process.cwd(), OUT)}`);
  if (unmapped.length) {
    console.warn(`\n${unmapped.length} endpoint(s) matched no resource in catalog.js:`);
    unmapped.forEach((u) => console.warn(`  ${u}`));
  }
}
