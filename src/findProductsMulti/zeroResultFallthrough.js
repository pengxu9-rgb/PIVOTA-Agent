'use strict';

// Zero-result classification for find_products_multi. MEASUREMENT ONLY: nothing here changes what a
// lane serves.
//
// Every search lane in the invoke handler answers the request itself, so an empty page says nothing
// about WHY it is empty. This module names the cause, as short fixed tokens for the completion log
// line, so that empties can be split into:
//   degraded      the lane did not work: it timed out or errored.
//   genuine       the lane ran and nothing passed its gates (no catalog match, category, price,
//                 relevance or serving gate). An honest empty answer.
//   policy        a deliberate refusal (safe-empty contract, clarify, contraindication, unpriced market).
//   unclassified  the response does not say which gate emptied it. Reported as such, never guessed.
//
// There is no retry here. A retry that serves another lane's rows is only acceptable once those rows
// provably pass the first lane's own relevance rules; that work lives outside this module.
//
// Flag: FIND_PRODUCTS_MULTI_ZERO_RESULT_FALLTHROUGH = off | observe (default off)
//   off      nothing changes: no response change, no new log fields.
//   observe  responses unchanged; the completion log line gains the lane, the empty reason and its
//            class, and, for ingredient answers that DID return rows, whether the lane's canonical leg
//            ran past the cap a future retry would need (so that cost can be measured first).
// Any other value (on, true, 1, ...) is treated as off; the caller logs one warning at startup.
//
// No dependencies, so it is unit-testable without loading the gateway.

const MODES = Object.freeze(['off', 'observe']);

// The budget a future ingredient-lane retry would need, used ONLY to measure how often the lane's
// canonical leg runs past the cap that retry would impose. Nothing is capped.
const PROPOSED_RETRY_DEADLINE_MS = 6000;
const PROPOSED_RETRY_MIN_BUDGET_MS = 1500;
const PROPOSED_POST_LEG_RESERVE_MS = 200;

const LANES = Object.freeze({
  INGREDIENT_DIRECT: 'ingredient_direct',
  BEAUTY_MAINLINE: 'beauty_mainline',
  UPSTREAM_SEARCH: 'upstream_search',
  SAFE_EMPTY: 'safe_empty',
  DISCOVERY_BRIDGE: 'discovery_bridge',
  CANONICAL_CHAIN: 'canonical_chain',
  OTHER: 'other',
});

// Why a lane was empty. Fixed tokens only; nothing derived from query text ever reaches a log.
const EMPTY_REASONS = Object.freeze({
  LANE_TIMEOUT: 'lane_timeout',
  LANE_ERROR: 'lane_error',
  NO_CATALOG_MATCH: 'no_catalog_match',
  CATEGORY_FILTERED: 'category_filtered',
  BUDGET_FILTERED: 'budget_filtered',
  SAFETY_FILTERED: 'safety_filtered',
  RELEVANCE_REJECTED: 'relevance_rejected',
  SERVING_REJECTED: 'serving_rejected',
  MARKET_UNPRICED: 'market_unpriced',
  POLICY_SAFE_EMPTY: 'policy_safe_empty',
  CLARIFY: 'clarify',
  UPSTREAM_TIMEOUT: 'upstream_timeout',
  UPSTREAM_ERROR: 'upstream_error',
  UPSTREAM_NO_ROWS: 'upstream_no_rows',
  UNCLASSIFIED: 'unclassified',
});

const EMPTY_CLASSES = Object.freeze({
  DEGRADED: 'degraded',
  GENUINE: 'genuine',
  POLICY: 'policy',
  UNCLASSIFIED: 'unclassified',
});

const DEGRADED_REASONS = new Set([
  EMPTY_REASONS.LANE_TIMEOUT,
  EMPTY_REASONS.LANE_ERROR,
  EMPTY_REASONS.UPSTREAM_TIMEOUT,
  EMPTY_REASONS.UPSTREAM_ERROR,
]);

const POLICY_REASONS = new Set([
  EMPTY_REASONS.SAFETY_FILTERED,
  EMPTY_REASONS.POLICY_SAFE_EMPTY,
  EMPTY_REASONS.CLARIFY,
  EMPTY_REASONS.MARKET_UNPRICED,
]);

const GENUINE_REASONS = new Set([
  EMPTY_REASONS.NO_CATALOG_MATCH,
  EMPTY_REASONS.CATEGORY_FILTERED,
  EMPTY_REASONS.BUDGET_FILTERED,
  EMPTY_REASONS.RELEVANCE_REJECTED,
  EMPTY_REASONS.SERVING_REJECTED,
  EMPTY_REASONS.UPSTREAM_NO_ROWS,
]);

function classifyEmptyReason(reason) {
  if (DEGRADED_REASONS.has(reason)) return EMPTY_CLASSES.DEGRADED;
  if (POLICY_REASONS.has(reason)) return EMPTY_CLASSES.POLICY;
  if (GENUINE_REASONS.has(reason)) return EMPTY_CLASSES.GENUINE;
  return EMPTY_CLASSES.UNCLASSIFIED;
}

/**
 * Returns { mode, invalidValue }. `invalidValue` is the (capped) raw value when the variable was set
 * to something other than off/observe, so the caller can warn once; the mode is then 'off'.
 */
function resolveZeroResultFallthroughConfig(env = process.env) {
  const raw = String(env.FIND_PRODUCTS_MULTI_ZERO_RESULT_FALLTHROUGH ?? '').trim();
  const value = raw.toLowerCase();
  if (!value) return Object.freeze({ mode: 'off', invalidValue: null });
  if (MODES.includes(value)) return Object.freeze({ mode: value, invalidValue: null });
  return Object.freeze({ mode: 'off', invalidValue: raw.slice(0, 32) });
}

function isObserving(config) {
  return Boolean(config) && config.mode === 'observe';
}

// The cap a future retry would put on the ingredient lane's canonical leg, given when the leg started.
function proposedIngredientLegCapMs(legStartedAtElapsedMs = 0) {
  return Math.max(
    0,
    PROPOSED_RETRY_DEADLINE_MS -
      PROPOSED_RETRY_MIN_BUDGET_MS -
      PROPOSED_POST_LEG_RESERVE_MS -
      Math.max(0, Number(legStartedAtElapsedMs) || 0),
  );
}

// Why the ingredient lane's filtered set is empty, from the lane's own stage counts.
function classifyIngredientDirectEmpty({
  seedPrefetchCount = 0,
  canonicalRecalledCount = 0,
  canonicalError = null,
  mergedCount = 0,
  categoryFilteredCount = 0,
  budgetFilteredCount = 0,
  finalCount = 0,
} = {}) {
  if (Number(finalCount) > 0) return null;
  if (Number(mergedCount) <= 0) {
    if (canonicalError) {
      return String(canonicalError).trim().toUpperCase() === 'STAGE_TIMEOUT'
        ? EMPTY_REASONS.LANE_TIMEOUT
        : EMPTY_REASONS.LANE_ERROR;
    }
    if (Number(seedPrefetchCount) <= 0 && Number(canonicalRecalledCount) > 0) {
      return EMPTY_REASONS.CATEGORY_FILTERED;
    }
    return EMPTY_REASONS.NO_CATALOG_MATCH;
  }
  if (Number(categoryFilteredCount) <= 0) return EMPTY_REASONS.CATEGORY_FILTERED;
  if (Number(budgetFilteredCount) <= 0) return EMPTY_REASONS.BUDGET_FILTERED;
  // Merged, categorised and priced rows existed; the contraindication filter is the only stage left.
  return EMPTY_REASONS.SAFETY_FILTERED;
}

function productList(body) {
  return body && typeof body === 'object' && !Array.isArray(body) && Array.isArray(body.products)
    ? body.products
    : [];
}

function metadataOf(body) {
  const metadata = body && typeof body === 'object' && !Array.isArray(body) ? body.metadata : null;
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
}

function isSafeEmptyBody(body) {
  const metadata = metadataOf(body);
  const decision =
    metadata.search_decision && typeof metadata.search_decision === 'object' ? metadata.search_decision : {};
  return (
    String(metadata.query_source || '') === 'search_quality_contract_v1_safe_empty' ||
    String(decision.decision_lock_reason || '') === 'search_quality_contract_ambiguous_or_non_shopping'
  );
}

// Which lane a response says served it.
function laneFromQuerySource(querySource) {
  const source = String(querySource || '').trim();
  if (!source) return LANES.OTHER;
  if (source === 'agent_products_ingredient_recall_direct') return LANES.INGREDIENT_DIRECT;
  if (/beauty_external_seed_mainline$/.test(source) || source === 'beauty_mainline_buyer_market_unpriced') {
    return LANES.BEAUTY_MAINLINE;
  }
  if (source === 'search_quality_contract_v1_safe_empty') return LANES.SAFE_EMPTY;
  if (source === 'beauty_discovery_mainline') return LANES.DISCOVERY_BRIDGE;
  if (source.startsWith('canonical_chain_catalog')) return LANES.CANONICAL_CHAIN;
  if (source === 'agent_products_search' || source === 'agent_products_error_fallback') return LANES.UPSTREAM_SEARCH;
  return LANES.OTHER;
}

function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

// Why an empty response is empty, read from the metadata the lane stamped. A gate is only named when
// the metadata shows that gate removing rows; otherwise the answer is 'unclassified'.
function classifyEmptyResponse(body) {
  if (productList(body).length > 0) return null;
  const metadata = metadataOf(body);
  const lane = laneFromQuerySource(metadata.query_source);
  if (lane === LANES.SAFE_EMPTY || isSafeEmptyBody(body)) return EMPTY_REASONS.POLICY_SAFE_EMPTY;
  if (String(metadata.query_source || '') === 'beauty_mainline_buyer_market_unpriced') {
    return EMPTY_REASONS.MARKET_UNPRICED;
  }
  if (lane === LANES.INGREDIENT_DIRECT) {
    const seed = Number(metadata.ingredient_direct_prefetch_count) || 0;
    const canonical = Number(metadata.canonical_raw_count) || 0;
    if (metadata.canonical_error && seed === 0) {
      return String(metadata.canonical_error).trim().toUpperCase() === 'STAGE_TIMEOUT'
        ? EMPTY_REASONS.LANE_TIMEOUT
        : EMPTY_REASONS.LANE_ERROR;
    }
    if (seed === 0 && canonical === 0) return EMPTY_REASONS.NO_CATALOG_MATCH;
    if (positive(metadata.contraindicated_product_filtered_count)) return EMPTY_REASONS.SAFETY_FILTERED;
    if (positive(metadata.ingredient_direct_budget_filtered_out_count)) return EMPTY_REASONS.BUDGET_FILTERED;
    if (
      positive(metadata.ingredient_direct_category_filtered_out_count) ||
      positive(metadata.canonical_category_scope_filtered_out_count)
    ) {
      return EMPTY_REASONS.CATEGORY_FILTERED;
    }
    return EMPTY_REASONS.UNCLASSIFIED;
  }
  if (lane === LANES.BEAUTY_MAINLINE) {
    if (metadata.primary_recall_degraded === true) return EMPTY_REASONS.LANE_TIMEOUT;
    const tiers =
      metadata.search_quality_tier_counts && typeof metadata.search_quality_tier_counts === 'object'
        ? metadata.search_quality_tier_counts
        : {};
    const gate =
      metadata.search_card_quality_gate && typeof metadata.search_card_quality_gate === 'object'
        ? metadata.search_card_quality_gate
        : {};
    if (tiers.input_count !== undefined && Number(tiers.input_count) === 0) return EMPTY_REASONS.NO_CATALOG_MATCH;
    const gateInput = Number(gate.input_count);
    if (gate.input_count !== undefined && Number.isFinite(gateInput)) {
      if (gateInput === 0) return EMPTY_REASONS.RELEVANCE_REJECTED;
      if (gateInput - (Number(gate.rejected_count) || 0) <= 0) return EMPTY_REASONS.SERVING_REJECTED;
    }
    if (positive(metadata.beauty_mainline_budget_filtered_out_count)) return EMPTY_REASONS.BUDGET_FILTERED;
    return EMPTY_REASONS.UNCLASSIFIED;
  }
  const decision =
    metadata.search_decision && typeof metadata.search_decision === 'object' ? metadata.search_decision : {};
  const fallback =
    metadata.proxy_search_fallback && typeof metadata.proxy_search_fallback === 'object'
      ? metadata.proxy_search_fallback
      : {};
  const reasonText = `${fallback.reason || ''} ${metadata.strict_empty_reason || ''}`.toLowerCase();
  if (/timeout|deadline/.test(reasonText)) return EMPTY_REASONS.UPSTREAM_TIMEOUT;
  if (/exception|5xx|error|failed/.test(reasonText)) return EMPTY_REASONS.UPSTREAM_ERROR;
  if (String(decision.final_decision || '') === 'clarify') return EMPTY_REASONS.CLARIFY;
  if (lane === LANES.UPSTREAM_SEARCH) return EMPTY_REASONS.UPSTREAM_NO_ROWS;
  return EMPTY_REASONS.UNCLASSIFIED;
}

/**
 * Fields for the 'invoke request complete' line. Only in observe mode, only for find_products_multi.
 * `record` is what the ingredient lane recorded for this request, or null:
 *   { lane, emptyReason }       an empty ingredient answer (classified from the lane's stage counts)
 *   { lane, legMs, legCapMs }   an ingredient answer with rows
 * Without a record, an empty body is classified from its own metadata; a non-empty one logs nothing.
 */
function buildZeroResultLogFields({ config, operation, record = null, body = null } = {}) {
  if (!isObserving(config)) return {};
  if (String(operation || '').trim().toLowerCase() !== 'find_products_multi') return {};
  const productCount = productList(body).length;
  if (record && record.emptyReason && productCount === 0) {
    return {
      fpm_lane_chain: record.lane || LANES.OTHER,
      fpm_empty_reason: record.emptyReason,
      fpm_empty_class: classifyEmptyReason(record.emptyReason),
    };
  }
  if (
    record &&
    productCount > 0 &&
    Number.isFinite(Number(record.legMs)) &&
    Number.isFinite(Number(record.legCapMs))
  ) {
    const legMs = Math.max(0, Math.round(Number(record.legMs)));
    return {
      fpm_lane_chain: record.lane || LANES.OTHER,
      fpm_ingredient_leg_ms: legMs,
      fpm_ingredient_leg_over_proposed_cap: legMs > Number(record.legCapMs),
    };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || productCount > 0) return {};
  const reason = classifyEmptyResponse(body) || EMPTY_REASONS.UNCLASSIFIED;
  return {
    fpm_lane_chain: laneFromQuerySource(metadataOf(body).query_source),
    fpm_empty_reason: reason,
    fpm_empty_class: classifyEmptyReason(reason),
  };
}

module.exports = {
  DEGRADED_REASONS,
  EMPTY_CLASSES,
  EMPTY_REASONS,
  GENUINE_REASONS,
  LANES,
  MODES,
  POLICY_REASONS,
  PROPOSED_POST_LEG_RESERVE_MS,
  PROPOSED_RETRY_DEADLINE_MS,
  PROPOSED_RETRY_MIN_BUDGET_MS,
  buildZeroResultLogFields,
  classifyEmptyReason,
  classifyEmptyResponse,
  classifyIngredientDirectEmpty,
  isObserving,
  laneFromQuerySource,
  proposedIngredientLegCapMs,
  resolveZeroResultFallthroughConfig,
};
