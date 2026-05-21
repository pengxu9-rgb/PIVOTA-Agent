#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');

const { closePool, query } = require('../src/db');
const { auditExternalSeedRow } = require('../src/services/externalSeedContentAudit');
const { ensureJsonObject } = require('../src/services/externalSeedProducts');
const { classifyExternalSeedProductKind } = require('../src/services/externalSeedProductKind');
const { resolveExternalSeedRecallDoc } = require('../src/services/externalSeedRecall');
const {
  buildSeedGate,
  buildSourceUnavailableExtractorGate,
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

async function fetchRows({
  market,
  seedId,
  externalProductId,
  domain,
  brand,
  limit,
  offset,
  includeAttached = false,
  includeAllTools = false,
}) {
  const focusedLookup = Boolean(seedId || externalProductId);
  const where = focusedLookup
    ? [
        `status = 'active'`,
        `market = $1`,
      ]
    : [
        `status = 'active'`,
        `market = $1`,
      ];
  if (!focusedLookup && !includeAttached) where.splice(1, 0, `attached_product_key IS NULL`);
  if (!focusedLookup && !includeAllTools) where.push(`(tool = '*' OR tool = 'creator_agents')`);
  const params = [market];
  const bind = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (seedId) where.push(`id::text = ${bind(seedId)}`);
  if (externalProductId) where.push(`external_product_id = ${bind(externalProductId)}`);
  if (!focusedLookup && domain) where.push(`domain = ${bind(domain)}`);
  if (!focusedLookup && brand) where.push(`lower(coalesce(seed_data->>'brand', seed_data->'snapshot'->>'brand', '')) = lower(${bind(brand)})`);

  params.push(limit);
  const limitBind = `$${params.length}`;
  params.push(offset);
  const offsetBind = `$${params.length}`;

  const orderSql = seedId || externalProductId
    ? ''
    : 'ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST';
  const res = await query(
    `
      SELECT
        id,
        external_product_id,
        market,
        domain,
        tool,
        attached_product_key,
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
      ${orderSql}
      LIMIT ${limitBind}
      OFFSET ${offsetBind}
    `,
    params,
  );
  const rows = res.rows || [];
  if (!focusedLookup) return rows;
  const expectedDomain = normalizeNonEmptyString(domain);
  const expectedBrand = normalizeNonEmptyString(brand).toLowerCase();
  return rows.filter((row) => {
    if (!includeAttached && row.attached_product_key != null) return false;
    if (!includeAllTools && !['*', 'creator_agents'].includes(normalizeNonEmptyString(row.tool))) return false;
    if (expectedDomain && normalizeNonEmptyString(row.domain) !== expectedDomain) return false;
    if (expectedBrand) {
      const seedData = ensureJsonObject(row.seed_data);
      const snapshot = ensureJsonObject(seedData.snapshot);
      const rowBrand = normalizeNonEmptyString(seedData.brand || snapshot.brand).toLowerCase();
      if (rowBrand !== expectedBrand) return false;
    }
    return true;
  });
}

async function fetchExtractorTruth(row, baseUrl, options = {}) {
  const targetUrl = pickSeedTargetUrl(row);
  if (!targetUrl) {
    return {
      target_url: '',
      response: { diagnostics: { failure_category: 'missing_target_url' } },
      product: null,
    };
  }
  const maxAttempts = resolveExtractorProbeMaxAttempts(options);
  const retryErrors = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let result;
    try {
      const response = await axios.post(
        `${baseUrl.replace(/\/$/, '')}/api/extract`,
        buildExtractRequestBody(targetUrl, row, { normalizeDuplicateHandle: false }),
        {
          timeout: parsePositiveInt(
            options.timeoutMs,
            Number(process.env.CATALOG_INTELLIGENCE_TIMEOUT_MS || 90000),
            1000,
            300000,
          ),
          headers: { 'Content-Type': 'application/json' },
        },
      );
      const data = response.data || {};
      result = {
        target_url: targetUrl,
        response: data,
        product: Array.isArray(data.products) && data.products.length > 0 ? data.products[0] : null,
      };
    } catch (error) {
      result = buildExtractorProbeFailure(error, targetUrl);
    }
    if (!isTransientExtractorProbeResult(result) || attempt >= maxAttempts) {
      if (retryErrors.length > 0) {
        return {
          ...result,
          response: {
            ...ensureJsonObject(result.response),
            diagnostics: {
              ...ensureJsonObject(result.response?.diagnostics),
              retry_attempts: attempt,
              retry_errors: retryErrors,
            },
          },
        };
      }
      return result;
    }
    const diagnostics = ensureJsonObject(result.response?.diagnostics);
    retryErrors.push({
      attempt,
      failure_category: normalizeNonEmptyString(diagnostics.failure_category) || null,
      error_code: normalizeNonEmptyString(diagnostics.error_code) || null,
      error_message: normalizeNonEmptyString(diagnostics.error_message) || null,
    });
    await sleep(Math.min(2500, 300 * attempt));
  }
  return buildExtractorProbeFailure(new Error('Extractor retry loop exhausted'), targetUrl);
}

function buildExtractorProbeFailure(error, targetUrl = '') {
  const code = normalizeNonEmptyString(error?.code);
  const message = normalizeNonEmptyString(error?.message || error);
  const status = Number(error?.response?.status || 0) || null;
  const timedOut = code === 'ECONNABORTED' || /timeout/i.test(message);
  const dnsFailed = code === 'ENOTFOUND' || /getaddrinfo\s+ENOTFOUND/i.test(message);
  const failureCategory = timedOut
    ? 'extractor_probe_timeout'
    : dnsFailed
      ? 'extractor_probe_dns_failure'
      : status
        ? `extractor_probe_http_${status}`
        : 'extractor_probe_failed';
  return {
    target_url: normalizeUrlLike(targetUrl),
    response: {
      diagnostics: {
        failure_category: failureCategory,
        probe: 'catalog_intelligence_extract',
        error_code: code || null,
        error_message: message || null,
        http_status: status,
      },
    },
    product: null,
  };
}

function isTransientExtractorProbeResult(result = {}) {
  const diagnostics = ensureJsonObject(result?.response?.diagnostics);
  const category = normalizeNonEmptyString(diagnostics.failure_category);
  const code = normalizeNonEmptyString(diagnostics.error_code).toUpperCase();
  const message = normalizeNonEmptyString(diagnostics.error_message);
  if (!category) return false;
  if (/source_unavailable|captcha|login|paywall|bot|blocked|http_4\d\d/i.test(category)) return false;
  if (['extractor_probe_timeout', 'extractor_probe_dns_failure', 'extractor_probe_failed'].includes(category)) {
    return true;
  }
  return ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ENOTFOUND'].includes(code) ||
    /timeout|temporarily unavailable|socket hang up|connection (?:reset|aborted)|network/i.test(message);
}

function resolveExtractorProbeMaxAttempts(options = {}) {
  const requested = Number(options.maxAttempts || process.env.EXTERNAL_PDP_QUALITY_EXTRACTOR_MAX_ATTEMPTS || 2);
  if (!Number.isFinite(requested) || requested <= 1) return 1;
  return Math.max(1, Math.min(4, Math.floor(requested)));
}

function buildProbeFailureResponse(error, { operation = '', probe = '' } = {}) {
  const code = normalizeNonEmptyString(error?.code);
  const message = normalizeNonEmptyString(error?.message || error);
  const timedOut = code === 'ECONNABORTED' || /timeout/i.test(message);
  const aborted = /stream has been aborted|socket hang up|connection (?:reset|aborted)/i.test(message);
  return {
    status: 'error',
    error: {
      code: timedOut ? 'PROBE_TIMEOUT' : aborted ? 'PROBE_ABORTED' : code || 'PROBE_FAILED',
      message: timedOut ? message || 'Probe timed out' : message || 'Probe failed',
      details: {
        operation,
        probe,
      },
    },
  };
}

function isTransientProbeFailureResponse(response = {}) {
  const error = ensureJsonObject(response?.error);
  const code = normalizeNonEmptyString(error.code || response?.code).toUpperCase();
  const message = normalizeNonEmptyString(error.message || response?.message || response?.detail || response?.error);
  if (['PROBE_TIMEOUT', 'PROBE_ABORTED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(code)) {
    return true;
  }
  return /stream has been aborted|socket hang up|timeout|connection (?:reset|aborted)|temporarily unavailable/i.test(message);
}

function resolveProbeMaxAttempts(options = {}) {
  const requested = Number(options.maxAttempts || process.env.EXTERNAL_PDP_QUALITY_PROBE_MAX_ATTEMPTS || 1);
  if (!Number.isFinite(requested) || requested <= 1) return 1;
  return Math.max(1, Math.min(4, Math.floor(requested)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const maxAttempts = resolveProbeMaxAttempts(options);
  const retryErrors = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      response = await invokeGateway(gatewayUrl, operation, payload, options);
    } catch (error) {
      response = buildProbeFailureResponse(error, {
        operation,
        probe: normalizeNonEmptyString(options.probe) || operation,
      });
    }
    if (!isTransientProbeFailureResponse(response) || attempt >= maxAttempts) {
      if (retryErrors.length > 0) {
        const error = ensureJsonObject(response?.error);
        return {
          ...response,
          error: {
            ...error,
            details: {
              ...ensureJsonObject(error.details),
              retry_attempts: attempt,
              retry_errors: retryErrors,
            },
          },
        };
      }
      return response;
    }
    retryErrors.push({
      attempt,
      code: normalizeNonEmptyString(response?.error?.code || response?.code) || null,
      message: normalizeNonEmptyString(response?.error?.message || response?.message || response?.error) || null,
    });
    await sleep(Math.min(2500, 250 * attempt));
  }
  return buildProbeFailureResponse(new Error('Probe retry loop exhausted'), { operation, probe: options.probe });
}

function isTransientImageProbeResult(result = {}) {
  const error = normalizeNonEmptyString(result.error).toUpperCase();
  return ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(error) ||
    /timeout|temporarily unavailable|socket hang up|connection (?:reset|aborted)/i.test(normalizeNonEmptyString(result.error));
}

function resolveImageProbeMaxAttempts(options = {}) {
  const requested = Number(options.maxAttempts || process.env.EXTERNAL_PDP_QUALITY_IMAGE_MAX_ATTEMPTS || 2);
  if (!Number.isFinite(requested) || requested <= 1) return 1;
  return Math.max(1, Math.min(4, Math.floor(requested)));
}

async function probeImageUrlOnce(url) {
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

async function probeImageUrl(url, options = {}) {
  const maxAttempts = resolveImageProbeMaxAttempts(options);
  const retryErrors = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await probeImageUrlOnce(url);
    if (!isTransientImageProbeResult(result) || attempt >= maxAttempts) {
      if (retryErrors.length > 0 && !result.ok) {
        return {
          ...result,
          retry_attempts: attempt,
          retry_errors: retryErrors,
        };
      }
      return result;
    }
    retryErrors.push({
      attempt,
      error: normalizeNonEmptyString(result.error) || null,
    });
    await sleep(Math.min(1500, 200 * attempt));
  }
  return { url, ok: false, status: null, content_type: null, error: 'image_probe_retry_loop_exhausted' };
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
    results.push(await probeImageUrl(url, { maxAttempts: options.maxAttempts }));
  }
  const transientErrors = results.filter((result) => !result.ok && isTransientImageProbeResult(result));
  const broken = results.filter((result) => !result.ok && !isTransientImageProbeResult(result));
  return {
    scanned_count: results.length,
    total_url_count: uniqueUrls.length,
    broken_count: broken.length,
    broken_urls: broken.slice(0, 20),
    transient_error_count: transientErrors.length,
    transient_error_urls: transientErrors.slice(0, 20),
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

function resolveExpectedLivePdpPrice(row = {}) {
  const amount = Number(row?.price_amount);
  return Number.isFinite(amount) && amount > 0 ? row.price_amount : null;
}

function hasTerminalHoldMarker(seedData = {}, snapshot = {}) {
  return [
    seedData.transaction_readiness_blocker_v1,
    snapshot.transaction_readiness_blocker_v1,
    seedData.non_merch_terminal_hold_v1,
    snapshot.non_merch_terminal_hold_v1,
    seedData.source_unavailable_v1,
    snapshot.source_unavailable_v1,
  ]
    .map(ensureJsonObject)
    .some((contract) =>
      Boolean(normalizeNonEmptyString(contract.status || contract.reason || contract.contract_version)),
    );
}

async function auditRow(row, {
  catalogBaseUrl,
  gatewayUrl,
  imageHealthEnabled = true,
  imageHealthLimit = null,
  similarEnabled = true,
  catalogTimeoutMs = null,
  pdpTimeoutMs = null,
  detailsPdpTimeoutMs = null,
  similarTimeoutMs = null,
}) {
  const seedData = ensureJsonObject(row.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const recall = resolveExternalSeedRecallDoc({ row, seedData, snapshot });
  const extractor = await fetchExtractorTruth(row, catalogBaseUrl, { timeoutMs: catalogTimeoutMs });
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
          maxAttempts: 3,
        })
      : Promise.resolve({ error: 'missing_product_id' }),
    productId
      ? invokeGatewayProbe(gatewayUrl, 'get_pdp_v2', {
          product_id: productId,
          include: AUTHORITATIVE_PDP_DETAILS_AUDIT_INCLUDE,
        }, {
          timeoutMs: effectiveDetailsPdpTimeoutMs,
          probe: 'pdp_details',
          maxAttempts: 3,
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
          maxAttempts: 2,
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
  const productKind = classifyExternalSeedProductKind(row);
  const seedGate = buildSeedGate(audit);
  const extractorGate = buildSourceUnavailableExtractorGate({
    extractorResponse: extractor.response,
    extractorProduct: extractor.product || {},
    seedData,
  });
  const terminalHold = hasTerminalHoldMarker(seedData, snapshot);
  const livePdpGate = buildLivePdpGate({
    extractorProduct: extractor.product || {},
    livePayload,
    liveResponse: ensureJsonObject(livePdp),
    seedData,
    productFamily: productKind.family,
    expectedPrice: resolveExpectedLivePdpPrice(row),
    imageHealth,
  });
  const identityGate = buildIdentityGate({
    livePayload: unwrapLivePdpPayload(corePdp),
    liveResponse: ensureJsonObject(corePdp),
    productFamily: productKind.family,
    terminalHold,
  });
  const productIntelGate = buildProductIntelGate({
    livePayload: unwrapLivePdpPayload(corePdp),
    liveResponse: ensureJsonObject(corePdp),
    productFamily: productKind.family,
    terminalHold,
  });
  const similarGate = buildSimilarGate({
    similarResponse: ensureJsonObject(similar),
    livePayload: similarEnabled ? livePayload : {},
    liveResponse: similarEnabled ? ensureJsonObject(livePdp) : {},
    exclusionFlags: recall.exclusion_flags || {},
    productFamily: productKind.family,
    sourceUnavailable: extractorGate?.source_unavailable === true,
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
  const catalogTimeoutMs = argValue('catalog-timeout-ms');
  const out = argValue('out');
  const progressEvery = parsePositiveInt(argValue('progress-every'), 10, 1, 1000);
  const rows = await fetchRows({
    market,
    seedId: argValue('seed-id'),
    externalProductId: argValue('external-product-id'),
    domain: argValue('domain'),
    brand: argValue('brand'),
    limit,
    offset,
    includeAttached: hasArg('include-attached') || hasArg('includeAttached'),
    includeAllTools: hasArg('include-all-tools') || hasArg('includeAllTools'),
  });

  const results = [];
  for (let idx = 0; idx < rows.length; idx += 1) {
    const row = rows[idx];
    try {
      results.push(
        await auditRow(row, {
          catalogBaseUrl: DEFAULT_CATALOG_BASE_URL,
          gatewayUrl,
          imageHealthEnabled,
          imageHealthLimit,
          similarEnabled,
          catalogTimeoutMs,
          pdpTimeoutMs,
          detailsPdpTimeoutMs,
          similarTimeoutMs,
        }),
      );
    } catch (error) {
      const seedData = ensureJsonObject(row.seed_data);
      const snapshot = ensureJsonObject(seedData.snapshot);
      results.push({
        seed_id: normalizeNonEmptyString(row.id),
        external_product_id: normalizeNonEmptyString(row.external_product_id),
        market: normalizeNonEmptyString(row.market),
        domain: normalizeNonEmptyString(row.domain),
        canonical_url: normalizeUrlLike(row.canonical_url || snapshot.canonical_url || row.destination_url),
        seed_gate: { status: 'unknown', findings_count: null, blockers_count: null },
        extractor_gate: { status: 'unknown', failure_reasons: [] },
        identity_gate: { status: 'unknown', failure_reasons: [] },
        product_intel_gate: { status: 'unknown', failure_reasons: [] },
        live_pdp_gate: {
          status: 'failed',
          probe_error: {
            code: normalizeNonEmptyString(error?.code) || 'AUDIT_ROW_FAILED',
            message: normalizeNonEmptyString(error?.message || error),
          },
          failure_reasons: ['audit_row_failed'],
        },
        similar_gate: { status: 'unknown', failure_reasons: [] },
        variant_gate: { status: 'unknown', failure_reasons: [] },
        root_cause_classification: ['audit_infra_issue'],
        failure_reasons: ['audit_row_failed'],
      });
    } finally {
      if ((idx + 1) % progressEvery === 0 || idx + 1 === rows.length) {
        process.stderr.write(`external seed PDP quality audit: ${idx + 1}/${rows.length} rows checked\n`);
      }
    }
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
  buildExtractorProbeFailure,
  invokeGateway,
  resolveGatewayUrl,
  getHeaders,
  buildAuthoritativePayload,
  buildPublicGatewayPayload,
  buildProbeFailureResponse,
  isTransientProbeFailureResponse,
  resolveProbeMaxAttempts,
  isTransientExtractorProbeResult,
  resolveExtractorProbeMaxAttempts,
  isTransientImageProbeResult,
  resolveImageProbeMaxAttempts,
  writeOutput,
  invokeGatewayProbe,
  isAuthoritativeInvokeUrl,
  unwrapLivePdpPayload,
  mergePdpProbeResponses,
  resolveExpectedLivePdpPrice,
  probeImageUrl,
  probeImageHealth,
  auditRow,
};
