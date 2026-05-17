#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query, withClient } = require('../src/db');

const MARKER_VERSION = 'external_seed.source_unavailable.v1';
const CATALOG_SYNC_STATUS = 'stale';

function argValue(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function asString(value) {
  return String(value || '').trim();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function readIdsFile(filePath) {
  const normalized = asString(filePath);
  if (!normalized) return [];
  return fs
    .readFileSync(normalized, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function uniqueStrings(values, limit = 5000) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const normalized = asString(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function deletePriceFields(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return;
  for (const key of ['price', 'price_amount', 'priceAmount', 'currency', 'price_currency', 'priceCurrency']) {
    delete target[key];
  }
}

function patchSeedData(seedData, marker) {
  const next = cloneJson(asObject(seedData));
  const snapshot = asObject(next.snapshot);
  next.snapshot = snapshot;

  next.availability = 'out_of_stock';
  next.in_stock = false;
  snapshot.availability = 'out_of_stock';
  snapshot.in_stock = false;

  deletePriceFields(next);
  deletePriceFields(snapshot);

  next.source_unavailable_v1 = marker;
  snapshot.source_unavailable_v1 = marker;
  next.transaction_readiness_blocker_v1 = marker;
  snapshot.transaction_readiness_blocker_v1 = marker;

  const contract = {
    ...asObject(snapshot.external_seed_snapshot_contract),
    ...asObject(next.external_seed_snapshot_contract),
    contract_version: 'external_seed.snapshot_contract.v1',
    authoritative: true,
    structured_fields_authoritative: true,
    legacy_fields_quarantined: true,
    replace_strategy: 'replace_not_merge',
    updated_at: marker.updated_at,
  };
  next.external_seed_snapshot_contract = contract;
  snapshot.external_seed_snapshot_contract = contract;

  return next;
}

async function fetchRows(ids, market) {
  if (!ids.length) return [];
  const res = await query(
    `
      SELECT id, external_product_id, market, domain, title, canonical_url, destination_url,
             price_amount, price_currency, availability, status, seed_data
      FROM external_product_seeds
      WHERE external_product_id = ANY($1::text[])
        AND ($2::text = '' OR upper(market) = upper($2))
      ORDER BY external_product_id
    `,
    [ids, asString(market)],
  );
  return res.rows || [];
}

async function countCatalogRows(ids) {
  if (!ids.length) return { products: 0, skus: 0, offers: 0 };
  const [products, skus, offers] = await Promise.all([
    query(`SELECT count(*)::int AS count FROM catalog_products WHERE source_product_id = ANY($1::text[])`, [ids]),
    query(`SELECT count(*)::int AS count FROM catalog_skus WHERE source_product_id = ANY($1::text[])`, [ids]),
    query(
      `
        SELECT count(*)::int AS count
        FROM catalog_offers
        WHERE product_key = ANY(
          SELECT product_key FROM catalog_products WHERE source_product_id = ANY($1::text[])
        )
      `,
      [ids],
    ),
  ]);
  return {
    products: Number(products.rows?.[0]?.count || 0),
    skus: Number(skus.rows?.[0]?.count || 0),
    offers: Number(offers.rows?.[0]?.count || 0),
  };
}

async function applyRows(rows, marker, { write }) {
  if (!write) return { external_product_seeds: 0, catalog_products: 0, catalog_skus: 0, catalog_offers: 0 };
  let seedUpdates = 0;
  let productUpdates = 0;
  let skuUpdates = 0;
  let offerUpdates = 0;
  await withClient(async (client) => {
    await client.query('BEGIN');
    try {
      await client.query("SET LOCAL lock_timeout = '10000ms'");
      await client.query("SET LOCAL statement_timeout = '60000ms'");
      for (const row of rows) {
        const externalProductId = asString(row.external_product_id);
        const patchedSeedData = patchSeedData(row.seed_data, marker);
        const seedResult = await client.query(
          `
            UPDATE external_product_seeds
            SET seed_data = $2::jsonb,
                availability = 'out_of_stock',
                price_amount = NULL,
                price_currency = NULL,
                updated_at = NOW()
            WHERE id = $1
          `,
          [row.id, JSON.stringify(patchedSeedData)],
        );
        seedUpdates += Number(seedResult.rowCount || 0);

        const productResult = await client.query(
          `
            UPDATE catalog_products
            SET readiness_tier = 'referral_only',
                sync_status = $3,
                product_payload = coalesce(product_payload, '{}'::jsonb) || $2::jsonb,
                updated_at = NOW()
            WHERE source_product_id = $1
          `,
          [externalProductId, JSON.stringify({ source_unavailable_v1: marker }), CATALOG_SYNC_STATUS],
        );
        productUpdates += Number(productResult.rowCount || 0);

        const skuResult = await client.query(
          `
            UPDATE catalog_skus
            SET readiness_tier = 'referral_only',
                sku_payload = coalesce(sku_payload, '{}'::jsonb) || $2::jsonb,
                updated_at = NOW()
            WHERE source_product_id = $1
          `,
          [externalProductId, JSON.stringify({ source_unavailable_v1: marker })],
        );
        skuUpdates += Number(skuResult.rowCount || 0);

        const offerResult = await client.query(
          `
            UPDATE catalog_offers
            SET availability = 'out_of_stock',
                inventory_quantity = 0,
                list_price = NULL,
                merchant_effective_price = NULL,
                estimated_best_price = NULL,
                price_confidence = NULL,
                offer_payload = coalesce(offer_payload, '{}'::jsonb) || $2::jsonb,
                updated_at = NOW()
            WHERE product_key = ANY(
              SELECT product_key FROM catalog_products WHERE source_product_id = $1
            )
          `,
          [externalProductId, JSON.stringify({ source_unavailable_v1: marker })],
        );
        offerUpdates += Number(offerResult.rowCount || 0);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => null);
      throw error;
    }
  });
  return {
    external_product_seeds: seedUpdates,
    catalog_products: productUpdates,
    catalog_skus: skuUpdates,
    catalog_offers: offerUpdates,
  };
}

async function main() {
  const ids = uniqueStrings([
    ...readIdsFile(argValue('ids-file')),
    ...asString(argValue('external-product-id'))
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
    ...asString(argValue('external-product-ids'))
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  ]);
  const market = asString(argValue('market', 'US')).toUpperCase();
  const reason = asString(argValue('reason', 'official_source_unavailable'));
  const sourceUrl = asString(argValue('source-url'));
  const evidence = asString(argValue('evidence'));
  const out = asString(argValue('out'));
  const write = hasFlag('write');
  const generatedAt = new Date().toISOString();

  const rows = await fetchRows(ids, market);
  const foundIds = new Set(rows.map((row) => asString(row.external_product_id)));
  const missingIds = ids.filter((id) => !foundIds.has(id));
  const catalogCounts = await countCatalogRows(rows.map((row) => row.external_product_id));
  const marker = {
    contract_version: MARKER_VERSION,
    updated_at: generatedAt,
    status: 'source_unavailable',
    reason,
    reason_codes: uniqueStrings([reason], 20),
    source_url: sourceUrl || undefined,
    evidence: evidence || undefined,
    transaction_ready: false,
    availability: 'out_of_stock',
    price_current: false,
    review_state: 'reviewed',
  };

  const applyResult = await applyRows(rows, marker, { write });
  const report = {
    generated_at: generatedAt,
    dry_run: !write,
    market,
    marker,
    summary: {
      requested_ids: ids.length,
      scanned: rows.length,
      missing_ids: missingIds.length,
      catalog_counts: catalogCounts,
      updated: applyResult,
    },
    missing_ids: missingIds,
    rows: rows.map((row) => ({
      id: row.id,
      external_product_id: row.external_product_id,
      title: row.title,
      domain: row.domain,
      canonical_url: row.canonical_url,
      destination_url: row.destination_url,
      before: {
        status: row.status,
        availability: row.availability,
        price_amount: row.price_amount,
        price_currency: row.price_currency,
      },
      after: {
        status: row.status,
        availability: 'out_of_stock',
        price_amount: null,
        price_currency: null,
      },
    })),
  };

  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => null);
    });
}

module.exports = {
  MARKER_VERSION,
  patchSeedData,
  deletePriceFields,
};
