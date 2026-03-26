function createChatRecoArtifactRuntime(options = {}) {
  const {
    logger = null,
    extractLatestArtifactIdFromSession,
    getLatestDiagnosisArtifact,
    hasUsableArtifactForRecommendations,
    AURORA_CHAT_NONBLOCKING_GATE_V1_ENABLED = false,
    looksLikeLowRiskSkincareTask = () => false,
    AURORA_PRODUCT_MATCHER_ENABLED = false,
    buildRecoEntryChips = () => [],
    getIngredientPlanByArtifactId,
    buildIngredientPlan,
    saveIngredientPlan,
    AURORA_INGREDIENT_PLAN_ENABLED = false,
    recordAuroraSkinFlowMetric = () => {},
  } = options;

  function requireFunction(name, value) {
    if (typeof value === 'function') return value;
    throw new Error(`aurora chat reco artifact runtime missing dependency: ${name}`);
  }

  async function prepareRecoArtifactContext({
    ctx,
    session = null,
    message = '',
    profile = null,
    identity = {},
    refinementChips = [],
    pushGateDecision = () => null,
    enqueueGateAdvisory = () => {},
  } = {}) {
    const extractLatestArtifactIdFromSessionFn = requireFunction(
      'extractLatestArtifactIdFromSession',
      extractLatestArtifactIdFromSession,
    );
    const getLatestDiagnosisArtifactFn = requireFunction(
      'getLatestDiagnosisArtifact',
      getLatestDiagnosisArtifact,
    );
    const hasUsableArtifactForRecommendationsFn = requireFunction(
      'hasUsableArtifactForRecommendations',
      hasUsableArtifactForRecommendations,
    );
    const getIngredientPlanByArtifactIdFn = requireFunction(
      'getIngredientPlanByArtifactId',
      getIngredientPlanByArtifactId,
    );
    const buildIngredientPlanFn = requireFunction('buildIngredientPlan', buildIngredientPlan);
    const saveIngredientPlanFn = requireFunction('saveIngredientPlan', saveIngredientPlan);

    const preferredArtifactId = extractLatestArtifactIdFromSessionFn(session);
    let latestArtifact = null;
    try {
      latestArtifact = await getLatestDiagnosisArtifactFn({
        auroraUid: identity.auroraUid,
        userId: identity.userId,
        sessionId: ctx && ctx.brief_id ? ctx.brief_id : null,
        maxAgeDays: 30,
        preferArtifactId: preferredArtifactId,
      });
    } catch (err) {
      logger?.warn?.(
        { err: err && err.message ? err.message : String(err), request_id: ctx && ctx.request_id },
        'aurora bff: failed to load latest diagnosis artifact',
      );
    }

    const latestArtifactForGate =
      latestArtifact &&
      latestArtifact.artifact_json &&
      typeof latestArtifact.artifact_json === 'object'
        ? {
            ...latestArtifact.artifact_json,
            artifact_id: latestArtifact.artifact_id,
            created_at: latestArtifact.created_at || latestArtifact.artifact_json.created_at,
          }
        : latestArtifact;

    const artifactGate = hasUsableArtifactForRecommendationsFn(latestArtifactForGate);
    const allowLowRiskNonBlockingArtifactGate =
      AURORA_CHAT_NONBLOCKING_GATE_V1_ENABLED && looksLikeLowRiskSkincareTask(message);

    if (AURORA_PRODUCT_MATCHER_ENABLED && !artifactGate.ok && !allowLowRiskNonBlockingArtifactGate) {
      const chips = buildRecoEntryChips(ctx && ctx.lang);
      const decision = pushGateDecision('artifact_missing_gate', {
        reason_codes: ['artifact_missing'],
      });
      if (decision && decision.mode === 'advisory') {
        enqueueGateAdvisory({
          gate_id: 'artifact_missing_gate',
          message:
            ctx && ctx.lang === 'CN'
              ? '我会先给你可执行推荐；补充 daylight + indoor_white 可进一步提升精准度。'
              : 'I will provide actionable recommendations first; adding daylight + indoor_white photos can further improve precision.',
          reason_codes: ['artifact_missing'],
          actions: ['upload_daylight_and_indoor_white', 'refine_profile'],
          chips: [...refinementChips, ...chips].slice(0, 8),
        });
        logger?.info?.(
          {
            request_id: ctx && ctx.request_id,
            trace_id: ctx && ctx.trace_id,
            artifact_reason: artifactGate.reason || 'artifact_missing',
          },
          'aurora bff: artifact gate downgraded to advisory',
        );
      }
    }

    if (AURORA_PRODUCT_MATCHER_ENABLED && !artifactGate.ok && allowLowRiskNonBlockingArtifactGate) {
      recordAuroraSkinFlowMetric({ stage: 'artifact_gate_nonblocking_low_risk', hit: true });
      logger?.info?.(
        {
          request_id: ctx && ctx.request_id,
          trace_id: ctx && ctx.trace_id,
          reason: artifactGate.reason || 'artifact_missing',
        },
        'aurora bff: bypassing artifact gate for low-risk skincare request',
      );
    }

    let mappedIngredientPlan = null;
    if (latestArtifact && AURORA_INGREDIENT_PLAN_ENABLED) {
      const latestArtifactId = String(latestArtifact.artifact_id || '').trim();
      try {
        const existingPlan = latestArtifactId
          ? await getIngredientPlanByArtifactIdFn({ artifactId: latestArtifactId })
          : null;
        if (existingPlan && existingPlan.plan_json && typeof existingPlan.plan_json === 'object') {
          mappedIngredientPlan = {
            ...existingPlan.plan_json,
            plan_id: existingPlan.plan_id,
            created_at: existingPlan.created_at || existingPlan.plan_json.created_at,
          };
        } else {
          const builtPlan = buildIngredientPlanFn({
            artifact: latestArtifact.artifact_json || latestArtifact,
            profile,
          });
          if (latestArtifactId) {
            const savedPlan = await saveIngredientPlanFn({
              artifactId: latestArtifactId,
              auroraUid: identity.auroraUid,
              userId: identity.userId,
              plan: builtPlan,
            });
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
        logger?.warn?.(
          { err: err && err.message ? err.message : String(err), request_id: ctx && ctx.request_id },
          'aurora bff: ingredient plan lookup/build failed',
        );
      }
    }

    const hasRecoArtifact = Boolean(latestArtifact && latestArtifact.artifact_json && typeof latestArtifact.artifact_json === 'object');
    const artifactConfidenceLevel =
      hasRecoArtifact && artifactGate && artifactGate.confidence_level
        ? artifactGate.confidence_level
        : 'unknown';
    const lowConfidenceArtifact = hasRecoArtifact && artifactConfidenceLevel === 'low';
    const artifactConfidenceScoreRaw = Number(
      latestArtifact &&
      latestArtifact.artifact_json &&
      latestArtifact.artifact_json.overall_confidence &&
      latestArtifact.artifact_json.overall_confidence.score,
    );
    const artifactConfidenceScore = Number.isFinite(artifactConfidenceScoreRaw) ? artifactConfidenceScoreRaw : null;

    return {
      latestArtifact,
      mappedIngredientPlan,
      artifactConfidenceLevel,
      artifactConfidenceScore,
      artifactGateOk: artifactGate ? artifactGate.ok : true,
      lowConfidenceArtifact,
    };
  }

  return {
    prepareRecoArtifactContext,
  };
}

module.exports = {
  createChatRecoArtifactRuntime,
};
