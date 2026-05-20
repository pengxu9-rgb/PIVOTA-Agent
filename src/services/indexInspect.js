'use strict';

/**
 * Commerce index inspection helper.
 *
 * Given a content_key, seed_id, or url, fetches the full pipeline state
 * for a product from index_pipeline_state and related tables.
 *
 * Used by GET /api/admin/index/inspect.
 *
 * All queries run in parallel (Promise.all) after the lookup param is resolved.
 * Returns { found: false, ... } when the product cannot be resolved — never
 * throws for a missing product.
 */

const { createHash } = require('crypto');

/**
 * Resolve a content_key from one of three lookup params.
 *
 * @param {{ content_key?: string, seed_id?: string, url?: string }} params
 * @param {function} queryFn  - node-postgres query(sql, params) function
 * @returns {Promise<string|null>}
 */
async function resolveContentKey({ content_key, seed_id, url } = {}, queryFn) {
  if (content_key) {
    return String(content_key).trim();
  }

  if (seed_id) {
    // external_product_seeds.attached_product_key → catalog_products.product_key → content_key
    const res = await queryFn(
      `SELECT cp.content_key
       FROM external_product_seeds eps
       JOIN catalog_products cp ON cp.product_key = eps.attached_product_key
       WHERE eps.id = $1
         AND cp.content_key IS NOT NULL
       LIMIT 1`,
      [String(seed_id).trim()],
    );
    return (res.rows[0] && res.rows[0].content_key) || null;
  }

  if (url) {
    const normalizedUrl = String(url).trim();

    // 1. Try external_offer_snapshots.canonical_url match
    const offerRes = await queryFn(
      `SELECT cp.content_key
       FROM external_offer_snapshots eos
       JOIN external_product_seeds eps ON eps.canonical_url = eos.canonical_url
       JOIN catalog_products cp ON cp.product_key = eps.attached_product_key
       WHERE eos.canonical_url = $1
         AND cp.content_key IS NOT NULL
       LIMIT 1`,
      [normalizedUrl],
    );
    if (offerRes.rows[0] && offerRes.rows[0].content_key) {
      return offerRes.rows[0].content_key;
    }

    // 2. Fall back to direct canonical_url match on external_product_seeds
    const seedRes = await queryFn(
      `SELECT cp.content_key
       FROM external_product_seeds eps
       JOIN catalog_products cp ON cp.product_key = eps.attached_product_key
       WHERE eps.canonical_url = $1
         AND cp.content_key IS NOT NULL
       LIMIT 1`,
      [normalizedUrl],
    );
    return (seedRes.rows[0] && seedRes.rows[0].content_key) || null;
  }

  return null;
}

/**
 * Inspect the full commerce index pipeline state for a product.
 *
 * @param {{ content_key?: string, seed_id?: string, url?: string }} params
 * @param {{ queryFn?: function }} deps
 * @returns {Promise<object>}
 */
async function inspectIndexPipeline(
  { content_key, seed_id, url } = {},
  { queryFn } = {},
) {
  const query = queryFn || require('../db').query;
  const lookupParam = { content_key, seed_id, url };

  let resolvedContentKey = null;
  try {
    resolvedContentKey = await resolveContentKey(lookupParam, query);
  } catch (err) {
    return {
      found: false,
      error: 'RESOLUTION_FAILED',
      message: err && err.message ? err.message : String(err),
      lookup_param: lookupParam,
      resolved_content_key: null,
    };
  }

  if (!resolvedContentKey) {
    return {
      found: false,
      lookup_param: lookupParam,
      resolved_content_key: null,
    };
  }

  // Fetch all pipeline data in parallel
  const [
    pipelineRes,
    catalogRes,
    pdpViewRes,
    seedsRes,
    offersRes,
    qualityRes,
  ] = await Promise.all([
    // 1. Pipeline state
    query(
      `SELECT *
       FROM index_pipeline_state
       WHERE content_key = $1`,
      [resolvedContentKey],
    ),

    // 2. Catalog products (multiple merchant rows possible for same content_key)
    query(
      `SELECT
         cp.product_key,
         cp.merchant_id,
         cp.platform,
         cp.source_product_id,
         cp.title,
         cp.brand,
         cp.category,
         cp.category_path,
         cp.canonical_url,
         cp.image_url,
         cp.pdp_scope,
         cp.pdp_lifecycle_stage,
         cp.sync_status,
         cp.pivota_signature_id,
         cp.content_key,
         cp.catalog_track,
         cp.truth_tier,
         cp.readiness_tier,
         cp.updated_at
       FROM catalog_products cp
       WHERE cp.content_key = $1
       LIMIT 10`,
      [resolvedContentKey],
    ),

    // 3. PDP view (serving layer)
    query(
      `SELECT
         content_key,
         pivota_signature_id,
         brand,
         title,
         description,
         image_url,
         image_urls,
         currency,
         price_min,
         price_max,
         offer_count,
         offers,
         variants_count,
         category_path,
         pdp_lifecycle_stage,
         sync_status,
         refreshed_at,
         refresh_source
       FROM agent_pdp_view
       WHERE content_key = $1`,
      [resolvedContentKey],
    ),

    // 4. External product seeds attached to this content_key
    query(
      `SELECT
         eps.id,
         eps.canonical_url,
         eps.destination_url,
         eps.domain,
         eps.title,
         eps.image_url,
         eps.price_amount,
         eps.price_currency,
         eps.availability,
         eps.status,
         eps.seed_data->'review_summary'  AS review_summary,
         eps.seed_data->>'title'          AS seed_title,
         eps.seed_data->>'description'    AS seed_description,
         eps.content_lock,
         eps.updated_at
       FROM external_product_seeds eps
       JOIN catalog_products cp ON cp.product_key = eps.attached_product_key
       WHERE cp.content_key = $1
         AND eps.status = 'active'
       LIMIT 5`,
      [resolvedContentKey],
    ),

    // 5. Active offers with price
    query(
      `SELECT
         co.offer_id,
         co.list_price,
         co.merchant_effective_price,
         co.currency,
         co.availability,
         co.offer_mode,
         co.source_system,
         co.updated_at
       FROM catalog_offers co
       JOIN catalog_products cp ON cp.product_key = co.product_key
       WHERE cp.content_key = $1
       LIMIT 10`,
      [resolvedContentKey],
    ),

    // 6. Latest quality snapshot
    query(
      `SELECT
         pqs.content_quality_score,
         pqs.model_readiness_score,
         pqs.conversion_potential_score,
         pqs.rules_version,
         pqs.model_version,
         pqs.snapshot_date
       FROM product_quality_snapshot pqs
       JOIN catalog_products cp
         ON cp.merchant_id = pqs.merchant_id
        AND cp.platform = pqs.platform
        AND cp.source_product_id = pqs.platform_product_id
       WHERE cp.content_key = $1
       ORDER BY pqs.snapshot_date DESC
       LIMIT 1`,
      [resolvedContentKey],
    ),
  ]);

  return {
    found: true,
    resolved_content_key: resolvedContentKey,
    pipeline_state: pipelineRes.rows[0] || null,
    catalog_products: catalogRes.rows,
    pdp_view: pdpViewRes.rows[0] || null,
    seeds: seedsRes.rows,
    offers: offersRes.rows,
    quality_snapshot: qualityRes.rows[0] || null,
  };
}

module.exports = { inspectIndexPipeline };
