function createChatIngredientLookupRuntime(options = {}) {
  const {
    logger = null,
    isPlainObject,
    pickFirstTrimmed,
    normalizeIngredientRecoContextValue,
    mergeIngredientRecoContextValue,
    ingredientEntityMatchFromText,
    resolveIngredientReferenceRuntimeMatch,
    resolveIngredientSignalRuntimeMatch,
    shouldPreferSignalRuntimeMatch,
    normalizeIngredientResearchKey,
    checkIngredientLookupRateLimit,
    getIngredientResearchCache,
    getIngredientResearchKbEntry,
    touchIngredientResearchCache,
    INGREDIENT_ROUTE_V2_ENABLED = false,
    INGREDIENT_LEGACY_PATH_ENABLED = false,
    AURORA_INGREDIENT_LLM_REPORT_ENABLED = false,
    runIngredientResearchSync,
    asResearchObject,
    getIngredientProviderCircuitState,
    INGREDIENT_KB_ONLY_MODE = false,
    enqueueIngredientResearchJob,
    buildIngredientReportPayload,
    stateChangeAllowed,
    buildIngredientReportQuickReplyChips,
    recordAuroraIngredientsFlowMetric = () => {},
    INGREDIENT_ROUTE_RULE_VERSION = '',
  } = options;

  function requireFunction(name, value) {
    if (typeof value === 'function') return value;
    throw new Error(`aurora chat ingredient lookup runtime missing dependency: ${name}`);
  }

  function clonePatchMeta(sessionPatch) {
    const isPlainObjectFn = requireFunction('isPlainObject', isPlainObject);
    const patch = isPlainObjectFn(sessionPatch) ? { ...sessionPatch } : {};
    const meta =
      patch.meta && isPlainObjectFn(patch.meta)
        ? { ...patch.meta }
        : {};
    return { patch, meta };
  }

  function attachIngredientRouteMetaToSessionPatch(
    sessionPatch,
    {
      queryFirstApplied = false,
      routeSource = '',
      normalizedQuery = '',
      entityMatchType = '',
      entityConfidence = null,
      routeDecisionReasons = null,
      routeRuleVersion = '',
    } = {},
  ) {
    const { patch, meta } = clonePatchMeta(sessionPatch);
    if (queryFirstApplied) meta.ingredient_query_first_applied = true;
    const source = String(routeSource || '').trim().toLowerCase();
    if (source === 'text' || source === 'chip') meta.ingredient_route_source = source;
    const normalized = String(normalizedQuery || '').trim().slice(0, 120);
    if (normalized) meta.normalized_query = normalized;
    const matchType = String(entityMatchType || '').trim().toLowerCase();
    if (matchType) meta.entity_match_type = matchType;
    if (Number.isFinite(Number(entityConfidence))) {
      meta.entity_confidence = Math.max(0, Math.min(1, Number(entityConfidence)));
    }
    const decisionReasons = Array.isArray(routeDecisionReasons)
      ? routeDecisionReasons.map((value) => String(value || '').trim()).filter(Boolean).slice(0, 12)
      : [];
    if (decisionReasons.length > 0) meta.route_decision_reasons = decisionReasons;
    const ruleVersion = String(routeRuleVersion || '').trim();
    if (ruleVersion) meta.route_rule_version = ruleVersion;
    if (Object.keys(meta).length > 0) patch.meta = meta;
    return patch;
  }

  function attachIngredientResearchJobMetaToSessionPatch(sessionPatch, jobId = '') {
    const job = String(jobId || '').trim();
    if (!job) return sessionPatch;
    const { patch, meta } = clonePatchMeta(sessionPatch);
    meta.ingredient_research_job_id = job.slice(0, 120);
    patch.meta = meta;
    return patch;
  }

  function attachIngredientContextMetaToSessionPatch(sessionPatch, contextValue) {
    const normalizeIngredientRecoContextValueFn = requireFunction(
      'normalizeIngredientRecoContextValue',
      normalizeIngredientRecoContextValue,
    );
    const contextNormalized = normalizeIngredientRecoContextValueFn(contextValue);
    if (!contextNormalized) return sessionPatch;
    const { patch, meta } = clonePatchMeta(sessionPatch);
    meta.ingredient_context = contextNormalized;
    patch.meta = meta;
    return patch;
  }

  async function buildIngredientLookupEnvelope({
    ctx,
    req,
    identity = null,
    profile = null,
    ingredientRecoContext = null,
    ingredientGoalRequest = null,
    nextStateOverride = null,
    lookupTarget = '',
    routeSource = 'chip',
    queryFirstApplied = false,
    reasonTag = 'ingredient_lookup_report',
    explicitRouteReasons = [],
    skipRateLimit = false,
    buildEnvelope,
    makeChatAssistantMessage,
    makeEvent,
  } = {}) {
    const pickFirstTrimmedFn = requireFunction('pickFirstTrimmed', pickFirstTrimmed);
    const ingredientEntityMatchFromTextFn = requireFunction(
      'ingredientEntityMatchFromText',
      ingredientEntityMatchFromText,
    );
    const resolveIngredientReferenceRuntimeMatchFn = requireFunction(
      'resolveIngredientReferenceRuntimeMatch',
      resolveIngredientReferenceRuntimeMatch,
    );
    const resolveIngredientSignalRuntimeMatchFn = requireFunction(
      'resolveIngredientSignalRuntimeMatch',
      resolveIngredientSignalRuntimeMatch,
    );
    const shouldPreferSignalRuntimeMatchFn = requireFunction(
      'shouldPreferSignalRuntimeMatch',
      shouldPreferSignalRuntimeMatch,
    );
    const normalizeIngredientResearchKeyFn = requireFunction(
      'normalizeIngredientResearchKey',
      normalizeIngredientResearchKey,
    );
    const checkIngredientLookupRateLimitFn = requireFunction(
      'checkIngredientLookupRateLimit',
      checkIngredientLookupRateLimit,
    );
    const getIngredientResearchCacheFn = requireFunction(
      'getIngredientResearchCache',
      getIngredientResearchCache,
    );
    const getIngredientResearchKbEntryFn = requireFunction(
      'getIngredientResearchKbEntry',
      getIngredientResearchKbEntry,
    );
    const touchIngredientResearchCacheFn = requireFunction(
      'touchIngredientResearchCache',
      touchIngredientResearchCache,
    );
    const runIngredientResearchSyncFn = requireFunction(
      'runIngredientResearchSync',
      runIngredientResearchSync,
    );
    const asResearchObjectFn = requireFunction('asResearchObject', asResearchObject);
    const getIngredientProviderCircuitStateFn = requireFunction(
      'getIngredientProviderCircuitState',
      getIngredientProviderCircuitState,
    );
    const enqueueIngredientResearchJobFn = requireFunction(
      'enqueueIngredientResearchJob',
      enqueueIngredientResearchJob,
    );
    const buildIngredientReportPayloadFn = requireFunction(
      'buildIngredientReportPayload',
      buildIngredientReportPayload,
    );
    const stateChangeAllowedFn = requireFunction('stateChangeAllowed', stateChangeAllowed);
    const buildIngredientReportQuickReplyChipsFn = requireFunction(
      'buildIngredientReportQuickReplyChips',
      buildIngredientReportQuickReplyChips,
    );
    const buildEnvelopeFn = requireFunction('buildEnvelope', buildEnvelope);
    const makeChatAssistantMessageFn = requireFunction(
      'makeChatAssistantMessage',
      makeChatAssistantMessage,
    );
    const makeEventFn = requireFunction('makeEvent', makeEvent);
    const mergeIngredientRecoContextValueFn = requireFunction(
      'mergeIngredientRecoContextValue',
      mergeIngredientRecoContextValue,
    );

    const targetInput = String(lookupTarget || '').trim().slice(0, 120);
    if (!targetInput) return null;

    const ingredientReferenceMatch = await resolveIngredientReferenceRuntimeMatchFn(
      targetInput,
      ctx && ctx.lang,
    );
    const entityMatch = ingredientEntityMatchFromTextFn(targetInput, ctx && ctx.lang);
    const ingredientSignalMatch = await resolveIngredientSignalRuntimeMatchFn(
      targetInput,
      ctx && ctx.lang,
    );
    const shouldPreferSignalMatch = shouldPreferSignalRuntimeMatchFn(
      ingredientSignalMatch,
      entityMatch,
      ingredientReferenceMatch,
    );
    const target =
      ingredientReferenceMatch && ingredientReferenceMatch.canonical_query
        ? String(ingredientReferenceMatch.canonical_query).slice(0, 120)
        : shouldPreferSignalMatch && ingredientSignalMatch && ingredientSignalMatch.canonical_query
          ? String(ingredientSignalMatch.canonical_query).slice(0, 120)
          : targetInput;
    const normalizedQuery = normalizeIngredientResearchKeyFn(target);
    const routeReasons = Array.isArray(explicitRouteReasons)
      ? explicitRouteReasons.map((value) => String(value || '').trim()).filter(Boolean)
      : [];
    const lookupGoal =
      pickFirstTrimmedFn(
        ingredientRecoContext && ingredientRecoContext.goal,
        ingredientGoalRequest && ingredientGoalRequest.goal,
      ) || '';
    const lookupSensitivity =
      pickFirstTrimmedFn(
        ingredientRecoContext && ingredientRecoContext.sensitivity,
        ingredientGoalRequest && ingredientGoalRequest.sensitivity,
      ) || '';
    if (entityMatch.entity_match_type && entityMatch.entity_match_type !== 'none') {
      routeReasons.push(`entity_${entityMatch.entity_match_type}_match`);
    }
    if (ingredientReferenceMatch && ingredientReferenceMatch.reference) {
      routeReasons.push('reference_seed_match');
    } else if (shouldPreferSignalMatch && ingredientSignalMatch && ingredientSignalMatch.signal) {
      routeReasons.push('signal_dict_match');
    } else if (!entityMatch.entity_match_type || entityMatch.entity_match_type === 'none') {
      routeReasons.push('entity_no_match');
    }
    const signalOnlyMatch = Boolean(
      shouldPreferSignalMatch &&
      ingredientSignalMatch &&
      ingredientSignalMatch.signal &&
      !(ingredientReferenceMatch && ingredientReferenceMatch.reference),
    );

    const rateLimit = skipRateLimit
      ? { blocked: false, reason: '' }
      : checkIngredientLookupRateLimitFn({
        sessionKey: pickFirstTrimmedFn(
          identity && identity.auroraUid,
          ctx && ctx.aurora_uid,
          ctx && ctx.brief_id,
          ctx && ctx.trace_id,
        ),
        ipKey: String((req && (req.ip || (req.headers && req.headers['x-forwarded-for']))) || '')
          .split(',')[0]
          .trim(),
      });
    if (rateLimit.blocked) {
      routeReasons.push(rateLimit.reason || 'rate_limited');
      recordAuroraIngredientsFlowMetric({ stage: 'rate_limited', hit: true });
    }

    let researchCache = signalOnlyMatch ? null : getIngredientResearchCacheFn(target);
    if (!signalOnlyMatch && !researchCache) {
      const genericKbHit = await getIngredientResearchKbEntryFn({
        query: target,
        lang: ctx && ctx.lang,
        layer: 'generic',
      });
      const variantKbHit =
        lookupGoal || lookupSensitivity
          ? await getIngredientResearchKbEntryFn({
            query: target,
            lang: ctx && ctx.lang,
            layer: 'variant',
            goal: lookupGoal,
            sensitivity: lookupSensitivity,
          })
          : null;
      const selectedKbHit = variantKbHit || genericKbHit;
      if (selectedKbHit && selectedKbHit.ingredient_profile_json) {
        researchCache = {
          ...(selectedKbHit.ingredient_profile_json || {}),
          status: selectedKbHit.status || 'ready',
          provider: selectedKbHit.provider || 'gemini',
          updated_at_ms: selectedKbHit.updated_at
            ? Date.parse(selectedKbHit.updated_at) || Date.now()
            : Date.now(),
          kb_revision: Number.isFinite(Number(selectedKbHit.revision))
            ? String(Math.max(1, Math.trunc(Number(selectedKbHit.revision))))
            : null,
        };
        touchIngredientResearchCacheFn(normalizedQuery, researchCache, { persist: false });
        routeReasons.push(variantKbHit ? 'kb_variant_hit' : 'kb_generic_hit');
      }
    }

    const researchReady = Boolean(researchCache && researchCache.status === 'ready');
    let resolvedResearch = researchCache || null;
    let syncResearch = null;
    if (
      !signalOnlyMatch &&
      !researchReady &&
      INGREDIENT_ROUTE_V2_ENABLED &&
      !INGREDIENT_LEGACY_PATH_ENABLED &&
      AURORA_INGREDIENT_LLM_REPORT_ENABLED &&
      !rateLimit.blocked
    ) {
      const profileSummaryForResearch =
        profile && typeof profile === 'object'
          ? {
            skin_type: pickFirstTrimmedFn(profile.skinType, profile.skin_type) || null,
            sensitivity: pickFirstTrimmedFn(profile.sensitivity, profile.skin_sensitivity) || null,
            concerns: Array.isArray(profile.goals) ? profile.goals.slice(0, 4) : [],
          }
          : null;
      syncResearch = await runIngredientResearchSyncFn({
        query: target,
        normalizedQuery,
        language: ctx && ctx.lang,
        goal: lookupGoal || null,
        sensitivity: lookupSensitivity || null,
        profileSummary: profileSummaryForResearch,
        sources: [],
        logger,
      });
      const syncPayload = asResearchObjectFn(syncResearch && syncResearch.research) || null;
      if (syncPayload) {
        const syncState = {
          ...syncPayload,
          status: syncResearch && syncResearch.ok ? 'ready' : 'fallback',
          provider: syncResearch && syncResearch.provider ? syncResearch.provider : 'gemini',
          provider_model_tier:
            syncResearch && syncResearch.provider_model_tier
              ? syncResearch.provider_model_tier
              : 'flash',
          provider_circuit_state:
            syncResearch && syncResearch.provider_circuit_state
              ? syncResearch.provider_circuit_state
              : getIngredientProviderCircuitStateFn(),
          error_code: syncResearch && syncResearch.research_error_code
            ? syncResearch.research_error_code
            : null,
          provider_attempts:
            Array.isArray(syncResearch && syncResearch.provider_attempts)
              ? syncResearch.provider_attempts.slice(0, 3)
              : [],
          normalized_query: normalizedQuery,
          updated_at_ms: Date.now(),
        };
        resolvedResearch = syncState;
        const hasMinimumSections = Boolean(
          pickFirstTrimmedFn(
            syncState.what_it_is,
            syncState.overview,
            syncState.ingredient && syncState.ingredient.what_it_is,
            syncState.ingredient && syncState.ingredient.display_name,
            syncState.verdict && syncState.verdict.one_liner,
          ),
        );
        if (syncResearch && syncResearch.ok && hasMinimumSections) {
          touchIngredientResearchCacheFn(normalizedQuery, syncState, { persist: true, logger });
          routeReasons.push('sync_research_hit');
        } else {
          routeReasons.push('sync_research_fallback');
          recordAuroraIngredientsFlowMetric({ stage: 'empty_section_prevented', hit: true });
        }
      }
    }

    const cacheAfterSync = getIngredientResearchCacheFn(target);
    const readyAfterSync = Boolean(cacheAfterSync && cacheAfterSync.status === 'ready');
    if (readyAfterSync) {
      resolvedResearch = cacheAfterSync;
      recordAuroraIngredientsFlowMetric({ stage: 'kb_hit', hit: true });
    } else {
      recordAuroraIngredientsFlowMetric({ stage: 'kb_miss', hit: true });
    }

    const shouldQueueResearch =
      !signalOnlyMatch &&
      !readyAfterSync &&
      !INGREDIENT_KB_ONLY_MODE &&
      AURORA_INGREDIENT_LLM_REPORT_ENABLED;
    const researchJob = shouldQueueResearch
      ? enqueueIngredientResearchJobFn({
        query: target,
        language: ctx && ctx.lang,
        requestId: ctx && ctx.request_id,
        traceId: ctx && ctx.trace_id,
        logger,
      })
      : readyAfterSync
        ? { status: 'ready', job_id: cacheAfterSync && cacheAfterSync.job_id ? cacheAfterSync.job_id : null }
        : null;
    if (researchJob && researchJob.status === 'queued') {
      recordAuroraIngredientsFlowMetric({ stage: 'research_requested', hit: true });
    }

    const reportPayload = buildIngredientReportPayloadFn({
      language: ctx && ctx.lang,
      query: target,
      research: resolvedResearch || researchJob || null,
      meta: {
        normalized_query: normalizedQuery,
        ingredient_reference:
          ingredientReferenceMatch && ingredientReferenceMatch.reference
            ? ingredientReferenceMatch.reference
            : null,
        ingredient_signal:
          shouldPreferSignalMatch && ingredientSignalMatch && ingredientSignalMatch.signal
            ? ingredientSignalMatch.signal
            : null,
        ingredient_signal_preferred: shouldPreferSignalMatch,
        route_decision_reasons: routeReasons.slice(0, 12),
        route_rule_version: INGREDIENT_ROUTE_RULE_VERSION,
        provider_model_tier: resolvedResearch && resolvedResearch.provider_model_tier,
        provider_circuit_state: resolvedResearch && resolvedResearch.provider_circuit_state,
        research_provider: resolvedResearch && resolvedResearch.provider,
        research_error_code: resolvedResearch && (resolvedResearch.error_code || resolvedResearch.error),
      },
    });
    const ingredientName =
      pickFirstTrimmedFn(
        reportPayload && reportPayload.ingredient && reportPayload.ingredient.display_name,
        reportPayload && reportPayload.ingredient && reportPayload.ingredient.inci,
        target,
      ) || target;
    const assistantText =
      ctx && ctx.lang === 'CN'
        ? reportPayload.research_status === 'queued'
          ? `已先返回 ${ingredientName} 的快速结论，增强证据生成中。`
          : `已为你生成 ${ingredientName} 的 1-minute 成分报告。`
        : reportPayload.research_status === 'queued'
          ? `Returning a quick brief for ${ingredientName}; enhanced evidence is generating.`
          : `I generated a 1-minute ingredient report for ${ingredientName}.`;

    let sessionPatch = attachIngredientRouteMetaToSessionPatch(
      nextStateOverride && stateChangeAllowedFn(ctx && ctx.trigger_source)
        ? { next_state: nextStateOverride }
        : {},
      {
        queryFirstApplied,
        routeSource,
        normalizedQuery,
        entityMatchType: entityMatch.entity_match_type,
        entityConfidence: entityMatch.entity_confidence,
        routeDecisionReasons: routeReasons,
        routeRuleVersion: INGREDIENT_ROUTE_RULE_VERSION,
      },
    );
    if (researchJob && researchJob.job_id) {
      sessionPatch = attachIngredientResearchJobMetaToSessionPatch(sessionPatch, researchJob.job_id);
    }
    sessionPatch = attachIngredientContextMetaToSessionPatch(
      sessionPatch,
      mergeIngredientRecoContextValueFn(ingredientRecoContext, {
        query: target,
        source: routeSource === 'text' ? 'text_lookup' : 'chip_lookup',
        updated_at_ms: Date.now(),
      }),
    );

    const events = [
      makeEventFn(ctx, readyAfterSync ? 'ingredient_kb_hit' : 'ingredient_kb_miss', {
        query: String(target || '').slice(0, 120),
        normalized_query: normalizedQuery,
      }),
      makeEventFn(ctx, 'state_entered', {
        next_state: (ctx && ctx.state) || 'idle',
        reason: reasonTag,
      }),
    ];
    if (researchJob && researchJob.status === 'queued') {
      events.push(
        makeEventFn(ctx, 'ingredient_research_requested', {
          ingredient_query: String(target || '').slice(0, 120),
          normalized_query: normalizedQuery,
          job_id: String(researchJob.job_id || '').slice(0, 120),
        }),
      );
    }
    if (reportPayload && reportPayload.kb_revision) {
      events.push(
        makeEventFn(ctx, 'ingredient_kb_updated', {
          ingredient_query: String(target || '').slice(0, 120),
          normalized_query: normalizedQuery,
          revision: String(reportPayload.kb_revision || '').slice(0, 64),
        }),
      );
    }

    return buildEnvelopeFn(ctx, {
      assistant_message: makeChatAssistantMessageFn(assistantText),
      suggested_chips: buildIngredientReportQuickReplyChipsFn({
        language: ctx && ctx.lang,
        reportPayload,
      }),
      cards: [
        {
          card_id: `ingredient_report_${ctx && ctx.request_id}`,
          type: 'aurora_ingredient_report',
          payload: reportPayload,
        },
      ],
      session_patch: sessionPatch,
      events,
    });
  }

  return {
    attachIngredientRouteMetaToSessionPatch,
    attachIngredientResearchJobMetaToSessionPatch,
    attachIngredientContextMetaToSessionPatch,
    buildIngredientLookupEnvelope,
  };
}

module.exports = {
  createChatIngredientLookupRuntime,
};
