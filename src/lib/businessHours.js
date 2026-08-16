const tz = require('./tz');

/**
 * Spec §16.1 / §72: the SLA clock runs either 24x7 or only inside business
 * hours, and the tenant chooses. A lead that arrives at 10pm should not breach
 * overnight when the team does not work nights.
 */

const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

/** Day of week (0=Sun) for an instant in a timezone. */
function weekday(date, zone) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short' }).format(date);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
}

/**
 * Working seconds between two instants.
 * `hours` is { start: 'HH:mm', end: 'HH:mm', days: [1..6] } in tenant time.
 */
function elapsedSeconds(from, to, zone = 'UTC', hours = null) {
  const start = new Date(from);
  const end = new Date(to);
  if (end <= start) return 0;
  if (!hours) return Math.round((end - start) / 1000);

  const openMin = toMinutes(hours.start);
  const closeMin = toMinutes(hours.end);
  const days = hours.days && hours.days.length ? hours.days : [1, 2, 3, 4, 5];
  if (closeMin <= openMin) return Math.round((end - start) / 1000); // misconfigured: fall back to 24x7

  let total = 0;
  let cursor = tz.startOfDay(start, zone);
  // Cap the walk so a stale record can never spin the scheduler.
  for (let i = 0; i < 400 && cursor < end; i += 1) {
    const dayStart = cursor;
    if (days.includes(weekday(dayStart, zone))) {
      const open = new Date(dayStart.getTime() + openMin * 60000);
      const close = new Date(dayStart.getTime() + closeMin * 60000);
      const windowStart = start > open ? start : open;
      const windowEnd = end < close ? end : close;
      if (windowEnd > windowStart) total += (windowEnd - windowStart) / 1000;
    }
    cursor = tz.addLocalDays(dayStart, 1, zone);
  }
  return Math.round(total);
}

/** True when `at` falls inside the configured working window. */
function isWithinBusinessHours(at, zone = 'UTC', hours = null) {
  if (!hours) return true;
  const days = hours.days && hours.days.length ? hours.days : [1, 2, 3, 4, 5];
  if (!days.includes(weekday(at, zone))) return false;
  const dayStart = tz.startOfDay(at, zone);
  const minutes = (new Date(at) - dayStart) / 60000;
  return minutes >= toMinutes(hours.start) && minutes < toMinutes(hours.end);
}

module.exports = { elapsedSeconds, isWithinBusinessHours, weekday, toMinutes };
