/**
 * Snapshot the whole database to one file, and load it back into an empty one.
 *
 *   npm run db:dump                 -> writes data/snapshot.json from MONGO_URI
 *   npm run db:restore              -> wipes MONGO_URI's db and loads that file
 *   node scripts/db-snapshot.js restore mongodb://host/other_db
 *
 * EJSON keeps ObjectIds, Dates and Decimal128 intact, so ids and references
 * survive the round trip and the restored database is byte-identical.
 */
const fs = require('node:fs');
const path = require('node:path');
const { EJSON } = require('bson');
const db = require('../src/db');
const config = require('../src/config');

const DEFAULT_FILE = path.join(__dirname, '..', 'data', 'snapshot.json');

async function dump(file, uri) {
  await db.connect(uri);
  const conn = db.mongoose.connection.db;
  const names = (await conn.listCollections({}, { nameOnly: true }).toArray())
    .map((c) => c.name)
    .filter((n) => !n.startsWith('system.'))
    .sort();

  const out = {};
  for (const name of names) {
    out[name] = await conn.collection(name).find({}).toArray();
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, EJSON.stringify(out, null, 2));

  const total = Object.values(out).reduce((n, docs) => n + docs.length, 0);
  console.log(`dumped ${total} docs from ${names.length} collections -> ${file}`);
}

async function restore(file, uri) {
  if (config.env === 'production') throw new Error('refusing to restore over a production database');
  const data = EJSON.parse(fs.readFileSync(file, 'utf8'));

  await db.connect(uri);
  await db.mongoose.connection.dropDatabase();

  let total = 0;
  for (const [name, docs] of Object.entries(data)) {
    if (!docs.length) continue;
    await db.mongoose.connection.db.collection(name).insertMany(docs, { ordered: false });
    total += docs.length;
  }
  await db.ensureIndexes();
  console.log(`restored ${total} docs into ${db.mongoose.connection.name}`);
}

const [mode, arg] = process.argv.slice(2);
const uri = arg && arg.startsWith('mongodb') ? arg : undefined;
const file = arg && !uri ? arg : DEFAULT_FILE;

const run = { dump, restore }[mode];
if (!run) {
  console.error('usage: node scripts/db-snapshot.js dump|restore [file|mongodb-uri]');
  process.exit(1);
}

run(file, uri)
  .then(() => db.disconnect())
  .catch(async (err) => {
    console.error(err.message);
    await db.disconnect().catch(() => {});
    process.exit(1);
  });
