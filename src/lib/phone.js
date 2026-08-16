/**
 * Spec §9.2 / §52.1: the normalized mobile number is THE duplicate identifier.
 * Every contact lookup, webhook capture and QR submission normalizes first.
 *
 * ponytail: digit-level E.164 normalization, no libphonenumber. It handles the
 * real inputs (local 10-digit, 0-prefixed, 91-prefixed, +91, spaces/dashes).
 * Swap in libphonenumber-js if genuinely multi-country validation is needed.
 */
const DEFAULT_CALLING_CODE = '91';

/** @returns {string|null} E.164 like "+919876543210", or null if unusable. */
function normalizeMobile(raw, callingCode = DEFAULT_CALLING_CODE) {
  if (!raw) return null;
  let digits = String(raw).replace(/[^\d+]/g, '');
  const hadPlus = digits.startsWith('+');
  digits = digits.replace(/\+/g, '');
  if (!digits) return null;

  if (!hadPlus) {
    // Strip a national trunk prefix ("0" in IN/most of APAC) before assuming country.
    if (digits.length > 10 && digits.startsWith('0')) digits = digits.replace(/^0+/, '');
    if (digits.length <= 10) digits = callingCode + digits.replace(/^0+/, '');
  }
  if (digits.length < 8 || digits.length > 15) return null;
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

module.exports = {
  DEFAULT_CALLING_CODE,
  normalizeMobile,
  isValidMobile,
  formatMobile,
  normalizeEmail,
  isValidEmail,
};
