'use strict';

// The per-line quantity ceiling added ONE member to the tool schemas tools/list publishes: `maximum` on a cart
// line's `quantity` (native `quote.items[].quantity`, UCP `checkout.line_items[].quantity`). This is that edit as a
// [now, before] pair in the published text. A golden test that pins a tools/list body captured before the ceiling
// reverses exactly this and compares the rest byte for byte, so any OTHER change still fails it.
const LINE_QUANTITY_MAXIMUM_EDIT = Object.freeze([
  '"quantity":{"type":"integer","minimum":1,"maximum":999}',
  '"quantity":{"type":"integer","minimum":1}',
]);

/** The text with the ceiling's schema edit reversed (each occurrence). */
function revertLineQuantityMaximumEdit(text) {
  const [now, before] = LINE_QUANTITY_MAXIMUM_EDIT;
  return String(text).split(now).join(before);
}

module.exports = { LINE_QUANTITY_MAXIMUM_EDIT, revertLineQuantityMaximumEdit };
