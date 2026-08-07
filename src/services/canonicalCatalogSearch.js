/**
 * Phase 7b Step 1 — Canonical catalog search helper (data access only).
 *
 * Reads `catalog_products` with optional `catalog_skus` / `catalog_offers` from the
 * shared Pivota database, returning flattened canonical-chain rows. The SQL
 * is ported from pivota-backend's
 * `services/pivot_query_service.py:_fetch_canonical_search_rows` (Python
 * `:name` params translated to node-pg `$N`). Rank weights are kept identical
 * so canonical recall scores the same across the backend HTTP API and this
 * gateway helper.
 *
 * **Why this exists.** The gateway's existing `findProductsMulti` flow scans
 * `external_product_seeds` standalone and never reads `catalog_products`.
 * That made the entire pivota-backend
 * canonical-chain work (Phases 1, 2, 2-redo, 6, 7a, 7c, 8, 9, C-1/C-2/C-3)
 * invisible to live recall. Probe v13 (post category_path backfill on 3442
 * rows) confirmed: the data is correct but the gateway's recall path doesn't
 * touch it — pass-rate moved 0pp. See
 * `pivota-backend/docs/PHASE_7B_PLAN.md` for the full background.
 *
 * **Step 2 / Integration (NOT in this PR — codex pickup).** Wire this helper
 * into `findProductsMulti`'s candidate pipeline:
 *   1. Run `fetchCanonicalChainRows` in parallel with the existing seed scan.
 *   2. Dedupe by `product_key` — canonical wins over seed for the same key.
 *   3. Add telemetry (`canonical_raw_count`, `canonical_path_executed`,
 *      `canonical_dedupe_count`).
 *   4. Pin a probe v14 expectation: lipstick 0/9 → ≥6/9, overall ≥40%.
 *
 * The DB infra is already in place — codex's `9adbcf1d` (PIVOTA-Agent
 * `option-a/relax-direct-retrieval-attached-agent-seeds` branch) shipped
 * `resolveCatalogProductRefFromPivotaSignature` in `src/server.js` for the
 * PDP detail page, proving the gateway can read `catalog_products` via the
 * existing `query(sql, params)` function. This helper uses the same
 * dependency-injection pattern.
 *
 * Caller responsibilities:
 *   - Provide `deps.query` — a node-pg-style query function:
 *     `(sql, params) => Promise<{rows: object[]}>`.
 *   - Compute `categoryPathPrefix` upstream when the user query maps to a
 *     known category alias (matches the backend's
 *     `services/pdp_category_classifier.py:category_path_prefix_for_query`,
 *     e.g. "lipstick" → "beauty/makeup/lip/"). Pass `null`/`undefined` when
 *     there's no category match.
 *   - **Passing a prefix switches the helper into CATEGORY-BROWSE mode and
 *     the query-text predicate is DROPPED from the WHERE clause** — recall
 *     becomes "rows under the prefix", ranked, with `updated_at` as the
 *     effective tie-break inside a bucket. That is correct for browse
 *     surfaces and silently wrong for query-specific recall (the 2026-07-31
 *     skincare release-gate red, PR #1889). Because the switch is invisible
 *     at the call site, a caller passing a prefix MUST also declare
 *     `categoryMode: 'category_browse'` — the helper throws otherwise.
 *     `categoryMode` without a prefix is fine (text mode; browse intent
 *     simply had no bucket to browse).
 *   - Set `verticalSearch=true` for ingredient-anchored queries (e.g.
 *     "niacinamide serum") to also match SKU `visible_option_labels` /
 *     `ingredient_ids`. Default `false` for category / brand queries.
 */

'use strict';

const { activeCatalogProductSourceWhere } = require('./activeCatalogSourceSql');
const { queryWantsMultiProductSet } = require('./beautyRelevanceGate');

const DEFAULT_LIMIT = 12;
const CANDIDATE_LIMIT_MIN = 25;
const CANDIDATE_LIMIT_MAX = 200;
const ROW_LIMIT_MIN = 50;
const ROW_LIMIT_MAX = 500;

// How far past the caller's `limit` this query over-fetches, as env-tunable knobs. DEFAULTS ARE THE
// HISTORICAL 4x/6x — read the next paragraph before lowering them.
//
// Measured on prod 2026-08-05: the beauty direct-recall lane asks for limit=48, which becomes 192
// candidates and a 288-row cap; that query costs 1.9-5.5s and is 60-98% of the lane's 3.1-4.0s. Lowering
// the multipliers looks like free latency. It is not, for two reasons found in review:
//
//   1. "ORDER BY rank_score DESC keeps the best rows" IS NOT TRUE ON THE LANES THAT MATTER. In
//      category_browse mode the text predicate is dropped and categoryScore adds a flat +90 to every row
//      in the bucket, so rank_score is near-constant and ordering degenerates to the `updated_at DESC`
//      tie-break — see the 2026-07-30 restamp note above, which turned the release gate red by exactly
//      this mechanism. Cutting candidates there keeps the most RECENTLY UPDATED rows, not the most
//      relevant ones. Both production callers (beauty mainline, shopping non-beauty) use category_browse.
//   2. THE ROW COUNT IS NOT THE CANDIDATE COUNT. The outer join fans out over skus/offers, so the observed
//      234-288 rows come from 192 candidates. Those candidates then pass the caller's relevance gate at a
//      measured ~30-35%, i.e. 192 -> 58-67 products for a 48-product page. Halve the candidates and the
//      canonical leg supplies ~29-34 — it silently stops filling its own page, and the seed-leg merge
//      hides the shortfall.
//
// So the safe unit of headroom is CANDIDATES SURVIVING THE GATE, not rows: hold
// candidate_limit * survival >= the caller's limit. To cut cost without touching recall, reduce the row
// fan-out (e.g. the unfiltered offer join) rather than the candidate depth.
function multiplierFromEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}
const CANDIDATE_LIMIT_MULTIPLIER = multiplierFromEnv('CANONICAL_CHAIN_CANDIDATE_MULTIPLIER', 4);
const ROW_LIMIT_MULTIPLIER = multiplierFromEnv('CANONICAL_CHAIN_ROW_MULTIPLIER', 6);

// Generic words dropped from query token matching (tokenMatch mode) so they
// don't dominate the token-overlap score / pull in irrelevant rows.
const TOKEN_STOPWORDS = new Set([
  'the', 'for', 'with', 'and', 'from', 'best', 'buy', 'top', 'good', 'great',
  'your', 'our', 'new', 'all', 'any', 'that', 'this', 'are', 'how', 'what',
  'under', 'over', 'cheap', 'affordable', 'recommend', 'recommended', 'review',
  'reviews', 'vs', 'near', 'online', 'shop', 'store',
]);

function normalizeQuery(raw) {
  if (raw == null) return '';
  return String(raw).trim().toLowerCase();
}

// ADR-020 search-wiring slice: env-flag gate for the recall_doc match lane.
// Read PER CALL (not at module load) so ops can flip the flag on a running
// process without a restart. Default OFF — serving is byte-identical until
// the flag is explicitly enabled.
const RECALL_DOC_MATCH_FLAG_VALUES = new Set(['enabled', 'on', '1', 'true']);

function isRecallDocMatchEnabled(env = process.env) {
  return RECALL_DOC_MATCH_FLAG_VALUES.has(
    String(env.CANONICAL_CATALOG_RECALL_DOC_MATCH || '').trim().toLowerCase(),
  );
}

// ADR-020 rank-recalibration slice: env-flag gate for rank v2 (match-quality
// dominance over provenance) + the market-exemption fix for
// pdp_scope='multi_merchant_canonical'. Same per-call read discipline as
// CANONICAL_CATALOG_RECALL_DOC_MATCH above — read per call so ops can flip it
// on a running process. Default OFF — flag-off SQL and params are
// byte-identical to the pre-slice behaviour.
const RANK_V2_FLAG_VALUES = new Set(['enabled', 'on', '1', 'true']);

// Class 4 (recall-lane assessment): deterministic serving tie-break.
// `updated_at DESC` as the rank tie-break means any bulk restamp of catalog
// rows reshuffles serving order wherever rank_score ties are broad — which is
// how the 2026-07-30 restamp of 3,824 skincare rows turned the release gate
// red with no code change (category-bucket mode had near-constant rank_score,
// so ordering degenerated to recency). Under this flag the tie-break becomes
// `product_key` — arbitrary but FIXED, so data jobs can never reorder results
// whose rank is equal. Freshness stops influencing equal-rank ordering by
// design: that influence is the instability. Default off; flip alongside
// CANONICAL_CATALOG_RANK_V2 (both reorder all canonical searches — soak as
// one change).
const DETERMINISTIC_TIEBREAK_FLAG_VALUES = RANK_V2_FLAG_VALUES;

function isDeterministicTiebreakEnabled(env = process.env) {
  return DETERMINISTIC_TIEBREAK_FLAG_VALUES.has(
    String(env.CANONICAL_CATALOG_DETERMINISTIC_TIEBREAK || '').trim().toLowerCase(),
  );
}

function isRankV2Enabled(env = process.env) {
  return RANK_V2_FLAG_VALUES.has(
    String(env.CANONICAL_CATALOG_RANK_V2 || '').trim().toLowerCase(),
  );
}

// ADR-020 / issue #1927: multi-product set diversity.
//
// THE DEFECT, MEASURED ON PROD 2026-08-07. Every rank arm that carries text
// signal needs a LITERAL match — the two phrase arms (+120 title, +60
// recall_doc) need the WHOLE query contiguous, and the coverage arm (+80)
// needs EVERY significant token. On a 5-6 token natural-language query none of
// them fires for any candidate, so on the lanes that also run without
// tokenMatch the ladder goes completely inert. Measured for "lightweight gel
// moisturizer for acne-prone skin" (mainline lane params, rank v2 + recall_doc
// on): all 192 candidates scored EXACTLY 20 — the flat
// multi_merchant_canonical arm and nothing else. With the score constant,
// every ordering decision falls to the tie-break, and the tie-break
// (product_key ASC) knows nothing about what a row IS.
//
// WHY THAT SURFACES AS BUNDLES. product_key ASC is not a neutral sample of the
// tied pool — it is alphabetical, and key-space is clustered by source, so the
// cut lands in whichever corner sorts first. Measured on the same query: the
// matched pool was 4,780 rows and 17.8% set_or_collection (the catalog base
// rate), but the 192-row candidate cut came back 47% sets. The bundles did not
// outrank anything; they won an arbitrary tie-break, and 43 candidate slots
// that singles would have taken went to sets. Both singles named in #1927 were
// in the matched pool and lost the cut.
//
// THE FIX IS TWO-PART, because the two symptoms have different causes:
//   1. QUOTA AT THE CUT (SQL, below). Within a tie group, sets past
//      `candidate_limit * SET_QUOTA_SHARE` sort behind everything else, so they
//      lose the LIMIT $3 cut to singles. Restores the pool's own composition to
//      the candidate set: 91/192 sets -> 48/192 on the measured query.
//   2. WINDOW CAP AT THE HEAD (JS, applyMultiProductSetTopCap). The quota does
//      not touch the FIRST sets, so the top-8 stayed at 4/8 sets after step 1
//      alone. The cap holds sets to MULTI_PRODUCT_SET_TOP_CAP_MAX per rolling
//      window of MULTI_PRODUCT_SET_TOP_CAP_WINDOW.
//
// NEITHER PART CAN OVERRIDE A REAL MATCH. Both are strictly TIE-GROUP SCOPED —
// they only reorder rows whose rank_score is EQUAL, i.e. they replace an
// arbitrary tie-break with an informed one and can never move a row past a row
// that genuinely scored differently. When the ladder fires the way it is
// supposed to ("gentle cleanser" -> [140] Water Bank Gentle Gel Cleanser) the
// matching rows sit in higher tie groups and are untouched, set or not.
//
// AND NEITHER RUNS WHEN THE SHOPPER ASKED FOR A SET. queryWantsMultiProductSet
// (the vocabulary already used by the serving-layer demotion in server.js —
// same regex, one home) exempts "gift set", "starter kit", "discovery",
// "routine". Note "easy to pack for travel" is a SIZE intent, not a
// multi-product one, and is deliberately NOT in that vocabulary.
//
// Default OFF, per the ordering-change discipline this file already follows
// for CANONICAL_CATALOG_RANK_V2 / _DETERMINISTIC_TIEBREAK: flag off emits
// byte-identical SQL and returns the driver's rows untouched.
const SET_DIVERSITY_FLAG_VALUES = RANK_V2_FLAG_VALUES;

function isSetDiversityEnabled(env = process.env) {
  return SET_DIVERSITY_FLAG_VALUES.has(
    String(env.CANONICAL_CATALOG_SET_DIVERSITY || '').trim().toLowerCase(),
  );
}

// The family value that means "this row is several products sold together".
// Written by the sync path and backfilled across the catalog by PR #1928
// (prod 2026-08-07: 2,000 set_or_collection of 11,820 live external_referral
// rows; 617 still unclassified).
const MULTI_PRODUCT_SET_FAMILY = 'set_or_collection';

// Share of the candidate budget sets may hold. 0.25 sits deliberately ABOVE
// the 17.8% measured pool rate: the quota is a ceiling on the pathological
// case, not a target, so on a normally-composed pool it never binds and the
// candidate set is byte-identical to flag-off.
const MULTI_PRODUCT_SET_QUOTA_SHARE = 0.25;

// Rolling head cap: at most 2 sets in any 8 consecutive served rows.
const MULTI_PRODUCT_SET_TOP_CAP_WINDOW = 8;
const MULTI_PRODUCT_SET_TOP_CAP_MAX = 2;

// Read product_family out of the payload JSON, in the same precedence order as
// every other reader (server.js resolveCatalogProductRef, pdpBuilder.js,
// pdpSchemaProfile.js). The two eps.seed_data fallbacks those readers also
// consult need a join this query does not have; they are the last resort for a
// row whose payload carries nothing, and a row with no family is simply not
// treated as a set (fail-open — an unclassified row keeps today's ordering).
//
// STAYS IN JSON, NO MIGRATION. This expression appears ONLY in the candidate
// CTE's projection and the window that orders it — never in a WHERE clause —
// so it runs over rows the text predicate already admitted and no index on it
// would be usable. Measured on prod (EXPLAIN ANALYZE, "lightweight gel
// moisturizer for acne-prone skin"): planner cost 159,387 -> 159,723 (+0.2%),
// execution 3,404ms -> 3,321ms. The plan already sorts the full matched set,
// so the WindowAgg rides along free. Promoting product_family to an indexed
// column becomes worth doing when something FILTERS on it — the user-facing
// "Sets & Kits" facet — not for this.
const PRODUCT_FAMILY_SQL = `COALESCE(
          p.product_payload->>'external_seed_product_family',
          p.product_payload->>'product_family',
          p.product_payload->'external_seed_product_kind'->>'family',
          ''
        )`;

/** Is this returned row a multi-product set? Mirrors PRODUCT_FAMILY_SQL. */
function rowIsMultiProductSet(row) {
  const raw = row && row.product_payload;
  let payload = raw;
  if (typeof raw === 'string') {
    try {
      payload = JSON.parse(raw);
    } catch {
      return false;
    }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const family =
    payload.external_seed_product_family ||
    payload.product_family ||
    (payload.external_seed_product_kind && payload.external_seed_product_kind.family) ||
    '';
  return String(family).trim().toLowerCase() === MULTI_PRODUCT_SET_FAMILY;
}

function sameRankScore(left, right) {
  const a = Number(left && left.rank_score);
  const b = Number(right && right.rank_score);
  if (Number.isFinite(a) && Number.isFinite(b)) return a === b;
  return (left && left.rank_score) === (right && right.rank_score);
}

/**
 * Hold multi-product sets to `maxPerWindow` per rolling window of
 * `windowSize` served rows.
 *
 * DEMOTES, NEVER DROPS: every input row is in the output exactly once, so
 * callers' counts and pagination are unchanged. Reordering happens strictly
 * INSIDE a run of equal rank_score — a deferred set is swapped with a later
 * single from its OWN tie group, so a row can never cross a genuine score
 * boundary in either direction. A tie group with no singles left to promote
 * emits its sets in the order it received them.
 *
 * Pure; exported for tests and the dry-run harness.
 *
 * @returns {{rows: object[], deferred_count: number}}
 */
function applyMultiProductSetTopCap(rows, options = {}) {
  const windowSize = Math.max(1, Math.floor(Number(options.windowSize) || MULTI_PRODUCT_SET_TOP_CAP_WINDOW));
  const maxPerWindow = Math.max(0, Math.floor(
    Number.isFinite(Number(options.maxPerWindow))
      ? Number(options.maxPerWindow)
      : MULTI_PRODUCT_SET_TOP_CAP_MAX,
  ));
  const input = Array.isArray(rows) ? rows : [];
  if (input.length < 2) return { rows: input, deferred_count: 0 };

  const out = [];
  let deferredCount = 0;
  let groupStart = 0;
  while (groupStart < input.length) {
    let groupEnd = groupStart + 1;
    while (groupEnd < input.length && sameRankScore(input[groupEnd], input[groupStart])) groupEnd += 1;
    const pending = input.slice(groupStart, groupEnd);
    while (pending.length > 0) {
      // Window is counted over GLOBAL output positions, not per group — "at
      // most 2 sets in the top 8" is a statement about the served page.
      const setsInWindow = out
        .slice(Math.max(0, out.length - (windowSize - 1)))
        .filter(rowIsMultiProductSet).length;
      let pick = 0;
      if (rowIsMultiProductSet(pending[0]) && setsInWindow >= maxPerWindow) {
        const alternative = pending.findIndex((row) => !rowIsMultiProductSet(row));
        if (alternative > 0) {
          pick = alternative;
          deferredCount += 1;
        }
      }
      out.push(pending.splice(pick, 1)[0]);
    }
    groupStart = groupEnd;
  }
  return { rows: out, deferred_count: deferredCount };
}

// Significant query tokens: length >= 3, stopwords dropped, deduped, capped
// at 6. Shared by the tokenMatch lane (WHERE overlap + *25 rank bonus) and the
// rank-v2 all-token-coverage arm so both see the same tokenization.
function buildSignificantTokens(lowered) {
  return Array.from(
    new Set(
      lowered
        .split(/\s+/)
        .map((t) => t.trim())
        .filter((t) => t.length >= 3 && !TOKEN_STOPWORDS.has(t)),
    ),
  ).slice(0, 6);
}

// Max LIKE patterns sent to the recall_doc LIKE ANY arm. Mirrors the seed
// lane's cap discipline (findProductsExternalSeedDirectRetrieval caps its
// variant patterns at 12); 16 leaves headroom for phrase + bigrams + tokens.
const RECALL_DOC_PATTERN_CAP = 16;

/**
 * Build the `%…%` LIKE patterns for the recall_doc match lane from the user
 * query. Pure function; mirrors the external-seed lane's approach
 * (search_text LIKE ANY over token patterns — see
 * buildExternalSeedRecallLikePredicate in externalSeedRecall.js and its
 * caller in findProductsExternalSeedDirectRetrieval.js; that caller derives
 * patterns from injected tokenizers so it is not reusable here).
 *
 * Emits, in order, deduped and capped at RECALL_DOC_PATTERN_CAP:
 *   1. the lowered full phrase,
 *   2. adjacent-token bigrams over the raw token sequence (kept verbatim —
 *      recall_doc is matched with LIKE, so a bigram must appear contiguously;
 *      dropping stopwords first would build patterns that can never match),
 *   3. single significant tokens of length >= 4 (stopwords excluded so
 *      generic words like "best"/"cheap" don't fan out the recall set).
 *
 * recall_doc is stored lower()ed (migration 058), so every pattern is
 * lowercased for a case-insensitive match without an ILIKE (which would
 * defeat the trigram index's LIKE support).
 */
function buildRecallDocMatchPatterns(rawQuery) {
  const lowered = normalizeQuery(rawQuery);
  if (!lowered) return [];
  const patterns = [];
  const seen = new Set();
  const push = (text) => {
    const t = String(text || '').trim();
    if (!t) return;
    const pattern = `%${t}%`;
    if (seen.has(pattern) || patterns.length >= RECALL_DOC_PATTERN_CAP) return;
    seen.add(pattern);
    patterns.push(pattern);
  };
  push(lowered);
  const tokens = lowered.split(/\s+/).map((t) => t.trim()).filter(Boolean);
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    push(`${tokens[i]} ${tokens[i + 1]}`);
  }
  for (const token of tokens) {
    if (token.length >= 4 && !TOKEN_STOPWORDS.has(token)) push(token);
  }
  return patterns;
}

function clampLimit(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function normalizeBrandFilterTerm(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function collectBrandFilterValues(value, out = []) {
  if (value == null) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectBrandFilterValues(item, out);
    return out;
  }
  if (typeof value === 'object') {
    for (const key of ['canonical', 'brand', 'alias', 'name', 'label', 'merchant_name', 'brand_key']) {
      if (value[key] == null) continue;
      const raw = key === 'brand_key'
        ? String(value[key]).replace(/_/g, ' ')
        : value[key];
      collectBrandFilterValues(raw, out);
    }
    return out;
  }
  out.push(value);
  return out;
}

function buildBrandFilterTerms(brandFilter) {
  const terms = [];
  const seen = new Set();
  const push = (value) => {
    const normalized = normalizeBrandFilterTerm(value);
    if (!normalized || normalized.length < 3 || seen.has(normalized)) return;
    seen.add(normalized);
    terms.push(normalized);
  };
  for (const value of collectBrandFilterValues(brandFilter, [])) {
    push(value);
  }
  return terms.slice(0, 6);
}

/**
 * Core entrypoint. Returns an array of flattened canonical-chain rows
 * (one per `catalog_offers` row, joined with its product + sku + merchant).
 * Returns `[]` for an empty/whitespace query.
 *
 * @param {object} args
 * @param {string} args.query              The user-facing search text.
 * @param {string} [args.merchantId]       Optional. Restrict to a single merchant.
 * @param {string} [args.categoryPathPrefix] Optional. e.g. 'beauty/makeup/lip/'.
 * @param {boolean} [args.verticalSearch]  When true, also search SKU
 *                                         visible_option_labels + ingredient_ids
 *                                         (mirrors the backend's vertical_where).
 * @param {boolean} [args.includeSkuOffers] Optional. Join SKU/offer rows for
 *                                          downstream offer-aware callers.
 *                                          Default false keeps recall on the
 *                                          product-level indexed path.
 * @param {string|object|Array} [args.brandFilter] Optional. Restrict recall to
 *                                          a known brand/alias. Intended for
 *                                          brand_browse and brand_category
 *                                          contracts so category recall does
 *                                          not degrade into generic category
 *                                          browse.
 * @param {string} [args.marketId]         Optional. The user's market (e.g.
 *                                          'US', 'KR', 'JP'). When provided,
 *                                          Path B mirrored rows whose source
 *                                          seed has a non-matching market are
 *                                          excluded. Path A merchant rows and
 *                                          Path C canonical-scope rows pass
 *                                          through regardless. When null/unset,
 *                                          no market filter is applied (legacy
 *                                          behaviour). Mirrors the market
 *                                          filter on the external-seed-direct
 *                                          path (queryBeautyExternalSeedRowsFast
 *                                          in server.js: AND market = $1).
 * @param {number} [args.limit]            Recall depth (default 12). NOT a final row cap: it is
 *                                         multiplied into candidate_limit and row_limit (see the
 *                                         over-fetch note), and the outer join fans out over
 *                                         skus/offers, so the returned row count routinely
 *                                         exceeds it several times over.
 * @param {boolean} [args.sargableTextWhere] Optional (tokenMatch callers only).
 *                                          Opt the buyable (serving_eligible)
 *                                          lane into the citable sargable text
 *                                          WHERE: every disjunct trigram-
 *                                          bitmap-able (title/brand/token/
 *                                          recall_doc), dropping the
 *                                          merchant_name, source_product_id,
 *                                          and sku/vertical OR-EXISTS recall
 *                                          arms (rank arms unaffected). See
 *                                          the citableSargableLane comment for
 *                                          the measured plans.
 * @param {function} [args.deps.query]     pg-style query function. Required.
 * @returns {Promise<Array<object>>}
 */
async function fetchCanonicalChainRows(args = {}) {
  const {
    query: queryText,
    merchantId = null,
    categoryPathPrefix = null,
    categoryMode = null,
    verticalSearch = false,
    includeSkuOffers = false,
    brandFilter = null,
    marketId = null,
    limit = DEFAULT_LIMIT,
    eligibility = 'serving_eligible',
    tokenMatch = false,
    sargableTextWhere = false,
    deps = {},
  } = args;
  const { query: pgQuery } = deps;
  if (typeof pgQuery !== 'function') {
    throw new TypeError('canonicalCatalogSearch: deps.query is required');
  }
  // Contract guard: a category prefix silently flips this helper from
  // query-text recall to category BROWSE (the text predicate is dropped from
  // the WHERE clause — see `whereClause` below). Every caller that passes a
  // prefix must therefore say so explicitly; an undeclared prefix is the exact
  // shape of the 2026-07-31 skincare release-gate regression (PR #1889) and is
  // rejected rather than silently honored. `categoryMode` without a prefix is
  // allowed: browse intent with no resolvable bucket degrades to text mode.
  if (categoryPathPrefix && categoryMode !== 'category_browse') {
    throw new TypeError(
      "canonicalCatalogSearch: categoryPathPrefix switches recall to category-browse mode and DROPS the query-text predicate; pass categoryMode: 'category_browse' to confirm, or drop the prefix for text recall",
    );
  }
  // The eligibility gate column. Default 'serving_eligible' (has a buyable offer
  // -> shopping). 'index_eligible' is the OFFER-FREE citable surface (ADR-007):
  // trust+quality+identity without an offer. Whitelisted to avoid SQL injection.
  const eligibilityColumn =
    eligibility === 'index_eligible' ? 'index_eligible' : 'serving_eligible';

  const lowered = normalizeQuery(queryText);
  if (!lowered) return [];

  // ADR-020 rank-recalibration slice. Read once per call; gates BOTH the rank
  // v2 CASE and the market-exemption fix below so they ship/roll back as one.
  const rankV2Enabled = isRankV2Enabled();
  // Flag off emits the legacy recency tie-break byte-for-byte; flag on pins
  // equal-rank ordering to product_key so bulk restamps cannot reshuffle it.
  const deterministicTiebreak = isDeterministicTiebreakEnabled();
  const innerTiebreakSql = deterministicTiebreak ? 'p.product_key ASC' : 'p.updated_at DESC';
  const outerTiebreakSql = deterministicTiebreak
    ? 'c.product_key ASC'
    : 'c.product_updated_at DESC';
  // Set diversity (#1927). Skipped wholesale — SQL and JS alike — when the
  // shopper asked for a set, so bundle queries keep today's ordering exactly.
  const setDiversityEnabled = isSetDiversityEnabled() && !queryWantsMultiProductSet(lowered);
  // Same tie-break, expressed against the quota CTE's alias. `p.updated_at` is
  // projected as `product_updated_at`, so the legacy form has to be remapped
  // rather than string-substituted.
  const quotaTiebreakSql = deterministicTiebreak ? 'm.product_key ASC' : 'm.product_updated_at DESC';

  const normalizedLimit = clampLimit(limit, DEFAULT_LIMIT, 1, ROW_LIMIT_MAX);
  const candidateLimit = clampLimit(
    normalizedLimit * CANDIDATE_LIMIT_MULTIPLIER,
    CANDIDATE_LIMIT_MIN,
    CANDIDATE_LIMIT_MIN,
    CANDIDATE_LIMIT_MAX,
  );
  const rowLimit = clampLimit(
    normalizedLimit * ROW_LIMIT_MULTIPLIER,
    ROW_LIMIT_MIN,
    ROW_LIMIT_MIN,
    ROW_LIMIT_MAX,
  );

  // Build positional params alongside the SQL fragments. Order:
  //   $1 query_exact, $2 query_like, $3 candidate_limit, $4 row_limit,
  //   then optional: merchant_id, category_path_exact/category_path_prefix.
  const params = [lowered, `%${lowered}%`, candidateLimit, rowLimit];
  let merchantClause = '';
  if (merchantId) {
    params.push(String(merchantId));
    merchantClause = `AND p.merchant_id = $${params.length}`;
  }

  let categoryBind = '';
  let categoryExactBind = '';
  let categoryScore = '';
  if (categoryPathPrefix) {
    const normalizedCategory = String(categoryPathPrefix).trim().replace(/\/+$/, '');
    params.push(normalizedCategory);
    categoryExactBind = `$${params.length}`;
    params.push(`${normalizedCategory}/%`);
    categoryBind = `$${params.length}`;
    categoryScore = `+ CASE WHEN p.category_path IS NOT NULL AND (p.category_path = ${categoryExactBind} OR p.category_path LIKE ${categoryBind}) THEN 90 ELSE 0 END`;
  }

  // Market-aware recall. When the caller passes the user's market (e.g.
  // 'US'), exclude Path B mirrored rows whose source seed has a
  // non-matching market — mirrors the market filter on the
  // external-seed-direct path (queryBeautyExternalSeedRowsFast in
  // server.js: AND market = $1). Path A merchant rows
  // (platform != 'external_seed') and Path C canonical-scope rows
  // (pdp_scope='multi_merchant_canonical') pass through regardless;
  // they're either user-merchant inventory or cross-market canonical
  // PDPs and should always be visible. Without this, market=KR Round
  // Lab products were surfacing in US users' chat.
  // ADR-009: gate on platform, NOT merchant_id='external_seed' — external
  // seeds now mirror under per-brand observed sellers (merch_obs_…), which a
  // merchant_id check misread as Path A and exempted from the market filter,
  // re-opening the cross-market bleed for every merch_obs_ seed.
  // COALESCE guards NULL platform: merchant_id is never NULL so the legacy
  // form was NULL-immune; a bare `platform != 'external_seed'` returns NULL
  // (not TRUE) for NULL-platform connected rows via SQL 3-valued logic, which
  // would silently drop them from market-scoped recall. Treat NULL as Path A.
  // ADR-020 rank-recalibration slice (flag-gated): the unconditional
  // pdp_scope='multi_merchant_canonical' exemption is the known cross-market
  // hole — the sync stamps that scope on every graduated external row, so the
  // market filter was a no-op for exactly the graduated population. Under
  // CANONICAL_CATALOG_RANK_V2 the exemption tightens to rows whose
  // recall_market is NULL (non-graduated multi-merchant canonicals keep the
  // legacy pass-through) or matches the caller's market. Graduated rows carry
  // recall_market (migration 058 projection) and become market-scopable; a
  // graduated row can still surface cross-market via the eps.market EXISTS arm
  // when its source seed genuinely matches the caller's market.
  let marketWhere = '';
  if (marketId) {
    params.push(String(marketId).toUpperCase());
    const marketBind = `$${params.length}`;
    const canonicalScopeExemption = rankV2Enabled
      ? `(p.pdp_scope = 'multi_merchant_canonical' AND (p.recall_market IS NULL OR p.recall_market = ${marketBind}))`
      : `p.pdp_scope = 'multi_merchant_canonical'`;
    marketWhere = `
      AND (
        COALESCE(p.platform, '') <> 'external_seed'
        OR ${canonicalScopeExemption}
        OR EXISTS (
          SELECT 1 FROM external_product_seeds eps
          WHERE eps.external_product_id = p.source_product_id
            AND eps.market = ${marketBind}
        )
      )`;
  }

  const brandFilterTerms = buildBrandFilterTerms(brandFilter);
  const brandTextSql = `
    lower(concat_ws(' ',
      p.brand,
      m.merchant_name,
      p.product_payload #>> '{brand}',
      p.product_payload #>> '{vendor}',
      p.product_payload #>> '{brand_name}',
      p.product_payload #>> '{merchant_name}',
      p.product_payload #>> '{seed_data,brand}',
      p.product_payload #>> '{seed_data,vendor}',
      p.product_payload #>> '{seed_data,snapshot,brand}',
      p.product_payload #>> '{seed_data,snapshot,vendor}',
      p.product_payload #>> '{seed_data,derived,recall,brand_name}',
      p.product_payload #>> '{external_seed,brand}',
      p.product_payload #>> '{external_seed,vendor}'
    ))`;
  const compactBrandTextSql = `regexp_replace(${brandTextSql}, '[^a-z0-9]+', '', 'g')`;
  const seedBrandTextSql = `
    lower(concat_ws(' ',
      eps_brand.domain,
      eps_brand.title,
      eps_brand.seed_data->>'brand',
      eps_brand.seed_data->>'vendor',
      eps_brand.seed_data->>'brand_name',
      eps_brand.seed_data->'snapshot'->>'brand',
      eps_brand.seed_data->'snapshot'->>'vendor',
      eps_brand.seed_data->'derived'->'recall'->>'brand_name',
      eps_brand.seed_data->'derived'->'recall'->>'brand'
    ))`;
  const compactSeedBrandTextSql = `regexp_replace(${seedBrandTextSql}, '[^a-z0-9]+', '', 'g')`;
  let brandWhere = '';
  if (brandFilterTerms.length > 0) {
    const brandClauses = brandFilterTerms.map((term) => {
      params.push(`%${term}%`);
      const likeBind = `$${params.length}`;
      params.push(`%${term.replace(/\s+/g, '')}%`);
      const compactBind = `$${params.length}`;
      return `(
        ${brandTextSql} LIKE ${likeBind}
        OR ${compactBrandTextSql} LIKE ${compactBind}
        OR EXISTS (
          SELECT 1
          FROM external_product_seeds eps_brand
          WHERE eps_brand.external_product_id = p.source_product_id
            AND (
              ${seedBrandTextSql} LIKE ${likeBind}
              OR ${compactSeedBrandTextSql} LIKE ${compactBind}
            )
        )
      )`;
    });
    brandWhere = `AND (${brandClauses.join('\n        OR ')})`;
  }

  let verticalWhere = '';
  let verticalScore = '';
  let skuIdentityScore = '';
  let skuTextWhere = '';
  if (verticalSearch) {
    skuTextWhere = `
      OR EXISTS (
        SELECT 1
        FROM catalog_skus sw
        WHERE sw.product_key = p.product_key
          AND (
            LOWER(COALESCE(sw.sku, '')) LIKE $2
            OR LOWER(COALESCE(sw.title, '')) LIKE $2
            OR LOWER(COALESCE(sw.source_variant_id, '')) LIKE $2
          )
      )`;
    skuIdentityScore = `
          CASE WHEN EXISTS (
            SELECT 1 FROM catalog_skus sx
            WHERE sx.product_key = p.product_key
              AND LOWER(COALESCE(sx.sku, '')) = $1
          ) THEN 120 ELSE 0 END +
          CASE WHEN EXISTS (
            SELECT 1 FROM catalog_skus sx
            WHERE sx.product_key = p.product_key
              AND LOWER(COALESCE(sx.source_variant_id, '')) = $1
          ) THEN 110 ELSE 0 END +`;
    verticalWhere = `
      OR EXISTS (
        SELECT 1
        FROM catalog_skus sv
        WHERE sv.product_key = p.product_key
          AND (
            LOWER(COALESCE(CAST(sv.visible_option_labels AS TEXT), '')) LIKE $2
            OR LOWER(COALESCE(CAST(sv.ingredient_ids AS TEXT), '')) LIKE $2
          )
      )`;
    verticalScore = `
      + CASE WHEN EXISTS (
          SELECT 1 FROM catalog_skus ss
          WHERE ss.product_key = p.product_key
            AND LOWER(COALESCE(CAST(ss.visible_option_labels AS TEXT), '')) LIKE $2
        ) THEN 20 ELSE 0 END
      + CASE WHEN EXISTS (
          SELECT 1 FROM catalog_skus si
          WHERE si.product_key = p.product_key
            AND LOWER(COALESCE(CAST(si.ingredient_ids AS TEXT), '')) LIKE $2
        ) THEN 15 ELSE 0 END`;
  }

  // Token matching (opt-in). Whole-phrase LIKE '%full query%' misses queries
  // whose words appear non-contiguously in a title (e.g. "hair butter for
  // damaged hair" vs title "Anuko Nourishing Hair Butter"). When tokenMatch is
  // on, ALSO match rows whose title/brand contain a threshold of the query's
  // significant tokens, and rank by how many overlap. Additive — the whole-phrase
  // clause is untouched, so this only ADDS matches.
  //
  // Sargability (citable index_eligible lane only): the plain
  // "(overlap) >= minTokens" arithmetic is opaque to the planner, so on the
  // offer-free citable lane — which scans ~all index_eligible rows — it forced a
  // seq/nested-loop over the whole eligible set (~6k rows), bypassing the
  // idx_catalog_products_{title,brand}_trgm GIN indexes (prod EXPLAIN: ~2.8s just
  // for this leg). When citableSargableLane is on we ALSO emit an explicit
  // any-token superset of bare title/brand LIKEs (which the trigram indexes CAN
  // bitmap) AND the exact overlap>=minTokens recheck. overlap>=minTokens implies
  // >=1 token present, so the AND is logically a no-op on the result set — it
  // only gives the planner an indexable handle. Prod EXPLAIN flips this to a
  // trigram BitmapOr (planner cost 97060 -> 9395). The buyable tokenMatch lane
  // (serving_eligible, WS2c) keeps the plain form byte-identical — it must retain
  // merchant_name / source_product_id recall and doesn't have the same scan
  // profile. See the citable-supplement latency track / PR follow-up to #1755.
  //
  // sargableTextWhere (opt-in) extends the SAME sargable lane to a
  // serving_eligible caller — not a new matcher variant; the caller elects the
  // existing citable text-WHERE shape for the buyable population. Added for the
  // strict ingredient-direct leg (class 5, budget incoherence): its plain-form
  // statement scanned all ~7.9k serving-eligible products through the
  // index_pipeline_state nested loop and post-filtered (prod EXPLAIN ANALYZE
  // 2026-08-04: 3.2-3.9s, ~262k buffers), because merchant_name (cross-table),
  // source_product_id (no trgm index), the two OR-EXISTS catalog_skus arms, and
  // the opaque overlap arithmetic each block a bitmap plan. The sargable shape
  // flips it to a trigram BitmapOr over title/brand/recall_doc: 0.7-1.5s.
  //
  // Row parity for the buyable opt-in HOLDS ONLY WITH THE recall_doc ARM
  // PRESENT — it is scoped to flag state, not universal. Prod row-diffs with
  // CANONICAL_CATALOG_RECALL_DOC_MATCH enabled returned identical rows +
  // order on "vitamin c serum" / "salicylic acid serum" / "niacinamide" and
  // (2026-08-04 review pass) bare "retinol" / "ceramide" / "glycerin" /
  // "niacinamide". With the flag DISABLED the same probe lost 22/25 rows for
  // bare "glycerin": catalog_skus.ingredient_ids / visible_option_labels ARE
  // populated for part of the catalog, and for a single-significant-token
  // query tokenWhere is empty, so the sargable WHERE would collapse to two
  // title/brand LIKEs while main's vertical EXISTS arm was doing the
  // recalling — recall_doc (populated on graduated seeds) is what covers
  // those rows when the flag is on. Therefore the buyable opt-in only takes
  // effect when the recall_doc arm will be emitted; flag-off callers fall
  // back to the plain WHERE (complete recall, pre-#1900 plan profile). The
  // citable index_eligible lane is unaffected: its callers never pass
  // verticalSearch, so the dropped fragments are empty strings there.
  const citableSargableLane =
    tokenMatch &&
    (eligibilityColumn === 'index_eligible' ||
      (sargableTextWhere === true && isRecallDocMatchEnabled()));
  let tokenWhere = '';
  let tokenScore = '';
  if (tokenMatch) {
    const tokens = buildSignificantTokens(lowered);
    if (tokens.length >= 2) {
      const tokenBinds = [];
      const overlapParts = tokens.map((t) => {
        params.push(`%${t}%`);
        const b = `$${params.length}`;
        tokenBinds.push(b);
        return `(CASE WHEN LOWER(COALESCE(p.title, '')) LIKE ${b} OR LOWER(COALESCE(p.brand, '')) LIKE ${b} THEN 1 ELSE 0 END)`;
      });
      const overlapSql = overlapParts.join(' + ');
      const minTokens = Math.max(2, Math.ceil(tokens.length * 0.5));
      tokenScore = `+ ((${overlapSql}) * 25)`;
      if (citableSargableLane) {
        const anyTokenSql = tokenBinds
          .map((b) => `LOWER(COALESCE(p.title, '')) LIKE ${b} OR LOWER(COALESCE(p.brand, '')) LIKE ${b}`)
          .join(' OR ');
        tokenWhere = `OR ((${anyTokenSql}) AND ((${overlapSql}) >= ${minTokens}))`;
      } else {
        tokenWhere = `OR ((${overlapSql}) >= ${minTokens})`;
      }
    }
  }

  // ADR-020 rank-recalibration slice (flag-gated): rank v2. The legacy CASE
  // grants +200 for pdp_scope='multi_merchant_canonical' — a pure provenance
  // bonus that every graduated external row carries (the sync stamps it
  // unconditionally), so external systematically outranked internal. Under
  // CANONICAL_CATALOG_RANK_V2 that arm is replaced with match-quality
  // dominance (source-neutral: text-match quality outranks provenance):
  //   +120  lowered query phrase appears in the title ($2 = '%phrase%')
  //   + 80  ALL significant query tokens covered across title/brand
  //   + 60  recall_doc phrase hit (projected seed searchable text, mig 058)
  //   + 20  multi_merchant_canonical (structural bonus, scaled down 200 -> 20)
  // Every other existing arm (identity exacts 105/100/90/80, category 90,
  // vertical 20/15, token overlap *25, sku identity 120/110) keeps its current
  // weight — none is a provenance bonus exceeding the new dominant terms.
  // NOTE: the old +10 internal_merchant offer bonus no longer exists in this
  // helper (removed by the P0.3 neutrality firewall — ownership is not a
  // ranking signal); rank v2 deliberately does NOT reintroduce it.
  // Flag OFF emits the legacy arm byte-for-byte and pushes no binds.
  let canonicalScopeRankArms =
    "CASE WHEN p.pdp_scope = 'multi_merchant_canonical'              THEN 200 ELSE 0 END";
  if (rankV2Enabled) {
    const v2Arms = [
      `CASE WHEN LOWER(COALESCE(p.title, '')) LIKE $2                 THEN 120 ELSE 0 END`,
    ];
    const v2Tokens = buildSignificantTokens(lowered);
    if (v2Tokens.length > 0) {
      const coverageSql = v2Tokens
        .map((t) => {
          params.push(`%${t}%`);
          const b = `$${params.length}`;
          return `(LOWER(COALESCE(p.title, '')) LIKE ${b} OR LOWER(COALESCE(p.brand, '')) LIKE ${b})`;
        })
        .join(' AND ');
      v2Arms.push(`CASE WHEN (${coverageSql})                          THEN  80 ELSE 0 END`);
    }
    v2Arms.push(
      `CASE WHEN p.recall_doc IS NOT NULL AND p.recall_doc LIKE $2    THEN  60 ELSE 0 END`,
    );
    v2Arms.push(
      `CASE WHEN p.pdp_scope = 'multi_merchant_canonical'             THEN  20 ELSE 0 END`,
    );
    canonicalScopeRankArms = v2Arms.join(' +\n          ');
  }

  // ADR-020 search-wiring slice: flag-gated recall_doc match lane. When
  // CANONICAL_CATALOG_RECALL_DOC_MATCH is enabled, the candidate WHERE gains
  // an OR-arm over catalog_products.recall_doc (migration 058: lower()ed
  // \n-joined projection of the external-seed searchable text, partial trgm
  // GIN index WHERE recall_doc IS NOT NULL — the IS NOT NULL conjunct below
  // keeps the predicate aligned with that partial index). Patterns are the
  // lowered phrase + bigrams + long tokens (see buildRecallDocMatchPatterns).
  //
  // Market scoping (recall-doc lane ONLY — the existing marketWhere behaviour
  // is untouched in this slice): rows matched via recall_doc must also satisfy
  // (recall_market IS NULL OR recall_market = $market) when a marketId is
  // provided. Without this, the recall_doc arm would resurface cross-market
  // seeds through the known pdp_scope='multi_merchant_canonical' market
  // exemption in marketWhere (full fix is a later slice).
  //
  // Binds are captured at params.push time (params.length), same as every
  // other optional arm in this function, so appending here never renumbers an
  // existing $n placeholder.
  //
  // IMPORTANT: only build (and bind) this arm when the text branch of
  // whereClause will actually be used. When categoryPathPrefix is provided,
  // whereClause takes the category branch and discards textWhereClause — if we
  // pushed the recall-doc binds anyway, the statement would declare fewer $n
  // placeholders than supplied params (Postgres 08P01) and every category-lane
  // query would fail. The category lane simply doesn't get recall-doc matching
  // in this slice.
  let recallDocWhere = '';
  if (!categoryBind && isRecallDocMatchEnabled()) {
    const recallDocPatterns = buildRecallDocMatchPatterns(lowered);
    if (recallDocPatterns.length > 0) {
      params.push(recallDocPatterns);
      const recallDocPatternsBind = `$${params.length}`;
      let recallDocMarketGuard = '';
      if (marketId) {
        params.push(String(marketId).toUpperCase());
        recallDocMarketGuard = `
          AND (p.recall_market IS NULL OR p.recall_market = $${params.length})`;
      }
      recallDocWhere = `OR (
          p.recall_doc IS NOT NULL
          AND p.recall_doc LIKE ANY(${recallDocPatternsBind}::text[])${recallDocMarketGuard}
        )`;
    }
  }

  // On the citable sargable lane, drop the merchant_name (cross-table, defeats a
  // catalog_products-only index) and source_product_id (leading-wildcard, no
  // trigram index) OR-arms so the remaining disjuncts are all trigram-bitmap-able
  // title/brand predicates. Both dropped arms are near-dead for natural-language
  // citation queries (a merchant is ~never named the full query; source_product_id
  // is an opaque platform id). Every other lane keeps the full clause verbatim.
  //
  // The sku/vertical OR-EXISTS arms are likewise excluded from the sargable
  // WHERE: a single OR-EXISTS disjunct forces the whole disjunction off the
  // bitmap path (prod EXPLAIN 2026-08-04: keeping them, the "sargable" form ran
  // 6.9s — WORSE than the 3.2s plain form). For citable callers this is a
  // no-op (they don't pass verticalSearch, so both fragments are empty). For
  // the buyable sargableTextWhere caller the recall these arms provide is
  // covered by the recall_doc arm the lane now requires (see the
  // citableSargableLane gate above — without it, bare "glycerin" lost 22/25
  // rows that only the vertical EXISTS arm recalled). The verticalScore /
  // skuIdentityScore RANK arms — which do carry signal (+35 moved 6
  // niacinamide rows across the candidate cut) — are unaffected: they are
  // correlated EXISTS subqueries in the candidate CTE's projection (an index
  // probe on catalog_skus(product_key) per WHERE-surviving row, feeding the
  // ORDER BY), outside the WHERE disjunction, so they don't block the bitmap
  // plan; their cost scales with WHERE breadth, not with the candidate cap.
  //
  // recallDocArm carries its own leading newline+indent so that with the flag
  // off (recallDocWhere === '') the interpolation contributes zero bytes and
  // the generated SQL is byte-identical to the pre-recall-doc output (no stray
  // blank line where the arm would sit).
  const recallDocArm = recallDocWhere ? `\n        ${recallDocWhere}` : '';
  const textWhereClause = citableSargableLane
    ? `
        LOWER(COALESCE(p.title, '')) LIKE $2
        OR LOWER(COALESCE(p.brand, '')) LIKE $2
        ${tokenWhere}${recallDocArm}
  `
    : `
        LOWER(COALESCE(p.title, '')) LIKE $2
        OR LOWER(COALESCE(p.brand, '')) LIKE $2
        OR LOWER(COALESCE(m.merchant_name, '')) LIKE $2
        ${skuTextWhere}
        OR LOWER(COALESCE(p.source_product_id, '')) LIKE $2
        ${verticalWhere}
        ${tokenWhere}${recallDocArm}
  `;
  const whereClause = categoryBind
    ? `(p.category_path IS NOT NULL AND (p.category_path = ${categoryExactBind} OR p.category_path LIKE ${categoryBind}) AND $2::text IS NOT NULL)`
    : `(${textWhereClause})`;
  // Suppress source-unavailable / discontinued external-seed products from
  // recall. ADR-009: gate on platform, NOT the legacy merchant_id='external_seed'
  // bucket — external seeds now mirror under per-brand observed sellers
  // (merch_obs_…), so a merchant_id check let every source-unavailable merch_obs_
  // seed slip through and stay citable. The inner EXISTS (unchanged) still keys
  // by source_product_id and uses idx_eps_source_unavailable_epid (mig 055).
  const externalSeedUnavailableWhere = `
        AND NOT (
          COALESCE(p.platform, '') = 'external_seed'
          AND (
            lower(coalesce(p.product_payload #>> '{source_unavailable_v1,status}', '')) = 'source_unavailable'
            OR coalesce(p.product_payload #>> '{source_unavailable_v1,contract_version}', '') = 'external_seed.source_unavailable.v1'
            OR lower(coalesce(p.product_payload #>> '{transaction_readiness_blocker_v1,status}', '')) = 'source_unavailable'
            OR coalesce(p.product_payload #>> '{transaction_readiness_blocker_v1,contract_version}', '') = 'external_seed.source_unavailable.v1'
            OR EXISTS (
              SELECT 1
              FROM external_product_seeds eps_unavailable
              WHERE eps_unavailable.external_product_id = p.source_product_id
                AND (
                  lower(coalesce(eps_unavailable.seed_data #>> '{source_unavailable_v1,status}', '')) = 'source_unavailable'
                  OR coalesce(eps_unavailable.seed_data #>> '{source_unavailable_v1,contract_version}', '') = 'external_seed.source_unavailable.v1'
                  OR lower(coalesce(eps_unavailable.seed_data #>> '{snapshot,source_unavailable_v1,status}', '')) = 'source_unavailable'
                  OR coalesce(eps_unavailable.seed_data #>> '{snapshot,source_unavailable_v1,contract_version}', '') = 'external_seed.source_unavailable.v1'
                  OR lower(coalesce(eps_unavailable.seed_data #>> '{transaction_readiness_blocker_v1,status}', '')) = 'source_unavailable'
                  OR coalesce(eps_unavailable.seed_data #>> '{transaction_readiness_blocker_v1,contract_version}', '') = 'external_seed.source_unavailable.v1'
                  OR lower(coalesce(eps_unavailable.seed_data #>> '{snapshot,transaction_readiness_blocker_v1,status}', '')) = 'source_unavailable'
                  OR coalesce(eps_unavailable.seed_data #>> '{snapshot,transaction_readiness_blocker_v1,contract_version}', '') = 'external_seed.source_unavailable.v1'
                )
            )
          )
        )`;
  const joinSkuOffers = Boolean(includeSkuOffers);
  // Price presence is part of the serving contract on BOTH branches: shopping
  // ingesters reject price-null items. Either way this surfaces ONE
  // representative offer via a LATERAL — amount, currency and availability MUST
  // come from the same offer row (never mixed across rows), cheapest in-market
  // first, and currency is never defaulted: an offer without a currency is not
  // price-quotable. The branches differ only in whether the sku columns ride
  // along, not in how the price is chosen.
  let bestOfferMarketOrder = '';
  if (marketId) {
    params.push(String(marketId).toUpperCase());
    bestOfferMarketOrder = `CASE WHEN upper(coalesce(o.market, '')) = $${params.length} THEN 0 ELSE 1 END,`;
  }
  const skuOfferColumns = joinSkuOffers
    ? `
      best_sku_offer.sku_key,
      best_sku_offer.source_variant_id,
      best_sku_offer.sku,
      best_sku_offer.barcode,
      best_sku_offer.sku_title,
      best_sku_offer.visible_attributes,
      best_sku_offer.visible_option_labels,
      best_sku_offer.ingredient_ids,
      best_sku_offer.sku_image_url,
      best_sku_offer.offer_id,
      best_sku_offer.offer_catalog_track,
      best_sku_offer.offer_truth_tier,
      best_sku_offer.offer_readiness_tier,
      best_sku_offer.offer_mode,
      best_sku_offer.availability,
      best_sku_offer.inventory_quantity,
      best_sku_offer.currency,
      best_sku_offer.list_price,
      best_sku_offer.merchant_effective_price,
      best_sku_offer.estimated_best_price,
      best_sku_offer.price_confidence,
      best_sku_offer.offer_source_system,
      best_sku_offer.offer_payload,
      -- Neutrality (P0.3 firewall): NO ownership boost. A first-party
      -- internal_merchant offer must NOT outrank an equally-relevant
      -- third-party offer for the same product — ownership is not a ranking
      -- signal, merit is. (pivota-backend removed the same +10 boost; this
      -- completes that "delete pay-to-win +10" keystone on the live gateway.)
      c.rank_score AS rank_score`
    : `
      NULL::text                 AS sku_key,
      NULL::text                 AS source_variant_id,
      NULL::text                 AS sku,
      NULL::text                 AS barcode,
      NULL::text                 AS sku_title,
      NULL::jsonb                AS visible_attributes,
      NULL::jsonb                AS visible_option_labels,
      NULL::jsonb                AS ingredient_ids,
      NULL::text                 AS sku_image_url,
      NULL::text                 AS offer_id,
      NULL::text                 AS offer_catalog_track,
      NULL::text                 AS offer_truth_tier,
      NULL::text                 AS offer_readiness_tier,
      NULL::text                 AS offer_mode,
      best_offer.availability    AS availability,
      NULL::integer              AS inventory_quantity,
      best_offer.currency        AS currency,
      best_offer.list_price      AS list_price,
      best_offer.merchant_effective_price AS merchant_effective_price,
      NULL::numeric              AS estimated_best_price,
      NULL::text                 AS price_confidence,
      NULL::text                 AS offer_source_system,
      NULL::jsonb                AS offer_payload,
      c.rank_score               AS rank_score`;
  // SUPPRESSION GUARD — measured, and the measurement is the point. (Written when the sku/offer
  // branch was still a bare fan-out pair of LEFT JOINs; both branches are LATERALs now, and both
  // still carry the `suppressed_at IS NULL` filters this describes.)
  //
  // These two joins were bare while the best_offer LATERAL below (the other half of this same function)
  // has always required `suppressed_at IS NULL`. That asymmetry looks alarming because the row mapper
  // reads price straight off the joined row, and 7,294 of 22,161 offers table-wide are suppressed —
  // step5_test_rig_retirement (4,295), demo_retired_2026_07 (2,457), source_currency_or_channel_defect
  // (466) — of which 7,208 still carry a positive price and a currency, so they look servable.
  //
  // But within the population this query can actually REACH — serving_eligible joined on content_key, plus
  // activeCatalogProductSourceWhere, which already excludes test/demo merchants — the count of suppressed
  // offers on prod 2026-08-05 was ZERO of 11,236. The scary cohort is 92.6% test-rig and demo rows whose
  // PRODUCTS are excluded upstream, so they never fan out here.
  //
  // So this filter removes no rows today: no latency win, no live mispricing corrected. What it buys is a
  // closed latent hole, and the hole WAS sharp — suppressing a row is itself a write, so 7,090 of the 7,294
  // suppressed offers have updated_at >= suppressed_at, and the outer ORDER BY then ended
  // `s.updated_at DESC, o.updated_at DESC`, so a suppressed offer attaching to a serving-eligible product
  // would not merely be present, it would sort ahead of its live siblings and take the price. The
  // recency tie-break is gone now (one row per product, chosen cheapest-priced-first), so that specific
  // edge is closed twice over — but the filter stays: without it a suppressed offer would still be a
  // CANDIDATE in the LATERAL, and the likeliest instance is a source_currency_or_channel_defect row on a
  // live product — a wrong-currency amount which, being wrong, may well also be the cheapest and win.
  //
  // catalog_skus carries the same suppressed_at / suppression_reason / suppression_metadata columns and was
  // joined just as bare, so the same latent hole existed one join up and is closed here too.
  //
  // ON clause, never WHERE: these are LEFT JOINs and a WHERE would silently make them INNER, dropping every
  // product with no live sku/offer. In ON, such a product keeps its row with NULL columns and is judged by
  // the serving gate on its merits. A test asserts the outer query has no WHERE at all.
  //
  // ONE ROW PER PRODUCT, BOTH BRANCHES. The sku/offer branch used to be a bare
  // pair of LEFT JOINs that FANNED OUT — one row per (product, sku, offer) —
  // and the row mapper builds one product per ROW. Measured on prod 2026-08-05:
  // 15,961 rows for 9,289 serving-eligible products, i.e. 6,672 surplus rows;
  // 3,542 products emitted 2+ rows and one emitted 82. Three consequences, all
  // live:
  //
  //   * 727 products were served at MULTIPLE DISTINCT PRICES at once and 16
  //     under multiple currencies, because each duplicate row carried its own
  //     offer's price and nothing collapsed them.
  //   * The outer ORDER BY ended `s.updated_at DESC, o.updated_at DESC`, and
  //     Postgres DESC defaults to NULLS FIRST — so a sku carrying NO offer
  //     sorted AHEAD of the same product's priced rows. Verified on the server.
  //     Both consuming lanes dedupe first-wins (mergeCanonicalChainProductsWithSeedProducts)
  //     or not at all, so the price-less row WON: 2,816 products had an unpriced
  //     first row while a priced row existed further down. That is the sharp
  //     edge the PR #1921 comment predicted, already firing on the sku join.
  //   * The outer LIMIT counts ROWS, so duplicates ate the caller's budget and
  //     a request for N products returned fewer than N distinct ones.
  //
  // Collapsing to a LATERAL fixes all three at the source and makes the price
  // contract identical on both branches: the row carries the cheapest
  // in-market PRICED offer, with amount, currency and availability from that
  // ONE offer row. Safe to collapse because nothing downstream groups these
  // rows back into variants — of the sku/offer columns only `sku_image_url` is
  // read by the mapper, and it now describes the variant actually being priced.
  //
  // A product with no priced offer still returns its row with NULL offer
  // columns (LEFT JOIN LATERAL ... ON TRUE), emits no price, and is dropped by
  // the serving gate on its merits — the same 13 products either way.
  const skuOfferJoinSql = joinSkuOffers
    ? `
    LEFT JOIN LATERAL (
      SELECT
        s.sku_key,
        s.source_variant_id,
        s.sku,
        s.barcode,
        s.title           AS sku_title,
        s.visible_attributes,
        s.visible_option_labels,
        s.ingredient_ids,
        s.image_url       AS sku_image_url,
        o.offer_id,
        o.catalog_track   AS offer_catalog_track,
        o.truth_tier      AS offer_truth_tier,
        o.readiness_tier  AS offer_readiness_tier,
        o.offer_mode,
        o.availability,
        o.inventory_quantity,
        o.currency,
        o.list_price,
        o.merchant_effective_price,
        o.estimated_best_price,
        o.price_confidence,
        o.source_system   AS offer_source_system,
        o.offer_payload
      FROM catalog_skus s
      JOIN catalog_offers o
        ON o.sku_key = s.sku_key
       AND o.suppressed_at IS NULL
      WHERE s.product_key = c.product_key
        AND s.suppressed_at IS NULL
        AND COALESCE(o.merchant_effective_price, o.list_price) > 0
        AND o.currency IS NOT NULL
      ORDER BY ${bestOfferMarketOrder}
        COALESCE(o.merchant_effective_price, o.list_price) ASC,
        o.offer_id ASC
      LIMIT 1
    ) best_sku_offer ON TRUE`
    : `
    LEFT JOIN LATERAL (
      SELECT o.currency, o.list_price, o.merchant_effective_price, o.availability
      FROM catalog_offers o
      WHERE o.product_key = c.product_key
        AND o.suppressed_at IS NULL
        AND COALESCE(o.merchant_effective_price, o.list_price) > 0
        AND o.currency IS NOT NULL
      ORDER BY ${bestOfferMarketOrder}
        COALESCE(o.merchant_effective_price, o.list_price) ASC,
        o.offer_id ASC
      LIMIT 1
    ) best_offer ON TRUE`;
  // No sku/offer tie-break: there is exactly one row per product now, and the
  // `s.updated_at DESC, o.updated_at DESC` that used to be here is precisely
  // what sorted price-less rows first (DESC => NULLS FIRST).
  const skuOfferOrderSql = '';

  // Set-diversity quota at the candidate cut (#1927 part 1 — see the
  // MULTI_PRODUCT_SET_* block at the top of this file for the prod
  // measurements). Flag off (or a set-seeking query) contributes ZERO bytes:
  // the statement keeps its single `candidate_products` CTE carrying its own
  // ORDER BY / LIMIT $3, exactly as before.
  //
  // Flag on, the CTE splits: `matched_products` computes rank over everything
  // the WHERE admitted (no ordering, no cut), and `candidate_products` applies
  // the cut with the quota in its ORDER BY. The window is PARTITIONed BY
  // rank_score so a set is only ever ranked against sets it is TIED with, and
  // `set_quota_demoted` sorts after rank_score for the same reason: a demoted
  // set still outranks every row in a lower tie group.
  const setDiversityProjectionSql = setDiversityEnabled
    ? `\n        (${PRODUCT_FAMILY_SQL} = '${MULTI_PRODUCT_SET_FAMILY}') AS is_multi_product_set,`
    : '';
  let setDiversityCteSql = '';
  let innerOrderLimitSql = `
      ORDER BY rank_score DESC, ${innerTiebreakSql}
      LIMIT $3`;
  if (setDiversityEnabled) {
    const setQuota = Math.max(1, Math.ceil(candidateLimit * MULTI_PRODUCT_SET_QUOTA_SHARE));
    params.push(setQuota);
    const setQuotaBind = `$${params.length}`;
    innerOrderLimitSql = '';
    setDiversityCteSql = `,
    candidate_products AS (
      SELECT
        m.*,
        CASE
          WHEN m.is_multi_product_set
           AND row_number() OVER (
                 PARTITION BY m.rank_score, m.is_multi_product_set
                 ORDER BY ${quotaTiebreakSql}
               ) > ${setQuotaBind}
          THEN 1 ELSE 0
        END AS set_quota_demoted
      FROM matched_products m
      ORDER BY rank_score DESC, set_quota_demoted ASC, ${quotaTiebreakSql}
      LIMIT $3
    )`;
  }
  const candidateCteName = setDiversityEnabled ? 'matched_products' : 'candidate_products';

  // Rank score weights mirror pivot_query_service.py exactly so canonical
  // recall ranks identically across the backend's HTTP API and this gateway
  // helper. Drift here would surface as inconsistent top-N between the two.
  // The +200 multi_merchant_canonical bonus is the dominant term — UNLESS
  // CANONICAL_CATALOG_RANK_V2 is enabled, in which case the pdp_scope arm is
  // the rank-v2 match-quality block built above (canonicalScopeRankArms) and
  // the gateway intentionally diverges from the backend's legacy weights.
  const sql = `
    WITH ${candidateCteName} AS (
      SELECT
        COALESCE(m.merchant_id, p.merchant_id) AS merchant_id,
        m.merchant_name         AS merchant_name,
        m.primary_platform      AS merchant_primary_platform,
        p.product_key,
        p.platform,
        p.source_product_id,
        p.title                 AS product_title,
        p.description           AS product_description,
        p.brand,
        p.product_type,
        p.category,
        p.category_path,
        p.canonical_url,
        p.image_url             AS product_image_url,
        p.catalog_track,
        p.truth_tier,
        p.readiness_tier,
        p.pdp_scope,
        p.source_system,
        p.product_payload,
        p.freshness_json,
        p.content_key,
        p.pivota_signature_id,
        p.pivota_canonical_url,
        -- Phase O-5b: structured fashion fields with per-field provenance.
        -- Surfaced into product.fashion_meta downstream; the confidence
        -- gate in pdpBuilder.pickFashionMeta drops low-trust derived
        -- values from merchant-facing prose. Columns added in
        -- pivota-backend mig 094.
        p.material,
        p.material_source,
        p.material_confidence,
        p.care,
        p.care_source,
        p.care_confidence,
        p.size_guide,
        p.size_guide_source,
        p.size_guide_confidence,
        p.updated_at            AS product_updated_at,${setDiversityProjectionSql}
        (
          ${skuIdentityScore}
          CASE WHEN LOWER(COALESCE(p.source_product_id, '')) = $1         THEN 105 ELSE 0 END +
          CASE WHEN LOWER(COALESCE(p.title, '')) = $1                     THEN 100 ELSE 0 END +
          CASE WHEN LOWER(COALESCE(m.merchant_name, '')) = $1             THEN  90 ELSE 0 END +
          CASE WHEN LOWER(COALESCE(p.brand, '')) = $1                     THEN  80 ELSE 0 END +
          ${canonicalScopeRankArms}
          ${categoryScore}
          ${verticalScore}
          ${tokenScore}
        ) AS rank_score
      FROM catalog_products p
      INNER JOIN index_pipeline_state ips
        ON ips.content_key = p.content_key
       AND ips.${eligibilityColumn} = TRUE
      LEFT JOIN catalog_merchants m ON m.merchant_id = p.merchant_id
      WHERE ${whereClause}
        AND ${activeCatalogProductSourceWhere('p', 'm')}
        ${externalSeedUnavailableWhere}
      ${merchantClause}
      ${marketWhere}
      ${brandWhere}${innerOrderLimitSql}
    )${setDiversityCteSql}
    SELECT
      c.merchant_id,
      c.merchant_name,
      c.merchant_primary_platform,
      c.product_key,
      c.platform,
      c.source_product_id,
      c.product_title,
      c.product_description,
      c.brand,
      c.product_type,
      c.category,
      c.category_path,
      c.canonical_url,
      c.product_image_url,
      c.catalog_track,
      c.truth_tier,
      c.readiness_tier,
      c.pdp_scope,
      c.source_system,
      c.product_payload,
      c.freshness_json,
      c.content_key,
      c.pivota_signature_id,
      c.pivota_canonical_url,
      c.material,
      c.material_source,
      c.material_confidence,
      c.care,
      c.care_source,
      c.care_confidence,
      c.size_guide,
      c.size_guide_source,
      c.size_guide_confidence,
      c.product_updated_at,
      ${skuOfferColumns}
    FROM candidate_products c
    ${skuOfferJoinSql}
    ORDER BY rank_score DESC, ${outerTiebreakSql}${skuOfferOrderSql}
    LIMIT $4
  `;

  const result = await pgQuery(sql, params);
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  // #1927 part 2 — the head cap. The quota above changes WHICH rows survive the
  // cut; it deliberately leaves the first `setQuota` sets in their natural
  // positions, so on the measured query the top-8 was still 4/8 sets after the
  // quota alone. This is the part the shopper sees. Applied here rather than in
  // the outer ORDER BY because there is exactly one row per product (both
  // LATERAL branches) and row_limit >= candidate_limit always, so the array is
  // the full candidate set — reordering it in JS and in SQL are equivalent, and
  // this form is directly unit-testable.
  return setDiversityEnabled ? applyMultiProductSetTopCap(rows).rows : rows;
}

module.exports = {
  fetchCanonicalChainRows,
  // Exported so buyable sargableTextWhere callers can stamp the EFFECTIVE
  // sargable state into telemetry: the opt-in is honored only while the
  // recall_doc arm is on (see citableSargableLane), so a literal `true`
  // stamp would lie in flag-off environments.
  isRecallDocMatchEnabled,
  // Exported so callers whose lane preserves recall order (the
  // ingredient-recall-direct lane) can stamp the EFFECTIVE set-diversity state
  // into telemetry, the same way isRecallDocMatchEnabled is used above.
  isSetDiversityEnabled,
  // Exposed for tests so the upper bounds can be asserted.
  __internal: {
    DEFAULT_LIMIT,
    CANDIDATE_LIMIT_MIN,
    CANDIDATE_LIMIT_MAX,
    ROW_LIMIT_MIN,
    ROW_LIMIT_MAX,
    normalizeQuery,
    clampLimit,
    normalizeBrandFilterTerm,
    buildBrandFilterTerms,
    RECALL_DOC_PATTERN_CAP,
    isRecallDocMatchEnabled,
    buildRecallDocMatchPatterns,
    isRankV2Enabled,
    isDeterministicTiebreakEnabled,
    buildSignificantTokens,
    isSetDiversityEnabled,
    applyMultiProductSetTopCap,
    rowIsMultiProductSet,
    MULTI_PRODUCT_SET_FAMILY,
    MULTI_PRODUCT_SET_QUOTA_SHARE,
    MULTI_PRODUCT_SET_TOP_CAP_WINDOW,
    MULTI_PRODUCT_SET_TOP_CAP_MAX,
  },
};
