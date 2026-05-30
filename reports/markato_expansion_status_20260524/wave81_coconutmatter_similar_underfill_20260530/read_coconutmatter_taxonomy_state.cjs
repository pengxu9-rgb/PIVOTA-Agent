#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { closePool, query } = require(path.join(process.cwd(), 'src/db'));

const IDS = [
  'ext_8982e4384c3bd70a5718c899',
  'ext_c840771410198f627d75673a',
];

function argValue(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !String(value).startsWith('--') ? String(value) : fallback;
}

async function main() {
  const { rows } = await query(
    `
      SELECT eps.external_product_id,
             eps.title,
             eps.seed_data->>'brand' AS seed_brand,
             eps.seed_data#>>'{snapshot,brand}' AS snapshot_brand,
             eps.domain,
             eps.market,
             eps.canonical_url,
             eps.price_amount,
             eps.price_currency,
             eps.seed_data->>'category' AS seed_category,
             eps.seed_data->>'product_type' AS seed_product_type,
             eps.seed_data->>'category_path' AS seed_category_path,
             eps.seed_data#>>'{snapshot,category}' AS snapshot_category,
             eps.seed_data#>>'{snapshot,product_type}' AS snapshot_product_type,
             eps.seed_data#>>'{snapshot,category_path}' AS snapshot_category_path,
             eps.seed_data#>>'{derived,recall,category}' AS recall_category,
             cp.category AS catalog_category,
             cp.product_type AS catalog_product_type,
             cp.category_path AS catalog_category_path,
             cp.product_payload->>'product_family' AS catalog_product_family,
             pil.product_line_id,
             pil.sellable_item_group_id,
             pil.identity_status,
             pil.review_required
      FROM external_product_seeds eps
      LEFT JOIN catalog_products cp
        ON cp.merchant_id = 'external_seed'
       AND cp.platform = 'external_seed'
       AND cp.source_product_id = eps.external_product_id
      LEFT JOIN pdp_identity_listing pil
        ON pil.merchant_id = 'external_seed'
       AND pil.product_id = eps.external_product_id
      WHERE eps.external_product_id = ANY($1::text[])
      ORDER BY eps.external_product_id
    `,
    [IDS],
  );
  const report = {
    generated_at: new Date().toISOString(),
    external_product_ids: IDS,
    rows,
  };
  const out = argValue('out');
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, serialized, 'utf8');
  }
  process.stdout.write(serialized);
}

main()
  .catch((error) => {
    process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
