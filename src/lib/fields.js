const { z } = require('zod');
const money = require('./money');

/**
 * Shared form field parsers. Browser forms send strings and empty strings for
 * "not filled in", and users paste values with stray whitespace — normalising
 * that in one place keeps every route's validation consistent (§62).
 */
const blankToUndefined = (v) => {
  if (typeof v === 'string') {
    const trimmed = v.trim();
    return trimmed === '' ? undefined : trimmed;
  }
  return v === null ? undefined : v;
};

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Select a valid option.');
const optionalId = z.preprocess(blankToUndefined, objectId.optional());

const requiredText = (max, message) => z.string().trim().min(1, message).max(max);
const optionalText = (max) => z.preprocess(blankToUndefined, z.string().max(max).optional());

const email = z.preprocess(blankToUndefined, z.string().email('Enter a valid email address.').optional());
const requiredEmail = z.preprocess(blankToUndefined, z.string().email('Enter a valid email address.'));

/** Accepts "45,00,000" or "4500000.50" and stores integer minor units (§73). */
const moneyAmount = z.preprocess((v) => {
  const clean = blankToUndefined(v);
  if (clean === undefined) return undefined;
  try { return money.toMinor(clean); } catch { return NaN; }
}, z.number({ message: 'Enter a valid amount.' }).int('Enter a valid amount.').min(0, 'Amount cannot be negative.').optional());

const optionalNumber = z.preprocess(blankToUndefined, z.coerce.number().optional());

/** Checkboxes arrive as "1"/absent; multi-selects as string or string[]. */
const checkbox = z.preprocess((v) => v === '1' || v === 'true' || v === true, z.boolean());
const stringList = z.preprocess((v) => {
  if (v === undefined || v === null || v === '') return [];
  if (Array.isArray(v)) return v.flatMap((item) => String(item).split(',')).map((s) => s.trim()).filter(Boolean);
  // The UI splits comma lists before submitting; doing it here as well keeps the
  // form working with JavaScript disabled.
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}, z.array(z.string()).optional());

const enumField = (values) => z.preprocess(blankToUndefined, z.enum(values).optional());

module.exports = {
  blankToUndefined, objectId, optionalId, requiredText, optionalText,
  email, requiredEmail, moneyAmount, optionalNumber, checkbox, stringList, enumField,
};
