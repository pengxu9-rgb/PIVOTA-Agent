function pickFirstTrimmed(...values) {
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (normalized) return normalized;
  }
  return '';
}

function createLegacyChatRecoAnalysisContextRuntime(deps = {}) {
  const {
    hasUsableArtifactForRecommendations,
    buildIngredientPlan,
  } = deps;

  async function prepareLegacyChatRecoAnalysisContext({
    ctx = null,
    logger = null,
    message = '',
    profile = null,
    identity = null,
    ingredientPlanEnabled = false,
    productMatcherEnabled = false,
    nonblockingGateEnabled = false,
    ensureLatestArtifactForConversation = null,
    ensureAnalysisContextSnapshotForConversation = null,
    ensureTaskAnalysisContextForConversation = null,
    looksLikeLowRiskSkincareTask = null,
    recordAuroraSkinFlowMetric = null,
    runAuroraTimedOperation = null,
    getIngredientPlanByArtifactIdForRoute = null,
    getAuroraStorageReadTimeoutMs = null,
    saveIngredientPlanForRoute = null,
    getAuroraStorageWriteTimeoutMs = null,
  } = {}) {
    const latestArtifactForGate =
      typeof ensureLatestArtifactForConversation === 'function'
        ? await ensureLatestArtifactForConversation()
        : null;
    const latestArtifact = latestArtifactForGate;
    const artifactGate =
      typeof hasUsableArtifactForRecommendations === 'function'
        ? hasUsableArtifactForRecommendations(latestArtifactForGate)
        : { ok: false, reason: 'artifact_checker_missing', confidence_level: 'unknown' };
    const analysisContextSnapshotForConversation =
      typeof ensureAnalysisContextSnapshotForConversation === 'function'
        ? await ensureAnalysisContextSnapshotForConversation()
        : null;
    const chatAnalysisTaskContext =
      typeof ensureTaskAnalysisContextForConversation === 'function'
        ? await ensureTaskAnalysisContextForConversation('chat')
        : null;
    const allowLowRiskNonBlockingArtifactGate =
      Boolean(nonblockingGateEnabled) &&
      typeof looksLikeLowRiskSkincareTask === 'function' &&
      looksLikeLowRiskSkincareTask(message);

    if (productMatcherEnabled && !artifactGate.ok && !allowLowRiskNonBlockingArtifactGate) {
      logger?.info(
        {
          request_id: ctx?.request_id,
          trace_id: ctx?.trace_id,
          artifact_reason: artifactGate.reason || 'artifact_missing',
        },
        'aurora bff: artifact gate bypassed for reco mainline',
      );
    }
    if (productMatcherEnabled && !artifactGate.ok && allowLowRiskNonBlockingArtifactGate) {
      if (typeof recordAuroraSkinFlowMetric === 'function') {
        recordAuroraSkinFlowMetric({ stage: 'artifact_gate_nonblocking_low_risk', hit: true });
      }
      logger?.info(
        {
          request_id: ctx?.request_id,
          trace_id: ctx?.trace_id,
          reason: artifactGate.reason || 'artifact_missing',
        },
        'aurora bff: bypassing artifact gate for low-risk skincare request',
      );
    }

    let mappedIngredientPlan = null;
    if (latestArtifact && ingredientPlanEnabled) {
      const latestArtifactId = String(latestArtifact.artifact_id || '').trim();
      try {
        const existingPlan =
          latestArtifactId && typeof runAuroraTimedOperation === 'function' && typeof getIngredientPlanByArtifactIdForRoute === 'function'
            ? await runAuroraTimedOperation(
                () => getIngredientPlanByArtifactIdForRoute({ artifactId: latestArtifactId }),
                {
                  timeoutMs:
                    typeof getAuroraStorageReadTimeoutMs === 'function'
                      ? getAuroraStorageReadTimeoutMs()
                      : 0,
                  timeoutCode: 'AURORA_CHAT_INGREDIENT_PLAN_LOAD_TIMEOUT',
                },
              )
            : null;
        if (existingPlan && existingPlan.plan_json && typeof existingPlan.plan_json === 'object') {
          mappedIngredientPlan = {
            ...existingPlan.plan_json,
            plan_id: existingPlan.plan_id,
            created_at: existingPlan.created_at || existingPlan.plan_json.created_at,
          };
        } else {
          const builtPlan =
            typeof buildIngredientPlan === 'function'
              ? buildIngredientPlan({ artifact: latestArtifact, profile })
              : null;
          if (
            latestArtifactId &&
            builtPlan &&
            typeof runAuroraTimedOperation === 'function' &&
            typeof saveIngredientPlanForRoute === 'function'
          ) {
            const savedPlan = await runAuroraTimedOperation(
              () =>
                saveIngredientPlanForRoute({
                  artifactId: latestArtifactId,
                  auroraUid: identity?.auroraUid,
                  userId: identity?.userId,
                  plan: builtPlan,
                }),
              {
                timeoutMs:
                  typeof getAuroraStorageWriteTimeoutMs === 'function'
                    ? getAuroraStorageWriteTimeoutMs()
                    : 0,
                timeoutCode: 'AURORA_CHAT_INGREDIENT_PLAN_SAVE_TIMEOUT',
              },
            );
            mappedIngredientPlan =
              savedPlan && savedPlan.plan_json && typeof savedPlan.plan_json === 'object'
                ? {
                    ...savedPlan.plan_json,
                    plan_id: savedPlan.plan_id,
                    created_at: savedPlan.created_at || savedPlan.plan_json.created_at,
                  }
                : builtPlan;
          } else {
            mappedIngredientPlan = builtPlan;
          }
        }
      } catch (err) {
        logger?.warn(
          { err: err && err.message ? err.message : String(err), request_id: ctx?.request_id },
          'aurora bff: ingredient plan lookup/build failed',
        );
      }
    }

    return {
      latestArtifact,
      artifactGate,
      analysisContextSnapshotForConversation,
      chatAnalysisTaskContext,
      allowLowRiskNonBlockingArtifactGate,
      mappedIngredientPlan,
    };
  }

  return {
    prepareLegacyChatRecoAnalysisContext,
  };
}

module.exports = {
  createLegacyChatRecoAnalysisContextRuntime,
};
