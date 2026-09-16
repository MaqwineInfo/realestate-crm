const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const { requirePermission } = require('../middleware/auth');

/**
 * Swagger UI for the society API, at `/app/society/api-docs`.
 *
 * Behind the CRM session and the same `society.view` permission as the rest of
 * the module — the document names every endpoint, every field and every auth
 * rule in the product, which is a map worth having before you attack something.
 * Publishing it unauthenticated would be handing that out.
 *
 * The UI assets are served from this origin rather than a CDN. The app's CSP
 * allows scripts from `'self'` only (`app.js`), and the right response to
 * "my documentation needs a CDN" is to host the documentation, not to widen the
 * policy that protects every other page.
 */
const router = express.Router();

const SPEC = path.join(__dirname, '..', '..', 'docs', 'society-openapi.json');
const UI = path.dirname(require.resolve('swagger-ui-dist/absolute-path.js'));

const gate = requirePermission('society.view');

/**
 * The generated document. Read per request rather than `require`d, so
 * regenerating it during development shows up on a refresh instead of after a
 * restart; it is a single file and the read is cached by the OS.
 */
router.get('/app/society/api-docs/openapi.json', gate, (req, res, next) => {
  fs.readFile(SPEC, 'utf8', (err, body) => {
    if (err) {
      return next(err.code === 'ENOENT'
        ? Object.assign(new Error('The API document has not been generated yet. Run `npm run society:openapi`.'), { status: 404 })
        : err);
    }
    res.type('application/json').send(body);
  });
});

/**
 * Swagger UI's own bundle. Explicitly listed rather than served as a directory:
 * the package ships its Node entry points and a source map alongside the
 * browser assets, and there is no reason for any of that to be reachable.
 */
const ASSETS = {
  'swagger-ui.css': 'text/css',
  'swagger-ui-bundle.js': 'application/javascript',
  'swagger-ui-standalone-preset.js': 'application/javascript',
  'favicon-32x32.png': 'image/png',
  'favicon-16x16.png': 'image/png',
};

for (const [file, type] of Object.entries(ASSETS)) {
  router.get(`/app/society/api-docs/${file}`, gate, (req, res) => {
    res.type(type).sendFile(path.join(UI, file), { maxAge: '1h' });
  });
}

/**
 * The page. Swagger UI is initialised from an external file rather than an
 * inline `<script>` for the same CSP reason — `scriptSrc: ['self']` has no
 * `unsafe-inline`, so an inline initialiser would silently not run.
 */
router.get('/app/society/api-docs', gate, (req, res) => {
  res.render('pages/society/api-docs', { title: 'Society API' });
});

module.exports = router;
