#!/usr/bin/env node

const axios = require('axios');

const { query } = require('../src/db');
const { ensureJsonObject } = require('../src/services/externalSeedProducts');
const { auditExternalSeedRow } = require('../src/services/externalSeedContentAudit');
const {
  classifySeedStructuredIngredientStatus,
  classifySeedPdpFieldCoverageStatus,
  buildIngredientSourceQualityStatus,
} = require('../src/services/externalSeedIngredientEnrichment');
const {
  pickSeedTargetUrl,
  buildExtractRequestBody,
} = require('./backfill-external-product-seeds-catalog');

const DEFAULT_CATALOG_BASE_URL =
  process.env.CATALOG_INTELLIGENCE_BASE_URL ||
  'https://pivota-catalog-intelligence-production.up.railway.app';
const PRIORITY_DOMAINS = [
  'fentybeauty.com',
  'pixibeauty.com',
  'rarebeauty.com',
  'patyka.com',
  'www.tomfordbeauty.com',
];

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
  const next = normalizeNonEmptyString(value);
  return /^https?:\/\//i.test(next) ? next : '';
}

function normalizeDetailsSections(value, maxItems = 24) {
  const items = Array.isArray(value) ? value : [];
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const heading = normalizeNonEmptyString(item?.heading);
    const body = normalizeNonEmptyString(item?.body);
    const sourceKind = normalizeNonEmptyString(item?.source_kind || item?.sourceKind) || 'unknown';
    if (!heading || !body) continue;
    const key = `${heading.toLowerCase()}|${body.toLowerCase()}|${sourceKind.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      heading,
      body,
      source_kind: sourceKind,
    });
    if (out.length >= Math.max(1, Number(maxItems) || 24)) break;
  }
  return out;
}

function detectPageModuleTruth(html) {
  const text = normalizeNonEmptyString(html);
  return {
    has_ingredients_module: /\bingredients?\b/i.test(text),
    has_active_ingredients_module: /\bactive ingredients?\b/i.test(text),
    has_inci_module: /\binci\b/i.test(text),
    has_details_module: /\bdetails?\b/i.test(text) || /\bbenefits?\b/i.test(text),
    has_how_to_use_module: /\bhow to use\b/i.test(text),
  };
}

function classifyExtractorCompleteness(product = {}) {
  const detailsSections = normalizeDetailsSections(product.details_sections);
  const categories = [
    Boolean(normalizeNonEmptyString(product.description_raw)),
    detailsSections.length > 0,
    Boolean(normalizeNonEmptyString(product.ingredients_raw) || normalizeNonEmptyString(product.active_ingredients_raw)),
    Boolean(normalizeNonEmptyString(product.how_to_use_raw)),
  ].filter(Boolean).length;
  if (categories >= 2) return 'present';
  if (categories === 1) return 'partial';
  return 'missing';
}

function seedLanguageMarketStatus(audit) {
  const findings = Array.isArray(audit?.findings) ? audit.findings : [];
  if (findings.some((finding) => normalizeNonEmptyString(finding?.anomaly_type) === 'locale_market_mismatch')) {
    return 'locale_market_mismatch';
  }
  if (
    findings.some((finding) =>
      ['fr_content_in_us_seed', 'es_content_in_us_seed', 'non_english_description_for_us_seed'].includes(
        normalizeNonEmptyString(finding?.anomaly_type),
      ),
    )
  ) {
    return 'market_language_review';
  }
  return 'ok';
}

function classifyUrlDriftStatus(extractorResponse = {}) {
  const diagnostics = ensureJsonObject(extractorResponse.diagnostics);
  const failureCategory = normalizeNonEmptyString(diagnostics.failure_category);
  if (failureCategory === 'no_product_urls') return 'suspected_url_drift';
  if (failureCategory === 'bot_challenge') return 'bot_challenge';
  if (failureCategory === 'timeout') return 'timeout';
  return 'ok';
}

function classifySeedPdpSyncStatus(extractorProduct, row) {
  const extractorStatus = classifyExtractorCompleteness(extractorProduct);
  const seedStatus = classifySeedPdpFieldCoverageStatus(row?.seed_data);
  if ((extractorStatus === 'present' || extractorStatus === 'partial') && seedStatus === 'present') return 'synced';
  if ((extractorStatus === 'present' || extractorStatus === 'partial') && seedStatus !== 'present') {
    return 'extractor_only_unsynced';
  }
  if (extractorStatus === 'missing' && seedStatus !== 'missing') return 'seed_only';
  return 'missing_both';
}

function classifyAuditBucket({ extractorResponse, extractorProduct, row, audit, pageTruth }) {
  const urlDrift = classifyUrlDriftStatus(extractorResponse);
  if (urlDrift === 'suspected_url_drift') return 'url_drift';
  if (seedLanguageMarketStatus(audit) !== 'ok') return 'market_language_drift';
  if (
    normalizeNonEmptyString(ensureJsonObject(row?.seed_data).seed_description_origin) === 'synthetic_summary' ||
    Array.isArray(audit?.findings) &&
      audit.findings.some((finding) => normalizeNonEmptyString(finding?.anomaly_type) === 'seed_description_pollution')
  ) {
    return 'seed_description_pollution';
  }

  const extractorStatus = classifyExtractorCompleteness(extractorProduct);
  const pageHasPdpModules =
    pageTruth.has_ingredients_module ||
    pageTruth.has_active_ingredients_module ||
    pageTruth.has_inci_module ||
    pageTruth.has_details_module ||
    pageTruth.has_how_to_use_module;
  if (pageHasPdpModules && extractorStatus === 'missing') return 'extractor_missing_pdp_module';

  const seedPdpSyncStatus = classifySeedPdpSyncStatus(extractorProduct, row);
  if (
    (extractorStatus === 'present' || extractorStatus === 'partial') &&
    ['extractor_only_unsynced', 'missing_both'].includes(seedPdpSyncStatus)
  ) {
    return 'writeback_source_gap';
  }

  return 'ok';
}

async function fetchRowsByDomain(domain, { market, limitPerDomain }) {
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
      seed_data,
      updated_at,
      created_at
      FROM external_product_seeds
      WHERE status = 'active'
        AND market = $1
        AND domain = $2
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT $3
    `,
    [market, domain, limitPerDomain],
  );
  return res.rows || [];
}

async function fetchExtractorTruth(row, baseUrl) {
  const targetUrl = pickSeedTargetUrl(row);
  if (!targetUrl) {
    return {
      request_target: '',
      response: { diagnostics: { failure_category: 'missing_target_url' }, products: [], variants: [] },
      product: null,
    };
  }
  const requestBody = buildExtractRequestBody(targetUrl, row);
  const response = await axios.post(`${baseUrl.replace(/\/$/, '')}/api/extract`, requestBody, {
    timeout: Number(process.env.CATALOG_INTELLIGENCE_TIMEOUT_MS || 90000),
    headers: { 'Content-Type': 'application/json' },
  });
  const data = response.data || {};
  return {
    request_target: targetUrl,
    response: data,
    product: Array.isArray(data.products) && data.products.length > 0 ? data.products[0] : null,
  };
}

async function fetchPageTruth(url) {
  const target = normalizeUrlLike(url);
  if (!target) return { fetch_status: 'missing_url', ...detectPageModuleTruth('') };
  try {
    const response = await axios.get(target, {
      timeout: Number(process.env.PDP_AUDIT_PAGE_TIMEOUT_MS || 30000),
      maxRedirects: 5,
      validateStatus: () => true,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      },
    });
    return {
      fetch_status: response.status,
      ...detectPageModuleTruth(typeof response.data === 'string' ? response.data : ''),
    };
  } catch (error) {
    return {
      fetch_status: String(error?.code || error?.message || 'request_failed'),
      ...detectPageModuleTruth(''),
    };
  }
}

async function auditRow(row, baseUrl) {
  const extractor = await fetchExtractorTruth(row, baseUrl);
  const audit = auditExternalSeedRow(row);
  const pageTruth = await fetchPageTruth(extractor.request_target || row?.canonical_url || row?.destination_url);
  const seedData = ensureJsonObject(row.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const extractorProduct = extractor.product || {};

  return {
    seed_id: normalizeNonEmptyString(row.id),
    domain: normalizeNonEmptyString(row.domain),
    market: normalizeNonEmptyString(row.market).toUpperCase(),
    canonical_url: normalizeUrlLike(row.canonical_url || snapshot.canonical_url),
    request_target: extractor.request_target,
    audit_bucket: classifyAuditBucket({
      extractorResponse: extractor.response,
      extractorProduct,
      row,
      audit,
      pageTruth,
    }),
    extractor_truth: {
      failure_category: normalizeNonEmptyString(ensureJsonObject(extractor.response.diagnostics).failure_category) || null,
      discovery_strategy: normalizeNonEmptyString(ensureJsonObject(extractor.response.diagnostics).discovery_strategy) || null,
      extractor_pdp_completeness_status: classifyExtractorCompleteness(extractorProduct),
      product_description_present: Boolean(normalizeNonEmptyString(extractorProduct.description_raw || extractorProduct.description)),
      variant_description_count: Array.isArray(extractorProduct.variants)
        ? extractorProduct.variants.filter((variant) => normalizeNonEmptyString(variant?.description)).length
        : 0,
      ingredients_raw_present: Boolean(normalizeNonEmptyString(extractorProduct.ingredients_raw)),
      active_ingredients_raw_present: Boolean(normalizeNonEmptyString(extractorProduct.active_ingredients_raw)),
      how_to_use_raw_present: Boolean(normalizeNonEmptyString(extractorProduct.how_to_use_raw)),
      details_sections_count: normalizeDetailsSections(extractorProduct.details_sections).length,
      url_drift_status: classifyUrlDriftStatus(extractor.response),
    },
    seed_truth: {
      seed_description_origin:
        normalizeNonEmptyString(seedData.seed_description_origin) ||
        normalizeNonEmptyString(snapshot.seed_description_origin) ||
        null,
      seed_pdp_field_coverage_status: classifySeedPdpFieldCoverageStatus(row.seed_data),
      seed_structured_ingredient_status: classifySeedStructuredIngredientStatus(row.seed_data),
      seed_language_market_status: seedLanguageMarketStatus(audit),
      ingredient_source_quality_status: buildIngredientSourceQualityStatus({
        seedDataValue: row.seed_data,
        reviewedKbRows: [],
      }),
      seed_pdp_sync_status: classifySeedPdpSyncStatus(extractorProduct, row),
    },
    page_truth: pageTruth,
    audit_findings: audit.findings,
  };
}

async function main() {
  const market = normalizeNonEmptyString(argValue('market') || 'US').toUpperCase();
  const domains = normalizeNonEmptyString(argValue('domains'))
    ? normalizeNonEmptyString(argValue('domains')).split(',').map((item) => item.trim()).filter(Boolean)
    : PRIORITY_DOMAINS;
  const limitPerDomain = Math.max(1, Math.min(Number(argValue('limit-per-domain') || 5), 20));
  const out = [];

  for (const domain of domains) {
    const rows = await fetchRowsByDomain(domain, { market, limitPerDomain });
    for (const row of rows) {
      out.push(await auditRow(row, DEFAULT_CATALOG_BASE_URL));
    }
  }

  const summary = {
    market,
    catalog_base_url: DEFAULT_CATALOG_BASE_URL,
    scanned: out.length,
    by_domain: {},
    by_bucket: {},
  };

  for (const item of out) {
    summary.by_domain[item.domain] = (summary.by_domain[item.domain] || 0) + 1;
    summary.by_bucket[item.audit_bucket] = (summary.by_bucket[item.audit_bucket] || 0) + 1;
  }

  console.log(JSON.stringify({ summary, rows: out }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
