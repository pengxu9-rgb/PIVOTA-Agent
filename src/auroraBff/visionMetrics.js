const {
  VisionUnavailabilityReason,
  normalizeVisionFailureReason,
  isVisionFailureReason,
} = require('./visionPolicy');

const LATENCY_BUCKETS_MS = Object.freeze([100, 250, 500, 1000, 2000, 5000, 10000, 30000, Infinity]);
const SNAPSHOT_AGE_BUCKETS_SEC = Object.freeze([60, 300, 1800, 3600, 21600, 86400, 259200, 604800, 1209600, Infinity]);

const callsCounter = new Map();
const failCounter = new Map();
const fallbackCounter = new Map();
const latencyByProvider = new Map();
const ensembleProviderCalls = new Map();
const ensembleProviderFails = new Map();
const ensembleProviderSchemaFails = new Map();
const ensembleLatencyByProvider = new Map();
const ensembleAgreementHistogram = new Map([
  [0.2, 0],
  [0.4, 0],
  [0.6, 0],
  [0.8, 0],
  [1.0, 0],
]);
let ensembleAgreementCount = 0;
let ensembleAgreementSum = 0;
const verifierCalls = new Map();
const verifierFails = new Map();
const verifierUnknownErrorClassFails = new Map();
let verifierBudgetGuardCount = 0;
let verifierCircuitOpenCount = 0;
let verifierRetryCount = 0;
const verifierTimeoutByStage = new Map();
const verifierAgreementHistogram = new Map([
  [0.2, 0],
  [0.4, 0],
  [0.6, 0],
  [0.8, 0],
  [1.0, 0],
]);
let verifierAgreementCount = 0;
let verifierAgreementSum = 0;
let verifierHardCaseCount = 0;
const analyzeRequestsCounter = new Map();
const geometrySanitizerDropCounter = new Map();
const geometrySanitizerClipCounter = new Map();
const photoModulesCardEmittedCounter = new Map();
const regionsEmittedCounter = new Map();
const modulesIssueCountHistogramCounter = new Map();
const ingredientActionsEmittedCounter = new Map();
const geometrySanitizerDropReasonCounter = new Map();
const skinmaskFallbackCounter = new Map();
const productRecEmittedCounter = new Map();
const productRecSuppressedCounter = new Map();
const claimsTemplateFallbackCounter = new Map();
const claimsViolationCounter = new Map();
let skinmaskEnabledCount = 0;
const skinmaskInferLatency = {
  count: 0,
  sum: 0,
  buckets: new Map(LATENCY_BUCKETS_MS.map((bucket) => [bucket, 0])),
};
let clarificationIdNormalizedEmptyCount = 0;
const catalogAvailabilityShortCircuitCounter = new Map();
const repeatedClarifyFieldCounter = new Map();
const clarificationPresentCounter = new Map();
const clarificationQuestionFilteredCounter = new Map();
let clarificationAllQuestionsFilteredCount = 0;
const clarificationSchemaInvalidCounter = new Map();
let clarificationFlowV2StartedCount = 0;
const pendingClarificationStepCounter = new Map();
let pendingClarificationCompletedCount = 0;
const pendingClarificationAbandonedCounter = new Map();
const clarificationHistorySentCounter = new Map();
const auroraChatSkippedCounter = new Map();
const pendingClarificationUpgradedCounter = new Map();
const pendingClarificationTruncatedCounter = new Map();
const resumePrefixInjectedCounter = new Map();
const resumePrefixHistoryItemsCounter = new Map();
const resumeResponseModeCounter = new Map();
const resumePlaintextReaskDetectedCounter = new Map();
const profileContextMissingCounter = new Map();
const sessionPatchProfileEmittedCounter = new Map();
const upstreamCallsCounter = new Map();
const upstreamLatencyByPath = new Map();
const templateAppliedCounter = new Map();
const templateFallbackCounter = new Map();
const antiTemplateViolationCounter = new Map();
const actionableReplyCounter = new Map();
const recoGuardrailViolationCounter = new Map();
const recoCandidateCounter = new Map();
const recoExplanationAlignmentCounter = new Map();
const recoGuardrailCircuitOpenCounter = new Map();
const recoEmployeeFeedbackCounter = new Map();
const recoInterleaveClickCounter = new Map();
const recoInterleaveWinCounter = new Map();
const recoExplorationSlotCounter = new Map();
const recoAsyncUpdateCounter = new Map();
const recoAsyncUpdateChangedItemsCounter = new Map();
const recoContextUsedCounter = new Map();
const travelPlanSelectionCounter = new Map();
const auroraRoute404Counter = new Map();
const auroraTravelPlansNonJsonCounter = new Map();
const auroraTravelLlmCallCounter = new Map();
const auroraTravelLlmTriggerCounter = new Map();
const auroraTravelLlmSkipCounter = new Map();
const auroraTravelSkillSkipCounter = new Map();
const auroraTravelKbHitCounter = new Map();
const auroraTravelKbWriteCounter = new Map();
const auroraTravelResponseSourceCounter = new Map();
const auroraTravelWeatherSourceCounter = new Map();
const auroraTravelForecastSourceCounter = new Map();
const auroraTravelAlertSourceCounter = new Map();
const auroraTravelBaselineIntegrityCounter = new Map();
const auroraTravelResponseQualityCounter = new Map();
const auroraTravelReplyModeCounter = new Map();
const auroraTravelEnvCardEmittedCounter = new Map();
const prelabelRequestsCounter = new Map();
const prelabelSuccessCounter = new Map();
const prelabelInvalidJsonCounter = new Map();
const prelabelCacheHitCounter = new Map();
const prelabelSuggestionsGeneratedCounter = new Map();
const prelabelQueueItemsServedCounter = new Map();
const socialFetchRequestsCounter = new Map();
const socialFetchSuccessCounter = new Map();
const socialFetchTimeoutCounter = new Map();
const socialKbBackfillCounter = new Map();
const auroraCompSnapshotHitCounter = new Map();
const auroraCompSnapshotStaleCounter = new Map();
const auroraCompDegradedCounter = new Map();
const auroraCompBackfillEnqueuedCounter = new Map();
const auroraCompBackfillDedupDropCounter = new Map();
const auroraCompPass2InvokedCounter = new Map();
const auroraCompPass2TimeoutCounter = new Map();
const auroraCompSnapshotAgeSecHistogram = {
  count: 0,
  sum: 0,
  buckets: new Map(SNAPSHOT_AGE_BUCKETS_SEC.map((bucket) => [bucket, 0])),
};
const prelabelGeminiLatency = {
  count: 0,
  sum: 0,
  buckets: new Map(LATENCY_BUCKETS_MS.map((bucket) => [bucket, 0])),
};
let recoCompetitorsSameBrandRateGauge = 0;
let recoCompetitorsOnPageSourceRateGauge = 0;
let recoExplanationAlignmentAt3Gauge = 0;
let prelabelCacheHitRateGauge = 0;
let prelabelOverturnedRateGauge = 0;
let socialCacheHitRateGauge = 0;
let socialChannelsCoverageGauge = 0;
let chipsTruncatedCount = 0;
let fieldMissingAddedCount = 0;
let modulesInteractionCount = 0;
let actionClickCount = 0;
let actionCopyCount = 0;
let retakeAfterModulesCount = 0;
const auroraSkinFlowCounter = new Map();
const auroraSkinLlmSchemaViolationCounter = new Map();
const auroraSkinLlmRetryCounter = new Map();
const auroraSkinLlmRetrySuccessCounter = new Map();
const auroraSkinMainlineProviderCounter = new Map();
const auroraSkinFallbackDeterministicCounter = new Map();
const auroraSkinShadowVerifyIsolatedWriteCounter = new Map();
const auroraSkinSemanticGuardCounter = new Map();
const auroraSkinUsefulOutputCounter = new Map();
const auroraIngredientsFlowCounter = new Map();
const auroraIngredientProviderCounter = new Map();
const ingredientReportGeneratedCounter = new Map();
const ingredientReportGenericFallbackCounter = new Map();
const ingredientReportPendingCounter = new Map();
const INGREDIENT_REPORT_UNIQUENESS_WINDOW = 512;
const ingredientReportFingerprintWindow = [];
const ingredientReportFingerprintFreq = new Map();
let ingredientReportUniquenessRatioGauge = 0;
const auroraIngredientsFirstAnswerLatency = {
  count: 0,
  sum: 0,
  buckets: new Map(LATENCY_BUCKETS_MS.map((bucket) => [bucket, 0])),
};
const auroraSkinAnalysisRealModelCounter = new Map();
const auroraSkinLlmCallCounter = new Map();
const auroraRecoLlmCallCounter = new Map();
let recoAlternativesBudgetExhaustedTotal = 0;
let recoAlternativesTimeoutTotal = 0;
let recoAlternativesEmptyTotal = 0;
let promptContractMismatchTotal = 0;
const auroraRecoEntrySourceCounter = new Map();
const auroraRecoKbWriteCounter = new Map();
const auroraProfileAutoPatchCounter = new Map();
const auroraRecoContextUsedCounter = new Map();
const responseSchemaViolationCounter = new Map();
const auroraKbV0LoaderErrorCounter = new Map();
const auroraKbV0RuleMatchCounter = new Map();
const auroraKbV0LegacyFallbackCounter = new Map();
const auroraKbV0ClimateFallbackCounter = new Map();
const fpmClarifyReasonCounter = new Map();
const fpmRepeatedSlotClarifyCounter = new Map();
const fpmContextFailOpenCounter = new Map();
const fpmProductsAfterClarifyCounter = new Map();
let fpmProductsAfterClarifySeen = 0;
let fpmProductsAfterClarifyHit = 0;
let fpmProductsAfterClarifyRateGauge = 0;
const VERIFY_FAIL_REASON_ALLOWLIST = new Set([
  'TIMEOUT',
  'RATE_LIMIT',
  'QUOTA',
  'UPSTREAM_4XX',
  'UPSTREAM_5XX',
  'SCHEMA_INVALID',
  'IMAGE_FETCH_FAILED',
  'NETWORK_ERROR',
  'UNKNOWN',
]);

function cleanLabel(value, fallback) {
  const raw = String(value == null ? '' : value).trim();
  return raw || fallback;
}

function cleanMetricToken(value, fallback = 'unknown') {
  const raw = String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return raw || fallback;
}

function normalizeQualityGrade(grade) {
  const token = cleanMetricToken(grade, 'unknown');
  if (token === 'pass' || token === 'degraded' || token === 'fail' || token === 'unknown') return token;
  return 'unknown';
}

function normalizePipelineVersion(version) {
  const token = cleanMetricToken(version, 'unknown');
  if (token === 'a' || token === 'b') return token.toUpperCase();
  return 'unknown';
}

function normalizeDeviceClass(deviceClass) {
  return cleanMetricToken(deviceClass, 'unknown');
}

function normalizeInputHashPrefix(inputHashPrefix) {
  const token = cleanMetricToken(inputHashPrefix, 'none');
  return token.slice(0, 8) || 'none';
}

function normalizeIssueType(issueType) {
  return cleanMetricToken(issueType, 'all');
}

function normalizeRegionType(regionType) {
  const token = cleanMetricToken(regionType, 'unknown');
  if (token === 'bbox' || token === 'polygon' || token === 'heatmap') return token;
  return 'unknown';
}

function normalizeModuleId(moduleId) {
  return cleanMetricToken(moduleId, 'unknown');
}

function normalizeMarketScope(market) {
  const token = String(market || '').trim().toUpperCase();
  if (token === 'EU' || token === 'US' || token === 'CN' || token === 'JP') return token;
  return 'UNKNOWN';
}

function normalizeSuppressedReason(reason) {
  const token = cleanMetricToken(reason, 'unknown').toUpperCase();
  if (token === 'NO_CATALOG_MATCH') return 'NO_MATCH';
  if (token === 'LOW_EVIDENCE' || token === 'RISK_TIER' || token === 'DEGRADED' || token === 'NO_MATCH') {
    return token;
  }
  return 'UNKNOWN';
}

function normalizeSkinmaskFallbackReason(reason) {
  const token = cleanMetricToken(reason, 'onnx_fail').toUpperCase();
  if (token === 'DISABLED' || token === 'MODEL_MISSING' || token === 'TIMEOUT' || token === 'ONNX_FAIL') return token;
  return 'ONNX_FAIL';
}

function normalizeSanitizerReason(reason) {
  return cleanMetricToken(reason, 'unknown');
}

function normalizeUiEventName(eventName) {
  return cleanMetricToken(eventName, 'unknown');
}

function normalizeVerifyFailReason(reason) {
  const token = cleanMetricToken(reason, 'unknown').toUpperCase();
  if (VERIFY_FAIL_REASON_ALLOWLIST.has(token)) return token;
  if (token.includes('TIMEOUT')) return 'TIMEOUT';
  if (token.includes('RATE_LIMIT')) return 'RATE_LIMIT';
  if (token.includes('QUOTA')) return 'QUOTA';
  if (token.includes('SCHEMA_INVALID')) return 'SCHEMA_INVALID';
  if (token.includes('IMAGE_FETCH') || token.includes('MISSING_IMAGE') || token.includes('PHOTO_DOWNLOAD')) return 'IMAGE_FETCH_FAILED';
  if (token.includes('NETWORK_ERROR') || token.includes('DNS')) return 'NETWORK_ERROR';
  if (token.includes('UPSTREAM_5XX')) return 'UPSTREAM_5XX';
  if (token.includes('UPSTREAM_4XX')) return 'UPSTREAM_4XX';
  return 'UNKNOWN';
}

function normalizeVerifyProvider(provider) {
  return cleanMetricToken(provider, 'unknown');
}

function normalizeHttpStatusClass(statusClass, reason) {
  const token = cleanMetricToken(statusClass, '');
  if (token === '2xx' || token === '4xx' || token === '5xx' || token === 'timeout' || token === 'unknown') {
    return token;
  }
  const fromReason = cleanMetricToken(reason, '');
  if (fromReason.includes('timeout')) return 'timeout';
  return 'unknown';
}

function normalizeTimeoutStage(stage) {
  const token = cleanMetricToken(stage, '');
  if (token === 'connect' || token === 'read' || token === 'total') return token;
  return 'unknown';
}

function normalizeVerifyErrorClass(errorClass) {
  return cleanMetricToken(errorClass, 'unknown');
}

function normalizeCatalogBrandId(brandId) {
  return cleanMetricToken(brandId, 'unknown');
}

function normalizeCatalogAvailabilityReason(reason) {
  return cleanMetricToken(reason, 'unknown');
}

function normalizeClarifyField(field) {
  return cleanMetricToken(field, 'unknown');
}

function normalizeClarificationPresentFlag(present) {
  return present ? 'true' : 'false';
}

function normalizeClarificationSchemaInvalidReason(reason) {
  return cleanMetricToken(reason, 'unknown');
}

function normalizePendingClarificationStepIndex(stepIndex) {
  const n = Number(stepIndex);
  if (!Number.isFinite(n) || n <= 0) return '1';
  return String(Math.max(1, Math.min(32, Math.trunc(n))));
}

function normalizePendingClarificationAbandonReason(reason) {
  const token = cleanMetricToken(reason, 'error');
  if (token === 'free_text' || token === 'ttl' || token === 'missing_state' || token === 'error') return token;
  return 'error';
}

function normalizeClarificationHistoryCount(count) {
  const n = Number(count);
  if (!Number.isFinite(n) || n < 0) return '0';
  return String(Math.max(0, Math.min(5, Math.trunc(n))));
}

function normalizeAuroraChatSkippedReason(reason) {
  return cleanMetricToken(reason, 'unknown');
}

function normalizePendingClarificationUpgradeFrom(from) {
  const token = cleanMetricToken(from, 'legacy');
  if (token === 'legacy') return token;
  return 'legacy';
}

function normalizePendingClarificationTruncatedField(field) {
  const token = cleanMetricToken(field, 'unknown');
  if (
    token === 'resume_user_text' ||
    token === 'question' ||
    token === 'option' ||
    token === 'queue' ||
    token === 'options' ||
    token === 'history'
  ) {
    return token;
  }
  return 'unknown';
}

function normalizeResumePrefixEnabledFlag(enabled) {
  return enabled ? 'true' : 'false';
}

function normalizeResumePrefixHistoryItemsCount(count) {
  const n = Number(count);
  if (!Number.isFinite(n) || n < 0) return '0';
  return String(Math.max(0, Math.min(6, Math.trunc(n))));
}

function normalizeResumeResponseMode(mode) {
  const token = cleanMetricToken(mode, 'mixed');
  if (token === 'answer' || token === 'question' || token === 'mixed') return token;
  return 'mixed';
}

function normalizeResumeReaskField(field) {
  const token = cleanMetricToken(field, 'unknown');
  if (
    token === 'skintype' ||
    token === 'sensitivity' ||
    token === 'barrierstatus' ||
    token === 'goals' ||
    token === 'budgettier'
  ) {
    return token;
  }
  return 'unknown';
}

function normalizeProfileContextSide(side) {
  const token = cleanMetricToken(side, 'unknown');
  if (token === 'frontend' || token === 'backend') return token;
  return 'unknown';
}

function normalizeSessionPatchChangedFlag(changed) {
  return changed ? 'true' : 'false';
}

function normalizeUpstreamPath(path) {
  return cleanMetricToken(path, 'unknown');
}

function normalizeUpstreamStatus(status) {
  return cleanMetricToken(status, 'unknown');
}

function normalizeTemplateModule(moduleName) {
  return cleanMetricToken(moduleName, 'unknown');
}

function normalizeTemplateVariant(variant) {
  return cleanMetricToken(variant, 'unknown');
}

function normalizeTemplateId(templateId) {
  return cleanMetricToken(templateId, 'unknown');
}

function normalizeTemplateSource(source) {
  return cleanMetricToken(source, 'unknown');
}

function normalizeTemplateFallbackReason(reason) {
  return cleanMetricToken(reason, 'unknown');
}

function normalizeAntiTemplateRule(rule) {
  return cleanMetricToken(rule, 'unknown');
}

function normalizeBoolLabel(value) {
  return value ? 'true' : 'false';
}

function normalizeRecoBlock(block) {
  const token = cleanMetricToken(block, 'unknown');
  if (token === 'competitors' || token === 'related_products' || token === 'dupes') return token;
  return 'unknown';
}

function normalizeRecoViolationType(violationType) {
  const token = cleanMetricToken(violationType, 'unknown');
  if (token === 'same_brand' || token === 'on_page_source') return token;
  return 'unknown';
}

function normalizeRecoGuardAction(action) {
  const token = cleanMetricToken(action, 'sanitize');
  if (token === 'sanitize' || token === 'circuit_open' || token === 'circuit_drop') return token;
  return 'sanitize';
}

function normalizeRecoMode(mode) {
  const token = cleanMetricToken(mode, 'unknown');
  if (token === 'main_path' || token === 'sync_repair' || token === 'async_backfill') return token;
  return 'unknown';
}

function normalizeRecoBrandRelation(brandRelation) {
  const token = cleanMetricToken(brandRelation, 'unknown');
  if (token === 'same_brand' || token === 'cross_brand' || token === 'unknown') return token;
  return 'unknown';
}

function normalizeRecoAligned(aligned) {
  return aligned ? 'true' : 'false';
}

function normalizeRecoFeedbackType(feedbackType) {
  const token = cleanMetricToken(feedbackType, 'unknown');
  if (token === 'relevant' || token === 'not_relevant' || token === 'wrong_block') return token;
  return 'unknown';
}

function normalizeRecoAttribution(attribution) {
  const token = cleanMetricToken(attribution, 'unknown');
  if (token === 'a' || token === 'b' || token === 'both' || token === 'explore') return token;
  return 'unknown';
}

function normalizeRecoRanker(ranker) {
  return cleanMetricToken(ranker, 'unknown');
}

function normalizeRecoCategoryBucket(bucket) {
  return cleanMetricToken(bucket, 'unknown');
}

function normalizeRecoPriceBand(priceBand) {
  const token = cleanMetricToken(priceBand, 'unknown');
  if (token === 'budget' || token === 'mid' || token === 'premium' || token === 'luxury' || token === 'unknown') return token;
  return 'unknown';
}

function normalizeRecoAsyncResult(result) {
  const token = cleanMetricToken(result, 'unknown');
  if (token === 'applied' || token === 'skipped' || token === 'noop' || token === 'error') return token;
  return 'unknown';
}

function normalizeAuroraSkinFlowStage(stage) {
  const token = cleanMetricToken(stage, 'unknown');
  if (
    token === 'analysis_request' ||
    token === 'artifact_created' ||
    token === 'ingredient_plan' ||
    token === 'analysis_timeout_degraded' ||
    token === 'analysis_optional_step' ||
    token === 'reco_request' ||
    token === 'reco_generated' ||
    token === 'reco_low_confidence' ||
    token === 'reco_safety_block' ||
    token === 'reco_timeout_degraded' ||
    token === 'reco_output_guard_fallback' ||
    token === 'reco_prompt_contract_mismatch'
  ) {
    return token;
  }
  return 'unknown';
}

function normalizeAuroraSkinFlowOutcome(outcome) {
  const token = cleanMetricToken(outcome, 'hit');
  if (token === 'hit' || token === 'miss') return token;
  return 'hit';
}

function normalizeAuroraIngredientsFlowStage(stage) {
  const token = cleanMetricToken(stage, 'unknown');
  if (
    token === 'entry_opened' ||
    token === 'text_query_routed' ||
    token === 'text_route_drift' ||
    token === 'mode_selected' ||
    token === 'answer_served' ||
    token === 'text_query_routed' ||
    token === 'text_route_drift' ||
    token === 'kb_hit' ||
    token === 'kb_miss' ||
    token === 'kb_updated' ||
    token === 'research_requested' ||
    token === 'research_completed' ||
    token === 'research_provider_attempt' ||
    token === 'research_provider_final' ||
    token === 'research_error' ||
    token === 'report_generated' ||
    token === 'report_pending' ||
    token === 'provider_unavailable' ||
    token === 'minimal_fallback' ||
    token === 'invalid_json' ||
    token === 'empty_section_prevented' ||
    token === 'duplicate_job_dedup' ||
    token === 'rate_limited' ||
    token === 'circuit_open' ||
    token === 'card_render_drop' ||
    token === 'optin_diagnosis' ||
    token === 'reco_optin' ||
    token === 'unwanted_diagnosis'
  ) {
    return token;
  }
  return 'unknown';
}

function normalizeAuroraIngredientsFlowOutcome(outcome) {
  const token = cleanMetricToken(outcome, 'hit');
  if (token === 'hit' || token === 'miss') return token;
  return 'hit';
}

function normalizeAuroraIngredientsFlowProvider(provider) {
  return cleanMetricToken(provider, 'unknown');
}

function normalizeAuroraIngredientProviderStage(stage) {
  const token = cleanMetricToken(stage, 'attempt');
  if (token === 'attempt' || token === 'final') return token;
  return 'attempt';
}

function normalizeAuroraIngredientProvider(provider) {
  const token = cleanMetricToken(provider, 'gemini');
  if (token === 'gemini' || token === 'openai') return token;
  return 'gemini';
}

function normalizeAuroraIngredientProviderOutcome(outcome) {
  const token = cleanMetricToken(outcome, 'unknown');
  return token || 'unknown';
}

function normalizeIngredientReportMode(mode) {
  const token = cleanMetricToken(mode, 'deterministic');
  if (token === 'deterministic' || token === 'hybrid' || token === 'llm_enriched') return token;
  return 'deterministic';
}

function normalizeIngredientReportStatus(status) {
  const token = cleanMetricToken(status, 'partial');
  if (token === 'ready' || token === 'partial' || token === 'pending' || token === 'failed') return token;
  return 'partial';
}

function normalizeIngredientReportReasonCode(reasonCode) {
  const token = cleanMetricToken(reasonCode, 'none');
  if (
    token === 'provider_unavailable' ||
    token === 'timeout' ||
    token === 'insufficient_evidence' ||
    token === 'kb_only' ||
    token === 'none'
  ) {
    return token;
  }
  return 'other';
}

function normalizeAuroraAnalysisSource(source) {
  return cleanMetricToken(source, 'unknown');
}

function normalizeAuroraLlmStage(stage) {
  const token = cleanMetricToken(stage, 'vision');
  if (token === 'vision' || token === 'report') return token;
  return 'vision';
}

function normalizeAuroraLlmCallOutcome(outcome) {
  const token = cleanMetricToken(outcome, 'skip');
  if (
    token === 'call' ||
    token === 'skip' ||
    token === 'error' ||
    token === 'policy_skip' ||
    token === 'precheck_fail' ||
    token === 'provider_error'
  ) {
    return token;
  }
  return 'skip';
}

function normalizeAuroraRecoLlmStage(stage) {
  const token = cleanMetricToken(stage, 'main');
  if (token === 'main' || token === 'alternatives') return token;
  return 'main';
}

function normalizeAuroraRecoLlmCallOutcome(outcome) {
  const token = cleanMetricToken(outcome, 'provider_error');
  if (
    token === 'success' ||
    token === 'policy_skip' ||
    token === 'precheck_fail' ||
    token === 'budget_exhausted' ||
    token === 'prompt_contract_mismatch' ||
    token === 'provider_error' ||
    token === 'timeout' ||
    token === 'empty_structured' ||
    token === 'empty_structured_clarify'
  ) {
    return token;
  }
  return 'provider_error';
}

function normalizeAuroraRecoEntrySource(source) {
  const token = cleanMetricToken(source, 'goal_driven');
  if (token === 'goal_driven' || token === 'ingredient_driven' || token === 'profile_refine_rerun') return token;
  return 'goal_driven';
}

function normalizeAuroraRecoKbWriteSource(source) {
  const token = cleanMetricToken(source, 'llm_primary');
  if (token === 'llm_primary' || token === 'artifact_matcher' || token === 'rules_only') return token;
  return 'llm_primary';
}

function normalizeAuroraRecoKbWriteOutcome(outcome) {
  const token = cleanMetricToken(outcome, 'attempted');
  if (
    token === 'attempted' ||
    token === 'persisted' ||
    token === 'quarantined' ||
    token === 'skipped' ||
    token === 'error'
  ) {
    return token;
  }
  return 'attempted';
}

function normalizeAuroraProfileAutoPatchField(field) {
  const token = cleanMetricToken(field, 'unknown');
  if (
    token === 'skintype' ||
    token === 'sensitivity' ||
    token === 'barrierstatus' ||
    token === 'goals' ||
    token === 'currentroutine' ||
    token === 'recentlogs'
  ) {
    return token;
  }
  return 'unknown';
}

function normalizeAuroraProfileAutoPatchOutcome(outcome) {
  const token = cleanMetricToken(outcome, 'applied');
  if (
    token === 'applied' ||
    token === 'persisted' ||
    token === 'persist_error' ||
    token === 'corrected' ||
    token === 'skipped'
  ) {
    return token;
  }
  return 'applied';
}

function normalizeAuroraRecoContextSignal(signal) {
  const token = cleanMetricToken(signal, 'recent_logs');
  if (token === 'recent_logs' || token === 'itinerary' || token === 'safety') return token;
  return 'recent_logs';
}

function normalizeSchemaViolationReason(reason) {
  return cleanMetricToken(reason, 'response_validation_failed');
}

function normalizeSchemaViolationPath(path) {
  return cleanMetricToken(path, 'unknown_path');
}

function normalizeFpmClarifyReason(reasonCode) {
  const token = cleanMetricToken(reasonCode, 'unknown').toUpperCase();
  return token || 'UNKNOWN';
}

function normalizeFpmSlot(slot) {
  const token = cleanMetricToken(slot, 'unknown');
  if (token === 'scenario' || token === 'category' || token === 'budget' || token === 'brand') {
    return token;
  }
  return 'unknown';
}

function normalizeFpmProductsAfterClarifyOutcome(hasProducts) {
  return hasProducts ? 'hit' : 'miss';
}

function normalizeAuroraKbV0Reason(reason) {
  return cleanMetricToken(reason, 'unknown');
}

function normalizeAuroraKbV0RuleSource(source) {
  const token = cleanMetricToken(source, 'unknown');
  if (token === 'kb_v0' || token === 'legacy') return token;
  return 'unknown';
}

function normalizeAuroraKbV0RuleLevel(level) {
  return cleanMetricToken(level, 'unknown');
}

function normalizeRecoContextSignal(signal) {
  const token = cleanMetricToken(signal, 'unknown');
  if (token === 'active_trip' || token === 'home_region_weather' || token === 'climate_fallback') return token;
  return 'unknown';
}

function normalizeTravelPlanSelectionMode(mode) {
  const token = cleanMetricToken(mode, 'none');
  if (token === 'in_range' || token === 'nearest_upcoming' || token === 'none') return token;
  return 'none';
}

function normalizeAuroraRoutePath(route) {
  const token = String(route || '').trim();
  if (
    token === '/v1/travel-plans' ||
    token === '/v1/travel-plans/:trip_id' ||
    token === '/v1/travel-plans/:trip_id/archive'
  ) {
    return token;
  }
  return '/v1/travel-plans';
}

function normalizeHttpStatusFamily(status) {
  const n = Number(status);
  if (!Number.isFinite(n) || n <= 0) return 'unknown';
  if (n >= 100 && n < 200) return '1xx';
  if (n >= 200 && n < 300) return '2xx';
  if (n >= 300 && n < 400) return '3xx';
  if (n >= 400 && n < 500) return '4xx';
  if (n >= 500 && n < 600) return '5xx';
  return 'unknown';
}

function normalizeAuroraTravelLlmOutcome(outcome) {
  const token = cleanMetricToken(outcome, 'skip_no_client');
  if (
    token === 'call' ||
    token === 'skip_no_client' ||
    token === 'skip_conditions_not_matched' ||
    token === 'skip_destination_missing' ||
    token === 'skip_disabled' ||
    token === 'timeout' ||
    token === 'error'
  ) {
    return token;
  }
  return 'error';
}

function normalizeAuroraTravelLlmTriggerReason(reason) {
  const token = cleanMetricToken(reason, 'destination_present');
  if (token === 'destination_present') return token;
  return 'destination_present';
}

function normalizeAuroraTravelLlmSkipReason(reason) {
  const token = cleanMetricToken(reason, 'disabled');
  if (token === 'destination_missing' || token === 'disabled') return token;
  return 'disabled';
}

function normalizeAuroraTravelSkillSkipSkill(skill) {
  const token = cleanMetricToken(skill, 'travel_unknown_skill');
  if (
    token === 'travel_reco_preview_skill' ||
    token === 'travel_store_channel_skill' ||
    token === 'travel_kb_write_skill' ||
    token === 'travel_llm_calibration_skill'
  ) {
    return token;
  }
  return 'travel_unknown_skill';
}

function normalizeAuroraTravelSkillSkipReason(reason) {
  const token = cleanMetricToken(reason, 'unknown');
  if (
    token === 'trigger_not_matched' ||
    token === 'destination_missing' ||
    token === 'no_products' ||
    token === 'no_channels' ||
    token === 'safety_conflict' ||
    token === 'incomplete_structure' ||
    token === 'backpressure_drop' ||
    token === 'entry_invalid' ||
    token === 'queued'
  ) {
    return token;
  }
  return 'unknown';
}

function normalizeAuroraTravelKbHitMode(mode) {
  const token = cleanMetricToken(mode, 'miss');
  if (token === 'hit' || token === 'miss') return token;
  return 'miss';
}

function normalizeAuroraTravelKbWriteOutcome(outcome) {
  const token = cleanMetricToken(outcome, 'skip');
  if (token === 'queued' || token === 'success' || token === 'skip' || token === 'error') return token;
  return 'skip';
}

function normalizeAuroraTravelKbWriteReason(reason) {
  return cleanMetricToken(reason, 'unknown');
}

function normalizeAuroraTravelResponseSource(source) {
  const token = cleanMetricToken(source, 'rules_only');
  if (token === 'llm_enriched' || token === 'rules_only') return token;
  return 'rules_only';
}

function normalizeAuroraTravelWeatherSource(source) {
  const token = cleanMetricToken(source, 'climate_fallback');
  if (token === 'weather_api' || token === 'climate_fallback') return token;
  return 'climate_fallback';
}

function normalizeAuroraTravelWeatherReason(reason) {
  const token = cleanMetricToken(reason, 'unknown');
  if (
    token === 'live_ok' ||
    token === 'live_timeout' ||
    token === 'live_http_error' ||
    token === 'geocode_failed' ||
    token === 'live_disabled' ||
    token === 'live_error'
  ) {
    return token;
  }
  return 'unknown';
}

function normalizeAuroraTravelForecastSource(source) {
  const token = cleanMetricToken(source, 'climate_fallback');
  if (token === 'weather_api' || token === 'climate_fallback') return token;
  return 'climate_fallback';
}

function normalizeAuroraTravelAlertSource(source) {
  const token = cleanMetricToken(source, 'none');
  if (token === 'official_api' || token === 'none' || token === 'degraded') return token;
  return 'none';
}

function normalizeAuroraTravelBaselineIntegrity(status) {
  const token = cleanMetricToken(status, 'ok');
  if (token === 'ok' || token === 'missing' || token === 'invalid_zero_coercion') return token;
  return 'ok';
}

function normalizeAuroraTravelResponseQualitySection(section) {
  const token = cleanMetricToken(section, 'unknown');
  if (token === 'answer_delta' || token === 'actions' || token === 'products' || token === 'alerts') return token;
  return 'unknown';
}

function normalizeAuroraTravelReplyMode(mode) {
  const token = cleanMetricToken(mode, 'fallback');
  if (token === 'focused' || token === 'fallback' || token === 'followup_text_only') return token;
  return 'fallback';
}

function normalizeAuroraTravelEnvCardTurn(turn) {
  const token = cleanMetricToken(turn, 'first_turn');
  if (token === 'first_turn' || token === 'followup') return token;
  return 'first_turn';
}

function geometryLabels({ issueType, qualityGrade, pipelineVersion, deviceClass } = {}) {
  return {
    issue_type: normalizeIssueType(issueType),
    quality_grade: normalizeQualityGrade(qualityGrade),
    pipeline_version: normalizePipelineVersion(pipelineVersion),
    device_class: normalizeDeviceClass(deviceClass),
  };
}

function keyFromLabels(labels) {
  return JSON.stringify(labels);
}

function parseLabelsKey(key) {
  try {
    const parsed = JSON.parse(key);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_err) {
    return {};
  }
}

function incCounter(counterMap, labels, delta = 1) {
  const key = keyFromLabels(labels);
  const next = (counterMap.get(key) || 0) + delta;
  counterMap.set(key, next);
}

function ensureLatencyState(provider) {
  const p = cleanLabel(provider, 'unknown');
  let state = latencyByProvider.get(p);
  if (!state) {
    state = {
      count: 0,
      sum: 0,
      buckets: new Map(LATENCY_BUCKETS_MS.map((bucket) => [bucket, 0])),
    };
    latencyByProvider.set(p, state);
  }
  return state;
}

function ensureEnsembleLatencyState(provider) {
  const p = cleanLabel(provider, 'unknown');
  let state = ensembleLatencyByProvider.get(p);
  if (!state) {
    state = {
      count: 0,
      sum: 0,
      buckets: new Map(LATENCY_BUCKETS_MS.map((bucket) => [bucket, 0])),
    };
    ensembleLatencyByProvider.set(p, state);
  }
  return state;
}

function ensureUpstreamLatencyState(path) {
  const p = cleanLabel(path, 'unknown');
  let state = upstreamLatencyByPath.get(p);
  if (!state) {
    state = {
      count: 0,
      sum: 0,
      buckets: new Map(LATENCY_BUCKETS_MS.map((bucket) => [bucket, 0])),
    };
    upstreamLatencyByPath.set(p, state);
  }
  return state;
}

function observeVisionLatency({ provider, latencyMs } = {}) {
  const latency = Number(latencyMs);
  if (!Number.isFinite(latency) || latency < 0) return;
  const state = ensureLatencyState(provider);
  state.count += 1;
  state.sum += latency;
  for (const bucket of LATENCY_BUCKETS_MS) {
    if (latency <= bucket) {
      state.buckets.set(bucket, (state.buckets.get(bucket) || 0) + 1);
    }
  }
}

function observeUpstreamLatency({ path, latencyMs } = {}) {
  const latency = Number(latencyMs);
  if (!Number.isFinite(latency) || latency < 0) return;
  const state = ensureUpstreamLatencyState(path);
  state.count += 1;
  state.sum += latency;
  for (const bucket of LATENCY_BUCKETS_MS) {
    if (latency <= bucket) {
      state.buckets.set(bucket, (state.buckets.get(bucket) || 0) + 1);
    }
  }
}

function recordClarificationIdNormalizedEmpty() {
  clarificationIdNormalizedEmptyCount += 1;
}

function recordCatalogAvailabilityShortCircuit({ brandId, reason } = {}) {
  incCounter(
    catalogAvailabilityShortCircuitCounter,
    {
      brand_id: normalizeCatalogBrandId(brandId),
      reason: normalizeCatalogAvailabilityReason(reason),
    },
    1,
  );
}

function recordRepeatedClarifyField({ field } = {}) {
  incCounter(repeatedClarifyFieldCounter, { field: normalizeClarifyField(field) }, 1);
}

function recordClarificationPresent({ present } = {}) {
  incCounter(
    clarificationPresentCounter,
    { present: normalizeClarificationPresentFlag(Boolean(present)) },
    1,
  );
}

function recordClarificationQuestionFiltered({ field } = {}) {
  incCounter(
    clarificationQuestionFilteredCounter,
    { field: normalizeClarifyField(field) },
    1,
  );
}

function recordClarificationAllQuestionsFiltered() {
  clarificationAllQuestionsFilteredCount += 1;
}

function recordClarificationSchemaInvalid({ reason } = {}) {
  incCounter(
    clarificationSchemaInvalidCounter,
    { reason: normalizeClarificationSchemaInvalidReason(reason) },
    1,
  );
}

function recordClarificationFlowV2Started() {
  clarificationFlowV2StartedCount += 1;
}

function recordPendingClarificationStep({ stepIndex } = {}) {
  incCounter(
    pendingClarificationStepCounter,
    { step_index: normalizePendingClarificationStepIndex(stepIndex) },
    1,
  );
}

function recordPendingClarificationCompleted() {
  pendingClarificationCompletedCount += 1;
}

function recordPendingClarificationAbandoned({ reason } = {}) {
  incCounter(
    pendingClarificationAbandonedCounter,
    { reason: normalizePendingClarificationAbandonReason(reason) },
    1,
  );
}

function recordClarificationHistorySent({ count } = {}) {
  incCounter(
    clarificationHistorySentCounter,
    { count: normalizeClarificationHistoryCount(count) },
    1,
  );
}

function recordAuroraChatSkipped({ reason } = {}) {
  incCounter(
    auroraChatSkippedCounter,
    { reason: normalizeAuroraChatSkippedReason(reason) },
    1,
  );
}

function recordPendingClarificationUpgraded({ from } = {}) {
  incCounter(
    pendingClarificationUpgradedCounter,
    { from: normalizePendingClarificationUpgradeFrom(from) },
    1,
  );
}

function recordPendingClarificationTruncated({ field } = {}) {
  incCounter(
    pendingClarificationTruncatedCounter,
    { field: normalizePendingClarificationTruncatedField(field) },
    1,
  );
}

function recordResumePrefixInjected({ enabled } = {}) {
  incCounter(
    resumePrefixInjectedCounter,
    { enabled: normalizeResumePrefixEnabledFlag(Boolean(enabled)) },
    1,
  );
}

function recordResumePrefixHistoryItems({ count } = {}) {
  incCounter(
    resumePrefixHistoryItemsCounter,
    { count: normalizeResumePrefixHistoryItemsCount(count) },
    1,
  );
}

function recordResumeResponseMode({ mode } = {}) {
  incCounter(
    resumeResponseModeCounter,
    { mode: normalizeResumeResponseMode(mode) },
    1,
  );
}

function recordResumePlaintextReaskDetected({ field } = {}) {
  incCounter(
    resumePlaintextReaskDetectedCounter,
    { field: normalizeResumeReaskField(field) },
    1,
  );
}

function recordProfileContextMissing({ side } = {}) {
  incCounter(profileContextMissingCounter, { side: normalizeProfileContextSide(side) }, 1);
}

function recordSessionPatchProfileEmitted({ changed } = {}) {
  incCounter(sessionPatchProfileEmittedCounter, { changed: normalizeSessionPatchChangedFlag(Boolean(changed)) }, 1);
}

function recordUpstreamCall({ path, status } = {}) {
  incCounter(
    upstreamCallsCounter,
    { path: normalizeUpstreamPath(path), status: normalizeUpstreamStatus(status) },
    1,
  );
}

function recordTemplateApplied({ templateId, moduleName, variant, source, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    templateAppliedCounter,
    {
      template_id: normalizeTemplateId(templateId),
      module: normalizeTemplateModule(moduleName),
      variant: normalizeTemplateVariant(variant),
      source: normalizeTemplateSource(source),
    },
    amount,
  );
}

function recordTemplateFallback({ reason, moduleName, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    templateFallbackCounter,
    {
      reason: normalizeTemplateFallbackReason(reason),
      module: normalizeTemplateModule(moduleName),
    },
    amount,
  );
}

function recordChipsTruncated({ delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  chipsTruncatedCount += amount;
}

function recordFieldMissingAdded({ delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  fieldMissingAddedCount += amount;
}

function recordAntiTemplateViolation({ rule, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    antiTemplateViolationCounter,
    { rule: normalizeAntiTemplateRule(rule) },
    amount,
  );
}

function recordActionableReply({ actionable, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    actionableReplyCounter,
    { actionable: normalizeBoolLabel(Boolean(actionable)) },
    amount,
  );
}

function recordRecoGuardrailViolation({ block, violationType, mode, action } = {}) {
  incCounter(
    recoGuardrailViolationCounter,
    {
      block: normalizeRecoBlock(block),
      violation_type: normalizeRecoViolationType(violationType),
      mode: normalizeRecoMode(mode),
      action: normalizeRecoGuardAction(action),
    },
    1,
  );
}

function recordRecoCandidate({ block, sourceType, brandRelation, mode, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    recoCandidateCounter,
    {
      block: normalizeRecoBlock(block),
      source_type: cleanMetricToken(sourceType, 'unknown'),
      brand_relation: normalizeRecoBrandRelation(brandRelation),
      mode: normalizeRecoMode(mode),
    },
    amount,
  );
}

function recordRecoExplanationAlignment({ block, aligned, mode, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    recoExplanationAlignmentCounter,
    {
      block: normalizeRecoBlock(block),
      aligned: normalizeRecoAligned(Boolean(aligned)),
      mode: normalizeRecoMode(mode),
    },
    amount,
  );
}

function recordRecoGuardrailCircuitOpen({ mode } = {}) {
  incCounter(
    recoGuardrailCircuitOpenCounter,
    { mode: normalizeRecoMode(mode) },
    1,
  );
}

function recordRecoEmployeeFeedback({ block, feedbackType, mode, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    recoEmployeeFeedbackCounter,
    {
      block: normalizeRecoBlock(block),
      feedback_type: normalizeRecoFeedbackType(feedbackType),
      mode: normalizeRecoMode(mode),
    },
    amount,
  );
}

function recordRecoInterleaveClick({ block, attribution, mode, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    recoInterleaveClickCounter,
    {
      block: normalizeRecoBlock(block),
      attribution: normalizeRecoAttribution(attribution),
      mode: normalizeRecoMode(mode),
    },
    amount,
  );
}

function recordRecoInterleaveWin({ block, ranker, categoryBucket, priceBand, mode, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    recoInterleaveWinCounter,
    {
      block: normalizeRecoBlock(block),
      ranker: normalizeRecoRanker(ranker),
      category_bucket: normalizeRecoCategoryBucket(categoryBucket),
      price_band: normalizeRecoPriceBand(priceBand),
      mode: normalizeRecoMode(mode),
    },
    amount,
  );
}

function recordRecoExplorationSlot({ block, mode, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    recoExplorationSlotCounter,
    {
      block: normalizeRecoBlock(block),
      mode: normalizeRecoMode(mode),
    },
    amount,
  );
}

function recordRecoAsyncUpdate({ block, result, mode, changedCount = 0, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  const safeChanged = Number.isFinite(Number(changedCount))
    ? Math.max(0, Math.trunc(Number(changedCount)))
    : 0;
  incCounter(
    recoAsyncUpdateCounter,
    {
      block: normalizeRecoBlock(block),
      result: normalizeRecoAsyncResult(result),
      mode: normalizeRecoMode(mode),
    },
    amount,
  );
  if (safeChanged > 0) {
    incCounter(
      recoAsyncUpdateChangedItemsCounter,
      {
        block: normalizeRecoBlock(block),
        mode: normalizeRecoMode(mode),
      },
      safeChanged,
    );
  }
}

function recordRecoContextUsed({ signal, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    recoContextUsedCounter,
    { signal: normalizeRecoContextSignal(signal) },
    amount,
  );
}

function recordTravelPlanSelection({ mode, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    travelPlanSelectionCounter,
    { mode: normalizeTravelPlanSelectionMode(mode) },
    amount,
  );
}

function recordAuroraRoute404({ route, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    auroraRoute404Counter,
    { route: normalizeAuroraRoutePath(route) },
    amount,
  );
}

function recordAuroraTravelPlansNonJson({ route, status, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    auroraTravelPlansNonJsonCounter,
    {
      route: normalizeAuroraRoutePath(route),
      status_family: normalizeHttpStatusFamily(status),
    },
    amount,
  );
}

function recordAuroraTravelLlmCall({ outcome, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    auroraTravelLlmCallCounter,
    { outcome: normalizeAuroraTravelLlmOutcome(outcome) },
    amount,
  );
}

function recordAuroraTravelLlmTrigger({ reason, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    auroraTravelLlmTriggerCounter,
    { reason: normalizeAuroraTravelLlmTriggerReason(reason) },
    amount,
  );
}

function recordAuroraTravelLlmSkip({ reason, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    auroraTravelLlmSkipCounter,
    { reason: normalizeAuroraTravelLlmSkipReason(reason) },
    amount,
  );
}

function recordAuroraTravelSkillSkip({ skill, reason, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    auroraTravelSkillSkipCounter,
    {
      skill: normalizeAuroraTravelSkillSkipSkill(skill),
      reason: normalizeAuroraTravelSkillSkipReason(reason),
    },
    amount,
  );
}

function recordAuroraTravelKbHit({ mode, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    auroraTravelKbHitCounter,
    { mode: normalizeAuroraTravelKbHitMode(mode) },
    amount,
  );
}

function recordAuroraTravelKbWrite({ outcome, reason, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    auroraTravelKbWriteCounter,
    {
      outcome: normalizeAuroraTravelKbWriteOutcome(outcome),
      reason: normalizeAuroraTravelKbWriteReason(reason),
    },
    amount,
  );
}

function recordAuroraTravelResponseSource({ source, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    auroraTravelResponseSourceCounter,
    { source: normalizeAuroraTravelResponseSource(source) },
    amount,
  );
}

function recordAuroraTravelWeatherSource({ source, reason, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    auroraTravelWeatherSourceCounter,
    {
      source: normalizeAuroraTravelWeatherSource(source),
      reason: normalizeAuroraTravelWeatherReason(reason),
    },
    amount,
  );
}

function recordAuroraTravelForecastSource({ source, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    auroraTravelForecastSourceCounter,
    { source: normalizeAuroraTravelForecastSource(source) },
    amount,
  );
}

function recordAuroraTravelAlertSource({ source, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    auroraTravelAlertSourceCounter,
    { source: normalizeAuroraTravelAlertSource(source) },
    amount,
  );
}

function recordAuroraTravelBaselineIntegrity({ status, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    auroraTravelBaselineIntegrityCounter,
    { status: normalizeAuroraTravelBaselineIntegrity(status) },
    amount,
  );
}

function recordAuroraTravelResponseQuality({ section, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    auroraTravelResponseQualityCounter,
    { section: normalizeAuroraTravelResponseQualitySection(section) },
    amount,
  );
}

function recordAuroraTravelReplyMode({ mode, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    auroraTravelReplyModeCounter,
    { mode: normalizeAuroraTravelReplyMode(mode) },
    amount,
  );
}

function recordAuroraTravelEnvCardEmitted({ turn, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    auroraTravelEnvCardEmittedCounter,
    { turn: normalizeAuroraTravelEnvCardTurn(turn) },
    amount,
  );
}

function clampRatio01(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function setRecoGuardrailRates({
  competitorsSameBrandRate,
  competitorsOnPageSourceRate,
  explanationAlignmentAt3,
} = {}) {
  recoCompetitorsSameBrandRateGauge = clampRatio01(competitorsSameBrandRate, recoCompetitorsSameBrandRateGauge);
  recoCompetitorsOnPageSourceRateGauge = clampRatio01(
    competitorsOnPageSourceRate,
    recoCompetitorsOnPageSourceRateGauge,
  );
  recoExplanationAlignmentAt3Gauge = clampRatio01(explanationAlignmentAt3, recoExplanationAlignmentAt3Gauge);
}

function observePrelabelGeminiLatency({ latencyMs } = {}) {
  const v = Number(latencyMs);
  if (!Number.isFinite(v) || v < 0) return;
  prelabelGeminiLatency.count += 1;
  prelabelGeminiLatency.sum += v;
  for (const bucket of LATENCY_BUCKETS_MS) {
    if (v <= bucket) prelabelGeminiLatency.buckets.set(bucket, (prelabelGeminiLatency.buckets.get(bucket) || 0) + 1);
  }
}

function recordPrelabelRequest({ block, mode, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    prelabelRequestsCounter,
    { block: normalizeRecoBlock(block), mode: normalizeRecoMode(mode) },
    amount,
  );
}

function recordPrelabelSuccess({ block, mode, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    prelabelSuccessCounter,
    { block: normalizeRecoBlock(block), mode: normalizeRecoMode(mode) },
    amount,
  );
}

function recordPrelabelInvalidJson({ block, mode, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    prelabelInvalidJsonCounter,
    { block: normalizeRecoBlock(block), mode: normalizeRecoMode(mode) },
    amount,
  );
}

function recordPrelabelCacheHit({ block, mode, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    prelabelCacheHitCounter,
    { block: normalizeRecoBlock(block), mode: normalizeRecoMode(mode) },
    amount,
  );
}

function recordSuggestionsGeneratedPerBlock({ block, mode, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    prelabelSuggestionsGeneratedCounter,
    { block: normalizeRecoBlock(block), mode: normalizeRecoMode(mode) },
    amount,
  );
}

function recordQueueItemsServed({ block, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    prelabelQueueItemsServedCounter,
    { block: normalizeRecoBlock(block) },
    amount,
  );
}

function setPrelabelCacheHitRate(rate) {
  prelabelCacheHitRateGauge = clampRatio01(rate, prelabelCacheHitRateGauge);
}

function setLlmSuggestionOverturnedRate(rate) {
  prelabelOverturnedRateGauge = clampRatio01(rate, prelabelOverturnedRateGauge);
}

function recordSocialFetchRequest({ mode, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    socialFetchRequestsCounter,
    { mode: normalizeRecoMode(mode) },
    amount,
  );
}

function recordSocialFetchSuccess({ mode, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    socialFetchSuccessCounter,
    { mode: normalizeRecoMode(mode) },
    amount,
  );
}

function recordSocialFetchTimeout({ mode, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    socialFetchTimeoutCounter,
    { mode: normalizeRecoMode(mode) },
    amount,
  );
}

function recordSocialKbBackfill({ mode, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    socialKbBackfillCounter,
    { mode: normalizeRecoMode(mode) },
    amount,
  );
}

function setSocialCacheHitRate(rate) {
  socialCacheHitRateGauge = clampRatio01(rate, socialCacheHitRateGauge);
}

function setSocialChannelsCoverage(coverage) {
  socialChannelsCoverageGauge = clampRatio01(coverage, socialChannelsCoverageGauge);
}

function observeAuroraCompSnapshotAgeSeconds(ageSec) {
  const value = Number(ageSec);
  if (!Number.isFinite(value) || value < 0) return;
  auroraCompSnapshotAgeSecHistogram.count += 1;
  auroraCompSnapshotAgeSecHistogram.sum += value;
  for (const bucket of SNAPSHOT_AGE_BUCKETS_SEC) {
    if (value <= bucket) {
      auroraCompSnapshotAgeSecHistogram.buckets.set(
        bucket,
        (auroraCompSnapshotAgeSecHistogram.buckets.get(bucket) || 0) + 1,
      );
    }
  }
}

function recordAuroraCompSnapshotHit({ mode, source, confidence, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    auroraCompSnapshotHitCounter,
    {
      mode: normalizeRecoMode(mode),
      source: cleanMetricToken(source, 'snapshot'),
      confidence: cleanMetricToken(confidence, 'unknown'),
    },
    amount,
  );
}

function recordAuroraCompSnapshotStale({ mode, staleLevel, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    auroraCompSnapshotStaleCounter,
    {
      mode: normalizeRecoMode(mode),
      stale_level: cleanMetricToken(staleLevel, 'soft'),
    },
    amount,
  );
}

function recordAuroraCompDegraded({ mode, reason, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    auroraCompDegradedCounter,
    {
      mode: normalizeRecoMode(mode),
      reason: cleanMetricToken(reason, 'unknown'),
    },
    amount,
  );
}

function recordAuroraCompBackfillEnqueued({ mode, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    auroraCompBackfillEnqueuedCounter,
    { mode: normalizeRecoMode(mode) },
    amount,
  );
}

function recordAuroraCompBackfillDedupDrop({ mode, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    auroraCompBackfillDedupDropCounter,
    { mode: normalizeRecoMode(mode) },
    amount,
  );
}

function recordAuroraCompPass2Invoked({ mode, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    auroraCompPass2InvokedCounter,
    { mode: normalizeRecoMode(mode) },
    amount,
  );
}

function recordAuroraCompPass2Timeout({ mode, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    auroraCompPass2TimeoutCounter,
    { mode: normalizeRecoMode(mode) },
    amount,
  );
}

function recordVisionDecision({ provider, decision, reasons, latencyMs } = {}) {
  const safeProvider = cleanLabel(provider, 'unknown');
  const safeDecision = cleanLabel(decision, 'skip').toLowerCase();
  incCounter(callsCounter, { provider: safeProvider, decision: safeDecision }, 1);

  if (Number.isFinite(Number(latencyMs))) {
    observeVisionLatency({ provider: safeProvider, latencyMs: Number(latencyMs) });
  }

  const reasonList = Array.isArray(reasons) ? reasons : [];
  const normalizedReasons = Array.from(
    new Set(
      reasonList
        .map((reason) => normalizeVisionFailureReason(reason))
        .filter(Boolean),
    ),
  );
  const failureReasons = normalizedReasons.filter((reason) => isVisionFailureReason(reason));
  const fallbackReasons = normalizedReasons.filter(
    (reason) => reason === VisionUnavailabilityReason.VISION_CV_FALLBACK_USED || isVisionFailureReason(reason),
  );

  if (safeDecision === 'fallback') {
    for (const reason of fallbackReasons) {
      incCounter(fallbackCounter, { provider: safeProvider, reason }, 1);
    }
  }

  if (failureReasons.length) {
    for (const reason of failureReasons) {
      incCounter(failCounter, { provider: safeProvider, reason }, 1);
    }
  }
}

function observeEnsembleProviderLatency({ provider, latencyMs } = {}) {
  const latency = Number(latencyMs);
  if (!Number.isFinite(latency) || latency < 0) return;
  const state = ensureEnsembleLatencyState(provider);
  state.count += 1;
  state.sum += latency;
  for (const bucket of LATENCY_BUCKETS_MS) {
    if (latency <= bucket) {
      state.buckets.set(bucket, (state.buckets.get(bucket) || 0) + 1);
    }
  }
}

function recordEnsembleProviderResult({ provider, ok, latencyMs, failureReason, schemaFailed } = {}) {
  const safeProvider = cleanLabel(provider, 'unknown');
  const status = ok ? 'ok' : 'fail';
  incCounter(ensembleProviderCalls, { provider: safeProvider, status }, 1);
  if (Number.isFinite(Number(latencyMs))) {
    observeEnsembleProviderLatency({ provider: safeProvider, latencyMs: Number(latencyMs) });
  }
  if (!ok && failureReason) {
    incCounter(ensembleProviderFails, { provider: safeProvider, reason: cleanLabel(failureReason, 'UNKNOWN') }, 1);
  }
  if (schemaFailed) {
    incCounter(ensembleProviderSchemaFails, { provider: safeProvider }, 1);
  }
}

function recordEnsembleAgreementScore(score) {
  const value = Number(score);
  if (!Number.isFinite(value)) return;
  const clamped = Math.max(0, Math.min(1, value));
  ensembleAgreementCount += 1;
  ensembleAgreementSum += clamped;
  for (const bucket of ensembleAgreementHistogram.keys()) {
    if (clamped <= bucket) {
      ensembleAgreementHistogram.set(bucket, (ensembleAgreementHistogram.get(bucket) || 0) + 1);
    }
  }
}

function recordVerifyCall({ status } = {}) {
  const safeStatus = cleanLabel(status, 'attempt').toLowerCase();
  incCounter(verifierCalls, { status: safeStatus }, 1);
}

function recordVerifyFail({ reason, provider, httpStatusClass, timeoutStage, errorClass } = {}) {
  const safeReason = normalizeVerifyFailReason(reason);
  const safeProvider = normalizeVerifyProvider(provider);
  const safeStatusClass = normalizeHttpStatusClass(httpStatusClass, safeReason);
  incCounter(
    verifierFails,
    {
      reason: safeReason,
      provider: safeProvider,
      http_status_class: safeStatusClass,
    },
    1,
  );
  if (safeReason === 'UNKNOWN') {
    incCounter(
      verifierUnknownErrorClassFails,
      {
        provider: safeProvider,
        http_status_class: safeStatusClass,
        error_class: normalizeVerifyErrorClass(errorClass),
      },
      1,
    );
  }
  if (safeReason === 'TIMEOUT') {
    incCounter(verifierTimeoutByStage, { stage: normalizeTimeoutStage(timeoutStage) }, 1);
  }
}

function recordVerifyBudgetGuard() {
  verifierBudgetGuardCount += 1;
}

function recordVerifyCircuitOpen() {
  verifierCircuitOpenCount += 1;
}

function recordVerifyRetry({ attempts } = {}) {
  const attemptCount = Number.isFinite(Number(attempts)) ? Math.max(1, Math.trunc(Number(attempts))) : 1;
  const retries = Math.max(0, attemptCount - 1);
  if (retries > 0) verifierRetryCount += retries;
}

function recordVerifyAgreementScore(score) {
  const value = Number(score);
  if (!Number.isFinite(value)) return;
  const clamped = Math.max(0, Math.min(1, value));
  verifierAgreementCount += 1;
  verifierAgreementSum += clamped;
  for (const bucket of verifierAgreementHistogram.keys()) {
    if (clamped <= bucket) {
      verifierAgreementHistogram.set(bucket, (verifierAgreementHistogram.get(bucket) || 0) + 1);
    }
  }
}

function recordVerifyHardCase() {
  verifierHardCaseCount += 1;
}

function recordAnalyzeRequest({ issueType, qualityGrade, pipelineVersion, deviceClass, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    analyzeRequestsCounter,
    geometryLabels({
      issueType,
      qualityGrade,
      pipelineVersion,
      deviceClass,
    }),
    amount,
  );
}

function recordGeometrySanitizerTotals({
  issueType,
  qualityGrade,
  pipelineVersion,
  deviceClass,
  dropped,
  clipped,
} = {}) {
  const labels = geometryLabels({
    issueType,
    qualityGrade,
    pipelineVersion,
    deviceClass,
  });
  const droppedN = Number.isFinite(Number(dropped)) ? Math.max(0, Math.trunc(Number(dropped))) : 0;
  const clippedN = Number.isFinite(Number(clipped)) ? Math.max(0, Math.trunc(Number(clipped))) : 0;
  if (droppedN > 0) incCounter(geometrySanitizerDropCounter, labels, droppedN);
  if (clippedN > 0) incCounter(geometrySanitizerClipCounter, labels, clippedN);
}

function recordPhotoModulesCardEmitted({ qualityGrade, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    photoModulesCardEmittedCounter,
    {
      quality_grade: normalizeQualityGrade(qualityGrade),
    },
    amount,
  );
}

function recordRegionsEmitted({ regionType, issueType, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    regionsEmittedCounter,
    {
      region_type: normalizeRegionType(regionType),
      issue_type: normalizeIssueType(issueType),
    },
    amount,
  );
}

function recordModulesIssueCountHistogram({ moduleId, issueType, count } = {}) {
  const amount = Number.isFinite(Number(count)) ? Math.max(0, Math.trunc(Number(count))) : 1;
  if (amount <= 0) return;
  incCounter(
    modulesIssueCountHistogramCounter,
    {
      module_id: normalizeModuleId(moduleId),
      issue_type: normalizeIssueType(issueType),
    },
    amount,
  );
}

function recordIngredientActionsEmitted({ moduleId, issueType, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    ingredientActionsEmittedCounter,
    {
      module_id: normalizeModuleId(moduleId),
      issue_type: normalizeIssueType(issueType),
    },
    amount,
  );
}

function recordProductRecEmitted({ market, qualityGrade, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    productRecEmittedCounter,
    {
      market: normalizeMarketScope(market),
      quality_grade: normalizeQualityGrade(qualityGrade),
    },
    amount,
  );
}

function recordProductRecSuppressed({ reason, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    productRecSuppressedCounter,
    {
      reason: normalizeSuppressedReason(reason),
    },
    amount,
  );
}

function recordClaimsTemplateFallback({ reason, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    claimsTemplateFallbackCounter,
    {
      reason: normalizeSanitizerReason(reason),
    },
    amount,
  );
}

function recordClaimsViolation({ reason, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    claimsViolationCounter,
    {
      reason: normalizeSanitizerReason(reason),
    },
    amount,
  );
}

function recordUiBehaviorEvent({ eventName, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  const name = normalizeUiEventName(eventName);

  if (name.startsWith('aurora_photo_modules_')) {
    modulesInteractionCount += amount;
  }
  if (name === 'aurora_photo_modules_action_tap' || name === 'aurora_action_click' || name === 'action_click') {
    actionClickCount += amount;
  }
  if (
    name === 'aurora_photo_modules_action_copy' ||
    name === 'aurora_photo_modules_routine_copy' ||
    name === 'aurora_action_copy' ||
    name === 'action_copy'
  ) {
    actionCopyCount += amount;
  }
  if (
    name === 'aurora_photo_modules_retake_tap' ||
    name === 'aurora_retake_after_modules' ||
    name === 'aurora_photo_retake_after_modules' ||
    name === 'retake_after_modules'
  ) {
    retakeAfterModulesCount += amount;
  }
}

function recordGeometrySanitizerDropReason({ reason, regionType, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    geometrySanitizerDropReasonCounter,
    {
      reason: normalizeSanitizerReason(reason),
      region_type: normalizeRegionType(regionType),
    },
    amount,
  );
}

function recordSkinmaskEnabled({ delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  skinmaskEnabledCount += amount;
}

function recordSkinmaskFallback({ reason, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    skinmaskFallbackCounter,
    {
      reason: normalizeSkinmaskFallbackReason(reason),
    },
    amount,
  );
}

function observeSkinmaskInferLatency({ latencyMs } = {}) {
  const latency = Number(latencyMs);
  if (!Number.isFinite(latency) || latency < 0) return;
  skinmaskInferLatency.count += 1;
  skinmaskInferLatency.sum += latency;
  for (const bucket of LATENCY_BUCKETS_MS) {
    if (latency <= bucket) {
      skinmaskInferLatency.buckets.set(bucket, (skinmaskInferLatency.buckets.get(bucket) || 0) + 1);
    }
  }
}

function recordAuroraSkinFlowMetric({ stage, outcome, hit, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  const normalizedOutcome =
    typeof outcome === 'string'
      ? normalizeAuroraSkinFlowOutcome(outcome)
      : normalizeAuroraSkinFlowOutcome(hit === false ? 'miss' : 'hit');
  incCounter(
    auroraSkinFlowCounter,
    {
      stage: normalizeAuroraSkinFlowStage(stage),
      outcome: normalizedOutcome,
    },
    amount,
  );
}

function recordAuroraSkinLlmSchemaViolation({ stage, provider, reason, inputHashPrefix, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    auroraSkinLlmSchemaViolationCounter,
    {
      stage: cleanMetricToken(stage, 'unknown'),
      provider: cleanMetricToken(provider, 'gemini'),
      reason: cleanMetricToken(reason, 'unknown'),
      input_hash_prefix: normalizeInputHashPrefix(inputHashPrefix),
    },
    amount,
  );
}

function recordAuroraSkinLlmRetry({ stage, provider, inputHashPrefix, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    auroraSkinLlmRetryCounter,
    {
      stage: cleanMetricToken(stage, 'unknown'),
      provider: cleanMetricToken(provider, 'gemini'),
      input_hash_prefix: normalizeInputHashPrefix(inputHashPrefix),
    },
    amount,
  );
}

function recordAuroraSkinLlmRetrySuccess({ stage, provider, inputHashPrefix, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    auroraSkinLlmRetrySuccessCounter,
    {
      stage: cleanMetricToken(stage, 'unknown'),
      provider: cleanMetricToken(provider, 'gemini'),
      input_hash_prefix: normalizeInputHashPrefix(inputHashPrefix),
    },
    amount,
  );
}

function recordAuroraSkinMainlineProvider({ provider, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    auroraSkinMainlineProviderCounter,
    { provider: cleanMetricToken(provider, 'gemini') },
    amount,
  );
}

function recordAuroraSkinFallbackDeterministic({ reason, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    auroraSkinFallbackDeterministicCounter,
    { reason: cleanMetricToken(reason, 'unknown') },
    amount,
  );
}

function recordAuroraSkinShadowVerifyIsolatedWrite({ status, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    auroraSkinShadowVerifyIsolatedWriteCounter,
    { status: cleanMetricToken(status, 'unknown') },
    amount,
  );
}

function recordAuroraSkinSemanticGuard({ stage, outcome, reason, promptVersion, locale, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    auroraSkinSemanticGuardCounter,
    {
      stage: cleanMetricToken(stage, 'unknown'),
      outcome: cleanMetricToken(outcome, 'unknown'),
      reason: cleanMetricToken(reason, 'none'),
      prompt_version: cleanMetricToken(promptVersion, 'unknown'),
      locale: cleanMetricToken(locale, 'en_us'),
    },
    amount,
  );
}

function recordAuroraSkinUsefulOutput({ stage, useful, insufficientReason, promptVersion, locale, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    auroraSkinUsefulOutputCounter,
    {
      stage: cleanMetricToken(stage, 'unknown'),
      useful: useful === true ? 'true' : 'false',
      insufficient_reason: cleanMetricToken(insufficientReason, 'none'),
      prompt_version: cleanMetricToken(promptVersion, 'unknown'),
      locale: cleanMetricToken(locale, 'en_us'),
    },
    amount,
  );
}

function recordAuroraIngredientsFlowMetric({ stage, outcome, hit, delta, provider } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  const normalizedOutcome =
    typeof outcome === 'string'
      ? normalizeAuroraIngredientsFlowOutcome(outcome)
      : normalizeAuroraIngredientsFlowOutcome(hit === false ? 'miss' : 'hit');
  const labels = {
    stage: normalizeAuroraIngredientsFlowStage(stage),
    outcome: normalizedOutcome,
  };
  if (provider != null && String(provider || '').trim()) {
    labels.provider = normalizeAuroraIngredientsFlowProvider(provider);
  }
  incCounter(
    auroraIngredientsFlowCounter,
    labels,
    amount,
  );
}

function recordAuroraIngredientProviderMetric({ stage, provider, outcome, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    auroraIngredientProviderCounter,
    {
      stage: normalizeAuroraIngredientProviderStage(stage),
      provider: normalizeAuroraIngredientProvider(provider),
      outcome: normalizeAuroraIngredientProviderOutcome(outcome),
    },
    amount,
  );
}

function recordIngredientReportMetric({
  mode,
  status,
  reasonCode,
  genericFallback,
  pending,
  fingerprint,
  delta,
} = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  const normalizedMode = normalizeIngredientReportMode(mode);
  const normalizedStatus = normalizeIngredientReportStatus(status);
  const normalizedReasonCode = normalizeIngredientReportReasonCode(reasonCode);
  incCounter(
    ingredientReportGeneratedCounter,
    {
      mode: normalizedMode,
      status: normalizedStatus,
      reason_code: normalizedReasonCode,
    },
    amount,
  );
  if (pending === true || normalizedStatus === 'pending') {
    incCounter(
      ingredientReportPendingCounter,
      { reason_code: normalizedReasonCode },
      amount,
    );
  }
  if (genericFallback === true) {
    incCounter(
      ingredientReportGenericFallbackCounter,
      { reason_code: normalizedReasonCode },
      amount,
    );
  }
  const rawFingerprint = String(fingerprint || '').trim().slice(0, 120);
  if (!rawFingerprint) return;
  const steps = Math.max(1, amount);
  for (let i = 0; i < steps; i += 1) {
    ingredientReportFingerprintWindow.push(rawFingerprint);
    ingredientReportFingerprintFreq.set(
      rawFingerprint,
      (ingredientReportFingerprintFreq.get(rawFingerprint) || 0) + 1,
    );
    while (ingredientReportFingerprintWindow.length > INGREDIENT_REPORT_UNIQUENESS_WINDOW) {
      const dropped = ingredientReportFingerprintWindow.shift();
      if (!dropped) continue;
      const next = (ingredientReportFingerprintFreq.get(dropped) || 0) - 1;
      if (next <= 0) ingredientReportFingerprintFreq.delete(dropped);
      else ingredientReportFingerprintFreq.set(dropped, next);
    }
  }
  ingredientReportUniquenessRatioGauge =
    ingredientReportFingerprintWindow.length > 0
      ? ingredientReportFingerprintFreq.size / ingredientReportFingerprintWindow.length
      : 0;
}

function observeAuroraIngredientsFirstAnswerLatency({ latencyMs } = {}) {
  const latency = Number(latencyMs);
  if (!Number.isFinite(latency) || latency < 0) return;
  auroraIngredientsFirstAnswerLatency.count += 1;
  auroraIngredientsFirstAnswerLatency.sum += latency;
  for (const bucket of LATENCY_BUCKETS_MS) {
    if (latency <= bucket) {
      auroraIngredientsFirstAnswerLatency.buckets.set(
        bucket,
        (auroraIngredientsFirstAnswerLatency.buckets.get(bucket) || 0) + 1,
      );
    }
  }
}

function recordAuroraSkinAnalysisRealModel({ source, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    auroraSkinAnalysisRealModelCounter,
    { source: normalizeAuroraAnalysisSource(source) },
    amount,
  );
}

function recordAuroraSkinLlmCall({ stage, outcome, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    auroraSkinLlmCallCounter,
    {
      stage: normalizeAuroraLlmStage(stage),
      outcome: normalizeAuroraLlmCallOutcome(outcome),
    },
    amount,
  );
}

function recordAuroraRecoLlmCall({ stage, outcome, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    auroraRecoLlmCallCounter,
    {
      stage: normalizeAuroraRecoLlmStage(stage),
      outcome: normalizeAuroraRecoLlmCallOutcome(outcome),
    },
    amount,
  );
}

function recordRecoAlternativesBudgetExhausted({ delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  recoAlternativesBudgetExhaustedTotal += amount;
}

function recordRecoAlternativesTimeout({ delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  recoAlternativesTimeoutTotal += amount;
}

function recordRecoAlternativesEmpty({ delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  recoAlternativesEmptyTotal += amount;
}

function recordPromptContractMismatch({ delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  promptContractMismatchTotal += amount;
}

function recordAuroraRecoEntrySource({ source, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    auroraRecoEntrySourceCounter,
    {
      source: normalizeAuroraRecoEntrySource(source),
    },
    amount,
  );
}

function recordAuroraRecoKbWrite({ source, outcome, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    auroraRecoKbWriteCounter,
    {
      source: normalizeAuroraRecoKbWriteSource(source),
      outcome: normalizeAuroraRecoKbWriteOutcome(outcome),
    },
    amount,
  );
}

function recordAuroraProfileAutoPatch({ field, outcome, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    auroraProfileAutoPatchCounter,
    {
      field: normalizeAuroraProfileAutoPatchField(field),
      outcome: normalizeAuroraProfileAutoPatchOutcome(outcome),
    },
    amount,
  );
}

function recordAuroraRecoContextUsed({ signal, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    auroraRecoContextUsedCounter,
    {
      signal: normalizeAuroraRecoContextSignal(signal),
    },
    amount,
  );
}

function recordFpmClarifyReason({ reasonCode, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    fpmClarifyReasonCounter,
    {
      reason_code: normalizeFpmClarifyReason(reasonCode),
    },
    amount,
  );
}

function recordFpmRepeatedSlotClarify({ slot, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    fpmRepeatedSlotClarifyCounter,
    {
      slot: normalizeFpmSlot(slot),
    },
    amount,
  );
}

function recordFpmContextFailOpen({ delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    fpmContextFailOpenCounter,
    {
      mode: 'enabled',
    },
    amount,
  );
}

function recordFpmProductsAfterClarify({ hasProducts, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  const outcome = normalizeFpmProductsAfterClarifyOutcome(Boolean(hasProducts));
  incCounter(
    fpmProductsAfterClarifyCounter,
    {
      outcome,
    },
    amount,
  );
  fpmProductsAfterClarifySeen += amount;
  if (outcome === 'hit') fpmProductsAfterClarifyHit += amount;
  fpmProductsAfterClarifyRateGauge =
    fpmProductsAfterClarifySeen > 0
      ? fpmProductsAfterClarifyHit / fpmProductsAfterClarifySeen
      : 0;
}

function recordResponseSchemaViolation({ reason, path, delta } = {}) {
  const amount = Number.isFinite(Number(delta)) ? Math.max(0, Math.trunc(Number(delta))) : 1;
  if (amount <= 0) return;
  incCounter(
    responseSchemaViolationCounter,
    {
      reason: normalizeSchemaViolationReason(reason),
      path: normalizeSchemaViolationPath(path),
    },
    amount,
  );
}

function recordAuroraKbV0LoaderError({ reason } = {}) {
  incCounter(
    auroraKbV0LoaderErrorCounter,
    { reason: normalizeAuroraKbV0Reason(reason) },
    1,
  );
}

function recordAuroraKbV0RuleMatch({ source, ruleId, level } = {}) {
  incCounter(
    auroraKbV0RuleMatchCounter,
    {
      source: normalizeAuroraKbV0RuleSource(source),
      rule_id: cleanMetricToken(ruleId, 'unknown'),
      level: normalizeAuroraKbV0RuleLevel(level),
    },
    1,
  );
}

function recordAuroraKbV0LegacyFallback({ reason } = {}) {
  incCounter(
    auroraKbV0LegacyFallbackCounter,
    { reason: normalizeAuroraKbV0Reason(reason) },
    1,
  );
}

function recordAuroraKbV0ClimateFallback({ reason } = {}) {
  incCounter(
    auroraKbV0ClimateFallbackCounter,
    { reason: normalizeAuroraKbV0Reason(reason) },
    1,
  );
}

function escapePromValue(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

function labelsToProm(labels) {
  const entries = Object.entries(labels || {});
  if (!entries.length) return '';
  return `{${entries.map(([k, v]) => `${k}="${escapePromValue(v)}"`).join(',')}}`;
}

function renderCounter(lines, metricName, counterMap) {
  const entries = Array.from(counterMap.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [key, value] of entries) {
    const labels = parseLabelsKey(key);
    lines.push(`${metricName}${labelsToProm(labels)} ${value}`);
  }
}

function counterValueByLabels(counterMap, expectedLabels = {}) {
  let total = 0;
  for (const [key, value] of counterMap.entries()) {
    const labels = parseLabelsKey(key);
    let matched = true;
    for (const [labelKey, labelValue] of Object.entries(expectedLabels)) {
      if (String(labels[labelKey] || '') !== String(labelValue)) {
        matched = false;
        break;
      }
    }
    if (matched) total += Number(value || 0);
  }
  return total;
}

function renderVisionMetricsPrometheus() {
  const lines = [];
  lines.push('# HELP vision_calls_total Total number of vision pipeline decisions.');
  lines.push('# TYPE vision_calls_total counter');
  renderCounter(lines, 'vision_calls_total', callsCounter);

  lines.push('# HELP vision_fail_total Total number of vision failures grouped by reason.');
  lines.push('# TYPE vision_fail_total counter');
  renderCounter(lines, 'vision_fail_total', failCounter);

  lines.push('# HELP vision_latency_ms Vision provider latency in milliseconds.');
  lines.push('# TYPE vision_latency_ms histogram');
  const providers = Array.from(latencyByProvider.keys()).sort((a, b) => a.localeCompare(b));
  for (const provider of providers) {
    const state = latencyByProvider.get(provider);
    if (!state) continue;
    for (const bucket of LATENCY_BUCKETS_MS) {
      const le = bucket === Infinity ? '+Inf' : String(bucket);
      const value = state.buckets.get(bucket) || 0;
      lines.push(`vision_latency_ms_bucket{provider="${escapePromValue(provider)}",le="${le}"} ${value}`);
    }
    lines.push(`vision_latency_ms_sum{provider="${escapePromValue(provider)}"} ${state.sum}`);
    lines.push(`vision_latency_ms_count{provider="${escapePromValue(provider)}"} ${state.count}`);
  }

  lines.push('# HELP vision_fallback_total Total number of vision fallbacks grouped by reason.');
  lines.push('# TYPE vision_fallback_total counter');
  renderCounter(lines, 'vision_fallback_total', fallbackCounter);

  lines.push('# HELP diag_ensemble_provider_calls_total Total number of ensemble provider calls.');
  lines.push('# TYPE diag_ensemble_provider_calls_total counter');
  renderCounter(lines, 'diag_ensemble_provider_calls_total', ensembleProviderCalls);

  lines.push('# HELP diag_ensemble_provider_fail_total Total number of ensemble provider failures grouped by reason.');
  lines.push('# TYPE diag_ensemble_provider_fail_total counter');
  renderCounter(lines, 'diag_ensemble_provider_fail_total', ensembleProviderFails);

  lines.push('# HELP diag_ensemble_provider_schema_fail_total Total number of ensemble provider schema failures.');
  lines.push('# TYPE diag_ensemble_provider_schema_fail_total counter');
  renderCounter(lines, 'diag_ensemble_provider_schema_fail_total', ensembleProviderSchemaFails);

  lines.push('# HELP diag_ensemble_provider_latency_ms Ensemble provider latency in milliseconds.');
  lines.push('# TYPE diag_ensemble_provider_latency_ms histogram');
  const ensembleProviders = Array.from(ensembleLatencyByProvider.keys()).sort((a, b) => a.localeCompare(b));
  for (const provider of ensembleProviders) {
    const state = ensembleLatencyByProvider.get(provider);
    if (!state) continue;
    for (const bucket of LATENCY_BUCKETS_MS) {
      const le = bucket === Infinity ? '+Inf' : String(bucket);
      const value = state.buckets.get(bucket) || 0;
      lines.push(`diag_ensemble_provider_latency_ms_bucket{provider="${escapePromValue(provider)}",le="${le}"} ${value}`);
    }
    lines.push(`diag_ensemble_provider_latency_ms_sum{provider="${escapePromValue(provider)}"} ${state.sum}`);
    lines.push(`diag_ensemble_provider_latency_ms_count{provider="${escapePromValue(provider)}"} ${state.count}`);
  }

  lines.push('# HELP diag_ensemble_agreement_score Agreement score distribution for ensemble outputs.');
  lines.push('# TYPE diag_ensemble_agreement_score histogram');
  for (const [bucket, value] of ensembleAgreementHistogram.entries()) {
    lines.push(`diag_ensemble_agreement_score_bucket{le="${bucket.toFixed(1)}"} ${value}`);
  }
  lines.push(`diag_ensemble_agreement_score_bucket{le="+Inf"} ${ensembleAgreementCount}`);
  lines.push(`diag_ensemble_agreement_score_sum ${ensembleAgreementSum}`);
  lines.push(`diag_ensemble_agreement_score_count ${ensembleAgreementCount}`);

  lines.push('# HELP verify_calls_total Total number of Gemini shadow verifier calls.');
  lines.push('# TYPE verify_calls_total counter');
  renderCounter(lines, 'verify_calls_total', verifierCalls);

  lines.push('# HELP verify_fail_total Total number of Gemini shadow verifier failures grouped by reason/provider/http_status_class.');
  lines.push('# TYPE verify_fail_total counter');
  renderCounter(lines, 'verify_fail_total', verifierFails);

  lines.push('# HELP verify_fail_unknown_error_class_total Total UNKNOWN verifier failures grouped by provider/http_status_class/error_class.');
  lines.push('# TYPE verify_fail_unknown_error_class_total counter');
  renderCounter(lines, 'verify_fail_unknown_error_class_total', verifierUnknownErrorClassFails);

  lines.push('# HELP verify_budget_guard_total Total number of verifier calls skipped by budget guard.');
  lines.push('# TYPE verify_budget_guard_total counter');
  lines.push(`verify_budget_guard_total ${verifierBudgetGuardCount}`);

  lines.push('# HELP verify_circuit_open_total Total number of verifier calls skipped by 5xx circuit breaker.');
  lines.push('# TYPE verify_circuit_open_total counter');
  lines.push(`verify_circuit_open_total ${verifierCircuitOpenCount}`);

  lines.push('# HELP verify_retry_total Total number of verifier retry attempts (attempts-1).');
  lines.push('# TYPE verify_retry_total counter');
  lines.push(`verify_retry_total ${verifierRetryCount}`);

  lines.push('# HELP verify_timeout_total Total number of verifier timeout failures by timeout stage.');
  lines.push('# TYPE verify_timeout_total counter');
  renderCounter(lines, 'verify_timeout_total', verifierTimeoutByStage);

  lines.push('# HELP agreement_histogram Agreement score distribution for Gemini shadow verifier.');
  lines.push('# TYPE agreement_histogram histogram');
  for (const [bucket, value] of verifierAgreementHistogram.entries()) {
    lines.push(`agreement_histogram_bucket{le="${bucket.toFixed(1)}"} ${value}`);
  }
  lines.push(`agreement_histogram_bucket{le="+Inf"} ${verifierAgreementCount}`);
  lines.push(`agreement_histogram_sum ${verifierAgreementSum}`);
  lines.push(`agreement_histogram_count ${verifierAgreementCount}`);

  lines.push('# HELP hard_case_rate Hard case ratio observed in Gemini shadow verifier.');
  lines.push('# TYPE hard_case_rate gauge');
  const verifyAttemptCount = Array.from(verifierCalls.entries())
    .map(([key, value]) => ({ labels: parseLabelsKey(key), value }))
    .filter((entry) => entry.labels.status === 'ok' || entry.labels.status === 'fail')
    .reduce((acc, entry) => acc + Number(entry.value || 0), 0);
  const hardCaseRate = verifyAttemptCount > 0 ? verifierHardCaseCount / verifyAttemptCount : 0;
  lines.push(`hard_case_rate ${hardCaseRate}`);

  lines.push('# HELP analyze_requests_total Total diagnosis analysis requests by issue type and quality buckets.');
  lines.push('# TYPE analyze_requests_total counter');
  renderCounter(lines, 'analyze_requests_total', analyzeRequestsCounter);

  lines.push('# HELP geometry_sanitizer_drop_total Total dropped geometry artifacts during sanitizer pass.');
  lines.push('# TYPE geometry_sanitizer_drop_total counter');
  renderCounter(lines, 'geometry_sanitizer_drop_total', geometrySanitizerDropCounter);
  renderCounter(lines, 'geometry_sanitizer_drop_total', geometrySanitizerDropReasonCounter);

  lines.push('# HELP geometry_sanitizer_clip_total Total clipped geometry artifacts during sanitizer pass.');
  lines.push('# TYPE geometry_sanitizer_clip_total counter');
  renderCounter(lines, 'geometry_sanitizer_clip_total', geometrySanitizerClipCounter);

  lines.push('# HELP photo_modules_card_emitted_total Total emitted photo_modules_v1 cards by quality grade.');
  lines.push('# TYPE photo_modules_card_emitted_total counter');
  renderCounter(lines, 'photo_modules_card_emitted_total', photoModulesCardEmittedCounter);

  lines.push('# HELP skinmask_enabled_total Total number of skinmask inference attempts on photo diagnosis path.');
  lines.push('# TYPE skinmask_enabled_total counter');
  lines.push(`skinmask_enabled_total ${skinmaskEnabledCount}`);

  lines.push('# HELP skinmask_fallback_total Total number of skinmask inference fallbacks by reason.');
  lines.push('# TYPE skinmask_fallback_total counter');
  renderCounter(lines, 'skinmask_fallback_total', skinmaskFallbackCounter);

  lines.push('# HELP skinmask_infer_ms Skinmask ONNX inference latency in milliseconds.');
  lines.push('# TYPE skinmask_infer_ms histogram');
  for (const bucket of LATENCY_BUCKETS_MS) {
    const le = bucket === Infinity ? '+Inf' : String(bucket);
    const value = skinmaskInferLatency.buckets.get(bucket) || 0;
    lines.push(`skinmask_infer_ms_bucket{le="${le}"} ${value}`);
  }
  lines.push(`skinmask_infer_ms_sum ${skinmaskInferLatency.sum}`);
  lines.push(`skinmask_infer_ms_count ${skinmaskInferLatency.count}`);

  lines.push('# HELP regions_emitted_total Total emitted regions grouped by type and issue.');
  lines.push('# TYPE regions_emitted_total counter');
  renderCounter(lines, 'regions_emitted_total', regionsEmittedCounter);

  lines.push('# HELP modules_issue_count_histogram Aggregated module issue counts grouped by module and issue.');
  lines.push('# TYPE modules_issue_count_histogram counter');
  renderCounter(lines, 'modules_issue_count_histogram', modulesIssueCountHistogramCounter);

  lines.push('# HELP ingredient_actions_emitted_total Total emitted ingredient actions grouped by module and issue.');
  lines.push('# TYPE ingredient_actions_emitted_total counter');
  renderCounter(lines, 'ingredient_actions_emitted_total', ingredientActionsEmittedCounter);

  lines.push('# HELP product_rec_emitted_total Total emitted product recommendations grouped by market and quality grade.');
  lines.push('# TYPE product_rec_emitted_total counter');
  renderCounter(lines, 'product_rec_emitted_total', productRecEmittedCounter);

  lines.push('# HELP product_rec_suppressed_total Total suppressed product recommendation decisions grouped by reason.');
  lines.push('# TYPE product_rec_suppressed_total counter');
  renderCounter(lines, 'product_rec_suppressed_total', productRecSuppressedCounter);

  lines.push('# HELP claims_template_fallback_total Total claims template fallback events grouped by reason.');
  lines.push('# TYPE claims_template_fallback_total counter');
  renderCounter(lines, 'claims_template_fallback_total', claimsTemplateFallbackCounter);

  lines.push('# HELP claims_violation_total Total claims policy violations caught before response output.');
  lines.push('# TYPE claims_violation_total counter');
  renderCounter(lines, 'claims_violation_total', claimsViolationCounter);

  lines.push('# HELP clarification_id_normalized_empty_total Total number of clarification_id normalizations that required an empty/hash fallback.');
  lines.push('# TYPE clarification_id_normalized_empty_total counter');
  lines.push(`clarification_id_normalized_empty_total ${clarificationIdNormalizedEmptyCount}`);

  lines.push('# HELP catalog_availability_shortcircuit_total Total number of brand availability queries short-circuited to catalog lookup.');
  lines.push('# TYPE catalog_availability_shortcircuit_total counter');
  renderCounter(lines, 'catalog_availability_shortcircuit_total', catalogAvailabilityShortCircuitCounter);

  lines.push('# HELP repeated_clarify_field_total Total number of repeated clarification questions detected for known profile fields.');
  lines.push('# TYPE repeated_clarify_field_total counter');
  renderCounter(lines, 'repeated_clarify_field_total', repeatedClarifyFieldCounter);

  lines.push('# HELP clarification_present_total Total number of chat turns where upstream clarification object is present=true|false.');
  lines.push('# TYPE clarification_present_total counter');
  renderCounter(lines, 'clarification_present_total', clarificationPresentCounter);

  lines.push('# HELP clarification_question_filtered_total Total number of clarification questions filtered because profile field is already known.');
  lines.push('# TYPE clarification_question_filtered_total counter');
  renderCounter(lines, 'clarification_question_filtered_total', clarificationQuestionFilteredCounter);

  lines.push('# HELP clarification_all_questions_filtered_total Total number of turns where all clarification questions were filtered out.');
  lines.push('# TYPE clarification_all_questions_filtered_total counter');
  lines.push(`clarification_all_questions_filtered_total ${clarificationAllQuestionsFilteredCount}`);

  lines.push('# HELP clarification_schema_invalid_total Total number of clarification payload validation failures by reason.');
  lines.push('# TYPE clarification_schema_invalid_total counter');
  renderCounter(lines, 'clarification_schema_invalid_total', clarificationSchemaInvalidCounter);

  lines.push('# HELP clarification_flow_v2_started_total Total number of turns that started pending_clarification Flow V2.');
  lines.push('# TYPE clarification_flow_v2_started_total counter');
  lines.push(`clarification_flow_v2_started_total ${clarificationFlowV2StartedCount}`);

  lines.push('# HELP pending_clarification_step_total Total number of pending clarification local-step responses by step index.');
  lines.push('# TYPE pending_clarification_step_total counter');
  renderCounter(lines, 'pending_clarification_step_total', pendingClarificationStepCounter);

  lines.push('# HELP pending_clarification_completed_total Total number of completed pending clarification flows.');
  lines.push('# TYPE pending_clarification_completed_total counter');
  lines.push(`pending_clarification_completed_total ${pendingClarificationCompletedCount}`);

  lines.push('# HELP pending_clarification_abandoned_total Total number of abandoned pending clarification flows by reason.');
  lines.push('# TYPE pending_clarification_abandoned_total counter');
  renderCounter(lines, 'pending_clarification_abandoned_total', pendingClarificationAbandonedCounter);

  lines.push('# HELP clarification_history_sent_total Total number of upstream calls that included clarification_history context.');
  lines.push('# TYPE clarification_history_sent_total counter');
  renderCounter(lines, 'clarification_history_sent_total', clarificationHistorySentCounter);

  lines.push('# HELP aurora_chat_skipped_total Total number of chat turns that skipped upstream by reason.');
  lines.push('# TYPE aurora_chat_skipped_total counter');
  renderCounter(lines, 'aurora_chat_skipped_total', auroraChatSkippedCounter);

  lines.push('# HELP pending_clarification_upgraded_total Total number of pending_clarification payloads upgraded from legacy shape.');
  lines.push('# TYPE pending_clarification_upgraded_total counter');
  renderCounter(lines, 'pending_clarification_upgraded_total', pendingClarificationUpgradedCounter);

  lines.push('# HELP pending_clarification_truncated_total Total number of pending_clarification truncation/capping events by field.');
  lines.push('# TYPE pending_clarification_truncated_total counter');
  renderCounter(lines, 'pending_clarification_truncated_total', pendingClarificationTruncatedCounter);

  lines.push('# HELP resume_prefix_injected_total Total number of resume-upstream calls where resume prefix injection is enabled=true|false.');
  lines.push('# TYPE resume_prefix_injected_total counter');
  renderCounter(lines, 'resume_prefix_injected_total', resumePrefixInjectedCounter);

  lines.push('# HELP resume_prefix_history_items_total Total number of history items included in resume prefix blocks by count.');
  lines.push('# TYPE resume_prefix_history_items_total counter');
  renderCounter(lines, 'resume_prefix_history_items_total', resumePrefixHistoryItemsCounter);

  lines.push('# HELP resume_response_mode_total Resume-turn response mode classification (answer|question|mixed).');
  lines.push('# TYPE resume_response_mode_total counter');
  renderCounter(lines, 'resume_response_mode_total', resumeResponseModeCounter);

  lines.push('# HELP resume_plaintext_reask_detected_total Resume-turn plaintext re-ask detections for already-known fields.');
  lines.push('# TYPE resume_plaintext_reask_detected_total counter');
  renderCounter(lines, 'resume_plaintext_reask_detected_total', resumePlaintextReaskDetectedCounter);

  lines.push('# HELP profile_context_missing_total Total number of requests missing profile context from frontend session or backend storage.');
  lines.push('# TYPE profile_context_missing_total counter');
  renderCounter(lines, 'profile_context_missing_total', profileContextMissingCounter);

  lines.push('# HELP session_patch_profile_emitted_total Total number of responses that emitted env.session_patch.profile (changed=true|false).');
  lines.push('# TYPE session_patch_profile_emitted_total counter');
  renderCounter(lines, 'session_patch_profile_emitted_total', sessionPatchProfileEmittedCounter);

  lines.push('# HELP reco_guardrail_violation_total Total guardrail violations detected for reco blocks.');
  lines.push('# TYPE reco_guardrail_violation_total counter');
  renderCounter(lines, 'reco_guardrail_violation_total', recoGuardrailViolationCounter);

  lines.push('# HELP reco_candidate_total Total reco candidates observed by block/source/brand relation.');
  lines.push('# TYPE reco_candidate_total counter');
  renderCounter(lines, 'reco_candidate_total', recoCandidateCounter);

  lines.push('# HELP reco_explanation_alignment_total Total explanation alignment samples by block/aligned/mode.');
  lines.push('# TYPE reco_explanation_alignment_total counter');
  renderCounter(lines, 'reco_explanation_alignment_total', recoExplanationAlignmentCounter);

  lines.push('# HELP reco_guardrail_circuit_open_total Total times reco guardrail circuit opened.');
  lines.push('# TYPE reco_guardrail_circuit_open_total counter');
  renderCounter(lines, 'reco_guardrail_circuit_open_total', recoGuardrailCircuitOpenCounter);

  lines.push('# HELP reco_employee_feedback_total Total employee feedback events by block and feedback type.');
  lines.push('# TYPE reco_employee_feedback_total counter');
  renderCounter(lines, 'reco_employee_feedback_total', recoEmployeeFeedbackCounter);

  lines.push('# HELP reco_interleave_click_total Total interleave click events by block and attribution.');
  lines.push('# TYPE reco_interleave_click_total counter');
  renderCounter(lines, 'reco_interleave_click_total', recoInterleaveClickCounter);

  lines.push('# HELP reco_interleave_win_total Total interleave wins by ranker/category bucket/price band.');
  lines.push('# TYPE reco_interleave_win_total counter');
  renderCounter(lines, 'reco_interleave_win_total', recoInterleaveWinCounter);

  lines.push('# HELP reco_exploration_slot_total Total exploration slots inserted by block.');
  lines.push('# TYPE reco_exploration_slot_total counter');
  renderCounter(lines, 'reco_exploration_slot_total', recoExplorationSlotCounter);

  lines.push('# HELP reco_async_update_total Total async updates attempted/applied by block.');
  lines.push('# TYPE reco_async_update_total counter');
  renderCounter(lines, 'reco_async_update_total', recoAsyncUpdateCounter);

  lines.push('# HELP reco_async_update_items_changed_count Total changed candidate items from async updates by block.');
  lines.push('# TYPE reco_async_update_items_changed_count counter');
  renderCounter(lines, 'reco_async_update_items_changed_count', recoAsyncUpdateChangedItemsCounter);

  lines.push('# HELP aurora_reco_context_used_total Recommendation context usage by signal.');
  lines.push('# TYPE aurora_reco_context_used_total counter');
  renderCounter(lines, 'aurora_reco_context_used_total', recoContextUsedCounter);

  lines.push('# HELP aurora_travel_plan_selection_total Travel plan selection mode distribution.');
  lines.push('# TYPE aurora_travel_plan_selection_total counter');
  renderCounter(lines, 'aurora_travel_plan_selection_total', travelPlanSelectionCounter);

  lines.push('# HELP aurora_route_404_total Route-level 404 counters for protected aurora endpoints.');
  lines.push('# TYPE aurora_route_404_total counter');
  renderCounter(lines, 'aurora_route_404_total', auroraRoute404Counter);

  lines.push('# HELP aurora_travel_plans_non_json_total Non-JSON responses on travel plans routes.');
  lines.push('# TYPE aurora_travel_plans_non_json_total counter');
  renderCounter(lines, 'aurora_travel_plans_non_json_total', auroraTravelPlansNonJsonCounter);

  lines.push('# HELP aurora_travel_llm_call_total Total travel LLM calibration outcomes.');
  lines.push('# TYPE aurora_travel_llm_call_total counter');
  renderCounter(lines, 'aurora_travel_llm_call_total', auroraTravelLlmCallCounter);

  lines.push('# HELP aurora_travel_llm_trigger_total Total travel LLM trigger reasons.');
  lines.push('# TYPE aurora_travel_llm_trigger_total counter');
  renderCounter(lines, 'aurora_travel_llm_trigger_total', auroraTravelLlmTriggerCounter);

  lines.push('# HELP aurora_travel_llm_skip_total Total travel LLM skip reasons.');
  lines.push('# TYPE aurora_travel_llm_skip_total counter');
  renderCounter(lines, 'aurora_travel_llm_skip_total', auroraTravelLlmSkipCounter);

  lines.push('# HELP aurora_travel_skill_skip_total Total travel skill skip reasons by skill.');
  lines.push('# TYPE aurora_travel_skill_skip_total counter');
  renderCounter(lines, 'aurora_travel_skill_skip_total', auroraTravelSkillSkipCounter);

  lines.push('# HELP aurora_travel_kb_hit_total Total travel KB lookup hit/miss counts.');
  lines.push('# TYPE aurora_travel_kb_hit_total counter');
  renderCounter(lines, 'aurora_travel_kb_hit_total', auroraTravelKbHitCounter);

  lines.push('# HELP aurora_travel_kb_write_total Total travel KB write queue/upsert outcomes.');
  lines.push('# TYPE aurora_travel_kb_write_total counter');
  renderCounter(lines, 'aurora_travel_kb_write_total', auroraTravelKbWriteCounter);

  lines.push('# HELP aurora_travel_response_source_total Travel response source split.');
  lines.push('# TYPE aurora_travel_response_source_total counter');
  renderCounter(lines, 'aurora_travel_response_source_total', auroraTravelResponseSourceCounter);

  lines.push('# HELP aurora_travel_weather_source_total Travel weather source and fallback reasons.');
  lines.push('# TYPE aurora_travel_weather_source_total counter');
  renderCounter(lines, 'aurora_travel_weather_source_total', auroraTravelWeatherSourceCounter);

  lines.push('# HELP aurora_travel_forecast_source_total Travel forecast source split.');
  lines.push('# TYPE aurora_travel_forecast_source_total counter');
  renderCounter(lines, 'aurora_travel_forecast_source_total', auroraTravelForecastSourceCounter);

  lines.push('# HELP aurora_travel_alert_source_total Travel alert source split.');
  lines.push('# TYPE aurora_travel_alert_source_total counter');
  renderCounter(lines, 'aurora_travel_alert_source_total', auroraTravelAlertSourceCounter);

  lines.push('# HELP aurora_travel_baseline_integrity_total Travel baseline integrity status.');
  lines.push('# TYPE aurora_travel_baseline_integrity_total counter');
  renderCounter(lines, 'aurora_travel_baseline_integrity_total', auroraTravelBaselineIntegrityCounter);

  lines.push('# HELP aurora_travel_response_quality_total Travel response quality section coverage.');
  lines.push('# TYPE aurora_travel_response_quality_total counter');
  renderCounter(lines, 'aurora_travel_response_quality_total', auroraTravelResponseQualityCounter);

  lines.push('# HELP aurora_travel_reply_mode_total Travel reply mode split.');
  lines.push('# TYPE aurora_travel_reply_mode_total counter');
  renderCounter(lines, 'aurora_travel_reply_mode_total', auroraTravelReplyModeCounter);

  lines.push('# HELP aurora_travel_env_card_emitted_total Travel env card emission count by turn.');
  lines.push('# TYPE aurora_travel_env_card_emitted_total counter');
  renderCounter(lines, 'aurora_travel_env_card_emitted_total', auroraTravelEnvCardEmittedCounter);

  lines.push('# HELP reco_competitors_same_brand_rate Last observed same-brand rate in competitors block.');
  lines.push('# TYPE reco_competitors_same_brand_rate gauge');
  lines.push(`reco_competitors_same_brand_rate ${recoCompetitorsSameBrandRateGauge}`);

  lines.push('# HELP reco_competitors_on_page_source_rate Last observed on_page_related source rate in competitors block.');
  lines.push('# TYPE reco_competitors_on_page_source_rate gauge');
  lines.push(`reco_competitors_on_page_source_rate ${recoCompetitorsOnPageSourceRateGauge}`);

  lines.push('# HELP reco_explanation_alignment_at3 Last observed explanation alignment@3 across reco blocks.');
  lines.push('# TYPE reco_explanation_alignment_at3 gauge');
  lines.push(`reco_explanation_alignment_at3 ${recoExplanationAlignmentAt3Gauge}`);

  lines.push('# HELP social_fetch_requests_total Total social-source fetch requests for async social enrichment.');
  lines.push('# TYPE social_fetch_requests_total counter');
  renderCounter(lines, 'social_fetch_requests_total', socialFetchRequestsCounter);

  lines.push('# HELP social_fetch_success_total Total successful social-source fetches for async social enrichment.');
  lines.push('# TYPE social_fetch_success_total counter');
  renderCounter(lines, 'social_fetch_success_total', socialFetchSuccessCounter);

  lines.push('# HELP social_fetch_timeout_total Total timed-out social-source fetches for async social enrichment.');
  lines.push('# TYPE social_fetch_timeout_total counter');
  renderCounter(lines, 'social_fetch_timeout_total', socialFetchTimeoutCounter);

  lines.push('# HELP social_kb_backfill_total Total async social KB backfill writes.');
  lines.push('# TYPE social_kb_backfill_total counter');
  renderCounter(lines, 'social_kb_backfill_total', socialKbBackfillCounter);

  lines.push('# HELP social_cache_hit_rate Last observed social fetch cache hit ratio.');
  lines.push('# TYPE social_cache_hit_rate gauge');
  lines.push(`social_cache_hit_rate ${socialCacheHitRateGauge}`);

  lines.push('# HELP social_channels_coverage_gauge Last observed social channel coverage ratio.');
  lines.push('# TYPE social_channels_coverage_gauge gauge');
  lines.push(`social_channels_coverage_gauge ${socialChannelsCoverageGauge}`);

  lines.push('# HELP aurora_comp_snapshot_hit_total Total competitor snapshot hits on aurora product analysis path.');
  lines.push('# TYPE aurora_comp_snapshot_hit_total counter');
  renderCounter(lines, 'aurora_comp_snapshot_hit_total', auroraCompSnapshotHitCounter);

  lines.push('# HELP aurora_comp_snapshot_stale_total Total stale competitor snapshot usages.');
  lines.push('# TYPE aurora_comp_snapshot_stale_total counter');
  renderCounter(lines, 'aurora_comp_snapshot_stale_total', auroraCompSnapshotStaleCounter);

  lines.push('# HELP aurora_comp_degraded_total Total degraded competitor responses from snapshot/internal fallback.');
  lines.push('# TYPE aurora_comp_degraded_total counter');
  renderCounter(lines, 'aurora_comp_degraded_total', auroraCompDegradedCounter);

  lines.push('# HELP aurora_comp_backfill_enqueued_total Total async competitor snapshot backfill jobs enqueued.');
  lines.push('# TYPE aurora_comp_backfill_enqueued_total counter');
  renderCounter(lines, 'aurora_comp_backfill_enqueued_total', auroraCompBackfillEnqueuedCounter);

  lines.push('# HELP aurora_comp_backfill_dedup_drop_total Total async competitor snapshot backfill jobs dropped by cooldown/dedup.');
  lines.push('# TYPE aurora_comp_backfill_dedup_drop_total counter');
  renderCounter(lines, 'aurora_comp_backfill_dedup_drop_total', auroraCompBackfillDedupDropCounter);

  lines.push('# HELP aurora_comp_pass2_invoked_total Total aurora two-pass external-seed pass2 attempts.');
  lines.push('# TYPE aurora_comp_pass2_invoked_total counter');
  renderCounter(lines, 'aurora_comp_pass2_invoked_total', auroraCompPass2InvokedCounter);

  lines.push('# HELP aurora_comp_pass2_timeout_total Total aurora two-pass external-seed pass2 timeouts.');
  lines.push('# TYPE aurora_comp_pass2_timeout_total counter');
  renderCounter(lines, 'aurora_comp_pass2_timeout_total', auroraCompPass2TimeoutCounter);

  lines.push('# HELP aurora_comp_snapshot_age_seconds Age distribution for competitor snapshots used in response path.');
  lines.push('# TYPE aurora_comp_snapshot_age_seconds histogram');
  for (const bucket of SNAPSHOT_AGE_BUCKETS_SEC) {
    const le = bucket === Infinity ? '+Inf' : String(bucket);
    const value = auroraCompSnapshotAgeSecHistogram.buckets.get(bucket) || 0;
    lines.push(`aurora_comp_snapshot_age_seconds_bucket{le="${le}"} ${value}`);
  }
  lines.push(`aurora_comp_snapshot_age_seconds_sum ${auroraCompSnapshotAgeSecHistogram.sum}`);
  lines.push(`aurora_comp_snapshot_age_seconds_count ${auroraCompSnapshotAgeSecHistogram.count}`);

  lines.push('# HELP prelabel_requests_total Total LLM prelabel suggestion requests by block/mode.');
  lines.push('# TYPE prelabel_requests_total counter');
  renderCounter(lines, 'prelabel_requests_total', prelabelRequestsCounter);

  lines.push('# HELP prelabel_success_total Total successful LLM prelabel suggestions by block/mode.');
  lines.push('# TYPE prelabel_success_total counter');
  renderCounter(lines, 'prelabel_success_total', prelabelSuccessCounter);

  lines.push('# HELP prelabel_invalid_json_total Total invalid-json prelabel fallbacks by block/mode.');
  lines.push('# TYPE prelabel_invalid_json_total counter');
  renderCounter(lines, 'prelabel_invalid_json_total', prelabelInvalidJsonCounter);

  lines.push('# HELP prelabel_cache_hit_total Total prelabel cache hits by block/mode.');
  lines.push('# TYPE prelabel_cache_hit_total counter');
  renderCounter(lines, 'prelabel_cache_hit_total', prelabelCacheHitCounter);

  lines.push('# HELP suggestions_generated_per_block Total generated suggestions by block/mode.');
  lines.push('# TYPE suggestions_generated_per_block counter');
  renderCounter(lines, 'suggestions_generated_per_block', prelabelSuggestionsGeneratedCounter);

  lines.push('# HELP queue_items_served Total label-queue items served by block.');
  lines.push('# TYPE queue_items_served counter');
  renderCounter(lines, 'queue_items_served', prelabelQueueItemsServedCounter);

  lines.push('# HELP prelabel_cache_hit_rate Last observed prelabel cache hit ratio.');
  lines.push('# TYPE prelabel_cache_hit_rate gauge');
  lines.push(`prelabel_cache_hit_rate ${prelabelCacheHitRateGauge}`);

  lines.push('# HELP llm_suggestion_overturned_rate Last observed LLM suggestion overturned ratio.');
  lines.push('# TYPE llm_suggestion_overturned_rate gauge');
  lines.push(`llm_suggestion_overturned_rate ${prelabelOverturnedRateGauge}`);

  lines.push('# HELP prelabel_gemini_latency_ms Gemini prelabel latency in milliseconds.');
  lines.push('# TYPE prelabel_gemini_latency_ms histogram');
  for (const bucket of LATENCY_BUCKETS_MS) {
    const le = bucket === Infinity ? '+Inf' : String(bucket);
    const value = prelabelGeminiLatency.buckets.get(bucket) || 0;
    lines.push(`prelabel_gemini_latency_ms_bucket{le="${le}"} ${value}`);
  }
  lines.push(`prelabel_gemini_latency_ms_sum ${prelabelGeminiLatency.sum}`);
  lines.push(`prelabel_gemini_latency_ms_count ${prelabelGeminiLatency.count}`);

  lines.push('# HELP upstream_call_total Total number of upstream calls by path and status.');
  lines.push('# TYPE upstream_call_total counter');
  renderCounter(lines, 'upstream_call_total', upstreamCallsCounter);

  lines.push('# HELP upstream_latency_ms Upstream latency in milliseconds by path.');
  lines.push('# TYPE upstream_latency_ms histogram');
  const upstreamPaths = Array.from(upstreamLatencyByPath.keys()).sort((a, b) => a.localeCompare(b));
  for (const path of upstreamPaths) {
    const state = upstreamLatencyByPath.get(path);
    if (!state) continue;
    for (const bucket of LATENCY_BUCKETS_MS) {
      const le = bucket === Infinity ? '+Inf' : String(bucket);
      const value = state.buckets.get(bucket) || 0;
      lines.push(`upstream_latency_ms_bucket{path="${escapePromValue(path)}",le="${le}"} ${value}`);
    }
    lines.push(`upstream_latency_ms_sum{path="${escapePromValue(path)}"} ${state.sum}`);
    lines.push(`upstream_latency_ms_count{path="${escapePromValue(path)}"} ${state.count}`);
  }

  lines.push('# HELP template_applied_total Total number of responses where template rendering was applied.');
  lines.push('# TYPE template_applied_total counter');
  renderCounter(lines, 'template_applied_total', templateAppliedCounter);

  lines.push('# HELP template_fallback_total Total number of responses that kept existing content via template fallback path.');
  lines.push('# TYPE template_fallback_total counter');
  renderCounter(lines, 'template_fallback_total', templateFallbackCounter);

  lines.push('# HELP chips_truncated_count Total number of chips truncated by response budget.');
  lines.push('# TYPE chips_truncated_count counter');
  lines.push(`chips_truncated_count ${chipsTruncatedCount}`);

  lines.push('# HELP field_missing_added_count Total number of field_missing rows auto-added by envelope enforcer.');
  lines.push('# TYPE field_missing_added_count counter');
  lines.push(`field_missing_added_count ${fieldMissingAddedCount}`);

  lines.push('# HELP anti_template_violation_count Total anti-template violations detected in response validation.');
  lines.push('# TYPE anti_template_violation_count counter');
  renderCounter(lines, 'anti_template_violation_count', antiTemplateViolationCounter);

  lines.push('# HELP actionable_reply_total Total responses classified as actionable=true|false.');
  lines.push('# TYPE actionable_reply_total counter');
  renderCounter(lines, 'actionable_reply_total', actionableReplyCounter);

  const templateAppliedTotal = Array.from(templateAppliedCounter.values()).reduce((acc, v) => acc + Number(v || 0), 0);
  const templateFallbackTotal = Array.from(templateFallbackCounter.values()).reduce((acc, v) => acc + Number(v || 0), 0);
  const templateAttempts = templateAppliedTotal + templateFallbackTotal;
  const actionableTrue = Array.from(actionableReplyCounter.entries())
    .map(([key, value]) => ({ labels: parseLabelsKey(key), value: Number(value || 0) }))
    .filter((entry) => entry.labels.actionable === 'true')
    .reduce((acc, entry) => acc + entry.value, 0);
  const actionableTotal = Array.from(actionableReplyCounter.values()).reduce((acc, v) => acc + Number(v || 0), 0);

  lines.push('# HELP template_applied_rate template_applied_total / (template_applied_total + template_fallback_total).');
  lines.push('# TYPE template_applied_rate gauge');
  lines.push(`template_applied_rate ${templateAttempts > 0 ? templateAppliedTotal / templateAttempts : 0}`);

  lines.push('# HELP template_fallback_rate template_fallback_total / (template_applied_total + template_fallback_total).');
  lines.push('# TYPE template_fallback_rate gauge');
  lines.push(`template_fallback_rate ${templateAttempts > 0 ? templateFallbackTotal / templateAttempts : 0}`);

  lines.push('# HELP actionable_reply_rate actionable=true / total actionable classifications.');
  lines.push('# TYPE actionable_reply_rate gauge');
  lines.push(`actionable_reply_rate ${actionableTotal > 0 ? actionableTrue / actionableTotal : 0}`);

  lines.push('# HELP modules_interaction_total Total UI interactions related to photo modules.');
  lines.push('# TYPE modules_interaction_total counter');
  lines.push(`modules_interaction_total ${modulesInteractionCount}`);

  lines.push('# HELP action_click_total Total action click events from photo modules UI.');
  lines.push('# TYPE action_click_total counter');
  lines.push(`action_click_total ${actionClickCount}`);

  lines.push('# HELP action_copy_total Total action copy events from photo modules UI.');
  lines.push('# TYPE action_copy_total counter');
  lines.push(`action_copy_total ${actionCopyCount}`);

  lines.push('# HELP retake_after_modules_total Total retake events triggered after photo modules interaction.');
  lines.push('# TYPE retake_after_modules_total counter');
  lines.push(`retake_after_modules_total ${retakeAfterModulesCount}`);

  lines.push('# HELP action_click_rate action_click_total / modules_interaction_total.');
  lines.push('# TYPE action_click_rate gauge');
  lines.push(`action_click_rate ${modulesInteractionCount > 0 ? actionClickCount / modulesInteractionCount : 0}`);

  lines.push('# HELP action_copy_rate action_copy_total / action_click_total.');
  lines.push('# TYPE action_copy_rate gauge');
  lines.push(`action_copy_rate ${actionClickCount > 0 ? actionCopyCount / actionClickCount : 0}`);

  lines.push('# HELP retake_rate_after_modules retake_after_modules_total / modules_interaction_total.');
  lines.push('# TYPE retake_rate_after_modules gauge');
  lines.push(`retake_rate_after_modules ${modulesInteractionCount > 0 ? retakeAfterModulesCount / modulesInteractionCount : 0}`);

  lines.push('# HELP aurora_skin_flow_total Aurora skin diagnosis/reco flow counters by stage and outcome.');
  lines.push('# TYPE aurora_skin_flow_total counter');
  renderCounter(lines, 'aurora_skin_flow_total', auroraSkinFlowCounter);

  lines.push('# HELP aurora_skin_llm_schema_violation_total Total LLM schema validation failures in skin mainline.');
  lines.push('# TYPE aurora_skin_llm_schema_violation_total counter');
  renderCounter(lines, 'aurora_skin_llm_schema_violation_total', auroraSkinLlmSchemaViolationCounter);

  lines.push('# HELP aurora_skin_llm_retry_total Total single lightweight retries for skin mainline LLM calls.');
  lines.push('# TYPE aurora_skin_llm_retry_total counter');
  renderCounter(lines, 'aurora_skin_llm_retry_total', auroraSkinLlmRetryCounter);

  lines.push('# HELP aurora_skin_llm_retry_success_total Total successful retries for skin mainline LLM calls.');
  lines.push('# TYPE aurora_skin_llm_retry_success_total counter');
  renderCounter(lines, 'aurora_skin_llm_retry_success_total', auroraSkinLlmRetrySuccessCounter);

  lines.push('# HELP aurora_skin_mainline_provider_total Mainline provider usage count for /v1/analysis/skin.');
  lines.push('# TYPE aurora_skin_mainline_provider_total counter');
  renderCounter(lines, 'aurora_skin_mainline_provider_total', auroraSkinMainlineProviderCounter);

  lines.push('# HELP aurora_skin_fallback_deterministic_total Total deterministic fallbacks in skin mainline.');
  lines.push('# TYPE aurora_skin_fallback_deterministic_total counter');
  renderCounter(lines, 'aurora_skin_fallback_deterministic_total', auroraSkinFallbackDeterministicCounter);

  lines.push('# HELP aurora_skin_shadow_verify_isolated_write_total Total isolated shadow verify write attempts.');
  lines.push('# TYPE aurora_skin_shadow_verify_isolated_write_total counter');
  renderCounter(lines, 'aurora_skin_shadow_verify_isolated_write_total', auroraSkinShadowVerifyIsolatedWriteCounter);

  lines.push('# HELP aurora_ingredients_flow_total Aurora ingredients query-first flow counters by stage and outcome.');
  lines.push('# TYPE aurora_ingredients_flow_total counter');
  renderCounter(lines, 'aurora_ingredients_flow_total', auroraIngredientsFlowCounter);

  lines.push('# HELP aurora_ingredient_provider_total Aurora ingredient research provider attempts/finals by provider and outcome.');
  lines.push('# TYPE aurora_ingredient_provider_total counter');
  renderCounter(lines, 'aurora_ingredient_provider_total', auroraIngredientProviderCounter);

  lines.push('# HELP ingredient_report_generated_total Total ingredient reports generated by mode/status/reason_code.');
  lines.push('# TYPE ingredient_report_generated_total counter');
  renderCounter(lines, 'ingredient_report_generated_total', ingredientReportGeneratedCounter);

  lines.push('# HELP ingredient_report_generic_fallback_total Total ingredient reports that hit minimal generic fallback path.');
  lines.push('# TYPE ingredient_report_generic_fallback_total counter');
  renderCounter(lines, 'ingredient_report_generic_fallback_total', ingredientReportGenericFallbackCounter);

  lines.push('# HELP ingredient_report_pending_total Total ingredient reports currently returned as pending.');
  lines.push('# TYPE ingredient_report_pending_total counter');
  renderCounter(lines, 'ingredient_report_pending_total', ingredientReportPendingCounter);

  lines.push('# HELP ingredient_report_uniqueness_ratio Unique fingerprint ratio for recent ingredient reports.');
  lines.push('# TYPE ingredient_report_uniqueness_ratio gauge');
  lines.push(`ingredient_report_uniqueness_ratio ${ingredientReportUniquenessRatioGauge}`);

  lines.push('# HELP ingredients_first_answer_latency_ms Ingredient first-answer latency measured from ui events.');
  lines.push('# TYPE ingredients_first_answer_latency_ms histogram');
  for (const bucket of LATENCY_BUCKETS_MS) {
    const le = bucket === Infinity ? '+Inf' : String(bucket);
    const value = auroraIngredientsFirstAnswerLatency.buckets.get(bucket) || 0;
    lines.push(`ingredients_first_answer_latency_ms_bucket{le="${le}"} ${value}`);
  }
  lines.push(`ingredients_first_answer_latency_ms_sum ${auroraIngredientsFirstAnswerLatency.sum}`);
  lines.push(`ingredients_first_answer_latency_ms_count ${auroraIngredientsFirstAnswerLatency.count}`);

  lines.push('# HELP aurora_skin_analysis_real_model_total Total completed skin analyses grouped by detector/model source.');
  lines.push('# TYPE aurora_skin_analysis_real_model_total counter');
  renderCounter(lines, 'aurora_skin_analysis_real_model_total', auroraSkinAnalysisRealModelCounter);

  lines.push('# HELP aurora_skin_llm_call_total Total skin analysis LLM call decisions grouped by stage and outcome.');
  lines.push('# TYPE aurora_skin_llm_call_total counter');
  renderCounter(lines, 'aurora_skin_llm_call_total', auroraSkinLlmCallCounter);

  lines.push('# HELP aurora_reco_llm_call_total Total recommendation LLM call decisions grouped by stage and outcome.');
  lines.push('# TYPE aurora_reco_llm_call_total counter');
  renderCounter(lines, 'aurora_reco_llm_call_total', auroraRecoLlmCallCounter);

  lines.push('# HELP reco_alternatives_budget_exhausted_total Total alternatives calls skipped because remaining budget was insufficient.');
  lines.push('# TYPE reco_alternatives_budget_exhausted_total counter');
  lines.push(`reco_alternatives_budget_exhausted_total ${recoAlternativesBudgetExhaustedTotal}`);

  lines.push('# HELP reco_alternatives_timeout_total Total alternatives calls that timed out.');
  lines.push('# TYPE reco_alternatives_timeout_total counter');
  lines.push(`reco_alternatives_timeout_total ${recoAlternativesTimeoutTotal}`);

  lines.push('# HELP reco_alternatives_empty_total Total alternatives calls that returned empty product selections.');
  lines.push('# TYPE reco_alternatives_empty_total counter');
  lines.push(`reco_alternatives_empty_total ${recoAlternativesEmptyTotal}`);

  lines.push('# HELP prompt_contract_mismatch_total Total blocked calls due to prompt contract mismatch.');
  lines.push('# TYPE prompt_contract_mismatch_total counter');
  lines.push(`prompt_contract_mismatch_total ${promptContractMismatchTotal}`);

  lines.push('# HELP aurora_reco_entry_source_total Total recommendation entry counts by request source detail.');
  lines.push('# TYPE aurora_reco_entry_source_total counter');
  renderCounter(lines, 'aurora_reco_entry_source_total', auroraRecoEntrySourceCounter);

  lines.push('# HELP aurora_reco_kb_write_total Total recommendation KB write attempts grouped by source and outcome.');
  lines.push('# TYPE aurora_reco_kb_write_total counter');
  renderCounter(lines, 'aurora_reco_kb_write_total', auroraRecoKbWriteCounter);

  lines.push('# HELP aurora_profile_autopatch_total Auto profile patch field updates and outcomes from free-text extraction.');
  lines.push('# TYPE aurora_profile_autopatch_total counter');
  renderCounter(lines, 'aurora_profile_autopatch_total', auroraProfileAutoPatchCounter);

  lines.push('# HELP aurora_reco_context_used_total Total recommendation responses that used specific user-context signals.');
  lines.push('# TYPE aurora_reco_context_used_total counter');
  renderCounter(lines, 'aurora_reco_context_used_total', auroraRecoContextUsedCounter);

  lines.push('# HELP aurora_schema_violation_total Total response schema violations observed before fallback envelope output.');
  lines.push('# TYPE aurora_schema_violation_total counter');
  renderCounter(lines, 'aurora_schema_violation_total', responseSchemaViolationCounter);

  lines.push('# HELP fpm_clarify_reason_total Total find_products_multi clarification reason counts.');
  lines.push('# TYPE fpm_clarify_reason_total counter');
  renderCounter(lines, 'fpm_clarify_reason_total', fpmClarifyReasonCounter);

  lines.push('# HELP fpm_repeated_slot_clarify_total Total blocked repeated slot clarifications for find_products_multi.');
  lines.push('# TYPE fpm_repeated_slot_clarify_total counter');
  renderCounter(lines, 'fpm_repeated_slot_clarify_total', fpmRepeatedSlotClarifyCounter);

  lines.push('# HELP fpm_context_fail_open_total Total context fail-open activations for find_products_multi.');
  lines.push('# TYPE fpm_context_fail_open_total counter');
  renderCounter(lines, 'fpm_context_fail_open_total', fpmContextFailOpenCounter);

  lines.push('# HELP fpm_products_after_clarify_total Total find_products_multi outcomes after prior clarify turns.');
  lines.push('# TYPE fpm_products_after_clarify_total counter');
  renderCounter(lines, 'fpm_products_after_clarify_total', fpmProductsAfterClarifyCounter);

  lines.push('# HELP fpm_products_after_clarify_rate Ratio of product-returned outcomes after prior clarify turns.');
  lines.push('# TYPE fpm_products_after_clarify_rate gauge');
  lines.push(`fpm_products_after_clarify_rate ${fpmProductsAfterClarifyRateGauge}`);

  lines.push('# HELP aurora_kb_v0_loader_error_total Total KB v0 loader errors by reason.');
  lines.push('# TYPE aurora_kb_v0_loader_error_total counter');
  renderCounter(lines, 'aurora_kb_v0_loader_error_total', auroraKbV0LoaderErrorCounter);

  lines.push('# HELP aurora_kb_v0_rule_match_total Total KB v0 and legacy rule matches by source/rule/level.');
  lines.push('# TYPE aurora_kb_v0_rule_match_total counter');
  renderCounter(lines, 'aurora_kb_v0_rule_match_total', auroraKbV0RuleMatchCounter);

  lines.push('# HELP aurora_kb_v0_legacy_fallback_total Total KB v0 legacy fallback hits by reason.');
  lines.push('# TYPE aurora_kb_v0_legacy_fallback_total counter');
  renderCounter(lines, 'aurora_kb_v0_legacy_fallback_total', auroraKbV0LegacyFallbackCounter);

  lines.push('# HELP aurora_kb_v0_climate_fallback_total Total climate fallback hits by reason.');
  lines.push('# TYPE aurora_kb_v0_climate_fallback_total counter');
  renderCounter(lines, 'aurora_kb_v0_climate_fallback_total', auroraKbV0ClimateFallbackCounter);

  const recoRequests = counterValueByLabels(auroraSkinFlowCounter, { stage: 'reco_request', outcome: 'hit' });
  const recoGenerated = counterValueByLabels(auroraSkinFlowCounter, { stage: 'reco_generated', outcome: 'hit' });
  const recoLowConfidence = counterValueByLabels(auroraSkinFlowCounter, { stage: 'reco_low_confidence', outcome: 'hit' });
  const recoSafetyBlock = counterValueByLabels(auroraSkinFlowCounter, { stage: 'reco_safety_block', outcome: 'hit' });
  const recoTimeoutDegraded = counterValueByLabels(auroraSkinFlowCounter, { stage: 'reco_timeout_degraded', outcome: 'hit' });
  const recoOutputGuardFallback = counterValueByLabels(auroraSkinFlowCounter, { stage: 'reco_output_guard_fallback', outcome: 'hit' });
  const analysisRequests = counterValueByLabels(auroraSkinFlowCounter, { stage: 'analysis_request', outcome: 'hit' });
  const artifactCreated = counterValueByLabels(auroraSkinFlowCounter, { stage: 'artifact_created', outcome: 'hit' });
  const ingredientPlans = counterValueByLabels(auroraSkinFlowCounter, { stage: 'ingredient_plan', outcome: 'hit' });
  const analysisTimeoutDegraded = counterValueByLabels(auroraSkinFlowCounter, { stage: 'analysis_timeout_degraded', outcome: 'hit' });
  const ingredientEntries = counterValueByLabels(auroraIngredientsFlowCounter, { stage: 'entry_opened', outcome: 'hit' });
  const ingredientAnswers = counterValueByLabels(auroraIngredientsFlowCounter, { stage: 'answer_served', outcome: 'hit' });
  const ingredientTextQueryRouted = counterValueByLabels(auroraIngredientsFlowCounter, { stage: 'text_query_routed', outcome: 'hit' });
  const ingredientTextRouteDrift = counterValueByLabels(auroraIngredientsFlowCounter, { stage: 'text_route_drift', outcome: 'hit' });
  const ingredientKbHit = counterValueByLabels(auroraIngredientsFlowCounter, { stage: 'kb_hit', outcome: 'hit' });
  const ingredientKbMiss = counterValueByLabels(auroraIngredientsFlowCounter, { stage: 'kb_miss', outcome: 'hit' });
  const ingredientResearchRequested = counterValueByLabels(auroraIngredientsFlowCounter, { stage: 'research_requested', outcome: 'hit' });
  const ingredientResearchCompleted = counterValueByLabels(auroraIngredientsFlowCounter, { stage: 'research_completed', outcome: 'hit' });
  const ingredientResearchError = counterValueByLabels(auroraIngredientsFlowCounter, { stage: 'research_error', outcome: 'hit' });
  const ingredientInvalidJson = counterValueByLabels(auroraIngredientsFlowCounter, { stage: 'invalid_json', outcome: 'hit' });
  const ingredientEmptySectionPrevented = counterValueByLabels(auroraIngredientsFlowCounter, { stage: 'empty_section_prevented', outcome: 'hit' });
  const ingredientDuplicateJobDedup = counterValueByLabels(auroraIngredientsFlowCounter, { stage: 'duplicate_job_dedup', outcome: 'hit' });
  const ingredientCircuitOpen = counterValueByLabels(auroraIngredientsFlowCounter, { stage: 'circuit_open', outcome: 'hit' });
  const ingredientCardRenderDrop = counterValueByLabels(auroraIngredientsFlowCounter, { stage: 'card_render_drop', outcome: 'hit' });
  const ingredientRecoOptin = counterValueByLabels(auroraIngredientsFlowCounter, { stage: 'reco_optin', outcome: 'hit' });
  const ingredientUnwantedDiagnosis = counterValueByLabels(auroraIngredientsFlowCounter, { stage: 'unwanted_diagnosis', outcome: 'hit' });
  const ingredientProviderAttemptGemini = counterValueByLabels(auroraIngredientProviderCounter, {
    stage: 'attempt',
    provider: 'gemini',
  });

  lines.push('# HELP aurora_skin_reco_generated_rate reco_generated / reco_request.');
  lines.push('# TYPE aurora_skin_reco_generated_rate gauge');
  lines.push(`aurora_skin_reco_generated_rate ${recoRequests > 0 ? recoGenerated / recoRequests : 0}`);

  lines.push('# HELP aurora_skin_reco_low_confidence_rate reco_low_confidence / reco_request.');
  lines.push('# TYPE aurora_skin_reco_low_confidence_rate gauge');
  lines.push(`aurora_skin_reco_low_confidence_rate ${recoRequests > 0 ? recoLowConfidence / recoRequests : 0}`);

  lines.push('# HELP aurora_skin_reco_safety_block_rate reco_safety_block / reco_request.');
  lines.push('# TYPE aurora_skin_reco_safety_block_rate gauge');
  lines.push(`aurora_skin_reco_safety_block_rate ${recoRequests > 0 ? recoSafetyBlock / recoRequests : 0}`);

  lines.push('# HELP aurora_skin_reco_timeout_degraded_rate reco_timeout_degraded / reco_request.');
  lines.push('# TYPE aurora_skin_reco_timeout_degraded_rate gauge');
  lines.push(`aurora_skin_reco_timeout_degraded_rate ${recoRequests > 0 ? recoTimeoutDegraded / recoRequests : 0}`);

  lines.push('# HELP aurora_skin_reco_output_guard_fallback_rate reco_output_guard_fallback / reco_request.');
  lines.push('# TYPE aurora_skin_reco_output_guard_fallback_rate gauge');
  lines.push(`aurora_skin_reco_output_guard_fallback_rate ${recoRequests > 0 ? recoOutputGuardFallback / recoRequests : 0}`);

  lines.push('# HELP aurora_skin_artifact_created_rate artifact_created / analysis_request.');
  lines.push('# TYPE aurora_skin_artifact_created_rate gauge');
  lines.push(`aurora_skin_artifact_created_rate ${analysisRequests > 0 ? artifactCreated / analysisRequests : 0}`);

  lines.push('# HELP aurora_skin_ingredient_plan_rate ingredient_plan / analysis_request.');
  lines.push('# TYPE aurora_skin_ingredient_plan_rate gauge');
  lines.push(`aurora_skin_ingredient_plan_rate ${analysisRequests > 0 ? ingredientPlans / analysisRequests : 0}`);

  lines.push('# HELP aurora_skin_analysis_timeout_degraded_rate analysis_timeout_degraded / analysis_request.');
  lines.push('# TYPE aurora_skin_analysis_timeout_degraded_rate gauge');
  lines.push(`aurora_skin_analysis_timeout_degraded_rate ${analysisRequests > 0 ? analysisTimeoutDegraded / analysisRequests : 0}`);

  lines.push('# HELP ingredients_unwanted_diagnosis_rate unwanted diagnosis gate responses / ingredients entries.');
  lines.push('# TYPE ingredients_unwanted_diagnosis_rate gauge');
  lines.push(`ingredients_unwanted_diagnosis_rate ${ingredientEntries > 0 ? ingredientUnwantedDiagnosis / ingredientEntries : 0}`);

  lines.push('# HELP ingredients_to_reco_optin_rate ingredient-path reco opt-ins / ingredients entries.');
  lines.push('# TYPE ingredients_to_reco_optin_rate gauge');
  lines.push(`ingredients_to_reco_optin_rate ${ingredientEntries > 0 ? ingredientRecoOptin / ingredientEntries : 0}`);

  lines.push('# HELP ingredients_text_route_drift_rate ingredient text-route drifts / ingredient text query-first routed.');
  lines.push('# TYPE ingredients_text_route_drift_rate gauge');
  lines.push(
    `ingredients_text_route_drift_rate ${ingredientTextQueryRouted > 0 ? ingredientTextRouteDrift / ingredientTextQueryRouted : 0}`,
  );

  lines.push('# HELP ingredient_kb_hit_rate ingredient KB hit / (hit + miss).');
  lines.push('# TYPE ingredient_kb_hit_rate gauge');
  lines.push(`ingredient_kb_hit_rate ${ingredientKbHit + ingredientKbMiss > 0 ? ingredientKbHit / (ingredientKbHit + ingredientKbMiss) : 0}`);

  lines.push('# HELP ingredient_card_render_drop_rate ingredient card render drops / ingredient answers.');
  lines.push('# TYPE ingredient_card_render_drop_rate gauge');
  lines.push(`ingredient_card_render_drop_rate ${ingredientAnswers > 0 ? ingredientCardRenderDrop / ingredientAnswers : 0}`);

  lines.push('# HELP ingredient_research_completion_rate ingredient deep-research completed / requested.');
  lines.push('# TYPE ingredient_research_completion_rate gauge');
  lines.push(
    `ingredient_research_completion_rate ${ingredientResearchRequested > 0 ? ingredientResearchCompleted / ingredientResearchRequested : 0}`,
  );

  lines.push('# HELP ingredient_research_error_rate ingredient deep-research errors / requested.');
  lines.push('# TYPE ingredient_research_error_rate gauge');
  lines.push(
    `ingredient_research_error_rate ${ingredientResearchRequested > 0 ? ingredientResearchError / ingredientResearchRequested : 0}`,
  );

  lines.push('# HELP gemini_circuit_open_rate ingredient provider circuit-open events / gemini attempts.');
  lines.push('# TYPE gemini_circuit_open_rate gauge');
  lines.push(
    `gemini_circuit_open_rate ${ingredientProviderAttemptGemini > 0 ? ingredientCircuitOpen / ingredientProviderAttemptGemini : 0}`,
  );

  lines.push('# HELP invalid_json_rate ingredient invalid-json fallbacks / ingredient research requested.');
  lines.push('# TYPE invalid_json_rate gauge');
  lines.push(`invalid_json_rate ${ingredientResearchRequested > 0 ? ingredientInvalidJson / ingredientResearchRequested : 0}`);

  lines.push('# HELP empty_section_prevented_rate ingredient minimal-card preventions / ingredient answers.');
  lines.push('# TYPE empty_section_prevented_rate gauge');
  lines.push(
    `empty_section_prevented_rate ${ingredientAnswers > 0 ? ingredientEmptySectionPrevented / ingredientAnswers : 0}`,
  );

  lines.push('# HELP duplicate_job_dedup_rate ingredient deduped async research jobs / ingredient KB misses.');
  lines.push('# TYPE duplicate_job_dedup_rate gauge');
  lines.push(
    `duplicate_job_dedup_rate ${ingredientKbMiss > 0 ? ingredientDuplicateJobDedup / ingredientKbMiss : 0}`,
  );

  lines.push('# HELP geometry_sanitizer_drop_rate geometry_sanitizer_drop_total / analyze_requests_total.');
  lines.push('# TYPE geometry_sanitizer_drop_rate gauge');
  const rateKeys = new Set([
    ...Array.from(analyzeRequestsCounter.keys()),
    ...Array.from(geometrySanitizerDropCounter.keys()),
    ...Array.from(geometrySanitizerClipCounter.keys()),
  ]);
  for (const key of Array.from(rateKeys).sort((a, b) => a.localeCompare(b))) {
    const labels = parseLabelsKey(key);
    const drops = Number(geometrySanitizerDropCounter.get(key) || 0);
    const requests = Number(analyzeRequestsCounter.get(key) || 0);
    const rate = requests > 0 ? drops / requests : 0;
    lines.push(`geometry_sanitizer_drop_rate${labelsToProm(labels)} ${rate}`);
  }

  return `${lines.join('\n')}\n`;
}

function resetVisionMetrics() {
  callsCounter.clear();
  failCounter.clear();
  fallbackCounter.clear();
  latencyByProvider.clear();
  ensembleProviderCalls.clear();
  ensembleProviderFails.clear();
  ensembleProviderSchemaFails.clear();
  ensembleLatencyByProvider.clear();
  for (const key of ensembleAgreementHistogram.keys()) ensembleAgreementHistogram.set(key, 0);
  ensembleAgreementCount = 0;
  ensembleAgreementSum = 0;
  verifierCalls.clear();
  verifierFails.clear();
  verifierUnknownErrorClassFails.clear();
  for (const key of verifierAgreementHistogram.keys()) verifierAgreementHistogram.set(key, 0);
  verifierAgreementCount = 0;
  verifierAgreementSum = 0;
  verifierHardCaseCount = 0;
  verifierBudgetGuardCount = 0;
  verifierCircuitOpenCount = 0;
  verifierRetryCount = 0;
  verifierTimeoutByStage.clear();
  analyzeRequestsCounter.clear();
  geometrySanitizerDropCounter.clear();
  geometrySanitizerClipCounter.clear();
  photoModulesCardEmittedCounter.clear();
  regionsEmittedCounter.clear();
  modulesIssueCountHistogramCounter.clear();
  ingredientActionsEmittedCounter.clear();
  geometrySanitizerDropReasonCounter.clear();
  skinmaskFallbackCounter.clear();
  productRecEmittedCounter.clear();
  productRecSuppressedCounter.clear();
  claimsTemplateFallbackCounter.clear();
  claimsViolationCounter.clear();
  skinmaskEnabledCount = 0;
  skinmaskInferLatency.count = 0;
  skinmaskInferLatency.sum = 0;
  for (const key of skinmaskInferLatency.buckets.keys()) skinmaskInferLatency.buckets.set(key, 0);
  clarificationIdNormalizedEmptyCount = 0;
  catalogAvailabilityShortCircuitCounter.clear();
  repeatedClarifyFieldCounter.clear();
  clarificationPresentCounter.clear();
  clarificationQuestionFilteredCounter.clear();
  clarificationAllQuestionsFilteredCount = 0;
  clarificationSchemaInvalidCounter.clear();
  clarificationFlowV2StartedCount = 0;
  pendingClarificationStepCounter.clear();
  pendingClarificationCompletedCount = 0;
  pendingClarificationAbandonedCounter.clear();
  clarificationHistorySentCounter.clear();
  auroraChatSkippedCounter.clear();
  pendingClarificationUpgradedCounter.clear();
  pendingClarificationTruncatedCounter.clear();
  resumePrefixInjectedCounter.clear();
  resumePrefixHistoryItemsCounter.clear();
  resumeResponseModeCounter.clear();
  resumePlaintextReaskDetectedCounter.clear();
  profileContextMissingCounter.clear();
  sessionPatchProfileEmittedCounter.clear();
  upstreamCallsCounter.clear();
  upstreamLatencyByPath.clear();
  templateAppliedCounter.clear();
  templateFallbackCounter.clear();
  antiTemplateViolationCounter.clear();
  actionableReplyCounter.clear();
  recoGuardrailViolationCounter.clear();
  recoCandidateCounter.clear();
  recoExplanationAlignmentCounter.clear();
  recoGuardrailCircuitOpenCounter.clear();
  recoEmployeeFeedbackCounter.clear();
  recoInterleaveClickCounter.clear();
  recoInterleaveWinCounter.clear();
  recoExplorationSlotCounter.clear();
  recoAsyncUpdateCounter.clear();
  recoAsyncUpdateChangedItemsCounter.clear();
  recoContextUsedCounter.clear();
  travelPlanSelectionCounter.clear();
  auroraRoute404Counter.clear();
  auroraTravelPlansNonJsonCounter.clear();
  auroraTravelLlmCallCounter.clear();
  auroraTravelLlmTriggerCounter.clear();
  auroraTravelLlmSkipCounter.clear();
  auroraTravelSkillSkipCounter.clear();
  auroraTravelKbHitCounter.clear();
  auroraTravelKbWriteCounter.clear();
  auroraTravelResponseSourceCounter.clear();
  auroraTravelWeatherSourceCounter.clear();
  auroraTravelForecastSourceCounter.clear();
  auroraTravelAlertSourceCounter.clear();
  auroraTravelBaselineIntegrityCounter.clear();
  auroraTravelResponseQualityCounter.clear();
  auroraTravelReplyModeCounter.clear();
  auroraTravelEnvCardEmittedCounter.clear();
  prelabelRequestsCounter.clear();
  prelabelSuccessCounter.clear();
  prelabelInvalidJsonCounter.clear();
  prelabelCacheHitCounter.clear();
  prelabelSuggestionsGeneratedCounter.clear();
  prelabelQueueItemsServedCounter.clear();
  socialFetchRequestsCounter.clear();
  socialFetchSuccessCounter.clear();
  socialFetchTimeoutCounter.clear();
  socialKbBackfillCounter.clear();
  auroraCompSnapshotHitCounter.clear();
  auroraCompSnapshotStaleCounter.clear();
  auroraCompDegradedCounter.clear();
  auroraCompBackfillEnqueuedCounter.clear();
  auroraCompBackfillDedupDropCounter.clear();
  auroraCompPass2InvokedCounter.clear();
  auroraCompPass2TimeoutCounter.clear();
  auroraCompSnapshotAgeSecHistogram.count = 0;
  auroraCompSnapshotAgeSecHistogram.sum = 0;
  for (const key of auroraCompSnapshotAgeSecHistogram.buckets.keys()) {
    auroraCompSnapshotAgeSecHistogram.buckets.set(key, 0);
  }
  prelabelGeminiLatency.count = 0;
  prelabelGeminiLatency.sum = 0;
  for (const key of prelabelGeminiLatency.buckets.keys()) prelabelGeminiLatency.buckets.set(key, 0);
  recoCompetitorsSameBrandRateGauge = 0;
  recoCompetitorsOnPageSourceRateGauge = 0;
  recoExplanationAlignmentAt3Gauge = 0;
  prelabelCacheHitRateGauge = 0;
  prelabelOverturnedRateGauge = 0;
  socialCacheHitRateGauge = 0;
  socialChannelsCoverageGauge = 0;
  chipsTruncatedCount = 0;
  fieldMissingAddedCount = 0;
  modulesInteractionCount = 0;
  actionClickCount = 0;
  actionCopyCount = 0;
  retakeAfterModulesCount = 0;
  auroraSkinFlowCounter.clear();
  auroraSkinLlmSchemaViolationCounter.clear();
  auroraSkinLlmRetryCounter.clear();
  auroraSkinLlmRetrySuccessCounter.clear();
  auroraSkinMainlineProviderCounter.clear();
  auroraSkinFallbackDeterministicCounter.clear();
  auroraSkinShadowVerifyIsolatedWriteCounter.clear();
  auroraSkinSemanticGuardCounter.clear();
  auroraSkinUsefulOutputCounter.clear();
  auroraIngredientsFlowCounter.clear();
  auroraIngredientProviderCounter.clear();
  ingredientReportGeneratedCounter.clear();
  ingredientReportGenericFallbackCounter.clear();
  ingredientReportPendingCounter.clear();
  ingredientReportFingerprintWindow.length = 0;
  ingredientReportFingerprintFreq.clear();
  ingredientReportUniquenessRatioGauge = 0;
  auroraIngredientsFirstAnswerLatency.count = 0;
  auroraIngredientsFirstAnswerLatency.sum = 0;
  for (const key of auroraIngredientsFirstAnswerLatency.buckets.keys()) {
    auroraIngredientsFirstAnswerLatency.buckets.set(key, 0);
  }
  auroraSkinAnalysisRealModelCounter.clear();
  auroraSkinLlmCallCounter.clear();
  auroraRecoLlmCallCounter.clear();
  recoAlternativesBudgetExhaustedTotal = 0;
  recoAlternativesTimeoutTotal = 0;
  recoAlternativesEmptyTotal = 0;
  promptContractMismatchTotal = 0;
  auroraRecoEntrySourceCounter.clear();
  auroraRecoKbWriteCounter.clear();
  auroraProfileAutoPatchCounter.clear();
  auroraRecoContextUsedCounter.clear();
  responseSchemaViolationCounter.clear();
  fpmClarifyReasonCounter.clear();
  fpmRepeatedSlotClarifyCounter.clear();
  fpmContextFailOpenCounter.clear();
  fpmProductsAfterClarifyCounter.clear();
  fpmProductsAfterClarifySeen = 0;
  fpmProductsAfterClarifyHit = 0;
  fpmProductsAfterClarifyRateGauge = 0;
  auroraKbV0LoaderErrorCounter.clear();
  auroraKbV0RuleMatchCounter.clear();
  auroraKbV0LegacyFallbackCounter.clear();
  auroraKbV0ClimateFallbackCounter.clear();
}

function snapshotVisionMetrics() {
  return {
    calls: Array.from(callsCounter.entries()),
    fails: Array.from(failCounter.entries()),
    fallbacks: Array.from(fallbackCounter.entries()),
    latencyProviders: Array.from(latencyByProvider.keys()),
    ensembleProviderCalls: Array.from(ensembleProviderCalls.entries()),
    ensembleProviderFails: Array.from(ensembleProviderFails.entries()),
    ensembleProviderSchemaFails: Array.from(ensembleProviderSchemaFails.entries()),
    ensembleLatencyProviders: Array.from(ensembleLatencyByProvider.keys()),
    ensembleAgreementCount,
    ensembleAgreementSum,
    verifierCalls: Array.from(verifierCalls.entries()),
    verifierFails: Array.from(verifierFails.entries()),
    verifierUnknownErrorClassFails: Array.from(verifierUnknownErrorClassFails.entries()),
    verifierAgreementCount,
    verifierAgreementSum,
    verifierHardCaseCount,
    verifierBudgetGuardCount,
    verifierCircuitOpenCount,
    verifierRetryCount,
    verifierTimeoutByStage: Array.from(verifierTimeoutByStage.entries()),
    analyzeRequests: Array.from(analyzeRequestsCounter.entries()),
    geometrySanitizerDrops: Array.from(geometrySanitizerDropCounter.entries()),
    geometrySanitizerClips: Array.from(geometrySanitizerClipCounter.entries()),
    photoModulesCardEmitted: Array.from(photoModulesCardEmittedCounter.entries()),
    regionsEmitted: Array.from(regionsEmittedCounter.entries()),
    modulesIssueCountHistogram: Array.from(modulesIssueCountHistogramCounter.entries()),
    ingredientActionsEmitted: Array.from(ingredientActionsEmittedCounter.entries()),
    geometrySanitizerDropReasons: Array.from(geometrySanitizerDropReasonCounter.entries()),
    skinmaskEnabledCount,
    skinmaskFallbacks: Array.from(skinmaskFallbackCounter.entries()),
    skinmaskInferLatency: {
      count: skinmaskInferLatency.count,
      sum: skinmaskInferLatency.sum,
      buckets: Array.from(skinmaskInferLatency.buckets.entries()),
    },
    productRecEmitted: Array.from(productRecEmittedCounter.entries()),
    productRecSuppressed: Array.from(productRecSuppressedCounter.entries()),
    claimsTemplateFallbacks: Array.from(claimsTemplateFallbackCounter.entries()),
    claimsViolations: Array.from(claimsViolationCounter.entries()),
    clarificationIdNormalizedEmptyCount,
    catalogAvailabilityShortCircuits: Array.from(catalogAvailabilityShortCircuitCounter.entries()),
    repeatedClarifyFields: Array.from(repeatedClarifyFieldCounter.entries()),
    clarificationPresent: Array.from(clarificationPresentCounter.entries()),
    clarificationQuestionFiltered: Array.from(clarificationQuestionFilteredCounter.entries()),
    clarificationAllQuestionsFilteredCount,
    clarificationSchemaInvalid: Array.from(clarificationSchemaInvalidCounter.entries()),
    clarificationFlowV2StartedCount,
    pendingClarificationStep: Array.from(pendingClarificationStepCounter.entries()),
    pendingClarificationCompletedCount,
    pendingClarificationAbandoned: Array.from(pendingClarificationAbandonedCounter.entries()),
    clarificationHistorySent: Array.from(clarificationHistorySentCounter.entries()),
    auroraChatSkipped: Array.from(auroraChatSkippedCounter.entries()),
    pendingClarificationUpgraded: Array.from(pendingClarificationUpgradedCounter.entries()),
    pendingClarificationTruncated: Array.from(pendingClarificationTruncatedCounter.entries()),
    resumePrefixInjected: Array.from(resumePrefixInjectedCounter.entries()),
    resumePrefixHistoryItems: Array.from(resumePrefixHistoryItemsCounter.entries()),
    resumeResponseMode: Array.from(resumeResponseModeCounter.entries()),
    resumePlaintextReaskDetected: Array.from(resumePlaintextReaskDetectedCounter.entries()),
    profileContextMissing: Array.from(profileContextMissingCounter.entries()),
    sessionPatchProfileEmitted: Array.from(sessionPatchProfileEmittedCounter.entries()),
    upstreamCalls: Array.from(upstreamCallsCounter.entries()),
    upstreamLatencyPaths: Array.from(upstreamLatencyByPath.keys()),
    templateApplied: Array.from(templateAppliedCounter.entries()),
    templateFallback: Array.from(templateFallbackCounter.entries()),
    antiTemplateViolation: Array.from(antiTemplateViolationCounter.entries()),
    actionableReply: Array.from(actionableReplyCounter.entries()),
    recoGuardrailViolations: Array.from(recoGuardrailViolationCounter.entries()),
    recoCandidates: Array.from(recoCandidateCounter.entries()),
    recoExplanationAlignment: Array.from(recoExplanationAlignmentCounter.entries()),
    recoGuardrailCircuitOpen: Array.from(recoGuardrailCircuitOpenCounter.entries()),
    recoEmployeeFeedback: Array.from(recoEmployeeFeedbackCounter.entries()),
    recoInterleaveClick: Array.from(recoInterleaveClickCounter.entries()),
    recoInterleaveWin: Array.from(recoInterleaveWinCounter.entries()),
    recoExplorationSlot: Array.from(recoExplorationSlotCounter.entries()),
    recoAsyncUpdate: Array.from(recoAsyncUpdateCounter.entries()),
    recoAsyncUpdateChangedItems: Array.from(recoAsyncUpdateChangedItemsCounter.entries()),
    recoContextUsed: Array.from(recoContextUsedCounter.entries()),
    travelPlanSelection: Array.from(travelPlanSelectionCounter.entries()),
    auroraRoute404: Array.from(auroraRoute404Counter.entries()),
    auroraTravelPlansNonJson: Array.from(auroraTravelPlansNonJsonCounter.entries()),
    auroraTravelLlmCall: Array.from(auroraTravelLlmCallCounter.entries()),
    auroraTravelLlmTrigger: Array.from(auroraTravelLlmTriggerCounter.entries()),
    auroraTravelLlmSkip: Array.from(auroraTravelLlmSkipCounter.entries()),
    auroraTravelSkillSkip: Array.from(auroraTravelSkillSkipCounter.entries()),
    auroraTravelKbHit: Array.from(auroraTravelKbHitCounter.entries()),
    auroraTravelKbWrite: Array.from(auroraTravelKbWriteCounter.entries()),
    auroraTravelResponseSource: Array.from(auroraTravelResponseSourceCounter.entries()),
    auroraTravelWeatherSource: Array.from(auroraTravelWeatherSourceCounter.entries()),
    auroraTravelForecastSource: Array.from(auroraTravelForecastSourceCounter.entries()),
    auroraTravelAlertSource: Array.from(auroraTravelAlertSourceCounter.entries()),
    auroraTravelBaselineIntegrity: Array.from(auroraTravelBaselineIntegrityCounter.entries()),
    auroraTravelResponseQuality: Array.from(auroraTravelResponseQualityCounter.entries()),
    auroraTravelReplyMode: Array.from(auroraTravelReplyModeCounter.entries()),
    auroraTravelEnvCardEmitted: Array.from(auroraTravelEnvCardEmittedCounter.entries()),
    prelabelRequests: Array.from(prelabelRequestsCounter.entries()),
    prelabelSuccess: Array.from(prelabelSuccessCounter.entries()),
    prelabelInvalidJson: Array.from(prelabelInvalidJsonCounter.entries()),
    prelabelCacheHit: Array.from(prelabelCacheHitCounter.entries()),
    prelabelSuggestionsGenerated: Array.from(prelabelSuggestionsGeneratedCounter.entries()),
    prelabelQueueItemsServed: Array.from(prelabelQueueItemsServedCounter.entries()),
    socialFetchRequests: Array.from(socialFetchRequestsCounter.entries()),
    socialFetchSuccess: Array.from(socialFetchSuccessCounter.entries()),
    socialFetchTimeout: Array.from(socialFetchTimeoutCounter.entries()),
    socialKbBackfill: Array.from(socialKbBackfillCounter.entries()),
    auroraCompSnapshotHit: Array.from(auroraCompSnapshotHitCounter.entries()),
    auroraCompSnapshotStale: Array.from(auroraCompSnapshotStaleCounter.entries()),
    auroraCompDegraded: Array.from(auroraCompDegradedCounter.entries()),
    auroraCompBackfillEnqueued: Array.from(auroraCompBackfillEnqueuedCounter.entries()),
    auroraCompBackfillDedupDrop: Array.from(auroraCompBackfillDedupDropCounter.entries()),
    auroraCompPass2Invoked: Array.from(auroraCompPass2InvokedCounter.entries()),
    auroraCompPass2Timeout: Array.from(auroraCompPass2TimeoutCounter.entries()),
    auroraCompSnapshotAgeSeconds: {
      count: auroraCompSnapshotAgeSecHistogram.count,
      sum: auroraCompSnapshotAgeSecHistogram.sum,
      buckets: Array.from(auroraCompSnapshotAgeSecHistogram.buckets.entries()),
    },
    prelabelGeminiLatency: {
      count: prelabelGeminiLatency.count,
      sum: prelabelGeminiLatency.sum,
      buckets: Array.from(prelabelGeminiLatency.buckets.entries()),
    },
    prelabelCacheHitRateGauge,
    prelabelOverturnedRateGauge,
    socialCacheHitRateGauge,
    socialChannelsCoverageGauge,
    recoCompetitorsSameBrandRateGauge,
    recoCompetitorsOnPageSourceRateGauge,
    recoExplanationAlignmentAt3Gauge,
    chipsTruncatedCount,
    fieldMissingAddedCount,
    modulesInteractionCount,
    actionClickCount,
    actionCopyCount,
    retakeAfterModulesCount,
    auroraSkinFlow: Array.from(auroraSkinFlowCounter.entries()),
    auroraSkinLlmSchemaViolations: Array.from(auroraSkinLlmSchemaViolationCounter.entries()),
    auroraSkinLlmRetry: Array.from(auroraSkinLlmRetryCounter.entries()),
    auroraSkinLlmRetrySuccess: Array.from(auroraSkinLlmRetrySuccessCounter.entries()),
    auroraSkinMainlineProvider: Array.from(auroraSkinMainlineProviderCounter.entries()),
    auroraSkinFallbackDeterministic: Array.from(auroraSkinFallbackDeterministicCounter.entries()),
    auroraSkinShadowVerifyIsolatedWrite: Array.from(auroraSkinShadowVerifyIsolatedWriteCounter.entries()),
    auroraSkinSemanticGuard: Array.from(auroraSkinSemanticGuardCounter.entries()),
    auroraSkinUsefulOutput: Array.from(auroraSkinUsefulOutputCounter.entries()),
    auroraIngredientsFlow: Array.from(auroraIngredientsFlowCounter.entries()),
    auroraIngredientProvider: Array.from(auroraIngredientProviderCounter.entries()),
    ingredientReportGenerated: Array.from(ingredientReportGeneratedCounter.entries()),
    ingredientReportGenericFallback: Array.from(ingredientReportGenericFallbackCounter.entries()),
    ingredientReportPending: Array.from(ingredientReportPendingCounter.entries()),
    ingredientReportUniquenessRatioGauge,
    auroraIngredientsFirstAnswerLatency: {
      count: auroraIngredientsFirstAnswerLatency.count,
      sum: auroraIngredientsFirstAnswerLatency.sum,
      buckets: Array.from(auroraIngredientsFirstAnswerLatency.buckets.entries()),
    },
    auroraSkinAnalysisRealModel: Array.from(auroraSkinAnalysisRealModelCounter.entries()),
    auroraSkinLlmCall: Array.from(auroraSkinLlmCallCounter.entries()),
    auroraRecoLlmCall: Array.from(auroraRecoLlmCallCounter.entries()),
    recoAlternativesBudgetExhaustedTotal,
    recoAlternativesTimeoutTotal,
    recoAlternativesEmptyTotal,
    promptContractMismatchTotal,
    auroraRecoEntrySource: Array.from(auroraRecoEntrySourceCounter.entries()),
    auroraRecoKbWrite: Array.from(auroraRecoKbWriteCounter.entries()),
    auroraProfileAutoPatch: Array.from(auroraProfileAutoPatchCounter.entries()),
    auroraRecoContextUsed: Array.from(auroraRecoContextUsedCounter.entries()),
    responseSchemaViolations: Array.from(responseSchemaViolationCounter.entries()),
    fpmClarifyReason: Array.from(fpmClarifyReasonCounter.entries()),
    fpmRepeatedSlotClarify: Array.from(fpmRepeatedSlotClarifyCounter.entries()),
    fpmContextFailOpen: Array.from(fpmContextFailOpenCounter.entries()),
    fpmProductsAfterClarify: Array.from(fpmProductsAfterClarifyCounter.entries()),
    fpmProductsAfterClarifyRateGauge,
    auroraKbV0LoaderError: Array.from(auroraKbV0LoaderErrorCounter.entries()),
    auroraKbV0RuleMatch: Array.from(auroraKbV0RuleMatchCounter.entries()),
    auroraKbV0LegacyFallback: Array.from(auroraKbV0LegacyFallbackCounter.entries()),
    auroraKbV0ClimateFallback: Array.from(auroraKbV0ClimateFallbackCounter.entries()),
  };
}

module.exports = {
  recordClarificationIdNormalizedEmpty,
  recordCatalogAvailabilityShortCircuit,
  recordRepeatedClarifyField,
  recordClarificationPresent,
  recordClarificationQuestionFiltered,
  recordClarificationAllQuestionsFiltered,
  recordClarificationSchemaInvalid,
  recordClarificationFlowV2Started,
  recordPendingClarificationStep,
  recordPendingClarificationCompleted,
  recordPendingClarificationAbandoned,
  recordClarificationHistorySent,
  recordAuroraChatSkipped,
  recordPendingClarificationUpgraded,
  recordPendingClarificationTruncated,
  recordResumePrefixInjected,
  recordResumePrefixHistoryItems,
  recordResumeResponseMode,
  recordResumePlaintextReaskDetected,
  recordProfileContextMissing,
  recordSessionPatchProfileEmitted,
  recordUpstreamCall,
  recordTemplateApplied,
  recordTemplateFallback,
  recordChipsTruncated,
  recordFieldMissingAdded,
  recordAntiTemplateViolation,
  recordActionableReply,
  recordRecoGuardrailViolation,
  recordRecoCandidate,
  recordRecoExplanationAlignment,
  recordRecoGuardrailCircuitOpen,
  recordRecoEmployeeFeedback,
  recordRecoInterleaveClick,
  recordRecoInterleaveWin,
  recordRecoExplorationSlot,
  recordRecoAsyncUpdate,
  recordRecoContextUsed,
  recordTravelPlanSelection,
  recordAuroraRoute404,
  recordAuroraTravelPlansNonJson,
  recordAuroraTravelLlmCall,
  recordAuroraTravelLlmTrigger,
  recordAuroraTravelLlmSkip,
  recordAuroraTravelSkillSkip,
  recordAuroraTravelKbHit,
  recordAuroraTravelKbWrite,
  recordAuroraTravelResponseSource,
  recordAuroraTravelWeatherSource,
  recordAuroraTravelForecastSource,
  recordAuroraTravelAlertSource,
  recordAuroraTravelBaselineIntegrity,
  recordAuroraTravelResponseQuality,
  recordAuroraTravelReplyMode,
  recordAuroraTravelEnvCardEmitted,
  setRecoGuardrailRates,
  recordPrelabelRequest,
  recordPrelabelSuccess,
  recordPrelabelInvalidJson,
  recordPrelabelCacheHit,
  observePrelabelGeminiLatency,
  recordSuggestionsGeneratedPerBlock,
  recordQueueItemsServed,
  setPrelabelCacheHitRate,
  setLlmSuggestionOverturnedRate,
  recordSocialFetchRequest,
  recordSocialFetchSuccess,
  recordSocialFetchTimeout,
  recordSocialKbBackfill,
  setSocialCacheHitRate,
  setSocialChannelsCoverage,
  recordAuroraCompSnapshotHit,
  recordAuroraCompSnapshotStale,
  recordAuroraCompDegraded,
  recordAuroraCompBackfillEnqueued,
  recordAuroraCompBackfillDedupDrop,
  recordAuroraCompPass2Invoked,
  recordAuroraCompPass2Timeout,
  observeAuroraCompSnapshotAgeSeconds,
  observeUpstreamLatency,
  recordVisionDecision,
  observeVisionLatency,
  recordEnsembleProviderResult,
  recordEnsembleAgreementScore,
  recordVerifyCall,
  recordVerifyFail,
  recordVerifyBudgetGuard,
  recordVerifyCircuitOpen,
  recordVerifyRetry,
  recordVerifyAgreementScore,
  recordVerifyHardCase,
  recordAnalyzeRequest,
  recordGeometrySanitizerTotals,
  recordPhotoModulesCardEmitted,
  recordRegionsEmitted,
  recordModulesIssueCountHistogram,
  recordIngredientActionsEmitted,
  recordProductRecEmitted,
  recordProductRecSuppressed,
  recordClaimsTemplateFallback,
  recordClaimsViolation,
  recordAuroraSkinFlowMetric,
  recordAuroraSkinLlmSchemaViolation,
  recordAuroraSkinLlmRetry,
  recordAuroraSkinLlmRetrySuccess,
  recordAuroraSkinMainlineProvider,
  recordAuroraSkinFallbackDeterministic,
  recordAuroraSkinShadowVerifyIsolatedWrite,
  recordAuroraSkinSemanticGuard,
  recordAuroraSkinUsefulOutput,
  recordAuroraIngredientsFlowMetric,
  recordAuroraIngredientProviderMetric,
  recordIngredientReportMetric,
  observeAuroraIngredientsFirstAnswerLatency,
  recordAuroraSkinAnalysisRealModel,
  recordAuroraSkinLlmCall,
  recordAuroraRecoLlmCall,
  recordRecoAlternativesBudgetExhausted,
  recordRecoAlternativesTimeout,
  recordRecoAlternativesEmpty,
  recordPromptContractMismatch,
  recordAuroraRecoEntrySource,
  recordAuroraRecoKbWrite,
  recordAuroraProfileAutoPatch,
  recordAuroraRecoContextUsed,
  recordResponseSchemaViolation,
  recordFpmClarifyReason,
  recordFpmRepeatedSlotClarify,
  recordFpmContextFailOpen,
  recordFpmProductsAfterClarify,
  recordAuroraKbV0LoaderError,
  recordAuroraKbV0RuleMatch,
  recordAuroraKbV0LegacyFallback,
  recordAuroraKbV0ClimateFallback,
  recordSkinmaskEnabled,
  recordSkinmaskFallback,
  observeSkinmaskInferLatency,
  recordUiBehaviorEvent,
  recordGeometrySanitizerDropReason,
  renderVisionMetricsPrometheus,
  resetVisionMetrics,
  snapshotVisionMetrics,
};
