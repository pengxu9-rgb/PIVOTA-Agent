function defaultIsPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function defaultPickFirstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function defaultResolveQaMode(value) {
  const token = String(value || '').trim().toLowerCase();
  return token || 'single';
}

function defaultResolveQaSingleProvider(value) {
  const token = String(value || '').trim().toLowerCase();
  return token || 'gemini';
}

function defaultInitLlmFallbackStageCounts() {
  return {
    timeout: 0,
    invalid_json: 0,
    error: 0,
    empty: 0,
  };
}

function defaultMakeEvent(ctx, eventName, eventData) {
  return {
    event_name: eventName,
    event_data: eventData,
    request_id: ctx && ctx.request_id ? ctx.request_id : null,
  };
}

function toNullableInt(value) {
  return Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : null;
}

function createProductIntelGuardrailRuntime(options = {}) {
  const {
    isPlainObject = defaultIsPlainObject,
    pickFirstString = defaultPickFirstString,
    resolveQaMode = defaultResolveQaMode,
    resolveQaSingleProvider = defaultResolveQaSingleProvider,
    applyPhotoClaimConsistency = (cards) => (Array.isArray(cards) ? cards.slice() : []),
    sanitizeRecoCandidatesForUi = async (cards) => ({
      cards: Array.isArray(cards) ? cards.slice() : [],
      dropped: 0,
      externalized: 0,
      rejected: [],
      lookup_meta: {},
    }),
    applyAnalysisStoryAndRoutineSoftGate = async (cards) => (Array.isArray(cards) ? cards.slice() : []),
    initLlmFallbackStageCounts = defaultInitLlmFallbackStageCounts,
    buildPurchasableFallbackCandidates = null,
    makeEvent = defaultMakeEvent,
    AURORA_LLM_QA_MIN_REMAINING_BUDGET_MS = 0,
    AURORA_LLM_QA_MODE = 'single',
    AURORA_LLM_SINGLE_PROVIDER = 'gemini',
    AURORA_LLM_OPENAI_FALLBACK_ENABLED = false,
    AURORA_PRODUCT_RELEVANCE_QA_MODE = 'single',
    AURORA_PRODUCT_STRICT_SKINCARE_FILTER = false,
    AURORA_PURCHASABLE_FALLBACK_ENABLED = false,
    AURORA_EXTERNAL_SEED_SUPPLEMENT_ENABLED = false,
    AURORA_PRODUCT_LOOKUP_LLM_FALLBACK_ENABLED = false,
    SKIN_VISION_MODEL_GEMINI = null,
    SKIN_VISION_MODEL_OPENAI = null,
    ANALYSIS_STORY_MODEL_OPENAI = null,
    ANALYSIS_STORY_MODEL_GEMINI = null,
  } = options;

  async function applyProductIntelGuardrailsToEnvelope({
    envelope,
    ctx,
    profile,
    language,
    logger = null,
    qaRuntime = null,
  } = {}) {
    const base = isPlainObject(envelope) ? { ...envelope } : envelope;
    if (!isPlainObject(base)) {
      return { envelope: base, dropped: 0, externalized: 0, rejected: [] };
    }
    const qaRuntimeObj = isPlainObject(qaRuntime) ? qaRuntime : {};
    const qaAllowOpenAiFallbackRaw = qaRuntimeObj.allow_openai_fallback;
    const qaContext = {
      budget_ms: toNullableInt(qaRuntimeObj.budget_ms),
      started_at_ms: toNullableInt(qaRuntimeObj.started_at_ms),
      min_budget_ms: toNullableInt(qaRuntimeObj.min_budget_ms) ?? AURORA_LLM_QA_MIN_REMAINING_BUDGET_MS,
      qa_mode: resolveQaMode(pickFirstString(qaRuntimeObj.qa_mode, AURORA_LLM_QA_MODE)),
      qa_provider: resolveQaSingleProvider(pickFirstString(qaRuntimeObj.qa_provider, AURORA_LLM_SINGLE_PROVIDER)),
      qa_openai_fallback_enabled:
        qaAllowOpenAiFallbackRaw !== undefined && qaAllowOpenAiFallbackRaw !== null
          ? Boolean(qaAllowOpenAiFallbackRaw)
          : AURORA_LLM_OPENAI_FALLBACK_ENABLED,
      story_meta: {},
      relevance_meta: {},
    };
    const productQaMode = resolveQaMode(
      pickFirstString(qaRuntimeObj.product_qa_mode, AURORA_PRODUCT_RELEVANCE_QA_MODE),
    );

    const rawCards = Array.isArray(base.cards) ? base.cards.slice() : [];
    const withPhotoConsistency = applyPhotoClaimConsistency(rawCards);
    const sanitized = await sanitizeRecoCandidatesForUi(withPhotoConsistency, {
      strictFilter: AURORA_PRODUCT_STRICT_SKINCARE_FILTER,
      qaMode: productQaMode,
      singleProvider: qaContext.qa_provider,
      allowOpenAiFallback: qaContext.qa_openai_fallback_enabled,
      qaContext,
      fallbackCandidateBuilder: AURORA_PURCHASABLE_FALLBACK_ENABLED ? buildPurchasableFallbackCandidates : null,
      allowExternalSeedSupplement: AURORA_EXTERNAL_SEED_SUPPLEMENT_ENABLED === true,
      externalSeedStrategy: 'supplement_internal_first',
      allowResolverExternalRecommendations: true,
      logger,
    });
    const withStoryAndGate = await applyAnalysisStoryAndRoutineSoftGate(sanitized.cards, {
      ctx,
      profile,
      language,
      qaMode: qaContext.qa_mode,
      singleProvider: qaContext.qa_provider,
      allowOpenAiFallback: qaContext.qa_openai_fallback_enabled,
      qaContext,
    });
    const analysisMetaBase = isPlainObject(base.analysis_meta) ? { ...base.analysis_meta } : null;
    const qaSkippedReason = pickFirstString(
      qaContext.story_meta && qaContext.story_meta.skipped_reason,
      qaContext.relevance_meta && qaContext.relevance_meta.skipped_reason,
    );
    const qaProvider = pickFirstString(
      qaContext.story_meta && qaContext.story_meta.provider,
      qaContext.relevance_meta && qaContext.relevance_meta.provider,
      qaContext.qa_provider,
    );
    const lookupMeta = isPlainObject(sanitized.lookup_meta) ? sanitized.lookup_meta : {};
    const llmFallbackStageCounts = isPlainObject(lookupMeta.llm_fallback_stage_counts)
      ? lookupMeta.llm_fallback_stage_counts
      : initLlmFallbackStageCounts();
    const summaryCard = withStoryAndGate.find(
      (card) => isPlainObject(card) && String(card.type || '').trim().toLowerCase() === 'analysis_summary',
    );
    const summaryPayload = summaryCard && isPlainObject(summaryCard.payload) ? summaryCard.payload : {};
    const photoModulesCard = withStoryAndGate.find(
      (card) => isPlainObject(card) && String(card.type || '').trim().toLowerCase() === 'photo_modules_v1',
    );
    const storyCard = withStoryAndGate.find(
      (card) => isPlainObject(card) && String(card.type || '').trim().toLowerCase() === 'analysis_story_v2',
    );
    const photoRegions = Array.isArray(photoModulesCard && photoModulesCard.payload && photoModulesCard.payload.regions)
      ? photoModulesCard.payload.regions
      : [];
    const regionsUnavailable = photoRegions.filter(
      (region) => String((region && region.status) || '').trim().toLowerCase() === 'unavailable',
    ).length;
    const recommendableCards = withStoryAndGate.filter((card) => {
      const type = String(card && card.type ? card.type : '').trim().toLowerCase();
      return type === 'recommendations' || type === 'ingredient_plan_v2' || type === 'ingredient_plan';
    });
    const recommendableCardsWithEmptyReason = recommendableCards.filter(
      (card) => isPlainObject(card && card.payload) && String(card.payload.products_empty_reason || '').trim(),
    ).length;
    const analysisSource = pickFirstString(summaryPayload.analysis_source, analysisMetaBase && analysisMetaBase.detector_source);
    const diagProvider = (() => {
      const token = String(analysisSource || '').trim().toLowerCase();
      if (token.includes('gemini')) return 'gemini';
      if (token.includes('openai')) return 'openai';
      if (token.includes('vision') || token.includes('rules') || token.includes('baseline')) return 'rules';
      return 'unknown';
    })();
    const storyProvider = pickFirstString(
      qaContext.story_meta && qaContext.story_meta.provider,
      qaProvider,
      qaContext.qa_provider,
    );
    const nextAnalysisMeta = {
      ...(analysisMetaBase || {}),
      qa_mode: qaContext.qa_mode,
      qa_provider: qaProvider || qaContext.qa_provider,
      diag_provider: diagProvider,
      diag_model:
        diagProvider === 'gemini' ? SKIN_VISION_MODEL_GEMINI : diagProvider === 'openai' ? SKIN_VISION_MODEL_OPENAI : null,
      story_provider: storyProvider || 'gemini',
      story_model: storyProvider === 'openai' ? ANALYSIS_STORY_MODEL_OPENAI : ANALYSIS_STORY_MODEL_GEMINI,
      product_lookup_mode: AURORA_PRODUCT_LOOKUP_LLM_FALLBACK_ENABLED ? 'catalog_then_llm_fallback' : 'catalog_only',
      product_lookup_fallback_used: lookupMeta.llm_fallback_used === true,
      product_lookup_fallback_attempted: Math.max(0, Math.trunc(Number(lookupMeta.llm_fallback_attempted || 0))),
      product_lookup_fallback_recovered: Math.max(0, Math.trunc(Number(lookupMeta.llm_fallback_recovered || 0))),
      product_lookup_fallback_timeout: Math.max(0, Math.trunc(Number(llmFallbackStageCounts.timeout || 0))),
      product_lookup_fallback_invalid_json: Math.max(0, Math.trunc(Number(llmFallbackStageCounts.invalid_json || 0))),
      product_lookup_fallback_error: Math.max(0, Math.trunc(Number(llmFallbackStageCounts.error || 0))),
      product_lookup_fallback_empty: Math.max(0, Math.trunc(Number(llmFallbackStageCounts.empty || 0))),
      photo_modules_emit_rate: photoModulesCard ? 1 : 0,
      regions_unavailable_rate: photoRegions.length ? Number((regionsUnavailable / photoRegions.length).toFixed(4)) : 0,
      analysis_story_ui_card_rate:
        storyCard && isPlainObject(storyCard.payload) && isPlainObject(storyCard.payload.ui_card_v1) ? 1 : 0,
      product_llm_fallback_hit_rate:
        Number(lookupMeta.llm_fallback_attempted || 0) > 0
          ? Number((Number(lookupMeta.llm_fallback_recovered || 0) / Number(lookupMeta.llm_fallback_attempted || 1)).toFixed(4))
          : 0,
      product_llm_fallback_error_rate:
        Number(lookupMeta.llm_fallback_attempted || 0) > 0
          ? Number(
            (
              (Number(llmFallbackStageCounts.timeout || 0) +
                Number(llmFallbackStageCounts.invalid_json || 0) +
                Number(llmFallbackStageCounts.error || 0)) /
              Number(lookupMeta.llm_fallback_attempted || 1)
            ).toFixed(4),
          )
          : 0,
      empty_products_rate:
        recommendableCards.length > 0
          ? Number((recommendableCardsWithEmptyReason / recommendableCards.length).toFixed(4))
          : 0,
      invalid_url_drop_rate:
        Number(sanitized.dropped || 0) + Number(sanitized.externalized || 0) > 0
          ? Number(
            (
              Number(sanitized.externalized || 0) /
              (Number(sanitized.dropped || 0) + Number(sanitized.externalized || 0))
            ).toFixed(4),
          )
          : 0,
      ...(pickFirstString(lookupMeta.llm_fallback_last_reason)
        ? { product_lookup_fallback_last_reason: lookupMeta.llm_fallback_last_reason }
        : {}),
      ...(qaSkippedReason ? { qa_skipped_reason: qaSkippedReason } : {}),
    };
    return {
      envelope: {
        ...base,
        cards: withStoryAndGate,
        ...(nextAnalysisMeta ? { analysis_meta: nextAnalysisMeta } : {}),
      },
      dropped: sanitized.dropped,
      externalized: sanitized.externalized,
      rejected: sanitized.rejected,
    };
  }

  async function safelyApplyProductIntelGuardrailsToEnvelope({
    envelope,
    ctx,
    profile,
    language,
    logger = null,
    qaRuntime = null,
    applyFn = applyProductIntelGuardrailsToEnvelope,
  } = {}) {
    const runGuardrail = typeof applyFn === 'function' ? applyFn : applyProductIntelGuardrailsToEnvelope;
    try {
      const out = await runGuardrail({
        envelope,
        ctx,
        profile,
        language,
        logger,
        qaRuntime,
      });
      if (out && typeof out === 'object' && !Array.isArray(out)) {
        return out;
      }
      return {
        envelope: isPlainObject(envelope) ? { ...envelope } : envelope,
        dropped: 0,
        externalized: 0,
        rejected: [],
        failed: false,
      };
    } catch (err) {
      const baseEnvelope = isPlainObject(envelope) ? { ...envelope } : {};
      const events = Array.isArray(baseEnvelope.events) ? baseEnvelope.events.slice(0, 96) : [];
      const errorCode = String((err && (err.code || err.name)) || 'GUARDRAIL_RUNTIME_ERROR').trim() || 'GUARDRAIL_RUNTIME_ERROR';
      const eventCtx = ctx && typeof ctx === 'object' ? ctx : {};
      events.push(
        makeEvent(eventCtx, 'product_intel_guardrail_failed', {
          code: errorCode.slice(0, 64),
        }),
      );

      if (logger && typeof logger.warn === 'function') {
        logger.warn(
          {
            request_id: eventCtx.request_id || null,
            trace_id: eventCtx.trace_id || null,
            error_code: errorCode.slice(0, 64),
            err: err && err.message ? err.message : String(err || ''),
          },
          'aurora bff: product-intel guardrail runtime failure',
        );
      }

      return {
        envelope: {
          ...baseEnvelope,
          events: events.slice(0, 96),
        },
        dropped: 0,
        externalized: 0,
        rejected: [],
        failed: true,
        error_code: errorCode.slice(0, 64),
      };
    }
  }

  return {
    applyProductIntelGuardrailsToEnvelope,
    safelyApplyProductIntelGuardrailsToEnvelope,
  };
}

module.exports = {
  createProductIntelGuardrailRuntime,
};
