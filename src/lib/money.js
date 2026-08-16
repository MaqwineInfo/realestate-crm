/**
 * Spec §73: money is fixed precision, never binary floating point.
 * Every monetary value in the database is an INTEGER in minor units (paise/cents).
 * Only format() ever produces a decimal, and only for display.
 */
const MINOR = 100;

/** Parse user input ("12,50,000.50", 1250000.5) into integer minor units. */
function toMinor(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Invalid amount');
    return Math.round(value * MINOR);
  }
  const cleaned = String(value).replace(/[,\s₹]/g, '');
  if (!/^-?\d*(\.\d*)?$/.test(cleaned)) throw new Error('Invalid amount');
  const neg = cleaned.startsWith('-');
  const [whole = '0', frac = ''] = cleaned.replace('-', '').split('.');
  const minor = Number(whole || '0') * MINOR + Number((frac + '00').slice(0, 2));
  return neg ? -minor : minor;
}

const toMajor = (minor) => Number(minor || 0) / MINOR;

/** Percentage of an amount, rounded half-up to the nearest minor unit. */
function percentOf(minor, percent) {
  const raw = (Number(minor) * Number(percent)) / 100;
  return Math.round(raw);
}

/** Rate per unit area, e.g. 5500/sqft on 1250 sqft. Rate is in minor units. */
function rateTimes(rateMinor, quantity) {
  return Math.round(Number(rateMinor) * Number(quantity));
}

const sum = (amounts) => amounts.reduce((a, b) => a + Number(b || 0), 0);

/** Indian-grouping aware display. Tenant currency symbol supplied by caller. */
function format(minor, { currency = 'INR', locale = 'en-IN' } = {}) {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(toMajor(minor));
}

/** Short form for dense list rows: ₹1.25 Cr / ₹45.00 L / ₹80,000 */
function formatShort(minor, { currency = 'INR', locale = 'en-IN' } = {}) {
  const major = toMajor(minor);
  const abs = Math.abs(major);
  const sym = new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 0 })
    .formatToParts(0).find((p) => p.type === 'currency')?.value || '';
  if (locale === 'en-IN') {
    if (abs >= 1e7) return `${sym}${(major / 1e7).toFixed(2)} Cr`;
    if (abs >= 1e5) return `${sym}${(major / 1e5).toFixed(2)} L`;
  } else if (abs >= 1e6) {
    return `${sym}${(major / 1e6).toFixed(2)}M`;
  }
  return format(minor, { currency, locale });
}

module.exports = { MINOR, toMinor, toMajor, percentOf, rateTimes, sum, format, formatShort };
