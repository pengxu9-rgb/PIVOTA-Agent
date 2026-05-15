#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { query } = require('../src/db');

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) {
    return process.argv[idx + 1];
  }
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function relationMissing(err) {
  const message = String(err?.message || err || '').toLowerCase();
  return err?.code === '42P01' || message.includes('does not exist') || message.includes('relation');
}

async function runAudit({ limit = 100, market = 'US' } = {}) {
  const params = [limit];
  const identityFragmentation = await query(
    `
      WITH identity_rows AS (
        SELECT
          source_listing_ref,
          merchant_id,
          product_id,
          source_kind,
          source_tier,
          sellable_item_group_id,
          brand_norm,
          title_core_norm,
          variant_axes,
          official_url,
          strong_identity,
          live_read_enabled,
          identity_status,
          review_required,
          updated_at
        FROM pdp_identity_listing
        WHERE identity_status = 'approved'
          AND review_required = false
          AND brand_norm IS NOT NULL
          AND title_core_norm IS NOT NULL
      ),
      grouped AS (
        SELECT
          brand_norm,
          title_core_norm,
          COALESCE(variant_axes, '{}'::jsonb) AS variant_axes,
          COUNT(*)::int AS listing_count,
          COUNT(DISTINCT merchant_id)::int AS merchant_count,
          COUNT(DISTINCT sellable_item_group_id)::int AS sig_count,
          COUNT(DISTINCT official_url)::int AS official_url_count,
          jsonb_agg(DISTINCT sellable_item_group_id) AS sig_ids,
          jsonb_agg(DISTINCT merchant_id) AS merchant_ids,
          jsonb_agg(DISTINCT official_url) FILTER (WHERE official_url IS NOT NULL) AS official_urls,
          jsonb_agg(
            jsonb_build_object(
              'source_listing_ref', source_listing_ref,
              'merchant_id', merchant_id,
              'product_id', product_id,
              'sig', sellable_item_group_id,
              'source_kind', source_kind,
              'source_tier', source_tier,
              'live_read_enabled', live_read_enabled
            )
            ORDER BY updated_at DESC NULLS LAST
          ) AS members,
          COUNT(DISTINCT strong_identity->>'gtins') FILTER (WHERE strong_identity ? 'gtins')::int AS gtin_signature_count,
          MAX(updated_at) AS latest_updated_at
        FROM identity_rows
        GROUP BY brand_norm, title_core_norm, COALESCE(variant_axes, '{}'::jsonb)
      )
      SELECT
        *,
        CASE
          WHEN gtin_signature_count > 1 THEN 'conflicting_gtin'
          WHEN official_url_count > 1 THEN 'conflicting_official_url_only'
          WHEN sig_count > 1 THEN 'fragmented_sig'
          ELSE 'not_fragmented'
        END AS blocker_type,
        CASE
          WHEN sig_count > 1 AND merchant_count > 1 AND gtin_signature_count <= 1 THEN 'auto_merge_candidate'
          WHEN sig_count > 1 THEN 'review_required'
          ELSE 'no_action'
        END AS recommended_action
      FROM grouped
      WHERE sig_count > 1 OR merchant_count > 1
      ORDER BY sig_count DESC, merchant_count DESC, latest_updated_at DESC NULLS LAST
      LIMIT $1
    `,
    params,
  );

  const canonicalClusters = await query(
    `
      WITH offer_stats AS (
        SELECT
          cp.content_key,
          COUNT(DISTINCT o.offer_id)::int AS offer_count
        FROM catalog_products cp
        LEFT JOIN catalog_skus s ON s.product_key = cp.product_key
        LEFT JOIN catalog_offers o ON o.sku_key = s.sku_key
        WHERE cp.content_key IS NOT NULL
        GROUP BY cp.content_key
      ),
      grouped AS (
        SELECT
          cp.content_key,
          COUNT(*)::int AS member_count,
          COUNT(DISTINCT cp.merchant_id)::int AS merchant_count,
          COUNT(DISTINCT cp.pivota_signature_id)::int AS sig_count,
          COUNT(DISTINCT pgm.product_group_id)::int AS product_group_count,
          COUNT(*) FILTER (WHERE pgm.product_group_id IS NOT NULL)::int AS grouped_member_count,
          jsonb_agg(DISTINCT cp.pivota_signature_id) FILTER (WHERE cp.pivota_signature_id IS NOT NULL) AS sig_ids,
          jsonb_agg(DISTINCT cp.merchant_id) AS merchant_ids,
          jsonb_agg(
            jsonb_build_object(
              'product_key', cp.product_key,
              'merchant_id', cp.merchant_id,
              'platform', cp.platform,
              'product_id', cp.source_product_id,
              'title', cp.title,
              'brand', cp.brand,
              'sig', cp.pivota_signature_id,
              'product_group_id', pgm.product_group_id,
              'is_primary', COALESCE(pgm.is_primary, false)
            )
            ORDER BY COALESCE(pgm.is_primary, false) DESC, cp.product_key ASC
          ) AS members,
          MAX(cp.updated_at) AS latest_updated_at
        FROM catalog_products cp
        LEFT JOIN product_group_members pgm
          ON pgm.merchant_id = cp.merchant_id
         AND pgm.platform = cp.platform
         AND pgm.platform_product_id = cp.source_product_id
        WHERE cp.content_key IS NOT NULL
        GROUP BY cp.content_key
      )
      SELECT
        grouped.*,
        COALESCE(offer_stats.offer_count, 0)::int AS offer_count,
        CASE
          WHEN member_count > grouped_member_count THEN 'missing_product_group_members'
          WHEN product_group_count > 1 THEN 'split_product_group_members'
          WHEN sig_count > 1 AND merchant_count > 1 THEN 'canonical_multi_seller_ready'
          WHEN sig_count > 1 THEN 'same_merchant_duplicate'
          ELSE 'single_listing'
        END AS blocker_type,
        CASE
          WHEN sig_count > 1 AND merchant_count > 1 AND product_group_count <= 1 THEN 'auto_merge_candidate'
          WHEN member_count > grouped_member_count OR product_group_count > 1 THEN 'repair_group_members'
          ELSE 'no_action'
        END AS recommended_action
      FROM grouped
      LEFT JOIN offer_stats ON offer_stats.content_key = grouped.content_key
      WHERE sig_count > 1 OR merchant_count > 1 OR member_count > grouped_member_count
      ORDER BY merchant_count DESC, sig_count DESC, latest_updated_at DESC NULLS LAST
      LIMIT $1
    `,
    params,
  );

  const summary = {
    generated_at: new Date().toISOString(),
    scope: { market, limit },
    identity_fragmented_cluster_count: identityFragmentation.rows.length,
    canonical_cluster_count: canonicalClusters.rows.length,
    identity_auto_merge_candidates: identityFragmentation.rows.filter((row) => row.recommended_action === 'auto_merge_candidate').length,
    canonical_auto_merge_candidates: canonicalClusters.rows.filter((row) => row.recommended_action === 'auto_merge_candidate').length,
    product_group_repairs: canonicalClusters.rows.filter((row) => row.recommended_action === 'repair_group_members').length,
  };

  return {
    status: 'success',
    summary,
    identity_fragmentation: identityFragmentation.rows,
    canonical_clusters: canonicalClusters.rows,
  };
}

async function main() {
  const limit = clampInt(readArg('limit', '100'), 100, 1, 1000);
  const market = readArg('market', process.env.EXTERNAL_SEED_MARKET || 'US');
  const out = readArg('out', '');
  try {
    const report = await runAudit({ limit, market });
    const json = JSON.stringify(report, null, 2);
    if (out) {
      await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
      await fs.writeFile(out, `${json}\n`, 'utf8');
    }
    if (hasFlag('json') || !out) {
      process.stdout.write(`${json}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
    }
  } catch (err) {
    if (relationMissing(err)) {
      process.stderr.write(
        `PDP entity-resolution audit requires pdp_identity_listing, catalog_products, product_group_members, catalog_skus, and catalog_offers: ${err.message}\n`,
      );
      process.exitCode = 2;
      return;
    }
    throw err;
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err?.stack || err?.message || String(err)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  runAudit,
};
