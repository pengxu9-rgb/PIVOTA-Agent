const test = require('node:test');
const assert = require('node:assert/strict');

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';

function loadRouteInternals() {
  const moduleId = require.resolve('../src/auroraBff/routes');
  delete require.cache[moduleId];
  const { __internal } = require('../src/auroraBff/routes');
  return { moduleId, __internal };
}

// extractProductPriceFromHtml's `inline_price` leg scrapes `"price": <number>` out of raw page
// text. Its pattern was `[0-9]+(?:\.[0-9]{1,2})?`, which matched a PREFIX and stopped at the first
// character it did not recognise — so an ordinary grouped-thousands price in embedded product JSON
// was read three orders of magnitude low. This is the user-facing "analyze this product URL" path
// (buildProductAnalysisFromUrlIngredients), and the result becomes the anchor price.
const inline = (frag) => `<html><body><div>${frag}</div></body></html>`;

test('the inline price reader does not read a prefix of the number', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    // The defect: $1 for a $1,299 product.
    assert.equal(
      __internal.extractProductPriceFromHtml(inline('"price": "1,299.00",'))?.amount,
      1299,
      'a grouped-thousands price must not be read as $1',
    );
    // The same prefix match turned an exponent into $1. No price beats a wrong one.
    assert.equal(
      __internal.extractProductPriceFromHtml(inline('"price": "1e999",'))?.amount ?? null,
      null,
      'an overflow must not be read as $1',
    );
    // ...and the repair must not overshoot in the other direction. toPositiveNumberOrNull's fast
    // path strips EVERY comma as a thousands separator, so a capture that swallowed any comma would
    // hand it `19,99` — an ordinary EU/LatAm decimal comma — and get 1999 back. Inflating a price
    // 100x is worse than the truncation this fixes, so a comma is only consumed where it can only
    // be grouping, and these fall through to the meta and on-page readers instead.
    for (const frag of ['"price":"19,99"', '"price": "24,90"', '"price":"129,90"', '"price": "1,2"', '"price": "1,2345"']) {
      assert.equal(
        __internal.extractProductPriceFromHtml(inline(frag))?.amount ?? null,
        null,
        `${frag} must not be inflated by stripping a decimal comma`,
      );
    }
    // A leading comma is not a number.
    assert.equal(__internal.extractProductPriceFromHtml(inline('"price": ,99'))?.amount ?? null, null, 'a leading comma is not a price');
    // The lookahead rejects a number that CONTINUES — a second decimal point, more digits, an
    // exponent — rather than reporting the prefix it happened to consume.
    for (const frag of ['"price": 1.2.3', '"price":1299e5', '"price": 12.34.56']) {
      assert.equal(
        __internal.extractProductPriceFromHtml(inline(frag))?.amount ?? null,
        null,
        `${frag} must not report a truncated prefix`,
      );
    }
    // ...but it must key on a DIGIT following, not on the punctuation alone. A price in prose ends
    // with a full stop and an unquoted JSON number with a comma; rejecting those outright threw
    // away real prices.
    for (const [frag, expected] of [
      ['"price": 19.99. Free shipping', 19.99],
      ['"price": 1299.', 1299],
      ['"price": 19.99,', 19.99],
    ]) {
      assert.equal(
        __internal.extractProductPriceFromHtml(inline(frag))?.amount,
        expected,
        `${frag} must still parse as ${expected}`,
      );
    }
  } finally {
    delete require.cache[moduleId];
  }
});

test('the inline price reader still reads every ordinary shape', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    // A guard that rejects too much is as wrong as one that rejects too little. The unquoted and
    // trailing-garbage forms are deliberate: embedded JSON is not always well-formed, and this leg
    // exists precisely to salvage from text.
    for (const [frag, expected] of [
      ['"price": "19.99",', 19.99],
      ['"price":"19.99"}', 19.99],
      ['"price": 19.99,', 19.99],
      ['"price":19.99}', 19.99],
      ['"price" : "45.00" ,', 45],
      ['"price":"45"', 45],
      ['"price": 45}', 45],
      ['"price": 19.99 garbage', 19.99],
      ['"price": "19.99" garbage', 19.99],
      ['"priceCurrency": "USD", "price": "88.00"}', 88],
      ['"price": "1,299.00",', 1299],
      ['"price": "12,345,678.90",', 12345678.9],
      // 3+ decimals must still parse (rounded, not truncated). Nothing pinned this, and a mutant
      // capping the decimals at {1,2} rejected every one of them while the suite stayed green.
      ['"price": "19.999",', 20],
      ['"price": "12.3456",', 12.35],
      // The key match is case-insensitive; a mutant dropping /i was invisible.
      ['"PRICE": "1,299.00",', 1299],
      ['"Price": "19.99",', 19.99],
    ]) {
      assert.equal(
        __internal.extractProductPriceFromHtml(inline(frag))?.amount,
        expected,
        `${frag} must parse as ${expected}`,
      );
    }
  } finally {
    delete require.cache[moduleId];
  }
});

// The on-page reader carried the SAME prefix defect, and this change routes more traffic into it:
// rejecting a fabricated JSON-LD price falls through to here. `[0-9]{1,4}(?:[.,][0-9]{1,2})?`
// matched `1,29` of `$1,299.00` and reported $129.
test('the on-page price reader does not read a prefix either', () => {
  const { moduleId, __internal } = loadRouteInternals();
  const page = (body) => `<html><body>${body}</body></html>`;
  try {
    for (const [body, expected] of [
      ['<span>$1,299.00</span>', 1299],
      ['<span>$12,499.00</span>', 12499],
      ['<span>$250.00</span>', 250],
      ['<span>1299.00 USD</span>', 1299],
      ['<span>1,299.00 USD</span>', 1299],
    ]) {
      assert.equal(__internal.extractProductPriceFromHtml(page(body))?.amount, expected, `${body} must read as ${expected}`);
    }
    // The fall-through case that motivates this — a page whose JSON-LD price is rejected upstream,
    // leaving the visible price to answer — is asserted in the reco suite that adds that rejection.
    // Here the JSON-LD reader still answers first, so the on-page leg is driven directly.
  } finally {
    delete require.cache[moduleId];
  }
});

test('the other price readers are untouched', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const ld = '<html><script type="application/ld+json">'
      + '{"@type":"Product","offers":{"@type":"Offer","price":"19.99","priceCurrency":"USD"}}</script></html>';
    const got = __internal.extractProductPriceFromHtml(ld);
    assert.equal(got?.amount, 19.99, 'JSON-LD still parses');
    assert.equal(got?.source, 'json_ld_offer', 'and is still answered by the JSON-LD reader');
    assert.equal(
      __internal.extractProductPriceFromHtml('<html><head><meta property="product:price:amount" content="42.50"></head></html>')?.amount,
      42.5,
      'the meta-tag reader still parses',
    );
    assert.equal(
      __internal.extractProductPriceFromHtml('<html><body>Now $250.00</body></html>')?.amount,
      250,
      'the on-page text reader still parses',
    );
  } finally {
    delete require.cache[moduleId];
  }
});
