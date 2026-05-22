#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CASES = Object.freeze([
  { id: 'brand_fenty', group: 'brand_browse', query: 'fenty', expected_contract: { query_class: 'brand_browse', target_domain: 'beauty' }, allowed_brands: ['fenty beauty'], min_result_count: 1, require_image: true, require_valid_price: true, require_pdp_open: true },
  { id: 'brand_rare_beauty', group: 'brand_browse', query: 'rare beauty', expected_contract: { query_class: 'brand_browse', target_domain: 'beauty' }, allowed_brands: ['rare beauty'], min_result_count: 1, require_image: true, require_valid_price: true, require_pdp_open: true },
  { id: 'brand_the_ordinary', group: 'brand_browse', query: 'the ordinary', expected_contract: { query_class: 'brand_browse', target_domain: 'beauty' }, allowed_brands: ['the ordinary'], min_result_count: 1, require_image: true, require_valid_price: true, require_pdp_open: true },
  { id: 'brand_cat_fenty_lipstick', group: 'brand_category', query: 'fenty lipstick', expected_contract: { query_class: 'brand_category', target_domain: 'beauty' }, allowed_brands: ['fenty beauty'], allowed_category_prefixes: ['beauty/makeup/lip'], forbidden_terms: ['lip oil', 'lip balm', 'lip mask'], min_result_count: 1, require_image: true, require_valid_price: true, require_pdp_open: true },
  { id: 'brand_cat_rare_blush', group: 'brand_category', query: 'rare beauty blush', expected_contract: { query_class: 'brand_category', target_domain: 'beauty' }, allowed_brands: ['rare beauty'], allowed_category_prefixes: ['beauty/makeup/face/blush'], min_result_count: 1, require_image: true, require_valid_price: true, require_pdp_open: true },
  { id: 'brand_cat_ordinary_niacinamide', group: 'brand_category', query: 'the ordinary niacinamide', expected_contract: { query_class: 'brand_category', target_domain: 'beauty' }, allowed_brands: ['the ordinary'], allowed_category_prefixes: ['beauty/skincare/treat'], min_result_count: 1, require_image: true, require_valid_price: true, require_pdp_open: true },
  { id: 'cat_lipstick', group: 'category_browse', query: 'lipstick', expected_contract: { query_class: 'category_browse', target_domain: 'beauty' }, allowed_category_prefixes: ['beauty/makeup/lip'], forbidden_terms: ['lip balm', 'lip oil'], min_result_count: 1, require_image: true, require_valid_price: true, require_pdp_open: true },
  { id: 'cat_fragrance', group: 'category_browse', query: 'fragrance', expected_contract: { query_class: 'category_browse', target_domain: 'beauty' }, allowed_category_prefixes: ['beauty/fragrance'], min_result_count: 1, require_image: true, require_valid_price: true, require_pdp_open: true },
  { id: 'cat_barrier_moisturizer', group: 'category_browse', query: 'barrier moisturizer', expected_contract: { query_class: 'category_browse', target_domain: 'beauty' }, allowed_category_prefixes: ['beauty/skincare/moisturize'], min_result_count: 1, require_image: true, require_valid_price: true, require_pdp_open: true },
  { id: 'cat_waterproof_mascara', group: 'category_browse', query: 'waterproof mascara', expected_contract: { query_class: 'category_browse', target_domain: 'beauty' }, allowed_category_prefixes: ['beauty/makeup/eye'], min_result_count: 1, require_image: true, require_valid_price: true, require_pdp_open: true },
  { id: 'need_acne_oily_serum', group: 'need_solution', query: 'acne oily skin serum', expected_contract: { query_class: 'need_solution', target_domain: 'beauty' }, allowed_category_prefixes: ['beauty/skincare/treat'], forbidden_terms: ['perfume', 'body mist'], min_result_count: 1, require_image: true, require_valid_price: true, require_pdp_open: true },
  { id: 'constraint_fragrance_free_moisturizer', group: 'constraint_search', query: 'fragrance-free moisturizer', expected_contract: { query_class: 'constraint_search', target_domain: 'beauty' }, allowed_category_prefixes: ['beauty/skincare/moisturize'], forbidden_terms: ['perfume', 'eau de parfum', 'body mist'], min_result_count: 1, require_image: true, require_valid_price: true, require_pdp_open: true },
  { id: 'constraint_pregnancy_sunscreen', group: 'constraint_search', query: 'pregnancy safe sunscreen', expected_contract: { query_class: 'constraint_search', target_domain: 'beauty' }, allowed_category_prefixes: ['beauty/skincare/sun'], forbidden_terms: ['retinol', 'retinal'], min_result_count: 1, require_image: true, require_valid_price: true, require_pdp_open: true },
  { id: 'constraint_rosacea_cleanser', group: 'constraint_search', query: 'rosacea cleanser', expected_contract: { query_class: 'constraint_search', target_domain: 'beauty' }, allowed_category_prefixes: ['beauty/skincare/cleanse'], forbidden_terms: ['perfume', 'body mist'], min_result_count: 1, require_image: true, require_valid_price: true, require_pdp_open: true },
  { id: 'nonbeauty_zara', group: 'non_beauty_guard', query: 'zara', expected_contract: { query_class: 'ambiguous_or_non_shopping', target_domain: 'other' }, min_result_count: 0 },
  { id: 'nonbeauty_nike', group: 'non_beauty_guard', query: 'nike shoes', expected_contract: { query_class: 'ambiguous_or_non_shopping', target_domain: 'other' }, min_result_count: 0 },
  { id: 'nonbeauty_earbuds', group: 'non_beauty_guard', query: 'wireless earbuds', expected_contract: { query_class: 'ambiguous_or_non_shopping', target_domain: 'other' }, min_result_count: 0 },
]);

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

function normalizeText(value) {
  return asString(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstString(...values) {
  for (const value of values) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      const nested = firstString(...value);
      if (nested) return nested;
      continue;
    }
    if (typeof value === 'object') continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

function loadCases(filePath) {
  const target = asString(filePath);
  if (!target) return DEFAULT_CASES.map((item) => ({ ...item }));
  const raw = fs.readFileSync(target, 'utf8');
  if (target.endsWith('.jsonl')) {
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : parsed.cases || [];
}

function joinUrl(baseUrl, route) {
  return `${String(baseUrl || '').replace(/\/+$/, '')}${String(route || '').startsWith('/') ? route : `/${route}`}`;
}

function authHeaders(apiKey = '') {
  const key = asString(
    apiKey ||
      process.env.AGENT_API_KEY ||
      process.env.PIVOTA_AGENT_API_KEY ||
      process.env.PIVOTA_BACKEND_AGENT_API_KEY ||
      process.env.PIVOTA_API_KEY,
  );
  if (!key) return {};
  return {
    'X-Agent-API-Key': key,
    'X-API-Key': key,
    Authorization: `Bearer ${key}`,
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson({ url, payload, headers = {}, timeoutMs = 30000, attempts = 2 }) {
  const startedAt = Date.now();
  let lastError = null;
  const maxAttempts = Math.max(1, Number(attempts) || 1);
  let response = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      response = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(payload),
        },
        timeoutMs,
      );
      break;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) await sleep(250 * attempt);
    }
  }
  if (!response) {
    return {
      status: 0,
      ok: false,
      body: {
        status: 'error',
        error: {
          code: lastError?.code || lastError?.name || 'REQUEST_FAILED',
          message: String(lastError?.message || lastError || 'request failed'),
        },
      },
      latency_ms: Math.max(0, Date.now() - startedAt),
    };
  }
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { parse_error: true, text };
  }
  return {
    status: response.status,
    ok: response.status >= 200 && response.status < 300,
    body,
    latency_ms: Math.max(0, Date.now() - startedAt),
  };
}

function buildFindProductsPayload(testCase, { limit = 6, market = 'US' } = {}) {
  return {
    operation: 'find_products_multi',
    payload: {
      search: {
        query: testCase.query,
        limit,
        market,
        in_stock_only: true,
        ui_surface: 'search_quality_eval_v1',
      },
    },
    metadata: {
      source: 'search_quality_eval_v1',
      test_suite: 'search_quality_contract_v1',
      case_id: testCase.id || testCase.query,
    },
  };
}

function extractResponseEnvelope(body) {
  if (!body || typeof body !== 'object') return {};
  if (Array.isArray(body.products) || body.metadata) return body;
  if (body.response && typeof body.response === 'object') return body.response;
  if (body.data && typeof body.data === 'object') return body.data;
  if (body.result && typeof body.result === 'object') return body.result;
  return body;
}

function extractProducts(body) {
  const envelope = extractResponseEnvelope(body);
  return Array.isArray(envelope.products) ? envelope.products : [];
}

function extractMetadata(body) {
  const envelope = extractResponseEnvelope(body);
  return envelope.metadata && typeof envelope.metadata === 'object' ? envelope.metadata : {};
}

function productText(product = {}) {
  return normalizeText([
    product.title,
    product.name,
    product.product_name,
    product.display_name,
    product.brand,
    product.vendor,
    product.merchant_name,
    product.category,
    product.product_type,
    product.catalog_category_path,
    Array.isArray(product.category_path) ? product.category_path.join(' ') : product.category_path,
    product.destination_url,
    product.merchant_canonical_url,
  ].filter(Boolean).join(' '));
}

function productCategoryPath(product = {}) {
  return normalizeText(firstString(
    product.catalog_category_path,
    Array.isArray(product.category_path) ? product.category_path.join('/') : product.category_path,
    product.categoryPath,
  )).replace(/\s+/g, '/');
}

function productBrand(product = {}) {
  return normalizeText(firstString(product.brand, product.vendor, product.merchant_name));
}

function productImage(product = {}) {
  return firstString(product.image_url, product.imageUrl, product.thumbnail_url, product.images, product.image_urls);
}

function productPriceAmount(product = {}) {
  for (const value of [
    product.price_amount,
    product.priceAmount,
    product.current_price,
    product.price,
    product.price?.amount,
    product.price?.value,
    product.price?.current?.amount,
    product.best_deal?.price,
  ]) {
    const amount = Number(value);
    if (Number.isFinite(amount)) return amount;
  }
  return null;
}

function hasValidPriceState(product = {}) {
  const amount = productPriceAmount(product);
  if (amount != null) return amount > 0 || product.price_is_free === true || product.is_free === true || product.free_sample === true;
  return Boolean(product.price_unknown === true || product.price?.unknown === true || /unknown|unavailable/i.test(firstString(product.price_label, product.priceLabel)));
}

function hasPdpOpen(product = {}) {
  return Boolean(
    product.pdp_open?.product_ref?.product_id ||
      product.pdp_open?.canonical_product_ref?.product_id ||
      product.canonical_product_ref?.product_id
  );
}

function isPollutedProduct(product = {}) {
  const text = productText(product);
  const category = normalizeText(firstString(product.category, product.product_type));
  return Boolean(
    product.transaction_ready === false ||
      product.source_unavailable_v1 ||
      product.transaction_readiness_blocker_v1 ||
      ['external', 'unknown', 'uncategorized', 'misc'].includes(category) ||
      /\b(shipping|delivery|route|package)\s+protection\b|\border\s+protection\b|\bprivacy\s+policy\b|\breturns?\s+policy\b/.test(text)
  );
}

function evaluateSearchResponse(testCase, responseBody, { limit = 6, pdpProbeResults = {} } = {}) {
  const products = extractProducts(responseBody).slice(0, limit);
  const metadata = extractMetadata(responseBody);
  const violations = [];
  const allowedBrands = (testCase.allowed_brands || []).map(normalizeText).filter(Boolean);
  const allowedCategoryPrefixes = (testCase.allowed_category_prefixes || []).map((item) => normalizeText(item).replace(/\s+/g, '/')).filter(Boolean);
  const forbiddenTerms = (testCase.forbidden_terms || []).map(normalizeText).filter(Boolean);
  const expectedContract = testCase.expected_contract || {};

  const contract = metadata.search_quality_contract || {};
  if (expectedContract.query_class && contract.query_class !== expectedContract.query_class) {
    violations.push({
      type: 'contract_query_class_mismatch',
      expected: expectedContract.query_class,
      actual: contract.query_class || null,
    });
  }
  if (expectedContract.target_domain && contract.target_domain !== expectedContract.target_domain) {
    violations.push({
      type: 'contract_target_domain_mismatch',
      expected: expectedContract.target_domain,
      actual: contract.target_domain || null,
    });
  }

  const missingImage = [];
  const invalidPrice = [];
  const missingPdp = [];
  const polluted = [];
  const pdpOpenFailures = [];

  products.forEach((product, index) => {
    const text = productText(product);
    if (allowedBrands.length && !allowedBrands.some((brand) => productBrand(product).includes(brand) || text.includes(brand))) {
      violations.push({ type: 'brand_mismatch', index, title: firstString(product.title, product.name), brand: productBrand(product) });
    }
    if (allowedCategoryPrefixes.length) {
      const pathText = productCategoryPath(product);
      if (!allowedCategoryPrefixes.some((prefix) => pathText === prefix || pathText.startsWith(`${prefix}/`) || text.includes(prefix.replace(/\//g, ' ')))) {
        violations.push({ type: 'category_mismatch', index, title: firstString(product.title, product.name), category_path: pathText });
      }
    }
    for (const term of forbiddenTerms) {
      if (term && text.includes(term)) {
        violations.push({ type: 'forbidden_term', index, term, title: firstString(product.title, product.name) });
      }
    }
    if (testCase.require_image !== false && !productImage(product)) missingImage.push(index);
    if (testCase.require_valid_price !== false && !hasValidPriceState(product)) invalidPrice.push(index);
    if (testCase.require_pdp_open !== false && !hasPdpOpen(product)) missingPdp.push(index);
    if (isPollutedProduct(product)) polluted.push(index);
    const pdpKey = firstString(product.pdp_open?.product_ref?.product_id, product.canonical_product_ref?.product_id);
    if (pdpKey && pdpProbeResults[pdpKey] && pdpProbeResults[pdpKey].ok === false) {
      pdpOpenFailures.push({ index, product_id: pdpKey, status: pdpProbeResults[pdpKey].status || null });
    }
  });

  const minResultCount = Number(testCase.min_result_count || 0);
  if (products.length < minResultCount) {
    violations.push({ type: 'underfill', expected_min: minResultCount, actual: products.length });
  }

  return {
    case_id: testCase.id || testCase.query,
    group: testCase.group || null,
    query: testCase.query,
    passed:
      violations.length === 0 &&
      missingImage.length === 0 &&
      invalidPrice.length === 0 &&
      missingPdp.length === 0 &&
      polluted.length === 0 &&
      pdpOpenFailures.length === 0,
    metrics: {
      returned_count: products.length,
      hard_constraint_violation_count: violations.filter((item) => item.type !== 'underfill').length,
      missing_image_count: missingImage.length,
      invalid_price_count: invalidPrice.length,
      missing_or_open_failed_pdp_count: missingPdp.length + pdpOpenFailures.length,
      polluted_row_count: polluted.length,
      canonical_candidate_count: Number(metadata.canonical_product_count || metadata.source_breakdown?.canonical_chain_candidate_count || 0) || 0,
      canonical_returned_count: Number(metadata.canonical_returned_count || metadata.source_breakdown?.canonical_chain_count || 0) || 0,
      underfill_count: products.length < minResultCount ? 1 : 0,
      latency_ms: Number(metadata.latency_ms || 0) || null,
    },
    top6_hard_constraint_violations: violations.slice(0, 6),
    missing_image_indexes: missingImage,
    invalid_price_indexes: invalidPrice,
    missing_pdp_indexes: missingPdp,
    pdp_open_failures: pdpOpenFailures,
    polluted_indexes: polluted,
    metadata: {
      search_quality_contract: metadata.search_quality_contract || null,
      search_quality_contract_applied: metadata.search_quality_contract_applied ?? null,
      search_quality_failure_reasons: metadata.search_quality_failure_reasons || null,
      search_quality_tier_counts: metadata.search_quality_tier_counts || null,
    },
  };
}

async function probePdpRefs(products, { baseUrl, headers, timeoutMs }) {
  const refs = new Map();
  for (const product of products) {
    const ref = product.pdp_open?.product_ref || product.pdp_open?.canonical_product_ref || product.canonical_product_ref;
    const productId = firstString(ref?.product_id);
    const merchantId = firstString(ref?.merchant_id, product.merchant_id);
    if (!productId || !merchantId || refs.has(productId)) continue;
    refs.set(productId, { merchant_id: merchantId, product_id: productId });
  }
  const out = {};
  for (const [productId, ref] of refs) {
    const response = await requestJson({
      url: joinUrl(baseUrl, '/agent/shop/v1/invoke'),
      headers,
      timeoutMs,
      payload: {
        operation: 'get_pdp_v2',
        payload: {
          product_ref: ref,
          options: { no_cache: true, cache_bypass: true },
        },
        metadata: { source: 'search_quality_eval_v1', probe: 'pdp_open' },
      },
    });
    out[productId] = {
      ok: response.ok && response.body?.status !== 'error',
      status: response.status,
      latency_ms: response.latency_ms,
    };
  }
  return out;
}

async function runEval({ cases, baseUrl, apiKey = '', limit = 6, market = 'US', timeoutMs = 30000, pdpProbe = false } = {}) {
  const headers = {
    'X-Aurora-UID': `search-quality-eval-${Date.now()}`,
    ...authHeaders(apiKey),
  };
  const results = [];
  for (const testCase of cases) {
    const response = await requestJson({
      url: joinUrl(baseUrl, '/agent/shop/v1/invoke'),
      headers,
      timeoutMs,
      payload: buildFindProductsPayload(testCase, { limit, market }),
    });
    const products = extractProducts(response.body);
    const pdpProbeResults = pdpProbe
      ? await probePdpRefs(products.slice(0, limit), { baseUrl, headers, timeoutMs })
      : {};
    const evaluation = evaluateSearchResponse(testCase, response.body, { limit, pdpProbeResults });
    evaluation.http_status = response.status;
    evaluation.http_ok = response.ok;
    evaluation.metrics.latency_ms = response.latency_ms;
    results.push(evaluation);
  }
  const summary = summarizeResults(results);
  return {
    generated_at: new Date().toISOString(),
    base_url: baseUrl,
    limit,
    market,
    summary,
    results,
  };
}

function summarizeResults(results = []) {
  const summary = {
    cases: results.length,
    passed: results.filter((row) => row.passed).length,
    failed: results.filter((row) => !row.passed).length,
    hard_constraint_violations: 0,
    missing_image_count: 0,
    invalid_price_count: 0,
    missing_or_open_failed_pdp_count: 0,
    polluted_row_count: 0,
    underfill_count: 0,
    canonical_candidate_count: 0,
    canonical_returned_count: 0,
    p95_latency_ms: null,
  };
  const latencies = [];
  for (const row of results) {
    summary.hard_constraint_violations += Number(row.metrics.hard_constraint_violation_count || 0);
    summary.missing_image_count += Number(row.metrics.missing_image_count || 0);
    summary.invalid_price_count += Number(row.metrics.invalid_price_count || 0);
    summary.missing_or_open_failed_pdp_count += Number(row.metrics.missing_or_open_failed_pdp_count || 0);
    summary.polluted_row_count += Number(row.metrics.polluted_row_count || 0);
    summary.underfill_count += Number(row.metrics.underfill_count || 0);
    summary.canonical_candidate_count += Number(row.metrics.canonical_candidate_count || 0);
    summary.canonical_returned_count += Number(row.metrics.canonical_returned_count || 0);
    if (Number.isFinite(Number(row.metrics.latency_ms))) latencies.push(Number(row.metrics.latency_ms));
  }
  latencies.sort((a, b) => a - b);
  if (latencies.length) summary.p95_latency_ms = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))];
  return summary;
}

function renderMarkdownReport(report) {
  const lines = [
    '# Search Quality Eval',
    '',
    `Generated: ${report.generated_at}`,
    `Base URL: ${report.base_url}`,
    '',
    '## Summary',
    '',
  ];
  for (const [key, value] of Object.entries(report.summary)) {
    lines.push(`- ${key}: ${value}`);
  }
  lines.push('', '## Cases', '');
  for (const row of report.results) {
    lines.push(`- ${row.passed ? 'PASS' : 'FAIL'} ${row.case_id}: ${row.query}`);
    const violations = row.top6_hard_constraint_violations || [];
    if (violations.length) lines.push(`  - violations: ${violations.map((item) => item.type).join(', ')}`);
    const m = row.metrics || {};
    lines.push(`  - returned=${m.returned_count} missing_image=${m.missing_image_count} invalid_price=${m.invalid_price_count} pdp=${m.missing_or_open_failed_pdp_count} polluted=${m.polluted_row_count} latency_ms=${m.latency_ms}`);
  }
  return `${lines.join('\n')}\n`;
}

function writeOutputs(report, { outJson = '', outMd = '' } = {}) {
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (outJson) {
    fs.mkdirSync(path.dirname(outJson), { recursive: true });
    fs.writeFileSync(outJson, json, 'utf8');
  }
  if (outMd) {
    fs.mkdirSync(path.dirname(outMd), { recursive: true });
    fs.writeFileSync(outMd, renderMarkdownReport(report), 'utf8');
  }
  process.stdout.write(json);
}

async function main() {
  const cases = loadCases(argValue('cases'));
  const baseUrl = asString(argValue('backend') || argValue('base-url') || process.env.BASE || process.env.PIVOTA_BACKEND_URL || 'http://localhost:3000');
  const limit = Math.max(1, Math.min(Number(argValue('limit') || 6), 24));
  const market = asString(argValue('market', 'US')).toUpperCase() || 'US';
  const timeoutMs = Math.max(1000, Number(argValue('timeout-ms') || 30000));
  const report = await runEval({
    cases,
    baseUrl,
    apiKey: argValue('api-key'),
    limit,
    market,
    timeoutMs,
    pdpProbe: hasFlag('pdp-probe'),
  });
  writeOutputs(report, {
    outJson: argValue('out-json') || '',
    outMd: argValue('out-md') || '',
  });
  if (hasFlag('fail-on-regression') && report.summary.failed > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_CASES,
  buildFindProductsPayload,
  evaluateSearchResponse,
  extractProducts,
  loadCases,
  requestJson,
  renderMarkdownReport,
  runEval,
  summarizeResults,
};
