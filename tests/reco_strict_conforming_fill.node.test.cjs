'use strict';

// STRICT FILL: when the catalog holds enough conforming products, every shortlist slot gets one.
//
// Live probe 2026-08-21, PRICE_MAX=40, "gentle exfoliant for sensitive skin":
//
//   The Ordinary  $5.16  conforming
//   Naturium      $19    UNKNOWN at selection time (no catalog price), rescued post-hoc by the live
//                        price check -- "price updated by live check: unknown -> 19 USD"
//   OleHenriksen  $62    flagged VIOLATES
//
// At selection the pool held exactly ONE known-conforming candidate, so the partition's
// `viable.slice(0, 3)` filled two slots from the unconstrained supplemental legs and the LLM kept all
// three. Conforming stock existed the whole time.
//
// Three changes, all gated on an enforcing ceiling:
//   1. DEPTH   -- the arm that carries the ceiling asks the upstream for ~18 rows, not 6, because the
//                 upstream hard-filters that arm and needs material to keep.
//   2. BUCKETS -- conforming > unknown > over (was two buckets; see the module comment for why the
//                 justification flipped).
//   3. TOP-UP  -- if the answer holds fewer than `shortlistTarget` conforming recommendations and the
//                 catalog can supply more, append the lane's OWN catalog rows before the tail.
//
// An all-violating catalog still answers with flagged near-misses. Never zero, never padded.

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';
process.env.AURORA_BFF_PDP_CORE_PREFETCH_ENABLED = 'false';
process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
process.env.PIVOTA_BACKEND_BASE_URL = 'https://pivota-backend.test';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyRecoPriceCeilingPreference,
  classifyRecoCandidateAgainstPriceCeiling,
  selectRecoPriceCeilingTopUpRows,
  recoRowIdentityKey,
} = require('../src/auroraBff/recoPriceCeiling');
const { applyStrictConformingTopUp } = require('../src/auroraBff/legacyRecoMainlineExecution');
const { RECO_RECALL_POOL_CACHE_VERSION } = require('../src/auroraBff/recoRecallPoolCache');
const { __internal } = require('../src/auroraBff/routes');
const dbModule = require('../src/db');

const USD40 = Object.freeze({ limit: 40, currency: 'USD' });
const ids = (rows) => rows.map((r) => r.product_id).join(',');

function catalogRow(product_id, price_amount, name) {
  return {
    product_id,
    merchant_id: 'm1',
    name,
    display_name: name,
    product_type: 'treatment',
    ...(price_amount == null ? {} : { price_amount, currency: 'USD' }),
  };
}

// The founder's own products.
const ORDINARY = catalogRow('c516', 5.16, 'The Ordinary Lactic Acid 5%');
const NATURIUM = catalogRow('c19', 19, 'Naturium PHA Exfoliant');
const COSRX = catalogRow('c23', 23, 'COSRX AHA/BHA Clarifying Serum');
const OLEHENRIKSEN = catalogRow('o62', 62, 'OleHenriksen Dewtopia Peel');
const NATURIUM_UNPRICED = catalogRow('c19', null, 'Naturium PHA Exfoliant');

/** Drive the REAL buildRecoGenerateFromCatalog with the durable pool cache stubbed to a hit. */
async function catalogFromPool(pool, extra = {}) {
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
      targetContext: { step_aware_intent: true, resolved_target_step: 'treatment', framework_roles: [] },
      needSeedText: 'a gentle exfoliant for sensitive skin under $40',
      maxGenericQueries: 3,
      debug: false,
      logger: null,
      ...extra,
    });
  } finally {
    dbModule.query = original;
  }
}

// ---------------------------------------------------------------------------
// 1. The founder's case, end to end through the real catalog builder
// ---------------------------------------------------------------------------

test("supply of 3 conforming: the shortlist fills 3/3 even when the LLM returns 1", async () => {
  const out = await catalogFromPool(
    [OLEHENRIKSEN, NATURIUM, ORDINARY, COSRX],
    { priceCeiling: USD40 },
  );
  const catalogStructured = out.structured;
  assert.ok(catalogStructured, 'the catalog must produce an answer');

  // The LLM keeps only one of them -- the shape of the live run.
  const llmAnswer = { recommendations: [{ ...ORDINARY, price: { amount: 5.16, currency: 'USD' } }] };
  const topUp = applyStrictConformingTopUp({
    structured: llmAnswer,
    catalogStructured,
    priceCeiling: USD40,
    shortlistTarget: 3,
  });

  // Mutant killed: removing the top-up from the engine, or gating it on something other than the
  // conforming count. One conforming item was the entire answer while conforming stock existed.
  assert.equal(topUp.appendedCount, 2);
  const conforming = topUp.structured.recommendations.filter(
    (r) => classifyRecoCandidateAgainstPriceCeiling(r, USD40) === 'conforming',
  );
  assert.equal(conforming.length, 3, ids(topUp.structured.recommendations));
  // Mutant killed: appending non-conforming filler to reach the target.
  for (const row of topUp.appended) {
    assert.equal(classifyRecoCandidateAgainstPriceCeiling(row, USD40), 'conforming');
  }
});

test('supply of 2 conforming: 2 conforming, and the leftover slot keeps a flagged near-miss', async () => {
  const out = await catalogFromPool([OLEHENRIKSEN, NATURIUM, ORDINARY], { priceCeiling: USD40 });
  const llmAnswer = {
    recommendations: [
      { ...ORDINARY, price: { amount: 5.16, currency: 'USD' } },
      { ...OLEHENRIKSEN, price: { amount: 62, currency: 'USD' } },
    ],
  };
  const topUp = applyStrictConformingTopUp({
    structured: llmAnswer,
    catalogStructured: out.structured,
    priceCeiling: USD40,
    shortlistTarget: 3,
  });
  const rows = topUp.structured.recommendations;
  const conforming = rows.filter((r) => classifyRecoCandidateAgainstPriceCeiling(r, USD40) === 'conforming');
  // Mutant killed: padding to the target with whatever is left. Conforming supply is 2, so the answer
  // holds 2 conforming; the $62 near-miss KEEPS the leftover slot rather than being displaced by junk.
  assert.equal(conforming.length, 2, ids(rows));
  assert.equal(topUp.appendedCount, 1);
  assert.ok(rows.some((r) => r.product_id === 'o62'), 'the flagged near-miss must survive');
});

test('an ALL-VIOLATING catalog appends nothing and never empties the answer', async () => {
  const out = await catalogFromPool([OLEHENRIKSEN, catalogRow('o80', 80, 'Luxury Peel')], { priceCeiling: USD40 });
  const llmAnswer = { recommendations: [{ ...OLEHENRIKSEN, price: { amount: 62, currency: 'USD' } }] };
  const topUp = applyStrictConformingTopUp({
    structured: llmAnswer,
    catalogStructured: out.structured,
    priceCeiling: USD40,
    shortlistTarget: 3,
  });
  // Mutant killed: treating "cannot reach the target" as a reason to drop or replace the answer. A
  // flagged near-miss is a worse answer than a conforming product and a far better one than zero.
  assert.equal(topUp.appendedCount, 0);
  assert.equal(topUp.structured, llmAnswer, 'the answer object must be returned untouched');
  assert.equal(topUp.structured.recommendations.length, 1);
});

// ---------------------------------------------------------------------------
// 2. Three buckets: conforming > unknown > over
// ---------------------------------------------------------------------------

test('an UNKNOWN price now outranks a certain violation', () => {
  const pool = [OLEHENRIKSEN, NATURIUM_UNPRICED, ORDINARY];
  // Mutant killed: reverting to #2057's two buckets. That put a certain violation ($62, which nothing
  // downstream can rescue) ahead of a checkable unknown -- and the live price check DOES rescue
  // unknowns now ("price updated by live check: unknown -> 19 USD"), which is why the choice flipped.
  assert.equal(ids(applyRecoPriceCeilingPreference(pool, USD40)), 'c516,c19,o62');
});

test('the partition is stable within every bucket and drops nothing', () => {
  const pool = [
    OLEHENRIKSEN,
    catalogRow('u1', null, 'Unknown A'),
    COSRX,
    catalogRow('o80', 80, 'Over B'),
    catalogRow('u2', null, 'Unknown B'),
    ORDINARY,
  ];
  const ordered = applyRecoPriceCeilingPreference(pool, USD40);
  // Mutant killed: sorting by price or verdict rank instead of partitioning -- relevance order inside
  // each bucket is the ranking this lane already computed.
  assert.equal(ids(ordered), 'c23,c516,u1,u2,o62,o80');
  assert.equal(ordered.length, pool.length);
});

test('with NO ceiling the partition returns the input order, element for element', () => {
  const pool = [OLEHENRIKSEN, NATURIUM_UNPRICED, ORDINARY];
  // Mutant killed: applying the three-bucket order unconditionally. The chat lane never supplies a
  // ceiling and must not move.
  assert.equal(ids(applyRecoPriceCeilingPreference(pool, null)), ids(pool));
  assert.equal(ids(applyRecoPriceCeilingPreference(pool, { limit: 40, currency: 'XYZ' })), ids(pool));
});

// ---------------------------------------------------------------------------
// 3. Depth on the constrained arm
// ---------------------------------------------------------------------------

async function armRequest({ queryIndex, priceCeiling, limit = 6 }) {
  const seen = [];
  await __internal.executeRecoRecallPlanEntry({
    entry: { query: 'exfoliant', source_scope: 'internal' },
    logger: null,
    timeoutMs: 5000,
    limit,
    targetContext: { step_aware_intent: true, resolved_target_step: 'treatment', framework_roles: [] },
    queryIndex,
    queryTotal: 3,
    priceCeiling,
    searchFn: async (params) => {
      seen.push(params);
      return { ok: true, products: [], latency_ms: 1 };
    },
  });
  return seen[0];
}

test('the arm that carries the ceiling asks the upstream for MORE rows', async () => {
  const constrained = await armRequest({ queryIndex: 0, priceCeiling: USD40 });
  // Mutant killed: reverting the depth hunk. The upstream hard-filters this arm, so a request limit
  // of 6 leaves it almost nothing to keep -- which is how the live run reached selection with one
  // known-conforming candidate.
  assert.equal(constrained.limit, 18);
  assert.deepEqual(constrained.priceCeiling, USD40);
});

test('unconstrained arms keep their existing depth exactly', async () => {
  const secondArm = await armRequest({ queryIndex: 1, priceCeiling: USD40 });
  const noCeiling = await armRequest({ queryIndex: 0, priceCeiling: null });
  // Mutant killed: raising the limit for every arm. Depth is only justified where a hard filter is
  // about to remove most of the rows; everywhere else it is pure upstream load.
  assert.equal(secondArm.limit, 6);
  assert.equal(secondArm.priceCeiling, undefined);
  assert.equal(noCeiling.limit, 6);
  assert.equal(noCeiling.priceCeiling, undefined);
});

test('depth never NARROWS an arm that already asked for more', async () => {
  const wide = await armRequest({ queryIndex: 0, priceCeiling: USD40, limit: 24 });
  // Mutant killed: assigning the env value instead of taking the max -- a caller that deliberately
  // asked for 24 rows would silently get 18.
  assert.equal(wide.limit, 24);
});

// ---------------------------------------------------------------------------
// 4. Top-up selection: dedupe, bounds, no-ceiling stability
// ---------------------------------------------------------------------------

test('a product the LLM already recommended is never appended twice', () => {
  const answer = [{ ...NATURIUM, price: { amount: 19, currency: 'USD' } }];
  const appended = selectRecoPriceCeilingTopUpRows({
    recommendations: answer,
    catalogRows: [NATURIUM, ORDINARY, COSRX],
    ceiling: USD40,
    target: 3,
  });
  // Mutant killed: dropping the dedupe set. The catalog rows and the LLM answer routinely name the
  // same products -- the shortlist would show Naturium twice.
  assert.equal(ids(appended), 'c516,c23');
});

test('dedupe recognises the same product across id shapes', () => {
  assert.equal(
    recoRowIdentityKey({ product_id: 'p1', merchant_id: 'm1' }),
    recoRowIdentityKey({ productId: 'p1', merchantId: 'm1' }),
  );
  // ONE namespace for the (merchant, product) pair. Mutant killed: keying a canonical_product_ref
  // into its own namespace -- a catalog-built row carries the ref AND the flat ids while an LLM row
  // carries only the flat ids, so the same product looked like two and got appended twice.
  assert.equal(
    recoRowIdentityKey({ product_id: 'p1', merchant_id: 'm1' }),
    recoRowIdentityKey({ product_id: 'p1', merchant_id: 'm1', canonical_product_ref: { product_id: 'p1', merchant_id: 'm1' } }),
  );
  assert.equal(
    recoRowIdentityKey({ canonical_product_ref: { product_id: 'p1', merchant_id: 'm1' } }),
    recoRowIdentityKey({ product_id: 'p1', merchant_id: 'm1' }),
  );
  // An ungrounded LLM row carries no ids at all; the display name is what stops it duplicating itself.
  // Mutant killed: returning '' for id-less rows -- every such row would look distinct from itself.
  assert.equal(recoRowIdentityKey({ name: 'Gentle Exfoliant' }), 'name:gentle exfoliant');
  assert.equal(recoRowIdentityKey({}), '');
  assert.equal(recoRowIdentityKey(null), '');
});

test('the top-up appends exactly the shortfall, never more', () => {
  const answer = [{ ...ORDINARY, price: { amount: 5.16, currency: 'USD' } }];
  const catalogRows = [NATURIUM, COSRX, catalogRow('c30', 30, 'Fourth'), catalogRow('c31', 31, 'Fifth')];
  // Mutant killed: appending every conforming catalog row. The shortlist would blow past the caller's
  // limit and the extra rows would be cut arbitrarily downstream.
  assert.equal(selectRecoPriceCeilingTopUpRows({ recommendations: answer, catalogRows, ceiling: USD40, target: 3 }).length, 2);
  assert.equal(selectRecoPriceCeilingTopUpRows({ recommendations: answer, catalogRows, ceiling: USD40, target: 2 }).length, 1);
  assert.equal(selectRecoPriceCeilingTopUpRows({ recommendations: answer, catalogRows, ceiling: USD40, target: 1 }).length, 0);
});

test('an UNKNOWN-price catalog row is never used as top-up material', () => {
  const appended = selectRecoPriceCeilingTopUpRows({
    recommendations: [],
    catalogRows: [NATURIUM_UNPRICED, catalogRow('u2', null, 'Also unpriced')],
    ceiling: USD40,
    target: 3,
  });
  // Mutant killed: treating 'unknown' as conforming for the top-up. An unknown may RANK above a
  // violation (it is checkable) but it is not evidence of conformance, and the top-up's whole promise
  // is that what it appends actually fits the budget.
  assert.deepEqual(appended, []);
});

test('the top-up is inert without an enforcing ceiling or a target', () => {
  const answer = { recommendations: [{ ...ORDINARY, price: { amount: 5.16, currency: 'USD' } }] };
  const catalogStructured = { recommendations: [NATURIUM, COSRX] };
  for (const args of [
    { priceCeiling: null, shortlistTarget: 3 },
    { priceCeiling: { limit: 0, currency: 'USD' }, shortlistTarget: 3 },
    { priceCeiling: { limit: 40, currency: 'XYZ' }, shortlistTarget: 3 },
    { priceCeiling: USD40, shortlistTarget: 0 },
    { priceCeiling: USD40 },
  ]) {
    const out = applyStrictConformingTopUp({ structured: answer, catalogStructured, ...args });
    // Mutant killed: defaulting shortlistTarget to 3, or treating a refused ceiling as enforcing.
    // Every lane that supplies neither -- the whole chat path -- must be byte-stable.
    assert.equal(out.appendedCount, 0, JSON.stringify(args));
    assert.equal(out.structured, answer, 'the same object, not a copy');
  }
});

test('the top-up falls back to the PRE-LLM catalog answer when the recovery one is absent', () => {
  const answer = { recommendations: [{ ...ORDINARY, price: { amount: 5.16, currency: 'USD' } }] };
  const out = applyStrictConformingTopUp({
    structured: answer,
    catalogStructured: null,
    preLlmCatalogStructured: { recommendations: [NATURIUM, COSRX] },
    priceCeiling: USD40,
    shortlistTarget: 3,
  });
  // Mutant killed: reading only catalogStructured. On the direct lane an LLM SUCCESS leaves
  // catalogStructured null by design (#2045) -- the pool lives in preLlmCatalogStructured, so the
  // top-up would never fire on exactly the path the founder's probe takes.
  assert.equal(out.appendedCount, 2);
});

test('a missing or malformed answer is left alone', () => {
  for (const structured of [null, undefined, {}, { recommendations: 'nope' }]) {
    const out = applyStrictConformingTopUp({
      structured,
      catalogStructured: { recommendations: [NATURIUM] },
      priceCeiling: USD40,
      shortlistTarget: 3,
    });
    assert.equal(out.appendedCount, 0);
  }
});

// ---------------------------------------------------------------------------
// 5. Threading and the cache bump
// ---------------------------------------------------------------------------

test("the bridge passes its own limit through as the shortlist target", async () => {
  const { makeRecommendProducts } = require('../src/agentSignals/recommendProducts');
  let seen = null;
  const handler = makeRecommendProducts({
    generate: async (args) => { seen = args; return { norm: { payload: { recommendations: [] } } }; },
    isEnabled: () => true,
  });
  await handler(
    { payload: { need: 'a gentle exfoliant', constraints: { price_max: 40 }, limit: 5 } },
    { agent_id: 'a' },
  );
  // Mutant killed: not threading shortlistTarget. The lane cannot tell whether one conforming item is
  // the whole answer or a fifth of it, so strict fill can never fire.
  assert.equal(seen.shortlistTarget, 5);
  assert.deepEqual(seen.priceCeiling, USD40);

  await handler({ payload: { need: 'a gentle exfoliant' } }, { agent_id: 'a' });
  // Mutant killed: hard-coding a target. It is the bridge's own DEFAULT_LIMIT (5), not a constant
  // invented here, and it is clamped to MAX_LIMIT for an over-large caller limit.
  assert.equal(seen.shortlistTarget, 5);
  assert.equal(seen.priceCeiling, undefined);

  await handler({ payload: { need: 'x', limit: 999 } }, { agent_id: 'a' });
  assert.equal(seen.shortlistTarget, 10, 'clamped to MAX_LIMIT, never the raw caller value');
});

test('the pool cache version was bumped so shallow ceiling pools go cold', () => {
  // Mutant killed: raising the arm depth without the bump. An existing ceiling'd key would keep
  // serving its SHALLOW pool for the rest of its 24h window -- the exact pool this change exists to
  // make deeper.
  assert.equal(RECO_RECALL_POOL_CACHE_VERSION, 'reco_recall_pool_cache_v4');
});

// ---------------------------------------------------------------------------
// 6. KNOWN HAZARD, documented so it cannot change silently
// ---------------------------------------------------------------------------

test('KNOWN HAZARD: grounding re-points a row at another product but keeps the old price', async () => {
  // mergeRecoPlanWithGroundedCandidate (src/auroraBff/routes.js) takes product_id, merchant_id, name,
  // title, display_name and category from the grounded candidate -- and NO price field, so `...plan`
  // keeps the ORIGINAL price. A grounded row can therefore carry product A's identity with product
  // B's price.
  //
  // This is PRE-EXISTING and applies to every llm_primary row, not only to top-up rows; it is not
  // fixed here because the right fix touches every grounded row on every lane and wants its own
  // measurement. This test exists so the behavior is visible and cannot drift unnoticed. On the agent
  // lane the bridge's live verifyPrice re-resolves by product_id and corrects it; the consumer
  // /v1/reco/generate lane has no such backstop.
  const original = dbModule.query;
  dbModule.query = async (sql) => (/SELECT payload/.test(sql)
    ? { rows: [{ payload: [OLEHENRIKSEN], refreshed_at: new Date().toISOString() }] }
    : { rows: [], rowCount: 0 });
  try {
    const out = await __internal.groundRecoRecommendationsFromCatalog({
      recommendations: [{ ...NATURIUM, step: 'Treatment', price: { amount: 19, currency: 'USD' } }],
      ctx: { lang: 'EN' },
      logger: null,
      defaultTargetContext: null,
    });
    const row = out.recommendations[0];
    assert.equal(row.product_id, 'o62', 'identity comes from the grounded candidate');
    assert.deepEqual(row.price, { amount: 19, currency: 'USD' }, 'price does NOT');
  } finally {
    dbModule.query = original;
  }
});

// ---------------------------------------------------------------------------
// 7. The upstream request limit, tested directly
// ---------------------------------------------------------------------------

// The arm-depth tests above inject a fake searchFn, so they never reach the clamp inside
// searchPivotaBackendProducts -- and a raised arm limit is worthless if the clamp puts it back.
test('only a CONSTRAINED request may go past the shared upstream cap of 12', () => {
  const f = __internal.resolveRecoSearchRequestLimit;
  // Mutant killed: leaving the cap at a flat 12. The constrained arm asks for 18 and would silently
  // receive 12 -- the depth change would be a no-op with a passing test suite.
  assert.equal(f(18, USD40), 18);
  assert.equal(f(18, null), 12, 'an unconstrained request keeps the shared cap exactly');
  // Mutant killed: lifting the cap for every request. Depth is only justified where a hard filter is
  // about to remove most of the rows.
  assert.equal(f(24, null), 12);
  // Mutant killed: treating a REFUSED ceiling as enforcing -- it does not constrain the upstream, so
  // it earns no extra depth either.
  assert.equal(f(18, { limit: 40, currency: 'XYZ' }), 12);
  assert.equal(f(100, USD40), 18, 'still bounded by the env knob');
  assert.equal(f(6, null), 6);
  assert.equal(f(0, USD40), 1, 'never zero');
  assert.equal(f(undefined, null), 6, 'the historical default');
});
