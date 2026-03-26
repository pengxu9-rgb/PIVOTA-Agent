function createChatUpstreamRequestRuntime(options = {}) {
  const {
    logger = null,
    ingredientEntityMatchFromText,
    buildIngredientReportPayload,
    buildSkinAnalysisContextForPrefix,
    buildContextPrefix,
    recordClarificationHistorySent = () => {},
    AURORA_CHAT_RESUME_PREFIX_V2_ENABLED = false,
    AURORA_CHAT_RESUME_PREFIX_V1_ENABLED = false,
    recordResumePrefixInjected = () => {},
    recordResumePrefixHistoryItems = () => {},
    auroraChat,
    AURORA_DECISION_BASE_URL = '',
    AURORA_CHAT_UPSTREAM_TIMEOUT_MS = 15000,
    recordUpstreamCall = () => {},
    observeUpstreamLatency = () => {},
    AURORA_CHAT_RESUME_PROBE_METRICS_ENABLED = false,
    classifyResumeResponseMode = () => 'unknown',
    recordResumeResponseMode = () => {},
    buildResumeKnownProfileFields = () => [],
    detectResumePlaintextReaskFields = () => [],
    recordResumePlaintextReaskDetected = () => {},
  } = options;

  function requireFunction(name, value) {
    if (typeof value === 'function') return value;
    throw new Error(`aurora chat upstream request runtime missing dependency: ${name}`);
  }

  function buildFallbackAnswer(language) {
    return language === 'CN'
      ? '（我已收到。Aurora 上游暂不可用或未配置，当前仅能提供门控与记忆能力。）'
      : '(Received. Aurora upstream is unavailable or not configured; returning a gated/memory-aware fallback response.)';
  }

  function buildIngredientHintForPrefix(args = {}) {
    const {
      upstreamMessage = '',
      language = 'EN',
    } = args;

    const messageText = String(upstreamMessage || '').trim();
    if (!messageText) return null;

    const matchIngredient = requireFunction('ingredientEntityMatchFromText', ingredientEntityMatchFromText);
    const buildReportPayload = requireFunction('buildIngredientReportPayload', buildIngredientReportPayload);

    const entityMatch = matchIngredient(messageText);
    if (!entityMatch || !entityMatch.entity_key) return null;

    const reportPayload = buildReportPayload({
      language,
      query: messageText,
      research: null,
      meta: {},
    });
    if (!reportPayload || !reportPayload.ingredient) return null;

    const picked = reportPayload;
    return [
      `[Ingredient KB context for "${picked.ingredient.display_name || picked.ingredient.inci}"]`,
      picked.ingredient.category ? `Category: ${picked.ingredient.category}` : null,
      picked.verdict && picked.verdict.one_liner ? `Summary: ${picked.verdict.one_liner}` : null,
      picked.verdict && picked.verdict.evidence_grade ? `Evidence grade: ${picked.verdict.evidence_grade}` : null,
      picked.verdict && picked.verdict.irritation_risk ? `Irritation risk: ${picked.verdict.irritation_risk}` : null,
      Array.isArray(picked.benefits) && picked.benefits.length
        ? `Benefits: ${picked.benefits.map((item) => `${item.concern} (S${item.strength}): ${item.what_it_means}`).join('; ')}`
        : null,
      Array.isArray(picked.watchouts) && picked.watchouts.length
        ? `Watchouts: ${picked.watchouts.map((item) => `${item.issue} (${item.likelihood || 'unknown'}): ${item.what_to_do}`).join('; ')}`
        : null,
      picked.how_to_use ? `Frequency: ${picked.how_to_use.frequency}, Step: ${picked.how_to_use.routine_step}` : null,
      '[Use this KB data for accurate ingredient-specific answers. Generate a detailed aurora_ingredient_report card with v2-lite schema using this data.]',
    ].filter(Boolean).join('\n');
  }

  async function requestUpstream(args = {}) {
    const {
      ctx,
      profile = null,
      profileSummary = null,
      recentLogs = [],
      upstreamMessage = '',
      agentState = null,
      normalizedActionPayload = null,
      clarificationId = null,
      clarificationHistoryForUpstream = [],
      resumeContextForUpstream = null,
      llmProvider = '',
      llmModel = '',
      anchorProductId = '',
      anchorProductUrl = '',
      upstreamMessages = [],
      debugUpstream = false,
      allowRecoCards = false,
    } = args;

    const buildPrefix = requireFunction('buildContextPrefix', buildContextPrefix);
    const buildSkinContext = requireFunction(
      'buildSkinAnalysisContextForPrefix',
      buildSkinAnalysisContextForPrefix,
    );
    const auroraChatFn = requireFunction('auroraChat', auroraChat);

    const language = ctx && ctx.lang === 'CN' ? 'CN' : 'EN';
    const historyForPrefix = Array.isArray(clarificationHistoryForUpstream)
      ? clarificationHistoryForUpstream
      : [];
    if (historyForPrefix.length) {
      recordClarificationHistorySent({ count: historyForPrefix.length });
    }

    const ingredientHintForPrefix = buildIngredientHintForPrefix({
      upstreamMessage,
      language,
    });
    const skinAnalysisContextForPrefix = buildSkinContext(profile);
    const prefix = buildPrefix({
      profile: profileSummary,
      recentLogs,
      lang: ctx && ctx.lang,
      state: ctx && ctx.state,
      agent_state: agentState,
      trigger_source: ctx && ctx.trigger_source,
      action_id:
        normalizedActionPayload && typeof normalizedActionPayload === 'object'
          ? normalizedActionPayload.action_id
          : null,
      clarification_id: clarificationId,
      ...(historyForPrefix.length ? { clarification_history: historyForPrefix } : {}),
      ...(ingredientHintForPrefix ? { ingredient_kb_context: ingredientHintForPrefix } : {}),
      ...(skinAnalysisContextForPrefix ? { skin_analysis_context: skinAnalysisContextForPrefix } : {}),
    });
    const query = `${prefix}${upstreamMessage || '(no message)'}`;

    const isResumeUpstreamCall = Boolean(
      resumeContextForUpstream &&
        typeof resumeContextForUpstream === 'object',
    );
    const resumePrefixEnabledForCall = Boolean(
      isResumeUpstreamCall &&
        (AURORA_CHAT_RESUME_PREFIX_V2_ENABLED || AURORA_CHAT_RESUME_PREFIX_V1_ENABLED),
    );
    const resumeContextForCall = isResumeUpstreamCall
      ? {
          ...resumeContextForUpstream,
          enabled: resumePrefixEnabledForCall,
          template_version: AURORA_CHAT_RESUME_PREFIX_V2_ENABLED ? 'v2' : 'v1',
        }
      : null;

    if (isResumeUpstreamCall) {
      const resumePrefixHistoryCount =
        resumePrefixEnabledForCall &&
        resumeContextForCall &&
        resumeContextForCall.include_history !== false &&
        Array.isArray(resumeContextForCall.clarification_history)
          ? Math.min(6, resumeContextForCall.clarification_history.length)
          : 0;
      recordResumePrefixInjected({ enabled: resumePrefixEnabledForCall });
      recordResumePrefixHistoryItems({ count: resumePrefixHistoryCount });
    }

    let upstream = null;
    const upstreamStartedAt = Date.now();
    try {
      upstream = await auroraChatFn({
        baseUrl: AURORA_DECISION_BASE_URL,
        query,
        timeoutMs: AURORA_CHAT_UPSTREAM_TIMEOUT_MS,
        debug: debugUpstream,
        allow_recommendations: allowRecoCards,
        ...(llmProvider ? { llm_provider: llmProvider } : {}),
        ...(llmModel ? { llm_model: llmModel } : {}),
        ...(anchorProductId ? { anchor_product_id: anchorProductId } : {}),
        ...(anchorProductUrl ? { anchor_product_url: anchorProductUrl } : {}),
        ...(Array.isArray(upstreamMessages) && upstreamMessages.length ? { messages: upstreamMessages } : {}),
        ...(isResumeUpstreamCall && resumeContextForCall ? { resume_context: resumeContextForCall } : {}),
      });
      recordUpstreamCall({ path: 'aurora_chat', status: 'ok' });
    } catch (err) {
      recordUpstreamCall({ path: 'aurora_chat', status: 'error' });
      if (err && err.code !== 'AURORA_NOT_CONFIGURED') {
        logger?.warn({ err: err.message }, 'aurora bff: aurora upstream failed');
      }
    } finally {
      observeUpstreamLatency({ path: 'aurora_chat', latencyMs: Date.now() - upstreamStartedAt });
    }

    const answer =
      upstream && typeof upstream.answer === 'string'
        ? upstream.answer
        : buildFallbackAnswer(language);

    const llmRouteMeta = {
      llm_provider_requested: llmProvider || null,
      llm_model_requested: llmModel || null,
      llm_provider_effective:
        upstream && typeof upstream.llm_provider === 'string' ? String(upstream.llm_provider || '').trim() || null : null,
      llm_model_effective:
        upstream && typeof upstream.llm_model === 'string' ? String(upstream.llm_model || '').trim() || null : null,
    };
    const hasLlmRouteMeta = Boolean(
      llmRouteMeta.llm_provider_requested ||
        llmRouteMeta.llm_model_requested ||
        llmRouteMeta.llm_provider_effective ||
        llmRouteMeta.llm_model_effective,
    );

    if (isResumeUpstreamCall && AURORA_CHAT_RESUME_PROBE_METRICS_ENABLED) {
      const resumeMode = classifyResumeResponseMode(answer);
      recordResumeResponseMode({ mode: resumeMode });
      const knownProfileFieldsForProbe = buildResumeKnownProfileFields(profileSummary);
      const reaskFields = detectResumePlaintextReaskFields(answer, knownProfileFieldsForProbe);
      for (const field of reaskFields) {
        recordResumePlaintextReaskDetected({ field });
      }
    }

    return {
      upstream,
      answer,
      query,
      hasLlmRouteMeta,
      llmRouteMeta,
      llmRouteMetaForResponse: hasLlmRouteMeta ? llmRouteMeta : null,
      isResumeUpstreamCall,
      resumeContextForCall,
    };
  }

  return {
    requestUpstream,
  };
}

module.exports = {
  createChatUpstreamRequestRuntime,
};
