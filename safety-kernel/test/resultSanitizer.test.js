// resultSanitizer tests — the single chokepoint every protocol adapter (MCP, ACP REST) runs before echoing a
// kernel/connector result to an agent. Covers: (1) secret/PAN redaction still holds, (2) internal ranking/debug
// noise is dropped at any depth, (3) bare score/confidence are dropped only on a product node (nested
// review.score survives), (4) the "why" prose survives, (5) the strip can be turned off via opts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeResult } from '../src/protocol/resultSanitizer.js';

test('drops internal ranking/debug keys at any depth; keeps catalog + why prose', () => {
  const out = sanitizeResult({
    products: [
      {
        product_id: 'p1', title: 'Vitamin C Serum', price: 29, currency: 'USD',
        ranking_features: { source: 'rerank_llm' }, ranking_score: 0.9, ranking_features_summary: 'overlap',
        candidate_source: 'vector_recall', score_breakdown: { fit: 0.5 }, x_score: 0.4,
        score: 0.88, confidence: 0.7,
        recommendation_reason: 'good for oily skin', match_reason: 'matches need', why_this_one: 'best value',
        review: { author: 'Jane', score: 4.5 },
      },
    ],
    metadata: { candidate_source: 'multi_provider', debug: { trace: 'x' }, total: 1 },
  });
  const p = out.products[0];
  for (const k of ['ranking_features', 'ranking_score', 'ranking_features_summary', 'candidate_source',
    'score_breakdown', 'x_score', 'score', 'confidence']) {
    assert.ok(!(k in p), `${k} must be stripped`);
  }
  // catalog + why survive
  assert.equal(p.title, 'Vitamin C Serum');
  assert.equal(p.price, 29);
  assert.equal(p.recommendation_reason, 'good for oily skin');
  assert.equal(p.match_reason, 'matches need');
  assert.equal(p.why_this_one, 'best value');
  // product-node-scoped: nested non-product review.score is preserved
  assert.equal(p.review.score, 4.5);
  assert.equal(p.review.author, 'Jane');
  // metadata-level internal keys also dropped
  assert.ok(!('candidate_source' in out.metadata));
  assert.ok(!('debug' in out.metadata));
  assert.equal(out.metadata.total, 1);
});

test('score/confidence are NOT stripped off a non-product object', () => {
  const out = sanitizeResult({ rating_summary: { score: 4.2, confidence: 0.9, count: 100 } });
  assert.equal(out.rating_summary.score, 4.2);
  assert.equal(out.rating_summary.confidence, 0.9);
});

test('no regression: secrets and PANs are still redacted alongside the ranking strip', () => {
  const out = sanitizeResult({
    product_id: 'p1', title: 'X', score: 0.5,
    access_token: 'at_secret', card_number: '4111 1111 1111 1111',
    note: 'pan 4242 4242 4242 4242 here',
  });
  assert.ok(!('score' in out));
  assert.equal(out.access_token, '[REDACTED]');
  assert.equal(out.card_number, '[REDACTED]');
  assert.equal(out.note, 'pan [REDACTED_PAN] here');
  assert.equal(out.title, 'X');
});

// PAN detection is Luhn-gated + system-id-exempt (prod incident 2026-07-10: 14-digit Shopify product ids in
// product_id / canonical URLs were redacted as "PANs", destroying search→detail chaining on the MCP doors).
test('numeric system ids are NOT redacted as PANs (id-key exemption)', () => {
  const out = sanitizeResult({
    product_id: '10064562258217',          // 14-digit Shopify id — the exact live breakage
    variant_id: '53012664942889',
    id: '4242424242424242',                // even a Luhn-valid run under a system id key survives
    order_id: 'ORD_918269F734DA457B',
    title: 'Serum',
  });
  assert.equal(out.product_id, '10064562258217');
  assert.equal(out.variant_id, '53012664942889');
  assert.equal(out.id, '4242424242424242');
  assert.equal(out.order_id, 'ORD_918269F734DA457B');
});

test('Luhn-INVALID digit runs in text/urls are NOT redacted; Luhn-valid still are', () => {
  const out = sanitizeResult({
    title: 'X', product_id: 'p1',
    pivota_url: 'https://agent.pivota.cc/products/4242424242424241',  // Luhn-invalid → preserved
    note_invalid: 'ref 4242 4242 4242 4241 ok',                       // Luhn-invalid → preserved
    note_valid: 'card 4242 4242 4242 4242 leaked',                    // Luhn-valid → redacted
    ref_code: '4111111111111111',                                     // Luhn-valid under NON-exempt key → redacted
  });
  assert.equal(out.pivota_url, 'https://agent.pivota.cc/products/4242424242424241');
  assert.equal(out.note_invalid, 'ref 4242 4242 4242 4241 ok');
  assert.equal(out.note_valid, 'card [REDACTED_PAN] leaked');
  assert.equal(out.ref_code, '[REDACTED_PAN]');
});

test('stripRankingInternals: false leaves ranking fields intact (still scrubs secrets)', () => {
  const out = sanitizeResult(
    { product_id: 'p1', title: 'X', ranking_score: 0.9, score: 0.5, access_token: 'at_secret' },
    { stripRankingInternals: false },
  );
  assert.equal(out.ranking_score, 0.9);
  assert.equal(out.score, 0.5);
  assert.equal(out.access_token, '[REDACTED]');
});

test('shared (non-cyclic) reference is NOT flagged [Circular] — DAG, not a cycle', () => {
  // Same product object appears in two slots (e.g. after dedup/family-collapse). Both must survive intact.
  const shared = { product_id: 'p1', title: 'Vitamin C Serum', price: 29 };
  const out = sanitizeResult({ items: [shared, shared], featured: shared });
  assert.equal(out.items[0].title, 'Vitamin C Serum');
  assert.equal(out.items[1].title, 'Vitamin C Serum', 'second occurrence must not be [Circular]');
  assert.notEqual(out.items[1], '[Circular]');
  assert.equal(out.featured.title, 'Vitamin C Serum');
  assert.equal(out.featured.price, 29);
});

test('real cycle IS still flagged [Circular] (object and array back-references)', () => {
  const node = { product_id: 'p1', title: 'X' };
  node.self = node;            // object self-reference
  const arr = [];
  arr.push(arr);              // array self-reference
  const out = sanitizeResult({ node, arr });
  assert.equal(out.node.title, 'X');
  assert.equal(out.node.self, '[Circular]');
  assert.equal(out.arr[0], '[Circular]');
});

// ---- attributed redirect links (redirect-commission lane) ---------------------------------------------------

// A realistic signed redirect: base64url payload with a 16-digit run (PAN_RE bait) + base64url HMAC sig.
const ATTRIBUTED = 'https://api.pivota.cc/r?token=eyJ2IjowLCJ0Ijoi1234567890123456abc_-w==.9f8E7dC6bA5_-4321abcdEFGHijkl==';

test('attributed link keys preserve a signed /r?token= URL verbatim (feed/discovery, handoff NOT allowed)', () => {
  const out = sanitizeResult(
    {
      products: [{
        product_id: 'p1', title: 'Serum',
        external_redirect_url: ATTRIBUTED,
        offers: [{ offer_id: 'o1', affiliate_url: ATTRIBUTED, purchase_route: 'affiliate_outbound' }],
        merchant_checkout_url: ATTRIBUTED,
      }],
    },
    { handoffAllowed: false },
  );
  const p = out.products[0];
  assert.equal(p.external_redirect_url, ATTRIBUTED, 'external_redirect_url must survive byte-for-byte');
  assert.equal(p.offers[0].affiliate_url, ATTRIBUTED, 'affiliate_url must survive byte-for-byte');
  assert.equal(p.merchant_checkout_url, ATTRIBUTED, 'merchant_checkout_url must survive byte-for-byte');
});

test('attributed-link preservation is shape-gated: non-/r URLs and secrets under those keys still scrubbed', () => {
  const out = sanitizeResult({
    // token param on an arbitrary URL under the attributed key → still redacted (shape mismatch)
    external_redirect_url: 'https://evil.example/steal?token=abc.def',
    // path is not /r → still redacted
    affiliate_url: 'https://api.pivota.cc/other?token=abc.def',
    // http (not https) → still redacted
    merchant_checkout_url: 'http://api.pivota.cc/r?token=abc.def',
    // real secret under an attributed key → still killed
    also_bad: { affiliate_url: 'Bearer abcdefghijklmnop1234' },
  });
  assert.match(out.external_redirect_url, /token=\[REDACTED\]/);
  assert.match(out.affiliate_url, /token=\[REDACTED\]/);
  assert.match(out.merchant_checkout_url, /token=\[REDACTED\]/);
  assert.match(out.also_bad.affiliate_url, /\[REDACTED_SECRET\]/);
});

test('no regression: ?token= on ordinary URL keys is still scrubbed everywhere', () => {
  const out = sanitizeResult({ url: 'https://api.pivota.cc/r?token=abc.def', link: 'https://x.example/?token=zzz' });
  assert.match(out.url, /token=\[REDACTED\]/, 'plain url key gets no attributed-link exemption');
  assert.match(out.link, /token=\[REDACTED\]/);
});

// ---------------------------------------------------------------------------------------------
// Execution spec v0 — a Shopify cart permalink must survive the PAN scrub.
//
// `https://<host>/cart/<variant>:<qty>` embeds a Shopify variant id, which is ALWAYS a 13-19 digit
// run — exactly PAN_RE's shape. The Luhn gate does not rescue it: ~1 in 10 variant ids is
// Luhn-valid by chance, so without a shape-gated exemption roughly a tenth of every cart permalink
// we publish would reach the agent as `/cart/[REDACTED_PAN]:1` and 404.
//
// This is the same failure the PAN_RE comment records from prod 2026-07-10 (a 14-digit Shopify id
// inside a canonical URL, breaking search→detail chaining), returning on a new field.
// ---------------------------------------------------------------------------------------------

// Luhn-valid and in the real Shopify variant-id range. Verified below rather than asserted, so this
// test cannot quietly stop exercising the redaction path if the constant is ever edited.
const LUHN_VALID_VARIANT_ID = '40064041844877';

test('the fixture variant id really is Luhn-valid — otherwise this suite proves nothing', () => {
  const digits = LUHN_VALID_VARIANT_ID;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  assert.equal(sum % 10, 0,
    'pick a Luhn-valid id: a Luhn-INVALID one is never redacted, so the exemption would be untested');
  assert.ok(digits.length >= 13 && digits.length <= 19, 'must be in PAN_RE length range');
});

test('a cart permalink survives the PAN scrub with its variant id intact', () => {
  const url = `https://brand.com/cart/${LUHN_VALID_VARIANT_ID}:1`
    + '?utm_source=pivota&attributes[pivota_click_id]=clk_abc123';
  const out = sanitizeResult({ offers: [{ execution_spec: { cart_url: url } }] });
  assert.equal(out.offers[0].execution_spec.cart_url, url,
    'the cart url must come through byte-identical — a redacted variant id is a 404');
});

test('the cart exemption is gated on SHAPE, not just the key name', () => {
  // A real PAN smuggled under `cart_url` must still be redacted. If the exemption were keyed on the
  // field name alone, `cart_url` would become a laundering channel for card numbers.
  const out = sanitizeResult({
    offers: [{ execution_spec: { cart_url: 'https://evil.example/pay?card=4111111111111111' } }],
  });
  assert.match(out.offers[0].execution_spec.cart_url, /\[REDACTED_PAN\]/,
    'a non-cart-shaped url under cart_url must take the normal scrub');
});

test('the cart exemption covers PAN scanning ONLY — secrets in the query are still scrubbed', () => {
  const out = sanitizeResult({
    offers: [{
      execution_spec: {
        cart_url: `https://brand.com/cart/${LUHN_VALID_VARIANT_ID}:1?secret=hunter2`,
      },
    }],
  });
  const got = out.offers[0].execution_spec.cart_url;
  assert.ok(!got.includes('hunter2'), 'a secret query param must not survive');
  assert.ok(got.includes(LUHN_VALID_VARIANT_ID), 'while the variant id still must');
});

test('a cart-shaped url under a DIFFERENT key gets no exemption', () => {
  // The exemption is keyed on `cart_url`. Anything else keeps the old behaviour, so this cannot
  // widen PAN tolerance across the payload by accident.
  const url = `https://brand.com/cart/${LUHN_VALID_VARIANT_ID}:1`;
  const out = sanitizeResult({ offers: [{ some_other_url: url }] });
  assert.match(out.offers[0].some_other_url, /\[REDACTED_PAN\]/);
});

test('variant_id itself is PAN-exempt as a system-issued id key', () => {
  const out = sanitizeResult({
    offers: [{ execution_spec: { variant_id: LUHN_VALID_VARIANT_ID } }],
  });
  assert.equal(out.offers[0].execution_spec.variant_id, LUHN_VALID_VARIANT_ID);
});

test('a cart-shaped url with NO key at all (bare array element) gets no exemption', () => {
  // The exemption reads the KEY. An array element has none, so `keyCanon` is undefined and the
  // value must fall through to the normal scrub. Nothing else covers the keyless path, and it is
  // the only place the `keyCanon &&` guard could ever matter.
  const url = `https://brand.com/cart/${LUHN_VALID_VARIANT_ID}:1`;
  const out = sanitizeResult({ offers: [{ notes: [url] }] });
  assert.match(out.offers[0].notes[0], /\[REDACTED_PAN\]/,
    'a keyless cart-shaped string must not inherit the cart_url exemption');
});
