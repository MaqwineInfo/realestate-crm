const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');
const { badRequest, notFound } = require('./errors');

/**
 * V2 §131, §193, §344.23: storage for files that must never be served by URL.
 *
 * The only difference from `services/projectAssets` — which writes into
 * `public/` on purpose, because brochures are meant to be shared — is that
 * nothing here is reachable without passing a permission check first. There is
 * no static route into `PRIVATE_UPLOAD_DIR`; `stream()` is the only way out.
 *
 * ponytail: local disk, same as project assets. Swap store/stream for an
 * object-store put/get with a signed URL if this ever leaves one box.
 */
const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const DOCUMENT_MIME = ['application/pdf'];
const DEFAULT_ALLOWED = [...IMAGE_MIME, ...DOCUMENT_MIME];

/**
 * §193: an executable can never be a KYC document, whatever it claims to be.
 * The declared MIME is checked against an allowlist rather than a blocklist,
 * and the extension is derived from the MIME — never from the uploaded name.
 */
const EXTENSION = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
};

function assertAcceptable({ mimeType, size, allowed = DEFAULT_ALLOWED, maxBytes = config.maxUploadBytes }) {
  if (!mimeType || !allowed.includes(mimeType)) {
    const names = allowed.map((m) => (m === 'application/pdf' ? 'PDF' : m.replace('image/', '').toUpperCase()));
    throw badRequest(`This file type is not accepted. Upload ${[...new Set(names)].join(', ')}.`);
  }
  if (!size) throw badRequest('That file is empty.');
  if (size > maxBytes) {
    throw badRequest(`Files must be under ${Math.max(1, Math.round(maxBytes / 1024 / 1024))} MB.`);
  }
}

/**
 * Writes the bytes under a random key. The uploaded filename is kept only as a
 * display label — it never reaches the filesystem, so "../../etc/passwd.pdf"
 * is just a string in Mongo.
 */
async function store({ tenantId, scope, mimeType, buffer }) {
  const safeScope = String(scope || 'misc').replace(/[^a-z0-9-]/gi, '').slice(0, 24) || 'misc';
  const key = `${tenantId}/${safeScope}/${crypto.randomBytes(16).toString('hex')}${EXTENSION[mimeType] || ''}`;
  const target = path.join(config.privateUploadDir, key);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, buffer);
  return { storageKey: key, bytes: buffer.length };
}

/** Absolute path for a stored key, refusing anything that tries to escape. */
function resolve(storageKey) {
  const root = path.resolve(config.privateUploadDir);
  const target = path.resolve(root, String(storageKey || ''));
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw badRequest('Invalid file reference.');
  }
  return target;
}

async function read(storageKey) {
  try {
    return await fs.readFile(resolve(storageKey));
  } catch {
    throw notFound('That file is no longer available.');
  }
}

/** A display-safe filename: never the raw upload name. */
const downloadName = (label, mimeType) => {
  const base = String(label || 'document').replace(/[^\w. -]/g, '').slice(0, 60).trim() || 'document';
  const ext = EXTENSION[mimeType] || '';
  return base.toLowerCase().endsWith(ext) ? base : `${base}${ext}`;
};

/**
 * §131: masking. A document number is shown as its last four characters; the
 * full value lives sealed (lib/secretbox) and is only ever revealed by an
 * explicit, audited action.
 */
function maskNumber(value) {
  const clean = String(value || '').replace(/\s+/g, '');
  if (!clean) return '';
  if (clean.length <= 4) return '•'.repeat(clean.length);
  return `${'•'.repeat(Math.min(8, clean.length - 4))}${clean.slice(-4)}`;
}

module.exports = {
  IMAGE_MIME, DOCUMENT_MIME, DEFAULT_ALLOWED, EXTENSION,
  assertAcceptable, store, read, resolve, downloadName, maskNumber,
};
