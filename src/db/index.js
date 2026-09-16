const mongoose = require('mongoose');
const config = require('../config');

mongoose.set('strictQuery', true);

/**
 * Index creation is explicit, not lazy.
 *
 * Mongoose's default `autoIndex` fires a `createIndex` for every index on every
 * model the moment that model is first used. With the society module the app
 * declares ~130 models and several hundred indexes, and the test runner gives
 * each of two dozen suites its own database — so the default has every suite
 * independently rebuilding the whole index set, in parallel, in the background.
 * That is enough to take a local `mongod` down mid-run, which is the failure
 * the `--test-concurrency=4` cap already exists to avoid.
 *
 * `ensureIndexes()` below builds them once per boot instead, and waits.
 */
mongoose.set('autoIndex', false);

let transactionsSupported = null;

async function connect(uri = config.mongoUri) {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  transactionsSupported = await detectTransactionSupport();
  return mongoose.connection;
}

/**
 * Mongoose builds indexes in the background and does not wait, so a fresh
 * database can accept a duplicate before its unique index exists. The uniqueness
 * rules here are business rules (§9.2 one contact per mobile, §27 unique unit
 * number), so boot waits for them.
 */
/**
 * Builds the indexes for a model set, once, and waits.
 *
 * `include` selects which sets to build: `'crm'`, `'society'`, or both (the
 * default, which is what `server.js` uses — production needs every index).
 *
 * Tests pass a narrower set deliberately. WiredTiger holds an open file handle
 * per collection and per index in use, and macOS hands launchd services a low
 * file-descriptor budget (`launchctl limit maxfiles` is 256 by default). Four
 * suites in parallel, each with a database containing every model in the app,
 * exhausts it — and the first thing that fails is mongod's own diagnostics
 * subsystem creating a temp file, which it treats as fatal. Building only the
 * models a suite actually uses keeps that budget in reach.
 */
async function ensureIndexes({ include = ['crm', 'society'], uniqueOnly = false } = {}) {
  const sets = { crm: () => require('./models'), society: () => require('./models/society') };
  const models = {};
  for (const key of include) {
    if (sets[key]) Object.assign(models, sets[key]());
  }

  /**
   * `createIndexes()` rather than `init()`: with `autoIndex` off, `init()` no
   * longer creates anything, and the uniqueness rules here are business rules
   * (§9.2 one contact per mobile, §27 unique unit number, and the society
   * module's double-booking guard) — boot waits for them.
   *
   * Sequential, not `Promise.all`: a few hundred concurrent index builds is
   * what this is here to stop doing.
   */
  if (!uniqueOnly) {
    for (const Model of Object.values(models)) await Model.createIndexes();
    return;
  }

  /**
   * `uniqueOnly` builds just the indexes that ENFORCE something.
   *
   * Both model sets together declare ~795 indexes, of which ~70 are unique.
   * The other 725 are query plans: they change how fast a read is, never
   * whether a write is allowed, so no test outcome depends on them. Building
   * them in every one of two dozen test databases costs minutes of wall clock
   * and — because WiredTiger holds a file handle per index — exhausts the
   * file-descriptor budget macOS gives a launchd service, which takes mongod
   * down entirely.
   *
   * Production still builds everything; `server.js` passes no options.
   */
  for (const Model of Object.values(models)) {
    for (const [spec, options = {}] of Model.schema.indexes()) {
      if (!options.unique) continue;
      // eslint-disable-next-line no-await-in-loop
      await Model.collection.createIndex(spec, { ...options, background: false });
    }
  }
}

async function detectTransactionSupport() {
  try {
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    return Boolean(hello.setName || hello.msg === 'isdbgrid');
  } catch {
    return false;
  }
}

/**
 * Spec §87: "If full transaction unsupported, use idempotent saga with recovery."
 *
 * A standalone mongod cannot do multi-document transactions, so services are
 * written as ordered, idempotent sagas whose contended write is always a single
 * atomic conditional update. This helper adds a real transaction on top when the
 * deployment is a replica set, so pointing MONGO_URI at one upgrades integrity
 * with no code change.
 */
async function withTx(work) {
  if (!transactionsSupported) return work(null);
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await work(session); });
    return result;
  } finally {
    await session.endSession();
  }
}

const hasTransactions = () => Boolean(transactionsSupported);

async function disconnect() {
  await mongoose.connection.close();
}

/** Test helper only: never exposed through the app. */
async function dropDatabase() {
  if (config.env === 'production') throw new Error('refusing to drop database in production');
  await mongoose.connection.dropDatabase();
}

module.exports = { mongoose, connect, disconnect, withTx, hasTransactions, dropDatabase, ensureIndexes };
