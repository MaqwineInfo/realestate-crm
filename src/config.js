require('dotenv').config();

const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),
  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/real_estate_crm',
  sessionSecret: process.env.SESSION_SECRET || 'dev-only-insecure-secret',
  sessionMaxAgeMs: Number(process.env.SESSION_MAX_AGE_MS || 12 * 60 * 60 * 1000),
  uploadDir: process.env.UPLOAD_DIR || 'public/uploads',
  /**
   * V2 §131/§344.23: KYC documents, payment proofs and (later) RERA and face
   * images must never be reachable by URL. This directory sits OUTSIDE public/,
   * so the static handler cannot serve it — every read goes through a
   * permission-checked route (routes/files.js).
   */
  privateUploadDir: process.env.PRIVATE_UPLOAD_DIR || 'private-uploads',
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES || 10 * 1024 * 1024),
  appUrl: process.env.APP_URL || 'http://localhost:3000',
};

if (config.env === 'production' && config.sessionSecret === 'dev-only-insecure-secret') {
  throw new Error('SESSION_SECRET must be set in production');
}

/**
 * Invites, password resets, payment links and walk-in QR codes are opened on
 * somebody else's device, so a localhost APP_URL produces links that cannot
 * work. Screens built from a request fall back to that request's own host
 * (lib/publicUrl.js), but background sends have no request to fall back to.
 */
if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/i.test(config.appUrl)) {
  if (config.env === 'production') {
    throw new Error('APP_URL must be a public address in production — invite, reset, payment and QR links are built from it.');
  }
  console.warn(JSON.stringify({
    level: 'warn',
    msg: 'APP_URL is localhost — links sent by SMS, WhatsApp or email will not open on a customer device. Set APP_URL before sharing anything.',
    appUrl: config.appUrl,
  }));
}

module.exports = config;
