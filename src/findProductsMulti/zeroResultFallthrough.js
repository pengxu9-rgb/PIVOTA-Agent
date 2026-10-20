'use strict';

// Zero-result classification and degraded-lane retry for find_products_multi.
//
// Every search lane in the invoke handler answers the request itself: a lane that recalls nothing
// returns an empty page, and nothing downstream asks a second lane. This module classifies WHY a lane
// was empty, and only when the lane itself did not work does it allow ONE retry on another lane.
//
// An empty answer has one of three causes, and they must not be confused:
//   degraded  the lane did not work: it timed out or errored. Retryable (ingredient lane only; see
//             NEXT_LANE), inside the remaining budget.
//   genuine   the lane ran fine and nothing relevant passed its gates (no catalog match, category,
//             price, relevance or serving gate). Returned empty, honestly. NEVER retried: another
//             lane would only add loosely related rows.
//   policy    a deliberate refusal (safe-empty contract, clarify, contraindication, unpriced market).
//             Never retried.
// Rows a retry returns must pass the first lane's own relevance and admission rules (the caller
// applies them; see the ingredient lane in server.js). Nothing is relaxed to fill an answer.
//
// Flag: FIND_PRODUCTS_MULTI_ZERO_RESULT_FALLTHROUGH = off | observe | on (default off)
//   off      nothing changes: no extra lane, no response change, no new log fields.
//   observe  every empty answer is classified on the completion log line, and the retry decision is
//            computed and logged; the original answer is returned unchanged and no extra lane runs. The decision is computed with the budget `on` would have had (see
//            ingredientCanonicalStageBudgetMs), so the log answers "what would on have done".
//   on       the retry runs when the decision allows it, raced against the remaining budget; the
//            ingredient lane's canonical leg is capped so a timeout still leaves that budget.
//
// Budget: the retry never extends the request past FIND_PRODUCTS_MULTI_ZERO_RESULT_FALLTHROUGH_DEADLINE_MS
// (measured from handler entry). It is skipped when less than ..._MIN_BUDGET_MS remains, and the next
// lane is raced against exactly what remains.
//
// The lane map has one edge; see NEXT_LANE for why the others are absent.
//
// No dependencies, so it is unit-testable without loading the gateway.

const MODES = Object.freeze(['off', 'observe', 'on']);
const DEFAULT_DEADLINE_MS = 6000;
const DEFAULT_MIN_BUDGET_MS = 1500;
// The floor the ingredient lane's canonical leg is never cut below (matches the existing env clamp).
const MIN_INGREDIENT_LEG_BUDGET_MS = 500;
// What the ingredient lane spends after its leg returns (merge, filters, rank) before it decides. The
// leg cap leaves this on top of the minimum budget, or a capped leg would always land just short of it.
const POST_LEG_RESERVE_MS = 200;

const LANES = Object.freeze({
  INGREDIENT_DIRECT: 'ingredient_direct',
  BEAUTY_MAINLINE: 'beauty_mainline',
  UPSTREAM_SEARCH: 'upstream_search',
  SAFE_EMPTY: 'safe_empty',
  DISCOVERY_BRIDGE: 'discovery_bridge',
  CANONICAL_CHAIN: 'canonical_chain',
  OTHER: 'other',
});

// Which lane is tried when a lane comes back empty BECAUSE IT DID NOT WORK.
//
// ingredient_direct -> beauty_mainline: when the ingredient lane's canonical leg times out (its
//   dominant empty), the mainline reads the same catalog for the same beauty query through a
//   different plan, with its own relevance gate. Its rows are then re-checked against the ingredient
//   lane's rules (ingredient named on the product, category scope, form, price, safety).
//
// Absent on purpose:
//   beauty_mainline -> * : the mainline already merges the seed lane and the canonical chain and
//     ranks them; an empty mainline page is its relevance, serving, price or currency gate speaking.
//     A second lane would serve what that gate rejected.
//   upstream_search -> * : the router sends a query upstream only when it is neither beauty-like nor
//     an applied beauty contract, which is exactly when the mainline declines it (it returns no
//     answer), and the canonical rescue for non-beauty category prefixes already runs on this path.
//   safe_empty, strict / merchant-scoped requests: policy answers, never overridden.
const NEXT_LANE = Object.freeze({
  [LANES.INGREDIENT_DIRECT]: LANES.BEAUTY_MAINLINE,
});

// Why a lane was empty. Fixed tokens only; nothing derived from query text ever reaches a log.
const EMPTY_REASONS = Object.freeze({
  LANE_TIMEOUT: 'lane_timeout',
  LANE_ERROR: 'lane_error',
  RECALL_EMPTY: 'no_catalog_match',
  CATEGORY_FILTERED: 'category_filtered',
  BUDGET_FILTERED: 'budget_filtered',
  SAFETY_FILTERED: 'safety_filtered',
  RELEVANCE_REJECTED: 'relevance_rejected',
  SERVING_REJECTED: 'serving_rejected',
  CURRENCY_FILTERED: 'currency_filtered',
  MARKET_UNPRICED: 'market_unpriced',
  POLICY_SAFE_EMPTY: 'policy_safe_empty',
  CLARIFY: 'clarify',
  UPSTREAM_TIMEOUT: 'upstream_timeout',
  UPSTREAM_ERROR: 'upstream_error',
  UPSTREAM_NO_ROWS: 'upstream_no_rows',
  UNKNOWN: 'unknown',
});

// Empty reasons that are a decision, not a miss. The next lane must not answer over them.
const REFUSAL_REASONS = new Set([
  EMPTY_REASONS.SAFETY_FILTERED,
  EMPTY_REASONS.POLICY_SAFE_EMPTY,
  EMPTY_REASONS.CLARIFY,
  EMPTY_REASONS.MARKET_UNPRICED,
]);

// Empty reasons that mean the lane did not work. The ONLY reasons a retry may follow.
const DEGRADED_REASONS = new Set([
  EMPTY_REASONS.LANE_TIMEOUT,
  EMPTY_REASONS.LANE_ERROR,
  EMPTY_REASONS.UPSTREAM_TIMEOUT,
  EMPTY_REASONS.UPSTREAM_ERROR,
]);

const EMPTY_CLASSES = Object.freeze({ DEGRADED: 'degraded', GENUINE: 'genuine', POLICY: 'policy' });

function classifyEmptyReason(reason) {
  if (DEGRADED_REASONS.has(reason)) return EMPTY_CLASSES.DEGRADED;
  if (REFUSAL_REASONS.has(reason)) return EMPTY_CLASSES.POLICY;
  return EMPTY_CLASSES.GENUINE;
}

const SKIP_REASONS = Object.freeze({
  NO_NEXT_LANE: 'no_next_lane',
  REFUSAL: 'refusal',
  GENUINELY_EMPTY: 'genuinely_empty',
  BUDGET_EXHAUSTED: 'budget_exhausted',
  MERCHANT_SCOPED: 'merchant_scoped',
  STRICT_SURFACE: 'strict_surface',
});

const OUTCOMES = Object.freeze({
  ADOPTED: 'adopted',
  NEXT_LANE_EMPTY: 'next_lane_empty',
  NEXT_LANE_IRRELEVANT: 'next_lane_irrelevant',
  NEXT_LANE_REFUSED: 'next_lane_refused',
  NEXT_LANE_INELIGIBLE: 'next_lane_ineligible',
  NEXT_LANE_TIMEOUT: 'next_lane_timeout',
  NEXT_LANE_ERROR: 'next_lane_error',
});

function parseMs(raw, fallback, { min, max }) {
  const n = Number.parseInt(String(raw ?? '').trim(), 10);
  const value = Number.isFinite(n) ? n : fallback;
  return Math.min(max, Math.max(min, value));
}

function resolveZeroResultFallthroughConfig(env = process.env) {
  const rawMode = String(env.FIND_PRODUCTS_MULTI_ZERO_RESULT_FALLTHROUGH || '').trim().toLowerCase();
  const mode = MODES.includes(rawMode) ? rawMode : 'off';
  const deadlineMs = parseMs(env.FIND_PRODUCTS_MULTI_ZERO_RESULT_FALLTHROUGH_DEADLINE_MS, DEFAULT_DEADLINE_MS, {
    min: 1000,
    max: 20000,
  });
  const minBudgetMs = parseMs(env.FIND_PRODUCTS_MULTI_ZERO_RESULT_FALLTHROUGH_MIN_BUDGET_MS, DEFAULT_MIN_BUDGET_MS, {
    min: 250,
    max: deadlineMs,
  });
  return Object.freeze({ mode, deadlineMs, minBudgetMs });
}

function isEngaged(config) {
  return Boolean(config) && (config.mode === 'observe' || config.mode === 'on');
}

// The ingredient lane's canonical leg is the stage that empties it: when it overruns its stage budget
// the lane answers empty at that budget, which is the whole deadline. Under `on` the leg is capped so
// that a timeout still leaves the next lane its minimum budget. `off` and `observe` keep the base
// budget exactly, so neither changes what the lane serves.
function ingredientCanonicalStageBudgetMs({ config, baseBudgetMs, elapsedMs = 0 } = {}) {
  const base = Math.max(1, Number(baseBudgetMs) || 0);
  if (!config || config.mode !== 'on') return base;
  const room =
    Number(config.deadlineMs) -
    Number(config.minBudgetMs) -
    POST_LEG_RESERVE_MS -
    Math.max(0, Number(elapsedMs) || 0);
  return Math.min(base, Math.max(MIN_INGREDIENT_LEG_BUDGET_MS, Math.floor(room)));
}

// What `on` would have spent before deciding, for an `observe` decision: the leg capped as `on` caps it.
function projectElapsedForOnMode({ config, elapsedMs, legStartedAtElapsedMs, legMs } = {}) {
  const elapsed = Math.max(0, Number(elapsedMs) || 0);
  if (!config || config.mode !== 'observe') return elapsed;
  const legStart = Math.max(0, Number(legStartedAtElapsedMs) || 0);
  const leg = Math.max(0, Number(legMs) || 0);
  const cap = ingredientCanonicalStageBudgetMs({
    config: { ...config, mode: 'on' },
    baseBudgetMs: Number.MAX_SAFE_INTEGER,
    elapsedMs: legStart,
  });
  return Math.max(0, elapsed - leg + Math.min(leg, cap));
}

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
    return EMPTY_REASONS.RECALL_EMPTY;
  }
  if (Number(categoryFilteredCount) <= 0) return EMPTY_REASONS.CATEGORY_FILTERED;
  if (Number(budgetFilteredCount) <= 0) return EMPTY_REASONS.BUDGET_FILTERED;
  return EMPTY_REASONS.SAFETY_FILTERED;
}

/**
 * Decide what to do with an empty lane.
 * Returns { action, fromLane, toLane, emptyReason, skipReason, budgetMs }:
 *   action 'none'    flag off; the caller does nothing at all.
 *   action 'skip'    no fallthrough (skipReason says why).
 *   action 'observe' observe mode: log toLane/budgetMs, run nothing.
 *   action 'attempt' on mode: run toLane, raced against budgetMs.
 */
function decideZeroResultFallthrough({
  config,
  fromLane,
  emptyReason,
  elapsedMs = 0,
  hasMerchantScope = false,
  strictSurface = false,
} = {}) {
  const base = {
    fromLane: fromLane || LANES.OTHER,
    toLane: null,
    emptyReason: emptyReason || EMPTY_REASONS.UNKNOWN,
    skipReason: null,
    budgetMs: 0,
  };
  if (!isEngaged(config)) return { ...base, action: 'none' };
  const skip = (skipReason) => ({ ...base, action: 'skip', skipReason });
  if (REFUSAL_REASONS.has(emptyReason)) return skip(SKIP_REASONS.REFUSAL);
  // A lane that worked and found nothing relevant is the answer. Only a lane that did not work may be
  // retried.
  if (!DEGRADED_REASONS.has(emptyReason)) return skip(SKIP_REASONS.GENUINELY_EMPTY);
  const toLane = NEXT_LANE[fromLane] || null;
  if (!toLane) return skip(SKIP_REASONS.NO_NEXT_LANE);
  if (hasMerchantScope) return skip(SKIP_REASONS.MERCHANT_SCOPED);
  if (strictSurface) return skip(SKIP_REASONS.STRICT_SURFACE);
  const remainingMs = Math.floor(Number(config.deadlineMs) - Math.max(0, Number(elapsedMs) || 0));
  if (!(remainingMs >= Number(config.minBudgetMs))) return skip(SKIP_REASONS.BUDGET_EXHAUSTED);
  return {
    ...base,
    toLane,
    budgetMs: remainingMs,
    action: config.mode === 'on' ? 'attempt' : 'observe',
  };
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

// The outcome of the next lane's answer, as one token.
function classifyFallthroughResult(body) {
  if (!body || typeof body !== 'object') return OUTCOMES.NEXT_LANE_INELIGIBLE;
  if (isSafeEmptyBody(body)) return OUTCOMES.NEXT_LANE_REFUSED;
  if (productList(body).length === 0) return OUTCOMES.NEXT_LANE_EMPTY;
  return OUTCOMES.ADOPTED;
}

function isBlankKey(key) {
  return !key || /^[:\s]*$/.test(String(key));
}

// Primary lane first, then the next lane; a product already present (same key) is dropped. Products
// whose key cannot be computed are kept, since dropping them could hide distinct products.
function mergeLaneProducts(primary = [], secondary = [], keyFn = () => '') {
  const seen = new Set();
  const out = [];
  let duplicateCount = 0;
  for (const product of [...(Array.isArray(primary) ? primary : []), ...(Array.isArray(secondary) ? secondary : [])]) {
    if (!product || typeof product !== 'object') continue;
    const key = keyFn(product);
    if (!isBlankKey(key)) {
      if (seen.has(key)) {
        duplicateCount += 1;
        continue;
      }
      seen.add(key);
    }
    out.push(product);
  }
  return { products: out, duplicateCount };
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

function nonNegative(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Why an empty response is empty, read from the metadata the lane stamped. Fixed tokens only.
function classifyEmptyResponse(body) {
  if (productList(body).length > 0) return null;
  const metadata = metadataOf(body);
  const lane = laneFromQuerySource(metadata.query_source);
  if (lane === LANES.SAFE_EMPTY || isSafeEmptyBody(body)) return EMPTY_REASONS.POLICY_SAFE_EMPTY;
  if (String(metadata.query_source || '') === 'beauty_mainline_buyer_market_unpriced') {
    return EMPTY_REASONS.MARKET_UNPRICED;
  }
  if (lane === LANES.INGREDIENT_DIRECT) {
    const seed = nonNegative(metadata.ingredient_direct_prefetch_count);
    const canonical = nonNegative(metadata.canonical_raw_count);
    if (metadata.canonical_error && seed === 0) {
      return String(metadata.canonical_error).trim().toUpperCase() === 'STAGE_TIMEOUT'
        ? EMPTY_REASONS.LANE_TIMEOUT
        : EMPTY_REASONS.LANE_ERROR;
    }
    if (seed === 0 && canonical === 0) return EMPTY_REASONS.RECALL_EMPTY;
    if (nonNegative(metadata.contraindicated_product_filtered_count) > 0) return EMPTY_REASONS.SAFETY_FILTERED;
    if (nonNegative(metadata.ingredient_direct_budget_filtered_out_count) > 0) return EMPTY_REASONS.BUDGET_FILTERED;
    return EMPTY_REASONS.CATEGORY_FILTERED;
  }
  if (lane === LANES.BEAUTY_MAINLINE) {
    if (metadata.primary_recall_degraded === true) return EMPTY_REASONS.LANE_TIMEOUT;
    const tiers = metadata.search_quality_tier_counts && typeof metadata.search_quality_tier_counts === 'object'
      ? metadata.search_quality_tier_counts
      : {};
    const gate = metadata.search_card_quality_gate && typeof metadata.search_card_quality_gate === 'object'
      ? metadata.search_card_quality_gate
      : {};
    if (Number(tiers.input_count) === 0) return EMPTY_REASONS.RECALL_EMPTY;
    const gateInput = Number(gate.input_count);
    if (Number.isFinite(gateInput) && gateInput === 0) return EMPTY_REASONS.RELEVANCE_REJECTED;
    if (Number.isFinite(gateInput) && gateInput - nonNegative(gate.rejected_count) <= 0) {
      return EMPTY_REASONS.SERVING_REJECTED;
    }
    if (nonNegative(metadata.beauty_mainline_budget_filtered_out_count) > 0) return EMPTY_REASONS.BUDGET_FILTERED;
    return EMPTY_REASONS.CURRENCY_FILTERED;
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
  return EMPTY_REASONS.UNKNOWN;
}

/**
 * Run the next lane for an 'attempt' decision, raced against the decision's budget. Never throws.
 * `runNextLane` returns a promise of the next lane's response body (or null when it declines);
 * `raceWithBudget(promise, ms)` rejects with code STAGE_TIMEOUT when the budget runs out.
 * Returns { outcome, body, latencyMs }; `body` is set only when the outcome is 'adopted'.
 */
async function runZeroResultFallthrough({
  decision,
  runNextLane,
  raceWithBudget,
  admitProducts = (products) => products,
  now = Date.now,
} = {}) {
  if (!decision || decision.action !== 'attempt') return null;
  const startedAt = now();
  let body = null;
  let outcome;
  let relevanceDroppedCount = 0;
  try {
    body = await raceWithBudget(Promise.resolve().then(() => runNextLane()), decision.budgetMs);
    outcome = classifyFallthroughResult(body);
    if (outcome === OUTCOMES.ADOPTED) {
      // The first lane's relevance and admission rules, applied to every retry row.
      const offered = productList(body);
      const admittedRaw = admitProducts(offered);
      const admitted = Array.isArray(admittedRaw) ? admittedRaw : [];
      relevanceDroppedCount = Math.max(0, offered.length - admitted.length);
      if (admitted.length === 0) {
        outcome = OUTCOMES.NEXT_LANE_IRRELEVANT;
      } else if (relevanceDroppedCount > 0) {
        body = {
          ...body,
          products: admitted,
          page_size: admitted.length,
          total: admitted.length,
          metadata: { ...metadataOf(body), total_is_lower_bound: true },
        };
      }
    }
  } catch (err) {
    outcome = err && err.code === 'STAGE_TIMEOUT' ? OUTCOMES.NEXT_LANE_TIMEOUT : OUTCOMES.NEXT_LANE_ERROR;
  }
  return {
    outcome,
    body: outcome === OUTCOMES.ADOPTED ? body : null,
    relevanceDroppedCount,
    latencyMs: Math.max(0, now() - startedAt),
  };
}

// The response metadata block, `on` mode only.
function buildFallthroughMetadata(record) {
  return {
    mode: record.mode,
    from_lane: record.fromLane,
    to_lane: record.toLane,
    empty_reason: record.emptyReason,
    empty_class: classifyEmptyReason(record.emptyReason),
    attempted: record.attempted === true,
    adopted: record.adopted === true,
    outcome: record.outcome || null,
    skip_reason: record.skipReason || null,
    relevance_dropped_count: Math.max(0, Number(record.relevanceDroppedCount) || 0),
    budget_ms: Math.max(0, Math.round(Number(record.budgetMs) || 0)),
    latency_ms: Math.max(0, Math.round(Number(record.latencyMs) || 0)),
  };
}

// Fields for the 'invoke request complete' line. `record` is what the lane recorded for this request
// (null when no lane recorded one); `body` is the final response. Off: always {}.
function buildZeroResultLogFields({ config, operation, record = null, body = null } = {}) {
  if (!isEngaged(config)) return {};
  if (String(operation || '').trim().toLowerCase() !== 'find_products_multi') return {};
  if (record) {
    const chain = record.attempted && record.toLane ? `${record.fromLane}>${record.toLane}` : record.fromLane;
    return {
      fpm_lane_chain: chain,
      fpm_fallthrough_used: record.adopted === true,
      fpm_fallthrough: record.adopted
        ? 'used'
        : record.attempted
          ? 'tried'
          : record.action === 'observe'
            ? 'observed'
            : 'skipped',
      fpm_empty_reason: record.emptyReason,
      fpm_empty_class: classifyEmptyReason(record.emptyReason),
      ...(record.relevanceDroppedCount > 0
        ? { fpm_fallthrough_relevance_dropped: Math.max(0, Number(record.relevanceDroppedCount) || 0) }
        : {}),
      ...(record.toLane && !record.attempted ? { fpm_fallthrough_next_lane: record.toLane } : {}),
      ...(record.skipReason ? { fpm_fallthrough_skip_reason: record.skipReason } : {}),
      ...(record.outcome ? { fpm_fallthrough_outcome: record.outcome } : {}),
      ...(record.attempted || record.action === 'observe'
        ? { fpm_fallthrough_budget_ms: Math.max(0, Math.round(Number(record.budgetMs) || 0)) }
        : {}),
      ...(record.attempted ? { fpm_fallthrough_ms: Math.max(0, Math.round(Number(record.latencyMs) || 0)) } : {}),
    };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || productList(body).length > 0) return {};
  // No lane recorded a decision: the lane that answered has no next lane (every lane that has one
  // records its own decision).
  const lane = laneFromQuerySource(metadataOf(body).query_source);
  const reason = classifyEmptyResponse(body) || EMPTY_REASONS.UNKNOWN;
  const emptyClass = classifyEmptyReason(reason);
  return {
    fpm_lane_chain: lane,
    fpm_fallthrough_used: false,
    fpm_fallthrough: 'skipped',
    fpm_empty_reason: reason,
    fpm_empty_class: emptyClass,
    fpm_fallthrough_skip_reason:
      emptyClass === EMPTY_CLASSES.POLICY
        ? SKIP_REASONS.REFUSAL
        : emptyClass === EMPTY_CLASSES.GENUINE
          ? SKIP_REASONS.GENUINELY_EMPTY
          : SKIP_REASONS.NO_NEXT_LANE,
  };
}

module.exports = {
  DEFAULT_DEADLINE_MS,
  DEFAULT_MIN_BUDGET_MS,
  DEGRADED_REASONS,
  EMPTY_CLASSES,
  EMPTY_REASONS,
  LANES,
  MIN_INGREDIENT_LEG_BUDGET_MS,
  MODES,
  NEXT_LANE,
  OUTCOMES,
  POST_LEG_RESERVE_MS,
  REFUSAL_REASONS,
  SKIP_REASONS,
  buildFallthroughMetadata,
  buildZeroResultLogFields,
  classifyEmptyReason,
  classifyEmptyResponse,
  classifyFallthroughResult,
  classifyIngredientDirectEmpty,
  decideZeroResultFallthrough,
  ingredientCanonicalStageBudgetMs,
  isEngaged,
  laneFromQuerySource,
  mergeLaneProducts,
  projectElapsedForOnMode,
  resolveZeroResultFallthroughConfig,
  runZeroResultFallthrough,
};
