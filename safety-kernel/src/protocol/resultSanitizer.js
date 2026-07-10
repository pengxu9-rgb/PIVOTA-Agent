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
//   - internal ranking/debug strip (`stripRankingInternals`, default ON): the agent product payload must be
//       catalog + the "why" prose, NOT our retrieval/ranking mechanics. Internal-only keys (ranking_features,
//       ranking_score, candidate_source, score_breakdown, x_score, debug/scratchpad bundles) are DROPPED at any
//       depth — the agent should not even see the key existed. Bare `score`/`confidence` are dropped only on a
//       product node (so a nested review.score etc. survives). Mirrors the FORBIDDEN_CONTEXT_KEYS denylist in
//       src/modules/contracts/shoppingContext.js (duplicated, not imported — that file is CJS, this is ESM).

const REDACTED = '[REDACTED]';
const PAN_RE = /\b(?:\d[ -]*?){13,19}\b/g;
// PAN detection is LUHN-GATED: every real card number is Luhn-valid, so requiring the checksum loses no real
// PANs while eliminating the false positives that broke live results (a 14-digit Shopify product id inside
// product_id / a canonical URL was redacted as a "PAN", destroying search→detail chaining — observed in prod
// 2026-07-10). Additionally, SYSTEM-ISSUED id keys (below) are exempt from PAN scanning entirely: their
// values are our own identifiers, a PAN cannot legitimately appear there via any flow, and the SENSITIVE
// key-denylist already drops card-named keys outright.
const PAN_EXEMPT_ID_KEYS = new Set([
  'id', 'productid', 'variantid', 'skuid', 'sku', 'productgroupid', 'platformproductid', 'sourceproductid',
  'sellableitemgroupid', 'signatureid', 'pivotasignatureid', 'productkey', 'catalogproductkey',
  'orderid', 'quoteid', 'sessionid', 'checkoutsessionid', 'merchantid', 'externalseedid', 'offerid',
  'lineitemid', 'itemid',
]);
function luhnValid(candidate) {
  const digits = String(candidate).replace(/[ -]/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}
function redactPans(s) {
  return s.replace(PAN_RE, (m) => (luhnValid(m) ? '[REDACTED_PAN]' : m));
}
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
// Attributed outbound links (redirect-commission lane): pivota-backend stamps signed first-party redirect URLs
// (`https://<host>/r?token=<payload_b64url>.<sig_b64url>`) onto product/offer payloads under these keys. The
// token is a PUBLIC signed click-attribution grant (HMAC over market/tool/dest/ctx), not a credential — and it
// MUST survive verbatim: URL_SECRET_RE would redact `token=` and PAN_RE can false-positive on digit runs inside
// the base64url payload; either one breaks the signature and kills attribution. Preservation is gated on BOTH
// the key name AND the strict value shape, so an arbitrary URL (or a real secret) smuggled under these keys
// still goes through the normal scrub.
const ATTRIBUTED_LINK_KEYS = new Set(['externalredirecturl', 'affiliateurl', 'merchantcheckouturl']);
const ATTRIBUTED_LINK_RE = /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/r\?token=[A-Za-z0-9_=-]+\.[A-Za-z0-9_=-]+$/;
// STRICT = unambiguous secrets (never a legit id/sku) — scrubbed even in id fields. LOOSE adds sk-{32,}
// (OpenAI-style), applied OUTSIDE id fields to avoid nuking a long "sk-…" SKU. Stripe publishable pk_ is
// intentionally excluded (not a secret; collides with SKUs).
const STRICT_SECRET_RE = /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{6,}\b|\bwhsec_[A-Za-z0-9]{10,}\b|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/g;
const LOOSE_SECRET_RE = /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{6,}\b|\bwhsec_[A-Za-z0-9]{10,}\b|\bsk-[A-Za-z0-9]{32,}\b|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/g;
const canon = (k) => k.toLowerCase().replace(/[^a-z0-9]/g, '');

// Internal ranking/retrieval/debug keys — never useful to an agent, dropped at ANY depth. Canonicalized
// (lowercase, alnum-only) to match canon(). Mirrors FORBIDDEN_CONTEXT_KEYS in shoppingContext.js.
const RANKING_INTERNAL = new Set([
  'rankingfeatures', 'rankingscore', 'rankingfeaturessummary', 'candidatesource', 'candidatesources',
  'scorebreakdown', 'xscore',
  // debug / scratch bundles that can ride along on internal objects
  'promptscratchpad', 'llmscratchpad', 'modulecache', 'rawcandidates', 'debug', 'debugbundle', 'cache',
]);
// Bare numeric rank signals — dropped ONLY on a product node, so an innocuous nested `review.score` survives.
const PRODUCT_SCOPED_INTERNAL = new Set(['score', 'confidence']);
// Product-identity sibling keys that mark an object as a product node (canonicalized).
const PRODUCT_ID_KEYS = new Set([
  'productid', 'sku', 'sellableitemgroupid', 'signatureid', 'pivotasignatureid', 'productkey',
]);
function looksLikeProductNode(obj) {
  let hasId = false;
  let hasTitle = false;
  for (const k of Object.keys(obj)) {
    const c = canon(k);
    if (PRODUCT_ID_KEYS.has(c)) return true;
    if (c === 'id') hasId = true;
    if (c === 'title' || c === 'name') hasTitle = true;
  }
  return hasId && hasTitle;
}

function isObjectLike(v) { return typeof v === 'object' && v !== null; }

/**
 * Sanitize a result a protocol adapter is about to return to an agent.
 * @param {*} rootValue
 * @param {{ handoffAllowed?: boolean }} [opts]  handoffAllowed=true ONLY for the checkout flow (preserves payment redirects verbatim)
 */
export function sanitizeResult(rootValue, { handoffAllowed = false, stripRankingInternals = true } = {}) {
  const walk = (value, seen, depth, keyCanon) => {
    if (typeof value === 'string') {
      if (keyCanon && HANDOFF_KEYS.has(keyCanon) && handoffAllowed) return value; // legit payment handoff — verbatim
      // Signed attribution link under an attributed-link key — verbatim regardless of handoffAllowed (these
      // ride on DISCOVERY payloads: feed items, product detail, offers). Shape-gated; see ATTRIBUTED_LINK_RE.
      if (keyCanon && ATTRIBUTED_LINK_KEYS.has(keyCanon) && ATTRIBUTED_LINK_RE.test(value)) return value;
      // System-issued id keys skip PAN scanning (their digits are our identifiers); everywhere else PAN
      // redaction is Luhn-gated (all real cards pass Luhn; random ids / URL digit runs almost never do).
      const out = keyCanon && PAN_EXEMPT_ID_KEYS.has(keyCanon) ? value : redactPans(value);
      if (keyCanon && isIdKey(keyCanon)) return out.replace(STRICT_SECRET_RE, '[REDACTED_SECRET]'); // keep SKUs, kill real secrets
      return out.replace(LOOSE_SECRET_RE, '[REDACTED_SECRET]').replace(URL_SECRET_RE, '$1[REDACTED]');
    }
    if (!isObjectLike(value)) return value;
    if (depth > 64) return '[Truncated]';
    // `seen` tracks the ANCESTOR chain on the CURRENT path (added before recursing, removed after) — not a
    // permanent visited-set. This catches real cycles (a node reachable from itself) without misflagging a
    // non-cyclic shared reference (a DAG — e.g. the same product object appearing in two result slots after
    // dedup/family-collapse) as '[Circular]', which would silently corrupt the agent-facing result.
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    let result;
    if (Array.isArray(value)) {
      result = value.map((v) => walk(v, seen, depth + 1, keyCanon));
    } else {
      const out = {};
      const isProductNode = stripRankingInternals && looksLikeProductNode(value);
      for (const [k, v] of Object.entries(value)) {
        const c = canon(k);
        if (SENSITIVE.has(c) || c.endsWith('token') || c.endsWith('secret') || c.endsWith('password') || c.endsWith('apikey')) {
          out[k] = REDACTED;
          continue;
        }
        if (stripRankingInternals && RANKING_INTERNAL.has(c)) continue; // internal ranking/debug noise — drop the key entirely
        if (isProductNode && PRODUCT_SCOPED_INTERNAL.has(c)) continue; // bare rank signal on a product node — drop
        out[k] = walk(v, seen, depth + 1, c);
      }
      result = out;
    }
    seen.delete(value); // leaving this node — it's no longer an ancestor of anything still being walked
    return result;
  };
  return walk(rootValue, new WeakSet(), 0, null);
}
