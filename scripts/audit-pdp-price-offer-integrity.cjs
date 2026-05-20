#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

function argValue(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !String(value).startsWith('--') ? String(value) : fallback;
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

function uniq(values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const normalized = text(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function moneyFrom(value, currency) {
  const amount = numberOrNull(value);
  if (!amount) return null;
  return {
    amount,
    currency: text(currency).toUpperCase() || null,
  };
}

function moneyKey(money) {
  if (!money) return '';
  return `${money.currency || 'UNK'}:${money.amount.toFixed(2)}`;
}

function hostOf(value) {
  try {
    return new URL(text(value)).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function readPayloadPrice(payload) {
  const obj = asObject(payload);
  const snapshot = asObject(obj.snapshot);
  return (
    moneyFrom(obj.price_amount, obj.price_currency) ||
    moneyFrom(snapshot.price_amount, snapshot.price_currency) ||
    moneyFrom(obj.price, obj.currency) ||
    moneyFrom(snapshot.price, snapshot.currency)
  );
}

function readSeedPrice(seedRow) {
  const seed = asObject(seedRow);
  const data = asObject(seed.seed_data);
  const snapshot = asObject(data.snapshot);
  return (
    moneyFrom(seed.price_amount, seed.price_currency) ||
    moneyFrom(data.price_amount, data.price_currency) ||
    moneyFrom(snapshot.price_amount, snapshot.price_currency) ||
    moneyFrom(data.price, data.currency) ||
    moneyFrom(snapshot.price, snapshot.currency)
  );
}

function readOfferPrice(offer) {
  const obj = asObject(offer);
  return (
    moneyFrom(obj.merchant_effective_price, obj.currency) ||
    moneyFrom(obj.estimated_best_price, obj.currency) ||
    moneyFrom(obj.list_price, obj.currency) ||
    moneyFrom(asObject(obj.offer_payload).price_amount, asObject(obj.offer_payload).price_currency) ||
    moneyFrom(asObject(obj.offer_payload).price, asObject(obj.offer_payload).currency)
  );
}

function readListingPrice(listing) {
  const payload = asObject(listing.source_payload);
  const price = asObject(payload.price);
  const pricingCurrent = asObject(asObject(payload.pricing).current);
  const snapshot = asObject(payload.snapshot);
  return (
    moneyFrom(price.amount, price.currency) ||
    moneyFrom(payload.price, payload.currency) ||
    moneyFrom(payload.price_amount, payload.price_currency) ||
    moneyFrom(pricingCurrent.amount, pricingCurrent.currency) ||
    moneyFrom(snapshot.price_amount, snapshot.price_currency) ||
    moneyFrom(snapshot.price, snapshot.currency) ||
    moneyFrom(asObject(payload.regional_price).amount, asObject(payload.regional_price).currency)
  );
}

function priceDiffers(left, right, cents = 1) {
  if (!left || !right) return false;
  if (left.currency && right.currency && left.currency !== right.currency) return true;
  return Math.abs(left.amount - right.amount) > cents / 100;
}

function summarizeIdentityListings(identityListings) {
  const rows = asArray(identityListings).filter((row) => row && typeof row === 'object');
  return rows.map((row) => {
    const payload = asObject(row.source_payload);
    return {
      source_listing_ref: text(row.source_listing_ref),
      product_group_id: text(row.sellable_item_group_id),
      product_line_id: text(row.product_line_id),
      sellable_item_group_id: text(row.sellable_item_group_id),
      merchant_id: text(row.merchant_id),
      product_id: text(row.product_id),
      source_kind: text(row.source_kind),
      matched_by_rule: text(row.matched_by_rule),
      identity_confidence: numberOrNull(row.identity_confidence),
      price: readListingPrice(row),
      merchant_name: text(payload.merchant_name || payload.seller_name || payload.store_name),
      url: text(payload.destination_url || payload.external_redirect_url || payload.url || payload.canonical_url),
    };
  });
}

function analyzeRow(row) {
  const payload = asObject(row.product_payload);
  const seedRow = asObject(row.seed_row);
  const seedData = asObject(seedRow.seed_data);
  const snapshot = asObject(seedData.snapshot);
  const offers = asArray(row.offers);
  const identityListings = summarizeIdentityListings(row.identity_listings);
  const cpPrice = readPayloadPrice(payload);
  const seedPrice = readSeedPrice(seedRow);
  const offerPrices = offers.map(readOfferPrice).filter(Boolean);
  const identityPrices = identityListings.map((listing) => listing.price).filter(Boolean);
  const currencies = uniq([
    cpPrice?.currency,
    seedPrice?.currency,
    ...offerPrices.map((price) => price.currency),
    ...identityPrices.map((price) => price.currency),
  ]);
  const allPriceKeys = uniq([
    moneyKey(cpPrice),
    moneyKey(seedPrice),
    ...offerPrices.map(moneyKey),
    ...identityPrices.map(moneyKey),
  ]).filter(Boolean);
  const market = text(seedRow.market || payload.market || snapshot.market || row.market).toUpperCase();
  const domain = text(seedRow.domain || payload.domain || snapshot.domain || row.domain || hostOf(row.canonical_url));
  const reasons = [];
  if (!cpPrice && !seedPrice && offerPrices.length === 0 && identityPrices.length === 0) {
    reasons.push('missing_all_prices');
  }
  if (currencies.includes('EUR') && currencies.includes('USD')) reasons.push('currency_conflict');
  if (market === 'US' && currencies.includes('EUR') && !currencies.includes('USD')) reasons.push('stale_eur_for_us');
  if (!market && currencies.includes('EUR') && !currencies.includes('USD')) reasons.push('eur_only_market_unknown');
  if (seedPrice && cpPrice && priceDiffers(seedPrice, cpPrice)) reasons.push('catalog_payload_seed_price_mismatch');
  if (seedPrice && offerPrices.length && !offerPrices.some((price) => !priceDiffers(seedPrice, price))) {
    reasons.push('seed_price_missing_from_catalog_offers');
  }
  if (seedPrice && identityPrices.length && !identityPrices.some((price) => !priceDiffers(seedPrice, price))) {
    reasons.push('seed_price_missing_from_identity_group');
  }
  if (identityPrices.length > 1 && uniq(identityPrices.map(moneyKey)).length > 1) {
    reasons.push('identity_group_multi_price');
  }
  if (offers.length === 0 && identityListings.length > 1) reasons.push('identity_group_without_catalog_offers');
  return {
    product_key: row.product_key,
    pivota_signature_id: row.pivota_signature_id,
    external_product_id: row.source_product_id,
    brand: text(row.brand || payload.brand || seedData.brand || snapshot.brand),
    title: text(row.title || payload.title || seedData.title || snapshot.title),
    domain,
    market,
    category_path: text(row.category_path),
    canonical_url: text(row.canonical_url || seedRow.destination_url || seedRow.canonical_url),
    catalog_price: cpPrice,
    seed_price: seedPrice,
    offer_count: offers.length,
    offer_prices: offerPrices,
    identity_listing_count: identityListings.length,
    identity_prices: identityPrices,
    identity_listings: identityListings,
    currencies,
    price_keys: allPriceKeys,
    status: reasons.length ? 'review' : 'ok',
    reasons,
  };
}

async function fetchRows(client, options) {
  const where = [`coalesce(cp.sync_status, 'live') NOT IN ('inactive', 'archived', 'deleted')`];
  const params = [];
  const bind = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  if (options.brand) {
    where.push(`lower(coalesce(cp.brand, cp.product_payload->>'brand', eps.seed_data->>'brand', eps.seed_data#>>'{snapshot,brand}', '')) = lower(${bind(options.brand)})`);
  }
  if (options.domain) {
    where.push(`lower(coalesce(eps.domain, cp.domain, cp.product_payload->>'domain', eps.seed_data->>'domain', eps.seed_data#>>'{snapshot,domain}', '')) LIKE lower(${bind(`%${options.domain}%`)})`);
  }
  if (options.externalProductId) where.push(`cp.source_product_id = ${bind(options.externalProductId)}`);
  if (options.categoryPrefix) where.push(`cp.category_path LIKE ${bind(`${options.categoryPrefix}%`)}`);
  if (options.market) where.push(`upper(coalesce(eps.market, cp.product_payload->>'market', eps.seed_data#>>'{snapshot,market}', '')) = upper(${bind(options.market)})`);
  if (options.onlyIssues) {
    where.push(`(
      cp.product_payload->>'price_currency' = 'EUR'
      OR cp.product_payload#>>'{snapshot,price_currency}' = 'EUR'
      OR eps.price_currency = 'EUR'
      OR EXISTS (
        SELECT 1 FROM catalog_offers co
        WHERE co.product_key = cp.product_key
          AND co.currency = 'EUR'
      )
    )`);
  }
  if (options.limit > 0) params.push(options.limit);
  const limitSql = options.limit > 0 ? `LIMIT $${params.length}` : '';
  const result = await client.query(
    `
      WITH base AS (
        SELECT
          cp.*,
          to_jsonb(eps) AS seed_row
        FROM catalog_products cp
        LEFT JOIN external_product_seeds eps
          ON cp.merchant_id = 'external_seed'
         AND cp.platform = 'external_seed'
         AND cp.source_product_id = eps.external_product_id
        WHERE ${where.join('\n          AND ')}
        ORDER BY cp.updated_at DESC NULLS LAST, cp.created_at DESC NULLS LAST
        ${limitSql}
      ),
      offer_agg AS (
        SELECT co.product_key, jsonb_agg(to_jsonb(co) ORDER BY co.updated_at DESC NULLS LAST) AS offers
        FROM catalog_offers co
        JOIN base ON base.product_key = co.product_key
        GROUP BY co.product_key
      ),
      identity_agg AS (
        SELECT
          base.product_key,
          jsonb_agg(to_jsonb(pil) ORDER BY pil.updated_at DESC NULLS LAST) AS identity_listings
        FROM base
        LEFT JOIN pdp_identity_listing pil
          ON pil.sellable_item_group_id = base.pivota_signature_id
          OR pil.product_line_id = base.product_payload->>'product_line_id'
          OR pil.source_listing_ref = 'external_seed:' || base.source_product_id
        GROUP BY base.product_key
      )
      SELECT
        base.*,
        coalesce(offer_agg.offers, '[]'::jsonb) AS offers,
        coalesce(identity_agg.identity_listings, '[]'::jsonb) AS identity_listings
      FROM base
      LEFT JOIN offer_agg ON offer_agg.product_key = base.product_key
      LEFT JOIN identity_agg ON identity_agg.product_key = base.product_key
    `,
    params,
  );
  return result.rows || [];
}

function ensureParent(filePath) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
}

function countBy(rows, keyFn) {
  const counts = new Map();
  for (const row of rows) {
    const keys = asArray(keyFn(row));
    for (const key of keys.length ? keys : ['none']) {
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([key, count]) => ({ key, count }));
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const options = {
    brand: argValue('brand'),
    domain: argValue('domain'),
    market: argValue('market'),
    externalProductId: argValue('external-product-id'),
    categoryPrefix: argValue('category-prefix'),
    limit: Math.max(0, Number(argValue('limit', '500')) || 0),
    out: argValue('out'),
    onlyIssues: hasFlag('only-issues'),
  };
  const client = new Client({ connectionString: databaseUrl, ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false } });
  await client.connect();
  try {
    const rows = (await fetchRows(client, options)).map(analyzeRow);
    const reviewRows = rows.filter((row) => row.status !== 'ok');
    const output = {
      generated_at: new Date().toISOString(),
      options,
      scanned: rows.length,
      review_count: reviewRows.length,
      reason_counts: countBy(reviewRows, (row) => row.reasons),
      brand_counts: countBy(reviewRows, (row) => [row.brand || 'unknown']).slice(0, 25),
      domain_counts: countBy(reviewRows, (row) => [row.domain || 'unknown']).slice(0, 25),
      rows,
    };
    const json = `${JSON.stringify(output, null, 2)}\n`;
    if (options.out) {
      ensureParent(options.out);
      fs.writeFileSync(options.out, json, 'utf8');
    }
    process.stdout.write(json);
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  analyzeRow,
  readPayloadPrice,
  readSeedPrice,
  readOfferPrice,
};
