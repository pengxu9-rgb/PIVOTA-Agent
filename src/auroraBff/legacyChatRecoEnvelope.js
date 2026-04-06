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

function createLegacyChatRecoEnvelopeRuntime(deps = {}) {
  const {
    buildEnvelope,
    makeAssistantMessage,
    makeEvent,
    buildConfidenceNoticeCardPayload,
    buildIngredientPlanCard,
    appendLatestArtifactToSessionPatch,
    appendLatestRecoContextToSessionPatch,
    attachAnalysisContextUsageToSessionPatch,
    recordAuroraRecoKbWrite,
    saveRecoRun,
    applyRecoContractToRecoRequestedEvents,
    buildRecoRequestedEventData,
    normalizeRecoSourceDetail,
    deriveRecoEmptyReason,
  } = deps;

  function buildLegacyChatRecoEnvelope({
    ctx,
    payload,
    normFieldMissing = [],
    mappedIngredientPlan = null,
    debugUpstream = false,
    upstreamDebug = null,
    alternativesDebug = null,
    nextState = undefined,
    recoIngredientContext = null,
    latestArtifact = null,
    latestRecoContextPatch = null,
    chatAnalysisTaskContext = null,
    attachAnalysisContextUsageToSessionPatch = null,
    lowConfidenceArtifact = false,
    identity = null,
    llmPrimaryUsed = false,
    matcherFallbackUsed = false,
    generatedPrimaryUsed = false,
    generatedSourceMode = '',
    genericConcernRecoMainline = false,
    hasDeterministicRecoTarget = false,
    productMatcherEnabled = false,
    matcherBundle = null,
    finalHasRecs = false,
    finalAssistantText = '',
    refinementChips = [],
    recoContract = null,
    recoSource = '',
    effectiveRecoEntrySourceDetail = '',
    shouldAutoRerunRecommendationsFromProfilePatch = false,
    artifactConfidenceLevel = '',
    artifactConfidenceScore = null,
    llmTraceRef = null,
    llmFailureClass = '',
    logger = null,
  } = {}) {
    const cards = finalHasRecs
      ? [
          {
            card_id: `reco_${ctx.request_id}`,
            type: 'recommendations',
            payload,
            ...(Array.isArray(normFieldMissing) && normFieldMissing.length
              ? { field_missing: normFieldMissing.slice(0, 8) }
              : {}),
          },
        ]
      : [
          {
            card_id: `conf_${ctx.request_id}_reco_missing`,
            type: 'confidence_notice',
            payload: buildConfidenceNoticeCardPayload({
              language: ctx.lang,
              reason: deriveRecoEmptyReason(payload, recoContract) || 'artifact_missing',
              confidence: {
                score: artifactConfidenceScore != null ? artifactConfidenceScore : 0.35,
                level: 'low',
                rationale: [
                  recoContract?.telemetry_failure_reason ||
                    deriveRecoEmptyReason(payload, recoContract) ||
                    'artifact_missing',
                ],
              },
              actions: ['retry_recommendations', 'upload_daylight_and_indoor_white', 'update_current_routine'],
            }),
          },
        ];
    if (mappedIngredientPlan) {
      cards.push(buildIngredientPlanCard(mappedIngredientPlan, ctx.request_id));
    }

    if (debugUpstream && upstreamDebug) {
      cards.push({
        card_id: `aurora_debug_${ctx.request_id}`,
        type: 'aurora_debug',
        payload: upstreamDebug,
      });
      if (alternativesDebug) {
        cards.push({
          card_id: `aurora_alt_debug_${ctx.request_id}`,
          type: 'aurora_alt_debug',
          payload: { items: alternativesDebug },
        });
      }
    }

    const sessionPatch = nextState ? { next_state: nextState } : {};
    if (recoIngredientContext) {
      sessionPatch.meta = {
        ...(sessionPatch.meta && typeof sessionPatch.meta === 'object' ? sessionPatch.meta : {}),
        ingredient_context: recoIngredientContext,
      };
    }
    appendLatestArtifactToSessionPatch(sessionPatch, latestArtifact && latestArtifact.artifact_id);
    appendLatestRecoContextToSessionPatch(sessionPatch, latestRecoContextPatch);
    if (typeof attachAnalysisContextUsageToSessionPatch === 'function') {
      attachAnalysisContextUsageToSessionPatch(sessionPatch, chatAnalysisTaskContext);
    }

    let kbWriteStatus = 'skipped';
    let kbQuarantineReasons = [];
    const baseRecoRunContext = {
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
      trigger_source: ctx.trigger_source,
      low_confidence: lowConfidenceArtifact,
    };

    if (llmPrimaryUsed && isPlainObject(payload)) {
      const recoItems = Array.isArray(payload.recommendations) ? payload.recommendations : [];
      const hasUsableReco = recoItems.some((row) => {
        if (!isPlainObject(row)) return false;
        const sku = isPlainObject(row.sku) ? row.sku : {};
        const brand = pickFirstTrimmed(row.brand, sku.brand);
        const name = pickFirstTrimmed(
          row.name,
          row.display_name,
          row.displayName,
          sku.name,
          sku.display_name,
          sku.displayName,
        );
        const externalUrl = pickFirstTrimmed(
          row?.pdp_open?.external?.url,
          row?.url,
          row?.pdp_url,
          sku?.url,
          sku?.pdp_url,
        );
        return Boolean((brand && name) || externalUrl);
      });
      kbQuarantineReasons = hasUsableReco ? [] : ['llm_reco_quality_gate_failed'];
      kbWriteStatus = 'attempted';
      recordAuroraRecoKbWrite({ source: 'llm_primary', outcome: 'attempted' });
      saveRecoRun({
        artifactId: latestArtifact ? latestArtifact.artifact_id : null,
        planId: mappedIngredientPlan && mappedIngredientPlan.plan_id ? mappedIngredientPlan.plan_id : null,
        auroraUid: identity?.auroraUid,
        userId: identity?.userId,
        requestContext: {
          ...baseRecoRunContext,
          source: 'llm_primary_v1',
          kb_backfill_attempted: true,
          kb_quarantined: kbQuarantineReasons.length > 0,
          ...(kbQuarantineReasons.length ? { kb_quarantine_reasons: kbQuarantineReasons } : {}),
        },
        reco: {
          source: 'llm_primary_v1',
          recommendation_meta: payload.recommendation_meta || null,
          recommendations: recoItems.slice(0, 16),
        },
        overallConfidence:
          Number.isFinite(Number(payload.recommendation_confidence_score))
            ? Number(payload.recommendation_confidence_score)
            : null,
      })
        .then(() => {
          recordAuroraRecoKbWrite({
            source: 'llm_primary',
            outcome: kbQuarantineReasons.length ? 'quarantined' : 'persisted',
          });
        })
        .catch((err) => {
          recordAuroraRecoKbWrite({ source: 'llm_primary', outcome: 'error' });
          logger?.warn(
            { err: err && err.message ? err.message : String(err), request_id: ctx.request_id },
            'aurora bff: failed to persist llm-primary reco run',
          );
        });
    } else {
      const skippedSource = matcherFallbackUsed
        ? 'artifact_matcher'
        : generatedPrimaryUsed
          ? generatedSourceMode || 'catalog_grounded'
          : llmPrimaryUsed
            ? 'llm_primary'
            : genericConcernRecoMainline
              ? 'framework_mainline'
              : hasDeterministicRecoTarget
                ? 'step_aware_mainline'
                : 'legacy_notice';
      recordAuroraRecoKbWrite({ source: skippedSource, outcome: 'skipped' });
    }

    if (matcherFallbackUsed && productMatcherEnabled && matcherBundle) {
      recordAuroraRecoKbWrite({ source: 'artifact_matcher', outcome: 'attempted' });
      saveRecoRun({
        artifactId: latestArtifact ? latestArtifact.artifact_id : null,
        planId: mappedIngredientPlan && mappedIngredientPlan.plan_id ? mappedIngredientPlan.plan_id : null,
        auroraUid: identity?.auroraUid,
        userId: identity?.userId,
        requestContext: {
          ...baseRecoRunContext,
          source: 'artifact_matcher_v1',
        },
        reco: matcherBundle,
        overallConfidence:
          matcherBundle.confidence && Number.isFinite(Number(matcherBundle.confidence.score))
            ? Number(matcherBundle.confidence.score)
            : null,
      })
        .then(() => {
          recordAuroraRecoKbWrite({ source: 'artifact_matcher', outcome: 'persisted' });
        })
        .catch((err) => {
          recordAuroraRecoKbWrite({ source: 'artifact_matcher', outcome: 'error' });
          logger?.warn(
            { err: err && err.message ? err.message : String(err), request_id: ctx.request_id },
            'aurora bff: failed to persist matcher fallback reco run',
          );
        });
    }

    if (isPlainObject(payload)) {
      payload.metadata = {
        ...(isPlainObject(payload.metadata) ? payload.metadata : {}),
        kb_write_status: kbWriteStatus,
        kb_quarantine_reasons: kbQuarantineReasons,
      };
    }

    return buildEnvelope(ctx, {
      assistant_message: makeAssistantMessage(finalAssistantText),
      suggested_chips: refinementChips,
      cards,
      session_patch: sessionPatch,
      events: applyRecoContractToRecoRequestedEvents(
        finalHasRecs ? [makeEvent(ctx, 'value_moment', { kind: 'product_reco' })] : [],
        recoContract,
        {
          ctx,
          emitIfMissing: true,
          eventData: {
            ...buildRecoRequestedEventData({
              explicit: true,
              payload,
              source: recoSource,
              sourceDetail: normalizeRecoSourceDetail(effectiveRecoEntrySourceDetail),
              recomputeFromProfileUpdate: shouldAutoRerunRecommendationsFromProfilePatch === true,
              lowConfidence: lowConfidenceArtifact,
              confidenceLevel: artifactConfidenceLevel,
              llmTraceRef,
              failureClass: llmFailureClass,
            }),
            kb_write_status: kbWriteStatus,
            ...(kbQuarantineReasons.length ? { kb_quarantine_reasons: kbQuarantineReasons } : {}),
            ...(artifactConfidenceScore != null ? { confidence_score: artifactConfidenceScore } : {}),
            ...(!finalHasRecs && deriveRecoEmptyReason(payload, recoContract)
              ? { reason: deriveRecoEmptyReason(payload, recoContract) }
              : {}),
          },
        },
      ).events,
    });
  }

  return {
    buildLegacyChatRecoEnvelope,
  };
}

module.exports = {
  createLegacyChatRecoEnvelopeRuntime,
};
