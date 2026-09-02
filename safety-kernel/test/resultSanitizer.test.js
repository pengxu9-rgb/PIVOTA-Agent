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

// PAN redaction vs OUR composite identifiers.
//
// PAN_EXEMPT_ID_KEYS already carried `productkey`, so on one prod get_product response (2026-09-02)
// `product_key` kept the Shopify id 9854988910809 while `sku_key` came back "[REDACTED_PAN]". The id
// is 13 digits AND Luhn-valid, so the checksum gate that stops random digit runs cannot stop it.
// The fix is a value-SHAPE gate rather than more key names — see COMPOSITE_ID_RE.

test('a composite identifier keeps the digit segments that follow its separators', () => {
  const out = sanitizeResult({
    review_summary: {
      product_key: 'merch_c5e24a8d3738d73b|shopify|9854988910809',
      sku_key: 'merch_c5e24a8d3738d73b|shopify|9854988910809|∅',
    },
    attached_product_key: 'prod::merch_c5e24a8d3738d73b::shopify::9854988910809',
    // No key list is consulted, so a key nobody enumerated works too. That is the point: the
    // original hole was `productkey` exempt and `skukey` not, and a name list cannot stop rotting.
    some_future_key: 'somenewkey::merch_x::shopify::9854988910809',
  });
  assert.equal(out.review_summary.sku_key, 'merch_c5e24a8d3738d73b|shopify|9854988910809|∅');
  assert.equal(out.review_summary.product_key, 'merch_c5e24a8d3738d73b|shopify|9854988910809');
  assert.match(out.attached_product_key, /9854988910809/);
  assert.match(out.some_future_key, /9854988910809/);
  assert.equal(JSON.stringify(out).includes('REDACTED_PAN'), false);
});

test('the shape gate is STRICTER than a key exemption: a bare PAN is still redacted', () => {
  // A key-name exemption skips scanning the whole value, so a card number placed in sku_key would
  // survive. The shape gate refuses it — there is no separator in front of it.
  const out = sanitizeResult({
    sku_key: '4111111111111111',
    // ...and a PAN in the FIRST segment has no preceding separator either.
    content_key: '4111111111111111|shopify|9854988910809',
  });
  assert.equal(out.sku_key, '[REDACTED_PAN]');
  assert.equal(out.content_key, '[REDACTED_PAN]|shopify|9854988910809');
});

test('free text is never treated as a composite id, whatever the key is called', () => {
  // `catalog_variant_promoter._visible_attributes` lowercases MERCHANT-AUTHORED option axis names
  // straight into dict keys, and canon() erases the space — so an axis named "sku key" would
  // inherit any name-based exemption. A composite id has no whitespace, so this stays scanned.
  const out = sanitizeResult({
    visible_attributes: { 'sku key': '4111111111111111', shade: '4111111111111111' },
    consumer_key: 'key 4111111111111111 end',
    note: 'card 4111111111111111 here',
    // A separator immediately before the digits is NOT enough on its own — free text can contain
    // one. The whitespace test is what makes it a composite identifier.
    ref_line: 'ref:4111111111111111 (customer copy)',
  });
  assert.equal(out.visible_attributes['sku key'], '[REDACTED_PAN]');
  assert.equal(out.visible_attributes.shade, '[REDACTED_PAN]');
  assert.match(out.consumer_key, /\[REDACTED_PAN\]/);
  assert.match(out.note, /\[REDACTED_PAN\]/);
  assert.match(out.ref_line, /\[REDACTED_PAN\]/);
});

test('a real content_key is unaffected either way — it can never match PAN_RE', () => {
  // content_key is `ck_` + 32 lowercase hex (services/catalog_identity.make_content_key). PAN_RE
  // needs a word boundary before the first digit and `ck_`/hex letters are word characters, so it
  // cannot match: 0 hits across 200k random keys. Pinned so nobody "fixes" content_key by inventing
  // a fixture holding a product_key-shaped value, which is what an earlier cut of this change did.
  const key = 'ck_32de31827aded89c8d0339895b6a2786';
  assert.equal(sanitizeResult({ content_key: key }).content_key, key);
  assert.equal(sanitizeResult({ unrelated: key }).unrelated, key);
});

test('a nested array under a composite-looking key is still scanned element by element', () => {
  // The shape gate is per STRING, decided by that string's own shape, so it cannot propagate into
  // children the way a name-based exemption does.
  //
  // NOT FIXED HERE, and deliberately out of scope: the PRE-EXISTING name exemptions (`id`, `sku`,
  // `productkey`, …) still propagate `keyCanon` into array elements at unlimited depth, so
  // `product_key: ['4111111111111111']` survives today. This change stops ADDING to that surface —
  // it does not drain it. Draining it means retiring the name list in favour of this gate, which is
  // its own change with its own blast radius.
  const out = sanitizeResult({
    sku_key: ['4111111111111111', [['4111111111111111']]],
    product_key: { note: '4111111111111111' },
  });
  assert.equal(out.sku_key[0], '[REDACTED_PAN]');
  assert.equal(out.sku_key[1][0][0], '[REDACTED_PAN]');
  assert.equal(out.product_key.note, '[REDACTED_PAN]');
});
