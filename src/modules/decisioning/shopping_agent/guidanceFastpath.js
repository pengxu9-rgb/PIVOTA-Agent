const {
  GUIDANCE_ONLY_DECISION_MODE,
  GUIDANCE_FASTPATH_INTERNAL_RECALL_BUDGET_MS,
  GUIDANCE_FASTPATH_EXTERNAL_RECALL_BUDGET_MS,
} = require('./guidanceContext');

function scoreGuidanceFastpathTargetClass(targetClass) {
  if (targetClass === 'strong_goal_family') return 400;
  if (targetClass === 'supportive_family') return 250;
  if (targetClass === 'generic_family') return 50;
  if (targetClass === 'adjacent_noise') return -100;
  if (targetClass === 'hard_invalid') return -250;
  return 0;
}

function createGuidanceFastpathRuntime(deps = {}) {
  const {
    normalizeSearchHintToken,
    extractSearchAnchorTokens,
    normalizeSearchTextForMatch,
    classifyGuidanceTargetRelevance,
    buildSearchDecisionProductKey,
    classifySharedBeautyCoarseCandidate,
    withStageBudget,
    getNowMs = () => Date.now(),
  } = deps;

  function getGuidanceFastpathPhaseBudgets(targetStepFamily) {
    if (normalizeSearchHintToken(targetStepFamily) === 'serum') {
      return {
        internal_recall_ms: 400,
        external_recall_ms: 3600,
      };
    }
    return {
      internal_recall_ms: GUIDANCE_FASTPATH_INTERNAL_RECALL_BUDGET_MS,
      external_recall_ms: GUIDANCE_FASTPATH_EXTERNAL_RECALL_BUDGET_MS,
    };
  }

  function sortGuidanceFastpathProducts(products, queryText, guidanceContext) {
    const anchorTokens = extractSearchAnchorTokens(queryText);
    return (Array.isArray(products) ? products : [])
      .slice()
      .sort((left, right) => {
        const leftClass = classifyGuidanceTargetRelevance(left, queryText, guidanceContext);
        const rightClass = classifyGuidanceTargetRelevance(right, queryText, guidanceContext);
        const classDelta =
          scoreGuidanceFastpathTargetClass(rightClass) - scoreGuidanceFastpathTargetClass(leftClass);
        if (classDelta !== 0) return classDelta;

        const leftText = normalizeSearchTextForMatch(
          `${left?.brand || ''} ${left?.title || left?.name || ''} ${left?.category || left?.product_type || ''}`,
        );
        const rightText = normalizeSearchTextForMatch(
          `${right?.brand || ''} ${right?.title || right?.name || ''} ${right?.category || right?.product_type || ''}`,
        );
        const leftAnchorHits = anchorTokens.filter((token) => leftText.includes(token)).length;
        const rightAnchorHits = anchorTokens.filter((token) => rightText.includes(token)).length;
        if (rightAnchorHits !== leftAnchorHits) return rightAnchorHits - leftAnchorHits;

        const leftExternal =
          String(left?.merchant_id || left?.merchantId || '').trim().toLowerCase() === 'external_seed';
        const rightExternal =
          String(right?.merchant_id || right?.merchantId || '').trim().toLowerCase() === 'external_seed';
        if (leftExternal !== rightExternal) return leftExternal ? 1 : -1;

        return String(right?.title || right?.name || '').localeCompare(String(left?.title || left?.name || ''));
      });
  }

  function mergeGuidanceFastpathProducts(products, queryText, guidanceContext) {
    const deduped = [];
    const seen = new Set();
    for (const product of Array.isArray(products) ? products : []) {
      if (!product || typeof product !== 'object') continue;
      const merchantId = String(product?.merchant_id || product?.merchantId || '').trim();
      const productKey = buildSearchDecisionProductKey(product);
      const compoundKey = `${merchantId || 'unknown'}::${productKey || ''}`;
      if (!productKey || seen.has(compoundKey)) continue;
      seen.add(compoundKey);
      deduped.push(product);
    }
    return sortGuidanceFastpathProducts(deduped, queryText, guidanceContext);
  }

  function stabilizeGuidanceFastpathDisplayProducts(products, queryText, guidanceContext) {
    const list = Array.isArray(products) ? products.slice() : [];
    if (!guidanceContext?.is_guidance_only || guidanceContext?.target_step_family !== 'moisturizer') {
      return list;
    }
    return list
      .map((product, index) => {
        const coarse = classifySharedBeautyCoarseCandidate(product, {
          queryTargetStepFamily: guidanceContext.target_step_family,
          queryText,
          guidanceOnlyDiscovery: true,
          queryStepStrength: guidanceContext.query_step_strength,
          mode: GUIDANCE_ONLY_DECISION_MODE,
        });
        return {
          product,
          index,
          sample_rank: coarse?.offer_type === 'sample' ? 1 : 0,
        };
      })
      .sort((left, right) => {
        if (left.sample_rank !== right.sample_rank) return left.sample_rank - right.sample_rank;
        return left.index - right.index;
      })
      .map((row) => row.product);
  }

  async function runGuidanceFastpathPhase(phaseName, timeoutMs, task) {
    const startedAt = getNowMs();
    try {
      const result = await withStageBudget(Promise.resolve().then(task), timeoutMs, phaseName);
      return {
        ok: true,
        result,
        duration_ms: getNowMs() - startedAt,
        timeout_ms: timeoutMs,
        phase: phaseName,
      };
    } catch (err) {
      return {
        ok: false,
        result: null,
        duration_ms: getNowMs() - startedAt,
        timeout_ms: timeoutMs,
        phase: phaseName,
        error: err?.message || String(err),
        phase_skipped_reason: err?.code === 'STAGE_TIMEOUT' ? 'budget_exhausted' : 'error',
      };
    }
  }

  function buildGuidanceFastpathFailureClass(decision, candidateSummary) {
    if (decision?.success_contract_result?.failure_class) {
      return decision.success_contract_result.failure_class;
    }
    if (candidateSummary?.adjacent_noise_dominant) return 'retrieval_direction_weak';
    if (candidateSummary?.generic_only) return 'generic_family_only';
    return 'no_target_relevant_candidates';
  }

  return {
    getGuidanceFastpathPhaseBudgets,
    sortGuidanceFastpathProducts,
    mergeGuidanceFastpathProducts,
    stabilizeGuidanceFastpathDisplayProducts,
    runGuidanceFastpathPhase,
    buildGuidanceFastpathFailureClass,
  };
}

module.exports = {
  createGuidanceFastpathRuntime,
};
