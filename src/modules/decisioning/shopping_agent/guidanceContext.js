const GUIDANCE_ONLY_UI_SURFACE = 'ingredient_plan_guidance_only';
const GUIDANCE_ONLY_DECISION_MODE = 'guidance_only';
const GUIDANCE_RETRIEVAL_MODE = 'guidance_recall_first';
const GUIDANCE_SOURCE_POLICY = 'internal_first_then_external_supplement';
const GUIDANCE_EXECUTION_MODE_SERVER_OWNED_LADDER = 'server_owned_ladder';
const GUIDANCE_FASTPATH_LATENCY_MODE = 'guidance_fastpath';
const GUIDANCE_FASTPATH_TOTAL_BUDGET_MS = 4200;
const GUIDANCE_FASTPATH_PLANNING_BUDGET_MS = 200;
const GUIDANCE_FASTPATH_INTERNAL_RECALL_BUDGET_MS = 800;
const GUIDANCE_FASTPATH_EXTERNAL_RECALL_BUDGET_MS = 3200;
const GUIDANCE_FASTPATH_SUPPORTIVE_ATTEMPT_BUDGET_MS = 1200;
const GUIDANCE_FASTPATH_RESPONSE_BUDGET_MS = 200;
const GUIDANCE_FASTPATH_CLIENT_TIMEOUT_RECOMMENDED_MS = 5000;
const GUIDANCE_FASTPATH_CANDIDATE_LIMIT = 24;

function normalizeSearchHintToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeGuidanceExecutionMode(value) {
  const token = normalizeSearchHintToken(value);
  if (token === GUIDANCE_EXECUTION_MODE_SERVER_OWNED_LADDER) {
    return GUIDANCE_EXECUTION_MODE_SERVER_OWNED_LADDER;
  }
  return null;
}

function hasFragranceFreeSkincareSignal(queryText) {
  return /\b(fragrance(?:\s|-)?free|fragranceless|unscented|without fragrance|no fragrance|sans parfum)\b/i.test(
    String(queryText || ''),
  );
}

function inferGuidanceSemanticFamily(queryText, targetStepFamily, deps) {
  const explicit = normalizeSearchHintToken(targetStepFamily);
  if (explicit) return explicit;
  const normalized = deps.normalizeSearchTextForMatch(queryText);
  if (/\b(moisturizer|moisturiser|cream|lotion|barrier cream|gel cream)\b/.test(normalized)) {
    return 'moisturizer';
  }
  if (/\b(serum|essence|ampoule|concentrate)\b/.test(normalized)) return 'serum';
  return '';
}

function createGuidanceDecisioningRuntime(deps = {}) {
  const {
    normalizeSearchTextForMatch,
    parseQueryStringArray,
    parseQueryBoolean,
    firstQueryParamValue,
    extractSearchQueryText,
    extractSearchAnchorTokens,
    isLookupStyleSearchQuery,
    buildFallbackCandidateText,
  } = deps;

  function extractGuidanceNegativeConstraints(queryLike, queryText) {
    const query = queryLike && typeof queryLike === 'object' && !Array.isArray(queryLike) ? queryLike : {};
    const explicit = parseQueryStringArray(query.negative_constraints ?? query.negativeConstraints)
      .map((item) => normalizeSearchHintToken(item))
      .filter(Boolean);
    const out = new Set(explicit);
    if (hasFragranceFreeSkincareSignal(queryText)) out.add('fragrance_free');
    return Array.from(out);
  }

  function extractGuidanceRetrievalContext(queryLike, { queryText = '' } = {}) {
    const query = queryLike && typeof queryLike === 'object' && !Array.isArray(queryLike) ? queryLike : {};
    const uiSurface = normalizeSearchHintToken(firstQueryParamValue(query.ui_surface ?? query.uiSurface));
    const decisionMode = normalizeSearchHintToken(firstQueryParamValue(query.decision_mode ?? query.decisionMode));
    const executionMode = normalizeGuidanceExecutionMode(
      firstQueryParamValue(query.execution_mode ?? query.executionMode),
    );
    const queryStepStrength = normalizeSearchHintToken(
      firstQueryParamValue(query.query_step_strength ?? query.queryStepStrength),
    );
    const targetStepFamily = normalizeSearchHintToken(
      firstQueryParamValue(query.target_step_family ?? query.targetStepFamily),
    );
    const sourcePolicy = normalizeSearchHintToken(firstQueryParamValue(query.source_policy ?? query.sourcePolicy));
    const retrievalMode = normalizeSearchHintToken(
      firstQueryParamValue(query.retrieval_mode ?? query.retrievalMode),
    );
    const semanticFamily = normalizeSearchHintToken(
      firstQueryParamValue(query.semantic_family ?? query.semanticFamily),
    );
    const isGuidanceOnly =
      uiSurface === GUIDANCE_ONLY_UI_SURFACE || decisionMode === GUIDANCE_ONLY_DECISION_MODE;
    const normalizedQueryText = String(queryText || extractSearchQueryText(query) || '').trim();
    const effectiveTargetStepFamily = inferGuidanceSemanticFamily(
      normalizedQueryText,
      targetStepFamily || semanticFamily,
      { normalizeSearchTextForMatch },
    );
    const effectiveExecutionMode =
      executionMode ||
      (
        isGuidanceOnly &&
        uiSurface === GUIDANCE_ONLY_UI_SURFACE &&
        ['moisturizer', 'serum'].includes(effectiveTargetStepFamily)
          ? GUIDANCE_EXECUTION_MODE_SERVER_OWNED_LADDER
          : null
      );
    const negativeConstraints = extractGuidanceNegativeConstraints(query, normalizedQueryText);
    const productOnly = parseQueryBoolean(query.product_only ?? query.productOnly);
    const allowExternalSeed = parseQueryBoolean(query.allow_external_seed ?? query.allowExternalSeed);
    const externalSeedStrategy = String(
      firstQueryParamValue(query.external_seed_strategy ?? query.externalSeedStrategy) || '',
    )
      .trim()
      .toLowerCase();
    return {
      ui_surface: uiSurface || null,
      decision_mode: decisionMode || null,
      execution_mode: effectiveExecutionMode || null,
      query_step_strength: queryStepStrength || null,
      target_step_family: effectiveTargetStepFamily || null,
      semantic_family: semanticFamily || effectiveTargetStepFamily || null,
      source_policy: sourcePolicy || null,
      retrieval_mode: retrievalMode || (isGuidanceOnly ? GUIDANCE_RETRIEVAL_MODE : null),
      negative_constraints: negativeConstraints,
      allow_external_seed: allowExternalSeed,
      external_seed_strategy: externalSeedStrategy || null,
      product_only: productOnly,
      is_guidance_only: isGuidanceOnly,
      is_guidance_recall_first: isGuidanceOnly && (retrievalMode === GUIDANCE_RETRIEVAL_MODE || !retrievalMode),
      is_server_owned_ladder:
        isGuidanceOnly && effectiveExecutionMode === GUIDANCE_EXECUTION_MODE_SERVER_OWNED_LADDER,
    };
  }

  function hasGuidanceLookupStyleQuery(queryText, guidanceContext) {
    if (!guidanceContext || !guidanceContext.is_guidance_only) return false;
    const anchorTokens = extractSearchAnchorTokens(queryText);
    if (isLookupStyleSearchQuery(queryText, anchorTokens)) return true;
    const normalized = normalizeSearchTextForMatch(queryText);
    if (!normalized) return false;
    if (
      guidanceContext.target_step_family === 'moisturizer' &&
      /\b(moisturizer|moisturiser|cream|lotion)\b/.test(normalized)
    ) {
      return false;
    }
    if (guidanceContext.target_step_family === 'serum' && /\b(serum|essence|ampoule)\b/.test(normalized)) {
      return false;
    }
    return false;
  }

  function buildGuidanceFamilyPatterns(targetStepFamily) {
    const family = normalizeSearchHintToken(targetStepFamily);
    if (family === 'moisturizer') {
      return {
        family_pattern: /\b(moisturizer|moisturiser|cream|lotion|gel cream|barrier cream)\b/i,
        core_anchors: ['barrier', 'repair', 'ceramide'],
        supportive_anchors: ['sensitive', 'fragrance free', 'unscented', 'soothing'],
        hard_invalid_pattern:
          /\b(perfume|parfum|cologne|body mist|eau de parfum|eau de toilette|brush|tool|body lotion|body cream|body wash|facial treatment|service)\b/i,
        adjacent_noise_pattern:
          /\b(bundle|duo|set|kit|skin tint|tinted|foundation|peel|exfoliant|spf|sunscreen|vitamin c|brightening|cleanser|mask|toner)\b/i,
      };
    }
    if (family === 'serum') {
      return {
        family_pattern: /\b(serum|essence|ampoule|concentrate)\b/i,
        core_anchors: ['panthenol', 'barrier', 'repair', 'soothing', 'hydrating'],
        supportive_anchors: ['sensitive', 'fragrance free', 'unscented', 'calming'],
        hard_invalid_pattern:
          /\b(perfume|parfum|cologne|body mist|brush|tool|body lotion|body cream|facial treatment|service)\b/i,
        adjacent_noise_pattern:
          /\b(bundle|duo|set|kit|skin tint|tinted|foundation|peel|exfoliant|spf|sunscreen|cleanser|mask|moisturizer|moisturiser|cream|vitamin c|brightening)\b/i,
      };
    }
    return null;
  }

  function countNormalizedPhraseMatches(text, phrases = []) {
    const normalizedText = normalizeSearchTextForMatch(text);
    if (!normalizedText) return 0;
    let count = 0;
    for (const phrase of phrases) {
      const normalizedPhrase = normalizeSearchTextForMatch(phrase);
      if (!normalizedPhrase) continue;
      if (normalizedText.includes(normalizedPhrase)) count += 1;
    }
    return count;
  }

  function classifyGuidanceTargetRelevance(product, queryText, guidanceContext) {
    if (!guidanceContext || !guidanceContext.is_guidance_only) return 'unclassified';
    const patterns = buildGuidanceFamilyPatterns(guidanceContext.target_step_family);
    if (!patterns) return 'unclassified';
    const candidateText = buildFallbackCandidateText(product);
    if (!candidateText) return 'hard_invalid';
    if (patterns.hard_invalid_pattern.test(candidateText)) return 'hard_invalid';
    if (!patterns.family_pattern.test(candidateText)) {
      return patterns.adjacent_noise_pattern.test(candidateText) ? 'adjacent_noise' : 'hard_invalid';
    }
    if (patterns.adjacent_noise_pattern.test(candidateText)) return 'adjacent_noise';
    const coreMatches = countNormalizedPhraseMatches(candidateText, patterns.core_anchors);
    const supportiveMatches = countNormalizedPhraseMatches(candidateText, patterns.supportive_anchors);
    if (coreMatches > 0) return 'strong_goal_family';
    if (supportiveMatches > 0) return 'supportive_family';
    return 'generic_family';
  }

  function summarizeGuidanceCandidatePool(products, queryText, queryLike) {
    const guidanceContext = extractGuidanceRetrievalContext(queryLike, { queryText });
    if (!guidanceContext.is_guidance_only) return null;
    const counts = {
      strong_goal_family: 0,
      supportive_family: 0,
      generic_family: 0,
      adjacent_noise: 0,
      hard_invalid: 0,
      unclassified: 0,
    };
    const list = Array.isArray(products) ? products : [];
    let top3Score = 0;
    for (let i = 0; i < list.length; i += 1) {
      const klass = classifyGuidanceTargetRelevance(list[i], queryText, guidanceContext);
      counts[klass] = Number(counts[klass] || 0) + 1;
      if (i < 3) {
        if (klass === 'strong_goal_family') top3Score += 100;
        else if (klass === 'supportive_family') top3Score += 40;
        else if (klass === 'generic_family') top3Score += 5;
        else if (klass === 'adjacent_noise') top3Score -= 20;
        else if (klass === 'hard_invalid') top3Score -= 50;
      }
    }
    return {
      context: guidanceContext,
      counts,
      target_relevant_count: counts.strong_goal_family + counts.supportive_family,
      top3_quality_score: top3Score,
      generic_only:
        counts.generic_family > 0 &&
        counts.strong_goal_family === 0 &&
        counts.supportive_family === 0,
      adjacent_noise_dominant:
        counts.adjacent_noise > 0 &&
        counts.adjacent_noise >= counts.strong_goal_family + counts.supportive_family + counts.generic_family,
    };
  }

  function compareGuidanceCandidatePools(candidateSummary, currentSummary) {
    if (!candidateSummary && !currentSummary) return 0;
    if (candidateSummary && !currentSummary) return 1;
    if (!candidateSummary && currentSummary) return -1;
    const candidateScore =
      candidateSummary.counts.strong_goal_family * 120 +
      candidateSummary.counts.supportive_family * 45 +
      candidateSummary.top3_quality_score +
      candidateSummary.counts.generic_family * 2 -
      candidateSummary.counts.adjacent_noise * 10 -
      candidateSummary.counts.hard_invalid * 15;
    const currentScore =
      currentSummary.counts.strong_goal_family * 120 +
      currentSummary.counts.supportive_family * 45 +
      currentSummary.top3_quality_score +
      currentSummary.counts.generic_family * 2 -
      currentSummary.counts.adjacent_noise * 10 -
      currentSummary.counts.hard_invalid * 15;
    if (candidateScore !== currentScore) return candidateScore > currentScore ? 1 : -1;
    if (candidateSummary.target_relevant_count !== currentSummary.target_relevant_count) {
      return candidateSummary.target_relevant_count > currentSummary.target_relevant_count ? 1 : -1;
    }
    return 0;
  }

  return {
    extractGuidanceNegativeConstraints,
    extractGuidanceRetrievalContext,
    hasGuidanceLookupStyleQuery,
    classifyGuidanceTargetRelevance,
    summarizeGuidanceCandidatePool,
    compareGuidanceCandidatePools,
  };
}

module.exports = {
  GUIDANCE_ONLY_UI_SURFACE,
  GUIDANCE_ONLY_DECISION_MODE,
  GUIDANCE_RETRIEVAL_MODE,
  GUIDANCE_SOURCE_POLICY,
  GUIDANCE_EXECUTION_MODE_SERVER_OWNED_LADDER,
  GUIDANCE_FASTPATH_LATENCY_MODE,
  GUIDANCE_FASTPATH_TOTAL_BUDGET_MS,
  GUIDANCE_FASTPATH_PLANNING_BUDGET_MS,
  GUIDANCE_FASTPATH_INTERNAL_RECALL_BUDGET_MS,
  GUIDANCE_FASTPATH_EXTERNAL_RECALL_BUDGET_MS,
  GUIDANCE_FASTPATH_SUPPORTIVE_ATTEMPT_BUDGET_MS,
  GUIDANCE_FASTPATH_RESPONSE_BUDGET_MS,
  GUIDANCE_FASTPATH_CLIENT_TIMEOUT_RECOMMENDED_MS,
  GUIDANCE_FASTPATH_CANDIDATE_LIMIT,
  normalizeSearchHintToken,
  normalizeGuidanceExecutionMode,
  hasFragranceFreeSkincareSignal,
  createGuidanceDecisioningRuntime,
};
