const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../helpers');
const { SocietyRole } = require('../../src/db/models/society');

const SPEC = path.join(__dirname, '..', '..', 'docs', 'society-openapi.json');
const manifest = require('../../docs/society-endpoints.json');
const { routes } = require('../../scripts/society-openapi');

/**
 * The API document is a gate, not a artefact.
 *
 * A hand-written API document is wrong within a week and nobody finds out until
 * a client is built against it. This one is generated, so the only things worth
 * asserting are that it was regenerated after the last change, that it covers
 * every endpoint the contract knows about, and that what it says about
 * authentication matches the middleware actually guarding each route — a
 * security note that drifts is worse than none.
 */

const doc = JSON.parse(fs.readFileSync(SPEC, 'utf8'));

/** `/api/v1/notices/:id` as OpenAPI writes it. */
const templated = (p) => p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

const operations = () => Object.entries(doc.paths).flatMap(
  ([p, ops]) => Object.entries(ops).map(([method, op]) => ({ path: p, method, op })),
);

test('the society API document', async (t) => {
  await t.test('is regenerable, and is not stale', () => {
    const { build } = require('../../scripts/society-openapi');
    const fresh = build();
    assert.equal(
      Object.keys(fresh.paths).length,
      Object.keys(doc.paths).length,
      'docs/society-openapi.json is behind the routes — run `npm run society:openapi`',
    );
    assert.deepEqual(
      Object.keys(fresh.paths).sort(),
      Object.keys(doc.paths).sort(),
      'the committed document lists different paths than the code serves',
    );
  });

  await t.test('covers every endpoint the contract knows about', () => {
    const documented = new Set(operations().map((o) => `${o.method.toUpperCase()} ${o.path}`));
    const missing = [...new Set(
      manifest.filter((r) => r.reachable).map((r) => `${r.method} ${templated(r.path)}`),
    )].filter((k) => !documented.has(k));

    assert.deepEqual(missing, [], 'endpoints in the contract with no entry in the document');
    assert.equal(documented.size, 460);
  });

  await t.test('documents nothing that is not mounted', () => {
    const real = new Set(routes().map((r) => `${r.method} ${templated(r.path)}`));
    const invented = operations()
      .map((o) => `${o.method.toUpperCase()} ${o.path}`)
      .filter((k) => !real.has(k));
    assert.deepEqual(invented, []);
  });

  await t.test('every operation carries a tag that is declared', () => {
    const declared = new Set(doc.tags.map((x) => x.name));
    for (const { path: p, method, op } of operations()) {
      assert.ok(op.tags?.length, `${method} ${p} has no tag`);
      for (const tag of op.tags) assert.ok(declared.has(tag), `${method} ${p}: undeclared tag ${tag}`);
    }
  });

  await t.test('every operation has a summary that says something', () => {
    for (const { path: p, method, op } of operations()) {
      assert.ok(op.summary && op.summary.length > 2, `${method} ${p} has no usable summary`);
      assert.doesNotMatch(op.summary, /^(Read|Get|List|Create|Update|Delete)$/,
        `${method} ${p}: bare verb as a summary`);
    }
  });

  await t.test('operation ids are unique', () => {
    const ids = operations().map((o) => o.op.operationId);
    assert.equal(new Set(ids).size, ids.length, 'a duplicate operationId breaks client generation');
  });
});

test('what the document says about authentication is true', async (t) => {
  const byKey = new Map(routes().map((r) => [`${r.method} ${templated(r.path)}`, r]));

  await t.test('every route behind a verifier is documented as requiring one', () => {
    for (const { path: p, method, op } of operations()) {
      const route = byKey.get(`${method.toUpperCase()} ${p}`);
      const guarded = route.chain.some((n) => /Verify|societyAdminOr/.test(n));
      assert.equal(
        op.security.length > 0, guarded,
        `${method} ${p}: document says ${op.security.length ? 'authenticated' : 'public'}, `
        + `code says ${guarded ? 'authenticated' : 'public'}`,
      );
    }
  });

  await t.test('the only public endpoints are the seven that must be', () => {
    const open = operations()
      .filter((o) => o.op.security.length === 0)
      .map((o) => `${o.method.toUpperCase()} ${o.path}`)
      .sort();

    assert.deepEqual(open, [
      'POST /api/v1/app/users/register',
      'POST /api/v1/app/users/resend-otp',
      'POST /api/v1/app/users/verify-otp',
      'POST /api/v1/auth/logout',
      'POST /api/v1/auth/resend-otp',
      'POST /api/v1/auth/send-otp',
      'POST /api/v1/auth/verify-otp',
    ], 'a new public endpoint appeared — that is a decision, not an accident');
  });

  await t.test('a society-pinned route documents the header it will reject you without', () => {
    for (const { path: p, method, op } of operations()) {
      const route = byKey.get(`${method.toUpperCase()} ${p}`);
      const pinned = route.chain.some(
        (n) => n === 'societyAdminVerifyToken' || n === 'securityGuardVerifyToken',
      );
      if (!pinned) continue;
      assert.ok(
        op.security.every((s) => 'societyId' in s),
        `${method} ${p} needs x-society-id but the document does not say so`,
      );
    }
  });

  await t.test('the resident surface documents its societyId query parameter', () => {
    const resident = operations().filter(
      (o) => o.path.startsWith('/api/v1/app/') && !o.path.startsWith('/api/v1/app/users'),
    );
    assert.ok(resident.length > 40);
    for (const { path: p, method, op } of resident) {
      assert.ok(
        op.parameters.some((x) => x.name === 'societyId' && x.in === 'query'),
        `${method} ${p} is on the resident surface but does not document societyId`,
      );
    }
  });
});

test('the document describes the wire, not the collection', async (t) => {
  const schemas = doc.components.schemas;

  await t.test('money is documented in rupees, never as paise', () => {
    const json = JSON.stringify(schemas);
    assert.doesNotMatch(json, /"[a-zA-Z]+Minor"/, 'a storage-only money column leaked into the document');

    const bill = schemas.SocietyUnitBill;
    assert.ok(bill.properties.amount, 'amountMinor is documented under its wire name');
    assert.equal(bill.properties.amount.type, 'string');
    assert.match(bill.properties.amount.description, /decimal string/);
    assert.equal(bill.properties.amountMinor, undefined);
  });

  await t.test('secrets are not documented, because they are never sent', () => {
    for (const [name, schema] of Object.entries(schemas)) {
      for (const field of ['otp', 'otpExpiresAt', 'otpDatetime']) {
        assert.equal(schema.properties?.[field], undefined, `${name} documents ${field}`);
      }
    }
  });

  await t.test('a scoped model says so, and a platform one says so', () => {
    assert.match(schemas.SocietyNotice.description, /Society-scoped/);
    assert.match(schemas.Society.description, /Platform-scoped/);
  });

  await t.test('enums come from the schema, so they cannot drift', () => {
    const enums = require('../../src/db/models/society/enums');
    assert.deepEqual(
      schemas.SocietyNotice.properties.publishStatus.enum,
      enums.publishStatus,
    );
  });
});

test('every operation shows a sample record', async (t) => {
  await t.test('responses carry a worked example in the envelope', () => {
    for (const { path: p, method, op } of operations()) {
      const ok = op.responses['200'] || op.responses['201'];
      const example = ok.content['application/json'].example;
      assert.ok(example, `${method} ${p} has no response example`);
      assert.ok(typeof example.message === 'string' && example.message.length,
        `${method} ${p}: example has no message`);
      assert.ok('result' in example, `${method} ${p}: example has no result`);
    }
  });

  await t.test('a list example is the list envelope, not a bare array', () => {
    const list = doc.paths['/api/v1/society-admin/notices'].get;
    const { result } = list.responses['200'].content['application/json'].example;
    assert.ok(Array.isArray(result.notices), 'the array sits under a key named for the resource');
    assert.equal(result.pagination.page, 1);
    assert.equal(result.notices[0].title, 'Water tank cleaning');
  });

  await t.test('a write example omits the fields the server owns', () => {
    const body = doc.paths['/api/v1/society-admin/notices'].post
      .requestBody.content['application/json'].example;
    for (const field of ['_id', 'societyId', 'createdAt', 'updatedAt', 'isDeleted']) {
      assert.equal(body[field], undefined, `the request example invites the caller to send ${field}`);
    }
    assert.ok(body.title, 'but it does show the fields they must send');
  });

  await t.test('a sample record does not contradict itself', () => {
    const notice = doc.paths['/api/v1/society-admin/notices'].get
      .responses['200'].content['application/json'].example.result.notices[0];
    assert.equal(notice.isDeleted, false);
    assert.equal(notice.deletedAt, null, 'a live record has no deletion date');
  });

  await t.test('errors are documented in the same envelope', () => {
    const op = doc.paths['/api/v1/society-admin/notices'].get;
    assert.ok(op.responses['401'], 'an authenticated endpoint documents its 401');
    const example = op.responses['401'].content['application/json'].example;
    assert.deepEqual(Object.keys(example).sort(), ['message', 'result']);
  });
});

test('the docs page is served, and only to people allowed to see it', async (t) => {
  let base;
  let admin;
  let orgA;

  await t.before(async () => {
    base = await h.startServer();
    await h.resetDb();
    ({ orgA } = await h.seedTwoOrgs());
    await SocietyRole.create({
      key: 'chairman', name: 'Chairman', displayName: 'Chairman', level: 2, scope: 'society', permissions: [],
    });
    admin = h.client();
    await admin.login('admin@alpha.test');
  });

  await t.after(async () => { await h.stopServer(); });

  await t.test('the page renders', async () => {
    const res = await admin.get('/app/society/api-docs');
    assert.equal(res.status, 200);
    assert.match(res.text, /Society API/);
    assert.match(res.text, /swagger-ui-bundle\.js/);
    assert.doesNotMatch(res.text, /Something went wrong/);
  });

  await t.test('the document is served as JSON', async () => {
    const res = await admin.get('/app/society/api-docs/openapi.json');
    assert.equal(res.status, 200);
    const spec = JSON.parse(res.text);
    assert.equal(spec.openapi, '3.1.0');
    assert.equal(Object.keys(spec.paths).length, Object.keys(doc.paths).length);
  });

  await t.test('the UI assets are served from this origin, not a CDN', async () => {
    for (const file of ['swagger-ui.css', 'swagger-ui-bundle.js']) {
      const res = await admin.get(`/app/society/api-docs/${file}`);
      assert.equal(res.status, 200, file);
      assert.ok(res.text.length > 1000, `${file} looks empty`);
    }
  });

  await t.test('the initialiser is a file, because inline scripts are blocked', async () => {
    const page = await admin.get('/app/society/api-docs');
    assert.doesNotMatch(page.text, /<script>[^<]*SwaggerUIBundle/, 'an inline boot would not run under the CSP');

    const boot = await fetch(`${base}/js/society-api-docs.js`);
    assert.equal(boot.status, 200);
    assert.match(await boot.text(), /SwaggerUIBundle/);
  });

  await t.test('a user without society.view cannot read it', async () => {
    await h.addUser({
      tenant: orgA.tenant, roles: orgA.roles,
      name: 'Sales Rep', email: 'rep-docs@alpha.test', roleName: 'Sales User',
    });
    const rep = h.client();
    await rep.login('rep-docs@alpha.test');

    for (const p of ['/app/society/api-docs', '/app/society/api-docs/openapi.json']) {
      const res = await rep.get(p);
      assert.ok(res.status === 403 || res.status === 302, `${p} returned ${res.status}`);
    }
  });

  await t.test('and neither can somebody with no session at all', async () => {
    const res = await fetch(`${base}/app/society/api-docs/openapi.json`, { redirect: 'manual' });
    assert.equal(res.status, 302);
  });
});
