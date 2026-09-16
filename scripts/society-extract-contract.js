const fs = require('node:fs');
const path = require('node:path');

/**
 * Extracts the society API contract from the source services.
 *
 * Walks each service's route tree, resolves the `router.use()` mount chain from
 * `routes/index.js` down to each leaf file, and emits one row per endpoint with
 * its FULL path. The output — `docs/society-endpoints.json` — is the contract of
 * record for the port: `tests/society/contract.test.js` asserts every row
 * resolves to a mounted handler.
 *
 * Usage: node scripts/society-extract-contract.js <out.json> [servicesDir]
 */
const ROOT = process.argv[3]
  || '/Users/amitpanchal/shivalik-frontend/real-estate-os-dev/services';
const SERVICES = {
  'society-admin-services': 'admin',
  'society-services': 'legacy',
  'society-user-services': 'user',
};

const walk = (dir, fn) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, fn); else fn(p);
  }
};

const joinPath = (...parts) => `/${parts.join('/')}`.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');

/**
 * Strips comments before matching.
 *
 * Whole blocks of routes are commented out in these services — the legacy
 * parking service has `// router.post('/rules', ...)` for six endpoints whose
 * handlers were deleted. A regex over the raw source counts them as real, which
 * inflates the contract with endpoints that do not exist and cannot be built.
 *
 * Deliberately crude: it does not try to understand strings containing `//`.
 * A URL literal like 'http://x' inside a route path would be mangled, and none
 * of these services has one — a route path is always relative.
 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
  .join('\n');

/**
 * Maps each route file to its parent and the prefix the parent mounts it under.
 * A file can only be mounted once in these services, which is what makes a
 * single upward walk sufficient.
 */
function buildMountTree(routesDir) {
  const parent = new Map();
  walk(routesDir, (file) => {
    if (!file.endsWith('.js')) return;
    const src = stripComments(fs.readFileSync(file, 'utf8'));

    const required = {};
    for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*require\(['"](\.[^'"]+)['"]\)/g)) {
      required[m[1]] = path.resolve(path.dirname(file), m[2].endsWith('.js') ? m[2] : `${m[2]}.js`);
    }
    // `router.use('/x', a)` and `router.use('/x', [mw], a)` both appear.
    for (const m of src.matchAll(/router\.use\(\s*['"]([^'"]*)['"]\s*,\s*(?:\[[^\]]*\]\s*,\s*)?(\w+)\s*\)/g)) {
      const target = required[m[2]];
      if (target) parent.set(target, { parent: file, prefix: m[1] });
    }
  });
  return parent;
}

/** Walks up the mount chain to the service root, accumulating the prefix. */
function fullPrefix(file, tree, seen = new Set()) {
  if (seen.has(file)) return ''; // defensive: a cycle would otherwise hang
  seen.add(file);
  const link = tree.get(file);
  if (!link) return '';
  return joinPath(fullPrefix(link.parent, tree, seen), link.prefix);
}

const rows = [];
for (const [service, tag] of Object.entries(SERVICES)) {
  const routesDir = path.join(ROOT, service, 'src', 'routes');
  const tree = buildMountTree(routesDir);
  const rootIndex = path.join(routesDir, 'index.js');

  walk(routesDir, (file) => {
    if (!file.endsWith('.js')) return;
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    const mount = fullPrefix(file, tree);
    /**
     * A route file nothing mounts is dead code: Express never sees it, so its
     * endpoints do not exist however many `router.get()` calls it contains.
     * `society-admin-services/routes/societyAdminRoutes/billCategoryRoutes.js`
     * is one — its paths are served from `billRoutes.js` under
     * `/bill/category/*` instead. Flagged rather than dropped, so the count
     * stays honest and the reason is visible.
     */
    const reachable = file === rootIndex || tree.has(file);

    for (const m of src.matchAll(/router\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]*)['"`]/g)) {
      const route = m[2] === '/' ? '' : m[2];
      rows.push({
        service: tag,
        file: path.relative(ROOT, file),
        method: m[1].toUpperCase(),
        mount,
        route: m[2],
        // The full mounted path, so consumers never re-derive the chain.
        path: joinPath('api/v1', mount, route),
        reachable,
      });
    }
  });
}

const out = process.argv[2] || 'docs/society-endpoints.json';
fs.writeFileSync(out, `${JSON.stringify(rows, null, 2)}\n`);

const live = rows.filter((r) => r.reachable);
const unique = new Set(live.map((r) => `${r.method} ${r.path}`));
const orphanFiles = [...new Set(rows.filter((r) => !r.reachable).map((r) => r.file))];
console.log(JSON.stringify({
  total: rows.length,
  reachable: live.length,
  unique: unique.size,
  unmountedFiles: orphanFiles,
  byService: live.reduce((a, r) => ({ ...a, [r.service]: (a[r.service] || 0) + 1 }), {}),
}, null, 2));
