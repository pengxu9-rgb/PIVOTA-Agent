'use strict';

const { activeCatalogProductSourceWhere } = require('./activeCatalogSourceSql');
const { coverageCatalogJoinSql, PDP_RENDER_FRESHNESS_DAYS } = require('../auroraBff/relationshipGraphCoverage');
const { currencyForBuyerRegion, normalizeBuyerRegion } = require('../auroraBff/buyerRegion');
const { externalSeedCatalogBindingSql } = require('./externalSeedCatalogBindingSql');

const OFFER_FRESHNESS_HOURS = 48; // Existing backend refresh queue's stale tier.
const MAX_REFRESH_PRODUCTS = 200;
const MANIFEST_SCHEMA = 'relgraph.freshness_refresh.v1';
const BEAUTY_PATTERNS = ['%beauty%', '%skincare%', '%skin care%', '%serum%', '%moisturizer%',
  '%cleanser%', '%sunscreen%', '%spf%', '%makeup%', '%cosmetic%', '%fragrance%', '%hair%'];

function normalizeOptions({ market = 'US', limit = 50, selectedProductKeys = [] } = {}) {
  market = normalizeBuyerRegion(market);
  const currency = currencyForBuyerRegion(market);
  if (!market || !currency) throw new Error('unsupported_freshness_market');
  if (!Number.isInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > MAX_REFRESH_PRODUCTS) {
    throw new Error('freshness_limit_must_be_1_to_200');
  }
  if (!Array.isArray(selectedProductKeys) || selectedProductKeys.length > MAX_REFRESH_PRODUCTS ||
      selectedProductKeys.some((key) => typeof key !== 'string' || !key || key.length > 255 || /[\s\x00-\x1f]/.test(key))) {
    throw new Error('invalid_selected_product_keys');
  }
  return { market, currency, limit: Number(limit), selectedProductKeys: [...new Set(selectedProductKeys)] };
}

function isFresh(value, now, maxAgeMs) {
  if (value == null || value === '') return false;
  const at = new Date(value).getTime(); const age = new Date(now).getTime() - at;
  return Number.isFinite(at) && Number.isFinite(age) && age >= 0 && age <= maxAgeMs;
}

function pageFreshness(row, now = new Date()) {
  if (!isFresh(row.pdp_will_render_computed_at, now, PDP_RENDER_FRESHNESS_DAYS * 86400000)) {
    return 'unknown_stale'; // A stale false is no more proof of a current failure than a stale true.
  }
  return row.pdp_will_render === true ? 'fresh_renderable'
    : row.pdp_will_render === false ? 'fresh_not_renderable' : 'unknown_unchecked';
}

function offerFreshness(row, { market, currency, now = new Date() } = {}) {
  if (String(row.market || '').trim().toUpperCase() !== market) return 'market_mismatch';
  if (!currency || String(row.currency || '').trim().toUpperCase() !== currency) return 'currency_mismatch';
  if (!isFresh(row.price_checked_at, now, OFFER_FRESHNESS_HOURS * 3600000) ||
      !isFresh(row.last_crawled_at, now, OFFER_FRESHNESS_HOURS * 3600000)) return 'unknown_stale';
  const availability = String(row.availability || '').toLowerCase().replace(/[^a-z]/g, '');
  if (['outofstock', 'unavailable', 'soldout'].includes(availability)) return 'fresh_unavailable';
  const amount = Number(row.price);
  if (!Number.isFinite(amount) || amount <= 0) return 'unknown_price';
  if (!['instock', 'available'].includes(availability)) return 'unknown_availability';
  return 'fresh_available';
}

// Catalog rows have no market column. Scope by persisted offers/seed partitions, then compare
// currency separately (SGD seeds can live in US). Suppressed products never become refresh work.
function cohortSql({ keysSql = '$5', patternsSql = '$6' } = {}) {
  return `SELECT cp.* FROM catalog_products cp
    LEFT JOIN catalog_merchants cm ON cm.merchant_id = cp.merchant_id
    WHERE ${activeCatalogProductSourceWhere('cp', 'cm')}
      AND cp.sync_status = 'live' AND cp.suppressed_at IS NULL AND cp.suppression_reason IS NULL
      AND (lower(concat_ws(' ', cp.title, cp.category, cp.category_path, cp.product_type, cp.category_label)) LIKE ANY(${patternsSql}::text[])
        OR cp.product_key = ANY(${keysSql}::text[]))
      AND (EXISTS (SELECT 1 FROM catalog_offers o WHERE o.product_key = cp.product_key
          AND upper(trim(o.market)) = $1 AND o.suppressed_at IS NULL)
        OR EXISTS (SELECT 1 FROM external_product_seeds seed WHERE seed.status = 'active'
          AND upper(trim(seed.market)) = $1
          AND ${externalSeedCatalogBindingSql('seed', 'cp')}))`;
}

function offerFactsSql() {
  return `SELECT o.product_key, o.market, o.currency,
    o.price_checked_at >= now() - interval '${OFFER_FRESHNESS_HOURS} hours' AND o.price_checked_at <= now() AS price_fresh,
    origin.last_crawled_at >= now() - interval '${OFFER_FRESHNESS_HOURS} hours' AND origin.last_crawled_at <= now() AS origin_fresh,
    COALESCE(o.merchant_effective_price, o.list_price, o.estimated_best_price) > 0 AS price_valid,
    regexp_replace(lower(o.availability), '[^a-z]', '', 'g') AS stock
    FROM catalog_offers o JOIN cohort cp ON cp.product_key = o.product_key
    LEFT JOIN LATERAL (SELECT max(origin.last_crawled_at) AS last_crawled_at FROM external_product_seeds origin
      WHERE (origin.id = COALESCE(NULLIF(o.offer_payload->>'external_seed_id', ''),
      CASE WHEN o.source_system = 'external_product_seeds_mirror_v1' THEN o.source_ref END)
      OR o.source_ref = origin.canonical_url OR o.source_ref = origin.destination_url)
      AND ${externalSeedCatalogBindingSql('origin', 'cp')}
      AND origin.status = 'active' AND upper(trim(origin.market)) = upper(trim(o.market))
      AND upper(trim(origin.price_currency)) = upper(trim(o.currency))) origin ON true
    WHERE o.suppressed_at IS NULL`;
}

function freshnessAuditSql() {
  return `WITH cohort AS MATERIALIZED (${cohortSql({ keysSql: '$3', patternsSql: '$4' })}), offers AS MATERIALIZED (${offerFactsSql()}),
    page_counts AS (SELECT count(*) AS active_products,
      count(*) FILTER (WHERE pdp_will_render IS TRUE) AS stored_renderable,
      count(*) FILTER (WHERE pdp_will_render IS FALSE) AS stored_not_renderable,
      count(*) FILTER (WHERE pdp_will_render_computed_at >= now() - interval '${PDP_RENDER_FRESHNESS_DAYS} days'
        AND pdp_will_render_computed_at <= now() AND pdp_will_render IS TRUE) AS fresh_renderable,
      count(*) FILTER (WHERE pdp_will_render_computed_at >= now() - interval '${PDP_RENDER_FRESHNESS_DAYS} days'
        AND pdp_will_render_computed_at <= now() AND pdp_will_render IS FALSE) AS fresh_not_renderable,
      count(*) FILTER (WHERE pdp_will_render_computed_at IS NULL
        OR pdp_will_render_computed_at < now() - interval '${PDP_RENDER_FRESHNESS_DAYS} days'
        OR pdp_will_render_computed_at > now() OR pdp_will_render IS NULL) AS page_unknown
      FROM cohort), offer_counts AS (SELECT count(*) AS offers,
      count(*) FILTER (WHERE upper(trim(market)) <> $1) AS offer_market_mismatch,
      count(*) FILTER (WHERE upper(trim(market)) = $1 AND COALESCE(upper(trim(currency)), '') <> $2) AS offer_currency_mismatch,
      count(*) FILTER (WHERE upper(trim(market)) = $1 AND upper(trim(currency)) = $2
        AND NOT COALESCE(price_fresh AND origin_fresh, false)) AS offer_unknown_stale,
      count(*) FILTER (WHERE upper(trim(market)) = $1 AND upper(trim(currency)) = $2
        AND price_fresh AND origin_fresh AND price_valid AND stock IN ('instock', 'available')) AS offer_fresh_available,
      count(*) FILTER (WHERE upper(trim(market)) = $1 AND upper(trim(currency)) = $2
        AND price_fresh AND origin_fresh AND stock IN ('outofstock', 'unavailable', 'soldout')) AS offer_fresh_unavailable
      FROM offers) SELECT * FROM page_counts CROSS JOIN offer_counts`;
}

function refreshPlanSql({ coverageSiblingRefs = true } = {}) {
  return `WITH cohort AS MATERIALIZED (${cohortSql()}), offers AS MATERIALIZED (${offerFactsSql()}),
    eligible_refs AS MATERIALIZED (
      SELECT lower(btrim(ref)) AS ref FROM relationship_candidate_labels rcl
      CROSS JOIN LATERAL (VALUES (rcl.anchor_ref), (rcl.candidate_product_ref)) endpoint(ref)
      WHERE rcl.vertical = 'beauty' AND upper(rcl.market) = $1
        AND rcl.label_state IN ('human_approved', 'ai_approved') AND rcl.last_verified_at IS NOT NULL
        AND rcl.expires_at > now() AND NOT (rcl.id = ANY($4::text[]))
        AND btrim(ref) ~* '^product:[^:]+$'
    ), candidates AS (
      SELECT cp.product_key, coverage.relgraph_priority, coverage.relgraph_last_activity,
        CASE WHEN cp.product_key = ANY($5::text[]) THEN 0
          WHEN EXISTS (SELECT 1 FROM eligible_refs refs WHERE refs.ref = lower('product:' || cp.pivota_signature_id)
            OR refs.ref = lower('product:' || cp.source_product_id)
            OR EXISTS (SELECT 1 FROM external_product_seeds seed WHERE seed.attached_product_key = cp.product_key
              AND refs.ref = lower('product:' || seed.external_product_id))
            OR EXISTS (SELECT 1 FROM product_group_members pgm WHERE pgm.merchant_id = cp.merchant_id
              AND pgm.platform = cp.platform AND pgm.platform_product_id = cp.source_product_id
              AND refs.ref = lower('product:' || pgm.product_group_id))) THEN 1 ELSE 2 END AS lane,
        cp.pdp_will_render_computed_at
      FROM cohort cp LEFT JOIN catalog_merchants cm ON cm.merchant_id = cp.merchant_id
      ${coverageCatalogJoinSql('cp', { marketSql: '$1', suppressedIdsSql: '$4::text[]', coverageSiblingRefs, requireFreshPdp: false })}
      WHERE (cp.pdp_will_render_computed_at IS NULL OR cp.pdp_will_render IS NULL
        OR cp.pdp_will_render_computed_at < now() - interval '${PDP_RENDER_FRESHNESS_DAYS} days'
        OR cp.pdp_will_render_computed_at > now()
        OR NOT EXISTS (SELECT 1 FROM offers o WHERE o.product_key = cp.product_key
          AND upper(trim(o.market)) = $1 AND upper(trim(o.currency)) = $2 AND o.price_fresh AND o.origin_fresh
          AND (o.stock IN ('outofstock', 'unavailable', 'soldout') OR (o.price_valid AND o.stock IN ('instock', 'available')))))
        AND (cp.pdp_will_render_computed_at IS NULL OR cp.pdp_will_render IS NULL
          OR cp.pdp_will_render_computed_at < now() - interval '${PDP_RENDER_FRESHNESS_DAYS} days'
          OR cp.pdp_will_render_computed_at > now()
          OR EXISTS (SELECT 1 FROM external_product_seeds refresh_origin WHERE refresh_origin.status = 'active'
            AND upper(trim(refresh_origin.market)) = $1
            AND (refresh_origin.price_currency IS NULL OR trim(refresh_origin.price_currency) = ''
              OR upper(trim(refresh_origin.price_currency)) = $2)
            AND ${externalSeedCatalogBindingSql('refresh_origin', 'cp')}))
    ) SELECT product_key FROM candidates WHERE lane < 2 OR relgraph_priority > 0
      ORDER BY lane, relgraph_priority DESC, relgraph_last_activity ASC NULLS FIRST,
        pdp_will_render_computed_at ASC NULLS FIRST, product_key LIMIT $3`;
}

function queryParams(options, suppressedIds = []) {
  const normalized = normalizeOptions(options);
  return [normalized.market, normalized.currency, normalized.limit, suppressedIds, normalized.selectedProductKeys, BEAUTY_PATTERNS];
}

function auditQueryParams(options) {
  const normalized = normalizeOptions(options);
  return [normalized.market, normalized.currency, normalized.selectedProductKeys, BEAUTY_PATTERNS];
}

const AUDIT_FIELDS = ['active_products', 'stored_renderable', 'stored_not_renderable', 'fresh_renderable',
  'fresh_not_renderable', 'page_unknown', 'offers', 'offer_market_mismatch', 'offer_currency_mismatch',
  'offer_unknown_stale', 'offer_fresh_available', 'offer_fresh_unavailable'];

function aggregateAudit(row = {}) {
  return Object.fromEntries(AUDIT_FIELDS.map((key) => {
    const count = Number(row[key]);
    return [key, Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0];
  }));
}

function buildRefreshManifest(rows, options, now = new Date()) {
  const { market, currency, limit } = normalizeOptions(options);
  if (!Array.isArray(rows) || rows.length > limit) throw new Error('refresh_plan_exceeds_limit');
  const productKeys = rows.map((row) => row.product_key);
  normalizeOptions({ market, limit, selectedProductKeys: productKeys });
  return { schema: MANIFEST_SCHEMA, generated_at: new Date(now).toISOString(), market, currency,
    max_products: limit, product_keys: [...new Set(productKeys)] };
}

module.exports = { pageFreshness, offerFreshness, freshnessAuditSql, refreshPlanSql, queryParams, auditQueryParams,
  normalizeOptions, aggregateAudit, buildRefreshManifest, MANIFEST_SCHEMA, MAX_REFRESH_PRODUCTS, OFFER_FRESHNESS_HOURS };
