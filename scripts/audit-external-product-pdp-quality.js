#!/usr/bin/env node

const axios = require('axios');

const { query } = require('../src/db');
const { auditExternalSeedRow } = require('../src/services/externalSeedContentAudit');
const { ensureJsonObject } = require('../src/services/externalSeedProducts');
const { resolveExternalSeedRecallDoc } = require('../src/services/externalSeedRecall');
const {
  buildSeedGate,
  buildExtractorGate,
  buildLivePdpGate,
  buildSimilarGate,
  buildExternalSeedQualityResult,
} = require('../src/services/externalSeedPdpQuality');
const {
  pickSeedTargetUrl,
  buildExtractRequestBody,
} = require('./backfill-external-product-seeds-catalog');

const DEFAULT_CATALOG_BASE_URL =
  process.env.CATALOG_INTELLIGENCE_BASE_URL ||
  'https://pivota-catalog-intelligence-production.up.railway.app';
const DEFAULT_GATEWAY_URL =
  process.env.EXTERNAL_PDP_QUALITY_GATEWAY_URL ||
  process.env.PDP_SMOKE_GATEWAY ||
  'https://agent.pivota.cc/api/gateway';

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

function normalizeNonEmptyString(value) {
  return String(value || '').trim();
}

function normalizeUrlLike(value) {
  const normalized = normalizeNonEmptyString(value);
  return /^https?:\/\//i.test(normalized) ? normalized : '';
}

function resolveGatewayUrl(value) {
  const normalized = normalizeUrlLike(value);
  if (!normalized) return DEFAULT_GATEWAY_URL;
  const trimmed = normalized.replace(/\/+$/, '');
  if (/\/(?:api\/gateway|agent\/shop\/v1\/invoke)$/i.test(trimmed)) return trimmed;
  return `${trimmed}/api/gateway`;
}

function getHeaders() {
  const apiKey = normalizeNonEmptyString(process.env.PIVOTA_API_KEY);
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['X-API-Key'] = apiKey;
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

async function fetchRows({ market, seedId, externalProductId, domain, brand, limit, offset }) {
  const where = [
    `status = 'active'`,
    `attached_product_key IS NULL`,
    `market = $1`,
    `(tool = '*' OR tool = 'creator_agents')`,
  ];
  const params = [market];
  const bind = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (seedId) where.push(`id::text = ${bind(seedId)}`);
  if (externalProductId) where.push(`external_product_id = ${bind(externalProductId)}`);
  if (domain) where.push(`domain = ${bind(domain)}`);
  if (brand) where.push(`lower(coalesce(seed_data->>'brand', seed_data->'snapshot'->>'brand', '')) = lower(${bind(brand)})`);

  params.push(limit);
  const limitBind = `$${params.length}`;
  params.push(offset);
  const offsetBind = `$${params.length}`;

  const res = await query(
    `
      SELECT
        id,
        external_product_id,
        market,
        domain,
        canonical_url,
        destination_url,
        title,
        price_amount,
        price_currency,
        availability,
        seed_data,
        updated_at,
        created_at
      FROM external_product_seeds
      WHERE ${where.join('\n        AND ')}
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT ${limitBind}
      OFFSET ${offsetBind}
    `,
    params,
  );
  return res.rows || [];
}

async function fetchExtractorTruth(row, baseUrl) {
  const targetUrl = pickSeedTargetUrl(row);
  if (!targetUrl) {
    return {
      target_url: '',
      response: { diagnostics: { failure_category: 'missing_target_url' } },
      product: null,
    };
  }
  const response = await axios.post(
    `${baseUrl.replace(/\/$/, '')}/api/extract`,
    buildExtractRequestBody(targetUrl, row),
    {
      timeout: Number(process.env.CATALOG_INTELLIGENCE_TIMEOUT_MS || 90000),
      headers: { 'Content-Type': 'application/json' },
    },
  );
  const data = response.data || {};
  return {
    target_url: targetUrl,
    response: data,
    product: Array.isArray(data.products) && data.products.length > 0 ? data.products[0] : null,
  };
}

async function invokeGateway(gatewayUrl, operation, payload) {
  const response = await axios.post(
    resolveGatewayUrl(gatewayUrl),
    { operation, payload },
    {
      timeout: Number(process.env.EXTERNAL_PDP_QUALITY_GATE_TIMEOUT_MS || 45000),
      headers: getHeaders(),
      validateStatus: () => true,
    },
  );
  return response.data || {};
}

function unwrapLivePdpPayload(response = {}) {
  const directPayload = ensureJsonObject(response?.pdp_payload || response?.payload);
  if (Array.isArray(directPayload?.modules)) return directPayload;

  const modules = Array.isArray(response?.modules) ? response.modules : [];
  const canonical = modules.find((module) => module?.type === 'canonical');
  const canonicalPayload = ensureJsonObject(canonical?.data?.pdp_payload || canonical?.data?.payload);
  if (Array.isArray(canonicalPayload?.modules)) return canonicalPayload;

  return ensureJsonObject(response);
}

async function auditRow(row, { catalogBaseUrl, gatewayUrl }) {
  const seedData = ensureJsonObject(row.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const recall = resolveExternalSeedRecallDoc({ row, seedData, snapshot });
  const extractor = await fetchExtractorTruth(row, catalogBaseUrl);
  const productId =
    normalizeNonEmptyString(row.external_product_id) ||
    normalizeNonEmptyString(seedData.external_product_id) ||
    normalizeNonEmptyString(seedData.product_id);
  const [livePdp, similar] = await Promise.all([
    productId
      ? invokeGateway(gatewayUrl, 'get_pdp_v2', { product_id: productId })
      : Promise.resolve({ error: 'missing_product_id' }),
    productId
      ? invokeGateway(gatewayUrl, 'find_similar_products', {
          product_id: productId,
          limit: 6,
          options: { debug: true, no_cache: true },
        })
      : Promise.resolve({ error: 'missing_product_id' }),
  ]);
  const audit = auditExternalSeedRow(row);
  const seedGate = buildSeedGate(audit);
  const extractorGate = buildExtractorGate({
    extractorResponse: extractor.response,
    extractorProduct: extractor.product || {},
  });
  const livePdpGate = buildLivePdpGate({
    extractorProduct: extractor.product || {},
    livePayload: unwrapLivePdpPayload(livePdp),
  });
  const similarGate = buildSimilarGate({
    similarResponse: ensureJsonObject(similar),
    exclusionFlags: recall.exclusion_flags || {},
  });
  return buildExternalSeedQualityResult({
    seedId: row.id,
    externalProductId: productId,
    canonicalUrl: normalizeUrlLike(row.canonical_url || snapshot.canonical_url || extractor.target_url),
    seedGate,
    extractorGate,
    livePdpGate,
    similarGate,
  });
}

async function main() {
  const market = normalizeNonEmptyString(argValue('market') || 'US').toUpperCase();
  const format = normalizeNonEmptyString(argValue('format') || 'summary').toLowerCase();
  const limit = Math.max(1, Math.min(200, Number(argValue('limit') || 20) || 20));
  const offset = Math.max(0, Number(argValue('offset') || 0) || 0);
  const gatewayUrl = resolveGatewayUrl(argValue('gateway-url') || argValue('gateway') || argValue('gateway-base-url'));
  const rows = await fetchRows({
    market,
    seedId: argValue('seed-id'),
    externalProductId: argValue('external-product-id'),
    domain: argValue('domain'),
    brand: argValue('brand'),
    limit,
    offset,
  });

  const results = [];
  for (const row of rows) {
    results.push(
      await auditRow(row, {
        catalogBaseUrl: DEFAULT_CATALOG_BASE_URL,
        gatewayUrl,
      }),
    );
  }

  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return;
  }

  const summary = {
    scanned: results.length,
    failed: results.filter((item) => item.failure_reasons.length > 0).length,
    failure_reason_counts: results.reduce((acc, item) => {
      item.failure_reasons.forEach((reason) => {
        acc[reason] = (acc[reason] || 0) + 1;
      });
      return acc;
    }, {}),
    results,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
    process.exit(1);
  });
}

module.exports = {
  fetchRows,
  fetchExtractorTruth,
  invokeGateway,
  resolveGatewayUrl,
  unwrapLivePdpPayload,
  auditRow,
};
