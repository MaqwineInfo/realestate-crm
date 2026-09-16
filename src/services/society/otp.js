const crypto = require('node:crypto');
const config = require('../../config');
const password = require('../../lib/password');
const messaging = require('./messaging');

/**
 * One-time passcodes for society logins.
 *
 * Both society identities authenticate by OTP on a phone — there is no
 * password anywhere in this module.
 *
 * Two departures from the source, both deliberate:
 *
 *  1. **The code is stored hashed.** The source wrote the six digits into the
 *     admin row in plaintext, so anyone with read access to the database — a
 *     backup, a log, an analytics replica — could log in as any chairman for
 *     the length of the window. It is hashed with the same `lib/password.js`
 *     scrypt the CRM uses, and compared in constant time.
 *
 *  2. **The test bypasses are not ported.** The source hardcoded two phone
 *     numbers to fixed codes (`7575007347` → `000000`, `9712586365` →
 *     `141414`) in the production login path. Those are backdoors into every
 *     society. `SOCIETY_OTP_DEV_CODE` gives the same convenience in
 *     development only and cannot be switched on in production.
 *
 * Delivery goes through this codebase's existing `services/messaging.js`
 * adapter, which records a `MessageLog` and uses the mock driver until real
 * SMS credentials are configured — the same path every other message takes.
 */

/** Cryptographically uniform, unlike `Math.random()`; no modulo bias. */
function generate(digits = 6) {
  const max = 10 ** digits;
  return String(crypto.randomInt(0, max)).padStart(digits, '0');
}

/** Development-only fixed code, so a local login does not need a real SMS. */
function devCode() {
  if (config.env === 'production') return null;
  return process.env.SOCIETY_OTP_DEV_CODE || null;
}

/** Returns the plaintext code to send, and the fields to persist. */
async function issue({ digits = 6 } = {}) {
  const code = devCode() || generate(digits);
  return {
    code,
    fields: { otp: await password.hash(code), otpDatetime: new Date() },
  };
}

/** Same shape for `SocietyUser`, whose columns are named differently. */
async function issueForUser({ digits = 6 } = {}) {
  const code = devCode() || generate(digits);
  const expiresAt = new Date(Date.now() + config.society.otpTtlMinutes * 60 * 1000);
  return {
    code,
    fields: { otp: await password.hash(code), otpExpiresAt: expiresAt },
  };
}

/** Within the configured window? The source called this `isOtpValid`. */
function withinWindow(issuedAt) {
  if (!issuedAt) return false;
  const ageMs = Date.now() - new Date(issuedAt).getTime();
  return ageMs >= 0 && ageMs <= config.society.otpTtlMinutes * 60 * 1000;
}

/** Constant-time check of a submitted code against the stored hash. */
const verify = (submitted, storedHash) => password.verify(String(submitted || ''), storedHash);

async function send({ countryCode, phoneNumber, code }) {
  return messaging.send({
    channel: 'SMS',
    to: `${countryCode || '+91'}${phoneNumber}`,
    body: `${code} is your verification code.`,
  });
}

module.exports = {
  generate, issue, issueForUser, withinWindow, verify, send, devCode,
};
