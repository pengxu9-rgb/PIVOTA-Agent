#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const axios = require('axios').default;

const { buildExtractRequestBody } = require('./backfill-external-product-seeds-catalog');

const DEFAULT_REPORT_DIR =
  '/Users/pengchydan/dev/PIVOTA-Agent/reports/k_beauty_seed_expansion_20260429';
const DEFAULT_CATALOG_BASE_URL =
  process.env.CATALOG_INTELLIGENCE_BASE_URL ||
  process.env.CATALOG_BASE_URL ||
  'http://127.0.0.1:3001';

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(filePath, value) {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function escapeCsv(value) {
  const text = value == null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeCsv(filePath, rows, preferredHeaders = []) {
  const headers = [];
  const seen = new Set();
  for (const header of preferredHeaders) {
    if (!header || seen.has(header)) continue;
    seen.add(header);
    headers.push(header);
  }
  for (const row of rows) {
    for (const header of Object.keys(row)) {
      if (seen.has(header)) continue;
      seen.add(header);
      headers.push(header);
    }
  }
  const lines = [
    headers.map(escapeCsv).join(','),
    ...rows.map((row) => headers.map((header) => escapeCsv(row[header])).join(',')),
  ];
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeTitleKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[%+&]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function groupKeyForRow(row) {
  try {
    const hostname = new URL(String(row.current_target_url || row.target_url || '')).hostname.replace(/^www\./, '');
    return `${row.brand}::${hostname}`;
  } catch {
    return `${row.brand}::`;
  }
}

async function probeExtract(url, brand, market, catalogBaseUrl) {
  try {
    const response = await axios.post(
      `${catalogBaseUrl.replace(/\/$/, '')}/api/extract`,
      {
        brand,
        domain: url,
        market,
        limit: 50,
      },
      {
        timeout: Number(process.env.CATALOG_INTELLIGENCE_TIMEOUT_MS || 90000),
        headers: { 'Content-Type': 'application/json' },
      },
    );
    const body = response.data || {};
    return {
      product_count: asArray(body.products).length,
      failure_category: body.diagnostics?.failure_category || '',
      discovery_strategy: body.diagnostics?.discovery_strategy || '',
      sample_url: body.products?.[0]?.url || body.products?.[0]?.canonical_url || '',
    };
  } catch (error) {
    return {
      product_count: 0,
      failure_category: 'request_error',
      discovery_strategy: '',
      sample_url: '',
      error: String(error?.message || error || 'unknown_error'),
    };
  }
}

async function fetchSiteLevelOffers(brand, domain, market, catalogBaseUrl) {
  const response = await axios.post(
    `${catalogBaseUrl.replace(/\/$/, '')}/api/extract-v2`,
    {
      brand,
      domain,
      market,
      limit: 250,
    },
    {
      timeout: Number(process.env.CATALOG_INTELLIGENCE_TIMEOUT_MS || 90000),
      headers: { 'Content-Type': 'application/json' },
    },
  );
  return asArray(response.data?.offers_v2);
}

function updateSummaryJson(reportDir, summary, outputFiles) {
  const summaryPath = path.join(reportDir, 'summary.json');
  const payload = readJson(summaryPath, {});
  const outputList = new Set(asArray(payload.output_files));
  for (const file of outputFiles) outputList.add(file);
  payload.output_files = Array.from(outputList);
  payload.canonical_cleanup_candidates = {
    ...summary,
    output_files: outputFiles,
  };
  writeJson(summaryPath, payload);
}

async function main() {
  const reportDir = path.resolve(process.argv[2] || DEFAULT_REPORT_DIR);
  const catalogBaseUrl = process.argv[3] || DEFAULT_CATALOG_BASE_URL;
  const evidence = readJson(path.join(reportDir, 'k_beauty_pdp_quality_issue_evidence.json'), {});
  const rows = asArray(evidence.rows);
  const candidates = rows.filter((row) => row.probe_classification === 'source_probe_no_product');
  const siteLevelOfferCache = new Map();

  const results = [];
  for (const row of candidates) {
    const normalizedRequest = buildExtractRequestBody(row.target_url, {
      brand: row.brand,
      market: 'US',
      title: row.title,
      canonical_url: row.canonical_url,
      destination_url: row.target_url,
      seed_data: {
        brand: row.brand,
        title: row.title,
        snapshot: {
          title: row.title,
          canonical_url: row.canonical_url,
          destination_url: row.target_url,
        },
      },
    });
    const suggestedUrl = normalizedRequest.domain;
    const currentProbe = await probeExtract(row.target_url, normalizedRequest.brand, 'US', catalogBaseUrl);
    const suggestedProbe =
      suggestedUrl && suggestedUrl !== row.target_url
        ? await probeExtract(suggestedUrl, normalizedRequest.brand, 'US', catalogBaseUrl)
        : currentProbe;
    const groupKey = groupKeyForRow({
      brand: row.brand,
      current_target_url: row.target_url,
    });
    let siteLevelOffers = siteLevelOfferCache.get(groupKey);
    if (!siteLevelOffers) {
      const domain = groupKey.split('::')[1] || '';
      try {
        siteLevelOffers = await fetchSiteLevelOffers(normalizedRequest.brand, domain, 'US', catalogBaseUrl);
      } catch (_) {
        siteLevelOffers = [];
      }
      siteLevelOfferCache.set(groupKey, siteLevelOffers);
    }
    const titleKey = normalizeTitleKey(row.title);
    const siteLevelExactMatch = siteLevelOffers.find(
      (offer) => normalizeTitleKey(offer?.product_title) === titleKey,
    );
    const siteLevelProbableMatch = !siteLevelExactMatch
      ? siteLevelOffers.find((offer) => {
          const offerTitleKey = normalizeTitleKey(offer?.product_title);
          return offerTitleKey && (offerTitleKey.includes(titleKey) || titleKey.includes(offerTitleKey));
        })
      : null;
    const siteLevelMatchStatus = siteLevelExactMatch
      ? 'exact_title_match'
      : siteLevelProbableMatch
        ? 'probable_title_match'
        : 'none';

    results.push({
      brand: row.brand,
      title: row.title,
      external_product_id: row.external_product_id,
      current_target_url: row.target_url,
      suggested_target_url: suggestedUrl,
      current_product_count: currentProbe.product_count,
      current_failure_category: currentProbe.failure_category,
      current_sample_url: currentProbe.sample_url,
      suggested_product_count: suggestedProbe.product_count,
      suggested_failure_category: suggestedProbe.failure_category,
      suggested_sample_url: suggestedProbe.sample_url,
      site_level_match_status: siteLevelMatchStatus,
      site_level_match_url: siteLevelExactMatch?.url_canonical || siteLevelProbableMatch?.url_canonical || '',
      site_level_match_title: siteLevelExactMatch?.product_title || siteLevelProbableMatch?.product_title || '',
      improvement_status:
        suggestedUrl && suggestedUrl !== row.target_url && currentProbe.product_count === 0 && suggestedProbe.product_count > 0
          ? 'recovered_by_target_normalization'
          : siteLevelMatchStatus !== 'none'
            ? 'site_level_match_requires_direct_extract_fallback'
            : suggestedUrl !== row.target_url
              ? 'normalized_but_unrecovered'
              : 'no_change',
    });
  }

  const summary = {
    generated_at: new Date().toISOString(),
    candidate_count: results.length,
    recovered_by_target_normalization_count: results.filter(
      (row) => row.improvement_status === 'recovered_by_target_normalization',
    ).length,
    site_level_match_requires_direct_extract_fallback_count: results.filter(
      (row) => row.improvement_status === 'site_level_match_requires_direct_extract_fallback',
    ).length,
    normalized_but_unrecovered_count: results.filter(
      (row) => row.improvement_status === 'normalized_but_unrecovered',
    ).length,
    no_change_count: results.filter((row) => row.improvement_status === 'no_change').length,
    by_brand: results.reduce((acc, row) => {
      acc[row.brand] = (acc[row.brand] || 0) + 1;
      return acc;
    }, {}),
  };

  const jsonPath = path.join(reportDir, 'k_beauty_canonical_cleanup_candidates.json');
  const csvPath = path.join(reportDir, 'k_beauty_canonical_cleanup_candidates.csv');

  writeJson(jsonPath, {
    summary,
    rows: results,
  });
  writeCsv(csvPath, results, [
    'brand',
    'title',
    'external_product_id',
    'current_target_url',
    'suggested_target_url',
    'current_product_count',
    'current_failure_category',
    'current_sample_url',
    'suggested_product_count',
    'suggested_failure_category',
    'suggested_sample_url',
    'site_level_match_status',
    'site_level_match_url',
    'site_level_match_title',
    'improvement_status',
  ]);

  updateSummaryJson(reportDir, summary, [
    'k_beauty_canonical_cleanup_candidates.json',
    'k_beauty_canonical_cleanup_candidates.csv',
  ]);

  process.stdout.write(
    `${JSON.stringify(
      {
        summary,
        json_path: jsonPath,
        csv_path: csvPath,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
