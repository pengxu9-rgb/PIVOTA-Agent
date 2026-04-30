#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const axios = require('axios').default;

const {
  buildSeedStats,
} = require('./audit-external-seed-pdp-underfill-against-catalog');
const {
  buildExtractRequestBody,
  chooseRepresentativeProduct,
  pickSeedTargetUrl,
  normalizeTargetUrlForMarket,
} = require('./backfill-external-product-seeds-catalog');

const DEFAULT_REPORT_DIR =
  '/Users/pengchydan/dev/PIVOTA-Agent/reports/k_beauty_seed_expansion_20260429';
const DEFAULT_CATALOG_BASE_URL =
  process.env.CATALOG_INTELLIGENCE_BASE_URL ||
  process.env.CATALOG_BASE_URL ||
  'http://127.0.0.1:3001';
const SHORT_DESCRIPTION_THRESHOLD = 180;
const DEFAULT_CONCURRENCY = 4;

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

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function pickFirstString(...values) {
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (normalized) return normalized;
  }
  return '';
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

function collectProductImageUrls(product = {}) {
  const out = [];
  const append = (value) => {
    if (Array.isArray(value)) {
      value.forEach(append);
      return;
    }
    const normalized = String(value || '').trim();
    if (/^https?:\/\//i.test(normalized) && !out.includes(normalized)) out.push(normalized);
  };
  append(product.image_url);
  append(product.image_urls);
  append(product.images);
  asArray(product.variants).forEach((variant) => {
    append(variant?.image_url);
    append(variant?.image_urls);
    append(variant?.images);
  });
  return out;
}

function mapManifestItems(filePath) {
  const manifest = readJson(filePath, {});
  const items = asArray(manifest.items);
  const map = new Map();
  for (const item of items) {
    const row = asObject(item.seed_row || item.seedRow || item);
    if (!row.external_product_id) continue;
    map.set(row.external_product_id, {
      manifest_path: filePath,
      manifest_brand: manifest.brand || row.brand || '',
      item,
      row,
    });
  }
  return map;
}

function mergeMaps(...maps) {
  const merged = new Map();
  for (const map of maps) {
    for (const [key, value] of map.entries()) {
      merged.set(key, value);
    }
  }
  return merged;
}

function normalizeIssueList(value) {
  return asArray(value).map((item) => String(item || '').trim()).filter(Boolean);
}

function classifyDescriptionGap(liveDescriptionLen, seedDescriptionLen, issueSet) {
  if (issueSet.has('description:empty')) {
    if (seedDescriptionLen > 0) return 'live_description_missing_but_seed_present';
    return 'seed_and_live_description_missing';
  }
  if (issueSet.has('description:short_lt_180')) {
    if (seedDescriptionLen >= SHORT_DESCRIPTION_THRESHOLD && liveDescriptionLen < seedDescriptionLen) {
      return 'live_description_truncated_vs_seed';
    }
    if (seedDescriptionLen > 0 && seedDescriptionLen < SHORT_DESCRIPTION_THRESHOLD) {
      return 'seed_description_short_at_ingest';
    }
    return 'live_description_short_unknown_source';
  }
  if (liveDescriptionLen === 0 && seedDescriptionLen > 0) {
    return 'live_description_missing_but_seed_present';
  }
  return 'none';
}

function classifyStructuredSeed(seedStats) {
  if (
    seedStats.details_sections_count === 0 &&
    seedStats.how_to_use_chars === 0 &&
    seedStats.faq_count === 0
  ) {
    return 'seed_structured_detail_absent';
  }
  if (seedStats.details_sections_count === 0 || seedStats.how_to_use_chars === 0) {
    return 'seed_structured_detail_partial';
  }
  return 'seed_structured_detail_present';
}

function buildIssueTags(auditRow, seedStats, descriptionGap) {
  const tags = [];
  if (classifyStructuredSeed(seedStats) !== 'seed_structured_detail_present') {
    tags.push('seed_underfilled_structured_pdp_detail');
  }
  if (auditRow.product_details_reason === 'module_absent' || auditRow.product_facts_reason === 'module_absent') {
    tags.push('live_pdp_detail_modules_absent');
  }
  if (String(auditRow.product_intel_reason || '').includes('intel_missing')) {
    tags.push('pivota_insights_missing');
  }
  if (auditRow.offers_reason === 'no_product_group_members') {
    tags.push('identity_group_or_offer_merge_missing');
  }
  if (descriptionGap === 'live_description_missing_but_seed_present' || descriptionGap === 'live_description_truncated_vs_seed') {
    tags.push('live_pdp_shaping_or_cache_gap');
  }
  if (descriptionGap === 'seed_description_short_at_ingest') {
    tags.push('seed_description_underfilled');
  }
  if (!tags.length) tags.push('quality_gap_needs_manual_triage');
  return tags;
}

function summarizeApplyArtifact(filePath) {
  const data = readJson(filePath, {});
  const topKeys = Object.keys(asObject(data));
  const serializedKeys = JSON.stringify(topKeys).toLowerCase();
  return {
    file: path.basename(filePath),
    top_level_keys: topKeys,
    apply_mode: data.mode || '',
    has_apply_result: Boolean(data.apply_result),
    has_explicit_backfill_marker: serializedKeys.includes('backfill'),
    has_explicit_insights_marker: serializedKeys.includes('insights'),
  };
}

async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) break;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

async function probeCatalog(seedRow, catalogBaseUrl) {
  const normalizedRow = asObject(seedRow);
  const targetUrl = normalizeTargetUrlForMarket(
    pickSeedTargetUrl(normalizedRow),
    normalizedRow.market || 'US',
  );
  if (!targetUrl) {
    return {
      probed: false,
      target_url: '',
      probe_classification: 'missing_target_url',
      probe_error: 'missing_target_url',
    };
  }
  try {
    const response = await axios.post(
      `${catalogBaseUrl.replace(/\/$/, '')}/api/extract`,
      buildExtractRequestBody(targetUrl, normalizedRow),
      {
        timeout: Number(process.env.CATALOG_INTELLIGENCE_TIMEOUT_MS || 90000),
        headers: { 'Content-Type': 'application/json' },
      },
    );
    const body = asObject(response.data);
    const product = asObject(chooseRepresentativeProduct(body, targetUrl, normalizedRow));
    const description = pickFirstString(product.description_raw, product.description);
    const detailsCount = asArray(product.details_sections).length;
    const howToLen = pickFirstString(product.how_to_use_raw).length;
    const ingredientsLen = pickFirstString(product.ingredients_raw).length;
    const imageCount = collectProductImageUrls(product).length;
    const productCount = asArray(body.products).length;
    let probeClassification = 'source_underfilled';
    if (productCount === 0) probeClassification = 'source_probe_no_product';
    else if (detailsCount > 0 || howToLen > 0 || ingredientsLen > 0) probeClassification = 'source_rich_detail_recoverable';
    else if (description.length > 0 || imageCount > 0) probeClassification = 'source_basic_product_recoverable';
    return {
      probed: true,
      target_url: targetUrl,
      probe_classification: probeClassification,
      extractor_product_count: productCount,
      extractor_title: product.title || '',
      extractor_canonical_url: product.canonical_url || product.url || '',
      extractor_description_chars: description.length,
      extractor_details_sections_count: detailsCount,
      extractor_how_to_use_chars: howToLen,
      extractor_ingredients_chars: ingredientsLen,
      extractor_image_count: imageCount,
      extractor_discovery_strategy: body.diagnostics?.discovery_strategy || '',
      extractor_failure_category: body.diagnostics?.failure_category || '',
      extractor_block_provider: body.diagnostics?.block_provider || '',
      extractor_http_trace: JSON.stringify(asArray(body.diagnostics?.http_trace)),
      probe_error: '',
    };
  } catch (error) {
    return {
      probed: true,
      target_url: targetUrl,
      probe_classification: 'source_probe_error',
      probe_error: String(error?.message || error || 'unknown_error'),
    };
  }
}

function chooseProbeCandidates(issueRows) {
  return issueRows.filter(
    (row) =>
      row.live_description_issue !== 'none' ||
      row.product_details_reason === 'module_absent' ||
      row.how_to_reason === 'unavailable',
  );
}

function buildSummary(issueRows, probeRows, artifactSummary) {
  const countWhere = (predicate) => issueRows.filter(predicate).length;
  const probeCountWhere = (predicate) => probeRows.filter(predicate).length;
  const brandSummary = {};
  for (const row of issueRows) {
    const bucket = brandSummary[row.brand] || {
      count: 0,
      live_description_issue_count: 0,
      seed_structured_detail_absent_count: 0,
      offers_missing_count: 0,
      product_intel_missing_count: 0,
      source_rich_detail_recoverable_count: 0,
      source_probe_no_product_count: 0,
    };
    bucket.count += 1;
    if (row.live_description_issue !== 'none') bucket.live_description_issue_count += 1;
    if (row.seed_structured_detail_status === 'seed_structured_detail_absent') {
      bucket.seed_structured_detail_absent_count += 1;
    }
    if (row.offers_reason === 'no_product_group_members') bucket.offers_missing_count += 1;
    if (String(row.product_intel_reason || '').includes('intel_missing')) {
      bucket.product_intel_missing_count += 1;
    }
    if (row.probe_classification === 'source_rich_detail_recoverable') {
      bucket.source_rich_detail_recoverable_count += 1;
    }
    if (row.probe_classification === 'source_probe_no_product') {
      bucket.source_probe_no_product_count += 1;
    }
    brandSummary[row.brand] = bucket;
  }

  return {
    generated_at: new Date().toISOString(),
    target_count: issueRows.length,
    live_description_issue_count: countWhere((row) => row.live_description_issue !== 'none'),
    live_description_missing_but_seed_present_count: countWhere(
      (row) => row.live_description_issue === 'live_description_missing_but_seed_present',
    ),
    live_description_truncated_vs_seed_count: countWhere(
      (row) => row.live_description_issue === 'live_description_truncated_vs_seed',
    ),
    seed_description_short_at_ingest_count: countWhere(
      (row) => row.live_description_issue === 'seed_description_short_at_ingest',
    ),
    seed_structured_detail_absent_count: countWhere(
      (row) => row.seed_structured_detail_status === 'seed_structured_detail_absent',
    ),
    live_product_detail_modules_absent_count: countWhere(
      (row) => row.product_details_reason === 'module_absent' || row.product_facts_reason === 'module_absent',
    ),
    live_offers_missing_count: countWhere((row) => row.offers_reason === 'no_product_group_members'),
    live_product_intel_missing_count: countWhere((row) =>
      String(row.product_intel_reason || '').includes('intel_missing'),
    ),
    direct_catalog_probe_count: probeRows.length,
    source_rich_detail_recoverable_count: probeCountWhere(
      (row) => row.probe_classification === 'source_rich_detail_recoverable',
    ),
    source_basic_product_recoverable_count: probeCountWhere(
      (row) => row.probe_classification === 'source_basic_product_recoverable',
    ),
    source_probe_no_product_count: probeCountWhere(
      (row) => row.probe_classification === 'source_probe_no_product',
    ),
    source_probe_error_count: probeCountWhere(
      (row) => row.probe_classification === 'source_probe_error',
    ),
    create_apply_artifact_summary: artifactSummary,
    by_brand: brandSummary,
    notes: [
      'All current LANEIGE/Anua production seed manifests lack structured PDP detail fields in seed_data.',
      'When live description is empty or shorter than the manifest seed description, the issue is downstream of initial seed creation.',
      'Direct /api/extract probes on representative rows distinguish source-recoverable PDP detail from stale canonical or extractor misses.',
    ],
  };
}

function updateSummaryJson(reportDir, summary, outputFiles) {
  const summaryPath = path.join(reportDir, 'summary.json');
  const payload = readJson(summaryPath, {});
  const outputList = new Set(asArray(payload.output_files));
  for (const file of outputFiles) outputList.add(file);
  payload.output_files = Array.from(outputList);
  payload.pdp_quality_issue_evidence = {
    ...summary,
    output_files: outputFiles,
  };
  writeJson(summaryPath, payload);
}

async function main() {
  const reportDir = path.resolve(process.argv[2] || DEFAULT_REPORT_DIR);
  const catalogBaseUrl = process.argv[3] || DEFAULT_CATALOG_BASE_URL;
  const concurrency = Math.max(1, Number(process.argv[4] || DEFAULT_CONCURRENCY));

  const fullAudit = readJson(path.join(reportDir, 'k_beauty_production_pdp_quality_full_audit.json'), {});
  const fullAuditRows = asArray(fullAudit.results);

  const manifestMap = mergeMaps(
    mapManifestItems(path.join(reportDir, 'manifests_filtered', 'laneige-dtc-manifest.json')),
    mapManifestItems(path.join(reportDir, 'manifests_filtered', 'anua-dtc-manifest.json')),
  );

  const artifactSummary = [
    summarizeApplyArtifact(path.join(reportDir, 'laneige-dtc-create-apply.json')),
    summarizeApplyArtifact(path.join(reportDir, 'anua-dtc-create-apply.json')),
  ];

  const issueRows = fullAuditRows.map((auditRow) => {
    const manifestEntry = manifestMap.get(auditRow.external_product_id) || null;
    const seedRow = manifestEntry?.row || {};
    const seedStats = buildSeedStats(seedRow);
    const issueSet = new Set(normalizeIssueList(auditRow.issues));
    const liveDescriptionLen = Number(auditRow.description_len || 0);
    const descriptionGap = classifyDescriptionGap(
      liveDescriptionLen,
      seedStats.description_chars,
      issueSet,
    );
    const tags = buildIssueTags(auditRow, seedStats, descriptionGap);
    return {
      brand: auditRow.brand || manifestEntry?.manifest_brand || seedRow.brand || '',
      title: auditRow.title || seedRow.title || '',
      external_product_id: auditRow.external_product_id || seedRow.external_product_id || '',
      production_url: auditRow.production_url || '',
      canonical_url: seedRow.canonical_url || auditRow.canonical_url || '',
      target_url:
        normalizeTargetUrlForMarket(pickSeedTargetUrl(seedRow), seedRow.market || 'US') ||
        seedRow.canonical_url ||
        '',
      live_price: auditRow.live_price ?? '',
      live_currency: auditRow.live_currency || '',
      live_description_chars: liveDescriptionLen,
      live_variant_count: auditRow.variant_count ?? '',
      live_module_count: auditRow.module_count ?? '',
      live_issue_count: auditRow.issue_count ?? '',
      offers_reason: auditRow.offers_reason || '',
      product_intel_reason: auditRow.product_intel_reason || '',
      product_details_reason: auditRow.product_details_reason || '',
      product_facts_reason: auditRow.product_facts_reason || '',
      active_reason: auditRow.active_reason || '',
      inci_reason: auditRow.inci_reason || '',
      how_to_reason: auditRow.how_to_reason || '',
      seed_description_chars: seedStats.description_chars,
      seed_image_count: seedStats.image_count,
      seed_details_sections_count: seedStats.details_sections_count,
      seed_how_to_use_chars: seedStats.how_to_use_chars,
      seed_faq_count: seedStats.faq_count,
      seed_structured_detail_status: classifyStructuredSeed(seedStats),
      live_description_issue: descriptionGap,
      issue_tags: tags.join('|'),
      manifest_path: manifestEntry?.manifest_path || '',
      probe_classification: '',
      extractor_product_count: '',
      extractor_title: '',
      extractor_canonical_url: '',
      extractor_description_chars: '',
      extractor_details_sections_count: '',
      extractor_how_to_use_chars: '',
      extractor_ingredients_chars: '',
      extractor_image_count: '',
      extractor_discovery_strategy: '',
      extractor_failure_category: '',
      extractor_block_provider: '',
      extractor_http_trace: '',
      probe_error: '',
    };
  });

  const probeCandidates = chooseProbeCandidates(issueRows);
  const issueRowById = new Map(issueRows.map((row) => [row.external_product_id, row]));

  const probeResults = await mapWithConcurrency(probeCandidates, concurrency, async (issueRow) => {
    const manifestEntry = manifestMap.get(issueRow.external_product_id) || null;
    const seedRow = manifestEntry?.row || {};
    const probe = await probeCatalog(seedRow, catalogBaseUrl);
    const merged = { ...issueRow, ...probe };
    issueRowById.set(issueRow.external_product_id, merged);
    return merged;
  });

  const finalRows = issueRows.map((row) => issueRowById.get(row.external_product_id) || row);
  const summary = buildSummary(finalRows, probeResults, artifactSummary);

  const jsonPath = path.join(reportDir, 'k_beauty_pdp_quality_issue_evidence.json');
  const csvPath = path.join(reportDir, 'k_beauty_pdp_quality_issue_evidence.csv');

  writeJson(jsonPath, {
    summary,
    rows: finalRows,
  });
  writeCsv(csvPath, finalRows, [
    'brand',
    'title',
    'external_product_id',
    'production_url',
    'canonical_url',
    'target_url',
    'live_price',
    'live_currency',
    'live_description_chars',
    'seed_description_chars',
    'live_description_issue',
    'seed_structured_detail_status',
    'seed_details_sections_count',
    'seed_how_to_use_chars',
    'seed_faq_count',
    'offers_reason',
    'product_intel_reason',
    'product_details_reason',
    'product_facts_reason',
    'active_reason',
    'inci_reason',
    'how_to_reason',
    'issue_tags',
    'probe_classification',
    'extractor_product_count',
    'extractor_title',
    'extractor_canonical_url',
    'extractor_description_chars',
    'extractor_details_sections_count',
    'extractor_how_to_use_chars',
    'extractor_ingredients_chars',
    'extractor_image_count',
    'extractor_discovery_strategy',
    'extractor_failure_category',
    'extractor_block_provider',
    'probe_error',
    'manifest_path',
  ]);

  updateSummaryJson(reportDir, summary, [
    'k_beauty_pdp_quality_issue_evidence.json',
    'k_beauty_pdp_quality_issue_evidence.csv',
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
