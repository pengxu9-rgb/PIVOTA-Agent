#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query } = require('../src/db');

function argValue(name, fallback = '') {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('--')) return fallback;
  return value;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function asString(value) {
  return String(value == null ? '' : value).trim();
}

function resolveOutPath(value) {
  const target = asString(value);
  if (!target) return '';
  return path.isAbsolute(target) ? target : path.join(process.cwd(), target);
}

async function many(sql, params = []) {
  const result = await query(sql, params);
  return result.rows || [];
}

async function one(sql, params = []) {
  const rows = await many(sql, params);
  return rows[0] || {};
}

async function run() {
  const market = asString(argValue('market', 'US')).toUpperCase() || 'US';
  const out = resolveOutPath(argValue('out'));
  const quick = hasFlag('quick');

  const ultaSeedPredicate = `
    lower(coalesce(external_product_id, '')) LIKE 'ulta:%'
    OR lower(coalesce(external_product_id, '')) LIKE 'ulta-beauty:%'
    OR lower(coalesce(domain, '')) LIKE '%ulta%'
    OR lower(coalesce(canonical_url, '')) LIKE '%ulta.com%'
    OR lower(coalesce(destination_url, '')) LIKE '%ulta.com%'
    OR lower(coalesce(seed_data->>'canonical_url', '')) LIKE '%ulta.com%'
    OR lower(coalesce(seed_data->>'destination_url', '')) LIKE '%ulta.com%'
    OR lower(coalesce(seed_data->>'external_redirect_url', '')) LIKE '%ulta.com%'
    OR lower(coalesce(seed_data#>>'{snapshot,canonical_url}', '')) LIKE '%ulta.com%'
    OR lower(coalesce(seed_data#>>'{snapshot,destination_url}', '')) LIKE '%ulta.com%'
    OR lower(coalesce(seed_data#>>'{snapshot,external_redirect_url}', '')) LIKE '%ulta.com%'
  `;
  const ultaCatalogPredicate = `
    lower(coalesce(cp.source_product_id, '')) LIKE 'ulta:%'
    OR lower(coalesce(cp.source_product_id, '')) LIKE 'ulta-beauty:%'
    OR lower(coalesce(cp.canonical_url, '')) LIKE '%ulta.com%'
    OR lower(coalesce(cp.product_payload->>'canonical_url', '')) LIKE '%ulta.com%'
    OR lower(coalesce(cp.product_payload->>'destination_url', '')) LIKE '%ulta.com%'
    OR lower(coalesce(cp.product_payload->>'external_redirect_url', '')) LIKE '%ulta.com%'
    OR lower(coalesce(cp.product_payload#>>'{external_seed,canonical_url}', '')) LIKE '%ulta.com%'
    OR lower(coalesce(cp.product_payload#>>'{external_seed,destination_url}', '')) LIKE '%ulta.com%'
    OR lower(coalesce(cp.product_payload#>>'{external_seed,external_redirect_url}', '')) LIKE '%ulta.com%'
    OR lower(coalesce(cp.product_payload#>>'{seed_data,canonical_url}', '')) LIKE '%ulta.com%'
    OR lower(coalesce(cp.product_payload#>>'{seed_data,destination_url}', '')) LIKE '%ulta.com%'
    OR lower(coalesce(cp.product_payload#>>'{seed_data,external_redirect_url}', '')) LIKE '%ulta.com%'
  `;
  const broadUltaSeedPredicate = `
    lower(coalesce(domain, '')) LIKE '%ulta%'
    OR lower(coalesce(canonical_url, '')) LIKE '%ulta.com%'
    OR lower(coalesce(destination_url, '')) LIKE '%ulta.com%'
    OR lower(coalesce(seed_data::text, '')) LIKE '%ulta.com%'
  `;
  const broadUltaCatalogPredicate = `
    lower(coalesce(cp.canonical_url, '')) LIKE '%ulta.com%'
    OR lower(coalesce(cp.product_payload::text, '')) LIKE '%ulta.com%'
    OR lower(coalesce(cp.source_product_id, '')) LIKE 'ulta:%'
    OR lower(coalesce(cp.source_product_id, '')) LIKE 'ulta-beauty:%'
  `;
  const beautyPredicate = `
    lower(coalesce(cp.category, '')) LIKE '%beauty%'
    OR lower(coalesce(cp.product_type, '')) LIKE '%beauty%'
    OR lower(coalesce(cp.category_path::text, '')) LIKE '%beauty%'
    OR lower(coalesce(cp.product_payload->>'vertical', '')) LIKE '%beauty%'
    OR lower(coalesce(cp.product_payload->>'category', '')) LIKE '%beauty%'
    OR lower(coalesce(cp.product_payload#>>'{snapshot,category}', '')) LIKE '%beauty%'
    OR lower(coalesce(cp.product_payload#>>'{external_seed,category}', '')) LIKE '%beauty%'
    OR lower(coalesce(cp.product_payload#>>'{seed_data,snapshot,category}', '')) LIKE '%beauty%'
    OR lower(coalesce(cp.brand, '')) IN (
      'benefit cosmetics',
      'bobbi brown',
      'clinique',
      'estee lauder',
      'estée lauder',
      'fenty beauty',
      'glossier',
      'hourglass',
      'lancome',
      'lancôme',
      'mac',
      'maybelline',
      'nars',
      'rare beauty',
      'tarte',
      'tom ford',
      'tom ford beauty',
      'too faced',
      'urban decay'
    )
  `;

  const [seedCoverage, catalogCoverage, skuOfferCoverage, topUltaBrands, underfilledUltaSample] =
    await Promise.all([
    one(
      `
        SELECT
          COUNT(*)::int AS total_rows,
          COUNT(*) FILTER (WHERE lower(coalesce(status, '')) = 'active')::int AS active_rows,
          COUNT(DISTINCT external_product_id)::int AS distinct_external_product_ids,
          COUNT(*) FILTER (WHERE price_amount > 0)::int AS priced_rows,
          COUNT(*) FILTER (WHERE coalesce(price_amount, 0) <= 0)::int AS unpriced_rows,
          COUNT(*) FILTER (WHERE lower(coalesce(availability, '')) IN ('in_stock', 'available'))::int AS in_stock_rows
        FROM external_product_seeds
        WHERE ${ultaSeedPredicate}
      `,
    ),
    one(
      `
        SELECT
          COUNT(*)::int AS total_rows,
          COUNT(DISTINCT cp.product_key)::int AS distinct_product_keys,
          COUNT(DISTINCT cp.source_product_id)::int AS distinct_source_product_ids,
          COUNT(DISTINCT cp.content_key)::int AS content_keys,
          COUNT(DISTINCT cp.pivota_signature_id)::int AS sigs,
          COUNT(*) FILTER (
            WHERE lower(coalesce(
              cp.product_payload->>'source_role',
              cp.product_payload#>>'{external_seed,source_role}',
              cp.product_payload#>>'{seed_data,source_role}',
              ''
            )) = 'retailer_offer'
          )::int AS retailer_offer_rows
        FROM catalog_products cp
        WHERE ${ultaCatalogPredicate}
      `,
    ),
    one(
      `
        WITH ulta_products AS (
          SELECT cp.product_key
          FROM catalog_products cp
          WHERE ${ultaCatalogPredicate}
        )
        SELECT
          COUNT(DISTINCT s.sku_key)::int AS sku_count,
          COUNT(DISTINCT o.offer_id)::int AS offer_count,
          COUNT(DISTINCT s.product_key)::int AS products_with_skus,
          COUNT(DISTINCT o.product_key)::int AS products_with_offers,
          COUNT(*) FILTER (
            WHERE coalesce(o.merchant_effective_price, o.estimated_best_price, o.list_price, 0) > 0
          )::int AS priced_offer_rows
        FROM ulta_products up
        LEFT JOIN catalog_skus s ON s.product_key = up.product_key
        LEFT JOIN catalog_offers o ON o.sku_key = s.sku_key
      `,
    ),
    many(
      `
        SELECT
          coalesce(
            nullif(btrim(coalesce(
              cp.brand,
              cp.product_payload#>>'{snapshot,brand}',
              cp.product_payload#>>'{external_seed,brand}',
              cp.product_payload#>>'{seed_data,snapshot,brand}'
            )), ''),
            'unknown'
          ) AS brand,
          COUNT(*)::int AS rows
        FROM catalog_products cp
        WHERE ${ultaCatalogPredicate}
        GROUP BY 1
        ORDER BY rows DESC, brand
        LIMIT 50
      `,
    ),
    many(
      `
        SELECT
          cp.source_product_id,
          cp.title,
          cp.brand,
          cp.canonical_url,
          cp.content_key,
          cp.pivota_signature_id,
          coalesce(e.price_amount, 0) AS seed_price,
          coalesce((
            SELECT max(coalesce(o.merchant_effective_price, o.estimated_best_price, o.list_price, 0))
            FROM catalog_skus s
            JOIN catalog_offers o ON o.sku_key = s.sku_key
            WHERE s.product_key = cp.product_key
          ), 0) AS offer_price
        FROM catalog_products cp
        LEFT JOIN external_product_seeds e ON e.external_product_id = cp.source_product_id
        WHERE (${ultaCatalogPredicate})
          AND coalesce(e.price_amount, 0) <= 0
        ORDER BY cp.updated_at DESC NULLS LAST
        LIMIT 75
      `,
    ),
  ]);

  let groupCoverage = null;
  let topMissingUltaBrands = [];
  let candidateMissingUltaSample = [];
  if (!quick) {
    [groupCoverage, topMissingUltaBrands, candidateMissingUltaSample] = await Promise.all([
      one(
        `
          WITH beauty_groups AS (
            SELECT DISTINCT pgm.product_group_id
            FROM product_group_members pgm
            JOIN catalog_products cp
              ON cp.merchant_id = pgm.merchant_id
             AND cp.platform = pgm.platform
             AND cp.source_product_id = pgm.platform_product_id
            WHERE coalesce(
                cp.product_payload->>'market',
                cp.product_payload->>'market_code',
                cp.product_payload#>>'{snapshot,market}',
                $1
              ) = $1
              AND (${beautyPredicate})
          ),
          ulta_members AS (
            SELECT DISTINCT pgm.product_group_id
            FROM product_group_members pgm
            JOIN catalog_products cp
              ON cp.merchant_id = pgm.merchant_id
             AND cp.platform = pgm.platform
             AND cp.source_product_id = pgm.platform_product_id
            WHERE ${ultaCatalogPredicate}
          )
          SELECT
            (SELECT COUNT(*)::int FROM beauty_groups) AS beauty_groups,
            (SELECT COUNT(*)::int FROM ulta_members) AS groups_with_ulta,
            (SELECT COUNT(*)::int FROM beauty_groups bg JOIN ulta_members um ON um.product_group_id = bg.product_group_id)
              AS beauty_groups_with_ulta,
            (SELECT COUNT(*)::int FROM beauty_groups bg LEFT JOIN ulta_members um ON um.product_group_id = bg.product_group_id WHERE um.product_group_id IS NULL)
              AS beauty_groups_missing_ulta
        `,
        [market],
      ),
      many(
        `
          WITH beauty_members AS (
            SELECT
              pgm.product_group_id,
              coalesce(
                nullif(btrim(cp.brand), ''),
                nullif(btrim(cp.product_payload#>>'{snapshot,brand}'), ''),
                nullif(btrim(cp.product_payload#>>'{external_seed,brand}'), ''),
                'unknown'
              ) AS brand,
              cp.updated_at
            FROM product_group_members pgm
            JOIN catalog_products cp
              ON cp.merchant_id = pgm.merchant_id
             AND cp.platform = pgm.platform
             AND cp.source_product_id = pgm.platform_product_id
            WHERE coalesce(
                cp.product_payload->>'market',
                cp.product_payload->>'market_code',
                cp.product_payload#>>'{snapshot,market}',
                $1
              ) = $1
              AND (${beautyPredicate})
          ),
          ulta_members AS (
            SELECT DISTINCT pgm.product_group_id
            FROM product_group_members pgm
            JOIN catalog_products cp
              ON cp.merchant_id = pgm.merchant_id
             AND cp.platform = pgm.platform
             AND cp.source_product_id = pgm.platform_product_id
            WHERE ${ultaCatalogPredicate}
          ),
          missing AS (
            SELECT bm.*
            FROM beauty_members bm
            LEFT JOIN ulta_members um ON um.product_group_id = bm.product_group_id
            WHERE um.product_group_id IS NULL
          )
          SELECT brand, COUNT(DISTINCT product_group_id)::int AS missing_groups
          FROM missing
          GROUP BY 1
          ORDER BY missing_groups DESC, brand
          LIMIT 50
        `,
        [market],
      ),
      many(
        `
        WITH ranked AS (
          SELECT
            pgm.product_group_id,
            cp.product_key,
            cp.merchant_id,
            cp.platform,
            cp.source_product_id,
            cp.title,
            cp.brand,
            cp.canonical_url,
            cp.content_key,
            cp.pivota_signature_id,
            coalesce(pgm.is_primary, false) AS is_primary,
            row_number() OVER (
              PARTITION BY pgm.product_group_id
              ORDER BY coalesce(pgm.is_primary, false) DESC, cp.updated_at DESC NULLS LAST, cp.product_key
            ) AS rn
          FROM product_group_members pgm
          JOIN catalog_products cp
            ON cp.merchant_id = pgm.merchant_id
           AND cp.platform = pgm.platform
           AND cp.source_product_id = pgm.platform_product_id
          WHERE coalesce(
              cp.product_payload->>'market',
              cp.product_payload->>'market_code',
              cp.product_payload#>>'{snapshot,market}',
              $1
            ) = $1
            AND (${beautyPredicate})
            AND NOT EXISTS (
              SELECT 1
              FROM product_group_members upgm
              JOIN catalog_products ucp
                ON ucp.merchant_id = upgm.merchant_id
               AND ucp.platform = upgm.platform
               AND ucp.source_product_id = upgm.platform_product_id
              WHERE upgm.product_group_id = pgm.product_group_id
                AND (${ultaCatalogPredicate.replaceAll('cp.', 'ucp.')})
            )
        )
        SELECT
          product_group_id,
          product_key,
          merchant_id,
          platform,
          source_product_id,
          title,
          brand,
          canonical_url,
          content_key,
          pivota_signature_id,
          is_primary
        FROM ranked
        WHERE rn = 1
        ORDER BY brand, title
        LIMIT 150
      `,
        [market],
      ),
    ]);
  }

  const report = {
    generated_at: new Date().toISOString(),
    market,
    mode: quick ? 'quick' : 'full',
    seed_coverage: seedCoverage,
    catalog_coverage: catalogCoverage,
    sku_offer_coverage: skuOfferCoverage,
    group_coverage: groupCoverage,
    top_ulta_brands: topUltaBrands,
    top_missing_ulta_brands: topMissingUltaBrands,
    underfilled_ulta_sample: underfilledUltaSample,
    candidate_missing_ulta_sample: candidateMissingUltaSample,
  };

  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

run()
  .catch((err) => {
    process.stderr.write(`${err?.stack || err?.message || String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(closePool);
