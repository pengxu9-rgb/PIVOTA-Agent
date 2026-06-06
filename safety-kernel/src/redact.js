// C2 — Redaction helper. Enforces §7 of the contract: never log ap2_state,
// payment tokens, confirmation_token, PANs, or raw payment bodies.
// Use redact() on ANYTHING before it reaches a logger.

const SENSITIVE_KEYS = new Set([
  'ap2_state', 'confirmation_token', 'payment_token', 'token', 'card', 'card_number',
  'pan', 'cvv', 'cvc', 'mandate', 'mandate_id', 'authorization', 'secret', 'client_secret', 'api_key',
]);

// Field names whose values are amounts-as-PII: keep the key, mask the value.
const AMOUNT_KEYS = new Set(['expected_amount', 'amount', 'amount_total', 'total', 'subtotal']);

const PAN_RE = /\b(?:\d[ -]*?){13,19}\b/g;

/**
 * Deep-clone with sensitive values masked. Safe to pass the result to a logger.
 * @param {unknown} value
 * @returns {unknown}
 */
export function redact(value, seen = new WeakSet()) {
  if (value == null) return value;
  if (typeof value === 'string') return value.replace(PAN_RE, '[REDACTED_PAN]');
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((v) => redact(v, seen));

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const lower = k.toLowerCase();
    if (SENSITIVE_KEYS.has(lower)) out[k] = '[REDACTED]';
    else if (AMOUNT_KEYS.has(lower)) out[k] = typeof v === 'number' ? '[REDACTED_AMOUNT]' : redact(v, seen);
    else out[k] = redact(v, seen);
  }
  return out;
}

/** Convenience: a logger wrapper that redacts every argument. */
export function safeLogger(base = console) {
  const wrap = (fn) => (...args) => fn(...args.map((a) => redact(a)));
  return { info: wrap(base.log || base.info), warn: wrap(base.warn), error: wrap(base.error) };
}
