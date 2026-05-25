#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const TARGET_IDS = [
  'ext_c26547ca63d530592ed62d63',
  'ext_0836525e72365da8ecbcc3b5',
  'ext_edcf7e510314384ac432b385',
];
const CONFIRM_TOKEN = 'APPLY_WAVE16_LUCAMAR_QUALITY_SNAPSHOT_REPAIR';

function argValue(name, fallback = '') {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx < 0) return fallback;
  const value = process.argv[idx + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function text(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstString(...values) {
  for (const value of values) {
    const normalized = text(value);
    if (normalized) return normalized;
  }
  return '';
}

function priceAmount(row) {
  const fromOffer = Number(row.offer_price_amount);
  if (Number.isFinite(fromOffer) && fromOffer > 0) return fromOffer;
  const fromSeed = Number(row.seed_price_amount);
  if (Number.isFinite(fromSeed) && fromSeed > 0) return fromSeed;
  return null;
}

function imageCount(row) {
  const payload = asObject(row.product_payload);
  const seedData = asObject(row.seed_data);
  const snapshot = asObject(seedData.snapshot);
  const urls = [
    row.catalog_image_url,
    row.seed_image_url,
    ...asArray(payload.image_urls),
    ...asArray(payload.images),
    ...asArray(seedData.image_urls),
    ...asArray(snapshot.image_urls),
  ].map(text).filter(Boolean);
  return new Set(urls).size;
}

function seedField(row, field) {
  const seedData = asObject(row.seed_data);
  const snapshot = asObject(seedData.snapshot);
  return firstString(seedData[field], snapshot[field]);
}

function qualityForRow(row) {
  const title = firstString(row.catalog_title, row.seed_title);
  const brand = firstString(row.catalog_brand, seedField(row, 'brand'));
  const description = firstString(
    row.catalog_description,
    seedField(row, 'description'),
    seedField(row, 'pdp_description_raw'),
  );
  const category = firstString(
    row.catalog_product_type,
    seedField(row, 'product_type'),
    seedField(row, 'category'),
    seedField(row, 'catalog_category_path'),
  );
  const ingredients = firstString(
    seedField(row, 'pdp_ingredients_raw'),
    seedField(row, 'raw_ingredient_text_clean'),
    asArray(asObject(row.seed_data).ingredients_inci).join(', '),
  );
  const howToUse = seedField(row, 'pdp_how_to_use_raw');
  const images = imageCount(row);
  const price = priceAmount(row);
  const components = [
    { name: 'title', score: title ? 100 : 0 },
    { name: 'description', score: description.length >= 140 ? 100 : description.length >= 60 ? 70 : 0 },
    { name: 'ingredients', score: ingredients.length >= 120 ? 100 : ingredients.length >= 60 ? 70 : 0 },
    { name: 'how_to_use', score: howToUse.length >= 60 ? 100 : howToUse.length >= 30 ? 70 : 0 },
    { name: 'images', score: images > 0 ? 100 : 0 },
    { name: 'brand_category', score: brand && category ? 100 : brand || category ? 50 : 0 },
    { name: 'price', score: price != null ? 100 : 0 },
  ];
  const score = Number((components.reduce((sum, item) => sum + item.score, 0) / components.length).toFixed(1));
  const problems = [];
  if (!title) problems.push({ field: 'title', code: 'missing_title', message: 'Missing product title.' });
  if (description.length < 60) problems.push({ field: 'description', code: 'missing_description', message: 'Missing usable product description.' });
  if (ingredients.length < 60) problems.push({ field: 'ingredients', code: 'missing_ingredients', message: 'Missing source-backed ingredients.' });
  if (howToUse.length < 30) problems.push({ field: 'how_to_use', code: 'missing_how_to_use', message: 'Missing source-backed how-to.' });
  if (!brand) problems.push({ field: 'brand', code: 'missing_brand', message: 'Missing brand.' });
  if (!category) problems.push({ field: 'category', code: 'missing_category', message: 'Missing category.' });
  if (!images) problems.push({ field: 'image_list', code: 'missing_images', message: 'Missing product image.' });
  if (price == null) problems.push({ field: 'price', code: 'invalid_price', message: 'Missing valid price.' });
  return {
    content_quality_score: score,
    model_readiness_score: 0,
    conversion_potential_score: null,
    rules_version: 'v1-lite-direct-pdp-source-backed',
    model_version: 'none',
    details: {
      content_quality_score: score,
      model_readiness_score: 0,
      conversion_potential_score: null,
      problems,
      components,
      repair_source: 'wave16_lucamar_quality_snapshot_repair',
      source_backed_fields: {
        title: Boolean(title),
        description_length: description.length,
        ingredients_length: ingredients.length,
        how_to_use_length: howToUse.length,
        image_count: images,
        price_amount: price,
        brand: Boolean(brand),
        category: Boolean(category),
      },
    },
  };
}

async function fetchRows(client) {
  const result = await client.query(
    `
      SELECT
        cp.merchant_id,
        cp.platform,
        cp.source_product_id,
        cp.content_key,
        cp.product_key,
        cp.pivota_signature_id,
        cp.title AS catalog_title,
        cp.brand AS catalog_brand,
        cp.product_type AS catalog_product_type,
        cp.description AS catalog_description,
        cp.image_url AS catalog_image_url,
        cp.product_payload,
        eps.id AS seed_id,
        eps.title AS seed_title,
        eps.image_url AS seed_image_url,
        eps.price_amount AS seed_price_amount,
        eps.seed_data,
        MAX(co.merchant_effective_price) AS offer_price_amount,
        bool_or(co.availability = 'in_stock') AS has_in_stock_offer
      FROM catalog_products cp
      JOIN external_product_seeds eps
        ON eps.external_product_id = cp.source_product_id
       AND eps.status = 'active'
      LEFT JOIN catalog_offers co
        ON co.product_key = cp.product_key
      WHERE cp.merchant_id = $2
        AND cp.platform = $2
        AND cp.source_product_id = ANY($1::text[])
      GROUP BY
        cp.merchant_id,
        cp.platform,
        cp.source_product_id,
        cp.content_key,
        cp.product_key,
        cp.pivota_signature_id,
        cp.title,
        cp.brand,
        cp.product_type,
        cp.description,
        cp.image_url,
        cp.product_payload,
        eps.id,
        eps.title,
        eps.image_url,
        eps.price_amount,
        eps.seed_data
      ORDER BY array_position($1::text[], cp.source_product_id)
    `,
    [TARGET_IDS, 'external_seed'],
  );
  return result.rows || [];
}

async function applyRepair(client, rows) {
  const results = [];
  await client.query('BEGIN');
  try {
    for (const row of rows) {
      const quality = qualityForRow(row);
      const servingEligible = quality.content_quality_score >= 75 && row.has_in_stock_offer === true;
      const blockerCode = servingEligible ? 'none' : 'low_quality';
      const blockerDetail = servingEligible ? null : 'quality snapshot below serving threshold';
      await client.query(
        `
          INSERT INTO product_quality_snapshot (
            merchant_id,
            platform,
            platform_product_id,
            geo_code,
            product_id,
            content_quality_score,
            model_readiness_score,
            conversion_potential_score,
            rules_version,
            model_version,
            details,
            snapshot_date,
            created_at
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::json,now(),now())
        `,
        [
          row.merchant_id,
          row.platform,
          row.source_product_id,
          'default',
          `${row.merchant_id}|${row.platform}|${row.source_product_id}`,
          quality.content_quality_score,
          quality.model_readiness_score,
          quality.conversion_potential_score,
          quality.rules_version,
          quality.model_version,
          JSON.stringify(quality.details),
        ],
      );
      await client.query(
        `
          INSERT INTO index_pipeline_state (
            content_key,
            pivota_signature_id,
            merchant_id,
            pipeline_stage,
            blocker_code,
            blocker_detail,
            serving_eligible,
            content_quality_score,
            quality_rules_version,
            quality_scored_at,
            seed_audit_status,
            identity_resolved,
            product_group_id,
            has_image,
            has_price,
            description_length,
            consolidation_version,
            last_consolidated_at,
            created_at
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),$10,$11,$12,$13,$14,$15,$16,now(),now())
          ON CONFLICT (content_key) DO UPDATE SET
            pivota_signature_id = EXCLUDED.pivota_signature_id,
            merchant_id = EXCLUDED.merchant_id,
            pipeline_stage = EXCLUDED.pipeline_stage,
            blocker_code = EXCLUDED.blocker_code,
            blocker_detail = EXCLUDED.blocker_detail,
            serving_eligible = EXCLUDED.serving_eligible,
            content_quality_score = EXCLUDED.content_quality_score,
            quality_rules_version = EXCLUDED.quality_rules_version,
            quality_scored_at = now(),
            seed_audit_status = EXCLUDED.seed_audit_status,
            identity_resolved = EXCLUDED.identity_resolved,
            product_group_id = EXCLUDED.product_group_id,
            has_image = EXCLUDED.has_image,
            has_price = EXCLUDED.has_price,
            description_length = EXCLUDED.description_length,
            consolidation_version = EXCLUDED.consolidation_version,
            last_consolidated_at = now()
        `,
        [
          row.content_key,
          row.pivota_signature_id,
          row.merchant_id,
          servingEligible ? 'shadow_indexed' : 'extracted',
          blockerCode,
          blockerDetail,
          servingEligible,
          quality.content_quality_score,
          quality.rules_version,
          'passed',
          true,
          row.pivota_signature_id,
          imageCount(row) > 0,
          priceAmount(row) != null,
          firstString(row.catalog_description, seedField(row, 'description')).length,
          'wave16_lucamar_qs_repair_v1',
        ],
      );
      results.push({
        external_product_id: row.source_product_id,
        content_key: row.content_key,
        pivota_signature_id: row.pivota_signature_id,
        serving_eligible: servingEligible,
        content_quality_score: quality.content_quality_score,
        blocker_code: blockerCode,
        blocker_detail: blockerDetail,
        inserted_quality_snapshot: true,
        updated_index_state: true,
      });
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
  return results;
}

async function main() {
  const write = hasFlag('write');
  const confirm = argValue('confirm');
  if (write && confirm !== CONFIRM_TOKEN) {
    throw new Error(`--write requires --confirm ${CONFIRM_TOKEN}`);
  }
  const out = argValue('out');
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
  await client.connect();
  try {
    const rows = await fetchRows(client);
    const missing = TARGET_IDS.filter((id) => !rows.some((row) => row.source_product_id === id));
    const plans = rows.map((row) => {
      const quality = qualityForRow(row);
      return {
        external_product_id: row.source_product_id,
        title: text(row.catalog_title),
        content_key: row.content_key,
        pivota_signature_id: row.pivota_signature_id,
        has_in_stock_offer: row.has_in_stock_offer === true,
        image_count: imageCount(row),
        price_amount: priceAmount(row),
        description_length: firstString(row.catalog_description, seedField(row, 'description')).length,
        ingredients_length: firstString(
          seedField(row, 'pdp_ingredients_raw'),
          seedField(row, 'raw_ingredient_text_clean'),
          asArray(asObject(row.seed_data).ingredients_inci).join(', '),
        ).length,
        how_to_use_length: seedField(row, 'pdp_how_to_use_raw').length,
        content_quality_score: quality.content_quality_score,
        rules_version: quality.rules_version,
        problems: quality.details.problems,
        would_be_serving_eligible: quality.content_quality_score >= 75 && row.has_in_stock_offer === true,
      };
    });
    const applyResults = write ? await applyRepair(client, rows) : [];
    const report = {
      generated_at: new Date().toISOString(),
      dry_run: !write,
      missing,
      summary: {
        scanned: rows.length,
        missing: missing.length,
        would_insert_quality_snapshots: write ? 0 : rows.length,
        inserted_quality_snapshots: applyResults.length,
        would_update_index_state: write ? 0 : rows.length,
        updated_index_state: applyResults.length,
        serving_eligible_plans: plans.filter((plan) => plan.would_be_serving_eligible).length,
      },
      plans,
      apply_results: applyResults,
    };
    if (out) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
  process.exitCode = 1;
});
