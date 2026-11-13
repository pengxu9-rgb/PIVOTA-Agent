'use strict';

// THE REASONS A TOOL ERROR MAY BE LOGGED WITH, on the `mcp tools/call complete` line (`error_reason`).
//
// A refusal's code alone does not say what was refused. IDEMPOTENCY_CONFLICT is the code of a key that is too
// short, a key with a character that is not accepted, a key that is missing and a key that was already used for
// another request: four different things a partner is doing, one bucket in the logs. The refusal's own
// `detail.reason` tells them apart, so the completion line carries it.
//
// A CLOSED SET, AND ONLY LABELS. A reason is logged only when it is one of the strings below, each of them written
// in this repository's own code. Nothing a caller sent (a key, an id, a quantity, a message) can match one, so
// nothing a caller sent reaches the log through this field. A reason that is not listed is simply not logged: the
// line keeps its code. An IDEMPOTENCY_CONFLICT with no `error_reason` is the kernel ledger's "this key was already
// used for a different request", which carries no reason of its own.
//
// Loaded by the recorder that writes the line (./mcpToolCallOutcome.js) and by the tool-surface helper that reads
// the reason off the thrown error (mcp-server/src/toolCallOutcome.js): one list, so the two cannot disagree.

const intakeBounds = require('../../safety-kernel/src/protocol/intakeBounds.cjs');

const MCP_TOOL_ERROR_REASONS = Object.freeze([
  // The shared intake bounds (safety-kernel/src/protocol/intakeBounds.cjs).
  intakeBounds.IDEMPOTENCY_KEY_TOO_SHORT_REASON,
  intakeBounds.IDEMPOTENCY_KEY_BAD_CHARACTERS_REASON,
  intakeBounds.QUANTITY_ABOVE_LINE_MAXIMUM_REASON,
  intakeBounds.DUPLICATE_LINE_REASON,
  // A state-changing call with no key: the executor's and the storefront cart's refusal, the UCP mapper's, the
  // kernel ledger's.
  'missing_idempotency_key',
  'ucp_idempotency_key_required',
  'missing_or_short_key',
  // A key that is already in use: the storefront cart's record of another request, the kernel ledger's states for
  // an earlier attempt under the same key, the purchase tool's.
  'storefront_cart_idempotency_key_reused',
  'in_flight',
  'race',
  'ambiguous_prior_attempt',
  'lease_lost_after_op',
  'purchase_idempotency_conflict',
  // An order that is already being charged, or was.
  'charge_in_progress',
  'charge_pending',
  'order_already_paid',
]);

const LISTED = new Set(MCP_TOOL_ERROR_REASONS);

/** `value` when it is one of the listed reasons, else undefined. Never throws. */
function loggedToolErrorReason(value) {
  return typeof value === 'string' && LISTED.has(value) ? value : undefined;
}

module.exports = { MCP_TOOL_ERROR_REASONS, loggedToolErrorReason };
