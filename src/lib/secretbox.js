const crypto = require('node:crypto');
const config = require('../config');

/**
 * Spec §49.1 / §74: provider secrets are stored encrypted and are never shown
 * again after saving. AES-256-GCM from stdlib — the key comes from
 * SECRETS_KEY, falling back to a key derived from SESSION_SECRET so a dev
 * install works without extra setup.
 */
const key = crypto.createHash('sha256')
  .update(process.env.SECRETS_KEY || `secretbox:${config.sessionSecret}`)
  .digest();

function seal(plain) {
  if (plain === undefined || plain === null || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${enc.toString('base64url')}`;
}

function open(sealed) {
  if (!sealed) return null;
  const [version, iv, tag, payload] = String(sealed).split('.');
  if (version !== 'v1') return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(payload, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** What the UI may show: proof a secret exists, never the secret (§49.1). */
const mask = (sealed) => (sealed ? '••••••••' : '');

module.exports = { seal, open, mask };
