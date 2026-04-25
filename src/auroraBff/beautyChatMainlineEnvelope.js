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

function uniqCaseInsensitiveStrings(values, max = 24) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const value = String(raw || '').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= Math.max(1, Number(max) || 24)) break;
  }
  return out;
}

function normalizeRecoComparisonMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return '';
  if (normalized === 'same_role' || normalized === 'same_role_comparison') return 'same_role_comparison';
  return normalized;
}

function normalizeRecoTargetStep(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return '';
  if (normalized.includes('sunscreen') || normalized.includes('spf') || normalized.includes('sun')) return 'sunscreen';
  if (normalized.includes('moistur') || normalized.includes('cream') || normalized.includes('lotion') || normalized.includes('gel cream')) return 'moisturizer';
  if (normalized.includes('mask')) return 'mask';
  if (normalized.includes('serum')) return 'serum';
  if (normalized.includes('treatment') || normalized.includes('retinol') || normalized.includes('acid')) return 'treatment';
  return normalized;
}

function hasEnvelopeExplicitNoAdditionalActiveConstraint(targetContext = null) {
  if (!isPlainObject(targetContext)) return false;
  const semanticPlan = isPlainObject(targetContext?.semantic_plan) ? targetContext.semantic_plan : null;
  const text = [
    targetContext?.request_text,
    targetContext?.focus_text,
    semanticPlan?.primary_concern,
    ...(Array.isArray(semanticPlan?.must_satisfy_constraints) ? semanticPlan.must_satisfy_constraints : []),
  ]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ');
  if (!text) return false;
  return /\b(?:do\s*not\s*want\s*another\s*active|don't\s*want\s*another\s*active|dont\s*want\s*another\s*active|not\s+another\s+active|no\s+(?:extra\s+|more\s+)?actives?|no\s+active\s+ingredients?|must\s+not\s+contain\s+active(?:\s+treatment)?\s+ingredients?|not\s+contain\s+active(?:\s+treatment)?\s+ingredients?|non[- ]?active(?:\s+step|\s+option|\s+moisturi[sz]er)?|without\s+actives?|avoid\s+(?:extra\s+)?actives?|avoid\s+active\s+ingredients?)\b/i.test(
    text,
  );
}

function buildEnvelopeAdditionalActiveText(row = null) {
  const candidate = isPlainObject(row) ? row : {};
  const sku = isPlainObject(candidate?.sku) ? candidate.sku : {};
  return uniqCaseInsensitiveStrings([
    candidate.display_name,
    candidate.displayName,
    candidate.name,
    candidate.title,
    sku.display_name,
    sku.displayName,
    sku.name,
    sku.title,
    candidate.short_description,
    candidate.shortDescription,
    candidate.description,
    candidate.summary,
    candidate.subtitle,
    candidate.why_this_one,
    candidate.whyThisOne,
    candidate?.product_intel?.shopping_card?.intro,
    candidate?.product_intel?.search_card?.intro_candidate,
    candidate?.product_intel?.search_card?.highlight_candidate,
    candidate?.product_intel?.what_it_is?.body,
    candidate?.product_intel?.product_intel_core?.what_it_is?.body,
    ...(Array.isArray(candidate?.key_features) ? candidate.key_features : []),
    ...(Array.isArray(candidate?.keyFeatures) ? candidate.keyFeatures : []),
    ...(Array.isArray(candidate?.compare_highlights) ? candidate.compare_highlights : []),
  ], 24)
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ');
}

function buildEnvelopeAdditionalActiveSignalParts(row = null) {
  const candidate = isPlainObject(row) ? row : {};
  const sku = isPlainObject(candidate?.sku) ? candidate.sku : {};
  const titleText = uniqCaseInsensitiveStrings([
    candidate.display_name,
    candidate.displayName,
    candidate.name,
    candidate.title,
    sku.display_name,
    sku.displayName,
    sku.name,
    sku.title,
    candidate?.product_intel?.shopping_card?.title,
    candidate?.product_intel?.shopping_card?.subtitle,
    candidate?.product_intel?.shopping_card?.highlight,
    candidate?.product_intel?.search_card?.title_candidate,
    candidate?.product_intel?.search_card?.compact_candidate,
    candidate?.product_intel?.search_card?.highlight_candidate,
  ], 16)
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ');
  const positioningText = uniqCaseInsensitiveStrings([
    candidate.short_description,
    candidate.shortDescription,
    candidate.subtitle,
    candidate.why_this_one,
    candidate.whyThisOne,
    candidate?.product_intel?.shopping_card?.intro,
    candidate?.product_intel?.search_card?.intro_candidate,
    candidate?.product_intel?.what_it_is?.body,
    candidate?.product_intel?.product_intel_core?.what_it_is?.body,
    ...(Array.isArray(candidate?.compare_highlights) ? candidate.compare_highlights : []),
  ], 24)
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ');
  const detailText = uniqCaseInsensitiveStrings([
    candidate.description,
    candidate.summary,
    ...(Array.isArray(candidate?.key_features) ? candidate.key_features : []),
    ...(Array.isArray(candidate?.keyFeatures) ? candidate.keyFeatures : []),
  ], 24)
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ');
  return {
    titleText,
    positioningText,
    detailText,
    fullText: [titleText, positioningText, detailText].filter(Boolean).join(' '),
  };
}

function hasEnvelopeAdditionalActiveSignal(row = null) {
  const { titleText, positioningText, detailText, fullText } = buildEnvelopeAdditionalActiveSignalParts(row);
  if (!fullText) return false;
  const strongActivePattern =
    /\b(?:retinol|retinal|retinaldehyde|retinoid|tretinoin|adapalene|salicylic acid|glycolic acid|lactic acid|mandelic acid|azelaic acid|benzoyl peroxide|vitamin c|ascorbic acid|tranexamic acid|arbutin|kojic acid|exfoliat(?:e|ing|ion|or)|acid complex|aha|bha|pha)\b/i;
  if (strongActivePattern.test(fullText)) return true;
  const softActivePattern = /\b(?:niacinamide|peptide(?:s)?|collagen)\b/i;
  if (softActivePattern.test(titleText)) return true;
  const activeForwardContextPattern =
    /\b(?:firm(?:ing|ness)?|fine lines?|wrinkles?|anti[- ]?aging|ageing|brighten(?:ing)?|dark spots?|post[- ]?breakout|tone|pigment|spot[- ]?fading|renewal|resurfac(?:e|ing)|treatment|correct(?:ing|ion)|smooth(?:ing)?)\b/i;
  return softActivePattern.test(detailText) && activeForwardContextPattern.test(fullText);
}

function extractEnvelopeRecoSelectionProductId(row = null) {
  if (!isPlainObject(row)) return '';
  return pickFirstTrimmed(
    row.product_id,
    row.productId,
    row.id,
    row.sku?.product_id,
    row.sku?.productId,
    row.sku?.id,
    row.product?.product_id,
    row.product?.productId,
    row.product?.id,
  );
}

function extractEnvelopeRecoSelectionTitle(row = null) {
  if (!isPlainObject(row)) return '';
  const sku = isPlainObject(row?.sku) ? row.sku : isPlainObject(row?.product) ? row.product : null;
  const brand = pickFirstTrimmed(
    row.brand,
    sku?.brand,
    row.brand_name,
    row.brandName,
  );
  const name = pickFirstTrimmed(
    row.display_name,
    row.displayName,
    row.name,
    row.title,
    sku?.display_name,
    sku?.displayName,
    sku?.name,
    sku?.title,
  );
  if (brand && name && String(name).trim().toLowerCase().startsWith(String(brand).trim().toLowerCase())) {
    return name;
  }
  return [brand, name].filter(Boolean).join(' ').trim() || '';
}

function pruneEnvelopeExplicitNoAdditionalActiveSameRoleRows(rows = [], {
  targetContext = null,
} = {}) {
  const selectedRows = Array.isArray(rows) ? rows.filter((row) => isPlainObject(row)) : [];
  if (selectedRows.length <= 2) return selectedRows;
  const semanticPlan = isPlainObject(targetContext?.semantic_plan) ? targetContext.semantic_plan : null;
  const comparisonMode = normalizeRecoComparisonMode(
    pickFirstTrimmed(
      targetContext?.comparison_mode,
      targetContext?.routine_mode,
      semanticPlan?.comparison_mode,
      semanticPlan?.routine_mode,
      semanticPlan?.selection_constraints?.comparison_mode,
      semanticPlan?.selection_constraints?.routine_mode,
    ),
  );
  if (comparisonMode !== 'same_role_comparison') return selectedRows;
  const frameworkRoles = Array.isArray(targetContext?.framework_roles)
    ? targetContext.framework_roles.filter((role) => isPlainObject(role))
    : [];
  const primaryRole =
    frameworkRoles.find((role) => pickFirstTrimmed(role?.role_id) === pickFirstTrimmed(targetContext?.primary_role_id))
    || frameworkRoles[0]
    || null;
  if (normalizeRecoTargetStep(primaryRole?.preferred_step || targetContext?.resolved_target_step) !== 'moisturizer') {
    return selectedRows;
  }
  if (!hasEnvelopeExplicitNoAdditionalActiveConstraint(targetContext)) return selectedRows;
  const kept = selectedRows.filter((row) => !hasEnvelopeAdditionalActiveSignal(row));
  return kept.length >= 2 ? kept : selectedRows;
}

function buildEnvelopeVisibleSelectionContract(baseSelection = null, recommendations = []) {
  const visibleRows = Array.isArray(recommendations) ? recommendations.filter((row) => isPlainObject(row)) : [];
  const selectedProductIds = [];
  const selectedTitles = [];
  const seenIds = new Set();
  const seenTitles = new Set();
  for (const row of visibleRows) {
    const productId = extractEnvelopeRecoSelectionProductId(row);
    if (productId) {
      const key = productId.toLowerCase();
      if (!seenIds.has(key)) {
        seenIds.add(key);
        selectedProductIds.push(productId);
      }
    }
    const title = extractEnvelopeRecoSelectionTitle(row);
    if (title) {
      const key = title.toLowerCase();
      if (!seenTitles.has(key)) {
        seenTitles.add(key);
        selectedTitles.push(title);
      }
    }
  }
  return {
    ...(isPlainObject(baseSelection) ? baseSelection : {}),
    selected_product_ids: selectedProductIds,
    selected_titles: selectedTitles,
    selected_products_count: visibleRows.length,
    selection_signature: null,
  };
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

  function inferBeautyMainlineHandoffNoticeReason(handoff = null) {
    const searchResult = isPlainObject(handoff?.searchResult) ? handoff.searchResult : {};
    const metadata = isPlainObject(searchResult?.metadata) ? searchResult.metadata : {};
    const searchStageLedger = isPlainObject(metadata?.search_stage_ledger)
      ? metadata.search_stage_ledger
      : isPlainObject(searchResult?.search_stage_ledger)
        ? searchResult.search_stage_ledger
        : {};
    const candidatePoolSummary = isPlainObject(searchStageLedger?.candidate_pool_summary)
      ? searchStageLedger.candidate_pool_summary
      : isPlainObject(metadata?.candidate_pool_summary)
        ? metadata.candidate_pool_summary
        : {};
    const candidateDropStage = pickFirstTrimmed(
      searchStageLedger?.candidate_drop_stage,
      metadata?.candidate_drop_stage,
      searchResult?.candidate_drop_stage,
    ).toLowerCase();
    if (candidateDropStage === 'weak_viable_pool' || candidateDropStage === 'filtered_after_recall') {
      return 'weak_viable_pool';
    }
    if (candidateDropStage === 'no_recall_from_planned_sources') {
      return 'no_recall_from_planned_sources';
    }
    if (candidateDropStage === 'upstream_timeout_primary_role' || candidateDropStage === 'upstream_timeout') {
      return 'upstream_timeout_primary_role';
    }
    const viablePoolStrength = String(candidatePoolSummary?.viable_pool_strength || '').trim().toLowerCase();
    if (candidatePoolSummary?.weak_viable_pool === true || viablePoolStrength === 'weak') {
      return 'weak_viable_pool';
    }
    return '';
  }

  function classifyBeautyMainlineHandoffFallback({ handoff = null, err = null } = {}) {
    const searchResult = isPlainObject(handoff?.searchResult) ? handoff.searchResult : {};
    const metadata = isPlainObject(searchResult?.metadata) ? searchResult.metadata : {};
    const searchStageLedger = isPlainObject(metadata?.search_stage_ledger)
      ? metadata.search_stage_ledger
      : isPlainObject(searchResult?.search_stage_ledger)
        ? searchResult.search_stage_ledger
        : {};
    const candidatePoolSummary = isPlainObject(searchStageLedger?.candidate_pool_summary)
      ? searchStageLedger.candidate_pool_summary
      : isPlainObject(metadata?.candidate_pool_summary)
        ? metadata.candidate_pool_summary
        : {};
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
        ...(hasOwnKeys(searchStageLedger) ? { search_stage_ledger: searchStageLedger } : {}),
        ...(hasOwnKeys(candidatePoolSummary) ? { candidate_pool_summary: candidatePoolSummary } : {}),
      };
    }
    if (handoff?.attempted === true) {
      const inferredNoticeReason =
        inferBeautyMainlineHandoffNoticeReason(handoff) || 'upstream_empty_recommendations';
      return {
        fallback_reason: 'beauty_mainline_handoff_empty',
        notice_reason: inferredNoticeReason,
        products_empty_reason: inferredNoticeReason,
        telemetry_failure_reason: inferredNoticeReason,
        mainline_status: 'needs_more_context',
        upstream_failure_code: transientCode || null,
        query_source: pickFirstTrimmed(searchResult?.query_source, metadata?.query_source) || null,
        source_mode: pickFirstTrimmed(metadata?.source_mode, searchResult?.source_mode) || null,
        ...(hasOwnKeys(searchStageLedger) ? { search_stage_ledger: searchStageLedger } : {}),
        ...(hasOwnKeys(candidatePoolSummary) ? { candidate_pool_summary: candidatePoolSummary } : {}),
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
      ...(pickFirstTrimmed(fallbackMeta.planner_failure_class) ? { planner_failure_class: pickFirstTrimmed(fallbackMeta.planner_failure_class) } : {}),
      ...(isPlainObject(fallbackMeta.search_stage_ledger) ? { search_stage_ledger: fallbackMeta.search_stage_ledger } : {}),
      ...(isPlainObject(fallbackMeta.candidate_pool_summary) ? { candidate_pool_summary: fallbackMeta.candidate_pool_summary } : {}),
      ...(fallbackMeta.fallback_or_gate_blocked === true ? { fallback_or_gate_blocked: true } : {}),
    };
    const details = [
      `fallback_reason: ${
        pickFirstTrimmed(
          fallbackMeta.fallback_reason,
          'beauty_mainline_handoff_unavailable',
        ) || 'beauty_mainline_handoff_unavailable'
      }`,
    ];
    if (pickFirstTrimmed(fallbackMeta.planner_failure_class)) {
      details.push(`planner_failure_class: ${pickFirstTrimmed(fallbackMeta.planner_failure_class)}`);
    }
    if (fallbackMeta.fallback_or_gate_blocked === true) {
      details.push('fallback_or_gate_blocked: true');
    }
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
      details,
    });
    if (isPlainObject(fallbackMeta.search_stage_ledger)) {
      noticePayload.search_stage_ledger = fallbackMeta.search_stage_ledger;
    }
    if (isPlainObject(fallbackMeta.candidate_pool_summary)) {
      noticePayload.candidate_pool_summary = fallbackMeta.candidate_pool_summary;
    }
    if (hasOwnKeys(recommendationMeta)) {
      noticePayload.recommendation_meta = recommendationMeta;
    }
    return buildEnvelope(ctx, {
      assistant_message: makeAssistantMessage(
        String(noticePayload.message || '').trim() ||
          (ctx?.lang === 'CN'
            ? '这轮 beauty 主链没有稳定拿到可落地商品，所以我先不展示商品推荐。'
            : 'The beauty mainline did not return a stable grounded product set for this turn, so I am not showing product picks yet.'),
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

  function compareFrameworkRecoContextCandidateRows(left, right) {
    const scoreDiff = Number(right?.framework_score || 0) - Number(left?.framework_score || 0);
    if (Math.abs(scoreDiff) > 1e-6) return scoreDiff;
    const tiebreakDiff = Number(right?.framework_tiebreak_score || 0) - Number(left?.framework_tiebreak_score || 0);
    if (Math.abs(tiebreakDiff) > 1e-6) return tiebreakDiff;
    const rightSelectedBoost = right?.comparison_fill === true ? 0 : 1;
    const leftSelectedBoost = left?.comparison_fill === true ? 0 : 1;
    if (rightSelectedBoost !== leftSelectedBoost) return rightSelectedBoost - leftSelectedBoost;
    const leftName = pickFirstTrimmed(left?.display_name, left?.displayName, left?.name, left?.title);
    const rightName = pickFirstTrimmed(right?.display_name, right?.displayName, right?.name, right?.title);
    return leftName.localeCompare(rightName);
  }

  function buildFrameworkRecoContextCandidatesByRoleId({
    recommendations = [],
    candidateState = null,
  } = {}) {
    const out = new Map();
    const seenByRole = new Map();
    const addCandidate = (roleId, row) => {
      const normalizedRoleId = String(roleId || '').trim();
      const candidate = buildRecoContextProductCandidateFromRecommendation(row);
      if (!normalizedRoleId || !candidate) return;
      const candidateWithRole = {
        ...candidate,
        matched_role_id: normalizedRoleId,
        role_id: normalizedRoleId,
      };
      const dedupeKey = [
        pickFirstTrimmed(candidateWithRole?.product_id, candidateWithRole?.productId),
        pickFirstTrimmed(candidateWithRole?.merchant_id, candidateWithRole?.merchantId),
        pickFirstTrimmed(candidateWithRole?.display_name, candidateWithRole?.displayName, candidateWithRole?.name, candidateWithRole?.title),
      ].join('::').toLowerCase();
      if (!dedupeKey || dedupeKey === '::::') return;
      const seen = seenByRole.get(normalizedRoleId) || new Set();
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
      seenByRole.set(normalizedRoleId, seen);
      const current = out.get(normalizedRoleId) || [];
      out.set(normalizedRoleId, [...current, candidateWithRole].slice(0, 4));
    };

    const viableCandidates = Array.isArray(candidateState?.viable_candidate_pool)
      ? candidateState.viable_candidate_pool.slice().sort(compareFrameworkRecoContextCandidateRows)
      : [];
    for (const row of viableCandidates) {
      addCandidate(pickFirstTrimmed(row?.matched_role_id, row?.matchedRoleId), row);
    }
    for (const row of Array.isArray(recommendations) ? recommendations : []) {
      addCandidate(pickFirstTrimmed(row?.matched_role_id, row?.matchedRoleId), row);
    }
    return out;
  }

  function buildFrameworkRecoContextPatch({
    recoContext = null,
    targetContext = null,
    recommendations = [],
    candidateState = null,
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
    const candidatesByRoleId = buildFrameworkRecoContextCandidatesByRoleId({
      recommendations,
      candidateState,
    });

    const rankedTargets = frameworkRoles.slice(0, 4).map((role, index) => {
      const roleId = pickFirstTrimmed(role?.role_id);
      const roleLabel = pickFirstTrimmed(role?.label, roleId);
      const preferredStep = pickFirstTrimmed(
        role?.preferred_step,
        targetContext?.resolved_target_step,
      );
      const roleCandidates = Array.isArray(candidatesByRoleId.get(roleId))
        ? candidatesByRoleId.get(roleId)
        : [];
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
        ...(roleCandidates.length
          ? {
              verified_product_count: roleCandidates.length,
              product_candidates: roleCandidates,
            }
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
    const orderedCanonicalRecommendations = orderRecoRecommendationsBySelection(
      rawRecommendations,
      selectionContract,
    );
    const canonicalRecommendations = pruneEnvelopeExplicitNoAdditionalActiveSameRoleRows(
      orderedCanonicalRecommendations,
      { targetContext },
    );
    if (!canonicalRecommendations.length) return null;
    const effectiveSearchResult = (() => {
      if (!isPlainObject(searchResult)) return searchResult;
      if (canonicalRecommendations.length === orderedCanonicalRecommendations.length) return searchResult;
      return {
        ...searchResult,
        final_selection: buildEnvelopeVisibleSelectionContract(selectionContract, canonicalRecommendations),
      };
    })();

    const frameworkRecoContextPatch = buildFrameworkRecoContextPatch({
      recoContext,
      targetContext,
      recommendations: canonicalRecommendations,
      candidateState:
        searchResult?.candidate_state &&
        typeof searchResult.candidate_state === 'object' &&
        !Array.isArray(searchResult.candidate_state)
          ? searchResult.candidate_state
          : searchResult?.candidateState &&
              typeof searchResult.candidateState === 'object' &&
              !Array.isArray(searchResult.candidateState)
            ? searchResult.candidateState
            : null,
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
        ...(basePayload?.recommendation_meta?.request_text
          ? { request_text: pickFirstTrimmed(basePayload.recommendation_meta.request_text) }
          : {}),
        ...(basePayload?.recommendation_meta?.contextual_reco_continuation === true
          ? { contextual_reco_continuation: true }
          : {}),
        ...(basePayload?.recommendation_meta?.current_request_text
          ? { current_request_text: pickFirstTrimmed(basePayload.recommendation_meta.current_request_text) }
          : {}),
        ...(basePayload?.recommendation_meta?.prior_request_text
          ? { prior_request_text: pickFirstTrimmed(basePayload.recommendation_meta.prior_request_text) }
          : {}),
        ...(basePayload?.recommendation_meta?.combined_request_text
          ? { combined_request_text: pickFirstTrimmed(basePayload.recommendation_meta.combined_request_text) }
          : {}),
        ...(basePayload?.recommendation_meta?.chat_planner_used === true
          ? { chat_planner_used: true }
          : {}),
        ...(basePayload?.recommendation_meta?.chat_planner_fallback_used === true
          ? { chat_planner_fallback_used: true }
          : {}),
        ...(basePayload?.recommendation_meta?.chat_planner_source
          ? { chat_planner_source: pickFirstTrimmed(basePayload.recommendation_meta.chat_planner_source) }
          : {}),
        ...(basePayload?.recommendation_meta?.chat_planner_route
          ? { chat_planner_route: pickFirstTrimmed(basePayload.recommendation_meta.chat_planner_route) }
          : {}),
        ...(basePayload?.recommendation_meta?.chat_planner_selection_source
          ? { chat_planner_selection_source: pickFirstTrimmed(basePayload.recommendation_meta.chat_planner_selection_source) }
          : {}),
        ...(basePayload?.recommendation_meta?.chat_planner_failure_class
          ? { chat_planner_failure_class: pickFirstTrimmed(basePayload.recommendation_meta.chat_planner_failure_class) }
          : {}),
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

    nextPayload = applyRecoCanonicalSearchResultToPayload(nextPayload, effectiveSearchResult, {
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
    nextPayload = applyRecoCanonicalSearchResultToPayload(nextPayload, effectiveSearchResult, {
      selectionOwner: effectiveSelectionOwner,
    });
    const finalVisibleRecommendations = pruneEnvelopeExplicitNoAdditionalActiveSameRoleRows(
      Array.isArray(nextPayload?.recommendations) ? nextPayload.recommendations : [],
      { targetContext },
    );
    if (
      Array.isArray(nextPayload?.recommendations)
      && finalVisibleRecommendations.length > 0
      && finalVisibleRecommendations.length !== nextPayload.recommendations.length
    ) {
      const finalVisibleSelection = buildEnvelopeVisibleSelectionContract(
        extractRecoFinalSelectionContract(nextPayload) || selectionContract,
        finalVisibleRecommendations,
      );
      const nextRecommendationMeta = isPlainObject(nextPayload.recommendation_meta)
        ? { ...nextPayload.recommendation_meta }
        : {};
      const nextPayloadMeta = isPlainObject(nextPayload.metadata) ? { ...nextPayload.metadata } : {};
      nextRecommendationMeta.final_selection = finalVisibleSelection;
      nextRecommendationMeta.selected_product_ids = finalVisibleSelection.selected_product_ids;
      nextRecommendationMeta.selected_titles = finalVisibleSelection.selected_titles;
      nextRecommendationMeta.selection_signature = null;
      if (isPlainObject(nextPayloadMeta.search_stage_ledger)) {
        nextPayloadMeta.search_stage_ledger = {
          ...nextPayloadMeta.search_stage_ledger,
          final_selection: finalVisibleSelection,
        };
      }
      nextPayloadMeta.final_selection = finalVisibleSelection;
      nextPayloadMeta.selected_product_ids = finalVisibleSelection.selected_product_ids;
      nextPayloadMeta.selected_titles = finalVisibleSelection.selected_titles;
      nextPayloadMeta.selection_signature = null;
      nextPayload = {
        ...nextPayload,
        recommendations: finalVisibleRecommendations,
        grounded_count: finalVisibleRecommendations.length,
        ...(Array.isArray(nextPayload?.products) ? { products: finalVisibleRecommendations } : {}),
        primary_recommendation_id:
          extractEnvelopeRecoSelectionProductId(finalVisibleRecommendations[0]) || nextPayload.primary_recommendation_id,
        recommendation_meta: nextRecommendationMeta,
        metadata: nextPayloadMeta,
      };
    }
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
