const mongoose = require('mongoose');
const config = require('../config');

mongoose.set('strictQuery', true);

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
async function ensureIndexes() {
  const models = require('./models');
  await Promise.all(Object.values(models).map((Model) => Model.init()));
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
