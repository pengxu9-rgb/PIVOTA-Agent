'use strict';

const fs = require('fs/promises');
const path = require('path');
const { Client } = require('pg');

const TARGETS = [
  {
    key: 'tinted',
    title: 'TINTED COCONUT LIP BALM',
    external_product_id: 'ext_c840771410198f627d75673a',
    pivota_signature_id: 'sig_ab0548c0101059f42676a642',
    product_line_id: 'pl_b280c2d5a19e59fcfc525550',
  },
  {
    key: 'clear',
    title: 'CLEAR LIP CARE',
    external_product_id: 'ext_8982e4384c3bd70a5718c899',
    pivota_signature_id: 'sig_2cbeb024c2e87aa7359f3677',
    product_line_id: null,
  },
];

const OUT_PATH = path.join(
  __dirname,
  'coconutmatter_tinted_resolver_state_prod.json',
);

function compact(value) {
  if (Array.isArray(value)) return value.map(compact);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const nested = compact(item);
      if (Object.keys(nested).length) out[key] = nested;
      continue;
    }
    out[key] = item;
  }
  return out;
}

function summarizeJson(value) {
  if (!value || typeof value !== 'object') return null;
  const snapshot = value.snapshot && typeof value.snapshot === 'object' ? value.snapshot : {};
  return compact({
    keys: Object.keys(value).sort().slice(0, 80),
    snapshot_keys: Object.keys(snapshot).sort().slice(0, 80),
    title: value.title || snapshot.title || null,
    brand: value.brand || snapshot.brand || null,
    product_id: value.product_id || snapshot.product_id || null,
    external_product_id: value.external_product_id || snapshot.external_product_id || null,
    pivota_signature_id: value.pivota_signature_id || snapshot.pivota_signature_id || null,
    product_line_id: value.product_line_id || snapshot.product_line_id || null,
    sellable_item_group_id: value.sellable_item_group_id || snapshot.sellable_item_group_id || null,
    product_kind: value.product_kind || snapshot.product_kind || null,
    product_family: value.product_family || snapshot.product_family || null,
    category: value.category || snapshot.category || null,
    catalog_category_path: value.catalog_category_path || snapshot.catalog_category_path || null,
    canonical_url: value.canonical_url || snapshot.canonical_url || null,
    destination_url: value.destination_url || snapshot.destination_url || null,
    has_description: Boolean(value.description || value.pdp_description_raw || snapshot.description || snapshot.pdp_description_raw),
    has_inci: Boolean(value.full_ingredients || value.ingredients_inci || snapshot.full_ingredients || snapshot.ingredients_inci),
    variant_count: Array.isArray(value.variants)
      ? value.variants.length
      : Array.isArray(snapshot.variants)
        ? snapshot.variants.length
        : 0,
    image_count: Array.isArray(value.image_urls)
      ? value.image_urls.length
      : Array.isArray(snapshot.image_urls)
        ? snapshot.image_urls.length
        : Array.isArray(value.images)
          ? value.images.length
          : Array.isArray(snapshot.images)
            ? snapshot.images.length
            : 0,
  });
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL or DATABASE_PUBLIC_URL is required');
  }
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const externalIds = TARGETS.map((target) => target.external_product_id);
    const sigIds = TARGETS.map((target) => target.pivota_signature_id);
    const groupIds = TARGETS.flatMap((target) => [
      target.pivota_signature_id,
      target.product_line_id,
    ]).filter(Boolean);
    const listingRefs = externalIds.map((id) => `external_seed:${id}`);

    const [seedRes, catalogRes, identityRes, eligibilityRes, duplicateSigRes] = await Promise.all([
      client.query(
        `
          SELECT
            id,
            external_product_id,
            status,
            domain,
            title,
            canonical_url,
            destination_url,
            image_url,
            price_amount,
            price_currency,
            availability,
            attached_product_key,
            updated_at,
            created_at,
            seed_data
          FROM external_product_seeds
          WHERE external_product_id = ANY($1::text[])
          ORDER BY external_product_id, updated_at DESC NULLS LAST, created_at DESC NULLS LAST
        `,
        [externalIds],
      ),
      client.query(
        `
          SELECT
            cp.merchant_id,
            cp.platform,
            cp.source_system,
            cp.source_product_id,
            cp.product_key,
            cp.content_key,
            cp.pivota_signature_id,
            cp.title,
            cp.brand,
            cp.category,
            cp.product_type,
            cp.category_path,
            cp.category_label_source,
            cp.category_confidence,
            cp.sync_status,
            cp.pdp_lifecycle_stage,
            cp.updated_at,
            cp.product_payload,
            cm.status AS merchant_status,
            ips.serving_eligible,
            ips.readiness_tier,
            ips.pipeline_stage,
            ips.blocker_code,
            ips.blocker_detail,
            ips.content_quality_score
          FROM catalog_products cp
          LEFT JOIN catalog_merchants cm ON cm.merchant_id = cp.merchant_id
          LEFT JOIN index_pipeline_state ips ON ips.content_key = cp.content_key
          WHERE cp.merchant_id = 'external_seed'
            AND (
              cp.source_product_id = ANY($1::text[])
              OR cp.pivota_signature_id = ANY($2::text[])
            )
          ORDER BY cp.source_product_id, cp.updated_at DESC NULLS LAST, cp.product_key ASC
        `,
        [externalIds, sigIds],
      ),
      client.query(
        `
          SELECT
            source_listing_ref,
            merchant_id,
            product_id,
            source_kind,
            source_tier,
            sellable_item_group_id,
            product_line_id,
            review_family_id,
            identity_status,
            live_read_enabled,
            review_required,
            identity_confidence,
            match_basis,
            variant_axes,
            source_payload,
            updated_at,
            created_at
          FROM pdp_identity_listing
          WHERE source_listing_ref = ANY($1::text[])
             OR product_id = ANY($2::text[])
             OR sellable_item_group_id = ANY($3::text[])
             OR product_line_id = ANY($3::text[])
          ORDER BY
            CASE WHEN source_listing_ref = ANY($1::text[]) THEN 0 ELSE 1 END,
            product_id,
            updated_at DESC NULLS LAST
        `,
        [listingRefs, externalIds, groupIds],
      ),
      client.query(
        `
          SELECT
            cp.source_product_id,
            cp.pivota_signature_id,
            cp.content_key,
            cp.product_key,
            cp.sync_status,
            cp.pdp_lifecycle_stage,
            ips.serving_eligible,
            ips.readiness_tier,
            ips.pipeline_stage,
            ips.blocker_code,
            ips.blocker_detail,
            ips.content_quality_score,
            eps.status AS active_seed_status
          FROM catalog_products cp
          LEFT JOIN index_pipeline_state ips ON ips.content_key = cp.content_key
          LEFT JOIN external_product_seeds eps
            ON eps.external_product_id = cp.source_product_id
           AND eps.status = 'active'
          WHERE cp.merchant_id = 'external_seed'
            AND (
              cp.source_product_id = ANY($1::text[])
              OR cp.pivota_signature_id = ANY($2::text[])
            )
          ORDER BY cp.source_product_id, cp.updated_at DESC NULLS LAST
        `,
        [externalIds, sigIds],
      ),
      client.query(
        `
          SELECT
            pivota_signature_id,
            COUNT(*)::int AS row_count,
            jsonb_agg(jsonb_build_object(
              'merchant_id', merchant_id,
              'source_product_id', source_product_id,
              'product_key', product_key,
              'content_key', content_key,
              'sync_status', sync_status,
              'pdp_lifecycle_stage', pdp_lifecycle_stage,
              'updated_at', updated_at
            ) ORDER BY updated_at DESC NULLS LAST) AS rows
          FROM catalog_products
          WHERE pivota_signature_id = ANY($1::text[])
          GROUP BY pivota_signature_id
          ORDER BY pivota_signature_id
        `,
        [sigIds],
      ),
    ]);

    const byExternalId = {};
    for (const target of TARGETS) {
      const seedRows = seedRes.rows.filter((row) => row.external_product_id === target.external_product_id);
      const catalogRows = catalogRes.rows.filter(
        (row) =>
          row.source_product_id === target.external_product_id ||
          row.pivota_signature_id === target.pivota_signature_id,
      );
      const identityRows = identityRes.rows.filter(
        (row) =>
          row.product_id === target.external_product_id ||
          row.source_listing_ref === `external_seed:${target.external_product_id}` ||
          row.sellable_item_group_id === target.pivota_signature_id ||
          row.sellable_item_group_id === target.product_line_id ||
          row.product_line_id === target.pivota_signature_id ||
          row.product_line_id === target.product_line_id,
      );
      const eligibilityRows = eligibilityRes.rows.filter(
        (row) =>
          row.source_product_id === target.external_product_id ||
          row.pivota_signature_id === target.pivota_signature_id,
      );
      byExternalId[target.key] = {
        target,
        seed_rows: seedRows.map((row) => ({
          ...row,
          seed_data_summary: summarizeJson(row.seed_data),
          seed_data: undefined,
        })),
        catalog_rows: catalogRows.map((row) => ({
          ...row,
          product_payload_summary: summarizeJson(row.product_payload),
          product_payload: undefined,
        })),
        identity_rows: identityRows.map((row) => ({
          ...row,
          source_payload_summary: summarizeJson(row.source_payload),
          source_payload: undefined,
        })),
        eligibility_rows: eligibilityRows,
        signature_duplicate_rows: duplicateSigRes.rows.filter(
          (row) => row.pivota_signature_id === target.pivota_signature_id,
        ),
      };
    }

    const report = {
      generated_at: new Date().toISOString(),
      targets: TARGETS,
      summary: Object.fromEntries(
        Object.entries(byExternalId).map(([key, item]) => [
          key,
          {
            seed_rows: item.seed_rows.length,
            catalog_rows: item.catalog_rows.length,
            identity_rows: item.identity_rows.length,
            eligibility_rows: item.eligibility_rows.length,
            signature_duplicate_groups: item.signature_duplicate_rows.length,
            first_seed_status: item.seed_rows[0]?.status || null,
            first_catalog_sig: item.catalog_rows[0]?.pivota_signature_id || null,
            first_catalog_serving_eligible: item.catalog_rows[0]?.serving_eligible ?? null,
            first_identity_sellable_item_group_id:
              item.identity_rows[0]?.sellable_item_group_id || null,
            first_identity_live_read_enabled:
              item.identity_rows[0]?.live_read_enabled ?? null,
            first_identity_review_required:
              item.identity_rows[0]?.review_required ?? null,
          },
        ]),
      ),
      by_external_id: byExternalId,
    };

    await fs.writeFile(OUT_PATH, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(JSON.stringify(report.summary, null, 2));
    process.stdout.write(`\nWrote ${OUT_PATH}\n`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
