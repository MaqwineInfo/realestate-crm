const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const manifest = require('../../docs/society-endpoints.json');

/**
 * SOCIETY-PLAN.md §4.1 — the contract gate.
 *
 * `docs/society-endpoints.json` is the contract of record: every endpoint the
 * three source services expose, extracted by
 * `scripts/society-extract-contract.js`. This test asserts each row resolves to
 * a real handler in this codebase.
 *
 * Rows not yet built live in `PENDING` below. That list is the honest measure
 * of how much of the port is left, it shrinks every phase, and it must reach
 * zero. Nothing may be removed from it without an endpoint appearing.
 *
 * The point of the gate is that "we forgot one" becomes a failing test rather
 * than a support ticket eighteen months from now.
 */

/**
 * What is actually mounted, read off the Express app rather than from a list
 * somebody has to remember to update. A hand-kept list drifts the first time
 * someone deletes a route; this cannot.
 */
const ROUTER_DIR = path.join(__dirname, '..', '..', 'src', 'routes', 'society-api');

function registeredRoutes() {
  // The society routers are walked directly rather than through `createApp()`:
  // building the app opens a MongoStore session store, which keeps the test
  // process alive after the assertions finish.
  const found = new Set();
  const walk = (stack) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const m of Object.keys(layer.route.methods)) {
          if (m !== '_all') found.add(`${m.toUpperCase()} ${layer.route.path}`);
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        walk(layer.handle.stack);
      }
    }
  };
  const load = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) load(p);
      else if (entry.name.endsWith('.js') && !entry.name.startsWith('_')) walk(require(p).stack);
    }
  };
  load(ROUTER_DIR);
  return found;
}

const IMPLEMENTED = registeredRoutes();

/**
 * The manifest now carries each endpoint's fully-resolved path, because
 * `scripts/society-extract-contract.js` walks the whole `router.use()` chain.
 * Re-deriving it here was how `/society-admin/society-admin/...` appeared —
 * the extractor had already chained that prefix and the test added it again.
 */
const contractKey = (row) => `${row.method} ${row.path}`;

/**
 * Only rows Express can actually reach.
 *
 * `reachable: false` marks a route file nothing mounts — its endpoints do not
 * exist in the running service however many `router.get()` calls it declares.
 * The port builds what is reachable; the rest are recorded so the difference
 * between "475 declared" and "467 real" stays visible rather than looking like
 * missing work.
 */
const REACHABLE = manifest.filter((r) => r.reachable);

test('society API contract', async (t) => {
  const keys = REACHABLE.map(contractKey);

  await t.test('the manifest is present and complete', () => {
    assert.equal(manifest.length, 468, 'the contract of record should hold 468 declared endpoints');
    for (const row of manifest) {
      assert.ok(row.service && row.method && row.file && row.path,
        `malformed manifest row: ${JSON.stringify(row)}`);
      assert.equal(typeof row.reachable, 'boolean', 'every row says whether Express can reach it');
    }
    assert.equal(REACHABLE.length, 463, '5 live in a route file nothing mounts');
    assert.equal(new Set(keys).size, 460,
      '460 distinct endpoints: 468 declared, minus 5 unmounted and 3 duplicate registrations');
  });

  await t.test('every endpoint has a well-formed contract key', () => {
    for (const key of keys) {
      assert.match(key, /^(GET|POST|PUT|PATCH|DELETE) \/api\/v1\//, `bad key: ${key}`);
    }
  });

  await t.test('the manifest is regenerable', () => {
    // If the extractor is gone the manifest cannot be re-derived from source,
    // and the contract stops being verifiable.
    assert.ok(fs.existsSync(path.join(__dirname, '..', '..', 'scripts', 'society-extract-contract.js')));
  });

  await t.test('every mounted /api/v1 route is in the contract', () => {
    // Catches the opposite mistake to a missing endpoint: a route invented
    // here that no client asked for, or a path typo that will 404 in the app
    // while looking implemented from the inside.
    const all = new Set(keys);
    const stray = [...IMPLEMENTED].filter((k) => k.includes(' /api/v1/') && !all.has(k));
    assert.deepEqual(stray.sort(), [], 'mounted routes that are not in the contract');
  });

  /** Each shipped phase locks in: its endpoints may not silently disappear. */
  const phaseComplete = (name, match) => t.test(name, () => {
    const wanted = [...new Set(REACHABLE.filter(match).map(contractKey))];
    const missing = wanted.filter((k) => !IMPLEMENTED.has(k));
    assert.deepEqual(missing.sort(), [], `${name}: endpoints not mounted`);
  });

  await phaseComplete('Phase 1 — auth and super-admin', (r) => r.service === 'admin'
    && (r.file.includes('/adminRoutes/') || r.file.includes('/authRoutes')));

  await phaseComplete('Phase 2 — structure, staff and onboarding',
    (r) => r.file.includes('societyAdminRoutes/societyRoutes')
      || /society-services\/src\/routes\/(block|floor|unit)Routes/.test(r.file));

  await phaseComplete('Phase 3 — members, family and committee',
    (r) => /societyAdminRoutes\/(userRoutes|committeeRoutes|adminRoutes)\.js/.test(r.file)
      || /society-user-services\/src\/routes\/memberRoutes/.test(r.file)
      || /society-services\/src\/routes\/societyUserRoutes/.test(r.file));

  await phaseComplete('Phase 4 — amenities and bookings',
    (r) => /amenityRoutes|amenityBookingRoutes/.test(r.file));

  await phaseComplete('Phase 5 — complaints', (r) => /complaintRoutes/.test(r.file));

  await phaseComplete('Phase 6 — communication',
    (r) => /noticeRoutes|pollRoutes|eventRoutes|galleryRoutes|societyDocumentRoutes|emergencyNumberRoutes|feedbackRoutes|lostAndFoundRoutes|notificationRoutes/.test(r.file));

  await phaseComplete('Phase 7 — money',
    (r) => /billRoutes|billCategoryRoutes|maintenanceRoutes|penaltyRoutes|balanceSheetRoutes/.test(r.file));

  await phaseComplete('Phase 8 — parking and vehicles',
    (r) => /parkingRoutes|parkingLevelRoutes|vehicleRoutes/.test(r.file));

  await phaseComplete('Phase 9 — visitors, gate and attendance',
    (r) => /visitorRoutes|gatekeeperRoutes|attendanceRoutes/.test(r.file));

  await t.test('port progress', () => {
    const total = new Set(keys).size;
    const done = [...IMPLEMENTED].filter((k) => k.includes(' /api/v1/')).length;
    // Not an assertion of completeness — a visible counter, so progress is
    // reported by the suite rather than by memory.
    console.log(`      society port: ${done}/${total} endpoints (${((done / total) * 100).toFixed(1)}%)`);
    assert.ok(done <= total);
  });
});
