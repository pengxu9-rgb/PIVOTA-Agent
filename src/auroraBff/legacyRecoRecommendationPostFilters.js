function createLegacyRecoRecommendationPostFiltersRuntime(deps = {}) {
  const {
    dedupeRecoRecommendationsStrict,
    limitRecoKnownTestSeedRecommendations,
    buildRecoDiversityHistoryKey,
    getRecoRecentExposureState,
    applyRecoRecentDiversityGuard,
    buildRecoDiversityToken,
    updateRecoRecentExposureTokens,
    normalizeBudgetHint,
    hasItineraryContextForReco,
    RECO_DIVERSITY_ENABLED,
    RECO_DIVERSITY_MAX_REPEAT_PER_RESPONSE,
    RECO_DIVERSITY_MIN_TOTAL,
  } = deps;

  function uniqStrings(items, max = null) {
    const out = [];
    const seen = new Set();
    for (const raw of Array.isArray(items) ? items : []) {
      const s = typeof raw === 'string' ? raw.trim() : raw == null ? '' : String(raw).trim();
      if (!s) continue;
      const key = s.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
      if (typeof max === 'number' && max > 0 && out.length >= max) break;
    }
    return out;
  }

  function applyLegacyRecoRecommendationPostFilters({
    ctx,
    norm,
    profileSummary = null,
  } = {}) {
    const nextNorm = norm && typeof norm === 'object' ? { ...norm } : { payload: {} };
    nextNorm.payload =
      nextNorm.payload && typeof nextNorm.payload === 'object' && !Array.isArray(nextNorm.payload)
        ? { ...nextNorm.payload }
        : {};

    let recoSeedFilterInfo = {
      applied: false,
      seed_count_before: 0,
      seed_count_after: 0,
      filtered_count: 0,
    };
    let recoDiversityInfo = {
      enabled: RECO_DIVERSITY_ENABLED,
      applied: false,
      repeated_before: 0,
      repeated_after: 0,
      filtered_count: 0,
      history_size_before: 0,
      history_size_after: 0,
    };

    if (Array.isArray(nextNorm.payload.recommendations) && nextNorm.payload.recommendations.length) {
      const prePdpDeduped = dedupeRecoRecommendationsStrict(nextNorm.payload.recommendations, { maxItems: 8 });
      const deduped = prePdpDeduped.recommendations.map((row) => ({ ...row, slot: 'other' }));
      const limited = limitRecoKnownTestSeedRecommendations(deduped);
      recoSeedFilterInfo = {
        applied: Boolean(limited.applied),
        seed_count_before: Number(limited.seed_count_before || 0),
        seed_count_after: Number(limited.seed_count_after || 0),
        filtered_count: Number(limited.filtered_count || 0),
      };
      let nextRecommendations = limited.recommendations;
      if (RECO_DIVERSITY_ENABLED && Array.isArray(nextRecommendations) && nextRecommendations.length) {
        const diversityHistoryKey = buildRecoDiversityHistoryKey(ctx);
        const historyState = getRecoRecentExposureState(diversityHistoryKey);
        const historyTokens = historyState.tokens;
        const diversityLimited = applyRecoRecentDiversityGuard(nextRecommendations, {
          historyTokens,
          maxRepeatPerResponse: RECO_DIVERSITY_MAX_REPEAT_PER_RESPONSE,
          minTotal: RECO_DIVERSITY_MIN_TOTAL,
          rotationRound: historyState.round + 1,
        });
        nextRecommendations = diversityLimited.recommendations;
        recoDiversityInfo = {
          enabled: true,
          applied: Boolean(diversityLimited.applied),
          repeated_before: Number(diversityLimited.repeated_before || 0),
          repeated_after: Number(diversityLimited.repeated_after || 0),
          filtered_count: Number(diversityLimited.filtered_count || 0),
          history_size_before: historyTokens.length,
          history_size_after: historyTokens.length,
        };

        const exposureTokens = (Array.isArray(nextRecommendations) ? nextRecommendations : [])
          .map((item) => buildRecoDiversityToken(item))
          .filter(Boolean)
          .slice(0, 8);
        updateRecoRecentExposureTokens(diversityHistoryKey, exposureTokens);
        const historyAfter = getRecoRecentExposureState(diversityHistoryKey);
        recoDiversityInfo.history_size_after = historyAfter.tokens.length;
      }
      nextNorm.payload = { ...nextNorm.payload, recommendations: nextRecommendations };
    }

    if (Array.isArray(nextNorm.field_missing) && nextNorm.field_missing.length && nextNorm.includeAlternatives) {
      // no-op placeholder to preserve shape if caller passes includeAlternatives by mistake
    }

    const budgetKnown = normalizeBudgetHint(profileSummary && profileSummary.budgetTier);
    if (budgetKnown && Array.isArray(nextNorm.payload?.missing_info)) {
      nextNorm.payload.missing_info = nextNorm.payload.missing_info.filter((code) => String(code) !== 'budget_unknown');
    }

    const itineraryAvailable = hasItineraryContextForReco(profileSummary);
    const itineraryText =
      profileSummary && typeof profileSummary.itinerary === 'string'
        ? profileSummary.itinerary.trim()
        : '';
    const itinerary = itineraryText ? itineraryText.slice(0, 160) : '';
    if (itinerary && Array.isArray(nextNorm.payload?.recommendations)) {
      const itineraryReason = ctx.lang === 'CN' ? `接下来计划：${itinerary}` : `Upcoming plan: ${itinerary}`;
      const itineraryRegex =
        ctx.lang === 'CN'
          ? /(行程|计划|旅行|出差|户外|飞行|滑雪|天气|气候)/
          : /\b(upcoming plan|itinerary|travel|trip|flight|outdoor|cold|dry|uv|ski)\b/i;

      const pickReasons = (reasonsRaw) => {
        const base = uniqStrings(reasonsRaw, 12);
        const alreadyHasItinerary = base.some((r) => itineraryRegex.test(String(r || '')));
        const reasons = alreadyHasItinerary ? base : [...base, itineraryReason];

        const activeRegex =
          ctx.lang === 'CN'
            ? /(最有效成分|关键成分|核心成分|主打成分)/
            : /\b(most effective active|hero ingredient|key actives?|key ingredients?)\b/i;
        const goalRegex = ctx.lang === 'CN' ? /(目标|匹配|针对)/ : /\b(goal fit|targets?:|goals?:)\b/i;
        const barrierRegex =
          ctx.lang === 'CN'
            ? /(屏障|敏感|刺激|低刺激|耐受|刺痛|泛红)/
            : /\b(barrier|sensitivity|irritat|low[- ]irritation|patch test|tolerance)\b/i;
        const logsRegex =
          ctx.lang === 'CN'
            ? /(近7天|最近7天|打卡|记录|泛红|痘|补水|保湿)/
            : /\b(last 7d|check-?in|redness|hydration)\b/i;
        const analysisRegex =
          ctx.lang === 'CN'
            ? /(皮肤分析|诊断|分析结果|上次分析)/
            : /\b(last skin analysis|skin analysis)\b/i;

        const picked = [];
        const usedIdx = new Set();
        const takeFirstMatch = (re) => {
          const idx = reasons.findIndex((r, i) => !usedIdx.has(i) && re.test(String(r || '')));
          if (idx === -1) return;
          usedIdx.add(idx);
          picked.push(reasons[idx]);
        };

        for (const re of [activeRegex, goalRegex, barrierRegex, logsRegex, analysisRegex, itineraryRegex]) {
          if (picked.length >= 6) break;
          takeFirstMatch(re);
        }

        for (let i = 0; i < reasons.length && picked.length < 6; i += 1) {
          if (usedIdx.has(i)) continue;
          picked.push(reasons[i]);
          usedIdx.add(i);
        }

        if (!picked.some((r) => itineraryRegex.test(String(r || '')))) {
          if (picked.length < 6) picked.push(itineraryReason);
          else picked[picked.length - 1] = itineraryReason;
        }

        return uniqStrings(picked, 6);
      };

      nextNorm.payload.recommendations = nextNorm.payload.recommendations.map((item) => {
        const base = item && typeof item === 'object' && !Array.isArray(item) ? item : null;
        if (!base) return item;
        const reasonsRaw = Array.isArray(base.reasons) ? base.reasons : [];
        return { ...base, reasons: pickReasons(reasonsRaw) };
      });
    }

    return {
      norm: nextNorm,
      recoSeedFilterInfo,
      recoDiversityInfo,
      itineraryAvailable,
    };
  }

  return {
    applyLegacyRecoRecommendationPostFilters,
  };
}

module.exports = {
  createLegacyRecoRecommendationPostFiltersRuntime,
};
