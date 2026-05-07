/**
 * Phase 7b Step 1 — Canonical catalog search helper (data access only).
 *
 * Reads `catalog_products` JOIN `catalog_skus` JOIN `catalog_offers` from the
 * shared Pivota database, returning flattened canonical-chain rows. The SQL
 * is ported from pivota-backend's
 * `services/pivot_query_service.py:_fetch_canonical_search_rows` (Python
 * `:name` params translated to node-pg `$N`). Rank weights are kept identical
 * so canonical recall scores the same across the backend HTTP API and this
 * gateway helper.
 *
 * **Why this exists.** The gateway's existing `findProductsMulti` flow scans
 * `external_product_seeds` standalone and never reads `catalog_products` /
 * `catalog_skus` / `catalog_offers`. That made the entire pivota-backend
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
 *     there's no category match — the helper simply omits the category
 *     WHERE/score branches.
 *   - Set `verticalSearch=true` for ingredient-anchored queries (e.g.
 *     "niacinamide serum") to also match SKU `visible_option_labels` /
 *     `ingredient_ids`. Default `false` for category / brand queries.
 */

'use strict';

const DEFAULT_LIMIT = 12;
const CANDIDATE_LIMIT_MIN = 25;
const CANDIDATE_LIMIT_MAX = 200;
const ROW_LIMIT_MIN = 50;
const ROW_LIMIT_MAX = 500;

function normalizeQuery(raw) {
  if (raw == null) return '';
  return String(raw).trim().toLowerCase();
}

function clampLimit(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
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
 * @param {number} [args.limit]            Final row cap (default 12).
 * @param {function} [args.deps.query]     pg-style query function. Required.
 * @returns {Promise<Array<object>>}
 */
async function fetchCanonicalChainRows(args = {}) {
  const {
    query: queryText,
    merchantId = null,
    categoryPathPrefix = null,
    verticalSearch = false,
    limit = DEFAULT_LIMIT,
    deps = {},
  } = args;
  const { query: pgQuery } = deps;
  if (typeof pgQuery !== 'function') {
    throw new TypeError('canonicalCatalogSearch: deps.query is required');
  }

  const lowered = normalizeQuery(queryText);
  if (!lowered) return [];

  const normalizedLimit = clampLimit(limit, DEFAULT_LIMIT, 1, ROW_LIMIT_MAX);
  const candidateLimit = clampLimit(
    normalizedLimit * 4,
    CANDIDATE_LIMIT_MIN,
    CANDIDATE_LIMIT_MIN,
    CANDIDATE_LIMIT_MAX,
  );
  const rowLimit = clampLimit(normalizedLimit * 6, ROW_LIMIT_MIN, ROW_LIMIT_MIN, ROW_LIMIT_MAX);

  // Build positional params alongside the SQL fragments. Order:
  //   $1 query_exact, $2 query_like, $3 candidate_limit, $4 row_limit,
  //   then optional: merchant_id, category_path_prefix.
  const params = [lowered, `%${lowered}%`, candidateLimit, rowLimit];
  let merchantClause = '';
  if (merchantId) {
    params.push(String(merchantId));
    merchantClause = `AND p.merchant_id = $${params.length}`;
  }

  let categoryWhere = '';
  let categoryScore = '';
  if (categoryPathPrefix) {
    params.push(`${String(categoryPathPrefix)}%`);
    const bind = `$${params.length}`;
    categoryWhere = `OR (p.category_path IS NOT NULL AND p.category_path LIKE ${bind})`;
    categoryScore = `+ CASE WHEN p.category_path IS NOT NULL AND p.category_path LIKE ${bind} THEN 90 ELSE 0 END`;
  }

  let verticalWhere = '';
  let verticalScore = '';
  if (verticalSearch) {
    verticalWhere = `
      OR LOWER(COALESCE(CAST(s.visible_option_labels AS TEXT), '')) LIKE $2
      OR LOWER(COALESCE(CAST(s.ingredient_ids AS TEXT), '')) LIKE $2`;
    verticalScore = `
      + CASE WHEN LOWER(COALESCE(CAST(s.visible_option_labels AS TEXT), '')) LIKE $2 THEN 20 ELSE 0 END
      + CASE WHEN LOWER(COALESCE(CAST(s.ingredient_ids AS TEXT), '')) LIKE $2 THEN 15 ELSE 0 END`;
  }

  // Rank score weights mirror pivot_query_service.py exactly so canonical
  // recall ranks identically across the backend's HTTP API and this gateway
  // helper. Drift here would surface as inconsistent top-N between the two.
  // The +200 multi_merchant_canonical bonus is the dominant term.
  const sql = `
    WITH candidate_skus AS (
      SELECT
        m.merchant_id           AS merchant_id,
        m.merchant_name         AS merchant_name,
        m.primary_platform      AS merchant_primary_platform,
        p.product_key,
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
        p.freshness_json,
        p.updated_at            AS product_updated_at,
        s.sku_key,
        s.source_variant_id,
        s.sku,
        s.barcode,
        s.title                 AS sku_title,
        s.visible_attributes,
        s.visible_option_labels,
        s.ingredient_ids,
        s.image_url             AS sku_image_url,
        (
          CASE WHEN LOWER(COALESCE(s.sku, '')) = $1                       THEN 120 ELSE 0 END +
          CASE WHEN LOWER(COALESCE(s.source_variant_id, '')) = $1         THEN 110 ELSE 0 END +
          CASE WHEN LOWER(COALESCE(p.source_product_id, '')) = $1         THEN 105 ELSE 0 END +
          CASE WHEN LOWER(COALESCE(p.title, '')) = $1                     THEN 100 ELSE 0 END +
          CASE WHEN LOWER(COALESCE(m.merchant_name, '')) = $1             THEN  90 ELSE 0 END +
          CASE WHEN LOWER(COALESCE(p.brand, '')) = $1                     THEN  80 ELSE 0 END +
          CASE WHEN p.pdp_scope = 'multi_merchant_canonical'              THEN 200 ELSE 0 END
          ${categoryScore}
          ${verticalScore}
        ) AS rank_score
      FROM catalog_products p
      JOIN catalog_skus s ON s.product_key = p.product_key
      LEFT JOIN catalog_merchants m ON m.merchant_id = p.merchant_id
      WHERE (
        LOWER(COALESCE(p.title, '')) LIKE $2
        OR LOWER(COALESCE(p.brand, '')) LIKE $2
        OR LOWER(COALESCE(m.merchant_name, '')) LIKE $2
        OR LOWER(COALESCE(s.sku, '')) LIKE $2
        OR LOWER(COALESCE(s.title, '')) LIKE $2
        OR LOWER(COALESCE(s.source_variant_id, '')) LIKE $2
        OR LOWER(COALESCE(p.source_product_id, '')) LIKE $2
        ${categoryWhere}
        ${verticalWhere}
      )
      ${merchantClause}
      ORDER BY rank_score DESC, p.updated_at DESC, s.updated_at DESC
      LIMIT $3
    )
    SELECT
      c.merchant_id,
      c.merchant_name,
      c.merchant_primary_platform,
      c.product_key,
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
      c.freshness_json,
      c.product_updated_at,
      c.sku_key,
      c.source_variant_id,
      c.sku,
      c.barcode,
      c.sku_title,
      c.visible_attributes,
      c.visible_option_labels,
      c.ingredient_ids,
      c.sku_image_url,
      o.offer_id,
      o.catalog_track            AS offer_catalog_track,
      o.truth_tier               AS offer_truth_tier,
      o.readiness_tier           AS offer_readiness_tier,
      o.offer_mode,
      o.availability,
      o.inventory_quantity,
      o.currency,
      o.list_price,
      o.merchant_effective_price,
      o.estimated_best_price,
      o.price_confidence,
      o.source_system            AS offer_source_system,
      o.offer_payload,
      c.rank_score + CASE WHEN o.catalog_track = 'internal_merchant' THEN 10 ELSE 0 END AS rank_score
    FROM candidate_skus c
    JOIN catalog_offers o ON o.sku_key = c.sku_key
    ORDER BY rank_score DESC, c.product_updated_at DESC, o.updated_at DESC
    LIMIT $4
  `;

  const result = await pgQuery(sql, params);
  return Array.isArray(result?.rows) ? result.rows : [];
}

module.exports = {
  fetchCanonicalChainRows,
  // Exposed for tests so the upper bounds can be asserted.
  __internal: {
    DEFAULT_LIMIT,
    CANDIDATE_LIMIT_MIN,
    CANDIDATE_LIMIT_MAX,
    ROW_LIMIT_MIN,
    ROW_LIMIT_MAX,
    normalizeQuery,
    clampLimit,
  },
};
