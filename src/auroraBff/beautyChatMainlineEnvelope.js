function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pickFirstTrimmed(...values) {
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (normalized) return normalized;
  }
  return '';
}

function hasOwnKeys(value) {
  return isPlainObject(value) && Object.keys(value).length > 0;
}

function createBeautyChatMainlineEnvelopeRuntime(deps = {}) {
  const {
    BEAUTY_DISCOVERY_MAINLINE_OWNER = 'shopping_agent_beauty_mainline',
    classifyRecoUpstreamFailureCode,
    isTransientRecoUpstreamFailureCode,
    buildConfidenceNoticeCardPayload,
    buildEnvelope,
    makeAssistantMessage,
    makeEvent,
    summarizeProfileForContext,
    applyRecoCanonicalSearchResultToPayload,
    applyRecoContentSpineToPayload,
    buildRecoMainlineContract,
    extractRecoOutcomeContractArgsFromPayload,
    attachRecoContractMeta,
    applyRecoAssistantSelectionSignature,
    extractRecoFinalSelectionContract,
    orderRecoRecommendationsBySelection,
  } = deps;

  function classifyBeautyMainlineHandoffFallback({ handoff = null, err = null } = {}) {
    const transientCode =
      typeof classifyRecoUpstreamFailureCode === 'function' && err
        ? classifyRecoUpstreamFailureCode(err)
        : '';
    if (
      typeof isTransientRecoUpstreamFailureCode === 'function' &&
      isTransientRecoUpstreamFailureCode(transientCode)
    ) {
      return {
        fallback_reason: 'beauty_mainline_handoff_timeout',
        notice_reason: 'upstream_timeout_primary_role',
        mainline_status: 'upstream_timeout',
        upstream_failure_code: transientCode || null,
      };
    }
    if (handoff?.attempted === true) {
      return {
        fallback_reason: 'beauty_mainline_handoff_empty',
        notice_reason: 'upstream_empty_recommendations',
        mainline_status: 'needs_more_context',
        upstream_failure_code: transientCode || null,
      };
    }
    return {
      fallback_reason: 'beauty_mainline_handoff_unavailable',
      notice_reason: 'upstream_empty_recommendations',
      mainline_status: 'needs_more_context',
      upstream_failure_code: transientCode || null,
    };
  }

  function buildBeautyMainlineHandoffFallbackEnvelope({
    ctx,
    fallback = null,
    suggestedChips = [],
  } = {}) {
    const fallbackMeta = isPlainObject(fallback) ? fallback : {};
    const noticePayload = buildConfidenceNoticeCardPayload({
      language: ctx?.lang,
      reason:
        pickFirstTrimmed(fallbackMeta.notice_reason, 'upstream_empty_recommendations') ||
        'upstream_empty_recommendations',
      confidence: {
        score: pickFirstTrimmed(fallbackMeta.mainline_status) === 'upstream_timeout' ? 0.12 : 0.2,
        level: 'low',
        rationale: ['beauty_mainline_handoff_controlled_fallback'],
      },
      actions: ['retry_recommendations', 'update_current_routine'],
      details: [
        `fallback_reason: ${
          pickFirstTrimmed(
            fallbackMeta.fallback_reason,
            'beauty_mainline_handoff_unavailable',
          ) || 'beauty_mainline_handoff_unavailable'
        }`,
      ],
    });
    return buildEnvelope(ctx, {
      assistant_message: makeAssistantMessage(
        String(noticePayload.message || '').trim() ||
          (ctx?.lang === 'CN'
            ? '这轮 beauty 主链没有稳定拿到可落地商品，我先保留保守结果。'
            : 'The beauty mainline did not return a stable grounded product set for this turn, so I am keeping this in a conservative fallback.'),
      ),
      suggested_chips: Array.isArray(suggestedChips) ? suggestedChips : [],
      cards: [
        {
          card_id: `conf_${ctx && ctx.request_id ? ctx.request_id : Date.now()}_beauty_mainline_handoff_fallback`,
          type: 'confidence_notice',
          payload: noticePayload,
        },
      ],
      session_patch: {},
      events: [
        makeEvent(ctx, 'recos_requested', {
          explicit: true,
          source: 'beauty_mainline_handoff',
          source_detail: 'beauty_mainline_handoff',
          fallback_reason:
            pickFirstTrimmed(
              fallbackMeta.fallback_reason,
              'beauty_mainline_handoff_unavailable',
            ) || 'beauty_mainline_handoff_unavailable',
        }),
      ],
    });
  }

  function buildRecoPayloadFromBeautyMainlineHandoff({
    handoff = null,
    profile = null,
    targetContext = null,
    recoContext = null,
    taskMode = 'goal_based_products',
    triggerSource = '',
    sourceMode = '',
    basePayload = null,
    selectionOwner = null,
    entryType = 'chat',
  } = {}) {
    if (!isPlainObject(handoff?.searchResult)) return null;
    const searchResult = handoff.searchResult;
    const selectionContract = extractRecoFinalSelectionContract(searchResult);
    const canonicalSelectedProductIds = Array.isArray(selectionContract?.selected_product_ids)
      ? selectionContract.selected_product_ids.filter((value) => String(value || '').trim())
      : [];
    const canonicalSelectedTitles = Array.isArray(selectionContract?.selected_titles)
      ? selectionContract.selected_titles.filter((value) => String(value || '').trim())
      : [];
    const canonicalDecisionOwner = pickFirstTrimmed(searchResult?.decision_owner);
    const canonicalSemanticOwner = pickFirstTrimmed(searchResult?.semantic_owner);
    const canonicalResolvedContract = pickFirstTrimmed(
      searchResult?.contract_bridge?.resolved_contract,
      searchResult?.metadata?.contract_bridge?.resolved_contract,
    );
    const canonicalSourceTierCounts =
      searchResult?.source_breakdown?.source_tier_counts ||
      searchResult?.metadata?.source_breakdown?.source_tier_counts ||
      selectionContract?.source_tier_counts;
    const hasCanonicalSelection =
      canonicalSelectedProductIds.length > 0 || canonicalSelectedTitles.length > 0;
    const hasCanonicalAuthority =
      hasCanonicalSelection &&
      canonicalDecisionOwner === BEAUTY_DISCOVERY_MAINLINE_OWNER &&
      canonicalSemanticOwner === BEAUTY_DISCOVERY_MAINLINE_OWNER &&
      canonicalResolvedContract === 'agent_v1_search_beauty_mainline' &&
      hasOwnKeys(canonicalSourceTierCounts);
    if (!hasCanonicalAuthority) return null;

    const rawRecommendations = Array.isArray(handoff?.recommendations) ? handoff.recommendations : [];
    const canonicalRecommendations = orderRecoRecommendationsBySelection(
      rawRecommendations,
      selectionContract,
    );
    if (!canonicalRecommendations.length) return null;

    const effectiveSelectionOwner =
      pickFirstTrimmed(
        selectionOwner,
        searchResult?.decision_owner,
        selectionContract?.selection_owner,
        BEAUTY_DISCOVERY_MAINLINE_OWNER,
      ) || BEAUTY_DISCOVERY_MAINLINE_OWNER;
    const mainlineStatus =
      pickFirstTrimmed(selectionContract?.mainline_status, 'grounded_success') ||
      'grounded_success';

    let nextPayload = {
      intent: 'reco_products',
      profile: summarizeProfileForContext(profile),
      recommendations: canonicalRecommendations,
      source: 'catalog_grounded_v1',
      grounding_status: 'grounded',
      grounded_count: canonicalRecommendations.length,
      ungrounded_count: 0,
      mainline_status: mainlineStatus,
      recommendation_confidence_score: Number.isFinite(
        Number(basePayload?.recommendation_confidence_score),
      )
        ? Number(basePayload.recommendation_confidence_score)
        : 0.61,
      recommendation_confidence_level:
        pickFirstTrimmed(basePayload?.recommendation_confidence_level, 'medium') || 'medium',
      task_mode: taskMode,
      recommendation_meta: {
        task_mode: taskMode,
        source_mode:
          pickFirstTrimmed(
            sourceMode,
            basePayload?.recommendation_meta?.source_mode,
            targetContext?.resolved_target_step ? 'step_aware_mainline' : 'framework_mainline',
          ) || 'framework_mainline',
        trigger_source:
          typeof deps.normalizeRecoSourceDetail === 'function'
            ? deps.normalizeRecoSourceDetail(triggerSource)
            : triggerSource,
        recompute_from_profile_update:
          basePayload?.recommendation_meta?.recompute_from_profile_update === true,
        used_recent_logs: basePayload?.recommendation_meta?.used_recent_logs === true,
        used_itinerary: false,
        used_safety_flags: basePayload?.recommendation_meta?.used_safety_flags === true,
        mainline_status: mainlineStatus,
        ...(targetContext?.resolved_target_step
          ? { resolved_target_step: targetContext.resolved_target_step }
          : {}),
        ...(targetContext?.resolved_target_step_confidence
          ? { resolved_target_step_confidence: targetContext.resolved_target_step_confidence }
          : {}),
        ...(targetContext?.resolved_target_step_source
          ? { resolved_target_step_source: targetContext.resolved_target_step_source }
          : {}),
      },
      metadata: {
        mainline_status: mainlineStatus,
      },
    };

    nextPayload = applyRecoCanonicalSearchResultToPayload(nextPayload, searchResult, {
      selectionOwner: effectiveSelectionOwner,
    });
    nextPayload = applyRecoContentSpineToPayload(nextPayload, recoContext);

    const recoContract = buildRecoMainlineContract({
      recommendations: nextPayload.recommendations,
      sourceMode: nextPayload.recommendation_meta?.source_mode,
      source: nextPayload.source,
      promptContractOk: nextPayload.prompt_contract_ok !== false,
      structuredSource: nextPayload.recommendation_meta?.source_mode,
      catalogSkipReason: nextPayload.recommendation_meta?.catalog_skip_reason,
      productsEmptyReason: nextPayload.products_empty_reason,
      groundingStatus:
        nextPayload.grounding_status || nextPayload.recommendation_meta?.grounding_status,
      groundedCount:
        nextPayload.grounded_count || nextPayload.recommendation_meta?.grounded_count,
      ungroundedCount:
        nextPayload.ungrounded_count || nextPayload.recommendation_meta?.ungrounded_count,
      mainlineStatusOverride:
        nextPayload.mainline_status || nextPayload.recommendation_meta?.mainline_status,
      promptTemplateId:
        nextPayload.prompt_template_id || nextPayload.recommendation_meta?.prompt_template_id,
      entryType,
      ...extractRecoOutcomeContractArgsFromPayload(nextPayload, null),
    });
    nextPayload = attachRecoContractMeta(nextPayload, recoContract);
    nextPayload = applyRecoCanonicalSearchResultToPayload(nextPayload, searchResult, {
      selectionOwner: effectiveSelectionOwner,
    });
    nextPayload = applyRecoAssistantSelectionSignature(nextPayload);

    return {
      payload: nextPayload,
      contract: recoContract,
      selectionContract: extractRecoFinalSelectionContract(nextPayload),
    };
  }

  return {
    classifyBeautyMainlineHandoffFallback,
    buildBeautyMainlineHandoffFallbackEnvelope,
    buildRecoPayloadFromBeautyMainlineHandoff,
  };
}

module.exports = {
  createBeautyChatMainlineEnvelopeRuntime,
};
