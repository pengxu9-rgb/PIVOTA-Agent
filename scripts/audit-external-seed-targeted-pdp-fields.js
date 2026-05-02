#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');

const { query, closePool } = require('../src/db');
const { ensureJsonObject } = require('../src/services/externalSeedProducts');
const {
  fetchRows,
  pickSeedTargetUrl,
  buildExtractRequestBody,
  chooseRepresentativeProduct,
  buildSeedUpdatePayload,
} = require('./backfill-external-product-seeds-catalog');

const DEFAULT_BASE_URL =
  process.env.CATALOG_INTELLIGENCE_BASE_URL ||
  'https://pivota-catalog-intelligence-production.up.railway.app';

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return '';
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('--')) return '';
  return String(value).trim();
}

function parseDelimitedIds(value) {
  return Array.from(
    new Set(
      String(value || '')
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sectionTitles(value) {
  return Array.isArray(value)
    ? value.map((item) => normalizeText(item?.heading || item?.title)).filter(Boolean)
    : [];
}

function summarizeSeed(seedData) {
  const snapshot = ensureJsonObject(seedData?.snapshot);
  return {
    description: normalizeText(seedData?.description || snapshot?.description),
    pdp_description_raw: normalizeText(seedData?.pdp_description_raw || snapshot?.pdp_description_raw),
    pdp_ingredients_raw: normalizeText(seedData?.pdp_ingredients_raw || snapshot?.pdp_ingredients_raw),
    pdp_how_to_use_raw: normalizeText(seedData?.pdp_how_to_use_raw || snapshot?.pdp_how_to_use_raw),
    pdp_details_titles: sectionTitles(seedData?.pdp_details_sections || snapshot?.pdp_details_sections),
    ingredients_inci_count: Array.isArray(seedData?.ingredients_inci)
      ? seedData.ingredients_inci.length
      : Array.isArray(snapshot?.ingredients_inci)
        ? snapshot.ingredients_inci.length
        : 0,
    review_count:
      seedData?.review_summary?.review_count ||
      snapshot?.review_summary?.review_count ||
      0,
  };
}

function summarizeRepresentative(product) {
  return {
    title: normalizeText(product?.title),
    description_raw_len: normalizeText(product?.description_raw || product?.pdp_description_raw).length,
    ingredients_raw_len: normalizeText(product?.ingredients_raw || product?.pdp_ingredients_raw).length,
    how_to_use_raw_len: normalizeText(product?.how_to_use_raw || product?.pdp_how_to_use_raw).length,
    details_titles: sectionTitles(product?.details_sections || product?.pdp_details_sections),
    review_count: product?.review_summary?.review_count || 0,
    field_quality_summary: product?.field_quality_summary || product?.pdp_field_quality_summary || null,
  };
}

function summarizeNextRow(nextRow) {
  const seedData = ensureJsonObject(nextRow?.seed_data);
  const snapshot = ensureJsonObject(seedData?.snapshot);
  return {
    description: normalizeText(seedData?.description || snapshot?.description),
    pdp_description_raw: normalizeText(seedData?.pdp_description_raw || snapshot?.pdp_description_raw),
    pdp_ingredients_raw: normalizeText(seedData?.pdp_ingredients_raw || snapshot?.pdp_ingredients_raw),
    pdp_how_to_use_raw: normalizeText(seedData?.pdp_how_to_use_raw || snapshot?.pdp_how_to_use_raw),
    pdp_details_titles: sectionTitles(seedData?.pdp_details_sections || snapshot?.pdp_details_sections),
    review_count:
      seedData?.review_summary?.review_count ||
      snapshot?.review_summary?.review_count ||
      0,
  };
}

async function fetchIdentityListing(sourceListingRef) {
  const result = await query(
    `
      SELECT source_listing_ref, live_read_enabled, source_payload
      FROM pdp_identity_listing
      WHERE source_listing_ref = $1
      LIMIT 1
    `,
    [sourceListingRef],
  );
  const row = result?.rows?.[0];
  if (!row) return null;
  const payload = ensureJsonObject(row.source_payload);
  const seedData = ensureJsonObject(payload.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  return {
    source_listing_ref: row.source_listing_ref,
    live_read_enabled: row.live_read_enabled === true,
    top_level: {
      pdp_ingredients_raw: normalizeText(payload.pdp_ingredients_raw),
      pdp_how_to_use_raw: normalizeText(payload.pdp_how_to_use_raw),
      pdp_details_titles: sectionTitles(payload.pdp_details_sections),
      ingredients_inci_count: Array.isArray(payload.ingredients_inci) ? payload.ingredients_inci.length : 0,
    },
    nested_seed_data: summarizeSeed(seedData),
    nested_snapshot: summarizeSeed(snapshot),
  };
}

async function main() {
  const externalProductIds = parseDelimitedIds(
    argValue('external-product-ids') || argValue('externalProductIds'),
  );
  if (externalProductIds.length === 0) throw new Error('missing_external_product_ids');
  const market = normalizeText(argValue('market') || 'US').toUpperCase();
  const baseUrl = normalizeText(argValue('base-url') || argValue('baseUrl') || DEFAULT_BASE_URL);
  const outPath = normalizeText(argValue('out'));

  const rows = await fetchRows({
    externalProductIds,
    market,
    limit: externalProductIds.length,
    offset: 0,
    concurrency: 1,
    dryRun: true,
    expandVariants: false,
    includeCommerceFacts: false,
    skipInsights: true,
    targetUrlOverrides: {},
    validateImageHealth: false,
    baseUrl,
  });

  const audit = [];
  for (const row of rows) {
    const targetUrl = pickSeedTargetUrl(row);
    const requestBody = buildExtractRequestBody(targetUrl, row);
    const response = await axios.post(`${baseUrl}/api/extract`, requestBody, {
      timeout: 60000,
      headers: { 'content-type': 'application/json' },
    });
    const representativeProduct = chooseRepresentativeProduct(response.data, targetUrl, row);
    const payload = representativeProduct
      ? buildSeedUpdatePayload(row, response.data, representativeProduct, targetUrl)
      : null;
    const identityListing = await fetchIdentityListing(`external_seed:${row.external_product_id}`);
    audit.push({
      external_product_id: row.external_product_id,
      title: normalizeText(row.title),
      target_url: targetUrl,
      current_seed: summarizeSeed(ensureJsonObject(row.seed_data)),
      representative_product: representativeProduct ? summarizeRepresentative(representativeProduct) : null,
      next_seed: payload?.nextRow ? summarizeNextRow(payload.nextRow) : null,
      changed: payload?.changed === true,
      identity_listing: identityListing,
    });
  }

  const output = {
    market,
    base_url: baseUrl,
    external_product_ids: externalProductIds,
    rows: audit,
  };

  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

if (require.main === module) {
  main()
    .catch((err) => {
      process.stderr.write(`${err?.stack || String(err)}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => {});
      if (process.exitCode && process.exitCode !== 0) process.exit(process.exitCode);
    });
}
