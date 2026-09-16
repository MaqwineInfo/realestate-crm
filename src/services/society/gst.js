const money = require('../../lib/money');

/**
 * GST, shared by amenity bookings, maintenance and penalties.
 *
 * Ported from the source's `libs/gstCalculator.js`, with one change: it works
 * in integer paise. The source did `Math.round(x * 100) / 100` on floats, which
 * is the classic way to be a paisa out — `(1000.005).toFixed(2)` and friends
 * disagree with themselves depending on the value, and the error compounds
 * across a maintenance run over four hundred units.
 *
 * `INCLUDED` means the price already contains the tax and it has to be
 * extracted; `EXCLUDED` means it is added on top. Both are used in practice:
 * amenities are usually quoted inclusive, maintenance exclusive.
 *
 * Returns integer paise, and `base + gst === total` exactly, always.
 */
function calculate(config = {}, amountMinor = 0) {
  const percentage = Number(config.gstPercentage ?? config.taxValue ?? 0);
  const type = config.gstAmountType || 'EXCLUDED';
  const billType = config.billType || 'TAXABLE';
  const amount = Math.round(Number(amountMinor) || 0);

  if (billType === 'NON_TAXABLE' || !percentage) {
    return {
      baseAmountMinor: amount, gstAmountMinor: 0, totalAmountMinor: amount, gstPercentage: 0,
    };
  }

  if (type === 'INCLUDED') {
    /**
     * base = amount / (1 + rate), in integer arithmetic:
     *   base = round(amount * 100 / (100 + percentage))
     * GST is then the remainder, so the two always sum back to `amount`
     * rather than being rounded independently and drifting apart.
     */
    const base = Math.round((amount * 100) / (100 + percentage));
    return {
      baseAmountMinor: base,
      gstAmountMinor: amount - base,
      totalAmountMinor: amount,
      gstPercentage: percentage,
    };
  }

  const gst = money.percentOf(amount, percentage);
  return {
    baseAmountMinor: amount,
    gstAmountMinor: gst,
    totalAmountMinor: amount + gst,
    gstPercentage: percentage,
  };
}

/** CGST/SGST split for display. Odd paise go to CGST so the halves still sum. */
function split(gstAmountMinor, gstType = 'CGST_SGST') {
  if (gstType === 'IGST') return { igst: gstAmountMinor, cgst: 0, sgst: 0 };
  const sgst = Math.floor(gstAmountMinor / 2);
  return { igst: 0, cgst: gstAmountMinor - sgst, sgst };
}

module.exports = { calculate, split };
