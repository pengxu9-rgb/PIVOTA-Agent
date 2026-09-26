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

// Companion to tests/reco_alternatives_candidate_price_contract.node.test.cjs (#2068), which owns
// the RAW request-row scalar leg and the decision to let a stated 0 survive. Nothing here asserts
// anything about a stated zero — that contract is pinned there.
//
// normalizeAlternativesSelectorCandidate has TWO legs and both write alternatives[].product.price.
// #2068 fixed the raw leg, taken when normalizeRecoCatalogProduct returns null (any row with no
// string product_id/productId/id). A row that DOES carry an id takes the other leg —
// normalizeRecoCatalogProduct -> extractCatalogCandidatePrice -> toPositiveNumberOrNull — a
// different rule, shared with every catalog and crawl path in this file, and it carried the same
// Number() coercion underneath.
const poolPrice = (internal, row, { withId }) => internal.buildRecoAlternativesCandidatePool({
  sharedCandidates: [{
    ...(withId ? { id: 'cand_guard' } : {}),
    name: 'Guard Row', brand: 'Guard Brand', category: 'serum', ...row,
  }],
  anchorId: 'anchor_that_matches_no_candidate',
})[0]?.price;

const COERCED_SHAPES = [
  // Number(true) is 1: finite, positive, and a dollar out of nowhere.
  ['price_usd: true', { price_usd: true }],
  // Number('1e999') is Infinity, so the string falls past the fast path into the salvage that
  // strips non-numeric characters — and the exponent marker goes with them, leaving 1999.
  ["price_usd: '1e999'", { price_usd: '1e999' }],
  // A list is malformed on a field that names ONE amount in ONE currency. Number([5]) is 5 while
  // Number([5, 6]) is NaN, so a one-element list priced a product and a two-element one did not.
  ['price_usd: [5]', { price_usd: [5] }],
  ['price_usd: [5, 6]', { price_usd: [5, 6] }],
  ["price_usd: ['19.99']", { price_usd: ['19.99'] }],
];

// Emptying this table would silently hollow out the two tests that iterate it.
assert.ok(COERCED_SHAPES.length >= 5, 'the coercion table must not be emptied');

test('the id-bearing catalog leg invents no price either', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    for (const [label, row] of COERCED_SHAPES) {
      assert.equal(poolPrice(__internal, row, { withId: true }), undefined, `${label} must publish NO price`);
    }
    // A real price on that leg is untouched — the guard must reject exactly the coercions.
    assert.equal(poolPrice(__internal, { price_usd: 62 }, { withId: true })?.amount, 62, 'a stated price survives');
    assert.equal(poolPrice(__internal, { price_usd: '41.50' }, { withId: true })?.amount, 41.5, 'a numeric string survives');
  } finally {
    delete require.cache[moduleId];
  }
});

// Why this is not merely hardening. Before #2068 the catalog leg's price never reached the prompt
// at all (normalizeRecoCatalogProduct emits an object and Number({...}) is NaN), so these
// fabrications were response-only. #2068 connected that leg — correctly — and carried them into the
// prompt with it. Verified against 4b5412658: '1e999' arrived as `"price_usd": 1999`.
test('a coerced catalog price does not reach the LLM prompt', () => {
  const { moduleId, __internal } = loadRouteInternals();
  const promptPriceFor = (raw) => {
    const row = __internal.normalizeRecoCatalogProduct({
      product_id: 'p_guard', name: 'Guard Serum', brand: 'Guard Brand', category: 'serum', ...raw,
    });
    const bundle = __internal.buildAuroraProductRecommendationsPromptBundle({
      profile: {}, requestText: 'recommend a serum', lang: 'EN',
      globalStatus: { budget_known: false, itinerary_provided: false, recent_logs_provided: false },
      candidates: [row],
    });
    return bundle.user_payload.candidates[0].price_usd;
  };
  try {
    for (const [label, row] of COERCED_SHAPES) {
      const got = promptPriceFor(row);
      // Assert on the payload OBJECT, not a regex over the serialized prompt: JSON.stringify
      // renders NaN and Infinity alike as `null`, so a non-finite price reads as absent in the
      // prompt text while the object still carries it.
      assert.equal(got, null, `${label} must reach the prompt as null, got ${JSON.stringify(got)}`);
    }
    // #2068's repair must still hold: a REAL catalog price reaches the prompt.
    assert.equal(promptPriceFor({ price_usd: 41.5 }), 41.5, 'a real catalog price must still reach the prompt');
  } finally {
    delete require.cache[moduleId];
  }
});

// declaredPriceCurrencyOf takes the first VALID alias, not the first PRESENT one. That distinction
// is the whole reason it can be trusted to answer "does this holder declare a unit?" — a holder
// whose first alias is present but unparseable still declares GBP further down the list. A mutant
// swapping it to first-present survived an earlier pass because nothing exercised that shape.
test('an unparseable currency alias does not mask a valid one', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    assert.equal(
      __internal.extractCatalogCandidatePrice({ currency: 'zz', price_currency: 'GBP', price_amount: 88 })?.currency,
      'GBP',
      'a junk `currency` must not mask a valid `price_currency`',
    );
    assert.equal(
      __internal.extractCatalogCandidatePrice({ subject: { price: 88, currency: 'zz', price_currency: 'GBP' } })?.currency,
      'GBP',
      '...including on a nested carrier',
    );
    // And on the raw request-row leg, the fill must still recognise the row as declaring a unit.
    const raw = __internal.buildRecoAlternativesCandidatePool({
      sharedCandidates: [{ name: 'N', brand: 'B', category: 'serum', price: { amount: 88 }, currency: 'zz', price_currency: 'GBP' }],
      anchorId: 'anchor_that_matches_no_candidate',
    })[0]?.price;
    assert.deepEqual(raw, { amount: 88, currency: 'GBP' }, 'the raw leg fills from the valid alias, not the junk one');
  } finally {
    delete require.cache[moduleId];
  }
});

test('the shared catalog price rule invents no price, and still salvages a real one', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    for (const field of ['price', 'price_usd', 'price_cny']) {
      assert.equal(__internal.extractCatalogCandidatePrice({ [field]: true }), null, `${field}: true is not a price`);
    }
    assert.equal(
      __internal.normalizePriceObject({ amount: true, currency: 'USD' }, { fallbackCurrency: 'USD' }),
      null,
      'a boolean amount is not a price object',
    );
    assert.equal(__internal.extractCatalogCandidatePrice({ price: '1e999' }), null, 'an overflow is not $1999');
    // ...and the salvage path must still do its job, or the overflow guard has been tightened into
    // a silent price-loss bug. These are the shapes it exists for.
    for (const [text, expected] of [['$12.30', 12.3], ['12.5 USD', 12.5], ['$1,299.00', 1299], ['19.99', 19.99], ['1e5', 100000]]) {
      assert.deepEqual(
        __internal.extractCatalogCandidatePrice({ price: text }),
        { amount: expected, currency: 'USD', unknown: false },
        `${text} must still parse as ${expected}`,
      );
    }
  } finally {
    delete require.cache[moduleId];
  }
});

// The array rejection is scoped to the SCALAR row fields (readRowScalarPriceOrNull) and deliberately
// NOT pushed down into toPositiveNumberOrNull. Measured against 4b5412658, rejecting lists in the
// shared helper silently dropped real prices one level inside an offer or carrier object — and a
// null price also passes isConcernFrameworkCandidateOverBudget, which returns false when there is
// no price. These rows are the boundary: a list is malformed on `price_usd`, ordinary on a carrier.
test('a list one level inside an offer or carrier still prices the row', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    for (const [label, row, expected] of [
      ["offers:[{price:['19.99']}]", { offers: [{ price: ['19.99'], priceCurrency: 'EUR' }] }, 19.99],
      ["price_info:{price:['19.99']}", { price_info: { price: ['19.99'] } }, 19.99],
      ["sku:{offers:[{price:['19.99']}]}", { sku: { offers: [{ price: ['19.99'] }] } }, 19.99],
      ["price:{amount:['19.99']}", { price: { amount: ['19.99'] } }, 19.99],
    ]) {
      assert.equal(__internal.extractCatalogCandidatePrice(row)?.amount, expected, `${label} must still price at ${expected}`);
    }
    assert.equal(
      __internal.normalizePriceObject({ amount: ['19.99'], currency: 'EUR' }, { fallbackCurrency: 'USD' })?.amount,
      19.99,
      'a list amount on a price object must still price',
    );
    // A top-level `price` list is an offers-style carrier and the seeds loop unwraps it. Only the
    // scalar aliases reject.
    assert.equal(__internal.extractCatalogCandidatePrice({ price: ['19.99'] })?.amount, 19.99, 'a top-level price list still prices');
    assert.equal(__internal.extractCatalogCandidatePrice({ price_usd: ['19.99'] }), null, "...but price_usd names ONE amount, so a list is malformed there");
    // price_cny takes the same scoped rule. Pinned separately: the two reads are separate lines and
    // a fix applied to one is easy to miss on the other.
    assert.equal(__internal.extractCatalogCandidatePrice({ price_cny: [99] }), null, 'price_cny rejects a list too');
    // The SAME aliases read one level down, inside a price object. Without this the arbitrary split
    // the scoped rule exists to close was still live there.
    assert.equal(__internal.extractCatalogCandidatePrice({ offers: [{ price_usd: [5] }] }), null, 'price_usd inside an offer rejects a list');
    assert.equal(__internal.extractCatalogCandidatePrice({ price: { price_usd: [5] } }), null, 'price_usd inside a price object rejects a list');
    assert.equal(__internal.normalizePriceObject({ price_cny: [9] }, { fallbackCurrency: 'USD' }), null, 'price_cny inside a price object rejects a list');
    assert.equal(__internal.extractCatalogCandidatePrice({ price_cny: 99 })?.currency, 'CNY', '...while a real price_cny still prices');
  } finally {
    delete require.cache[moduleId];
  }
});

// The overflow guard sits in the JSON-LD leg of extractProductPriceFromHtml, and an `inline_price`
// regex fallback runs AFTER it over the same text. That fallback used to match a PREFIX, so
// rejecting the overflow upstream merely relocated the fabrication: `"price":"1e999"` went from a
// fabricated $1999 to a fabricated $1. Both legs are pinned here, because fixing one alone is worse
// than fixing neither — $1 is more plausible-looking, and therefore more damaging, than $1999.
test('a crawled overflow price is not laundered by the inline fallback', () => {
  const { moduleId, __internal } = loadRouteInternals();
  const page = (priceJson) =>
    `<html><body>Now $250.00</body><script type="application/ld+json">`
    + `{"@type":"Product","offers":{"@type":"Offer","priceCurrency":"USD","price":${priceJson}}}`
    + `</script></html>`;
  try {
    const overflow = __internal.extractProductPriceFromHtml(page('"1e999"'));
    assert.notEqual(overflow?.amount, 1999, 'the overflow must not be read as $1999');
    assert.notEqual(overflow?.amount, 1, 'nor laundered into $1 by the inline-price fallback');
    // What is left is the price actually visible on the page.
    assert.equal(overflow?.amount, 250, 'the on-page price is the honest answer');

    // Same fall-through with a GROUPED visible price. This is the assertion the crawler PR cannot
    // make, because the rejection that creates the fall-through lives in THIS commit: without the
    // on-page fix it lands on $129, and without the overflow guard it never falls through at all.
    const groupedVisible = '<html><body><span>$1,299.00</span></body><script type="application/ld+json">'
      + '{"@type":"Product","offers":{"@type":"Offer","priceCurrency":"USD","price":"1e999"}}</script></html>';
    assert.equal(__internal.extractProductPriceFromHtml(groupedVisible)?.amount, 1299, 'the visible price answers, not $1999 and not $129');

    // The same prefix match mis-read grouped thousands — $1 for a $1,299 product, on main today.
    const grouped = __internal.extractProductPriceFromHtml('<html><body><div>"price": "1,299.00",</div></body></html>');
    assert.equal(grouped?.amount, 1299, 'a grouped-thousands inline price must not be read as $1');

    // ...and a real inline price is still read.
    assert.equal(
      __internal.extractProductPriceFromHtml('<html><body><div>"price": "19.99",</div></body></html>')?.amount,
      19.99,
      'a plain inline price must still parse',
    );
  } finally {
    delete require.cache[moduleId];
  }
});

// #2065 established that a declared currency must not be discarded and the price stamped USD — a
// relabel serves 88 GBP as 88 USD, which reads as authoritative and defeats
// classifyRecoCandidateAgainstPriceCeiling's foreign-currency 'unknown' verdict. It landed inside
// extractCatalogCandidatePrice, so it reached the catalog leg only; the raw leg carries a bare
// `{amount: 88}` with the unit in a sibling field and needs the same answer.
test('a candidate price keeps the currency its row declares, on both legs', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    for (const withId of [true, false]) {
      const leg = withId ? 'withId' : 'withoutId';
      assert.equal(poolPrice(__internal, { price: { amount: 88 }, currency: 'GBP' }, { withId })?.currency, 'GBP', `${leg}: a sibling currency is kept`);
      assert.equal(poolPrice(__internal, { price: { amount: 88 }, price_currency: 'JPY' }, { withId })?.currency, 'JPY', `${leg}: price_currency alias`);
      // A currency the price object carries ITSELF wins — fallback, never override.
      assert.equal(
        poolPrice(__internal, { price: { amount: 88, currency: 'EUR' }, currency: 'GBP' }, { withId })?.currency,
        'EUR',
        `${leg}: the price object's own currency wins over the row's`,
      );
      // With nothing declared, the two legs answer differently BY CONSTRUCTION and both are right:
      // the catalog leg has already canonicalised the object through normalizePriceObject, whose
      // documented default is USD, while the raw leg leaves the caller's object exactly as it
      // arrived rather than inventing a unit for it.
      assert.equal(
        poolPrice(__internal, { price: { amount: 88 } }, { withId })?.currency,
        withId ? 'USD' : undefined,
        `${leg}: an undeclared unit`,
      );
      assert.equal(
        poolPrice(__internal, { price: { amount: 88 }, currency: 'not-a-code' }, { withId })?.currency,
        withId ? 'USD' : undefined,
        `${leg}: an unrecognized unit invents nothing`,
      );
      // price_usd names its own unit, so a sibling currency must NOT relabel it.
      assert.equal(poolPrice(__internal, { price_usd: 88, currency: 'GBP' }, { withId })?.currency, 'USD', `${leg}: price_usd is USD by name`);
      // A price object that states no AMOUNT is not a price, so no unit is attached to it. The fill
      // is gated on the object resolving, not merely on who declared a currency.
      for (const nonPrice of [{}, { unknown: true }, { amount: true }]) {
        const got = poolPrice(__internal, { price: { ...nonPrice }, currency: 'GBP' }, { withId });
        assert.equal(got?.currency, undefined, `${leg}: no unit is attached to ${JSON.stringify(nonPrice)}`);
      }
      // The amount is never touched by the currency repair.
      assert.equal(poolPrice(__internal, { price: { amount: 88 }, currency: 'GBP' }, { withId })?.amount, 88, `${leg}: amount unchanged`);
      // A price object declaring its own currency in ANY spelling the fill accepts must be left
      // alone. Testing only `.currency` let the other four be overwritten with USD — and USD then
      // won downstream, because normalizePriceObject reads `currency ?? currency_code ?? ...`.
      for (const alias of ['currency', 'currency_code', 'currencyCode', 'price_currency', 'priceCurrency']) {
        const got = poolPrice(__internal, { price: { amount: 88, [alias]: 'GBP' }, currency: 'USD' }, { withId });
        // The catalog leg canonicalises the object through normalizePriceObject, so read the
        // EFFECTIVE unit the way every downstream consumer does rather than the literal key.
        const effective = got.currency ?? got.currency_code ?? got.currencyCode ?? got.price_currency ?? got.priceCurrency;
        assert.equal(effective, 'GBP', `${leg}: ${alias} must survive as the effective currency`);
        assert.notEqual(effective, 'USD', `${leg}: ${alias} must not be relabelled USD by the row`);
      }
      // Nothing declares a unit anywhere: the object must come back untouched, with no currency key
      // invented. A fallback that always resolves would make a previously-unevaluable price
      // evaluable by a price-ceiling reader.
      if (!withId) {
        assert.deepEqual(poolPrice(__internal, { price: { amount: 88 } }, { withId }), { amount: 88 }, `${leg}: no unit is invented`);
        assert.deepEqual(poolPrice(__internal, { price: { amount: 88 }, currency: 'not-a-code' }, { withId }), { amount: 88 }, `${leg}: junk invents nothing`);
      }
    }
    // The hoisted helper is called with THREE different holders — the row, and each nested carrier.
    // The most plausible slip in a hoist is passing `base` where `holder` was meant, which silently
    // reinstates the #2065 relabel one level down. Pinned here because the hoist is this PR's hunk,
    // rather than relying on the sibling suite to catch it.
    for (const [carrier, expected] of [['subject', 'GBP'], ['sku', 'JPY'], ['product', 'EUR']]) {
      const currency = { subject: 'GBP', sku: 'JPY', product: 'EUR' }[carrier];
      assert.deepEqual(
        __internal.extractCatalogCandidatePrice({ [carrier]: { price: 88, currency } }),
        { amount: 88, currency: expected, unknown: false },
        `a nested ${carrier} carrier keeps its OWN declared currency`,
      );
    }
  } finally {
    delete require.cache[moduleId];
  }
});
