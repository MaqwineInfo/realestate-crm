require('dotenv').config();

const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),
  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/real_estate_crm',
  sessionSecret: process.env.SESSION_SECRET || 'dev-only-insecure-secret',
  sessionMaxAgeMs: Number(process.env.SESSION_MAX_AGE_MS || 12 * 60 * 60 * 1000),
  uploadDir: process.env.UPLOAD_DIR || 'public/uploads',
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES || 10 * 1024 * 1024),
  appUrl: process.env.APP_URL || 'http://localhost:3000',
};

if (config.env === 'production' && config.sessionSecret === 'dev-only-insecure-secret') {
  throw new Error('SESSION_SECRET must be set in production');
}

module.exports = config;
