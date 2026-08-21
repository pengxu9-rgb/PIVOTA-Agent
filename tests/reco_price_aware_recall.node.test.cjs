'use strict';

// RECALL WAS PRICE-BLIND.
//
// Live 2026-08-21: the founder's probe for "a gentle exfoliant for sensitive skin under $40" with
// constraints {price_max: 40} returned 3 grounded items priced 45/45/60 USD -- honestly flagged as
// violations by the bridge's deterministic gate, but still the entire shortlist -- while the catalog
// held 40+ conforming products at or under 40 USD (measured directly: catalog_products JOIN
// catalog_offers, merchant_effective_price <= 40; e.g. "AXIS-Y PHA Resurfacing Glow Peel" at 6 USD,
// the near-exact product the LLM used to invent as an archetype).
//
// The ceiling was parsed in src/agentSignals/recommendProducts.js (extractPriceMax) and reached the
// lane only as PROSE inside buildAsk. The recall plan, the loopback search and the pool selection
// never saw it, so the ~5-candidate pool was pure relevance -- premium-brand-heavy -- and the gate
// downstream could only flag what recall had already decided.
//
// The rule under test is BIAS, NOT CENSORSHIP: conforming candidates fill the pool first, nothing is
// ever dropped, and an all-violating catalog must still answer with flagged near-misses rather than
// zero results.

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';
process.env.AURORA_BFF_PDP_CORE_PREFETCH_ENABLED = 'false';
process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
process.env.API_MODE = 'REAL';
process.env.PIVOTA_API_BASE = 'http://127.0.0.1:4599';
process.env.PIVOTA_API_KEY = `ak_${'a'.repeat(64)}`;
delete process.env.DATABASE_URL;

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RECO_PRICE_CEILING_KNOWN_CURRENCIES,
  normalizeRecoPriceCeiling,
  formatRecoPriceCeilingCacheToken,
  readRecoCandidatePriceForCeiling,
  classifyRecoCandidateAgainstPriceCeiling,
  applyRecoPriceCeilingPreference,
  shouldSendPriceCeilingOnQueryArm,
} = require('../src/auroraBff/recoPriceCeiling');
const {
  finalizeRecommendationCandidatePools,
} = require('../src/auroraBff/recommendationSharedStack');
const { buildRecoRecallPoolCacheKey } = require('../src/auroraBff/recoRecallPoolCache');
const { __internal } = require('../src/auroraBff/routes');
const { buildFindProductsMultiPayloadFromQuery } = require('../src/server')._debug;

const USD40 = Object.freeze({ limit: 40, currency: 'USD' });

// The founder's exact pool: three premium items the lane actually returned, plus two conforming
// products that were in the catalog the whole time and never surfaced.
function founderPool() {
  return [
    { product_id: 'v45a', merchant_id: 'm1', name: 'Murad AHA/BHA Exfoliating Cleanser', product_type: 'treatment', price_amount: 45, currency: 'USD' },
    { product_id: 'v45b', merchant_id: 'm1', name: 'Premium Resurfacing Treatment', product_type: 'treatment', price_amount: 45, currency: 'USD' },
    { product_id: 'v60', merchant_id: 'm1', name: 'Luxury Glycolic Peel', product_type: 'treatment', price_amount: 60, currency: 'USD' },
    { product_id: 'c6', merchant_id: 'm1', name: 'AXIS-Y PHA Resurfacing Glow Peel', product_type: 'treatment', price_amount: 6, currency: 'USD' },
    { product_id: 'c17', merchant_id: 'm1', name: 'Gentle PHA Exfoliant', product_type: 'treatment', price_amount: 17, currency: 'USD' },
  ];
}

const TREATMENT_CONTEXT = Object.freeze({
  step_aware_intent: true,
  resolved_target_step: 'treatment',
  framework_roles: [],
});

const ids = (rows) => rows.map((row) => row.product_id).join(',');

// ---------------------------------------------------------------------------
// 1. The founder's case: conforming items fill the pool first
// ---------------------------------------------------------------------------

test("the founder's case: conforming items fill the shortlist, near-misses take leftovers", () => {
  const withoutCeiling = finalizeRecommendationCandidatePools(founderPool(), {
    targetContext: TREATMENT_CONTEXT,
  });
  const withCeiling = finalizeRecommendationCandidatePools(founderPool(), {
    targetContext: TREATMENT_CONTEXT,
    priceCeiling: USD40,
  });

  // This is the bug, reproduced: pure relevance takes the top 3 of a premium-heavy pool.
  assert.equal(ids(withoutCeiling.selected_recommendations), 'v45a,v45b,v60');
  // Mutant killed: reverting the conforming-first partition in finalizeRecommendationCandidatePools.
  // Both conforming items lead; the third slot is a flagged near-miss, not a fourth violation.
  assert.equal(ids(withCeiling.selected_recommendations), 'c6,c17,v45a');
  assert.equal(withCeiling.price_ceiling_conforming_count, 2);
  assert.equal(withCeiling.price_ceiling_conforming_selected_count, 2);
});

test('nothing is dropped: this is a re-ordering, not a filter', () => {
  const withoutCeiling = finalizeRecommendationCandidatePools(founderPool(), {
    targetContext: TREATMENT_CONTEXT,
  });
  const withCeiling = finalizeRecommendationCandidatePools(founderPool(), {
    targetContext: TREATMENT_CONTEXT,
    priceCeiling: USD40,
  });
  // Mutant killed: implementing the ceiling as a `.filter()`. Every count in the pool state must be
  // identical, because the same candidates are present -- only their order changed.
  for (const key of [
    'raw_candidate_count', 'viable_candidate_count', 'exact_step_viable_count',
    'same_family_viable_count', 'soft_mismatch_count', 'hard_reject_count',
    'selected_candidate_count', 'pre_llm_selected_candidate_count', 'final_selected_candidate_count',
  ]) {
    assert.equal(withCeiling[key], withoutCeiling[key], `count "${key}" changed`);
  }
  assert.deepEqual(
    withCeiling.viable_candidate_pool.map((p) => p.product_id).sort(),
    withoutCeiling.viable_candidate_pool.map((p) => p.product_id).sort(),
  );
});

test('an all-violating catalog still answers with flagged near-misses, never zero results', () => {
  const allOver = founderPool().filter((row) => row.price_amount > 40);
  const state = finalizeRecommendationCandidatePools(allOver, {
    targetContext: TREATMENT_CONTEXT,
    priceCeiling: USD40,
  });
  // Mutant killed: dropping non-conforming candidates when nothing conforms. That converts "here are
  // three near-misses, all flagged" into "No products matched" -- strictly worse than the bug.
  assert.equal(state.selected_candidate_count, 3);
  assert.equal(ids(state.selected_recommendations), 'v45a,v45b,v60');
  assert.equal(state.price_ceiling_conforming_count, 0);
});

test('relevance order is preserved WITHIN each bucket', () => {
  // c17 is listed before c6 here; the partition must not re-rank inside a bucket.
  const pool = [
    { product_id: 'v45', merchant_id: 'm1', name: 'Exfoliating Treatment', product_type: 'treatment', price_amount: 45, currency: 'USD' },
    { product_id: 'c17', merchant_id: 'm1', name: 'Exfoliating Treatment', product_type: 'treatment', price_amount: 17, currency: 'USD' },
    { product_id: 'v60', merchant_id: 'm1', name: 'Exfoliating Treatment', product_type: 'treatment', price_amount: 60, currency: 'USD' },
    { product_id: 'c6', merchant_id: 'm1', name: 'Exfoliating Treatment', product_type: 'treatment', price_amount: 6, currency: 'USD' },
  ];
  const ordered = applyRecoPriceCeilingPreference(pool, USD40);
  // Mutant killed: sorting by price instead of partitioning ('c6,c17,v45,v60' would be the giveaway).
  assert.equal(ids(ordered), 'c17,c6,v45,v60');
});

// ---------------------------------------------------------------------------
// 2. No ceiling => byte-stable
// ---------------------------------------------------------------------------

test('without a ceiling the pool state is byte-identical to today', () => {
  const before = finalizeRecommendationCandidatePools(founderPool(), { targetContext: TREATMENT_CONTEXT });
  const explicitNull = finalizeRecommendationCandidatePools(founderPool(), {
    targetContext: TREATMENT_CONTEXT,
    priceCeiling: null,
  });
  // Mutant killed: defaulting priceCeiling to anything but null, or applying the partition
  // unconditionally. The chat lane never supplies a ceiling and must not move at all.
  assert.equal(ids(explicitNull.selected_recommendations), ids(before.selected_recommendations));
  assert.equal(explicitNull.price_ceiling, null);
  assert.equal(explicitNull.price_ceiling_conforming_count, 0);
  assert.deepEqual(
    explicitNull.viable_candidate_pool.map((p) => p.product_id),
    before.viable_candidate_pool.map((p) => p.product_id),
  );
});

test('a REFUSED ceiling behaves exactly like no ceiling', () => {
  const baseline = finalizeRecommendationCandidatePools(founderPool(), { targetContext: TREATMENT_CONTEXT });
  // Mutant killed: coercing a bad ceiling instead of refusing it -- e.g. reading {limit:40,
  // currency:'XYZ'} as USD 40, which would bias recall on a unit nobody could interpret.
  for (const bad of [
    { limit: 0, currency: 'USD' },
    { limit: -5, currency: 'USD' },
    { limit: 'abc', currency: 'USD' },
    { limit: 40, currency: 'XYZ' },
    { limit: Infinity, currency: 'USD' },
    {},
    'nonsense',
  ]) {
    const state = finalizeRecommendationCandidatePools(founderPool(), {
      targetContext: TREATMENT_CONTEXT,
      priceCeiling: bad,
    });
    assert.equal(
      ids(state.selected_recommendations),
      ids(baseline.selected_recommendations),
      `refused ceiling ${JSON.stringify(bad)} changed the pool`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3. Ceiling normalization and the FX refusal
// ---------------------------------------------------------------------------

test('a ceiling normalizes to {limit, currency}, defaulting only an UNDECLARED currency', () => {
  assert.deepEqual(normalizeRecoPriceCeiling(40), { limit: 40, currency: 'USD' });
  assert.deepEqual(normalizeRecoPriceCeiling({ limit: 40 }), { limit: 40, currency: 'USD' });
  assert.deepEqual(normalizeRecoPriceCeiling({ limit: 40, currency: 'eur' }), { limit: 40, currency: 'EUR' });
  assert.deepEqual(normalizeRecoPriceCeiling({ price_max: 25, price_currency: 'GBP' }), { limit: 25, currency: 'GBP' });
  // Mutant killed: falling back to USD on a DECLARED but unknown currency. The caller told us the
  // unit and we could not read it -- applying a 40-unit cap anyway invents the comparison.
  assert.equal(normalizeRecoPriceCeiling({ limit: 40, currency: 'XYZ' }), null);
  assert.equal(normalizeRecoPriceCeiling(0), null);
  assert.equal(normalizeRecoPriceCeiling(-1), null);
  assert.equal(normalizeRecoPriceCeiling(true), null);
  assert.equal(normalizeRecoPriceCeiling(null), null);
});

test('a price in a different currency is UNKNOWN, never a violation', () => {
  // Mutant killed: comparing amounts across currencies. 4500 JPY is well under a $40 ceiling in
  // reality and far over it numerically; this lane holds no FX rates, so it must refuse both answers.
  assert.equal(classifyRecoCandidateAgainstPriceCeiling({ price_amount: 4500, currency: 'JPY' }, USD40), 'unknown');
  assert.equal(classifyRecoCandidateAgainstPriceCeiling({ price_amount: 5, currency: 'JPY' }, USD40), 'unknown');
  assert.equal(classifyRecoCandidateAgainstPriceCeiling({ price_amount: 30 }, USD40), 'unknown');
  assert.equal(classifyRecoCandidateAgainstPriceCeiling({}, USD40), 'unknown');
  assert.equal(classifyRecoCandidateAgainstPriceCeiling({ price_amount: 30, currency: 'USD' }, USD40), 'conforming');
  assert.equal(classifyRecoCandidateAgainstPriceCeiling({ price_amount: 40, currency: 'USD' }, USD40), 'conforming');
  // Mutant killed: an exclusive comparison. "under $40" with price_max 40 must admit exactly 40 --
  // the bridge's own gate is `price > ceiling.limit`.
  assert.equal(classifyRecoCandidateAgainstPriceCeiling({ price_amount: 40.01, currency: 'USD' }, USD40), 'over');
});

test('an UNKNOWN price outranks a certain violation', () => {
  const pool = [
    { product_id: 'v45', price_amount: 45, currency: 'USD' },
    { product_id: 'nop', name: 'no price at all' },
    { product_id: 'c10', price_amount: 10, currency: 'USD' },
  ];
  // THIS ASSERTION FLIPPED, on purpose. It originally pinned TWO buckets, on the reasoning that "at
  // recall time an unpriced row is not 'possibly conforming', it is unevaluable" -- true when nothing
  // downstream could resolve it.
  //
  // The premise changed: the agent bridge's live re-verification now RESOLVES unknowns before the
  // shortlist is cut. Measured live 2026-08-21 -- "price updated by live check: unknown -> 19 USD"
  // turned an unpriced Naturium exfoliant into a conforming $19 item. So an unknown is "possibly
  // conforming, and CHECKABLE" while an `over` is a certain violation nothing can rescue.
  // See the applyRecoPriceCeilingPreference doc comment for the full record.
  //
  // Mutant killed: reverting to two buckets -- the order would be c10, v45, nop again.
  assert.equal(ids(applyRecoPriceCeilingPreference(pool, USD40)), 'c10,nop,v45');
});

test('the price reader agrees with the shipped extractCatalogCandidatePrice, except where it must not', () => {
  const agree = [
    { price: { amount: 45, currency: 'USD' } },
    { price: 45, currency: 'USD' },
    { price_amount: 45, currency: 'USD' },
    { price_amount: 45, price_currency: 'usd' },
    { price: { amount: 0, currency: 'USD' } },
    { price: { amount: -3, currency: 'USD' } },
    { price_amount: '6', currency: 'USD' },
    {},
    { price: null },
  ];
  for (const shape of agree) {
    const shipped = __internal.extractCatalogCandidatePrice(shape);
    const mine = readRecoCandidatePriceForCeiling(shape);
    const norm = (v) => (v ? { amount: v.amount, currency: String(v.currency || '').toUpperCase() } : null);
    assert.deepEqual(norm(mine), norm(shipped), `disagreed on ${JSON.stringify(shape)}`);
  }

  // TWO DELIBERATE DIVERGENCES. extractCatalogCandidatePrice stamps `fallbackCurrency: 'USD'` on any
  // amount whose seed carries no currency -- correct for DISPLAY, wrong for COMPARISON, because it
  // makes "asserted USD" and "no currency at all" indistinguishable.
  // Mutant killed: reusing extractCatalogCandidatePrice as the ceiling reader.
  assert.equal(__internal.extractCatalogCandidatePrice({ price_amount: 4500, currency: 'JPY' }).currency, 'USD');
  assert.equal(readRecoCandidatePriceForCeiling({ price_amount: 4500, currency: 'JPY' }).currency, 'JPY');
  assert.equal(__internal.extractCatalogCandidatePrice({ price: { amount: 17 } }).currency, 'USD');
  assert.equal(readRecoCandidatePriceForCeiling({ price: { amount: 17 } }).currency, '');
});

test('the currency allowlist is the same list in all three places that hold one', () => {
  const bridge = require('../src/agentSignals/recommendProducts');
  // The bridge does not export its Set, so read the ceiling it produces for each code instead: a
  // currency the bridge accepts must be one this lane can also compare against, or enforcement and
  // recall would disagree about which asks are constrained.
  for (const code of RECO_PRICE_CEILING_KNOWN_CURRENCIES) {
    const extracted = bridge.extractPriceMax({ price_max: 40, price_max_currency: code });
    assert.equal(extracted && extracted.currency, code, `bridge rejected ${code}`);
    assert.ok(normalizeRecoPriceCeiling({ limit: 40, currency: code }), `recall rejected ${code}`);
    assert.equal(
      buildFindProductsMultiPayloadFromQuery({ q: 'x', max_price: '40', price_currency: code }).search.price_currency,
      code,
      `boundary rejected ${code}`,
    );
  }
  // Mutant killed: widening one list without the others (e.g. adding 'XYZ' to the boundary only).
  assert.equal(bridge.extractPriceMax({ price_max: 40, price_max_currency: 'XYZ' }).currency, 'USD');
  assert.equal(normalizeRecoPriceCeiling({ limit: 40, currency: 'XYZ' }), null);
});

// ---------------------------------------------------------------------------
// 4. Cache-key separation
// ---------------------------------------------------------------------------

test('a ceiling is a cache-key dimension: constrained and unconstrained pools never share a row', () => {
  const base = { queries: ['gentle exfoliant sensitive skin'], stepFamily: 'treatment', lang: 'EN' };
  const none = buildRecoRecallPoolCacheKey(base);
  const at40 = buildRecoRecallPoolCacheKey({ ...base, priceCeiling: USD40 });
  const at60 = buildRecoRecallPoolCacheKey({ ...base, priceCeiling: { limit: 60, currency: 'USD' } });
  const eur40 = buildRecoRecallPoolCacheKey({ ...base, priceCeiling: { limit: 40, currency: 'EUR' } });
  // Mutant killed: omitting the ceiling from the key. The pool a ceiling produces is conforming-first,
  // so a constrained call would poison the unconstrained pool -- and vice versa -- for up to 24 hours,
  // fleet-wide, with no way to tell from the row which kind it was.
  assert.notEqual(none, at40);
  assert.notEqual(at40, at60);
  assert.notEqual(at40, eur40);
  assert.match(at40, /^[0-9a-f]{64}$/);
});

test('a refused ceiling produces the SAME key as no ceiling', () => {
  const base = { queries: ['gentle exfoliant'], stepFamily: 'treatment', lang: 'EN' };
  // Mutant killed: keying on the raw ceiling instead of the normalized one -- {limit:40,
  // currency:'XYZ'} does not constrain recall, so it must not fragment the cache either.
  assert.equal(
    buildRecoRecallPoolCacheKey({ ...base, priceCeiling: { limit: 40, currency: 'XYZ' } }),
    buildRecoRecallPoolCacheKey(base),
  );
  assert.equal(buildRecoRecallPoolCacheKey({ ...base, priceCeiling: 0 }), buildRecoRecallPoolCacheKey(base));
});

test('the ceiling cache token is normalized so trivial variants share a row', () => {
  assert.equal(formatRecoPriceCeilingCacheToken({ limit: 40, currency: 'USD' }), '40usd');
  assert.equal(formatRecoPriceCeilingCacheToken({ limit: 40.0, currency: 'usd' }), '40usd');
  // Mutant killed: no rounding -- 40 and 40.00000001 would each claim their own 24h row.
  assert.equal(formatRecoPriceCeilingCacheToken({ limit: 40.00000001, currency: 'USD' }), '40usd');
  assert.equal(formatRecoPriceCeilingCacheToken(null), '');
  assert.equal(formatRecoPriceCeilingCacheToken({ limit: 40, currency: 'XYZ' }), '');
});

test('the cache version was bumped, orphaning pools built without a ceiling dimension', () => {
  const { RECO_RECALL_POOL_CACHE_VERSION } = require('../src/auroraBff/recoRecallPoolCache');
  // Mutant killed: changing pool CONTENT without a bump. v3 recorded the ceiling key dimension; v4
  // records the deeper constrained arm (~18 rows instead of 6), without which an existing ceiling'd
  // key would keep serving its shallow pool for the rest of its 24h window.
  assert.equal(RECO_RECALL_POOL_CACHE_VERSION, 'reco_recall_pool_cache_v4');
});

// ---------------------------------------------------------------------------
// 5. Transport: one arm carries the ceiling
// ---------------------------------------------------------------------------

test('only the PRIMARY query arm carries the ceiling upstream', () => {
  assert.equal(shouldSendPriceCeilingOnQueryArm({ queryIndex: 0 }), true);
  // Mutant killed: constraining every arm. The local mainline treats max_price as a HARD drop
  // (filterFindProductsMultiDirectProductsByBudget), so a ceiling on every arm turns "nothing
  // conforms" into zero results -- the failure this whole change exists to prevent.
  assert.equal(shouldSendPriceCeilingOnQueryArm({ queryIndex: 1 }), false);
  assert.equal(shouldSendPriceCeilingOnQueryArm({ queryIndex: 2 }), false);
  // Mutant killed: `Number(null) === 0` making every unlabelled arm "primary".
  assert.equal(shouldSendPriceCeilingOnQueryArm({}), false);
  assert.equal(shouldSendPriceCeilingOnQueryArm({ queryIndex: null }), false);
  assert.equal(shouldSendPriceCeilingOnQueryArm({ queryIndex: '' }), false);
  assert.equal(shouldSendPriceCeilingOnQueryArm({ queryIndex: false }), false);
  assert.equal(shouldSendPriceCeilingOnQueryArm({ queryIndex: '0' }), true);
});

// ---------------------------------------------------------------------------
// 6. The GET boundary
// ---------------------------------------------------------------------------

test('the boundary parses a positive ceiling and its currency', () => {
  const payload = buildFindProductsMultiPayloadFromQuery({
    q: 'gentle exfoliant',
    price_max: '40',
    price_currency: 'usd',
  });
  // Mutant killed: reverting the boundary hunk -- the recall client's price_max would be dropped at
  // the HTTP hop exactly like target_step_family used to be.
  assert.equal(payload.search.max_price, 40);
  assert.equal(payload.search.price_currency, 'USD');
  assert.equal(
    buildFindProductsMultiPayloadFromQuery({ q: 'x', max_price: '40', priceCurrency: 'EUR' }).search.price_currency,
    'EUR',
  );
});

test('a non-positive, non-finite or absent ceiling is DROPPED', () => {
  for (const value of ['0', '-5', 'abc', '', 'Infinity', 'NaN']) {
    const search = buildFindProductsMultiPayloadFromQuery({ q: 'x', max_price: value }).search;
    // Mutant killed: forwarding the value verbatim (today's behavior). `max_price=0` reaches a HARD
    // downstream post-filter that drops every priced product and answers zero results.
    assert.ok(!('max_price' in search), `"${value}" survived as max_price`);
  }
  const none = buildFindProductsMultiPayloadFromQuery({ q: 'x' }).search;
  assert.ok(!('max_price' in none));
  assert.ok(!('price_currency' in none));
});

test('a DECLARED but unknown currency disables the whole ceiling', () => {
  const search = buildFindProductsMultiPayloadFromQuery({
    q: 'x',
    max_price: '40',
    price_currency: 'XYZ',
  }).search;
  // Mutant killed: dropping only the currency and keeping max_price. The caller told us the unit and
  // we could not read it; applying 40 in an assumed unit is the fabrication the enforcement gate
  // already refuses ('unverifiable', never a pass).
  assert.ok(!('max_price' in search), 'max_price must not survive an unreadable currency');
  assert.ok(!('price_currency' in search));
});

test('an UNDECLARED currency leaves max_price alone: existing callers are unaffected', () => {
  const search = buildFindProductsMultiPayloadFromQuery({ q: 'x', max_price: '40' }).search;
  // Mutant killed: requiring price_currency before honouring max_price -- every caller that has been
  // sending a bare max_price would silently lose it.
  assert.equal(search.max_price, 40);
  assert.ok(!('price_currency' in search));
});

// ---------------------------------------------------------------------------
// 7. Regression: the cached pool must be finalized against THIS request
// ---------------------------------------------------------------------------

test('a cache hit is finalized against the request target context (regression from #2049)', () => {
  const pool = [
    { product_id: 'p1', merchant_id: 'm1', name: 'Gentle Cleanser', product_type: 'cleanser' },
    { product_id: 'p2', merchant_id: 'm1', name: 'Hydrating Toner', product_type: 'toner' },
  ];
  const collected = __internal.buildRecoCollectedFromCachedPool(pool, {
    targetContext: { step_aware_intent: true, resolved_target_step: 'cleanser', framework_roles: [] },
  });
  // #2049 shipped the ordinary cache-hit branch as `buildRecoCollectedFromCachedPool(pool)` with no
  // options, so every hit was finalized against targetContext=null: no step filtering at all, and a
  // cleanser request served the cached toner too. Measured before the fix: selected p1,p2 with
  // exact_step_viable_count 0.
  // Mutant killed: dropping the options at either cache-hit call site in buildRecoGenerateFromCatalog.
  assert.equal(collected.candidateState.selected_recommendations.length, 1);
  assert.equal(collected.candidateState.selected_recommendations[0].product_id, 'p1');
  assert.equal(collected.candidateState.exact_step_viable_count, 1);

  const argless = __internal.buildRecoCollectedFromCachedPool(pool);
  assert.equal(argless.candidateState.exact_step_viable_count, 0, 'the argless shape is the bug shape');
});

test('a cached pool is biased by the ceiling too', () => {
  const collected = __internal.buildRecoCollectedFromCachedPool(founderPool(), {
    targetContext: TREATMENT_CONTEXT,
    priceCeiling: USD40,
  });
  // Mutant killed: threading the ceiling into live recall but not into the cached path -- a cache hit
  // would then answer with the premium-heavy shortlist for up to 24 hours.
  assert.equal(ids(collected.candidateState.selected_recommendations), 'c6,c17,v45a');
});

// ---------------------------------------------------------------------------
// 8. The bridge: the ceiling becomes a first-class argument to the lane
// ---------------------------------------------------------------------------

const { makeRecommendProducts } = require('../src/agentSignals/recommendProducts');

function laneCall(constraints) {
  let seen = null;
  const handler = makeRecommendProducts({
    generate: async (args) => {
      seen = args;
      return { norm: { payload: { recommendations: [] } } };
    },
    isEnabled: () => true,
  });
  return handler({ payload: { need: 'a gentle exfoliant for sensitive skin', constraints } }, { agent_id: 'a' })
    .then(() => seen);
}

test('an ENFORCING ceiling reaches generate() as a structured argument', async () => {
  const seen = await laneCall({ price_max: 40 });
  // Mutant killed: reverting the bridge hunk. This is the whole chain's entry point -- without it the
  // ceiling reaches the lane only as prose inside buildAsk and recall stays price-blind.
  assert.deepEqual(seen.priceCeiling, { limit: 40, currency: 'USD' });
  assert.equal(seen.entryType, 'direct');
});

test('a declared ceiling currency travels with it', async () => {
  const seen = await laneCall({ price_max: 25, price_max_currency: 'GBP' });
  assert.deepEqual(seen.priceCeiling, { limit: 25, currency: 'GBP' });
});

test('a NON-enforcing ceiling is not threaded at all', async () => {
  // Mutant killed: passing the ceiling unconditionally. `extractPriceMax` deliberately REFUSES prose
  // and out-of-range values and reports them as `unstructured`; biasing recall on a value the
  // extractor refused would enforce something nobody could parse.
  for (const constraints of [
    {},
    { avoid: ['fragrance'] },
    { budget: 'somewhere around forty dollars' },
    { price_max: 0 },
    { price_max: [40] },
  ]) {
    const seen = await laneCall(constraints);
    assert.ok(
      !('priceCeiling' in seen),
      `priceCeiling threaded for ${JSON.stringify(constraints)}`,
    );
  }
});

test('the ceiling is still enforced after the lane answers, unchanged', async () => {
  // The bridge's post-hoc gate must keep working: this change adds a recall bias, it does not move
  // enforcement. Mutant killed: deleting the post-hoc gate on the assumption recall now guarantees it.
  const handler = makeRecommendProducts({
    generate: async () => ({
      norm: {
        payload: {
          recommendations: [
            { product_id: 'p1', merchant_id: 'm1', name: 'Over', price: { amount: 45, currency: 'USD' }, grounding_status: 'grounded' },
          ],
        },
      },
    }),
    isEnabled: () => true,
  });
  const res = await handler(
    { payload: { need: 'a gentle exfoliant', constraints: { price_max: 40 }, limit: 3 } },
    { agent_id: 'a' },
  );
  const violations = (res.signals || []).flatMap((s) => s.value?.constraint_violations || []);
  assert.equal(violations.length, 1, JSON.stringify(res.signals, null, 1));
  assert.equal(violations[0].constraint, 'price_max');
  assert.equal(violations[0].limit, 40);
});

// ---------------------------------------------------------------------------
// 9. The cache-hit CALL SITE, driven end to end through buildRecoGenerateFromCatalog
// ---------------------------------------------------------------------------

// Testing buildRecoCollectedFromCachedPool alone is not enough: #2049's bug was in how the call site
// invoked it, and a helper-level test passes happily while the caller drops every option. These drive
// the real function with the durable cache stubbed to a hit, so no upstream search is attempted.
const dbModule = require('../src/db');

async function catalogWithCachedPool(pool, extraArgs = {}) {
  const original = dbModule.query;
  dbModule.query = async (sql) => (/SELECT payload/.test(sql)
    ? { rows: [{ payload: pool, refreshed_at: new Date().toISOString() }] }
    : { rows: [], rowCount: 0 });
  try {
    return await __internal.buildRecoGenerateFromCatalog({
      ctx: { lang: 'EN' },
      profileSummary: null,
      ingredientContext: null,
      recommendationTaskContext: null,
      targetContext: TREATMENT_CONTEXT,
      needSeedText: 'a gentle exfoliant for sensitive skin',
      maxGenericQueries: 3,
      debug: false,
      logger: null,
      ...extraArgs,
    });
  } finally {
    dbModule.query = original;
  }
}

test('the cache-hit CALL SITE applies this request target context', async () => {
  const out = await catalogWithCachedPool([
    { product_id: 'p1', merchant_id: 'm1', name: 'Gentle Exfoliating Treatment', product_type: 'treatment', price_amount: 30, currency: 'USD' },
    { product_id: 'p2', merchant_id: 'm1', name: 'Hydrating Toner', product_type: 'toner', price_amount: 20, currency: 'USD' },
  ]);
  assert.equal(out.debug.pool_cache_outcome, 'hit', JSON.stringify(out.debug.skipped_reason || ''));
  // Mutant killed: the #2049 shape, `buildRecoCollectedFromCachedPool(cachedEntry.pool)` with no
  // options. Every cache hit was then finalized against targetContext=null, so a treatment request
  // served the cached toner as an equal candidate.
  assert.equal(out.candidate_pool_state.exact_step_viable_count, 1);
  assert.equal(out.candidate_pool_state.selected_recommendations.length, 1);
  assert.equal(out.candidate_pool_state.selected_recommendations[0].product_id, 'p1');
});

test('the cache-hit CALL SITE applies the price ceiling', async () => {
  const out = await catalogWithCachedPool(founderPool(), { priceCeiling: USD40 });
  assert.equal(out.debug.pool_cache_outcome, 'hit');
  // Mutant killed: threading the ceiling into live recall but not into the cached path.
  assert.deepEqual(out.debug.price_ceiling, USD40);
  assert.equal(
    ids(out.candidate_pool_state.selected_recommendations),
    'c6,c17,v45a',
  );
});

test('the cache-hit CALL SITE is unchanged when no ceiling is supplied', async () => {
  const out = await catalogWithCachedPool(founderPool());
  assert.equal(out.debug.price_ceiling, null);
  // Mutant killed: defaulting the ceiling anywhere along the thread.
  assert.equal(
    ids(out.candidate_pool_state.selected_recommendations),
    'v45a,v45b,v60',
  );
});

// ---------------------------------------------------------------------------
// 10. The mainline threads the ceiling into BOTH recall branches
// ---------------------------------------------------------------------------

const {
  createLegacyRecoMainlineExecutionRuntime,
} = require('../src/auroraBff/legacyRecoMainlineExecution');

function mainlineWith(args = {}) {
  const catalogCalls = [];
  const deps = {
    pickFirstTrimmed: (...v) => v.map((x) => String(x == null ? '' : x).trim()).find(Boolean) || '',
    isPlainObject: (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v),
    finalizeConcernFrameworkCandidatePools: () => ({ selected_recommendations: [] }),
    finalizeRecommendationCandidatePools: () => ({ selected_recommendations: [] }),
    buildRecoGenerateFromCatalog: async (a) => {
      catalogCalls.push(a);
      return {
        structured: { recommendations: [{ product_id: 'c6' }] },
        candidate_pool: [{ product_id: 'c6', price_amount: 6, currency: 'USD' }],
        candidate_pool_state: { selected_candidate_count: 1, terminal_success: true },
        debug: { ok_count: 1 },
      };
    },
    deriveRecoPdpFastFallbackReasonCode: () => null,
    buildRecoLlmPromptState: () => ({
      promptBundle: { prompt_spec: {}, schema_chars: 0 },
      query: 'q',
      promptContract: { ok: true, issues: [] },
      llmTraceSeed: {},
    }),
    runRecoLlmPrimary: async () => ({
      upstream: null, contextMeta: {}, upstreamFailureCode: '', llmFailureClass: '', llmLatencyMs: 1,
      answerJson: null, llmStructured: { recommendations: [{ name: 'archetype' }] },
      llmStructuredSource: 'llm_primary', llmTrace: {}, llmInvoked: true, initialLlmOutcome: 'success',
    }),
    resolveConcernMainlineFailure: () => ({}),
    resolveRecoEffectiveFailure: () => ({}),
    normalizeRecoFailureClass: (v) => String(v || '').toLowerCase(),
    hasEmptyStructuredRecommendations: (s) => !s || !Array.isArray(s.recommendations) || !s.recommendations.length,
    shouldUseRecoCatalogTransientFallback: () => false,
    buildRecoCatalogTransientFallbackStructured: () => null,
    recordAuroraRecoLlmCall: () => {},
  };
  const { runLegacyRecoMainlineExecution } = createLegacyRecoMainlineExecutionRuntime(deps);
  return runLegacyRecoMainlineExecution({
    frameworkCatalogFirstEnabled: false,
    deterministicCatalogFirstEnabled: false,
    targetContext: TREATMENT_CONTEXT,
    recommendationTaskContext: null,
    profileSummary: null,
    normalizedIngredientContext: null,
    ctx: { lang: 'EN' },
    entryType: 'direct',
    userAsk: 'a gentle exfoliant for sensitive skin under $40',
    prefix: '',
    recentLogs: [],
    globalStatus: {},
    mainlineStageTimingsMs: {},
    ...args,
  }).then(() => catalogCalls);
}

test('the direct-lane pre-LLM recall receives the ceiling', async () => {
  const calls = await mainlineWith({ priceCeiling: USD40 });
  assert.equal(calls.length, 1);
  // Mutant killed: dropping priceCeiling from the Branch B pre-LLM buildRecoGenerateFromCatalog call.
  // That is the call that builds the pool the LLM sees, so a ceiling that misses it changes nothing
  // about the shortlist the buyer gets.
  assert.deepEqual(calls[0].priceCeiling, USD40);
  assert.equal(calls[0].needSeedText, 'a gentle exfoliant for sensitive skin under $40');
});

test('the step-aware catalog-first branch receives the ceiling', async () => {
  const calls = await mainlineWith({ priceCeiling: USD40, deterministicCatalogFirstEnabled: true });
  assert.equal(calls.length, 1);
  // Mutant killed: threading the ceiling into Branch B only. Branch A is the step-aware/framework
  // catalog-first path and needs the same bias.
  assert.deepEqual(calls[0].priceCeiling, USD40);
});

test('without a ceiling the mainline passes none, on either branch', async () => {
  for (const deterministicCatalogFirstEnabled of [false, true]) {
    const calls = await mainlineWith({ deterministicCatalogFirstEnabled });
    // Mutant killed: defaulting priceCeiling to anything but null in the mainline signature.
    assert.equal(calls[0].priceCeiling, null, `branch deterministic=${deterministicCatalogFirstEnabled}`);
  }
});
