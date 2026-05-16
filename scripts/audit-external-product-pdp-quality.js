#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');

const { closePool, query } = require('../src/db');
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
  buildVariantGate,
  buildExternalSeedQualityResult,
  collectLiveGalleryImages,
  extractProbeError,
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
const PUBLIC_PDP_AUDIT_INCLUDE = ['product_intel', 'reviews_preview'];
const AUTHORITATIVE_PDP_CORE_AUDIT_INCLUDE = [
  'canonical',
  'product_intel',
  'reviews_preview',
  'similar',
  'variant_selector',
  'offers',
];
const AUTHORITATIVE_PDP_DETAILS_AUDIT_INCLUDE = [
  'product_details',
  'product_facts',
  'active_ingredients',
  'ingredients_inci',
  'how_to_use',
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

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeOutput(output, filePath) {
  const target = normalizeNonEmptyString(filePath);
  if (!target) {
    process.stdout.write(output);
    return;
  }
  ensureParentDir(target);
  fs.writeFileSync(target, output, 'utf8');
  process.stdout.write(output);
}

function increment(map, key, amount = 1) {
  const normalized = normalizeNonEmptyString(key) || 'unknown';
  map[normalized] = (map[normalized] || 0) + amount;
}

function topEntries(map, limit = 25) {
  return Object.entries(map || {})
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, Math.max(1, limit))
    .map(([key, count]) => ({ key, count }));
}

function parsePositiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
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
        include: Array.isArray(payload.include) && payload.include.length > 0
          ? payload.include
          : AUTHORITATIVE_PDP_CORE_AUDIT_INCLUDE,
        options: {
          ...ensureJsonObject(payload.options),
          debug: true,
          no_cache: true,
          cache_bypass: true,
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
          cache_bypass: true,
          similar_cache_bypass: true,
        },
      },
    };
  }
  return { operation, payload };
}

function buildPublicGatewayPayload(operation, payload = {}) {
  if (operation === 'get_pdp_v2') {
    return {
      operation,
      payload: {
        product_ref: {
          merchant_id: 'external_seed',
          product_id: normalizeNonEmptyString(payload.product_id),
        },
        include: Array.isArray(payload.include) && payload.include.length > 0
          ? payload.include
          : PUBLIC_PDP_AUDIT_INCLUDE,
        options: {
          ...ensureJsonObject(payload.options),
          debug: true,
          no_cache: true,
          cache_bypass: true,
          similar_cache_bypass: true,
        },
      },
      metadata: {
        scope: { catalog: 'global', region: 'US', language: 'en-US' },
        entry: 'pdp_quality_audit',
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
          cache_bypass: true,
        },
      },
      metadata: {
        scope: { catalog: 'global', region: 'US', language: 'en-US' },
        entry: 'pdp_quality_audit',
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

function buildProbeFailureResponse(error, { operation = '', probe = '' } = {}) {
  const code = normalizeNonEmptyString(error?.code);
  const message = normalizeNonEmptyString(error?.message || error);
  const timedOut = code === 'ECONNABORTED' || /timeout/i.test(message);
  return {
    status: 'error',
    error: {
      code: timedOut ? 'PROBE_TIMEOUT' : code || 'PROBE_FAILED',
      message: timedOut ? message || 'Probe timed out' : message || 'Probe failed',
      details: {
        operation,
        probe,
      },
    },
  };
}

async function invokeGateway(gatewayUrl, operation, payload, options = {}) {
  const resolvedGatewayUrl = resolveGatewayUrl(gatewayUrl);
  const requestBody = isAuthoritativeInvokeUrl(resolvedGatewayUrl)
    ? buildAuthoritativePayload(operation, ensureJsonObject(payload))
    : buildPublicGatewayPayload(operation, ensureJsonObject(payload));
  const response = await axios.post(
    resolvedGatewayUrl,
    requestBody,
    {
      timeout: parsePositiveInt(
        options.timeoutMs,
        parsePositiveInt(process.env.EXTERNAL_PDP_QUALITY_GATE_TIMEOUT_MS, 45000, 1000, 300000),
        1000,
        300000,
      ),
      headers: getHeaders(),
      validateStatus: () => true,
    },
  );
  return response.data || {};
}

async function invokeGatewayProbe(gatewayUrl, operation, payload, options = {}) {
  try {
    return await invokeGateway(gatewayUrl, operation, payload, options);
  } catch (error) {
    return buildProbeFailureResponse(error, {
      operation,
      probe: normalizeNonEmptyString(options.probe) || operation,
    });
  }
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

function mergeModuleLists(...moduleLists) {
  const byType = new Map();
  for (const modules of moduleLists) {
    for (const module of Array.isArray(modules) ? modules : []) {
      const type = normalizeNonEmptyString(module?.type);
      if (!type || byType.has(type)) continue;
      byType.set(type, module);
    }
  }
  return Array.from(byType.values());
}

function mergePdpProbeResponses(coreResponse = {}, detailsResponse = {}) {
  const core = ensureJsonObject(coreResponse);
  const details = ensureJsonObject(detailsResponse);
  const corePayload = unwrapLivePdpPayload(core);
  const detailsPayload = unwrapLivePdpPayload(details);
  const mergedPayload = {
    ...corePayload,
    ...detailsPayload,
    product: {
      ...ensureJsonObject(corePayload.product),
      ...ensureJsonObject(detailsPayload.product),
    },
    modules: mergeModuleLists(corePayload.modules, detailsPayload.modules),
  };
  const detailsProbeError = extractProbeError(details);
  return {
    ...core,
    ...details,
    ...(detailsProbeError ? { error: details.error || detailsProbeError } : {}),
    modules: mergeModuleLists(core.modules, details.modules),
    pdp_payload: mergedPayload,
  };
}

async function auditRow(row, {
  catalogBaseUrl,
  gatewayUrl,
  imageHealthEnabled = true,
  imageHealthLimit = null,
  similarEnabled = true,
  pdpTimeoutMs = null,
  detailsPdpTimeoutMs = null,
  similarTimeoutMs = null,
}) {
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
  const effectiveCorePdpTimeoutMs = parsePositiveInt(
    pdpTimeoutMs,
    parsePositiveInt(process.env.EXTERNAL_PDP_QUALITY_CORE_PDP_TIMEOUT_MS, 10000, 1000, 300000),
    1000,
    300000,
  );
  const effectiveDetailsPdpTimeoutMs = parsePositiveInt(
    detailsPdpTimeoutMs,
    parsePositiveInt(process.env.EXTERNAL_PDP_QUALITY_DETAILS_PDP_TIMEOUT_MS, 25000, 1000, 300000),
    1000,
    300000,
  );
  const effectiveSimilarTimeoutMs = parsePositiveInt(
    similarTimeoutMs,
    parsePositiveInt(process.env.EXTERNAL_PDP_QUALITY_SIMILAR_TIMEOUT_MS, 12000, 1000, 300000),
    1000,
    300000,
  );

  const [corePdp, detailsPdp, similar] = await Promise.all([
    productId
      ? invokeGatewayProbe(gatewayUrl, 'get_pdp_v2', {
          product_id: productId,
          include: AUTHORITATIVE_PDP_CORE_AUDIT_INCLUDE,
        }, {
          timeoutMs: effectiveCorePdpTimeoutMs,
          probe: 'pdp_core',
        })
      : Promise.resolve({ error: 'missing_product_id' }),
    productId
      ? invokeGatewayProbe(gatewayUrl, 'get_pdp_v2', {
          product_id: productId,
          include: AUTHORITATIVE_PDP_DETAILS_AUDIT_INCLUDE,
        }, {
          timeoutMs: effectiveDetailsPdpTimeoutMs,
          probe: 'pdp_details',
        })
      : Promise.resolve({ error: 'missing_product_id' }),
    similarEnabled && productId
      ? invokeGatewayProbe(gatewayUrl, 'find_similar_products', {
          product_id: productId,
          limit: 6,
          options: { debug: true, no_cache: true },
        }, {
          timeoutMs: effectiveSimilarTimeoutMs,
          probe: 'similar_slow',
        })
      : Promise.resolve({ skipped: true, reason: similarEnabled ? 'missing_product_id' : 'similar_probe_disabled' }),
  ]);
  const livePdp = mergePdpProbeResponses(corePdp, detailsPdp);
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
    seedData,
    expectedPrice: variantScopedSeed ? row.price_amount : null,
    imageHealth,
  });
  const identityGate = buildIdentityGate({
    livePayload: unwrapLivePdpPayload(corePdp),
    liveResponse: ensureJsonObject(corePdp),
  });
  const productIntelGate = buildProductIntelGate({
    livePayload: unwrapLivePdpPayload(corePdp),
    liveResponse: ensureJsonObject(corePdp),
  });
  const similarGate = buildSimilarGate({
    similarResponse: ensureJsonObject(similar),
    livePayload: similarEnabled ? livePayload : {},
    liveResponse: similarEnabled ? ensureJsonObject(livePdp) : {},
    exclusionFlags: recall.exclusion_flags || {},
    skippedReason: similarEnabled ? '' : 'similar_probe_disabled',
  });
  const variantGate = buildVariantGate({
    seedData,
    livePayload: unwrapLivePdpPayload(corePdp),
    liveResponse: ensureJsonObject(corePdp),
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
    variantGate,
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
  const similarEnabled = !hasArg('skip-similar') && !hasArg('fast-only');
  const pdpTimeoutMs = argValue('pdp-timeout-ms');
  const detailsPdpTimeoutMs = argValue('details-pdp-timeout-ms');
  const similarTimeoutMs = argValue('similar-timeout-ms');
  const out = argValue('out');
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
        similarEnabled,
        pdpTimeoutMs,
        detailsPdpTimeoutMs,
        similarTimeoutMs,
      }),
    );
  }

  if (format === 'json') {
    writeOutput(`${JSON.stringify(results, null, 2)}\n`, out);
    return;
  }

  const summary = {
    scanned: results.length,
    failed: results.filter((item) => item.failure_reasons.length > 0).length,
    failed_by_domain: {},
    failure_reason_counts: results.reduce((acc, item) => {
      item.failure_reasons.forEach((reason) => {
        acc[reason] = (acc[reason] || 0) + 1;
      });
      return acc;
    }, {}),
    failure_reason_domain_counts: {},
    root_cause_domain_counts: {},
    results,
  };
  results.forEach((item) => {
    const domain = normalizeNonEmptyString(item.domain) || 'unknown';
    if (item.failure_reasons.length > 0) {
      increment(summary.failed_by_domain, domain);
    }
    item.failure_reasons.forEach((reason) => {
      increment(summary.failure_reason_domain_counts, `${domain}::${reason}`);
    });
    (Array.isArray(item.root_cause_classification) ? item.root_cause_classification : []).forEach((reason) => {
      increment(summary.root_cause_domain_counts, `${domain}::${reason}`);
    });
  });
  summary.failed_by_domain = topEntries(summary.failed_by_domain, 25);
  summary.failure_reason_domain_counts = topEntries(summary.failure_reason_domain_counts, 50);
  summary.root_cause_domain_counts = topEntries(summary.root_cause_domain_counts, 50);
  writeOutput(`${JSON.stringify(summary, null, 2)}\n`, out);
}

if (require.main === module) {
  main()
    .catch((error) => {
      process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      try {
        await closePool();
      } catch {}
    });
}

module.exports = {
  fetchRows,
  fetchExtractorTruth,
  invokeGateway,
  resolveGatewayUrl,
  getHeaders,
  buildAuthoritativePayload,
  buildPublicGatewayPayload,
  buildProbeFailureResponse,
  writeOutput,
  invokeGatewayProbe,
  isAuthoritativeInvokeUrl,
  unwrapLivePdpPayload,
  mergePdpProbeResponses,
  probeImageUrl,
  probeImageHealth,
  auditRow,
};
