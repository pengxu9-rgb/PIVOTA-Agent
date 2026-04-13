#!/usr/bin/env node

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { closePool } = require('../src/db');
const {
  backfillCatalogServingIndex,
  canSearchCatalogServingIndex,
  getCatalogServingIndexConfig,
} = require('../src/services/catalogServingIndex');
const { searchCatalogServingGateway } = require('../src/services/catalogServingGateway');
const { summarizePdpIdentityCoverageByBrand } = require('../src/services/pdpIdentityGraph');

const SCHEMA_VERSION = 'pivota.catalog_serving.shadow_acceptance.v1';
const DEFAULT_REPORTS_OUT = 'reports';
const DEFAULT_LIMIT = 500;
const DEFAULT_MARKET = 'US';
const DEFAULT_SAMPLE_LIMIT = 5;
const DEFAULT_MIN_PUBLIC_DOCS = 1;
const DEFAULT_MAX_SHADOW_RATIO = 0.95;

function parseArgs(argv) {
  const out = {
    outDir: '',
    inputJson: '',
    limit: '',
    brand: '',
    market: '',
    sampleQuery: '',
    sampleLimit: '',
    minPublicDocs: '',
    maxShadowRatio: '',
    failOnStatus: '',
    blockedReasons: [],
    skipSearch: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === '--skip-search') {
      out.skipSearch = true;
      continue;
    }
    if (!next || next.startsWith('--')) continue;
    if (token === '--out-dir') {
      out.outDir = next;
      index += 1;
      continue;
    }
    if (token === '--input-json') {
      out.inputJson = next;
      index += 1;
      continue;
    }
    if (token === '--limit') {
      out.limit = next;
      index += 1;
      continue;
    }
    if (token === '--brand') {
      out.brand = next;
      index += 1;
      continue;
    }
    if (token === '--market') {
      out.market = next;
      index += 1;
      continue;
    }
    if (token === '--sample-query') {
      out.sampleQuery = next;
      index += 1;
      continue;
    }
    if (token === '--sample-limit') {
      out.sampleLimit = next;
      index += 1;
      continue;
    }
    if (token === '--min-public-docs') {
      out.minPublicDocs = next;
      index += 1;
      continue;
    }
    if (token === '--max-shadow-ratio') {
      out.maxShadowRatio = next;
      index += 1;
      continue;
    }
    if (token === '--fail-on-status') {
      out.failOnStatus = next;
      index += 1;
      continue;
    }
    if (token === '--blocked-reason') {
      out.blockedReasons.push(next);
      index += 1;
    }
  }
  return out;
}

function safeToken(value, fallback = '') {
  const token = String(value == null ? '' : value).trim();
  return token || fallback;
}

function safeNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function uniqStrings(values = [], limit = 32) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : [values]) {
    const normalized = safeToken(value, '');
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

async function readJson(filePath) {
  const raw = await fsp.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

function buildStamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function percent(value) {
  const numeric = safeNumber(value, 0) || 0;
  return `${(numeric * 100).toFixed(1)}%`;
}

function buildMarkdown(report) {
  const backfill = report.backfill || {};
  const searchProbe = report.search_probe || {};
  const representativeSample = report.representative_sample || null;
  return [
    '# Catalog Serving Shadow Acceptance',
    '',
    `- Readiness: **${String(report.readiness_status || 'unknown').toUpperCase()}**`,
    `- Generated at (UTC): ${safeToken(report.generated_at_utc, 'unknown')}`,
    `- Market: ${safeToken(report.requested?.market, DEFAULT_MARKET)}`,
    `- Brand filter: ${safeToken(report.requested?.brand, 'none')}`,
    '',
    '## Backfill Summary',
    '',
    `- Sample scope: ${safeToken(report.backfill_sample_scope, 'default')}`,
    `- Source rows scanned: ${safeNumber(backfill.source_rows_scanned, 0) || 0}`,
    `- Live identity rows: ${safeNumber(backfill.live_identity_rows, 0) || 0}`,
    `- Docs built: ${safeNumber(backfill.docs_built, 0) || 0}`,
    `- Public docs built: ${safeNumber(backfill.public_docs_built, 0) || 0}`,
    `- Non-public docs built: ${safeNumber(backfill.non_public_docs_built, 0) || 0}`,
    `- Shadow ratio: ${percent(report.shadow_ratio)}`,
    '',
    ...(representativeSample
      ? [
          '## Representative Retry',
          '',
          `- Brand: ${safeToken(representativeSample.brand, 'unknown')}`,
          `- Candidate rank: ${safeNumber(representativeSample.candidate_rank, 0) || 0}`,
          `- Public docs built: ${safeNumber(representativeSample.backfill?.public_docs_built, 0) || 0}`,
          '',
        ]
      : []),
    '## Search Probe',
    '',
    `- Status: ${safeToken(searchProbe.status, 'unknown')}`,
    `- Source: ${safeToken(searchProbe.source, 'n/a')}`,
    `- Returned: ${safeNumber(searchProbe.returned, 0) || 0}`,
    `- Has next page: ${searchProbe.has_next_page === true ? 'yes' : 'no'}`,
    '',
    ...(Array.isArray(report.blocked_reasons) && report.blocked_reasons.length
      ? [
          '## Blockers',
          '',
          ...report.blocked_reasons.map((line) => (line.startsWith('- ') ? line : `- ${line}`)),
          '',
        ]
      : []),
    ...((Array.isArray(report.prerequisites) && report.prerequisites.length
      ? [
          '## Prerequisites',
          '',
          ...report.prerequisites.map((line) => (line.startsWith('- ') ? line : `- ${line}`)),
          '',
        ]
      : [])),
    ...['## Notes', ''],
    ...((Array.isArray(report.notes) && report.notes.length
      ? report.notes
      : ['- No additional notes.']).map((line) => (line.startsWith('- ') ? line : `- ${line}`))),
    '',
  ].join('\n');
}

function evaluateReadiness(report, thresholds) {
  const notes = [];
  const backfill = report.backfill || {};
  const searchProbe = report.search_probe || {};

  if (report.blocked === true || (Array.isArray(report.blocked_reasons) && report.blocked_reasons.length)) {
    notes.push(...(Array.isArray(report.blocked_reasons) ? report.blocked_reasons : []));
    return { status: 'red', notes };
  }

  if ((safeNumber(backfill.docs_built, 0) || 0) <= 0) {
    notes.push('No serving docs were built from the current backfill sample.');
    return { status: 'red', notes };
  }

  if ((safeNumber(backfill.public_docs_built, 0) || 0) < thresholds.minPublicDocs) {
    notes.push(
      `Public docs built (${safeNumber(backfill.public_docs_built, 0) || 0}) is below threshold (${thresholds.minPublicDocs}).`,
    );
    return { status: 'red', notes };
  }

  if ((safeNumber(report.shadow_ratio, 0) || 0) > thresholds.maxShadowRatio) {
    notes.push(
      `Shadow ratio ${percent(report.shadow_ratio)} exceeds threshold ${percent(thresholds.maxShadowRatio)}.`,
    );
    return { status: 'yellow', notes };
  }

  if (searchProbe.status === 'error') {
    notes.push(`Catalog serving search probe failed: ${safeToken(searchProbe.error, 'unknown error')}.`);
    return { status: 'yellow', notes };
  }

  if (searchProbe.status === 'ok' && safeToken(searchProbe.source, '') === 'local_shadow') {
    notes.push('Catalog serving local shadow probe passed, but the external OpenSearch-compatible index is still disabled.');
    return { status: 'yellow', notes };
  }

  if (searchProbe.status === 'disabled' || searchProbe.status === 'skipped') {
    notes.push('Catalog serving index probe was skipped or disabled; backfill sample passed.');
    return { status: 'yellow', notes };
  }

  if ((safeNumber(searchProbe.returned, 0) || 0) <= 0) {
    notes.push('Catalog serving search probe returned zero items.');
    return { status: 'yellow', notes };
  }

  notes.push('Backfill sample and index probe passed baseline readiness checks.');
  return { status: 'green', notes };
}

function statusSeverity(status) {
  const normalized = safeToken(status, '').toLowerCase();
  if (normalized === 'red') return 2;
  if (normalized === 'yellow') return 1;
  return 0;
}

function sortRepresentativeBrands(rows = []) {
  return [...(Array.isArray(rows) ? rows : [])].sort((left, right) => {
    const liveDelta = (safeNumber(right?.live_rows, 0) || 0) - (safeNumber(left?.live_rows, 0) || 0);
    if (liveDelta !== 0) return liveDelta;
    const reviewDelta =
      (safeNumber(left?.review_ratio, 1) || 0) - (safeNumber(right?.review_ratio, 1) || 0);
    if (reviewDelta !== 0) return reviewDelta;
    return safeToken(left?.brand_norm, '').localeCompare(safeToken(right?.brand_norm, ''));
  });
}

function shouldRetryRepresentativeSample(backfill = {}) {
  const publicDocsBuilt = safeNumber(backfill?.public_docs_built, 0) || 0;
  const liveIdentityRows = safeNumber(backfill?.live_identity_rows, 0) || 0;
  return publicDocsBuilt <= 1 || liveIdentityRows <= 1;
}

async function listRepresentativeLiveBrands({ queryFn, summarizeFn = summarizePdpIdentityCoverageByBrand } = {}) {
  const summary = await summarizeFn({
    limit: 100,
    minSourceRows: 1,
    beautyOnly: false,
    ...(typeof queryFn === 'function' ? { queryFn } : {}),
  });
  return sortRepresentativeBrands(summary)
    .filter((row) => (safeNumber(row?.live_rows, 0) || 0) > 0)
    .map((row) => safeToken(row?.brand_norm, ''))
    .filter(Boolean)
    .slice(0, 10);
}

async function collectRuntimeSummary(
  options,
  {
    backfillCatalogServingIndexFn = backfillCatalogServingIndex,
    getCatalogServingIndexConfigFn = getCatalogServingIndexConfig,
    searchCatalogServingGatewayFn = searchCatalogServingGateway,
    summarizeCoverageFn = summarizePdpIdentityCoverageByBrand,
  } = {},
) {
  const limit = Math.max(1, Math.min(5000, safeNumber(options.limit, DEFAULT_LIMIT) || DEFAULT_LIMIT));
  const brand = safeToken(options.brand, '') || null;
  const market = safeToken(options.market, DEFAULT_MARKET) || DEFAULT_MARKET;
  const sampleQuery = safeToken(options.sampleQuery, brand || 'serum');
  const sampleLimit = Math.max(1, Math.min(20, safeNumber(options.sampleLimit, DEFAULT_SAMPLE_LIMIT) || DEFAULT_SAMPLE_LIMIT));
  const config = getCatalogServingIndexConfigFn(process.env);
  const initialBackfill = await backfillCatalogServingIndexFn({
    limit,
    brand,
    market,
    dryRun: true,
    includeNonPublic: true,
  });
  let backfill = initialBackfill;
  let representativeSample = null;
  let backfillSampleScope = brand ? 'brand_filter' : 'global_recent';

  if (!brand && shouldRetryRepresentativeSample(initialBackfill)) {
    const candidateBrands = await listRepresentativeLiveBrands({
      summarizeFn: summarizeCoverageFn,
    });
    for (let index = 0; index < candidateBrands.length; index += 1) {
      const candidateBrand = candidateBrands[index];
      const candidateBackfill = await backfillCatalogServingIndexFn({
        limit,
        brand: candidateBrand,
        market,
        dryRun: true,
        includeNonPublic: true,
      });
      representativeSample = {
        brand: candidateBrand,
        candidate_rank: index + 1,
        backfill: candidateBackfill,
      };
      if ((safeNumber(candidateBackfill?.public_docs_built, 0) || 0) > 0) {
        backfill = candidateBackfill;
        backfillSampleScope = 'representative_brand_retry';
        break;
      }
    }
  }

  const localShadowProbeEnabled = canSearchCatalogServingIndex(process.env, { allowLocalShadow: true });
  const requestedShadowMode = config.enabled ? 'external_only' : 'allow_local_shadow';
  let searchProbe = {
    status: options.skipSearch ? 'skipped' : localShadowProbeEnabled ? 'pending' : 'disabled',
    source: config.enabled ? 'opensearch_compatible' : localShadowProbeEnabled ? 'local_shadow' : 'disabled',
    shadow_mode: requestedShadowMode,
    returned: 0,
    has_next_page: false,
  };
  if (!options.skipSearch && localShadowProbeEnabled) {
    try {
      const response = await searchCatalogServingGatewayFn({
        query_text: sampleQuery,
        market,
        limit: sampleLimit,
        shadow_mode: requestedShadowMode,
      });
      searchProbe = {
        status: 'ok',
        source: safeToken(response?.source, 'opensearch_compatible'),
        returned: Array.isArray(response?.items) ? response.items.length : 0,
        has_next_page: response?.cursor_info?.has_next_page === true,
        shadow_mode: safeToken(response?.shadow_mode, requestedShadowMode),
      };
    } catch (err) {
      searchProbe = {
        status: 'error',
        source: 'opensearch_compatible',
        returned: 0,
        has_next_page: false,
        shadow_mode: requestedShadowMode,
        error: err?.message || String(err),
      };
    }
  }

  return {
    schema_version: SCHEMA_VERSION,
    generated_at_utc: new Date().toISOString(),
    requested: {
      limit,
      brand,
      market,
      sample_query: sampleQuery,
      sample_limit: sampleLimit,
      skip_search: options.skipSearch === true,
    },
    index_config: {
      enabled: config.enabled,
      index_name: config.index_name || null,
      shadow_read_enabled: config.shadow_read_enabled === true,
    },
    backfill,
    initial_backfill: representativeSample ? initialBackfill : undefined,
    representative_sample: representativeSample,
    backfill_sample_scope: backfillSampleScope,
    search_probe: searchProbe,
  };
}

function buildBlockedSummary(args, reasons = []) {
  const brand = safeToken(args.brand, '') || null;
  const market = safeToken(args.market, DEFAULT_MARKET) || DEFAULT_MARKET;
  const sampleQuery = safeToken(args.sampleQuery, brand || 'serum');
  const sampleLimit = Math.max(1, Math.min(20, safeNumber(args.sampleLimit, DEFAULT_SAMPLE_LIMIT) || DEFAULT_SAMPLE_LIMIT));
  const limit = Math.max(1, Math.min(5000, safeNumber(args.limit, DEFAULT_LIMIT) || DEFAULT_LIMIT));
  const config = getCatalogServingIndexConfig(process.env);
  return {
    schema_version: SCHEMA_VERSION,
    generated_at_utc: new Date().toISOString(),
    blocked: true,
    blocked_reasons: uniqStrings(reasons, 16),
    prerequisites: [
      'Set GitHub Actions secret DATABASE_URL so the workflow can build a shadow backfill sample.',
      'Set CATALOG_SERVING_INDEX_BASE_URL to enable the OpenSearch-compatible probe.',
      'Set CATALOG_SERVING_INDEX_API_KEY if the serving index requires authenticated reads.',
    ],
    requested: {
      limit,
      brand,
      market,
      sample_query: sampleQuery,
      sample_limit: sampleLimit,
      skip_search: args.skipSearch === true,
    },
    index_config: {
      enabled: config.enabled,
      index_name: config.index_name || null,
      shadow_read_enabled: config.shadow_read_enabled === true,
    },
    backfill: {
      source_rows_scanned: 0,
      live_identity_rows: 0,
      docs_built: 0,
      public_docs_built: 0,
      non_public_docs_built: 0,
    },
    search_probe: {
      status: 'blocked',
      source: config.enabled ? 'opensearch_compatible' : 'disabled',
      returned: 0,
      has_next_page: false,
    },
  };
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const outDir = path.resolve(safeToken(args.outDir, DEFAULT_REPORTS_OUT));
    const summary =
      Array.isArray(args.blockedReasons) && args.blockedReasons.length
        ? buildBlockedSummary(args, args.blockedReasons)
        : safeToken(args.inputJson, '')
        ? await readJson(path.resolve(args.inputJson))
        : await collectRuntimeSummary(args);

    const docsBuilt = safeNumber(summary?.backfill?.docs_built, 0) || 0;
    const nonPublicDocs = safeNumber(summary?.backfill?.non_public_docs_built, 0) || 0;
    const shadowRatio = docsBuilt > 0 ? Number((nonPublicDocs / docsBuilt).toFixed(4)) : 1;
    const thresholds = {
      minPublicDocs: Math.max(0, safeNumber(args.minPublicDocs, DEFAULT_MIN_PUBLIC_DOCS) || DEFAULT_MIN_PUBLIC_DOCS),
      maxShadowRatio: Math.max(0, Math.min(1, safeNumber(args.maxShadowRatio, DEFAULT_MAX_SHADOW_RATIO) || DEFAULT_MAX_SHADOW_RATIO)),
    };
    const failOnStatus = safeToken(args.failOnStatus, '').toLowerCase();
    const readiness = evaluateReadiness(
      {
        ...summary,
        shadow_ratio: shadowRatio,
      },
      thresholds,
    );
    const report = {
      ...summary,
      shadow_ratio: shadowRatio,
      thresholds,
      fail_on_status: failOnStatus || null,
      readiness_status: readiness.status,
      notes: readiness.notes,
    };

    await fsp.mkdir(outDir, { recursive: true });
    const stamp = buildStamp();
    const jsonPath = path.join(outDir, `catalog_serving_shadow_acceptance_${stamp}.json`);
    const markdownPath = path.join(outDir, `catalog_serving_shadow_acceptance_${stamp}.md`);
    await fsp.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await fsp.writeFile(markdownPath, `${buildMarkdown(report)}\n`, 'utf8');

    process.stdout.write(
      `${JSON.stringify(
        {
          schema_version: SCHEMA_VERSION,
          readiness_status: report.readiness_status,
          json_path: jsonPath,
          markdown_path: markdownPath,
          fail_on_status: report.fail_on_status,
        },
        null,
        2,
      )}\n`,
    );

    if (failOnStatus && statusSeverity(report.readiness_status) >= statusSeverity(failOnStatus)) {
      process.exitCode = 1;
    }
  } finally {
    await closePool().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((err) => {
    const payload = {
      schema_version: SCHEMA_VERSION,
      readiness_status: 'red',
      error: err?.message || String(err),
      host: os.hostname(),
    };
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildMarkdown,
  buildBlockedSummary,
  collectRuntimeSummary,
  evaluateReadiness,
  listRepresentativeLiveBrands,
  shouldRetryRepresentativeSample,
  statusSeverity,
};
