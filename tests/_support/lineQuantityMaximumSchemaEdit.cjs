'use strict';

// What the two shared checkout bounds changed in the text tools/list publishes, as [now, before] pairs:
//   - the per-line quantity ceiling added ONE member to a cart line's `quantity` (native `quote.items[].quantity`,
//     UCP `checkout.line_items[].quantity`): `maximum`;
//   - each of the two idempotency key descriptions (native `idempotency_key`, UCP `meta["idempotency-key"]`) gained
//     ONE sentence: how the minimum is counted.
// A golden test that pins a tools/list body captured before them reverses exactly these and compares the rest byte
// for byte, so any OTHER change still fails it.
const LINE_QUANTITY_MAXIMUM_EDIT = Object.freeze([
  '"quantity":{"type":"integer","minimum":1,"maximum":999}',
  '"quantity":{"type":"integer","minimum":1}',
]);
const KEY_LENGTH_SENTENCE = ' At least 8 characters; leading and trailing whitespace and invisible formatting characters are not counted.';
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

const reverse = (text, [now, before]) => String(text).split(now).join(before);

/** The text with the ceiling's schema edit reversed (each occurrence). */
function revertLineQuantityMaximumEdit(text) {
  return reverse(text, LINE_QUANTITY_MAXIMUM_EDIT);
}

/** The text with the sentence taken back out of both key descriptions (each occurrence). */
function revertIdempotencyKeyDescriptionEdits(text) {
  return IDEMPOTENCY_KEY_DESCRIPTION_EDITS.reduce(reverse, String(text));
}

module.exports = {
  LINE_QUANTITY_MAXIMUM_EDIT, IDEMPOTENCY_KEY_DESCRIPTION_EDITS, KEY_LENGTH_SENTENCE,
  revertLineQuantityMaximumEdit, revertIdempotencyKeyDescriptionEdits,
};
