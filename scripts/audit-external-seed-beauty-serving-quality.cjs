#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const axios = require('axios');

const { closePool } = require('../src/db');
const { fetchRows } = require('./audit-external-product-seeds-content.js');
const { auditExternalSeedRow } = require('../src/services/externalSeedContentAudit');
const {
  auditRow: auditPdpQualityRow,
  resolveGatewayUrl,
} = require('./audit-external-product-pdp-quality.js');

const DEFAULT_CATALOG_BASE_URL =
  process.env.CATALOG_INTELLIGENCE_BASE_URL ||
  'https://pivota-catalog-intelligence-production.up.railway.app';

const CLASSIFICATIONS = Object.freeze({
  PASS: 'pass',
  REPAIRABLE_BACKFILL: 'repairable_backfill',
  SOURCE_UNAVAILABLE: 'source_unavailable',
  NON_MERCHANDISE: 'non_merchandise',
  REVIEW_REQUIRED: 'review_required',
  PDP_SHAPING_ISSUE: 'pdp_shaping_issue',
  CACHE_ISSUE: 'cache_issue',
});

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

function firstImageUrl(row = {}) {
  const seedData = asObject(row.seed_data);
  const snapshot = asObject(seedData.snapshot);
  return firstString(
    row.image_url,
    row.image_urls,
    seedData.image_url,
    seedData.image_urls,
    seedData.images,
    snapshot.image_url,
    snapshot.image_urls,
    snapshot.images,
  );
}

function priceAmount(row = {}) {
  const seedData = asObject(row.seed_data);
  const snapshot = asObject(seedData.snapshot);
  for (const value of [
    row.price_amount,
    row.price,
    seedData.price_amount,
    seedData.price,
    snapshot.price_amount,
    snapshot.price,
  ]) {
    const amount = Number(value);
    if (Number.isFinite(amount)) return amount;
  }
  return null;
}

function hasExplicitUnknownOrFreePrice(row = {}) {
  const seedData = asObject(row.seed_data);
  const snapshot = asObject(seedData.snapshot);
  const text = [
    row.price_state,
    row.price_label,
    seedData.price_state,
    seedData.price_label,
    snapshot.price_state,
    snapshot.price_label,
  ].join(' ');
  return Boolean(
    row.price_unknown === true ||
      seedData.price_unknown === true ||
      snapshot.price_unknown === true ||
      row.price_is_free === true ||
      seedData.price_is_free === true ||
      snapshot.price_is_free === true ||
      /\b(price\s+unknown|unavailable|free|sample)\b/i.test(text)
  );
}

function hasSourceUnavailableMarker(row = {}) {
  const seedData = asObject(row.seed_data);
  const snapshot = asObject(seedData.snapshot);
  const candidates = [
    row.source_unavailable_v1,
    row.transaction_readiness_blocker_v1,
    seedData.source_unavailable_v1,
    seedData.transaction_readiness_blocker_v1,
    snapshot.source_unavailable_v1,
    snapshot.transaction_readiness_blocker_v1,
  ].map(asObject);
  return candidates.some((item) => (
    asString(item.status).toLowerCase() === 'source_unavailable' ||
    asString(item.contract_version) === 'external_seed.source_unavailable.v1'
  ));
}

function buildRowSurfaceText(row = {}) {
  const seedData = asObject(row.seed_data);
  const snapshot = asObject(seedData.snapshot);
  return [
    row.title,
    row.canonical_url,
    row.destination_url,
    row.category,
    row.product_type,
    seedData.title,
    seedData.canonical_url,
    seedData.destination_url,
    seedData.description,
    snapshot.title,
    snapshot.canonical_url,
    snapshot.destination_url,
    snapshot.description,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function isNonMerchandiseRow(row = {}) {
  const text = buildRowSurfaceText(row);
  return /\b(shipping|delivery|route|package)\s+protection\b|\border\s+protection\b|\breturns?\s+policy\b|\bprivacy\s+policy\b|\bterms\s+of\s+service\b|\bgift\s+card\b|\bwarranty\b/.test(text);
}

async function probeMerchantUrl(url, { timeoutMs = 8000 } = {}) {
  const target = asString(url);
  if (!target) return { checked: false, ok: false, reason: 'missing_url' };
  try {
    const response = await axios.head(target, {
      timeout: timeoutMs,
      maxRedirects: 5,
      validateStatus: () => true,
    });
    return {
      checked: true,
      ok: response.status >= 200 && response.status < 400,
      status: response.status,
      method: 'HEAD',
    };
  } catch (error) {
    try {
      const response = await axios.get(target, {
        timeout: timeoutMs,
        maxRedirects: 5,
        validateStatus: () => true,
      });
      return {
        checked: true,
        ok: response.status >= 200 && response.status < 400,
        status: response.status,
        method: 'GET',
      };
    } catch (fallbackError) {
      return {
        checked: true,
        ok: false,
        reason: asString(fallbackError.code || fallbackError.message || error.code || error.message || 'url_probe_failed'),
      };
    }
  }
}

function summarizePdpQualityFailure(pdpQuality = null) {
  if (!pdpQuality || typeof pdpQuality !== 'object') return [];
  return Array.isArray(pdpQuality.failure_reasons) ? pdpQuality.failure_reasons : [];
}

function classifyBeautyServingQualityRow({
  row = {},
  contentAudit = null,
  pdpQuality = null,
  merchantUrlHealth = null,
} = {}) {
  const failureReasons = [];
  const contentFindings = Array.isArray(contentAudit?.findings) ? contentAudit.findings : [];
  const pdpReasons = summarizePdpQualityFailure(pdpQuality);
  const imageUrl = firstImageUrl(row);
  const amount = priceAmount(row);
  const sourceUnavailable = hasSourceUnavailableMarker(row);
  const nonMerchandise = isNonMerchandiseRow(row);
  const category = asString(row.category || row.product_type || asObject(row.seed_data).category || asObject(row.seed_data).product_type).toLowerCase();

  if (sourceUnavailable) failureReasons.push('source_unavailable_marker');
  if (nonMerchandise) failureReasons.push('non_merchandise_surface');
  if (!imageUrl) failureReasons.push('missing_image');
  if ((amount == null || amount <= 0) && !hasExplicitUnknownOrFreePrice(row)) failureReasons.push(amount == null ? 'missing_price' : 'invalid_zero_or_negative_price');
  if (category === 'external' || category === 'unknown' || category === 'uncategorized') failureReasons.push('generic_external_category');
  if (merchantUrlHealth?.checked && merchantUrlHealth.ok === false) failureReasons.push(`merchant_url_${merchantUrlHealth.status || merchantUrlHealth.reason || 'failed'}`);
  for (const finding of contentFindings) {
    const anomaly = asString(finding.anomaly_type || finding.reason || finding.severity);
    if (anomaly) failureReasons.push(`content_${anomaly}`);
  }
  for (const reason of pdpReasons) {
    failureReasons.push(`pdp_${reason}`);
  }

  let classification = CLASSIFICATIONS.PASS;
  if (sourceUnavailable || /source_unavailable|terminal_source_unavailable|404|410/.test(failureReasons.join(' '))) {
    classification = CLASSIFICATIONS.SOURCE_UNAVAILABLE;
  } else if (nonMerchandise) {
    classification = CLASSIFICATIONS.NON_MERCHANDISE;
  } else if (pdpReasons.some((reason) => /cache|stale|mismatch/.test(String(reason)))) {
    classification = CLASSIFICATIONS.CACHE_ISSUE;
  } else if (pdpReasons.some((reason) => /shape|module|schema|missing_product_intel|pdp/.test(String(reason)))) {
    classification = CLASSIFICATIONS.PDP_SHAPING_ISSUE;
  } else if (
    failureReasons.some((reason) =>
      /missing_image|missing_price|invalid_zero_or_negative_price|generic_external_category|content_/.test(reason),
    )
  ) {
    classification = asString(row.external_product_id) ? CLASSIFICATIONS.REPAIRABLE_BACKFILL : CLASSIFICATIONS.REVIEW_REQUIRED;
  } else if (failureReasons.length > 0) {
    classification = CLASSIFICATIONS.REVIEW_REQUIRED;
  }

  return {
    classification,
    failure_reasons: Array.from(new Set(failureReasons)),
    image_url: imageUrl || null,
    price_amount: amount,
    merchant_url_ok: merchantUrlHealth?.checked ? Boolean(merchantUrlHealth.ok) : null,
    auto_fixable: [CLASSIFICATIONS.SOURCE_UNAVAILABLE, CLASSIFICATIONS.NON_MERCHANDISE].includes(classification),
    recommended_action: classification === CLASSIFICATIONS.PASS
      ? 'keep_serving'
      : classification === CLASSIFICATIONS.REPAIRABLE_BACKFILL
        ? 'run targeted catalog-intelligence backfill, then image/offer/recall-doc backfills'
        : classification === CLASSIFICATIONS.SOURCE_UNAVAILABLE || classification === CLASSIFICATIONS.NON_MERCHANDISE
          ? 'mark source unavailable with external_seed.source_unavailable.v1'
          : classification === CLASSIFICATIONS.CACHE_ISSUE
            ? 'refresh PDP/image/recall caches for this exact external_product_id'
            : classification === CLASSIFICATIONS.PDP_SHAPING_ISSUE
              ? 'inspect get_pdp_v2 shaping and product-intel modules'
              : 'manual review required before data writes',
  };
}

function renderMarkdownReport(report) {
  const lines = [
    '# Beauty Serving Quality Audit',
    '',
    `Generated: ${report.generated_at}`,
    `Dry run: ${report.dry_run}`,
    '',
    '## Summary',
    '',
  ];
  for (const [key, value] of Object.entries(report.summary.classification_counts)) {
    lines.push(`- ${key}: ${value}`);
  }
  lines.push('', '## Rows', '');
  for (const row of report.rows) {
    lines.push(`- ${row.classification}: ${row.external_product_id || row.seed_id || 'unknown'} - ${row.title || ''}`);
    if (row.failure_reasons.length) lines.push(`  - reasons: ${row.failure_reasons.join(', ')}`);
    lines.push(`  - action: ${row.recommended_action}`);
  }
  return `${lines.join('\n')}\n`;
}

function writeReport(report, { format = 'json', out = '' } = {}) {
  let output;
  if (format === 'md' || format === 'markdown') output = renderMarkdownReport(report);
  else output = `${JSON.stringify(report, null, 2)}\n`;
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, output, 'utf8');
  }
  process.stdout.write(output);
}

function assertWriteIsTargeted(options) {
  if (!options.write) return;
  if (!options.externalProductId && !options.seedId) {
    throw new Error('--write requires --external-product-id or --seed-id');
  }
}

function applySourceUnavailableWrite(rows, options) {
  if (!options.write) return { attempted: false, updated: null };
  const ids = rows
    .map((row) => asString(row.external_product_id))
    .filter(Boolean);
  if (!ids.length) return { attempted: true, updated: null, error: 'missing_external_product_id' };
  const markerScript = path.join(__dirname, 'mark-external-seed-source-unavailable.cjs');
  const args = [
    markerScript,
    '--external-product-ids',
    ids.join(','),
    '--market',
    options.market,
    '--reason',
    options.writeReason,
    '--evidence',
    options.writeEvidence,
    '--write',
  ].filter((value) => value !== '');
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    attempted: true,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error ? asString(result.error.message || result.error) : null,
  };
}

async function runAudit(options = {}) {
  assertWriteIsTargeted(options);
  const rows = await fetchRows({
    market: options.market,
    seedId: options.seedId,
    externalProductId: options.externalProductId,
    domain: options.domain,
    brand: options.brand,
    limit: options.limit,
    offset: options.offset,
    includeInactive: options.includeInactive,
    includeSourceUnavailable: true,
  });

  const results = [];
  for (const row of rows) {
    const contentAudit = auditExternalSeedRow(row, { includeSourceUnavailable: true });
    const merchantUrl = firstString(row.destination_url, row.canonical_url, asObject(row.seed_data).destination_url, asObject(row.seed_data).canonical_url);
    const merchantUrlHealth = options.skipMerchantUrlProbe
      ? { checked: false, ok: null }
      : await probeMerchantUrl(merchantUrl, { timeoutMs: options.urlTimeoutMs });
    const pdpQuality = options.skipPdpQuality
      ? null
      : await auditPdpQualityRow(row, {
          catalogBaseUrl: options.catalogBaseUrl,
          gatewayUrl: options.gatewayUrl,
          imageHealthEnabled: !options.skipImageHealth,
          imageHealthLimit: options.imageHealthLimit,
          similarEnabled: options.similarEnabled,
          catalogTimeoutMs: options.catalogTimeoutMs,
          pdpTimeoutMs: options.pdpTimeoutMs,
          detailsPdpTimeoutMs: options.detailsPdpTimeoutMs,
          similarTimeoutMs: options.similarTimeoutMs,
        });
    const classification = classifyBeautyServingQualityRow({
      row,
      contentAudit,
      pdpQuality,
      merchantUrlHealth,
    });
    results.push({
      seed_id: row.id || null,
      external_product_id: row.external_product_id || null,
      market: row.market || options.market,
      domain: row.domain || null,
      brand: row.brand || asObject(row.seed_data).brand || null,
      title: row.title || asObject(row.seed_data).title || null,
      canonical_url: row.canonical_url || asObject(row.seed_data).canonical_url || null,
      destination_url: row.destination_url || asObject(row.seed_data).destination_url || null,
      classification: classification.classification,
      failure_reasons: classification.failure_reasons,
      recommended_action: classification.recommended_action,
      auto_fixable: classification.auto_fixable,
      content_findings_count: Array.isArray(contentAudit?.findings) ? contentAudit.findings.length : 0,
      pdp_failure_reasons: summarizePdpQualityFailure(pdpQuality),
      merchant_url_health: merchantUrlHealth,
      image_url: classification.image_url,
      price_amount: classification.price_amount,
    });
  }

  const classificationCounts = {};
  for (const row of results) {
    classificationCounts[row.classification] = (classificationCounts[row.classification] || 0) + 1;
  }
  const writeRows = results
    .filter((row) => row.auto_fixable)
    .filter((row) => [CLASSIFICATIONS.SOURCE_UNAVAILABLE, CLASSIFICATIONS.NON_MERCHANDISE].includes(row.classification));
  const writeResult = options.write ? applySourceUnavailableWrite(writeRows, options) : { attempted: false };
  return {
    generated_at: new Date().toISOString(),
    dry_run: !options.write,
    options: {
      market: options.market,
      seed_id: options.seedId || null,
      external_product_id: options.externalProductId || null,
      domain: options.domain || null,
      brand: options.brand || null,
      limit: options.limit,
      skip_pdp_quality: options.skipPdpQuality,
      skip_image_health: options.skipImageHealth,
      skip_merchant_url_probe: options.skipMerchantUrlProbe,
    },
    summary: {
      scanned: results.length,
      classification_counts: classificationCounts,
      auto_fixable_count: writeRows.length,
    },
    write_result: writeResult,
    rows: results,
  };
}

async function main() {
  const options = {
    market: asString(argValue('market', 'US')).toUpperCase() || 'US',
    seedId: argValue('seed-id') || argValue('seedId') || '',
    externalProductId: argValue('external-product-id') || argValue('externalProductId') || '',
    domain: argValue('domain') || '',
    brand: argValue('brand') || '',
    limit: Math.max(1, Math.min(Number(argValue('limit') || 100), 1000)),
    offset: Math.max(0, Number(argValue('offset') || 0)),
    includeInactive: hasFlag('include-inactive'),
    skipPdpQuality: hasFlag('skip-pdp-quality'),
    skipImageHealth: hasFlag('skip-image-health'),
    skipMerchantUrlProbe: hasFlag('skip-merchant-url-probe'),
    similarEnabled: !hasFlag('skip-similar'),
    imageHealthLimit: Number(argValue('image-health-limit') || 8) || 8,
    catalogBaseUrl: argValue('catalog-base-url') || DEFAULT_CATALOG_BASE_URL,
    gatewayUrl: resolveGatewayUrl(argValue('gateway-url') || process.env.PIVOTA_GATEWAY_URL || ''),
    urlTimeoutMs: Number(argValue('url-timeout-ms') || 8000) || 8000,
    catalogTimeoutMs: Number(argValue('catalog-timeout-ms') || 15000) || null,
    pdpTimeoutMs: Number(argValue('pdp-timeout-ms') || 10000) || null,
    detailsPdpTimeoutMs: Number(argValue('details-pdp-timeout-ms') || 25000) || null,
    similarTimeoutMs: Number(argValue('similar-timeout-ms') || 12000) || null,
    write: hasFlag('write'),
    writeReason: asString(argValue('reason', 'beauty_serving_quality_pollution')),
    writeEvidence: asString(argValue('evidence', 'beauty_serving_quality_audit')),
    format: asString(argValue('format', 'json')).toLowerCase(),
    out: argValue('out') || '',
  };
  const report = await runAudit(options);
  writeReport(report, { format: options.format, out: options.out });
}

if (require.main === module) {
  main()
    .catch((error) => {
      process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => null);
    });
}

module.exports = {
  CLASSIFICATIONS,
  classifyBeautyServingQualityRow,
  probeMerchantUrl,
  renderMarkdownReport,
  runAudit,
};
