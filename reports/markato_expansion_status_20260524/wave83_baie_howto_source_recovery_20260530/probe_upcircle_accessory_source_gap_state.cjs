#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { query, closePool } = require('../../../src/db');

const IDS = [
  'ext_092b6aa9139491c529586778',
  'ext_f79a99a09a933e731880cdfb',
];

async function main() {
  const out = process.argv[2] || '';
  const res = await query(
    `
      SELECT eps.external_product_id,
             eps.title,
             eps.domain,
             eps.canonical_url,
             eps.destination_url,
             eps.seed_data->>'category' AS seed_category,
             eps.seed_data->>'product_type' AS seed_product_type,
             eps.seed_data->>'product_family' AS seed_product_family,
             eps.seed_data->>'product_kind' AS seed_product_kind,
             eps.seed_data->>'category_path' AS seed_category_path,
             eps.seed_data->'snapshot'->>'category' AS snapshot_category,
             eps.seed_data->'snapshot'->>'product_type' AS snapshot_product_type,
             eps.seed_data->'snapshot'->>'product_family' AS snapshot_product_family,
             cp.category AS catalog_category,
             cp.product_type AS catalog_product_type,
             cp.category_path AS catalog_category_path,
             ips.serving_eligible,
             ips.blocker_code,
             ips.blocker_detail,
             pil.review_required AS identity_review_required,
             pil.identity_status,
             pil.live_read_enabled AS identity_live_read_enabled,
             pil.source_payload->>'category_path' AS identity_category_path
      FROM external_product_seeds eps
      LEFT JOIN catalog_products cp
        ON cp.merchant_id = 'external_seed'
       AND cp.platform = 'external_seed'
       AND cp.source_product_id = eps.external_product_id
      LEFT JOIN index_pipeline_state ips
        ON ips.content_key = cp.content_key
      LEFT JOIN pdp_identity_listing pil
        ON pil.source_listing_ref = 'external_seed:' || eps.external_product_id
      WHERE eps.external_product_id = ANY($1::text[])
      ORDER BY eps.external_product_id
    `,
    [IDS],
  );
  const report = {
    generated_at: new Date().toISOString(),
    external_product_ids: IDS,
    rows: res.rows || [],
  };
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
    if (process.exitCode) process.exit(process.exitCode);
  });
