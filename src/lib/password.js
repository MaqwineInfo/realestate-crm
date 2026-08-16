const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const KEYLEN = 64;
const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** Spec §74: strong password hashing. scrypt from stdlib, no bcrypt dependency. */
async function hash(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scrypt(plain, salt, KEYLEN, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt}$${derived.toString('hex')}`;
}

async function verify(plain, stored) {
  if (!plain || !stored) return false;
  const [scheme, N, r, p, salt, hex] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const derived = await scrypt(plain, salt, KEYLEN, { N: Number(N), r: Number(r), p: Number(p), maxmem: PARAMS.maxmem });
  const expected = Buffer.from(hex, 'hex');
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

/** Single-use token for invites and password resets: raw goes to the user, hash to the DB. */
function newToken() {
  const raw = crypto.randomBytes(32).toString('base64url');
  return { raw, hash: hashToken(raw) };
}

const hashToken = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');

/** Rules kept deliberately mild — spec asks for strong hashing, not password theatre. */
function validateStrength(plain) {
  if (!plain || plain.length < 8) return 'Password must be at least 8 characters.';
  if (!/[a-zA-Z]/.test(plain) || !/\d/.test(plain)) return 'Password must include a letter and a number.';
  return null;
}

module.exports = { hash, verify, newToken, hashToken, validateStrength };
