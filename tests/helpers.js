const path = require('node:path');

process.env.NODE_ENV = 'test';
// The test runner executes files in parallel, so each file gets its own
// database — otherwise one suite's reset wipes another's fixtures mid-run.
const suiteFile = process.argv[1] || 'suite.test.js';
const suite = path.basename(suiteFile, '.test.js').replace(/\W/g, '_');
/** The directory decides which models a suite gets — see `modelSetsFor`. */
const suiteDir = path.basename(path.dirname(suiteFile));
process.env.MONGO_URI = process.env.TEST_MONGO_URI || `mongodb://127.0.0.1:27017/crm_test_${suite}`;
process.env.SESSION_SECRET = 'test-secret';

const db = require('../src/db');
const createApp = require('../src/app');
const seed = require('../src/db/seed');

let server;
let baseUrl;
let app;

/**
 * A suite only builds the indexes it needs — see `db.ensureIndexes`. Society
 * suites opt in so a CRM-only suite does not create 60 collections' worth of
 * index files it will never read.
 *
 * Decided by DIRECTORY, not by filename. Matching on the filename meant
 * `tests/society/journey.test.js` and `screens.test.js` quietly got the CRM
 * indexes only — so every uniqueness rule in the society module was absent
 * while their tests ran, and a double-booking assertion passed by not being
 * tested. A directory cannot be misspelled into silence the way a prefix can.
 */
function modelSetsFor(dir) {
  return dir === 'society' ? ['crm', 'society'] : ['crm'];
}

async function startServer() {
  if (server) return baseUrl;
  await db.connect();
  // Drop before the session store starts: dropping the database underneath
  // connect-mongo's TTL index build aborts it and crashes the process.
  await db.dropDatabase();
  require('../src/services/listeners').register();
  app = createApp();
  /**
   * Tests build only the indexes that enforce a rule — see `db.ensureIndexes`.
   * A performance index cannot change an assertion's outcome, and building all
   * of them in every suite database is what exhausted mongod's file handles.
   */
  await db.ensureIndexes({ include: modelSetsFor(suiteDir), uniqueOnly: true });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return baseUrl;
}

async function stopServer() {
  if (server) await new Promise((resolve) => server.close(resolve));
  // The session store holds its own Mongo client; leaving it open hangs the run.
  if (app?.locals?.sessionStore?.close) await app.locals.sessionStore.close();
  /**
   * Drop the suite's database on the way out.
   *
   * WiredTiger writes one file per collection AND one per index. Two dozen
   * suites, each with a database holding every model in the app, is tens of
   * thousands of files — and because each run only dropped its database on
   * START, every run left its own set behind. The mongod data directory grew
   * past 38,000 files and mongod began aborting on startup because its
   * diagnostics subsystem could no longer create a temp file there.
   *
   * Dropping here bounds it to one run's worth.
   */
  try {
    if (db.mongoose.connection.readyState === 1) await db.dropDatabase();
  } catch { /* a suite that never connected has nothing to drop */ }
  server = null;
  baseUrl = null;
  app = null;
  await db.disconnect();
}

/**
 * Clears business data between suites. Collections are emptied rather than the
 * database dropped, so the running session store keeps its indexes.
 */
async function resetDb() {
  const collections = await db.mongoose.connection.db.listCollections().toArray();
  await Promise.all(collections
    .filter((c) => c.name !== 'sessions')
    .map((c) => db.mongoose.connection.db.collection(c.name).deleteMany({})));
}

/** A browser-ish client: keeps cookies and hands back parsed responses. */
function client() {
  const jar = new Map();
  let lastPage = null;

  const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

  function absorb(res) {
    const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const line of raw) {
      const [pair] = line.split(';');
      const idx = pair.indexOf('=');
      jar.set(pair.slice(0, idx), pair.slice(idx + 1));
    }
  }

  async function request(method, path, { body, json, rawBody, headers = {}, redirect = 'manual' } = {}) {
    const browserAccept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
    const init = {
      method,
      redirect,
      headers: { accept: json ? 'application/json' : browserAccept, cookie: cookieHeader(), ...headers },
    };
    // Browsers send a same-origin Referer on form posts; the app uses it to
    // bounce validation errors back to the page the user was on.
    if (method !== 'GET' && !json && lastPage && !init.headers.referer) {
      init.headers.referer = baseUrl + lastPage;
    }
    // File uploads: the caller builds the multipart body and sets its own
    // content-type, because that boundary has to match byte for byte.
    if (rawBody) {
      init.body = rawBody;
    } else if (json) {
      init.headers['content-type'] = 'application/json';
      init.headers.accept = 'application/json';
      init.body = JSON.stringify(json);
    } else if (body) {
      init.headers['content-type'] = 'application/x-www-form-urlencoded';
      // A browser sends one key per value for repeated fields; URLSearchParams
      // would otherwise join arrays into a single "a,b" value.
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(body)) {
        if (Array.isArray(value)) value.forEach((v) => params.append(key, v));
        else params.append(key, value);
      }
      init.body = params.toString();
    }
    const res = await fetch(baseUrl + path, init);
    absorb(res);
    if (method === 'GET' && res.status === 200) lastPage = path;
    const text = await res.text();
    let data = null;
    if ((res.headers.get('content-type') || '').includes('application/json')) {
      try { data = JSON.parse(text); } catch { /* leave null */ }
    }
    return { status: res.status, headers: res.headers, text, data, location: res.headers.get('location') };
  }

  return {
    get: (path, opts) => request('GET', path, opts),
    post: (path, body, opts) => request('POST', path, { body, ...opts }),
    postJson: (path, json, opts) => request('POST', path, { json, ...opts }),

    /** Reads the CSRF token out of a rendered page so posts look like real form submits. */
    async csrf(path = '/login') {
      const res = await request('GET', path);
      const match = res.text.match(/name="_csrf" value="([^"]+)"/);
      return match ? match[1] : null;
    },

    async login(email, password = 'Password1') {
      const token = await this.csrf('/login');
      return this.post('/login', { _csrf: token, email, password });
    },

    /** Form post that fetches a fresh CSRF token from `page` first. */
    async submit(path, body, page = '/app/dashboard') {
      const token = await this.csrf(page);
      return this.post(path, { _csrf: token, ...body });
    },
  };
}

/**
 * Waits for a condition that an event listener will satisfy.
 *
 * `lib/events.js` emits through `setImmediate` and does not await handlers
 * (§61: notifications must never block the sale), so anything a listener writes
 * is not there the instant the HTTP response returns. Asserting immediately
 * passes on an idle machine and fails under load — polling makes the test wait
 * for the behaviour instead of racing it.
 *
 * Returns the first truthy value the probe produces, or throws after `timeout`.
 */
async function eventually(probe, { timeout = 3000, interval = 25, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    last = await probe();
    if (last) return last;
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeout}ms waiting for ${what}`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, interval); });
  }
}

/**
 * The dashboard work-queue table only. Asserting against the whole page is
 * unreliable — a customer's name also appears in the notifications panel.
 */
function queueSection(html) {
  const start = html.indexOf('data-queue=');
  if (start === -1) return '';
  return html.slice(start, html.indexOf('</table>', start));
}

/** Tile counts as rendered, keyed by tile label (HTML entities decoded). */
function tileCounts(html) {
  const decode = (s) => s
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  const counts = {};
  const re = /<div class="num">(\d+)<\/div>\s*<div class="lbl">([^<]+)<\/div>/g;
  let match = re.exec(html);
  while (match) {
    counts[decode(match[2]).trim()] = Number(match[1]);
    match = re.exec(html);
  }
  return counts;
}

/** Two independent organizations, so tenant isolation can actually be tested. */
async function seedTwoOrgs() {
  const orgA = await seed.createOrganization({
    name: 'Alpha Realty',
    adminName: 'Alpha Admin',
    adminEmail: 'admin@alpha.test',
    adminMobile: '9000000001',
    adminPassword: 'Password1',
  });
  const orgB = await seed.createOrganization({
    name: 'Beta Estates',
    adminName: 'Beta Admin',
    adminEmail: 'admin@beta.test',
    adminMobile: '9000000002',
    adminPassword: 'Password1',
  });
  return { orgA, orgB };
}

/** Adds a user to an org with one of the seeded default roles. */
async function addUser({ tenant, roles, name, email, roleName, managerId }) {
  const { User } = require('../src/db/models');
  const password = require('../src/lib/password');
  return User.create({
    tenantId: tenant._id,
    name,
    email,
    roleId: roles[roleName]._id,
    managerId,
    status: 'ACTIVE',
    passwordHash: await password.hash('Password1'),
  });
}

module.exports = {
  startServer, stopServer, resetDb, client, seedTwoOrgs, addUser, db, queueSection, tileCounts,
  eventually,
};
