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
    buildConcernFrameworkSummary,
  } = deps;

  function hasCanonicalTargetBundle(payload = null) {
    const meta = isPlainObject(payload?.recommendation_meta) ? payload.recommendation_meta : {};
    const rankedTargets = Array.isArray(meta.ranked_targets)
      ? meta.ranked_targets.filter((item) => isPlainObject(item))
      : [];
    const primaryTargetId = pickFirstTrimmed(
      meta.primary_target_id,
      rankedTargets.find((item) => pickFirstTrimmed(item?.target_role) === 'primary')?.target_id,
      rankedTargets[0]?.target_id,
    );
    const selectedTargetIds = Array.isArray(meta.selected_target_ids)
      ? meta.selected_target_ids.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    return Boolean(
      primaryTargetId &&
      rankedTargets.length > 0 &&
      rankedTargets.some((item) => pickFirstTrimmed(item?.target_id) === primaryTargetId) &&
      selectedTargetIds.length > 0,
    );
  }

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
    const recommendationMeta = {
      ...(pickFirstTrimmed(fallbackMeta.source_mode) ? { source_mode: pickFirstTrimmed(fallbackMeta.source_mode) } : {}),
      ...(pickFirstTrimmed(fallbackMeta.products_empty_reason) ? { products_empty_reason: pickFirstTrimmed(fallbackMeta.products_empty_reason) } : {}),
      ...(pickFirstTrimmed(fallbackMeta.telemetry_failure_reason) ? { telemetry_failure_reason: pickFirstTrimmed(fallbackMeta.telemetry_failure_reason) } : {}),
    };
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
          ...(pickFirstTrimmed(fallbackMeta.source_mode) ? { source_mode: pickFirstTrimmed(fallbackMeta.source_mode) } : {}),
          fallback_reason:
            pickFirstTrimmed(
              fallbackMeta.fallback_reason,
              'beauty_mainline_handoff_unavailable',
            ) || 'beauty_mainline_handoff_unavailable',
          ...(hasOwnKeys(recommendationMeta) ? { recommendation_meta: recommendationMeta } : {}),
        }),
      ],
    });
  }

  function buildRecoContextProductCandidateFromRecommendation(row) {
    if (!isPlainObject(row)) return null;
    const productId = pickFirstTrimmed(row.product_id, row.productId);
    const merchantId = pickFirstTrimmed(row.merchant_id, row.merchantId);
    const brand = pickFirstTrimmed(row.brand, row.brand_name, row.brandName);
    const name = pickFirstTrimmed(row.name, row.title, row.display_name, row.displayName);
    const displayName = pickFirstTrimmed(row.display_name, row.displayName, row.name, row.title);
    const category = pickFirstTrimmed(
      row.category,
      row.category_name,
      row.categoryName,
      row.product_type,
      row.productType,
      row.step,
    );
    const productType = pickFirstTrimmed(
      row.product_type,
      row.productType,
      row.category,
      row.category_name,
      row.categoryName,
    );
    if (!productId && !merchantId && !displayName && !name) return null;
    return {
      ...(productId ? { product_id: productId } : {}),
      ...(merchantId ? { merchant_id: merchantId } : {}),
      ...(brand ? { brand } : {}),
      ...(name ? { name } : {}),
      ...(displayName ? { display_name: displayName } : {}),
      ...(category ? { category } : {}),
      ...(productType ? { product_type: productType } : {}),
      ...(pickFirstTrimmed(row.retrieval_source, row.retrievalSource, row.source)
        ? { retrieval_source: pickFirstTrimmed(row.retrieval_source, row.retrievalSource, row.source) }
        : {}),
      ...(pickFirstTrimmed(row.url, row.product_url, row.productUrl, row.canonical_pdp_url, row.canonicalPdpUrl, row.purchase_path, row.purchasePath)
        ? { url: pickFirstTrimmed(row.url, row.product_url, row.productUrl, row.canonical_pdp_url, row.canonicalPdpUrl, row.purchase_path, row.purchasePath) }
        : {}),
    };
  }

  function buildFrameworkRecoContextPatch({
    recoContext = null,
    targetContext = null,
    recommendations = [],
  } = {}) {
    const frameworkRoles = Array.isArray(targetContext?.framework_roles)
      ? targetContext.framework_roles.filter((role) => isPlainObject(role))
      : [];
    if (!frameworkRoles.length) return null;

    const primaryRoleId = pickFirstTrimmed(
      targetContext?.primary_role_id,
      frameworkRoles[0]?.role_id,
    );
    const primaryRole =
      frameworkRoles.find((role) => pickFirstTrimmed(role?.role_id) === primaryRoleId)
      || frameworkRoles[0]
      || null;
    const candidatesByRoleId = new Map();

    for (const row of Array.isArray(recommendations) ? recommendations : []) {
      const roleId = pickFirstTrimmed(row?.matched_role_id, row?.matchedRoleId);
      const candidate = buildRecoContextProductCandidateFromRecommendation(row);
      if (!roleId || !candidate) continue;
      const current = candidatesByRoleId.get(roleId) || [];
      if (
        current.some((item) =>
          pickFirstTrimmed(item?.product_id, item?.productId) ===
            pickFirstTrimmed(candidate?.product_id, candidate?.productId),
        )
      ) {
        continue;
      }
      candidatesByRoleId.set(roleId, [...current, candidate].slice(0, 4));
    }

    const rankedTargets = frameworkRoles.slice(0, 4).map((role, index) => {
      const roleId = pickFirstTrimmed(role?.role_id);
      const roleLabel = pickFirstTrimmed(role?.label, roleId);
      const preferredStep = pickFirstTrimmed(
        role?.preferred_step,
        targetContext?.resolved_target_step,
      );
      if (!roleId && !roleLabel && !preferredStep) return null;
      return {
        ...(roleId ? { target_id: roleId } : {}),
        target_role:
          roleId && primaryRoleId
            ? roleId === primaryRoleId
              ? 'primary'
              : 'secondary'
            : index === 0
              ? 'primary'
              : 'secondary',
        ...(roleLabel ? { ingredient_query: roleLabel } : {}),
        ...(preferredStep ? { resolved_target_step: preferredStep } : {}),
        target_confidence: index === 0 ? 'high' : 'medium',
        source: 'beauty_mainline_handoff',
        ...(Array.isArray(candidatesByRoleId.get(roleId)) && candidatesByRoleId.get(roleId).length
          ? { product_candidates: candidatesByRoleId.get(roleId) }
          : {}),
      };
    }).filter(Boolean);

    if (!rankedTargets.length) return null;

    const selectedTargetIds = Array.from(new Set(
      (Array.isArray(recommendations) ? recommendations : [])
        .map((row) => pickFirstTrimmed(row?.matched_role_id, row?.matchedRoleId))
        .filter((roleId) =>
          roleId && rankedTargets.some((target) => pickFirstTrimmed(target?.target_id) === roleId),
        ),
    ));

    const patch = {};
    patch.ranked_targets = rankedTargets;
    patch.primary_target_id = primaryRoleId || pickFirstTrimmed(rankedTargets[0]?.target_id);
    patch.selected_target_ids = selectedTargetIds.length
      ? selectedTargetIds
      : patch.primary_target_id
        ? [patch.primary_target_id]
        : [];
    patch.owner_source = BEAUTY_DISCOVERY_MAINLINE_OWNER;
    patch.target_bundle_owner = BEAUTY_DISCOVERY_MAINLINE_OWNER;
    patch.final_outcome_owner = BEAUTY_DISCOVERY_MAINLINE_OWNER;

    const existingResolvedTargetStep = pickFirstTrimmed(
      recoContext?.resolved_target_step,
      recoContext?.resolvedTargetStep,
      recoContext?.target_step,
      recoContext?.targetStep,
      recoContext?.step,
    );
    const primaryPreferredStep = pickFirstTrimmed(
      primaryRole?.preferred_step,
      targetContext?.resolved_target_step,
    );
    if (!existingResolvedTargetStep && primaryPreferredStep) {
      patch.resolved_target_step = primaryPreferredStep;
      patch.target_step = primaryPreferredStep;
      patch.step = primaryPreferredStep;
    }

    const existingResolvedTargetStepConfidence = pickFirstTrimmed(
      recoContext?.resolved_target_step_confidence,
      recoContext?.resolvedTargetStepConfidence,
      recoContext?.target_step_confidence,
      recoContext?.targetStepConfidence,
      recoContext?.step_confidence,
      recoContext?.stepConfidence,
    );
    if (
      !existingResolvedTargetStepConfidence &&
      pickFirstTrimmed(targetContext?.resolved_target_step_confidence)
    ) {
      patch.resolved_target_step_confidence = pickFirstTrimmed(
        targetContext?.resolved_target_step_confidence,
      );
    }

    const existingResolvedTargetStepSource = pickFirstTrimmed(
      recoContext?.resolved_target_step_source,
      recoContext?.resolvedTargetStepSource,
      recoContext?.target_step_source,
      recoContext?.targetStepSource,
      recoContext?.step_source,
      recoContext?.stepSource,
    );
    if (
      !existingResolvedTargetStepSource &&
      pickFirstTrimmed(targetContext?.resolved_target_step_source)
    ) {
      patch.resolved_target_step_source = pickFirstTrimmed(
        targetContext?.resolved_target_step_source,
      );
    }

    return Object.keys(patch).length > 0 ? patch : null;
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
    language = 'EN',
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
    const canonicalDecisionOwner = pickFirstTrimmed(
      searchResult?.decision_owner,
      searchResult?.metadata?.decision_owner,
    );
    const canonicalSemanticOwner = pickFirstTrimmed(
      searchResult?.semantic_owner,
      searchResult?.metadata?.semantic_owner,
    );
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

    const frameworkRecoContextPatch = buildFrameworkRecoContextPatch({
      recoContext,
      targetContext,
      recommendations: canonicalRecommendations,
    });
    const effectiveRecoContext = frameworkRecoContextPatch
      ? {
          ...(isPlainObject(recoContext) ? recoContext : {}),
          ...frameworkRecoContextPatch,
        }
      : recoContext;

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
    nextPayload = applyRecoContentSpineToPayload(nextPayload, effectiveRecoContext);
    if (Array.isArray(targetContext?.framework_roles) && targetContext.framework_roles.length > 0) {
      const frameworkSummary =
        typeof buildConcernFrameworkSummary === 'function'
          ? buildConcernFrameworkSummary({
              targetContext,
              recommendations: nextPayload.recommendations,
              language,
            })
          : null;
      nextPayload = {
        ...nextPayload,
        ...(isPlainObject(frameworkSummary) ? { framework_summary: frameworkSummary } : {}),
        roles: targetContext.framework_roles.map((role) => ({
          role_id: pickFirstTrimmed(role?.role_id) || null,
          label: pickFirstTrimmed(role?.label) || null,
          why_this_role: pickFirstTrimmed(role?.why_this_role) || null,
          rank: Number.isFinite(Number(role?.rank)) ? Number(role.rank) : null,
          preferred_step: pickFirstTrimmed(role?.preferred_step) || null,
        })),
        primary_role_id: pickFirstTrimmed(targetContext?.primary_role_id) || null,
        primary_recommendation_id:
          pickFirstTrimmed(
            nextPayload.recommendations.find((item) =>
              pickFirstTrimmed(item?.matched_role_id, item?.matchedRoleId) ===
              pickFirstTrimmed(targetContext?.primary_role_id)
            )?.product_id,
            nextPayload.recommendations.find((item) =>
              pickFirstTrimmed(item?.matched_role_id, item?.matchedRoleId) ===
              pickFirstTrimmed(targetContext?.primary_role_id)
            )?.productId,
          ) || null,
        primary_role_matched: nextPayload.recommendations.some((item) =>
          pickFirstTrimmed(item?.matched_role_id, item?.matchedRoleId) ===
          pickFirstTrimmed(targetContext?.primary_role_id)
        ),
        semantic_plan: isPlainObject(targetContext?.semantic_plan) ? targetContext.semantic_plan : null,
        core_roles: Array.isArray(targetContext?.semantic_plan?.core_roles)
          ? targetContext.semantic_plan.core_roles
          : [],
        support_roles: Array.isArray(targetContext?.semantic_plan?.support_roles)
          ? targetContext.semantic_plan.support_roles
          : [],
        ingredient_hypotheses: Array.isArray(targetContext?.semantic_plan?.ingredient_hypotheses)
          ? targetContext.semantic_plan.ingredient_hypotheses
          : [],
      };
    }
    if (isPlainObject(nextPayload.recommendation_meta)) {
      nextPayload.recommendation_meta.owner_source = BEAUTY_DISCOVERY_MAINLINE_OWNER;
      nextPayload.recommendation_meta.final_outcome_owner = BEAUTY_DISCOVERY_MAINLINE_OWNER;
    }
    if (Array.isArray(targetContext?.framework_roles) && targetContext.framework_roles.length > 0 && !hasCanonicalTargetBundle(nextPayload)) {
      return null;
    }
    const persistedRecoContext = {
      ...(isPlainObject(effectiveRecoContext) ? effectiveRecoContext : {}),
      primary_focus: isPlainObject(nextPayload.recommendation_meta?.primary_focus)
        ? nextPayload.recommendation_meta.primary_focus
        : effectiveRecoContext?.primary_focus,
      confidence_policy: isPlainObject(nextPayload.recommendation_meta?.confidence_policy)
        ? nextPayload.recommendation_meta.confidence_policy
        : effectiveRecoContext?.confidence_policy,
      ranked_targets: Array.isArray(nextPayload.recommendation_meta?.ranked_targets)
        ? nextPayload.recommendation_meta.ranked_targets
        : effectiveRecoContext?.ranked_targets,
      primary_target_id: pickFirstTrimmed(
        nextPayload.recommendation_meta?.primary_target_id,
        effectiveRecoContext?.primary_target_id,
      ),
      selected_target_ids: Array.isArray(nextPayload.recommendation_meta?.selected_target_ids)
        ? nextPayload.recommendation_meta.selected_target_ids
        : effectiveRecoContext?.selected_target_ids,
      owner_source: BEAUTY_DISCOVERY_MAINLINE_OWNER,
      target_bundle_owner: BEAUTY_DISCOVERY_MAINLINE_OWNER,
      final_outcome_owner: BEAUTY_DISCOVERY_MAINLINE_OWNER,
    };

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
      recoContext: persistedRecoContext,
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
