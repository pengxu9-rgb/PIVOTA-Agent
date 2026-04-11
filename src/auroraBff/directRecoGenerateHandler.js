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

function coerceBoolean(value) {
  if (typeof value === 'boolean') return value;
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return false;
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return Boolean(value);
}

function buildDirectRecoDebugPayload({
  upstreamDebug = null,
  envelope = null,
  recoPayload = null,
  recoContract = null,
} = {}) {
  const topMeta = isPlainObject(envelope?.meta) ? envelope.meta : null;
  const analysisMeta = isPlainObject(envelope?.analysis_meta) ? envelope.analysis_meta : null;
  const next = isPlainObject(upstreamDebug) ? { ...upstreamDebug } : {};

  if (isPlainObject(topMeta?.canonical_ownership)) {
    next.canonical_ownership = topMeta.canonical_ownership;
  }
  if (isPlainObject(topMeta?.quality_contract)) {
    next.quality_contract = topMeta.quality_contract;
  }
  if (isPlainObject(analysisMeta) && Object.keys(analysisMeta).length > 0) {
    next.analysis_meta = analysisMeta;
  }
  if (isPlainObject(recoPayload?.recommendation_meta)) {
    next.recommendation_meta = recoPayload.recommendation_meta;
  }
  if (isPlainObject(recoContract)) {
    next.reco_contract = recoContract;
  }

  return Object.keys(next).length > 0 ? next : null;
}

function createDirectRecoGenerateHandlerRuntime(deps = {}) {
  const {
    buildRequestContext,
    requireAuroraUid,
    RecoGenerateRequestSchema,
    buildEnvelope,
    makeAssistantMessage,
    makeEvent,
    resolveIdentity,
    getProfileForIdentity,
    getRecentSkinLogsForIdentity,
    extractAnalysisProfileContextOverlay,
    extractProfilePatchFromSession,
    extractProfilePatchFromRequestContextPayload,
    loadLatestDiagnosisArtifactForRoute,
    buildAnalysisContextSnapshotForRoute,
    buildTaskAnalysisContextForPrefix,
    summarizeProfileForContext,
    extractLatestRecoContextFromSession,
    buildAutoAnchoredRecoRequestText,
    buildRecoGenerateUserAsk,
    resolveRecommendationTargetContext,
    mergeIngredientRecoContextValue,
    shouldDiagnosisGate,
    buildDiagnosisPrompt,
    buildDiagnosisChips,
    buildConfidenceNoticeCardPayload,
    generateProductRecommendations,
    normalizeRecoGenerate,
    buildRecoMainlineContract,
    extractRecoOutcomeContractArgsFromPayload,
    enrichRecommendationsWithAlternatives,
    mergeFieldMissing,
    AURORA_PRODUCT_MATCHER_ENABLED,
    AURORA_PRODUCT_MATCHER_BUNDLED_SEED_FALLBACK_ENABLED,
    buildIngredientPlan,
    DIAG_PRODUCT_CATALOG_PATH,
    buildProductRecommendationsBundle,
    toLegacyRecommendationsPayload,
    buildRecoLlmTraceRef,
    buildRecoSuccessFollowupChips,
    buildRecoEntryChips,
    deriveRecommendationContextState,
    buildTaskAnalysisContextUsageMeta,
    REQUEST_CONTEXT_SIGNATURE_VERSION,
    DIRECT_RECO_CANDIDATE_POOL_SIGNATURE_VERSION,
    applyRecoContentSpineToPayload,
    applyRecoContractToRecoRequestedEvents,
    buildRecoRequestedEventData,
    deriveRecoEmptyReason,
    AURORA_RECO_GENERATE_GUARDRAIL_V1,
    applyBeautyCanonicalOwnershipToEnvelope,
    applyRecommendationOutputGuardrailsForRoute,
    persistRejectedCatalogCandidates,
    normalizeRecoGroundingStatus,
    attachRecoContractMeta,
    restorePlanOnlyRecommendations,
    logger,
  } = deps;

  function buildBadRequestEnvelope(ctx, details) {
    return buildEnvelope(ctx, {
      assistant_message: makeAssistantMessage('Invalid request.'),
      suggested_chips: [],
      cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', details } }],
      session_patch: {},
      events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
    });
  }

  function buildFailureEnvelope(ctx, errorCode) {
    return buildEnvelope(ctx, {
      assistant_message: makeAssistantMessage('Failed to generate recommendations.'),
      suggested_chips: [],
      cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: errorCode } }],
      session_patch: {},
      events: [makeEvent(ctx, 'error', { code: errorCode })],
    });
  }

  function finalizeDirectRecoEnvelope({
    envelope,
    includeDebug = false,
    upstreamDebug = null,
    recoPayload = null,
    recoContract = null,
    route = 'reco_generate',
    assistantText = '',
    policyMeta = null,
    profile = null,
  } = {}) {
    const finalized = applyBeautyCanonicalOwnershipToEnvelope({
      envelope,
      route,
      assistantText,
      policyMeta,
      profile,
    });
    if (!includeDebug) return finalized;
    const debugPayload = buildDirectRecoDebugPayload({
      upstreamDebug,
      envelope: finalized,
      recoPayload,
      recoContract,
    });
    if (!isPlainObject(debugPayload)) return finalized;
    return {
      ...finalized,
      debug: debugPayload,
    };
  }

  async function handleDirectRecoGenerateRoute(req, res) {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = RecoGenerateRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json(buildBadRequestEnvelope(ctx, parsed.error.format()));
      }
      const debugHeaderRaw = req.get('X-Debug') ?? req.get('X-Aurora-Debug');
      const includeDebugFromHeader = debugHeaderRaw == null || debugHeaderRaw === '' ? null : coerceBoolean(debugHeaderRaw);
      const includeDebug = includeDebugFromHeader == null ? Boolean(parsed.data.include_debug) : includeDebugFromHeader;

      const identity = await resolveIdentity(req, ctx);
      const storedProfile = await getProfileForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId }).catch(() => null);
      const recentLogs = await getRecentSkinLogsForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId }, 7).catch(() => []);
      const requestProfileOverlay = extractAnalysisProfileContextOverlay(
        extractProfilePatchFromSession(parsed.data.session),
        extractProfilePatchFromRequestContextPayload(req.body || {}),
      );
      const requestProfileOverlayKeys =
        requestProfileOverlay && typeof requestProfileOverlay === 'object'
          ? Object.keys(requestProfileOverlay).sort()
          : [];
      const requestProfileContextSource = requestProfileOverlayKeys.length ? 'request_overlay_applied' : 'db_only_profile';
      const latestArtifact = await loadLatestDiagnosisArtifactForRoute({
        identity,
        session:
          parsed.data.session && typeof parsed.data.session === 'object' && !Array.isArray(parsed.data.session)
            ? parsed.data.session
            : null,
        ctx,
        logger,
      });
      const analysisContextSnapshot = buildAnalysisContextSnapshotForRoute({
        latestArtifact,
        profile: storedProfile,
        recentLogs,
      });
      const recommendationAnalysisTaskContext = buildTaskAnalysisContextForPrefix({
        task: 'recommendation',
        snapshot: analysisContextSnapshot,
        profile: storedProfile,
        requestOverride: requestProfileOverlay,
        recentLogs,
      });
      const profile =
        requestProfileOverlay && typeof requestProfileOverlay === 'object'
          ? { ...(storedProfile && typeof storedProfile === 'object' && !Array.isArray(storedProfile) ? storedProfile : {}), ...requestProfileOverlay }
          : storedProfile;
      const profileSummary = summarizeProfileForContext(profile);
      const latestRecoContextFromSession = extractLatestRecoContextFromSession(parsed.data.session);
      const derivedDirectRecoContext = latestRecoContextFromSession || null;
      const effectiveDirectFocus = pickFirstTrimmed(
        parsed.data.focus,
        derivedDirectRecoContext && derivedDirectRecoContext.resolved_target_step,
      );
      const requestText = !pickFirstTrimmed(parsed.data.focus) && derivedDirectRecoContext
        ? buildAutoAnchoredRecoRequestText({
          rawMessage: '',
          recoContext: derivedDirectRecoContext,
          language: ctx.lang,
        })
        : buildRecoGenerateUserAsk({
          focus: effectiveDirectFocus,
          constraints: parsed.data.constraints || {},
          lang: ctx.lang,
        });
      const directRecoTargetContext = resolveRecommendationTargetContext({
        explicitStep: effectiveDirectFocus,
        focus: pickFirstTrimmed(
          effectiveDirectFocus,
          derivedDirectRecoContext && derivedDirectRecoContext.ingredient_query,
          derivedDirectRecoContext && derivedDirectRecoContext.goal,
        ),
        text: requestText,
        entryType: 'direct',
      });
      const directRecoSpineContext = mergeIngredientRecoContextValue(derivedDirectRecoContext, {
        query: pickFirstTrimmed(
          derivedDirectRecoContext && derivedDirectRecoContext.ingredient_query,
          derivedDirectRecoContext && derivedDirectRecoContext.query,
          effectiveDirectFocus,
        ),
        goal: pickFirstTrimmed(derivedDirectRecoContext && derivedDirectRecoContext.goal),
        target_step: pickFirstTrimmed(
          directRecoTargetContext && directRecoTargetContext.resolved_target_step,
          derivedDirectRecoContext && derivedDirectRecoContext.resolved_target_step,
        ),
        resolved_target_step: pickFirstTrimmed(
          directRecoTargetContext && directRecoTargetContext.resolved_target_step,
          derivedDirectRecoContext && derivedDirectRecoContext.resolved_target_step,
        ),
        resolved_target_step_confidence: pickFirstTrimmed(
          directRecoTargetContext && directRecoTargetContext.resolved_target_step_confidence,
          derivedDirectRecoContext && derivedDirectRecoContext.resolved_target_step_confidence,
        ),
        resolved_target_step_source: pickFirstTrimmed(
          directRecoTargetContext && directRecoTargetContext.resolved_target_step_source,
          derivedDirectRecoContext && derivedDirectRecoContext.resolved_target_step_source,
          'direct_request',
        ),
        primary_focus: derivedDirectRecoContext && derivedDirectRecoContext.primary_focus,
        confidence_policy: derivedDirectRecoContext && derivedDirectRecoContext.confidence_policy,
        ranked_targets: Array.isArray(derivedDirectRecoContext && derivedDirectRecoContext.ranked_targets)
          ? derivedDirectRecoContext.ranked_targets
          : [],
        primary_target_id: pickFirstTrimmed(derivedDirectRecoContext && derivedDirectRecoContext.primary_target_id),
        selected_target_ids: Array.isArray(derivedDirectRecoContext && derivedDirectRecoContext.selected_target_ids)
          ? derivedDirectRecoContext.selected_target_ids
          : [],
        product_candidates: Array.isArray(derivedDirectRecoContext && derivedDirectRecoContext.product_candidates)
          ? derivedDirectRecoContext.product_candidates
          : [],
        source: pickFirstTrimmed(
          derivedDirectRecoContext && derivedDirectRecoContext.context_origin,
          derivedDirectRecoContext && derivedDirectRecoContext.source,
          'direct_request',
        ),
        updated_at_ms: Date.now(),
      });

      const gate = shouldDiagnosisGate({ message: 'recommend', triggerSource: 'action', profile });
      let gateAdvisoryCard = null;
      let gateAdvisoryChips = [];
      if (gate.gated) {
        const prompt = buildDiagnosisPrompt(ctx.lang, gate.missing);
        const chips = buildDiagnosisChips(ctx.lang, gate.missing);
        gateAdvisoryCard = {
          card_id: `diag_advisory_${ctx.request_id}`,
          type: 'confidence_notice',
          payload: buildConfidenceNoticeCardPayload({
            language: ctx.lang,
            reason: 'diagnosis_first',
            confidence: { score: 0.45, level: 'low', rationale: ['profile_incomplete_assumptions_used'] },
            non_blocking: true,
            details: [
              ...(Array.isArray(gate.missing) ? gate.missing.map((field) => `missing_${field}`) : []),
              prompt,
            ].slice(0, 6),
            actions: ['refine_profile'],
          }),
        };
        gateAdvisoryChips = chips;
      }

      const upstreamReco = await generateProductRecommendations({
        ctx,
        profile,
        recentLogs,
        message: requestText,
        focus: effectiveDirectFocus,
        analysisContextSnapshot,
        requestOverride: requestProfileOverlay,
        includeAlternatives: false,
        debug: includeDebug,
        logger,
        recoTriggerSource: 'typed_reco',
        entryType: 'direct',
      });
      const norm = upstreamReco && upstreamReco.norm && typeof upstreamReco.norm === 'object'
        ? upstreamReco.norm
        : normalizeRecoGenerate(null);
      const baseContract =
        upstreamReco && upstreamReco.contract && typeof upstreamReco.contract === 'object'
          ? upstreamReco.contract
          : buildRecoMainlineContract({
            recommendations: norm?.payload?.recommendations,
            sourceMode: norm?.payload?.recommendation_meta?.source_mode,
            source: norm?.payload?.source,
            llmFailureClass: upstreamReco?.llmFailureClass,
            upstreamFailureCode: upstreamReco?.upstreamFailureCode,
            promptContractOk: norm?.payload?.prompt_contract_ok !== false,
            fieldMissing: norm?.field_missing,
            structuredSource: norm?.payload?.recommendation_meta?.source_mode,
            catalogSkipReason: norm?.payload?.recommendation_meta?.catalog_skip_reason,
            productsEmptyReason: norm?.payload?.products_empty_reason,
            groundingStatus: norm?.payload?.grounding_status || norm?.payload?.recommendation_meta?.grounding_status,
            groundedCount: norm?.payload?.grounded_count || norm?.payload?.recommendation_meta?.grounded_count,
            ungroundedCount: norm?.payload?.ungrounded_count || norm?.payload?.recommendation_meta?.ungrounded_count,
            mainlineStatusOverride: norm?.payload?.mainline_status || norm?.payload?.recommendation_meta?.mainline_status,
            promptTemplateId: norm?.payload?.recommendation_meta?.prompt_template_id,
            entryType: 'direct',
            ...extractRecoOutcomeContractArgsFromPayload(norm?.payload, upstreamReco?.contract),
          });
      if (parsed.data.include_alternatives) {
        try {
          const alt = await enrichRecommendationsWithAlternatives({
            ctx,
            profileSummary,
            recentLogs,
            recommendations: norm.payload.recommendations,
            logger,
          });
          norm.payload = { ...norm.payload, recommendations: alt.recommendations };
          norm.field_missing = mergeFieldMissing(norm.field_missing, alt.field_missing);
        } catch (altErr) {
          logger?.warn({ err: altErr?.message, code: altErr?.code }, 'aurora bff: generic-reco enrichRecommendationsWithAlternatives failed, continuing without alternatives');
        }
      }
      let directMatcherRecommendationCount = 0;
      const shouldAttemptDirectMatcherFallback =
        AURORA_PRODUCT_MATCHER_ENABLED &&
        (
          Boolean(latestArtifact && typeof latestArtifact === 'object' && !Array.isArray(latestArtifact))
          || AURORA_PRODUCT_MATCHER_BUNDLED_SEED_FALLBACK_ENABLED
        );
      const hasUpstreamRecommendations = Array.isArray(norm?.payload?.recommendations) && norm.payload.recommendations.length > 0;
      if (!hasUpstreamRecommendations && shouldAttemptDirectMatcherFallback) {
        try {
          const matcherPlan = buildIngredientPlan({
            artifact: latestArtifact || null,
            profile: profile || {},
          });
          const allowBundledSeedCatalog =
            AURORA_PRODUCT_MATCHER_BUNDLED_SEED_FALLBACK_ENABLED
            && !DIAG_PRODUCT_CATALOG_PATH;
          const directMatcherBundle = buildProductRecommendationsBundle({
            ingredientPlan: matcherPlan,
            artifact: latestArtifact || null,
            profile,
            language: ctx.lang,
            disallowTreatment: false,
            catalogPath: DIAG_PRODUCT_CATALOG_PATH,
            allowDefaultSeedCatalog: allowBundledSeedCatalog,
          });
          const directMatcherPayload = toLegacyRecommendationsPayload(directMatcherBundle, { language: ctx.lang });
          directMatcherRecommendationCount = Array.isArray(directMatcherPayload?.recommendations)
            ? directMatcherPayload.recommendations.length
            : 0;
        } catch (matcherErr) {
          logger?.warn(
            { err: matcherErr?.message, code: matcherErr?.code, request_id: ctx.request_id },
            'aurora bff: direct reco matcher fallback failed',
          );
        }
      }

      const payload = norm.payload;
      const llmTraceRef = buildRecoLlmTraceRef(upstreamReco && upstreamReco.llmTrace);
      const recoMeta = isPlainObject(payload?.recommendation_meta) ? payload.recommendation_meta : {};
      const hasPayloadRecommendations = Array.isArray(payload?.recommendations) && payload.recommendations.length > 0;
      const suggestedChips = hasPayloadRecommendations
        ? buildRecoSuccessFollowupChips(ctx.lang)
        : buildRecoEntryChips(ctx.lang);
      if (gateAdvisoryChips.length > 0) {
        const existing = new Set(suggestedChips.map((chip) => String(chip && chip.chip_id ? chip.chip_id : '').trim()).filter(Boolean));
        for (const chip of gateAdvisoryChips) {
          const chipId = String(chip && chip.chip_id ? chip.chip_id : '').trim();
          if (!chipId || existing.has(chipId)) continue;
          existing.add(chipId);
          suggestedChips.push(chip);
          if (suggestedChips.length >= 12) break;
        }
      }

      const finalDirectContract = buildRecoMainlineContract({
        recommendations: payload?.recommendations,
        sourceMode: payload?.recommendation_meta?.source_mode || baseContract.source_mode,
        source: payload?.source || baseContract.source,
        llmFailureClass: upstreamReco?.llmFailureClass || baseContract.failure_class,
        upstreamFailureCode: upstreamReco?.upstreamFailureCode,
        promptContractOk: payload?.prompt_contract_ok !== false,
        fieldMissing: norm?.field_missing,
        structuredSource: payload?.recommendation_meta?.source_mode,
        catalogSkipReason: payload?.recommendation_meta?.catalog_skip_reason,
        productsEmptyReason: payload?.products_empty_reason,
        groundingStatus: payload?.grounding_status || payload?.recommendation_meta?.grounding_status,
        groundedCount: payload?.grounded_count || payload?.recommendation_meta?.grounded_count,
        ungroundedCount: payload?.ungrounded_count || payload?.recommendation_meta?.ungrounded_count,
        mainlineStatusOverride: payload?.mainline_status || payload?.recommendation_meta?.mainline_status,
        promptTemplateId: payload?.recommendation_meta?.prompt_template_id,
        entryType: 'direct',
        ...extractRecoOutcomeContractArgsFromPayload(payload, baseContract),
      });
      finalDirectContract.mainline_status = pickFirstTrimmed(
        payload?.mainline_status,
        payload?.recommendation_meta?.mainline_status,
        finalDirectContract.mainline_status,
      ) || finalDirectContract.mainline_status;
      finalDirectContract.grounding_status = normalizeRecoGroundingStatus(
        payload?.grounding_status || payload?.recommendation_meta?.grounding_status,
      ) || finalDirectContract.grounding_status || null;
      finalDirectContract.grounded_count = Number.isFinite(Number(payload?.grounded_count))
        ? Number(payload.grounded_count)
        : Number.isFinite(Number(payload?.recommendation_meta?.grounded_count))
          ? Number(payload.recommendation_meta.grounded_count)
          : finalDirectContract.grounded_count;
      finalDirectContract.ungrounded_count = Number.isFinite(Number(payload?.ungrounded_count))
        ? Number(payload.ungrounded_count)
        : Number.isFinite(Number(payload?.recommendation_meta?.ungrounded_count))
          ? Number(payload.recommendation_meta.ungrounded_count)
          : finalDirectContract.ungrounded_count;
      finalDirectContract.prompt_template_id = pickFirstTrimmed(
        payload?.recommendation_meta?.prompt_template_id,
        finalDirectContract.prompt_template_id,
      ) || finalDirectContract.prompt_template_id;
      if (isPlainObject(payload)) {
        const nextPayload = attachRecoContractMeta(
          restorePlanOnlyRecommendations(payload, {
            sourceMode: finalDirectContract.source_mode,
          }),
          finalDirectContract,
        );
        Object.assign(payload, nextPayload);
      }
      if (Array.isArray(payload?.recommendations) && payload.recommendations.length > 0) {
        Object.assign(
          finalDirectContract,
          buildRecoMainlineContract({
            recommendations: payload.recommendations,
            sourceMode: payload?.recommendation_meta?.source_mode || finalDirectContract.source_mode,
            source: payload?.source || finalDirectContract.source,
            llmFailureClass: upstreamReco?.llmFailureClass,
            upstreamFailureCode: upstreamReco?.upstreamFailureCode,
            promptContractOk: payload?.prompt_contract_ok !== false,
            fieldMissing: norm.field_missing,
            structuredSource: payload?.recommendation_meta?.source_mode,
            catalogSkipReason: payload?.recommendation_meta?.catalog_skip_reason,
            productsEmptyReason: payload?.products_empty_reason,
            groundingStatus: payload?.grounding_status || payload?.recommendation_meta?.grounding_status,
            groundedCount: payload?.grounded_count || payload?.recommendation_meta?.grounded_count,
            ungroundedCount: payload?.ungrounded_count || payload?.recommendation_meta?.ungrounded_count,
            mainlineStatusOverride: payload?.mainline_status || payload?.recommendation_meta?.mainline_status,
            promptTemplateId: payload?.prompt_template_id || payload?.recommendation_meta?.prompt_template_id,
            entryType: 'direct',
            ...extractRecoOutcomeContractArgsFromPayload(payload, finalDirectContract),
          }),
        );
      }

      const recommendationContextState = deriveRecommendationContextState(recommendationAnalysisTaskContext);
      const explicitOnlyNeedsMoreContextWarning =
        !(Array.isArray(payload?.recommendations) && payload.recommendations.length > 0)
        && String(recommendationAnalysisTaskContext?.context_source_mode || '').trim() === 'explicit_only'
        && recommendationContextState.satisfied === false;
      const recommendationAnalysisContextMeta = buildTaskAnalysisContextUsageMeta(
        recommendationAnalysisTaskContext,
        {
          requestContextSignature: payload?.recommendation_meta?.request_context_signature,
          requestContextSignatureVersion:
            payload?.recommendation_meta?.request_context_signature_version || REQUEST_CONTEXT_SIGNATURE_VERSION,
          candidatePoolSignature: payload?.recommendation_meta?.candidate_pool_signature,
          candidatePoolSignatureVersion: DIRECT_RECO_CANDIDATE_POOL_SIGNATURE_VERSION,
          strictnessSource: 'entry_default',
          minimumRecommendationContextSatisfied: recommendationContextState.satisfied,
          minContextRuleVersion: recommendationContextState.min_context_rule_version,
        },
      );
      if (isPlainObject(payload)) {
        const payloadMeta = isPlainObject(payload.recommendation_meta) ? payload.recommendation_meta : {};
        payload.recommendation_meta = {
          ...payloadMeta,
          analysis_context_usage: recommendationAnalysisContextMeta,
          request_context_signature_version:
            pickFirstTrimmed(payloadMeta.request_context_signature_version, REQUEST_CONTEXT_SIGNATURE_VERSION)
            || REQUEST_CONTEXT_SIGNATURE_VERSION,
          candidate_pool_signature_version: DIRECT_RECO_CANDIDATE_POOL_SIGNATURE_VERSION,
          ...(explicitOnlyNeedsMoreContextWarning
            ? {
              minimum_recommendation_context_warning: true,
              minimum_recommendation_context_reason: 'minimum_recommendation_context_unsatisfied',
            }
            : {}),
          ...(directRecoTargetContext?.resolved_target_step ? { resolved_target_step: directRecoTargetContext.resolved_target_step } : {}),
          ...(directRecoTargetContext?.resolved_target_step_confidence ? { resolved_target_step_confidence: directRecoTargetContext.resolved_target_step_confidence } : {}),
          ...(directRecoTargetContext?.resolved_target_step_source ? { resolved_target_step_source: directRecoTargetContext.resolved_target_step_source } : {}),
        };
        Object.assign(payload, applyRecoContentSpineToPayload(payload, directRecoSpineContext));
        payload.metadata = {
          ...(isPlainObject(payload.metadata) ? payload.metadata : {}),
          ...(explicitOnlyNeedsMoreContextWarning
            ? {
              minimum_recommendation_context_warning: true,
              minimum_recommendation_context_reason: 'minimum_recommendation_context_unsatisfied',
            }
            : {}),
          matcher_check_result: {
            source: 'artifact_matcher_v1',
            available: directMatcherRecommendationCount > 0,
            recommendation_count: directMatcherRecommendationCount,
          },
        };
      }

      const directSessionPatchMeta = {
        profile_context_source: requestProfileContextSource,
        request_profile_overlay_applied: requestProfileOverlayKeys.length > 0,
        ...(requestProfileOverlayKeys.length ? { request_profile_overlay_keys: requestProfileOverlayKeys } : {}),
        analysis_context_usage: recommendationAnalysisContextMeta,
        ...(explicitOnlyNeedsMoreContextWarning
          ? {
            recommendation_warning: {
              minimum_recommendation_context_warning: true,
              missing_context: recommendationContextState.missing_context,
              request_context_signature_version: recommendationContextState.request_context_signature_version,
              candidate_pool_signature_version: recommendationContextState.candidate_pool_signature_version,
              strictness_source: recommendationContextState.strictness_source,
            },
          }
          : {}),
      };
      const directNoRecoReason = pickFirstTrimmed(
        finalDirectContract.surface_reason,
        payload?.recommendation_meta?.surface_reason,
        finalDirectContract.products_empty_reason,
        payload?.products_empty_reason,
        deriveRecoEmptyReason(payload, finalDirectContract),
      );
      const hasPlanOrGroundedRecommendations = Array.isArray(payload?.recommendations) && payload.recommendations.length > 0;

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: suggestedChips,
        cards: [
          {
            card_id: `reco_${ctx.request_id}`,
            type: 'recommendations',
            payload,
            ...(norm.field_missing?.length ? { field_missing: norm.field_missing.slice(0, 8) } : {}),
          },
          ...(gateAdvisoryCard ? [gateAdvisoryCard] : []),
        ],
        session_patch: {
          ...(payload.recommendations && payload.recommendations.length ? { next_state: 'S7_PRODUCT_RECO' } : {}),
          meta: directSessionPatchMeta,
        },
        events: applyRecoContractToRecoRequestedEvents([], finalDirectContract, {
          ctx: { ...ctx, trigger_source: 'action' },
          emitIfMissing: true,
          eventData: buildRecoRequestedEventData({
            explicit: true,
            payload,
            source: String(payload?.source || recoMeta.source_mode || 'catalog_grounded_v1'),
            llmTraceRef,
            failureClass: upstreamReco && upstreamReco.llmFailureClass ? upstreamReco.llmFailureClass : '',
            upstreamFailureCode: upstreamReco?.upstreamFailureCode,
            ...(!hasPlanOrGroundedRecommendations && directNoRecoReason ? { reason: directNoRecoReason } : {}),
          }),
        }).events,
      });

      if (!AURORA_RECO_GENERATE_GUARDRAIL_V1) {
        const envelopeRecommendations = Array.isArray(payload?.recommendations) ? payload.recommendations : [];
        if (!envelopeRecommendations.length) {
          const noRecoEnvelope = {
            ...envelope,
            cards: [
              {
                card_id: `conf_${ctx.request_id}_reco_missing`,
                type: 'confidence_notice',
                payload: buildConfidenceNoticeCardPayload({
                  language: ctx.lang,
                  reason: directNoRecoReason || 'artifact_missing',
                  confidence: { score: 0.35, level: 'low', rationale: [finalDirectContract.telemetry_failure_reason || directNoRecoReason || 'artifact_missing'] },
                  actions: ['retry_recommendations', 'refine_profile'],
                }),
              },
              ...(gateAdvisoryCard ? [gateAdvisoryCard] : []),
            ],
            suggested_chips: suggestedChips.length ? suggestedChips : buildRecoEntryChips(ctx.lang),
            session_patch: {
              ...(isPlainObject(envelope.session_patch) ? envelope.session_patch : {}),
            },
          };
          return res.json(finalizeDirectRecoEnvelope({
            envelope: noRecoEnvelope,
            includeDebug,
            upstreamDebug: upstreamReco?.upstreamDebug,
            recoPayload: payload,
            recoContract: finalDirectContract,
            assistantText:
              isPlainObject(noRecoEnvelope.assistant_message) && typeof noRecoEnvelope.assistant_message.content === 'string'
                ? noRecoEnvelope.assistant_message.content
                : '',
            policyMeta: { intent_canonical: 'reco_products' },
            profile,
          }));
        }
        return res.json(finalizeDirectRecoEnvelope({
          envelope,
          includeDebug,
          upstreamDebug: upstreamReco?.upstreamDebug,
          recoPayload: payload,
          recoContract: finalDirectContract,
          assistantText:
            isPlainObject(envelope.assistant_message) && typeof envelope.assistant_message.content === 'string'
              ? envelope.assistant_message.content
              : '',
          policyMeta: { intent_canonical: 'reco_products' },
          profile,
        }));
      }

      const guardrailResult = await applyRecommendationOutputGuardrailsForRoute({
        envelope,
        ctx,
        logger,
      });
      if (Array.isArray(guardrailResult.rejected) && guardrailResult.rejected.length > 0) {
        persistRejectedCatalogCandidates(ctx, guardrailResult.rejected);
      }
      const guardedEnvelope = isPlainObject(guardrailResult.envelope) ? guardrailResult.envelope : envelope;
      const guardedCards = Array.isArray(guardedEnvelope.cards) ? guardedEnvelope.cards : [];
      const guardedRecoCard = guardedCards.find(
        (card) => isPlainObject(card) && String(card.type || '').trim().toLowerCase() === 'recommendations',
      );
      const guardedRecommendations = Array.isArray(guardedRecoCard && guardedRecoCard.payload && guardedRecoCard.payload.recommendations)
        ? guardedRecoCard.payload.recommendations
        : [];
      if (isPlainObject(guardedRecoCard?.payload)) {
        const guardedMeta = isPlainObject(guardedRecoCard.payload.recommendation_meta) ? guardedRecoCard.payload.recommendation_meta : {};
        guardedRecoCard.payload.recommendation_meta = {
          ...guardedMeta,
          analysis_context_usage: recommendationAnalysisContextMeta,
          request_context_signature_version:
            pickFirstTrimmed(guardedMeta.request_context_signature_version, REQUEST_CONTEXT_SIGNATURE_VERSION)
            || REQUEST_CONTEXT_SIGNATURE_VERSION,
          candidate_pool_signature_version: DIRECT_RECO_CANDIDATE_POOL_SIGNATURE_VERSION,
          final_selected_candidate_count: guardedRecommendations.length,
          post_guardrail_count: guardedRecommendations.length,
        };
        guardedRecoCard.payload = applyRecoContentSpineToPayload(guardedRecoCard.payload, directRecoSpineContext);
      }
      const hasGuardedRecommendations = guardedRecommendations.length > 0;
      const finalContract = buildRecoMainlineContract({
        recommendations: guardedRecommendations,
        sourceMode: guardedRecoCard?.payload?.recommendation_meta?.source_mode || baseContract.source_mode,
        source: guardedRecoCard?.payload?.source || baseContract.source,
        llmFailureClass: baseContract.failure_class || upstreamReco?.llmFailureClass,
        upstreamFailureCode: upstreamReco?.upstreamFailureCode,
        promptContractOk: guardedRecoCard?.payload?.prompt_contract_ok !== false,
        fieldMissing: guardedRecoCard?.field_missing,
        structuredSource: guardedRecoCard?.payload?.recommendation_meta?.source_mode,
        catalogSkipReason: guardedRecoCard?.payload?.recommendation_meta?.catalog_skip_reason,
        productsEmptyReason: guardedRecoCard?.payload?.products_empty_reason,
        groundingStatus: guardedRecoCard?.payload?.grounding_status || guardedRecoCard?.payload?.recommendation_meta?.grounding_status,
        groundedCount: guardedRecoCard?.payload?.grounded_count || guardedRecoCard?.payload?.recommendation_meta?.grounded_count,
        ungroundedCount: guardedRecoCard?.payload?.ungrounded_count || guardedRecoCard?.payload?.recommendation_meta?.ungrounded_count,
        mainlineStatusOverride: guardedRecoCard?.payload?.mainline_status || guardedRecoCard?.payload?.recommendation_meta?.mainline_status,
        promptTemplateId: guardedRecoCard?.payload?.prompt_template_id || guardedRecoCard?.payload?.recommendation_meta?.prompt_template_id,
        entryType: 'direct',
        ...extractRecoOutcomeContractArgsFromPayload(guardedRecoCard?.payload, baseContract),
      });
      finalContract.mainline_status = pickFirstTrimmed(
        guardedRecoCard?.payload?.mainline_status,
        guardedRecoCard?.payload?.recommendation_meta?.mainline_status,
        finalContract.mainline_status,
      ) || finalContract.mainline_status;
      finalContract.grounding_status = normalizeRecoGroundingStatus(
        guardedRecoCard?.payload?.grounding_status || guardedRecoCard?.payload?.recommendation_meta?.grounding_status,
      ) || finalContract.grounding_status || null;
      finalContract.grounded_count = Number.isFinite(Number(guardedRecoCard?.payload?.grounded_count))
        ? Number(guardedRecoCard.payload.grounded_count)
        : Number.isFinite(Number(guardedRecoCard?.payload?.recommendation_meta?.grounded_count))
          ? Number(guardedRecoCard.payload.recommendation_meta.grounded_count)
          : finalContract.grounded_count;
      finalContract.ungrounded_count = Number.isFinite(Number(guardedRecoCard?.payload?.ungrounded_count))
        ? Number(guardedRecoCard.payload.ungrounded_count)
        : Number.isFinite(Number(guardedRecoCard?.payload?.recommendation_meta?.ungrounded_count))
          ? Number(guardedRecoCard.payload.recommendation_meta.ungrounded_count)
          : finalContract.ungrounded_count;
      finalContract.prompt_template_id = pickFirstTrimmed(
        guardedRecoCard?.payload?.prompt_template_id,
        guardedRecoCard?.payload?.recommendation_meta?.prompt_template_id,
        finalContract.prompt_template_id,
      ) || finalContract.prompt_template_id;
      if (isPlainObject(guardedRecoCard?.payload)) {
        guardedRecoCard.payload = attachRecoContractMeta(
          restorePlanOnlyRecommendations(guardedRecoCard.payload, {
            sourceMode: finalContract.source_mode,
          }),
          finalContract,
        );
      }
      if (Array.isArray(guardedRecoCard?.payload?.recommendations) && guardedRecoCard.payload.recommendations.length > 0) {
        Object.assign(
          finalContract,
          buildRecoMainlineContract({
            recommendations: guardedRecoCard.payload.recommendations,
            sourceMode: guardedRecoCard.payload?.recommendation_meta?.source_mode || finalContract.source_mode,
            source: guardedRecoCard.payload?.source || finalContract.source,
            llmFailureClass: finalContract.failure_class,
            upstreamFailureCode: upstreamReco?.upstreamFailureCode,
            promptContractOk: guardedRecoCard.payload?.prompt_contract_ok !== false,
            fieldMissing: guardedRecoCard?.field_missing,
            structuredSource: guardedRecoCard.payload?.recommendation_meta?.source_mode,
            catalogSkipReason: guardedRecoCard.payload?.recommendation_meta?.catalog_skip_reason,
            productsEmptyReason: guardedRecoCard.payload?.products_empty_reason,
            groundingStatus: guardedRecoCard.payload?.grounding_status || guardedRecoCard.payload?.recommendation_meta?.grounding_status,
            groundedCount: guardedRecoCard.payload?.grounded_count || guardedRecoCard.payload?.recommendation_meta?.grounded_count,
            ungroundedCount: guardedRecoCard.payload?.ungrounded_count || guardedRecoCard.payload?.recommendation_meta?.ungrounded_count,
            mainlineStatusOverride: guardedRecoCard.payload?.mainline_status || guardedRecoCard.payload?.recommendation_meta?.mainline_status,
            promptTemplateId: guardedRecoCard.payload?.prompt_template_id || guardedRecoCard.payload?.recommendation_meta?.prompt_template_id,
            entryType: 'direct',
            ...extractRecoOutcomeContractArgsFromPayload(guardedRecoCard.payload, finalContract),
          }),
        );
      }

      const finalNoRecoReason = deriveRecoEmptyReason(guardedRecoCard?.payload, finalContract);
      const nextSessionPatch = isPlainObject(guardedEnvelope.session_patch) ? { ...guardedEnvelope.session_patch } : {};
      nextSessionPatch.meta = {
        ...(isPlainObject(nextSessionPatch.meta) ? nextSessionPatch.meta : {}),
        ...directSessionPatchMeta,
      };
      const hasFinalRecommendations = Array.isArray(guardedRecoCard?.payload?.recommendations)
        ? guardedRecoCard.payload.recommendations.length > 0
        : hasGuardedRecommendations;
      if (hasFinalRecommendations) {
        nextSessionPatch.next_state = 'S7_PRODUCT_RECO';
        if (!Array.isArray(guardedEnvelope.suggested_chips) || guardedEnvelope.suggested_chips.length === 0) {
          guardedEnvelope.suggested_chips = buildRecoSuccessFollowupChips(ctx.lang);
        }
      } else {
        delete nextSessionPatch.next_state;
        if (!Array.isArray(guardedEnvelope.suggested_chips) || guardedEnvelope.suggested_chips.length === 0) {
          guardedEnvelope.suggested_chips = buildRecoEntryChips(ctx.lang);
        }
        guardedEnvelope.cards = [
          {
            card_id: `conf_${ctx.request_id}_reco_missing`,
            type: 'confidence_notice',
            payload: buildConfidenceNoticeCardPayload({
              language: ctx.lang,
              reason: finalNoRecoReason || 'artifact_missing',
              confidence: { score: 0.35, level: 'low', rationale: [finalContract.telemetry_failure_reason || finalNoRecoReason || 'artifact_missing'] },
              actions: ['retry_recommendations', 'refine_profile'],
            }),
          },
          ...(gateAdvisoryCard ? [gateAdvisoryCard] : []),
        ];
      }
      guardedEnvelope.events = applyRecoContractToRecoRequestedEvents(guardedEnvelope.events, finalContract, {
        ctx: { ...ctx, trigger_source: 'action' },
        emitIfMissing: true,
        eventData: buildRecoRequestedEventData({
          explicit: true,
          payload: guardedRecoCard?.payload,
          source: String(
            guardedRecoCard?.payload?.source
            || guardedRecoCard?.payload?.recommendation_meta?.source_mode
            || baseContract.source
            || 'legacy_notice'
          ),
          llmTraceRef,
          failureClass: finalContract.failure_class,
          upstreamFailureCode: upstreamReco?.upstreamFailureCode,
          ...(!hasFinalRecommendations && finalNoRecoReason ? { reason: finalNoRecoReason } : {}),
        }),
      }).events;
      guardedEnvelope.session_patch = nextSessionPatch;
      return res.json(finalizeDirectRecoEnvelope({
        envelope: guardedEnvelope,
        includeDebug,
        upstreamDebug: upstreamReco?.upstreamDebug,
        recoPayload: guardedRecoCard?.payload,
        recoContract: finalContract,
        assistantText:
          isPlainObject(guardedEnvelope.assistant_message) && typeof guardedEnvelope.assistant_message.content === 'string'
            ? guardedEnvelope.assistant_message.content
            : '',
        policyMeta: { intent_canonical: 'reco_products' },
        profile,
      }));
    } catch (err) {
      const status = err.status || 500;
      const errorCode = err.code || 'RECO_GENERATE_FAILED';
      return res.status(status).json(buildFailureEnvelope(ctx, errorCode));
    }
  }

  return {
    handleDirectRecoGenerateRoute,
  };
}

module.exports = {
  createDirectRecoGenerateHandlerRuntime,
};
