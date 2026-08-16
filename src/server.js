const config = require('./config');
const db = require('./db');
const createApp = require('./app');

async function start() {
  await db.connect();
  await db.ensureIndexes();
  require('./services/listeners').register();
  require('./jobs/scheduler').start();

  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(JSON.stringify({
      level: 'info',
      msg: `CRM listening on ${config.appUrl}`,
      env: config.env,
      transactions: db.hasTransactions() ? 'replica-set' : 'standalone (saga mode, spec §87)',
    }));
  });

  const shutdown = async (signal) => {
    console.log(JSON.stringify({ level: 'info', msg: `${signal} received, shutting down` }));
    server.close(async () => {
      await db.disconnect();
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start().catch((err) => {
  console.error(JSON.stringify({ level: 'fatal', message: err.message, stack: err.stack }));
  process.exit(1);
});
