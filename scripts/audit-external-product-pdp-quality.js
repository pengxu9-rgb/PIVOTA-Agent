#!/usr/bin/env node

const axios = require('axios');

const { query } = require('../src/db');
const { auditExternalSeedRow } = require('../src/services/externalSeedContentAudit');
const { ensureJsonObject } = require('../src/services/externalSeedProducts');
const { resolveExternalSeedRecallDoc } = require('../src/services/externalSeedRecall');
const {
  buildSeedGate,
  buildExtractorGate,
  buildIdentityGate,
  buildProductIntelGate,
  buildLivePdpGate,
  buildSimilarGate,
  buildExternalSeedQualityResult,
  collectLiveGalleryImages,
} = require('../src/services/externalSeedPdpQuality');
const {
  pickSeedTargetUrl,
  buildExtractRequestBody,
} = require('./backfill-external-product-seeds-catalog');

const PUBLIC_GATEWAY_PATH = `/${['api', 'gateway'].join('/')}`;
const AUTHORITATIVE_INVOKE_PATH = `/${['agent', 'shop', 'v1', 'invoke'].join('/')}`;
const DEFAULT_PUBLIC_GATEWAY_ORIGIN = 'https://agent.pivota.cc';
const DEFAULT_CATALOG_BASE_URL =
  process.env.CATALOG_INTELLIGENCE_BASE_URL ||
  'https://pivota-catalog-intelligence-production.up.railway.app';
const DEFAULT_GATEWAY_URL =
  process.env.PIVOTA_GATEWAY_URL ||
  process.env.EXTERNAL_PDP_QUALITY_GATEWAY_URL ||
  process.env.PDP_SMOKE_GATEWAY ||
  `${DEFAULT_PUBLIC_GATEWAY_ORIGIN}${PUBLIC_GATEWAY_PATH}`;
const DEFAULT_PDP_QUALITY_INCLUDE = [
  'media_gallery',
  'price_promo',
  'variant_selector',
  'product_overview',
  'supplemental_details',
  'product_facts',
  'active_ingredients',
  'ingredients_inci',
  'how_to_use',
  'reviews_preview',
  'product_intel',
  'offers',
];

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

function hasArg(name) {
  return process.argv.includes(`--${name}`);
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
  const lowered = trimmed.toLowerCase();
  if (lowered.endsWith(PUBLIC_GATEWAY_PATH) || lowered.endsWith(AUTHORITATIVE_INVOKE_PATH)) {
    return trimmed;
  }
  return `${trimmed}${PUBLIC_GATEWAY_PATH}`;
}

function getHeaders() {
  const apiKey = normalizeNonEmptyString(
    process.env.PIVOTA_BACKEND_AGENT_API_KEY ||
      process.env.SHOP_GATEWAY_AGENT_API_KEY ||
      process.env.PIVOTA_AGENT_API_KEY ||
      process.env.AGENT_API_KEY ||
      process.env.PIVOTA_API_KEY,
  );
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['X-Agent-API-Key'] = apiKey;
    headers['X-API-Key'] = apiKey;
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function isAuthoritativeInvokeUrl(gatewayUrl) {
  return resolveGatewayUrl(gatewayUrl).toLowerCase().endsWith(AUTHORITATIVE_INVOKE_PATH);
}

function buildAuthoritativePayload(operation, payload = {}) {
  if (operation === 'get_pdp_v2') {
    return {
      operation,
      payload: {
        product_ref: {
          merchant_id: 'external_seed',
          product_id: normalizeNonEmptyString(payload.product_id),
        },
        include: Array.isArray(payload.include) && payload.include.length
          ? payload.include
          : DEFAULT_PDP_QUALITY_INCLUDE,
        options: {
          ...ensureJsonObject(payload.options),
          debug: true,
          no_cache: true,
        },
      },
    };
  }
  if (operation === 'find_similar_products') {
    return {
      operation,
      payload: {
        similar: {
          merchant_id: 'external_seed',
          product_id: normalizeNonEmptyString(payload.product_id),
          limit: Number(payload.limit) > 0 ? Number(payload.limit) : 6,
          ...(Array.isArray(payload.exclude_items) && payload.exclude_items.length > 0
            ? { exclude_items: payload.exclude_items }
            : {}),
        },
        options: {
          ...ensureJsonObject(payload.options),
          debug: true,
          no_cache: true,
        },
      },
    };
  }
  return { operation, payload };
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
  const resolvedGatewayUrl = resolveGatewayUrl(gatewayUrl);
  const requestBody = isAuthoritativeInvokeUrl(resolvedGatewayUrl)
    ? buildAuthoritativePayload(operation, ensureJsonObject(payload))
    : { operation, payload };
  const response = await axios.post(
    resolvedGatewayUrl,
    requestBody,
    {
      timeout: Number(process.env.EXTERNAL_PDP_QUALITY_GATE_TIMEOUT_MS || 45000),
      headers: getHeaders(),
      validateStatus: () => true,
    },
  );
  return response.data || {};
}

async function probeImageUrl(url) {
  const target = normalizeUrlLike(url);
  if (!target) {
    return { url, ok: false, status: null, content_type: null, error: 'invalid_url' };
  }
  const timeout = Number(process.env.EXTERNAL_PDP_QUALITY_IMAGE_TIMEOUT_MS || 5000);
  const requestConfig = {
    timeout,
    headers: {
      Accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
      'User-Agent': 'Pivota PDP quality audit/1.0',
    },
    validateStatus: () => true,
  };

  try {
    let response = await axios.head(target, requestConfig);
    if ([403, 405].includes(Number(response.status))) {
      response = await axios.get(target, {
        ...requestConfig,
        responseType: 'arraybuffer',
        headers: {
          ...requestConfig.headers,
          Range: 'bytes=0-0',
        },
        maxContentLength: 1024 * 64,
      });
    }
    const status = Number(response.status || 0);
    const contentType = normalizeNonEmptyString(response.headers?.['content-type']).toLowerCase();
    const ok = status >= 200 && status < 400 && (!contentType || contentType.includes('image/'));
    return {
      url: target,
      ok,
      status: status || null,
      content_type: contentType || null,
      ...(ok ? {} : { error: contentType && !contentType.includes('image/') ? 'non_image_content_type' : 'bad_status' }),
    };
  } catch (error) {
    return {
      url: target,
      ok: false,
      status: null,
      content_type: null,
      error: normalizeNonEmptyString(error?.code || error?.message || 'request_failed'),
    };
  }
}

async function probeImageHealth(urls, options = {}) {
  if (options.skip) {
    return {
      scanned_count: 0,
      broken_count: 0,
      broken_urls: [],
      skipped: true,
    };
  }
  const limit = Math.max(
    1,
    Math.min(100, Number(options.limit || process.env.EXTERNAL_PDP_QUALITY_IMAGE_HEALTH_LIMIT || 12) || 12),
  );
  const uniqueUrls = Array.from(new Set((Array.isArray(urls) ? urls : []).map(normalizeUrlLike).filter(Boolean)));
  const selectedUrls = uniqueUrls.slice(0, limit);
  const results = [];
  for (const url of selectedUrls) {
    results.push(await probeImageUrl(url));
  }
  const broken = results.filter((result) => !result.ok);
  return {
    scanned_count: results.length,
    total_url_count: uniqueUrls.length,
    broken_count: broken.length,
    broken_urls: broken.slice(0, 20),
    skipped: false,
    truncated: uniqueUrls.length > selectedUrls.length,
  };
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

async function auditRow(row, { catalogBaseUrl, gatewayUrl, imageHealthEnabled = true, imageHealthLimit = null }) {
  const seedData = ensureJsonObject(row.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const variantScopedSeed =
    normalizeNonEmptyString(seedData.source_listing_scope).toLowerCase() === 'variant' ||
    Boolean(normalizeNonEmptyString(seedData.parent_external_product_id || seedData.parent_seed_id));
  const recall = resolveExternalSeedRecallDoc({ row, seedData, snapshot });
  const extractor = await fetchExtractorTruth(row, catalogBaseUrl);
  const productId =
    normalizeNonEmptyString(row.external_product_id) ||
    normalizeNonEmptyString(seedData.external_product_id) ||
    normalizeNonEmptyString(seedData.product_id);
  const [livePdp, similar] = await Promise.all([
    productId
      ? invokeGateway(gatewayUrl, 'get_pdp_v2', {
          product_id: productId,
          include: DEFAULT_PDP_QUALITY_INCLUDE,
          options: { debug: true, no_cache: true },
        })
      : Promise.resolve({ error: 'missing_product_id' }),
    productId
      ? invokeGateway(gatewayUrl, 'find_similar_products', {
          product_id: productId,
          limit: 6,
          options: { debug: true, no_cache: true },
        })
      : Promise.resolve({ error: 'missing_product_id' }),
  ]);
  const livePayload = unwrapLivePdpPayload(livePdp);
  const imageHealth = await probeImageHealth(collectLiveGalleryImages(livePayload), {
    skip: !imageHealthEnabled,
    limit: imageHealthLimit,
  });
  const audit = auditExternalSeedRow(row);
  const seedGate = buildSeedGate(audit);
  const extractorGate = buildExtractorGate({
    extractorResponse: extractor.response,
    extractorProduct: extractor.product || {},
  });
  const livePdpGate = buildLivePdpGate({
    extractorProduct: extractor.product || {},
    livePayload,
    liveResponse: ensureJsonObject(livePdp),
    expectedPrice: variantScopedSeed ? row.price_amount : null,
    imageHealth,
  });
  const identityGate = buildIdentityGate({
    livePayload,
    liveResponse: ensureJsonObject(livePdp),
  });
  const productIntelGate = buildProductIntelGate({
    livePayload,
    liveResponse: ensureJsonObject(livePdp),
  });
  const similarGate = buildSimilarGate({
    similarResponse: ensureJsonObject(similar),
    exclusionFlags: recall.exclusion_flags || {},
  });
  return buildExternalSeedQualityResult({
    seedId: row.id,
    externalProductId: productId,
    market: row.market,
    domain: row.domain,
    canonicalUrl: normalizeUrlLike(row.canonical_url || snapshot.canonical_url || extractor.target_url),
    seedGate,
    extractorGate,
    identityGate,
    productIntelGate,
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
  const imageHealthEnabled = !hasArg('skip-image-health');
  const imageHealthLimit = argValue('image-health-limit');
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
        imageHealthEnabled,
        imageHealthLimit,
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
  getHeaders,
  buildAuthoritativePayload,
  isAuthoritativeInvokeUrl,
  unwrapLivePdpPayload,
  probeImageUrl,
  probeImageHealth,
  auditRow,
};
