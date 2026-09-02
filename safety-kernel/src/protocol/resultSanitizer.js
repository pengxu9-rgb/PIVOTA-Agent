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
// A COMPOSITE IDENTIFIER is one of our own keys: separator-joined, no whitespace —
// "merch_x|shopify|9854988910809|∅", "prod::merch_x::shopify::9854988910809". Inside one, a digit
// run that FOLLOWS a separator is a segment of the id, never a card number.
//
// Why a shape gate and not more key names. `PAN_EXEMPT_ID_KEYS` already carried `productkey`, so on
// one prod get_product response (2026-09-02) `product_key` kept the Shopify id 9854988910809 while
// `sku_key` came back "[REDACTED_PAN]" — 13 digits and Luhn-valid, so the checksum gate that stops
// random digit runs cannot stop this one. Adding `skukey` fixes that row and nothing else: the same
// asymmetry waits on every sibling nobody enumerated (`matched_product_key` is exempted by name in
// one upserter tuple while `matched_content_key` beside it is not), which is how the original hole
// was born. A name list cannot stop rotting; the value's shape can.
//
// It is also strictly SAFER than a name exemption, which skips PAN scanning for the whole value:
//   - a bare PAN keeps being redacted even under an exempt key — "4111111111111111" has no
//     separator before it;
//   - a PAN in the FIRST segment is redacted — "4111111111111111|shopify|985…" → the leading run is
//     not preceded by a separator;
//   - free text is untouched, because a composite id has no whitespace. That closes a real hole:
//     `catalog_variant_promoter._visible_attributes` lowercases MERCHANT-AUTHORED option axis names
//     into dict keys, and canon() erases the space — so an axis literally named "sku key" would
//     inherit a name-based exemption. Its value is bare text, so the shape gate refuses it.
//
// Mirrors redactPansOutsideStorefrontIds below, whose comment records that its own per-VALUE
// ancestor was a prefix-gate hole. Same lesson, same fix.
const COMPOSITE_ID_RE = /^\S*(?:\|\|?|::)\S*$/;
const COMPOSITE_SEGMENT_SEPARATORS = new Set(['|', ':']);

function redactPans(s) {
  const composite = COMPOSITE_ID_RE.test(s);
  return s.replace(PAN_RE, (m, offset) => {
    if (!luhnValid(m)) return m;
    if (composite && offset > 0 && COMPOSITE_SEGMENT_SEPARATORS.has(s[offset - 1])) return m;
    return '[REDACTED_PAN]';
  });
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
// AP2 checkout binding JWT. This is the one payment-adjacent string that MUST reach the agent
// verbatim: the wallet hashes it to mint a Checkout Mandate, and the kernel then compares that
// digest. It is not a bearer credential — it grants nothing, carries only a checkout session id
// and an expiry, and is signed with a server-side secret that never leaves us. LOOSE_SECRET_RE
// matches any compact JWS, so it was being rewritten to [REDACTED_SECRET] and every AP2
// completion failed checkout_hash_mismatch on a token the wallet could never have seen.
//
// Preserved regardless of handoffAllowed: the ACP session body is sanitized with
// handoffAllowed:false, and that door needs the field just as much as the native one. Gated on
// BOTH the key name AND a strict compact-JWS shape, the same belt-and-braces as
// ATTRIBUTED_LINK_KEYS, so an arbitrary secret smuggled under this key still gets scrubbed.
const AP2_CHECKOUT_JWT_KEYS = new Set(['ap2checkoutjwt']);
const AP2_CHECKOUT_JWT_RE = /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}$/;
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
// Execution spec v0 (`cart_url` / `pdp_url`). Both embed a Shopify identifier that is ALWAYS a 13-19 digit
// run — the cart permalink's `/cart/<variant>:<qty>`, and a product url's `?variant=<id>` selector. That is
// exactly PAN_RE's shape, and the Luhn gate does not help: ~1 in 10 such ids is Luhn-valid by chance. Measured
// on real Pivota-composed urls: 9.3% of product urls carrying `?variant=` (7 of 75) would be rewritten. The
// cart case 404s; the product case is worse — it silently drops the buyer on the DEFAULT variant, not the
// shade the agent just described. Same failure the PAN_RE note above records from prod 2026-07-10.
//
// The exemption is per-SPAN, not per-value. An earlier cut of this exempted the whole string once the value
// matched a cart-permalink shape, which made the gate a PREFIX gate: `https://x.co/cart/1:1?c=<PAN>` passed
// unscrubbed, as did a PAN in the host or after a `#`. Preserving only the digit runs we ourselves wrote keeps
// every other position — host, path, query, fragment — under the normal scrub, and needs no anchoring.
//
// KNOWN AND DELIBERATE: a PAN sitting in the variant POSITION (`/cart/4111111111111111:1`) is preserved. A
// 16-digit variant id and a PAN are indistinguishable there, so the choice is to preserve variant ids or to
// break ~10% of carts. The only producer of these keys is our own composer
// (services/outbound_links_service.py), which writes an id already through extract_shopify_numeric_variant_id.
const STOREFRONT_URL_KEYS = new Set(['carturl', 'pdpurl']);
const STOREFRONT_ID_SPAN_RE = /\/cart\/\d{1,19}:\d{1,4}|[?&]variant=\d{1,19}\b/g;
// Redact PANs everywhere EXCEPT the spans we wrote. Splitting on those spans also means a digit run cannot be
// matched across a boundary into a preserved id.
function redactPansOutsideStorefrontIds(s) {
  let out = '';
  let last = 0;
  STOREFRONT_ID_SPAN_RE.lastIndex = 0;
  let m = STOREFRONT_ID_SPAN_RE.exec(s);
  while (m !== null) {
    out += redactPans(s.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
    m = STOREFRONT_ID_SPAN_RE.exec(s);
  }
  return out + redactPans(s.slice(last));
}
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
      // AP2 binding material under its own key, shape-gated. See AP2_CHECKOUT_JWT_KEYS.
      if (keyCanon && AP2_CHECKOUT_JWT_KEYS.has(keyCanon) && AP2_CHECKOUT_JWT_RE.test(value)) return value;
      // System-issued id keys skip PAN scanning (their digits are our identifiers); everywhere else PAN
      // redaction is Luhn-gated (all real cards pass Luhn; random ids / URL digit runs almost never do).
      // A shape-verified cart permalink is exempt for the same reason: the digit run IS the variant id.
      // Note this exempts PAN scanning ONLY — the secret scrubs below still run on it, which is stricter
      // than the verbatim return the attributed-link rule above takes, and costs nothing here.
      const out = keyCanon && PAN_EXEMPT_ID_KEYS.has(keyCanon)
        ? value
        : keyCanon && STOREFRONT_URL_KEYS.has(keyCanon)
          ? redactPansOutsideStorefrontIds(value)
          : redactPans(value);
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
