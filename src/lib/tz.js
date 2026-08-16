/**
 * Spec §72: timestamps are stored in UTC and every "today" boundary is resolved
 * in the tenant's business timezone. All dashboards and reports call the helpers
 * here so two screens can never disagree about what "today" means.
 *
 * ponytail: Intl-based, no date library.
 */

/** Offset of `tz` from UTC at the given instant, in ms. */
function offsetMs(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = Number(p.value);
    return acc;
  }, {});
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Calendar date in `tz` as {year, month, day}. */
function localParts(date, tz) {
  const [month, day, year] = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date).split('/').map(Number);
  return { year, month, day };
}

/** UTC instant of local midnight for a calendar date in `tz`. */
function localMidnight(year, month, day, tz) {
  const naive = Date.UTC(year, month - 1, day);
  // First guess assumes the current offset; re-derive once so a day that starts
  // on a DST transition still resolves to the real local midnight.
  let guess = new Date(naive - offsetMs(new Date(naive), tz));
  guess = new Date(naive - offsetMs(guess, tz));
  return guess;
}

/** UTC instant of local midnight starting the day that contains `date` in `tz`. */
function startOfDay(date = new Date(), tz = 'UTC') {
  const { year, month, day } = localParts(date, tz);
  return localMidnight(year, month, day, tz);
}

/**
 * Local-calendar day arithmetic. Adding 24h of milliseconds is wrong on a DST
 * boundary, where a local day is 23 or 25 hours long.
 */
function addLocalDays(date, days, tz = 'UTC') {
  const { year, month, day } = localParts(date, tz);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return localMidnight(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate(), tz);
}

const endOfDay = (date = new Date(), tz = 'UTC') => new Date(addLocalDays(date, 1, tz).getTime() - 1);

const addDays = (date, days) => new Date(date.getTime() + days * 86400000);
const addMinutes = (date, minutes) => new Date(date.getTime() + minutes * 60000);

/** Inclusive-exclusive range for "today" in the tenant timezone: { start, end }. */
function todayRange(tz = 'UTC', now = new Date()) {
  return { start: startOfDay(now, tz), end: addLocalDays(now, 1, tz) };
}

/** Range covering N calendar days back through the end of today. */
function lastNDaysRange(days, tz = 'UTC', now = new Date()) {
  return { start: addLocalDays(now, -(days - 1), tz), end: addLocalDays(now, 1, tz) };
}

/** Combine a "YYYY-MM-DD" + "HH:mm" form input in tenant tz into a UTC Date. */
function fromLocalInput(dateStr, timeStr, tz = 'UTC') {
  if (!dateStr) return null;
  const [year, month, day] = String(dateStr).split('-').map(Number);
  const [hour = 0, minute = 0] = String(timeStr || '00:00').split(':').map(Number);
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  let guess = new Date(naive - offsetMs(new Date(naive), tz));
  guess = new Date(naive - offsetMs(guess, tz));
  return guess;
}

/** Display helpers used by views. */
function formatDateTime(date, tz = 'UTC', locale = 'en-IN') {
  if (!date) return '';
  return new Intl.DateTimeFormat(locale, {
    timeZone: tz, day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  }).format(new Date(date));
}

function formatDate(date, tz = 'UTC', locale = 'en-IN') {
  if (!date) return '';
  return new Intl.DateTimeFormat(locale, {
    timeZone: tz, day: '2-digit', month: 'short', year: 'numeric',
  }).format(new Date(date));
}

function formatTime(date, tz = 'UTC', locale = 'en-IN') {
  if (!date) return '';
  return new Intl.DateTimeFormat(locale, {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: true,
  }).format(new Date(date));
}

/** "in 2h", "3d ago" — used on work rows for lead age / due time (§8.3). */
function relative(date, now = new Date()) {
  if (!date) return '';
  const diffMs = new Date(date).getTime() - now.getTime();
  const abs = Math.abs(diffMs);
  const units = [
    ['day', 86400000], ['hour', 3600000], ['minute', 60000],
  ];
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, ms] of units) {
    if (abs >= ms) return rtf.format(Math.round(diffMs / ms), unit);
  }
  return 'just now';
}

/** Values for <input type="date"> / <input type="time"> in tenant tz. */
function toDateInput(date, tz = 'UTC') {
  if (!date) return '';
  const { year, month, day } = localParts(new Date(date), tz);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function toTimeInput(date, tz = 'UTC') {
  if (!date) return '';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(date));
  return parts;
}

module.exports = {
  offsetMs, localParts, localMidnight, startOfDay, endOfDay, addDays, addLocalDays,
  addMinutes, todayRange, lastNDaysRange, fromLocalInput, formatDateTime, formatDate,
  formatTime, relative, toDateInput, toTimeInput,
};
