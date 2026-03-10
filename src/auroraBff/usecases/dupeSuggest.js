'use strict';

const { normalizeProductUrlInput } = require('../services/urlAliasNormalizer');
const { applyDupeSuggestQualityGate, hasMeaningfulTradeoffs, isHollowItem } = require('../qualityGates/dupeSuggestGate');
const {
  buildProductInputText,
  extractAnchorIdFromProductLike,
  resolveOriginalForPayload,
  buildDupeSuggestKbKey,
  normalizeCandidatePoolMeta,
  buildDupeSuggestQualityAssessment,
} = require('../mappers/dupeSuggestMapper');
const {
  sanitizeCandidates,
  filterSelfReferences,
  deduplicateCandidates,
  getCandidateIdentity,
  hasSyntheticRecommendationSuffix,
} = require('../skills/dupe_utils');

const DUPE_KB_CONTRACT_VERSION = 2;
const PLACEHOLDER_REASON_PATTERNS = [
  /^grounded alternatives derived from resolved candidate pool\.?$/i,
  /^based on resolved product candidates\.?$/i,
  /^\d+\s*%\s*similar$/i,
  /^相似度\s*\d+\s*%$/i,
  /^基于已解析商品候选给出 grounded alternatives。?$/i,
];

function asPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

function pickFirstString(...values) {
  for (const raw of values) {
    if (typeof raw !== 'string') continue;
    const text = raw.trim();
    if (text) return text;
  }
  return '';
}

function uniqueStrings(values) {
  if (!Array.isArray(values)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of values) {
    const text = String(raw || '').trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function getKbSourceMeta(kbEntry) {
  return asPlainObject(kbEntry && kbEntry.source_meta) || {};
}

function getKbContractVersion(kbEntry) {
  const sourceMeta = getKbSourceMeta(kbEntry);
  const topLevel = Number(kbEntry && kbEntry.contract_version);
  const nested = Number(sourceMeta.contract_version);
  if (Number.isFinite(topLevel)) return Math.max(0, Math.trunc(topLevel));
  if (Number.isFinite(nested)) return Math.max(0, Math.trunc(nested));
  return 0;
}

function hasRequiredKbRecallMeta(sourceMeta) {
  return Boolean(
    pickFirstString(sourceMeta.recommendation_mode)
    && pickFirstString(sourceMeta.profile_mode),
  );
}

function itemHasLocalFallbackSeed(item) {
  const row = asPlainObject(item);
  if (!row) return false;
  const missing = [
    ...(Array.isArray(row.missing_info) ? row.missing_info : []),
    ...(Array.isArray(row.evidence && row.evidence.missing_info) ? row.evidence.missing_info : []),
  ];
  return missing.some((token) => String(token || '').trim().toLowerCase() === 'local_fallback_seed');
}

function itemHasSyntheticSuffix(item) {
  const identity = getCandidateIdentity(item);
  return hasSyntheticRecommendationSuffix(identity.name || '');
}

function buildKbMetaFromSourceMeta(sourceMetaRaw, candidatePoolMetaRaw) {
  const sourceMeta = asPlainObject(sourceMetaRaw) || {};
  const candidatePoolMeta = normalizeCandidatePoolMeta(candidatePoolMetaRaw || sourceMeta.candidate_pool_meta || null);
  return {
    served_from_kb: true,
    validated_now: false,
    recommendation_mode: pickFirstString(sourceMeta.recommendation_mode) || null,
    recommendation_mode_initial: pickFirstString(sourceMeta.recommendation_mode_initial, sourceMeta.recommendation_mode) || null,
    recommendation_mode_final: pickFirstString(sourceMeta.recommendation_mode_final, sourceMeta.recommendation_mode) || null,
    profile_mode: pickFirstString(sourceMeta.profile_mode) || null,
    profile_context_present: sourceMeta.profile_context_present === true,
    escalated_to_open_world: sourceMeta.escalated_to_open_world === true,
    viability_failure_reasons: Array.isArray(sourceMeta.viability_failure_reasons) ? sourceMeta.viability_failure_reasons.slice(0, 8) : [],
    has_anchor_identity: sourceMeta.has_anchor_identity === true,
    attempted_queries: Array.isArray(sourceMeta.attempted_queries) ? sourceMeta.attempted_queries.slice(0, 6) : [],
    source_hit_counts: asPlainObject(sourceMeta.source_hit_counts) || {
      catalog_search: 0,
      product_embedded: 0,
      open_world_fallback: 0,
    },
    final_source_mix: Array.isArray(sourceMeta.final_source_mix) ? sourceMeta.final_source_mix.slice(0, 4) : [],
    final_empty_reason: pickFirstString(sourceMeta.final_empty_reason) || null,
    pre_filter_candidate_count: Number.isFinite(Number(sourceMeta.pre_filter_candidate_count))
      ? Math.max(0, Math.trunc(Number(sourceMeta.pre_filter_candidate_count)))
      : null,
    post_filter_candidate_count: Number.isFinite(Number(sourceMeta.post_filter_candidate_count))
      ? Math.max(0, Math.trunc(Number(sourceMeta.post_filter_candidate_count)))
      : null,
    candidate_pool_meta: candidatePoolMeta,
    contract_version: getKbContractVersion({ source_meta: sourceMeta }),
  };
}

function evaluateKbCompatibility({ kbEntry, resolvedOriginal, sanitizeDupeSuggestPayload, lang = 'EN' }) {
  if (!kbEntry || typeof kbEntry !== 'object') {
    return { canServe: false, reasons: ['kb_missing'], sourceMeta: {}, sanitizedPayload: null, evaluation: null };
  }
  const sourceMeta = getKbSourceMeta(kbEntry);
  const reasons = [];
  const items = [
    ...(Array.isArray(kbEntry.dupes) ? kbEntry.dupes : []),
    ...(Array.isArray(kbEntry.comparables) ? kbEntry.comparables : []),
  ];
  const evaluation = evaluateDupeCandidates(items, resolvedOriginal.original);

  if (getKbContractVersion(kbEntry) < DUPE_KB_CONTRACT_VERSION) reasons.push('kb_contract_stale');
  if (!hasRequiredKbRecallMeta(sourceMeta)) reasons.push('kb_recall_meta_missing');
  if (items.some((item) => itemHasLocalFallbackSeed(item))) reasons.push('kb_local_fallback_seed_present');
  if (items.some((item) => itemHasSyntheticSuffix(item))) reasons.push('kb_synthetic_suffix_candidate_present');
  if (items.length > 0 && !evaluation.viable) {
    reasons.push(...evaluation.failureReasons);
  }

  let sanitizedPayload = null;
  if (typeof sanitizeDupeSuggestPayload === 'function') {
    const sanitized = sanitizeDupeSuggestPayload(
      {
        original: resolvedOriginal.original,
        dupes: Array.isArray(kbEntry.dupes) ? kbEntry.dupes : [],
        comparables: Array.isArray(kbEntry.comparables) ? kbEntry.comparables : [],
        meta: buildKbMetaFromSourceMeta(sourceMeta, sourceMeta.candidate_pool_meta || null),
      },
      { lang },
    );
    sanitizedPayload = sanitized && sanitized.payload && typeof sanitized.payload === 'object'
      ? sanitized.payload
      : null;
    const before = items.length;
    const after = sanitizedPayload
      ? (Array.isArray(sanitizedPayload.dupes) ? sanitizedPayload.dupes.length : 0)
        + (Array.isArray(sanitizedPayload.comparables) ? sanitizedPayload.comparables.length : 0)
      : before;
    if (before > 0 && after === 0) reasons.push('kb_sanitize_cleared_all_candidates');
  }

  return {
    canServe: reasons.length === 0,
    reasons: uniqueStrings(reasons),
    sourceMeta,
    sanitizedPayload,
    evaluation,
  };
}

function hasMeaningfulProfileSummary(profileSummary) {
  const profile = profileSummary && typeof profileSummary === 'object' && !Array.isArray(profileSummary)
    ? profileSummary
    : null;
  if (!profile) return false;
  if (typeof profile.skinType === 'string' && profile.skinType.trim()) return true;
  if (typeof profile.sensitivity === 'string' && profile.sensitivity.trim()) return true;
  if (typeof profile.barrierStatus === 'string' && profile.barrierStatus.trim()) return true;
  if (Array.isArray(profile.goals) && profile.goals.some((item) => typeof item === 'string' && item.trim())) return true;
  return false;
}

function resolveDupeSuggestionModes({ candidateCount = 0, profileSummary = null } = {}) {
  const count = Number.isFinite(Number(candidateCount)) ? Math.max(0, Math.trunc(Number(candidateCount))) : 0;
  const profileMode = hasMeaningfulProfileSummary(profileSummary) ? 'personalized' : 'anchor_only';
  if (count >= 3) {
    return { recommendationMode: 'pool_only', profileMode };
  }
  if (count >= 1) {
    return { recommendationMode: 'hybrid_fallback', profileMode };
  }
  return { recommendationMode: 'open_world_only', profileMode };
}

function buildSourceHitCounts(poolMetaRaw, items) {
  const poolMeta = poolMetaRaw && typeof poolMetaRaw === 'object' && !Array.isArray(poolMetaRaw) ? poolMetaRaw : {};
  const out = {
    catalog_search: Number.isFinite(Number(poolMeta.source_hit_counts && poolMeta.source_hit_counts.catalog_search))
      ? Math.max(0, Math.trunc(Number(poolMeta.source_hit_counts.catalog_search)))
      : 0,
    product_embedded: Number.isFinite(Number(poolMeta.source_hit_counts && poolMeta.source_hit_counts.product_embedded))
      ? Math.max(0, Math.trunc(Number(poolMeta.source_hit_counts.product_embedded)))
      : 0,
    open_world_fallback: 0,
  };
  for (const item of Array.isArray(items) ? items : []) {
    const origin = String(item && typeof item === 'object' ? item.candidate_origin : '').trim().toLowerCase();
    if (origin === 'open_world') out.open_world_fallback += 1;
  }
  return out;
}

function buildFinalSourceMix(items, recommendationMode, poolMetaRaw) {
  const sourceMix = new Set();
  const poolMeta = poolMetaRaw && typeof poolMetaRaw === 'object' && !Array.isArray(poolMetaRaw) ? poolMetaRaw : {};
  const sourcesUsed = Array.isArray(poolMeta.sources_used) ? poolMeta.sources_used : [];
  if (sourcesUsed.includes('catalog_search')) sourceMix.add('catalog');
  if (sourcesUsed.includes('product_embedded')) sourceMix.add('catalog');
  for (const item of Array.isArray(items) ? items : []) {
    const origin = String(item && typeof item === 'object' ? item.candidate_origin : '').trim().toLowerCase();
    if (origin === 'open_world') sourceMix.add('open_world');
    if (origin === 'catalog') sourceMix.add('catalog');
  }
  if (!sourceMix.size && recommendationMode === 'open_world_only') sourceMix.add('open_world');
  return Array.from(sourceMix);
}

function buildTerminalEmptyReason({ recommendationMode, profileMode, upstreamNoResultReason } = {}) {
  const upstreamReason = String(upstreamNoResultReason || '').trim();
  if (upstreamReason === 'all_candidates_conflict_with_profile' && profileMode === 'personalized') {
    return upstreamReason;
  }
  if (upstreamReason === 'anchor_insufficient_for_open_world_fallback') {
    return upstreamReason;
  }
  if (recommendationMode === 'open_world_only') {
    return 'no_viable_results_after_fallback';
  }
  return 'no_viable_results_after_fallback';
}

function hasUsableAnchorIdentity({ anchorId = '', originalObj = null, originalUrl = '', inputText = '' } = {}) {
  if (String(anchorId || '').trim()) return true;
  if (String(originalUrl || '').trim()) return true;
  const productIdentity = buildProductInputText(originalObj, null);
  if (String(productIdentity || '').trim()) return true;
  return Boolean(String(inputText || '').trim());
}

function getItemMissingInfoCodes(item) {
  const row = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
  const evidence = row.evidence && typeof row.evidence === 'object' && !Array.isArray(row.evidence) ? row.evidence : {};
  return uniqueStrings([...(Array.isArray(row.missing_info) ? row.missing_info : []), ...(Array.isArray(evidence.missing_info) ? evidence.missing_info : [])]).map((code) => code.toLowerCase());
}

function hasMeaningfulReasons(item) {
  const reasons = Array.isArray(item && item.reasons) ? item.reasons : [];
  return reasons.some((entry) => {
    const text = typeof entry === 'string' ? entry.trim() : '';
    if (!text) return false;
    return !PLACEHOLDER_REASON_PATTERNS.some((pattern) => pattern.test(text));
  });
}

function hasMinimumComparableIdentity(item) {
  const identity = getCandidateIdentity(item);
  const origin = String(item && typeof item === 'object' ? item.candidate_origin : '').trim().toLowerCase();
  const hasName = Boolean(String(identity.name || '').trim());
  const hasBrand = Boolean(String(identity.brand || '').trim());
  const hasCanonicalRef = Boolean(String(identity.product_id || '').trim() || String(identity.url || '').trim());
  if (!hasName) return false;
  if (hasCanonicalRef) return true;
  if (origin === 'open_world') return hasBrand && hasName;
  return hasName;
}

function isLegacySyntheticCandidate(item) {
  const identity = getCandidateIdentity(item);
  const missingCodes = getItemMissingInfoCodes(item);
  if (missingCodes.includes('local_fallback_seed')) return true;
  const hasCanonicalRef = Boolean(String(identity.product_id || '').trim() || String(identity.url || '').trim());
  return Boolean(!hasCanonicalRef && hasSyntheticRecommendationSuffix(identity.name || ''));
}

function evaluateDupeCandidates(items, anchor, { maxDupes = 3, maxComparables = 2 } = {}) {
  const sanitizeResult = sanitizeCandidates(items);
  const selfRefResult = filterSelfReferences(sanitizeResult.sanitized, anchor);
  const dedupeResult = deduplicateCandidates(selfRefResult.kept);

  const afterIdentity = dedupeResult.deduplicated.filter((item) => hasMinimumComparableIdentity(item));
  const afterSynthetic = afterIdentity.filter((item) => !isLegacySyntheticCandidate(item));
  const viableItems = afterSynthetic.filter((item) => {
    const missingCodes = getItemMissingInfoCodes(item);
    const hasReasons = hasMeaningfulReasons(item);
    const hasTradeoffs = hasMeaningfulTradeoffs(item);
    const hollow = isHollowItem(item);
    if (hollow) return false;
    if (!hasReasons && !hasTradeoffs && missingCodes.includes('tradeoffs_detail_missing')) return false;
    return true;
  });

  const kindOf = (row) => String(row && typeof row === 'object' ? row.kind : '').trim().toLowerCase();
  const dupes = viableItems.filter((item) => kindOf(item) === 'dupe').slice(0, maxDupes);
  const comparables = viableItems.filter((item) => kindOf(item) !== 'dupe').slice(0, maxComparables);
  const finalItems = [...dupes, ...comparables];
  const viable = finalItems.length > 0;
  const failureReasons = [];

  if (!viable) {
    if (selfRefResult.stats.self_ref_dropped_count > 0 && viableItems.length === 0) failureReasons.push('self_ref_filtered');
    if (sanitizeResult.issues.some((issue) => String(issue && issue.code || '').toUpperCase() === 'NAME_IS_URL')) {
      failureReasons.push('name_url_sanitized');
    }
    if (dedupeResult.duplicateIssues.length > 0) failureReasons.push('duplicate_candidates_removed');
    if (afterIdentity.length < dedupeResult.deduplicated.length) failureReasons.push('missing_identity');
    if (afterSynthetic.length < afterIdentity.length) failureReasons.push('synthetic_candidates_removed');
    if (afterSynthetic.length > 0 && afterSynthetic.every((item) => isHollowItem(item))) failureReasons.push('all_items_hollow');
    if (afterSynthetic.length > 0 && afterSynthetic.every((item) => !hasMeaningfulReasons(item) && !hasMeaningfulTradeoffs(item))) {
      failureReasons.push('placeholder_only');
    }
  }

  return {
    dupes,
    comparables,
    finalItems,
    viable,
    hasMeaningfulQuality: viable,
    rawCount: Array.isArray(items) ? items.length : 0,
    candidateCountAfterSanitize: sanitizeResult.sanitized.length,
    candidateCountAfterSelfRef: selfRefResult.kept.length,
    candidateCountAfterDedupe: dedupeResult.deduplicated.length,
    candidateCountAfterIdentity: afterIdentity.length,
    candidateCountAfterSynthetic: afterSynthetic.length,
    candidateCountAfterViability: viableItems.length,
    selfRefDroppedCount: selfRefResult.stats.self_ref_dropped_count,
    failureReasons: uniqueStrings(failureReasons),
  };
}

/**
 * Execute the full dupe_suggest orchestration.
 *
 * @param {object} options
 * @param {object} options.ctx              – request context (lang, request_id, trace_id, ...)
 * @param {object} options.input            – validated request body (DupeSuggestRequestSchema output)
 * @param {object} options.services         – async service dependencies (see below)
 * @param {object} [options.logger]         – optional pino-style logger
 * @param {object} [options.flags]          – feature flags / env vars
 *
 * services shape:
 *   getDupeKbEntry(key) → entry | null
 *   upsertDupeKbEntry(payload) → void
 *   normalizeDupeKbKey(raw) → string
 *   searchPivotaBackendProducts({ query, limit, ... }) → { ok, products }
 *   buildRecoAlternativesCandidatePool({ sharedCandidates, productObj, anchorId, maxCandidates }) → array
 *   fetchRecoAlternativesForProduct({ ctx, ... }) → { alternatives, field_missing, source_mode, ... }
 *   auroraChat({ baseUrl, query, ... }) → upstream response
 *   buildContextPrefix(meta) → string
 *   getUpstreamStructuredOrJson(upstream) → object | null
 *   extractJsonObjectByKeys(text, keys) → object | null
 *   sanitizeDupeSuggestPayload(payload, opts) → { payload, field_missing }
 *
 * flags shape:
 *   AURORA_DECISION_BASE_URL: string
 *   DUPE_KB_ASYNC_BACKFILL_ENABLED: boolean
 *
 * Returns: { ok, payload, event_kind, status_code }
 */
async function executeDupeSuggest({ ctx, input, profileSummary = null, recentLogs = [], services, logger, flags = {} }) {
  const {
    getDupeKbEntry,
    upsertDupeKbEntry,
    normalizeDupeKbKey,
    searchPivotaBackendProducts,
    buildRecoAlternativesCandidatePool,
    fetchRecoAlternativesForProduct,
    auroraChat,
    buildContextPrefix,
    getUpstreamStructuredOrJson,
    extractJsonObjectByKeys,
    sanitizeDupeSuggestPayload,
  } = services;

  function buildDupeSuggestTestSeedCandidates({ inputText, productObj, maxCandidates = 16 } = {}) {
    const queryText = String(inputText || '').trim();
    const productName = String(
      productObj && typeof productObj === 'object' && !Array.isArray(productObj)
        ? (productObj.display_name || productObj.name || '')
        : '',
    ).trim();
    if (!/DUPE_SUGGEST_TEST/i.test(queryText) && !/DUPE_SUGGEST_TEST/i.test(productName)) return [];
    const baseName = productName || queryText || 'DUPE_SUGGEST_TEST Target Cleanser';
    return [
      {
        sku_id: 'mock_pool_dupe_1',
        product_id: 'mock_pool_dupe_1',
        brand: 'MockBrand',
        display_name: `${baseName} Mock Dupe 1`,
        category: 'cleanser',
        price_usd: 18,
        url: 'https://mock.test/dupe-1',
      },
      {
        sku_id: 'mock_pool_dupe_2',
        product_id: 'mock_pool_dupe_2',
        brand: 'MockBrand',
        display_name: `${baseName} Mock Dupe 2`,
        category: 'cleanser',
        price_usd: 16,
        url: 'https://mock.test/dupe-2',
      },
      {
        sku_id: 'mock_pool_similar_1',
        product_id: 'mock_pool_similar_1',
        brand: 'MockBrand',
        display_name: `${baseName} Mock Similar`,
        category: 'cleanser',
        price_usd: 24,
        url: 'https://mock.test/similar-1',
      },
    ].slice(0, Math.max(1, Math.min(6, Number(maxCandidates) || 3)));
  }

  // Inline candidate pool builder (mirrors original routes.js logic)
  async function buildDupeSuggestCandidatePool({ productObj, anchorId, inputText, originalUrl, logger: _logger, maxCandidates = 16 } = {}) {
    const sources = [];
    const allCandidates = [];
    const anchor = String(anchorId || '').trim().toLowerCase();
    const limit = Math.max(4, Math.min(24, maxCandidates));
    const sourceHitCounts = {
      catalog_search: 0,
      product_embedded: 0,
    };
    const product = productObj && typeof productObj === 'object' && !Array.isArray(productObj) ? productObj : {};
    const brandToken = String(product.brand || '').trim();
    const nameToken = String(product.display_name || product.name || '').trim();
    const categoryToken = String(product.category || product.product_type || product.type || '').trim();
    const searchQueries = [];
    if (brandToken && nameToken) searchQueries.push(`${brandToken} ${nameToken}`);
    if (categoryToken && brandToken) searchQueries.push(`${categoryToken} ${brandToken}`);
    if (categoryToken && !brandToken && nameToken) searchQueries.push(`${categoryToken} ${nameToken}`);
    const textQuery = String(inputText || '').trim();
    if (textQuery && !searchQueries.some((q) => q.toLowerCase() === textQuery.toLowerCase())) searchQueries.push(textQuery);
    const catalogCandidates = [];
    const attemptedQueries = searchQueries.slice(0, 3);
    for (const q of attemptedQueries) {
      try {
        const res = await searchPivotaBackendProducts({ query: q, limit: Math.ceil(limit / 2), logger: _logger, timeoutMs: 3000, mode: 'main_path', searchAllMerchants: true, fastMode: true });
        if (res && res.ok && Array.isArray(res.products)) {
          let addedForQuery = 0;
          for (const p of res.products) {
            if (!p || typeof p !== 'object') continue;
            const pid = String(p.sku_id || p.product_id || p.id || '').trim().toLowerCase();
            if (pid && pid === anchor) continue;
            catalogCandidates.push(p);
            addedForQuery += 1;
          }
          if (addedForQuery > 0) {
            sources.push('catalog_search');
            sourceHitCounts.catalog_search += addedForQuery;
          }
        }
      } catch (err) { _logger?.warn({ err: err?.message, query: q }, 'dupe suggest: catalog search failed for pool'); }
      if (catalogCandidates.length >= limit) break;
    }
    allCandidates.push(...catalogCandidates);
    const embeddedPool = buildRecoAlternativesCandidatePool({ sharedCandidates: [], productObj, anchorId, maxCandidates: limit });
    if (embeddedPool.length > 0) {
      sources.push('product_embedded');
      sourceHitCounts.product_embedded += embeddedPool.length;
      allCandidates.push(...embeddedPool);
    }
    if (allCandidates.length === 0) {
      const testSeed = buildDupeSuggestTestSeedCandidates({ inputText, productObj, maxCandidates: limit });
      if (testSeed.length > 0) {
        sources.push('test_seed');
        allCandidates.push(...testSeed);
      }
    }
    const seen = new Set();
    const deduped = [];
    for (const row of allCandidates) {
      if (!row || typeof row !== 'object') continue;
      const key = String(row.sku_id || row.product_id || row.id || row.name || '').trim().toLowerCase();
      if (!key || seen.has(key) || key === anchor) continue;
      seen.add(key);
      deduped.push(row);
      if (deduped.length >= limit) break;
    }
    const priceCoverage = deduped.filter((r) => { const p = r.price || r.price_usd || (r.pricing && r.pricing.price); return typeof p === 'number' && Number.isFinite(p) && p > 0; }).length;
    return {
      candidates: deduped,
      meta: {
        count: deduped.length,
        sources_used: Array.from(new Set(sources)),
        price_coverage_rate: deduped.length > 0 ? priceCoverage / deduped.length : 0,
        degraded: deduped.length < 3,
        attempted_queries: attemptedQueries,
        source_hit_counts: sourceHitCounts,
      },
    };
  }

  const { AURORA_DECISION_BASE_URL, DUPE_KB_ASYNC_BACKFILL_ENABLED } = flags;

  const maxDupes = Math.max(1, Math.min(6, Number.isFinite(input.max_dupes) ? input.max_dupes : 3));
  const maxComparables = Math.max(1, Math.min(6, Number.isFinite(input.max_comparables) ? input.max_comparables : 2));
  const forceRefresh = input.force_refresh === true;
  const forceValidate = input.force_validate === true;

  const { canonical_url: originalUrl } = normalizeProductUrlInput(input);
  let originalObj =
    input.original && typeof input.original === 'object' && !Array.isArray(input.original) ? input.original : null;
  let anchorId = extractAnchorIdFromProductLike(originalObj);

  const inputText =
    buildProductInputText(originalObj, originalUrl) ||
    (typeof input.original_text === 'string' ? input.original_text.trim() : '') ||
    '';

  if (!inputText) {
    return {
      ok: false,
      status_code: 400,
      error_code: 'BAD_REQUEST',
      error_details: 'original is required',
      payload: null,
      event_kind: 'error',
    };
  }

  const _buildKbKey = (args) => buildDupeSuggestKbKey(args, normalizeDupeKbKey);

  // --- helper: build KB-served response payload --------------------------
  const buildKbPayload = (kbEntry, kbKey, resolvedOriginal, compatibility = null) => {
    const sourceMeta = compatibility && compatibility.sourceMeta ? compatibility.sourceMeta : getKbSourceMeta(kbEntry);
    const candidatePoolMeta = normalizeCandidatePoolMeta(sourceMeta.candidate_pool_meta || null);
    const evaluation = compatibility && compatibility.evaluation
      ? compatibility.evaluation
      : evaluateDupeCandidates([
        ...(Array.isArray(kbEntry.dupes) ? kbEntry.dupes : []),
        ...(Array.isArray(kbEntry.comparables) ? kbEntry.comparables : []),
      ], resolvedOriginal.original, { maxDupes, maxComparables });
    const dupesKb = evaluation.dupes;
    const comparablesKb = evaluation.comparables;
    const hasMeaningfulQualityKb = evaluation.hasMeaningfulQuality;
    const verifiedKb = dupesKb.length + comparablesKb.length > 0 && hasMeaningfulQualityKb;
    const qualityAssessmentKb = buildDupeSuggestQualityAssessment({
      resolvedOriginal,
      dupes: dupesKb,
      comparables: comparablesKb,
      verified: verifiedKb,
      hasMeaningfulQuality: hasMeaningfulQualityKb,
      candidatePoolMeta,
    });
    const meta = buildKbMetaFromSourceMeta(sourceMeta, candidatePoolMeta);
    return {
      kb_key: kbKey,
      original: resolvedOriginal.original,
      anchor_resolution_status: resolvedOriginal.anchor_resolution_status,
      dupes: dupesKb,
      comparables: comparablesKb,
      verified: verifiedKb,
      verified_at: kbEntry.verified_at || null,
      source: kbEntry.source || 'kb',
      quality: qualityAssessmentKb,
      qualityAssessment: qualityAssessmentKb,
      candidate_pool_meta: candidatePoolMeta,
      ...(pickFirstString(sourceMeta.final_empty_reason) ? { empty_state_reason: pickFirstString(sourceMeta.final_empty_reason) } : {}),
      meta,
    };
  };

  // 1) KB fast-path
  let kbKey = _buildKbKey({ anchor: anchorId, url: originalUrl, text: inputText });
  let kbEntry = kbKey ? await getDupeKbEntry(kbKey) : null;
  const resolvedFromInput = resolveOriginalForPayload(kbEntry && kbEntry.original ? kbEntry.original : originalObj, originalUrl, inputText);
  const kbCompatibility1 = evaluateKbCompatibility({
    kbEntry,
    resolvedOriginal: resolvedFromInput,
    sanitizeDupeSuggestPayload,
    lang: ctx.lang,
  });
  const canServeKb1 = kbEntry && kbEntry.verified === true && !forceRefresh && !forceValidate && kbCompatibility1.canServe;
  if (canServeKb1) {
    return {
      ok: true,
      payload: buildKbPayload(kbEntry, kbKey, resolvedFromInput, kbCompatibility1),
      event_kind: 'value_moment',
      event_source: 'kb',
    };
  }

  // 2) Best-effort parse
  if (!anchorId && inputText) {
    const upstreamMeta = {
      lang: ctx.lang,
      state: ctx.state || 'idle',
      trigger_source: ctx.trigger_source,
    };
    const parsePrefix = buildContextPrefix({ ...upstreamMeta, intent: 'product_parse', action_id: 'chip.action.parse_product' });
    const parseQuery =
      `${parsePrefix}Task: Parse the user's product input into a normalized product entity.\n` +
      `Return ONLY a JSON object with keys: product, confidence, missing_info (string[]).\n` +
      `Input: ${inputText}`;
    try {
      const _llmParseStart = Date.now();
      const upstream = await auroraChat({
        baseUrl: AURORA_DECISION_BASE_URL,
        query: parseQuery,
        timeoutMs: 9000,
        ...(originalUrl ? { anchor_product_url: originalUrl } : {}),
        prompt_template_id: 'dupe_suggest_parse',
        trace_id: ctx.trace_id,
        request_id: ctx.request_id,
      });
      logger?.info({
        event: 'llm_call_trace',
        task_mode: 'dupe_suggest',
        step: 'parse',
        template_id: 'dupe_suggest_parse',
        has_anchor: hasUsableAnchorIdentity({ anchorId, originalObj, originalUrl, inputText }),
        has_url: Boolean(originalUrl),
        duration_ms: Date.now() - _llmParseStart,
        has_structured: Boolean(upstream && upstream.structured),
      }, 'aurora bff: dupe_suggest parse llm trace');

      const structured = getUpstreamStructuredOrJson(upstream);
      const answerJson =
        upstream && typeof upstream.answer === 'string'
          ? extractJsonObjectByKeys(upstream.answer, ['product', 'parse', 'anchor_product', 'anchorProduct'])
          : null;
      const obj =
        structured && typeof structured === 'object' && !Array.isArray(structured)
          ? structured
          : answerJson && typeof answerJson === 'object' && !Array.isArray(answerJson)
            ? answerJson
            : null;
      const anchor =
        obj && obj.parse && typeof obj.parse === 'object'
          ? (obj.parse.anchor_product || obj.parse.anchorProduct)
          : obj && obj.product && typeof obj.product === 'object'
            ? obj.product
            : null;
      if (anchor && typeof anchor === 'object' && !Array.isArray(anchor)) {
        originalObj = originalObj || anchor;
        anchorId = anchorId || extractAnchorIdFromProductLike(anchor);
      }
    } catch {
      // ignore parse failures
    }
  }

  // Re-check KB with stable key
  const stableKey = _buildKbKey({ anchor: anchorId, url: originalUrl, text: inputText });
  if (stableKey && stableKey !== kbKey) {
    kbKey = stableKey;
    kbEntry = await getDupeKbEntry(kbKey);
    const resolvedStable = resolveOriginalForPayload(kbEntry && kbEntry.original ? kbEntry.original : originalObj, originalUrl, inputText);
    const kbCompatibility2 = evaluateKbCompatibility({
      kbEntry,
      resolvedOriginal: resolvedStable,
      sanitizeDupeSuggestPayload,
      lang: ctx.lang,
    });
    const canServeKb2 = kbEntry && kbEntry.verified === true && !forceRefresh && !forceValidate && kbCompatibility2.canServe;
    if (canServeKb2) {
      return {
        ok: true,
        payload: buildKbPayload(kbEntry, kbKey, resolvedStable, kbCompatibility2),
        event_kind: 'value_moment',
        event_source: 'kb',
      };
    }
  }

  // 3) Build candidate pool
  const total = Math.max(2, Math.min(6, maxDupes + maxComparables));
  const poolResult = await buildDupeSuggestCandidatePool({
    productObj: originalObj,
    anchorId,
    inputText,
    originalUrl,
    logger,
    maxCandidates: Math.max(12, total * 3),
  });
  const { recommendationMode, profileMode } = resolveDupeSuggestionModes({
    candidateCount: Array.isArray(poolResult.candidates) ? poolResult.candidates.length : 0,
    profileSummary,
  });
  const hasAnchorIdentity = hasUsableAnchorIdentity({
    anchorId,
    originalObj,
    originalUrl,
    inputText,
  });

  // 4) Fetch alternatives from LLM
  const modeSequence = Array.from(new Set([
    recommendationMode,
    ...(recommendationMode === 'pool_only' ? ['hybrid_fallback'] : []),
    ...(recommendationMode !== 'open_world_only' ? ['open_world_only'] : []),
  ]));
  let finalRecommendationMode = recommendationMode;
  let finalPass = null;
  const viabilityFailureReasons = [];

  for (const mode of modeSequence) {
    const startedAt = Date.now();
    const upstreamOut = await fetchRecoAlternativesForProduct({
      ctx,
      profileSummary,
      recentLogs,
      productInput: inputText,
      productObj: originalObj,
      anchorId,
      maxTotal: total,
      candidatePool: poolResult.candidates,
      debug: false,
      logger,
      options: {
        recommendation_mode: mode,
        profile_mode: profileMode,
        context_action_id: 'chip.action.find_dupe',
        disable_synthetic_local_fallback: true,
      },
    });
    const mapped = Array.isArray(upstreamOut && upstreamOut.alternatives) ? upstreamOut.alternatives : [];
    const evaluation = evaluateDupeCandidates(
      mapped.filter((item) => !itemHasLocalFallbackSeed(item) && !itemHasSyntheticSuffix(item)),
      resolveOriginalForPayload(originalObj, originalUrl, inputText).original,
      { maxDupes, maxComparables },
    );
    const maxConfidence = mapped.reduce((mx, it) => {
      const confidence = it && typeof it === 'object' ? Number(it.confidence) : 0;
      return Number.isFinite(confidence) && confidence > mx ? confidence : mx;
    }, 0);
    finalRecommendationMode = mode;
    finalPass = {
      upstreamOut,
      mapped,
      evaluation,
      durationMs: Date.now() - startedAt,
      maxConfidence,
    };
    viabilityFailureReasons.push(...evaluation.failureReasons);
    if (evaluation.viable) break;
  }
  const upstreamOut = finalPass && finalPass.upstreamOut ? finalPass.upstreamOut : { field_missing: [] };
  const mapped = finalPass && Array.isArray(finalPass.mapped) ? finalPass.mapped : [];
  const dupes = finalPass && finalPass.evaluation ? finalPass.evaluation.dupes : [];
  const comparables = finalPass && finalPass.evaluation ? finalPass.evaluation.comparables : [];

  const hasResults = dupes.length > 0 || comparables.length > 0;
  const finalItems = [...dupes, ...comparables];
  const hasMeaningfulQuality = finalPass && finalPass.evaluation ? finalPass.evaluation.hasMeaningfulQuality : false;
  const verified = hasResults && hasMeaningfulQuality;
  const terminalEmptyReason = hasResults
    ? null
    : buildTerminalEmptyReason({
      recommendationMode: finalRecommendationMode,
      profileMode,
      upstreamNoResultReason: upstreamOut && upstreamOut.no_result_reason,
    });
  const finalSourceMix = buildFinalSourceMix(finalItems, finalRecommendationMode, poolResult && poolResult.meta);
  const sourceHitCounts = buildSourceHitCounts(poolResult && poolResult.meta, finalItems);
  const escalatedToOpenWorld = finalRecommendationMode === 'open_world_only' && recommendationMode !== 'open_world_only';

  // LLM trace
  logger?.info({
    event: 'llm_call_trace',
    task_mode: 'dupe_suggest',
    step: 'alternatives',
    template_id: upstreamOut.template_id || (finalRecommendationMode === 'pool_only' ? 'reco_alternatives_v1_0' : 'reco_alternatives_hybrid_v1'),
    has_candidates: poolResult.candidates.length > 0,
    candidate_count: poolResult.candidates.length,
    has_anchor: hasAnchorIdentity,
    duration_ms: finalPass ? finalPass.durationMs : 0,
    output_item_count: mapped.length,
    output_dupe_count: dupes.length,
    output_comparable_count: comparables.length,
    output_max_confidence: finalPass ? finalPass.maxConfidence : 0,
    has_meaningful_quality: hasMeaningfulQuality,
    source_mode: upstreamOut.source_mode || null,
    fallback_source: upstreamOut.fallback_source || null,
    recommendation_mode: finalRecommendationMode,
    profile_mode: profileMode,
    recommendation_mode_initial: recommendationMode,
    recommendation_mode_final: finalRecommendationMode,
    escalated_to_open_world: escalatedToOpenWorld,
    viability_failure_reasons: uniqueStrings(viabilityFailureReasons),
  }, 'aurora bff: dupe_suggest alternatives llm trace');

  // 5) KB backfill
  if (kbKey) {
    const kbWritePayload = {
      kb_key: kbKey,
      original: resolveOriginalForPayload(originalObj, originalUrl, inputText).original,
      dupes,
      comparables,
      verified,
      verified_at: verified ? new Date().toISOString() : null,
      verified_by: verified ? 'aurora_llm' : null,
      source: verified ? 'llm_generate' : 'llm_generate_empty',
      source_meta: {
        generated_at: new Date().toISOString(),
        max_dupes: maxDupes,
        max_comparables: maxComparables,
        recommendation_mode: finalRecommendationMode,
        recommendation_mode_initial: recommendationMode,
        recommendation_mode_final: finalRecommendationMode,
        profile_mode: profileMode,
        profile_context_present: profileMode === 'personalized',
        escalated_to_open_world: escalatedToOpenWorld,
        viability_failure_reasons: uniqueStrings(viabilityFailureReasons),
        has_anchor_identity: hasAnchorIdentity,
        attempted_queries: Array.isArray(poolResult?.meta?.attempted_queries) ? poolResult.meta.attempted_queries.slice(0, 6) : [],
        source_hit_counts: sourceHitCounts,
        final_source_mix: finalSourceMix,
        final_empty_reason: terminalEmptyReason,
        pre_filter_candidate_count: mapped.length,
        post_filter_candidate_count: finalPass && finalPass.evaluation ? finalPass.evaluation.candidateCountAfterViability : mapped.length,
        candidate_pool_meta: normalizeCandidatePoolMeta(poolResult && poolResult.meta),
        contract_version: DUPE_KB_CONTRACT_VERSION,
      },
      contract_version: DUPE_KB_CONTRACT_VERSION,
    };
    if (DUPE_KB_ASYNC_BACKFILL_ENABLED) {
      upsertDupeKbEntry(kbWritePayload).catch((err) => {
        logger?.warn(
          { err: err?.message || String(err), kb_key: kbKey },
          'aurora bff: async dupe kb backfill failed',
        );
      });
    } else {
      await upsertDupeKbEntry(kbWritePayload);
    }
  }

  // 6) Assemble payload + quality gate
  const resolvedOriginalFinal = resolveOriginalForPayload(originalObj, originalUrl, inputText);
  const candidatePoolMeta = normalizeCandidatePoolMeta(poolResult && poolResult.meta);
  const qualityAssessmentFinal = buildDupeSuggestQualityAssessment({
    resolvedOriginal: resolvedOriginalFinal,
    dupes,
    comparables,
    verified,
    hasMeaningfulQuality,
    candidatePoolMeta,
  });

  const payload = {
    kb_key: kbKey,
    original: resolvedOriginalFinal.original,
    anchor_resolution_status: resolvedOriginalFinal.anchor_resolution_status,
    dupes,
    comparables,
    verified,
    verified_at: verified ? new Date().toISOString() : null,
    source: verified ? 'llm_generate' : 'llm_generate_empty',
    quality: qualityAssessmentFinal,
    qualityAssessment: qualityAssessmentFinal,
    candidate_pool_meta: candidatePoolMeta,
    ...(terminalEmptyReason ? { empty_state_reason: terminalEmptyReason } : {}),
    meta: {
      served_from_kb: false,
      validated_now: true,
      force_refresh: forceRefresh,
      force_validate: forceValidate,
      kb_backfill_mode: DUPE_KB_ASYNC_BACKFILL_ENABLED ? 'async' : 'sync',
      recommendation_mode: finalRecommendationMode,
      recommendation_mode_initial: recommendationMode,
      recommendation_mode_final: finalRecommendationMode,
      profile_mode: profileMode,
      profile_context_present: profileMode === 'personalized',
      escalated_to_open_world: escalatedToOpenWorld,
      viability_failure_reasons: uniqueStrings(viabilityFailureReasons),
      has_anchor_identity: hasAnchorIdentity,
      attempted_queries: Array.isArray(poolResult?.meta?.attempted_queries) ? poolResult.meta.attempted_queries.slice(0, 6) : [],
      source_hit_counts: sourceHitCounts,
      final_source_mix: finalSourceMix,
      final_empty_reason: terminalEmptyReason,
      pre_filter_candidate_count: mapped.length,
      post_filter_candidate_count: finalPass && finalPass.evaluation ? finalPass.evaluation.candidateCountAfterViability : mapped.length,
      candidate_pool_meta: candidatePoolMeta,
      llm_trace: {
        task_mode: 'dupe_suggest',
        template_id: upstreamOut.template_id || (finalRecommendationMode === 'pool_only' ? 'reco_alternatives_v1_0' : 'reco_alternatives_hybrid_v1'),
        candidate_count: poolResult.candidates.length,
        has_anchor: hasAnchorIdentity,
        output_item_count: mapped.length,
        output_max_confidence: finalPass ? finalPass.maxConfidence : 0,
        quality_flags: qualityAssessmentFinal.quality_issues,
      },
    },
    ...(Array.isArray(upstreamOut.field_missing) && upstreamOut.field_missing.length ? { field_missing: upstreamOut.field_missing } : {}),
  };

  // P0-C: Hard quality gate
  const qualityGateResult = applyDupeSuggestQualityGate(payload, { lang: ctx.lang });
  const finalPayload = qualityGateResult.gated ? qualityGateResult.payload : payload;
  if (qualityGateResult.gated) {
    logger?.info(
      { event: 'dupe_suggest_quality_gate', request_id: ctx.request_id, reason: qualityGateResult.reason },
      'aurora bff: dupe_suggest quality gate enforced',
    );
  }

  return {
    ok: true,
    payload: finalPayload,
    event_kind: qualityGateResult.gated ? 'empty_state' : 'value_moment',
    event_source: 'llm',
    quality_gated: qualityGateResult.gated,
    event_reason: qualityGateResult.gated ? qualityGateResult.reason : null,
    field_missing: Array.isArray(upstreamOut.field_missing) ? upstreamOut.field_missing : [],
  };
}

module.exports = { executeDupeSuggest };
