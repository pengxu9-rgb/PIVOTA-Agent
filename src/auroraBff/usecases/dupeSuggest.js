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

const DUPE_SUGGEST_KB_CONTRACT_VERSION = 'dupe_suggest_v4';
const PLACEHOLDER_REASON_PATTERNS = [
  /^grounded alternatives derived from resolved candidate pool\.?$/i,
  /^based on resolved product candidates\.?$/i,
  /^\d+\s*%\s*similar$/i,
  /^相似度\s*\d+\s*%$/i,
  /^基于已解析商品候选给出 grounded alternatives。?$/i,
];

function uniqStrings(values) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const value = String(raw || '').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function mergeFieldMissingEntries(...lists) {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    for (const row of Array.isArray(list) ? list : []) {
      if (!row || typeof row !== 'object') continue;
      const field = String(row.field || '').trim();
      const reason = String(row.reason || '').trim();
      if (!field || !reason) continue;
      const key = `${field.toLowerCase()}::${reason.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ field, reason });
    }
  }
  return out;
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
  const profileMode = hasMeaningfulProfileSummary(profileSummary) ? 'personalized' : 'anchor_only';
  return { recommendationMode: 'pool_only', profileMode };
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

function buildFinalSourceMix(items, recommendationMode) {
  const sourceMix = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const origin = String(item && typeof item === 'object' ? item.candidate_origin : '').trim().toLowerCase();
    if (origin === 'open_world') sourceMix.add('open_world');
    if (origin === 'catalog') sourceMix.add('catalog');
  }
  if (!sourceMix.size && recommendationMode === 'open_world_only') sourceMix.add('open_world');
  return Array.from(sourceMix);
}

function buildStableCandidateKey(item) {
  const identity = getCandidateIdentity(item);
  const productId = String(identity.product_id || '').trim().toLowerCase();
  if (productId) return `product:${productId}`;
  const skuId = String(identity.sku_id || '').trim().toLowerCase();
  if (skuId) return `sku:${skuId}`;
  const url = String(identity.url || '').trim().toLowerCase();
  if (url) return `url:${url}`;
  const brand = String(identity.brand || '').trim().toLowerCase();
  const name = String(identity.name || '').trim().toLowerCase();
  if (brand || name) return `name:${brand}::${name}`;
  return '';
}

function mergeRankedItems(primaryItems, secondaryItems, { limit = 3 } = {}) {
  const out = [];
  const seen = new Set();
  const maxItems = Math.max(0, Math.trunc(Number(limit) || 0));
  const pushOne = (item) => {
    const key = buildStableCandidateKey(item);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(item);
  };
  for (const item of Array.isArray(primaryItems) ? primaryItems : []) {
    pushOne(item);
    if (out.length >= maxItems) return out.slice(0, maxItems);
  }
  for (const item of Array.isArray(secondaryItems) ? secondaryItems : []) {
    pushOne(item);
    if (out.length >= maxItems) break;
  }
  return out.slice(0, maxItems);
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
  return uniqStrings([...(Array.isArray(row.missing_info) ? row.missing_info : []), ...(Array.isArray(evidence.missing_info) ? evidence.missing_info : [])]).map((code) => code.toLowerCase());
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

function isPlaceholderLikeCandidate(item) {
  const hasReasons = hasMeaningfulReasons(item);
  const hasTradeoffs = hasMeaningfulTradeoffs(item);
  const sim = Number(item && item.similarity);
  const conf = Number(item && item.confidence);
  const hasSignal = (Number.isFinite(sim) && sim > 0) || (Number.isFinite(conf) && conf > 0);
  return !hasReasons && !hasTradeoffs && !hasSignal;
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
    failureReasons: uniqStrings(failureReasons),
  };
}

function evaluateLiveDupeCandidates(items, anchor, { maxDupes = 3, maxComparables = 2 } = {}) {
  const sanitizeResult = sanitizeCandidates(items);
  const selfRefResult = filterSelfReferences(sanitizeResult.sanitized, anchor);
  const dedupeResult = deduplicateCandidates(selfRefResult.kept);

  const afterIdentity = dedupeResult.deduplicated.filter((item) => hasMinimumComparableIdentity(item));
  const afterSynthetic = afterIdentity.filter((item) => !isLegacySyntheticCandidate(item));
  const afterPlaceholder = afterSynthetic.filter((item) => !isPlaceholderLikeCandidate(item));

  const kindOf = (row) => String(row && typeof row === 'object' ? row.kind : '').trim().toLowerCase();
  const dupes = afterPlaceholder.filter((item) => kindOf(item) === 'dupe').slice(0, maxDupes);
  const comparables = afterPlaceholder.filter((item) => kindOf(item) !== 'dupe').slice(0, maxComparables);
  const finalItems = [...dupes, ...comparables];
  const viable = finalItems.length > 0;
  const failureReasons = [];

  if (!viable) {
    if (selfRefResult.stats.self_ref_dropped_count > 0) failureReasons.push('self_ref_filtered');
    if (sanitizeResult.issues.some((issue) => String(issue && issue.code || '').toUpperCase() === 'NAME_IS_URL')) {
      failureReasons.push('name_url_sanitized');
    }
    if (dedupeResult.duplicateIssues.length > 0) failureReasons.push('duplicate_candidates_removed');
    if (afterIdentity.length < dedupeResult.deduplicated.length) failureReasons.push('missing_identity');
    if (afterSynthetic.length < afterIdentity.length) failureReasons.push('synthetic_candidates_removed');
    if (afterPlaceholder.length < afterSynthetic.length) failureReasons.push('placeholder_candidates_removed');
  }

  const hasMeaningfulQuality = finalItems.some((item) => {
    if (hasMeaningfulTradeoffs(item)) return true;
    if (hasMeaningfulReasons(item)) return true;
    const sim = Number(item && item.similarity);
    if (Number.isFinite(sim) && sim > 0) return true;
    const conf = Number(item && item.confidence);
    return Number.isFinite(conf) && conf > 0;
  });

  return {
    dupes,
    comparables,
    finalItems,
    viable,
    hasMeaningfulQuality,
    rawCount: Array.isArray(items) ? items.length : 0,
    candidateCountAfterSanitize: sanitizeResult.sanitized.length,
    candidateCountAfterSelfRef: selfRefResult.kept.length,
    candidateCountAfterDedupe: dedupeResult.deduplicated.length,
    candidateCountAfterIdentity: afterIdentity.length,
    candidateCountAfterSynthetic: afterSynthetic.length,
    candidateCountAfterPlaceholder: afterPlaceholder.length,
    candidateCountAfterViability: finalItems.length,
    selfRefDroppedCount: selfRefResult.stats.self_ref_dropped_count,
    failureReasons: uniqStrings(failureReasons),
  };
}

function getKbSourceMeta(entry) {
  return entry && entry.source_meta && typeof entry.source_meta === 'object' && !Array.isArray(entry.source_meta)
    ? entry.source_meta
    : {};
}

function assessKbCompatibility(entry, resolvedOriginal, { maxDupes = 3, maxComparables = 2 } = {}) {
  const sourceMeta = getKbSourceMeta(entry);
  const items = [
    ...(Array.isArray(entry && entry.dupes) ? entry.dupes : []),
    ...(Array.isArray(entry && entry.comparables) ? entry.comparables : []),
  ];
  const evaluation = evaluateDupeCandidates(items, resolvedOriginal.original, { maxDupes, maxComparables });
  const contractVersion = String(sourceMeta.contract_version || '').trim();
  const compatible = contractVersion === DUPE_SUGGEST_KB_CONTRACT_VERSION
    && Boolean(String(sourceMeta.recommendation_mode || '').trim())
    && Boolean(String(sourceMeta.profile_mode || '').trim())
    && !items.some((item) => isLegacySyntheticCandidate(item))
    && (items.length === 0 || evaluation.viable);
  return {
    compatible,
    sourceMeta,
    evaluation,
    contractVersion,
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
      const key = String(
        row.sku_id
        || row.product_id
        || row.id
        || row.url
        || row.pdp_url
        || ([row.brand, row.display_name || row.name].filter(Boolean).join('::'))
        || row.name
        || '',
      ).trim().toLowerCase();
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
  const buildKbPayload = (kbEntry, kbKey, resolvedOriginal, compatibility) => {
    const kbEvaluation = compatibility && compatibility.evaluation ? compatibility.evaluation : evaluateDupeCandidates(
      [
        ...(Array.isArray(kbEntry.dupes) ? kbEntry.dupes : []),
        ...(Array.isArray(kbEntry.comparables) ? kbEntry.comparables : []),
      ],
      resolvedOriginal.original,
      { maxDupes, maxComparables },
    );
    const sourceMeta = compatibility && compatibility.sourceMeta ? compatibility.sourceMeta : getKbSourceMeta(kbEntry);
    const dupesKb = kbEvaluation.dupes;
    const comparablesKb = kbEvaluation.comparables;
    const hasMeaningfulQualityKb = kbEvaluation.hasMeaningfulQuality;
    const verifiedKb = dupesKb.length + comparablesKb.length > 0 && hasMeaningfulQualityKb;
    const candidatePoolMeta = normalizeCandidatePoolMeta(
      sourceMeta.candidate_pool_meta || {
        count: sourceMeta.pre_filter_candidate_count,
        sources_used: sourceMeta.final_source_mix,
      },
    );
    const qualityAssessmentKb = buildDupeSuggestQualityAssessment({
      resolvedOriginal,
      dupes: dupesKb,
      comparables: comparablesKb,
      verified: verifiedKb,
      hasMeaningfulQuality: hasMeaningfulQualityKb,
      candidatePoolMeta,
    });
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
      ...(sourceMeta.final_empty_reason ? { empty_state_reason: sourceMeta.final_empty_reason } : {}),
      meta: {
        served_from_kb: true,
        validated_now: false,
        recommendation_mode: sourceMeta.recommendation_mode || null,
        recommendation_mode_initial: sourceMeta.recommendation_mode_initial || sourceMeta.recommendation_mode || null,
        recommendation_mode_final: sourceMeta.recommendation_mode_final || sourceMeta.recommendation_mode || null,
        profile_mode: sourceMeta.profile_mode || null,
        profile_context_present: sourceMeta.profile_context_present === true,
        attempted_queries: Array.isArray(sourceMeta.attempted_queries) ? sourceMeta.attempted_queries.slice(0, 6) : [],
        source_hit_counts: sourceMeta.source_hit_counts || { catalog_search: 0, product_embedded: 0, open_world_fallback: 0 },
        final_source_mix: Array.isArray(sourceMeta.final_source_mix) ? sourceMeta.final_source_mix : [],
        final_empty_reason: sourceMeta.final_empty_reason || null,
        viability_failure_reasons: Array.isArray(sourceMeta.viability_failure_reasons) ? sourceMeta.viability_failure_reasons : [],
        escalated_to_open_world: sourceMeta.escalated_to_open_world === true,
        has_anchor_identity: sourceMeta.has_anchor_identity === true,
        candidate_pool_meta: candidatePoolMeta,
      },
    };
  };

  // 1) KB fast-path
  let kbKey = _buildKbKey({ anchor: anchorId, url: originalUrl, text: inputText });
  let kbEntry = kbKey ? await getDupeKbEntry(kbKey) : null;
  const initialResolvedOriginal = resolveOriginalForPayload(kbEntry && kbEntry.original ? kbEntry.original : originalObj, originalUrl, inputText);
  const kbCompatibility1 = kbEntry
    ? assessKbCompatibility(kbEntry, initialResolvedOriginal, { maxDupes, maxComparables })
    : null;
  const canServeKb1 = kbEntry && kbEntry.verified === true && kbCompatibility1 && kbCompatibility1.compatible && !forceRefresh && !forceValidate;
  if (canServeKb1) {
    const resolved = initialResolvedOriginal;
    return {
      ok: true,
      payload: buildKbPayload(kbEntry, kbKey, resolved, kbCompatibility1),
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
    const stableResolvedOriginal = resolveOriginalForPayload(kbEntry && kbEntry.original ? kbEntry.original : originalObj, originalUrl, inputText);
    const kbCompatibility2 = kbEntry
      ? assessKbCompatibility(kbEntry, stableResolvedOriginal, { maxDupes, maxComparables })
      : null;
    const canServeKb2 = kbEntry && kbEntry.verified === true && kbCompatibility2 && kbCompatibility2.compatible && !forceRefresh && !forceValidate;
    if (canServeKb2) {
      return {
        ok: true,
        payload: buildKbPayload(kbEntry, kbKey, stableResolvedOriginal, kbCompatibility2),
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
  const { recommendationMode, profileMode } = resolveDupeSuggestionModes({ profileSummary });
  const hasAnchorIdentity = hasUsableAnchorIdentity({
    anchorId,
    originalObj,
    originalUrl,
    inputText,
  });

  // 4) Fetch alternatives from LLM
  const runRecommendationPass = async (mode) => {
    const modeCandidatePool = mode === 'open_world_only'
      ? []
      : (Array.isArray(poolResult.candidates) ? poolResult.candidates : []);
    const anchorForEvaluation = resolveOriginalForPayload(originalObj, originalUrl, inputText).original;
    if (mode === 'pool_only' && modeCandidatePool.length === 0) {
      const emptyEvaluation = evaluateLiveDupeCandidates([], anchorForEvaluation, { maxDupes, maxComparables });
      return {
        recommendationMode: mode,
        candidatePoolSize: 0,
        upstreamOut: {
          alternatives: [],
          field_missing: [],
          source_mode: 'pool_only',
          fallback_source: 'none',
          no_result_reason: 'candidate_pool_empty',
          template_id: 'reco_alternatives_v1_0',
        },
        mapped: [],
        liveEvaluation: emptyEvaluation,
        persistEvaluation: evaluateDupeCandidates([], anchorForEvaluation, { maxDupes, maxComparables }),
        durationMs: 0,
        maxConfidence: 0,
      };
    }
    const startedAt = Date.now();
    const upstreamOut = await fetchRecoAlternativesForProduct({
      ctx,
      profileSummary,
      recentLogs,
      productInput: inputText,
      productObj: originalObj,
      anchorId,
      maxTotal: mode === 'open_world_only'
        ? Math.max(1, total - poolPass.liveEvaluation.finalItems.length)
        : total,
      candidatePool: modeCandidatePool,
      debug: false,
      logger,
      options: {
        recommendation_mode: mode,
        profile_mode: profileMode,
        context_action_id: 'chip.action.find_dupe',
        disable_fallback: true,
        disable_synthetic_local_fallback: true,
        ignore_selector_candidates: mode === 'open_world_only',
      },
    });
    const mapped = Array.isArray(upstreamOut.alternatives) ? upstreamOut.alternatives : [];
    const liveEvaluation = evaluateLiveDupeCandidates(mapped, anchorForEvaluation, { maxDupes, maxComparables });
    const persistEvaluation = evaluateDupeCandidates(mapped, anchorForEvaluation, { maxDupes, maxComparables });
    const maxConfidence = mapped.reduce((mx, it) => {
      const confidence = it && typeof it === 'object' ? Number(it.confidence) : 0;
      return Number.isFinite(confidence) && confidence > mx ? confidence : mx;
    }, 0);
    return {
      recommendationMode: mode,
      candidatePoolSize: Array.isArray(modeCandidatePool) ? modeCandidatePool.length : 0,
      upstreamOut,
      mapped,
      liveEvaluation,
      persistEvaluation,
      durationMs: Date.now() - startedAt,
      maxConfidence,
    };
  };

  const poolPass = await runRecommendationPass('pool_only');
  const openWorldNeeded = poolPass.liveEvaluation.finalItems.length < total;
  const openWorldPass = openWorldNeeded ? await runRecommendationPass('open_world_only') : null;

  const recommendationModeFinal = openWorldPass ? 'open_world_only' : recommendationMode;
  const openWorldSupplementUsed = Boolean(openWorldPass);
  const escalatedToOpenWorld = openWorldSupplementUsed;
  const dupes = mergeRankedItems(
    poolPass.liveEvaluation.dupes,
    openWorldPass ? openWorldPass.liveEvaluation.dupes : [],
    { limit: maxDupes },
  );
  const comparables = mergeRankedItems(
    poolPass.liveEvaluation.comparables,
    openWorldPass ? openWorldPass.liveEvaluation.comparables : [],
    { limit: maxComparables },
  );
  const finalItems = [...dupes, ...comparables];
  const combinedMapped = [
    ...(Array.isArray(poolPass.mapped) ? poolPass.mapped : []),
    ...(openWorldPass && Array.isArray(openWorldPass.mapped) ? openWorldPass.mapped : []),
  ];
  const finalPersistEvaluation = evaluateDupeCandidates(
    finalItems,
    resolveOriginalForPayload(originalObj, originalUrl, inputText).original,
    { maxDupes, maxComparables },
  );
  const finalLiveEvaluation = evaluateLiveDupeCandidates(
    finalItems,
    resolveOriginalForPayload(originalObj, originalUrl, inputText).original,
    { maxDupes, maxComparables },
  );
  const viabilityFailureReasons = [];
  const hasResults = dupes.length > 0 || comparables.length > 0;
  viabilityFailureReasons.push(...poolPass.liveEvaluation.failureReasons);
  if (openWorldPass) viabilityFailureReasons.push(...openWorldPass.liveEvaluation.failureReasons);
  const hasMeaningfulQuality = finalLiveEvaluation.hasMeaningfulQuality;
  const verified = hasResults && finalPersistEvaluation.viable;
  const terminalEmptyReason = hasResults
    ? null
    : buildTerminalEmptyReason({
      recommendationMode: recommendationModeFinal,
      profileMode,
      upstreamNoResultReason: openWorldPass && openWorldPass.upstreamOut
        ? openWorldPass.upstreamOut.no_result_reason
        : poolPass.upstreamOut && poolPass.upstreamOut.no_result_reason,
    });
  const finalSourceMix = buildFinalSourceMix(finalItems, recommendationModeFinal);
  const sourceHitCounts = buildSourceHitCounts(poolResult && poolResult.meta, finalItems);

  // LLM trace
  logger?.info({
    event: 'llm_call_trace',
    task_mode: 'dupe_suggest',
    step: 'alternatives',
    template_id: (openWorldPass && openWorldPass.upstreamOut && openWorldPass.upstreamOut.template_id)
      || (poolPass.upstreamOut && poolPass.upstreamOut.template_id)
      || (recommendationModeFinal === 'pool_only' ? 'reco_alternatives_v1_0' : 'reco_alternatives_hybrid_v1'),
    has_candidates: poolResult.candidates.length > 0,
    candidate_count: poolResult.candidates.length,
    has_anchor: hasAnchorIdentity,
    duration_ms: poolPass.durationMs + (openWorldPass ? openWorldPass.durationMs : 0),
    output_item_count: combinedMapped.length,
    output_dupe_count: dupes.length,
    output_comparable_count: comparables.length,
    output_max_confidence: Math.max(poolPass.maxConfidence, openWorldPass ? openWorldPass.maxConfidence : 0),
    has_meaningful_quality: hasMeaningfulQuality,
    source_mode: openWorldPass && openWorldPass.upstreamOut
      ? openWorldPass.upstreamOut.source_mode || null
      : poolPass.upstreamOut ? poolPass.upstreamOut.source_mode || null : null,
    fallback_source: openWorldPass && openWorldPass.upstreamOut
      ? openWorldPass.upstreamOut.fallback_source || null
      : poolPass.upstreamOut ? poolPass.upstreamOut.fallback_source || null : null,
    recommendation_mode_initial: recommendationMode,
    recommendation_mode_final: recommendationModeFinal,
    profile_mode: profileMode,
    escalated_to_open_world: escalatedToOpenWorld,
    open_world_supplement_used: openWorldSupplementUsed,
    viability_failure_reasons: uniqStrings(viabilityFailureReasons),
    output_preview_products: finalItems
      .slice(0, 3)
      .map((item) => {
        const product = item && typeof item === 'object' ? item.product : null;
        const brand = product && typeof product === 'object' ? String(product.brand || '').trim() : '';
        const name = product && typeof product === 'object' ? String(product.name || '').trim() : '';
        return [brand, name].filter(Boolean).join(' ').trim() || null;
      })
      .filter(Boolean),
    pre_post_filter_counts: {
      raw: combinedMapped.length,
      after_sanitize: poolPass.liveEvaluation.candidateCountAfterSanitize + (openWorldPass ? openWorldPass.liveEvaluation.candidateCountAfterSanitize : 0),
      after_self_ref: poolPass.liveEvaluation.candidateCountAfterSelfRef + (openWorldPass ? openWorldPass.liveEvaluation.candidateCountAfterSelfRef : 0),
      after_dedupe: poolPass.liveEvaluation.candidateCountAfterDedupe + (openWorldPass ? openWorldPass.liveEvaluation.candidateCountAfterDedupe : 0),
      after_identity: poolPass.liveEvaluation.candidateCountAfterIdentity + (openWorldPass ? openWorldPass.liveEvaluation.candidateCountAfterIdentity : 0),
      after_synthetic: poolPass.liveEvaluation.candidateCountAfterSynthetic + (openWorldPass ? openWorldPass.liveEvaluation.candidateCountAfterSynthetic : 0),
      after_placeholder: poolPass.liveEvaluation.candidateCountAfterPlaceholder + (openWorldPass ? openWorldPass.liveEvaluation.candidateCountAfterPlaceholder : 0),
      after_viability: finalLiveEvaluation.candidateCountAfterViability,
    },
  }, 'aurora bff: dupe_suggest alternatives llm trace');

  // 5) KB backfill
  const kbGatePayload = {
    dupes,
    comparables,
    candidate_pool_meta: normalizeCandidatePoolMeta(poolResult && poolResult.meta),
    empty_state_reason: terminalEmptyReason,
    meta: {
      final_empty_reason: terminalEmptyReason,
    },
  };
  const kbGateResult = applyDupeSuggestQualityGate(kbGatePayload, { lang: ctx.lang });
  const kbPersistAllowed = hasResults && !kbGateResult.gated;
  if (kbKey && kbPersistAllowed) {
    const kbWritePayload = {
      kb_key: kbKey,
      original: resolveOriginalForPayload(originalObj, originalUrl, inputText).original,
      dupes,
      comparables,
      verified,
      verified_at: verified ? new Date().toISOString() : null,
      verified_by: verified ? 'aurora_llm' : null,
      source: hasResults ? 'llm_generate' : 'llm_generate_empty',
      source_meta: {
        contract_version: DUPE_SUGGEST_KB_CONTRACT_VERSION,
        generated_at: new Date().toISOString(),
        max_dupes: maxDupes,
        max_comparables: maxComparables,
        recommendation_mode: recommendationModeFinal,
        recommendation_mode_initial: recommendationMode,
        recommendation_mode_final: recommendationModeFinal,
        profile_mode: profileMode,
        profile_context_present: profileMode === 'personalized',
        open_world_supplement_used: openWorldSupplementUsed,
        attempted_queries: Array.isArray(poolResult?.meta?.attempted_queries) ? poolResult.meta.attempted_queries.slice(0, 6) : [],
        source_hit_counts: sourceHitCounts,
        final_source_mix: finalSourceMix,
        final_empty_reason: terminalEmptyReason,
        pre_filter_candidate_count: combinedMapped.length,
        post_filter_candidate_count: finalPersistEvaluation.candidateCountAfterViability,
        candidate_pool_meta: normalizeCandidatePoolMeta(poolResult && poolResult.meta),
        escalated_to_open_world: escalatedToOpenWorld,
        viability_failure_reasons: uniqStrings(viabilityFailureReasons),
        has_anchor_identity: hasAnchorIdentity,
      },
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
  } else if (kbKey && logger) {
    logger.info(
      {
        event: 'dupe_suggest_kb_backfill_blocked',
        request_id: ctx.request_id,
        kb_key: kbKey,
        reason: kbGateResult.reason || 'kb_persist_gate_failed',
      },
      'aurora bff: dupe_suggest kb backfill blocked',
    );
  }

  // 6) Assemble payload
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
    source: hasResults ? 'llm_generate' : 'llm_generate_empty',
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
      recommendation_mode: recommendationModeFinal,
      recommendation_mode_initial: recommendationMode,
      recommendation_mode_final: recommendationModeFinal,
      profile_mode: profileMode,
      profile_context_present: profileMode === 'personalized',
      open_world_supplement_used: openWorldSupplementUsed,
      escalated_to_open_world: escalatedToOpenWorld,
      viability_failure_reasons: uniqStrings(viabilityFailureReasons),
      has_anchor_identity: hasAnchorIdentity,
      attempted_queries: Array.isArray(poolResult?.meta?.attempted_queries) ? poolResult.meta.attempted_queries.slice(0, 6) : [],
      source_hit_counts: sourceHitCounts,
      final_source_mix: finalSourceMix,
      final_empty_reason: terminalEmptyReason,
      pre_filter_candidate_count: combinedMapped.length,
      post_filter_candidate_count: finalLiveEvaluation.candidateCountAfterViability,
      candidate_pool_meta: candidatePoolMeta,
      llm_trace: {
        task_mode: 'dupe_suggest',
        template_id: (openWorldPass && openWorldPass.upstreamOut && openWorldPass.upstreamOut.template_id)
          || (poolPass.upstreamOut && poolPass.upstreamOut.template_id)
          || (recommendationModeFinal === 'pool_only' ? 'reco_alternatives_v1_0' : 'reco_alternatives_hybrid_v1'),
        candidate_count: poolResult.candidates.length,
        has_anchor: hasAnchorIdentity,
        output_item_count: combinedMapped.length,
        output_max_confidence: Math.max(poolPass.maxConfidence, openWorldPass ? openWorldPass.maxConfidence : 0),
        quality_flags: qualityAssessmentFinal.quality_issues,
      },
      ...(kbPersistAllowed ? {} : { kb_backfill_blocked_reason: kbGateResult.reason || 'kb_persist_gate_failed' }),
    },
    ...(mergeFieldMissingEntries(
      Array.isArray(poolPass.upstreamOut && poolPass.upstreamOut.field_missing) ? poolPass.upstreamOut.field_missing : [],
      Array.isArray(openWorldPass && openWorldPass.upstreamOut && openWorldPass.upstreamOut.field_missing) ? openWorldPass.upstreamOut.field_missing : [],
    ).length ? {
      field_missing: mergeFieldMissingEntries(
        Array.isArray(poolPass.upstreamOut && poolPass.upstreamOut.field_missing) ? poolPass.upstreamOut.field_missing : [],
        Array.isArray(openWorldPass && openWorldPass.upstreamOut && openWorldPass.upstreamOut.field_missing) ? openWorldPass.upstreamOut.field_missing : [],
      ),
    } : {}),
  };

  return {
    ok: true,
    payload,
    event_kind: hasResults ? 'value_moment' : 'empty_state',
    event_source: 'llm',
    quality_gated: false,
    event_reason: null,
    field_missing: mergeFieldMissingEntries(
      Array.isArray(poolPass.upstreamOut && poolPass.upstreamOut.field_missing) ? poolPass.upstreamOut.field_missing : [],
      Array.isArray(openWorldPass && openWorldPass.upstreamOut && openWorldPass.upstreamOut.field_missing) ? openWorldPass.upstreamOut.field_missing : [],
    ),
  };
}

module.exports = { executeDupeSuggest };
