function buildIngredientIntentDirectBaseMetadata({
  diagnostics = {},
  recallProfileDiagnostics = {},
  recallProfile = null,
  ingredientIntentDetected = false,
  ingredientIntentIds = [],
  strictConstraintReason = null,
  mergedRecalledProducts = [],
  directServiceProducts = [],
  hasServiceRecallMeta = false,
  ingredientBudgetRescueAttempted = false,
  ingredientBudgetRescueRecovered = false,
  ingredientBudgetRescueQueries = [],
  ingredientDirectRecallLimit = null,
  ingredientDirectMinimumProducts = null,
} = {}) {
  return {
    fetched_at: new Date().toISOString(),
    strict_constraint_query: ingredientIntentIds.length > 0,
    strict_constraint_reason: strictConstraintReason,
    ...(ingredientIntentIds.length > 0 ? { ingredient_intents: ingredientIntentIds } : {}),
    ingredient_direct_main_path_status:
      diagnostics.ingredient_direct_main_path_status === 'direct_hit'
        ? 'direct_hit'
        : 'direct_empty_unrecovered',
    ingredient_intent_detected:
      diagnostics.ingredient_intent_detected === true || ingredientIntentDetected,
    ingredient_registry_match:
      recallProfileDiagnostics.registry_match === true ||
      diagnostics.ingredient_registry_match === true,
    ingredient_registry_source:
      diagnostics.ingredient_registry_source ||
      recallProfileDiagnostics.registry_source ||
      'none',
    ingredient_profile_source:
      diagnostics.ingredient_profile_source ||
      recallProfileDiagnostics.profile_source ||
      (recallProfile ? 'local' : 'none'),
    ingredient_registry_source_breakdown:
      diagnostics.ingredient_registry_source_breakdown &&
      typeof diagnostics.ingredient_registry_source_breakdown === 'object'
        ? { ...diagnostics.ingredient_registry_source_breakdown }
        : recallProfileDiagnostics.registry_source_breakdown &&
            typeof recallProfileDiagnostics.registry_source_breakdown === 'object'
          ? { ...recallProfileDiagnostics.registry_source_breakdown }
          : {},
    ingredient_evidence_mode: diagnostics.ingredient_evidence_mode || null,
    ingredient_direct_source_stage_counts:
      diagnostics.ingredient_direct_source_stage_counts &&
      typeof diagnostics.ingredient_direct_source_stage_counts === 'object'
        ? { ...diagnostics.ingredient_direct_source_stage_counts }
        : {},
    ingredient_direct_source_reject_breakdown:
      diagnostics.ingredient_direct_source_reject_breakdown &&
      typeof diagnostics.ingredient_direct_source_reject_breakdown === 'object'
        ? { ...diagnostics.ingredient_direct_source_reject_breakdown }
        : {},
    ingredient_direct_source_statuses:
      diagnostics.ingredient_direct_source_statuses &&
      typeof diagnostics.ingredient_direct_source_statuses === 'object'
        ? { ...diagnostics.ingredient_direct_source_statuses }
        : {},
    ingredient_candidate_evidence_breakdown:
      diagnostics.ingredient_candidate_evidence_breakdown &&
      typeof diagnostics.ingredient_candidate_evidence_breakdown === 'object'
        ? { ...diagnostics.ingredient_candidate_evidence_breakdown }
        : {},
    runtime_ingredient_evidence_source:
      String(diagnostics.runtime_ingredient_evidence_source || '').trim() || 'none',
    seed_anchor_source_kind:
      String(diagnostics.seed_anchor_source_kind || '').trim() || 'none',
    seed_anchor_conflict_status:
      String(diagnostics.seed_anchor_conflict_status || '').trim() || 'none',
    ingredient_direct_miss_reason: diagnostics.ingredient_direct_miss_reason || null,
    kb_recall_attempted: diagnostics.kb_recall_attempted === true,
    kb_recall_recovered: Math.max(0, Number(diagnostics.kb_recall_recovered || 0) || 0),
    attached_seed_recall_attempted: diagnostics.attached_seed_recall_attempted === true,
    attached_seed_recall_recovered: Math.max(
      0,
      Number(diagnostics.attached_seed_recall_recovered || 0) || 0,
    ),
    products_cache_recall_attempted: diagnostics.products_cache_recall_attempted === true,
    products_cache_recall_recovered: Math.max(
      0,
      Number(diagnostics.products_cache_recall_recovered || 0) || 0,
    ),
    unattached_seed_recall_attempted: diagnostics.unattached_seed_recall_attempted === true,
    unattached_seed_recall_recovered: Math.max(
      0,
      Number(diagnostics.unattached_seed_recovered || 0) || 0,
    ),
    family_fallback_attempted: diagnostics.family_fallback_attempted === true,
    family_fallback_recovered: Math.max(
      0,
      Number(diagnostics.family_fallback_recovered || 0) || 0,
    ),
    family_fallback_used: diagnostics.family_fallback_used === true,
    clarify_applied_after_kb_exhausted: false,
    strict_empty_reason: diagnostics.ingredient_direct_miss_reason || null,
    source_breakdown: {
      internal_count: 0,
      external_seed_count: mergedRecalledProducts.length,
      stale_cache_used: false,
      strategy_applied: 'ingredient_registry_then_direct_evidence',
    },
    ingredient_recall_source_breakdown:
      diagnostics.recall_source_breakdown &&
      typeof diagnostics.recall_source_breakdown === 'object'
        ? { ...diagnostics.recall_source_breakdown }
        : {},
    ingredient_candidate_reject_breakdown:
      diagnostics.ingredient_candidate_reject_breakdown &&
      typeof diagnostics.ingredient_candidate_reject_breakdown === 'object'
        ? { ...diagnostics.ingredient_candidate_reject_breakdown }
        : {},
    ingredient_rejected_candidate_samples: Array.isArray(
      diagnostics.ingredient_rejected_candidate_samples,
    )
      ? diagnostics.ingredient_rejected_candidate_samples.slice(0, 5)
      : [],
    ingredient_ranked_candidate_samples: Array.isArray(
      diagnostics.ingredient_ranked_candidate_samples,
    )
      ? diagnostics.ingredient_ranked_candidate_samples.slice(0, 5)
      : [],
    ingredient_direct_service_products_count: directServiceProducts.length,
    ingredient_direct_display_strategy: hasServiceRecallMeta
      ? 'service_stabilized'
      : 'route_stabilized',
    ingredient_budget_query_rescue_attempted: ingredientBudgetRescueAttempted,
    ingredient_budget_query_rescue_recovered: ingredientBudgetRescueRecovered,
    ingredient_budget_query_rescue_query:
      ingredientBudgetRescueAttempted && ingredientBudgetRescueQueries.length > 0
        ? ingredientBudgetRescueQueries[0]
        : null,
    ingredient_direct_recall_limit: ingredientDirectRecallLimit,
    ingredient_direct_minimum_products: ingredientDirectMinimumProducts,
    products_returned_count: mergedRecalledProducts.length,
    external_seed_returned_count: mergedRecalledProducts.length,
  };
}

function shouldTreatIngredientDirectRecallAsMiss({
  baseMetadata = {},
  diagnostics = {},
  hasIngredientIntentExplicitEvidenceBreakdown,
} = {}) {
  const directBreakdownProvided =
    hasIngredientIntentExplicitEvidenceBreakdown(
      baseMetadata.ingredient_candidate_evidence_breakdown,
    ) || Number(baseMetadata?.ingredient_candidate_evidence_breakdown?.family_only || 0) > 0;
  const directRecallHasExplicitEvidence = hasIngredientIntentExplicitEvidenceBreakdown(
    baseMetadata.ingredient_candidate_evidence_breakdown,
  );
  return (
    !Number(baseMetadata.products_returned_count || 0) ||
    (diagnostics.family_fallback_used === true && !directRecallHasExplicitEvidence) ||
    (directBreakdownProvided &&
      !directRecallHasExplicitEvidence &&
      Number(baseMetadata?.ingredient_candidate_evidence_breakdown?.family_only || 0) > 0)
  );
}

function mapGuidanceProducts(products = [], normalizeGuidanceDiscoveryProductPdpContract) {
  return products.map((product) =>
    normalizeGuidanceDiscoveryProductPdpContract(product),
  );
}

function buildIngredientIntentExternalSeedRescueResponse({
  rescuedProducts = [],
  safeOffset = 0,
  safeLimit = 20,
  safePage = 1,
  guidanceOnlyDiscovery = false,
  normalizeGuidanceDiscoveryProductPdpContract,
  baseMetadata = {},
  ingredientIntentIds = [],
  diagnostics = {},
  ingredientIntentDetected = false,
  recallProfileDiagnostics = {},
  targetStepFamily = null,
} = {}) {
  const pagedRescuedProducts = rescuedProducts.slice(safeOffset, safeOffset + safeLimit);
  const returnedCount = Math.min(safeLimit, Math.max(0, rescuedProducts.length - safeOffset));
  return {
    status: 'success',
    success: true,
    products: guidanceOnlyDiscovery
      ? mapGuidanceProducts(
          pagedRescuedProducts,
          normalizeGuidanceDiscoveryProductPdpContract,
        )
      : pagedRescuedProducts,
    total: rescuedProducts.length,
    page: safePage,
    page_size: returnedCount,
    reply: null,
    metadata: {
      ...baseMetadata,
      ingredient_direct_main_path_status: 'direct_hit',
      query_source: 'agent_products_ingredient_external_seed_rescue',
      strict_empty_reason: null,
      ...(ingredientIntentIds.length > 0 ? { matched_ingredient_ids: ingredientIntentIds } : {}),
      ingredient_external_seed_rescue_attempted: true,
      ingredient_external_seed_rescue_recovered: true,
      products_returned_count: returnedCount,
      external_seed_returned_count: returnedCount,
      source_breakdown: {
        internal_count: 0,
        external_seed_count: returnedCount,
        stale_cache_used: false,
        strategy_applied: 'ingredient_registry_then_external_seed_rescue',
      },
      route_health: {
        ...(
          baseMetadata.route_health &&
          typeof baseMetadata.route_health === 'object' &&
          !Array.isArray(baseMetadata.route_health)
            ? baseMetadata.route_health
            : {}
        ),
        primary_path_used: 'ingredient_external_seed_rescue',
        fallback_triggered: false,
        fallback_reason: null,
        final_returned_count: returnedCount,
      },
      search_trace: {
        ...(
          baseMetadata.search_trace &&
          typeof baseMetadata.search_trace === 'object' &&
          !Array.isArray(baseMetadata.search_trace)
            ? baseMetadata.search_trace
            : {}
        ),
        final_decision: 'products_returned',
        primary_path_used: 'ingredient_external_seed_rescue',
      },
      search_decision: {
        final_decision: 'products_returned',
        primary_path_used: 'ingredient_external_seed_rescue',
        decision_authority: 'agent_products_ingredient_external_seed_rescue',
        decision_locked: true,
        decision_lock_reason: 'primary_authority',
        hit_quality: 'valid_hit',
        ingredient_intent_detected:
          diagnostics.ingredient_intent_detected === true || ingredientIntentDetected,
        ingredient_registry_match:
          recallProfileDiagnostics.registry_match === true ||
          diagnostics.ingredient_registry_match === true,
        ingredient_registry_source:
          diagnostics.ingredient_registry_source ||
          recallProfileDiagnostics.registry_source ||
          'none',
        ingredient_direct_miss_reason: null,
        kb_recall_attempted: diagnostics.kb_recall_attempted === true,
        attached_seed_recall_attempted: diagnostics.attached_seed_recall_attempted === true,
        products_cache_recall_attempted: diagnostics.products_cache_recall_attempted === true,
        family_fallback_used: diagnostics.family_fallback_used === true,
        clarify_applied_after_kb_exhausted: false,
        query_target_step_family: targetStepFamily || null,
      },
    },
  };
}

function buildIngredientIntentDirectEmptyResponse({
  safePage = 1,
  baseMetadata = {},
  ingredientIntentIds = [],
  diagnostics = {},
  ingredientIntentDetected = false,
  recallProfileDiagnostics = {},
  targetStepFamily = null,
} = {}) {
  return {
    status: 'success',
    success: true,
    products: [],
    total: 0,
    page: safePage,
    page_size: 0,
    reply: null,
    metadata: {
      ...baseMetadata,
      ingredient_direct_main_path_status: 'direct_empty_unrecovered',
      query_source: 'agent_products_ingredient_recall_direct_empty',
      matched_ingredient_ids: ingredientIntentIds,
      ingredient_external_seed_rescue_attempted: true,
      ingredient_external_seed_rescue_recovered: false,
      route_health: {
        ...(
          baseMetadata.route_health &&
          typeof baseMetadata.route_health === 'object' &&
          !Array.isArray(baseMetadata.route_health)
            ? baseMetadata.route_health
            : {}
        ),
        primary_path_used: 'ingredient_recall_direct_empty',
        fallback_triggered: false,
        fallback_reason: null,
        final_returned_count: 0,
      },
      search_trace: {
        ...(
          baseMetadata.search_trace &&
          typeof baseMetadata.search_trace === 'object' &&
          !Array.isArray(baseMetadata.search_trace)
            ? baseMetadata.search_trace
            : {}
        ),
        final_decision: 'strict_empty',
        primary_path_used: 'ingredient_recall_direct_empty',
      },
      search_decision: {
        final_decision: 'strict_empty',
        primary_path_used: 'ingredient_recall_direct_empty',
        decision_authority: 'agent_products_ingredient_recall_direct_empty',
        decision_locked: true,
        decision_lock_reason: 'strict_empty_contract',
        hit_quality: 'strict_empty',
        ingredient_intent_detected:
          diagnostics.ingredient_intent_detected === true || ingredientIntentDetected,
        ingredient_registry_match:
          recallProfileDiagnostics.registry_match === true ||
          diagnostics.ingredient_registry_match === true,
        ingredient_registry_source:
          diagnostics.ingredient_registry_source ||
          recallProfileDiagnostics.registry_source ||
          'none',
        ingredient_direct_miss_reason:
          diagnostics.ingredient_direct_miss_reason || 'no_explicit_sku_evidence',
        kb_recall_attempted: diagnostics.kb_recall_attempted === true,
        attached_seed_recall_attempted: diagnostics.attached_seed_recall_attempted === true,
        products_cache_recall_attempted: diagnostics.products_cache_recall_attempted === true,
        family_fallback_used: diagnostics.family_fallback_used === true,
        clarify_applied_after_kb_exhausted: false,
        query_target_step_family: targetStepFamily || null,
      },
    },
  };
}

function buildIngredientIntentDirectHitResponse({
  responseProducts = [],
  mergedRecalledProducts = [],
  safePage = 1,
  baseMetadata = {},
  ingredientIntentIds = [],
  diagnostics = {},
  ingredientIntentDetected = false,
  recallProfileDiagnostics = {},
  targetStepFamily = null,
} = {}) {
  return {
    status: 'success',
    success: true,
    products: responseProducts,
    total: mergedRecalledProducts.length,
    page: safePage,
    page_size: responseProducts.length,
    reply: null,
    metadata: {
      ...baseMetadata,
      ingredient_direct_main_path_status: 'direct_hit',
      query_source: 'agent_products_ingredient_recall_direct',
      strict_empty_reason: null,
      ...(ingredientIntentIds.length > 0 ? { matched_ingredient_ids: ingredientIntentIds } : {}),
      products_returned_count: responseProducts.length,
      external_seed_returned_count: responseProducts.length,
      route_health: {
        ...(
          baseMetadata.route_health &&
          typeof baseMetadata.route_health === 'object' &&
          !Array.isArray(baseMetadata.route_health)
            ? baseMetadata.route_health
            : {}
        ),
        primary_path_used: 'ingredient_recall_direct',
        fallback_triggered: false,
        fallback_reason: null,
        final_returned_count: responseProducts.length,
      },
      search_trace: {
        ...(
          baseMetadata.search_trace &&
          typeof baseMetadata.search_trace === 'object' &&
          !Array.isArray(baseMetadata.search_trace)
            ? baseMetadata.search_trace
            : {}
        ),
        final_decision: 'products_returned',
        primary_path_used: 'ingredient_recall_direct',
      },
      search_decision: {
        final_decision: 'products_returned',
        primary_path_used: 'ingredient_recall_direct',
        decision_authority: 'agent_products_ingredient_recall_direct',
        decision_locked: true,
        decision_lock_reason: 'primary_authority',
        hit_quality: responseProducts.length > 0 ? 'valid_hit' : 'strict_empty',
        ingredient_intent_detected:
          diagnostics.ingredient_intent_detected === true || ingredientIntentDetected,
        ingredient_registry_match:
          recallProfileDiagnostics.registry_match === true ||
          diagnostics.ingredient_registry_match === true,
        ingredient_registry_source:
          diagnostics.ingredient_registry_source ||
          recallProfileDiagnostics.registry_source ||
          'none',
        ingredient_direct_miss_reason: null,
        kb_recall_attempted: diagnostics.kb_recall_attempted === true,
        attached_seed_recall_attempted: diagnostics.attached_seed_recall_attempted === true,
        products_cache_recall_attempted: diagnostics.products_cache_recall_attempted === true,
        family_fallback_used: diagnostics.family_fallback_used === true,
        clarify_applied_after_kb_exhausted: false,
        query_target_step_family: targetStepFamily || null,
      },
    },
  };
}

module.exports = {
  buildIngredientIntentDirectBaseMetadata,
  shouldTreatIngredientDirectRecallAsMiss,
  buildIngredientIntentExternalSeedRescueResponse,
  buildIngredientIntentDirectEmptyResponse,
  buildIngredientIntentDirectHitResponse,
};
