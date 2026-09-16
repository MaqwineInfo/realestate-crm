const { DRIVERS } = require('../messaging');

/**
 * Outbound messages for the society module: SMS, email and push.
 *
 * Societies are platform-level (D3), so they have no `tenantId` — and
 * `services/messaging.js` writes a tenant-scoped `MessageLog` on every send.
 * Rather than inventing a fake tenant to satisfy that, this reuses the same
 * `DRIVERS` table and skips the log. Configuring a real SMS provider therefore
 * lights up both the CRM and the society module at once, which is the point of
 * sharing the table instead of forking it.
 *
 * Push replaces the source's direct Firebase Admin SDK dependency (§3.7). It is
 * an adapter with a mock default, exactly like WhatsApp/SMS/email already are
 * here, so nothing needs Firebase credentials to run or to be tested. Swapping
 * in the real thing means adding one entry to `PUSH_DRIVERS`.
 *
 * Delivery is best-effort and never throws: a resident's dead FCM token must
 * not fail the complaint they just filed. Callers persist a
 * `SocietyNotification` row regardless, which is what the in-app bell reads.
 */

const PUSH_DRIVERS = {
  /** Records a realistic push without contacting Firebase. */
  async mock({ tokens, title }) {
    return {
      ok: true,
      successCount: tokens.length,
      failureCount: 0,
      note: `simulated push "${title}" to ${tokens.length} device(s)`,
    };
  },
};

const driverName = () => process.env.SOCIETY_PUSH_DRIVER || 'mock';

/** SMS or email through the CRM's own driver table. */
async function send({ channel = 'SMS', to, body, subject }) {
  if (!to) return { ok: false, skipped: 'no recipient' };
  const driver = DRIVERS[process.env.SOCIETY_MESSAGE_DRIVER || 'mock'] || DRIVERS.mock;
  try {
    return await driver({ channel, to, body, subject });
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Push to a set of device tokens. Silently drops empty/duplicate tokens —
 * residents log in on two phones and the same token arrives twice.
 */
async function push({ tokens = [], title, body, data = {} }) {
  const unique = [...new Set(tokens.filter(Boolean))];
  if (!unique.length) return { ok: true, successCount: 0, failureCount: 0, note: 'no devices' };

  const driver = PUSH_DRIVERS[driverName()] || PUSH_DRIVERS.mock;
  try {
    return await driver({ tokens: unique, title, body, data });
  } catch (err) {
    // Never let a push failure surface as a request failure.
    return { ok: false, successCount: 0, failureCount: unique.length, error: err.message };
  }
}

module.exports = { send, push, PUSH_DRIVERS };
