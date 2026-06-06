// Shared result sanitizer for protocol adapters (MCP commerce surface, ACP REST, future UCP/A2A). ONE place
// so the secret-scrubbing rules never diverge per ecosystem. Hardened across the MCP surface's 5 adversarial
// review rounds; reused verbatim by every adapter that echoes a kernel/connector result to an agent.
//
// Policy (provenance-aware):
//   - KEY denylist (precise): tokens/secrets/credentials/bank fields are dropped by key name.
//   - per-key string MODE:
//       handoff (checkout flow only): a payment-redirect URL/QR is preserved VERBATIM — scrubbing token=/code=
//         would break real PSPs (PayPal ?token=EC-…, OAuth ?code=…, 3DS client_secret must reach the buyer).
//       id (key ends in "id"): PAN + UNAMBIGUOUS secrets only, so orderable SKUs like "sk-…"/"pk_live_…"
//         survive while a real Stripe-secret/AWS/JWT/Bearer hidden under a *_id key is still killed.
//       normal: PAN + all value-prefix secrets + URL query-secret scrubbing.
//   - `handoffAllowed` (caller passes true ONLY for the checkout flow) gates the verbatim handoff preservation.

const REDACTED = '[REDACTED]';
const PAN_RE = /\b(?:\d[ -]*?){13,19}\b/g;
const SENSITIVE = new Set([
  'ap2state', 'confirmationtoken', 'clientsecret', 'authorization', 'accesstoken', 'idtoken', 'refreshtoken',
  'paymenttoken', 'paymentauthorization', 'mandate', 'mandatetoken', 'cardtoken', 'cardnumber', 'token',
  'apikey', 'secretkey', 'privatekey', 'password', 'passwd', 'passphrase', 'pin', 'cvv', 'cvv2', 'cvc', 'cvc2',
  'iban', 'sortcode', 'routingnumber', 'accountnumber', 'ssn', 'secret', 'pan',
]);
const HANDOFF_KEYS = new Set([
  'redirecturl', 'returnurl', 'actionurl', 'verificationurl', 'paymenturl', 'qr', 'qrcode', 'qrcodeurl', 'hostedurl',
  'checkouturl', 'confirmationurl', 'nextactionurl', 'threedsurl', 'approvalurl', 'authorizeurl', 'authenticationurl', 'acsurl',
]);
const isIdKey = (c) => c === 'id' || c.endsWith('id');
const URL_SECRET_RE = /([?&](?:client_secret|token|access_token|id_token|refresh_token|api_key|apikey|key|password|secret|sig|signature|code)=)[^&#\s]+/gi;
// STRICT = unambiguous secrets (never a legit id/sku) — scrubbed even in id fields. LOOSE adds sk-{32,}
// (OpenAI-style), applied OUTSIDE id fields to avoid nuking a long "sk-…" SKU. Stripe publishable pk_ is
// intentionally excluded (not a secret; collides with SKUs).
const STRICT_SECRET_RE = /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{6,}\b|\bwhsec_[A-Za-z0-9]{10,}\b|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/g;
const LOOSE_SECRET_RE = /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{6,}\b|\bwhsec_[A-Za-z0-9]{10,}\b|\bsk-[A-Za-z0-9]{32,}\b|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/g;
const canon = (k) => k.toLowerCase().replace(/[^a-z0-9]/g, '');

function isObjectLike(v) { return typeof v === 'object' && v !== null; }

/**
 * Sanitize a result a protocol adapter is about to return to an agent.
 * @param {*} rootValue
 * @param {{ handoffAllowed?: boolean }} [opts]  handoffAllowed=true ONLY for the checkout flow (preserves payment redirects verbatim)
 */
export function sanitizeResult(rootValue, { handoffAllowed = false } = {}) {
  const walk = (value, seen, depth, keyCanon) => {
    if (typeof value === 'string') {
      if (keyCanon && HANDOFF_KEYS.has(keyCanon) && handoffAllowed) return value; // legit payment handoff — verbatim
      const out = value.replace(PAN_RE, '[REDACTED_PAN]');
      if (keyCanon && isIdKey(keyCanon)) return out.replace(STRICT_SECRET_RE, '[REDACTED_SECRET]'); // keep SKUs, kill real secrets
      return out.replace(LOOSE_SECRET_RE, '[REDACTED_SECRET]').replace(URL_SECRET_RE, '$1[REDACTED]');
    }
    if (!isObjectLike(value)) return value;
    if (depth > 64) return '[Truncated]';
    if (seen.has(value)) return '[Circular]'; // add to `seen` BEFORE recursing — covers array cycles too
    seen.add(value);
    if (Array.isArray(value)) return value.map((v) => walk(v, seen, depth + 1, keyCanon));
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const c = canon(k);
      if (SENSITIVE.has(c) || c.endsWith('token') || c.endsWith('secret') || c.endsWith('password') || c.endsWith('apikey')) {
        out[k] = REDACTED;
        continue;
      }
      out[k] = walk(v, seen, depth + 1, c);
    }
    return out;
  };
  return walk(rootValue, new WeakSet(), 0, null);
}
