'use strict';

/*
 * THE TWO BOUNDS EVERY CHECKOUT DOOR SHARES, as numbers and as rules: the minimum length of an idempotency key
 * that is present, and the most units one cart line may ask for. This is the ONE place either number is written.
 *
 * WHY .cjs INSIDE AN ESM PACKAGE (the same reason as ucpSpecVersion.cjs). The protocol doors are ESM and reach
 * these through buyerIntake.js, which re-exports them and turns a refusal described here into the kernel error
 * every door throws. The gateway's own invoke route is CommonJS, answers before anything asynchronous happens, and
 * runs under a test runner that cannot load an ESM module at all: it `require`s this file directly. One file both
 * can load is what keeps the rule from being written twice.
 *
 * Nothing here throws, reads a request beyond the fields named, or imports anything. A REFUSAL is a plain
 * description: `{ code, reason, message, detail, retriable }`. `code` is the kernel error code the refusal is
 * raised under; `detail` names the bound and nothing from the request.
 */

// ---- the idempotency key -----------------------------------------------------------------------------------------
//
// At least IDEMPOTENCY_KEY_MIN_LENGTH characters, counted in Unicode code points (as JSON Schema `minLength` counts
// them) after surrounding whitespace is removed (as the kernel's ledger and the doors that carry the key in a header
// or in `meta` already remove it before using the key). An ABSENT key is not this rule's: whichever rule requires
// one stays where it was, with the answer it had.
//
// INVISIBLE CHARACTERS ARE NOT COUNTED EITHER. A key of eight zero-width spaces is eight code points and nothing a
// person or a log can tell apart from an empty one. Every character of Unicode general category Cf ("format":
// U+200B zero width space, U+200C and U+200D the zero width joiners, U+2060 word joiner, U+FEFF, U+00AD soft
// hyphen, the bidirectional marks and isolates, the tag characters, ...) is left out of the COUNT, wherever it sits
// in the key. Only the count: the key itself is never changed, and is stored and forwarded exactly as each door
// always did.
const IDEMPOTENCY_KEY_MIN_LENGTH = 8;
const IDEMPOTENCY_KEY_TOO_SHORT_REASON = 'idempotency_key_too_short';
const INVISIBLE_FORMAT_CHARACTERS = /\p{Cf}/gu;

const isPresentKey = (key) => typeof key === 'string' && key.trim() !== '';

// WHICH CHARACTERS A KEY MAY BE MADE OF: printable ASCII, U+0020 (space) to U+007E, and nothing else.
//
// WHY. The kernel sends a caller's key on to the backend inside an HTTP header as well as in the body. A header
// value cannot carry a character above U+00FF at all (the request is never sent, and the caller used to get a
// retriable "merchant unavailable" for a key that could never work), nor a control character. The characters from
// U+0080 to U+00FF are legal in a header but are not text there: intermediaries re-encode or drop them, so the key
// the backend deduplicates on could differ from the key in the body. Refusing all of them leaves one alphabet that
// arrives everywhere exactly as sent, and it is the alphabet every generated key (a UUID, a hash, a counter) uses.
// Spaces are accepted anywhere; those around the key are not counted toward its length (below), and the key is
// never altered.
const IDEMPOTENCY_KEY_BAD_CHARACTERS_REASON = 'idempotency_key_bad_characters';
const KEY_CHARACTERS_ACCEPTED = /^[\x20-\x7E]*$/;

/** How many characters of a key count toward the minimum. */
const countedKeyLength = (key) => [...key.replace(INVISIBLE_FORMAT_CHARACTERS, '').trim()].length;

/**
 * The refusal for a PRESENT key that cannot be used, else null (absent, or acceptable). The characters are judged
 * first, on the key exactly as sent: a key with a character outside the accepted set is refused for that whatever
 * its length. So an invisible character never reaches the count through a door; the count still leaves them out,
 * for any caller of the length rule that judges characters some other way.
 */
function idempotencyKeyRefusal(key) {
  if (!isPresentKey(key)) return null;
  if (!KEY_CHARACTERS_ACCEPTED.test(key)) {
    return {
      // The code a missing key gets.
      code: 'IDEMPOTENCY_CONFLICT',
      reason: IDEMPOTENCY_KEY_BAD_CHARACTERS_REASON,
      message: [
        'The idempotency key contains a character that is not accepted: a key may be made of printable ASCII',
        'characters only (letters, digits, punctuation and spaces, U+0020 to U+007E). Generate a new unique key',
        'from those characters (a UUID works) and send the request again with it. Retrying with this key will not',
        'change the answer.',
      ].join(' '),
      detail: { accepted_characters: 'printable ASCII, U+0020 to U+007E' },
      retriable: false,
    };
  }
  if (countedKeyLength(key) >= IDEMPOTENCY_KEY_MIN_LENGTH) return null;
  return {
    // The code a missing key gets.
    code: 'IDEMPOTENCY_CONFLICT',
    reason: IDEMPOTENCY_KEY_TOO_SHORT_REASON,
    message: [
      `The idempotency key is too short: it must be at least ${IDEMPOTENCY_KEY_MIN_LENGTH} characters, not counting leading or trailing`,
      'whitespace or invisible formatting characters. Generate a new unique key of that length or longer (a UUID',
      'works) and send the request again with it. Retrying with this key will not change the answer.',
    ].join(' '),
    detail: { min_length: IDEMPOTENCY_KEY_MIN_LENGTH },
    retriable: false,
  };
}

// ---- the quantity of one line --------------------------------------------------------------------------------------
//
// At most MAX_LINE_QUANTITY units. Per line only: a cart's own bounds (lines, distinct products) are the cart
// rule's, and a purchase lane with a lower limit of its own keeps it.
const MAX_LINE_QUANTITY = 999;
const QUANTITY_ABOVE_LINE_MAXIMUM_REASON = 'quantity_above_line_maximum';

/** A number above the ceiling, whatever else is wrong with it. Anything that is not a number is not this rule's. */
const isLineQuantityAboveMaximum = (quantity) => typeof quantity === 'number' && quantity > MAX_LINE_QUANTITY;

/** The one definition of a line quantity a door may act on: a whole number from 1 to MAX_LINE_QUANTITY. */
const isAcceptableLineQuantity = (quantity) => Number.isSafeInteger(quantity) && quantity >= 1
  && quantity <= MAX_LINE_QUANTITY;

/** The refusal for a line above the ceiling. Never the quantity itself. */
function lineQuantityRefusal() {
  return {
    // The code every other bad quantity gets.
    code: 'QUOTE_REQUIRED',
    reason: QUANTITY_ABOVE_LINE_MAXIMUM_REASON,
    message: [
      `A line's quantity is above the maximum: at most ${MAX_LINE_QUANTITY} units per line are accepted.`,
      `Send a whole number from 1 to ${MAX_LINE_QUANTITY} as each line's quantity. Retrying as sent will not change the answer.`,
    ].join(' '),
    detail: { max_quantity: MAX_LINE_QUANTITY },
    retriable: false,
  };
}

// ---- the invoke door: where its operations carry a key and cart lines ----------------------------------------------

// The invoke operations a caller may send an idempotency key with. A key that is PRESENT has the minimum on each of
// them; whether one is REQUIRED is each route's own rule and is unchanged.
const INVOKE_KEYED_OPERATIONS = Object.freeze(['confirm_payment', 'create_order', 'preview_quote', 'request_after_sales', 'submit_payment']);

// Where an invoke operation carries cart lines that are handed on to be priced. `create_order` carries lines only on
// the route that does not run the strict contract (it re-quotes them); under the strict contract an order is priced
// from its locked quote and any lines beside it are never read.
const INVOKE_CART_LINES = Object.freeze({
  preview_quote: (payload) => (payload && payload.quote ? payload.quote.items : undefined),
  create_order: (payload) => (payload && payload.order ? payload.order.items : undefined),
});

/** Every invoke operation either bound can refuse. */
const INVOKE_BOUNDED_OPERATIONS = Object.freeze(
  [...new Set([...INVOKE_KEYED_OPERATIONS, ...Object.keys(INVOKE_CART_LINES)])].sort(),
);

/**
 * The refusal for an invoke operation with a cart line above the ceiling, else null.
 *
 * `asThatRouteReadsIt`: the route that does not run the strict contract does not refuse a quantity that is not a
 * number, it converts it (`Number(quantity)`) and prices the result, so "1000" is a thousand units there. For that
 * route the ceiling is judged on the converted value, the quantity it would actually price. The strict contract
 * converts nothing (it refuses a non-number itself), so there the ceiling is judged on the value as sent.
 */
function invokeLineQuantityRefusal(operation, payload, { asThatRouteReadsIt = false } = {}) {
  const linesOf = Object.prototype.hasOwnProperty.call(INVOKE_CART_LINES, operation) ? INVOKE_CART_LINES[operation] : null;
  const items = linesOf ? linesOf(payload) : undefined;
  if (!Array.isArray(items)) return null;
  const sent = (it) => (it === null || it === undefined ? undefined : it.quantity);
  const quantityOf = (it) => (asThatRouteReadsIt && sent(it) != null ? Number(sent(it)) : sent(it));
  return items.some((it) => isLineQuantityAboveMaximum(quantityOf(it))) ? lineQuantityRefusal() : null;
}

/** The refusal for a present, short idempotency key on an invoke operation that takes one, else null. */
function invokeKeyRefusal(operation, payload) {
  if (!INVOKE_KEYED_OPERATIONS.includes(operation)) return null;
  return idempotencyKeyRefusal(payload === null || payload === undefined ? undefined : payload.idempotency_key);
}

/**
 * Both bounds and nothing else, for the invoke route that does not run the strict contract (and its alias): the
 * key first, then the lines as that route reads them. Null for everything else, which that route judges as it
 * always did.
 */
function invokeIntakeBoundsRefusal(operation, payload) {
  return invokeKeyRefusal(operation, payload) || invokeLineQuantityRefusal(operation, payload, { asThatRouteReadsIt: true });
}

// The one sentence a tool schema adds to a key's description: `minLength` alone cannot say how the runtime counts.
const IDEMPOTENCY_KEY_LENGTH_SENTENCE = `At least ${IDEMPOTENCY_KEY_MIN_LENGTH} characters, printable ASCII only (U+0020 to U+007E); leading and trailing spaces are not counted.`;

module.exports = {
  IDEMPOTENCY_KEY_MIN_LENGTH,
  IDEMPOTENCY_KEY_TOO_SHORT_REASON,
  IDEMPOTENCY_KEY_BAD_CHARACTERS_REASON,
  IDEMPOTENCY_KEY_LENGTH_SENTENCE,
  MAX_LINE_QUANTITY,
  QUANTITY_ABOVE_LINE_MAXIMUM_REASON,
  idempotencyKeyRefusal,
  countedKeyLength,
  isAcceptableLineQuantity,
  isLineQuantityAboveMaximum,
  lineQuantityRefusal,
  INVOKE_KEYED_OPERATIONS,
  INVOKE_BOUNDED_OPERATIONS,
  invokeKeyRefusal,
  invokeLineQuantityRefusal,
  invokeIntakeBoundsRefusal,
};
