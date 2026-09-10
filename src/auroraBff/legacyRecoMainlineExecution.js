const { selectRecoPriceCeilingTopUpRows } = require('./recoPriceCeiling');

// The direct lane = consumer POST /v1/reco/generate and the agent-door tool `recommend_products`.
// Both reach generateProductRecommendations with entryType 'direct'; the chat lane uses 'chat' and is
// deliberately untouched by the pre-LLM recall below.
function isPlainObjectValue(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Merge the warnings/missing_info of a DECLINED llm answer onto whatever replaced it.
// Deduped case-insensitively and bounded, appended after the replacement's own notes so the
// replacement still leads. Returns the input untouched when there was no decline, so every
// path that does not involve one is byte-identical.
function carryRecoDeclineNotes(structured, { declined = false, declinedAnswer = null } = {}) {
  if (!declined || !isPlainObjectValue(structured) || !isPlainObjectValue(declinedAnswer)) return structured;
  if (structured === declinedAnswer) return structured;
  const merge = (base, extra, cap) => {
    const seen = new Set();
    const out = [];
    for (const value of [...(Array.isArray(base) ? base : []), ...(Array.isArray(extra) ? extra : [])]) {
      const text = typeof value === 'string' ? value.trim() : '';
      if (!text) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(text);
      if (out.length >= cap) break;
    }
    return out;
  };
  const warnings = merge(structured.warnings, declinedAnswer.warnings, 8);
  const missingInfo = merge(structured.missing_info, declinedAnswer.missing_info, 8);
  if (!warnings.length && !missingInfo.length) return structured;
  return {
    ...structured,
    ...(warnings.length ? { warnings } : {}),
    ...(missingInfo.length ? { missing_info: missingInfo } : {}),
  };
}

// Did the model actually SAY why it returned nothing? A bare `{recommendations: []}` is not a
// refusal -- it is an empty answer, and on chat it is very likely a SUPPLY gap: the chat lane gets
// no pre-LLM recall (isDirectRecoEntryType below excludes it), so a chat model returning an empty
// list did so having been shown zero candidates. Treating that as a domain decision would empty a
// shortlist the catalog could legitimately have filled.
function hasStatedDeclineReason(structured) {
  // No isPlainObjectValue guard: the only caller already requires it one line above the call, so a
  // guard here is unfalsifiable -- the same shape that was removed from the recovery gate earlier
  // in this branch rather than left as a line no test can justify.
  for (const field of ['warnings', 'missing_info']) {
    const values = structured[field];
    // A BARE STRING COUNTS. Both templates ask for an array, but "missing_info": "..." is a common
    // model slip and nothing normalises before this read -- so the array-only version reproduced the
    // original defect (cleansers served) on exactly the turns where the model DID explain itself.
    if (typeof values === 'string' && values.trim()) return true;
    if (!Array.isArray(values)) continue;
    if (values.some((v) => typeof v === 'string' && v.trim())) return true;
  }
  return false;
}

function isDirectRecoEntryType(entryType) {
  const token = String(entryType || '').trim().toLowerCase();
  return token === 'direct' || token === 'agent_tool';
}

// Should a fluent LLM answer that grounded to ZERO products be replaced by the catalog answer?
//
// The mainline's own recovery gate fires only on a missing / schema_invalid / empty answer, so an
// invented-but-well-formed list of archetypes counts as success today. This is the missing trigger.
//
// It is deliberately a pure predicate: the caller performs at most ONE swap and re-derives the tail
// with structuredSource 'catalog_grounded', which the grounding pass ignores — so it cannot loop.
function shouldRecoverFullyUngroundedDirectAnswer({
  enabled = true,
  entryType = 'chat',
  structuredSource = null,
  groundingApplied = false,
  groundedCount = 0,
  answerRecommendationCount = 0,
  catalogRecommendationCount = 0,
} = {}) {
  if (enabled !== true) return false;
  if (!isDirectRecoEntryType(entryType)) return false;
  // Only an LLM-primary answer can be ungrounded in this sense; a catalog answer is grounded by
  // construction and swapping it for itself would be a no-op at best.
  if (structuredSource !== 'llm_primary') return false;
  if (groundingApplied !== true) return false;
  if (Number(groundedCount || 0) !== 0) return false;
  // An EMPTY answer is already handled by the mainline recovery gate; this trigger is specifically the
  // "non-empty but 100% ungrounded" case.
  if (Number(answerRecommendationCount || 0) <= 0) return false;
  // Nothing to swap in: keep the ungrounded answer rather than emptying the response.
  if (Number(catalogRecommendationCount || 0) <= 0) return false;
  return true;
}

/**
 * STRICT FILL. When the buyer set a price ceiling and the catalog can supply enough CONFORMING
 * products, every shortlist slot should hold one -- flagged near-misses only when conforming supply
 * is genuinely short.
 *
 * Live 2026-08-21 (PRICE_MAX=40): the shortlist came back The Ordinary $5.16 (conforming), Naturium
 * $19 (no catalog price at selection time, rescued later by the live price check) and OleHenriksen
 * $62 (a flagged violation). At selection the pool held ONE known-conforming candidate, so the
 * partition's slice took 1 conforming + 2 rest and the LLM kept all three -- while conforming stock
 * existed.
 *
 * This appends the lane's OWN catalog rows -- built by buildRecoGenerateFromCatalog from real catalog
 * fields, never invented prose -- for conforming products the answer does not already name. It is a
 * single bounded pass: nothing loops, nothing is removed, and an all-violating catalog appends
 * NOTHING rather than padding with filler.
 */
function applyStrictConformingTopUp({
  structured = null,
  catalogStructured = null,
  preLlmCatalogStructured = null,
  priceCeiling = null,
  shortlistTarget = 0,
  selectTopUpRows = selectRecoPriceCeilingTopUpRows,
} = {}) {
  const noop = { structured, appended: [], appendedCount: 0 };
  if (!isPlainObjectValue(structured) || !Array.isArray(structured.recommendations)) return noop;
  // AN EMPTY ANSWER HAS NO SLOTS TO FILL. This function fills the slots of a shortlist the model
  // produced; on an empty answer "shortfall = target - 0" turns it into a REPLACEMENT, and it
  // silently reinstated the exact defect the decline fix removes: measured by executing this helper
  // with a bronzer decline, three catalog cleansers and { limit: 40, currency: 'USD' }, it appended
  // all three. Only the agent bridge threads a priceCeiling and a shortlistTarget, so "a bronzer
  // under $40" would have come back as cleansers on the one door this was written for.
  if (structured.recommendations.length === 0) return noop;
  const catalogRows = [
    ...(isPlainObjectValue(catalogStructured) && Array.isArray(catalogStructured.recommendations)
      ? catalogStructured.recommendations
      : []),
    ...(isPlainObjectValue(preLlmCatalogStructured) && Array.isArray(preLlmCatalogStructured.recommendations)
      ? preLlmCatalogStructured.recommendations
      : []),
  ];
  if (!catalogRows.length) return noop;
  const appended = selectTopUpRows({
    recommendations: structured.recommendations,
    catalogRows,
    ceiling: priceCeiling,
    target: shortlistTarget,
  });
  if (!Array.isArray(appended) || appended.length === 0) return noop;
  // STAMP WHAT THESE ROWS ARE. The key is namespaced because it is a SERVER assertion on a row that
  // may otherwise be model-authored: every transform on this lane is a `{...row}` spread, so a plain
  // `score_basis` emitted by the model would arrive at the signal builder and be read as
  // authoritative — letting a model hand itself back the band this PR exists to withhold. Verified:
  // a row carrying `score_basis: 'model_self_report'` banded `high` inside an answer the server had
  // derived as positional. Namespacing removes the realistic vector; the principled fix is a strip
  // at the mapper boundary, the shape stripRecoPlanPriceCarryingFields already uses for price, and
  // that is filed rather than done here. They come from the catalog, carrying `95 - 3*index` as their score —
  // a POSITION, not a judgement about the item. The answer they are appended to keeps
  // structuredSource 'llm_primary', so an answer-level confidence basis would call them the model's
  // own estimate and band them `high`, above the model's actual pick. Per-row, because this is the
  // only place that knows which rows were filler.
  const stamped = appended.map((row) => (
    row && typeof row === 'object' && !Array.isArray(row)
      ? { ...row, __pivota_score_basis: 'positional' }
      : row
  ));
  return {
    structured: {
      ...structured,
      recommendations: [...structured.recommendations, ...stamped],
    },
    appended: stamped,
    appendedCount: stamped.length,
  };
}

function createLegacyRecoMainlineExecutionRuntime(deps = {}) {
  const {
    pickFirstTrimmed,
    isPlainObject,
    finalizeConcernFrameworkCandidatePools,
    finalizeRecommendationCandidatePools,
    buildRecoGenerateFromCatalog,
    deriveRecoPdpFastFallbackReasonCode,
    buildRecoLlmPromptState,
    runRecoLlmPrimary,
    resolveConcernMainlineFailure,
    resolveRecoEffectiveFailure,
    normalizeRecoFailureClass,
    hasEmptyStructuredRecommendations,
    shouldUseRecoCatalogTransientFallback,
    buildRecoCatalogTransientFallbackStructured,
    recordAuroraRecoLlmCall,
  } = deps;

  async function runLegacyRecoMainlineExecution({
    concernSemanticPlanBlockedReason = '',
    concernSemanticPlanBlockedTelemetryReason = '',
    concernSemanticPlanBlockedFailureClass = '',
    concernSemanticPlanBlockedFailureOrigin = 'none',
    frameworkCatalogFirstEnabled = false,
    deterministicCatalogFirstEnabled = false,
    targetContext = null,
    recommendationTaskContext = null,
    profileSummary = null,
    normalizedIngredientContext = null,
    catalogExternalSeedStrategy = '',
    debug = false,
    logger,
    ctx,
    entryType = 'chat',
    userAsk = '',
    prefix = '',
    recentLogs = [],
    globalStatus = {},
    mainlineStageTimingsMs = {},
    // '' (chat, consumer /v1/reco/generate) keeps the skincare-bounded template; 'beauty' selects the
    // wider one for the agent door only (#2155). Threaded rather than inferred from entryType: the
    // consumer direct lane shares entryType 'direct' with the tool and must NOT widen.
    promptDomainScope = '',
    RECO_MAIN_PROMPT_TEMPLATE_ID = 'reco_main_v1_2',
    RECO_PDP_FAST_EXTERNAL_FALLBACK_ENABLED = false,
    RECO_DIRECT_RECALL_BEFORE_LLM_ENABLED = true,
    RECO_DIRECT_RECALL_BEFORE_LLM_MAX_QUERIES = 3,
    priceCeiling = null,
  } = {}) {
    let upstream = null;
    let contextMeta = {};
    let upstreamFailureCode = '';
    let llmFailureClass = '';
    let llmLatencyMs = null;
    let catalogStructured = null;
    let catalogCandidatePool = [];
    let catalogCandidateState = null;
    let catalogDebug = null;
    let pdpFastFallbackReasonCode = null;
    let pdpFastExternalFallbackReasonCode = null;
    let catalogTransientFallbackStructured = null;

    let answerJson = null;
    let structured = null;
    let structuredSource = null;
    let llmStructured = null;
    let llmStructuredSource = null;
    let promptBundle = {
      prompt_spec: {
        template_id: RECO_MAIN_PROMPT_TEMPLATE_ID,
        llm_mode: null,
      },
      schema_chars: 0,
    };
    let query = '';
    let promptContract = { ok: true, issues: [] };
    let llmTrace = null;
    let llmInvoked = false;
    let initialLlmOutcome = 'not_invoked';
    let presentationMode = 'full_llm';
    let nonBlockingLlmIssue = 'none';
    let successMode = 'full_success';
    let effectiveFailureClass = 'none';
    let failureOrigin = 'none';
    let preLlmSelectedCandidateCount = null;
    let finalSelectedCandidateCount = null;
    // Branch-B pre-LLM recall result, kept separate from `catalogStructured` so the LLM-success path
    // keeps reporting exactly what it reports today. It is the recovery source when the LLM answer is
    // missing/schema-invalid/empty, AND the recovery source for a fluent-but-fully-ungrounded answer
    // (see legacyRecoGenerationEngine).
    let preLlmCatalogStructured = null;
    let preLlmCatalogCandidateState = null;
    let preLlmCatalogDebug = null;
    let directRecallBeforeLlmApplied = false;

    if (concernSemanticPlanBlockedReason) {
      structured = {
        recommendations: [],
        products_empty_reason: concernSemanticPlanBlockedReason,
        telemetry_reason: concernSemanticPlanBlockedTelemetryReason || null,
        mainline_status: 'severe_parse_or_prompt_failure',
      };
      structuredSource = null;
      llmFailureClass = 'planner_untrusted';
      initialLlmOutcome = concernSemanticPlanBlockedReason;
      presentationMode = '';
      successMode = '';
      effectiveFailureClass =
        concernSemanticPlanBlockedFailureClass || 'planner_untrusted';
      failureOrigin =
        concernSemanticPlanBlockedFailureOrigin || 'internal_contract';
      catalogCandidateState = frameworkCatalogFirstEnabled
        ? finalizeConcernFrameworkCandidatePools([], { targetContext })
        : finalizeRecommendationCandidatePools([], {
            targetContext,
            recoContext: recommendationTaskContext,
            priceCeiling,
          });
      catalogDebug = {
        recall_plan_version:
          pickFirstTrimmed(
            targetContext?.semantic_plan_version,
            null,
          ) || null,
        executed_query_count: 0,
        executed_upstream_attempt_count: 0,
        actual_http_attempt_count: 0,
        stage_timeout_counts: {},
        primary_stage_timeout_class:
          concernSemanticPlanBlockedTelemetryReason === 'planner_timeout'
            ? 'planner_timeout'
            : 'planner_untrusted',
        transport_policy_mode: null,
        candidate_drop_stage: concernSemanticPlanBlockedReason,
        selected_source_counts: {},
        external_seed_used_count: 0,
      };
    } else if (deterministicCatalogFirstEnabled) {
      const catalogRecallStartedAt = Date.now();
      const catalogOut = await buildRecoGenerateFromCatalog({
        ctx,
        profileSummary,
        ingredientContext: normalizedIngredientContext,
        recommendationTaskContext,
        targetContext,
        externalSeedStrategyOverride: catalogExternalSeedStrategy,
        allowStepAwareAdjacentFamilyFallback: String(entryType || '').trim().toLowerCase() === 'chat',
        priceCeiling,
        debug,
        logger,
      });
      mainlineStageTimingsMs.catalog_recall = Math.max(
        0,
        Date.now() - catalogRecallStartedAt,
      );
      catalogStructured =
        catalogOut &&
        typeof catalogOut === 'object' &&
        catalogOut.structured &&
        typeof catalogOut.structured === 'object'
          ? catalogOut.structured
          : null;
      catalogCandidatePool =
        catalogOut &&
        typeof catalogOut === 'object' &&
        Array.isArray(catalogOut.candidate_pool)
          ? catalogOut.candidate_pool
          : [];
      catalogCandidateState =
        catalogOut &&
        typeof catalogOut === 'object' &&
        catalogOut.candidate_pool_state &&
        typeof catalogOut.candidate_pool_state === 'object'
          ? catalogOut.candidate_pool_state
          : finalizeRecommendationCandidatePools([], {
              targetContext,
              recoContext: recommendationTaskContext,
              priceCeiling,
            });
      catalogDebug =
        catalogOut &&
        typeof catalogOut === 'object' &&
        catalogOut.debug &&
        typeof catalogOut.debug === 'object'
          ? catalogOut.debug
          : null;
      pdpFastFallbackReasonCode =
        deriveRecoPdpFastFallbackReasonCode(catalogDebug);
      pdpFastExternalFallbackReasonCode =
        RECO_PDP_FAST_EXTERNAL_FALLBACK_ENABLED
          ? pdpFastFallbackReasonCode
          : null;

      const promptState = buildRecoLlmPromptState({
        prefix,
        profileSummary,
        recentLogs,
        requestText: userAsk,
        lang: ctx.lang,
        globalStatus,
        ingredientContext: normalizedIngredientContext,
        candidates: catalogCandidatePool,
        promptDomainScope,
      });
      promptBundle = promptState.promptBundle;
      query = promptState.query;
      promptContract = promptState.promptContract;
      llmTrace = {
        ...promptState.llmTraceSeed,
        latency_ms: null,
        cache_hit: false,
        prompt_contract_ok: promptState.promptContract.ok,
        ...(promptState.promptContract.ok
          ? {}
          : {
              prompt_contract_issues:
                promptState.promptContract.issues.slice(0, 6),
            }),
      };

      preLlmSelectedCandidateCount = Number.isFinite(
        Number(catalogCandidateState?.pre_llm_selected_candidate_count),
      )
        ? Math.max(
            0,
            Math.trunc(
              Number(catalogCandidateState.pre_llm_selected_candidate_count),
            ),
          )
        : Number.isFinite(Number(catalogCandidateState?.selected_candidate_count))
          ? Math.max(
              0,
              Math.trunc(Number(catalogCandidateState.selected_candidate_count)),
            )
          : 0;
      finalSelectedCandidateCount = preLlmSelectedCandidateCount;
      structured = catalogStructured;
      structuredSource = catalogStructured ? 'catalog_grounded' : null;

      if (
        preLlmSelectedCandidateCount > 0 &&
        catalogCandidateState?.terminal_success === true &&
        !frameworkCatalogFirstEnabled
      ) {
        const llmPrimary = await runRecoLlmPrimary({
          ctx,
          logger,
          promptState,
          profileSummary,
        });
        upstream = llmPrimary.upstream;
        contextMeta = llmPrimary.contextMeta;
        upstreamFailureCode = llmPrimary.upstreamFailureCode;
        llmFailureClass = llmPrimary.llmFailureClass;
        llmLatencyMs = llmPrimary.llmLatencyMs;
        answerJson = llmPrimary.answerJson;
        llmStructured = llmPrimary.llmStructured;
        llmStructuredSource = llmPrimary.llmStructuredSource;
        llmTrace = llmPrimary.llmTrace;
        llmInvoked = llmPrimary.llmInvoked;
        initialLlmOutcome = llmPrimary.initialLlmOutcome;
        if (initialLlmOutcome === 'success') {
          presentationMode = 'full_llm';
          successMode = 'full_success';
        } else {
          presentationMode = 'deterministic_degraded';
          successMode = 'degraded_success';
          nonBlockingLlmIssue =
            String(initialLlmOutcome || '').trim().toLowerCase() ||
            'empty_structured';
          llmFailureClass = '';
        }
      } else {
        presentationMode = '';
        successMode = '';
      }
      const failureSignals = frameworkCatalogFirstEnabled
        ? resolveConcernMainlineFailure({
            plannerBlocked: false,
            viablePoolState: catalogCandidateState,
            catalogDebug,
          })
        : resolveRecoEffectiveFailure({
            targetContext,
            viablePoolState: catalogCandidateState,
            catalogDebug,
          });
      effectiveFailureClass =
        failureSignals.effective_failure_class || 'none';
      failureOrigin = failureSignals.failure_origin || 'none';
    } else {
      // Recall BEFORE the LLM on the direct lane.
      //
      // Without this the LLM is asked to recommend products with `candidates: []` (catalogCandidatePool
      // is still the initial empty array here), and catalog recovery below only runs when the answer is
      // missing/schema-invalid/empty — so a fluent, entirely invented answer SUPPRESSES recall and the
      // caller gets archetypes with no product_id and no price. Bounded: one call, need-seeded queries,
      // the existing per-query timeouts, and the fail-fast circuit still short-circuits inside
      // buildRecoGenerateFromCatalog. The chat lane is untouched.
      const directRecallBeforeLlm =
        RECO_DIRECT_RECALL_BEFORE_LLM_ENABLED === true && isDirectRecoEntryType(entryType);
      if (directRecallBeforeLlm) {
        const preLlmRecallStartedAt = Date.now();
        const preLlmCatalogOut = await buildRecoGenerateFromCatalog({
          ctx,
          profileSummary,
          ingredientContext: normalizedIngredientContext,
          recommendationTaskContext,
          targetContext,
          externalSeedStrategyOverride: catalogExternalSeedStrategy,
          allowStepAwareAdjacentFamilyFallback: false,
          needSeedText: userAsk,
          maxGenericQueries: RECO_DIRECT_RECALL_BEFORE_LLM_MAX_QUERIES,
          priceCeiling,
          debug,
          logger,
        });
        mainlineStageTimingsMs.catalog_recall = Math.max(
          Number(mainlineStageTimingsMs.catalog_recall || 0),
          Math.max(0, Date.now() - preLlmRecallStartedAt),
        );
        directRecallBeforeLlmApplied = true;
        preLlmCatalogStructured =
          preLlmCatalogOut &&
          typeof preLlmCatalogOut === 'object' &&
          preLlmCatalogOut.structured &&
          typeof preLlmCatalogOut.structured === 'object'
            ? preLlmCatalogOut.structured
            : null;
        preLlmCatalogCandidateState =
          preLlmCatalogOut &&
          typeof preLlmCatalogOut === 'object' &&
          preLlmCatalogOut.candidate_pool_state &&
          typeof preLlmCatalogOut.candidate_pool_state === 'object'
            ? preLlmCatalogOut.candidate_pool_state
            : null;
        preLlmCatalogDebug =
          preLlmCatalogOut &&
          typeof preLlmCatalogOut === 'object' &&
          preLlmCatalogOut.debug &&
          typeof preLlmCatalogOut.debug === 'object'
            ? preLlmCatalogOut.debug
            : null;
        catalogCandidatePool =
          preLlmCatalogOut &&
          typeof preLlmCatalogOut === 'object' &&
          Array.isArray(preLlmCatalogOut.candidate_pool)
            ? preLlmCatalogOut.candidate_pool
            : [];
      }
      const promptState = buildRecoLlmPromptState({
        prefix,
        profileSummary,
        recentLogs,
        requestText: userAsk,
        lang: ctx.lang,
        globalStatus,
        ingredientContext: normalizedIngredientContext,
        candidates: catalogCandidatePool,
        promptDomainScope,
      });
      promptBundle = promptState.promptBundle;
      query = promptState.query;
      promptContract = promptState.promptContract;
      const llmPrimary = await runRecoLlmPrimary({
        ctx,
        logger,
        promptState,
        profileSummary,
      });
      upstream = llmPrimary.upstream;
      contextMeta = llmPrimary.contextMeta;
      upstreamFailureCode = llmPrimary.upstreamFailureCode;
      llmFailureClass = llmPrimary.llmFailureClass;
      llmLatencyMs = llmPrimary.llmLatencyMs;
      answerJson = llmPrimary.answerJson;
      llmStructured = llmPrimary.llmStructured;
      llmStructuredSource = llmPrimary.llmStructuredSource;
      llmTrace = llmPrimary.llmTrace;
      llmInvoked = llmPrimary.llmInvoked;
      initialLlmOutcome = llmPrimary.initialLlmOutcome;
      const normalizedNonStepAwareLlmFailure = normalizeRecoFailureClass(
        llmFailureClass || '',
      );
      const llmStructuredRecoEmpty =
        hasEmptyStructuredRecommendations(llmStructured);
      const shouldAttemptCatalogRecovery =
        !llmStructured ||
        normalizedNonStepAwareLlmFailure === 'schema_invalid' ||
        llmStructuredRecoEmpty;
      const shouldAllowCatalogTransientFallback =
        !llmStructured || llmStructuredRecoEmpty;
      if (shouldAttemptCatalogRecovery) {
        const catalogRecoveryStartedAt = Date.now();
        // When the direct lane already ran recall before the LLM, that call used the same arguments
        // (plus the need seed) — re-running it would double the upstream cost for the same answer.
        const catalogOut = directRecallBeforeLlmApplied
          ? {
              structured: preLlmCatalogStructured,
              candidate_pool: catalogCandidatePool,
              candidate_pool_state: preLlmCatalogCandidateState,
              debug: preLlmCatalogDebug,
            }
          : await buildRecoGenerateFromCatalog({
              ctx,
              profileSummary,
              ingredientContext: normalizedIngredientContext,
              recommendationTaskContext,
              targetContext,
              externalSeedStrategyOverride: catalogExternalSeedStrategy,
              allowStepAwareAdjacentFamilyFallback: String(entryType || '').trim().toLowerCase() === 'chat',
              priceCeiling,
              debug,
              logger,
            });
        mainlineStageTimingsMs.catalog_recall = Math.max(
          Number(mainlineStageTimingsMs.catalog_recall || 0),
          Math.max(0, Date.now() - catalogRecoveryStartedAt),
        );
        catalogStructured =
          catalogOut &&
          typeof catalogOut === 'object' &&
          catalogOut.structured &&
          typeof catalogOut.structured === 'object'
            ? catalogOut.structured
            : null;
        catalogCandidatePool =
          catalogOut &&
          typeof catalogOut === 'object' &&
          Array.isArray(catalogOut.candidate_pool)
            ? catalogOut.candidate_pool
            : [];
        catalogCandidateState =
          catalogOut &&
          typeof catalogOut === 'object' &&
          catalogOut.candidate_pool_state &&
          typeof catalogOut.candidate_pool_state === 'object'
            ? catalogOut.candidate_pool_state
            : null;
        catalogDebug =
          catalogOut &&
          typeof catalogOut === 'object' &&
          catalogOut.debug &&
          typeof catalogOut.debug === 'object'
            ? catalogOut.debug
            : null;
        pdpFastFallbackReasonCode =
          deriveRecoPdpFastFallbackReasonCode(catalogDebug);
        pdpFastExternalFallbackReasonCode =
          RECO_PDP_FAST_EXTERNAL_FALLBACK_ENABLED
            ? pdpFastFallbackReasonCode
            : null;
        const useCatalogTransientFallback =
          shouldAllowCatalogTransientFallback &&
          shouldUseRecoCatalogTransientFallback(catalogDebug);
        catalogTransientFallbackStructured =
          useCatalogTransientFallback &&
          !(targetContext && targetContext.step_aware_intent)
            ? buildRecoCatalogTransientFallbackStructured({ ctx })
            : null;
      }
      // CARRY THE DECLINE. When the model returns a well-formed answer with NO
      // recommendations, that is a decision, and its warnings/missing_info are the only
      // account of WHY — "makeup items such as bronzers are outside the skincare domain
      // boundary" is the lane's own words. Replacing the answer wholesale with the catalog
      // list threw that away, so the better the prompt got at declining, the more often a
      // buyer received an unexplained off-category shortlist instead of a reasoned refusal.
      //
      // Only a DECLINE carries, and "decline" needs BOTH halves.
      //
      // llmStructuredRecoEmpty says the object has an empty recommendations ARRAY. It does not say
      // the MODEL produced that object. When the upstream answers 200 with a routine and no reco
      // JSON, llmStructured is mapAuroraRoutineToRecoGenerate's output, and that mapper SYNTHESIZES
      // missing_info from our own logic — 'routine_missing', 'budget_unknown', 'over_budget'. Those
      // satisfy the empty-array test, and normalize.js promotes 'routine_missing' into the
      // user-visible warnings. Without the source check this shipped a warning WE invented on a
      // perfectly healthy catalog answer, presented as the model's account of a refusal — the exact
      // fabrication this carry exists to avoid, arriving through the door it did not guard.
      //
      // 'llm_answer_json' is the only source that is the model's own words about recommending.
      // ONLY WHERE THE DECLINE IS A CONTRACT. reco_main_v1_3 -- the widened template, asked for by
      // the agent bridge alone (promptDomainScope 'beauty') -- instructs the model to answer an
      // off-category request with `recommendations: []` and the reason in missing_info. On that
      // template an empty answer with a reason IS a refusal.
      //
      // reco_main_v1_2, which chat and the consumer lane run, contains no such instruction. There an
      // empty list with `missing_info: ['Skin type']` is the model saying it lacks PROFILE data --
      // both templates forbid clarifying questions, so an empty answer is the only channel it has --
      // and honouring that as a refusal would empty a shortlist the catalog was right to fill.
      // Nothing in the notes can tell a refusal from a clarification, so the template that defines
      // the contract is the gate.
      const wideRecoTemplateInPlay =
        typeof promptDomainScope === 'string'
        && promptDomainScope.trim().toLowerCase() === 'beauty';
      const llmDeclinedInItsOwnWords =
        wideRecoTemplateInPlay
        && llmStructuredSource === 'llm_answer_json'
        && Boolean(llmStructuredRecoEmpty)
        && isPlainObjectValue(llmStructured)
        // ...AND the model gave a reason. The carry below exists because "its warnings/missing_info
        // are the only account of WHY"; with neither there is no account, and nothing to honour.
        && hasStatedDeclineReason(llmStructured);
      // A DECLINE IS NOT A GAP. Hoisted above the recovery gate below, because that gate treated
      // `llmStructuredRecoEmpty` as a FAILURE to be repaired from the catalog -- and a decline is
      // the model succeeding. Measured in prod 2026-09-10 on the agent door: a bronzer ask returned
      // three CLEANSERS with the model's own refusal ("Per category fidelity rules, we do not
      // substitute skincare for a makeup request") pasted onto them as missing_info. The prompt fix
      // worked and this gate reversed it, every time recall had anything at all to offer.
      // NOTE: deliberately NOT gated on llmDeclinedInItsOwnWords. Both readers of this flag check
      // the decline first, so a guard here is unfalsifiable -- a mutant removing it leaves every
      // test green. The decline is handled where the flag is USED, below.
      const catalogRecoveredFromLlmGap =
        (normalizedNonStepAwareLlmFailure === 'schema_invalid' ||
          llmStructuredRecoEmpty) &&
        catalogStructured &&
        Array.isArray(catalogStructured.recommendations) &&
        catalogStructured.recommendations.length > 0;
      const structuredBeforeDeclineCarry = llmDeclinedInItsOwnWords
        ? llmStructured
        : catalogRecoveredFromLlmGap
        ? catalogStructured
        : llmStructuredRecoEmpty
          ? (
              catalogStructured ||
              catalogTransientFallbackStructured ||
              llmStructured
            )
          : llmStructured ||
            catalogStructured ||
            catalogTransientFallbackStructured;
      structured = carryRecoDeclineNotes(structuredBeforeDeclineCarry, {
        declined: llmDeclinedInItsOwnWords,
        declinedAnswer: llmStructured,
      });
      structuredSource = llmDeclinedInItsOwnWords
        ? 'llm_primary'
        : catalogRecoveredFromLlmGap
        ? 'catalog_grounded'
        : llmStructuredRecoEmpty
          ? (
              catalogStructured
                ? 'catalog_grounded'
                : catalogTransientFallbackStructured
                  ? 'catalog_transient_fallback'
                  : llmStructured
                    ? 'llm_primary'
                    : null
            )
          : llmStructured
            ? 'llm_primary'
            : catalogStructured
              ? 'catalog_grounded'
              : catalogTransientFallbackStructured
                ? 'catalog_transient_fallback'
                : null;
      if (
        !llmDeclinedInItsOwnWords &&
        !deterministicCatalogFirstEnabled &&
        promptContract.ok &&
        catalogStructured &&
        Array.isArray(catalogStructured.recommendations) &&
        catalogStructured.recommendations.length > 0 &&
        (!llmStructured ||
          normalizedNonStepAwareLlmFailure === 'schema_invalid' ||
          llmStructuredRecoEmpty)
      ) {
        if (
          (llmFailureClass === 'empty_structured' ||
            llmFailureClass === 'schema_invalid') &&
          isPlainObject(llmTrace)
        ) {
          const { error_class: _ignoredErrorClass, ...nextTrace } = llmTrace;
          llmTrace = nextTrace;
        }
        if (normalizedNonStepAwareLlmFailure === 'schema_invalid') {
          initialLlmOutcome = 'catalog_recovered_schema_invalid';
        } else if (llmStructuredRecoEmpty) {
          initialLlmOutcome = 'catalog_recovered_empty_structured';
        }
        llmFailureClass = '';
        recordAuroraRecoLlmCall({
          stage: 'main',
          outcome: 'catalog_grounded_primary',
        });
      }
    }

    return {
      upstream,
      contextMeta,
      upstreamFailureCode,
      llmFailureClass,
      llmLatencyMs,
      catalogStructured,
      catalogCandidatePool,
      catalogCandidateState,
      catalogDebug,
      preLlmCatalogStructured,
      preLlmCatalogCandidateState,
      preLlmCatalogDebug,
      directRecallBeforeLlmApplied,
      pdpFastFallbackReasonCode,
      pdpFastExternalFallbackReasonCode,
      catalogTransientFallbackStructured,
      answerJson,
      structured,
      structuredSource,
      llmStructured,
      llmStructuredSource,
      promptBundle,
      query,
      promptContract,
      llmTrace,
      llmInvoked,
      initialLlmOutcome,
      presentationMode,
      nonBlockingLlmIssue,
      successMode,
      effectiveFailureClass,
      failureOrigin,
      preLlmSelectedCandidateCount,
      finalSelectedCandidateCount,
      mainlineStageTimingsMs,
    };
  }

  return {
    runLegacyRecoMainlineExecution,
  };
}

module.exports = {
  carryRecoDeclineNotes,
  createLegacyRecoMainlineExecutionRuntime,
  applyStrictConformingTopUp,
  isDirectRecoEntryType,
  shouldRecoverFullyUngroundedDirectAnswer,
};
