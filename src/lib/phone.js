/**
 * Spec §9.2 / §52.1: the normalized mobile number is THE duplicate identifier.
 * Every contact lookup, webhook capture and QR submission normalizes first.
 *
 * ponytail: digit-level E.164 normalization, no libphonenumber. It handles the
 * real inputs (local 10-digit, 0-prefixed, 91-prefixed, +91, spaces/dashes).
 * Swap in libphonenumber-js if genuinely multi-country validation is needed.
 */
const DEFAULT_CALLING_CODE = '91';

/**
 * The calling codes offered in the UI, with the national-number lengths each
 * one actually uses. The length rule is the point: without it a 9- or 11-digit
 * Indian number normalized cleanly and created a contact that could never be
 * matched again — and the mobile number is the duplicate key (§9.2).
 *
 * ponytail: a short table, not libphonenumber. Add a row when a market is sold
 * into; swap in libphonenumber-js only if per-region carrier rules ever matter.
 */
const COUNTRY_CODES = [
  { code: '91', label: 'India', iso: 'IN', lengths: [10] },
  { code: '971', label: 'UAE', iso: 'AE', lengths: [9] },
  { code: '966', label: 'Saudi Arabia', iso: 'SA', lengths: [9] },
  { code: '968', label: 'Oman', iso: 'OM', lengths: [8] },
  { code: '974', label: 'Qatar', iso: 'QA', lengths: [8] },
  { code: '965', label: 'Kuwait', iso: 'KW', lengths: [8] },
  { code: '973', label: 'Bahrain', iso: 'BH', lengths: [8] },
  { code: '44', label: 'United Kingdom', iso: 'GB', lengths: [10] },
  { code: '1', label: 'USA / Canada', iso: 'US', lengths: [10] },
  { code: '61', label: 'Australia', iso: 'AU', lengths: [9] },
  { code: '65', label: 'Singapore', iso: 'SG', lengths: [8] },
  { code: '60', label: 'Malaysia', iso: 'MY', lengths: [9, 10] },
  { code: '254', label: 'Kenya', iso: 'KE', lengths: [9] },
  { code: '27', label: 'South Africa', iso: 'ZA', lengths: [9] },
];

const CODE_MAP = new Map(COUNTRY_CODES.map((c) => [c.code, c]));

/** The national-number lengths valid for a calling code, or null if unknown. */
const lengthsFor = (callingCode) => CODE_MAP.get(String(callingCode || ''))?.lengths || null;

/** @returns {string|null} E.164 like "+919876543210", or null if unusable. */
function normalizeMobile(raw, callingCode = DEFAULT_CALLING_CODE) {
  if (!raw) return null;
  let digits = String(raw).replace(/[^\d+]/g, '');
  const hadPlus = digits.startsWith('+');
  digits = digits.replace(/\+/g, '');
  if (!digits) return null;

  if (!hadPlus) {
    // Strip a national trunk prefix ("0" in IN/most of APAC) before assuming country.
    digits = digits.replace(/^0+/, '');
    const known = lengthsFor(callingCode);
    /**
     * Without a "+", this is a number typed the way it is dialled locally, so it
     * must be a valid national number for the tenant's own country — unless it
     * already carries that country's code (someone typed 919876543210).
     * Previously anything over 10 digits was assumed to be international, so an
     * 11-digit typo saved happily and became an unmatchable duplicate key.
     */
    if (known && known.includes(digits.length)) {
      digits = callingCode + digits;
    } else if (!(known && digits.startsWith(String(callingCode)))) {
      if (known) return null;
      if (digits.length <= 10) digits = callingCode + digits;
    }
  }
  if (digits.length < 8 || digits.length > 15) return null;

  /**
   * Length check against the country actually dialled — taken from the number's
   * own prefix, not the caller's default, so a pasted +971… is judged as a UAE
   * number even when the tenant is Indian. Unknown codes keep the loose 8–15
   * rule rather than rejecting a market we simply have no row for.
   */
  const match = COUNTRY_CODES
    .filter((c) => digits.startsWith(c.code))
    .sort((a, b) => b.code.length - a.code.length)[0];
  if (match && !match.lengths.includes(digits.length - match.code.length)) return null;

  return `+${digits}`;
}

const isValidMobile = (raw, cc) => normalizeMobile(raw, cc) !== null;

/** Display without the country code when it matches the tenant's own. */
function formatMobile(e164, callingCode = DEFAULT_CALLING_CODE) {
  if (!e164) return '';
  const d = e164.replace('+', '');
  return d.startsWith(callingCode) ? d.slice(callingCode.length) : e164;
}

const normalizeEmail = (raw) => (raw ? String(raw).trim().toLowerCase() : null);
const isValidEmail = (raw) => !!raw && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(raw).trim());

/** Split an E.164 number into its calling code and national part, for form fields. */
function splitMobile(e164, fallbackCode = DEFAULT_CALLING_CODE) {
  const digits = String(e164 || '').replace(/[^\d]/g, '');
  if (!digits) return { callingCode: String(fallbackCode), national: '' };
  const match = COUNTRY_CODES
    .filter((c) => digits.startsWith(c.code))
    .sort((a, b) => b.code.length - a.code.length)[0];
  return match
    ? { callingCode: match.code, national: digits.slice(match.code.length) }
    : { callingCode: String(fallbackCode), national: digits };
}

module.exports = {
  DEFAULT_CALLING_CODE,
  COUNTRY_CODES,
  lengthsFor,
  splitMobile,
  normalizeMobile,
  isValidMobile,
  formatMobile,
  normalizeEmail,
  isValidEmail,
};
