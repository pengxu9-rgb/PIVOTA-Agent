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
// Execution spec v0 — Shopify identifiers inside storefront URLs must survive the PAN scrub,
// and NOTHING ELSE in those URLs may.
//
// `cart_url` embeds `/cart/<variant>:<qty>`; `pdp_url` embeds `?variant=<id>`. A Shopify variant
// id is always a 13-19 digit run — exactly PAN_RE's shape — and ~1 in 10 is Luhn-valid by chance.
// Unprotected, the cart url 404s and the product url silently lands the buyer on the DEFAULT
// variant rather than the one the agent described.
//
// The exemption is per-SPAN. An earlier cut exempted the whole value once it matched a cart shape,
// which made it a PREFIX gate — everything below marked "must be redacted" passed through it.
// ---------------------------------------------------------------------------------------------

const LUHN_VALID_VARIANT_ID = '40064041844877';
const PAN = '4111111111111111';

test('the fixture ids really are Luhn-valid — otherwise this suite proves nothing', () => {
  const luhn = (digits) => {
    let sum = 0;
    let dbl = false;
    for (let i = digits.length - 1; i >= 0; i -= 1) {
      let d = digits.charCodeAt(i) - 48;
      if (dbl) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
      dbl = !dbl;
    }
    return sum % 10 === 0;
  };
  assert.ok(luhn(LUHN_VALID_VARIANT_ID), 'a Luhn-INVALID id is never redacted — nothing would be tested');
  assert.ok(luhn(PAN), 'the PAN fixture must be Luhn-valid or the negative cases prove nothing');
});

const spec = (k, v) => sanitizeResult({ offers: [{ execution_spec: { [k]: v } }] }).offers[0].execution_spec[k];

test('the identifier we wrote survives, in both storefront url shapes', () => {
  const cart = `https://brand.com/cart/${LUHN_VALID_VARIANT_ID}:1?attributes[pivota_click_id]=clk_abc`;
  assert.equal(spec('cart_url', cart), cart, 'a redacted variant id is a 404');

  const pdp = `https://brand.com/products/serum?variant=${LUHN_VALID_VARIANT_ID}&utm_source=pivota`;
  assert.equal(spec('pdp_url', pdp), pdp, 'a redacted variant selector silently serves the DEFAULT variant');
});

test('everything OUTSIDE the identifier span is still scrubbed', () => {
  // Each of these defeated the earlier whole-value exemption. They are the reason it is per-span.
  const cases = [
    [`https://a.co/cart/1:1?x=${PAN}`, 'PAN in the query'],
    [`https://brand.com/cart/${LUHN_VALID_VARIANT_ID}:1?note=${PAN}`, 'PAN in the query beside a real variant'],
    [`https://${PAN}.evil.com/cart/1:1`, 'PAN in the host'],
    ['https://a.co/cart/1:1?n=4111-1111-1111-1111', 'dashed PAN in the query'],
    [`https://a.co/cart/1:1#${PAN}`, 'PAN after a fragment'],
    [`${PAN} https://a.co/cart/1:1`, 'PAN before the url'],
    [`https://a.co/cart/1:1?a=${PAN}&b=5555555555554444`, 'two PANs in the query'],
    // The cart span is anchored to the `/cart/` PATH. Without that anchor a bare `<digits>:<digits>`
    // anywhere in the string would be preserved, so a PAN only has to be followed by `:1` to pass.
    [`https://a.co/cart/1:1?x=${PAN}:99`, 'PAN wearing a :qty suffix outside the cart path'],
    [`https://a.co/collections/${PAN}:1`, 'cart-looking pair on a non-cart path'],
  ];
  for (const [value, label] of cases) {
    assert.match(spec('cart_url', value), /\[REDACTED_PAN\]/, `must be redacted: ${label}`);
  }
  assert.match(spec('pdp_url', `https://a.co/products/x?variant=${LUHN_VALID_VARIANT_ID}&note=${PAN}`),
    /\[REDACTED_PAN\]/, 'pdp_url: PAN beside a legitimate variant selector');
});

test('a real variant beside a PAN keeps the variant AND kills the PAN', () => {
  const got = spec('cart_url', `https://brand.com/cart/${LUHN_VALID_VARIANT_ID}:1?note=${PAN}`);
  assert.ok(got.includes(LUHN_VALID_VARIANT_ID), 'the identifier we wrote must survive');
  assert.ok(!got.includes(PAN), 'the PAN must not');
});

test('the exemption applies only to the storefront url keys', () => {
  const cart = `https://brand.com/cart/${LUHN_VALID_VARIANT_ID}:1`;
  // Same string, different key -> no exemption.
  assert.match(sanitizeResult({ offers: [{ some_other_url: cart }] }).offers[0].some_other_url,
    /\[REDACTED_PAN\]/);
  // Keyless (bare array element) -> keyCanon is undefined, so no exemption.
  assert.match(sanitizeResult({ offers: [{ notes: [cart] }] }).offers[0].notes[0], /\[REDACTED_PAN\]/);
});

test('the exemption covers PAN scanning ONLY — secrets in the query are still scrubbed', () => {
  const got = spec('cart_url', `https://brand.com/cart/${LUHN_VALID_VARIANT_ID}:1?secret=hunter2`);
  assert.ok(!got.includes('hunter2'), 'a secret query param must not survive');
  assert.ok(got.includes(LUHN_VALID_VARIANT_ID), 'while the variant id still must');
});

test('variant_id itself is PAN-exempt as a system-issued id key', () => {
  assert.equal(spec('variant_id', LUHN_VALID_VARIANT_ID), LUHN_VALID_VARIANT_ID);
});

// The composite-key family. `productkey` was exempted from PAN scanning when PAN_EXEMPT_ID_KEYS was
// written; its siblings carry the identical value shape and were not — so the SAME platform id
// survived in one field of a response and was destroyed in the next one down. Observed in prod
// 2026-09-02 on a single get_product response:
//     product_key: "merch_c5e24a8d3738d73b|shopify|9854988910809"
//     sku_key:     "merch_c5e24a8d3738d73b|shopify|[REDACTED_PAN]|∅"
// 9854988910809 is 13 digits AND Luhn-valid, so the checksum gate that stops random digit runs
// does not stop this one — an agent chaining on sku_key got a broken identifier.

test('a composite key keeps its platform id — the Luhn gate does not save a 13-digit product id', () => {
  const out = sanitizeResult({
    review_summary: {
      product_key: 'merch_c5e24a8d3738d73b|shopify|9854988910809',
      sku_key: 'merch_c5e24a8d3738d73b|shopify|9854988910809|∅',
      content_key: 'merch_c5e24a8d3738d73b|shopify|9854988910809',
    },
    attached_product_key: 'prod::merch_c5e24a8d3738d73b::shopify::9854988910809',
    representative_product_key: 'prod::merch_c5e24a8d3738d73b::shopify::9854988910809',
    matched_product_key: 'prod::merch_c5e24a8d3738d73b::shopify::9854988910809',
  });
  // The id the agent has to chain on must survive in EVERY field that carries it, not just one.
  assert.equal(out.review_summary.sku_key, 'merch_c5e24a8d3738d73b|shopify|9854988910809|∅');
  assert.equal(out.review_summary.product_key, 'merch_c5e24a8d3738d73b|shopify|9854988910809');
  assert.equal(out.review_summary.content_key, 'merch_c5e24a8d3738d73b|shopify|9854988910809');
  for (const k of ['attached_product_key', 'representative_product_key', 'matched_product_key']) {
    assert.match(out[k], /9854988910809/, `${k} must keep its platform id`);
  }
  assert.equal(JSON.stringify(out).includes('REDACTED_PAN'), false);
});

test('the exemption is per-key, so a key that is NOT one of ours still gets PAN-scanned', () => {
  // The counterpart. Exempting a key asserts "a PAN cannot legitimately appear in this value via
  // any flow" — a claim about each field — so the list is enumerated rather than `endsWith('key')`.
  // consumer_key is a WooCommerce credential; idempotency/lock/module keys are not published ids.
  const out = sanitizeResult({
    consumer_key: 'key 4111111111111111 end',
    idempotency_key: 'idem 4111111111111111 end',
    lock_key: 'lock 4111111111111111 end',
    module_key: 'mod 4111111111111111 end',
    note: 'card 4111111111111111 here',
  });
  for (const k of ['consumer_key', 'idempotency_key', 'lock_key', 'module_key', 'note']) {
    assert.match(out[k], /\[REDACTED_PAN\]/, `${k} must still be PAN-scanned`);
  }
});

test('a real PAN is still redacted where a composite key is not involved', () => {
  // Guards the obvious over-correction: exempting keys must not weaken the scan itself.
  const out = sanitizeResult({ sku_key: '4111111111111111', note: '4111111111111111' });
  assert.equal(out.note, '[REDACTED_PAN]');
  // ...and the exempt field is exempt by KEY, which is the deliberate trade: a bare PAN placed in
  // sku_key survives. That is acceptable only because sku_key is server-composed and a card number
  // cannot reach it — the same reasoning already applied to product_key.
  assert.equal(out.sku_key, '4111111111111111');
});
