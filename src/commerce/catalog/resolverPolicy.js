const {
  normalizeAgentSource: normalizeAgentSourceBase,
  isCreatorUiSource: isCreatorUiSourceBase,
  isAuroraSource: isAuroraSourceBase,
  isResolverFirstCatalogSource: isResolverFirstCatalogSourceBase,
} = require('./searchGuards');

const LOOKUP_EQUIVALENCE_FAMILIES = [
  ['winona', '薇诺娜'],
  ['ipsa', '茵芙莎', '流金水'],
  ['time reset aqua', '流金水', 'ipsa'],
  ['the ordinary', 'ordinary'],
  ['sk ii', 'skii', '神仙水'],
];

function isKnownLookupAliasQuery({
  queryText,
  normalizeSearchTextForMatch,
} = {}) {
  const normalizedQuery =
    typeof normalizeSearchTextForMatch === 'function'
      ? normalizeSearchTextForMatch(queryText)
      : String(queryText || '').trim().toLowerCase();
  if (!normalizedQuery) return false;
  for (const family of LOOKUP_EQUIVALENCE_FAMILIES) {
    const normalizedFamilyTerms = family
      .map((term) =>
        typeof normalizeSearchTextForMatch === 'function'
          ? normalizeSearchTextForMatch(term)
          : String(term || '').trim().toLowerCase(),
      )
      .filter(Boolean);
    if (normalizedFamilyTerms.some((term) => term && normalizedQuery.includes(term))) {
      return true;
    }
  }
  return false;
}

function expandLookupAnchorTokens({
  queryText,
  anchorTokens,
  normalizeSearchTextForMatch,
  tokenizeSearchTextForMatch,
} = {}) {
  const normalize = (value) =>
    typeof normalizeSearchTextForMatch === 'function'
      ? normalizeSearchTextForMatch(value)
      : String(value || '').trim().toLowerCase();
  const tokenize = (value) =>
    typeof tokenizeSearchTextForMatch === 'function'
      ? tokenizeSearchTextForMatch(value)
      : String(value || '')
          .split(/\s+/)
          .map((item) => normalize(item))
          .filter(Boolean);

  const normalizedQuery = normalize(queryText);
  const normalizedAnchors = Array.isArray(anchorTokens)
    ? anchorTokens.map((token) => normalize(token)).filter(Boolean)
    : [];
  const expanded = new Set(normalizedAnchors);
  const anchorSet = new Set(normalizedAnchors);
  const queryTokens = new Set(tokenize(normalizedQuery));

  for (const family of LOOKUP_EQUIVALENCE_FAMILIES) {
    const normalizedFamilyTerms = family.map((term) => normalize(term)).filter(Boolean);
    if (!normalizedFamilyTerms.length) continue;

    const matched = normalizedFamilyTerms.some((term) => {
      if (!term) return false;
      if (anchorSet.has(term)) return true;
      if (normalizedQuery.includes(term)) return true;
      return !term.includes(' ') && queryTokens.has(term);
    });
    if (!matched) continue;

    for (const term of normalizedFamilyTerms) {
      expanded.add(term);
      if (term.includes(' ')) {
        for (const sub of term.split(' ')) {
          const normalizedSub = normalize(sub);
          if (normalizedSub && normalizedSub.length >= 2) {
            expanded.add(normalizedSub);
          }
        }
      }
    }
  }

  return Array.from(expanded);
}

function isResolverMiss(result) {
  if (!result || typeof result !== 'object') return false;
  return Number(result.usableCount || 0) <= 0;
}

function shouldReducePrimaryTimeoutAfterResolverMiss({
  result,
  queryText = '',
  hasPetSearchSignal,
  normalizeOffersResolveReasonCode,
} = {}) {
  if (!isResolverMiss(result)) return false;
  if (typeof hasPetSearchSignal === 'function' && hasPetSearchSignal(queryText)) return false;
  const reasonCode =
    typeof normalizeOffersResolveReasonCode === 'function'
      ? normalizeOffersResolveReasonCode(
          result?.resolve_reason_code || result?.resolve_reason || '',
          '',
        )
      : String(result?.resolve_reason_code || result?.resolve_reason || '')
          .trim()
          .toLowerCase();
  return (
    reasonCode === 'no_candidates' ||
    reasonCode === 'upstream_timeout' ||
    reasonCode === 'db_timeout'
  );
}

function isUuidLikeSearchQuery(value) {
  const s = String(value || '').trim();
  if (!s) return false;
  return (
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(s) ||
    /^[0-9a-f]{32}$/i.test(s)
  );
}

function isStrongResolverFirstQuery({
  queryText,
  isKnownLookupAliasQuery: isKnownLookupAliasQueryImpl,
  resolveStableAliasByQuery,
  buildResolverQueryCandidates,
  normalizeResolverText,
  tokenizeResolverQuery,
} = {}) {
  const raw = String(queryText || '').trim();
  if (!raw) return false;
  if (typeof isKnownLookupAliasQueryImpl === 'function' && isKnownLookupAliasQueryImpl(raw)) {
    return true;
  }
  if (isUuidLikeSearchQuery(raw)) return true;
  if (!resolveStableAliasByQuery) return false;

  const queryCandidates =
    typeof buildResolverQueryCandidates === 'function'
      ? buildResolverQueryCandidates(raw)
      : [];
  for (const candidate of queryCandidates) {
    try {
      const normalized =
        typeof normalizeResolverText === 'function'
          ? normalizeResolverText(candidate)
          : String(candidate || '').trim().toLowerCase();
      const tokens = typeof tokenizeResolverQuery === 'function'
        ? tokenizeResolverQuery(normalized)
        : String(normalized || '')
            .split(/\s+/)
            .map((item) => String(item || '').trim())
            .filter(Boolean);
      if (!normalized || !tokens.length) continue;
      const match = resolveStableAliasByQuery({
        query: candidate,
        normalizedQuery: normalized,
        queryTokens: tokens,
      });
      if (
        match &&
        match.product_ref &&
        String(match.product_ref.product_id || '').trim() &&
        String(match.product_ref.merchant_id || '').trim()
      ) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

function getSecondaryFallbackSkipReason({
  result,
  queryText = '',
  disableSkipAfterResolverMiss = false,
  queryClass = null,
  brandLike = false,
  proxySearchSkipSecondaryFallbackAfterResolverMiss = false,
  hasPetSearchSignal,
  hasFragranceQuerySignal,
  shouldReducePrimaryTimeoutAfterResolverMiss: shouldReducePrimaryTimeoutAfterResolverMissImpl,
  isKnownLookupAliasQuery: isKnownLookupAliasQueryImpl,
  extractSearchAnchorTokens,
  isLookupStyleSearchQuery,
  fpmGateSimplifyV1 = false,
  fpmLookupOnlyResolver = false,
  isStrongResolverFirstQuery: isStrongResolverFirstQueryImpl,
} = {}) {
  if (disableSkipAfterResolverMiss) return null;
  if (!proxySearchSkipSecondaryFallbackAfterResolverMiss) return null;
  if (typeof hasPetSearchSignal === 'function' && hasPetSearchSignal(queryText)) return null;
  if (typeof hasFragranceQuerySignal === 'function' && hasFragranceQuerySignal(queryText)) return null;
  if (
    typeof shouldReducePrimaryTimeoutAfterResolverMissImpl !== 'function' ||
    !shouldReducePrimaryTimeoutAfterResolverMissImpl(result, queryText)
  ) {
    return null;
  }
  if (brandLike) return null;
  if (typeof isKnownLookupAliasQueryImpl === 'function' && isKnownLookupAliasQueryImpl(queryText)) {
    return null;
  }

  const resolverSources = Array.isArray(result?.resolve_sources)
    ? result.resolve_sources
    : Array.isArray(result?.metadata?.sources)
      ? result.metadata.sources
      : [];
  const hasResolverPositiveSource =
    resolverSources.length > 0 &&
    resolverSources.some((item) => {
      if (!item || typeof item !== 'object') return false;
      if (item.ok === true) return true;
      const count = Number(item.count || 0);
      return Number.isFinite(count) && count > 0;
    });
  if (resolverSources.length > 0 && !hasResolverPositiveSource) {
    return 'resolver_miss_skip_secondary';
  }

  const normalizedQueryClass = String(queryClass || '').trim().toLowerCase();
  const lookupOnlyClasses = new Set(['lookup', 'attribute']);
  const forceSearchFirstClasses = new Set([
    'category',
    'exploratory',
    'scenario',
    'mission',
    'gift',
    'non_shopping',
  ]);
  if (normalizedQueryClass && forceSearchFirstClasses.has(normalizedQueryClass)) {
    return null;
  }

  const anchorTokens =
    typeof extractSearchAnchorTokens === 'function'
      ? extractSearchAnchorTokens(queryText)
      : [];
  const lookupStyle =
    typeof isLookupStyleSearchQuery === 'function'
      ? isLookupStyleSearchQuery(queryText, anchorTokens)
      : false;
  if (
    fpmGateSimplifyV1 &&
    fpmLookupOnlyResolver &&
    ((!normalizedQueryClass && !lookupStyle) ||
      (normalizedQueryClass && !lookupOnlyClasses.has(normalizedQueryClass)))
  ) {
    return null;
  }
  if (isUuidLikeSearchQuery(queryText)) return 'resolver_miss_uuid_like';
  if (
    typeof isStrongResolverFirstQueryImpl === 'function' &&
    isStrongResolverFirstQueryImpl(queryText)
  ) {
    return 'resolver_miss_strong_resolver_query';
  }
  if (lookupStyle) return 'resolver_miss_lookup_style';
  return null;
}

function shouldSkipSecondaryFallbackAfterResolverMiss({
  result,
  queryText = '',
  disableSkipAfterResolverMiss = false,
  queryClass = null,
  brandLike = false,
  getSecondaryFallbackSkipReason: getSecondaryFallbackSkipReasonImpl,
} = {}) {
  return Boolean(
    typeof getSecondaryFallbackSkipReasonImpl === 'function' &&
      getSecondaryFallbackSkipReasonImpl({
        result,
        queryText,
        disableSkipAfterResolverMiss,
        queryClass,
        brandLike,
      }),
  );
}

function shouldAllowSecondaryFallback({
  operation,
  forceSecondaryFallback = false,
  proxySearchSecondaryFallbackMultiEnabled = false,
} = {}) {
  if (forceSecondaryFallback) return true;
  if (operation === 'find_products_multi') {
    return proxySearchSecondaryFallbackMultiEnabled;
  }
  return true;
}

function shouldAllowInvokeFallback({
  operation,
  forceInvokeFallback = false,
  proxySearchInvokeFallbackEnabled = false,
} = {}) {
  if (forceInvokeFallback) return true;
  if (!(operation === 'find_products' || operation === 'find_products_multi')) return false;
  return proxySearchInvokeFallbackEnabled;
}

function shouldAllowResolverFallback({
  operation,
  proxySearchResolverFallbackEnabled = false,
} = {}) {
  if (!(operation === 'find_products' || operation === 'find_products_multi')) return false;
  return proxySearchResolverFallbackEnabled;
}

function shouldUseResolverFirstSearch({
  operation,
  metadata,
  queryText,
  remainingBudgetMs = null,
  queryClass = null,
  brandLike = false,
  allowBroadCatalog = false,
  proxySearchResolverFirstEnabled = false,
  fpmLatencyGuardResolverMinRemainingMs = 0,
  fpmGateSimplifyV1 = false,
  extractSearchAnchorTokens,
  isLookupStyleSearchQuery,
  isStrongResolverFirstQuery: isStrongResolverFirstQueryImpl,
  fpmLookupOnlyResolver = false,
  normalizeAgentSource = normalizeAgentSourceBase,
  isCreatorUiSource = isCreatorUiSourceBase,
  isAuroraSource = isAuroraSourceBase,
  proxySearchResolverFirstDisableAurora = false,
  isResolverFirstCatalogSource = isResolverFirstCatalogSourceBase,
  proxySearchResolverFirstStrongOnly = false,
} = {}) {
  if (!proxySearchResolverFirstEnabled) return false;
  if (!(operation === 'find_products' || operation === 'find_products_multi')) return false;
  if (!String(queryText || '').trim()) return false;
  if (
    Number.isFinite(Number(remainingBudgetMs)) &&
    Number(remainingBudgetMs) < fpmLatencyGuardResolverMinRemainingMs
  ) {
    return false;
  }

  const normalizedQueryClass = String(queryClass || '').trim().toLowerCase();
  const forceSearchFirstClasses = new Set([
    'category',
    'exploratory',
    'scenario',
    'mission',
    'gift',
    'non_shopping',
  ]);
  if (
    fpmGateSimplifyV1 &&
    normalizedQueryClass &&
    forceSearchFirstClasses.has(normalizedQueryClass)
  ) {
    return false;
  }

  const anchorTokens =
    typeof extractSearchAnchorTokens === 'function'
      ? extractSearchAnchorTokens(queryText)
      : [];
  const lookupStyle =
    typeof isLookupStyleSearchQuery === 'function'
      ? isLookupStyleSearchQuery(queryText, anchorTokens)
      : false;
  const strongResolverQuery =
    typeof isStrongResolverFirstQueryImpl === 'function'
      ? isStrongResolverFirstQueryImpl(queryText)
      : false;
  if (brandLike && !allowBroadCatalog && !(lookupStyle || strongResolverQuery)) return false;
  const lookupOnlyClasses = new Set(['lookup', 'attribute']);
  if (
    fpmGateSimplifyV1 &&
    fpmLookupOnlyResolver &&
    !allowBroadCatalog &&
    !strongResolverQuery &&
    ((!normalizedQueryClass && !lookupStyle) ||
      (normalizedQueryClass && !lookupOnlyClasses.has(normalizedQueryClass)))
  ) {
    return false;
  }

  const source =
    typeof normalizeAgentSource === 'function'
      ? normalizeAgentSource(metadata?.source)
      : String(metadata?.source || '').trim().toLowerCase() || null;
  if (typeof isCreatorUiSource === 'function' && isCreatorUiSource(source)) return false;
  const auroraSource = typeof isAuroraSource === 'function' && isAuroraSource(source);
  if (auroraSource && proxySearchResolverFirstDisableAurora) return false;
  if (!source) return true;
  const isCatalogSource =
    typeof isResolverFirstCatalogSource === 'function'
      ? isResolverFirstCatalogSource(source)
      : false;
  if (proxySearchResolverFirstStrongOnly && (isCatalogSource || auroraSource)) {
    return strongResolverQuery || lookupStyle;
  }

  return isCatalogSource || auroraSource;
}

module.exports = {
  isKnownLookupAliasQuery,
  expandLookupAnchorTokens,
  isResolverMiss,
  shouldReducePrimaryTimeoutAfterResolverMiss,
  isUuidLikeSearchQuery,
  isStrongResolverFirstQuery,
  getSecondaryFallbackSkipReason,
  shouldSkipSecondaryFallbackAfterResolverMiss,
  shouldAllowSecondaryFallback,
  shouldAllowInvokeFallback,
  shouldAllowResolverFallback,
  shouldUseResolverFirstSearch,
};
