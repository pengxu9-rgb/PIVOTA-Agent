function ensureFunction(name, value) {
  if (typeof value === 'function') return value;
  throw new Error(`aurora skin analysis routes missing dependency: ${name}`);
}

function ensureSchema(name, value) {
  if (value && typeof value.safeParse === 'function') return value;
  throw new Error(`aurora skin analysis routes missing schema: ${name}`);
}

function mountSkinAnalysisRoutes(app, deps = {}) {
  const adjudicateDeepeningCanonicalLayer = ensureFunction('adjudicateDeepeningCanonicalLayer', deps.adjudicateDeepeningCanonicalLayer);
  const appendLatestArtifactToSessionPatch = ensureFunction('appendLatestArtifactToSessionPatch', deps.appendLatestArtifactToSessionPatch);
  const appendShadowIdToLastAnalysisForIdentity = ensureFunction('appendShadowIdToLastAnalysisForIdentity', deps.appendShadowIdToLastAnalysisForIdentity);
  const applyConfidenceCaps = ensureFunction('applyConfidenceCaps', deps.applyConfidenceCaps);
  const applyProductIntelGuardrailsToEnvelope = ensureFunction('applyProductIntelGuardrailsToEnvelope', deps.applyProductIntelGuardrailsToEnvelope);
  const assignExperiments = ensureFunction('assignExperiments', deps.assignExperiments);
  const attachRoutineExpertToAnalysis = ensureFunction('attachRoutineExpertToAnalysis', deps.attachRoutineExpertToAnalysis);
  const auroraChat = ensureFunction('auroraChat', deps.auroraChat);
  const buildAnalysisAssistantMessage = ensureFunction('buildAnalysisAssistantMessage', deps.buildAnalysisAssistantMessage);
  const buildAnalysisSuggestedChips = ensureFunction('buildAnalysisSuggestedChips', deps.buildAnalysisSuggestedChips);
  const buildConfidenceNoticeCardPayload = ensureFunction('buildConfidenceNoticeCardPayload', deps.buildConfidenceNoticeCardPayload);
  const buildContextPrefix = ensureFunction('buildContextPrefix', deps.buildContextPrefix);
  const buildDiagnosisArtifactV1 = ensureFunction('buildDiagnosisArtifactV1', deps.buildDiagnosisArtifactV1);
  const buildEnvelope = ensureFunction('buildEnvelope', deps.buildEnvelope);
  const buildExecutablePlanForAnalysis = ensureFunction('buildExecutablePlanForAnalysis', deps.buildExecutablePlanForAnalysis);
  const buildFactLayer = ensureFunction('buildFactLayer', deps.buildFactLayer);
  const buildIngredientPlan = ensureFunction('buildIngredientPlan', deps.buildIngredientPlan);
  const buildIngredientPlanCard = ensureFunction('buildIngredientPlanCard', deps.buildIngredientPlanCard);
  const buildInputHashPrefix = ensureFunction('buildInputHashPrefix', deps.buildInputHashPrefix);
  const buildLowConfidenceBaselineSkinAnalysis = ensureFunction('buildLowConfidenceBaselineSkinAnalysis', deps.buildLowConfidenceBaselineSkinAnalysis);
  const buildMainlineDeepeningDto = ensureFunction('buildMainlineDeepeningDto', deps.buildMainlineDeepeningDto);
  const buildPivotaBackendAuthHeaders = ensureFunction('buildPivotaBackendAuthHeaders', deps.buildPivotaBackendAuthHeaders);
  const buildQualityObject = ensureFunction('buildQualityObject', deps.buildQualityObject);
  const buildReportSignalsDto = ensureFunction('buildReportSignalsDto', deps.buildReportSignalsDto);
  const buildRequestContext = ensureFunction('buildRequestContext', deps.buildRequestContext);
  const buildRetakeSkinAnalysis = ensureFunction('buildRetakeSkinAnalysis', deps.buildRetakeSkinAnalysis);
  const buildRoutineFitRetryPrompt = ensureFunction('buildRoutineFitRetryPrompt', deps.buildRoutineFitRetryPrompt);
  const buildRoutineFitSummaryCard = ensureFunction('buildRoutineFitSummaryCard', deps.buildRoutineFitSummaryCard);
  const buildRoutineFitSummaryPrompt = ensureFunction('buildRoutineFitSummaryPrompt', deps.buildRoutineFitSummaryPrompt);
  const buildRuleBasedSkinAnalysis = ensureFunction('buildRuleBasedSkinAnalysis', deps.buildRuleBasedSkinAnalysis);
  const buildSkinAnalysisFromDiagnosisV1 = ensureFunction('buildSkinAnalysisFromDiagnosisV1', deps.buildSkinAnalysisFromDiagnosisV1);
  const buildVisionPhotoNotice = ensureFunction('buildVisionPhotoNotice', deps.buildVisionPhotoNotice);
  const buildVisionSignalsDto = ensureFunction('buildVisionSignalsDto', deps.buildVisionSignalsDto);
  const chooseVisionPhoto = ensureFunction('chooseVisionPhoto', deps.chooseVisionPhoto);
  const classifyPhotoQuality = ensureFunction('classifyPhotoQuality', deps.classifyPhotoQuality);
  const classifyVisionAvailability = ensureFunction('classifyVisionAvailability', deps.classifyVisionAvailability);
  const createStageProfiler = ensureFunction('createStageProfiler', deps.createStageProfiler);
  const dedupeAndCapOutput = ensureFunction('dedupeAndCapOutput', deps.dedupeAndCapOutput);
  const deepScanRoutineProductCandidate = ensureFunction('deepScanRoutineProductCandidate', deps.deepScanRoutineProductCandidate);
  const derivePregnancyPolicyPatch = ensureFunction('derivePregnancyPolicyPatch', deps.derivePregnancyPolicyPatch);
  const deriveSkinDegradeMeta = ensureFunction('deriveSkinDegradeMeta', deps.deriveSkinDegradeMeta);
  const detectInsufficientVisualDetail = ensureFunction('detectInsufficientVisualDetail', deps.detectInsufficientVisualDetail);
  const downgradeSkinAnalysisConfidence = ensureFunction('downgradeSkinAnalysisConfidence', deps.downgradeSkinAnalysisConfidence);
  const enrichPhotoModulesCardWithIngredientProductsBounded = ensureFunction('enrichPhotoModulesCardWithIngredientProductsBounded', deps.enrichPhotoModulesCardWithIngredientProductsBounded);
  const ensureRetakeFeatureObservation = ensureFunction('ensureRetakeFeatureObservation', deps.ensureRetakeFeatureObservation);
  const executeAuroraOptionalStep = ensureFunction('executeAuroraOptionalStep', deps.executeAuroraOptionalStep);
  const extractProfilePatchFromRoutinePayload = ensureFunction('extractProfilePatchFromRoutinePayload', deps.extractProfilePatchFromRoutinePayload);
  const extractRoutineProductCandidatesForDeepScan = ensureFunction('extractRoutineProductCandidatesForDeepScan', deps.extractRoutineProductCandidatesForDeepScan);
  const fetchPhotoBytesFromPivotaBackend = ensureFunction('fetchPhotoBytesFromPivotaBackend', deps.fetchPhotoBytesFromPivotaBackend);
  const finalizeSkinAnalysisContract = ensureFunction('finalizeSkinAnalysisContract', deps.finalizeSkinAnalysisContract);
  const getDiagRolloutDecision = ensureFunction('getDiagRolloutDecision', deps.getDiagRolloutDecision);
  const getProfileForIdentity = ensureFunction('getProfileForIdentity', deps.getProfileForIdentity);
  const getRecentSkinLogsForIdentity = ensureFunction('getRecentSkinLogsForIdentity', deps.getRecentSkinLogsForIdentity);
  const hasUsableArtifactForRecommendations = ensureFunction('hasUsableArtifactForRecommendations', deps.hasUsableArtifactForRecommendations);
  const humanizeLlmReasons = ensureFunction('humanizeLlmReasons', deps.humanizeLlmReasons);
  const inferDetectorConfidence = ensureFunction('inferDetectorConfidence', deps.inferDetectorConfidence);
  const inferDeviceClassForMetrics = ensureFunction('inferDeviceClassForMetrics', deps.inferDeviceClassForMetrics);
  const isGeminiSkinGatewayAvailable = ensureFunction('isGeminiSkinGatewayAvailable', deps.isGeminiSkinGatewayAvailable);
  const isPlainObject = ensureFunction('isPlainObject', deps.isPlainObject);
  const makeAssistantMessage = ensureFunction('makeAssistantMessage', deps.makeAssistantMessage);
  const makeEvent = ensureFunction('makeEvent', deps.makeEvent);
  const maybeBuildPhotoModulesCardForAnalysis = ensureFunction('maybeBuildPhotoModulesCardForAnalysis', deps.maybeBuildPhotoModulesCardForAnalysis);
  const maybeInferSkinMaskForPhotoModules = ensureFunction('maybeInferSkinMaskForPhotoModules', deps.maybeInferSkinMaskForPhotoModules);
  const mergeFinalContractIntoAnalysis = ensureFunction('mergeFinalContractIntoAnalysis', deps.mergeFinalContractIntoAnalysis);
  const mergePhotoFindingsIntoAnalysis = ensureFunction('mergePhotoFindingsIntoAnalysis', deps.mergePhotoFindingsIntoAnalysis);
  const normalizePipelineVersionForMetrics = ensureFunction('normalizePipelineVersionForMetrics', deps.normalizePipelineVersionForMetrics);
  const normalizeQualityGradeForMetrics = ensureFunction('normalizeQualityGradeForMetrics', deps.normalizeQualityGradeForMetrics);
  const normalizeReportFailureReason = ensureFunction('normalizeReportFailureReason', deps.normalizeReportFailureReason);
  const normalizeVisionReason = ensureFunction('normalizeVisionReason', deps.normalizeVisionReason);
  const parseRoutineFitUpstreamResult = ensureFunction('parseRoutineFitUpstreamResult', deps.parseRoutineFitUpstreamResult);
  const persistRejectedCatalogCandidates = ensureFunction('persistRejectedCatalogCandidates', deps.persistRejectedCatalogCandidates);
  const pickPrimaryVisionReason = ensureFunction('pickPrimaryVisionReason', deps.pickPrimaryVisionReason);
  const recordAnalyzeRequest = ensureFunction('recordAnalyzeRequest', deps.recordAnalyzeRequest);
  const recordAuroraSkinAnalysisRealModel = ensureFunction('recordAuroraSkinAnalysisRealModel', deps.recordAuroraSkinAnalysisRealModel);
  const recordAuroraSkinFallbackDeterministic = ensureFunction('recordAuroraSkinFallbackDeterministic', deps.recordAuroraSkinFallbackDeterministic);
  const recordAuroraSkinFlowMetric = ensureFunction('recordAuroraSkinFlowMetric', deps.recordAuroraSkinFlowMetric);
  const recordAuroraSkinLlmCall = ensureFunction('recordAuroraSkinLlmCall', deps.recordAuroraSkinLlmCall);
  const recordAuroraSkinLlmRetry = ensureFunction('recordAuroraSkinLlmRetry', deps.recordAuroraSkinLlmRetry);
  const recordAuroraSkinLlmRetrySuccess = ensureFunction('recordAuroraSkinLlmRetrySuccess', deps.recordAuroraSkinLlmRetrySuccess);
  const recordAuroraSkinLlmSchemaViolation = ensureFunction('recordAuroraSkinLlmSchemaViolation', deps.recordAuroraSkinLlmSchemaViolation);
  const recordAuroraSkinMainlineProvider = ensureFunction('recordAuroraSkinMainlineProvider', deps.recordAuroraSkinMainlineProvider);
  const recordAuroraSkinSemanticGuard = ensureFunction('recordAuroraSkinSemanticGuard', deps.recordAuroraSkinSemanticGuard);
  const recordAuroraSkinShadowVerifyIsolatedWrite = ensureFunction('recordAuroraSkinShadowVerifyIsolatedWrite', deps.recordAuroraSkinShadowVerifyIsolatedWrite);
  const recordAuroraSkinUsefulOutput = ensureFunction('recordAuroraSkinUsefulOutput', deps.recordAuroraSkinUsefulOutput);
  const recordEnsembleAgreementScore = ensureFunction('recordEnsembleAgreementScore', deps.recordEnsembleAgreementScore);
  const recordEnsembleProviderResult = ensureFunction('recordEnsembleProviderResult', deps.recordEnsembleProviderResult);
  const recordGeometrySanitizerTotals = ensureFunction('recordGeometrySanitizerTotals', deps.recordGeometrySanitizerTotals);
  const recordVerifyAgreementScore = ensureFunction('recordVerifyAgreementScore', deps.recordVerifyAgreementScore);
  const recordVerifyBudgetGuard = ensureFunction('recordVerifyBudgetGuard', deps.recordVerifyBudgetGuard);
  const recordVerifyCall = ensureFunction('recordVerifyCall', deps.recordVerifyCall);
  const recordVerifyCircuitOpen = ensureFunction('recordVerifyCircuitOpen', deps.recordVerifyCircuitOpen);
  const recordVerifyFail = ensureFunction('recordVerifyFail', deps.recordVerifyFail);
  const recordVerifyHardCase = ensureFunction('recordVerifyHardCase', deps.recordVerifyHardCase);
  const recordVerifyRetry = ensureFunction('recordVerifyRetry', deps.recordVerifyRetry);
  const recordVisionDecision = ensureFunction('recordVisionDecision', deps.recordVisionDecision);
  const renderDeepeningCanonicalLayer = ensureFunction('renderDeepeningCanonicalLayer', deps.renderDeepeningCanonicalLayer);
  const requestPhotoDownloadUrlOnce = ensureFunction('requestPhotoDownloadUrlOnce', deps.requestPhotoDownloadUrlOnce);
  const requireAuroraUid = ensureFunction('requireAuroraUid', deps.requireAuroraUid);
  const resolveIdentity = ensureFunction('resolveIdentity', deps.resolveIdentity);
  const resolveRoutineFitAnalysisPlan = ensureFunction('resolveRoutineFitAnalysisPlan', deps.resolveRoutineFitAnalysisPlan);
  const runGeminiDeepeningStrategyImpl = ensureFunction('runGeminiDeepeningStrategyImpl', deps.runGeminiDeepeningStrategyImpl);
  const runGeminiReportStrategyImpl = ensureFunction('runGeminiReportStrategyImpl', deps.runGeminiReportStrategyImpl);
  const runGeminiShadowVerify = ensureFunction('runGeminiShadowVerify', deps.runGeminiShadowVerify);
  const runGeminiVisionStrategyImpl = ensureFunction('runGeminiVisionStrategyImpl', deps.runGeminiVisionStrategyImpl);
  const runSkinDiagnosisV1 = ensureFunction('runSkinDiagnosisV1', deps.runSkinDiagnosisV1);
  const sampleHardCase = ensureFunction('sampleHardCase', deps.sampleHardCase);
  const saveDiagnosisArtifact = ensureFunction('saveDiagnosisArtifact', deps.saveDiagnosisArtifact);
  const saveIngredientPlan = ensureFunction('saveIngredientPlan', deps.saveIngredientPlan);
  const saveLastAnalysisForIdentity = ensureFunction('saveLastAnalysisForIdentity', deps.saveLastAnalysisForIdentity);
  const saveShadowVerifyForIdentity = ensureFunction('saveShadowVerifyForIdentity', deps.saveShadowVerifyForIdentity);
  const scheduleSkinAnalysisKbBackfill = ensureFunction('scheduleSkinAnalysisKbBackfill', deps.scheduleSkinAnalysisKbBackfill);
  const shouldCallLlm = ensureFunction('shouldCallLlm', deps.shouldCallLlm);
  const summarizeDiagnosisForPolicy = ensureFunction('summarizeDiagnosisForPolicy', deps.summarizeDiagnosisForPolicy);
  const summarizeProfileForContext = ensureFunction('summarizeProfileForContext', deps.summarizeProfileForContext);
  const toNullableInt = ensureFunction('toNullableInt', deps.toNullableInt);
  const toNullableNumber = ensureFunction('toNullableNumber', deps.toNullableNumber);
  const upsertProfileForIdentity = ensureFunction('upsertProfileForIdentity', deps.upsertProfileForIdentity);
  const utcTodayIsoDate = ensureFunction('utcTodayIsoDate', deps.utcTodayIsoDate);
  const withTimeout = ensureFunction('withTimeout', deps.withTimeout);
  const SkinAnalysisRequestSchema = ensureSchema('SkinAnalysisRequestSchema', deps.SkinAnalysisRequestSchema);
  const logger = deps && typeof deps.logger === 'object' ? deps.logger : null;
  const AURORA_AURORAAPP_PHOTO_PIPELINE_ENABLED = deps.AURORA_AURORAAPP_PHOTO_PIPELINE_ENABLED;
  const AURORA_BFF_ANALYSIS_BUDGET_MS = deps.AURORA_BFF_ANALYSIS_BUDGET_MS;
  const AURORA_DECISION_BASE_URL = deps.AURORA_DECISION_BASE_URL;
  const AURORA_DIAG_ARTIFACT_ENABLED = deps.AURORA_DIAG_ARTIFACT_ENABLED;
  const AURORA_INGREDIENT_PLAN_ENABLED = deps.AURORA_INGREDIENT_PLAN_ENABLED;
  const AURORA_LLM_OPENAI_FALLBACK_ENABLED = deps.AURORA_LLM_OPENAI_FALLBACK_ENABLED;
  const AURORA_LLM_QA_MIN_REMAINING_BUDGET_MS = deps.AURORA_LLM_QA_MIN_REMAINING_BUDGET_MS;
  const AURORA_LLM_QA_MODE = deps.AURORA_LLM_QA_MODE;
  const AURORA_LLM_SINGLE_PROVIDER = deps.AURORA_LLM_SINGLE_PROVIDER;
  const AURORA_PRODUCT_RELEVANCE_QA_MODE = deps.AURORA_PRODUCT_RELEVANCE_QA_MODE;
  const AURORA_ROUTINE_PRODUCT_AUTOSCAN_ENABLED = deps.AURORA_ROUTINE_PRODUCT_AUTOSCAN_ENABLED;
  const AURORA_ROUTINE_PRODUCT_AUTOSCAN_TIMEOUT_MS = deps.AURORA_ROUTINE_PRODUCT_AUTOSCAN_TIMEOUT_MS;
  const AURORA_ROUTINE_PRODUCT_AUTOSCAN_TOTAL_LIMIT = deps.AURORA_ROUTINE_PRODUCT_AUTOSCAN_TOTAL_LIMIT;
  const AURORA_RULE_RELAX_AGGRESSIVE = deps.AURORA_RULE_RELAX_AGGRESSIVE;
  const AURORA_RULE_RELAX_MODE = deps.AURORA_RULE_RELAX_MODE;
  const DIAG_VERIFY_ALLOW_GUARD_TEST = deps.DIAG_VERIFY_ALLOW_GUARD_TEST;
  const PIVOTA_BACKEND_BASE_URL = deps.PIVOTA_BACKEND_BASE_URL;
  const ROUTINE_FIT_DIMENSION_KEYS = deps.ROUTINE_FIT_DIMENSION_KEYS;
  const ROUTINE_FIT_REQUIRED_STRUCTURED_KEYS = deps.ROUTINE_FIT_REQUIRED_STRUCTURED_KEYS;
  const SKIN_DEGRADED_MODE = deps.SKIN_DEGRADED_MODE;
  const SKIN_VISION_ENABLED = deps.SKIN_VISION_ENABLED;
  const SKIN_VISION_FORCE_CALL = deps.SKIN_VISION_FORCE_CALL;
  const SKIN_VISION_MODEL_GEMINI = deps.SKIN_VISION_MODEL_GEMINI;
  const VisionUnavailabilityReason = deps.VisionUnavailabilityReason;
  app.post('/v1/analysis/skin', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    const rollout = getDiagRolloutDecision({ requestId: ctx.request_id });
    const outputPipelineVersion = rollout.shadowMode ? 'legacy' : rollout.selectedVersion;
    const shadowRunV2 = rollout.shadowMode && rollout.selectedVersion === 'v2';

    logger?.info(
      {
        kind: 'diag_rollout',
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
        output_pipeline_version: outputPipelineVersion,
        selected_pipeline_version: rollout.selectedVersion,
        reason: rollout.reason,
        shadow_mode: rollout.shadowMode,
        canary_percent: rollout.canaryPercent,
        canary_bucket: rollout.canaryBucket,
        llm_kill_switch: rollout.llmKillSwitch,
      },
      'aurora bff: diag rollout decision',
    );
    try {
      requireAuroraUid(ctx);
      const parsed = SkinAnalysisRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', details: parsed.error.format() } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      recordAuroraSkinFlowMetric({ stage: 'analysis_request', hit: true });

      const identity = await resolveIdentity(req, ctx);
      const runOnce = async ({ pipelineVersion, persistLastAnalysis, shadowRun } = {}) => {
        const profiler = createStageProfiler();
        profiler.skip('face', 'not_implemented');
        profiler.skip('skin_roi', 'not_implemented');

        const experiments = assignExperiments({ requestId: ctx.request_id });
        const experimentsSlim = Array.isArray(experiments.assignments)
          ? experiments.assignments
              .map((a) => ({
                experiment_id: a.experiment_id,
                kind: a.kind,
                variant: a.variant,
                ...(typeof a.bucket === 'number' ? { bucket: a.bucket } : {}),
                ...(a.reason ? { reason: a.reason } : {}),
              }))
              .slice(0, 8)
          : [];
        if (experiments.error) {
          logger?.warn(
            { err: String(experiments.error), request_id: ctx.request_id, trace_id: ctx.trace_id },
            'aurora bff: experiments config invalid',
          );
        }

        const qualityGateConfig =
          experiments.byKind && experiments.byKind.quality_gate && experiments.byKind.quality_gate.params
            ? experiments.byKind.quality_gate.params
            : null;
        const severityThresholdsOverrides =
          experiments.byKind && experiments.byKind.severity_mapping && experiments.byKind.severity_mapping.params
            ? experiments.byKind.severity_mapping.params
            : null;
        const promptParams =
          experiments.byKind && experiments.byKind.llm_prompt && experiments.byKind.llm_prompt.params
            ? experiments.byKind.llm_prompt.params
            : null;
        const promptVersionFromParams =
          promptParams && typeof promptParams.prompt_version === 'string' && promptParams.prompt_version.trim()
            ? promptParams.prompt_version.trim()
            : null;
        const promptVersion =
          promptVersionFromParams ||
          (experiments.byKind &&
          experiments.byKind.llm_prompt &&
          typeof experiments.byKind.llm_prompt.variant === 'string' &&
          experiments.byKind.llm_prompt.variant &&
          experiments.byKind.llm_prompt.variant !== 'holdout'
            ? experiments.byKind.llm_prompt.variant
            : null);

        let profile = null;
        let recentLogs = [];
        let pregnancyPolicyEvents = [];
        profiler.start('quality', { kind: 'memory' });
        try {
          const [profileRes, logsRes] = await Promise.allSettled([
            getProfileForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId }),
            getRecentSkinLogsForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId }, 7),
          ]);
          if (profileRes.status === 'fulfilled') profile = profileRes.value;
          else {
            const r = profileRes.reason;
            logger?.warn(
              { err: r && (r.code || r.message) ? String(r.code || r.message) : String(r) },
              'aurora bff: failed to load profile',
            );
          }
          if (logsRes.status === 'fulfilled') recentLogs = logsRes.value;
          else {
            const r = logsRes.reason;
            logger?.warn(
              { err: r && (r.code || r.message) ? String(r.code || r.message) : String(r) },
              'aurora bff: failed to load recent logs',
            );
          }
        } catch (err) {
          logger?.warn({ err: err.code || err.message }, 'aurora bff: failed to load memory context');
        }

        const pregnancyPolicyForDiagnosis = derivePregnancyPolicyPatch({
          profile,
          message: '',
          todayUtc: utcTodayIsoDate(),
        });
        if (pregnancyPolicyForDiagnosis && Array.isArray(pregnancyPolicyForDiagnosis.events)) {
          pregnancyPolicyEvents = pregnancyPolicyForDiagnosis.events
            .filter((evt) => evt && typeof evt === 'object' && evt.event_name)
            .map((evt) => makeEvent(ctx, evt.event_name, evt.data && typeof evt.data === 'object' ? evt.data : {}));
        }
        if (pregnancyPolicyForDiagnosis && pregnancyPolicyForDiagnosis.patch) {
          profile = { ...(profile || {}), ...pregnancyPolicyForDiagnosis.patch };
          if (persistLastAnalysis) {
            try {
              profile = await upsertProfileForIdentity(
                { auroraUid: identity.auroraUid, userId: identity.userId },
                pregnancyPolicyForDiagnosis.patch,
              );
            } catch (err) {
              logger?.warn({ err: err.code || err.message }, 'aurora bff: failed to persist diagnosis pregnancy policy patch');
            }
          }
        }

        const photos = Array.isArray(parsed.data.photos) ? parsed.data.photos : [];
        const photoQcParts = [];
        const passedPhotos = [];
        const degradedPhotos = [];
        const failedPhotos = [];
        let photosSubmittedCount = 0;
        for (const p of photos) {
          const slot = String(p.slot_id || '').trim();
          const qc = String(p.qc_status || '').trim().toLowerCase();
          const photoId = typeof p.photo_id === 'string' ? p.photo_id.trim() : '';
          if (slot && qc) photoQcParts.push(`${slot}:${qc}`);
          if (!slot || !photoId) continue;
          photosSubmittedCount += 1;
          const entry = { slot_id: slot, photo_id: photoId, qc_status: qc || 'unknown' };
          if (qc === 'passed' || qc === 'pass' || qc === 'ok') passedPhotos.push(entry);
          else if (qc === 'degraded' || qc === 'warn' || qc === 'warning' || qc === 'low' || !qc) degradedPhotos.push(entry);
          else if (qc === 'fail' || qc === 'failed' || qc === 'reject' || qc === 'rejected' || qc === 'bad') failedPhotos.push(entry);
          else degradedPhotos.push(entry);
        }
        const photosProvided = photosSubmittedCount > 0;
        let photoQuality = classifyPhotoQuality(photos);

        let profileSummary = summarizeProfileForContext(profile);
        const recentLogsSummary = Array.isArray(recentLogs) ? recentLogs.slice(0, 7) : [];
        const routineFromRequest = parsed.data.currentRoutine;
        const routineDerivedProfilePatch = extractProfilePatchFromRoutinePayload(routineFromRequest);

        if (routineFromRequest !== undefined) {
          // Best-effort persistence. Analysis should still proceed even if storage is unavailable.
          profile = {
            ...(profile || {}),
            ...(routineDerivedProfilePatch && typeof routineDerivedProfilePatch === 'object' ? routineDerivedProfilePatch : {}),
            currentRoutine: routineFromRequest,
          };
          if (persistLastAnalysis) {
            try {
              profile = await upsertProfileForIdentity(
                { auroraUid: identity.auroraUid, userId: identity.userId },
                {
                  ...(routineDerivedProfilePatch && typeof routineDerivedProfilePatch === 'object' ? routineDerivedProfilePatch : {}),
                  currentRoutine: routineFromRequest,
                },
              );
            } catch (err) {
              logger?.warn({ err: err.code || err.message }, 'aurora bff: failed to persist current routine for analysis');
            }
          }
          profileSummary = summarizeProfileForContext(profile);
        }

        const routineCandidate = routineFromRequest !== undefined ? routineFromRequest : profileSummary && profileSummary.currentRoutine;
        const hasRoutine = Boolean(
          routineCandidate != null &&
            (typeof routineCandidate === 'string'
              ? String(routineCandidate).trim().length > 0
              : Array.isArray(routineCandidate)
                ? routineCandidate.length > 0
                : typeof routineCandidate === 'object'
                  ? Object.keys(routineCandidate).length > 0
                  : false),
        );
        const routineProductCandidates =
          AURORA_ROUTINE_PRODUCT_AUTOSCAN_ENABLED && hasRoutine
            ? extractRoutineProductCandidatesForDeepScan(routineCandidate, {
              maxTotal: AURORA_ROUTINE_PRODUCT_AUTOSCAN_TOTAL_LIMIT,
            })
            : [];
        profiler.end('quality', { kind: 'memory', has_routine: hasRoutine, logs_n: recentLogsSummary.length });

        // "Dual input" policy:
        // - routine/recent logs are primary for personalization
        // - when photos are explicitly provided, allow a photo-first path so LLM/photo analysis is not blocked
        const hasPrimaryInput = hasRoutine || recentLogsSummary.length > 0;

        const userRequestedPhoto =
          parsed.data.use_photo === true || (parsed.data.use_photo == null && photosProvided);
        const hasPhotoPrimaryInput = Boolean(userRequestedPhoto && photosProvided);
        const hasLlmPrimaryInput = hasPrimaryInput || hasPhotoPrimaryInput;
        const forceVisionCall = Boolean(SKIN_VISION_FORCE_CALL && userRequestedPhoto && photosProvided && hasLlmPrimaryInput);
        const detectorConfidence = inferDetectorConfidence({ profileSummary, recentLogsSummary, routineCandidate });
        const selectedVisionProvider = {
          provider: 'gemini',
          requested: 'gemini_locked_mainline',
          apiKeyConfigured: isGeminiSkinGatewayAvailable(),
        };
        const visionAvailability = classifyVisionAvailability({
          enabled: SKIN_VISION_ENABLED,
          apiKeyConfigured: selectedVisionProvider.apiKeyConfigured,
        });
        const visionAvailable = visionAvailability.available && !rollout.llmKillSwitch;
        const reportAvailable = Boolean(selectedVisionProvider.apiKeyConfigured) && !rollout.llmKillSwitch;

        const analysisFieldMissing = [];
        const qualityReportReasons = [];
        const photoFailureCodes = [];
        let usedPhotos = false;
        let analysisSource = 'rule_based';
        let visionRuntime = null;
        let visionDecisionForReport = null;
        let visionLayer = null;
        let reportLayer = null;
        let reportCanonical = null;
        let deepeningRuntime = null;
        let llmInputHash = null;
        let llmInputHashPrefix = null;
        let deterministicFallbackReason = null;
        let reportModelCalled = false;
        let reportModelErrored = false;
        let reportModelErrorReason = null;

        let diagnosisPhoto = null;
        let diagnosisPhotoBytes = null;
        let shadowVerifyPhotoBytes = null;
        let photoModulesSourcePhoto = null;
        let diagnosisV1 = null;
        let diagnosisV1Internal = null;
        let diagnosisPolicy = null;
        function recordPhotoFailure(code, detail) {
          const failureCode = String(code || '').trim().toUpperCase() || 'DOWNLOAD_URL_GENERATE_FAILED';
          if (!photoFailureCodes.includes(failureCode)) photoFailureCodes.push(failureCode);
          analysisFieldMissing.push({ field: 'analysis.used_photos', reason: failureCode });
          if (detail) {
            logger?.warn({ code: failureCode, detail }, 'aurora bff: photo fetch failure');
          }
        }

        if (rollout.llmKillSwitch) {
          if (ctx.lang === 'CN') qualityReportReasons.push('系统已开启 LLM 总开关：本次会强制跳过所有模型调用。');
          else qualityReportReasons.push('LLM kill switch is enabled: skipping all model calls for this request.');
        }

        function mergePhotoQuality(baseQuality, extraQuality, { extraPrefix } = {}) {
          const base = baseQuality && typeof baseQuality === 'object' ? baseQuality : { grade: 'unknown', reasons: [] };
          const extra = extraQuality && typeof extraQuality === 'object' ? extraQuality : null;
          if (!extra) return base;
          const order = { unknown: 0, pass: 1, degraded: 2, fail: 3 };
          const g0 = String(base.grade || 'unknown').trim().toLowerCase();
          const g1 = String(extra.grade || 'unknown').trim().toLowerCase();
          const grade0 = order[g0] != null ? g0 : 'unknown';
          const grade1 = order[g1] != null ? g1 : 'unknown';
          const mergedGrade = order[grade1] > order[grade0] ? grade1 : grade0;
          const r0 = Array.isArray(base.reasons) ? base.reasons : [];
          const r1raw = Array.isArray(extra.reasons) ? extra.reasons : [];
          const r1 = extraPrefix ? r1raw.map((r) => `${extraPrefix}${r}`) : r1raw;
          const mergedReasons = Array.from(new Set([...r0, ...r1])).slice(0, 10);
          return { grade: mergedGrade, reasons: mergedReasons };
        }

        if (hasPhotoPrimaryInput && (photoQuality.grade !== 'fail' || AURORA_RULE_RELAX_AGGRESSIVE)) {
          const candidates = photoQuality.grade === 'pass' ? passedPhotos : degradedPhotos.length ? degradedPhotos : passedPhotos;
          diagnosisPhoto = chooseVisionPhoto(candidates);
          if (!diagnosisPhoto) {
            analysisFieldMissing.push({ field: 'analysis.used_photos', reason: 'no_usable_photo' });
            if (ctx.lang === 'CN') qualityReportReasons.push('没有可用的照片（缺少 photo_id 或未通过质量门槛）；我会跳过照片检测。');
            else qualityReportReasons.push('No usable photo (missing photo_id or failed quality gate); skipping photo checks.');
          } else {
            photoModulesSourcePhoto = {
              slot_id: diagnosisPhoto.slot_id,
              photo_id: diagnosisPhoto.photo_id,
            };
            try {
              profiler.start('decode', { kind: 'photo_fetch', slot: diagnosisPhoto.slot_id, purpose: 'diagnosis_v1' });
              const resp = await fetchPhotoBytesFromPivotaBackend({ req, photoId: diagnosisPhoto.photo_id });
              if (resp && resp.ok) {
                diagnosisPhotoBytes = resp.buffer;
                shadowVerifyPhotoBytes = diagnosisPhotoBytes;
              } else {
                recordPhotoFailure(resp && (resp.failure_code || resp.reason), resp && resp.detail);
              }
              profiler.end('decode', {
                kind: 'photo_fetch',
                slot: diagnosisPhoto.slot_id,
                purpose: 'diagnosis_v1',
                ok: Boolean(diagnosisPhotoBytes),
                bytes: diagnosisPhotoBytes ? diagnosisPhotoBytes.length : 0,
              });
            } catch (err) {
              recordPhotoFailure('DOWNLOAD_URL_FETCH_5XX', err && err.message ? err.message : null);
              profiler.fail('decode', err, { kind: 'photo_fetch', slot: diagnosisPhoto.slot_id, purpose: 'diagnosis_v1' });
              logger?.warn({ err: err.message }, 'aurora bff: failed to fetch photo bytes for diagnosis');
            }

	            if (diagnosisPhotoBytes) {
	              const diag = await runSkinDiagnosisV1({
	                imageBuffer: diagnosisPhotoBytes,
	                language: ctx.lang,
	                profileSummary,
	                recentLogsSummary,
	                profiler,
                  qualityGateConfig,
                  severityThresholdsOverrides,
	              });
	              if (diag && diag.ok && diag.diagnosis) {
	                diagnosisV1 = diag.diagnosis;
	                diagnosisV1Internal = diag.internal || null;
	                diagnosisPolicy = summarizeDiagnosisForPolicy(diagnosisV1);
	                usedPhotos = true;
	                shadowVerifyPhotoBytes = diagnosisPhotoBytes;
	                const dq = diagnosisV1 && diagnosisV1.quality && typeof diagnosisV1.quality === 'object' ? diagnosisV1.quality : null;
	                if (dq && typeof dq.grade === 'string') photoQuality = mergePhotoQuality(photoQuality, dq, { extraPrefix: 'pixel_' });
                if (dq && dq.grade === 'fail') {
                  if (ctx.lang === 'CN') qualityReportReasons.push('照片像素质量未通过（模糊/光照/白平衡/覆盖不足等）；为避免误判我会建议重拍。');
                  else
                    qualityReportReasons.push(
                      'Pixel-level photo quality did not pass (blur/lighting/WB/coverage); recommending a retake to avoid wrong guesses.',
                    );
                } else if (dq && dq.grade === 'degraded') {
                  if (ctx.lang === 'CN') qualityReportReasons.push('照片质量一般：我会更保守，并减少/避免无效模型调用。');
                  else qualityReportReasons.push('Photo quality is degraded: keeping conclusions conservative and reducing unnecessary model calls.');
                }
              } else if (diag && !diag.ok) {
                const reason = String(diag.reason || 'diagnosis_failed');
                photoQuality = mergePhotoQuality(photoQuality, { grade: 'fail', reasons: [reason] }, { extraPrefix: 'pixel_' });
                if (ctx.lang === 'CN') qualityReportReasons.push(`照片检测未能稳定完成（${reason}）；为避免误判建议重拍。`);
                else qualityReportReasons.push(`Photo checks could not complete reliably (${reason}); recommending a retake to avoid wrong guesses.`);
                if (!analysisFieldMissing.some((f) => f && f.field === 'analysis.used_photos' && f.reason === 'diagnosis_failed')) {
                  analysisFieldMissing.push({ field: 'analysis.used_photos', reason: 'diagnosis_failed' });
                }
              }
            }
          }
        }

        const qualityForReport = userRequestedPhoto && photosProvided ? photoQuality : { grade: 'pass', reasons: ['no_photo'] };
        const policyDetectorConfidenceLevel = diagnosisPolicy ? diagnosisPolicy.detector_confidence_level : detectorConfidence.level;
        const policyUncertainty = diagnosisPolicy ? diagnosisPolicy.uncertainty : null;

        const visionDecision = rollout.llmKillSwitch
          ? { decision: 'skip', reasons: ['llm_kill_switch'], downgrade_confidence: true }
          : forceVisionCall
            ? { decision: 'call', reasons: ['force_vision_call'], downgrade_confidence: true }
            : shouldCallLlm({
                kind: 'vision',
                quality: photoQuality,
                hasPrimaryInput: hasLlmPrimaryInput,
                userRequestedPhoto,
                detectorConfidenceLevel: policyDetectorConfidenceLevel,
                uncertainty: policyUncertainty,
                visionAvailable,
                visionUnavailabilityReason: visionAvailability.reason,
                reportAvailable,
                degradedMode: SKIN_DEGRADED_MODE,
              });
        let reportDecision = rollout.llmKillSwitch
          ? { decision: 'skip', reasons: ['llm_kill_switch'], downgrade_confidence: true }
          : shouldCallLlm({
              kind: 'report',
              quality: qualityForReport,
              hasPrimaryInput: hasLlmPrimaryInput,
              userRequestedPhoto,
              detectorConfidenceLevel: policyDetectorConfidenceLevel,
              uncertainty: policyUncertainty,
              visionAvailable,
              reportAvailable,
              degradedMode: SKIN_DEGRADED_MODE,
            });
        const forceReportOnPhotoFetchFailure = Boolean(
            !rollout.llmKillSwitch &&
            userRequestedPhoto &&
            photosProvided &&
            hasLlmPrimaryInput &&
            reportAvailable &&
            photoFailureCodes.length > 0 &&
            reportDecision.decision !== 'call',
        );
        if (forceReportOnPhotoFetchFailure) {
          reportDecision = {
            decision: 'call',
            reasons: ['photo_fetch_failed_force_report'],
            downgrade_confidence: true,
          };
          if (ctx.lang === 'CN') {
            qualityReportReasons.push('照片上传已通过但读取失败：强制调用报告模型给出保守解释与下一步。');
          } else {
            qualityReportReasons.push(
              'Photo upload passed but image bytes could not be read: forcing report model for conservative guidance.',
            );
          }
        }
        let analysis = null;
        let retakeFallbackAnalysis = null;
        if (hasPhotoPrimaryInput && !hasPrimaryInput) {
          if (ctx.lang === 'CN') {
            qualityReportReasons.push('缺少 routine/recent logs：本次改为“照片优先 + 保守解释”，并建议补充日常流程提升准确性。');
          } else {
            qualityReportReasons.push(
              'Routine/recent logs are missing: proceeding with photo-first analysis and conservative interpretation.',
            );
          }
        }

        if (userRequestedPhoto && photosProvided && photoQuality.grade === 'fail' && !forceVisionCall && !AURORA_RULE_RELAX_AGGRESSIVE) {
          retakeFallbackAnalysis = profiler.timeSync('detector', () => buildRetakeSkinAnalysis({ language: ctx.lang, photoQuality }), {
            kind: 'retake',
          });
          if (ctx.lang === 'CN') qualityReportReasons.push('照片质量未通过：我不会调用 AI 做皮肤结论，避免误判；建议按提示重拍。');
          else qualityReportReasons.push('Photo quality failed: skipping all AI analysis to avoid guessy results; please retake.');
        } else if (userRequestedPhoto && photosProvided && photoQuality.grade === 'fail' && forceVisionCall) {
          if (ctx.lang === 'CN') qualityReportReasons.push('已开启调试强制：即使质量判定失败也会尝试继续调用照片模型。');
          else qualityReportReasons.push('Force-vision debug enabled: attempting photo model call despite fail-grade quality.');
        }

        if (!analysis && visionDecision.decision === 'call') {
          const allowLowQualityVision = AURORA_RULE_RELAX_AGGRESSIVE && userRequestedPhoto && photosProvided;
          const candidates = photoQuality.grade === 'pass'
            ? passedPhotos
            : degradedPhotos.length
              ? degradedPhotos
              : forceVisionCall || allowLowQualityVision
                ? [...passedPhotos, ...degradedPhotos, ...failedPhotos]
                : passedPhotos;
          const chosen = chooseVisionPhoto(candidates);
          if (!chosen) {
            analysisFieldMissing.push({ field: 'photos', reason: photosProvided ? 'no_usable_photo' : 'no_photo_uploaded' });
            if (ctx.lang === 'CN') qualityReportReasons.push('没有可用的照片（缺少 photo_id 或未通过质量门槛）；我会跳过照片解析。');
            else qualityReportReasons.push('No usable photo (missing photo_id or failed quality gate); skipping photo analysis.');
          } else {
            let photoBytes = null;
            photoModulesSourcePhoto = { slot_id: chosen.slot_id, photo_id: chosen.photo_id };
            if (diagnosisPhotoBytes && diagnosisPhoto && diagnosisPhoto.photo_id === chosen.photo_id) {
              photoBytes = diagnosisPhotoBytes;
            } else {
              try {
                profiler.start('decode', { kind: 'photo_fetch', slot: chosen.slot_id, purpose: 'vision' });
                const resp = await fetchPhotoBytesFromPivotaBackend({ req, photoId: chosen.photo_id });
                if (resp && resp.ok) photoBytes = resp.buffer;
                else {
                  recordPhotoFailure(resp && (resp.failure_code || resp.reason), resp && resp.detail);
                }
                profiler.end('decode', {
                  kind: 'photo_fetch',
                  slot: chosen.slot_id,
                  purpose: 'vision',
                  ok: Boolean(photoBytes),
                  bytes: photoBytes ? photoBytes.length : 0,
                });
              } catch (err) {
                recordPhotoFailure('DOWNLOAD_URL_FETCH_5XX', err && err.message ? err.message : null);
                profiler.fail('decode', err, { kind: 'photo_fetch', slot: chosen.slot_id, purpose: 'vision' });
                logger?.warn({ err: err.message }, 'aurora bff: failed to fetch photo bytes');
              }
            }

            if (photoBytes) {
              const deterministicSeedForVisionDto =
                userRequestedPhoto && photosProvided && diagnosisV1 && diagnosisV1.quality
                  ? buildSkinAnalysisFromDiagnosisV1(diagnosisV1, { language: ctx.lang, profileSummary })
                  : buildRuleBasedSkinAnalysis({ profile: profileSummary || profile, recentLogs, language: ctx.lang });
              const factLayerSeed = buildFactLayer({
                deterministicAnalysis: deterministicSeedForVisionDto,
                visionLayer: null,
              });
              const visionDto = buildVisionSignalsDto({
                lang: ctx.lang,
                photoQuality,
                profileSummary,
                diagnosisPolicy,
                factLayer: factLayerSeed,
                imageBuffer: photoBytes,
              });
              llmInputHash = visionDto.input_hash || llmInputHash;
              llmInputHashPrefix = buildInputHashPrefix(llmInputHash);
              recordAuroraSkinMainlineProvider({ provider: 'gemini' });
              const visionStep = await executeAuroraOptionalStep({
                logger,
                route: '/v1/analysis/skin',
                stepId: 'analysis_skin.vision_mainline',
                criticality: 'optional',
                metricStage: 'analysis_optional_step',
                fn: async () =>
                  runGeminiVisionStrategyImpl({
                    imageBuffer: photoBytes,
                    visionDto,
                    language: ctx.lang,
                    promptVersion,
                    profiler,
                  }),
              });
              const vision = visionStep.ok
                ? visionStep.value
                : {
                    ok: false,
                    provider: 'gemini',
                    reason: 'OPTIONAL_STEP_FAILED',
                    schema_violation: false,
                    semantic_violation: false,
                    upstream_status_code: null,
                    latency_ms: 0,
                    retry: { attempted: 0, final: 'fail', last_reason: 'OPTIONAL_STEP_FAILED' },
                    optional_step_error_class: visionStep.error_class,
                  };
              visionRuntime = vision;
              if (vision && vision.ok && vision.analysis) {
                visionLayer = vision.analysis;
                usedPhotos = true;
                shadowVerifyPhotoBytes = photoBytes;
                analysisSource = 'vision_gemini';
                recordAuroraSkinSemanticGuard({
                  stage: 'vision',
                  outcome: vision.semantic && vision.semantic.useful_output ? 'pass' : 'limited',
                  reason: 'none',
                  promptVersion: vision.prompt_version,
                  locale: ctx.lang,
                });
                recordAuroraSkinUsefulOutput({
                  stage: 'vision',
                  useful: Boolean(vision.semantic ? vision.semantic.useful_output : !vision.analysis.insufficient_visual_detail),
                  insufficientReason: vision.canonical && vision.canonical.insufficient_reason ? vision.canonical.insufficient_reason : 'none',
                  promptVersion: vision.prompt_version,
                  locale: ctx.lang,
                });
                logger?.info(
                  {
                    kind: 'metric',
                    name: 'aurora.skin.analysis.provider_success.count',
                    value: 1,
                    provider: 'gemini',
                    analysis_source: analysisSource,
                  },
                  'metric',
                );
                if (vision.retry && Number(vision.retry.attempted || 0) > 0) {
                  recordAuroraSkinLlmRetry({
                    stage: 'vision',
                    provider: 'gemini',
                    inputHashPrefix: llmInputHashPrefix,
                  });
                  if (vision.retry.final === 'success') {
                    recordAuroraSkinLlmRetrySuccess({
                      stage: 'vision',
                      provider: 'gemini',
                      inputHashPrefix: llmInputHashPrefix,
                    });
                  }
                }
              } else if (vision && !vision.ok) {
                const gatewayReasonMap = {
                  TIMEOUT: VisionUnavailabilityReason.VISION_TIMEOUT,
                  RATE_LIMIT: VisionUnavailabilityReason.VISION_RATE_LIMITED,
                  UPSTREAM_5XX: VisionUnavailabilityReason.VISION_UPSTREAM_5XX,
                  UPSTREAM_4XX: VisionUnavailabilityReason.VISION_UPSTREAM_4XX,
                  IMAGE_INVALID: VisionUnavailabilityReason.VISION_IMAGE_INVALID,
                  VISION_IMAGE_INVALID: VisionUnavailabilityReason.VISION_IMAGE_INVALID,
                  SCHEMA_INVALID: VisionUnavailabilityReason.VISION_SCHEMA_INVALID,
                  SEMANTIC_EMPTY: VisionUnavailabilityReason.VISION_SEMANTIC_INVALID,
                  SEMANTIC_INVALID: VisionUnavailabilityReason.VISION_SEMANTIC_INVALID,
                  IMAGE_FETCH_FAILED: VisionUnavailabilityReason.VISION_IMAGE_FETCH_FAILED,
                  MISSING_GEMINI_KEY: VisionUnavailabilityReason.VISION_MISSING_KEY,
                };
                const normalizedReason = normalizeVisionReason(gatewayReasonMap[String(vision.reason || '').trim().toUpperCase()] || vision.reason);
                visionRuntime = { ...vision, reason: normalizedReason || vision.reason };
                deterministicFallbackReason = normalizedReason || deterministicFallbackReason || 'vision_failed';
                analysisFieldMissing.push({
                  field: 'analysis.used_photos',
                  reason: normalizedReason || 'VISION_UNKNOWN',
                });
                if (ctx.lang === 'CN') qualityReportReasons.push(`照片解析失败（${normalizedReason || 'VISION_UNKNOWN'}）；我会退回到确定性基线。`);
                else qualityReportReasons.push(`Photo analysis failed (${normalizedReason || 'VISION_UNKNOWN'}); falling back to deterministic baseline.`);
                if (vision.schema_violation) {
                  recordAuroraSkinLlmSchemaViolation({
                    stage: 'vision',
                    provider: 'gemini',
                    reason: normalizedReason || 'VISION_SCHEMA_INVALID',
                    inputHashPrefix: llmInputHashPrefix,
                  });
                }
                if (vision.semantic_violation) {
                  recordAuroraSkinSemanticGuard({
                    stage: 'vision',
                    outcome: 'fail',
                    reason: normalizedReason || 'VISION_SEMANTIC_INVALID',
                    promptVersion: vision.prompt_version,
                    locale: ctx.lang,
                  });
                  recordAuroraSkinUsefulOutput({
                    stage: 'vision',
                    useful: false,
                    insufficientReason: vision.canonical && vision.canonical.insufficient_reason ? vision.canonical.insufficient_reason : 'none',
                    promptVersion: vision.prompt_version,
                    locale: ctx.lang,
                  });
                }
                logger?.info(
                  {
                    kind: 'metric',
                    name: 'aurora.skin.analysis.provider_failure.count',
                    value: 1,
                    provider: 'gemini',
                    reason: normalizedReason || 'VISION_UNKNOWN',
                    fallback_from: null,
                  },
                  'metric',
                );
                logger?.warn(
                  {
                    reason: normalizedReason || 'VISION_UNKNOWN',
                    provider: 'gemini',
                    upstream_status_code: toNullableInt(vision.upstream_status_code),
                    error_code: vision.error || null,
                  },
                  'aurora bff: vision skin analysis failed',
                );
              }
            }
          }
        } else if (!analysis && visionDecision.decision === 'skip' && userRequestedPhoto && photosProvided) {
          const r = humanizeLlmReasons(visionDecision.reasons, { language: ctx.lang });
          if (ctx.lang === 'CN') qualityReportReasons.push(`已跳过照片解析：${r.join('；') || '原因未知'}`);
          else qualityReportReasons.push(`Skipped photo analysis: ${r.join('; ') || 'unknown reason'}`);
        }

        if (!analysis && reportDecision.decision === 'call' && hasPrimaryInput && reportAvailable) {
          reportModelCalled = true;
          const deterministicSeedForReportDto =
            userRequestedPhoto && photosProvided && diagnosisV1 && diagnosisV1.quality
              ? buildSkinAnalysisFromDiagnosisV1(diagnosisV1, { language: ctx.lang, profileSummary })
              : buildRuleBasedSkinAnalysis({ profile: profileSummary || profile, recentLogs, language: ctx.lang });
          const factLayerForReport = buildFactLayer({
            deterministicAnalysis: deterministicSeedForReportDto,
            visionLayer,
          });
	          const reportDto = buildReportSignalsDto({
	            lang: ctx.lang,
            diagnosisV1,
            diagnosisPolicy,
            profileSummary,
            routineCandidate: hasRoutine ? routineCandidate : null,
            photoQuality: qualityForReport,
            factLayer: factLayerForReport,
            visionCanonical: visionRuntime && visionRuntime.canonical ? visionRuntime.canonical : null,
            imageBuffer: diagnosisPhotoBytes || shadowVerifyPhotoBytes || null,
	          });
	          llmInputHash = reportDto.input_hash || llmInputHash;
	          llmInputHashPrefix = buildInputHashPrefix(llmInputHash);
	          recordAuroraSkinMainlineProvider({ provider: 'gemini' });
	          const reportStep = await executeAuroraOptionalStep({
	            logger,
	            route: '/v1/analysis/skin',
	            stepId: 'analysis_skin.report_mainline',
	            criticality: 'optional',
	            metricStage: 'analysis_optional_step',
	            fn: async () =>
	              runGeminiReportStrategyImpl({
	                reportDto,
	                language: ctx.lang,
	                promptVersion,
	                profiler,
	              }),
	          });
	          const reportResult = reportStep.ok
	            ? reportStep.value
	            : {
	                ok: false,
	                provider: 'gemini',
	                reason: 'OPTIONAL_STEP_FAILED',
	                schema_violation: false,
	                semantic_violation: false,
	                layer: null,
	                retry: { attempted: 0, final: 'fail', last_reason: 'OPTIONAL_STEP_FAILED' },
	                upstream_status_code: null,
	                latency_ms: 0,
	                prompt_version: promptVersion,
	                input_hash: reportDto && reportDto.input_hash ? String(reportDto.input_hash) : null,
	                optional_step_error_class: reportStep.error_class,
	              };
          if (reportResult.retry && Number(reportResult.retry.attempted || 0) > 0) {
            recordAuroraSkinLlmRetry({
              stage: 'report',
              provider: 'gemini',
              inputHashPrefix: llmInputHashPrefix,
            });
            if (reportResult.retry.final === 'success') {
              recordAuroraSkinLlmRetrySuccess({
                stage: 'report',
                provider: 'gemini',
                inputHashPrefix: llmInputHashPrefix,
              });
            }
          }
          if (reportResult.ok && reportResult.layer) {
            reportLayer = reportResult.layer;
            reportCanonical = reportResult.canonical || reportCanonical;
            analysisSource = visionLayer ? 'gemini_vision_report' : 'gemini_report';
            recordAuroraSkinSemanticGuard({
              stage: 'report',
              outcome: reportResult.semantic && reportResult.semantic.useful_output ? 'pass' : 'limited',
              reason: 'none',
              promptVersion: reportResult.prompt_version,
              locale: ctx.lang,
            });
            recordAuroraSkinUsefulOutput({
              stage: 'report',
              useful: Boolean(reportResult.semantic ? reportResult.semantic.useful_output : !reportResult.layer.insufficient_visual_detail),
              insufficientReason: reportResult.layer && reportResult.layer.insufficient_visual_detail ? 'insufficient_visual_detail' : 'none',
              promptVersion: reportResult.prompt_version,
              locale: ctx.lang,
            });
	            const deepeningContext = buildMainlineDeepeningDto({
              language: ctx.lang,
              promptVersion,
              userRequestedPhoto,
              photosProvided,
              hasRoutine,
              routineCandidate,
              profileSummary,
              recentLogsSummary,
              qualityObject: reportDto && reportDto.quality,
              reportCanonical,
              visionCanonical: visionRuntime && visionRuntime.canonical ? visionRuntime.canonical : null,
	            });
	            if (deepeningContext && deepeningContext.dto) {
	              const deepeningStep = await executeAuroraOptionalStep({
	                logger,
	                route: '/v1/analysis/skin',
	                stepId: 'analysis_skin.deepening_child',
	                criticality: 'optional',
	                metricStage: 'analysis_optional_step',
	                fn: async () =>
	                  runGeminiDeepeningStrategyImpl({
	                    deepeningDto: deepeningContext.dto,
	                    language: ctx.lang,
	                    promptVersion: deepeningContext.promptVersion,
	                    profiler,
	                  }),
	              });
	              deepeningRuntime = deepeningStep.ok
	                ? deepeningStep.value
	                : {
	                    ok: false,
	                    provider: 'deterministic',
	                    reason: 'OPTIONAL_STEP_FAILED',
	                    optional_step_error_class: deepeningStep.error_class,
	                    layer: null,
	                  };
	              if (deepeningRuntime && deepeningRuntime.ok && deepeningRuntime.layer) {
	                reportLayer = {
	                  ...reportLayer,
                  deepening: deepeningRuntime.layer,
                };
              } else {
                const fallbackDeepeningCanonical = adjudicateDeepeningCanonicalLayer(
                  {
                    phase: deepeningContext.phasePlan.phase,
                    summary_priority:
                      reportCanonical && reportCanonical.summary_focus
                        ? reportCanonical.summary_focus.priority
                        : 'mixed',
                    question_intent: deepeningContext.phasePlan.question_intent,
                  },
                  {
                    inheritedPriority:
                      reportCanonical && reportCanonical.summary_focus
                        ? reportCanonical.summary_focus.priority
                        : 'mixed',
                    deepeningContext: deepeningContext.dto,
                  },
                );
                reportLayer = {
                  ...reportLayer,
                  deepening: renderDeepeningCanonicalLayer(fallbackDeepeningCanonical, { lang: ctx.lang }),
                };
              }
            }
          } else {
            const reportFailureRaw = reportResult.reason || 'report_output_invalid';
            const reportFailureReason = normalizeReportFailureReason(reportFailureRaw) || 'UNKNOWN';
            deterministicFallbackReason = deterministicFallbackReason || reportFailureRaw;
            reportModelErrored = true;
            reportModelErrorReason = reportFailureReason;
            if (reportResult.schema_violation) {
              recordAuroraSkinLlmSchemaViolation({
                stage: 'report',
                provider: 'gemini',
                reason: reportFailureReason,
                inputHashPrefix: llmInputHashPrefix,
              });
            }
            if (reportResult.semantic_violation) {
              recordAuroraSkinSemanticGuard({
                stage: 'report',
                outcome: 'fail',
                reason: reportFailureReason,
                promptVersion: reportResult.prompt_version,
                locale: ctx.lang,
              });
              recordAuroraSkinUsefulOutput({
                stage: 'report',
                useful: false,
                insufficientReason: 'semantic_invalid',
                promptVersion: reportResult.prompt_version,
                locale: ctx.lang,
              });
            }
            if (ctx.lang === 'CN') qualityReportReasons.push(`报告模型未能稳定输出（${reportFailureReason}）；我会退回到确定性基线。`);
            else qualityReportReasons.push(`Report model output was unstable (${reportFailureReason}); falling back to deterministic baseline.`);
          }
        }
        if (!analysis && reportDecision.decision === 'skip' && hasPrimaryInput) {
          const r = humanizeLlmReasons(reportDecision.reasons, { language: ctx.lang });
          if (ctx.lang === 'CN') qualityReportReasons.push(`已跳过报告模型：${r.join('；') || '原因未知'}`);
          else qualityReportReasons.push(`Skipped report model: ${r.join('; ') || 'unknown reason'}`);
        }
        if (!analysis && retakeFallbackAnalysis) {
          analysis = retakeFallbackAnalysis;
          analysisSource = 'retake';
        }

        if (!analysis) {
          if (!hasPrimaryInput && !hasPhotoPrimaryInput) {
            analysis = profiler.timeSync(
              'detector',
              () => buildLowConfidenceBaselineSkinAnalysis({ profile: profileSummary || profile, language: ctx.lang }),
              { kind: 'baseline_low_confidence' },
            );
            analysisSource = 'baseline_low_confidence';
          } else {
            if (
              userRequestedPhoto &&
              photosProvided &&
              diagnosisV1 &&
              diagnosisV1.quality &&
              String(diagnosisV1.quality.grade || '').trim().toLowerCase() !== 'fail'
            ) {
              analysis = profiler.timeSync(
                'postprocess',
                () => buildSkinAnalysisFromDiagnosisV1(diagnosisV1, { language: ctx.lang, profileSummary }),
                { kind: 'diagnosis_v1_template' },
              );
              if (analysis) analysisSource = 'diagnosis_v1_template';
            }
            if (!analysis) {
              analysis = profiler.timeSync(
                'detector',
                () => buildRuleBasedSkinAnalysis({ profile: profileSummary || profile, recentLogs, language: ctx.lang }),
                { kind: 'rule_based' },
              );
            }
          }
        }
        if (
          analysis &&
          deterministicFallbackReason &&
          analysisSource !== 'gemini_vision_report' &&
          analysisSource !== 'gemini_report' &&
          analysisSource !== 'vision_gemini'
        ) {
          recordAuroraSkinFallbackDeterministic({ reason: deterministicFallbackReason });
        }
        if (analysis && reportLayer && analysisSource !== 'retake') {
          analysisSource = visionLayer ? 'gemini_vision_report' : 'gemini_report';
        }

        const baseVisionReasons = Array.isArray(visionDecision.reasons) ? visionDecision.reasons.filter(Boolean) : [];
        const firstVisionFailureReason = pickPrimaryVisionReason(baseVisionReasons);
        const unavailabilityOnSkip = Boolean(visionDecision.decision === 'skip' && firstVisionFailureReason);
        const visionRetryDefault = {
          attempted: 0,
          final: 'fail',
          last_reason: firstVisionFailureReason || null,
        };
        visionDecisionForReport = {
          ...visionDecision,
          reasons: baseVisionReasons,
          provider: selectedVisionProvider.provider || 'gemini',
          upstream_status_code: null,
          latency_ms: null,
          retry: visionRetryDefault,
        };

        if (visionRuntime && visionRuntime.ok) {
          const runtimeReasons = Array.isArray(visionDecisionForReport.reasons)
            ? visionDecisionForReport.reasons.filter(Boolean)
            : [];
          const normalizedQualityGrade = String(photoQuality && photoQuality.grade ? photoQuality.grade : '')
            .trim()
            .toLowerCase();
          const qualityReasonFallback =
            normalizedQualityGrade === 'degraded' || normalizedQualityGrade === 'unknown'
              ? ['degraded_mode_vision']
              : ['quality_pass'];
          visionDecisionForReport = {
            ...visionDecisionForReport,
            decision: 'call',
            // Preserve policy reasons so report metadata stays consistent with degrade decisions.
            reasons: runtimeReasons.length ? runtimeReasons : qualityReasonFallback,
            provider: visionRuntime.provider || visionDecisionForReport.provider,
            retry: visionRuntime.retry || { attempted: 0, final: 'success', last_reason: null },
            upstream_status_code: null,
            latency_ms: toNullableNumber(visionRuntime.latency_ms),
          };
        } else if (visionRuntime && !visionRuntime.ok) {
          const runtimeReason = normalizeVisionReason(visionRuntime.reason);
          const runtimeReasons = [runtimeReason];
          if (usedPhotos) runtimeReasons.push(VisionUnavailabilityReason.VISION_CV_FALLBACK_USED);
          visionDecisionForReport = {
            ...visionDecisionForReport,
            decision: 'fallback',
            reasons: Array.from(new Set(runtimeReasons)),
            provider: visionRuntime.provider || visionDecisionForReport.provider,
            retry: visionRuntime.retry || { attempted: 0, final: 'fail', last_reason: runtimeReason },
            upstream_status_code: toNullableInt(visionRuntime.upstream_status_code),
            latency_ms: toNullableNumber(visionRuntime.latency_ms),
          };
        } else if (visionDecision.decision === 'call' && photoFailureCodes.length) {
          const reasons = [VisionUnavailabilityReason.VISION_IMAGE_FETCH_FAILED];
          if (usedPhotos) reasons.push(VisionUnavailabilityReason.VISION_CV_FALLBACK_USED);
          visionDecisionForReport = {
            ...visionDecisionForReport,
            decision: 'fallback',
            reasons,
            retry: { attempted: 0, final: 'fail', last_reason: VisionUnavailabilityReason.VISION_IMAGE_FETCH_FAILED },
          };
        } else if (unavailabilityOnSkip && userRequestedPhoto && photosProvided && usedPhotos) {
          visionDecisionForReport = {
            ...visionDecisionForReport,
            decision: 'fallback',
            reasons: Array.from(new Set([...baseVisionReasons, VisionUnavailabilityReason.VISION_CV_FALLBACK_USED])),
          };
        }

        const visionNoticeReason = pickPrimaryVisionReason(visionDecisionForReport.reasons);
        const visionPhotoNoticeMessage = buildVisionPhotoNotice({
          reason: visionNoticeReason,
          language: ctx.lang,
        });

        recordVisionDecision({
          provider: visionDecisionForReport.provider || 'gemini',
          decision: visionDecisionForReport.decision,
          reasons: visionDecisionForReport.reasons,
          latencyMs: visionDecisionForReport.latency_ms,
        });

        const mustDowngrade =
          userRequestedPhoto &&
          photosProvided &&
          (photoQuality.grade === 'degraded' || photoQuality.grade === 'unknown') &&
          analysisSource !== 'retake';
        if (analysis && mustDowngrade) analysis = downgradeSkinAnalysisConfidence(analysis, { language: ctx.lang, qualityObject: buildQualityObject(photoQuality) });
        if (analysis && diagnosisV1 && usedPhotos) {
          analysis = mergePhotoFindingsIntoAnalysis({
            analysis,
            diagnosisV1,
            language: ctx.lang,
            profileSummary,
          });
        }
        let finalContract = null;
        if (analysis) {
          const factLayer = buildFactLayer({
            deterministicAnalysis: analysis,
            visionLayer,
          });
          finalContract = finalizeSkinAnalysisContract({
            factLayer,
            reportLayer,
            quality: photoQuality,
            lang: ctx.lang,
            deterministicFallback: analysis,
          });
          if (finalContract && finalContract.__contract_fallback) {
            deterministicFallbackReason = deterministicFallbackReason || 'contract_invalid';
            recordAuroraSkinFallbackDeterministic({ reason: deterministicFallbackReason });
          }
          analysis = mergeFinalContractIntoAnalysis({ analysis, finalContract });
        }
        const photoNotUsed = Boolean(userRequestedPhoto && photosProvided && !usedPhotos);
        const photoFailureCode =
          photoFailureCodes[0] || (photoNotUsed && hasPhotoPrimaryInput && !hasPrimaryInput ? 'MISSING_PRIMARY_INPUT' : null);
        let geometrySanitizer = null;
        let photoNotice = null;
        if (photoNotUsed && photoFailureCode) {
          photoNotice = {
            failure_code: photoFailureCode,
            message:
              ctx.lang === 'CN'
                ? `本次未能读取并分析照片（原因：${photoFailureCode}），以下结果仅基于你的问卷/历史信息。请重传后重试。`
                : `We couldn't analyze your photo this time (reason: ${photoFailureCode}). Results below are based on your answers/history only. Please re-upload and retry.`,
          };
        }
        if (analysis) {
          analysis = buildExecutablePlanForAnalysis({
            analysis,
            language: ctx.lang,
            usedPhotos,
            photoQuality,
            profileSummary,
            photoNoticeOverride:
              photoNotice && typeof photoNotice.message === 'string' && photoNotice.message.trim()
                ? photoNotice.message
                : visionPhotoNoticeMessage,
            photoFailureCode,
            photosProvided,
          });
          analysis = attachRoutineExpertToAnalysis({
            analysis,
            routineCandidate: hasRoutine ? routineCandidate : null,
            profileSummary,
            recentLogs: recentLogsSummary,
            language: ctx.lang,
          });
          geometrySanitizer =
            analysis && analysis.__geometry_sanitizer && typeof analysis.__geometry_sanitizer === 'object'
              ? analysis.__geometry_sanitizer
              : null;
          if (analysis && Object.prototype.hasOwnProperty.call(analysis, '__geometry_sanitizer')) {
            delete analysis.__geometry_sanitizer;
          }
          if (finalContract) {
            const locked = finalizeSkinAnalysisContract({
              factLayer: buildFactLayer({ deterministicAnalysis: analysis, visionLayer }),
              reportLayer,
              quality: photoQuality,
              lang: ctx.lang,
              deterministicFallback: analysis,
            });
            analysis = mergeFinalContractIntoAnalysis({ analysis, finalContract: locked });
          }
        }

        let renderedAnalysisSource = analysisSource;
        if (photoNotUsed && analysisSource !== 'retake') {
          renderedAnalysisSource = 'rule_based_with_photo_qc';
        }
        const qualityGradeForMetrics = normalizeQualityGradeForMetrics(photoQuality && photoQuality.grade);
        const pipelineVersionForMetrics = normalizePipelineVersionForMetrics(pipelineVersion || 'unknown');
        const deviceClassForMetrics = inferDeviceClassForMetrics(req);
        const sanitizerTotals = geometrySanitizer || { checked_n: 0, dropped_n: 0, clipped_n: 0 };
        recordAnalyzeRequest({
          issueType: 'all',
          qualityGrade: qualityGradeForMetrics,
          pipelineVersion: pipelineVersionForMetrics,
          deviceClass: deviceClassForMetrics,
        });
        recordGeometrySanitizerTotals({
          issueType: 'all',
          qualityGrade: qualityGradeForMetrics,
          pipelineVersion: pipelineVersionForMetrics,
          deviceClass: deviceClassForMetrics,
          dropped: sanitizerTotals.dropped_n,
          clipped: sanitizerTotals.clipped_n,
        });
        const sanitizerByIssue =
          geometrySanitizer && geometrySanitizer.by_issue && typeof geometrySanitizer.by_issue === 'object'
            ? geometrySanitizer.by_issue
            : {};
        for (const [issueType, issueStatsRaw] of Object.entries(sanitizerByIssue)) {
          const issueStats = issueStatsRaw && typeof issueStatsRaw === 'object' ? issueStatsRaw : {};
          const checkedN = Number(issueStats.checked_n || 0);
          if (checkedN <= 0) continue;
          recordAnalyzeRequest({
            issueType,
            qualityGrade: qualityGradeForMetrics,
            pipelineVersion: pipelineVersionForMetrics,
            deviceClass: deviceClassForMetrics,
          });
          recordGeometrySanitizerTotals({
            issueType,
            qualityGrade: qualityGradeForMetrics,
            pipelineVersion: pipelineVersionForMetrics,
            deviceClass: deviceClassForMetrics,
            dropped: issueStats.dropped_n,
            clipped: issueStats.clipped_n,
          });
        }

        const photoModulesSkinMask = await maybeInferSkinMaskForPhotoModules({
          imageBuffer: diagnosisPhotoBytes,
          diagnosisInternal: diagnosisV1Internal,
          logger,
          requestId: ctx.request_id,
        });

        const photoModulesSourceResolved = (() => {
          const normalizeSourcePhoto = (candidate) => {
            if (!candidate || typeof candidate !== 'object') return null;
            const slotId = String(candidate.slot_id || '').trim();
            const photoId = String(candidate.photo_id || '').trim();
            if (!slotId || !photoId) return null;
            return { slot_id: slotId, photo_id: photoId };
          };

          const direct = normalizeSourcePhoto(photoModulesSourcePhoto);
          if (direct) return direct;

          const diagnosisFallback = normalizeSourcePhoto(diagnosisPhoto);
          if (diagnosisFallback) return diagnosisFallback;

          const bestEffort = chooseVisionPhoto([
            ...(Array.isArray(passedPhotos) ? passedPhotos : []),
            ...(Array.isArray(degradedPhotos) ? degradedPhotos : []),
            ...(Array.isArray(failedPhotos) ? failedPhotos : []),
          ]);
          return normalizeSourcePhoto(bestEffort);
        })();

        let photoModulesCard = maybeBuildPhotoModulesCardForAnalysis({
          requestId: ctx.request_id,
          analysis,
          usedPhotos,
          photoQuality,
          photoNotice:
            photoNotice && typeof photoNotice.message === 'string' && photoNotice.message.trim()
              ? photoNotice.message
              : visionPhotoNoticeMessage,
          diagnosisInternal: diagnosisV1Internal,
          sourcePhoto: photoModulesSourceResolved,
          profileSummary,
          language: ctx.lang,
          skinMask: photoModulesSkinMask,
        });
        if (photoModulesCard && photoModulesSourceResolved) {
          const payloadObj =
            photoModulesCard.payload && typeof photoModulesCard.payload === 'object' && !Array.isArray(photoModulesCard.payload)
              ? photoModulesCard.payload
              : null;
          const faceCropObj =
            payloadObj && payloadObj.face_crop && typeof payloadObj.face_crop === 'object' && !Array.isArray(payloadObj.face_crop)
              ? payloadObj.face_crop
              : null;

          const hasRenderablePhoto = Boolean(
            faceCropObj &&
              (
                String(faceCropObj.crop_image_url || '').trim() ||
                String(faceCropObj.original_image_url || '').trim() ||
                String(faceCropObj.face_crop_url || '').trim() ||
                String(faceCropObj.source_image_url || '').trim() ||
                String(faceCropObj.image_url || '').trim() ||
                String(faceCropObj.src || '').trim()
              ),
          );

          if (!hasRenderablePhoto) {
            const authHeaders = buildPivotaBackendAuthHeaders(req);
            if (PIVOTA_BACKEND_BASE_URL && Object.keys(authHeaders).length) {
              const generated = await requestPhotoDownloadUrlOnce({
                photoId: photoModulesSourceResolved.photo_id,
                authHeaders,
              });
              const fallbackImageUrl =
                generated && generated.ok && typeof generated.downloadUrl === 'string' ? generated.downloadUrl.trim() : '';
              if (fallbackImageUrl) {
                const nextFaceCrop = {
                  ...(faceCropObj && typeof faceCropObj === 'object' ? faceCropObj : {}),
                  original_image_url:
                    (faceCropObj && typeof faceCropObj.original_image_url === 'string' && faceCropObj.original_image_url.trim()) ||
                    fallbackImageUrl,
                };
                if (!String(nextFaceCrop.source_image_url || '').trim()) nextFaceCrop.source_image_url = fallbackImageUrl;
                if (!String(nextFaceCrop.image_url || '').trim()) nextFaceCrop.image_url = fallbackImageUrl;
                photoModulesCard.payload = {
                  ...(payloadObj || {}),
                  face_crop: nextFaceCrop,
                };
              }
            }
          }
        }
        if (photoModulesCard) {
          photoModulesCard = await enrichPhotoModulesCardWithIngredientProductsBounded({
            photoModulesCard,
            profileSummary,
            language: ctx.lang,
            logger,
          });
        }

        if (analysis && persistLastAnalysis) {
          try {
            await saveLastAnalysisForIdentity(
              { auroraUid: identity.auroraUid, userId: identity.userId },
              { analysis, lang: ctx.lang },
            );
          } catch (err) {
            logger?.warn({ err: err && err.message ? err.message : String(err) }, 'aurora bff: failed to persist last analysis');
          }
        }

        let diagnosisArtifact = null;
        let ingredientPlan = null;
        let recommendationReady = false;
        let latestArtifactId = null;
        let artifactGate = null;
        if (analysis && AURORA_DIAG_ARTIFACT_ENABLED && persistLastAnalysis) {
          try {
            const artifactCandidate = buildDiagnosisArtifactV1({
              ctx,
              identity,
              profileSummary,
              recentLogsSummary,
              analysis,
              analysisSource: renderedAnalysisSource,
              usePhoto: Boolean(userRequestedPhoto),
              usedPhotos,
              photos,
              photoQuality,
            });
            const savedArtifact = await saveDiagnosisArtifact({
              auroraUid: identity.auroraUid,
              userId: identity.userId,
              sessionId: ctx.brief_id || null,
              artifact: artifactCandidate,
              artifactId: artifactCandidate && artifactCandidate.artifact_id ? artifactCandidate.artifact_id : undefined,
            });
            diagnosisArtifact = savedArtifact && savedArtifact.artifact_json && typeof savedArtifact.artifact_json === 'object'
              ? {
                  ...savedArtifact.artifact_json,
                  artifact_id: savedArtifact.artifact_id,
                  created_at: savedArtifact.created_at || savedArtifact.artifact_json.created_at,
                }
              : artifactCandidate;
            logger?.info({ kind: 'metric', name: 'aurora.skin.artifact_created_rate', value: diagnosisArtifact ? 1 : 0 }, 'metric');
            recordAuroraSkinFlowMetric({ stage: 'artifact_created', hit: Boolean(diagnosisArtifact) });
            latestArtifactId = diagnosisArtifact && diagnosisArtifact.artifact_id
              ? String(diagnosisArtifact.artifact_id).trim()
              : null;

            if (diagnosisArtifact && AURORA_INGREDIENT_PLAN_ENABLED && latestArtifactId) {
              const planBuilt = buildIngredientPlan({
                artifact: diagnosisArtifact,
                profile: profileSummary || profile || {},
              });
              const savedPlan = await saveIngredientPlan({
                artifactId: latestArtifactId,
                auroraUid: identity.auroraUid,
                userId: identity.userId,
                plan: planBuilt,
              });
              ingredientPlan = savedPlan && savedPlan.plan_json && typeof savedPlan.plan_json === 'object'
                ? {
                    ...savedPlan.plan_json,
                    plan_id: savedPlan.plan_id,
                    created_at: savedPlan.created_at || savedPlan.plan_json.created_at,
                  }
                : planBuilt;
              logger?.info({ kind: 'metric', name: 'aurora.skin.ingredient_plan_rate', value: ingredientPlan ? 1 : 0 }, 'metric');
              recordAuroraSkinFlowMetric({ stage: 'ingredient_plan', hit: Boolean(ingredientPlan) });
            }

            artifactGate = hasUsableArtifactForRecommendations(diagnosisArtifact);
            recommendationReady = Boolean(artifactGate && artifactGate.ok && artifactGate.confidence_level !== 'low');

            if (ingredientPlan && persistLastAnalysis && analysis) {
              try {
                const analysisWithPlan = {
                  ...analysis,
                  ingredient_plan: {
                    targets: Array.isArray(ingredientPlan.targets) ? ingredientPlan.targets.slice(0, 8).map((t) => ({
                      ingredient_id: t.ingredient_id, ingredient_name: t.ingredient_name, role: t.role, priority: t.priority,
                    })) : [],
                    avoid: Array.isArray(ingredientPlan.avoid) ? ingredientPlan.avoid.slice(0, 4).map((a) => ({
                      ingredient_id: a.ingredient_id, ingredient_name: a.ingredient_name, severity: a.severity, reason: a.reason,
                    })) : [],
                  },
                };
                await saveLastAnalysisForIdentity(
                  { auroraUid: identity.auroraUid, userId: identity.userId },
                  { analysis: analysisWithPlan, lang: ctx.lang },
                );
              } catch {
                // non-critical: ingredient plan context will still work from ingredient plan card
              }
            }
          } catch (err) {
            logger?.warn(
              { err: err && err.message ? err.message : String(err), request_id: ctx.request_id },
              'aurora bff: diagnosis artifact/plan generation failed',
            );
          }
        }

        const visionModelCalled = Boolean(visionRuntime);
        const visionLlmOutcome =
          visionModelCalled
            ? visionRuntime && visionRuntime.ok
              ? 'call'
              : 'provider_error'
            : visionDecision && visionDecision.decision === 'call'
              ? 'precheck_fail'
              : 'policy_skip';
        const reportLlmOutcome = reportModelCalled
          ? (reportModelErrored ? 'provider_error' : 'call')
          : reportDecision && reportDecision.decision === 'call'
            ? 'precheck_fail'
            : 'policy_skip';
        if (!shadowRun) {
          recordAuroraSkinAnalysisRealModel({ source: renderedAnalysisSource });
          recordAuroraSkinLlmCall({ stage: 'vision', outcome: visionLlmOutcome });
          recordAuroraSkinLlmCall({ stage: 'report', outcome: reportLlmOutcome });
        }

        const degradeMeta = deriveSkinDegradeMeta({
          renderedAnalysisSource,
          photoFailureCode,
          visionDecisionForReport,
          reportModelErrored,
          reportModelErrorReason,
        });
        const degradeReason = degradeMeta.degradeReason;
        const analysisMeta = {
          detector_source: String(renderedAnalysisSource || '').trim() || 'unknown',
          llm_vision_called: visionModelCalled,
          llm_report_called: reportModelCalled,
          artifact_usable: Boolean(artifactGate && artifactGate.ok),
          gate_relax_mode: AURORA_RULE_RELAX_MODE,
          low_quality_tolerated: Boolean(
            AURORA_RULE_RELAX_AGGRESSIVE &&
              userRequestedPhoto &&
              photosProvided &&
              String(photoQuality && photoQuality.grade || '').trim().toLowerCase() === 'fail',
          ),
          ...(degradeReason ? { degrade_reason: degradeReason } : {}),
          ...(degradeMeta.visionFailureReason ? { vision_failure_reason: degradeMeta.visionFailureReason } : {}),
          ...(degradeMeta.reportFailureReason ? { report_failure_reason: degradeMeta.reportFailureReason } : {}),
        };
        const lowConfidenceFromPhotoQuality = Boolean(
          userRequestedPhoto &&
            photosProvided &&
            ['fail', 'unknown'].includes(String(photoQuality && photoQuality.grade || '').trim().toLowerCase()),
        );
        const lowConfidenceSummary = analysisSource === 'baseline_low_confidence' || lowConfidenceFromPhotoQuality;

        profiler.start('render', { kind: 'envelope' });
        const chatQualityObj = buildQualityObject(photoQuality);
        const chatCappedAnalysis = analysis ? applyConfidenceCaps(analysis, chatQualityObj.grade) : analysis;
        const chatDedupedAnalysis = chatCappedAnalysis ? dedupeAndCapOutput(chatCappedAnalysis) : chatCappedAnalysis;
        let chatEnrichedAnalysis = chatDedupedAnalysis ? {
          ...chatDedupedAnalysis,
          quality: chatQualityObj,
          findings: Array.isArray(chatDedupedAnalysis.findings) ? chatDedupedAnalysis.findings : [],
          guidance_brief: Array.isArray(chatDedupedAnalysis.guidance_brief) ? chatDedupedAnalysis.guidance_brief : [],
          insufficient_visual_detail: Boolean(chatDedupedAnalysis.insufficient_visual_detail) || detectInsufficientVisualDetail(Array.isArray(chatDedupedAnalysis.findings) ? chatDedupedAnalysis.findings : []),
        } : chatDedupedAnalysis;
        if (renderedAnalysisSource === 'retake') {
          chatEnrichedAnalysis = ensureRetakeFeatureObservation(chatEnrichedAnalysis, { language: ctx.lang });
        }
        const analysisSummaryPayload = {
          analysis: chatEnrichedAnalysis,
          low_confidence: lowConfidenceSummary,
          photos_provided: photosProvided,
          photo_qc: photoQcParts,
          used_photos: usedPhotos,
          analysis_source: renderedAnalysisSource,
          ...(photoNotice ? { photo_notice: photoNotice } : {}),
          quality_report: {
            photo_quality: { grade: photoQuality.grade, reasons: photoQuality.reasons },
            detector_confidence: detectorConfidence,
            ...(diagnosisPolicy ? { detector_policy: diagnosisPolicy } : {}),
            degraded_mode: SKIN_DEGRADED_MODE,
            llm: { vision: visionDecisionForReport || visionDecision, report: reportDecision },
            ...(llmInputHashPrefix ? { input_hash_prefix: llmInputHashPrefix } : {}),
            reasons: qualityReportReasons.slice(0, 8),
          },
          ...(diagnosisArtifact ? { diagnosis_artifact: diagnosisArtifact } : {}),
          ...(ingredientPlan ? { ingredient_plan: ingredientPlan } : {}),
          recommendation_ready: Boolean(recommendationReady),
          photo_pipeline_enabled: AURORA_AURORAAPP_PHOTO_PIPELINE_ENABLED,
          analysis_meta: {
            gate_relax_mode: AURORA_RULE_RELAX_MODE,
            low_quality_tolerated: Boolean(
              AURORA_RULE_RELAX_AGGRESSIVE &&
                userRequestedPhoto &&
                photosProvided &&
                String(photoQuality && photoQuality.grade || '').trim().toLowerCase() === 'fail',
            ),
          },
        };
        if (!shadowRun && persistLastAnalysis) {
          scheduleSkinAnalysisKbBackfill({
            ctx,
            identity,
            analysisSummaryPayload,
            analysisMeta,
            logger,
          });
        }

        const sessionPatch = { next_state: 'S5_ANALYSIS_SUMMARY' };
        appendLatestArtifactToSessionPatch(sessionPatch, latestArtifactId);

        const artifactConfidence = diagnosisArtifact && diagnosisArtifact.overall_confidence && typeof diagnosisArtifact.overall_confidence === 'object'
          ? diagnosisArtifact.overall_confidence
          : null;
        const lowConfidenceRuleBased =
          artifactConfidence &&
          String(artifactConfidence.level || '').toLowerCase() === 'low' &&
          (renderedAnalysisSource === 'rule_based' || renderedAnalysisSource === 'baseline_low_confidence');

        const extraCards = [];
        if (ingredientPlan) {
          extraCards.push(buildIngredientPlanCard(ingredientPlan, ctx.request_id));
        }
        const routineProductEvents = [];

        const routineFitPlan = resolveRoutineFitAnalysisPlan({
          routineProductCandidates,
          lowConfidenceRuleBased,
        });
        let routineFitCard = null;
        let routineFitFailureReason = null;
        let routineFitRetryCount = 0;
        let routineFitPartialStructured = false;
        let routineFitPartialDimensions = [];
        if (routineFitPlan.shouldEvaluateRoutineFit) {
          routineProductEvents.push(
            makeEvent(ctx, 'routine_fit_evaluation_started', {
              total_candidates: routineProductCandidates.length,
            }),
          );

          const routineSkinProfile = {
            skin_type_tendency: profileSummary && profileSummary.skinType ? profileSummary.skinType : null,
            sensitivity_tendency: profileSummary && profileSummary.sensitivity ? profileSummary.sensitivity : null,
          };
          const fitPrefix = buildContextPrefix({
            profile: isPlainObject(profileSummary) ? profileSummary : {},
            lang: ctx.lang,
            state: 'S4_ANALYSIS_LOADING',
            trigger_source: 'routine_fit_evaluation',
            intent: 'routine_fit_summary',
            action_id: 'routine.fit.evaluate',
          });
          const fitPrompt = buildRoutineFitSummaryPrompt({
            prefix: fitPrefix,
            skinProfile: routineSkinProfile,
            ingredientPlan,
            routineProducts: routineProductCandidates.slice(0, 8),
            language: ctx.lang,
          });

          for (let attempt = 0; attempt < 2 && !routineFitCard; attempt += 1) {
            const attemptPrompt = attempt === 0 ? fitPrompt : buildRoutineFitRetryPrompt(fitPrompt, ctx.lang);
            try {
              const fitUpstream = await auroraChat({
                baseUrl: AURORA_DECISION_BASE_URL,
                query: attemptPrompt,
                timeoutMs: Math.min(12000, AURORA_ROUTINE_PRODUCT_AUTOSCAN_TIMEOUT_MS || 12000),
                llm_provider: 'gemini',
                llm_model: SKIN_VISION_MODEL_GEMINI || 'gemini-3-flash-preview',
                intent_hint: 'routine_fit_summary',
                disallow_clarify: true,
                required_structured_keys: ROUTINE_FIT_REQUIRED_STRUCTURED_KEYS,
              });

              const parsedFit = parseRoutineFitUpstreamResult(fitUpstream);
              if (parsedFit.ok && parsedFit.value) {
                routineFitCard = buildRoutineFitSummaryCard(parsedFit.value, ctx.request_id);
                routineFitFailureReason = null;
                routineFitRetryCount = attempt;
                routineFitPartialStructured = Boolean(parsedFit.partial_structured);
                routineFitPartialDimensions = Array.isArray(parsedFit.partial_dimensions)
                  ? parsedFit.partial_dimensions.slice(0, ROUTINE_FIT_DIMENSION_KEYS.length)
                  : [];
                break;
              }

              routineFitFailureReason = parsedFit.failure_reason || 'json_parse_failed';
              routineFitRetryCount = attempt;
              if (attempt === 0) {
                logger?.warn(
                  {
                    request_id: ctx.request_id,
                    failure_reason: routineFitFailureReason,
                    missing_keys: parsedFit.missing_keys,
                  },
                  'aurora bff: routine fit evaluation retrying after invalid structured output',
                );
              }
            } catch (err) {
              routineFitFailureReason = 'upstream_error';
              routineFitRetryCount = attempt;
              logger?.warn(
                { err: err && err.message ? err.message : String(err), request_id: ctx.request_id, attempt: attempt + 1 },
                'aurora bff: routine fit evaluation failed',
              );
            }
          }

          if (!routineFitCard) {
            recordAuroraSkinFlowMetric({
              stage: `routine_fit_${String(routineFitFailureReason || 'failed').slice(0, 48)}`,
              hit: true,
            });
          }
          recordAuroraSkinFlowMetric({ stage: 'routine_fit_evaluated', hit: true });
          recordAuroraSkinFlowMetric({ stage: 'routine_fit_emitted', hit: Boolean(routineFitCard) });
          logger?.info(
            { kind: 'metric', name: 'aurora.skin.routine_fit.emitted_rate', value: routineFitCard ? 1 : 0 },
            'metric',
          );
          if (routineFitCard && routineFitPartialStructured) {
            logger?.info(
              { kind: 'metric', name: 'aurora.skin.routine_fit.partial_structured_rate', value: 1 },
              'metric',
            );
          }

          routineProductEvents.push(
            makeEvent(ctx, 'routine_fit_evaluation_completed', {
              candidate_count: routineProductCandidates.length,
              fit_card_emitted: Boolean(routineFitCard),
              overall_fit: routineFitCard && routineFitCard.payload ? routineFitCard.payload.overall_fit : null,
              failure_reason: routineFitCard ? null : routineFitFailureReason || 'unknown',
              retry_count: routineFitRetryCount,
              partial_structured: routineFitPartialStructured,
              partial_dimensions: routineFitPartialDimensions,
            }),
          );
        }

        if (routineFitCard && analysisSummaryPayload && typeof analysisSummaryPayload === 'object') {
          analysisSummaryPayload.routine_fit = routineFitCard.payload;
        }

        if (routineFitCard && persistLastAnalysis && analysis) {
          try {
            const analysisWithFollowups = {
              ...analysis,
              ...(ingredientPlan ? {
                ingredient_plan: {
                  targets: Array.isArray(ingredientPlan.targets) ? ingredientPlan.targets.slice(0, 8).map((t) => ({
                    ingredient_id: t.ingredient_id,
                    ingredient_name: t.ingredient_name,
                    role: t.role,
                    priority: t.priority,
                  })) : [],
                  avoid: Array.isArray(ingredientPlan.avoid) ? ingredientPlan.avoid.slice(0, 4).map((a) => ({
                    ingredient_id: a.ingredient_id,
                    ingredient_name: a.ingredient_name,
                    severity: a.severity,
                    reason: a.reason,
                  })) : [],
                },
              } : {}),
              routine_fit: routineFitCard.payload,
            };
            await saveLastAnalysisForIdentity(
              { auroraUid: identity.auroraUid, userId: identity.userId },
              { analysis: analysisWithFollowups, lang: ctx.lang },
            );
          } catch {
            // non-critical: follow-up chat can still use the current response card
          }
        }

        if (routineFitPlan.shouldQueueKbBackfill) {
          setImmediate(async () => {
            let asyncCompleted = 0;
            let asyncBackfilled = 0;
            for (const candidate of routineProductCandidates) {
              try {
                const result = await deepScanRoutineProductCandidate({
                  candidate,
                  ctx,
                  profileSummary,
                  recentLogsSummary,
                  logger,
                  includeCard: false,
                });
                asyncCompleted += 1;
                if (result && result.backfilled) asyncBackfilled += 1;
              } catch {
                // non-critical: KB backfill for on-demand deep dive
              }
            }
            logger?.info(
              {
                request_id: ctx.request_id,
                trace_id: ctx.trace_id,
                queued: routineProductCandidates.length,
                completed: asyncCompleted,
                backfilled: asyncBackfilled,
              },
              'aurora bff: routine product async KB backfill finished',
            );
          });
        }

        if (artifactConfidence && String(artifactConfidence.level || '').toLowerCase() === 'low') {
          logger?.info({ kind: 'metric', name: 'aurora.skin.low_confidence_rate', value: 1 }, 'metric');
          extraCards.push({
            card_id: `conf_${ctx.request_id}`,
            type: 'confidence_notice',
            payload: buildConfidenceNoticeCardPayload({
              language: ctx.lang,
              reason: 'low_confidence',
              confidence: artifactConfidence,
              actions: ['upload_daylight_and_indoor_white', 'update_current_routine'],
            }),
          });
        }

        const analysisSkinProfile = {
          skin_type_tendency: profileSummary && profileSummary.skinType ? profileSummary.skinType : null,
          sensitivity_tendency: profileSummary && profileSummary.sensitivity ? profileSummary.sensitivity : null,
        };
        const analysisChips = buildAnalysisSuggestedChips({
          language: ctx.lang,
          lowConfidence: lowConfidenceSummary,
          hasIngredientPlan: Boolean(ingredientPlan),
          hasRoutineFit: Boolean(routineFitCard),
        });
        const analysisAssistantText = buildAnalysisAssistantMessage({
          language: ctx.lang,
          skinProfile: analysisSkinProfile,
          lowConfidence: lowConfidenceSummary,
          ingredientPlan,
          routineFit: routineFitCard && routineFitCard.payload ? routineFitCard.payload : null,
        });

        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage(analysisAssistantText),
          suggested_chips: analysisChips,
          cards: [
            {
              card_id: `analysis_${ctx.request_id}`,
              type: 'analysis_summary',
              payload: analysisSummaryPayload,
              ...(analysisFieldMissing.length ? { field_missing: analysisFieldMissing } : {}),
            },
            ...(routineFitCard ? [routineFitCard] : []),
            ...(photoModulesCard ? [photoModulesCard] : []),
            ...extraCards,
          ],
          session_patch: sessionPatch,
          events: [
            ...routineProductEvents,
            ...pregnancyPolicyEvents,
            makeEvent(ctx, 'value_moment', { kind: 'skin_analysis', used_photos: usedPhotos, analysis_source: renderedAnalysisSource }),
          ],
          analysis_meta: analysisMeta,
        });
        profiler.end('render', { kind: 'envelope' });

        const report = profiler.report();
        logger?.info(
          {
            kind: shadowRun ? 'skin_analysis_profile_shadow' : 'skin_analysis_profile',
            request_id: ctx.request_id,
            trace_id: ctx.trace_id,
            pipeline_version: pipelineVersion || null,
            shadow_run: Boolean(shadowRun),
            experiments: experimentsSlim,
            analysis_source: renderedAnalysisSource,
            user_requested_photo: Boolean(userRequestedPhoto),
            photos_provided: Boolean(photosProvided),
            used_photos: Boolean(usedPhotos),
            photo_quality_grade: photoQuality && typeof photoQuality.grade === 'string' ? photoQuality.grade : 'unknown',
            total_ms: report.total_ms,
            llm_summary: report.llm_summary,
            stages: report.stages,
          },
          'aurora bff: skin analysis profile',
        );
        logger?.info(
          { kind: 'metric', name: `aurora.skin_analysis.${pipelineVersion || 'unknown'}.total_ms`, value: report.total_ms },
          'metric',
        );
	        if (!shadowRun) {
	          logger?.info({ kind: 'metric', name: 'aurora.skin_analysis.total_ms', value: report.total_ms }, 'metric');
	        }

        if (experimentsSlim.length) {
          const llmCalls = report && report.llm_summary && typeof report.llm_summary.calls === 'number' ? report.llm_summary.calls : 0;
          const qualityGrade = photoQuality && typeof photoQuality.grade === 'string' ? photoQuality.grade : 'unknown';
          const pv = pipelineVersion || 'unknown';

          for (const exp of experimentsSlim) {
            const expId = exp && typeof exp.experiment_id === 'string' ? exp.experiment_id : null;
            const variant = exp && typeof exp.variant === 'string' ? exp.variant : null;
            if (!expId || !variant) continue;

            logger?.info({ kind: 'metric', name: `aurora.skin_experiment.${expId}.${variant}.${pv}.requests`, value: 1 }, 'metric');
            logger?.info(
              { kind: 'metric', name: `aurora.skin_experiment.${expId}.${variant}.${pv}.total_ms`, value: report.total_ms },
              'metric',
            );
            logger?.info(
              { kind: 'metric', name: `aurora.skin_experiment.${expId}.${variant}.${pv}.llm_calls`, value: llmCalls },
              'metric',
            );
            logger?.info(
              { kind: 'metric', name: `aurora.skin_experiment.${expId}.${variant}.${pv}.quality_grade.${qualityGrade}`, value: 1 },
              'metric',
            );
          }
        }

	        setImmediate(() => {
	          sampleHardCase({
	            req,
	            ctx,
	            identity: { auroraUid: identity.auroraUid, userId: identity.userId },
	            pipelineVersion,
	            shadowRun,
	            profileSummary,
	            photoQuality,
	            diagnosisPolicy,
	            diagnosisV1,
	            analysis,
	            analysisSource,
	            geometrySanitizer,
	            diagnosisPhotoBytes,
	            diagnosisV1Internal,
	            logger,
	          }).catch((err) => {
	            logger?.warn({ err: err && err.message ? err.message : String(err) }, 'hard case sampler: failed');
	          });
	        });

	        if (!shadowRun) {
	          const verifyRuntimeLimits = (() => {
	            if (!DIAG_VERIFY_ALLOW_GUARD_TEST) return null;

	            const headerPerMin = Number(req.get('x-diag-verify-max-calls-per-min'));
	            const headerPerDay = Number(req.get('x-diag-verify-max-calls-per-day'));
	            const queryPerMin = Number(req.query && req.query.diag_verify_max_calls_per_min);
	            const queryPerDay = Number(req.query && req.query.diag_verify_max_calls_per_day);
	            const bodyLimits =
	              (isPlainObject(req.body) && isPlainObject(req.body.diag_verify_runtime_limits) && req.body.diag_verify_runtime_limits) ||
	              (isPlainObject(req.body) &&
	                isPlainObject(req.body.debug) &&
	                isPlainObject(req.body.debug.diag_verify_runtime_limits) &&
	                req.body.debug.diag_verify_runtime_limits) ||
	              null;
	            const bodyPerMin = Number(
	              bodyLimits &&
	                (bodyLimits.maxCallsPerMin != null ? bodyLimits.maxCallsPerMin : bodyLimits.max_calls_per_min),
	            );
	            const bodyPerDay = Number(
	              bodyLimits &&
	                (bodyLimits.maxCallsPerDay != null ? bodyLimits.maxCallsPerDay : bodyLimits.max_calls_per_day),
	            );

	            const pickFirstFinite = (...values) => {
	              for (const value of values) {
	                if (Number.isFinite(value) && value >= 0) return Math.trunc(value);
	              }
	              return null;
	            };

	            const maxCallsPerMin = pickFirstFinite(headerPerMin, bodyPerMin, queryPerMin);
	            const maxCallsPerDay = pickFirstFinite(headerPerDay, bodyPerDay, queryPerDay);
	            if (maxCallsPerMin == null && maxCallsPerDay == null) return null;
	            return {
	              ...(maxCallsPerMin != null ? { maxCallsPerMin } : {}),
	              ...(maxCallsPerDay != null ? { maxCallsPerDay } : {}),
	            };
	          })();
	          setImmediate(() => {
	            runGeminiShadowVerify({
	              imageBuffer: shadowVerifyPhotoBytes || diagnosisPhotoBytes || null,
	              language: ctx.lang,
	              photoQuality,
	              usedPhotos,
	              diagnosisV1,
	              diagnosisInternal: diagnosisV1Internal,
	              profileSummary,
	              recentLogsSummary,
	              inferenceId: ctx.request_id || ctx.trace_id || null,
	              traceId: ctx.trace_id || null,
	              assetId: diagnosisPhoto && typeof diagnosisPhoto.photo_id === 'string' ? diagnosisPhoto.photo_id : null,
	              runtimeLimits: verifyRuntimeLimits || undefined,
	              skinToneBucket:
	                diagnosisV1Internal && typeof diagnosisV1Internal.skin_tone_bucket === 'string'
	                  ? diagnosisV1Internal.skin_tone_bucket
	                  : 'unknown',
	              lightingBucket:
	                diagnosisV1Internal && typeof diagnosisV1Internal.lighting_bucket === 'string'
	                  ? diagnosisV1Internal.lighting_bucket
	                  : 'unknown',
	              logger,
	              metricsHooks: {
	                onProviderResult: (stat) =>
	                  recordEnsembleProviderResult({
	                    provider: stat.provider,
	                    ok: stat.ok,
	                    latencyMs: stat.latency_ms,
	                    failureReason: stat.failure_reason,
	                    schemaFailed: stat.schema_failed,
	                  }),
	                onAgreement: (score) => recordEnsembleAgreementScore(score),
	                onVerifyCall: ({ status }) => recordVerifyCall({ status }),
	                onVerifyFail: ({
	                  reason,
	                  provider,
	                  http_status_class: httpStatusClass,
	                  timeout_stage: timeoutStage,
	                  retry_count: retryCount,
	                  error_class: errorClass,
	                }) =>
	                  recordVerifyFail({
	                    reason,
	                    provider,
	                    httpStatusClass,
	                    timeoutStage,
	                    retryCount,
	                    errorClass,
	                  }),
	                onVerifyRetry: ({ attempts }) => recordVerifyRetry({ attempts }),
	                onVerifyBudgetGuard: () => recordVerifyBudgetGuard(),
	                onVerifyCircuitOpen: () => recordVerifyCircuitOpen(),
	                onVerifyAgreement: (score) => recordVerifyAgreementScore(score),
	                onVerifyHardCase: () => recordVerifyHardCase(),
	              },
		            })
		              .then(async (verify) => {
		                if (!verify || !verify.called) return;
		                logger?.info(
		                  {
		                    request_id: ctx.request_id,
		                    trace_id: ctx.trace_id,
		                    used_photos: usedPhotos,
		                    verify_ok: Boolean(verify.ok),
		                    verify_provider_status_code:
		                      Number.isFinite(Number(verify.provider_status_code)) ? Number(verify.provider_status_code) : null,
		                    verify_final_reason: verify.final_reason || null,
		                    verify_raw_final_reason: verify.raw_final_reason || null,
		                    verify_fail_reason: verify.verify_fail_reason || null,
		                    verify_timeout_stage: verify.timeout_stage || null,
		                    verify_upstream_request_id: verify.upstream_request_id || null,
		                    verify_attempts: Number.isFinite(Number(verify.attempts)) ? Number(verify.attempts) : null,
		                    verify_latency_ms: Number.isFinite(Number(verify.latency_ms)) ? Number(verify.latency_ms) : null,
		                    agreement_score: verify.agreement_score,
		                    disagreement_reasons: verify.disagreement_reasons,
		                    hard_case_written: Boolean(verify.hard_case_written),
		                  },
		                  'diag verify: shadow run recorded',
		                );
                    try {
                      const shadowRecord = {
                        source: 'shadow_verify',
                        provider: 'gemini',
                        prompt_version:
                          verify &&
                          verify.verifier &&
                          typeof verify.verifier.schema_version === 'string' &&
                          verify.verifier.schema_version.trim()
                            ? verify.verifier.schema_version.trim()
                            : 'aurora.diag.verify_shadow.v1',
                        created_at: new Date().toISOString(),
                        input_hash: llmInputHash || null,
                        verdict: {
                          ok: Boolean(verify.ok),
                          final_reason: verify.final_reason || null,
                          raw_final_reason: verify.raw_final_reason || null,
                          verify_fail_reason: verify.verify_fail_reason || null,
                          agreement_score:
                            Number.isFinite(Number(verify.agreement_score)) ? Number(verify.agreement_score) : null,
                          disagreement_reasons: Array.isArray(verify.disagreement_reasons)
                            ? verify.disagreement_reasons.slice(0, 10)
                            : [],
                        },
                        meta: {
                          request_id: ctx.request_id || null,
                          trace_id: ctx.trace_id || null,
                          provider_status_code:
                            Number.isFinite(Number(verify.provider_status_code)) ? Number(verify.provider_status_code) : null,
                          attempts: Number.isFinite(Number(verify.attempts)) ? Number(verify.attempts) : null,
                          latency_ms: Number.isFinite(Number(verify.latency_ms)) ? Number(verify.latency_ms) : null,
                          upstream_request_id: verify.upstream_request_id || null,
                          hard_case_written: Boolean(verify.hard_case_written),
                        },
                      };
                      const savedShadow = await saveShadowVerifyForIdentity(
                        { auroraUid: identity.auroraUid, userId: identity.userId },
                        { shadow: shadowRecord },
                      );
                      if (savedShadow && savedShadow.shadow_id != null) {
                        await appendShadowIdToLastAnalysisForIdentity(
                          { auroraUid: identity.auroraUid, userId: identity.userId },
                          { shadowId: savedShadow.shadow_id, maxIds: 20 },
                        );
                        recordAuroraSkinShadowVerifyIsolatedWrite({ status: 'success' });
                      } else {
                        recordAuroraSkinShadowVerifyIsolatedWrite({ status: 'skip' });
                      }
                    } catch (shadowErr) {
                      recordAuroraSkinShadowVerifyIsolatedWrite({ status: 'fail' });
                      logger?.warn(
                        { err: shadowErr && shadowErr.message ? shadowErr.message : String(shadowErr) },
                        'diag verify: isolated shadow write failed',
                      );
                    }
		              })
		              .catch((err) => {
		                logger?.warn({ err: err && err.message ? err.message : String(err) }, 'diag verify: shadow run failed');
		              });
	          });
	        }

	        return { envelope, report, profile_for_guardrails: profile };
	      };

      const analysisBudgetStartedAtMs = Date.now();
      let output = null;
      try {
        if (AURORA_RULE_RELAX_AGGRESSIVE) {
          output = await runOnce({
            pipelineVersion: outputPipelineVersion,
            persistLastAnalysis: true,
            shadowRun: false,
          });
        } else {
          output = await withTimeout(
            runOnce({
              pipelineVersion: outputPipelineVersion,
              persistLastAnalysis: true,
              shadowRun: false,
            }),
            AURORA_BFF_ANALYSIS_BUDGET_MS,
            'AURORA_ANALYSIS_BUDGET_TIMEOUT',
          );
        }
      } catch (err) {
        if (!(err && err.code === 'AURORA_ANALYSIS_BUDGET_TIMEOUT')) throw err;
        logger?.warn(
          {
            request_id: ctx.request_id,
            trace_id: ctx.trace_id,
            budget_ms: AURORA_BFF_ANALYSIS_BUDGET_MS,
          },
          'aurora bff: analysis budget timeout, degraded to low-confidence baseline',
        );
        logger?.info({ kind: 'metric', name: 'aurora.skin.analysis.timeout_degraded_rate', value: 1 }, 'metric');
        recordAuroraSkinFlowMetric({ stage: 'analysis_timeout_degraded', hit: true });
        recordAuroraSkinAnalysisRealModel({ source: 'baseline_low_confidence' });
        recordAuroraSkinLlmCall({ stage: 'vision', outcome: 'policy_skip' });
        recordAuroraSkinLlmCall({ stage: 'report', outcome: 'policy_skip' });

        const degradedAnalysis = buildLowConfidenceBaselineSkinAnalysis({
          profile: null,
          language: ctx.lang,
        });
        const timeoutReasonText = ctx.lang === 'CN'
          ? '分析超时，已降级为低置信度基础方案。'
          : 'Analysis timed out and was downgraded to a low-confidence baseline.';
        const timeoutPayload = {
          analysis: degradedAnalysis,
          low_confidence: true,
          photos_provided: Boolean(parsed.data && parsed.data.use_photo),
          photo_qc: [],
          used_photos: false,
          analysis_source: 'baseline_low_confidence',
          quality_report: {
            photo_quality: { grade: 'unknown', reasons: ['analysis_budget_timeout'] },
            detector_confidence: 0,
            degraded_mode: SKIN_DEGRADED_MODE,
            llm: {
              vision: { decision: 'skip', reasons: ['analysis_budget_timeout'] },
              report: { decision: 'skip', reasons: ['analysis_budget_timeout'] },
            },
            reasons: [timeoutReasonText],
          },
          recommendation_ready: false,
          photo_pipeline_enabled: AURORA_AURORAAPP_PHOTO_PIPELINE_ENABLED,
          analysis_meta: {
            gate_relax_mode: AURORA_RULE_RELAX_MODE,
            low_quality_tolerated: Boolean(AURORA_RULE_RELAX_AGGRESSIVE),
          },
        };
        scheduleSkinAnalysisKbBackfill({
          ctx,
          identity,
          analysisSummaryPayload: timeoutPayload,
          analysisMeta: {
            detector_source: 'baseline_low_confidence',
            llm_vision_called: false,
            llm_report_called: false,
            artifact_usable: false,
            gate_relax_mode: AURORA_RULE_RELAX_MODE,
            low_quality_tolerated: Boolean(AURORA_RULE_RELAX_AGGRESSIVE),
            degrade_reason: 'analysis_budget_timeout',
          },
          logger,
        });

        const timeoutChips = buildAnalysisSuggestedChips({
          language: ctx.lang,
          lowConfidence: true,
          hasIngredientPlan: false,
          hasRoutineProducts: false,
        });
        const timeoutAssistantText = ctx.lang === 'CN'
          ? '分析超时，已切换为保守方案。你可以重新拍照或直接提问。'
          : 'Analysis timed out and switched to a conservative plan. You can retake photos or ask questions.';

        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage(timeoutAssistantText),
          suggested_chips: timeoutChips,
          cards: [
            {
              card_id: `analysis_${ctx.request_id}`,
              type: 'analysis_summary',
              payload: timeoutPayload,
              field_missing: [{ field: 'analysis', reason: 'analysis_budget_timeout' }],
            },
            {
              card_id: `conf_${ctx.request_id}`,
              type: 'confidence_notice',
              payload: buildConfidenceNoticeCardPayload({
                language: ctx.lang,
                reason: 'timeout_degraded',
                confidence: { score: 0.35, level: 'low', rationale: ['analysis_budget_timeout'] },
                actions: ['retry_analysis', 'upload_daylight_and_indoor_white', 'update_current_routine'],
                details: [timeoutReasonText],
              }),
            },
          ],
          session_patch: { next_state: 'S5_ANALYSIS_SUMMARY' },
          events: [
            makeEvent(ctx, 'value_moment', { kind: 'skin_analysis', used_photos: false, analysis_source: 'baseline_low_confidence' }),
            makeEvent(ctx, 'analysis_timeout_degraded', { budget_ms: AURORA_BFF_ANALYSIS_BUDGET_MS }),
          ],
          analysis_meta: {
            detector_source: 'baseline_low_confidence',
            llm_vision_called: false,
            llm_report_called: false,
            artifact_usable: false,
            gate_relax_mode: AURORA_RULE_RELAX_MODE,
            low_quality_tolerated: Boolean(AURORA_RULE_RELAX_AGGRESSIVE),
            degrade_reason: 'analysis_budget_timeout',
          },
        });
        const degradedGuardrail = await applyProductIntelGuardrailsToEnvelope({
          envelope,
          ctx,
          profile: null,
          language: ctx.lang,
          qaRuntime: {
            budget_ms: AURORA_BFF_ANALYSIS_BUDGET_MS,
            started_at_ms: analysisBudgetStartedAtMs,
            min_budget_ms: AURORA_LLM_QA_MIN_REMAINING_BUDGET_MS,
            qa_mode: AURORA_LLM_QA_MODE,
            qa_provider: AURORA_LLM_SINGLE_PROVIDER,
            allow_openai_fallback: AURORA_LLM_OPENAI_FALLBACK_ENABLED,
            product_qa_mode: AURORA_PRODUCT_RELEVANCE_QA_MODE,
          },
        });
        if (degradedGuardrail && Array.isArray(degradedGuardrail.rejected) && degradedGuardrail.rejected.length > 0) {
          persistRejectedCatalogCandidates(ctx, degradedGuardrail.rejected);
        }
        return res.json(degradedGuardrail && degradedGuardrail.envelope ? degradedGuardrail.envelope : envelope);
      }

      if (shadowRunV2) {
        setImmediate(() => {
          runOnce({ pipelineVersion: 'v2', persistLastAnalysis: false, shadowRun: true }).catch((err) => {
            logger?.warn({ err: err && err.message ? err.message : String(err) }, 'aurora bff: v2 shadow run failed');
          });
        });
      }

      const guardrailResult = await applyProductIntelGuardrailsToEnvelope({
        envelope: output.envelope,
        ctx,
        profile: output && output.profile_for_guardrails ? output.profile_for_guardrails : null,
        language: ctx.lang,
        qaRuntime: {
          budget_ms: AURORA_BFF_ANALYSIS_BUDGET_MS,
          started_at_ms: analysisBudgetStartedAtMs,
          min_budget_ms: AURORA_LLM_QA_MIN_REMAINING_BUDGET_MS,
          qa_mode: AURORA_LLM_QA_MODE,
          qa_provider: AURORA_LLM_SINGLE_PROVIDER,
          allow_openai_fallback: AURORA_LLM_OPENAI_FALLBACK_ENABLED,
          product_qa_mode: AURORA_PRODUCT_RELEVANCE_QA_MODE,
        },
      });
      if (guardrailResult && Array.isArray(guardrailResult.rejected) && guardrailResult.rejected.length > 0) {
        persistRejectedCatalogCandidates(ctx, guardrailResult.rejected);
      }
      return res.json(guardrailResult && guardrailResult.envelope ? guardrailResult.envelope : output.envelope);
    } catch (err) {
      const status = err.status || 500;
      logger?.error(
        {
          err: err && err.message ? err.message : String(err),
          code: err && err.code ? err.code : null,
          stack: err && err.stack ? String(err.stack) : null,
          request_id: ctx.request_id,
          trace_id: ctx.trace_id,
          aurora_uid: ctx.aurora_uid,
        },
        'aurora bff: /v1/analysis/skin failed',
      );
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to generate skin analysis.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: err.code || 'ANALYSIS_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: err.code || 'ANALYSIS_FAILED' })],
      });
      return res.status(status).json(envelope);
    }
  });
}

module.exports = { mountSkinAnalysisRoutes };
