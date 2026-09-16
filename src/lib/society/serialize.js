const money = require('../money');

/**
 * Paise in, the source's decimal strings out.
 *
 * SOCIETY-PLAN.md §3.9: money is stored as integer minor units everywhere in
 * this codebase, because rounding a percentage late fee across four hundred
 * units in floating point drifts. The society services stored the same amounts
 * as decimal `String`s and floats, and the mobile app parses them that way
 * (D2), so the two representations meet exactly here — at the wire boundary,
 * once, instead of in every controller.
 *
 * Each model declares its own `MONEY_FIELDS`, so adding a money column means
 * adding it in one place rather than remembering every serializer that touches
 * the model.
 */

/**
 * The source stored these as JS Numbers and decimal Strings, so it emitted
 * "1500" and "1500.5" — not "1500.00". `toFixed(2)` would change the bytes on
 * the wire for every amount in the product, so the minimal decimal form is what
 * goes out.
 */
const toDecimalString = (minor) => String(money.toMajor(minor));

/**
 * Renames `xMinor` -> `x` and formats it the way the source emitted it.
 * A null amount stays null rather than becoming "0.00" — the app renders those
 * differently, and "not set" is not "free".
 */
/**
 * Resolves the objects a dotted money path actually lands on.
 *
 * A path may pass through an array of subdocuments — `featurePricing.amountMinor`
 * is one amount per feature, not one amount. Returning the list of holders lets
 * the caller convert each in place, instead of the traversal quietly giving up
 * at the array and shipping paise to the client, which is what it used to do.
 */
function holdersOf(root, keys) {
  let nodes = [root];
  for (const key of keys) {
    const next = [];
    for (const node of nodes) {
      if (node == null || typeof node !== 'object') continue;
      const child = node[key];
      if (Array.isArray(child)) next.push(...child.filter((x) => x && typeof x === 'object'));
      else if (child && typeof child === 'object') next.push(child);
    }
    nodes = next;
  }
  return nodes;
}

function toWire(doc, moneyFields = []) {
  if (!doc) return doc;
  if (Array.isArray(doc)) return doc.map((d) => toWire(d, moneyFields));
  const out = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };

  for (const field of moneyFields) {
    const keys = field.split('.');
    const leaf = keys.pop();
    const plain = leaf.replace(/Minor$/, '');

    for (const holder of holdersOf(out, keys)) {
      const value = holder[leaf];
      holder[plain] = value === null || value === undefined ? null : toDecimalString(value);
      if (plain !== leaf) delete holder[leaf];
    }
  }
  return out;
}

/** The inverse, for request bodies: `"1500.50"` -> `150050`. */
function fromWire(body, moneyFields = []) {
  if (!body) return body;
  const out = { ...body };

  for (const field of moneyFields) {
    const keys = field.split('.');
    const leaf = keys.pop();
    const plain = leaf.replace(/Minor$/, '');

    for (const holder of holdersOf(out, keys)) {
      const value = holder[plain];
      if (value === undefined) continue;
      holder[leaf] = value === null || value === '' ? null : money.toMinor(value);
      if (plain !== leaf) delete holder[plain];
    }
  }
  return out;
}

/** Convenience: serialize using a model's own declared money fields. */
const forModel = (Model, doc) => toWire(doc, Model.MONEY_FIELDS || []);

module.exports = { toWire, fromWire, forModel };
