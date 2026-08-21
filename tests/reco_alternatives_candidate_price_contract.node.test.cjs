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

// normalizeAlternativesSelectorCandidate decided "is this a price?" with a bare
// `Number.isFinite(Number(x))`. Number() maps null, '', '   ', false and [] all to 0 — and 0 IS
// finite — so a candidate carrying no price was published as a FREE product, and `price_usd: true`
// as a $1 one. Same family as the reco-prompt defect fixed in 24e15bdd2, one lane over.
//
// The shapes are caller-supplied, not hypothetical. normalizeAlternativesSelectorCandidate falls
// back to the RAW row whenever normalizeRecoCatalogProduct returns null, which it does for any row
// with no string product_id/productId/id. buildRecoAlternativesCandidatePool reads
// product.candidates[] and seven sibling lists straight off `productObj`, and `productObj` is the
// caller's own `product` — RecoAlternativesRequestSchema types it `z.record(z.string(), z.any())`,
// as DupeSuggestRequestSchema does for `original`. So an unnormalized row reaches the branch.
//
// Every row below deliberately omits product_id: that is what selects the raw-row fallback. The
// catalog-normalized path is covered separately at the bottom, and is NOT the defect — it never
// carried a scalar price_usd in the first place.
const ALTERNATIVES_PRICE_ROWS = [
  // No price, in every shape Number() silently turns into 0 (or 1).
  { label: 'price_usd_null', row: { price_usd: null }, expected: null },
  { label: 'price_usd_empty_string', row: { price_usd: '' }, expected: null },
  { label: 'price_usd_blank_string', row: { price_usd: '   ' }, expected: null },
  { label: 'price_usd_false', row: { price_usd: false }, expected: null },
  { label: 'price_usd_true', row: { price_usd: true }, expected: null },
  { label: 'price_usd_empty_array', row: { price_usd: [] }, expected: null },
  { label: 'price_usd_absent', row: {}, expected: null },
  { label: 'price_usd_not_numeric', row: { price_usd: 'free' }, expected: null },
  // A real price still passes through untouched, in both the number and the string spelling.
  { label: 'price_usd_number', row: { price_usd: 62 }, expected: 62 },
  { label: 'price_usd_numeric_string', row: { price_usd: '41.5' }, expected: 41.5 },
  // The guard keys on the no-price SHAPES above, not on falsiness: a caller that explicitly states
  // 0 is asserting a price, not omitting one. Same rule the reco prompt lane follows.
  { label: 'price_usd_explicit_zero', row: { price_usd: 0 }, expected: 0 },
];

function buildAlternativesPriceRow(entry) {
  return {
    // No product_id / productId / id anywhere: that is what makes normalizeRecoCatalogProduct
    // return null and hands the RAW row to the price branch.
    name: `Alt Price ${entry.label}`,
    brand: 'Alt Price Brand',
    category: 'serum',
    ...entry.row,
  };
}

function poolFor(internal, rows) {
  return internal.buildRecoAlternativesCandidatePool({
    sharedCandidates: [],
    productObj: { candidates: rows.map(buildAlternativesPriceRow) },
    anchorId: '',
    maxCandidates: 24,
  });
}

test('alternatives selector candidates report an unknown price as null, never a fabricated zero', () => {
  // Without this the suite goes vacuous if the table is ever emptied or the pool cap shrinks:
  // a zero-length loop asserts nothing at all.
  assert.ok(ALTERNATIVES_PRICE_ROWS.length >= 11, 'the price table must keep its shape coverage');
  assert.equal(
    ALTERNATIVES_PRICE_ROWS.filter((entry) => entry.expected === null).length,
    8,
    'the no-price half of the table must stay populated',
  );

  const { moduleId, __internal } = loadRouteInternals();
  try {
    const pool = poolFor(__internal, ALTERNATIVES_PRICE_ROWS);
    assert.equal(pool.length, ALTERNATIVES_PRICE_ROWS.length, 'every row must survive the pool builder');

    for (const [index, entry] of ALTERNATIVES_PRICE_ROWS.entries()) {
      const candidate = pool[index];
      assert.equal(candidate.name, `Alt Price ${entry.label}`, `${entry.label}: row order must match`);

      if (entry.expected === null) {
        // The whole point: no price means the key is ABSENT, not present-and-zero. Asserting
        // `price.amount !== 0` would pass on `{amount: 1}` from the `true` row, so assert the
        // omission itself.
        assert.equal(
          Object.prototype.hasOwnProperty.call(candidate, 'price'),
          false,
          `${entry.label}: a no-price row must omit price entirely, got ${JSON.stringify(candidate.price)}`,
        );
      } else {
        assert.deepEqual(
          candidate.price,
          { amount: entry.expected, currency: 'USD' },
          `${entry.label}: a stated price must survive as ${entry.expected} USD`,
        );
      }
    }
  } finally {
    delete require.cache[moduleId];
  }
});

test('a fabricated alternatives price would reach the API response, so the omission must hold there too', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    // mapSelectorCandidatesToAlternatives copies the candidate price into
    // `alternatives[].product.price`, which is the surface a client renders — this is where a
    // fabricated $0 actually does its damage. (It never reaches the alternatives PROMPT:
    // buildRecoAlternativesPromptPayload projects candidates down to a seven-field allowlist that
    // excludes price. Asserted below so that if price is ever added to the prompt payload, this
    // test says so rather than silently widening the blast radius.)
    const pool = poolFor(__internal, [
      { label: 'no_price', row: { price_usd: null }, expected: null },
      { label: 'real_price', row: { price_usd: 62 }, expected: 62 },
    ]);
    assert.equal(pool.length, 2, 'both rows must reach the mapper');

    const mapped = __internal.mapSelectorCandidatesToAlternatives(pool, {
      maxTotal: 4,
      lang: 'EN',
      reasonLine: 'Grounded alternative from the candidate pool.',
    });
    assert.equal(mapped.length, 2, 'both candidates must map to alternatives');

    const noPrice = mapped.find((row) => String(row?.product?.name || '').includes('no_price'));
    const realPrice = mapped.find((row) => String(row?.product?.name || '').includes('real_price'));
    assert.ok(noPrice && realPrice, 'both mapped rows must be identifiable by name');

    assert.equal(
      Object.prototype.hasOwnProperty.call(noPrice.product, 'price'),
      false,
      `a no-price alternative must not publish a price, got ${JSON.stringify(noPrice.product.price)}`,
    );
    assert.deepEqual(
      realPrice.product.price,
      { amount: 62, currency: 'USD' },
      'a stated price must still reach the response',
    );

    // Pin the projection: price is deliberately NOT part of the alternatives prompt today.
    // buildRecoAlternativesPromptPayload projects candidates down to a seven-field allowlist, so
    // the fabricated amount never reached the model. Asserted on the serialized query — the thing
    // the LLM actually reads — so that if price is ever added to that projection, this test says
    // so rather than letting the blast radius widen silently.
    const promptQuery = String(
      __internal.buildAuroraRecoAlternativesQuery({
        lang: 'EN',
        profileSnapshot: {},
        productInput: 'anchor serum',
        productObj: {},
        maxTotal: 3,
        region: 'US',
        candidates: pool,
        anchorId: '',
        mode: 'pool_only',
      }).query,
    );
    // Guard the guard: if the candidates never made it into the prompt at all, the two negative
    // assertions below would pass against anything.
    assert.match(promptQuery, /Alt Price real_price/, 'the candidates must actually reach the prompt');
    assert.equal(
      promptQuery.match(/"price[a-zA-Z_]*"\s*:/g),
      null,
      'no price key belongs in the alternatives prompt candidate projection',
    );
    assert.equal(
      /\b62\b/.test(promptQuery),
      false,
      'the candidate price amount must not appear in the alternatives prompt',
    );
  } finally {
    delete require.cache[moduleId];
  }
});

test('the catalog-normalized alternatives path keeps its own price object intact', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    // With a product_id present, normalizeRecoCatalogProduct succeeds and the raw-row fallback is
    // never taken — this path was already safe and must stay that way.
    const pool = __internal.buildRecoAlternativesCandidatePool({
      productObj: {
        candidates: [
          { product_id: 'cat_no_price', merchant_id: 'm1', name: 'Catalog No Price', price_usd: null },
          { product_id: 'cat_usd', merchant_id: 'm1', name: 'Catalog USD', price: { amount: 62, currency: 'USD' } },
          { product_id: 'cat_jpy', merchant_id: 'm1', name: 'Catalog JPY', price: { amount: 4500, currency: 'JPY' } },
        ],
      },
      maxCandidates: 8,
    });
    assert.equal(pool.length, 3, 'all three catalog rows must survive');

    const byId = new Map(pool.map((row) => [row.product_id, row]));
    assert.equal(
      Object.prototype.hasOwnProperty.call(byId.get('cat_no_price'), 'price'),
      false,
      'a catalog row with no readable price must omit price',
    );
    assert.equal(byId.get('cat_usd').price.amount, 62, 'a catalog USD price must survive');
    assert.equal(byId.get('cat_usd').price.currency, 'USD', 'a catalog USD price must keep its currency');
    // The currency is carried through, not relabelled: the alternatives lane holds no FX rates.
    assert.equal(byId.get('cat_jpy').price.amount, 4500, 'a catalog JPY price must survive');
    assert.equal(byId.get('cat_jpy').price.currency, 'JPY', 'a JPY price must NOT be relabelled USD');
  } finally {
    delete require.cache[moduleId];
  }
});
