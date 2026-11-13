'use strict';

// What the two shared checkout bounds changed in the text tools/list publishes, as [now, before] pairs:
//   - the per-line quantity ceiling added ONE member to a cart line's `quantity` (native `quote.items[].quantity`,
//     UCP `checkout.line_items[].quantity`): `maximum`;
//   - each of the two idempotency key descriptions (native `idempotency_key`, UCP `meta["idempotency-key"]`) gained
//     ONE sentence: how the minimum is counted.
//   - each of the two cart line-item lists (native `quote.items`, UCP `checkout.line_items`) says, in ONE sentence,
//     that a product and variant goes on one line: the native list gained a `description` holding it, the UCP
//     list's description gained it as a second sentence.
// A golden test that pins a tools/list body captured before them reverses exactly these and compares the rest byte
// for byte, so any OTHER change still fails it.
const LINE_QUANTITY_MAXIMUM_EDIT = Object.freeze([
  '"quantity":{"type":"integer","minimum":1,"maximum":999}',
  '"quantity":{"type":"integer","minimum":1}',
]);
const KEY_LENGTH_SENTENCE = ' At least 8 characters, printable ASCII only (U+0020 to U+007E); leading and trailing spaces are not counted.';
const IDEMPOTENCY_KEY_DESCRIPTION_EDITS = Object.freeze([
  Object.freeze([
    `Client-generated unique key; a replay returns the original result, never a duplicate.${KEY_LENGTH_SENTENCE}"`,
    'Client-generated unique key; a replay returns the original result, never a duplicate."',
  ]),
  Object.freeze([
    `make every retry a new request, which is the opposite of what the key is for.${KEY_LENGTH_SENTENCE}"`,
    'make every retry a new request, which is the opposite of what the key is for."',
  ]),
]);

const DUPLICATE_LINES_SENTENCE = 'Name each product and variant on ONE line: a cart that lists the same product and variant on more than one line is refused; merge those lines into one.';
const DUPLICATE_LINES_DESCRIPTION_EDITS = Object.freeze([
  Object.freeze([
    `"items":{"type":"array","minItems":1,"maxItems":50,"description":"${DUPLICATE_LINES_SENTENCE}","items":{`,
    '"items":{"type":"array","minItems":1,"maxItems":50,"items":{',
  ]),
  Object.freeze([
    `The lines to price; the id is NESTED under \`item\`, per the UCP wire shape. ${DUPLICATE_LINES_SENTENCE}"`,
    'The lines to price; the id is NESTED under `item`, per the UCP wire shape."',
  ]),
]);

const reverse = (text, [now, before]) => String(text).split(now).join(before);

/** The text with the ceiling's schema edit reversed (each occurrence). */
function revertLineQuantityMaximumEdit(text) {
  return reverse(text, LINE_QUANTITY_MAXIMUM_EDIT);
}

/** The text with the sentence taken back out of both key descriptions (each occurrence). */
function revertIdempotencyKeyDescriptionEdits(text) {
  return IDEMPOTENCY_KEY_DESCRIPTION_EDITS.reduce(reverse, String(text));
}

/** The text with the one-line-per-product-and-variant sentence taken back out of both line-item lists (each occurrence). */
function revertDuplicateLinesDescriptionEdits(text) {
  return DUPLICATE_LINES_DESCRIPTION_EDITS.reduce(reverse, String(text));
}

module.exports = {
  LINE_QUANTITY_MAXIMUM_EDIT, IDEMPOTENCY_KEY_DESCRIPTION_EDITS, KEY_LENGTH_SENTENCE,
  DUPLICATE_LINES_DESCRIPTION_EDITS, DUPLICATE_LINES_SENTENCE,
  revertLineQuantityMaximumEdit, revertIdempotencyKeyDescriptionEdits, revertDuplicateLinesDescriptionEdits,
};
