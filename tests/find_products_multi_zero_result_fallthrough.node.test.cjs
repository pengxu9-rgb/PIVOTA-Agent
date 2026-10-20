'use strict';

// Unit tests for the zero-result fallthrough decision module. The invoke-route behaviour (which
// lane actually runs, what the response and the completion log carry) is pinned separately in
// tests/integration/invoke.find_products_multi_zero_result_fallthrough.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const zr = require('../src/findProductsMulti/zeroResultFallthrough');

const ON = zr.resolveZeroResultFallthroughConfig({ FIND_PRODUCTS_MULTI_ZERO_RESULT_FALLTHROUGH: 'on' });
const OBSERVE = zr.resolveZeroResultFallthroughConfig({ FIND_PRODUCTS_MULTI_ZERO_RESULT_FALLTHROUGH: 'observe' });
const OFF = zr.resolveZeroResultFallthroughConfig({});

test('config: default off, unknown values off, defaults for the budget', () => {
  assert.equal(OFF.mode, 'off');
  assert.equal(zr.resolveZeroResultFallthroughConfig({ FIND_PRODUCTS_MULTI_ZERO_RESULT_FALLTHROUGH: 'yes' }).mode, 'off');
  assert.equal(zr.resolveZeroResultFallthroughConfig({ FIND_PRODUCTS_MULTI_ZERO_RESULT_FALLTHROUGH: ' ON ' }).mode, 'on');
  assert.equal(OBSERVE.mode, 'observe');
  assert.equal(ON.deadlineMs, zr.DEFAULT_DEADLINE_MS);
  assert.equal(ON.minBudgetMs, zr.DEFAULT_MIN_BUDGET_MS);
});

test('config: deadline and minimum budget are clamped; the minimum never exceeds the deadline', () => {
  const c = zr.resolveZeroResultFallthroughConfig({
    FIND_PRODUCTS_MULTI_ZERO_RESULT_FALLTHROUGH: 'on',
    FIND_PRODUCTS_MULTI_ZERO_RESULT_FALLTHROUGH_DEADLINE_MS: '1200',
    FIND_PRODUCTS_MULTI_ZERO_RESULT_FALLTHROUGH_MIN_BUDGET_MS: '99999',
  });
  assert.equal(c.deadlineMs, 1200);
  assert.equal(c.minBudgetMs, 1200);
  const low = zr.resolveZeroResultFallthroughConfig({
    FIND_PRODUCTS_MULTI_ZERO_RESULT_FALLTHROUGH_DEADLINE_MS: '5',
    FIND_PRODUCTS_MULTI_ZERO_RESULT_FALLTHROUGH_MIN_BUDGET_MS: '1',
  });
  assert.equal(low.deadlineMs, 1000);
  assert.equal(low.minBudgetMs, 250);
});

test('lane map: only ingredient_direct has a next lane', () => {
  assert.deepEqual({ ...zr.NEXT_LANE }, { ingredient_direct: 'beauty_mainline' });
});

test('decide: off does nothing at all', () => {
  const d = zr.decideZeroResultFallthrough({ config: OFF, fromLane: 'ingredient_direct', emptyReason: 'lane_timeout' });
  assert.equal(d.action, 'none');
});

test('decide: a timed-out ingredient lane is retried on the mainline with the remaining budget', () => {
  const d = zr.decideZeroResultFallthrough({
    config: ON,
    fromLane: 'ingredient_direct',
    emptyReason: 'lane_timeout',
    elapsedMs: 1000,
  });
  assert.equal(d.action, 'attempt');
  assert.equal(d.toLane, 'beauty_mainline');
  assert.equal(d.budgetMs, ON.deadlineMs - 1000);
});

test('decide: observe computes the same decision but only observes', () => {
  const d = zr.decideZeroResultFallthrough({
    config: OBSERVE,
    fromLane: 'ingredient_direct',
    emptyReason: 'lane_timeout',
    elapsedMs: 1000,
  });
  assert.equal(d.action, 'observe');
  assert.equal(d.toLane, 'beauty_mainline');
});

test('decide: a healthy lane that found nothing is never retried', () => {
  for (const reason of [
    'no_catalog_match',
    'category_filtered',
    'budget_filtered',
    'relevance_rejected',
    'serving_rejected',
    'currency_filtered',
    'upstream_no_rows',
    'unknown',
  ]) {
    const d = zr.decideZeroResultFallthrough({ config: ON, fromLane: 'ingredient_direct', emptyReason: reason, elapsedMs: 0 });
    assert.equal(d.action, 'skip', reason);
    assert.equal(d.skipReason, 'genuinely_empty', reason);
    assert.equal(zr.classifyEmptyReason(reason), 'genuine', reason);
  }
});

test('decide: degraded lanes without a next lane are skipped', () => {
  for (const lane of ['beauty_mainline', 'upstream_search', 'safe_empty', 'discovery_bridge', 'other']) {
    const d = zr.decideZeroResultFallthrough({ config: ON, fromLane: lane, emptyReason: 'lane_timeout' });
    assert.equal(d.action, 'skip', lane);
    assert.equal(d.skipReason, 'no_next_lane', lane);
  }
});

test('decide: refusals are never overridden', () => {
  for (const reason of zr.REFUSAL_REASONS) {
    const d = zr.decideZeroResultFallthrough({ config: ON, fromLane: 'ingredient_direct', emptyReason: reason });
    assert.equal(d.action, 'skip', reason);
    assert.equal(d.skipReason, 'refusal', reason);
    assert.equal(zr.classifyEmptyReason(reason), 'policy', reason);
  }
  assert.ok(zr.REFUSAL_REASONS.has('safety_filtered'));
  assert.ok(zr.REFUSAL_REASONS.has('policy_safe_empty'));
});

test('decide: merchant-scoped and strict-surface requests are never widened', () => {
  const scoped = zr.decideZeroResultFallthrough({
    config: ON,
    fromLane: 'ingredient_direct',
    emptyReason: 'lane_timeout',
    hasMerchantScope: true,
  });
  assert.equal(scoped.skipReason, 'merchant_scoped');
  const strict = zr.decideZeroResultFallthrough({
    config: ON,
    fromLane: 'ingredient_direct',
    emptyReason: 'lane_timeout',
    strictSurface: true,
  });
  assert.equal(strict.skipReason, 'strict_surface');
});

test('decide: a lane that errored or timed out is retried (the main route did not work)', () => {
  for (const reason of ['lane_error', 'lane_timeout']) {
    const d = zr.decideZeroResultFallthrough({ config: ON, fromLane: 'ingredient_direct', emptyReason: reason });
    assert.equal(d.action, 'attempt', reason);
    assert.equal(zr.classifyEmptyReason(reason), 'degraded', reason);
  }
  assert.equal(zr.classifyEmptyReason('upstream_timeout'), 'degraded');
  assert.equal(zr.classifyEmptyReason('upstream_error'), 'degraded');
});

test('decide: budget boundary — exactly the minimum runs, one millisecond less skips', () => {
  const atMin = zr.decideZeroResultFallthrough({
    config: ON,
    fromLane: 'ingredient_direct',
    emptyReason: 'lane_timeout',
    elapsedMs: ON.deadlineMs - ON.minBudgetMs,
  });
  assert.equal(atMin.action, 'attempt');
  assert.equal(atMin.budgetMs, ON.minBudgetMs);
  const below = zr.decideZeroResultFallthrough({
    config: ON,
    fromLane: 'ingredient_direct',
    emptyReason: 'lane_timeout',
    elapsedMs: ON.deadlineMs - ON.minBudgetMs + 1,
  });
  assert.equal(below.action, 'skip');
  assert.equal(below.skipReason, 'budget_exhausted');
  const past = zr.decideZeroResultFallthrough({
    config: ON,
    fromLane: 'ingredient_direct',
    emptyReason: 'lane_timeout',
    elapsedMs: ON.deadlineMs + 5000,
  });
  assert.equal(past.skipReason, 'budget_exhausted');
});

test('decide: the budget handed to the next lane never reaches past the deadline', () => {
  for (const elapsedMs of [0, 1, 250, 2000, 4499]) {
    const d = zr.decideZeroResultFallthrough({ config: ON, fromLane: 'ingredient_direct', emptyReason: 'lane_timeout', elapsedMs });
    assert.ok(elapsedMs + d.budgetMs <= ON.deadlineMs, String(elapsedMs));
  }
});

test('ingredient leg budget: off and observe keep the base budget exactly', () => {
  for (const config of [OFF, OBSERVE, null]) {
    assert.equal(zr.ingredientCanonicalStageBudgetMs({ config, baseBudgetMs: 6000, elapsedMs: 300 }), 6000);
  }
});

test('ingredient leg budget: on caps the leg so a timeout leaves the minimum budget', () => {
  const capped = zr.ingredientCanonicalStageBudgetMs({ config: ON, baseBudgetMs: 6000, elapsedMs: 300 });
  assert.equal(capped, ON.deadlineMs - ON.minBudgetMs - zr.POST_LEG_RESERVE_MS - 300);
  // A leg cut at the cap, plus post-leg work inside the reserve, still leaves the minimum budget.
  const decision = zr.decideZeroResultFallthrough({
    config: ON,
    fromLane: 'ingredient_direct',
    emptyReason: 'lane_timeout',
    elapsedMs: 300 + capped + zr.POST_LEG_RESERVE_MS,
  });
  assert.equal(decision.action, 'attempt');
  // Never above the base, never below the floor.
  assert.equal(zr.ingredientCanonicalStageBudgetMs({ config: ON, baseBudgetMs: 2000, elapsedMs: 0 }), 2000);
  assert.equal(
    zr.ingredientCanonicalStageBudgetMs({ config: ON, baseBudgetMs: 6000, elapsedMs: 99999 }),
    zr.MIN_INGREDIENT_LEG_BUDGET_MS,
  );
});

test('observe projects the elapsed time on would have had', () => {
  // A leg that ran 6s from t=200ms: on would have cut it at deadline - min - 200.
  const projected = zr.projectElapsedForOnMode({
    config: OBSERVE,
    elapsedMs: 6300,
    legStartedAtElapsedMs: 200,
    legMs: 6000,
  });
  const cap = OBSERVE.deadlineMs - OBSERVE.minBudgetMs - zr.POST_LEG_RESERVE_MS - 200;
  assert.equal(projected, 6300 - 6000 + cap);
  const d = zr.decideZeroResultFallthrough({
    config: OBSERVE,
    fromLane: 'ingredient_direct',
    emptyReason: 'lane_timeout',
    elapsedMs: projected,
  });
  assert.equal(d.action, 'observe');
  // On mode is never projected.
  assert.equal(zr.projectElapsedForOnMode({ config: ON, elapsedMs: 6300, legStartedAtElapsedMs: 200, legMs: 6000 }), 6300);
});

test('classifyIngredientDirectEmpty: each filter stage maps to its own token', () => {
  const c = zr.classifyIngredientDirectEmpty;
  assert.equal(c({ finalCount: 3 }), null);
  assert.equal(c({ mergedCount: 0, canonicalError: 'STAGE_TIMEOUT' }), 'lane_timeout');
  assert.equal(c({ mergedCount: 0, canonicalError: 'timeout exceeded when trying to connect' }), 'lane_error');
  assert.equal(c({ mergedCount: 0 }), 'no_catalog_match');
  assert.equal(c({ mergedCount: 0, canonicalRecalledCount: 4 }), 'category_filtered');
  assert.equal(c({ mergedCount: 5, categoryFilteredCount: 0 }), 'category_filtered');
  assert.equal(c({ mergedCount: 5, categoryFilteredCount: 5, budgetFilteredCount: 0 }), 'budget_filtered');
  assert.equal(c({ mergedCount: 5, categoryFilteredCount: 5, budgetFilteredCount: 5, finalCount: 0 }), 'safety_filtered');
});

test('mergeLaneProducts: primary order first, then the next lane, no duplicate products', () => {
  const key = (p) => `${p.merchant_id || ''}::${p.product_id || ''}`;
  const a = { merchant_id: 'm1', product_id: 'p1' };
  const b = { merchant_id: 'm1', product_id: 'p2' };
  const c = { merchant_id: 'm2', product_id: 'p1' };
  const dupA = { merchant_id: 'm1', product_id: 'p1', title: 'dup' };
  const noKey = { title: 'no id' };
  const merged = zr.mergeLaneProducts([a, b], [dupA, c, b, noKey, noKey], key);
  assert.deepEqual(merged.products, [a, b, c, noKey, noKey]);
  assert.equal(merged.duplicateCount, 2);
  // Duplicates inside one lane are dropped too.
  assert.deepEqual(zr.mergeLaneProducts([], [a, dupA, b], key).products, [a, b]);
  assert.deepEqual(zr.mergeLaneProducts(null, undefined, key).products, []);
});

test('classifyFallthroughResult: safe-empty is a refusal, empty is empty, rows are adopted', () => {
  assert.equal(zr.classifyFallthroughResult(null), 'next_lane_ineligible');
  assert.equal(
    zr.classifyFallthroughResult({ products: [], metadata: { query_source: 'search_quality_contract_v1_safe_empty' } }),
    'next_lane_refused',
  );
  assert.equal(
    zr.classifyFallthroughResult({
      products: [{ product_id: 'x' }],
      metadata: { search_decision: { decision_lock_reason: 'search_quality_contract_ambiguous_or_non_shopping' } },
    }),
    'next_lane_refused',
  );
  assert.equal(zr.classifyFallthroughResult({ products: [], metadata: {} }), 'next_lane_empty');
  assert.equal(zr.classifyFallthroughResult({ products: [{ product_id: 'x' }], metadata: {} }), 'adopted');
});

function stageTimeoutRace(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('budget'), { code: 'STAGE_TIMEOUT' })), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

test('runZeroResultFallthrough: only an attempt decision runs the next lane', async () => {
  let ran = 0;
  for (const action of ['none', 'skip', 'observe']) {
    const out = await zr.runZeroResultFallthrough({
      decision: { action, budgetMs: 1000 },
      runNextLane: async () => {
        ran += 1;
        return { products: [{ product_id: 'x' }] };
      },
      raceWithBudget: stageTimeoutRace,
    });
    assert.equal(out, null, action);
  }
  assert.equal(ran, 0);
});

test('runZeroResultFallthrough: adopted rows, empty, refusal, error and budget timeout', async () => {
  const run = (runNextLane, budgetMs = 1000) =>
    zr.runZeroResultFallthrough({ decision: { action: 'attempt', budgetMs }, runNextLane, raceWithBudget: stageTimeoutRace });
  const adopted = await run(async () => ({ products: [{ product_id: 'x' }], metadata: {} }));
  assert.equal(adopted.outcome, 'adopted');
  assert.equal(adopted.body.products.length, 1);
  const empty = await run(async () => ({ products: [], metadata: {} }));
  assert.equal(empty.outcome, 'next_lane_empty');
  assert.equal(empty.body, null);
  const declined = await run(async () => null);
  assert.equal(declined.outcome, 'next_lane_ineligible');
  const refused = await run(async () => ({ products: [], metadata: { query_source: 'search_quality_contract_v1_safe_empty' } }));
  assert.equal(refused.outcome, 'next_lane_refused');
  assert.equal(refused.body, null);
  const failed = await run(async () => {
    throw new Error('boom');
  });
  assert.equal(failed.outcome, 'next_lane_error');
  const syncThrow = await run(() => {
    throw new Error('sync boom');
  });
  assert.equal(syncThrow.outcome, 'next_lane_error');
  const startedAt = Date.now();
  const slow = await run(() => new Promise((resolve) => setTimeout(() => resolve({ products: [{ product_id: 'late' }] }), 500)), 50);
  assert.equal(slow.outcome, 'next_lane_timeout');
  assert.equal(slow.body, null);
  assert.ok(Date.now() - startedAt < 400, 'the race returns at the budget, not when the lane finishes');
});

test('laneFromQuerySource maps every lane token', () => {
  assert.equal(zr.laneFromQuerySource('agent_products_ingredient_recall_direct'), 'ingredient_direct');
  assert.equal(zr.laneFromQuerySource('agent_products_beauty_external_seed_mainline'), 'beauty_mainline');
  assert.equal(zr.laneFromQuerySource('agent_products_creator_beauty_external_seed_mainline'), 'beauty_mainline');
  assert.equal(zr.laneFromQuerySource('search_quality_contract_v1_safe_empty'), 'safe_empty');
  assert.equal(zr.laneFromQuerySource('agent_products_search'), 'upstream_search');
  assert.equal(zr.laneFromQuerySource('agent_products_error_fallback'), 'upstream_search');
  assert.equal(zr.laneFromQuerySource('beauty_discovery_mainline'), 'discovery_bridge');
  assert.equal(zr.laneFromQuerySource('canonical_chain_catalog_direct'), 'canonical_chain');
  assert.equal(zr.laneFromQuerySource('something_new'), 'other');
  assert.equal(zr.laneFromQuerySource(null), 'other');
});

test('classifyEmptyResponse reads the lane metadata into fixed tokens', () => {
  const c = zr.classifyEmptyResponse;
  assert.equal(c({ products: [{ product_id: 'x' }] }), null);
  assert.equal(c({ products: [], metadata: { query_source: 'search_quality_contract_v1_safe_empty' } }), 'policy_safe_empty');
  assert.equal(c({ products: [], metadata: { query_source: 'beauty_mainline_buyer_market_unpriced' } }), 'market_unpriced');
  const ingredient = (extra) => ({ products: [], metadata: { query_source: 'agent_products_ingredient_recall_direct', ...extra } });
  assert.equal(c(ingredient({ canonical_error: 'STAGE_TIMEOUT', ingredient_direct_prefetch_count: 0 })), 'lane_timeout');
  assert.equal(c(ingredient({ canonical_error: 'ECONNREFUSED', ingredient_direct_prefetch_count: 0 })), 'lane_error');
  assert.equal(c(ingredient({ canonical_raw_count: 0, ingredient_direct_prefetch_count: 0 })), 'no_catalog_match');
  assert.equal(c(ingredient({ canonical_raw_count: 3, contraindicated_product_filtered_count: 3 })), 'safety_filtered');
  assert.equal(c(ingredient({ canonical_raw_count: 3, ingredient_direct_budget_filtered_out_count: 3 })), 'budget_filtered');
  assert.equal(c(ingredient({ canonical_raw_count: 3 })), 'category_filtered');
  const mainline = (extra) => ({ products: [], metadata: { query_source: 'agent_products_beauty_external_seed_mainline', ...extra } });
  assert.equal(c(mainline({ primary_recall_degraded: true })), 'lane_timeout');
  assert.equal(c(mainline({ search_quality_tier_counts: { input_count: 0 } })), 'no_catalog_match');
  assert.equal(c(mainline({ search_quality_tier_counts: { input_count: 9 }, search_card_quality_gate: { input_count: 0 } })), 'relevance_rejected');
  assert.equal(
    c(mainline({ search_quality_tier_counts: { input_count: 9 }, search_card_quality_gate: { input_count: 4, rejected_count: 4 } })),
    'serving_rejected',
  );
  assert.equal(
    c(mainline({
      search_quality_tier_counts: { input_count: 9 },
      search_card_quality_gate: { input_count: 4, rejected_count: 0 },
      beauty_mainline_budget_filtered_out_count: 4,
    })),
    'budget_filtered',
  );
  assert.equal(
    c(mainline({ search_quality_tier_counts: { input_count: 9 }, search_card_quality_gate: { input_count: 4, rejected_count: 0 } })),
    'currency_filtered',
  );
  const upstream = (extra) => ({ products: [], metadata: { query_source: 'agent_products_search', ...extra } });
  assert.equal(c(upstream({ proxy_search_fallback: { reason: 'shopping_mainline_timeout' } })), 'upstream_timeout');
  assert.equal(c(upstream({ strict_empty_reason: 'shopping_mainline_upstream_5xx' })), 'upstream_error');
  assert.equal(c(upstream({ search_decision: { final_decision: 'clarify' } })), 'clarify');
  assert.equal(c(upstream({})), 'upstream_no_rows');
  assert.equal(c({ products: [], metadata: {} }), 'unknown');
});

test('log fields: off emits nothing, whatever happened', () => {
  assert.deepEqual(
    zr.buildZeroResultLogFields({ config: OFF, operation: 'find_products_multi', record: { fromLane: 'ingredient_direct' }, body: { products: [] } }),
    {},
  );
  assert.deepEqual(zr.buildZeroResultLogFields({ config: ON, operation: 'get_pdp_v2', body: { products: [] } }), {});
});

test('log fields: a recorded fallthrough names the chain, use, reason and timing', () => {
  const used = zr.buildZeroResultLogFields({
    config: ON,
    operation: 'find_products_multi',
    record: {
      action: 'attempt',
      fromLane: 'ingredient_direct',
      toLane: 'beauty_mainline',
      emptyReason: 'lane_timeout',
      attempted: true,
      adopted: true,
      outcome: 'adopted',
      budgetMs: 1700.4,
      latencyMs: 812.6,
    },
  });
  assert.deepEqual(used, {
    fpm_lane_chain: 'ingredient_direct>beauty_mainline',
    fpm_fallthrough_used: true,
    fpm_fallthrough: 'used',
    fpm_empty_reason: 'lane_timeout',
    fpm_empty_class: 'degraded',
    fpm_fallthrough_outcome: 'adopted',
    fpm_fallthrough_budget_ms: 1700,
    fpm_fallthrough_ms: 813,
  });
  const skipped = zr.buildZeroResultLogFields({
    config: ON,
    operation: 'find_products_multi',
    record: { action: 'skip', fromLane: 'ingredient_direct', toLane: null, emptyReason: 'lane_timeout', skipReason: 'budget_exhausted' },
  });
  assert.deepEqual(skipped, {
    fpm_lane_chain: 'ingredient_direct',
    fpm_fallthrough_used: false,
    fpm_fallthrough: 'skipped',
    fpm_empty_reason: 'lane_timeout',
    fpm_empty_class: 'degraded',
    fpm_fallthrough_skip_reason: 'budget_exhausted',
  });
  const observed = zr.buildZeroResultLogFields({
    config: OBSERVE,
    operation: 'find_products_multi',
    record: { action: 'observe', fromLane: 'ingredient_direct', toLane: 'beauty_mainline', emptyReason: 'lane_timeout', budgetMs: 1500 },
  });
  assert.equal(observed.fpm_fallthrough, 'observed');
  assert.equal(observed.fpm_lane_chain, 'ingredient_direct');
  assert.equal(observed.fpm_fallthrough_next_lane, 'beauty_mainline');
  assert.equal(observed.fpm_fallthrough_used, false);
});

test('log fields: an empty answer from a lane with no next lane is classified from the body', () => {
  const fields = zr.buildZeroResultLogFields({
    config: OBSERVE,
    operation: 'find_products_multi',
    body: { products: [], metadata: { query_source: 'agent_products_search', search_decision: { final_decision: 'clarify' } } },
  });
  assert.deepEqual(fields, {
    fpm_lane_chain: 'upstream_search',
    fpm_fallthrough_used: false,
    fpm_fallthrough: 'skipped',
    fpm_empty_reason: 'clarify',
    fpm_empty_class: 'policy',
    fpm_fallthrough_skip_reason: 'refusal',
  });
  const genuine = zr.buildZeroResultLogFields({
    config: OBSERVE,
    operation: 'find_products_multi',
    body: { products: [], metadata: { query_source: 'agent_products_search' } },
  });
  assert.equal(genuine.fpm_empty_class, 'genuine');
  assert.equal(genuine.fpm_fallthrough_skip_reason, 'genuinely_empty');
  const degraded = zr.buildZeroResultLogFields({
    config: OBSERVE,
    operation: 'find_products_multi',
    body: { products: [], metadata: { query_source: 'agent_products_search', proxy_search_fallback: { reason: 'shopping_mainline_timeout' } } },
  });
  assert.equal(degraded.fpm_empty_class, 'degraded');
  assert.equal(degraded.fpm_fallthrough_skip_reason, 'no_next_lane');
  // A non-empty answer with no record logs nothing new.
  assert.deepEqual(
    zr.buildZeroResultLogFields({ config: ON, operation: 'find_products_multi', body: { products: [{ product_id: 'x' }] } }),
    {},
  );
});

test('log fields carry only fixed tokens and numbers', () => {
  const fields = zr.buildZeroResultLogFields({
    config: ON,
    operation: 'find_products_multi',
    body: { products: [], metadata: { query_source: 'agent_products_search', strict_empty_reason: 'some free text from upstream' } },
  });
  const allowed = new Set([
    ...Object.values(zr.LANES),
    ...Object.values(zr.EMPTY_REASONS),
    ...Object.values(zr.SKIP_REASONS),
    ...Object.values(zr.OUTCOMES),
    ...Object.values(zr.EMPTY_CLASSES),
    'used',
    'tried',
    'observed',
    'skipped',
  ]);
  for (const value of Object.values(fields)) {
    if (typeof value === 'string') assert.ok(allowed.has(value), value);
  }
});

test('buildFallthroughMetadata rounds timings and never carries free text', () => {
  const m = zr.buildFallthroughMetadata({
    mode: 'on',
    fromLane: 'ingredient_direct',
    toLane: 'beauty_mainline',
    emptyReason: 'lane_timeout',
    attempted: true,
    adopted: false,
    outcome: 'next_lane_irrelevant',
    relevanceDroppedCount: 4,
    budgetMs: 1234.5,
    latencyMs: -3,
  });
  assert.deepEqual(m, {
    mode: 'on',
    from_lane: 'ingredient_direct',
    to_lane: 'beauty_mainline',
    empty_reason: 'lane_timeout',
    empty_class: 'degraded',
    attempted: true,
    adopted: false,
    outcome: 'next_lane_irrelevant',
    skip_reason: null,
    relevance_dropped_count: 4,
    budget_ms: 1235,
    latency_ms: 0,
  });
});

test('runZeroResultFallthrough: retry rows that fail the first lane\'s relevance rules are dropped', async () => {
  const relevant = { product_id: 'keep', title: 'Niacinamide Serum' };
  const loose = { product_id: 'drop', title: 'Hydrating Serum' };
  const admitProducts = (products) => products.filter((p) => /niacinamide/i.test(p.title));
  const run = (products) =>
    zr.runZeroResultFallthrough({
      decision: { action: 'attempt', budgetMs: 1000 },
      runNextLane: async () => ({ products, total: 40, page_size: products.length, metadata: {} }),
      raceWithBudget: stageTimeoutRace,
      admitProducts,
    });
  const mixed = await run([loose, relevant, loose]);
  assert.equal(mixed.outcome, 'adopted');
  assert.deepEqual(mixed.body.products, [relevant]);
  assert.equal(mixed.relevanceDroppedCount, 2);
  assert.equal(mixed.body.total, 1);
  assert.equal(mixed.body.page_size, 1);
  const allLoose = await run([loose, loose]);
  assert.equal(allLoose.outcome, 'next_lane_irrelevant');
  assert.equal(allLoose.body, null);
  assert.equal(allLoose.relevanceDroppedCount, 2);
  const allRelevant = await run([relevant]);
  assert.equal(allRelevant.relevanceDroppedCount, 0);
  assert.equal(allRelevant.body.total, 40, 'nothing dropped: the lane\'s own total stands');
});
