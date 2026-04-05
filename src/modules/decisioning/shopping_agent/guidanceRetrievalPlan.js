const { GUIDANCE_FASTPATH_TOTAL_BUDGET_MS } = require('./guidanceContext');

function createGuidanceRetrievalPlanRuntime(deps = {}) {
  const {
    normalizeSearchTextForMatch,
    normalizeRecoTargetStep,
    normalizeSearchUiSurface,
    normalizeRecommendationDecisionMode,
    normalizeSharedTargetIntent,
    normalizeGuidanceIntentStrength,
    classifyBeautyGuidanceQueryStrength,
    hasFragranceFreeSkincareSignal,
    getNowMs = () => Date.now(),
  } = deps;

  function resolveGuidanceSearchStepStrength(rawValue, queryText, targetStepFamily = null) {
    return (
      normalizeGuidanceIntentStrength(rawValue) ||
      classifyBeautyGuidanceQueryStrength(queryText, {
        queryTargetStepFamily: normalizeRecoTargetStep(targetStepFamily),
      })
    );
  }

  function buildGuidanceRecallSupplementQueries(queryText, guidanceContext) {
    if (!guidanceContext || !guidanceContext.is_guidance_only) return [];
    const out = [];
    const seen = new Set();
    const push = (value) => {
      const query = String(value || '').trim();
      if (!query) return;
      const key = normalizeSearchTextForMatch(query);
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(query);
    };
    const normalized = normalizeSearchTextForMatch(queryText);
    if (guidanceContext.target_step_family === 'moisturizer') {
      if (/\bceramide\b/.test(normalized)) push('ceramide barrier moisturizer');
      push('barrier repair moisturizer');
      push('ceramide moisturizer');
      push('sensitive skin moisturizer');
    } else if (guidanceContext.target_step_family === 'serum') {
      const hasPanthenol = /\bpanthenol\b/.test(normalized);
      const hasHyaluronic = /\b(hyaluronic|hyaluron|sodium hyaluronate|ha)\b/.test(normalized);
      const hasNiacinamide = /\bniacinamide\b/.test(normalized);
      const hasZinc = /\b(zinc|zinc pca)\b/.test(normalized);
      const hasAzelaic = /\bazelaic\b/.test(normalized);
      const hasSalicylic = /\b(salicylic|bha)\b/.test(normalized);
      const hasVitaminC = /\b(vitamin c|ascorbic)\b/.test(normalized);
      const hasBarrier = /\b(barrier|repair)\b/.test(normalized);
      const hydrationFocused = hasHyaluronic || /\b(hydrat\w*|dehydrat\w*|dry)\b/.test(normalized);
      const needsHydrationSupportiveBridge =
        hydrationFocused &&
        !hasPanthenol &&
        !hasBarrier &&
        !hasNiacinamide &&
        !hasZinc &&
        !hasAzelaic &&
        !hasSalicylic &&
        !hasVitaminC;
      if (hasPanthenol) push('panthenol serum');
      if (needsHydrationSupportiveBridge) {
        push('repair serum');
        push('soothing repair serum');
      }
      push('barrier repair serum');
      push('soothing serum');
      push('hydrating serum');
      push('serum');
    }
    return out;
  }

  function buildBeautyFamilySupplementQueries(queryText, context = {}) {
    const targetStepFamily = normalizeRecoTargetStep(
      context?.target_step_family || context?.targetStepFamily || '',
    );
    if (!targetStepFamily) return [];
    const normalized = normalizeSearchTextForMatch(queryText);
    if (!normalized) return [];

    const out = [];
    const seen = new Set();
    const push = (value) => {
      const query = String(value || '').trim();
      if (!query) return;
      const key = normalizeSearchTextForMatch(query);
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(query);
    };

    if (targetStepFamily === 'sunscreen') {
      const explicitSerumQuery =
        /\b(serum|spf serum|sunscreen serum|uv filters?\s+serum)\b/.test(normalized);
      const oilySignal =
        /\b(oily skin|oil control|shine control|mattify|mattifying|non-greasy|non greasy|sebum|matte)\b/.test(
          normalized,
        );
      const sensitiveSignal =
        /\b(sensitive|barrier|redness|soothing|calming|fragrance free|fragrance-free)\b/.test(
          normalized,
        );
      const mineralSignal = /\b(mineral|zinc oxide|titanium dioxide)\b/.test(normalized);

      if (explicitSerumQuery) {
        push('spf serum');
        push('uv filters serum');
        return out;
      }

      if (oilySignal) {
        push('lightweight face sunscreen');
        push('matte face sunscreen');
        push('face sunscreen lotion');
        push('sunscreen milk');
      } else if (sensitiveSignal) {
        push('sensitive skin sunscreen');
        push('face sunscreen lotion');
        push('sunscreen milk');
      } else {
        push('face sunscreen');
        push('broad spectrum face sunscreen');
        push('face sunscreen lotion');
        push('sunscreen milk');
      }
      if (mineralSignal || !sensitiveSignal) push('mineral face sunscreen');
    }

    return out;
  }

  function buildIngredientRecallQueryVariants(queryText, recallProfile, targetStepFamily = '') {
    if (!recallProfile || typeof recallProfile !== 'object') return [];
    const out = [];
    const seen = new Set();
    const normalizedTargetStepFamily = normalizeRecoTargetStep(targetStepFamily);
    const push = (value) => {
      const query = String(value || '').trim();
      if (!query) return;
      const key = normalizeSearchTextForMatch(query);
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(query);
    };
    const phrases = [
      ...(Array.isArray(recallProfile.exact_phrases) ? recallProfile.exact_phrases : []),
      ...(Array.isArray(recallProfile.alias_phrases) ? recallProfile.alias_phrases : []),
    ]
      .map((item) => String(item || '').trim())
      .filter(Boolean);
    for (const phrase of phrases) {
      push(phrase);
      if (normalizedTargetStepFamily && !new RegExp(`\\b${normalizedTargetStepFamily}\\b`, 'i').test(phrase)) {
        push(`${phrase} ${normalizedTargetStepFamily}`);
      }
    }
    return out;
  }

  function buildGuidanceSearchNormalizedIntent({
    queryText = '',
    targetStepFamily = null,
    uiSurface = null,
    decisionMode = null,
    queryStepStrength = null,
  } = {}) {
    const normalizedUiSurface = normalizeSearchUiSurface(uiSurface);
    const normalizedDecisionMode = normalizeRecommendationDecisionMode(decisionMode, {
      guidanceOnlyDiscovery: normalizedUiSurface === 'ingredient_plan_guidance_only',
    });
    return normalizeSharedTargetIntent({
      queryText,
      targetStepFamily: normalizeRecoTargetStep(targetStepFamily),
      mode: normalizedDecisionMode,
      queryStepStrength,
    });
  }

  function getGuidanceFastpathRemainingBudgetMs(
    startedAt,
    totalBudgetMs = GUIDANCE_FASTPATH_TOTAL_BUDGET_MS,
  ) {
    return Math.max(0, Math.floor(Number(totalBudgetMs || 0) - (getNowMs() - Number(startedAt || getNowMs()))));
  }

  function buildGuidanceServerOwnedLadderAttempts(queryText, guidanceContext) {
    if (!guidanceContext || !guidanceContext.is_server_owned_ladder) return [];
    const normalized = normalizeSearchTextForMatch(queryText);
    const pushUnique = (list, value) => {
      const query = String(value || '').trim();
      if (!query) return;
      const key = normalizeSearchTextForMatch(query);
      if (!key) return;
      if (list.some((item) => normalizeSearchTextForMatch(item) === key)) return;
      list.push(query);
    };

    const strongQueries = [];
    const supportiveQueries = [];

    if (guidanceContext.target_step_family === 'moisturizer') {
      const hasCeramide = /\bceramide\b/.test(normalized);
      const hasFragranceFree = hasFragranceFreeSkincareSignal(queryText);

      if (hasCeramide) pushUnique(strongQueries, 'ceramide barrier moisturizer');
      pushUnique(strongQueries, 'barrier repair ceramide moisturizer');
      pushUnique(strongQueries, 'ceramide barrier moisturizer');

      pushUnique(supportiveQueries, 'barrier repair moisturizer');
      if (hasFragranceFree) pushUnique(supportiveQueries, 'fragrance-free barrier moisturizer');
      pushUnique(supportiveQueries, hasCeramide ? 'ceramide moisturizer' : 'ceramide barrier moisturizer');
      pushUnique(supportiveQueries, 'sensitive skin moisturizer');
    } else if (guidanceContext.target_step_family === 'serum') {
      const hasPanthenol = /\b(panthenol|vitamin[-\s]?b5|b5)\b/.test(normalized);
      const hasHyaluronic = /\b(hyaluronic|hyaluron|sodium hyaluronate|ha)\b/.test(normalized);
      const hasNiacinamide = /\bniacinamide\b/.test(normalized);
      const hasZinc = /\b(zinc|zinc pca)\b/.test(normalized);
      const hasAzelaic = /\bazelaic\b/.test(normalized);
      const hasSalicylic = /\b(salicylic|bha)\b/.test(normalized);
      const hasVitaminC = /\b(vitamin c|ascorbic)\b/.test(normalized);
      const hasBarrier = /\b(barrier|repair)\b/.test(normalized);
      const hydrationFocused = hasHyaluronic || /\b(hydrat\w*|dehydrat\w*|dry)\b/.test(normalized);
      const needsHydrationSupportiveBridge =
        hydrationFocused &&
        !hasPanthenol &&
        !hasBarrier &&
        !hasNiacinamide &&
        !hasZinc &&
        !hasAzelaic &&
        !hasSalicylic &&
        !hasVitaminC;

      if (hasPanthenol) {
        pushUnique(strongQueries, 'panthenol serum');
        pushUnique(strongQueries, 'barrier b5 serum');
      }
      if (hasHyaluronic) pushUnique(strongQueries, 'hyaluronic acid serum');
      if (hasNiacinamide) pushUnique(strongQueries, 'niacinamide serum');
      if (hasZinc) pushUnique(strongQueries, 'zinc pca serum');
      if (hasAzelaic) pushUnique(strongQueries, 'azelaic acid serum');
      if (hasSalicylic) pushUnique(strongQueries, 'salicylic acid serum');
      if (hasVitaminC) pushUnique(strongQueries, 'vitamin c serum');
      if (strongQueries.length === 0 && hasBarrier) pushUnique(strongQueries, 'barrier repair serum');
      if (strongQueries.length === 0) pushUnique(strongQueries, String(queryText || '').trim());

      if (hydrationFocused) {
        pushUnique(supportiveQueries, 'hydrating serum');
      }
      if (needsHydrationSupportiveBridge) {
        pushUnique(supportiveQueries, 'repair serum');
      }
      if (hasPanthenol || hasBarrier || needsHydrationSupportiveBridge) {
        pushUnique(supportiveQueries, 'barrier repair serum');
      }
      if (hasPanthenol || /\b(soothing|calming|sensitive|cica|centella)\b/.test(normalized)) {
        pushUnique(supportiveQueries, 'soothing serum');
      }
      if (needsHydrationSupportiveBridge) {
        pushUnique(supportiveQueries, 'soothing repair serum');
      }
      if (!hydrationFocused) {
        pushUnique(supportiveQueries, 'hydrating serum');
      }
      if (hasNiacinamide || hasZinc) pushUnique(supportiveQueries, 'balancing serum');
      if (hasVitaminC) pushUnique(supportiveQueries, 'brightening serum');
      pushUnique(supportiveQueries, 'hydrating serum');
      pushUnique(supportiveQueries, 'serum');
      if (strongQueries.length > 2) strongQueries.splice(2);
      if (supportiveQueries.length > 5) supportiveQueries.splice(5);
    } else {
      return [];
    }

    return [
      {
        intent_strength: 'strong_goal_family',
        cluster_queries: strongQueries,
        selected_query: strongQueries[0] || String(queryText || '').trim(),
        stop_on_success: true,
      },
      {
        intent_strength: 'supportive_family',
        cluster_queries: supportiveQueries,
        selected_query: supportiveQueries[0] || String(queryText || '').trim(),
        stop_on_success: true,
      },
    ].filter((attempt) => String(attempt.selected_query || '').trim());
  }

  return {
    resolveGuidanceSearchStepStrength,
    buildGuidanceRecallSupplementQueries,
    buildBeautyFamilySupplementQueries,
    buildIngredientRecallQueryVariants,
    buildGuidanceSearchNormalizedIntent,
    getGuidanceFastpathRemainingBudgetMs,
    buildGuidanceServerOwnedLadderAttempts,
  };
}

module.exports = {
  createGuidanceRetrievalPlanRuntime,
};
