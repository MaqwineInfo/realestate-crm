const sla = require('../services/sla');
const followups = require('../services/followups');
const blocks = require('../services/blocks');
const bookings = require('../services/bookings');
const opportunities = require('../services/opportunities');
const campaigns = require('../services/campaigns');
const nurture = require('../services/nurture');
const temperature = require('../services/temperature');
const postBooking = require('../services/postBooking');
const collections = require('../services/collections');
const collectionFollowups = require('../services/collectionFollowups');
const paymentReminders = require('../services/paymentReminders');
const payments = require('../services/payments');

/**
 * Spec §107: the timed automation. One tick per minute, each job independent,
 * idempotent and safe to retry — a crashed run simply happens again next
 * minute (§106).
 *
 * ponytail: in-process interval, no queue infrastructure. If this ever runs on
 * more than one node, add a claim document per job name so only one instance
 * runs a tick.
 */
const JOBS = [
  { name: 'sla', run: () => sla.tick() },
  { name: 'followups.missed', run: () => followups.markMissed() },
  { name: 'blocks.expiry', run: () => blocks.expirySweep() },
  { name: 'bookings.resume', run: () => bookings.resumeIncomplete() },
  { name: 'opportunities.reminders', run: () => opportunities.reminderSweep() },
  { name: 'campaigns.scheduled', run: () => campaigns.sendDueScheduled() },
  { name: 'nurture', run: () => nurture.tick() },
  // V1.1 §14.7: inactivity decay. Nothing happens to a neglected lead to fire an
  // event, so the cooling has to be swept for.
  { name: 'temperature.decay', run: () => temperature.sweep() },

  /**
   * V2 §188. Post-booking and collections all turn on the passage of time:
   * nothing happens on the day a payment falls due to fire an event, so each of
   * these is a sweep. All idempotent (§188), all independently retryable.
   */
  { name: 'booking.post_initialize', run: () => postBooking.retrySweep() },
  { name: 'collection.overdue_refresh', run: () => collections.overdueRefresh() },
  { name: 'collection.followups_missed', run: () => collectionFollowups.markMissed() },
  { name: 'collection.promise_missed', run: () => collectionFollowups.promiseSweep() },
  { name: 'booking.payment_reminders', run: () => paymentReminders.sweep() },
  { name: 'payments.expire_links', run: () => payments.expireSweep() },

  /**
   * V2 §53/§188 — channel partner. RERA lapses with the calendar and collection
   * thresholds are crossed by receipts, so both need a sweep behind the events.
   */
  { name: 'cp.rera_expiry', run: () => require('../services/rera').expirySweep() },
  { name: 'cp.commission_eligibility', run: () => require('../services/commissions').eligibilitySweep() },
];

const TICK_MS = Number(process.env.SCHEDULER_TICK_MS || 60000);

let timer = null;
let running = false;
const lastRun = new Map();

async function runOnce({ only = null } = {}) {
  if (running) return { skipped: true };
  running = true;
  const results = {};
  try {
    for (const job of JOBS) {
      if (only && job.name !== only) continue;
      const startedAt = Date.now();
      try {
        results[job.name] = await job.run();
        lastRun.set(job.name, { at: new Date(), ms: Date.now() - startedAt, ok: true });
      } catch (err) {
        results[job.name] = { error: err.message };
        lastRun.set(job.name, { at: new Date(), ms: Date.now() - startedAt, ok: false, error: err.message });
        console.error(JSON.stringify({ level: 'error', scope: 'scheduler', job: job.name, message: err.message }));
      }
    }
  } finally {
    running = false;
  }
  return results;
}

function start() {
  if (timer) return timer;
  timer = setInterval(() => { runOnce(); }, TICK_MS);
  timer.unref();
  return timer;
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

const health = () => Object.fromEntries(lastRun);

module.exports = { start, stop, runOnce, health, JOBS };
