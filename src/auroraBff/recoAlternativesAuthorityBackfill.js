const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const axios = require('axios');

const { getPool, query } = require('../db');
const {
  fetchBrandCatalog,
  buildManifestFromExtract,
  buildManifestFromSourceAttempts,
  computeExtractLimit,
} = require('../../scripts/build_beauty_brand_external_seed_manifest.cjs');
const {
  processManifestWithDb,
  processManifestWithoutDb,
  summarizeResults: summarizeSeedApplyResults,
  buildCorrectionFollowups,
} = require('../../scripts/apply_aurora_external_seed_creation_manifest.cjs');
const {
  fetchRows: fetchRecallRows,
  processRow: processRecallRow,
  summarizeResults: summarizeRecallRefreshResults,
} = require('../../scripts/backfill-external-seed-recall-docs.js');
const { auditExternalSeedRow, summarizeAuditResults } = require('../services/externalSeedContentAudit');
const { auditRow: auditExternalSeedPdpQualityRow, resolveGatewayUrl: resolveQualityGatewayUrl } = require('../../scripts/audit-external-product-pdp-quality.js');
const { runCoverageBatch: runPivotaInsightsCoverageBatch } = require('../../scripts/pivota_insights_coverage_batch.js');

const ASYNC_BACKFILL_ENABLED =
  String(process.env.AURORA_RECO_ALTERNATIVES_ASYNC_BACKFILL_ENABLED || 'true').trim().toLowerCase() !== 'false';
const ASYNC_BACKFILL_APPLY_ENABLED =
  String(process.env.AURORA_RECO_ALTERNATIVES_ASYNC_BACKFILL_APPLY_ENABLED || 'true').trim().toLowerCase() !== 'false';
const ASYNC_BACKFILL_MARKET =
  String(process.env.AURORA_RECO_ALTERNATIVES_ASYNC_BACKFILL_MARKET || 'US').trim().toUpperCase() || 'US';
const ASYNC_BACKFILL_BRAND_LIMIT = Math.max(
  1,
  Math.min(12, Number(process.env.AURORA_RECO_ALTERNATIVES_ASYNC_BACKFILL_BRAND_LIMIT || 4) || 4),
);
const ASYNC_BACKFILL_TITLE_LIMIT = Math.max(
  1,
  Math.min(16, Number(process.env.AURORA_RECO_ALTERNATIVES_ASYNC_BACKFILL_TITLE_LIMIT || 6) || 6),
);
const ASYNC_BACKFILL_MANIFEST_LIMIT = Math.max(
  20,
  Math.min(400, Number(process.env.AURORA_RECO_ALTERNATIVES_ASYNC_BACKFILL_MANIFEST_LIMIT || 120) || 120),
);
const ASYNC_BACKFILL_SOURCE_DISCOVERY_ENABLED =
  String(process.env.AURORA_RECO_ALTERNATIVES_ASYNC_BACKFILL_SOURCE_DISCOVERY_ENABLED || 'true').trim().toLowerCase() !== 'false';
const ASYNC_BACKFILL_SOURCE_DISCOVERY_TIMEOUT_MS = Math.max(
  1000,
  Math.min(15000, Number(process.env.AURORA_RECO_ALTERNATIVES_ASYNC_BACKFILL_SOURCE_DISCOVERY_TIMEOUT_MS || 5000) || 5000),
);
const ASYNC_BACKFILL_POST_ENRICHMENT_ENABLED =
  String(process.env.AURORA_RECO_ALTERNATIVES_ASYNC_BACKFILL_POST_ENRICHMENT_ENABLED || 'true').trim().toLowerCase() !== 'false';
const ASYNC_BACKFILL_PIVOTA_INSIGHTS_ENABLED =
  String(process.env.AURORA_RECO_ALTERNATIVES_ASYNC_BACKFILL_PIVOTA_INSIGHTS_ENABLED || 'true').trim().toLowerCase() !== 'false';
const ASYNC_BACKFILL_PIVOTA_INSIGHTS_MODEL =
  String(
    process.env.AURORA_RECO_ALTERNATIVES_ASYNC_BACKFILL_PIVOTA_INSIGHTS_MODEL ||
      process.env.PIVOTA_PRODUCT_INTEL_MODEL ||
      'gemini-3-flash-preview',
  ).trim() || 'gemini-3-flash-preview';
const ASYNC_BACKFILL_PIVOTA_INSIGHTS_MAX_PRODUCTS = Math.max(
  1,
  Math.min(12, Number(process.env.AURORA_RECO_ALTERNATIVES_ASYNC_BACKFILL_PIVOTA_INSIGHTS_MAX_PRODUCTS || 6) || 6),
);
const ASYNC_BACKFILL_COOLDOWN_MS = Math.max(
  10 * 1000,
  Math.min(24 * 60 * 60 * 1000, Number(process.env.AURORA_RECO_ALTERNATIVES_ASYNC_BACKFILL_COOLDOWN_MS || 30 * 60 * 1000) || 30 * 60 * 1000),
);
const HISTORY_LIMIT = Math.max(10, Math.min(200, Number(process.env.AURORA_RECO_ALTERNATIVES_ASYNC_BACKFILL_HISTORY_LIMIT || 60) || 60));
const OUT_DIR = String(
  process.env.AURORA_RECO_ALTERNATIVES_ASYNC_BACKFILL_OUT_DIR ||
    path.join(os.tmpdir(), 'aurora_reco_alternatives_backfill'),
).trim();

const state = {
  cooldownUntilMs: new Map(),
  inFlight: new Map(),
  history: [],
  runnerOverride: null,
  sourcePlanResolverOverride: null,
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pickFirstTrimmed(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

function normalizeBrand(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeBrandCompact(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function buildBrandLookupVariants(value) {
  const normalized = normalizeBrand(value);
  const compact = normalizeBrandCompact(value);
  const withoutAnd = normalized.replace(/\band\b/g, ' ').replace(/\s+/g, ' ').trim();
  const compactWithoutAnd = withoutAnd.replace(/\s+/g, '');
  return {
    exact: uniqueStrings([String(value || '').trim().toLowerCase()].filter(Boolean), 6),
    loose: uniqueStrings([normalized, withoutAnd].filter(Boolean), 6),
    compact: uniqueStrings([compact, compactWithoutAnd].filter(Boolean), 6),
  };
}

function buildBrandDomainGuessCandidates(brand, market = ASYNC_BACKFILL_MARKET) {
  const normalized = normalizeBrand(brand);
  const compact = normalizeBrandCompact(brand);
  const hyphenated = normalized.replace(/\s+/g, '-');
  const candidates = [];
  for (const host of [compact, hyphenated]) {
    const safeHost = String(host || '').trim().replace(/^-+|-+$/g, '');
    if (!safeHost) continue;
    candidates.push(`https://${safeHost}.com`);
    candidates.push(`https://www.${safeHost}.com`);
    if (String(market || '').trim().toUpperCase() === 'US') {
      candidates.push(`https://${safeHost}.us`);
      candidates.push(`https://www.${safeHost}.us`);
    }
  }
  return uniqueStrings(candidates, 8);
}

function getAxiosResponseUrl(resp) {
  return pickFirstTrimmed(
    resp?.request?.res?.responseUrl,
    resp?.request?._redirectable?._currentUrl,
    resp?.config?.url,
  );
}

async function discoverBrandSourcePlanByGuess({ brand, market = ASYNC_BACKFILL_MARKET, logger } = {}) {
  if (!ASYNC_BACKFILL_SOURCE_DISCOVERY_ENABLED) {
    return { ok: false, reason: 'source_discovery_disabled', primaryDomain: '', fallbackDomains: [] };
  }
  const compactBrand = normalizeBrandCompact(brand);
  if (!compactBrand) {
    return { ok: false, reason: 'brand_missing', primaryDomain: '', fallbackDomains: [] };
  }
  const candidates = buildBrandDomainGuessCandidates(brand, market);
  for (const candidateUrl of candidates) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const resp = await axios.get(candidateUrl, {
        timeout: ASYNC_BACKFILL_SOURCE_DISCOVERY_TIMEOUT_MS,
        maxRedirects: 5,
        responseType: 'text',
        validateStatus: (status) => Number.isFinite(Number(status)) && Number(status) >= 200 && Number(status) < 400,
        headers: {
          'User-Agent': 'AuroraRecoAlternativesAuthorityBackfill/1.0',
          Accept: 'text/html,application/xhtml+xml',
        },
      });
      const resolvedUrl = getAxiosResponseUrl(resp);
      const parsed = new URL(resolvedUrl || candidateUrl);
      const hostCompact = normalizeBrandCompact(parsed.hostname.replace(/^www\./i, ''));
      if (!hostCompact) continue;
      if (!hostCompact.includes(compactBrand) && !compactBrand.includes(hostCompact)) continue;
      return {
        ok: true,
        primaryDomain: `${parsed.protocol}//${parsed.host}`.replace(/\/+$/, ''),
        primaryRole: 'guessed_official',
        fallbackDomains: [],
      };
    } catch (err) {
      logger?.debug?.(
        {
          err: err?.message || String(err),
          brand,
          candidate_url: candidateUrl,
        },
        'aurora bff: alternatives authority backfill source guess failed',
      );
    }
  }
  return { ok: false, reason: 'no_domain_guess_match', primaryDomain: '', fallbackDomains: [] };
}

function normalizeTitle(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
}

function ensureHttpUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) return text.replace(/\/+$/, '');
  return `https://${text.replace(/^\/+/, '').replace(/\/+$/, '')}`;
}

function uniqueStrings(values, limit = 24) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const text = String(raw || '').trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function looksLikeRelationMissing(err) {
  const message = String(err?.message || err || '').toLowerCase();
  return message.includes('does not exist') || message.includes('undefined table');
}

function buildBackfillJobKey({ brand, market }) {
  return `${normalizeBrand(brand)}|${String(market || ASYNC_BACKFILL_MARKET).trim().toUpperCase() || ASYNC_BACKFILL_MARKET}`;
}

function canEnqueueJob(jobKey, nowMs = Date.now()) {
  if (!jobKey) return false;
  if (state.inFlight.has(jobKey)) return false;
  const cooldownUntil = Number(state.cooldownUntilMs.get(jobKey) || 0);
  return cooldownUntil <= nowMs;
}

function markCooldown(jobKey, nowMs = Date.now()) {
  if (!jobKey) return;
  state.cooldownUntilMs.set(jobKey, nowMs + ASYNC_BACKFILL_COOLDOWN_MS);
}

function recordHistory(entry) {
  state.history.push({
    recorded_at: new Date().toISOString(),
    ...(isPlainObject(entry) ? entry : {}),
  });
  while (state.history.length > HISTORY_LIMIT) state.history.shift();
}

function buildCoverageGroups(rows, market = ASYNC_BACKFILL_MARKET) {
  const openWorldRows = [];
  const coverageRows = [];
  const recallRows = [];
  const grouped = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const origin = String(row?.candidate_origin || '').trim().toLowerCase();
    if (origin !== 'open_world') continue;
    openWorldRows.push(row);
    const metadata = isPlainObject(row?.metadata) ? row.metadata : {};
    const groundingStatus = String(row?.grounding_status || '').trim().toLowerCase();
    const failureClass = String(metadata.grounding_failure_class || '').trim().toLowerCase();
    if (groundingStatus === 'catalog_verified' && !failureClass) continue;
    const product = isPlainObject(row?.product) ? row.product : {};
    const brand = pickFirstTrimmed(product.brand, row?.brand);
    const name = normalizeTitle(pickFirstTrimmed(product.display_name, product.displayName, product.name, row?.name));
    if (!brand || !name) continue;
    if (failureClass === 'recall_miss') {
      recallRows.push(row);
      continue;
    }
    coverageRows.push(row);
    const key = buildBackfillJobKey({ brand, market });
    const current = grouped.get(key) || {
      brand,
      market,
      preferredTitles: [],
      rows: [],
    };
    current.rows.push(row);
    current.preferredTitles = uniqueStrings([...current.preferredTitles, name], ASYNC_BACKFILL_TITLE_LIMIT);
    grouped.set(key, current);
  }
  return {
    open_world_row_count: openWorldRows.length,
    coverage_gap_count: coverageRows.length,
    recall_gap_count: recallRows.length,
    groups: Array.from(grouped.values()).slice(0, ASYNC_BACKFILL_BRAND_LIMIT),
  };
}

async function resolveBrandSourcePlanDefault({ brand, market = ASYNC_BACKFILL_MARKET, logger = null } = {}) {
  if (!getPool()) {
    return { ok: false, reason: 'no_database', primaryDomain: '', fallbackDomains: [] };
  }
  const brandVariants = buildBrandLookupVariants(brand);
  if (!brandVariants.loose.length && !brandVariants.compact.length && !brandVariants.exact.length) {
    return { ok: false, reason: 'brand_missing', primaryDomain: '', fallbackDomains: [] };
  }

  const primaryCandidates = [];
  const fallbackCandidates = [];

  try {
    const identityRes = await query(
      `
        SELECT official_domain
        FROM pdp_identity_listing
        WHERE (
          lower(trim(coalesce(brand_norm, ''))) = ANY($1::text[])
          OR trim(regexp_replace(lower(coalesce(brand_norm, '')), '[^a-z0-9]+', ' ', 'g')) = ANY($2::text[])
          OR regexp_replace(lower(coalesce(brand_norm, '')), '[^a-z0-9]+', '', 'g') = ANY($3::text[])
        )
          AND coalesce(official_domain, '') <> ''
        ORDER BY
          CASE WHEN source_tier = 'brand' THEN 0 ELSE 1 END,
          CASE WHEN live_read_enabled = true THEN 0 ELSE 1 END,
          identity_confidence DESC NULLS LAST,
          updated_at DESC NULLS LAST,
          created_at DESC NULLS LAST
        LIMIT 4
      `,
      [brandVariants.exact, brandVariants.loose, brandVariants.compact],
    );
    for (const row of Array.isArray(identityRes?.rows) ? identityRes.rows : []) {
      const domain = ensureHttpUrl(row?.official_domain);
      if (domain) primaryCandidates.push(domain);
    }
  } catch (err) {
    if (!looksLikeRelationMissing(err)) {
      return { ok: false, reason: 'source_lookup_error', error: err?.message || String(err), primaryDomain: '', fallbackDomains: [] };
    }
  }

  try {
    const externalRes = await query(
      `
        SELECT
          domain,
          seed_data #>> '{authority_source,source_role}' AS source_role,
          seed_data #>> '{authority_source,source_url}' AS source_url
        FROM external_product_seeds
        WHERE status = 'active'
          AND attached_product_key IS NULL
          AND market = $2
          AND (
            lower(trim(coalesce(seed_data->>'brand', seed_data->'snapshot'->>'brand', ''))) = ANY($1::text[])
            OR trim(regexp_replace(lower(coalesce(seed_data->>'brand', seed_data->'snapshot'->>'brand', '')), '[^a-z0-9]+', ' ', 'g')) = ANY($3::text[])
            OR regexp_replace(lower(coalesce(seed_data->>'brand', seed_data->'snapshot'->>'brand', '')), '[^a-z0-9]+', '', 'g') = ANY($4::text[])
          )
          AND coalesce(domain, '') <> ''
        ORDER BY
          CASE WHEN coalesce(seed_data #>> '{authority_source,source_role}', '') = 'primary' THEN 0 ELSE 1 END,
          updated_at DESC NULLS LAST,
          created_at DESC NULLS LAST
        LIMIT 8
      `,
      [
        brandVariants.exact,
        String(market || ASYNC_BACKFILL_MARKET).trim().toUpperCase() || ASYNC_BACKFILL_MARKET,
        brandVariants.loose,
        brandVariants.compact,
      ],
    );
    for (const row of Array.isArray(externalRes?.rows) ? externalRes.rows : []) {
      const sourceUrl = ensureHttpUrl(pickFirstTrimmed(row?.source_url, row?.domain));
      if (!sourceUrl) continue;
      const sourceRole = String(row?.source_role || '').trim().toLowerCase();
      if (sourceRole === 'primary') primaryCandidates.push(sourceUrl);
      else fallbackCandidates.push(sourceUrl);
    }
  } catch (err) {
    if (!looksLikeRelationMissing(err)) {
      return { ok: false, reason: 'source_lookup_error', error: err?.message || String(err), primaryDomain: '', fallbackDomains: [] };
    }
  }

  const uniquePrimary = uniqueStrings(primaryCandidates, 4);
  const uniqueFallback = uniqueStrings(
    fallbackCandidates.filter((domain) => !uniquePrimary.some((primary) => primary.toLowerCase() === domain.toLowerCase())),
    8,
  );

  const primaryDomain = uniquePrimary[0] || uniqueFallback[0] || '';
  const primaryRole = uniquePrimary[0] ? 'primary' : uniqueFallback[0] ? 'secondary_fallback' : '';
  const fallbackDomains = uniquePrimary[0]
    ? uniqueFallback
    : uniqueFallback.slice(1);
  if (!primaryDomain) {
    return discoverBrandSourcePlanByGuess({ brand, market, logger });
  }
  return {
    ok: true,
    primaryDomain,
    primaryRole,
    fallbackDomains,
  };
}

function buildEmptySourceManifest({ brand, domain, market, preferredTitles, sourceRole, err }) {
  return {
    generated_at: new Date().toISOString(),
    brand,
    domain,
    source_url: domain,
    source_role: sourceRole,
    market,
    preferred_titles: uniqueStrings(preferredTitles, 24),
    matched_preferred_titles: [],
    extracted_product_count: 0,
    excluded_bundle_like_count: 0,
    matched_preferred_title_count: 0,
    diagnostics_summary: {
      discovery_strategy: null,
      failure_category: pickFirstTrimmed(err?.code, 'extract_error') || 'extract_error',
      block_provider: null,
    },
    item_count: 0,
    items: [],
  };
}

function ensureOutDir() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  return OUT_DIR;
}

async function fetchSeedRowsByIds({ seedIds, market }) {
  const normalizedSeedIds = uniqueStrings(seedIds, 200);
  if (!normalizedSeedIds.length || !getPool()) return [];
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
        image_url,
        price_amount,
        price_currency,
        availability,
        seed_data,
        status,
        updated_at,
        created_at
      FROM external_product_seeds
      WHERE id::text = ANY($1::text[])
        AND market = $2
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
    `,
    [normalizedSeedIds, String(market || ASYNC_BACKFILL_MARKET).trim().toUpperCase() || ASYNC_BACKFILL_MARKET],
  );
  return Array.isArray(res?.rows) ? res.rows : [];
}

function writeJson(outPath, doc) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
}

function countAuditFindingsBySeverity(findings = []) {
  return (Array.isArray(findings) ? findings : []).reduce(
    (acc, finding) => {
      const severity = String(finding?.severity || '').trim().toLowerCase();
      if (severity === 'blocker') acc.blocker += 1;
      else if (severity === 'review') acc.review += 1;
      else acc.info += 1;
      return acc;
    },
    { blocker: 0, review: 0, info: 0 },
  );
}

function countByString(values = []) {
  return (Array.isArray(values) ? values : []).reduce((acc, value) => {
    const key = String(value || '').trim();
    if (!key) return acc;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function hasBlockingSeedAuditFindings(result = {}) {
  return (Array.isArray(result?.findings) ? result.findings : []).some((finding) => {
    const severity = String(finding?.severity || '').trim().toLowerCase();
    return severity === 'blocker' || severity === 'review';
  });
}

async function runPostApplyEnrichmentDefault({
  jobDir,
  brand,
  market,
  appliedSeedIds,
  logger,
} = {}) {
  const baseReport = {
    status: 'not_needed',
    eligible_seed_ids: [],
    eligible_external_product_ids: [],
    remaining_followups: [],
    seed_content_audit: null,
    live_pdp_quality: null,
    pivota_insights: null,
  };
  if (!ASYNC_BACKFILL_POST_ENRICHMENT_ENABLED) {
    return {
      ...baseReport,
      status: 'skipped_disabled',
    };
  }
  if (!Array.isArray(appliedSeedIds) || !appliedSeedIds.length) {
    return {
      ...baseReport,
      status: 'skipped_no_applied_seeds',
    };
  }

  const seedRows = await fetchSeedRowsByIds({ seedIds: appliedSeedIds, market });
  if (!seedRows.length) {
    return {
      ...baseReport,
      status: 'skipped_missing_seed_rows',
    };
  }

  const seedAuditResults = seedRows.map((row) => auditExternalSeedRow(row));
  const seedAuditSummary = summarizeAuditResults(seedAuditResults);
  const seedAuditBlocked = [];
  const seedAuditPassedRows = [];
  seedAuditResults.forEach((result, index) => {
    const row = seedRows[index];
    const findingCounts = countAuditFindingsBySeverity(result?.findings);
    const seedId = pickFirstTrimmed(row?.id);
    const externalProductId = pickFirstTrimmed(row?.external_product_id);
    if (hasBlockingSeedAuditFindings(result)) {
      seedAuditBlocked.push({
        seed_id: seedId,
        external_product_id: externalProductId,
        finding_counts: findingCounts,
        anomaly_types: uniqueStrings((result?.findings || []).map((finding) => pickFirstTrimmed(finding?.anomaly_type)), 24),
      });
    } else {
      seedAuditPassedRows.push(row);
    }
  });
  const seedAuditReport = {
    generated_at: new Date().toISOString(),
    brand,
    market,
    scanned_seed_count: seedRows.length,
    passed_seed_ids: seedAuditPassedRows.map((row) => pickFirstTrimmed(row?.id)).filter(Boolean),
    blocked_rows: seedAuditBlocked,
    summary: seedAuditSummary,
  };
  const seedAuditPath = path.join(jobDir, 'seed-content-audit.json');
  writeJson(seedAuditPath, seedAuditReport);

  const livePdpResults = [];
  for (const row of seedAuditPassedRows) {
    try {
      // eslint-disable-next-line no-await-in-loop
      livePdpResults.push(
        await auditExternalSeedPdpQualityRow(row, {
          catalogBaseUrl:
            process.env.CATALOG_INTELLIGENCE_BASE_URL ||
            'https://pivota-catalog-intelligence-production.up.railway.app',
          gatewayUrl: resolveQualityGatewayUrl(
            process.env.PIVOTA_GATEWAY_URL ||
              process.env.EXTERNAL_PDP_QUALITY_GATEWAY_URL ||
              process.env.PDP_SMOKE_GATEWAY,
          ),
        }),
      );
    } catch (err) {
      logger?.warn?.(
        {
          err: err?.message || String(err),
          brand,
          seed_id: pickFirstTrimmed(row?.id),
        },
        'aurora bff: alternatives authority backfill live PDP quality failed',
      );
      livePdpResults.push({
        seed_id: pickFirstTrimmed(row?.id),
        external_product_id: pickFirstTrimmed(row?.external_product_id),
        canonical_url: pickFirstTrimmed(row?.canonical_url),
        seed_gate: { status: 'passed', findings_count: 0, blockers_count: 0 },
        extractor_gate: { status: 'failed', failure_reasons: ['live_pdp_quality_exception'] },
        live_pdp_gate: { status: 'failed', failure_reasons: ['live_pdp_quality_exception'] },
        similar_gate: { status: 'failed', failure_reasons: ['live_pdp_quality_exception'] },
        failure_reasons: ['live_pdp_quality_exception'],
      });
    }
  }
  const livePdpBlocked = livePdpResults
    .filter((result) => Array.isArray(result?.failure_reasons) && result.failure_reasons.length > 0)
    .map((result) => ({
      seed_id: pickFirstTrimmed(result?.seed_id),
      external_product_id: pickFirstTrimmed(result?.external_product_id),
      failure_reasons: uniqueStrings(result?.failure_reasons || [], 24),
    }));
  const livePdpPassed = livePdpResults.filter(
    (result) => !Array.isArray(result?.failure_reasons) || result.failure_reasons.length <= 0,
  );
  const livePdpReport = {
    generated_at: new Date().toISOString(),
    brand,
    market,
    scanned_seed_count: livePdpResults.length,
    passed_seed_ids: livePdpPassed.map((result) => pickFirstTrimmed(result?.seed_id)).filter(Boolean),
    blocked_rows: livePdpBlocked,
    failure_reason_counts: countByString(livePdpResults.flatMap((result) => result?.failure_reasons || [])),
  };
  const livePdpPath = path.join(jobDir, 'live-pdp-quality.json');
  writeJson(livePdpPath, livePdpReport);

  const eligibleExternalProductIds = uniqueStrings(
    livePdpPassed.map((result) => pickFirstTrimmed(result?.external_product_id)).filter(Boolean),
    200,
  );
  const limitedInsightsProductIds = eligibleExternalProductIds.slice(0, ASYNC_BACKFILL_PIVOTA_INSIGHTS_MAX_PRODUCTS);
  const deferredInsightsProductIds = eligibleExternalProductIds.slice(ASYNC_BACKFILL_PIVOTA_INSIGHTS_MAX_PRODUCTS);

  let insightsReport = {
    status: 'skipped_no_eligible_products',
    eligible_external_product_ids: eligibleExternalProductIds,
    queued_external_product_ids: [],
    deferred_external_product_ids: deferredInsightsProductIds,
  };
  if (!ASYNC_BACKFILL_PIVOTA_INSIGHTS_ENABLED) {
    insightsReport = {
      ...insightsReport,
      status: 'skipped_disabled',
    };
  } else if (limitedInsightsProductIds.length > 0) {
    const outDir = path.join(jobDir, 'pivota-insights');
    try {
      const coverageResult = await runPivotaInsightsCoverageBatch({
        gatewayUrl: process.env.PIVOTA_GATEWAY_URL || 'https://agent.pivota.cc/api/gateway',
        productIds: limitedInsightsProductIds,
        frontendPaths: [],
        outDir,
        excludeCovered: false,
        model: ASYNC_BACKFILL_PIVOTA_INSIGHTS_MODEL,
        maxPerBrand: Math.max(1, Math.min(3, limitedInsightsProductIds.length)),
        maxPerCategory: Math.max(1, Math.min(4, limitedInsightsProductIds.length)),
      });
      insightsReport = {
        ...coverageResult,
        status: 'completed',
        coverage_status: pickFirstTrimmed(coverageResult?.status, 'ok'),
        eligible_external_product_ids: eligibleExternalProductIds,
        queued_external_product_ids: limitedInsightsProductIds,
        deferred_external_product_ids: deferredInsightsProductIds,
      };
    } catch (err) {
      logger?.warn?.(
        {
          err: err?.message || String(err),
          brand,
          product_ids: limitedInsightsProductIds,
        },
        'aurora bff: alternatives authority backfill pivota insights coverage failed',
      );
      insightsReport = {
        status: 'failed',
        error: err?.message || String(err),
        eligible_external_product_ids: eligibleExternalProductIds,
        queued_external_product_ids: limitedInsightsProductIds,
        deferred_external_product_ids: deferredInsightsProductIds,
      };
    }
  }
  const insightsPath = path.join(jobDir, 'pivota-insights-summary.json');
  writeJson(insightsPath, insightsReport);

  const remainingFollowups = [];
  if (seedAuditBlocked.length > 0) remainingFollowups.push('seed_content_audit');
  if (livePdpBlocked.length > 0) remainingFollowups.push('live_pdp_quality');
  if (
    ASYNC_BACKFILL_PIVOTA_INSIGHTS_ENABLED &&
    eligibleExternalProductIds.length > 0 &&
    String(insightsReport?.status || '') !== 'completed'
  ) {
    remainingFollowups.push('pivota_insights');
  }
  if (deferredInsightsProductIds.length > 0) {
    remainingFollowups.push('pivota_insights');
  }

  return {
    status: remainingFollowups.length > 0 ? 'partial' : 'completed',
    eligible_seed_ids: livePdpPassed.map((result) => pickFirstTrimmed(result?.seed_id)).filter(Boolean),
    eligible_external_product_ids: eligibleExternalProductIds,
    remaining_followups: uniqueStrings(remainingFollowups, 8),
    seed_content_audit: {
      path: seedAuditPath,
      ...seedAuditReport,
    },
    live_pdp_quality: {
      path: livePdpPath,
      ...livePdpReport,
    },
    pivota_insights: {
      path: insightsPath,
      ...insightsReport,
    },
  };
}

async function runBackfillJobDefault({ brand, market, preferredTitles, sourcePlan, logger } = {}) {
  const primaryDomain = ensureHttpUrl(sourcePlan?.primaryDomain);
  const fallbackDomains = uniqueStrings(sourcePlan?.fallbackDomains || [], 8).map((value) => ensureHttpUrl(value)).filter(Boolean);
  if (!primaryDomain) {
    return {
      status: 'skipped_no_domain',
      brand,
      market,
      preferred_titles: uniqueStrings(preferredTitles, ASYNC_BACKFILL_TITLE_LIMIT),
    };
  }

  const safeBrandKey = normalizeBrand(brand).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'brand';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jobDir = path.join(ensureOutDir(), `${stamp}_${safeBrandKey}`);
  fs.mkdirSync(jobDir, { recursive: true });

  const sourceSpecs = [
    { domain: primaryDomain, sourceRole: sourcePlan?.primaryRole || 'primary' },
    ...fallbackDomains.map((domain) => ({ domain, sourceRole: 'secondary_fallback' })),
  ];
  const sourceManifests = [];
  const extractLimit = computeExtractLimit(ASYNC_BACKFILL_MANIFEST_LIMIT, preferredTitles);
  for (const sourceSpec of sourceSpecs) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const extractDoc = await fetchBrandCatalog({
        brand,
        domain: sourceSpec.domain,
        market,
        limit: extractLimit,
        catalogBaseUrl: process.env.CATALOG_INTELLIGENCE_BASE_URL,
      });
      sourceManifests.push(
        buildManifestFromExtract({
          brand,
          domain: sourceSpec.domain,
          market,
          limit: ASYNC_BACKFILL_MANIFEST_LIMIT,
          preferredTitles,
          extractDoc,
          sourceRole: sourceSpec.sourceRole,
        }),
      );
    } catch (err) {
      logger?.warn?.(
        {
          err: err?.message || String(err),
          brand,
          domain: sourceSpec.domain,
        },
        'aurora bff: alternatives authority backfill extract failed',
      );
      sourceManifests.push(
        buildEmptySourceManifest({
          brand,
          domain: sourceSpec.domain,
          market,
          preferredTitles,
          sourceRole: sourceSpec.sourceRole,
          err,
        }),
      );
    }
  }

  const manifest = buildManifestFromSourceAttempts({
    brand,
    domain: primaryDomain,
    fallbackDomains,
    market,
    limit: ASYNC_BACKFILL_MANIFEST_LIMIT,
    preferredTitles,
    sourceManifests,
  });
  const manifestPath = path.join(jobDir, 'brand-manifest.json');
  writeJson(manifestPath, manifest);

  if (!Array.isArray(manifest.items) || manifest.items.length <= 0) {
    const report = {
      generated_at: new Date().toISOString(),
      brand,
      market,
      status: 'empty_manifest',
      manifest_path: manifestPath,
      preferred_titles: uniqueStrings(preferredTitles, ASYNC_BACKFILL_TITLE_LIMIT),
      source_plan: {
        primary_domain: primaryDomain,
        fallback_domains: fallbackDomains,
      },
    };
    const reportPath = path.join(jobDir, 'backfill-report.json');
    writeJson(reportPath, report);
    return { ...report, report_path: reportPath };
  }

  const databaseAvailable = Boolean(getPool());
  const applyMode = databaseAvailable && ASYNC_BACKFILL_APPLY_ENABLED ? 'apply' : 'dry_run';
  const applyItems =
    applyMode === 'apply'
      ? await processManifestWithDb(manifest, 'apply')
      : await processManifestWithoutDb(manifest);
  const applySummary = summarizeSeedApplyResults(applyItems, applyMode === 'apply' ? 'apply' : 'dry_run', databaseAvailable);
  const correctionFollowups = buildCorrectionFollowups(applyItems);
  const appliedSeedIds = uniqueStrings(
    applyItems
      .filter((item) => ['inserted', 'skipped_existing'].includes(String(item?.status || '').trim()))
      .map((item) => pickFirstTrimmed(item?.seed_id)),
    200,
  );

  let recallSummary = null;
  if (applyMode === 'apply' && appliedSeedIds.length > 0) {
    const recallRows = await fetchRecallRows({
      seedIds: appliedSeedIds,
      market,
      limit: appliedSeedIds.length + 4,
      onlyMissing: false,
    });
    const recallResults = [];
    for (const row of recallRows) {
      // eslint-disable-next-line no-await-in-loop
      recallResults.push(await processRecallRow(row, { dryRun: false, touchUpdatedAt: true }));
    }
    recallSummary = summarizeRecallRefreshResults(recallResults);
  }

  const postEnrichment = applyMode === 'apply' && appliedSeedIds.length > 0
    ? await runPostApplyEnrichmentDefault({
        jobDir,
        brand,
        market,
        appliedSeedIds,
        logger,
      })
    : {
        status: applyMode === 'apply' ? 'skipped_no_applied_seeds' : 'skipped_non_apply_mode',
        eligible_seed_ids: [],
        eligible_external_product_ids: [],
        remaining_followups: [],
        seed_content_audit: null,
        live_pdp_quality: null,
        pivota_insights: null,
      };

  const report = {
    generated_at: new Date().toISOString(),
    brand,
    market,
    status: 'completed',
    mode: applyMode,
    manifest_path: manifestPath,
    preferred_titles: uniqueStrings(preferredTitles, ASYNC_BACKFILL_TITLE_LIMIT),
    source_plan: {
      primary_domain: primaryDomain,
      fallback_domains: fallbackDomains,
    },
    apply_summary: applySummary,
    applied_seed_ids: appliedSeedIds,
    correction_followups: correctionFollowups,
    recall_refresh_summary: recallSummary,
    post_enrichment: postEnrichment,
    pending_followups: uniqueStrings(
      [
        ...(Array.isArray(correctionFollowups) ? correctionFollowups.map((item) => pickFirstTrimmed(item?.action, item?.kind, item?.type)) : []),
        ...(Array.isArray(postEnrichment?.remaining_followups) ? postEnrichment.remaining_followups : []),
      ].filter(Boolean),
      12,
    ),
  };
  const reportPath = path.join(jobDir, 'backfill-report.json');
  writeJson(reportPath, report);
  return {
    ...report,
    report_path: reportPath,
  };
}

async function enqueueRecoAlternativesAuthorityBackfill({
  ctx = null,
  alternatives,
  logger,
  market = ASYNC_BACKFILL_MARKET,
} = {}) {
  const coverage = buildCoverageGroups(alternatives, market);
  const baseLedger = {
    mode: 'async_external_seed_backfill',
    policy: 'open_world_coverage_repair',
    open_world_role: 'coverage_supplement',
    open_world_row_count: coverage.open_world_row_count,
    coverage_gap_count: coverage.coverage_gap_count,
    recall_gap_count: coverage.recall_gap_count,
    pending: false,
    status: 'not_needed',
    enqueued_brand_count: 0,
    enqueued_candidate_count: 0,
    brands: [],
    market,
  };
  if (!coverage.open_world_row_count) return baseLedger;
  if (!ASYNC_BACKFILL_ENABLED) {
    return {
      ...baseLedger,
      status: 'disabled',
    };
  }
  if (!coverage.coverage_gap_count) {
    return {
      ...baseLedger,
      status: coverage.recall_gap_count > 0 ? 'recall_only' : 'not_needed',
    };
  }

  const resolveSourcePlan = typeof state.sourcePlanResolverOverride === 'function'
    ? state.sourcePlanResolverOverride
    : resolveBrandSourcePlanDefault;
  const runJob = typeof state.runnerOverride === 'function'
    ? state.runnerOverride
    : runBackfillJobDefault;

  const nowMs = Date.now();
  const brandResults = [];
  let enqueuedBrandCount = 0;
  let enqueuedCandidateCount = 0;
  for (const group of coverage.groups) {
    const brand = pickFirstTrimmed(group?.brand);
    const preferredTitles = uniqueStrings(group?.preferredTitles, ASYNC_BACKFILL_TITLE_LIMIT);
    const jobKey = buildBackfillJobKey({ brand, market: group?.market || market });
    // eslint-disable-next-line no-await-in-loop
    const sourcePlan = await resolveSourcePlan({
      brand,
      market: group?.market || market,
      preferredTitles,
      ctx,
      rows: Array.isArray(group?.rows) ? group.rows : [],
      logger,
    });
    if (!sourcePlan?.ok) {
      brandResults.push({
        brand,
        status: `skipped_${pickFirstTrimmed(sourcePlan?.reason, 'unknown')}`,
        preferred_titles: preferredTitles,
      });
      continue;
    }
    if (!canEnqueueJob(jobKey, nowMs)) {
      brandResults.push({
        brand,
        status: 'deduped',
        preferred_titles: preferredTitles,
        source_domain: sourcePlan.primaryDomain || null,
      });
      continue;
    }

    markCooldown(jobKey, nowMs);
    enqueuedBrandCount += 1;
    enqueuedCandidateCount += preferredTitles.length;
    brandResults.push({
      brand,
      status: 'enqueued',
      preferred_titles: preferredTitles,
      source_domain: sourcePlan.primaryDomain || null,
      fallback_domains: uniqueStrings(sourcePlan.fallbackDomains, 8),
    });

    let settle;
    const trackedPromise = new Promise((resolve) => {
      settle = resolve;
    });
    state.inFlight.set(jobKey, trackedPromise);
    setImmediate(async () => {
      let result = null;
      try {
        result = await runJob({
          brand,
          market: group?.market || market,
          preferredTitles,
          sourcePlan,
          ctx,
          logger,
        });
        recordHistory({
          job_key: jobKey,
          brand,
          status: pickFirstTrimmed(result?.status, 'completed'),
          mode: pickFirstTrimmed(result?.mode),
          report_path: pickFirstTrimmed(result?.report_path),
          applied_seed_ids: Array.isArray(result?.applied_seed_ids) ? result.applied_seed_ids : [],
        });
      } catch (err) {
        recordHistory({
          job_key: jobKey,
          brand,
          status: 'failed',
          error: err?.message || String(err),
        });
        logger?.warn?.(
          {
            err: err?.message || String(err),
            brand,
            market: group?.market || market,
          },
          'aurora bff: alternatives authority backfill failed',
        );
      } finally {
        state.inFlight.delete(jobKey);
        settle(result);
      }
    });
  }

  const status = enqueuedBrandCount > 0
    ? 'enqueued'
    : brandResults.some((item) => item.status === 'deduped')
      ? 'deduped'
      : brandResults.some((item) => String(item.status || '').startsWith('skipped_'))
        ? 'blocked'
        : 'not_needed';
  return {
    ...baseLedger,
    pending: enqueuedBrandCount > 0,
    status,
    enqueued_brand_count: enqueuedBrandCount,
    enqueued_candidate_count: enqueuedCandidateCount,
    brands: brandResults,
  };
}

async function flushRecoAlternativesAuthorityBackfillJobsForTest() {
  const pending = Array.from(state.inFlight.values());
  if (!pending.length) return;
  await Promise.allSettled(pending);
}

function resetRecoAlternativesAuthorityBackfillStateForTest() {
  state.cooldownUntilMs.clear();
  state.inFlight.clear();
  state.history.length = 0;
  state.runnerOverride = null;
  state.sourcePlanResolverOverride = null;
}

module.exports = {
  enqueueRecoAlternativesAuthorityBackfill,
  _internals: {
    buildCoverageGroups,
    buildBackfillJobKey,
    canEnqueueJob,
    markCooldown,
    resolveBrandSourcePlanDefault,
    runBackfillJobDefault,
    runPostApplyEnrichmentDefault,
    flushRecoAlternativesAuthorityBackfillJobsForTest,
    resetRecoAlternativesAuthorityBackfillStateForTest,
    getHistoryForTest() {
      return state.history.slice();
    },
    setRunnerForTest(fn) {
      state.runnerOverride = typeof fn === 'function' ? fn : null;
    },
    setSourcePlanResolverForTest(fn) {
      state.sourcePlanResolverOverride = typeof fn === 'function' ? fn : null;
    },
    buildBrandDomainGuessCandidates,
    discoverBrandSourcePlanByGuess,
  },
};
