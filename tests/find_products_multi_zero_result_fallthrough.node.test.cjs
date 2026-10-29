'use strict';

// Unit tests for the zero-result classification module (measurement only — it changes no answer).
// The invoke-route behaviour is pinned in
// tests/integration/invoke.find_products_multi_zero_result_fallthrough.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const zr = require('../src/findProductsMulti/zeroResultFallthrough');

const OBSERVE = zr.resolveZeroResultFallthroughConfig({ FIND_PRODUCTS_MULTI_ZERO_RESULT_FALLTHROUGH: 'observe' });
const OFF = zr.resolveZeroResultFallthroughConfig({});

test('mode: unset and off are off with no warning; observe is observe', () => {
  assert.deepEqual({ ...OFF }, { mode: 'off', invalidValue: null });
  assert.deepEqual(
    { ...zr.resolveZeroResultFallthroughConfig({ FIND_PRODUCTS_MULTI_ZERO_RESULT_FALLTHROUGH: ' Off ' }) },
    { mode: 'off', invalidValue: null },
  );
  assert.deepEqual({ ...OBSERVE }, { mode: 'observe', invalidValue: null });
  assert.equal(zr.resolveZeroResultFallthroughConfig({ FIND_PRODUCTS_MULTI_ZERO_RESULT_FALLTHROUGH: ' OBSERVE ' }).mode, 'observe');
  assert.deepEqual([...zr.MODES], ['off', 'observe']);
});

test('mode: on and every other value run as off and are reported for a warning', () => {
  for (const value of ['on', 'ON', 'true', '1', 'yes', 'enforce']) {
    const config = zr.resolveZeroResultFallthroughConfig({ FIND_PRODUCTS_MULTI_ZERO_RESULT_FALLTHROUGH: value });
    assert.equal(config.mode, 'off', value);
    assert.equal(config.invalidValue, value, value);
    assert.equal(zr.isObserving(config), false, value);
  }
  const long = 'x'.repeat(100);
  assert.equal(zr.resolveZeroResultFallthroughConfig({ FIND_PRODUCTS_MULTI_ZERO_RESULT_FALLTHROUGH: long }).invalidValue.length, 32);
});

test('classes: every reason has exactly one class, and unclassified is its own class', () => {
  const groups = [zr.DEGRADED_REASONS, zr.POLICY_REASONS, zr.GENUINE_REASONS];
  for (const reason of Object.values(zr.EMPTY_REASONS)) {
    const memberships = groups.filter((group) => group.has(reason)).length;
    if (reason === 'unclassified') {
      assert.equal(memberships, 0);
      assert.equal(zr.classifyEmptyReason(reason), 'unclassified');
    } else {
      assert.equal(memberships, 1, reason);
    }
  }
  for (const reason of ['lane_timeout', 'lane_error', 'upstream_timeout', 'upstream_error']) {
    assert.equal(zr.classifyEmptyReason(reason), 'degraded', reason);
  }
  for (const reason of ['safety_filtered', 'policy_safe_empty', 'clarify', 'market_unpriced']) {
    assert.equal(zr.classifyEmptyReason(reason), 'policy', reason);
  }
  for (const reason of ['no_catalog_match', 'category_filtered', 'budget_filtered', 'relevance_rejected', 'serving_rejected', 'upstream_no_rows']) {
    assert.equal(zr.classifyEmptyReason(reason), 'genuine', reason);
  }
  assert.equal(zr.classifyEmptyReason('something_new'), 'unclassified');
  assert.equal(zr.classifyEmptyReason(undefined), 'unclassified');
});

test('proposed ingredient leg cap: deadline minus minimum budget minus reserve minus start', () => {
  const base = zr.PROPOSED_RETRY_DEADLINE_MS - zr.PROPOSED_RETRY_MIN_BUDGET_MS - zr.PROPOSED_POST_LEG_RESERVE_MS;
  assert.equal(zr.proposedIngredientLegCapMs(0), base);
  assert.equal(zr.proposedIngredientLegCapMs(300), base - 300);
  assert.equal(zr.proposedIngredientLegCapMs(-5), base);
  assert.equal(zr.proposedIngredientLegCapMs(999999), 0);
});

test('classifyIngredientDirectEmpty: each stage maps to its own token', () => {
  const c = zr.classifyIngredientDirectEmpty;
  assert.equal(c({ finalCount: 3 }), null);
  assert.equal(c({ mergedCount: 0, canonicalError: 'STAGE_TIMEOUT' }), 'lane_timeout');
  assert.equal(c({ mergedCount: 0, canonicalError: 'stage_timeout ' }), 'lane_timeout');
  assert.equal(c({ mergedCount: 0, canonicalError: 'timeout exceeded when trying to connect' }), 'lane_error');
  assert.equal(c({ mergedCount: 0 }), 'no_catalog_match');
  assert.equal(c({ mergedCount: 0, canonicalRecalledCount: 4 }), 'category_filtered');
  assert.equal(c({ mergedCount: 5, categoryFilteredCount: 0 }), 'category_filtered');
  assert.equal(c({ mergedCount: 5, categoryFilteredCount: 5, budgetFilteredCount: 0 }), 'budget_filtered');
  assert.equal(c({ mergedCount: 5, categoryFilteredCount: 5, budgetFilteredCount: 5, finalCount: 0 }), 'safety_filtered');
});

test('laneFromQuerySource maps every lane token', () => {
  assert.equal(zr.laneFromQuerySource('agent_products_ingredient_recall_direct'), 'ingredient_direct');
  assert.equal(zr.laneFromQuerySource('agent_products_beauty_external_seed_mainline'), 'beauty_mainline');
  assert.equal(zr.laneFromQuerySource('agent_products_creator_beauty_external_seed_mainline'), 'beauty_mainline');
  assert.equal(zr.laneFromQuerySource('beauty_mainline_buyer_market_unpriced'), 'beauty_mainline');
  assert.equal(zr.laneFromQuerySource('search_quality_contract_v1_safe_empty'), 'safe_empty');
  assert.equal(zr.laneFromQuerySource('agent_products_search'), 'upstream_search');
  assert.equal(zr.laneFromQuerySource('agent_products_error_fallback'), 'upstream_search');
  assert.equal(zr.laneFromQuerySource('beauty_discovery_mainline'), 'discovery_bridge');
  assert.equal(zr.laneFromQuerySource('canonical_chain_catalog_direct'), 'canonical_chain');
  assert.equal(zr.laneFromQuerySource('something_new'), 'other');
  assert.equal(zr.laneFromQuerySource(null), 'other');
});

const c = zr.classifyEmptyResponse;
const ingredient = (extra) => ({ products: [], metadata: { query_source: 'agent_products_ingredient_recall_direct', ...extra } });
const mainline = (extra) => ({ products: [], metadata: { query_source: 'agent_products_beauty_external_seed_mainline', ...extra } });
const upstream = (extra) => ({ products: [], metadata: { query_source: 'agent_products_search', ...extra } });

test('classifyEmptyResponse: non-empty is null; policy answers', () => {
  assert.equal(c({ products: [{ product_id: 'x' }] }), null);
  assert.equal(c({ products: [], metadata: { query_source: 'search_quality_contract_v1_safe_empty' } }), 'policy_safe_empty');
  assert.equal(
    c(mainline({ search_decision: { decision_lock_reason: 'search_quality_contract_ambiguous_or_non_shopping' } })),
    'policy_safe_empty',
  );
  assert.equal(c({ products: [], metadata: { query_source: 'beauty_mainline_buyer_market_unpriced' } }), 'market_unpriced');
});

test('classifyEmptyResponse: ingredient lane names a gate only when its count shows it', () => {
  assert.equal(c(ingredient({ canonical_error: 'STAGE_TIMEOUT', ingredient_direct_prefetch_count: 0 })), 'lane_timeout');
  assert.equal(c(ingredient({ canonical_error: 'ECONNREFUSED', ingredient_direct_prefetch_count: 0 })), 'lane_error');
  assert.equal(c(ingredient({ canonical_raw_count: 0, ingredient_direct_prefetch_count: 0 })), 'no_catalog_match');
  assert.equal(c(ingredient({ canonical_raw_count: 3, contraindicated_product_filtered_count: 3 })), 'safety_filtered');
  assert.equal(c(ingredient({ canonical_raw_count: 3, ingredient_direct_budget_filtered_out_count: 3 })), 'budget_filtered');
  assert.equal(c(ingredient({ canonical_raw_count: 3, ingredient_direct_category_filtered_out_count: 3 })), 'category_filtered');
  assert.equal(c(ingredient({ canonical_raw_count: 3, canonical_category_scope_filtered_out_count: 3 })), 'category_filtered');
  // Rows recalled, no count says which gate removed them: not guessed.
  assert.equal(c(ingredient({ canonical_raw_count: 3 })), 'unclassified');
  // An error with seed rows present is not a failed lane.
  assert.equal(c(ingredient({ canonical_error: 'STAGE_TIMEOUT', ingredient_direct_prefetch_count: 2 })), 'unclassified');
});

test('classifyEmptyResponse: mainline names a gate only when its count shows it', () => {
  assert.equal(c(mainline({ primary_recall_degraded: true })), 'lane_timeout');
  assert.equal(c(mainline({ search_quality_tier_counts: { input_count: 0 } })), 'no_catalog_match');
  assert.equal(
    c(mainline({ search_quality_tier_counts: { input_count: 9 }, search_card_quality_gate: { input_count: 0 } })),
    'relevance_rejected',
  );
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
  // Eligible rows existed and no gate count explains the empty page: never defaulted to a gate.
  assert.equal(
    c(mainline({ search_quality_tier_counts: { input_count: 9 }, search_card_quality_gate: { input_count: 4, rejected_count: 0 } })),
    'unclassified',
  );
  // Missing counts are not zero counts.
  assert.equal(c(mainline({})), 'unclassified');
  assert.equal(c(mainline({ search_card_quality_gate: { rejected_count: 2 } })), 'unclassified');
});

test('classifyEmptyResponse: upstream and unknown lanes', () => {
  assert.equal(c(upstream({ proxy_search_fallback: { reason: 'shopping_mainline_timeout' } })), 'upstream_timeout');
  assert.equal(c(upstream({ proxy_search_fallback: { reason: 'shopping_mainline_non_beauty_primary_deadline' } })), 'upstream_timeout');
  assert.equal(c(upstream({ strict_empty_reason: 'shopping_mainline_upstream_5xx' })), 'upstream_error');
  assert.equal(c(upstream({ proxy_search_fallback: { reason: 'shopping_mainline_exception' } })), 'upstream_error');
  assert.equal(c(upstream({ search_decision: { final_decision: 'clarify' } })), 'clarify');
  assert.equal(c(upstream({})), 'upstream_no_rows');
  assert.equal(c({ products: [], metadata: { query_source: 'something_new' } }), 'unclassified');
  assert.equal(c({ products: [], metadata: {} }), 'unclassified');
  assert.equal(c({}), 'unclassified');
});

test('log fields: off emits nothing, whatever the request', () => {
  const inputs = [
    { record: { lane: 'ingredient_direct', emptyReason: 'lane_timeout' }, body: { products: [] } },
    { record: { lane: 'ingredient_direct', legMs: 9000, legCapMs: 4000 }, body: { products: [{ product_id: 'x' }] } },
    { body: upstream({}) },
  ];
  for (const config of [OFF, zr.resolveZeroResultFallthroughConfig({ FIND_PRODUCTS_MULTI_ZERO_RESULT_FALLTHROUGH: 'on' }), null]) {
    for (const input of inputs) {
      assert.deepEqual(zr.buildZeroResultLogFields({ config, operation: 'find_products_multi', ...input }), {});
    }
  }
});

test('log fields: only find_products_multi', () => {
  assert.deepEqual(zr.buildZeroResultLogFields({ config: OBSERVE, operation: 'get_pdp_v2', body: upstream({}) }), {});
});

test('log fields: an empty ingredient answer reports the lane-recorded reason and class', () => {
  assert.deepEqual(
    zr.buildZeroResultLogFields({
      config: OBSERVE,
      operation: 'find_products_multi',
      record: { lane: 'ingredient_direct', emptyReason: 'lane_timeout' },
      body: ingredient({}),
    }),
    { fpm_lane_chain: 'ingredient_direct', fpm_empty_reason: 'lane_timeout', fpm_empty_class: 'degraded' },
  );
});

test('log fields: an ingredient answer with rows reports its leg against the proposed cap', () => {
  const rows = { products: [{ product_id: 'x' }], metadata: { query_source: 'agent_products_ingredient_recall_direct' } };
  const over = zr.buildZeroResultLogFields({
    config: OBSERVE,
    operation: 'find_products_multi',
    record: { lane: 'ingredient_direct', legMs: 4500.4, legCapMs: 4100 },
    body: rows,
  });
  assert.deepEqual(over, {
    fpm_lane_chain: 'ingredient_direct',
    fpm_ingredient_leg_ms: 4500,
    fpm_ingredient_leg_over_proposed_cap: true,
  });
  const atCap = zr.buildZeroResultLogFields({
    config: OBSERVE,
    operation: 'find_products_multi',
    record: { lane: 'ingredient_direct', legMs: 4100, legCapMs: 4100 },
    body: rows,
  });
  assert.equal(atCap.fpm_ingredient_leg_over_proposed_cap, false);
});

test('log fields: a lane with rows that the final filters emptied is classified from the body', () => {
  const fields = zr.buildZeroResultLogFields({
    config: OBSERVE,
    operation: 'find_products_multi',
    record: { lane: 'ingredient_direct', legMs: 100, legCapMs: 4000 },
    body: ingredient({ canonical_raw_count: 3 }),
  });
  assert.deepEqual(fields, { fpm_lane_chain: 'ingredient_direct', fpm_empty_reason: 'unclassified', fpm_empty_class: 'unclassified' });
});

test('log fields: other lanes are classified from the body; non-empty answers log nothing', () => {
  assert.deepEqual(
    zr.buildZeroResultLogFields({
      config: OBSERVE,
      operation: 'find_products_multi',
      body: upstream({ search_decision: { final_decision: 'clarify' } }),
    }),
    { fpm_lane_chain: 'upstream_search', fpm_empty_reason: 'clarify', fpm_empty_class: 'policy' },
  );
  assert.deepEqual(
    zr.buildZeroResultLogFields({ config: OBSERVE, operation: 'find_products_multi', body: mainline({}) }),
    { fpm_lane_chain: 'beauty_mainline', fpm_empty_reason: 'unclassified', fpm_empty_class: 'unclassified' },
  );
  assert.deepEqual(
    zr.buildZeroResultLogFields({ config: OBSERVE, operation: 'find_products_multi', body: { products: [{ product_id: 'x' }] } }),
    {},
  );
});

test('log fields carry only fixed tokens, numbers and booleans', () => {
  const fields = zr.buildZeroResultLogFields({
    config: OBSERVE,
    operation: 'find_products_multi',
    body: upstream({ strict_empty_reason: 'some free text from upstream' }),
  });
  const allowed = new Set([...Object.values(zr.LANES), ...Object.values(zr.EMPTY_REASONS), ...Object.values(zr.EMPTY_CLASSES)]);
  for (const value of Object.values(fields)) {
    if (typeof value === 'string') assert.ok(allowed.has(value), value);
  }
});

test('log fields: a recorded empty reason is never reported for an answer that went out with rows', () => {
  assert.deepEqual(
    zr.buildZeroResultLogFields({
      config: OBSERVE,
      operation: 'find_products_multi',
      record: { lane: 'ingredient_direct', emptyReason: 'lane_timeout' },
      body: { products: [{ product_id: 'x' }], metadata: { query_source: 'agent_products_ingredient_recall_direct' } },
    }),
    {},
  );
});
