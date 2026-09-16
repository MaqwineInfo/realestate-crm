const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const models = require('../../src/db/models/society');
const crmModels = require('../../src/db/models');

const MODEL_DIR = path.join(__dirname, '..', '..', 'src', 'db', 'models', 'society');

/**
 * SOCIETY-PLAN.md §4.2 — the model parity gate.
 *
 * Society collections sit outside `tenantGuard` by design (D3), which removes
 * the guarantee the rest of this codebase leans on. These tests are what keeps
 * that a decision rather than a slow leak: every society model must declare
 * which kind of scoping it has, and nothing may quietly acquire none.
 */
test('society models', async (t) => {
  const names = Object.keys(models);

  await t.test('every model file is exported from index.js', () => {
    const files = fs.readdirSync(MODEL_DIR)
      .filter((f) => f.endsWith('.js') && f !== 'index.js' && f !== 'enums.js')
      .map((f) => f.replace('.js', ''))
      .sort();
    assert.deepEqual(names.slice().sort(), files, 'index.js and the directory disagree');
  });

  await t.test('all 60 collections are present', () => {
    assert.equal(names.length, 60);
  });

  await t.test('each model carries exactly one scoping plugin', () => {
    const unscoped = [];
    const doubleScoped = [];
    for (const name of names) {
      const { schema } = models[name];
      const society = schema.$societyScoped === true;
      const platform = schema.$platformScoped === true;
      if (!society && !platform) unscoped.push(name);
      if (society && platform) doubleScoped.push(name);
    }
    assert.deepEqual(unscoped, [], 'models with no scoping plugin — add societyGuard or platformScoped');
    assert.deepEqual(doubleScoped, [], 'models with both scoping plugins');
  });

  await t.test('society-scoped models require societyId', () => {
    for (const name of names) {
      const { schema } = models[name];
      if (schema.$societyScoped !== true) continue;
      const p = schema.path('societyId');
      assert.ok(p, `${name}: societyGuard did not add societyId`);
      assert.equal(p.isRequired, true, `${name}: societyId must be required`);
    }
  });

  await t.test('no society model carries tenantId', () => {
    // Societies are platform-level (D3). A tenantId here would mean someone
    // reached for the wrong guard and got isolation that does not apply.
    const offenders = names.filter((n) => models[n].schema.path('tenantId'));
    assert.deepEqual(offenders, [], 'society models must not be tenant-scoped');
  });

  await t.test('no society model name collides with a CRM model', () => {
    const crm = new Set(Object.keys(crmModels));
    const collisions = names.filter((n) => crm.has(n));
    assert.deepEqual(collisions, [], 'society model names must not shadow CRM models');
  });

  await t.test('no two models claim the same collection', () => {
    // The bug this port inherited twice: `users` declared under two shapes
    // (§2.3) and `complainthistories` under two spellings (§6.1).
    const seen = new Map();
    const clashes = [];
    for (const name of names) {
      const coll = models[name].collection.collectionName;
      if (seen.has(coll)) clashes.push(`${coll}: ${seen.get(coll)} and ${name}`);
      seen.set(coll, name);
    }
    assert.deepEqual(clashes, []);
  });

  await t.test('no society collection collides with a CRM collection', () => {
    /**
     * The society module shares the CRM's database, so an identical collection
     * name means the two systems write into the same collection — and inherit
     * each other's indexes. This is not hypothetical: `SocietyFloor` and the
     * CRM's `Floor` both defaulted to `floors`, so society floors hit the CRM's
     * unique `tenantId_1_towerId_1_number_1` index (all nulls on a society row)
     * and only the first insert of six survived. `users`, `roles`, `units` and
     * `notifications` collided the same way.
     *
     * Every society collection is prefixed `society_` so this cannot recur —
     * including for models nobody has written yet.
     */
    const crmCollections = new Map(
      Object.entries(crmModels).map(([n, M]) => [M.collection.collectionName, n]),
    );
    const collisions = [];
    const unprefixed = [];
    for (const name of names) {
      const coll = models[name].collection.collectionName;
      if (crmCollections.has(coll)) collisions.push(`${coll}: CRM ${crmCollections.get(coll)} vs ${name}`);
      if (!coll.startsWith('society_')) unprefixed.push(`${name} -> ${coll}`);
    }
    assert.deepEqual(collisions, [], 'society collections must not share a name with a CRM collection');
    assert.deepEqual(unprefixed, [], 'every society collection must be prefixed society_');
  });

  await t.test('collection names are lowercase', () => {
    // `complainthistories` vs `complaintHistories` is exactly how the source
    // ended up with the admin panel and the app writing different collections.
    const offenders = names
      .map((n) => models[n].collection.collectionName)
      .filter((c) => c !== c.toLowerCase());
    assert.deepEqual(offenders, []);
  });
});

test('society guard behaviour', async (t) => {
  const societyGuard = require('../../src/db/societyGuard');

  await t.test('a filter naming societyId passes', () => {
    assert.equal(societyGuard.hasSocietyFilter({ societyId: 'x' }), true);
  });

  await t.test('an unscoped filter is rejected', () => {
    assert.equal(societyGuard.hasSocietyFilter({ status: 'ACTIVE' }), false);
  });

  await t.test('$and passes when any branch is scoped, $or only when all are', () => {
    assert.equal(societyGuard.hasSocietyFilter({ $and: [{ a: 1 }, { societyId: 'x' }] }), true);
    assert.equal(societyGuard.hasSocietyFilter({ $or: [{ a: 1 }, { societyId: 'x' }] }), false);
    assert.equal(societyGuard.hasSocietyFilter({ $or: [{ societyId: 'x' }, { societyId: 'y' }] }), true);
  });

  await t.test('an id-anchored read is allowed, as it is for tenants', () => {
    assert.equal(societyGuard.isIdAnchored({ _id: 'abc' }), true);
    assert.equal(societyGuard.isIdAnchored({ name: 'abc' }), false);
  });
});
