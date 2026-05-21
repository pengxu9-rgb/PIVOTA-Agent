#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { query, getPool } = require('../src/db');
const {
  EXTERNAL_SEED_MERCHANT_ID,
  buildExternalSeedProduct,
} = require('../src/services/externalSeedProducts');
const {
  buildSourceListingRef,
} = require('../src/services/pdpIdentityGraph');
const {
  buildCatalogServingBackfillDocs,
  getCatalogServingIndexConfig,
  _internals: {
    hydrateCatalogServingSourceRowsWithProductIntel,
  },
} = require('../src/services/catalogServingIndex');
const {
  buildCheckpointedReadinessAudit,
} = require('./audit-external-seed-pdp-readiness');

const IDENTITY_CHUNK_SIZE = Math.max(1, Math.min(Number(process.env.AUDIT_IDENTITY_CHUNK_SIZE || 250), 1000));
const KB_CHUNK_SIZE = Math.max(1, Math.min(Number(process.env.AUDIT_KB_CHUNK_SIZE || 250), 1000));
const CATALOG_CHUNK_SIZE = Math.max(1, Math.min(Number(process.env.AUDIT_CATALOG_CHUNK_SIZE || 250), 1000));
const OFFER_CHUNK_SIZE = Math.max(1, Math.min(Number(process.env.AUDIT_OFFER_CHUNK_SIZE || 250), 1000));
const INDEX_CHUNK_SIZE = Math.max(1, Math.min(Number(process.env.AUDIT_INDEX_CHUNK_SIZE || 250), 1000));

function argValue(name, fallback = '') {
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

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function bindParam(params, value) {
  params.push(value);
  return `$${params.length}`;
}

function compactJson(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function csvEscape(value) {
  const text = compactJson(value).replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function writeCsv(filePath, rows, columns) {
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => csvEscape(row[column])).join(','));
  }
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function writeJson(filePath, payload) {
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function safeFilePart(value) {
  return (
    asString(value)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120) || 'unknown'
  );
}

function countBy(rows, keyFn) {
  const out = {};
  for (const row of rows) {
    const key = asString(typeof keyFn === 'function' ? keyFn(row) : row?.[keyFn]) || 'unknown';
    out[key] = Number(out[key] || 0) + 1;
  }
  return out;
}

function logStage(message) {
  process.stderr.write(`[kb-commerce-audit] ${message}\n`);
}

function topEntries(map, limit = 25) {
  return Object.entries(map || {})
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

function lower(value) {
  return asString(value).toLowerCase();
}

function firstString(...values) {
  for (const value of values) {
    const normalized = asString(value);
    if (normalized) return normalized;
  }
  return '';
}

function firstArray(...values) {
  for (const value of values) {
    if (Array.isArray(value) && value.length) return value;
  }
  return [];
}

function firstNumber(...values) {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function chunk(values, size = 1000) {
  const out = [];
  for (let index = 0; index < values.length; index += size) {
    out.push(values.slice(index, index + size));
  }
  return out;
}

function relationMissing(error) {
  const msg = lower(error?.message || error);
  return error?.code === '42P01' || msg.includes('does not exist') || msg.includes('relation');
}

async function queryRows(sql, params = [], { optional = false, label = 'query' } = {}) {
  try {
    const result = await query(sql, params);
    return { rows: result.rows || [], warning: null };
  } catch (error) {
    if (optional && (relationMissing(error) || error?.code === '57014')) {
      return {
        rows: [],
        warning: {
          label,
          code: error?.code || null,
          message: asString(error?.message || error).slice(0, 240),
        },
      };
    }
    throw error;
  }
}

async function fetchIdentityRows(productIds) {
  const rows = [];
  const warnings = [];
  const chunks = chunk(productIds, IDENTITY_CHUNK_SIZE);
  for (let index = 0; index < chunks.length; index += 1) {
    const ids = chunks[index];
    const result = await queryRows(
      `
        SELECT to_jsonb(pil) AS row
        FROM pdp_identity_listing pil
        WHERE pil.merchant_id = 'external_seed'
          AND pil.product_id = ANY($1::text[])
      `,
      [ids],
      { optional: true, label: 'pdp_identity_listing' },
    );
    rows.push(...result.rows.map((item) => item.row));
    if (result.warning) warnings.push(result.warning);
    logStage(`identity chunk ${index + 1}/${chunks.length} rows=${result.rows?.length || 0}`);
  }
  return { rows, warnings };
}

async function fetchKbRows(productIds) {
  const rows = [];
  const warnings = [];
  const chunks = chunk(productIds, KB_CHUNK_SIZE);
  for (let index = 0; index < chunks.length; index += 1) {
    const ids = chunks[index];
    const result = await queryRows(
      `
        SELECT
          kb_key,
          source,
          source_meta,
          last_success_at,
          last_error,
          updated_at,
          analysis
        FROM aurora_product_intel_kb
        WHERE kb_key = ANY($1::text[])
      `,
      [ids.map((id) => `product:${id}`)],
      { optional: true, label: 'aurora_product_intel_kb' },
    );
    rows.push(...result.rows);
    if (result.warning) warnings.push(result.warning);
    logStage(`kb chunk ${index + 1}/${chunks.length} rows=${result.rows?.length || 0}`);
  }
  return { rows, warnings };
}

async function fetchCatalogRows(productKeys) {
  const rows = [];
  const warnings = [];
  const keys = productKeys.filter(Boolean);
  const chunks = chunk(keys, CATALOG_CHUNK_SIZE);
  for (let index = 0; index < chunks.length; index += 1) {
    const keyChunk = chunks[index];
    const result = await queryRows(
      `
        SELECT
          cp.product_key,
          cp.content_key,
          to_jsonb(cp) AS row
        FROM catalog_products cp
        WHERE cp.product_key = ANY($1::text[])
      `,
      [keyChunk],
      { optional: true, label: 'catalog_products' },
    );
    rows.push(...result.rows);
    if (result.warning) warnings.push(result.warning);
    logStage(`catalog chunk ${index + 1}/${chunks.length} rows=${result.rows?.length || 0}`);
  }
  return { rows, warnings };
}

async function fetchOfferRows(productKeys) {
  const rows = [];
  const warnings = [];
  const keys = productKeys.filter(Boolean);
  const chunks = chunk(keys, OFFER_CHUNK_SIZE);
  for (let index = 0; index < chunks.length; index += 1) {
    const keyChunk = chunks[index];
    const result = await queryRows(
      `
        SELECT
          co.product_key,
          count(*)::int AS offer_count,
          min(coalesce(co.merchant_effective_price, co.list_price)) AS min_price,
          max(coalesce(co.merchant_effective_price, co.list_price)) AS max_price,
          array_agg(DISTINCT co.currency) FILTER (WHERE co.currency IS NOT NULL) AS currencies,
          array_agg(DISTINCT co.availability) FILTER (WHERE co.availability IS NOT NULL) AS availabilities
        FROM catalog_offers co
        WHERE co.product_key = ANY($1::text[])
        GROUP BY co.product_key
      `,
      [keyChunk],
      { optional: true, label: 'catalog_offers' },
    );
    rows.push(...result.rows);
    if (result.warning) warnings.push(result.warning);
    logStage(`offer chunk ${index + 1}/${chunks.length} rows=${result.rows?.length || 0}`);
  }
  return { rows, warnings };
}

async function fetchIndexRows(contentKeys) {
  const rows = [];
  const warnings = [];
  const keys = contentKeys.filter(Boolean);
  const chunks = chunk(keys, INDEX_CHUNK_SIZE);
  for (let index = 0; index < chunks.length; index += 1) {
    const keyChunk = chunks[index];
    const result = await queryRows(
      `
        SELECT
          ips.content_key,
          to_jsonb(ips) AS row
        FROM index_pipeline_state ips
        WHERE ips.content_key = ANY($1::text[])
      `,
      [keyChunk],
      { optional: true, label: 'index_pipeline_state' },
    );
    rows.push(...result.rows);
    if (result.warning) warnings.push(result.warning);
    logStage(`index chunk ${index + 1}/${chunks.length} rows=${result.rows?.length || 0}`);
  }
  return { rows, warnings };
}

async function fetchMarketCounts() {
  const result = await queryRows(
    `
      SELECT coalesce(market, 'unknown') AS market, count(*)::int AS active_external_seed_rows
      FROM external_product_seeds
      WHERE status = 'active'
        AND external_product_id LIKE 'ext_%'
      GROUP BY coalesce(market, 'unknown')
      ORDER BY active_external_seed_rows DESC, market
    `,
    [],
    { label: 'external_product_seeds_market_counts' },
  );
  return result.rows;
}

async function fetchInventorySeedRowsProjectedByProductIds(productIds, options = {}) {
  const ids = Array.from(new Set((productIds || []).map(asString).filter(Boolean)));
  const rows = [];
  const productionBuilderIds = new Set(
    Array.from(options.productionBuilderProductIds || []).map(asString).filter(Boolean),
  );
  const chunkSize = Math.max(
    1,
    Math.min(Number(options.seedProjectionChunkSize || process.env.AUDIT_SEED_PROJECTION_CHUNK_SIZE || 100), 250),
  );
  const minimalChunkSize = Math.max(
    1,
    Math.min(Number(process.env.AUDIT_SEED_MINIMAL_CHUNK_SIZE || 1000), 2000),
  );
  const fetchChunk = async (idSubset, { includeSeedProjection, label }) => {
    if (!idSubset.length) return [];
    const params = [idSubset];
    const where = [
      `eps.status = 'active'`,
      `eps.external_product_id LIKE 'ext_%'`,
      `eps.external_product_id = ANY($1::text[])`,
    ];
    if (!options.allMarkets) where.push(`eps.market = ${bindParam(params, options.market || 'US')}`);
    if (options.includeAttached !== true) where.push(`eps.attached_product_key IS NULL`);
    const seedDataSql = includeSeedProjection
      ? `
          jsonb_strip_nulls(jsonb_build_object(
            'brand', eps.seed_data->'brand',
            'brand_name', eps.seed_data->'brand_name',
            'vendor', eps.seed_data->'vendor',
            'title', eps.seed_data->'title',
            'name', eps.seed_data->'name',
            'category', eps.seed_data->'category',
            'product_type', eps.seed_data->'product_type',
            'description', eps.seed_data->'description',
            'summary', eps.seed_data->'summary',
            'images', eps.seed_data->'images',
            'image_urls', eps.seed_data->'image_urls',
            'tags', eps.seed_data->'tags',
            'variants', eps.seed_data->'variants',
            'price_amount', eps.seed_data->'price_amount',
            'price', eps.seed_data->'price',
            'price_currency', eps.seed_data->'price_currency',
            'currency', eps.seed_data->'currency',
            'availability', eps.seed_data->'availability',
            'snapshot', jsonb_strip_nulls(jsonb_build_object(
              'brand', eps.seed_data #> '{snapshot,brand}',
              'brand_name', eps.seed_data #> '{snapshot,brand_name}',
              'vendor', eps.seed_data #> '{snapshot,vendor}',
              'title', eps.seed_data #> '{snapshot,title}',
              'name', eps.seed_data #> '{snapshot,name}',
              'category', eps.seed_data #> '{snapshot,category}',
              'product_type', eps.seed_data #> '{snapshot,product_type}',
              'description', eps.seed_data #> '{snapshot,description}',
              'summary', eps.seed_data #> '{snapshot,summary}',
              'images', eps.seed_data #> '{snapshot,images}',
              'image_urls', eps.seed_data #> '{snapshot,image_urls}',
              'price_amount', eps.seed_data #> '{snapshot,price_amount}',
              'price', eps.seed_data #> '{snapshot,price}',
              'price_currency', eps.seed_data #> '{snapshot,price_currency}',
              'currency', eps.seed_data #> '{snapshot,currency}',
              'availability', eps.seed_data #> '{snapshot,availability}',
              'canonical_url', eps.seed_data #> '{snapshot,canonical_url}',
              'destination_url', eps.seed_data #> '{snapshot,destination_url}'
            )),
            'derived', jsonb_strip_nulls(jsonb_build_object(
              'recall', jsonb_strip_nulls(jsonb_build_object(
                'category', eps.seed_data #> '{derived,recall,category}',
                'retrieval_title', eps.seed_data #> '{derived,recall,retrieval_title}',
                'retrieval_summary', eps.seed_data #> '{derived,recall,retrieval_summary}',
                'retrieval_body', eps.seed_data #> '{derived,recall,retrieval_body}'
              ))
            ))
          ))`
      : `
          jsonb_strip_nulls(jsonb_build_object(
            'title', eps.title,
            'name', eps.title,
            'images', CASE WHEN eps.image_url IS NOT NULL THEN jsonb_build_array(eps.image_url) ELSE NULL END,
            'image_urls', CASE WHEN eps.image_url IS NOT NULL THEN jsonb_build_array(eps.image_url) ELSE NULL END,
            'price_amount', eps.price_amount,
            'price_currency', eps.price_currency,
            'currency', eps.price_currency,
            'availability', eps.availability,
            'snapshot', jsonb_strip_nulls(jsonb_build_object(
              'title', eps.title,
              'name', eps.title,
              'images', CASE WHEN eps.image_url IS NOT NULL THEN jsonb_build_array(eps.image_url) ELSE NULL END,
              'image_urls', CASE WHEN eps.image_url IS NOT NULL THEN jsonb_build_array(eps.image_url) ELSE NULL END,
              'price_amount', eps.price_amount,
              'price_currency', eps.price_currency,
              'currency', eps.price_currency,
              'availability', eps.availability,
              'canonical_url', eps.canonical_url,
              'destination_url', eps.destination_url
            ))
          ))`;
    const result = await queryRows(
      `
        SELECT
          eps.id,
          eps.external_product_id,
          eps.market,
          eps.tool,
          eps.domain,
          eps.title,
          eps.canonical_url,
          eps.destination_url,
          eps.image_url,
          eps.attached_product_key,
          eps.price_amount,
          eps.price_currency,
          eps.availability,
          eps.updated_at,
          ${seedDataSql} AS seed_data
        FROM external_product_seeds eps
        WHERE ${where.join('\n          AND ')}
      `,
      params,
      { label },
    );
    return result.rows || [];
  };

  const minimalChunks = chunk(ids.filter((id) => !productionBuilderIds.has(id)), minimalChunkSize);
  for (let index = 0; index < minimalChunks.length; index += 1) {
    const minimalIds = minimalChunks[index];
    const minimalRows = await fetchChunk(minimalIds, {
      includeSeedProjection: false,
      label: 'external_product_seeds_minimal',
    });
    rows.push(...minimalRows);
    logStage(`seed minimal chunk ${index + 1}/${minimalChunks.length} rows=${minimalRows.length}`);
  }

  const projectedChunks = chunk(ids.filter((id) => productionBuilderIds.has(id)), chunkSize);
  for (let index = 0; index < projectedChunks.length; index += 1) {
    const projectedIds = projectedChunks[index];
    const projectedRows = await fetchChunk(projectedIds, {
      includeSeedProjection: true,
      label: 'external_product_seeds_projected',
    });
    rows.push(...projectedRows);
    logStage(`seed projected chunk ${index + 1}/${projectedChunks.length} rows=${projectedRows.length}`);
  }
  return rows;
}

function buildSourceRows(seedRows, { productionBuilderProductIds = new Set() } = {}) {
  const rows = [];
  const failures = [];
  for (const row of seedRows) {
    try {
      const product = buildLiteExternalSeedProduct(row, {
        useProductionBuilder: productionBuilderProductIds.has(asString(row.external_product_id)),
      });
      const productId = firstString(product?.product_id, row.external_product_id, row.id);
      if (!product || !productId) {
        failures.push({
          seed_id: row.id,
          external_product_id: row.external_product_id,
          reason: 'missing_product_payload',
        });
        continue;
      }
      rows.push({
        merchant_id: EXTERNAL_SEED_MERCHANT_ID,
        product_id: productId,
        source_kind: 'external_seed',
        product,
        source_meta: {
          external_seed_id: row.id || null,
          market: row.market || null,
          tool: row.tool || null,
          updated_at: row.updated_at || null,
        },
      });
    } catch (error) {
      failures.push({
        seed_id: row.id,
        external_product_id: row.external_product_id,
        reason: 'build_external_seed_product_failed',
        message: asString(error?.message || error).slice(0, 240),
      });
    }
  }
  return { rows, failures };
}

async function hydrateSourceRowsForAudit(sourceRows, options = {}) {
  const hydratedRows = [];
  const hydrateChunkSize = Math.max(
    1,
    Math.min(Number(process.env.AUDIT_HYDRATE_CHUNK_SIZE || 1000), 4000),
  );
  const chunks = chunk(sourceRows || [], hydrateChunkSize);
  for (let index = 0; index < chunks.length; index += 1) {
    const hydratedChunk = await hydrateCatalogServingSourceRowsWithProductIntel(chunks[index], options);
    hydratedRows.push(...hydratedChunk);
    logStage(`hydrated source chunk ${index + 1}/${chunks.length} rows=${hydratedChunk.length}`);
  }
  return hydratedRows;
}

function buildLiteExternalSeedProduct(row, { useProductionBuilder = false } = {}) {
  if (useProductionBuilder) {
    const productionProduct = buildExternalSeedProduct(row);
    if (productionProduct && typeof productionProduct === 'object') return productionProduct;
  }

  const seedData = asObject(row.seed_data);
  const snapshot = asObject(seedData.snapshot);
  const facts = resolveSeedFacts(row);
  const images = firstArray(seedData.images, snapshot.images, seedData.image_urls, snapshot.image_urls);
  const brand = firstString(
    asObject(seedData.brand).name,
    seedData.brand,
    seedData.brand_name,
    seedData.vendor,
    snapshot.brand,
    snapshot.brand_name,
    snapshot.vendor,
  );
  const url = facts.url;
  const price = facts.price;
  const currency = facts.currency;
  const offer =
    url && price != null
      ? {
          offer_id: `external_seed:${row.external_product_id}`,
          merchant_id: EXTERNAL_SEED_MERCHANT_ID,
          product_id: row.external_product_id,
          price: { amount: price, currency },
          current_price: { amount: price, currency },
          external_redirect_url: url,
          availability: facts.availability || row.availability || null,
          source_system: 'external_product_seeds',
        }
      : null;
  return {
    id: row.external_product_id,
    product_id: row.external_product_id,
    merchant_id: EXTERNAL_SEED_MERCHANT_ID,
    market: row.market || 'US',
    title: facts.title,
    name: facts.title,
    brand,
    brand_name: brand,
    vendor: brand,
    category: facts.category,
    product_type: firstString(seedData.product_type, snapshot.product_type),
    description: facts.description,
    card_subtitle: facts.description,
    canonical_url: row.canonical_url || snapshot.canonical_url || seedData.canonical_url || url,
    destination_url: row.destination_url || snapshot.destination_url || seedData.destination_url || url,
    external_url: url,
    external_redirect_url: url,
    image_url: facts.image_url,
    images: images.length ? images : facts.image_url ? [facts.image_url] : [],
    image_urls: images.length ? images : facts.image_url ? [facts.image_url] : [],
    price,
    currency,
    availability: facts.availability || row.availability || null,
    in_stock: !/out|sold|unavailable/i.test(facts.availability || row.availability || ''),
    offers: offer ? [offer] : [],
    tags: firstArray(seedData.tags, snapshot.tags),
    seed_data: seedData,
    product_intel: seedData.product_intel || snapshot.product_intel || null,
    shopping_card: seedData.shopping_card || snapshot.shopping_card || null,
    search_card: seedData.search_card || snapshot.search_card || null,
    pivota_insight_summary: firstString(
      seedData.pivota_insight_summary,
      snapshot.pivota_insight_summary,
      seedData.card_intro,
      snapshot.card_intro,
      asObject(seedData.shopping_card).intro,
      asObject(snapshot.shopping_card).intro,
      asObject(asObject(seedData.product_intel).product_intel_core).what_it_is?.body,
      asObject(asObject(snapshot.product_intel).product_intel_core).what_it_is?.body,
    ),
    updated_at: row.updated_at || null,
  };
}

function resolveSeedFacts(row) {
  const seedData = asObject(row.seed_data);
  const snapshot = asObject(seedData.snapshot);
  const recall = asObject(asObject(seedData.derived).recall);
  const images = firstArray(
    seedData.images,
    snapshot.images,
    seedData.image_urls,
    snapshot.image_urls,
  );
  const variants = firstArray(seedData.variants, snapshot.variants);
  const firstVariant = asObject(variants[0]);
  const price = firstNumber(
    row.price_amount,
    seedData.price_amount,
    seedData.price,
    snapshot.price_amount,
    snapshot.price,
    firstVariant.price,
  );
  return {
    title: firstString(row.title, seedData.title, snapshot.title, seedData.name, snapshot.name),
    url: firstString(row.destination_url, row.canonical_url, seedData.destination_url, snapshot.destination_url, seedData.canonical_url, snapshot.canonical_url),
    image_url: firstString(row.image_url, images[0]),
    price,
    currency: firstString(row.price_currency, seedData.price_currency, seedData.currency, snapshot.price_currency, snapshot.currency, firstVariant.currency),
    availability: firstString(row.availability, seedData.availability, snapshot.availability, firstVariant.stock, firstVariant.availability),
    description: firstString(
      seedData.description,
      snapshot.description,
      seedData.summary,
      snapshot.summary,
      recall.retrieval_summary,
      recall.retrieval_body,
    ),
    category: firstString(seedData.category, snapshot.category, recall.category),
    source_payload_present: Boolean(Object.keys(snapshot).length || Object.keys(seedData).length),
    domain: firstString(row.domain),
  };
}

function missingSeedFields(row) {
  const facts = resolveSeedFacts(row);
  const missing = [];
  if (!facts.title) missing.push('title');
  if (!facts.url) missing.push('url');
  if (!facts.image_url) missing.push('image');
  if (facts.price == null) missing.push('price');
  if (!facts.currency) missing.push('currency');
  if (!facts.availability) missing.push('availability');
  if (!facts.description) missing.push('description_or_summary');
  if (!facts.category) missing.push('category');
  if (!facts.domain) missing.push('domain');
  if (!facts.source_payload_present) missing.push('source_payload');
  return { facts, missing };
}

function identityStatus(identity) {
  if (!identity) return { ok: false, issues: ['missing_identity'] };
  const issues = [];
  if (identity.live_read_enabled !== true) issues.push('not_live_read_enabled');
  if (asString(identity.identity_status) !== 'approved') issues.push(`identity_status_${asString(identity.identity_status) || 'missing'}`);
  if (identity.review_required === true) issues.push('review_required');
  if (!asString(identity.sellable_item_group_id)) issues.push('missing_sellable_item_group_id');
  if (!asString(identity.product_line_id)) issues.push('missing_product_line_id');
  if (!asString(identity.review_family_id)) issues.push('missing_review_family_id');
  return { ok: issues.length === 0, issues };
}

function isSellerOnlyEvidenceProfile(value) {
  const profile = lower(value);
  return profile === 'seller_only' || profile === 'seller_grounded' || profile === 'seller_only_fallback';
}

function kbMainStatus(readiness) {
  const direct = asObject(asObject(readiness).pivota_insights).direct || {};
  const effective = asObject(asObject(readiness).pivota_insights).effective || {};
  if (!direct.kb_exists) {
    return {
      ok: false,
      blocker: 'kb_missing',
      detail: effective.high_quality_ready ? 'direct_missing_effective_sibling_ready' : 'missing_direct_product_intel_kb',
    };
  }
  const issues = asArray(direct.issues);
  const blocking = asArray(direct.blocking_issues);
  const sellerOnly = isSellerOnlyEvidenceProfile(direct.evidence_profile) || issues.includes('seller_only_evidence');
  if (sellerOnly) {
    return {
      ok: false,
      blocker: 'kb_displayable_limited',
      detail: 'seller_only_or_limited_evidence',
    };
  }
  if (direct.high_quality_ready) return { ok: true, blocker: '', detail: '' };
  if (direct.displayable && !blocking.length) {
    return {
      ok: false,
      blocker: 'kb_displayable_limited',
      detail: `limited_issues:${issues.join('|')}`,
    };
  }
  return {
    ok: false,
    blocker: 'kb_blocked',
    detail: blocking.length ? `blocking_issues:${blocking.join('|')}` : `issues:${issues.join('|') || 'unknown'}`,
  };
}

function recommendedLane(blocker) {
  if (blocker === 'db_serving_ready' || blocker === 'public_index_ready') return 'ready_no_action';
  if (blocker === 'identity_blocked' || blocker === 'index_doc_shadow_only') return 'lane_1_identity_index';
  if (blocker === 'seed_content_blocked') return 'lane_2_seed_commerce_facts';
  if (blocker === 'kb_missing' || blocker === 'kb_blocked' || blocker === 'kb_displayable_limited') {
    return 'lane_3_kb_rewrite_review';
  }
  return 'triage';
}

function nextCommand(row) {
  const domain = row.domain || 'unknown';
  if (row.main_blocker === 'seed_content_blocked') {
    return `npm run external-seeds:backfill:catalog -- --market ${row.market} --domain ${domain} --dry-run`;
  }
  if (row.main_blocker === 'identity_blocked' || row.main_blocker === 'index_doc_shadow_only') {
    return `node scripts/audit-pdp-entity-resolution.js --market ${row.market} --limit 500 --dry-run`;
  }
  if (row.main_blocker === 'kb_missing' || row.main_blocker === 'kb_blocked' || row.main_blocker === 'kb_displayable_limited') {
    return `node scripts/pivota_insights_coverage_batch.js --product-ids ${row.external_product_id} --limit 1 --skip-gemini`;
  }
  return '';
}

function isDbServingReadyBlocker(blocker) {
  return blocker === 'db_serving_ready' || blocker === 'public_index_ready';
}

function resolveExternalIndexPublished(indexState = null) {
  const row = asObject(indexState);
  return Boolean(
    row.external_index_published === true ||
      row.published_to_external_index === true ||
      row.catalog_serving_index_published === true ||
      row.public_index_published === true ||
      firstString(
        row.external_index_published_at,
        row.catalog_serving_index_published_at,
        row.public_index_published_at,
      ),
  );
}

function isDealTitle(title) {
  return /^\s*\[deal\]/i.test(asString(title));
}

function hasDocPrice(doc) {
  return doc?.price_min != null || doc?.price_max != null;
}

function isCategoryOnlyMissingToleratedByServingDoc(seedFacts, doc, { hasPublicDoc, hasDocInsightSummary } = {}) {
  const missing = asArray(seedFacts?.missing).filter(Boolean);
  if (!missing.length) return false;
  if (!missing.every((field) => field === 'category')) return false;
  if (isDealTitle(seedFacts?.facts?.title)) return false;
  return Boolean(
    hasPublicDoc &&
      hasDocInsightSummary &&
      doc?.external_offer_exists === true &&
      hasDocPrice(doc) &&
      asArray(doc?.category_paths).length,
  );
}

function buildInventoryRows({
  seedRows,
  readinessByProductId,
  identityByProductId,
  kbByProductId,
  catalogByProductKey,
  offerByProductKey,
  indexByContentKey,
  docBySourceRef,
}) {
  return seedRows.map((seed) => {
    const externalProductId = asString(seed.external_product_id);
    const sourceRef = buildSourceListingRef({
      merchantId: EXTERNAL_SEED_MERCHANT_ID,
      productId: externalProductId,
    });
    const readiness = readinessByProductId.get(externalProductId) || {};
    const identity = identityByProductId.get(externalProductId) || null;
    const kb = kbByProductId.get(externalProductId) || null;
    const catalog = seed.attached_product_key ? catalogByProductKey.get(seed.attached_product_key) : null;
    const offers = seed.attached_product_key ? offerByProductKey.get(seed.attached_product_key) : null;
    const indexState = catalog?.content_key ? indexByContentKey.get(catalog.content_key) : null;
    const doc = sourceRef ? docBySourceRef.get(sourceRef) : null;
    const seedFacts = missingSeedFields(seed);
    const identityGate = identityStatus(identity);
    const kbGate = kbMainStatus(readiness);
    const hasPublicDoc = Boolean(doc && asString(doc.publish_state) === 'public');
    const hasDocInsightSummary = Boolean(asString(doc?.pivota_insight_summary));
    const categoryOnlyMissingToleratedByServingDoc = isCategoryOnlyMissingToleratedByServingDoc(seedFacts, doc, {
      hasPublicDoc,
      hasDocInsightSummary,
    });
    const externalIndexPublished = resolveExternalIndexPublished(indexState);

    let mainBlocker = 'db_serving_ready';
    let blockerDetail = '';
    if (seedFacts.missing.length && !categoryOnlyMissingToleratedByServingDoc) {
      mainBlocker = 'seed_content_blocked';
      blockerDetail = `missing:${seedFacts.missing.join('|')}`;
    } else if (!identityGate.ok) {
      mainBlocker = 'identity_blocked';
      blockerDetail = identityGate.issues.join('|');
    } else if (!kbGate.ok) {
      mainBlocker = kbGate.blocker;
      blockerDetail = kbGate.detail;
    } else if (!hasPublicDoc || !hasDocInsightSummary) {
      mainBlocker = 'index_doc_shadow_only';
      blockerDetail = !hasPublicDoc ? 'missing_public_catalog_serving_doc' : 'commerce_doc_missing_pivota_insight_summary';
    }

    const directIntel = asObject(asObject(readiness).pivota_insights).direct || {};
    const effectiveIntel = asObject(asObject(readiness).pivota_insights).effective || {};
    const activeIngredients = asObject(readiness.active_ingredients);
    const variants = asObject(readiness.variants);
    const facts = seedFacts.facts;
    const row = {
      seed_id: seed.id,
      external_product_id: externalProductId,
      source_listing_ref: sourceRef,
      market: seed.market,
      domain: seed.domain,
      brand: firstString(asObject(seed.seed_data).brand, asObject(asObject(seed.seed_data).snapshot).brand, doc?.brand_name),
      title: facts.title,
      canonical_url: seed.canonical_url,
      destination_url: seed.destination_url,
      attached_product_key: seed.attached_product_key,
      content_key: catalog?.content_key || '',
      seed_missing_fields: seedFacts.missing.join('|'),
      seed_missing_tolerated_by_serving_builder: categoryOnlyMissingToleratedByServingDoc,
      identity_exists: Boolean(identity),
      identity_status: identity?.identity_status || '',
      identity_live_read_enabled: identity?.live_read_enabled === true,
      identity_review_required: identity?.review_required === true,
      identity_source_tier: identity?.source_tier || '',
      sellable_item_group_id: identity?.sellable_item_group_id || '',
      product_line_id: identity?.product_line_id || '',
      review_family_id: identity?.review_family_id || '',
      kb_exists: Boolean(kb),
      kb_last_success_at: kb?.last_success_at || '',
      kb_last_error: kb?.last_error ? compactJson(kb.last_error) : '',
      kb_direct_status: directIntel.status || '',
      kb_direct_displayable: directIntel.displayable === true,
      kb_direct_high_quality_ready: directIntel.high_quality_ready === true,
      kb_direct_human_reviewed: directIntel.human_reviewed === true,
      kb_direct_quality_state: directIntel.quality_state || '',
      kb_direct_evidence_profile: directIntel.evidence_profile || '',
      kb_direct_issues: asArray(directIntel.issues).join('|'),
      kb_direct_blocking_issues: asArray(directIntel.blocking_issues).join('|'),
      kb_effective_product_id: effectiveIntel.product_id || '',
      kb_effective_high_quality_ready: effectiveIntel.high_quality_ready === true,
      kb_borrowed_from_sibling: asObject(readiness.pivota_insights).borrowed_from_sibling === true,
      active_ingredients_status: activeIngredients.status || '',
      active_ingredients_issues: asArray(activeIngredients.issues).join('|'),
      variant_status: variants.status || '',
      variant_issues: asArray(variants.issues).join('|'),
      catalog_attached: Boolean(catalog),
      catalog_offer_count: offers?.offer_count || 0,
      index_pipeline_state_exists: Boolean(indexState),
      index_serving_eligible: indexState?.serving_eligible === true,
      db_serving_ready: mainBlocker === 'db_serving_ready',
      external_index_published: externalIndexPublished,
      commerce_doc_public: hasPublicDoc,
      commerce_doc_id: doc?.doc_id || '',
      commerce_doc_has_pivota_insight_summary: hasDocInsightSummary,
      commerce_doc_pivota_insight_status: doc?.pivota_insight_status || '',
      commerce_doc_price_min: doc?.price_min ?? '',
      commerce_doc_price_max: doc?.price_max ?? '',
      commerce_doc_external_offer_exists: doc?.external_offer_exists === true,
      main_blocker: mainBlocker,
      blocker_detail: blockerDetail,
      recommended_lane: recommendedLane(mainBlocker),
    };
    row.next_command = nextCommand(row);
    return row;
  });
}

function buildDomainRollup(inventoryRows, docsByDomain) {
  const domains = new Map();
  for (const row of inventoryRows) {
    const key = asString(row.domain) || 'unknown';
    if (!domains.has(key)) {
      domains.set(key, {
        domain: key,
        seed_rows: 0,
        db_serving_ready: 0,
        public_index_ready: 0,
        external_index_published: 0,
        commerce_public_docs: 0,
        direct_kb_high_quality_ready: 0,
        direct_kb_displayable: 0,
        identity_ready: 0,
        seed_content_blocked: 0,
        identity_blocked: 0,
        kb_missing: 0,
        kb_blocked: 0,
        kb_displayable_limited: 0,
        index_doc_shadow_only: 0,
        top_blocker: '',
      });
    }
    const item = domains.get(key);
    item.seed_rows += 1;
    if (isDbServingReadyBlocker(row.main_blocker)) {
      item.db_serving_ready += 1;
      item.public_index_ready += 1;
    }
    if (row.external_index_published) item.external_index_published += 1;
    if (row.commerce_doc_public) item.commerce_public_docs += 1;
    if (row.kb_direct_high_quality_ready) item.direct_kb_high_quality_ready += 1;
    if (row.kb_direct_displayable) item.direct_kb_displayable += 1;
    if (row.identity_exists && row.identity_live_read_enabled && row.identity_status === 'approved' && !row.identity_review_required) {
      item.identity_ready += 1;
    }
    if (
      !isDbServingReadyBlocker(row.main_blocker) &&
      Object.prototype.hasOwnProperty.call(item, row.main_blocker)
    ) {
      item[row.main_blocker] += 1;
    }
  }
  for (const item of domains.values()) {
    const blockers = {
      seed_content_blocked: item.seed_content_blocked,
      identity_blocked: item.identity_blocked,
      kb_missing: item.kb_missing,
      kb_blocked: item.kb_blocked,
      kb_displayable_limited: item.kb_displayable_limited,
      index_doc_shadow_only: item.index_doc_shadow_only,
    };
    item.commerce_public_doc_groups = docsByDomain.get(item.domain) || 0;
    item.db_serving_ready_rate = item.seed_rows ? Number((item.db_serving_ready / item.seed_rows).toFixed(4)) : 0;
    item.public_index_ready_rate = item.db_serving_ready_rate;
    item.top_blocker = topEntries(blockers, 1)[0]?.key || '';
  }
  return Array.from(domains.values()).sort((left, right) => right.seed_rows - left.seed_rows || left.domain.localeCompare(right.domain));
}

function sortBacklogRows(rows, domainRollup) {
  const lanePriority = {
    lane_1_identity_index: 1,
    lane_2_seed_commerce_facts: 2,
    lane_3_kb_rewrite_review: 3,
    triage: 9,
    ready_no_action: 99,
  };
  const domainImpact = new Map(domainRollup.map((row) => [row.domain, row.seed_rows]));
  return [...rows].sort((left, right) => {
    const laneDelta =
      Number(lanePriority[left.recommended_lane] || 50) -
      Number(lanePriority[right.recommended_lane] || 50);
    if (laneDelta) return laneDelta;
    const impactDelta = Number(domainImpact.get(right.domain) || 0) - Number(domainImpact.get(left.domain) || 0);
    if (impactDelta) return impactDelta;
    const blockerDelta = asString(left.main_blocker).localeCompare(asString(right.main_blocker));
    if (blockerDelta) return blockerDelta;
    return asString(left.external_product_id).localeCompare(asString(right.external_product_id));
  });
}

function summarizeInventory(inventoryRows, publicDocs, sourceBuildFailures, warnings, marketCounts) {
  const blockers = countBy(inventoryRows, 'main_blocker');
  const lanes = countBy(inventoryRows, 'recommended_lane');
  const dbServingReadyRows = inventoryRows.filter((row) => isDbServingReadyBlocker(row.main_blocker)).length;
  const externalIndexConfig = getCatalogServingIndexConfig(process.env);
  return {
    generated_at: new Date().toISOString(),
    market_counts: marketCounts,
    scanned_rows: inventoryRows.length,
    db_serving_ready_rows: dbServingReadyRows,
    db_serving_ready_rate: inventoryRows.length
      ? Number((dbServingReadyRows / inventoryRows.length).toFixed(4))
      : 0,
    public_index_ready_rows: dbServingReadyRows,
    public_index_ready_rate: inventoryRows.length
      ? Number((dbServingReadyRows / inventoryRows.length).toFixed(4))
      : 0,
    blocker_breakdown: topEntries(blockers, 20),
    lane_breakdown: topEntries(lanes, 20),
    kb: {
      direct_displayable: inventoryRows.filter((row) => row.kb_direct_displayable).length,
      direct_high_quality_ready: inventoryRows.filter((row) => row.kb_direct_high_quality_ready).length,
      direct_seller_only_or_limited: inventoryRows.filter((row) =>
        isSellerOnlyEvidenceProfile(row.kb_direct_evidence_profile),
      ).length,
      missing_or_no_direct_kb: inventoryRows.filter((row) => !row.kb_exists).length,
    },
    identity: {
      identity_rows_joined: inventoryRows.filter((row) => row.identity_exists).length,
      identity_ready_rows: inventoryRows.filter(
        (row) => row.identity_exists && row.identity_live_read_enabled && row.identity_status === 'approved' && !row.identity_review_required,
      ).length,
    },
    commerce_index: {
      db_serving_ready_rows: dbServingReadyRows,
      external_index_published_rows: inventoryRows.filter((row) => row.external_index_published).length,
      public_doc_groups_built_dry_run: publicDocs.length,
      rows_with_public_doc: inventoryRows.filter((row) => row.commerce_doc_public).length,
      rows_with_public_doc_and_insight_summary: inventoryRows.filter(
        (row) => row.commerce_doc_public && row.commerce_doc_has_pivota_insight_summary,
      ).length,
      index_config: externalIndexConfig,
      external_index_required_for_db_serving_ready: false,
    },
    source_build_failures: sourceBuildFailures.slice(0, 50),
    warnings,
  };
}

function renderExecSummary({ summary, domainRollup, readinessSummary, reportDir, options }) {
  const blockerLines = summary.blocker_breakdown
    .map((item) => `| ${item.key} | ${item.count} |`)
    .join('\n');
  const domainLines = domainRollup
    .slice(0, 20)
    .map(
      (row) =>
        `| ${row.domain} | ${row.seed_rows} | ${row.db_serving_ready} | ${row.db_serving_ready_rate} | ${row.external_index_published} | ${row.top_blocker} |`,
    )
    .join('\n');
  const marketLines = summary.market_counts
    .map((row) => `| ${row.market} | ${row.active_external_seed_rows} |`)
    .join('\n');
  return `# KB x Commerce Index Readiness Audit

Generated: ${summary.generated_at}

Scope: active external seeds, market=${options.market}, include_attached=true, limit=${options.limit}

Report directory: ${reportDir}

## Executive Numbers

- Rows scanned: ${summary.scanned_rows}
- DB Serving Ready rows: ${summary.db_serving_ready_rows} (${summary.db_serving_ready_rate})
- External index published rows: ${summary.commerce_index.external_index_published_rows}
- Direct KB displayable rows: ${summary.kb.direct_displayable}
- Direct KB high-quality-ready rows: ${summary.kb.direct_high_quality_ready}
- Identity ready rows: ${summary.identity.identity_ready_rows}
- Public commerce doc groups built by dry-run: ${summary.commerce_index.public_doc_groups_built_dry_run}
- Rows with public commerce doc + insight summary: ${summary.commerce_index.rows_with_public_doc_and_insight_summary}
- External index configured: ${summary.commerce_index.index_config.enabled === true}
- External index required for DB Serving Ready: ${summary.commerce_index.external_index_required_for_db_serving_ready === true}

## Active External Seed Rows By Market

| Market | Active rows |
| --- | ---: |
${marketLines}

## Main Blockers

| Blocker | Rows |
| --- | ---: |
${blockerLines}

## Top Domains

| Domain | Seed rows | DB serving ready | Ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | --- |
${domainLines}

## Existing PDP/KB Readiness Summary

\`\`\`json
${JSON.stringify(readinessSummary, null, 2)}
\`\`\`

## Notes

- DB Serving Ready is stricter than KB presence. Seller-only or limited evidence is not counted as high-quality pass.
- Commerce dry-run used the same catalog serving document builder with \`includeNonPublic=false\` and market-filtered source rows derived from \`external_product_seeds\`; no DB/index writes were attempted.
- A row can have high-quality KB and still fail DB serving readiness if identity or commerce doc hydration does not expose it.
- External index publication is tracked separately and is not a blocker for the current DB-backed serving path.
- Next remediation should start from \`gap_backlog.csv\` ordered by lane and domain impact.
`;
}

async function main() {
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const options = {
    market: asString(argValue('market', 'US')).toUpperCase() || 'US',
    limit: Math.max(1, Math.min(Number(argValue('limit', '20000')) || 20000, 20000)),
    pageSize: Math.max(1, Math.min(Number(argValue('page-size', '500')) || 500, 1000)),
    sampleLimit: Math.max(1, Math.min(Number(argValue('sample-limit', '10')) || 10, 100)),
    outDir: argValue('out-dir', path.join('reports', `kb_commerce_index_readiness_${datePart}`)),
    resume: hasFlag('resume'),
    force: hasFlag('force'),
  };
  const outDir = path.resolve(options.outDir);
  ensureDir(outDir);

  logStage(`start market=${options.market} limit=${options.limit} out_dir=${outDir}`);
  await query(`SET statement_timeout = '240000ms'`, []);

  logStage('fetch market counts');
  const warnings = [];
  const marketCounts = await fetchMarketCounts();
  const checkpointDir = path.join(outDir, 'pdp_readiness_checkpoint');
  logStage(`build/read checkpointed pdp readiness audit checkpoint_dir=${checkpointDir}`);
  const readinessAudit = await buildCheckpointedReadinessAudit({
    market: options.market,
    includeAttached: true,
    limit: options.limit,
    sampleLimit: options.sampleLimit,
    checkpointDir,
    checkpointMode: 'domain',
    resume: options.resume,
    force: options.force,
    continueOnError: true,
    pageSize: options.pageSize,
    format: 'json',
  });
  writeJson(path.join(outDir, 'pdp_readiness_audit.json'), readinessAudit);
  logStage(`pdp readiness rows=${readinessAudit.rows?.length || 0}`);

  const readinessProductIds = Array.from(
    new Set((readinessAudit.rows || []).map((row) => asString(row.external_product_id)).filter(Boolean)),
  );
  const productionBuilderProductIds = new Set();
  for (const row of readinessAudit.rows || []) {
    const productId = asString(row.external_product_id);
    const directIntel = asObject(asObject(row).pivota_insights).direct || {};
    const effectiveIntel = asObject(asObject(row).pivota_insights).effective || {};
    if (
      productId &&
      (directIntel.displayable === true ||
        directIntel.high_quality_ready === true ||
        effectiveIntel.displayable === true ||
        effectiveIntel.high_quality_ready === true)
    ) {
      productionBuilderProductIds.add(productId);
    }
  }
  logStage(`production builder candidates=${productionBuilderProductIds.size}`);
  logStage(`fetch projected seed rows for inventory product_ids=${readinessProductIds.length}`);
  const seedRows = await fetchInventorySeedRowsProjectedByProductIds(readinessProductIds, {
    market: options.market,
    includeAttached: true,
    limit: options.limit,
    pageSize: options.pageSize,
    productionBuilderProductIds,
  });
  if ((readinessAudit.rows?.length || 0) !== seedRows.length) {
    warnings.push({
      label: 'readiness_seed_count_mismatch',
      message: `readiness rows=${readinessAudit.rows?.length || 0}, seed rows=${seedRows.length}`,
    });
  }
  logStage(`seed rows=${seedRows.length}`);
  const productIds = Array.from(new Set(seedRows.map((row) => asString(row.external_product_id)).filter(Boolean)));
  const productKeys = Array.from(new Set(seedRows.map((row) => asString(row.attached_product_key)).filter(Boolean)));

  logStage(`fetch identity rows product_ids=${productIds.length}`);
  const identityPayload = await fetchIdentityRows(productIds);
  warnings.push(...identityPayload.warnings);
  const identityByProductId = new Map();
  for (const row of identityPayload.rows) {
    identityByProductId.set(asString(row.product_id), row);
  }
  logStage(`identity rows=${identityPayload.rows.length}`);

  logStage(`fetch kb rows product_ids=${productIds.length}`);
  const kbPayload = await fetchKbRows(productIds);
  warnings.push(...kbPayload.warnings);
  const kbByProductId = new Map();
  for (const row of kbPayload.rows) {
    const productId = asString(row.kb_key).replace(/^product:/, '');
    if (productId) kbByProductId.set(productId, row);
  }
  logStage(`kb rows=${kbPayload.rows.length}`);
  const readinessByProductId = new Map();
  for (const row of readinessAudit.rows || []) {
    readinessByProductId.set(asString(row.external_product_id), row);
  }

  logStage(`fetch catalog rows attached_product_keys=${productKeys.length}`);
  const catalogPayload = await fetchCatalogRows(productKeys);
  warnings.push(...catalogPayload.warnings);
  const catalogByProductKey = new Map();
  for (const row of catalogPayload.rows) {
    catalogByProductKey.set(asString(row.product_key), {
      ...(row.row || {}),
      product_key: row.product_key,
      content_key: row.content_key,
    });
  }
  logStage(`catalog rows=${catalogPayload.rows.length}`);

  logStage(`fetch offer rows attached_product_keys=${productKeys.length}`);
  const offerPayload = await fetchOfferRows(productKeys);
  warnings.push(...offerPayload.warnings);
  const offerByProductKey = new Map();
  for (const row of offerPayload.rows) {
    offerByProductKey.set(asString(row.product_key), row);
  }
  logStage(`offer rows=${offerPayload.rows.length}`);

  const contentKeys = Array.from(new Set(catalogPayload.rows.map((row) => asString(row.content_key)).filter(Boolean)));
  logStage(`fetch index pipeline rows content_keys=${contentKeys.length}`);
  const indexPayload = await fetchIndexRows(contentKeys);
  warnings.push(...indexPayload.warnings);
  const indexByContentKey = new Map();
  for (const row of indexPayload.rows) {
    indexByContentKey.set(asString(row.content_key), row.row || {});
  }
  logStage(`index rows=${indexPayload.rows.length}`);

  logStage('build market-filtered source rows for commerce public dry-run');
  const sourcePayload = buildSourceRows(seedRows, { productionBuilderProductIds });
  logStage(`source rows=${sourcePayload.rows.length} source_build_failures=${sourcePayload.failures.length}`);
  logStage('hydrate source rows from high-quality product-intel KB for commerce dry-run');
  const hydratedSourceRows = await hydrateSourceRowsForAudit(sourcePayload.rows, {
    queryFn: query,
    env: process.env,
  });
  logStage('build public-only catalog serving dry-run docs');
  const publicDocs = buildCatalogServingBackfillDocs(hydratedSourceRows, {
    identityRows: identityPayload.rows,
    includeNonPublic: false,
    market: options.market,
  });
  logStage(`public dry-run docs=${publicDocs.length}`);
  writeJson(path.join(outDir, 'commerce_public_dry_run_docs.json'), {
    generated_at: new Date().toISOString(),
    market: options.market,
    include_non_public: false,
    docs_built: publicDocs.length,
    source_build_failures: sourcePayload.failures,
    docs: publicDocs,
  });

  const docBySourceRef = new Map();
  const docsByDomain = new Map();
  const seedByExternalProductId = new Map(seedRows.map((row) => [asString(row.external_product_id), row]));
  for (const doc of publicDocs) {
    for (const sourceRef of asArray(doc.source_refs)) {
      docBySourceRef.set(asString(sourceRef), doc);
      const productId = asString(sourceRef).split(':').slice(1).join(':');
      const seed = seedByExternalProductId.get(productId);
      if (seed?.domain) docsByDomain.set(seed.domain, Number(docsByDomain.get(seed.domain) || 0) + 1);
    }
  }

  logStage('build inventory rows and rollups');
  const inventoryRows = buildInventoryRows({
    seedRows,
    readinessByProductId,
    identityByProductId,
    kbByProductId,
    catalogByProductKey,
    offerByProductKey,
    indexByContentKey,
    docBySourceRef,
  });
  const domainRollup = buildDomainRollup(inventoryRows, docsByDomain);
  const summary = summarizeInventory(
    inventoryRows,
    publicDocs,
    sourcePayload.failures,
    warnings,
    marketCounts,
  );

  logStage('write report artifacts');
  const inventoryColumns = [
    'seed_id',
    'external_product_id',
    'source_listing_ref',
    'market',
    'domain',
    'brand',
    'title',
    'canonical_url',
    'destination_url',
    'attached_product_key',
    'content_key',
    'seed_missing_fields',
    'seed_missing_tolerated_by_serving_builder',
    'identity_exists',
    'identity_status',
    'identity_live_read_enabled',
    'identity_review_required',
    'identity_source_tier',
    'sellable_item_group_id',
    'product_line_id',
    'review_family_id',
    'kb_exists',
    'kb_last_success_at',
    'kb_last_error',
    'kb_direct_status',
    'kb_direct_displayable',
    'kb_direct_high_quality_ready',
    'kb_direct_human_reviewed',
    'kb_direct_quality_state',
    'kb_direct_evidence_profile',
    'kb_direct_issues',
    'kb_direct_blocking_issues',
    'kb_effective_product_id',
    'kb_effective_high_quality_ready',
    'kb_borrowed_from_sibling',
    'active_ingredients_status',
    'active_ingredients_issues',
    'variant_status',
    'variant_issues',
    'catalog_attached',
    'catalog_offer_count',
    'index_pipeline_state_exists',
    'index_serving_eligible',
    'db_serving_ready',
    'external_index_published',
    'commerce_doc_public',
    'commerce_doc_id',
    'commerce_doc_has_pivota_insight_summary',
    'commerce_doc_pivota_insight_status',
    'commerce_doc_price_min',
    'commerce_doc_price_max',
    'commerce_doc_external_offer_exists',
    'main_blocker',
    'blocker_detail',
    'recommended_lane',
    'next_command',
  ];
  const rollupColumns = [
    'domain',
    'seed_rows',
    'db_serving_ready',
    'db_serving_ready_rate',
    'public_index_ready',
    'public_index_ready_rate',
    'external_index_published',
    'commerce_public_docs',
    'commerce_public_doc_groups',
    'direct_kb_high_quality_ready',
    'direct_kb_displayable',
    'identity_ready',
    'seed_content_blocked',
    'identity_blocked',
    'kb_missing',
    'kb_blocked',
    'kb_displayable_limited',
    'index_doc_shadow_only',
    'top_blocker',
  ];
  writeJson(path.join(outDir, 'commerce_index_kb_readiness_inventory.json'), inventoryRows);
  writeCsv(path.join(outDir, 'commerce_index_kb_readiness_inventory.csv'), inventoryRows, inventoryColumns);
  writeCsv(path.join(outDir, 'domain_rollup.csv'), domainRollup, rollupColumns);
  const gapRows = sortBacklogRows(
    inventoryRows.filter((row) => !isDbServingReadyBlocker(row.main_blocker)),
    domainRollup,
  );
  writeCsv(
    path.join(outDir, 'gap_backlog.csv'),
    gapRows,
    inventoryColumns,
  );
  writeCsv(
    path.join(outDir, 'kb_rewrite_candidates.csv'),
    inventoryRows.filter((row) =>
      ['kb_missing', 'kb_blocked', 'kb_displayable_limited'].includes(row.main_blocker),
    ),
    inventoryColumns,
  );
  writeCsv(
    path.join(outDir, 'shadow_or_limited_use.csv'),
    inventoryRows.filter((row) =>
      row.main_blocker === 'index_doc_shadow_only' || row.main_blocker === 'kb_displayable_limited',
    ),
    inventoryColumns,
  );
  writeCsv(
    path.join(outDir, 'public_index_ready_candidates.csv'),
    inventoryRows.filter((row) => isDbServingReadyBlocker(row.main_blocker)),
    inventoryColumns,
  );
  writeCsv(
    path.join(outDir, 'db_serving_ready_candidates.csv'),
    inventoryRows.filter((row) => isDbServingReadyBlocker(row.main_blocker)),
    inventoryColumns,
  );
  writeCsv(
    path.join(outDir, 'external_index_published_candidates.csv'),
    inventoryRows.filter((row) => row.external_index_published),
    inventoryColumns,
  );
  writeJson(path.join(outDir, 'summary.json'), summary);
  fs.writeFileSync(
    path.join(outDir, 'exec_summary.md'),
    renderExecSummary({
      summary,
      domainRollup,
      readinessSummary: readinessAudit.summary,
      reportDir: outDir,
      options,
    }),
    'utf8',
  );

  process.stdout.write(`${JSON.stringify({ ok: true, out_dir: outDir, summary }, null, 2)}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await getPool()?.end();
    } catch {}
  });
