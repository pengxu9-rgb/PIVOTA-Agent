const axios = require('axios');
const OpenAI = require('openai');
const sharp = require('sharp');
const fs = require('fs');
const crypto = require('crypto');
const { buildRequestContext } = require('./requestContext');
const { buildEnvelope, makeAssistantMessage, makeEvent } = require('./envelope');
const { createStageProfiler } = require('./skinAnalysisProfiling');
const { runSkinDiagnosisV1, summarizeDiagnosisForPolicy, buildSkinAnalysisFromDiagnosisV1 } = require('./skinDiagnosisV1');
const { buildSkinVisionPrompt, buildSkinReportPrompt } = require('./skinLlmPrompts');
const {
  classifyPhotoQuality,
  inferDetectorConfidence,
  shouldCallLlm,
  downgradeSkinAnalysisConfidence,
  humanizeLlmReasons,
} = require('./skinLlmPolicy');
const {
  VisionUnavailabilityReason,
  classifyVisionAvailability,
  classifyVisionProviderFailure,
  executeVisionWithRetry,
  normalizeVisionReason,
  isVisionFailureReason,
  pickPrimaryVisionReason,
  buildVisionPhotoNotice,
} = require('./visionPolicy');
const {
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
  observeUpstreamLatency,
  recordVisionDecision,
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
  recordSkinmaskEnabled,
  recordSkinmaskFallback,
  observeSkinmaskInferLatency,
  recordGeometrySanitizerDropReason,
  renderVisionMetricsPrometheus,
} = require('./visionMetrics');
const { buildPhotoModulesCard } = require('./photoModulesV1');
const { inferSkinMaskOnFaceCrop } = require('./skinmaskOnnx');
const { runGeminiShadowVerify } = require('./diagVerify');
const { getDiagRolloutDecision } = require('./diagRollout');
const { assignExperiments } = require('./experiments');
const { sampleHardCase, deleteHardCasesForIdentity } = require('./hardCaseSampler');
const {
  V1ChatRequestSchema,
  UserProfilePatchSchema,
  TrackerLogSchema,
  RoutineSimulateRequestSchema,
  OffersResolveRequestSchema,
  AffiliateOutcomeRequestSchema,
  ProductParseRequestSchema,
  ProductAnalyzeRequestSchema,
  DupeCompareRequestSchema,
  DupeSuggestRequestSchema,
  RecoGenerateRequestSchema,
  PhotosPresignRequestSchema,
  PhotosConfirmRequestSchema,
  SkinAnalysisRequestSchema,
  AuthStartRequestSchema,
  AuthVerifyRequestSchema,
  AuthPasswordSetRequestSchema,
  AuthPasswordLoginRequestSchema,
} = require('./schemas');
const {
  getProfileForIdentity,
  upsertProfileForIdentity,
  upsertSkinLogForIdentity,
  getRecentSkinLogsForIdentity,
  saveLastAnalysisForIdentity,
  deleteIdentityData,
  isCheckinDue,
  upsertIdentityLink,
  migrateGuestDataToUser,
} = require('./memoryStore');
const {
  createOtpChallenge,
  verifyOtpChallenge,
  createSession,
  resolveSessionFromToken,
  revokeSessionToken,
  getBearerToken,
  setUserPassword,
  verifyPasswordForEmail,
} = require('./authStore');
const {
  profileCompleteness,
  looksLikeDiagnosisStart,
  looksLikeRecommendationRequest,
  looksLikeSuitabilityRequest,
  recommendationsAllowed,
  stateChangeAllowed,
  shouldDiagnosisGate,
  buildDiagnosisPrompt,
  buildDiagnosisChips,
  stripRecommendationCards,
} = require('./gating');
const {
  DEFAULT_AGENT_STATE,
  normalizeAgentState,
  validateRequestedTransition,
  inferTextExplicitTransition,
  deriveRequestedTransitionFromAction,
} = require('./agentStateMachine');
const {
  normalizeProductParse,
  normalizeProductAnalysis,
  enrichProductAnalysisPayload,
  normalizeDupeCompare,
  normalizeRecoGenerate,
} = require('./normalize');
const { simulateConflicts } = require('./routineRules');
const { buildConflictHeatmapV1 } = require('./conflictHeatmapV1');
const { auroraChat, buildContextPrefix } = require('./auroraDecisionClient');
const { extractJsonObject, extractJsonObjectByKeys, parseJsonOnlyObject } = require('./jsonExtract');
const { normalizeKey: normalizeDupeKbKey, getDupeKbEntry, upsertDupeKbEntry } = require('./dupeKbStore');
const { parseMultipart, rmrf } = require('../lookReplicator/multipart');
const {
  _internals: productGroundingResolverInternals = {},
} = require('../services/productGroundingResolver');
const {
  normalizeBudgetHint,
  mapConcerns,
  mapBarrierStatus,
  mapAuroraProductParse,
  mapAuroraProductAnalysis,
  mapAuroraAlternativesToDupeCompare,
  mapAuroraAlternativesToRecoAlternatives,
  mapAuroraRoutineToRecoGenerate,
} = require('./auroraStructuredMapper');

const resolveKnownStableProductRef =
  typeof productGroundingResolverInternals.resolveKnownStableProductRef === 'function'
    ? productGroundingResolverInternals.resolveKnownStableProductRef
    : null;
const normalizeTextForStableResolver =
  typeof productGroundingResolverInternals.normalizeTextForResolver === 'function'
    ? productGroundingResolverInternals.normalizeTextForResolver
    : (value) => String(value || '').trim().toLowerCase();
const tokenizeStableResolverQuery =
  typeof productGroundingResolverInternals.tokenizeNormalizedResolverQuery === 'function'
    ? productGroundingResolverInternals.tokenizeNormalizedResolverQuery
    : (value) =>
        String(value || '')
          .trim()
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean);

const AURORA_DECISION_BASE_URL = String(process.env.AURORA_DECISION_BASE_URL || '').replace(/\/$/, '');
const PIVOTA_BACKEND_BASE_URL = String(process.env.PIVOTA_BACKEND_BASE_URL || process.env.PIVOTA_API_BASE || '')
  .replace(/\/$/, '');
const INCLUDE_RAW_AURORA_CONTEXT = String(process.env.AURORA_BFF_INCLUDE_RAW_CONTEXT || '').toLowerCase() === 'true';
const USE_AURORA_BFF_MOCK = String(process.env.AURORA_BFF_USE_MOCK || '').toLowerCase() === 'true';
const CONFLICT_HEATMAP_V1_ENABLED = String(process.env.AURORA_BFF_CONFLICT_HEATMAP_V1_ENABLED || '').toLowerCase() === 'true';
const AURORA_CHAT_CATALOG_AVAIL_FAST_PATH_ENABLED = (() => {
  const raw = String(process.env.AURORA_CHAT_CATALOG_AVAIL_FAST_PATH || 'true')
    .trim()
    .toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'y' || raw === 'on';
})();
const AURORA_CHAT_CLARIFICATION_FILTER_KNOWN_ENABLED = (() => {
  const raw = String(process.env.AURORA_CHAT_CLARIFICATION_FILTER_KNOWN || 'true')
    .trim()
    .toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'y' || raw === 'on';
})();
const AURORA_CHAT_CLARIFICATION_FLOW_V2_ENABLED = (() => {
  const raw = String(process.env.AURORA_CHAT_CLARIFICATION_FLOW_V2 || 'false')
    .trim()
    .toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'y' || raw === 'on';
})();
const AURORA_CHAT_CLARIFICATION_HISTORY_CONTEXT_ENABLED = (() => {
  const raw = String(process.env.AURORA_CHAT_CLARIFICATION_HISTORY_CONTEXT || 'true')
    .trim()
    .toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'y' || raw === 'on';
})();
const AURORA_CHAT_RESUME_PREFIX_V1_ENABLED = (() => {
  const raw = String(process.env.AURORA_CHAT_RESUME_PREFIX_V1 || 'true')
    .trim()
    .toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'y' || raw === 'on';
})();
const AURORA_CHAT_RESUME_PREFIX_V2_ENABLED = (() => {
  const raw = String(process.env.AURORA_CHAT_RESUME_PREFIX_V2 || 'false')
    .trim()
    .toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'y' || raw === 'on';
})();
const AURORA_CHAT_RESUME_PROBE_METRICS_ENABLED = (() => {
  const raw = String(process.env.AURORA_CHAT_RESUME_PROBE_METRICS || 'true')
    .trim()
    .toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'y' || raw === 'on';
})();
const PENDING_CLARIFICATION_TTL_MS = 10 * 60 * 1000;
const RECO_CATALOG_GROUNDED_ENABLED = String(process.env.AURORA_BFF_RECO_CATALOG_GROUNDED || '').toLowerCase() === 'true';
const RECO_CATALOG_GROUNDED_QUERIES = String(process.env.AURORA_BFF_RECO_CATALOG_QUERIES || '').trim();
const RECO_CATALOG_SEARCH_TIMEOUT_MS = (() => {
  const n = Number(process.env.AURORA_BFF_RECO_CATALOG_SEARCH_TIMEOUT_MS || 1200);
  const v = Number.isFinite(n) ? Math.trunc(n) : 1200;
  return Math.max(400, Math.min(12000, v));
})();
const RECO_CATALOG_SEARCH_CONCURRENCY = (() => {
  const n = Number(process.env.AURORA_BFF_RECO_CATALOG_SEARCH_CONCURRENCY || 3);
  const v = Number.isFinite(n) ? Math.trunc(n) : 3;
  return Math.max(1, Math.min(4, v));
})();
const RECO_CATALOG_FAIL_FAST_ENABLED = (() => {
  const raw = String(process.env.AURORA_BFF_RECO_CATALOG_FAIL_FAST || 'true')
    .trim()
    .toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'y' || raw === 'on';
})();
const RECO_CATALOG_FAIL_FAST_THRESHOLD = (() => {
  const n = Number(process.env.AURORA_BFF_RECO_CATALOG_FAIL_FAST_THRESHOLD || 1);
  const v = Number.isFinite(n) ? Math.trunc(n) : 1;
  return Math.max(1, Math.min(8, v));
})();
const RECO_CATALOG_FAIL_FAST_COOLDOWN_MS = (() => {
  const n = Number(process.env.AURORA_BFF_RECO_CATALOG_FAIL_FAST_COOLDOWN_MS || 90000);
  const v = Number.isFinite(n) ? Math.trunc(n) : 90000;
  return Math.max(3000, Math.min(300000, v));
})();
const RECO_CATALOG_FAIL_FAST_PROBE_INTERVAL_MS = (() => {
  const n = Number(process.env.AURORA_BFF_RECO_CATALOG_FAIL_FAST_PROBE_INTERVAL_MS || 8000);
  const v = Number.isFinite(n) ? Math.trunc(n) : 8000;
  return Math.max(500, Math.min(60000, v));
})();
const RECO_CATALOG_FAIL_FAST_PROBE_SEARCH_TIMEOUT_MS = (() => {
  const n = Number(process.env.AURORA_BFF_RECO_CATALOG_FAIL_FAST_PROBE_SEARCH_TIMEOUT_MS || 1200);
  const v = Number.isFinite(n) ? Math.trunc(n) : 1200;
  return Math.max(300, Math.min(6000, v));
})();
const CATALOG_AVAIL_RESOLVE_FALLBACK_ENABLED = (() => {
  const raw = String(process.env.AURORA_CHAT_CATALOG_AVAIL_RESOLVE_FALLBACK || 'true')
    .trim()
    .toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'y' || raw === 'on';
})();
const CATALOG_AVAIL_RESOLVE_TIMEOUT_MS = (() => {
  const n = Number(process.env.AURORA_CHAT_CATALOG_AVAIL_RESOLVE_TIMEOUT_MS || 1400);
  const v = Number.isFinite(n) ? Math.trunc(n) : 1400;
  return Math.max(300, Math.min(6000, v));
})();
const CATALOG_AVAIL_SEARCH_TIMEOUT_MS = (() => {
  const n = Number(process.env.AURORA_CHAT_CATALOG_AVAIL_SEARCH_TIMEOUT_MS || 1200);
  const v = Number.isFinite(n) ? Math.trunc(n) : 1200;
  return Math.max(300, Math.min(6000, v));
})();
const PIVOTA_BACKEND_AGENT_API_KEY = String(
  process.env.PIVOTA_BACKEND_AGENT_API_KEY ||
    process.env.PIVOTA_BACKEND_API_KEY ||
    process.env.PIVOTA_API_KEY ||
    process.env.SHOP_GATEWAY_AGENT_API_KEY ||
    process.env.PIVOTA_AGENT_API_KEY ||
    process.env.AGENT_API_KEY ||
    '',
).trim();
const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || '').trim();
const GEMINI_API_KEY = String(
  process.env.AURORA_SKIN_GEMINI_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
).trim();
const OPENAI_BASE_URL = String(process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE || '').trim();
const SKIN_VISION_ENABLED = String(process.env.AURORA_SKIN_VISION_ENABLED || '').toLowerCase() === 'true';
const SKIN_VISION_PROVIDER = (() => {
  const raw = String(process.env.AURORA_SKIN_VISION_PROVIDER || 'openai')
    .trim()
    .toLowerCase();
  if (raw === 'gemini' || raw === 'auto') return raw;
  return 'openai';
})();
const SKIN_VISION_MODEL_OPENAI =
  String(process.env.AURORA_SKIN_VISION_MODEL_OPENAI || process.env.AURORA_SKIN_VISION_MODEL || 'gpt-4o-mini').trim() ||
  'gpt-4o-mini';
const SKIN_VISION_MODEL_GEMINI =
  String(process.env.AURORA_SKIN_VISION_MODEL_GEMINI || process.env.GEMINI_MODEL || 'gemini-2.0-flash').trim() ||
  'gemini-2.0-flash';
const SKIN_DEGRADED_MODE = (() => {
  const raw = String(process.env.AURORA_SKIN_DEGRADED_MODE || 'report')
    .trim()
    .toLowerCase();
  return raw === 'vision' ? 'vision' : 'report';
})();
const SKIN_VISION_TIMEOUT_MS = Math.max(
  2000,
  Math.min(30000, Number(process.env.AURORA_SKIN_VISION_TIMEOUT_MS || 12000)),
);
const SKIN_VISION_RETRY_MAX = Math.max(
  0,
  Math.min(2, Number(process.env.AURORA_SKIN_VISION_RETRY_MAX || 2)),
);
const SKIN_VISION_RETRY_BASE_MS = Math.max(
  50,
  Math.min(2000, Number(process.env.AURORA_SKIN_VISION_RETRY_BASE_MS || 250)),
);
const SKIN_VISION_FORCE_CALL = String(process.env.AURORA_SKIN_FORCE_VISION_CALL || '').toLowerCase() === 'true';
const PHOTO_UPLOAD_PROXY_MAX_BYTES = Math.max(
  1024 * 1024,
  Math.min(25 * 1024 * 1024, Number(process.env.AURORA_PHOTO_UPLOAD_MAX_BYTES || 10 * 1024 * 1024)),
);
const PHOTO_UPLOAD_PARSE_TIMEOUT_MS = Math.max(
  1000,
  Math.min(120000, Number(process.env.AURORA_PHOTO_UPLOAD_PARSE_TIMEOUT_MS || 30000)),
);
const PHOTO_DOWNLOAD_URL_TIMEOUT_MS = Math.max(
  1000,
  Math.min(20000, Number(process.env.AURORA_PHOTO_DOWNLOAD_URL_TIMEOUT_MS || 5000)),
);
const PHOTO_FETCH_TIMEOUT_MS = Math.max(
  1000,
  Math.min(20000, Number(process.env.AURORA_PHOTO_FETCH_TIMEOUT_MS || 3000)),
);
const PHOTO_FETCH_TOTAL_TIMEOUT_MS = Math.max(
  2000,
  Math.min(30000, Number(process.env.AURORA_PHOTO_FETCH_TOTAL_TIMEOUT_MS || 5000)),
);
const PHOTO_FETCH_RETRIES = Math.max(0, Math.min(5, Number(process.env.AURORA_PHOTO_FETCH_RETRIES || 2)));
const PHOTO_FETCH_RETRY_BASE_MS = Math.max(
  100,
  Math.min(2000, Number(process.env.AURORA_PHOTO_FETCH_RETRY_BASE_MS || 250)),
);
const PHOTO_BYTES_CACHE_MAX_ITEMS = Math.max(
  0,
  Math.min(500, Number(process.env.AURORA_PHOTO_CACHE_MAX_ITEMS || 40)),
);
const PHOTO_BYTES_CACHE_TTL_MS = Math.max(
  10 * 1000,
  Math.min(30 * 60 * 1000, Number(process.env.AURORA_PHOTO_CACHE_TTL_MS || 10 * 60 * 1000)),
);
const PHOTO_AUTO_ANALYZE_AFTER_CONFIRM = String(process.env.AURORA_PHOTO_AUTO_ANALYZE_AFTER_CONFIRM || 'true').toLowerCase() !== 'false';
const DIAG_PHOTO_MODULES_CARD = String(process.env.DIAG_PHOTO_MODULES_CARD || '').toLowerCase() === 'true';
const DIAG_VERIFY_ALLOW_GUARD_TEST = String(process.env.ALLOW_GUARD_TEST || '').toLowerCase() === 'true';
const DIAG_OVERLAY_MODE = (() => {
  const raw = String(process.env.DIAG_OVERLAY_MODE || 'client')
    .trim()
    .toLowerCase();
  return raw === 'client' ? 'client' : 'client';
})();
const DIAG_INGREDIENT_REC = String(process.env.DIAG_INGREDIENT_REC || 'true').toLowerCase() !== 'false';
const DIAG_PRODUCT_REC = String(process.env.DIAG_PRODUCT_REC || '').toLowerCase() === 'true';
const DIAG_SKINMASK_ENABLED = String(process.env.DIAG_SKINMASK_ENABLED || '').toLowerCase() === 'true';
const DIAG_SKINMASK_MODEL_PATH = String(process.env.DIAG_SKINMASK_MODEL_PATH || 'artifacts/skinmask_v2.onnx').trim();
const DIAG_SKINMASK_TIMEOUT_MS = (() => {
  const n = Number(process.env.DIAG_SKINMASK_TIMEOUT_MS || 1200);
  const v = Number.isFinite(n) ? Math.trunc(n) : 1200;
  return Math.max(100, Math.min(15000, v));
})();
const DIAG_PRODUCT_REC_MIN_CITATIONS = Math.max(
  0,
  Math.min(5, Math.trunc(Number(process.env.DIAG_PRODUCT_REC_MIN_CITATIONS || 1) || 1)),
);
const DIAG_PRODUCT_REC_MIN_EVIDENCE_GRADE = (() => {
  const token = String(process.env.DIAG_PRODUCT_REC_MIN_EVIDENCE_GRADE || 'B')
    .trim()
    .toUpperCase();
  if (token === 'A' || token === 'B' || token === 'C') return token;
  return 'B';
})();
const DIAG_PRODUCT_REC_REPAIR_ONLY_WHEN_DEGRADED =
  String(process.env.DIAG_PRODUCT_REC_REPAIR_ONLY_WHEN_DEGRADED || '').toLowerCase() === 'true';
const INTERNAL_TEST_MODE = String(process.env.INTERNAL_TEST_MODE || '').toLowerCase() === 'true';
const DIAG_INGREDIENT_KB_V2_PATH = String(process.env.INGREDIENT_KB_V2_PATH || '').trim() || null;
const DIAG_PRODUCT_CATALOG_PATH = String(process.env.AURORA_PRODUCT_REC_CATALOG_PATH || '').trim() || null;

const RECO_ALTERNATIVES_TIMEOUT_MS = (() => {
  const n = Number(process.env.AURORA_BFF_RECO_ALTERNATIVES_TIMEOUT_MS || 9000);
  const v = Number.isFinite(n) ? Math.trunc(n) : 9000;
  return Math.max(2000, Math.min(20000, v));
})();

const RECO_ALTERNATIVES_MAX_PRODUCTS = (() => {
  const n = Number(process.env.AURORA_BFF_RECO_ALTERNATIVES_MAX_PRODUCTS || 5);
  const v = Number.isFinite(n) ? Math.trunc(n) : 5;
  return Math.max(0, Math.min(6, v));
})();

const RECO_ALTERNATIVES_CONCURRENCY = (() => {
  const n = Number(process.env.AURORA_BFF_RECO_ALTERNATIVES_CONCURRENCY || 2);
  const v = Number.isFinite(n) ? Math.trunc(n) : 2;
  return Math.max(1, Math.min(4, v));
})();

const RECO_UPSTREAM_TIMEOUT_HARD_CAP_MS = (() => {
  const n = Number(process.env.AURORA_BFF_RECO_UPSTREAM_TIMEOUT_HARD_CAP_MS || 4500);
  const v = Number.isFinite(n) ? Math.trunc(n) : 4500;
  return Math.max(2000, Math.min(22000, v));
})();

const RECO_UPSTREAM_TIMEOUT_MS = (() => {
  const n = Number(process.env.AURORA_BFF_RECO_UPSTREAM_TIMEOUT_MS || 3500);
  const v = Number.isFinite(n) ? Math.trunc(n) : 3500;
  const bounded = Math.max(3000, Math.min(22000, v));
  return Math.min(bounded, RECO_UPSTREAM_TIMEOUT_HARD_CAP_MS);
})();

const RECO_ROUTINE_UPSTREAM_TIMEOUT_MS = (() => {
  const n = Number(process.env.AURORA_BFF_RECO_ROUTINE_TIMEOUT_MS || 14000);
  const v = Number.isFinite(n) ? Math.trunc(n) : 14000;
  return Math.max(3000, Math.min(22000, v));
})();

const RECO_PDP_RESOLVE_ENABLED = (() => {
  const raw = String(process.env.AURORA_BFF_RECO_PDP_RESOLVE_ENABLED || 'true')
    .trim()
    .toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'y' || raw === 'on';
})();

const RECO_PDP_RESOLVE_TIMEOUT_MS = (() => {
  const n = Number(process.env.AURORA_BFF_RECO_PDP_RESOLVE_TIMEOUT_MS || 900);
  const v = Number.isFinite(n) ? Math.trunc(n) : 900;
  return Math.max(300, Math.min(6000, v));
})();

const RECO_PDP_OFFERS_RESOLVE_TIMEOUT_MS = (() => {
  const n = Number(process.env.AURORA_BFF_RECO_PDP_OFFERS_RESOLVE_TIMEOUT_MS || 2200);
  const v = Number.isFinite(n) ? Math.trunc(n) : 2200;
  return Math.max(300, Math.min(6000, v));
})();

const RECO_PDP_LOCAL_INVOKE_FALLBACK_ENABLED = (() => {
  const fallbackDefault = 'false';
  const raw = String(process.env.AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ENABLED || fallbackDefault)
    .trim()
    .toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'y' || raw === 'on';
})();

const RECO_PDP_LOCAL_INVOKE_FALLBACK_CHAT_ENABLED = (() => {
  const raw = String(process.env.AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_CHAT || 'false')
    .trim()
    .toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'y' || raw === 'on';
})();
const RECO_PDP_LOCAL_INVOKE_FALLBACK_ON_NO_CANDIDATES = (() => {
  const raw = String(process.env.AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ON_NO_CANDIDATES || 'false')
    .trim()
    .toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'y' || raw === 'on';
})();

const RECO_PDP_LOCAL_INVOKE_FALLBACK_ON_UPSTREAM_TIMEOUT = (() => {
  const raw = String(process.env.AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ON_UPSTREAM_TIMEOUT || 'false')
    .trim()
    .toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'y' || raw === 'on';
})();

const RECO_PDP_SKIP_QUERY_RESOLVE_ON_STABLE_FAILURE = (() => {
  const raw = String(process.env.AURORA_BFF_RECO_PDP_SKIP_QUERY_RESOLVE_ON_STABLE_FAILURE || 'true')
    .trim()
    .toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'y' || raw === 'on';
})();

const RECO_PDP_SKIP_OPAQUE_STABLE_IDS = (() => {
  const raw = String(process.env.AURORA_BFF_RECO_PDP_SKIP_OPAQUE_STABLE_IDS || 'true')
    .trim()
    .toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'y' || raw === 'on';
})();
const RECO_PDP_LOCAL_INVOKE_BASE_URL = (() => {
  const explicit = String(process.env.AURORA_BFF_RECO_PDP_LOCAL_INVOKE_BASE_URL || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const rawPort = String(process.env.PORT || '3000').trim();
  const normalizedPort = /^\d+$/.test(rawPort) ? rawPort : '3000';
  return `http://127.0.0.1:${normalizedPort}`;
})();

const RECO_PDP_LOCAL_INVOKE_TIMEOUT_MS = (() => {
  const n = Number(process.env.AURORA_BFF_RECO_PDP_LOCAL_INVOKE_TIMEOUT_MS || 500);
  const v = Number.isFinite(n) ? Math.trunc(n) : 500;
  return Math.max(250, Math.min(4000, v));
})();

const RECO_PDP_LOCAL_SEARCH_FALLBACK_ON_TRANSIENT = (() => {
  const raw = String(process.env.AURORA_BFF_RECO_PDP_LOCAL_SEARCH_FALLBACK_ON_TRANSIENT || 'false')
    .trim()
    .toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'y' || raw === 'on';
})();

const RECO_PDP_ENRICH_CONCURRENCY = (() => {
  const n = Number(process.env.AURORA_BFF_RECO_PDP_ENRICH_CONCURRENCY || 6);
  const v = Number.isFinite(n) ? Math.trunc(n) : 6;
  return Math.max(1, Math.min(12, v));
})();

const RECO_PDP_ENRICH_MAX_NETWORK_ITEMS = (() => {
  const n = Number(process.env.AURORA_BFF_RECO_PDP_ENRICH_MAX_NETWORK_ITEMS || 3);
  const v = Number.isFinite(n) ? Math.trunc(n) : 3;
  return Math.max(0, Math.min(8, v));
})();

const RECO_PDP_CHAT_DISABLE_LOCAL_DOUBLE_HOP = (() => {
  const raw = String(process.env.AURORA_BFF_RECO_PDP_CHAT_DISABLE_LOCAL_DOUBLE_HOP || 'true')
    .trim()
    .toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'y' || raw === 'on';
})();

const RECO_CATALOG_TRANSIENT_FALLBACK_ENABLED = (() => {
  const raw = String(process.env.AURORA_BFF_RECO_CATALOG_TRANSIENT_FALLBACK || 'true')
    .trim()
    .toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'y' || raw === 'on';
})();

const RECO_CATALOG_TRANSIENT_FALLBACK_MAX_ITEMS = (() => {
  const n = Number(process.env.AURORA_BFF_RECO_CATALOG_TRANSIENT_FALLBACK_MAX_ITEMS || 3);
  const v = Number.isFinite(n) ? Math.trunc(n) : 3;
  return Math.max(1, Math.min(6, v));
})();

const DUPE_DEEPSCAN_CACHE_MAX = (() => {
  const n = Number(process.env.AURORA_BFF_DUPE_DEEPSCAN_CACHE_MAX || 80);
  const v = Number.isFinite(n) ? Math.trunc(n) : 80;
  return Math.max(0, Math.min(300, v));
})();

const DUPE_DEEPSCAN_CACHE_TTL_MS = (() => {
  const n = Number(process.env.AURORA_BFF_DUPE_DEEPSCAN_CACHE_TTL_MS || 6 * 60 * 60 * 1000);
  const v = Number.isFinite(n) ? Math.trunc(n) : 6 * 60 * 60 * 1000;
  return Math.max(30 * 1000, Math.min(24 * 60 * 60 * 1000, v));
})();

const dupeDeepscanCache = new Map();
const photoBytesCache = new Map();

function getDupeDeepscanCache(key) {
  if (!key || DUPE_DEEPSCAN_CACHE_MAX <= 0) return null;
  const entry = dupeDeepscanCache.get(key);
  if (!entry) return null;
  if (!entry.expiresAt || entry.expiresAt <= Date.now()) {
    dupeDeepscanCache.delete(key);
    return null;
  }
  // Touch for LRU-ish behavior.
  dupeDeepscanCache.delete(key);
  dupeDeepscanCache.set(key, entry);
  return entry.value || null;
}

function setDupeDeepscanCache(key, value) {
  if (!key || DUPE_DEEPSCAN_CACHE_MAX <= 0) return;
  dupeDeepscanCache.set(key, { value, expiresAt: Date.now() + DUPE_DEEPSCAN_CACHE_TTL_MS });
  while (dupeDeepscanCache.size > DUPE_DEEPSCAN_CACHE_MAX) {
    const oldestKey = dupeDeepscanCache.keys().next().value;
    if (!oldestKey) break;
    dupeDeepscanCache.delete(oldestKey);
  }
}

function getAuroraUidFromReq(req) {
  if (!req || typeof req.get !== 'function') return '';
  return String(req.get('X-Aurora-UID') || req.get('x-aurora-uid') || '').trim();
}

function makePhotoCacheKey({ photoId, auroraUid } = {}) {
  const pid = String(photoId || '').trim();
  const uid = String(auroraUid || '').trim();
  if (!pid || !uid) return '';
  return `${uid}:${pid}`;
}

function setPhotoBytesCache({ photoId, auroraUid, buffer, contentType } = {}) {
  if (PHOTO_BYTES_CACHE_MAX_ITEMS <= 0) return;
  const key = makePhotoCacheKey({ photoId, auroraUid });
  if (!key || !buffer || !Buffer.isBuffer(buffer) || !buffer.length) return;
  photoBytesCache.set(key, {
    buffer,
    contentType: String(contentType || 'image/jpeg').trim() || 'image/jpeg',
    expiresAt: Date.now() + PHOTO_BYTES_CACHE_TTL_MS,
  });
  while (photoBytesCache.size > PHOTO_BYTES_CACHE_MAX_ITEMS) {
    const oldestKey = photoBytesCache.keys().next().value;
    if (!oldestKey) break;
    photoBytesCache.delete(oldestKey);
  }
}

function getPhotoBytesCache({ photoId, auroraUid } = {}) {
  const key = makePhotoCacheKey({ photoId, auroraUid });
  if (!key) return null;
  const entry = photoBytesCache.get(key);
  if (!entry) return null;
  if (!entry.expiresAt || entry.expiresAt <= Date.now()) {
    photoBytesCache.delete(key);
    return null;
  }
  photoBytesCache.delete(key);
  photoBytesCache.set(key, entry);
  return entry;
}

function getCheckoutToken(req) {
  const v = req.get('X-Checkout-Token') || req.get('x-checkout-token');
  return v ? String(v).trim() : '';
}

function buildPivotaBackendAuthHeaders(req) {
  const checkoutToken = getCheckoutToken(req);
  if (checkoutToken) return { 'X-Checkout-Token': checkoutToken };
  if (PIVOTA_BACKEND_AGENT_API_KEY) {
    return { 'X-API-Key': PIVOTA_BACKEND_AGENT_API_KEY, Authorization: `Bearer ${PIVOTA_BACKEND_AGENT_API_KEY}` };
  }
  return {};
}

function buildPivotaBackendAgentHeaders() {
  if (PIVOTA_BACKEND_AGENT_API_KEY) {
    return { 'X-API-Key': PIVOTA_BACKEND_AGENT_API_KEY, Authorization: `Bearer ${PIVOTA_BACKEND_AGENT_API_KEY}` };
  }
  return {};
}

function extractAgentProductsFromSearchResponse(raw) {
  if (!raw) return [];
  const obj = raw && typeof raw === 'object' ? raw : null;
  if (!obj) return [];
  if (Array.isArray(obj)) return obj;
  if (Array.isArray(obj.products)) return obj.products;
  if (Array.isArray(obj.items)) return obj.items;
  if (Array.isArray(obj.results)) return obj.results;
  const data = obj.data;
  if (data && typeof data === 'object') {
    if (Array.isArray(data.products)) return data.products;
    if (Array.isArray(data.items)) return data.items;
    if (Array.isArray(data.results)) return data.results;
  }
  return [];
}

function normalizeRecoCatalogProduct(raw) {
  const base = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  const productId =
    (typeof base.product_id === 'string' && base.product_id) ||
    (typeof base.productId === 'string' && base.productId) ||
    (typeof base.id === 'string' && base.id) ||
    '';

  const merchantId =
    (typeof base.merchant_id === 'string' && base.merchant_id) ||
    (typeof base.merchantId === 'string' && base.merchantId) ||
    (base.merchant && typeof base.merchant === 'object' && !Array.isArray(base.merchant) && typeof base.merchant.merchant_id === 'string'
      ? base.merchant.merchant_id
      : '') ||
    '';

  const brand =
    (typeof base.brand === 'string' && base.brand) ||
    (typeof base.brand_name === 'string' && base.brand_name) ||
    (typeof base.brandName === 'string' && base.brandName) ||
    '';

  const name =
    (typeof base.name === 'string' && base.name) ||
    (typeof base.title === 'string' && base.title) ||
    '';

  const displayName =
    (typeof base.display_name === 'string' && base.display_name) ||
    (typeof base.displayName === 'string' && base.displayName) ||
    name ||
    '';

  const skuId =
    (typeof base.sku_id === 'string' && base.sku_id) ||
    (typeof base.skuId === 'string' && base.skuId) ||
    '';

  const productGroupId =
    (typeof base.product_group_id === 'string' && base.product_group_id) ||
    (typeof base.productGroupId === 'string' && base.productGroupId) ||
    (base.subject &&
    typeof base.subject === 'object' &&
    !Array.isArray(base.subject) &&
    typeof base.subject.product_group_id === 'string'
      ? base.subject.product_group_id
      : '') ||
    '';

  const imageUrl =
    (typeof base.image_url === 'string' && base.image_url) ||
    (typeof base.imageUrl === 'string' && base.imageUrl) ||
    (typeof base.thumbnail_url === 'string' && base.thumbnail_url) ||
    (typeof base.thumbnailUrl === 'string' && base.thumbnailUrl) ||
    '';

  const out = {
    product_id: String(productId || '').trim(),
    merchant_id: String(merchantId || '').trim() || null,
    ...(String(productGroupId || '').trim() ? { product_group_id: String(productGroupId).trim() } : {}),
    ...(String(skuId || '').trim() ? { sku_id: String(skuId).trim() } : {}),
    ...(String(brand || '').trim() ? { brand: String(brand).trim() } : {}),
    ...(String(name || '').trim() ? { name: String(name).trim() } : {}),
    ...(String(displayName || '').trim() ? { display_name: String(displayName).trim() } : {}),
    ...(String(imageUrl || '').trim() ? { image_url: String(imageUrl).trim() } : {}),
  };

  const canonicalProductRef = normalizeCanonicalProductRef(
    {
      product_id: out.product_id,
      merchant_id: out.merchant_id,
    },
    { requireMerchant: true, allowOpaqueProductId: false },
  );
  if (canonicalProductRef) out.canonical_product_ref = canonicalProductRef;

  return out.product_id ? out : null;
}

const recoCatalogFailFastState = {
  consecutive_failures: 0,
  open_until_ms: 0,
  last_reason: null,
  last_failed_at: 0,
  last_probe_started_at: 0,
};

function getRecoCatalogFailFastSnapshot(nowMs = Date.now()) {
  const openUntilMs = Number(recoCatalogFailFastState.open_until_ms || 0);
  const open = RECO_CATALOG_FAIL_FAST_ENABLED && nowMs < openUntilMs;
  const lastProbeStartedAt = Number(recoCatalogFailFastState.last_probe_started_at || 0);
  const probeElapsedMs = Math.max(0, nowMs - lastProbeStartedAt);
  const nextProbeInMs = open ? Math.max(0, RECO_CATALOG_FAIL_FAST_PROBE_INTERVAL_MS - probeElapsedMs) : 0;
  const canProbeWhileOpen = open && nextProbeInMs <= 0;
  return {
    enabled: RECO_CATALOG_FAIL_FAST_ENABLED,
    open,
    open_until_ms: open ? openUntilMs : 0,
    consecutive_failures: Number(recoCatalogFailFastState.consecutive_failures || 0),
    last_reason: recoCatalogFailFastState.last_reason || null,
    cooldown_ms: RECO_CATALOG_FAIL_FAST_COOLDOWN_MS,
    threshold: RECO_CATALOG_FAIL_FAST_THRESHOLD,
    probe_interval_ms: RECO_CATALOG_FAIL_FAST_PROBE_INTERVAL_MS,
    last_probe_started_at: lastProbeStartedAt || 0,
    can_probe_while_open: canProbeWhileOpen,
    next_probe_in_ms: nextProbeInMs,
  };
}

function markRecoCatalogFailFastSuccess() {
  recoCatalogFailFastState.consecutive_failures = 0;
  recoCatalogFailFastState.open_until_ms = 0;
  recoCatalogFailFastState.last_reason = null;
  recoCatalogFailFastState.last_failed_at = 0;
  recoCatalogFailFastState.last_probe_started_at = 0;
}

function markRecoCatalogFailFastFailure(reason, nowMs = Date.now()) {
  if (!RECO_CATALOG_FAIL_FAST_ENABLED) return;
  recoCatalogFailFastState.consecutive_failures = Number(recoCatalogFailFastState.consecutive_failures || 0) + 1;
  recoCatalogFailFastState.last_reason = reason || 'unknown';
  recoCatalogFailFastState.last_failed_at = nowMs;
  if (recoCatalogFailFastState.consecutive_failures >= RECO_CATALOG_FAIL_FAST_THRESHOLD) {
    recoCatalogFailFastState.open_until_ms = nowMs + RECO_CATALOG_FAIL_FAST_COOLDOWN_MS;
    recoCatalogFailFastState.last_probe_started_at = nowMs;
  }
}

function beginRecoCatalogFailFastProbe(nowMs = Date.now()) {
  if (!RECO_CATALOG_FAIL_FAST_ENABLED) return false;
  const snapshot = getRecoCatalogFailFastSnapshot(nowMs);
  if (!snapshot.open || !snapshot.can_probe_while_open) return false;
  recoCatalogFailFastState.last_probe_started_at = nowMs;
  return true;
}

async function searchPivotaBackendProducts({ query, limit = 6, logger, timeoutMs = RECO_CATALOG_SEARCH_TIMEOUT_MS } = {}) {
  const startedAt = Date.now();
  const q = String(query || '').trim();
  if (!q) return { ok: false, products: [], reason: 'query_missing', latency_ms: 0 };
  if (!PIVOTA_BACKEND_BASE_URL) return { ok: false, products: [], reason: 'pivota_backend_not_configured', latency_ms: 0 };
  const normalizedLimit = Math.max(1, Math.min(12, Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : 6));
  const normalizedTimeout = Math.max(300, Math.min(12000, Number.isFinite(Number(timeoutMs)) ? Math.trunc(Number(timeoutMs)) : RECO_CATALOG_SEARCH_TIMEOUT_MS));
  const params = {
    query: q,
    search_all_merchants: true,
    in_stock_only: false,
    limit: normalizedLimit,
    offset: 0,
  };
  const primaryUrl = `${PIVOTA_BACKEND_BASE_URL}/agent/v1/products/search`;
  const localSearchUrl = `${String(RECO_PDP_LOCAL_INVOKE_BASE_URL || '').replace(/\/+$/, '')}/agent/v1/products/search`;
  const shouldAttemptLocalSearchFallback =
    RECO_PDP_LOCAL_INVOKE_FALLBACK_CHAT_ENABLED &&
    RECO_PDP_LOCAL_INVOKE_FALLBACK_ENABLED &&
    localSearchUrl &&
    localSearchUrl !== primaryUrl;
  const mapSearchFailureReason = ({ statusCode, errCode, errMessage } = {}) => {
    const code = typeof errCode === 'string' ? errCode.trim().toUpperCase() : '';
    const msg = typeof errMessage === 'string' ? errMessage : '';
    const timeoutHit = code === 'ECONNABORTED' || /timeout/i.test(msg);
    let reason = 'upstream_error';
    if (timeoutHit || statusCode === 504 || statusCode === 408) reason = 'upstream_timeout';
    else if (statusCode === 404) reason = 'not_found';
    else if (statusCode === 429) reason = 'rate_limited';
    return reason;
  };
  const mapProxySearchFallbackReason = (raw) => {
    const token = String(raw || '').trim().toLowerCase();
    if (!token) return null;
    if (
      token === 'upstream_timeout' ||
      token === 'timeout' ||
      token === 'primary_timeout' ||
      token === 'invoke_timeout'
    ) {
      return 'upstream_timeout';
    }
    if (token === 'rate_limited' || token === 'too_many_requests' || token === 'throttled') {
      return 'rate_limited';
    }
    if (
      token === 'upstream_error' ||
      token === 'primary_exception' ||
      token === 'primary_request_failed' ||
      token === 'primary_status_5xx' ||
      token === 'error_soft_fallback' ||
      token === 'db_timeout' ||
      token === 'db_error'
    ) {
      return 'upstream_error';
    }
    if (token === 'not_found' || token === 'no_candidates' || token === 'no_results') {
      return 'not_found';
    }
    return null;
  };
  const inferSearchFailureReasonFromBody = ({ data, statusCode } = {}) => {
    const body = data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    if (!body) return null;
    const metadata =
      body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata) ? body.metadata : null;
    const proxyFallback =
      metadata &&
      metadata.proxy_search_fallback &&
      typeof metadata.proxy_search_fallback === 'object' &&
      !Array.isArray(metadata.proxy_search_fallback)
        ? metadata.proxy_search_fallback
        : null;

    const fallbackReason = mapProxySearchFallbackReason(proxyFallback && proxyFallback.reason);
    if (fallbackReason === 'upstream_timeout' || fallbackReason === 'upstream_error' || fallbackReason === 'rate_limited') {
      return fallbackReason;
    }

    const resolveReason = mapProxySearchFallbackReason(
      body.reason_code ||
      body.reasonCode ||
      metadata?.reason_code ||
      metadata?.reasonCode ||
      metadata?.resolve_reason_code ||
      metadata?.resolveReasonCode,
    );
    if (resolveReason === 'upstream_timeout' || resolveReason === 'upstream_error' || resolveReason === 'rate_limited') {
      return resolveReason;
    }
    if (resolveReason === 'not_found') return 'not_found';

    const upstreamStatus = Number(
      proxyFallback?.upstream_status ??
      proxyFallback?.upstreamStatus ??
      metadata?.upstream_status ??
      metadata?.upstreamStatus ??
      statusCode ??
      0,
    );
    if (Number.isFinite(upstreamStatus)) {
      if (upstreamStatus === 429) return 'rate_limited';
      if (upstreamStatus === 408 || upstreamStatus === 504) return 'upstream_timeout';
      if (upstreamStatus >= 500) return 'upstream_error';
    }

    const upstreamErrorCode = String(
      proxyFallback?.upstream_error_code ||
      proxyFallback?.upstreamErrorCode ||
      metadata?.upstream_error_code ||
      metadata?.upstreamErrorCode ||
      '',
    )
      .trim()
      .toUpperCase();
    if (upstreamErrorCode === 'ECONNABORTED' || upstreamErrorCode === 'ETIMEDOUT') {
      return 'upstream_timeout';
    }

    const upstreamErrorMessage = String(
      proxyFallback?.upstream_error_message ||
      proxyFallback?.upstreamErrorMessage ||
      metadata?.upstream_error_message ||
      metadata?.upstreamErrorMessage ||
      '',
    ).trim();
    if (/timeout/i.test(upstreamErrorMessage)) return 'upstream_timeout';
    return null;
  };
  const normalizeProductsFromSearchData = (data) => {
    const rawList = extractAgentProductsFromSearchResponse(data);
    return rawList.map((p) => normalizeRecoCatalogProduct(p)).filter(Boolean);
  };

  try {
    const resp = await axios.get(primaryUrl, {
      params,
      headers: buildPivotaBackendAgentHeaders(),
      timeout: normalizedTimeout,
    });

    const statusCode = Number.isFinite(Number(resp?.status)) ? Math.trunc(Number(resp.status)) : null;
    const body = resp && resp.data ? resp.data : null;
    const products = normalizeProductsFromSearchData(body);
    const bodyReason = products.length
      ? null
      : inferSearchFailureReasonFromBody({ data: body, statusCode });
    if (bodyReason && bodyReason !== 'not_found') {
      return {
        ok: false,
        products: [],
        reason: bodyReason,
        status_code: statusCode,
        latency_ms: Date.now() - startedAt,
      };
    }

    return {
      ok: true,
      products,
      reason: products.length ? null : bodyReason || 'empty',
      status_code: statusCode,
      latency_ms: Date.now() - startedAt,
    };
  } catch (err) {
    const statusCode = Number.isFinite(Number(err?.response?.status)) ? Math.trunc(Number(err.response.status)) : null;
    const errCode = typeof err?.code === 'string' ? err.code.trim().toUpperCase() : '';
    const errMessage = err && err.message ? err.message : String(err);
    let reason = mapSearchFailureReason({ statusCode, errCode, errMessage });
    const transientFailure = reason === 'upstream_timeout' || reason === 'upstream_error' || reason === 'rate_limited';
    if (transientFailure && shouldAttemptLocalSearchFallback && RECO_PDP_LOCAL_SEARCH_FALLBACK_ON_TRANSIENT) {
      try {
        const localResp = await axios.get(localSearchUrl, {
          params,
          headers: { 'Content-Type': 'application/json' },
          timeout: RECO_PDP_LOCAL_INVOKE_TIMEOUT_MS,
          validateStatus: () => true,
        });
        const localStatusCode = Number.isFinite(Number(localResp?.status)) ? Math.trunc(Number(localResp.status)) : 0;
        if (localStatusCode >= 200 && localStatusCode < 300) {
          const localBody = localResp?.data || null;
          const products = normalizeProductsFromSearchData(localBody);
          const localBodyReason = products.length
            ? null
            : inferSearchFailureReasonFromBody({ data: localBody, statusCode: localStatusCode });
          if (localBodyReason && localBodyReason !== 'not_found') {
            return {
              ok: false,
              products: [],
              reason: localBodyReason,
              status_code: localStatusCode,
              latency_ms: Date.now() - startedAt,
            };
          }
          return {
            ok: true,
            products,
            reason: products.length ? null : localBodyReason || 'empty',
            status_code: localStatusCode,
            latency_ms: Date.now() - startedAt,
          };
        }
        const localReason = mapSearchFailureReason({
          statusCode: localStatusCode,
          errCode: null,
          errMessage: null,
        });
        if (reason === 'upstream_timeout' && localReason && localReason !== 'not_found') {
          reason = localReason;
        }
        logger?.warn(
          {
            query: q.slice(0, 120),
            primary_status_code: statusCode,
            primary_reason: reason,
            local_status_code: localStatusCode,
            local_reason: localReason,
          },
          'aurora bff: reco catalog local search fallback unresolved',
        );
      } catch (localErr) {
        const localStatusCode = Number.isFinite(Number(localErr?.response?.status))
          ? Math.trunc(Number(localErr.response.status))
          : null;
        const localErrCode = typeof localErr?.code === 'string' ? localErr.code.trim().toUpperCase() : '';
        const localErrMessage = localErr && localErr.message ? localErr.message : String(localErr);
        const localReason = mapSearchFailureReason({
          statusCode: localStatusCode,
          errCode: localErrCode,
          errMessage: localErrMessage,
        });
        if (reason === 'upstream_timeout' && localReason && localReason !== 'not_found') {
          reason = localReason;
        }
        logger?.warn(
          {
            query: q.slice(0, 120),
            primary_status_code: statusCode,
            primary_reason: reason,
            local_status_code: localStatusCode,
            local_reason: localReason,
            local_code: localErrCode || null,
            local_err: localErrMessage,
          },
          'aurora bff: reco catalog local search fallback failed',
        );
      }
    }
    logger?.warn(
      { reason, status_code: statusCode, code: errCode || null, err: errMessage },
      'aurora bff: reco catalog search failed',
    );
    return {
      ok: false,
      products: [],
      reason,
      status_code: statusCode,
      error_code: errCode || null,
      latency_ms: Date.now() - startedAt,
    };
  }
}

const CATALOG_BRANDS = {
  brand_winona: {
    brand_id: 'brand_winona',
    aliases: ['薇诺娜', 'winona', 'wei nuo na'],
    name: { CN: '薇诺娜', EN: 'Winona' },
  },
};

function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildLooseAsciiAliasRegex(alias) {
  const tokens = String(alias || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 6);
  if (!tokens.length) return null;
  const sep = '(?:[\\s\\p{P}_-])*';
  const body = tokens.map((t) => escapeRegExp(t)).join(sep);
  return new RegExp(`(?<![a-z0-9])${body}(?![a-z0-9])`, 'iu');
}

function detectBrandAvailabilityIntent(message, lang) {
  const raw = String(message || '').trim();
  if (!raw) return null;

  // Exclude obvious non-commerce asks.
  if (looksLikeDiagnosisStart(raw)) return null;
  if (looksLikeSuitabilityRequest(raw)) return null;
  if (looksLikeRecommendationRequest(raw)) return null;
  if (looksLikeRoutineRequest(raw, null)) return null;
  if (looksLikeCompatibilityOrConflictQuestion(raw)) return null;
  if (looksLikeWeatherOrEnvironmentQuestion(raw)) return null;

  const text = raw.normalize('NFKC');
  const lowered = text.toLowerCase();

  const availabilityHint =
    /(有没有|有无|有吗|有没|有木有|有货|现货|库存|哪里买|怎么买|能买|购买|下单|链接|渠道|旗舰|自营|店|请问|\?)/.test(text) ||
    /\b(in stock|available|availability|where (can i|to) buy|do you have|have any|buy|purchase|link)\b/i.test(lowered);

  for (const brand of Object.values(CATALOG_BRANDS)) {
    const aliases = Array.isArray(brand.aliases) ? brand.aliases : [];
    let matchedAlias = '';
    for (const alias of aliases) {
      const a = String(alias || '').trim();
      if (!a) continue;
      if (/[\u4e00-\u9fff]/.test(a)) {
        if (text.includes(a)) {
          matchedAlias = a;
          break;
        }
        continue;
      }

      const re = buildLooseAsciiAliasRegex(a);
      if (re && re.test(lowered)) {
        matchedAlias = a;
        break;
      }
    }

    if (!matchedAlias) continue;

    const compact = (value) =>
      String(value || '')
        .toLowerCase()
        .replace(/[\s\p{P}_-]+/gu, '');
    const compactAlias = compact(matchedAlias);
    const compactText = compact(text);
    const bareBrandQuery =
      compactText === compactAlias ||
      compactText === `${compactAlias}品牌` ||
      compactText === `${compactAlias}brand` ||
      compactText === `${compactAlias}${compactAlias}`;
    if (!availabilityHint && !bareBrandQuery) continue;

    const brandName = lang === 'CN' ? brand?.name?.CN || '' : brand?.name?.EN || '';
    return {
      intent: 'availability',
      brand_id: brand.brand_id,
      brand_name: brandName || String(matchedAlias || '').trim(),
      matched_alias: matchedAlias,
      reason: availabilityHint ? 'availability_hint' : 'bare_brand_query',
    };
  }

  return null;
}

function buildAvailabilityCatalogQuery(message, availabilityIntent) {
  const raw = String(message || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[。！？!?]+$/g, '');
  const brand = String(
    availabilityIntent?.brand_name || availabilityIntent?.matched_alias || availabilityIntent?.brand_id || '',
  ).trim();
  if (!raw) return brand;

  let cleaned = raw
    .replace(/^(请问|请帮我|请|我想问下|我想问|could you|can you|do you|i want to know)\s*/i, '')
    .replace(/\b(in stock|available|availability|where can i buy|where to buy|do you have|have any|buy|purchase|link|have|has)\b/gi, ' ')
    .replace(/(有没有|有无|有吗|有没|有木有|有货|现货|库存|哪里买|怎么买|购买|下单|链接|渠道|官方旗舰|旗舰店|自营|请问)/g, ' ')
    .replace(/[（(]\s*(品牌|brand|official)\s*[）)]/gi, ' ')
    .replace(/\bbrand\b/gi, ' ')
    .replace(/品牌/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[。！？!?]+$/g, '');

  if (!cleaned) cleaned = raw;
  cleaned = cleaned
    .split(/\s+/)
    .filter((token, idx, arr) => idx === 0 || token.toLowerCase() !== arr[idx - 1].toLowerCase())
    .join(' ')
    .trim();
  cleaned = cleaned.replace(/[吗嘛呢呀]+$/g, '').trim();

  if (brand) {
    const compact = (value) =>
      String(value || '')
        .toLowerCase()
        .replace(/[\s\p{P}_-]+/gu, '');
    const compactBrand = compact(brand);
    const compactCleaned = compact(cleaned);
    if (compactBrand && compactCleaned && compactCleaned === compactBrand.repeat(2)) cleaned = brand;
  }

  if (cleaned.length > 120) cleaned = cleaned.slice(0, 120).trim();

  if (!cleaned) return brand;
  if (brand && cleaned.toLowerCase() === brand.toLowerCase()) return brand;
  return cleaned;
}

function isSpecificAvailabilityQuery(queryText, availabilityIntent) {
  const q = String(queryText || '').trim().toLowerCase();
  if (!q) return false;
  const brand = String(
    availabilityIntent?.brand_name || availabilityIntent?.matched_alias || availabilityIntent?.brand_id || '',
  )
    .trim()
    .toLowerCase();
  const compact = (value) =>
    String(value || '')
      .toLowerCase()
      .replace(/[\s\p{P}_-]+/gu, '');

  if (!brand) return compact(q).length >= 8;
  const qCompact = compact(q);
  const brandCompact = compact(brand);
  if (!qCompact || !brandCompact) return false;
  if (qCompact === brandCompact) return false;

  const genericOnly = compact(
    q
      .replace(
        /(有没有|有无|有吗|有没|有木有|请问|产品|商品|有货|现货|库存|哪里买|怎么买|购买|下单|链接|渠道|官方|旗舰|自营|店|products?|items?|catalog|store|shop|buy|available|availability|in\s*stock)/gi,
        ' ',
      )
      .replace(/\b(do you have|have any|where can i buy|where to buy)\b/gi, ' '),
  );
  if (!genericOnly) return false;
  if (genericOnly === brandCompact) return false;
  return genericOnly.length > brandCompact.length + 2;
}

async function resolveAvailabilityProductByQuery({ query, lang = 'en', hints = null, logger } = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, reason: 'query_missing', product: null, resolve_reason_code: 'no_candidates', latency_ms: 0 };
  if (!PIVOTA_BACKEND_BASE_URL) {
    return { ok: false, reason: 'pivota_backend_not_configured', product: null, resolve_reason_code: 'db_error', latency_ms: 0 };
  }

  const startedAt = Date.now();
  const url = `${PIVOTA_BACKEND_BASE_URL}/agent/v1/products/resolve`;
  const payload = {
    query: q,
    lang: String(lang || 'en').toLowerCase() === 'cn' ? 'zh' : 'en',
    options: {
      search_all_merchants: true,
      timeout_ms: CATALOG_AVAIL_RESOLVE_TIMEOUT_MS,
      upstream_retries: 0,
      stable_alias_short_circuit: true,
      allow_stable_alias_for_uuid: true,
    },
    ...(hints && typeof hints === 'object' && !Array.isArray(hints) ? { hints } : {}),
    caller: 'aurora_chatbox',
  };
  const buildResolvedProduct = (resolvedRef, resolveBody) => {
    const firstCandidate =
      Array.isArray(resolveBody?.candidates) &&
      resolveBody.candidates.length &&
      resolveBody.candidates[0] &&
      typeof resolveBody.candidates[0] === 'object'
        ? resolveBody.candidates[0]
        : null;
    const normalizedCandidate = normalizeRecoCatalogProduct(firstCandidate);
    const displayName = pickFirstTrimmed(
      normalizedCandidate?.display_name,
      normalizedCandidate?.name,
      firstCandidate?.title,
      firstCandidate?.name,
      q,
    );
    const name = pickFirstTrimmed(normalizedCandidate?.name, firstCandidate?.title, displayName);
    const brand = pickFirstTrimmed(normalizedCandidate?.brand, firstCandidate?.vendor, firstCandidate?.brand);
    const imageUrl = pickFirstTrimmed(normalizedCandidate?.image_url, firstCandidate?.image_url, firstCandidate?.thumbnail_url);
    return {
      ...(normalizedCandidate && typeof normalizedCandidate === 'object' ? normalizedCandidate : {}),
      product_id: resolvedRef.product_id,
      merchant_id: resolvedRef.merchant_id,
      canonical_product_ref: resolvedRef,
      ...(brand ? { brand } : {}),
      ...(name ? { name } : {}),
      ...(displayName ? { display_name: displayName } : {}),
      ...(imageUrl ? { image_url: imageUrl } : {}),
    };
  };

  let resp = null;
  let err = null;
  try {
    resp = await axios.post(url, payload, {
      headers: buildPivotaBackendAgentHeaders(),
      timeout: CATALOG_AVAIL_RESOLVE_TIMEOUT_MS,
      validateStatus: () => true,
    });
  } catch (e) {
    err = e;
  }

  const body = resp && typeof resp.data === 'object' ? resp.data : null;
  const statusCode = Number.isFinite(Number(resp?.status)) ? Math.trunc(Number(resp.status)) : 0;
  const resolvedRef = normalizeCanonicalProductRef(body?.product_ref, {
    requireMerchant: true,
    allowOpaqueProductId: false,
  });
  if (statusCode === 200 && body?.resolved === true && resolvedRef) {
    const product = buildResolvedProduct(resolvedRef, body);
    return {
      ok: true,
      reason: null,
      product,
      resolve_reason_code: null,
      status_code: statusCode,
      latency_ms: Date.now() - startedAt,
    };
  }

  const reasonCode = mapResolveFailureCode({
    resolveBody: body,
    statusCode,
    error: err,
  });
  const localResolveUrl = `${String(RECO_PDP_LOCAL_INVOKE_BASE_URL || '').replace(/\/+$/, '')}/agent/v1/products/resolve`;
  const shouldAttemptLocalResolveFallback =
    RECO_PDP_LOCAL_INVOKE_FALLBACK_CHAT_ENABLED &&
    RECO_PDP_LOCAL_INVOKE_FALLBACK_ENABLED &&
    localResolveUrl &&
    localResolveUrl !== url &&
    shouldAttemptLocalRecoFallback(reasonCode, err);
  let finalReasonCode = reasonCode;
  if (shouldAttemptLocalResolveFallback) {
    let localResp = null;
    let localErr = null;
    try {
      localResp = await axios.post(localResolveUrl, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: RECO_PDP_LOCAL_INVOKE_TIMEOUT_MS,
        validateStatus: () => true,
      });
    } catch (e) {
      localErr = e;
    }

    const localBody = localResp && typeof localResp.data === 'object' ? localResp.data : null;
    const localStatusCode = Number.isFinite(Number(localResp?.status)) ? Math.trunc(Number(localResp.status)) : 0;
    const localResolvedRef = normalizeCanonicalProductRef(localBody?.product_ref, {
      requireMerchant: true,
      allowOpaqueProductId: false,
    });
    if (localStatusCode === 200 && localBody?.resolved === true && localResolvedRef) {
      return {
        ok: true,
        reason: null,
        product: buildResolvedProduct(localResolvedRef, localBody),
        resolve_reason_code: null,
        status_code: localStatusCode,
        latency_ms: Date.now() - startedAt,
      };
    }
    const localReasonCode = mapResolveFailureCode({
      resolveBody: localBody,
      statusCode: localStatusCode,
      error: localErr,
    });
    if (
      (finalReasonCode === 'no_candidates' || finalReasonCode === 'upstream_timeout') &&
      localReasonCode &&
      localReasonCode !== 'no_candidates'
    ) {
      finalReasonCode = localReasonCode;
    }
    if (localErr || localReasonCode !== 'no_candidates') {
      logger?.warn(
        {
          query: q.slice(0, 120),
          primary_status_code: statusCode || null,
          primary_resolve_reason_code: reasonCode,
          local_status_code: localStatusCode || null,
          local_resolve_reason_code: localReasonCode,
          local_err: localErr ? localErr.message || String(localErr) : null,
        },
        'aurora bff: availability local resolve fallback unresolved',
      );
    }
  }
  if (err || reasonCode !== 'no_candidates') {
    logger?.warn(
      {
        query: q.slice(0, 120),
        status_code: statusCode || null,
        resolve_reason_code: finalReasonCode,
        err: err ? err.message || String(err) : null,
      },
      'aurora bff: availability resolve fallback failed',
    );
  }
  return {
    ok: false,
    reason: 'unresolved',
    product: null,
    resolve_reason_code: finalReasonCode,
    status_code: statusCode || null,
    latency_ms: Date.now() - startedAt,
  };
}

function buildBrandPlaceholderProduct({ brandId, brandName, lang } = {}) {
  const isCn = String(lang || '').toUpperCase() === 'CN';
  const brand = String(brandName || '').trim() || (isCn ? '未知品牌' : 'Unknown brand');
  const skuId = String(brandId || '').trim() || `brand_${stableHashBase36(brand).slice(0, 10)}`;
  const name = brand;
  return {
    product_id: `brand:${skuId}`,
    sku_id: skuId,
    brand,
    name,
    display_name: name,
    image_url: '',
    category: isCn ? '品牌' : 'Brand',
  };
}

function applyCommerceMedicalClaimGuard(text, lang) {
  const input = String(text || '');
  if (!input.trim()) return input;
  const lowered = input.toLowerCase();
  const hit =
    /(治愈|疗效|治疗|药用|处方|皮炎|湿疹|激素)/.test(input) ||
    /\b(cure|treat|heals?|prescription|steroid|dermatitis|eczema)\b/i.test(lowered);
  if (!hit) return input;

  recordClaimsViolation({ reason: 'commerce_medical_blacklist' });
  return lang === 'CN'
    ? '我可以帮你查商品信息/成分/购买渠道，但不提供医疗诊断或治疗建议；如果你有皮炎、湿疹等情况，建议线下就医。你想查哪个品牌/单品？'
    : "I can help with product info/ingredients/where to buy, but I can't provide medical diagnosis or treatment advice. If you suspect dermatitis/eczema, please see a clinician. Which brand or product are you looking for?";
}

function buildRecoCatalogQueries({ profileSummary, lang } = {}) {
  const raw = RECO_CATALOG_GROUNDED_QUERIES;
  const fromEnv = raw
    ? raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 8)
    : null;

  const base = fromEnv && fromEnv.length > 0 ? fromEnv : ['cleanser', 'moisturizer', 'sunscreen'];

  const goalPrimaryRaw = profileSummary && typeof profileSummary.goal_primary === 'string' ? profileSummary.goal_primary.trim().toLowerCase() : '';
  const goals = Array.isArray(profileSummary?.goals) ? profileSummary.goals : [];
  const goalsText = [goalPrimaryRaw, ...goals.map((g) => String(g || '').trim().toLowerCase())].filter(Boolean).join(' ');
  const hasAcne = /\b(acne|breakout|breakouts)\b/.test(goalsText) || /痘/.test(goalsText);

  const isCn = String(lang || '').toUpperCase() === 'CN';
  const stepLabels = {
    cleanser: isCn ? '洁面' : 'Cleanser',
    moisturizer: isCn ? '保湿' : 'Moisturizer',
    sunscreen: isCn ? '防晒' : 'Sunscreen',
    treatment: isCn ? '功效' : 'Treatment',
  };

  const items = base.map((q, idx) => {
    const key = String(q || '').trim().toLowerCase();
    const step = stepLabels[key] || (isCn ? `推荐 ${idx + 1}` : `Recommendation ${idx + 1}`);
    const slot = idx === 0 ? 'am' : idx === 1 ? 'pm' : 'other';
    const query = hasAcne && key === 'cleanser' ? 'acne cleanser' : q;
    return { query: String(query || '').trim(), step, slot };
  });

  return items.slice(0, 8);
}

function shouldUseRecoCatalogTransientFallback(catalogDebug) {
  if (!RECO_CATALOG_TRANSIENT_FALLBACK_ENABLED) return false;
  if (!catalogDebug || typeof catalogDebug !== 'object' || Array.isArray(catalogDebug)) return false;
  const queryCount = Number.isFinite(Number(catalogDebug.query_count)) ? Math.trunc(Number(catalogDebug.query_count)) : 0;
  const okCount = Number.isFinite(Number(catalogDebug.ok_count)) ? Math.trunc(Number(catalogDebug.ok_count)) : 0;
  if (queryCount <= 0 || okCount > 0) return false;

  const timeoutCount = Number.isFinite(Number(catalogDebug.timeout_count)) ? Math.trunc(Number(catalogDebug.timeout_count)) : 0;
  const statusCounts =
    catalogDebug.status_counts && typeof catalogDebug.status_counts === 'object' && !Array.isArray(catalogDebug.status_counts)
      ? catalogDebug.status_counts
      : null;
  const timeoutByStatus = Number.isFinite(Number(statusCounts && statusCounts.upstream_timeout))
    ? Math.trunc(Number(statusCounts.upstream_timeout))
    : 0;
  const upstreamErrorByStatus = Number.isFinite(Number(statusCounts && statusCounts.upstream_error))
    ? Math.trunc(Number(statusCounts.upstream_error))
    : 0;
  const rateLimitedByStatus = Number.isFinite(Number(statusCounts && statusCounts.rate_limited))
    ? Math.trunc(Number(statusCounts.rate_limited))
    : 0;
  const transientByStatus = timeoutByStatus + upstreamErrorByStatus + rateLimitedByStatus;
  const skippedReason = String(catalogDebug.skipped_reason || '').trim().toLowerCase();
  const failFastAfter =
    catalogDebug.fail_fast_after && typeof catalogDebug.fail_fast_after === 'object' && !Array.isArray(catalogDebug.fail_fast_after)
      ? catalogDebug.fail_fast_after
      : null;
  const failFastAfterOpen = Boolean(failFastAfter && failFastAfter.open === true);
  const failFastAfterReason = String(failFastAfter && failFastAfter.last_reason ? failFastAfter.last_reason : '')
    .trim()
    .toLowerCase();
  const failFastAfterTransient =
    failFastAfterReason === 'all_queries_failed' || failFastAfterReason === 'probe_transient_errors';

  if (skippedReason === 'fail_fast_open') return true;
  if (timeoutCount >= Math.max(1, queryCount)) return true;
  if (transientByStatus >= Math.max(1, queryCount)) return true;
  if (failFastAfterOpen && failFastAfterTransient) return true;
  return false;
}

function buildRecoCatalogTransientFallbackStructured({ ctx } = {}) {
  const isCn = String(ctx && ctx.lang ? ctx.lang : '').toUpperCase() === 'CN';
  const stableSeeds = [
    {
      query: 'Winona Soothing Repair Serum',
      brand: isCn ? '薇诺娜' : 'Winona',
      name: isCn ? '舒缓修护精华' : 'Soothing Repair Serum',
      display_name: isCn ? '薇诺娜 舒缓修护精华' : 'Winona Soothing Repair Serum',
      step: isCn ? '修护精华' : 'Barrier Serum',
      slot: 'pm',
      reasons: isCn
        ? ['优先修护屏障与舒缓不适，可作为晚间核心修护步骤。']
        : ['Prioritizes barrier repair and soothing support for PM recovery.'],
    },
    {
      query: 'The Ordinary Niacinamide 10% + Zinc 1%',
      brand: 'The Ordinary',
      name: 'Niacinamide 10% + Zinc 1%',
      display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
      step: isCn ? '控油精华' : 'Balancing Serum',
      slot: 'am',
      reasons: isCn
        ? ['聚焦提亮与毛孔困扰，适合作为白天轻量功效步骤。']
        : ['Targets uneven tone and pores with a light daytime active step.'],
    },
    {
      query: 'IPSA Time Reset Aqua',
      brand: 'IPSA',
      name: 'Time Reset Aqua',
      display_name: 'IPSA Time Reset Aqua',
      step: isCn ? '补水打底' : 'Hydration Base',
      slot: 'am',
      reasons: isCn
        ? ['偏向基础保湿与稳定耐受，适合和功效产品搭配。']
        : ['Provides hydration baseline and tolerance support for layering.'],
    },
  ];

  const recos = [];
  const seenProductIds = new Set();
  for (const seed of stableSeeds) {
    if (recos.length >= RECO_CATALOG_TRANSIENT_FALLBACK_MAX_ITEMS) break;
    const match = resolveRecoStableAliasRefByQuery(seed.query);
    if (!match || !match.canonicalProductRef) continue;
    const productId = String(match.canonicalProductRef.product_id || '').trim();
    const merchantId = String(match.canonicalProductRef.merchant_id || '').trim();
    if (!productId || !merchantId || seenProductIds.has(productId)) continue;
    seenProductIds.add(productId);
    recos.push({
      slot: seed.slot,
      step: seed.step,
      score: 90 - recos.length * 2,
      sku: {
        product_id: productId,
        merchant_id: merchantId,
        brand: seed.brand,
        name: seed.name,
        display_name: seed.display_name,
        canonical_product_ref: {
          product_id: productId,
          merchant_id: merchantId,
        },
      },
      reasons: seed.reasons,
      warnings: [
        isCn
          ? '商品库上游暂时波动，已使用稳定候选作为快速兜底。'
          : 'Catalog upstream is unstable; showing stable fallback picks for faster response.',
      ],
    });
  }

  if (!recos.length) return null;
  return {
    recommendations: recos,
    evidence: null,
    confidence: 0.62,
    missing_info: [],
    warnings: [
      isCn
        ? '商品库服务波动，当前先返回稳定候选；稍后可再次刷新获取更多选项。'
        : 'Catalog service is unstable right now; returning stable fallback picks first.',
    ],
  };
}

async function buildRecoGenerateFromCatalog({ ctx, profileSummary, debug, logger } = {}) {
  const startedAt = Date.now();
  const failFastBefore = getRecoCatalogFailFastSnapshot(startedAt);
  let probeWhileOpen = false;
  let searchTimeoutEffectiveMs = RECO_CATALOG_SEARCH_TIMEOUT_MS;
  const debugInfo = {
    enabled: RECO_CATALOG_GROUNDED_ENABLED,
    search_timeout_ms: RECO_CATALOG_SEARCH_TIMEOUT_MS,
    search_concurrency: RECO_CATALOG_SEARCH_CONCURRENCY,
    fail_fast: failFastBefore,
  };

  if (!RECO_CATALOG_GROUNDED_ENABLED) {
    return { structured: null, debug: { ...debugInfo, skipped_reason: 'disabled', total_ms: Date.now() - startedAt } };
  }
  if (!PIVOTA_BACKEND_BASE_URL) {
    return {
      structured: null,
      debug: { ...debugInfo, skipped_reason: 'pivota_backend_not_configured', total_ms: Date.now() - startedAt },
    };
  }
  if (failFastBefore.open) {
    probeWhileOpen = beginRecoCatalogFailFastProbe(startedAt);
    if (!probeWhileOpen) {
      return { structured: null, debug: { ...debugInfo, skipped_reason: 'fail_fast_open', total_ms: Date.now() - startedAt } };
    }
    searchTimeoutEffectiveMs = Math.min(RECO_CATALOG_SEARCH_TIMEOUT_MS, RECO_CATALOG_FAIL_FAST_PROBE_SEARCH_TIMEOUT_MS);
  }

  const queries = buildRecoCatalogQueries({ profileSummary, lang: ctx && ctx.lang ? ctx.lang : 'EN' });
  if (!queries.length) {
    return { structured: null, debug: { ...debugInfo, skipped_reason: 'queries_empty', total_ms: Date.now() - startedAt } };
  }

  const results = await mapWithConcurrency(queries, RECO_CATALOG_SEARCH_CONCURRENCY, async (q) => {
    const out = await searchPivotaBackendProducts({
      query: q.query,
      limit: 6,
      logger,
      timeoutMs: searchTimeoutEffectiveMs,
    });
    return { ...q, ...out };
  });

  const usedProductIds = new Set();
  const recos = [];
  for (const r of results) {
    const products = Array.isArray(r?.products) ? r.products : [];
    const picked = products.find((p) => p && p.product_id && !usedProductIds.has(p.product_id));
    if (!picked) continue;
    usedProductIds.add(picked.product_id);
    recos.push({
      slot: r.slot || 'other',
      step: r.step || (ctx && ctx.lang === 'CN' ? '推荐' : 'Recommendation'),
      score: 95,
      sku: picked,
      ...(debug
        ? {
          notes:
            ctx && ctx.lang === 'CN'
              ? ['来自 Pivota 商品库（PDP 测试模式）']
              : ['From Pivota catalog (PDP test mode)'],
        }
        : {}),
    });
  }

  const statusCounts = {};
  let okCount = 0;
  let emptyCount = 0;
  let timeoutCount = 0;
  for (const r of results) {
    const reason = String(r?.reason || (r?.ok ? 'ok' : 'unknown')).trim() || 'unknown';
    statusCounts[reason] = (statusCounts[reason] || 0) + 1;
    if (r?.ok) okCount += 1;
    if (r?.ok && (!Array.isArray(r?.products) || r.products.length === 0)) emptyCount += 1;
    if (reason === 'upstream_timeout') timeoutCount += 1;
  }

  const transientReasons = new Set(['upstream_timeout', 'upstream_error', 'rate_limited']);
  const hasOnlyTransientErrors = results.length > 0 && results.every((r) => !r?.ok && transientReasons.has(String(r?.reason || '')));
  const hasTransientErrors = results.some((r) => !r?.ok && transientReasons.has(String(r?.reason || '')));
  const healthyProbeResult = okCount > 0 && !hasTransientErrors;
  if (probeWhileOpen) {
    if (!healthyProbeResult && (hasOnlyTransientErrors || hasTransientErrors)) {
      markRecoCatalogFailFastFailure('probe_transient_errors', Date.now());
    }
  } else if (okCount > 0) {
    markRecoCatalogFailFastSuccess();
  } else if (hasOnlyTransientErrors) {
    markRecoCatalogFailFastFailure('all_queries_failed', Date.now());
  }

  const debugPayload = {
    ...debugInfo,
    query_count: queries.length,
    ok_count: okCount,
    picked_count: recos.length,
    probe_while_open: probeWhileOpen,
    search_timeout_effective_ms: searchTimeoutEffectiveMs,
    total_ms: Date.now() - startedAt,
    fail_fast_after: getRecoCatalogFailFastSnapshot(Date.now()),
    timeout_count: timeoutCount,
    status_counts: statusCounts,
    ...(debug
      ? {
        empty_count: emptyCount,
      }
      : {}),
  };

  if (!recos.length) return { structured: null, debug: debugPayload };

  return {
    structured: {
      recommendations: recos,
      evidence: null,
      confidence: 0.9,
      missing_info: [],
      warnings: [],
    },
    debug: debugPayload,
  };
}

function deriveRecoPdpFastFallbackReasonCode(catalogDebug) {
  const debugObj = catalogDebug && typeof catalogDebug === 'object' ? catalogDebug : null;
  if (!debugObj) return null;
  if (String(debugObj.skipped_reason || '').trim() === 'fail_fast_open') return 'upstream_timeout';
  const okCount = Number.isFinite(Number(debugObj.ok_count)) ? Math.trunc(Number(debugObj.ok_count)) : 0;
  const timeoutCount = Number.isFinite(Number(debugObj.timeout_count)) ? Math.trunc(Number(debugObj.timeout_count)) : 0;
  const queryCount = Number.isFinite(Number(debugObj.query_count)) ? Math.trunc(Number(debugObj.query_count)) : 0;
  const statusCounts =
    debugObj.status_counts && typeof debugObj.status_counts === 'object' && !Array.isArray(debugObj.status_counts)
      ? debugObj.status_counts
      : null;
  const timeoutByStatus = Number.isFinite(Number(statusCounts && statusCounts.upstream_timeout))
    ? Math.trunc(Number(statusCounts ? statusCounts.upstream_timeout : 0))
    : 0;
  const failFastAfter =
    debugObj.fail_fast_after && typeof debugObj.fail_fast_after === 'object' && !Array.isArray(debugObj.fail_fast_after)
      ? debugObj.fail_fast_after
      : null;
  const failFastAfterOpen = Boolean(failFastAfter && failFastAfter.open === true);
  const failFastAfterReason = String(failFastAfter && failFastAfter.last_reason ? failFastAfter.last_reason : '')
    .trim()
    .toLowerCase();
  const failFastAfterTransient =
    failFastAfterReason === 'all_queries_failed' || failFastAfterReason === 'probe_transient_errors';
  if (okCount > 0) return null;
  if (timeoutCount > 0 && timeoutCount >= Math.max(1, queryCount)) return 'upstream_timeout';
  if (timeoutByStatus > 0 && timeoutByStatus >= Math.max(1, queryCount)) return 'upstream_timeout';
  if (failFastAfterOpen && failFastAfterTransient) return 'upstream_timeout';
  return null;
}

function normalizeHeatmapStepLabel(raw, { slot } = {}) {
  const slotPrefix = String(slot || '').trim().toUpperCase();
  const base =
    raw && typeof raw === 'object'
      ? String(raw.step || raw.category || raw.slot_step || raw.title || raw.name || raw.display_name || '').trim()
      : String(raw || '').trim();
  const label = base || '';
  if (!label) return '';
  if (!slotPrefix) return label.slice(0, 60);
  return `${slotPrefix} ${label}`.slice(0, 60);
}

function buildHeatmapStepsFromRoutine(routine, { testProduct } = {}) {
  const routineObj = routine && typeof routine === 'object' ? routine : {};
  const am = Array.isArray(routineObj.am) ? routineObj.am : [];
  const pm = Array.isArray(routineObj.pm) ? routineObj.pm : [];
  const out = [];

  for (const item of am) {
    const label = normalizeHeatmapStepLabel(item, { slot: 'AM' });
    out.push(label || item);
    if (out.length >= 16) return out;
  }
  for (const item of pm) {
    const label = normalizeHeatmapStepLabel(item, { slot: 'PM' });
    out.push(label || item);
    if (out.length >= 16) return out;
  }
  if (testProduct) {
    const label = normalizeHeatmapStepLabel(testProduct, { slot: 'TEST' });
    out.push(label || testProduct);
  }
  return out;
}

function extractHeatmapStepsFromConflictDetector({ conflictDetector, contextRaw } = {}) {
  if (conflictDetector && typeof conflictDetector === 'object') {
    const candidates = [
      conflictDetector.steps,
      conflictDetector.routine_steps,
      conflictDetector.routineSteps,
      conflictDetector.routineStepsV1,
      conflictDetector.routine && conflictDetector.routine.steps,
      conflictDetector.routine && conflictDetector.routine.routine_steps,
      conflictDetector.routine && conflictDetector.routine.routineSteps,
    ];
    for (const candidate of candidates) {
      if (Array.isArray(candidate) && candidate.length) return candidate;
    }
    const routineCandidate =
      conflictDetector.routine && typeof conflictDetector.routine === 'object'
        ? conflictDetector.routine
        : null;
    if (routineCandidate) {
      const steps = buildHeatmapStepsFromRoutine(routineCandidate);
      if (steps.length) return steps;
    }
  }

  if (contextRaw && typeof contextRaw === 'object') {
    const candidates = [
      contextRaw.routine,
      contextRaw.routine_v1,
      contextRaw.routineV1,
      contextRaw.current_routine,
      contextRaw.currentRoutine,
      contextRaw.recommended_routine,
      contextRaw.recommendedRoutine,
    ];
    for (const candidate of candidates) {
      if (Array.isArray(candidate) && candidate.length) return candidate;
      if (candidate && typeof candidate === 'object') {
        const steps = buildHeatmapStepsFromRoutine(candidate);
        if (steps.length) return steps;
      }
    }
  }

  return [];
}

let openaiClient;
function getOpenAIClient() {
  if (!OPENAI_API_KEY) return null;
  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: OPENAI_API_KEY,
      ...(OPENAI_BASE_URL ? { baseURL: OPENAI_BASE_URL } : {}),
    });
  }
  return openaiClient;
}

let geminiClient;
let geminiClientInitFailed = false;
function getGeminiClient() {
  if (!GEMINI_API_KEY) return { client: null, init_error: VisionUnavailabilityReason.VISION_MISSING_KEY };
  if (geminiClient) return { client: geminiClient, init_error: null };
  if (geminiClientInitFailed) return { client: null, init_error: VisionUnavailabilityReason.VISION_UNKNOWN };

  try {
    const { GoogleGenAI } = require('@google/genai');
    geminiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    return { client: geminiClient, init_error: null };
  } catch (_err) {
    geminiClientInitFailed = true;
    return { client: null, init_error: VisionUnavailabilityReason.VISION_UNKNOWN };
  }
}

function resolveVisionProviderSelection() {
  const requested = SKIN_VISION_PROVIDER;
  if (requested === 'openai') {
    return { provider: 'openai', apiKeyConfigured: Boolean(OPENAI_API_KEY), requested };
  }
  if (requested === 'gemini') {
    return { provider: 'gemini', apiKeyConfigured: Boolean(GEMINI_API_KEY), requested };
  }

  if (OPENAI_API_KEY) return { provider: 'openai', apiKeyConfigured: true, requested };
  if (GEMINI_API_KEY) return { provider: 'gemini', apiKeyConfigured: true, requested };
  return { provider: 'openai', apiKeyConfigured: false, requested };
}

async function withVisionTimeout(promise, timeoutMs) {
  let timeoutRef = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutRef = setTimeout(() => {
          const err = new Error(`vision timeout after ${timeoutMs}ms`);
          err.name = 'AbortError';
          reject(err);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutRef) clearTimeout(timeoutRef);
  }
}

async function extractTextFromGeminiResponse(response) {
  if (!response) return '';
  if (typeof response.text === 'function') {
    const maybe = await response.text();
    if (typeof maybe === 'string' && maybe.trim()) return maybe;
  }
  if (typeof response.text === 'string' && response.text.trim()) return response.text;

  const candidates = Array.isArray(response.candidates) ? response.candidates : [];
  const parts = [];
  for (const candidate of candidates) {
    const contentParts =
      candidate && candidate.content && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
    for (const part of contentParts) {
      if (part && typeof part.text === 'string' && part.text.trim()) parts.push(part.text);
    }
  }
  return parts.join('\n').trim();
}

function chooseVisionPhoto(passedPhotos) {
  if (!Array.isArray(passedPhotos) || !passedPhotos.length) return null;
  return (
    passedPhotos.find((p) => String(p.slot_id || '').trim().toLowerCase() === 'daylight') ||
    passedPhotos[0] ||
    null
  );
}

function isSignedUrlExpiredSignal({ status, detail, code } = {}) {
  const statusNum = Number(status || 0);
  const combined = `${detail || ''} ${code || ''}`.toLowerCase();
  const token = /(expired|request has expired|x-amz-expires|signature.*expired|token.*expired|expiredtoken|expiration)/i;
  if (token.test(combined)) return true;
  return statusNum === 410;
}

function classifySignedUrlFetchFailure({ status, detail, code } = {}) {
  if (isSignedUrlExpiredSignal({ status, detail, code })) {
    return { failure_code: 'DOWNLOAD_URL_EXPIRED', retryable: false };
  }
  const statusNum = Number(status || 0);
  const errorCode = String(code || '').toUpperCase();
  if (statusNum === 408) {
    return { failure_code: 'DOWNLOAD_URL_TIMEOUT', retryable: true };
  }
  if (statusNum >= 500 && statusNum < 600) {
    return { failure_code: 'DOWNLOAD_URL_FETCH_5XX', retryable: true };
  }
  if (statusNum >= 400 && statusNum < 500) {
    return { failure_code: 'DOWNLOAD_URL_FETCH_4XX', retryable: false };
  }
  if (errorCode === 'ECONNABORTED' || errorCode === 'ETIMEDOUT' || /timeout/i.test(String(detail || ''))) {
    return { failure_code: 'DOWNLOAD_URL_TIMEOUT', retryable: true };
  }
  if (errorCode === 'ENOTFOUND' || errorCode === 'EAI_AGAIN' || errorCode === 'EAI_FAIL') {
    return { failure_code: 'DOWNLOAD_URL_DNS', retryable: true };
  }
  return { failure_code: 'DOWNLOAD_URL_FETCH_5XX', retryable: true };
}

async function fetchBytesFromSignedUrl(downloadUrl) {
  const startedAt = Date.now();
  let lastFailure = null;
  const totalAttempts = PHOTO_FETCH_RETRIES + 1;

  for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
    const elapsed = Date.now() - startedAt;
    const remaining = PHOTO_FETCH_TOTAL_TIMEOUT_MS - elapsed;
    if (remaining <= 0) {
      return {
        ok: false,
        failure_code: 'DOWNLOAD_URL_TIMEOUT',
        reason: 'download_url_fetch_timeout',
        status: null,
        detail: 'signed_url_fetch_total_timeout',
      };
    }

    const perAttemptTimeout = Math.min(PHOTO_FETCH_TIMEOUT_MS, remaining);
    try {
      const blobResp = await axios.get(downloadUrl, {
        timeout: perAttemptTimeout,
        validateStatus: () => true,
        responseType: 'arraybuffer',
        maxBodyLength: 15 * 1024 * 1024,
        maxContentLength: 15 * 1024 * 1024,
      });
      const detail = pickUpstreamErrorDetail(blobResp.data);
      if (blobResp.status >= 200 && blobResp.status < 300 && blobResp.data) {
        const contentTypeHeader =
          blobResp.headers && (blobResp.headers['content-type'] || blobResp.headers['Content-Type'])
            ? String(blobResp.headers['content-type'] || blobResp.headers['Content-Type']).trim()
            : null;
        return {
          ok: true,
          buffer: Buffer.from(blobResp.data),
          contentTypeHeader,
        };
      }

      const failure = classifySignedUrlFetchFailure({ status: blobResp.status, detail });
      lastFailure = {
        ok: false,
        failure_code: failure.failure_code,
        reason: String(failure.failure_code || 'download_url_fetch_failed').toLowerCase(),
        status: blobResp.status,
        detail: detail || null,
      };
      if (!failure.retryable || attempt >= totalAttempts - 1) return lastFailure;
    } catch (err) {
      const failure = classifySignedUrlFetchFailure({
        status: null,
        detail: err && err.message ? err.message : null,
        code: err && err.code ? err.code : null,
      });
      lastFailure = {
        ok: false,
        failure_code: failure.failure_code,
        reason: String(failure.failure_code || 'download_url_fetch_failed').toLowerCase(),
        status: null,
        detail: err && (err.code || err.message) ? String(err.code || err.message) : null,
      };
      if (!failure.retryable || attempt >= totalAttempts - 1) return lastFailure;
    }

    const backoffMs = Math.min(
      PHOTO_FETCH_RETRY_BASE_MS * (2 ** attempt),
      Math.max(0, PHOTO_FETCH_TOTAL_TIMEOUT_MS - (Date.now() - startedAt)),
    );
    if (backoffMs > 0) await sleep(backoffMs);
  }

  return (
    lastFailure || {
      ok: false,
      failure_code: 'DOWNLOAD_URL_FETCH_5XX',
      reason: 'download_url_fetch_failed',
      status: null,
      detail: null,
    }
  );
}

async function fetchPhotoBytesFromPivotaBackend({ req, photoId } = {}) {
  const auroraUid = getAuroraUidFromReq(req);
  if (!photoId) return { ok: false, reason: 'photo_id_missing', failure_code: 'DOWNLOAD_URL_GENERATE_FAILED' };

  const cached = getPhotoBytesCache({ photoId, auroraUid });
  if (cached) {
    return {
      ok: true,
      buffer: Buffer.from(cached.buffer),
      contentType: cached.contentType || 'image/jpeg',
      source: 'upload_cache',
    };
  }

  if (!PIVOTA_BACKEND_BASE_URL) {
    return {
      ok: false,
      reason: 'pivota_backend_not_configured',
      failure_code: 'DOWNLOAD_URL_GENERATE_FAILED',
    };
  }

  const authHeaders = buildPivotaBackendAuthHeaders(req);
  if (!Object.keys(authHeaders).length) {
    return {
      ok: false,
      reason: 'pivota_backend_auth_not_configured',
      failure_code: 'DOWNLOAD_URL_GENERATE_FAILED',
    };
  }

  let upstreamResp = null;
  try {
    upstreamResp = await axios.get(`${PIVOTA_BACKEND_BASE_URL}/photos/download-url`, {
      timeout: PHOTO_DOWNLOAD_URL_TIMEOUT_MS,
      validateStatus: () => true,
      headers: authHeaders,
      params: { upload_id: photoId },
    });
  } catch (err) {
    return {
      ok: false,
      reason: 'download_url_generate_failed',
      failure_code: 'DOWNLOAD_URL_GENERATE_FAILED',
      status: null,
      detail: err && (err.code || err.message) ? String(err.code || err.message) : null,
    };
  }

  const download = upstreamResp && upstreamResp.data && upstreamResp.data.download ? upstreamResp.data.download : null;
  const downloadUrl = download && typeof download.url === 'string' ? download.url.trim() : '';
  if (upstreamResp.status !== 200 || !downloadUrl) {
    const detail = pickUpstreamErrorDetail(upstreamResp.data);
    return {
      ok: false,
      reason: 'download_url_generate_failed',
      failure_code: 'DOWNLOAD_URL_GENERATE_FAILED',
      status: upstreamResp.status,
      detail: detail || null,
    };
  }

  const downloadExpiresAt =
    (download && typeof download.expires_at === 'string' && download.expires_at) ||
    (upstreamResp.data && typeof upstreamResp.data.expires_at === 'string' && upstreamResp.data.expires_at) ||
    null;
  const secLeft = secondsUntilIso(downloadExpiresAt);
  if (secLeft != null && secLeft <= 0) {
    return {
      ok: false,
      reason: 'download_url_expired',
      failure_code: 'DOWNLOAD_URL_EXPIRED',
      status: 410,
      detail: 'signed_url_expired_before_fetch',
    };
  }

  const contentTypeUpstream =
    typeof upstreamResp.data.content_type === 'string' && upstreamResp.data.content_type.trim()
      ? upstreamResp.data.content_type.trim()
      : null;
  const blobResp = await fetchBytesFromSignedUrl(downloadUrl);
  if (!blobResp || !blobResp.ok) return blobResp || { ok: false, reason: 'download_url_fetch_failed' };

  const buffer = blobResp.buffer;
  const contentTypeHeader = blobResp.contentTypeHeader;
  const finalContentType = contentTypeHeader || contentTypeUpstream || 'image/jpeg';
  setPhotoBytesCache({ photoId, auroraUid, buffer, contentType: finalContentType });
  return {
    ok: true,
    buffer,
    contentType: finalContentType,
    source: 'signed_url',
  };
}

function isPassedPhotoQcStatus(qcStatus) {
  return normalizePhotoQcStatus(qcStatus) === 'passed';
}

function normalizePhotoQcStatus(rawStatus) {
  const token = String(rawStatus || '')
    .trim()
    .toLowerCase();
  if (!token) return '';
  if (token === 'passed' || token === 'pass' || token === 'ok' || token === 'success' || token === 'succeeded') {
    return 'passed';
  }
  if (token === 'degraded' || token === 'warn' || token === 'warning' || token === 'low') {
    return 'degraded';
  }
  if (token === 'fail' || token === 'failed' || token === 'reject' || token === 'rejected' || token === 'bad') {
    return 'failed';
  }
  return '';
}

function resolvePhotoQcStatus(payload) {
  const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  if (!source) return null;
  const nestedQc = source.qc && typeof source.qc === 'object' && !Array.isArray(source.qc) ? source.qc : null;
  const candidates = [
    source.qc_status,
    nestedQc && nestedQc.qc_status,
    source.status,
    nestedQc && nestedQc.status,
    source.result,
    nestedQc && nestedQc.result,
    source.state,
    nestedQc && nestedQc.state,
  ];
  for (const candidate of candidates) {
    const normalized = normalizePhotoQcStatus(candidate);
    if (normalized) return normalized;
  }
  return null;
}

function hasNonEmptyRoutineInput(routineCandidate) {
  return Boolean(
    routineCandidate != null &&
      (typeof routineCandidate === 'string'
        ? String(routineCandidate).trim().length > 0
        : Array.isArray(routineCandidate)
          ? routineCandidate.length > 0
          : typeof routineCandidate === 'object'
            ? Object.keys(routineCandidate).length > 0
            : false),
  );
}

function normalizeQualityGradeForMetrics(grade) {
  const token = String(grade || '')
    .trim()
    .toLowerCase();
  if (token === 'pass' || token === 'degraded' || token === 'fail') return token;
  return 'unknown';
}

function normalizePipelineVersionForMetrics(version) {
  const token = String(version || '')
    .trim()
    .toLowerCase();
  if (token === 'a' || token === 'legacy' || token === 'v1') return 'A';
  if (token === 'b' || token === 'v2') return 'B';
  return 'unknown';
}

function inferDeviceClassForMetrics(req) {
  const explicit = req && typeof req.get === 'function' ? req.get('X-Device-Class') : null;
  if (explicit && String(explicit).trim()) return String(explicit).trim().slice(0, 64);
  const ua = req && typeof req.get === 'function' ? String(req.get('User-Agent') || '') : '';
  const lowered = ua.toLowerCase();
  if (!lowered) return 'unknown';
  if (/(iphone|android|ipad|mobile)/.test(lowered)) return 'mobile';
  if (/(macintosh|windows|linux|x11)/.test(lowered)) return 'desktop';
  return 'unknown';
}

function buildPhotoAutoNoticeMessage({ language, failureCode }) {
  const code = String(failureCode || 'DOWNLOAD_URL_GENERATE_FAILED').trim().toUpperCase();
  if (language === 'CN') {
    return `本次未能读取并分析照片（原因：${code}），以下结果仅基于你的问卷/历史信息。请重传后重试。`;
  }
  return `We couldn't analyze your photo this time (reason: ${code}). Results below are based on your answers/history only. Please re-upload and retry.`;
}

let inferSkinMaskOnFaceCropImpl = inferSkinMaskOnFaceCrop;

function computeElapsedMs(startHrTime) {
  if (typeof startHrTime !== 'bigint') return 0;
  return Number(process.hrtime.bigint() - startHrTime) / 1e6;
}

function withTimeout(promise, timeoutMs, timeoutCode) {
  const ms = Number.isFinite(Number(timeoutMs)) ? Math.max(1, Math.trunc(Number(timeoutMs))) : 0;
  if (!ms) return promise;
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(timeoutCode || 'timeout');
      err.code = timeoutCode || 'TIMEOUT';
      reject(err);
    }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function normalizeSkinmaskFallbackReason(rawReason, detail) {
  const reason = String(rawReason || '').trim().toUpperCase();
  const info = String(detail || '').trim().toUpperCase();
  if (reason.includes('TIMEOUT') || info.includes('TIMEOUT')) return 'TIMEOUT';
  if (
    reason === 'MODEL_PATH_MISSING' ||
    reason === 'ONNXRUNTIME_MISSING' ||
    reason === 'SESSION_UNAVAILABLE' ||
    reason === 'SESSION_LOAD_FAILED' ||
    info.includes('ENOENT') ||
    info.includes('NO SUCH FILE')
  ) {
    return 'MODEL_MISSING';
  }
  return 'ONNX_FAIL';
}

function maybeBuildPhotoModulesCardForAnalysis({
  requestId,
  analysis,
  usedPhotos,
  photoQuality,
  photoNotice,
  diagnosisInternal,
  profileSummary,
  language,
  skinMask,
} = {}) {
  if (!DIAG_PHOTO_MODULES_CARD) return null;
  if (DIAG_OVERLAY_MODE !== 'client') return null;

  const photoNoticeText =
    typeof photoNotice === 'string'
      ? photoNotice
      : photoNotice && typeof photoNotice.message === 'string'
        ? photoNotice.message
        : null;

  const built = buildPhotoModulesCard({
    requestId,
    analysis,
    usedPhotos: Boolean(usedPhotos),
    photoQuality,
    photoNotice: photoNoticeText,
    diagnosisInternal,
    profileSummary,
    language,
    ingredientRecEnabled: DIAG_INGREDIENT_REC,
    productRecEnabled: DIAG_PRODUCT_REC,
    productRecMinCitations: DIAG_PRODUCT_REC_MIN_CITATIONS,
    productRecMinEvidenceGrade: DIAG_PRODUCT_REC_MIN_EVIDENCE_GRADE,
    productRecRepairOnlyWhenDegraded: DIAG_PRODUCT_REC_REPAIR_ONLY_WHEN_DEGRADED,
    internalTestMode: INTERNAL_TEST_MODE,
    ingredientKbArtifactPath: DIAG_INGREDIENT_KB_V2_PATH,
    productCatalogPath: DIAG_PRODUCT_CATALOG_PATH,
    skinMask,
  });
  if (!built || !built.card) return null;

  const metrics = built.metrics && typeof built.metrics === 'object' ? built.metrics : {};
  recordPhotoModulesCardEmitted({
    qualityGrade: metrics.quality_grade || (photoQuality && photoQuality.grade),
  });

  const regionCounts = Array.isArray(metrics.regionCounts) ? metrics.regionCounts : [];
  for (const row of regionCounts) {
    const delta = Number.isFinite(Number(row && row.count)) ? Number(row.count) : 0;
    if (delta <= 0) continue;
    recordRegionsEmitted({
      regionType: row.region_type,
      issueType: row.issue_type,
      delta,
    });
  }

  const moduleIssueCounts = Array.isArray(metrics.moduleIssueCounts) ? metrics.moduleIssueCounts : [];
  for (const row of moduleIssueCounts) {
    const count = Number.isFinite(Number(row && row.count)) ? Number(row.count) : 0;
    if (count <= 0) continue;
    recordModulesIssueCountHistogram({
      moduleId: row.module_id,
      issueType: row.issue_type,
      count,
    });
  }

  const ingredientActionCounts = Array.isArray(metrics.ingredientActionCounts) ? metrics.ingredientActionCounts : [];
  for (const row of ingredientActionCounts) {
    const delta = Number.isFinite(Number(row && row.count)) ? Number(row.count) : 0;
    if (delta <= 0) continue;
    recordIngredientActionsEmitted({
      moduleId: row.module_id,
      issueType: row.issue_type,
      delta,
    });
  }

  const productRecEmittedCounts = Array.isArray(metrics.productRecEmittedCounts) ? metrics.productRecEmittedCounts : [];
  for (const row of productRecEmittedCounts) {
    const delta = Number.isFinite(Number(row && row.count)) ? Number(row.count) : 0;
    if (delta <= 0) continue;
    recordProductRecEmitted({
      market: row.market,
      qualityGrade: row.quality_grade,
      delta,
    });
  }

  const productRecSuppressedCounts = Array.isArray(metrics.productRecSuppressedCounts) ? metrics.productRecSuppressedCounts : [];
  for (const row of productRecSuppressedCounts) {
    const delta = Number.isFinite(Number(row && row.count)) ? Number(row.count) : 0;
    if (delta <= 0) continue;
    recordProductRecSuppressed({
      reason: row.reason,
      delta,
    });
  }

  const claimsTemplateFallbackCounts = Array.isArray(metrics.claimsTemplateFallbackCounts) ? metrics.claimsTemplateFallbackCounts : [];
  for (const row of claimsTemplateFallbackCounts) {
    const delta = Number.isFinite(Number(row && row.count)) ? Number(row.count) : 0;
    if (delta <= 0) continue;
    recordClaimsTemplateFallback({
      reason: row.reason,
      delta,
    });
  }

  const claimsViolationCounts = Array.isArray(metrics.claimsViolationCounts) ? metrics.claimsViolationCounts : [];
  for (const row of claimsViolationCounts) {
    const delta = Number.isFinite(Number(row && row.count)) ? Number(row.count) : 0;
    if (delta <= 0) continue;
    recordClaimsViolation({
      reason: row.reason,
      delta,
    });
  }

  const geometryDropCounts = Array.isArray(metrics.geometryDropCounts) ? metrics.geometryDropCounts : [];
  for (const row of geometryDropCounts) {
    const delta = Number.isFinite(Number(row && row.count)) ? Number(row.count) : 0;
    if (delta <= 0) continue;
    recordGeometrySanitizerDropReason({
      reason: row.reason,
      regionType: row.region_type,
      delta,
    });
  }

  return built.card;
}

async function maybeInferSkinMaskForPhotoModules({ imageBuffer, diagnosisInternal, logger, requestId } = {}) {
  if (!DIAG_SKINMASK_ENABLED) return null;
  if (!imageBuffer || !Buffer.isBuffer(imageBuffer) || !imageBuffer.length) return null;
  recordSkinmaskEnabled();
  if (!DIAG_SKINMASK_MODEL_PATH) {
    recordSkinmaskFallback({ reason: 'MODEL_MISSING' });
    logger?.warn(
      {
        request_id: requestId || null,
        reason: 'MODEL_MISSING',
      },
      'aurora bff: skinmask onnx inference skipped',
    );
    return null;
  }

  const inferStartedAt = process.hrtime.bigint();
  try {
    const inferred = await withTimeout(
      Promise.resolve(
        inferSkinMaskOnFaceCropImpl({
          imageBuffer,
          diagnosisInternal,
          modelPath: DIAG_SKINMASK_MODEL_PATH,
        }),
      ),
      DIAG_SKINMASK_TIMEOUT_MS,
      'SKINMASK_TIMEOUT',
    );
    observeSkinmaskInferLatency({ latencyMs: computeElapsedMs(inferStartedAt) });
    if (!inferred || !inferred.ok) {
      const fallbackReason = normalizeSkinmaskFallbackReason(inferred && inferred.reason, inferred && inferred.detail);
      recordSkinmaskFallback({ reason: fallbackReason });
      logger?.warn(
        {
          request_id: requestId || null,
          fallback_reason: fallbackReason,
          reason: inferred && inferred.reason ? inferred.reason : 'unknown',
          detail: inferred && inferred.detail ? inferred.detail : null,
        },
        'aurora bff: skinmask onnx inference skipped',
      );
      return null;
    }
    return inferred;
  } catch (error) {
    observeSkinmaskInferLatency({ latencyMs: computeElapsedMs(inferStartedAt) });
    const fallbackReason = normalizeSkinmaskFallbackReason(error && error.code ? error.code : null, error && error.message);
    recordSkinmaskFallback({ reason: fallbackReason });
    logger?.warn(
      {
        request_id: requestId || null,
        fallback_reason: fallbackReason,
        reason: error && error.code ? String(error.code) : 'unknown',
        err: error && error.message ? error.message : String(error),
      },
      'aurora bff: skinmask onnx inference failed',
    );
    return null;
  }
}

async function buildAutoAnalysisFromConfirmedPhoto({ req, ctx, photoId, slotId, qcStatus, logger, identity } = {}) {
  if (!PHOTO_AUTO_ANALYZE_AFTER_CONFIRM) return null;
  if (!photoId || !isPassedPhotoQcStatus(qcStatus)) return null;

  const language = ctx && ctx.lang === 'CN' ? 'CN' : 'EN';
  const slot = String(slotId || 'daylight').trim() || 'daylight';
  const qc = String(qcStatus || 'passed').trim().toLowerCase() || 'passed';

  let profile = null;
  let recentLogs = [];
  let resolvedIdentity = identity || null;
  try {
    resolvedIdentity = resolvedIdentity || (await resolveIdentity(req, ctx));
    profile = await getProfileForIdentity({ auroraUid: resolvedIdentity.auroraUid, userId: resolvedIdentity.userId });
    recentLogs = await getRecentSkinLogsForIdentity({ auroraUid: resolvedIdentity.auroraUid, userId: resolvedIdentity.userId }, 7);
  } catch (err) {
    logger?.warn({ err: err && err.message ? err.message : String(err) }, 'aurora bff: auto analysis failed to load memory context');
  }

  const profileSummary = summarizeProfileForContext(profile);
  const recentLogsSummary = Array.isArray(recentLogs) ? recentLogs.slice(0, 7) : [];
  const routineCandidate = profileSummary && profileSummary.currentRoutine;
  const hasPrimaryInput = hasNonEmptyRoutineInput(routineCandidate) || recentLogsSummary.length > 0;
  const detectorConfidence = inferDetectorConfidence({ profileSummary, recentLogsSummary, routineCandidate });
  const photoQuality = classifyPhotoQuality([{ slot_id: slot, photo_id: photoId, qc_status: qc }]);

  const fieldMissing = [];
  const qualityReasons = [];

  let usedPhotos = false;
  let analysisSource = hasPrimaryInput ? 'rule_based_with_photo_qc' : 'baseline_low_confidence';
  let diagnosisV1 = null;
  let diagnosisV1Internal = null;
  let diagnosisPhotoBytes = null;
  let analysis = null;
  let photoNotice = null;

  try {
    const photoResp = await fetchPhotoBytesFromPivotaBackend({ req, photoId });
    if (photoResp && photoResp.ok && photoResp.buffer && Buffer.isBuffer(photoResp.buffer) && photoResp.buffer.length > 0) {
      diagnosisPhotoBytes = photoResp.buffer;
      const profiler = createStageProfiler();
      const diag = await runSkinDiagnosisV1({
        imageBuffer: diagnosisPhotoBytes,
        language,
        profileSummary,
        recentLogsSummary,
        profiler,
      });
      if (diag && diag.ok && diag.diagnosis) {
        diagnosisV1 = diag.diagnosis;
        diagnosisV1Internal = diag.internal || null;
        usedPhotos = true;
        const qGrade = String(diagnosisV1?.quality?.grade || '').trim().toLowerCase();
        if (qGrade === 'fail') {
          analysis = buildRetakeSkinAnalysis({ language, photoQuality: diagnosisV1.quality || photoQuality });
          analysisSource = 'retake';
          qualityReasons.push(
            language === 'CN'
              ? '已读取照片，但像素质量不足；建议重拍并复核。'
              : 'Photo was read, but pixel quality is insufficient; please retake and recheck.',
          );
        } else {
          analysis = buildSkinAnalysisFromDiagnosisV1(diagnosisV1, { language, profileSummary });
          analysisSource = 'diagnosis_v1_template';
        }
        if (qGrade === 'degraded') {
          qualityReasons.push(
            language === 'CN'
              ? '已完成照片分析（质量一般）：结论会更保守。'
              : 'Photo analysis completed (degraded quality): conclusions are conservative.',
          );
        } else if (qGrade !== 'fail') {
          qualityReasons.push(language === 'CN' ? '已基于照片完成自动皮肤分析。' : 'Auto skin analysis completed from your photo.');
        }
      } else {
        const failureCode = 'diagnosis_failed';
        fieldMissing.push({ field: 'analysis.used_photos', reason: failureCode });
        photoNotice = {
          failure_code: failureCode,
          message: buildPhotoAutoNoticeMessage({ language, failureCode }),
        };
        qualityReasons.push(
          language === 'CN'
            ? '照片读取成功，但分析模块未稳定完成；已退回问卷/历史基线。'
            : 'Photo bytes were loaded, but diagnosis did not complete reliably; fell back to answers/history baseline.',
        );
      }
    } else {
      const failureCode = String(photoResp && (photoResp.failure_code || photoResp.reason) ? photoResp.failure_code || photoResp.reason : 'DOWNLOAD_URL_GENERATE_FAILED')
        .trim()
        .toUpperCase();
      fieldMissing.push({ field: 'analysis.used_photos', reason: failureCode });
      photoNotice = {
        failure_code: failureCode,
        message: buildPhotoAutoNoticeMessage({ language, failureCode }),
      };
      qualityReasons.push(language === 'CN' ? `照片读取失败（${failureCode}）。` : `Photo fetch failed (${failureCode}).`);
    }
  } catch (err) {
    const failureCode = 'DOWNLOAD_URL_FETCH_5XX';
    fieldMissing.push({ field: 'analysis.used_photos', reason: failureCode });
    photoNotice = {
      failure_code: failureCode,
      message: buildPhotoAutoNoticeMessage({ language, failureCode }),
    };
    qualityReasons.push(language === 'CN' ? `照片读取异常（${failureCode}）。` : `Photo fetch error (${failureCode}).`);
    logger?.warn(
      { err: err && err.message ? err.message : String(err) },
      'aurora bff: auto analysis photo fetch failed',
    );
  }

  if (!analysis) {
    if (hasPrimaryInput) {
      analysis = buildRuleBasedSkinAnalysis({ profile: profileSummary || profile, recentLogs, language });
      analysisSource = 'rule_based_with_photo_qc';
    } else {
      fieldMissing.push({ field: 'analysis.used_photos', reason: 'routine_or_recent_logs_required' });
      qualityReasons.push(
        language === 'CN'
          ? '缺少“正在用什么/最近打卡”等关键信息；先返回低风险基线。'
          : 'Routine/recent logs are missing; returning a low-risk baseline first.',
      );
      analysis = buildLowConfidenceBaselineSkinAnalysis({ profile: profileSummary || profile, language });
      analysisSource = 'baseline_low_confidence';
    }
  }

  if (analysis && diagnosisV1 && usedPhotos) {
    analysis = mergePhotoFindingsIntoAnalysis({
      analysis,
      diagnosisV1,
      language,
      profileSummary,
    });
  }

  analysis = buildExecutablePlanForAnalysis({
    analysis,
    language,
    usedPhotos,
    photoQuality: diagnosisV1 && diagnosisV1.quality ? diagnosisV1.quality : photoQuality,
    profileSummary,
    photoNoticeOverride: photoNotice && typeof photoNotice.message === 'string' ? photoNotice.message : '',
    photoFailureCode: photoNotice && typeof photoNotice.failure_code === 'string' ? photoNotice.failure_code : '',
    photosProvided: true,
  });
  const geometrySanitizer =
    analysis && analysis.__geometry_sanitizer && typeof analysis.__geometry_sanitizer === 'object'
      ? analysis.__geometry_sanitizer
      : null;
  if (analysis && Object.prototype.hasOwnProperty.call(analysis, '__geometry_sanitizer')) {
    delete analysis.__geometry_sanitizer;
  }

  const qualityGradeForMetrics = normalizeQualityGradeForMetrics(diagnosisV1?.quality?.grade || photoQuality?.grade);
  const pipelineVersionForMetrics = normalizePipelineVersionForMetrics(String(process.env.DIAG_PIPELINE_VERSION || 'legacy'));
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

  const payload = {
    analysis,
    low_confidence: analysisSource === 'baseline_low_confidence',
    photos_provided: true,
    photo_qc: [`${slot}:${qc}`],
    used_photos: usedPhotos,
    analysis_source: !usedPhotos && analysisSource !== 'retake' ? 'rule_based_with_photo_qc' : analysisSource,
    ...(photoNotice ? { photo_notice: photoNotice } : {}),
    quality_report: {
      photo_quality: {
        grade: String(diagnosisV1?.quality?.grade || photoQuality?.grade || 'unknown').toLowerCase(),
        reasons:
          Array.isArray(diagnosisV1?.quality?.reasons) && diagnosisV1.quality.reasons.length
            ? diagnosisV1.quality.reasons
            : Array.isArray(photoQuality?.reasons)
              ? photoQuality.reasons
              : [],
      },
      detector_confidence: detectorConfidence,
      degraded_mode: SKIN_DEGRADED_MODE,
      llm: {
        vision: { decision: 'skip', reasons: ['auto_analysis_diagnosis_v1_only'], downgrade_confidence: false },
        report: { decision: 'skip', reasons: ['auto_analysis_diagnosis_v1_only'], downgrade_confidence: false },
      },
      reasons: qualityReasons.slice(0, 8),
    },
  };

  const photoModulesSkinMask = await maybeInferSkinMaskForPhotoModules({
    imageBuffer: diagnosisPhotoBytes,
    diagnosisInternal: diagnosisV1Internal,
    logger,
    requestId: ctx.request_id,
  });

  const photoModulesCard = maybeBuildPhotoModulesCardForAnalysis({
    requestId: ctx.request_id,
    analysis,
    usedPhotos,
    photoQuality: diagnosisV1 && diagnosisV1.quality ? diagnosisV1.quality : photoQuality,
    photoNotice,
    diagnosisInternal: diagnosisV1Internal,
    profileSummary,
    language,
    skinMask: photoModulesSkinMask,
  });

  const cards = [
    {
      card_id: `analysis_${ctx.request_id}`,
      type: 'analysis_summary',
      payload,
      ...(fieldMissing.length ? { field_missing: fieldMissing } : {}),
    },
    ...(photoModulesCard ? [photoModulesCard] : []),
  ];

  return {
    cards,
    session_patch: { next_state: 'S5_ANALYSIS_SUMMARY' },
    event: makeEvent(ctx, 'value_moment', {
      kind: 'skin_analysis',
      used_photos: usedPhotos,
      analysis_source: payload.analysis_source,
      source: 'photo_auto',
    }),
  };
}

async function safeBuildAutoAnalysisFromConfirmedPhoto({ req, ctx, photoId, slotId, qcStatus, logger, identity } = {}) {
  try {
    return await buildAutoAnalysisFromConfirmedPhoto({ req, ctx, photoId, slotId, qcStatus, logger, identity });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    const code = err && err.code ? String(err.code) : 'PHOTO_AUTO_ANALYSIS_FAILED';
    logger?.error(
      {
        err: message,
        code,
        request_id: ctx && ctx.request_id ? ctx.request_id : null,
        trace_id: ctx && ctx.trace_id ? ctx.trace_id : null,
        aurora_uid: ctx && ctx.aurora_uid ? ctx.aurora_uid : null,
        photo_id: photoId || null,
        slot_id: slotId || null,
      },
      'aurora bff: auto analysis failed unexpectedly; returning photo_confirm only',
    );
    return {
      cards: [],
      session_patch: {},
      event: makeEvent(ctx, 'error', { code }),
    };
  }
}

async function runOpenAIVisionSkinAnalysis({
  imageBuffer,
  language,
  photoQuality,
  diagnosisPolicy,
  diagnosisV1,
  profileSummary,
  recentLogsSummary,
  profiler,
  promptVersion,
} = {}) {
  const startedAt = Date.now();
  if (!SKIN_VISION_ENABLED) {
    return {
      ok: false,
      provider: 'openai',
      reason: VisionUnavailabilityReason.VISION_DISABLED_BY_FLAG,
      upstream_status_code: null,
      latency_ms: Date.now() - startedAt,
      retry: { attempted: 0, final: 'fail', last_reason: VisionUnavailabilityReason.VISION_DISABLED_BY_FLAG },
    };
  }
  const client = getOpenAIClient();
  if (!client) {
    return {
      ok: false,
      provider: 'openai',
      reason: VisionUnavailabilityReason.VISION_MISSING_KEY,
      upstream_status_code: null,
      latency_ms: Date.now() - startedAt,
      retry: { attempted: 0, final: 'fail', last_reason: VisionUnavailabilityReason.VISION_MISSING_KEY },
    };
  }
  if (!imageBuffer || !Buffer.isBuffer(imageBuffer) || !imageBuffer.length) {
    return {
      ok: false,
      provider: 'openai',
      reason: VisionUnavailabilityReason.VISION_IMAGE_FETCH_FAILED,
      upstream_status_code: null,
      latency_ms: Date.now() - startedAt,
      retry: { attempted: 0, final: 'fail', last_reason: VisionUnavailabilityReason.VISION_IMAGE_FETCH_FAILED },
    };
  }

  const optimized =
    profiler && typeof profiler.time === 'function'
      ? await profiler.time(
          'decode',
          async () =>
            sharp(imageBuffer)
              .rotate()
              .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: 82 })
              .toBuffer(),
          { kind: 'vision_prepare' },
        )
      : await sharp(imageBuffer)
          .rotate()
          .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 82 })
          .toBuffer();
  const dataUrl = `data:image/jpeg;base64,${optimized.toString('base64')}`;

  const promptBase = buildSkinVisionPrompt({
    language,
    photoQuality,
    diagnosisPolicy,
    diagnosisV1,
    profileSummary,
    recentLogsSummary,
    promptVersion,
  });

  const attemptResult = await executeVisionWithRetry({
    maxRetries: SKIN_VISION_RETRY_MAX,
    baseDelayMs: SKIN_VISION_RETRY_BASE_MS,
    classifyError: classifyVisionProviderFailure,
    operation: async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SKIN_VISION_TIMEOUT_MS);
      try {
        const callOpenAI = async () =>
          client.chat.completions.create(
            {
              model: SKIN_VISION_MODEL_OPENAI,
              temperature: 0.2,
              max_tokens: 480,
              response_format: { type: 'json_object' },
              messages: [
                { role: 'system', content: 'You produce ONLY JSON.' },
                {
                  role: 'user',
                  content: [
                    {
                      type: 'text',
                      text: `${promptBase}\nSELF-CHECK before responding: output MUST be strict JSON (no markdown/text), match the exact keys, and end strategy with a single direct question mark.\n`,
                    },
                    { type: 'image_url', image_url: { url: dataUrl } },
                  ],
                },
              ],
            },
            { signal: controller.signal },
          );

        const resp =
          profiler && typeof profiler.timeLlmCall === 'function'
            ? await profiler.timeLlmCall({ provider: 'openai', model: SKIN_VISION_MODEL_OPENAI, kind: 'skin_vision' }, callOpenAI)
            : await callOpenAI();

        const content = resp && resp.choices && resp.choices[0] && resp.choices[0].message ? resp.choices[0].message.content : '';
        const jsonOnly = unwrapCodeFence(content);
        const parsedObj = parseJsonOnlyObject(jsonOnly);
        const analysis = normalizeSkinAnalysisFromLLM(parsedObj, { language });
        if (!analysis) {
          const schemaErr = new Error('vision schema invalid');
          schemaErr.__vision_reason = VisionUnavailabilityReason.VISION_SCHEMA_INVALID;
          throw schemaErr;
        }
        return { analysis };
      } finally {
        clearTimeout(timer);
      }
    },
  });

  if (attemptResult && attemptResult.ok && attemptResult.result && attemptResult.result.analysis) {
    return {
      ok: true,
      provider: 'openai',
      analysis: attemptResult.result.analysis,
      upstream_status_code: null,
      latency_ms: Date.now() - startedAt,
      retry: attemptResult.retry,
    };
  }

  return {
    ok: false,
    provider: 'openai',
    reason: normalizeVisionReason(attemptResult && attemptResult.reason),
    upstream_status_code: toNullableInt(attemptResult && attemptResult.upstream_status_code),
    error: attemptResult && attemptResult.error_code ? String(attemptResult.error_code) : null,
    latency_ms: Date.now() - startedAt,
    retry:
      (attemptResult && attemptResult.retry) ||
      { attempted: 0, final: 'fail', last_reason: normalizeVisionReason(attemptResult && attemptResult.reason) },
  };
}

async function runGeminiVisionSkinAnalysis({
  imageBuffer,
  language,
  photoQuality,
  diagnosisPolicy,
  diagnosisV1,
  profileSummary,
  recentLogsSummary,
  profiler,
  promptVersion,
} = {}) {
  const startedAt = Date.now();
  if (!SKIN_VISION_ENABLED) {
    return {
      ok: false,
      provider: 'gemini',
      reason: VisionUnavailabilityReason.VISION_DISABLED_BY_FLAG,
      upstream_status_code: null,
      latency_ms: Date.now() - startedAt,
      retry: { attempted: 0, final: 'fail', last_reason: VisionUnavailabilityReason.VISION_DISABLED_BY_FLAG },
    };
  }

  const gemini = getGeminiClient();
  if (!gemini || !gemini.client) {
    const reason =
      gemini && gemini.init_error ? normalizeVisionReason(gemini.init_error) : VisionUnavailabilityReason.VISION_MISSING_KEY;
    return {
      ok: false,
      provider: 'gemini',
      reason,
      upstream_status_code: null,
      latency_ms: Date.now() - startedAt,
      retry: { attempted: 0, final: 'fail', last_reason: reason },
    };
  }

  if (!imageBuffer || !Buffer.isBuffer(imageBuffer) || !imageBuffer.length) {
    return {
      ok: false,
      provider: 'gemini',
      reason: VisionUnavailabilityReason.VISION_IMAGE_FETCH_FAILED,
      upstream_status_code: null,
      latency_ms: Date.now() - startedAt,
      retry: { attempted: 0, final: 'fail', last_reason: VisionUnavailabilityReason.VISION_IMAGE_FETCH_FAILED },
    };
  }

  const optimized =
    profiler && typeof profiler.time === 'function'
      ? await profiler.time(
          'decode',
          async () =>
            sharp(imageBuffer)
              .rotate()
              .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: 82 })
              .toBuffer(),
          { kind: 'vision_prepare' },
        )
      : await sharp(imageBuffer)
          .rotate()
          .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 82 })
          .toBuffer();

  const promptBase = buildSkinVisionPrompt({
    language,
    photoQuality,
    diagnosisPolicy,
    diagnosisV1,
    profileSummary,
    recentLogsSummary,
    promptVersion,
  });

  const attemptResult = await executeVisionWithRetry({
    maxRetries: SKIN_VISION_RETRY_MAX,
    baseDelayMs: SKIN_VISION_RETRY_BASE_MS,
    classifyError: classifyVisionProviderFailure,
    operation: async () => {
      const callGemini = async () =>
        withVisionTimeout(
          gemini.client.models.generateContent({
            model: SKIN_VISION_MODEL_GEMINI,
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    inlineData: {
                      mimeType: 'image/jpeg',
                      data: optimized.toString('base64'),
                    },
                  },
                  {
                    text: `${promptBase}\nSELF-CHECK before responding: output MUST be strict JSON (no markdown/text), match the exact keys, and end strategy with a single direct question mark.\n`,
                  },
                ],
              },
            ],
            config: {
              temperature: 0.2,
              responseMimeType: 'application/json',
            },
          }),
          SKIN_VISION_TIMEOUT_MS,
        );

      const resp =
        profiler && typeof profiler.timeLlmCall === 'function'
          ? await profiler.timeLlmCall({ provider: 'gemini', model: SKIN_VISION_MODEL_GEMINI, kind: 'skin_vision' }, callGemini)
          : await callGemini();

      const content = await extractTextFromGeminiResponse(resp);
      const jsonOnly = unwrapCodeFence(content);
      const parsedObj = parseJsonOnlyObject(jsonOnly);
      const analysis = normalizeSkinAnalysisFromLLM(parsedObj, { language });
      if (!analysis) {
        const schemaErr = new Error('vision schema invalid');
        schemaErr.__vision_reason = VisionUnavailabilityReason.VISION_SCHEMA_INVALID;
        throw schemaErr;
      }
      return { analysis };
    },
  });

  if (attemptResult && attemptResult.ok && attemptResult.result && attemptResult.result.analysis) {
    return {
      ok: true,
      provider: 'gemini',
      analysis: attemptResult.result.analysis,
      upstream_status_code: null,
      latency_ms: Date.now() - startedAt,
      retry: attemptResult.retry,
    };
  }

  return {
    ok: false,
    provider: 'gemini',
    reason: normalizeVisionReason(attemptResult && attemptResult.reason),
    upstream_status_code: toNullableInt(attemptResult && attemptResult.upstream_status_code),
    error: attemptResult && attemptResult.error_code ? String(attemptResult.error_code) : null,
    latency_ms: Date.now() - startedAt,
    retry:
      (attemptResult && attemptResult.retry) ||
      { attempted: 0, final: 'fail', last_reason: normalizeVisionReason(attemptResult && attemptResult.reason) },
  };
}

async function runVisionSkinAnalysis({ provider, ...rest } = {}) {
  const target = String(provider || 'openai')
    .trim()
    .toLowerCase();
  if (target === 'gemini') {
    return runGeminiVisionSkinAnalysis(rest);
  }
  return runOpenAIVisionSkinAnalysis(rest);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toNullableInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  if (num <= 0) return null;
  return Math.trunc(num);
}

function toNullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return num;
}

function secondsUntilIso(iso) {
  if (!iso || typeof iso !== 'string') return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round((ms - Date.now()) / 1000));
}

function pickUpstreamErrorDetail(data) {
  if (!data) return null;
  if (typeof data === 'string') return data;
  if (data.detail) return data.detail;
  if (data.error) return data.error;
  if (data.message) return data.message;
  return null;
}

function normalizeSkinAnalysisFromLLM(obj, { language } = {}) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  const o = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  if (!o) return null;

  const forbiddenRegex =
    lang === 'CN'
      ? /玫瑰痤疮|湿疹|银屑病|皮炎|感染|抗生素|激素|氢化可的松|维A酸|异维A酸|阿达帕林|克林霉素|多西环素|甲硝唑/i
      : /rosacea|eczema|psoriasis|dermatitis|melanoma|infection|antibiotic|steroid|hydrocortisone|tretinoin|adapalene|isotretinoin|accutane|clindamycin|doxycycline|metronidazole/i;

  function clampText(raw, maxLen) {
    const s = typeof raw === 'string' ? raw.trim() : '';
    if (!s) return '';
    if (s.length <= maxLen) return s;
    return `${s.slice(0, Math.max(0, maxLen - 1))}…`;
  }

  const featuresRaw = Array.isArray(o.features) ? o.features : [];
  const features = [];
  for (const raw of featuresRaw) {
    const f = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
    if (!f) continue;
    const observation = clampText(f.observation, 120);
    if (!observation) continue;
    if (forbiddenRegex.test(observation)) return null;
    const c = typeof f.confidence === 'string' ? f.confidence.trim() : '';
    const confidence = c === 'pretty_sure' || c === 'somewhat_sure' || c === 'not_sure' ? c : 'somewhat_sure';
    features.push({ observation, confidence });
  }

  let strategyRaw = clampText(o.strategy, 420);
  const needsRiskCheckRaw = o.needs_risk_check ?? o.needsRiskCheck;
  const needs_risk_check = typeof needsRiskCheckRaw === 'boolean' ? needsRiskCheckRaw : false;

  const fallbackStrategy = lang === 'CN' ? '我需要再确认一点信息：你最近是否有刺痛/泛红？' : 'Quick check: have you had stinging or redness recently?';
  if (strategyRaw) {
    const qIdx = Math.max(strategyRaw.lastIndexOf('?'), strategyRaw.lastIndexOf('？'));
    if (qIdx !== -1) strategyRaw = strategyRaw.slice(0, qIdx + 1).trim();
    // Ensure "ONE direct question": replace earlier question marks with sentence punctuation.
    if (strategyRaw) {
      const last = strategyRaw[strategyRaw.length - 1];
      const replaceWith = lang === 'CN' ? '。' : '.';
      const body = strategyRaw.slice(0, -1).replace(/[?？]/g, replaceWith);
      strategyRaw = `${body}${last}`.trim();
    }
    if (forbiddenRegex.test(strategyRaw)) return null;
  }
  const strategy = strategyRaw || fallbackStrategy;
  if (!/[?？]$/.test(strategy)) return null;

  if (features.length < 2 && !strategyRaw) return null;

  return {
    features: features.slice(0, 6),
    strategy,
    needs_risk_check,
  };
}

function mergePhotoFindingsIntoAnalysis({ analysis, diagnosisV1, language, profileSummary } = {}) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  const base = analysis && typeof analysis === 'object' && !Array.isArray(analysis) ? { ...analysis } : null;
  if (!base) return analysis;
  const diagnosis = diagnosisV1 && typeof diagnosisV1 === 'object' && !Array.isArray(diagnosisV1) ? diagnosisV1 : null;
  if (!diagnosis) return base;

  const normalizeFinding = (raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const issueType = typeof raw.issue_type === 'string' ? raw.issue_type.trim() : '';
    const subtype = typeof raw.subtype === 'string' ? raw.subtype.trim() : '';
    if (!issueType) return null;
    const severity = Number.isFinite(raw.severity) ? Math.max(0, Math.min(4, Math.round(raw.severity))) : 0;
    const confidence = Number.isFinite(raw.confidence) ? Math.max(0, Math.min(1, Number(raw.confidence))) : 0;
    return {
      issue_type: issueType,
      subtype: subtype || null,
      severity,
      confidence,
      evidence: typeof raw.evidence === 'string' ? raw.evidence.trim() : '',
      computed_features: raw.computed_features && typeof raw.computed_features === 'object' ? raw.computed_features : {},
      geometry: raw.geometry && typeof raw.geometry === 'object' ? raw.geometry : null,
      ...(raw.uncertain === true ? { uncertain: true } : {}),
    };
  };

  const normalizeTakeaway = (raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const source = typeof raw.source === 'string' && raw.source.trim() ? raw.source.trim() : 'mixed';
    const textRaw = typeof raw.text === 'string' ? raw.text.trim() : '';
    if (!textRaw) return null;
    const text =
      source === 'photo' && !/^from photo:/i.test(textRaw)
        ? `${lang === 'CN' ? 'From photo: ' : 'From photo: '}${textRaw}`
        : textRaw;
    return {
      source,
      issue_type: typeof raw.issue_type === 'string' && raw.issue_type.trim() ? raw.issue_type.trim() : null,
      text,
      confidence: Number.isFinite(raw.confidence) ? Math.max(0, Math.min(1, Number(raw.confidence))) : 0.5,
    };
  };

  const incomingFindings = [];
  for (const finding of Array.isArray(diagnosis.photo_findings) ? diagnosis.photo_findings : []) {
    const normalized = normalizeFinding(finding);
    if (normalized) incomingFindings.push(normalized);
  }

  const existingFindings = [];
  const existingFromPhoto = Array.isArray(base.photo_findings) ? base.photo_findings : [];
  const existingFromFindings = Array.isArray(base.findings) ? base.findings : [];
  for (const finding of [...existingFromPhoto, ...existingFromFindings]) {
    const normalized = normalizeFinding(finding);
    if (normalized) existingFindings.push(normalized);
  }

  const mergedFindings = [];
  const findingSeen = new Set();
  for (const finding of [...existingFindings, ...incomingFindings]) {
    const key = `${finding.issue_type}::${finding.subtype || ''}`;
    if (findingSeen.has(key)) continue;
    findingSeen.add(key);
    mergedFindings.push(finding);
  }

  if (mergedFindings.length) {
    base.photo_findings = mergedFindings.slice(0, 10);
    base.findings = mergedFindings.slice(0, 10);
  }

  const existingTakeaways = Array.isArray(base.takeaways) ? base.takeaways : [];
  const diagnosisTakeaways = Array.isArray(diagnosis.takeaways) ? diagnosis.takeaways : [];
  const mergedTakeaways = [];
  const takeawaySeen = new Set();

  const addTakeaway = (candidate) => {
    const normalized = normalizeTakeaway(candidate);
    if (!normalized) return;
    const key = `${normalized.source}::${normalized.text.toLowerCase()}`;
    if (takeawaySeen.has(key)) return;
    takeawaySeen.add(key);
    mergedTakeaways.push(normalized);
  };

  for (const takeaway of existingTakeaways) addTakeaway(takeaway);
  for (const takeaway of diagnosisTakeaways) addTakeaway(takeaway);

  const goals = profileSummary && Array.isArray(profileSummary.goals) ? profileSummary.goals.filter((item) => typeof item === 'string') : [];
  if (goals.length) {
    addTakeaway({
      source: 'user',
      issue_type: 'goal',
      text: lang === 'CN' ? `You mentioned your goals: ${goals.slice(0, 3).join(', ')}.` : `You mentioned your goals: ${goals.slice(0, 3).join(', ')}.`,
      confidence: 1,
    });
  }

  if (mergedTakeaways.length) base.takeaways = mergedTakeaways.slice(0, 12);
  return base;
}

function normalizePlanTakeaway(raw, { language } = {}) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const sourceRaw = typeof raw.source === 'string' ? raw.source.trim().toLowerCase() : '';
  const source = sourceRaw === 'photo' || sourceRaw === 'user' || sourceRaw === 'mixed' ? sourceRaw : 'mixed';
  let text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (!text) return null;
  if (source === 'photo' && !/^from photo:/i.test(text)) text = `${lang === 'CN' ? 'From photo: ' : 'From photo: '}${text}`;
  if (source === 'user' && /^you reported/i.test(text)) text = text.replace(/^you reported/i, 'You mentioned');
  return {
    takeaway_id: typeof raw.takeaway_id === 'string' && raw.takeaway_id.trim() ? raw.takeaway_id.trim() : null,
    source,
    issue_type: typeof raw.issue_type === 'string' && raw.issue_type.trim() ? raw.issue_type.trim() : null,
    text,
    confidence: Number.isFinite(raw.confidence) ? Math.max(0, Math.min(1, Number(raw.confidence))) : 0.55,
    linked_finding_ids: Array.isArray(raw.linked_finding_ids)
      ? raw.linked_finding_ids.filter((item) => typeof item === 'string' && item.trim()).slice(0, 8)
      : [],
    linked_issue_types: Array.isArray(raw.linked_issue_types)
      ? raw.linked_issue_types.filter((item) => typeof item === 'string' && item.trim()).slice(0, 8)
      : [],
  };
}

function renderPlanAsStrategy({ plan, language, photoNotice } = {}) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  if (!plan || typeof plan !== 'object') return '';
  const getWhat = (step) => (step && typeof step.what === 'string' ? step.what.trim() : '');
  const am = Array.isArray(plan?.today?.am_steps) ? plan.today.am_steps.map(getWhat).filter(Boolean) : [];
  const pm = Array.isArray(plan?.today?.pm_steps) ? plan.today.pm_steps.map(getWhat).filter(Boolean) : [];
  const pause = Array.isArray(plan?.today?.pause_now) ? plan.today.pause_now.map(getWhat).filter(Boolean) : [];
  const rule = Array.isArray(plan?.next_7_days?.rules) ? plan.next_7_days.rules.filter((item) => typeof item === 'string' && item.trim()).slice(0, 2) : [];
  const lines = [];
  if (photoNotice) lines.push(photoNotice);
  lines.push(lang === 'CN' ? 'Today' : 'Today');
  lines.push(`${lang === 'CN' ? 'AM' : 'AM'}: ${am.length ? am.join(' -> ') : (lang === 'CN' ? '以重拍和观察为主' : 'retake + observe')}`);
  lines.push(`${lang === 'CN' ? 'PM' : 'PM'}: ${pm.length ? pm.join(' -> ') : (lang === 'CN' ? '以重拍和观察为主' : 'retake + observe')}`);
  if (pause.length) lines.push(`${lang === 'CN' ? 'Pause now' : 'Pause now'}: ${pause.join(' / ')}`);
  if (rule.length) lines.push(`${lang === 'CN' ? 'Next 7 days' : 'Next 7 days'}: ${rule.join(' | ')}`);
  const retakeDays = Number.isFinite(plan?.tracking?.retake_after_days) ? Number(plan.tracking.retake_after_days) : 7;
  lines.push(lang === 'CN' ? `Re-evaluate in ${retakeDays} days.` : `Re-evaluate in ${retakeDays} days.`);
  return lines.join('\n').slice(0, 1200);
}

function normalizePhotoFailureCodeForFallback(code) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!normalized) return '';
  if (
    normalized === 'DOWNLOAD_URL_GENERATE_FAILED' ||
    normalized === 'DOWNLOAD_URL_FETCH_4XX' ||
    normalized === 'DOWNLOAD_URL_FETCH_5XX' ||
    normalized === 'DOWNLOAD_URL_TIMEOUT' ||
    normalized === 'DOWNLOAD_URL_EXPIRED' ||
    normalized === 'DOWNLOAD_URL_DNS'
  ) {
    return normalized;
  }
  return '';
}

function buildPhotoFallbackActionCard({
  language,
  qualityFail,
  failureCode,
  photosProvided,
} = {}) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  const normalizedFailure = normalizePhotoFailureCodeForFallback(failureCode);
  const reasonByCodeEn = {
    DOWNLOAD_URL_GENERATE_FAILED: "We couldn't generate a secure photo download link.",
    DOWNLOAD_URL_FETCH_4XX: "Photo access was rejected while fetching bytes (4xx).",
    DOWNLOAD_URL_FETCH_5XX: 'Photo storage returned a server error while fetching bytes (5xx).',
    DOWNLOAD_URL_TIMEOUT: 'Photo download timed out before bytes were received.',
    DOWNLOAD_URL_EXPIRED: 'The signed photo link expired before analysis could start.',
    DOWNLOAD_URL_DNS: 'Photo storage host lookup failed (DNS/network resolution).',
  };
  const reasonByCodeZh = {
    DOWNLOAD_URL_GENERATE_FAILED: '系统未能生成可用的照片下载链接。',
    DOWNLOAD_URL_FETCH_4XX: '下载照片时访问被拒绝（4xx）。',
    DOWNLOAD_URL_FETCH_5XX: '下载照片时存储服务返回服务器错误（5xx）。',
    DOWNLOAD_URL_TIMEOUT: '下载照片超时，未能及时拿到图像字节。',
    DOWNLOAD_URL_EXPIRED: '签名照片链接已过期，分析前无法继续读取。',
    DOWNLOAD_URL_DNS: '照片存储域名解析失败（DNS/网络异常）。',
  };

  let primaryReason = '';
  if (qualityFail) {
    primaryReason =
      lang === 'CN'
        ? '照片质量未通过（光线/清晰度/覆盖不足），本次无法做可靠的图像分析。'
        : 'Photo quality failed (lighting/focus/coverage), so image-based analysis is unavailable for this run.';
  } else if (normalizedFailure) {
    primaryReason = lang === 'CN' ? reasonByCodeZh[normalizedFailure] || '' : reasonByCodeEn[normalizedFailure] || '';
  } else if (photosProvided === false) {
    primaryReason = lang === 'CN' ? '本次没有可用照片，因此无法进行图像分析。' : 'No photo was provided in this run, so image-based analysis is unavailable.';
  } else {
    primaryReason =
      lang === 'CN'
        ? '本次未能成功读取照片字节，因此无法进行图像分析。'
        : "We couldn't read photo bytes for this run, so image-based analysis is unavailable.";
  }

  const guardrailReason =
    lang === 'CN'
      ? '为避免误导，本次结果仅基于问卷/历史信息，不会输出照片结论。'
      : 'To avoid misleading conclusions, this run is questionnaire/history-only.';

  const retakeGuide =
    lang === 'CN'
      ? [
          '自然光拍摄：正对窗户，避免背光与强阴影。',
          '距离 30–50cm，正脸平视，脸部占画面约 70%。',
          '关闭美颜/滤镜，确保对焦清晰且无遮挡（头发/口罩/手）。',
        ]
      : [
          'Use daylight facing a window; avoid backlight and strong shadows.',
          'Keep 30–50cm distance, straight-on angle, and face fills about 70% of frame.',
          'Turn off beauty filters, keep sharp focus, and remove obstructions (hair/mask/hand).',
        ];

  const meanwhilePlan =
    lang === 'CN'
      ? [
          '如果有刺痛或泛红：暂停潜在刺激活性 5–7 天，仅保留温和洁面 + 保湿 + 白天防晒。',
          '如果出油但同时紧绷：减少清洁强度/次数，补一层轻薄保湿。',
          '如果连续 3 天稳定：仅恢复 1 个产品，每周 1–2 次，出现不适立即停用。',
        ]
      : [
          'If stinging or redness appears: pause potentially irritating actives for 5–7 days; keep gentle cleanser + moisturizer + daytime SPF only.',
          'If skin feels oily but tight: reduce cleansing intensity/frequency and add a light moisturizer layer.',
          'If stable for 3 straight days: re-introduce only one product at 1–2 nights/week; stop immediately if irritation returns.',
        ];

  const ask3 =
    lang === 'CN'
      ? [
          '最近 72 小时是否有刺痛/灼热？通常发生在第几步之后？',
          '你当前 AM/PM 每一步具体用了什么产品？各自频率是多少？',
          '最近是否有环境变化（出差/气候/作息/压力）影响皮肤状态？',
        ]
      : [
          'Any stinging or burning in the last 72 hours, and after which routine step?',
          'What exact products are you using in AM/PM, and how often for each?',
          'Any recent environment/lifestyle shift (travel, climate, sleep, stress) affecting your skin?',
        ];

  return {
    why_i_cant_analyze: [primaryReason, guardrailReason].filter(Boolean).slice(0, 2),
    retake_guide: retakeGuide.slice(0, 3),
    meanwhile_plan: meanwhilePlan.slice(0, 3),
    ask_3_questions: ask3.slice(0, 3),
  };
}

function renderPhotoFallbackStrategy({ language, photoNotice, actionCard } = {}) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  const card = actionCard && typeof actionCard === 'object' ? actionCard : null;
  if (!card) return '';
  const lines = [];
  if (photoNotice) lines.push(photoNotice);
  lines.push(lang === 'CN' ? '为何暂时无法分析' : "Why I can't analyze");
  for (const item of Array.isArray(card.why_i_cant_analyze) ? card.why_i_cant_analyze.slice(0, 2) : []) lines.push(`- ${item}`);
  lines.push(lang === 'CN' ? '重拍指引' : 'Retake guide');
  for (const item of Array.isArray(card.retake_guide) ? card.retake_guide.slice(0, 3) : []) lines.push(`- ${item}`);
  lines.push(lang === 'CN' ? '7 天临时方案' : 'Meanwhile plan (7 days)');
  for (const item of Array.isArray(card.meanwhile_plan) ? card.meanwhile_plan.slice(0, 3) : []) lines.push(`- ${item}`);
  lines.push(lang === 'CN' ? '补充 3 个问题' : 'Ask-3 questions');
  for (const item of Array.isArray(card.ask_3_questions) ? card.ask_3_questions.slice(0, 3) : []) lines.push(`- ${item}`);
  return lines.join('\n').slice(0, 1200);
}

function clampGeometry01(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  if (numeric <= 0) return 0;
  if (numeric >= 1) return 1;
  return numeric;
}

function sanitizeBBoxNorm(rawBBox) {
  if (!rawBBox || typeof rawBBox !== 'object') return { ok: false, clipped: false, bbox: null };
  const raw = {
    x0: Number(rawBBox.x0),
    y0: Number(rawBBox.y0),
    x1: Number(rawBBox.x1),
    y1: Number(rawBBox.y1),
  };
  if (!Number.isFinite(raw.x0) || !Number.isFinite(raw.y0) || !Number.isFinite(raw.x1) || !Number.isFinite(raw.y1)) {
    return { ok: false, clipped: false, bbox: null };
  }

  const clamped = {
    x0: clampGeometry01(raw.x0),
    y0: clampGeometry01(raw.y0),
    x1: clampGeometry01(raw.x1),
    y1: clampGeometry01(raw.y1),
  };
  let clipped =
    clamped.x0 !== raw.x0 ||
    clamped.y0 !== raw.y0 ||
    clamped.x1 !== raw.x1 ||
    clamped.y1 !== raw.y1;

  const ordered = {
    x0: Math.min(clamped.x0, clamped.x1),
    y0: Math.min(clamped.y0, clamped.y1),
    x1: Math.max(clamped.x0, clamped.x1),
    y1: Math.max(clamped.y0, clamped.y1),
  };
  if (ordered.x0 !== clamped.x0 || ordered.y0 !== clamped.y0 || ordered.x1 !== clamped.x1 || ordered.y1 !== clamped.y1) {
    clipped = true;
  }

  if (ordered.x1 - ordered.x0 <= 0.001 || ordered.y1 - ordered.y0 <= 0.001) {
    return { ok: false, clipped: true, bbox: null };
  }
  return { ok: true, clipped, bbox: ordered };
}

function sanitizeGridGeometry(rawGeometry) {
  if (!rawGeometry || typeof rawGeometry !== 'object') return { ok: false, clipped: false, grid: null };
  const rawRows = Number(rawGeometry.rows);
  const rawCols = Number(rawGeometry.cols);
  const rawValues = Array.isArray(rawGeometry.values) ? rawGeometry.values : null;
  if (!Number.isFinite(rawRows) || !Number.isFinite(rawCols) || !rawValues) {
    return { ok: false, clipped: false, grid: null };
  }

  const rows = Math.max(1, Math.min(64, Math.trunc(rawRows)));
  const cols = Math.max(1, Math.min(64, Math.trunc(rawCols)));
  const expected = rows * cols;
  let clipped = rows !== rawRows || cols !== rawCols;
  if (rawValues.length < expected) {
    return { ok: false, clipped: true, grid: null };
  }

  const values = rawValues.slice(0, expected).map((item) => {
    const numeric = Number(item);
    if (!Number.isFinite(numeric)) {
      clipped = true;
      return 0;
    }
    const normalized = clampGeometry01(numeric);
    if (normalized !== numeric) clipped = true;
    return normalized;
  });
  return {
    ok: true,
    clipped,
    grid: {
      type: 'grid',
      rows,
      cols,
      values,
    },
  };
}

function sanitizeFindingGeometry(rawGeometry) {
  if (!rawGeometry || typeof rawGeometry !== 'object') {
    return { geometry: null, checked_n: 0, dropped_n: 0, clipped_n: 0 };
  }

  let checked = 0;
  let dropped = 0;
  let clipped = 0;
  const geometry = {};
  let hasGeometry = false;

  if (rawGeometry.bbox_norm && typeof rawGeometry.bbox_norm === 'object') {
    checked += 1;
    const bbox = sanitizeBBoxNorm(rawGeometry.bbox_norm);
    if (bbox.ok && bbox.bbox) {
      geometry.bbox_norm = bbox.bbox;
      hasGeometry = true;
    } else {
      dropped += 1;
    }
    if (bbox.clipped) clipped += 1;
  }

  if (
    rawGeometry.type === 'grid' ||
    (Number.isFinite(Number(rawGeometry.rows)) && Number.isFinite(Number(rawGeometry.cols)) && Array.isArray(rawGeometry.values))
  ) {
    checked += 1;
    const grid = sanitizeGridGeometry(rawGeometry);
    if (grid.ok && grid.grid) {
      geometry.type = 'grid';
      geometry.rows = grid.grid.rows;
      geometry.cols = grid.grid.cols;
      geometry.values = grid.grid.values;
      hasGeometry = true;
    } else {
      dropped += 1;
    }
    if (grid.clipped) clipped += 1;
  }

  return {
    geometry: hasGeometry ? geometry : null,
    checked_n: checked,
    dropped_n: dropped,
    clipped_n: clipped,
  };
}

function mergeGeometrySanitizerByIssue(target, issueType, stats) {
  const issue = String(issueType || 'unknown').trim().toLowerCase() || 'unknown';
  if (!target[issue]) {
    target[issue] = { checked_n: 0, dropped_n: 0, clipped_n: 0, fixed_n: 0 };
  }
  target[issue].checked_n += Number(stats.checked_n || 0);
  target[issue].dropped_n += Number(stats.dropped_n || 0);
  target[issue].clipped_n += Number(stats.clipped_n || 0);
  target[issue].fixed_n += Number(stats.fixed_n != null ? stats.fixed_n : stats.clipped_n || 0);
}

function buildExecutablePlanForAnalysis({
  analysis,
  language,
  usedPhotos,
  photoQuality,
  profileSummary,
  photoNoticeOverride,
  photoFailureCode,
  photosProvided,
} = {}) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  const base = analysis && typeof analysis === 'object' && !Array.isArray(analysis) ? { ...analysis } : null;
  if (!base) return analysis;

  const quality = photoQuality && typeof photoQuality === 'object' ? photoQuality : { grade: 'unknown', reasons: [] };
  const qualityFail = String(quality.grade || '').trim().toLowerCase() === 'fail';
  const fallbackMode = qualityFail || !usedPhotos;
  const defaultPhotoNotice = qualityFail
    ? lang === 'CN'
      ? '照片质量未通过，本次仅基于问卷/历史信息给出临时建议。'
      : 'Photo quality failed, so this run uses questionnaire/history only.'
    : usedPhotos
      ? null
      : 'Based on your answers only (photo not analyzed).';
  const overrideNotice = typeof photoNoticeOverride === 'string' ? photoNoticeOverride.trim() : '';
  const photoNotice = overrideNotice ? [overrideNotice, defaultPhotoNotice].filter(Boolean).join(' ') : defaultPhotoNotice;

  const findingsInput = usedPhotos && !qualityFail
    ? Array.isArray(base.photo_findings)
      ? base.photo_findings
      : Array.isArray(base.findings)
        ? base.findings
        : []
    : [];
  const geometrySanitizer = {
    checked_n: 0,
    dropped_n: 0,
    clipped_n: 0,
    fixed_n: 0,
    by_issue: {},
  };
  const photoFindings = [];
  const issueToFindingIds = new Map();
  for (let i = 0; i < findingsInput.length; i += 1) {
    const finding = findingsInput[i];
    if (!finding || typeof finding !== 'object') continue;
    const issueType = typeof finding.issue_type === 'string' ? finding.issue_type.trim() : '';
    if (!issueType) continue;
    const findingIdRaw = typeof finding.finding_id === 'string' && finding.finding_id.trim() ? finding.finding_id.trim() : `pf_${issueType}_${i + 1}`;
    const geometryStats = sanitizeFindingGeometry(finding.geometry);
    geometrySanitizer.checked_n += Number(geometryStats.checked_n || 0);
    geometrySanitizer.dropped_n += Number(geometryStats.dropped_n || 0);
    geometrySanitizer.clipped_n += Number(geometryStats.clipped_n || 0);
    geometrySanitizer.fixed_n += Number(geometryStats.clipped_n || 0);
    if (Number(geometryStats.checked_n || 0) > 0) {
      mergeGeometrySanitizerByIssue(geometrySanitizer.by_issue, issueType, {
        checked_n: geometryStats.checked_n,
        dropped_n: geometryStats.dropped_n,
        clipped_n: geometryStats.clipped_n,
        fixed_n: geometryStats.clipped_n,
      });
    }
    const normalizedFinding = {
      finding_id: findingIdRaw,
      issue_type: issueType,
      subtype: typeof finding.subtype === 'string' && finding.subtype.trim() ? finding.subtype.trim() : null,
      severity: Number.isFinite(finding.severity) ? Math.max(0, Math.min(4, Math.round(finding.severity))) : 0,
      confidence: Number.isFinite(finding.confidence) ? Math.max(0, Math.min(1, Number(finding.confidence))) : 0,
      evidence: typeof finding.evidence === 'string' ? finding.evidence.trim() : '',
      computed_features: finding.computed_features && typeof finding.computed_features === 'object' ? finding.computed_features : {},
      geometry: geometryStats.geometry,
      ...(finding.uncertain === true ? { uncertain: true } : {}),
    };
    photoFindings.push(normalizedFinding);
    const list = issueToFindingIds.get(issueType) || [];
    list.push(findingIdRaw);
    issueToFindingIds.set(issueType, list);
  }
  base.photo_findings = photoFindings;
  base.findings = photoFindings;
  if (usedPhotos && !qualityFail && photoFindings.length) {
    const evidenceRegions = [];
    for (const finding of photoFindings) {
      const geometry = finding && finding.geometry && typeof finding.geometry === 'object' ? finding.geometry : null;
      if (!geometry) continue;
      if (geometry.bbox_norm && typeof geometry.bbox_norm === 'object') {
        evidenceRegions.push({
          concern_type: finding.issue_type,
          severity: finding.severity,
          confidence: finding.confidence,
          region: { kind: 'bbox', bbox_norm: geometry.bbox_norm },
          evidence_text: finding.evidence || '',
        });
      }
      if (
        geometry.type === 'grid' &&
        Number.isFinite(Number(geometry.rows)) &&
        Number.isFinite(Number(geometry.cols)) &&
        Array.isArray(geometry.values)
      ) {
        const rows = Math.max(1, Math.min(64, Math.trunc(Number(geometry.rows))));
        const cols = Math.max(1, Math.min(64, Math.trunc(Number(geometry.cols))));
        const values = geometry.values
          .slice(0, rows * cols)
          .map((value) => (Number.isFinite(Number(value)) ? Math.max(0, Math.min(1, Number(value))) : 0));
        if (values.length === rows * cols) {
          evidenceRegions.push({
            concern_type: finding.issue_type,
            severity: finding.severity,
            confidence: finding.confidence,
            region: { kind: 'heatmap', rows, cols, values },
            evidence_text: finding.evidence || '',
          });
        }
      }
    }
    if (evidenceRegions.length) base.evidence_regions = evidenceRegions.slice(0, 48);
    else delete base.evidence_regions;
  } else {
    delete base.evidence_regions;
  }

  const takeawaysInput = Array.isArray(base.takeaways) ? base.takeaways : [];
  const takeaways = [];
  const seenTakeawayText = new Set();
  for (const item of takeawaysInput) {
    const normalized = normalizePlanTakeaway(item, { language: lang });
    if (!normalized) continue;
    if (fallbackMode && normalized.source === 'photo') continue;
    if (normalized.source === 'photo' && normalized.linked_finding_ids.length === 0 && normalized.issue_type) {
      normalized.linked_finding_ids = (issueToFindingIds.get(normalized.issue_type) || []).slice(0, 8);
    }
    if (normalized.source === 'photo' && normalized.linked_issue_types.length === 0 && normalized.issue_type) {
      normalized.linked_issue_types = [normalized.issue_type];
    }
    const key = `${normalized.source}:${normalized.text.toLowerCase()}`;
    if (seenTakeawayText.has(key)) continue;
    seenTakeawayText.add(key);
    takeaways.push(normalized);
  }

  if (!fallbackMode) {
    const goals = profileSummary && Array.isArray(profileSummary.goals) ? profileSummary.goals.filter((item) => typeof item === 'string' && item.trim()) : [];
    if (goals.length) {
      const text = `You mentioned your goals: ${goals.slice(0, 3).join(', ')}.`;
      const key = `user:${text.toLowerCase()}`;
      if (!seenTakeawayText.has(key)) {
        takeaways.push({
          takeaway_id: 'tw_user_goals_plan',
          source: 'user',
          issue_type: 'goal',
          text,
          confidence: 1,
          linked_finding_ids: [],
          linked_issue_types: ['goal'],
        });
        seenTakeawayText.add(key);
      }
    }
    if (profileSummary && profileSummary.barrierStatus === 'impaired') {
      const text = 'You mentioned stinging/redness and barrier stress recently.';
      const key = `user:${text.toLowerCase()}`;
      if (!seenTakeawayText.has(key)) {
        takeaways.push({
          takeaway_id: 'tw_user_barrier_stress',
          source: 'user',
          issue_type: 'barrier',
          text,
          confidence: 0.9,
          linked_finding_ids: [],
          linked_issue_types: ['barrier'],
        });
        seenTakeawayText.add(key);
      }
    }
  }

  if (usedPhotos && !qualityFail && photoFindings.length) {
    for (const finding of photoFindings) {
      const alreadyLinked = takeaways.some((item) => item.source === 'photo' && item.linked_finding_ids.includes(finding.finding_id));
      if (alreadyLinked) continue;
      takeaways.push({
        takeaway_id: `tw_photo_${finding.finding_id}`,
        source: 'photo',
        issue_type: finding.issue_type,
        text: `From photo: ${finding.issue_type} signal observed in the highlighted area.`,
        confidence: finding.confidence,
        linked_finding_ids: [finding.finding_id],
        linked_issue_types: [finding.issue_type],
      });
    }
  }

  const takeawaysByIssue = new Map();
  for (const item of takeaways) {
    if (!item.issue_type) continue;
    const list = takeawaysByIssue.get(item.issue_type) || [];
    list.push(item.takeaway_id);
    takeawaysByIssue.set(item.issue_type, list);
  }

  const makeStep = ({ what, why, whenToStop, priority, linkedIssueTypes = [], linkedFindingIds = [] } = {}) => ({
    what: String(what || '').trim(),
    why: String(why || '').trim(),
    when_to_stop: String(whenToStop || '').trim(),
    priority: priority === 'P0' || priority === 'P1' || priority === 'P2' ? priority : 'P1',
    linked_issue_types: linkedIssueTypes.filter((item) => typeof item === 'string' && item.trim()).slice(0, 6),
    linked_finding_ids: linkedFindingIds.filter((item) => typeof item === 'string' && item.trim()).slice(0, 8),
    linked_takeaway_ids: linkedIssueTypes
      .flatMap((issueType) => (takeawaysByIssue.get(issueType) || []).filter((item) => typeof item === 'string' && item.trim()))
      .slice(0, 8),
  });

  const requiredCheckboxes = [
    { metric: 'redness_stinging', label: 'redness/stinging', options: ['↓', '→', '↑'] },
    { metric: 'new_breakouts', label: 'new breakouts', options: ['↓', '→', '↑'] },
    { metric: 'shine_oil_control', label: 'shine/oil control', options: ['↓', '→', '↑'] },
  ];

  let plan = null;
  let fallbackActionCard = null;
  if (fallbackMode) {
    fallbackActionCard = buildPhotoFallbackActionCard({
      language: lang,
      qualityFail,
      failureCode: photoFailureCode,
      photosProvided,
    });
    plan = {
      today: {
        am_steps: [],
        pm_steps: [],
        pause_now: [
          makeStep({
            what:
              lang === 'CN'
                ? '按重拍指引补拍一张照片（自然光、无遮挡、无滤镜）。'
                : 'Retake one photo using the retake guide (daylight, unobstructed, no filter).',
            why: (fallbackActionCard.why_i_cant_analyze && fallbackActionCard.why_i_cant_analyze[0]) || '',
            whenToStop:
              lang === 'CN'
                ? '连续 2 次仍不通过时，先继续问卷流程并稍后再拍。'
                : 'If QC still fails after 2 attempts, continue with questionnaire flow and retry later.',
            priority: 'P0',
            linkedIssueTypes: ['quality'],
            linkedFindingIds: [],
          }),
        ],
      },
      next_7_days: {
        rules:
          lang === 'CN'
            ? ['在照片不可用期间，先执行保守的 7 天临时方案。', '尽快重拍并通过 QC 后再恢复照片分析。']
            : ['Use a conservative 7-day temporary plan while photo evidence is unavailable.', 'Retake as soon as possible and resume photo analysis after QC passes.'],
        steps: [
          makeStep({
            what: fallbackActionCard.meanwhile_plan[0] || '',
            why:
              lang === 'CN'
                ? '先控制刺激风险，避免在证据不足时过度调整。'
                : 'Control irritation risk first while evidence is incomplete.',
            whenToStop:
              lang === 'CN'
                ? '若刺痛/泛红连续减轻 3 天可进入下一步。'
                : 'Move to next step after 3 consecutive days of stable or improved comfort.',
            priority: 'P0',
            linkedIssueTypes: ['fallback'],
            linkedFindingIds: [],
          }),
          makeStep({
            what: fallbackActionCard.meanwhile_plan[1] || '',
            why:
              lang === 'CN'
                ? '先修正清洁和保湿平衡，降低“外油内干”波动。'
                : 'Re-balance cleansing and hydration to reduce rebound fluctuations.',
            whenToStop:
              lang === 'CN'
                ? '若紧绷/泛红加重，继续简化并暂停新增产品。'
                : 'If tightness/redness worsens, simplify further and pause new products.',
            priority: 'P1',
            linkedIssueTypes: ['fallback'],
            linkedFindingIds: [],
          }),
          makeStep({
            what: fallbackActionCard.meanwhile_plan[2] || '',
            why:
              lang === 'CN'
                ? '通过低频恢复来确认耐受，避免一次叠加多个变化。'
                : 'Low-frequency reintroduction helps verify tolerance without stacking changes.',
            whenToStop:
              lang === 'CN'
                ? '出现持续不适时，回到“仅基础三步”并等待复拍结果。'
                : 'If persistent discomfort returns, revert to basic 3-step care and wait for retake results.',
            priority: 'P1',
            linkedIssueTypes: ['fallback'],
            linkedFindingIds: [],
          }),
        ],
      },
      after_calm: {
        entry_criteria:
          lang === 'CN'
            ? ['照片 QC 至少达到 pass/degraded。', '可重复同一光线与角度。']
            : ['Photo QC reaches pass/degraded.', 'Same lighting and angle are reproducible.'],
        steps: [],
      },
      tracking: {
        checkboxes: requiredCheckboxes,
        retake_prompt:
          lang === 'CN'
            ? '7 天内按同一光线/角度重拍，并遵循重拍指引。'
            : 'Retake within 7 days with the same lighting/angle and follow the retake guide.',
        retake_after_days: 7,
      },
    };
  } else {
    const rednessFindingIds = issueToFindingIds.get('redness') || [];
    const shineFindingIds = issueToFindingIds.get('shine') || [];
    const textureFindingIds = issueToFindingIds.get('texture') || [];
    const toneFindingIds = issueToFindingIds.get('tone') || [];
    const hasRedness = rednessFindingIds.length > 0;
    const hasShine = shineFindingIds.length > 0;
    const hasTexture = textureFindingIds.length > 0;
    const hasTone = toneFindingIds.length > 0;

    const amSteps = [
      makeStep({
        what: 'Use gentle cleanser, then moisturizer.',
        why: hasRedness ? `Linked evidence: ${rednessFindingIds.join(', ')} (photo redness) and barrier-related takeaways.` : 'Linked evidence: user-input sensitivity/barrier context.',
        whenToStop: 'Stop if burning >10 minutes or persistent stinging.',
        priority: 'P0',
        linkedIssueTypes: hasRedness ? ['redness'] : ['barrier'],
        linkedFindingIds: rednessFindingIds,
      }),
      makeStep({
        what: 'Apply broad-spectrum SPF as last AM step.',
        why: hasTone ? `Linked evidence: ${toneFindingIds.join(', ')} (uneven tone proxy).` : 'Linked evidence: prevention baseline and user goals.',
        whenToStop: 'Stop only if rash or swelling appears.',
        priority: 'P0',
        linkedIssueTypes: hasTone ? ['tone'] : ['goal'],
        linkedFindingIds: toneFindingIds,
      }),
    ];

    const pmSteps = [
      makeStep({
        what: 'Cleanse gently and moisturize; keep PM routine simple for 7 days.',
        why: hasRedness ? `Linked evidence: ${rednessFindingIds.join(', ')} indicates irritation risk.` : 'Linked evidence: user-reported sensitivity context.',
        whenToStop: 'Stop and simplify further if redness/stinging increases for 2 consecutive days.',
        priority: 'P0',
        linkedIssueTypes: hasRedness ? ['redness'] : ['barrier'],
        linkedFindingIds: rednessFindingIds,
      }),
    ];

    if (hasShine || hasTexture) {
      pmSteps.push(
        makeStep({
          what: 'If skin stays calm for 3 nights, add one low-frequency balancing step (2 nights/week).',
          why: `Linked evidence: ${(hasTexture ? textureFindingIds : shineFindingIds).join(', ')} supports oil/texture control.`,
          whenToStop: 'Stop if peeling, burning, or new diffuse redness appears.',
          priority: 'P1',
          linkedIssueTypes: hasTexture ? ['texture'] : ['shine'],
          linkedFindingIds: hasTexture ? textureFindingIds : shineFindingIds,
        }),
      );
    }

    const pauseNow = [];
    if (hasRedness) {
      pauseNow.push(
        makeStep({
          what: 'Pause layering multiple strong actives on the same night.',
          why: `Linked evidence: ${rednessFindingIds.join(', ')} and photo-linked irritation takeaways.`,
          whenToStop: 'Resume only after 3 consecutive days with redness/stinging not increasing.',
          priority: 'P0',
          linkedIssueTypes: ['redness'],
          linkedFindingIds: rednessFindingIds,
        }),
      );
    }

    const nextSteps = [
      makeStep({
        what: 'Keep one-variable-at-a-time changes across the next 7 days.',
        why: 'Linked evidence: mixed uncertainty from photo + user signals requires controlled iteration.',
        whenToStop: 'Stop adding new steps if any metric trends upward for 2 days.',
        priority: 'P0',
        linkedIssueTypes: ['mixed'],
        linkedFindingIds: [...rednessFindingIds, ...shineFindingIds, ...textureFindingIds, ...toneFindingIds].slice(0, 8),
      }),
    ];
    if (hasShine) {
      nextSteps.push(
        makeStep({
          what: 'Track midday shine and reduce occlusive layering if shine worsens.',
          why: `Linked evidence: ${shineFindingIds.join(', ')} (shine/specular proxy).`,
          whenToStop: 'Stop reduction if tightness or flaking increases.',
          priority: 'P1',
          linkedIssueTypes: ['shine'],
          linkedFindingIds: shineFindingIds,
        }),
      );
    }

    const afterCalmSteps = [];
    if (hasTexture || hasTone) {
      afterCalmSteps.push(
        makeStep({
          what: 'After skin is calm, add one targeted step and reassess after 7 days.',
          why: `Linked evidence: ${[...textureFindingIds, ...toneFindingIds].join(', ')} and corresponding takeaways.`,
          whenToStop: 'Stop targeted step if irritation rises or breakouts increase.',
          priority: 'P2',
          linkedIssueTypes: [...(hasTexture ? ['texture'] : []), ...(hasTone ? ['tone'] : [])],
          linkedFindingIds: [...textureFindingIds, ...toneFindingIds],
        }),
      );
    }

    plan = {
      today: {
        am_steps: amSteps,
        pm_steps: pmSteps,
        pause_now: pauseNow,
      },
      next_7_days: {
        rules: [
          'Keep routine changes incremental (one new variable at a time).',
          usedPhotos ? 'Use current photo findings as baseline and compare after retake.' : 'Use symptom trend checkboxes as baseline until photo is provided.',
        ],
        steps: nextSteps,
      },
      after_calm: {
        entry_criteria: ['redness/stinging trend is ↓ or stable for 3 days', 'no sudden breakout spike', 'routine feels tolerable daily'],
        steps: afterCalmSteps,
      },
      tracking: {
        checkboxes: requiredCheckboxes,
        retake_prompt: 'Retake in 7 days with the same lighting, angle, and camera distance; follow QC guidance before submit.',
        retake_after_days: 7,
      },
    };
  }

  base.plan = plan;
  if (fallbackMode) {
    base.photo_findings = [];
    base.findings = [];
    base.takeaways = [];
    base.features = (fallbackActionCard.why_i_cant_analyze || []).map((text, index) => ({
      observation: text,
      confidence: index === 0 ? 'pretty_sure' : 'somewhat_sure',
    }));
    base.next_action_card = fallbackActionCard;
    base.strategy = renderPhotoFallbackStrategy({ language: lang, photoNotice, actionCard: fallbackActionCard });
  } else {
    base.takeaways = takeaways.slice(0, 14);
    delete base.next_action_card;
    base.strategy = renderPlanAsStrategy({ plan, language: lang, photoNotice });
  }
  if (photoNotice) base.photo_notice = photoNotice;
  else delete base.photo_notice;
  if (fallbackMode && Array.isArray(fallbackActionCard.ask_3_questions)) {
    base.ask_3_questions = fallbackActionCard.ask_3_questions.slice(0, 3);
  } else {
    delete base.ask_3_questions;
  }
  if (fallbackMode && Array.isArray(fallbackActionCard.retake_guide)) {
    base.retake_guide = fallbackActionCard.retake_guide.slice(0, 3);
  } else {
    delete base.retake_guide;
  }
  const geometryByIssue = {};
  for (const issueType of Object.keys(geometrySanitizer.by_issue).sort((a, b) => a.localeCompare(b))) {
    const raw = geometrySanitizer.by_issue[issueType] || {};
    geometryByIssue[issueType] = {
      checked_n: Number(raw.checked_n || 0),
      dropped_n: Number(raw.dropped_n || 0),
      clipped_n: Number(raw.clipped_n || 0),
      fixed_n: Number(raw.fixed_n || 0),
    };
  }
  base.__geometry_sanitizer = {
    checked_n: Number(geometrySanitizer.checked_n || 0),
    dropped_n: Number(geometrySanitizer.dropped_n || 0),
    clipped_n: Number(geometrySanitizer.clipped_n || 0),
    fixed_n: Number(geometrySanitizer.fixed_n || 0),
    by_issue: geometryByIssue,
  };
  return base;
}

function buildRuleBasedSkinAnalysis({ profile, recentLogs, language }) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  const p = profile || {};
  const goals = Array.isArray(p.goals) ? p.goals : [];
  const routineRaw = p.currentRoutine;
  const routineText =
    typeof routineRaw === 'string'
      ? routineRaw
      : routineRaw && typeof routineRaw === 'object'
        ? JSON.stringify(routineRaw)
        : '';
  const routineTextLower = String(routineText || '').toLowerCase();

  const hasStingingSignal =
    /\bsting\b|\bstinging\b|\bburn\b|\bburning\b|\birritat|\bredness\b|\bflak|\bpeel/.test(routineTextLower);

  const features = [];
  if (p.barrierStatus === 'impaired') {
    features.push({
      observation:
        lang === 'CN'
          ? '你提到最近屏障不稳定（易刺痛/泛红）→ 先把“舒缓修护”放在优先级第一。'
          : 'You mentioned recent barrier stress (stinging/redness) -> prioritize calming + repair first.',
      confidence: 'pretty_sure',
    });
  } else if (hasStingingSignal) {
    features.push({
      observation:
        lang === 'CN'
          ? '你提到最近有刺痛/泛红/脱皮信号 → 先按“屏障压力”处理，建议先降阶与简化。'
          : 'You mentioned stinging/redness/flaking signals → treat this as barrier stress and simplify first.',
      confidence: 'somewhat_sure',
    });
  }
  if (p.skinType === 'oily' || p.skinType === 'combination') {
    features.push({
      observation:
        lang === 'CN'
          ? '偏油/混油更容易出现堵塞与闭口，但也可能“外油内干”，不要过度清洁。'
          : 'Oily/combination skin is more clog-prone; avoid over-cleansing (oiliness can still be dehydration).',
      confidence: 'somewhat_sure',
    });
  }
  if (p.sensitivity === 'high') {
    features.push({
      observation:
        lang === 'CN'
          ? '敏感度偏高时，活性成分需要更慢的引入节奏（频率/浓度/叠加要保守）。'
          : 'If sensitivity is high, introduce actives slowly (frequency/strength/stacking should be conservative).',
      confidence: 'pretty_sure',
    });
  }
  const wantsPores = goals.includes('pores');
  const wantsAcne = goals.includes('acne');
  if (wantsPores || wantsAcne) {
    const targetText =
      wantsPores && wantsAcne
        ? lang === 'CN'
          ? '毛孔/控痘'
          : 'pores + acne'
        : wantsPores
          ? lang === 'CN'
            ? '毛孔/纹理'
            : 'pores/texture'
          : lang === 'CN'
            ? '控痘'
            : 'acne';
    features.push({
      observation:
        lang === 'CN'
          ? `你的目标包含${targetText} → 后续更适合“温和去角质 + 控油”路线，但要以不刺激为前提。`
          : `Your goals include ${targetText} → gentle exfoliation + oil control may help later, if tolerated.`,
      confidence: 'somewhat_sure',
    });
  }

  // Very light routine heuristic: only surface broad safety signals (no brand recommendations).
  if (routineTextLower) {
    const hasRetinoid = /\bretinol\b|\badapalene\b|\btretinoin\b|\bretinoid\b/.test(routineTextLower);
    const hasExfoliatingAcid =
      /\bglycolic\b|\blactic\b|\bmandelic\b|\bsalicylic\b|\bbha\b|\baha\b/.test(routineTextLower);
    const hasBpo = /\bbenzoyl\b|\bbpo\b/.test(routineTextLower);
    const hasHighStrengthVitC = /\bascorbic\b|\bl-ascorbic\b|\bvitamin c\b|\bhigh[- ]?strength\b/.test(routineTextLower);
    if (hasRetinoid || hasExfoliatingAcid || hasBpo) {
      const actives = [
        ...(hasRetinoid ? [lang === 'CN' ? '维A类' : 'retinoid'] : []),
        ...(hasExfoliatingAcid ? [lang === 'CN' ? '酸类' : 'acids'] : []),
        ...(hasBpo ? [lang === 'CN' ? '过氧化苯甲酰(BPO)' : 'benzoyl peroxide (BPO)'] : []),
      ];
      features.push({
        observation:
          lang === 'CN'
            ? `你当前 routine 里包含 ${actives.join(' / ')} → 先避免叠加、从低频开始，降低刺激风险。`
            : `Your current routine includes ${actives.join(' / ')} → avoid stacking and start low-frequency to reduce irritation risk.`,
        confidence: 'somewhat_sure',
      });
    }

    if (hasRetinoid && hasStingingSignal) {
      features.push({
        observation:
          lang === 'CN'
            ? '你提到用维A后会刺痛 → 常见原因是频率过高/叠加刺激/屏障压力；先暂停几晚再用更低频。'
            : 'Stinging after a retinoid often means frequency/stacking is too aggressive; pause a few nights and restart lower.',
        confidence: 'somewhat_sure',
      });
    }

    if (hasExfoliatingAcid && hasHighStrengthVitC && (p.barrierStatus === 'impaired' || hasStingingSignal)) {
      features.push({
        observation:
          lang === 'CN'
            ? '酸类 + 高浓 VC 同期叠加在屏障压力期更容易刺激 → 建议分开天用或先停一类。'
            : 'Acids + high-strength vitamin C can be harsh during barrier stress → separate days or pause one active.',
        confidence: 'somewhat_sure',
      });
    }
  }

  const latest = Array.isArray(recentLogs) && recentLogs[0] ? recentLogs[0] : null;
  if (latest && (typeof latest.redness === 'number' || typeof latest.acne === 'number' || typeof latest.hydration === 'number')) {
    const redness = typeof latest.redness === 'number' ? latest.redness : null;
    const acne = typeof latest.acne === 'number' ? latest.acne : null;
    const hydration = typeof latest.hydration === 'number' ? latest.hydration : null;
    const parts = [];
    if (redness != null) parts.push(lang === 'CN' ? `泛红 ${redness}/5` : `redness ${redness}/5`);
    if (acne != null) parts.push(lang === 'CN' ? `痘痘 ${acne}/5` : `acne ${acne}/5`);
    if (hydration != null) parts.push(lang === 'CN' ? `补水 ${hydration}/5` : `hydration ${hydration}/5`);
    if (parts.length) {
      features.push({
        observation:
          lang === 'CN'
            ? `你最近一次打卡：${parts.join(' · ')}（我会按这个趋势给建议）。`
            : `Latest check-in: ${parts.join(' · ')} (I’ll tailor advice to this trend).`,
        confidence: 'pretty_sure',
      });
    }
  }

  const goalText = goals.map((g) => String(g || '').trim().toLowerCase()).filter(Boolean);
  const wantsPoresOrAcne = goalText.includes('pores') || goalText.includes('acne');
  const wantsWrinkles = goalText.includes('wrinkles') || goalText.includes('anti-aging') || goalText.includes('aging');

  const plan = [];
  if (lang === 'CN') {
    plan.push('少而稳：温和洁面 + 保湿 + 白天 SPF。');
    plan.push(
      p.barrierStatus === 'impaired' || hasStingingSignal
        ? '若刺痛/泛红：先停 5–7 天强刺激活性（酸/高浓 VC/维A），以修护为主。'
        : '活性只引入 1 个：从低频（每周 1–2 次）开始，观察 72 小时。'
    );
    plan.push(
      wantsPoresOrAcne
        ? '毛孔/闭口：等皮肤稳定后再从每周 2 次开始，别和维A同晚叠加。'
        : wantsWrinkles
          ? '细纹/抗老：优先 SPF + 补水；维A等稳定后再慢慢加。'
          : '如果你愿意，我可以先按“最少新增”给你一个 3–4 步 AM/PM 框架。'
    );
  } else {
    plan.push('Keep it minimal: gentle cleanser + moisturizer + daytime SPF.');
    plan.push(
      p.barrierStatus === 'impaired' || hasStingingSignal
        ? 'If stinging/redness: pause strong actives for 5–7 days (acids/high-strength vitamin C/retinoids) and focus on repair.'
        : 'Introduce only ONE active at a time: start 1–2×/week and watch the 72h response.'
    );
    plan.push(
      wantsPoresOrAcne
        ? 'For pores/texture: wait until calm, then start 2×/week; avoid stacking with a retinoid on the same night.'
        : wantsWrinkles
          ? 'For fine lines: prioritize SPF + hydration; consider retinoid only after skin feels stable.'
          : 'If you want, I can draft a minimal 3–4 step AM/PM framework with minimal new purchases.'
    );
  }

  const question =
    lang === 'CN'
      ? /\bretinol\b|\badapalene\b|\btretinoin\b|\bretinoid\b/.test(routineTextLower)
        ? '你现在维A大概每周用几晚？会不会和酸/VC同晚叠加？'
        : '你最近有刺痛或泛红吗？'
      : /\bretinol\b|\badapalene\b|\btretinoin\b|\bretinoid\b/.test(routineTextLower)
        ? 'How many nights/week are you using your retinoid, and are you stacking it with acids/vitamin C?'
        : 'Any stinging or redness recently?';

  const strategy = `${lang === 'CN' ? '接下来 7 天建议：' : 'Next 7 days:'}\n1) ${plan[0]}\n2) ${plan[1]}\n3) ${plan[2]}\n\n${question}`;

  return {
    features: features.slice(0, 6),
    strategy: strategy.slice(0, 1200),
    needs_risk_check: false,
  };
}

function buildLowConfidenceBaselineSkinAnalysis({ profile, language }) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  const p = profile || {};
  const goals = Array.isArray(p.goals) ? p.goals : [];

  const features = [];
  if (p.barrierStatus === 'impaired') {
    features.push({
      observation:
        lang === 'CN'
          ? '你提到屏障可能不稳定 → 建议先走“舒缓修护”优先路线。'
          : 'You may have a stressed barrier → prioritize calming + repair first.',
      confidence: 'somewhat_sure',
    });
  }
  if (p.skinType) {
    features.push({
      observation:
        lang === 'CN'
          ? `你提到肤质为 ${String(p.skinType)} → 我会先给“低风险通用策略”。`
          : `You mentioned ${String(p.skinType)} skin -> I’ll start with low-risk baseline guidance.`,
      confidence: 'somewhat_sure',
    });
  }
  if (goals.length) {
    features.push({
      observation:
        lang === 'CN'
          ? `你的目标包含 ${goals.slice(0, 2).join(' / ')} → 但在缺少更多输入时只能给方向性建议。`
          : `Your goals include ${goals.slice(0, 2).join(' / ')} → but without more inputs I can only give directional guidance.`,
      confidence: 'not_sure',
    });
  }

  const strategy =
    lang === 'CN'
      ? '当前信息不足（缺少你正在用的产品/步骤），我先给低风险的 7 天基线：\n1) 少而稳：温和洁面 + 保湿 + 白天 SPF。\n2) 若刺痛/泛红：先停用强刺激活性（酸/高浓 VC/视黄醇），以修护为主。\n3) 任何新活性都从低频开始（每周 1–2 次），观察 72 小时。\n\n为了把建议做得更准：请把你现在 AM/PM 用的产品（洁面/活性/保湿/SPF，名字或链接都行）发我；如果方便，也可以补一张自然光自拍（可选）。'
      : "I don't have your current products/steps yet, so this is a low-confidence baseline:\n1) Keep it minimal: gentle cleanser + moisturizer + daytime SPF.\n2) If stinging/redness: pause strong actives (acids/high-strength vitamin C/retinoids) and focus on repair.\n3) Any new active: start 1–2×/week and watch the 72h response.\n\nTo personalize this safely: please share your current AM/PM products (cleanser/actives/moisturizer/SPF, names or links). If you'd like, you can also add a daylight selfie (optional).";

  return {
    features: features.slice(0, 6),
    strategy: strategy.slice(0, 1200),
    needs_risk_check: false,
  };
}

function buildRetakeSkinAnalysis({ language, photoQuality } = {}) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  const reasonsRaw = photoQuality && Array.isArray(photoQuality.reasons) ? photoQuality.reasons : [];
  const failedHint = reasonsRaw.includes('qc_failed');

  const features = [
    {
      observation:
        lang === 'CN'
          ? `这张照片${failedHint ? '没有通过' : '质量不够'}，我不会基于照片下皮肤结论（避免误判）。`
          : `This photo ${failedHint ? "didn't pass" : 'is too low-quality'}, so I won’t make skin conclusions from it (to avoid wrong guesses).`,
      confidence: 'pretty_sure',
    },
    {
      observation:
        lang === 'CN'
          ? '重拍要点：自然光/正脸/无遮挡（头发、口罩）/不美颜滤镜/对焦清晰，距离约 30–50cm。'
          : 'Retake tips: daylight, straight-on, no obstructions (hair/mask), no beauty filters, sharp focus, ~30–50cm distance.',
      confidence: 'pretty_sure',
    },
  ];

  const strategy =
    lang === 'CN'
      ? '为了更安全更准：\n1) 按上面的要点重拍一张（自然光）。\n2) 先不要同晚叠加多种强活性（维A/酸/高浓VC）。\n3) 如果你愿意，也可以先把你现在 AM/PM 用的产品/活性和频率发我，我可以先给一个“低刺激”的临时安排。\n\n你最近是否有刺痛/泛红/爆皮？'
      : "To keep this safe and accurate:\n1) Retake a daylight photo using the tips above.\n2) Avoid stacking multiple strong actives on the same night (retinoid/acids/high-strength vitamin C).\n3) If you want, share your current AM/PM products and active frequency and I’ll draft a low-irritation temporary plan.\n\nAny stinging/redness/flaking recently?";

  return {
    features: features.slice(0, 6),
    strategy: strategy.slice(0, 1200),
    needs_risk_check: false,
  };
}

function requireAuroraUid(ctx) {
  const uid = String(ctx.aurora_uid || '').trim();
  if (!uid) {
    const err = new Error('Missing X-Aurora-UID');
    err.status = 400;
    err.code = 'MISSING_AURORA_UID';
    throw err;
  }
  return uid;
}

async function resolveIdentity(req, ctx) {
  const token = getBearerToken(req);
  if (!token) return { auroraUid: ctx.aurora_uid, userId: null, userEmail: null, token: null, auth_invalid: false };

  let session = null;
  try {
    session = await resolveSessionFromToken(token);
  } catch {
    session = null;
  }

  if (!session) return { auroraUid: ctx.aurora_uid, userId: null, userEmail: null, token: null, auth_invalid: true };

  if (ctx.aurora_uid) {
    try {
      await upsertIdentityLink(ctx.aurora_uid, session.userId);
    } catch {
      // ignore
    }
  }

  return { auroraUid: ctx.aurora_uid, userId: session.userId, userEmail: session.email, token, auth_invalid: false };
}

function parseClarificationIdFromActionId(actionId) {
  const id = String(actionId || '').trim();
  if (!id) return '';
  const parts = id.split('.');
  if (parts.length < 4) return '';
  if (parts[0] !== 'chip' || parts[1] !== 'clarify') return '';
  return String(parts[2] || '').trim();
}

function parseClarificationReplyFromActionId(actionId) {
  const id = String(actionId || '').trim();
  if (!id) return '';
  const parts = id.split('.');
  if (parts.length < 4) return '';
  if (parts[0] !== 'chip' || parts[1] !== 'clarify') return '';
  return String(parts.slice(3).join(' ') || '')
    .replace(/_/g, ' ')
    .trim();
}

function stableHashBase36(raw) {
  const input = String(raw == null ? '' : raw);
  const hex = crypto.createHash('sha1').update(input).digest('hex');
  return BigInt(`0x${hex}`).toString(36);
}

function normalizeClarificationField(raw) {
  const rawText = String(raw == null ? '' : raw).trim();
  const lowered = rawText.toLowerCase();
  let norm = lowered
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}_:]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!norm) {
    recordClarificationIdNormalizedEmpty();
    norm = `cid_${stableHashBase36(rawText).slice(0, 12)}`;
  }

  const haystack = `${lowered} ${norm}`;
  if (/(budget|price|spend|预算|价位|预算档)/.test(haystack)) return 'budgetTier';
  if (/(goal|concern|target|focus|目标|诉求|优先|最想|想解决)/.test(haystack)) return 'goals';
  if (/(barrier|sting|red|irrit|reactive|屏障|耐受|刺痛|泛红|发红|刺激)/.test(haystack)) return 'barrierStatus';
  if (/(sensit|敏感程度|敏感性)/.test(haystack)) return 'sensitivity';
  if (/(skin|肤质|皮肤类型|油皮|干皮|混合|中性|oily|dry|combo|combination|mixed|normal)/.test(haystack)) return 'skinType';
  return norm;
}

const FILTERABLE_CLARIFICATION_FIELDS = new Set(['skinType', 'sensitivity', 'barrierStatus', 'goals', 'budgetTier']);
const RESUME_KNOWN_PROFILE_FIELDS = Object.freeze(['skinType', 'sensitivity', 'barrierStatus', 'goals', 'budgetTier']);
const RESUME_PREFIX_KNOWN_FIELD_MAX_VALUE = 40;
const RESUME_PREFIX_KNOWN_GOALS_MAX_ITEMS = 5;

const RESUME_REASK_PATTERNS = Object.freeze({
  skinType: [
    /what(?:'s| is)\s+your\s+skin\s+type/i,
    /which\s+skin\s+type/i,
    /(?:你的|您).{0,8}(?:肤质|皮肤类型).{0,8}(?:是|属于|吗|\?|？)/i,
  ],
  barrierStatus: [
    /is\s+your\s+barrier\s+(?:stable|healthy|ok)/i,
    /do\s+you\s+have\s+stinging(?:\/|\s+or\s+)redness/i,
    /stinging\/redness/i,
    /(?:屏障).{0,12}(?:稳定|刺痛|泛红|受损).{0,6}(?:吗|\?|？)/i,
  ],
  goals: [
    /what(?:'s| is)\s+your\s+(?:main|top)\s+goal/i,
    /what\s+is\s+your\s+goal/i,
    /(?:你的|您).{0,8}(?:主要|首要|最想).{0,8}(?:目标|诉求).{0,6}(?:是|吗|\?|？)/i,
  ],
});

function truncateResumeKnownValue(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text || isUnsureToken(text)) return '';
  if (text.length <= RESUME_PREFIX_KNOWN_FIELD_MAX_VALUE) return text;
  return text.slice(0, RESUME_PREFIX_KNOWN_FIELD_MAX_VALUE);
}

function hasKnownClarificationFieldValue(profileSummary, field) {
  if (!field || !profileSummary || typeof profileSummary !== 'object') return false;
  const norm = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
  if (field === 'skinType') {
    const v = norm(profileSummary.skinType);
    return Boolean(v && v !== 'unknown');
  }
  if (field === 'sensitivity') {
    const v = norm(profileSummary.sensitivity);
    return Boolean(v && v !== 'unknown');
  }
  if (field === 'barrierStatus') {
    const v = norm(profileSummary.barrierStatus);
    return Boolean(v && v !== 'unknown');
  }
  if (field === 'goals') {
    const goals = Array.isArray(profileSummary.goals) ? profileSummary.goals : [];
    return goals.some((g) => norm(g));
  }
  if (field === 'budgetTier') {
    const v = norm(profileSummary.budgetTier);
    return Boolean(v && v !== 'unknown');
  }
  return false;
}

function buildResumeKnownProfileFields(profileSummary) {
  if (!profileSummary || typeof profileSummary !== 'object') return null;
  const out = {};

  if (hasKnownClarificationFieldValue(profileSummary, 'skinType')) {
    const skinType = truncateResumeKnownValue(profileSummary.skinType);
    if (skinType) out.skinType = skinType;
  }

  if (hasKnownClarificationFieldValue(profileSummary, 'sensitivity')) {
    const sensitivity = truncateResumeKnownValue(profileSummary.sensitivity);
    if (sensitivity) out.sensitivity = sensitivity;
  }

  if (hasKnownClarificationFieldValue(profileSummary, 'barrierStatus')) {
    const barrierStatus = truncateResumeKnownValue(profileSummary.barrierStatus);
    if (barrierStatus) out.barrierStatus = barrierStatus;
  }

  if (hasKnownClarificationFieldValue(profileSummary, 'goals')) {
    const goals = (Array.isArray(profileSummary.goals) ? profileSummary.goals : [])
      .map((g) => truncateResumeKnownValue(g))
      .filter(Boolean)
      .slice(0, RESUME_PREFIX_KNOWN_GOALS_MAX_ITEMS);
    if (goals.length) out.goals = goals;
  }

  if (hasKnownClarificationFieldValue(profileSummary, 'budgetTier')) {
    const budgetTier = truncateResumeKnownValue(profileSummary.budgetTier);
    if (budgetTier) out.budgetTier = budgetTier;
  }

  return Object.keys(out).length ? out : null;
}

function classifyResumeResponseMode(answerText) {
  const text = String(answerText || '').trim();
  if (!text) return 'mixed';
  const leading = text.slice(0, 400);
  const leadingNorm = leading.replace(/\s+/g, ' ').trim();
  const questionMarks = (text.match(/[?？]/g) || []).length;
  const startsWithIntakePrompt = /^(before i can|before i recommend|i need a quick skin profile)/i.test(leadingNorm);
  const numberedQuestionLines = (leading.match(/(?:^|\n)\s*\d+\s*[\)\.:\uff1a]/g) || []).length >= 2;
  if (questionMarks >= 2 || startsWithIntakePrompt || numberedQuestionLines) return 'question';

  const answerLike = /(am\/pm|routine|plan|onboarding|ingredient|buying criteria|方案|步骤|早晚|建议|计划)/i.test(text);
  if (answerLike && questionMarks <= 1) return 'answer';
  return 'mixed';
}

function detectResumePlaintextReaskFields(answerText, knownProfileFields) {
  const text = String(answerText || '');
  if (!text || !knownProfileFields || typeof knownProfileFields !== 'object') return [];
  const detected = [];
  for (const field of RESUME_KNOWN_PROFILE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(knownProfileFields, field)) continue;
    const patterns = RESUME_REASK_PATTERNS[field];
    if (!Array.isArray(patterns) || !patterns.length) continue;
    if (patterns.some((pattern) => pattern.test(text))) detected.push(field);
  }
  return detected;
}

function filterClarificationQuestionsForChips({ clarification, profileSummary, filterKnown } = {}) {
  if (!clarification || typeof clarification !== 'object') return [];

  const rawQuestions = clarification.questions;
  if (!Array.isArray(rawQuestions)) {
    recordClarificationSchemaInvalid({ reason: 'questions_not_array' });
    return [];
  }

  const questions = [];
  let filteredKnownCount = 0;
  let validQuestionCount = 0;
  for (const rawQuestion of rawQuestions) {
    if (!rawQuestion || typeof rawQuestion !== 'object' || Array.isArray(rawQuestion)) {
      recordClarificationSchemaInvalid({ reason: 'question_not_object' });
      continue;
    }

    const qidRaw = typeof rawQuestion.id === 'string' ? rawQuestion.id.trim() : '';
    const qid = qidRaw || 'clarify';
    if (!qidRaw) {
      recordClarificationSchemaInvalid({ reason: 'question_id_missing' });
    }

    if (!Array.isArray(rawQuestion.options)) {
      recordClarificationSchemaInvalid({ reason: 'question_options_not_array' });
      continue;
    }

    let hasInvalidOptionType = false;
    const options = [];
    for (const rawOption of rawQuestion.options) {
      if (typeof rawOption !== 'string') {
        hasInvalidOptionType = true;
        continue;
      }
      const option = rawOption.trim();
      if (option) options.push(option);
    }
    if (hasInvalidOptionType) {
      recordClarificationSchemaInvalid({ reason: 'question_option_non_string' });
    }
    if (!options.length) {
      recordClarificationSchemaInvalid({ reason: 'question_options_empty' });
      continue;
    }
    const question = typeof rawQuestion.question === 'string' ? rawQuestion.question.trim() : '';

    validQuestionCount += 1;
    const field = normalizeClarificationField(qid);
    const shouldFilterKnown =
      Boolean(filterKnown) &&
      FILTERABLE_CLARIFICATION_FIELDS.has(field) &&
      hasKnownClarificationFieldValue(profileSummary, field);
    if (shouldFilterKnown) {
      filteredKnownCount += 1;
      recordClarificationQuestionFiltered({ field });
      // Keep existing observability for repeated asks, even when we filter the chips.
      recordRepeatedClarifyField({ field });
      continue;
    }

    questions.push({ id: qid, question, options });
  }

  if (Boolean(filterKnown) && validQuestionCount > 0 && filteredKnownCount > 0 && questions.length === 0) {
    recordClarificationAllQuestionsFiltered();
  }

  return questions;
}

const PENDING_CLARIFICATION_SCHEMA_V1 = 1;
const PENDING_CLARIFICATION_MAX_RESUME_USER_TEXT = 800;
const PENDING_CLARIFICATION_MAX_QUEUE = 5;
const PENDING_CLARIFICATION_MAX_OPTIONS = 8;
const PENDING_CLARIFICATION_MAX_QUESTION = 200;
const PENDING_CLARIFICATION_MAX_OPTION = 80;
const PENDING_CLARIFICATION_MAX_HISTORY = 6;

function makeFlowId() {
  const rand = crypto.randomBytes(6).toString('hex').slice(0, 12);
  return `pc_${rand || Math.random().toString(36).slice(2, 10)}`;
}

function truncate(value, maxChars) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return { value: '', truncated: false };
  if (text.length <= maxChars) return { value: text, truncated: false };
  return { value: text.slice(0, maxChars), truncated: true };
}

function capArray(items, maxCount) {
  const list = Array.isArray(items) ? items : [];
  if (list.length <= maxCount) return { values: list, dropped: 0 };
  return { values: list.slice(0, maxCount), dropped: list.length - maxCount };
}

function normalizePendingClarificationId(rawId) {
  const idRaw = typeof rawId === 'string' ? rawId.trim() : '';
  const id = idRaw || 'clarify';
  const normId = normalizeClarificationField(id);
  return { id, norm_id: normId };
}

function recordPendingClarificationTruncationFields(fields) {
  for (const field of Array.from(fields || [])) {
    recordPendingClarificationTruncated({ field });
  }
}

function normalizeClarificationQuestionForPending(rawQuestion, { recordTruncationMetrics = true, truncationFields } = {}) {
  if (!rawQuestion || typeof rawQuestion !== 'object' || Array.isArray(rawQuestion)) return null;
  if (!Array.isArray(rawQuestion.options)) return null;

  const localTruncationFields = new Set();
  const idInfo = normalizePendingClarificationId(rawQuestion.id);
  const questionTextRaw = typeof rawQuestion.question === 'string' ? rawQuestion.question.trim() : '';
  const questionTrimmed = truncate(questionTextRaw, PENDING_CLARIFICATION_MAX_QUESTION);
  if (questionTrimmed.truncated) localTruncationFields.add('question');

  const options = [];
  for (const rawOption of rawQuestion.options) {
    if (typeof rawOption !== 'string') continue;
    const optionText = rawOption.trim();
    if (!optionText) continue;
    const optionTrimmed = truncate(optionText, PENDING_CLARIFICATION_MAX_OPTION);
    if (optionTrimmed.truncated) localTruncationFields.add('option');
    options.push(optionTrimmed.value);
  }
  if (!options.length) return null;

  const cappedOptions = capArray(options, PENDING_CLARIFICATION_MAX_OPTIONS);
  if (cappedOptions.dropped > 0) localTruncationFields.add('options');

  for (const field of Array.from(localTruncationFields)) {
    if (truncationFields && truncationFields.add) truncationFields.add(field);
  }
  if (recordTruncationMetrics && localTruncationFields.size > 0) {
    recordPendingClarificationTruncationFields(localTruncationFields);
  }

  return {
    id: idInfo.id,
    norm_id: idInfo.norm_id,
    question: questionTrimmed.value,
    options: cappedOptions.values,
  };
}

function isClarifyChipAction(action, { actionId, clarificationId } = {}) {
  const id =
    typeof actionId === 'string'
      ? actionId.trim()
      : typeof action === 'string'
        ? action.trim()
        : action && typeof action === 'object' && typeof action.action_id === 'string'
          ? action.action_id.trim()
          : '';
  if (id.toLowerCase().startsWith('chip.clarify.')) return true;
  if (parseClarificationIdFromActionId(id)) return true;
  return Boolean(typeof clarificationId === 'string' && clarificationId.trim());
}

function hasPendingClarificationStateHint(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return false;
  const data = action.data && typeof action.data === 'object' ? action.data : null;
  if (!data) return false;
  if (Object.prototype.hasOwnProperty.call(data, 'clarification_step')) return true;
  if (typeof data.clarification_question_id === 'string' && data.clarification_question_id.trim()) return true;
  if (typeof data.clarificationQuestionId === 'string' && data.clarificationQuestionId.trim()) return true;
  return false;
}

function extractClarificationQuestionIdFromAction(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return '';
  const data = action.data && typeof action.data === 'object' ? action.data : null;
  if (!data) return '';
  const raw =
    (typeof data.clarification_question_id === 'string' && data.clarification_question_id) ||
    (typeof data.clarificationQuestionId === 'string' && data.clarificationQuestionId) ||
    '';
  return String(raw || '').trim();
}

function sanitizePendingClarification(rawPending, { recordMetrics = true } = {}) {
  if (!rawPending || typeof rawPending !== 'object' || Array.isArray(rawPending)) return null;
  const truncationFields = new Set();

  const createdAtRaw = Number(rawPending.created_at_ms);
  if (!Number.isFinite(createdAtRaw) || createdAtRaw <= 0) return null;
  const createdAtMs = Math.trunc(createdAtRaw);

  const resumeTextRaw = typeof rawPending.resume_user_text === 'string' ? rawPending.resume_user_text.trim() : '';
  if (!resumeTextRaw) return null;
  const resumeText = truncate(resumeTextRaw, PENDING_CLARIFICATION_MAX_RESUME_USER_TEXT);
  if (resumeText.truncated) truncationFields.add('resume_user_text');

  const flowIdRaw = typeof rawPending.flow_id === 'string' ? rawPending.flow_id.trim() : '';
  const flowId = /^pc_[a-z0-9]+$/i.test(flowIdRaw) ? flowIdRaw.slice(0, 32) : makeFlowId();

  const resumeUserHashRaw = typeof rawPending.resume_user_hash === 'string' ? rawPending.resume_user_hash.trim() : '';
  const resumeUserHashSafe = (resumeUserHashRaw || stableHashBase36(resumeText.value).slice(0, 20))
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 24);

  if (!Array.isArray(rawPending.queue)) return null;
  const normalizedQueue = [];
  for (const rawQuestion of rawPending.queue) {
    const normalized = normalizeClarificationQuestionForPending(rawQuestion, {
      recordTruncationMetrics: false,
      truncationFields,
    });
    if (normalized) normalizedQueue.push(normalized);
  }
  if (normalizedQueue.length < rawPending.queue.length) truncationFields.add('queue');
  const cappedQueue = capArray(normalizedQueue, PENDING_CLARIFICATION_MAX_QUEUE);
  if (cappedQueue.dropped > 0) truncationFields.add('queue');

  let current = null;
  if (rawPending.current && typeof rawPending.current === 'object' && !Array.isArray(rawPending.current)) {
    const currentIdRaw = typeof rawPending.current.id === 'string' ? rawPending.current.id.trim() : '';
    if (currentIdRaw) {
      const currentIdInfo = normalizePendingClarificationId(currentIdRaw);
      current = { id: currentIdInfo.id, norm_id: currentIdInfo.norm_id };
    }
  }

  const historyRaw = Array.isArray(rawPending.history) ? rawPending.history : [];
  if (!Array.isArray(rawPending.history) && rawPending.history != null) {
    truncationFields.add('history');
  }
  const normalizedHistory = [];
  for (const entry of historyRaw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const questionIdRaw = typeof entry.question_id === 'string' ? entry.question_id.trim() : '';
    const optionRaw = typeof entry.option === 'string' ? entry.option.trim() : '';
    const tsMsRaw = Number(entry.ts_ms);
    if (!questionIdRaw || !optionRaw || !Number.isFinite(tsMsRaw) || tsMsRaw <= 0) continue;

    const questionIdInfo = normalizePendingClarificationId(questionIdRaw);
    const optionTrimmed = truncate(optionRaw, PENDING_CLARIFICATION_MAX_OPTION);
    if (optionTrimmed.truncated) truncationFields.add('option');

    normalizedHistory.push({
      question_id: questionIdInfo.id,
      norm_id:
        typeof entry.norm_id === 'string' && entry.norm_id.trim()
          ? entry.norm_id.trim().slice(0, 80)
          : questionIdInfo.norm_id,
      option: optionTrimmed.value,
      ts_ms: Math.trunc(tsMsRaw),
    });
  }
  if (normalizedHistory.length < historyRaw.length) truncationFields.add('history');
  let history = normalizedHistory;
  if (normalizedHistory.length > PENDING_CLARIFICATION_MAX_HISTORY) {
    history = normalizedHistory.slice(-PENDING_CLARIFICATION_MAX_HISTORY);
    truncationFields.add('history');
  }

  const canonical = {
    v: PENDING_CLARIFICATION_SCHEMA_V1,
    flow_id: flowId,
    created_at_ms: createdAtMs,
    resume_user_text: resumeText.value,
    ...(resumeUserHashSafe ? { resume_user_hash: resumeUserHashSafe } : {}),
    step_index: history.length,
    ...(current ? { current } : {}),
    queue: cappedQueue.values,
    history,
  };

  const upgraded = Number(rawPending.v) !== PENDING_CLARIFICATION_SCHEMA_V1;
  if (recordMetrics) {
    if (upgraded) recordPendingClarificationUpgraded({ from: 'legacy' });
    if (truncationFields.size > 0) recordPendingClarificationTruncationFields(truncationFields);
  }

  return { pending: canonical, upgraded };
}

function getPendingClarification(session) {
  const s = session && typeof session === 'object' ? session : null;
  if (!s) return null;
  const state = s.state && typeof s.state === 'object' && !Array.isArray(s.state) ? s.state : null;
  if (!state) return null;
  const raw = state.pending_clarification;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return sanitizePendingClarification(raw, { recordMetrics: true });
}

function emitPendingClarificationPatch(sessionPatch, pendingOrNull) {
  if (!sessionPatch || typeof sessionPatch !== 'object') return;
  const state = isPlainObject(sessionPatch.state) ? { ...sessionPatch.state } : {};
  state.pending_clarification = pendingOrNull || null;
  sessionPatch.state = state;
}

function buildChipsForQuestion(question, { stepIndex } = {}) {
  const q = normalizeClarificationQuestionForPending(question);
  if (!q) return [];
  const qid = String(q.id || 'clarify').trim() || 'clarify';
  const step = Number.isFinite(Number(stepIndex)) ? Math.max(1, Math.trunc(Number(stepIndex))) : 1;
  return q.options.slice(0, 8).map((option) => ({
    chip_id: `chip.clarify.${qid}.${option.trim().slice(0, 40).replace(/\s+/g, '_')}`,
    label: option,
    kind: 'quick_reply',
    data: {
      reply_text: option,
      clarification_id: qid,
      clarification_question_id: qid,
      clarification_norm_id: String(q.norm_id || ''),
      clarification_step: step,
    },
  }));
}

function advancePendingClarification(pending, selectedOption, selectedQuestionId) {
  const nowMs = Date.now();
  const option = typeof selectedOption === 'string' ? selectedOption.trim() : '';
  const currentId =
    (typeof selectedQuestionId === 'string' && selectedQuestionId.trim()) ||
    (pending && pending.current && typeof pending.current.id === 'string' && pending.current.id.trim()) ||
    'clarify';
  const currentIdInfo = normalizePendingClarificationId(currentId);
  const optionTrimmed = truncate(option || '(empty)', PENDING_CLARIFICATION_MAX_OPTION);
  if (optionTrimmed.truncated) {
    recordPendingClarificationTruncated({ field: 'option' });
  }
  const entry = {
    question_id: currentIdInfo.id,
    norm_id: currentIdInfo.norm_id,
    option: optionTrimmed.value || '(empty)',
    ts_ms: nowMs,
  };

  const history = Array.isArray(pending && pending.history) ? [...pending.history, entry] : [entry];
  const queue = Array.isArray(pending && pending.queue) ? pending.queue : [];
  const historyState = sanitizePendingClarification(
    {
      v: PENDING_CLARIFICATION_SCHEMA_V1,
      flow_id: pending && typeof pending.flow_id === 'string' ? pending.flow_id : makeFlowId(),
      created_at_ms: Number(pending && pending.created_at_ms) || nowMs,
      resume_user_text: typeof pending?.resume_user_text === 'string' ? pending.resume_user_text : '(no message)',
      ...(pending && typeof pending.resume_user_hash === 'string' ? { resume_user_hash: pending.resume_user_hash } : {}),
      step_index: history.length,
      ...(pending && pending.current ? { current: pending.current } : {}),
      queue,
      history,
    },
    { recordMetrics: true },
  );
  const boundedHistory = historyState ? historyState.pending.history : history.slice(-PENDING_CLARIFICATION_MAX_HISTORY);
  if (!queue.length) {
    return { nextPending: null, nextQuestion: null, history: boundedHistory };
  }

  const nextQuestion = normalizeClarificationQuestionForPending(queue[0], { recordTruncationMetrics: true });
  if (!nextQuestion) return { nextPending: null, nextQuestion: null, history: boundedHistory };
  const nextPendingState = sanitizePendingClarification(
    {
      v: PENDING_CLARIFICATION_SCHEMA_V1,
      flow_id: pending && typeof pending.flow_id === 'string' ? pending.flow_id : makeFlowId(),
      created_at_ms: Number(pending && pending.created_at_ms) || nowMs,
      resume_user_text: typeof pending?.resume_user_text === 'string' ? pending.resume_user_text : '(no message)',
      ...(pending && typeof pending.resume_user_hash === 'string' ? { resume_user_hash: pending.resume_user_hash } : {}),
      step_index: boundedHistory.length,
      current: { id: nextQuestion.id, norm_id: nextQuestion.norm_id },
      queue: queue.slice(1),
      history: boundedHistory,
    },
    { recordMetrics: true },
  );
  if (!nextPendingState || !nextPendingState.pending) {
    return { nextPending: null, nextQuestion: null, history: boundedHistory };
  }
  return { nextPending: nextPendingState.pending, nextQuestion, history: nextPendingState.pending.history };
}

function compactClarificationHistory(history) {
  const out = [];
  const list = Array.isArray(history) ? history : [];
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const questionId = typeof item.question_id === 'string' ? item.question_id.trim() : '';
    const option = typeof item.option === 'string' ? item.option.trim() : '';
    if (!questionId || !option) continue;
    out.push({
      question_id: questionId.slice(0, 120),
      option: option.slice(0, 120),
    });
    if (out.length >= 5) break;
  }
  return out;
}

function isUnsureToken(raw) {
  const text = String(raw || '').trim().toLowerCase();
  if (!text) return false;
  return (
    text === 'unknown' ||
    text === 'unsure' ||
    text === 'not sure' ||
    text === 'n/a' ||
    text === 'na' ||
    /不确定|不知道|不清楚/.test(text)
  );
}

function inferGoalFromClarificationText(raw) {
  const text = String(raw || '').trim().toLowerCase();
  if (!text) return '';
  if (/(acne|breakout|pore|oil|控痘|痘|闭口|粉刺|毛孔|出油)/.test(text)) return 'acne';
  if (/(redness|sensitive|reactive|泛红|敏感|刺痛|修护屏障|屏障)/.test(text)) return 'redness';
  if (/(dark spot|pigment|bright|tone|淡斑|美白|提亮|暗沉|色沉|痘印)/.test(text)) return 'dark_spots';
  if (/(dry|hydrate|moist|保湿|补水|干燥|紧绷)/.test(text)) return 'dehydration';
  if (/(wrinkle|fine line|firm|anti[- ]?aging|抗老|抗衰|细纹|紧致|提拉)/.test(text)) return 'wrinkles';
  return '';
}

function inferProfilePatchFromClarification({ clarificationId, replyText }) {
  const field = normalizeClarificationField(clarificationId);
  const raw = String(replyText || '').trim();
  const text = raw.toLowerCase();
  if (!field || !raw) return null;

  if (field === 'skinType') {
    if (/\boily\b/.test(text) || /(油皮|油性|出油)/.test(text)) return { skinType: 'oily' };
    if (/\bdry\b/.test(text) || /(干皮|干性|干燥|紧绷)/.test(text)) return { skinType: 'dry' };
    if (/\b(combo|combination|mixed)\b/.test(text) || /混合/.test(text)) return { skinType: 'combination' };
    if (/\bnormal\b/.test(text) || /中性/.test(text)) return { skinType: 'normal' };
    if (/\bsensitive\b/.test(text) || /敏感/.test(text)) return { skinType: 'sensitive' };
    if (isUnsureToken(text)) return { skinType: 'unknown' };
    return null;
  }

  if (field === 'barrierStatus') {
    if (/(stable|healthy|normal|ok|good|稳定|健康)/.test(text)) return { barrierStatus: 'healthy' };
    if (/(sting|stinging|red|irrit|burn|reactive|impaired|damaged|刺痛|泛红|发红|刺激|不稳定|受损)/.test(text)) return { barrierStatus: 'impaired' };
    if (isUnsureToken(text)) return { barrierStatus: 'unknown' };
    return null;
  }

  if (field === 'sensitivity') {
    if (/(^|\b)(low|mild)\b|低|轻/.test(text)) return { sensitivity: 'low' };
    if (/(^|\b)(medium|mid|moderate)\b|中/.test(text)) return { sensitivity: 'medium' };
    if (/(^|\b)(high|severe|very)\b|高|重/.test(text)) return { sensitivity: 'high' };
    if (/(^|\b)yes(\b|$)|有|容易刺痛/.test(text)) return { sensitivity: 'high' };
    if (/(^|\b)no(\b|$)|无|不敏感/.test(text)) return { sensitivity: 'low' };
    if (isUnsureToken(text)) return { sensitivity: 'unknown' };
    return null;
  }

  if (field === 'goals') {
    if (isUnsureToken(text)) return { goals: ['unknown'] };
    const goal = inferGoalFromClarificationText(text);
    if (goal) return { goals: [goal] };
    const normalized = raw.replace(/\s+/g, ' ').trim().slice(0, 80);
    return normalized ? { goals: [normalized] } : null;
  }

  if (field === 'budgetTier') {
    const budget = normalizeBudgetHint(raw);
    return { budgetTier: budget || raw.slice(0, 40) };
  }

  return null;
}

function parseProfilePatchFromAction(action) {
  if (!action) return null;
  if (typeof action === 'object' && action.data && typeof action.data === 'object') {
    const patch = action.data.profile_patch || action.data.profilePatch;
    if (patch && typeof patch === 'object') return patch;
  }

  const id = typeof action === 'string' ? action : action && action.action_id;
  if (typeof action === 'object' && action && typeof action.data === 'object' && action.data) {
    const clarificationIdRaw =
      action.data.clarification_id || action.data.clarificationId || parseClarificationIdFromActionId(id);
    const replyText = extractReplyTextFromAction(action) || parseClarificationReplyFromActionId(id);
    const patchFromClarification = inferProfilePatchFromClarification({
      clarificationId: clarificationIdRaw,
      replyText,
    });
    if (patchFromClarification) return patchFromClarification;
  }

  // Fallback: parse chip ids like "profile.skinType.oily".
  if (!id || typeof id !== 'string') return null;
  const parts = id.split('.');
  if (parts.length < 3 || parts[0] !== 'profile') return null;
  const key = parts[1];
  const value = parts.slice(2).join('.');
  if (!key || !value) return null;
  if (key === 'goals') return { goals: [value] };
  if (key === 'skinType') return { skinType: value };
  if (key === 'sensitivity') return { sensitivity: value };
  if (key === 'barrierStatus') return { barrierStatus: value };
  return null;
}

function extractProfilePatchFromSession(session) {
  const s = session && typeof session === 'object' ? session : null;
  if (!s) return null;

  const rawProfile =
    (s.profile_patch && typeof s.profile_patch === 'object' ? s.profile_patch : null) ||
    (s.profilePatch && typeof s.profilePatch === 'object' ? s.profilePatch : null) ||
    (s.profile && typeof s.profile === 'object' ? s.profile : null) ||
    null;
  if (!rawProfile) return null;

  const patch = {};

  // Strings
  const copyString = (toKey, ...fromKeys) => {
    for (const k of fromKeys) {
      const v = rawProfile[k];
      if (typeof v !== 'string') continue;
      const t = v.trim();
      if (!t) continue;
      patch[toKey] = t;
      return;
    }
  };
  copyString('skinType', 'skinType', 'skin_type');
  copyString('sensitivity', 'sensitivity');
  copyString('barrierStatus', 'barrierStatus', 'barrier_status');
  copyString('region', 'region');
  copyString('budgetTier', 'budgetTier', 'budget_tier');

  // Arrays
  if (Array.isArray(rawProfile.goals)) {
    const goals = rawProfile.goals
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .filter(Boolean)
      .slice(0, 12);
    if (goals.length) patch.goals = goals;
  }
  if (Array.isArray(rawProfile.contraindications)) {
    const contraindications = rawProfile.contraindications
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .filter(Boolean)
      .slice(0, 24);
    if (contraindications.length) patch.contraindications = contraindications;
  }

  // Mixed types
  if (rawProfile.currentRoutine != null) patch.currentRoutine = rawProfile.currentRoutine;
  if (rawProfile.current_routine != null) patch.currentRoutine = rawProfile.current_routine;
  if (rawProfile.itinerary != null) patch.itinerary = rawProfile.itinerary;

  const parsed = UserProfilePatchSchema.safeParse(patch);
  if (!parsed.success) return null;
  const clean = parsed.data;
  return Object.keys(clean).length ? clean : null;
}

function shouldPersistProfilePatch(baseProfile, patch) {
  if (!patch || typeof patch !== 'object') return false;
  const keys = Object.keys(patch);
  if (keys.length === 0) return false;
  if (!baseProfile) return true;

  for (const k of keys) {
    const next = patch[k];
    if (next == null) continue;

    const prev = baseProfile[k];
    if (k === 'goals' || k === 'contraindications') {
      const prevArr = Array.isArray(prev) ? prev : [];
      const nextArr = Array.isArray(next) ? next : [];
      if (nextArr.length && prevArr.length === 0) return true;
      continue;
    }

    if (typeof next === 'string') {
      const prevText = typeof prev === 'string' ? prev.trim() : '';
      if (!prevText) return true;
      continue;
    }

    if (prev == null) return true;
  }

  return false;
}

function extractReplyTextFromAction(action) {
  if (!action || typeof action !== 'object') return null;
  const data = action.data && typeof action.data === 'object' ? action.data : null;
  if (!data) return null;
  const raw =
    (typeof data.reply_text === 'string' && data.reply_text) ||
    (typeof data.replyText === 'string' && data.replyText) ||
    (typeof data.text === 'string' && data.text) ||
    null;
  const text = raw ? String(raw).trim() : '';
  return text || null;
}

function coerceBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value !== 'string') return false;
  const s = value.trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'y' || s === 'on';
}

function classifyStorageError(err) {
  const code = err && err.code ? String(err.code) : null;
  const sqlState = code && /^[0-9A-Z]{5}$/.test(code) ? code : null;
  const netCodes = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN']);

  const dbNotConfigured = code === 'NO_DATABASE';
  const dbSchemaError = sqlState === '42P01' || sqlState === '42703' || sqlState === '42883';
  const dbError = dbNotConfigured || Boolean(sqlState) || netCodes.has(code);
  return { code, sqlState, dbError, dbNotConfigured, dbSchemaError };
}

function extractIncludeAlternativesFromAction(action) {
  if (!action || typeof action !== 'object') return false;
  const data = action.data && typeof action.data === 'object' ? action.data : null;
  if (!data) return false;
  return coerceBoolean(data.include_alternatives ?? data.includeAlternatives);
}

function summarizeProfileForContext(profile) {
  if (!profile) return null;
  const currentRoutineRaw = profile.currentRoutine;
  let currentRoutine = null;
  if (typeof currentRoutineRaw === 'string') {
    const t = currentRoutineRaw.trim();
    currentRoutine = t ? t.slice(0, 4000) : null;
  } else if (currentRoutineRaw && typeof currentRoutineRaw === 'object') {
    try {
      const json = JSON.stringify(currentRoutineRaw);
      currentRoutine = json.length > 5000 ? `${json.slice(0, 5000)}…` : json;
    } catch {
      currentRoutine = null;
    }
  }

  const itineraryRaw = profile.itinerary;
  let itinerary = null;
  if (typeof itineraryRaw === 'string') {
    const t = itineraryRaw.trim();
    itinerary = t ? t.slice(0, 1200) : null;
  } else if (itineraryRaw && typeof itineraryRaw === 'object') {
    try {
      const json = JSON.stringify(itineraryRaw);
      itinerary = json.length > 1500 ? `${json.slice(0, 1500)}…` : json;
    } catch {
      itinerary = null;
    }
  }

  const contraindications = Array.isArray(profile.contraindications)
    ? profile.contraindications.filter((v) => typeof v === 'string' && v.trim()).slice(0, 12)
    : [];

  return {
    skinType: profile.skinType || null,
    sensitivity: profile.sensitivity || null,
    barrierStatus: profile.barrierStatus || null,
    goals: Array.isArray(profile.goals) ? profile.goals : [],
    region: profile.region || null,
    budgetTier: profile.budgetTier || null,
    currentRoutine,
    itinerary,
    contraindications,
  };
}

function deepHasKey(obj, predicate, depth = 0) {
  if (depth > 6) return false;
  if (!obj) return false;
  if (Array.isArray(obj)) return obj.some((v) => deepHasKey(v, predicate, depth + 1));
  if (typeof obj !== 'object') return false;
  for (const [k, v] of Object.entries(obj)) {
    if (predicate(k)) return true;
    if (deepHasKey(v, predicate, depth + 1)) return true;
  }
  return false;
}

function structuredContainsCommerceLikeFields(structured) {
  const commerceKeys = new Set([
    'recommendations',
    'reco',
    'offers',
    'offer',
    'checkout',
    'purchase_route',
    'purchaseroute',
    'affiliate_url',
    'affiliateurl',
    'internal_checkout',
    'internalcheckout',
  ]);
  return deepHasKey(structured, (k) => commerceKeys.has(String(k || '').trim().toLowerCase()));
}

function getUpstreamStructuredOrJson(upstream) {
  if (upstream && upstream.structured && typeof upstream.structured === 'object' && !Array.isArray(upstream.structured)) {
    return upstream.structured;
  }
  if (upstream && typeof upstream.answer === 'string') return extractJsonObject(upstream.answer);
  return null;
}

function unwrapCodeFence(text) {
  const t = String(text || '').trim();
  if (!t.startsWith('```')) return t;
  const firstNewline = t.indexOf('\n');
  const lastFence = t.lastIndexOf('```');
  if (firstNewline === -1 || lastFence === -1 || lastFence <= firstNewline) return t;
  return t.slice(firstNewline + 1, lastFence).trim();
}

function looksLikeJsonOrCode(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) return true;

  if (t.startsWith('```')) {
    const firstLine = t.split('\n')[0].toLowerCase();
    if (firstLine.includes('json') || firstLine.includes('typescript') || firstLine.includes('javascript') || firstLine.includes('ts') || firstLine.includes('js')) {
      return true;
    }
    const inner = unwrapCodeFence(t);
    if ((inner.startsWith('{') && inner.endsWith('}')) || (inner.startsWith('[') && inner.endsWith(']'))) return true;
  }

  return false;
}

function stripInternalKbRefsFromText(text) {
  const input = typeof text === 'string' ? text : '';
  if (!input.trim()) return input;

  const withoutKb = input.replace(/\bkb:[a-z0-9_-]+\b/gi, '');

  const cleaned = withoutKb
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, '').replace(/^[ \t]+/g, ''))
    .filter((line) => {
      const t = line.trim();
      if (!t) return true;
      if (/^(evidence|citation|citations|source|sources)[:：]?\s*$/i.test(t)) return false;
      if (/^(证据|引用|来源)[:：]?\s*$/.test(t)) return false;
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return cleaned;
}

function isInternalKbCitationId(raw) {
  const v = String(raw || '').trim();
  if (!v) return false;
  const lower = v.toLowerCase();
  if (lower.startsWith('kb:')) return true;
  if (/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v)) return true;
  return false;
}

function stripInternalRefsDeep(value, { parentKey } = {}) {
  if (typeof value === 'string') return stripInternalKbRefsFromText(value);
  if (Array.isArray(value)) {
    const key = String(parentKey || '').trim().toLowerCase();
    const isCitationsField = key === 'citations' || key.endsWith('_citations') || key.endsWith('citations');
    if (isCitationsField) {
      const out = [];
      for (const item of value) {
        if (typeof item === 'string') {
          const t = item.trim();
          if (!t) continue;
          if (isInternalKbCitationId(t)) continue;
          out.push(t);
          continue;
        }
        out.push(stripInternalRefsDeep(item));
      }
      return out;
    }
    return value.map((v) => stripInternalRefsDeep(v));
  }
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = stripInternalRefsDeep(v, { parentKey: k });
  }
  return out;
}

function sanitizeUpstreamAnswer(answer, { language, hasRenderableCards, stripInternalRefs } = {}) {
  let t = typeof answer === 'string' ? answer : '';
  if (stripInternalRefs) t = stripInternalKbRefsFromText(t);

  const lang = language === 'CN' ? 'CN' : 'EN';

  const noRenderableCardsMessage =
    lang === 'CN'
      ? '我这次没有拿到可展示的结构化结果卡片（上游仅返回了摘要/解析信息）。请重试一次，或换一种问法（例如：评估这款：<产品名>）。'
      : 'I did not receive any renderable structured cards from upstream (only a parse/summary stub). Please retry, or rephrase (e.g. “Evaluate: <product name>”).';
  const hasRenderableCardsMessage =
    lang === 'CN' ? '我已经把核心结果整理成结构化卡片（见下方）。' : 'I summarized the key results into structured cards below.';

  const looksLikeCardsBelowTemplate = (() => {
    const raw = String(t || '').trim();
    if (!raw) return false;
    const lower = raw.toLowerCase();

    // EN: "cards below" style.
    if (/\bcards?\s+below\b/.test(lower)) return true;
    if (/\bstructured\s+cards?\s+below\b/.test(lower)) return true;
    if (/\bsee\s+(the\s+)?(structured\s+)?cards?\s+below\b/.test(lower)) return true;
    if (/\bsee\s+the\s+card\s+below\b/.test(lower)) return true;

    // CN: "见下方/下方卡片".
    if (/见下方/.test(raw)) return true;
    if (/下方.*(卡片|卡)\b/.test(raw)) return true;
    if (/(结构化|结构).*卡片.*(下方|如下)/.test(raw)) return true;
    return false;
  })();

  if (looksLikeCardsBelowTemplate) {
    return hasRenderableCards ? hasRenderableCardsMessage : noRenderableCardsMessage;
  }

  // If we provide renderable cards, keep assistant_message concise and avoid confusing
  // "templated" multi-part essays (often redundant with the cards).
  //
  // IMPORTANT: do not reference "cards below" unless we are confident the UI will
  // actually render at least one card (e.g. structured citations, env_stress, recos).
  const looksLikeOverlongTemplate =
    t.length > 600 &&
    (/\bpart\s*\d+\s*:/i.test(t) ||
      /\b(budget analysis|am\s*\(|pm\s*\(|am\s*:|pm\s*:)\b/i.test(t) ||
      /(^|\n)#+\s*(am|pm|budget|safety)\b/i.test(t));
  if (looksLikeOverlongTemplate) {
    if (hasRenderableCards) {
      return hasRenderableCardsMessage;
    }
    return noRenderableCardsMessage;
  }

  if (!looksLikeJsonOrCode(t)) return t;

  if (lang === 'CN') {
    return hasRenderableCards ? '我已经把结果整理成结构化卡片（见下方）。' : '我已收到你的信息。';
  }
  return hasRenderableCards ? 'I formatted the result into structured cards below.' : 'Got it.';
}

const REGION_TO_TIMEZONE = {
  CN: 'Asia/Shanghai',
  HK: 'Asia/Hong_Kong',
  TW: 'Asia/Taipei',
  JP: 'Asia/Tokyo',
  KR: 'Asia/Seoul',
  SG: 'Asia/Singapore',
  UK: 'Europe/London',
  EU: 'Europe/Berlin',
  US: 'America/Los_Angeles',
};

function guessTimeZoneForChat({ profile, language } = {}) {
  const regionRaw = profile && typeof profile.region === 'string' ? profile.region.trim().toUpperCase() : '';
  if (regionRaw && REGION_TO_TIMEZONE[regionRaw]) return REGION_TO_TIMEZONE[regionRaw];

  // Conservative fallback: if language is CN and region is missing, assume CN timezone
  // (better UX for most CN users; avoids relying on server locale).
  if (language === 'CN') return REGION_TO_TIMEZONE.CN;
  return null;
}

function hourInTimeZone(now, timeZone) {
  if (!now || !(now instanceof Date)) return null;
  if (!timeZone) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hour12: false }).formatToParts(now);
    const hourStr = parts.find((p) => p && p.type === 'hour')?.value;
    const hour = Number(hourStr);
    return Number.isFinite(hour) ? hour : null;
  } catch {
    return null;
  }
}

function timeOfDayBucket(hour) {
  if (!Number.isFinite(hour)) return null;
  if (hour >= 5 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'night';
}

function detectLeadingGreetingLanguage(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const head = raw.slice(0, 80);
  const lower = head.toLowerCase();

  if (/^(hi|hello|hey|good\s+(morning|afternoon|evening)|morning|evening)\b/i.test(lower)) return 'EN';
  if (/^(你好|您好|嗨|哈喽|早(上好|安)?|下午好|晚上好|晚安|夜里好)/.test(head)) return 'CN';
  return null;
}

function stripMismatchedLeadingGreeting(text, { language } = {}) {
  const raw = typeof text === 'string' ? text : '';
  if (!raw.trim()) return raw;
  const expected = language === 'CN' ? 'CN' : 'EN';
  const lines = raw.split(/\r?\n/);
  if (!lines.length) return raw;
  const firstLine = String(lines[0] || '').trim();
  const detected = detectLeadingGreetingLanguage(firstLine);
  if (!detected || detected === expected) return raw;
  const rest = lines.slice(1).join('\n').replace(/^\s+/, '');
  return rest || raw;
}

function looksLikeGreetingAlready(text, { language } = {}) {
  const detected = detectLeadingGreetingLanguage(text);
  if (!detected) return false;
  if (!language) return true;
  return detected === (language === 'CN' ? 'CN' : 'EN');
}

function stableHashInt(input) {
  const s = String(input == null ? '' : input);
  let hash = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

const EMOTIONAL_PREAMBLE_OPTIONS = {
  CN: {
    fallback: [
      '收到，我们一步步来。',
      '明白了，我们慢慢把关键点理顺。',
      '好呀，我们先把最重要的一步定下来。',
    ],
    morning: [
      '早上好，今天也一起把护肤做得稳稳的。',
      '早上好，新的一天我们从清晰方案开始。',
      '早上好，先抓重点，你会轻松很多。',
    ],
    afternoon: [
      '下午好，辛苦啦，我们把重点快速理清。',
      '下午好，忙碌中也能从容，我们一步步来。',
      '下午好，我会给你一个省心好执行的方案。',
    ],
    evening: [
      '晚上好，辛苦一天了，我们放松着来。',
      '晚上好，今天也很努力了，我们走简洁稳妥路线。',
      '晚上好，我们把步骤整理得清楚又轻松。',
    ],
    night: [
      '夜深了，愿你今晚好好休息；我把重点浓缩给你。',
      '夜里好，咱们简短高效处理完就休息。',
      '这么晚还在关心皮肤，已经很棒了；我尽量说得更省心。',
    ],
  },
  EN: {
    fallback: [
      'Got it — I’ll keep it clear and practical.',
      'Absolutely — let’s make this simple and actionable.',
      'Sounds good — we’ll take this step by step.',
    ],
    morning: [
      'Good morning — let’s keep your routine easy and steady today.',
      'Good morning — we’ll focus on the highest-impact steps first.',
      'Good morning — I’ll keep this practical and skin-friendly.',
    ],
    afternoon: [
      'Good afternoon — quick, clear, and practical steps coming up.',
      'Good afternoon — we can keep this efficient and smooth.',
      'Good afternoon — I’ll help you lock in a plan that’s easy to follow.',
    ],
    evening: [
      'Good evening — you’ve done enough today; let’s make this easy.',
      'Good evening — we’ll keep things calm, clear, and realistic.',
      'Good evening — I’ll help you finish today with an easy routine.',
    ],
    night: [
      'Late-night check-in — I’ll keep this short so you can rest.',
      'It’s late — let’s keep this concise and soothing for your skin.',
      'Quick night plan: simple steps now, better skin tomorrow.',
    ],
  },
};

function normalizePreambleLine(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function buildKnownPreambleSetByLang() {
  const out = { CN: new Set(), EN: new Set() };
  for (const lang of ['CN', 'EN']) {
    const choices = EMOTIONAL_PREAMBLE_OPTIONS[lang] || {};
    for (const key of Object.keys(choices)) {
      const arr = Array.isArray(choices[key]) ? choices[key] : [];
      for (const line of arr) {
        const normalized = normalizePreambleLine(line);
        if (normalized) out[lang].add(normalized);
      }
    }
  }
  return out;
}

const KNOWN_EMOTIONAL_PREAMBLE_SET = buildKnownPreambleSetByLang();

function hasKnownEmotionalPreamble(text, lang) {
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const normalized = normalizePreambleLine(line);
    if (!normalized) continue;
    const set = KNOWN_EMOTIONAL_PREAMBLE_SET[lang === 'CN' ? 'CN' : 'EN'];
    if (set && set.has(normalized)) return true;
    break;
  }
  return false;
}

function pickPreambleVariant(options, { seed, language, bucket }) {
  const list = Array.isArray(options) ? options.filter((s) => typeof s === 'string' && s.trim()) : [];
  if (!list.length) return '';
  if (list.length === 1) return list[0];
  const index = stableHashInt(`${language || 'EN'}|${bucket || 'fallback'}|${seed || ''}`) % list.length;
  return list[index];
}

function buildEmotionalPreamble({ language, profile, now, seed } = {}) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  const timeZone = guessTimeZoneForChat({ profile, language: lang });
  const hour = hourInTimeZone(now, timeZone);
  const bucket = timeOfDayBucket(hour);
  const choices = EMOTIONAL_PREAMBLE_OPTIONS[lang] || EMOTIONAL_PREAMBLE_OPTIONS.EN;
  const key = bucket || 'fallback';
  const selected = pickPreambleVariant(choices[key], { seed, language: lang, bucket: key });
  if (selected) return selected;

  const fallback = pickPreambleVariant(choices.fallback, { seed, language: lang, bucket: 'fallback' });
  return fallback || (lang === 'CN' ? '收到，我们一步步来。' : 'Got it — I’ll keep it clear and practical.');
}

function addEmotionalPreambleToAssistantText(text, { language, profile, seed } = {}) {
  const raw = typeof text === 'string' ? text : '';
  if (!raw.trim()) return raw;
  const lang = language === 'CN' ? 'CN' : 'EN';
  const normalized = stripMismatchedLeadingGreeting(raw, { language: lang });
  if (
    looksLikeGreetingAlready(normalized, { language: lang }) ||
    hasKnownEmotionalPreamble(normalized, lang)
  ) {
    return normalized;
  }

  const pre = buildEmotionalPreamble({ language: lang, profile, now: new Date(), seed });
  if (!pre || !String(pre).trim()) return raw;

  const maxPreLen = lang === 'CN' ? 44 : 120;
  const safePre = String(pre).trim().slice(0, maxPreLen);
  return `${safePre}\n\n${normalized}`;
}

const CHATBOX_UI_RENDERABLE_CARD_TYPES = new Set([
  'recommendations',
  'product_analysis',
  'env_stress',
  'routine_simulation',
  'conflict_heatmap',
  'analysis_summary',
  'diagnosis_gate',
]);

const CHATBOX_UI_HIDDEN_CARD_TYPES = new Set(['gate_notice', 'session_bootstrap', 'budget_gate', 'aurora_context_raw']);

function isRenderableCardForChatboxUi(card, { debug } = {}) {
  if (!card || typeof card !== 'object') return false;
  const type = String(card.type || '').trim().toLowerCase();
  if (!type) return false;
  if (debug) return true;
  if (type === 'aurora_structured') return false; // Renderability depends on citations; handled separately.
  if (CHATBOX_UI_HIDDEN_CARD_TYPES.has(type)) return false;
  return CHATBOX_UI_RENDERABLE_CARD_TYPES.has(type);
}

function structuredLooksLikeParseOnlyStub(value) {
  if (!isPlainObject(value)) return false;
  const allowed = new Set(['schema_version', 'parse', 'conflicts']);
  const keys = Object.keys(value || {}).filter((k) => value[k] != null);
  if (keys.length === 0) return false;
  // Require parse to exist; otherwise this could be any partial structured payload.
  if (!('parse' in value)) return false;
  return keys.every((k) => allowed.has(k));
}

function extractProductInputFromFitCheckText(message) {
  const raw = String(message || '').trim();
  if (!raw) return '';

  // Remove internal test markers if they leaked into user input.
  let t = raw
    .replace(/STRUCTURED_STUB_ONLY_TEST/gi, '')
    .replace(/SHORT_CARDS_BELOW_STUB_TEST/gi, '')
    .replace(/SHORT_CARDS_BELOW_STRIPPED_RECO_TEST/gi, '')
    .replace(/NON_GENERIC_STUB_TEST/gi, '')
    .trim();

  // Prefer suffix after the last ":" / "：" (common pattern: "Evaluate: <name>").
  const m = t.match(/[:：]\s*([^:：]{2,400})\s*$/);
  if (m && m[1]) t = String(m[1]).trim();

  // Strip leading intent phrases; keep the product token(s).
  t = t.replace(
    /^(请|帮我|麻烦|想问|我要|我想|想|能否)?\s*(诊断|评估|分析|看看|判断|check|evaluate|analyze)\s*(一下|下|下这款|这款|这个)?\s*(产品|精华|serum|product)?\s*(是否|能不能|可不可以|适不适合我|适合吗|能用吗|可以用吗|suitable|safe|okay)?\s*/i,
    '',
  ).trim();

  // If it still looks like a full sentence, keep the tail (often where the product appears).
  if (t.length > 160) t = t.slice(-160).trim();
  return t;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asStringArray(value, max = 8) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(value) ? value : []) {
    const s = typeof raw === 'string' ? raw.trim() : raw == null ? '' : String(raw).trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function hasAnyToken(text, tokens) {
  const haystack = String(text || '').toLowerCase();
  return (Array.isArray(tokens) ? tokens : []).some((t) => haystack.includes(String(t || '').toLowerCase()));
}

const ROUTE_SECTION_HINTS = {
  'fit-check': [
    ['结论：', 'Verdict:'],
    ['风险点：', 'Risk points:'],
    ['更稳妥替代方向：', 'Safer alternatives:'],
    ['怎么用（频率/顺序/观察周期）：', 'How to use (frequency/order/timeline):'],
    ['停用信号：', 'Stop signals:'],
  ],
  reco: [
    ['目标与前提：', 'Goal & context:'],
    ['最小可行清单（早/晚）：', 'Minimum viable routine (AM/PM):'],
    ['成分方向（Top 3）：', 'Ingredient directions (Top 3):'],
    ['一周引入计划：', 'One-week onboarding plan:'],
    ['怎么选（选购标准）：', 'Buying criteria (how to choose):'],
    ['红旗信号：', 'Red flags:'],
  ],
  conflict: [
    ['冲突原因：', 'Conflict reason:'],
    ['安全排班（错开使用）：', 'Safer schedule (alternate use):'],
    ['优先级取舍：', 'Priority choices:'],
    ['停用信号：', 'Stop signals:'],
  ],
  env: [
    ['环境判断：', 'Environment check:'],
    ['加什么 / 减什么 / 替换什么：', 'Add / remove / replace:'],
    ['频率调整：', 'Frequency adjustment:'],
    ['临时极简方案：', 'Temporary minimal plan:'],
    ['防晒/保湿策略：', 'Sun/moisture strategy:'],
  ],
};

function isRouteStructuredAnswer(text, route) {
  const checks = ROUTE_SECTION_HINTS[String(route || '').trim()];
  if (!checks || !checks.length) return true;
  return checks.every((tokens) => hasAnyToken(text, tokens));
}

function looksLikeGenericStructuredNotice(text) {
  const raw = String(text || '').trim();
  if (!raw) return true;
  const lower = raw.toLowerCase();
  return (
    lower.includes('structured cards below') ||
    lower.includes('i did not receive any renderable structured cards') ||
    lower.includes('only a parse/summary stub') ||
    raw.includes('我已经把核心结果整理成结构化卡片') ||
    raw.includes('我还没能从上游拿到可结构化') ||
    raw.includes('仅返回了摘要/解析信息')
  );
}

function getCardPayload(card) {
  if (!card || typeof card !== 'object') return null;
  if (isPlainObject(card.payload)) return card.payload;
  return isPlainObject(card) ? card : null;
}

function inferRouteFromCards(cards) {
  const list = Array.isArray(cards) ? cards.filter((c) => c && typeof c === 'object') : [];
  const byType = new Map();
  for (const c of list) {
    const type = String(c.type || '').trim();
    if (!type) continue;
    if (!byType.has(type)) byType.set(type, c);
  }

  if (byType.has('routine_simulation') || byType.has('conflict_heatmap')) {
    const card = byType.get('routine_simulation') || byType.get('conflict_heatmap');
    return { route: 'conflict', payload: getCardPayload(card) };
  }
  if (byType.has('env_stress')) {
    return { route: 'env', payload: getCardPayload(byType.get('env_stress')) };
  }
  if (byType.has('product_analysis')) {
    return { route: 'fit-check', payload: getCardPayload(byType.get('product_analysis')) };
  }
  if (byType.has('recommendations')) {
    return { route: 'reco', payload: getCardPayload(byType.get('recommendations')) };
  }
  return null;
}

function inferRouteFromMessageIntent(message, { allowRecoCards } = {}) {
  if (looksLikeCompatibilityOrConflictQuestion(message)) return { route: 'conflict', payload: {} };
  if (looksLikeWeatherOrEnvironmentQuestion(message)) return { route: 'env', payload: {} };
  if (looksLikeSuitabilityRequest(message)) return { route: 'fit-check', payload: {} };
  if (allowRecoCards && looksLikeRecommendationRequest(message)) return { route: 'reco', payload: {} };
  return null;
}

function resolveRouteHint(fromCards, fromMessage) {
  const cardRoute = String(fromCards?.route || '').trim();
  const messageRoute = String(fromMessage?.route || '').trim();
  if (!cardRoute) return fromMessage || null;
  if (!messageRoute) return fromCards || null;

  const explicitMessageRoutes = new Set(['fit-check', 'conflict', 'env']);
  if (explicitMessageRoutes.has(messageRoute)) {
    if (cardRoute === 'reco') return fromMessage;
    if (cardRoute === messageRoute) return fromCards;
  }
  return fromCards;
}

function summarizeProfileForAnswer(profile, lang) {
  const p = isPlainObject(profile) ? profile : {};
  const skinType = typeof p.skinType === 'string' ? p.skinType.trim() : '';
  const sensitivity = typeof p.sensitivity === 'string' ? p.sensitivity.trim() : '';
  const barrier = typeof p.barrierStatus === 'string' ? p.barrierStatus.trim() : '';
  const goals = asStringArray(p.goals, 4);
  if (lang === 'CN') {
    const left = [skinType || '肤质待补充', sensitivity ? `${sensitivity}敏` : '敏感度待补充', barrier || '屏障状态待补充'];
    const goalText = goals.length ? `目标：${goals.join('、')}` : '目标：待补充';
    return `${left.join(' / ')}；${goalText}。`;
  }
  const left = [skinType || 'skin type pending', sensitivity ? `${sensitivity} sensitivity` : 'sensitivity pending', barrier || 'barrier pending'];
  const goalText = goals.length ? `Goals: ${goals.join(', ')}` : 'Goals: pending';
  return `${left.join(' / ')}; ${goalText}.`;
}

function pickRecoNames(payload, max = 3) {
  const recos = Array.isArray(payload && payload.recommendations) ? payload.recommendations : [];
  const out = [];
  const seen = new Set();
  for (const r of recos) {
    if (!r || typeof r !== 'object') continue;
    const sku = isPlainObject(r.sku) ? r.sku : isPlainObject(r.product) ? r.product : null;
    const brand = typeof sku?.brand === 'string' ? sku.brand.trim() : '';
    const name = typeof sku?.name === 'string' ? sku.name.trim() : '';
    const title = [brand, name].filter(Boolean).join(' ').trim() || (typeof r.title === 'string' ? r.title.trim() : '');
    if (!title) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(title);
    if (out.length >= max) break;
  }
  return out;
}

function buildRouteAwareAssistantText({ route, payload, language, profile }) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  const p = isPlainObject(payload) ? payload : {};
  const profileLine = summarizeProfileForAnswer(profile, lang);

  if (route === 'fit-check') {
    const assessment = isPlainObject(p.assessment) ? p.assessment : {};
    const verdict = String(assessment.verdict || '').trim() || (lang === 'CN' ? '谨慎可试' : 'Cautious to try');
    const reasons = asStringArray(assessment.reasons, 6);
    const riskLines = reasons.filter((r) => /风险|刺激|刺痛|泛红|risk|irritat|sting|burn/i.test(r));
    const fitLines = reasons.filter((r) => !riskLines.includes(r));
    const risk = (riskLines.length ? riskLines : reasons).slice(0, 2);
    const fit = (fitLines.length ? fitLines : reasons).slice(0, 2);

    if (lang === 'CN') {
      return [
        `结论：${verdict}（先看耐受，再决定是否长期用）。`,
        `你的情况：${profileLine}`,
        '风险点：',
        ...(risk.length ? risk.map((r) => `- ${r}`) : ['- 若近期有刺痛/爆皮，需先降频并修护屏障。']),
        '更稳妥替代方向：',
        ...(fit.length ? fit.map((r) => `- 可优先考虑：${r}`) : ['- 先选低刺激、简配方、无香精版本。']),
        '怎么用（频率/顺序/观察周期）：',
        '- 先每周 2-3 次，晚间使用；连续 2-4 周观察再决定是否加频。',
        '- 早上务必防晒（SPF30+），并避免同晚叠加强酸/高强度活性。',
        '停用信号：出现持续刺痛、明显泛红或爆皮时先停用 3-5 天，仅保湿修护；持续加重请就医。',
      ].join('\n');
    }

    return [
      `Verdict: ${verdict} (start cautiously, then scale only if tolerated).`,
      `Your profile: ${profileLine}`,
      'Risk points:',
      ...(risk.length ? risk.map((r) => `- ${r}`) : ['- If stinging/peeling is active, reduce frequency and prioritize barrier repair.']),
      'Safer alternatives:',
      ...(fit.length ? fit.map((r) => `- Consider: ${r}`) : ['- Prefer low-irritation, simple, fragrance-free options first.']),
      'How to use (frequency/order/timeline):',
      '- Start at 2-3 nights/week; reassess after 2-4 weeks before increasing.',
      '- Use sunscreen every morning (SPF30+), and avoid stacking multiple strong actives in one night.',
      'Stop signals: pause if persistent stinging/redness/peeling, switch to barrier repair only, and seek dermatology care if worsening.',
    ].join('\n');
  }

  if (route === 'reco') {
    const names = pickRecoNames(p, 3);
    const topNames = names.length ? names : [lang === 'CN' ? '温和修护类精华' : 'gentle barrier-support serum'];
    if (lang === 'CN') {
      return [
        `目标与前提：${profileLine}`,
        '最小可行清单（早/晚）：',
        '- AM：温和清洁 → 保湿/功效精华（低刺激）→ 防晒。',
        '- PM：温和清洁 → 单一主活性（低频）→ 保湿修护。',
        '成分方向（Top 3）：',
        `- 方向 1：烟酰胺/神经酰胺（兼顾提亮与屏障支持）`,
        `- 方向 2：壬二酸/温和抗炎路线（痘印与泛红更稳）`,
        `- 方向 3：保湿舒缓体系（甘油/透明质酸/角鲨烷）`,
        `可优先看的示例：${topNames.join('、')}。`,
        '一周引入计划：',
        '- 第 1-3 天：只保留基础清洁+保湿+防晒，先稳耐受。',
        '- 第 4-7 天：单一活性每周 2-3 次起步，其余晚修护保湿。',
        '- 观察 2-4 周再加频；若刺痛/泛红/爆皮，立即降频或停用新活性。',
        '怎么选（选购标准）：',
        '- 优先考虑：低刺激、配方简洁、与你目标匹配的单一主活性。',
        '- 筛选原则：先看耐受和可持续性，再看叠加数量，避免一次上太多功效。',
        '红旗信号：',
        '- 若出现持续刺痛、明显泛红或爆皮，先停新活性 3-5 天，仅做修护保湿；持续加重请就医。',
      ].join('\n');
    }

    return [
      `Goal & context: ${profileLine}`,
      'Minimum viable routine (AM/PM):',
      '- AM: gentle cleanse → treatment/hydration → sunscreen.',
      '- PM: gentle cleanse → one core active (low frequency) → barrier moisturizer.',
      'Ingredient directions (Top 3):',
      '- Direction 1: niacinamide/ceramide for brightening + barrier support.',
      '- Direction 2: azelaic-acid-friendly, low-irritation anti-redness path.',
      '- Direction 3: hydration-soothing base (glycerin/HA/squalane).',
      `Sample options to review first: ${topNames.join(', ')}.`,
      'One-week onboarding plan:',
      '- Days 1-3: keep only cleanse + moisturizer + sunscreen to stabilize tolerance.',
      '- Days 4-7: introduce one active at 2-3 nights/week; keep recovery nights in between.',
      '- Reassess after 2-4 weeks and scale only if skin stays stable.',
      'Buying criteria (how to choose):',
      '- Look for low-irritation, simple formulas and one clear active aligned to your goal.',
      '- Prioritize tolerability and consistency before stacking more products.',
      'Red flags:',
      '- Pause new actives if persistent stinging/redness/peeling appears; switch to barrier repair and seek care if worsening.',
    ].join('\n');
  }

  if (route === 'conflict') {
    const conflicts = Array.isArray(p.conflicts) ? p.conflicts : [];
    const safe = Boolean(p.safe);
    const conflictMessages = asStringArray(conflicts.map((c) => (isPlainObject(c) ? c.message : null)), 3);
    if (lang === 'CN') {
      return [
        safe ? '冲突判断：当前未发现明显冲突。' : '冲突判断：检测到活性叠加冲突风险。',
        '冲突原因：',
        ...(conflictMessages.length
          ? conflictMessages.map((m) => `- ${m}`)
          : ['- 同晚叠加强活性会让刺激风险上升，耐受不稳时更容易泛红/爆皮。']),
        '安全排班（错开使用）：',
        '- AM：温和清洁 → 保湿 → 防晒。',
        '- PM：活性 A 与活性 B 交替晚用（例如周一/周四 A，周二/周五 B），中间留修护晚。',
        '- 先从每周 2-3 次起步，耐受稳定后再加频。',
        '优先级取舍：',
        '- 优先保留一个主活性先做满 2-4 周，再决定是否加入第二个活性。',
        '- 如果目标是“先稳后进”，优先减少叠加数量而不是提高浓度。',
        '停用信号：出现持续刺痛、明显泛红、爆皮时先停用新活性，仅做修护保湿；若持续恶化请就医。',
      ].join('\n');
    }

    return [
      safe ? 'Conflict check: no major conflict detected right now.' : 'Conflict check: potential active-stacking risk detected.',
      'Conflict reason:',
      ...(conflictMessages.length
        ? conflictMessages.map((m) => `- ${m}`)
        : ['- Layering strong actives in the same night can increase irritation and reduce tolerance.']),
      'Safer schedule (alternate use):',
      '- AM: gentle cleanse → moisturizer → sunscreen.',
      '- PM: alternate active A and active B on different nights; keep recovery nights between them.',
      '- Start at 2-3 active nights/week, then increase only after stable tolerance.',
      'Priority choices:',
      '- Keep one core active first for 2-4 weeks before adding a second active.',
      '- Prioritize lower stacking load before increasing concentration.',
      'Stop signals: pause new actives if persistent stinging/redness/peeling appears; switch to barrier repair only and seek care if worsening.',
    ].join('\n');
  }

  if (route === 'env') {
    const tier = typeof p.tier === 'string' ? p.tier.trim() : '';
    const ess = Number.isFinite(Number(p.ess)) ? Number(p.ess) : null;
    const notes = asStringArray(p.notes, 3);
    if (lang === 'CN') {
      return [
        `环境判断：当前环境压力 ${tier || '待评估'}${ess != null ? `（ESS ${Math.round(ess)}）` : ''}。`,
        notes.length ? `环境线索：${notes.join('；')}` : '环境线索：以天气变化为主，先做保守调整。',
        '加什么 / 减什么 / 替换什么：',
        '- 加：修护保湿（神经酰胺、甘油、角鲨烷等）与舒缓产品。',
        '- 减：同晚多活性叠加、高清洁力和高频去角质。',
        '- 替换：把刺激型活性改为低频或更温和版本。',
        '频率调整：',
        '- 活性先降到每周 2-3 次；其余晚以保湿修护为主。',
        '- 天气骤变期优先稳住 3-7 天，再逐步恢复原计划。',
        '临时极简方案：',
        '- 早晚都用“温和清洁 + 保湿修护”，白天固定防晒；先稳住再加功效。',
        '防晒/保湿策略：',
        '- 白天坚持 SPF30+ 并按需补涂；室内干燥时增加保湿层与补水频次。',
      ].join('\n');
    }

    return [
      `Environment check: stress level is ${tier || 'pending'}${ess != null ? ` (ESS ${Math.round(ess)})` : ''}.`,
      notes.length ? `Context clues: ${notes.join('; ')}` : 'Context clues: keep adjustments conservative while conditions shift.',
      'Add / remove / replace:',
      '- Add: barrier-support hydration and soothing layers.',
      '- Remove: same-night multi-active stacking and frequent strong exfoliation.',
      '- Replace: high-irritation steps with lower-frequency, gentler options.',
      'Frequency adjustment:',
      '- Reduce actives to 2-3 nights/week; keep recovery-focused nights in between.',
      '- Stabilize for 3-7 days during weather swings before ramping back up.',
      'Temporary minimal plan:',
      '- Keep cleanse + barrier moisturizer AM/PM, and hold high-irritation actives during unstable weather days.',
      'Sun/moisture strategy:',
      '- Keep daily SPF30+ and reapply as needed; increase moisturizer support in dry indoor air.',
    ].join('\n');
  }

  return '';
}

function coerceNumber(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function clamp0to100(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function titleCase(value) {
  const t = String(value || '').trim();
  if (!t) return t;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function buildEnvStressUiModelFromUpstream(value, { language } = {}) {
  if (!isPlainObject(value)) return null;
  const schema = typeof value.schema_version === 'string' ? value.schema_version : '';

  if (schema === 'aurora.ui.env_stress.v1') return value;
  if (schema !== 'aurora.env_stress.v1') return null;

  const essRaw = coerceNumber(value.ess);
  const ess = essRaw == null ? null : clamp0to100(essRaw);
  const tier = typeof value.tier === 'string' ? value.tier.trim() || null : null;

  const contributors = Array.isArray(value.contributors) ? value.contributors : [];
  const weights = contributors.map((c) => {
    if (!isPlainObject(c)) return null;
    const w = coerceNumber(c.weight);
    return w == null || w < 0 ? null : w;
  });

  const weightSum = weights.reduce((acc, w) => acc + (w ?? 0), 0);
  const denom = weightSum > 0 ? weightSum : contributors.length;

  const radar = [];
  for (let i = 0; i < contributors.length; i += 1) {
    const c = contributors[i];
    if (!isPlainObject(c)) continue;
    const axisRaw = typeof c.key === 'string' ? c.key.trim() : '';
    if (!axisRaw) continue;
    const w = weightSum > 0 ? (weights[i] ?? 0) / denom : 1 / denom;
    const v = ess == null ? 0 : clamp0to100(Math.round(ess * w));
    radar.push({ axis: titleCase(axisRaw).slice(0, 40), value: v });
    if (radar.length >= 8) break;
  }

  const notes = [];
  const missing = Array.isArray(value.missing_inputs) ? value.missing_inputs : [];
  const missingFlat = missing.map((m) => String(m || '').trim()).filter(Boolean);
  if (missingFlat.length) {
    notes.push(
      language === 'CN'
        ? `缺少：${missingFlat.slice(0, 4).join(' / ')}`
        : `Missing: ${missingFlat.slice(0, 4).join(' / ')}`,
    );
  }

  for (const c of contributors) {
    if (!isPlainObject(c)) continue;
    const note = typeof c.note === 'string' ? c.note.trim() : '';
    if (!note) continue;
    notes.push(note.slice(0, 220));
    if (notes.length >= 4) break;
  }

  return {
    schema_version: 'aurora.ui.env_stress.v1',
    ess,
    tier,
    radar,
    notes,
  };
}

function looksLikeWeatherOrEnvironmentQuestion(message) {
  const t = String(message || '').trim();
  if (!t) return false;

  const lower = t.toLowerCase();

  // English
  if (
    /\b(snow|rain|weather|humidity|uv|climate|wind|dry air|cold|heat|sun exposure|travel|itinerary|destination|flight|ski)\b/i.test(
      lower,
    )
  )
    return true;

  // Chinese (keep focused on environment, not general skin symptoms)
  if (
    /(下雪|雪天|下雨|雨天|天气|气温|温度|湿度|紫外线|UV|风大|大风|寒冷|冷空气|高温|热浪|干燥(空气|天气)?|雾霾|污染|花粉|旅行|出差|飞行|飞机|高原|海边|滑雪|户外)/.test(
      t,
    )
  )
    return true;

  return false;
}

function extractWeatherScenario(message) {
  const t = String(message || '').trim();
  if (!t) return 'unknown';
  const lower = t.toLowerCase();

  if (/(下雪|雪天|滑雪)/.test(t) || /\bsnow|ski\b/i.test(lower)) return 'snow';
  if (/(下雨|雨天|暴雨)/.test(t) || /\brain|storm\b/i.test(lower)) return 'rain';
  if (/(紫外线|UV|日晒|阳光|晒)/.test(t) || /\buv|sun|sunlight\b/i.test(lower)) return 'uv';
  if (/(湿度|潮湿|闷热)/.test(t) || /\bhumid|humidity\b/i.test(lower)) return 'humid';
  if (/(干燥|干冷|冷空气)/.test(t) || /\bdry air|dry|dehydrating\b/i.test(lower)) return 'dry';
  if (/(寒冷|冷|低温)/.test(t) || /\bcold|freez(e|ing)\b/i.test(lower)) return 'cold';
  if (/(大风|风大|风|刮风)/.test(t) || /\bwind|windy\b/i.test(lower)) return 'wind';
  if (/(旅行|出差|飞行|飞机|高原|海边)/.test(t) || /\btravel|flight|itinerary|destination\b/i.test(lower)) return 'travel';
  return 'unknown';
}

function extractKnownActivesFromText(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  const lower = t.toLowerCase();
  // Some CN inputs may contain spaces between characters (e.g. "阿达 帕林", "维 A").
  // Keep an additional whitespace-stripped view for conservative CN matching.
  const compact = t.replace(/\s+/g, '');
  const out = [];

  const push = (token) => {
    const key = String(token || '').trim().toLowerCase();
    if (!key) return;
    if (!out.includes(key)) out.push(key);
  };

  // NOTE: This is used for routing + local compatibility simulation. Keep it conservative but multilingual.
  // EN: tretinoin/adapalene/retinal/retinol/retinoid
  // CN: 阿达帕林 / 维A(类)/维A酸 / 维甲酸 / 视黄醇/视黄醛 / A醇/A酸
  if (
    /(tretinoin|adapalene|retinal|retinol|retinoid)/i.test(lower) ||
    /(阿达帕林|维a类|维a酸|维a|维甲酸|维甲|视黄醇|视黄醛|a醇|a酸)/i.test(compact)
  ) {
    push('retinoid');
  }
  // Strong acids: BHA (salicylic) / AHA (glycolic/lactic/mandelic) / PHA.
  // CN: 水杨酸 / 果酸(甘醇酸/乳酸/杏仁酸) / PHA(葡糖酸内酯)
  // Treat PHA as "aha" for conflict heuristics (retinoid_x_acids includes AHA/BHA/PHA).
  if (/(benzoyl\s*peroxide|bpo)/i.test(lower)) push('benzoyl_peroxide');
  if (/(过氧化苯甲酰)/i.test(compact)) push('benzoyl_peroxide');
  if (/(salicylic|bha)/i.test(lower) || /(水杨酸)/i.test(compact)) push('bha');
  if (
    /(glycolic|lactic|mandelic|aha|pha|gluconolactone)/i.test(lower) ||
    /(果酸|甘醇酸|乙醇酸|乳酸|杏仁酸|葡糖酸内酯)/i.test(compact)
  ) {
    push('aha');
  }
  if (/(vitamin\s*c|ascorbic|l-ascorbic|ascorbate)/i.test(lower)) push('vitamin_c');
  if (/(维c|维生素c|抗坏血酸)/i.test(compact)) push('vitamin_c');
  if (/(niacinamide)/i.test(lower) || /(烟酰胺)/i.test(compact)) push('niacinamide');
  if (/(azelaic)/i.test(lower) || /(壬二酸)/i.test(compact)) push('azelaic_acid');
  if (/(tranexamic)/i.test(lower) || /(传明酸|氨甲环酸)/i.test(compact)) push('tranexamic_acid');

  return out;
}

function collectKnownActivesFromRoutine(routine) {
  const routineObj = routine && typeof routine === 'object' ? routine : {};
  const am = Array.isArray(routineObj.am) ? routineObj.am : [];
  const pm = Array.isArray(routineObj.pm) ? routineObj.pm : [];
  const out = [];
  const seen = new Set();

  const push = (token) => {
    const key = String(token || '').trim().toLowerCase();
    if (!key) return;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(key);
  };

  const scanText = (raw) => {
    const tokens = extractKnownActivesFromText(String(raw || ''));
    for (const t of tokens) push(t);
  };

  const scanItem = (item) => {
    if (!item) return;
    if (typeof item === 'string') {
      scanText(item);
      return;
    }
    if (typeof item !== 'object' || Array.isArray(item)) return;

    const actives = item.key_actives || item.keyActives || item.actives;
    if (Array.isArray(actives)) {
      for (const a of actives) scanText(a);
    }

    const fields = [
      item.step,
      item.category,
      item.slot_step,
      item.slotStep,
      item.title,
      item.name,
      item.display_name,
      item.displayName,
      item.product,
    ];
    for (const f of fields) {
      if (typeof f === 'string' && f.trim()) scanText(f);
    }
  };

  for (const item of am) scanItem(item);
  for (const item of pm) scanItem(item);

  return out;
}

function looksLikeCompatibilityOrConflictQuestion(message) {
  const t = String(message || '').trim();
  if (!t) return false;
  const lower = t.toLowerCase();

  const hasCompatVerbEn =
    /\b(conflict|conflicts|compatible|incompatible|pair|layer|stack|mix|combine|together|same routine|same night|can i add|should i add|with)\b/i.test(
      lower,
    );
  const hasCompatVerbZh = /(冲突|相克|兼容|叠加|同晚|一起用|能不能一起|还能和|搭配|同用)/.test(t);
  if (!(hasCompatVerbEn || hasCompatVerbZh)) return false;

  // Avoid triggering on generic “conflict” questions without any known skincare actives.
  const actives = extractKnownActivesFromText(t);
  return actives.length > 0;
}

function buildLocalCompatibilitySimulationInput({ message, profile } = {}) {
  const text = String(message || '').trim();
  if (!text) return null;

  const clauses = text
    .split(/[.?!。！？\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8);

  let routineText = '';
  let testText = '';
  for (const clause of clauses) {
    const lower = clause.toLowerCase();
    const isRoutineContextEn = /\b(my|i use|i'm using|currently|routine|am|pm|at night|morning)\b/i.test(lower);
    const isRoutineContextZh = /(我(现在|目前|早上|晚上|一直)|我的(早晚)?(流程|步骤|routine)|正在用)/.test(clause);
    const isTestContextEn = /\b(add|can i|layer|stack|mix|combine|together|with|conflict|compatible)\b/i.test(lower);
    const isTestContextZh = /(叠加|同晚|一起用|能不能|还能和|搭配|冲突|兼容|同用)/.test(clause);

    if (isRoutineContextEn || isRoutineContextZh) routineText = `${routineText} ${clause}`.trim();
    if (isTestContextEn || isTestContextZh) testText = `${testText} ${clause}`.trim();
  }

  const all = extractKnownActivesFromText(text);
  const routineActives = routineText ? extractKnownActivesFromText(routineText) : [];
  const testActives = testText ? extractKnownActivesFromText(testText) : [];

  const setEq = (a, b) => {
    const aa = new Set((a || []).map((v) => String(v).toLowerCase()));
    const bb = new Set((b || []).map((v) => String(v).toLowerCase()));
    if (aa.size !== bb.size) return false;
    for (const v of aa) if (!bb.has(v)) return false;
    return true;
  };

  let routineTokens = routineActives;
  let testTokens = testActives;

  if (!routineTokens.length || !testTokens.length || setEq(routineTokens, testTokens)) {
    const has = (tok) => all.includes(tok);
    if (has('retinoid') && (has('aha') || has('bha'))) {
      routineTokens = ['retinoid'];
      testTokens = [...new Set([...(has('aha') ? ['aha'] : []), ...(has('bha') ? ['bha'] : [])])];
    } else if (has('retinoid') && has('benzoyl_peroxide')) {
      routineTokens = ['retinoid'];
      testTokens = ['benzoyl_peroxide'];
    } else if (has('vitamin_c') && (has('aha') || has('bha'))) {
      routineTokens = ['vitamin_c'];
      testTokens = [...new Set([...(has('aha') ? ['aha'] : []), ...(has('bha') ? ['bha'] : [])])];
    } else if (all.length >= 2) {
      routineTokens = [all[0]];
      testTokens = [all[1]];
    } else {
      // If we can’t confidently form a pair from text, don’t short-circuit.
      return null;
    }
  }

  const routineFromProfile =
    profile &&
    profile.currentRoutine &&
    typeof profile.currentRoutine === 'object' &&
    !Array.isArray(profile.currentRoutine) &&
    (Array.isArray(profile.currentRoutine.am) || Array.isArray(profile.currentRoutine.pm))
      ? profile.currentRoutine
      : null;

  const profileRoutineActives = routineFromProfile ? collectKnownActivesFromRoutine(routineFromProfile) : [];
  const shouldUseProfileRoutine = Boolean(
    routineFromProfile && routineTokens.some((t) => profileRoutineActives.includes(String(t || '').toLowerCase())),
  );

  const routine = shouldUseProfileRoutine ? routineFromProfile : {
    am: [],
    pm: routineTokens.length ? [{ step: 'Treatment', key_actives: routineTokens }] : [],
  };

  const testProduct = {
    step: 'Add-on',
    name: testTokens.join(' + ') || 'Test product',
    key_actives: testTokens,
  };

  if (!Array.isArray(testProduct.key_actives) || testProduct.key_actives.length === 0) return null;

  return { routine, testProduct };
}

function buildEnvStressUiModelFromLocal({ profile, recentLogs, message, language } = {}) {
  const lang = language === 'CN' ? 'CN' : 'EN';

  const barrier = String(profile && profile.barrierStatus ? profile.barrierStatus : '').trim().toLowerCase();
  const sensitivity = String(profile && profile.sensitivity ? profile.sensitivity : '').trim().toLowerCase();

  let ess = 35;
  if (barrier === 'impaired' || barrier === 'damaged') ess = 75;
  else if (barrier === 'healthy' || barrier === 'stable') ess = 20;
  else if (barrier) ess = 35;

  if (sensitivity === 'high' || sensitivity === 'sensitive') ess += 10;

  const scenario = extractWeatherScenario(message);
  const bumpMap = {
    snow: 18,
    cold: 15,
    wind: 12,
    dry: 15,
    uv: 15,
    rain: 8,
    humid: 8,
    travel: 12,
    unknown: 6,
  };
  ess += bumpMap[scenario] ?? 6;
  ess = clamp0to100(ess);

  const tier = ess <= 30 ? 'Low' : ess <= 60 ? 'Medium' : 'High';

  const barrierScore = barrier === 'impaired' || barrier === 'damaged' ? 80 : barrier === 'healthy' || barrier === 'stable' ? 20 : 40;
  const weatherScore = scenario === 'snow' || scenario === 'cold' || scenario === 'dry' || scenario === 'wind' ? 70 : scenario === 'rain' || scenario === 'humid' ? 45 : scenario === 'travel' ? 55 : 35;
  const uvScore = scenario === 'uv' || scenario === 'snow' ? 65 : 30;

  const radar = [
    { axis: 'Barrier', value: clamp0to100(barrierScore) },
    { axis: 'Weather', value: clamp0to100(weatherScore) },
    { axis: 'UV', value: clamp0to100(uvScore) },
  ];

  const missing = [];
  if (!String(profile && profile.sensitivity ? profile.sensitivity : '').trim()) missing.push('profile.sensitivity');
  if (!Array.isArray(recentLogs) || recentLogs.length === 0) missing.push('recent_logs');

  const notes = [];
  if (missing.length) {
    notes.push(lang === 'CN' ? `缺少：${missing.slice(0, 4).join(' / ')}` : `Missing: ${missing.slice(0, 4).join(' / ')}`);
  }
  if (barrier) notes.push(`barrier_status=${barrier}`.slice(0, 220));
  if (scenario && scenario !== 'unknown') notes.push((lang === 'CN' ? `场景：${scenario}（推断）` : `Scenario: ${scenario} (inferred)`).slice(0, 220));

  return {
    schema_version: 'aurora.ui.env_stress.v1',
    ess,
    tier,
    radar,
    notes: notes.slice(0, 4),
  };
}

function buildWeatherAdviceMessage({ language, scenario, profile } = {}) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  const skin = String(profile && profile.skinType ? profile.skinType : '').trim();

  const skinLine =
    skin && lang === 'CN'
      ? `你的肤质：${skin}。`
      : skin && lang === 'EN'
        ? `Your skin type: ${skin}.`
        : '';

  if (lang === 'CN') {
    if (scenario === 'snow') {
      return [
        '雪天的皮肤压力通常来自：低温 + 干燥 + 大风 + 雪地反光导致的 UV（更容易晒/更容易干裂）。',
        skinLine,
        '',
        '**护肤要点（优先级从高到低）**',
        '1) **保湿 + 封闭**：面霜稍厚一点；口周/鼻翼/脸颊干处可薄薄封一层凡士林类。',
        '2) **防晒**：即使阴天/下雪也建议 SPF30+；如果户外时间长或雪地强反光，尽量提高防晒强度并注意补涂。',
        '3) **物理防护**：围巾/口罩/帽子减少冷风直吹；干裂倾向的手部建议戴手套。',
        '4) **温和清洁**：避免强清洁/磨砂；回家后用温和洁面即可。',
        '5) **活性减量**：如果你晚上用维A/酸，雪天更容易刺痛；更稳妥是把强酸和维A错开晚用。',
        '',
        '**对应产品清单（按“品类/关键词”找）**',
        '- 温和洁面（低泡/无磨砂）',
        '- 修护面霜（偏屏障修护/保湿）',
        '- 封闭修护（凡士林/修护膏；局部薄涂）',
        '- 防晒（广谱 SPF30+；户外注意补涂）',
        '- 润唇膏 + 护手霜（干裂优先）',
        '',
        '想要我根据你现有产品给你一个「雪天 AM/PM 版本」吗？也可以直接点下面的选项继续。',
      ]
        .filter(Boolean)
        .join('\n');
    }

    if (scenario === 'uv') {
      return [
        '这类问题更像是「紫外线/日晒压力」场景：主要风险是晒黑/反黑、屏障受刺激、炎症后色沉加重。',
        skinLine,
        '',
        '**护肤要点**',
        '1) 防晒优先：足量 SPF30+，户外注意补涂。',
        '2) 轻薄但够保湿：避免晒后紧绷脱皮。',
        '3) 活性分开用：敏感/刺痛时先停酸/维A，先修护。',
      ]
        .filter(Boolean)
        .join('\n');
    }

    return [
      '我把你的问题理解成「天气/环境变化对皮肤的影响」。',
      skinLine,
      '',
      '**通用要点**',
      '1) 保湿与屏障优先（面霜/修护类）。',
      '2) 容易刺痛就先减量/停用强活性（酸/维A）。',
      '3) 白天注意防晒（户外更重要）。',
      '',
      '如果你告诉我你明天大概会在户外多久、以及最近是否有刺痛/爆皮，我可以把建议进一步细化。',
    ]
      .filter(Boolean)
      .join('\n');
  }

  // EN
  if (scenario === 'snow') {
    return [
      'Snowy days usually stress skin via: cold + dry air + wind + higher UV exposure from snow reflection.',
      skinLine,
      '',
      '**Skincare priorities**',
      '1) **Moisturize + seal**: use a richer moisturizer; consider a thin occlusive layer on dry-prone areas.',
      '2) **Sunscreen**: SPF 30+ even on cloudy/snowy days. If you’re outdoors on snow for longer, go higher and reapply.',
      '3) **Physical protection**: scarf/mask/hat for wind; gloves if hands crack easily.',
      '4) **Gentle cleanse**: avoid harsh cleansing or scrubs.',
      '5) **Reduce actives**: if you use retinoids/acids, avoid stacking them on the same night—snowy weather increases irritation risk.',
      '',
      '**Product-type checklist**',
      '- Gentle cleanser',
      '- Barrier-support moisturizer',
      '- Occlusive (petrolatum/ointment) for dry spots',
      '- Broad-spectrum SPF 30+',
      '- Lip balm + hand cream',
      '',
      'Want me to adapt this into a simple AM/PM “snow day routine” for what you already use?',
    ]
      .filter(Boolean)
      .join('\n');
  }

  return [
    'I’m treating this as a “weather / environment stress” question for skin.',
    skinLine,
    '',
    '**General guidance**',
    '1) Prioritize barrier support (moisturizer, gentle routine).',
    '2) If you feel stinging/flaking, reduce strong actives (acids/retinoids).',
    '3) Use sunscreen for outdoor exposure.',
  ]
    .filter(Boolean)
    .join('\n');
}

function mergeExternalVerificationIntoStructured(structured, contextRaw) {
  const s = isPlainObject(structured) ? structured : null;
  if (!s) return structured;

  const hasExt = isPlainObject(s.external_verification) || isPlainObject(s.externalVerification);
  if (hasExt) return structured;

  const ctx = isPlainObject(contextRaw) ? contextRaw : null;
  if (!ctx) return structured;

  const ext = isPlainObject(ctx.external_verification) ? ctx.external_verification : isPlainObject(ctx.externalVerification) ? ctx.externalVerification : null;
  if (!ext) return structured;

  return { ...s, external_verification: ext };
}

function buildProductInputText(inputObj, url) {
  if (typeof url === 'string' && url.trim()) return url.trim();
  const o = inputObj && typeof inputObj === 'object' && !Array.isArray(inputObj) ? inputObj : null;
  if (!o) return null;
  const brand = typeof o.brand === 'string' ? o.brand.trim() : '';
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  const display = typeof o.display_name === 'string' ? o.display_name.trim() : typeof o.displayName === 'string' ? o.displayName.trim() : '';
  const sku = typeof o.sku_id === 'string' ? o.sku_id.trim() : typeof o.skuId === 'string' ? o.skuId.trim() : '';
  const pid = typeof o.product_id === 'string' ? o.product_id.trim() : typeof o.productId === 'string' ? o.productId.trim() : '';
  const bestName = display || name;
  if (brand && bestName) return joinBrandAndName(brand, bestName);
  if (bestName) return bestName;
  if (sku) return sku;
  if (pid) return pid;
  return null;
}

function pickFirstTrimmed(...values) {
  for (const raw of values) {
    const s = typeof raw === 'string' ? raw.trim() : '';
    if (s) return s;
  }
  return '';
}

function joinBrandAndName(brandRaw, nameRaw) {
  const brand = String(brandRaw || '').trim();
  const name = String(nameRaw || '').trim();
  if (!brand) return name;
  if (!name) return brand;
  const brandLower = brand.toLowerCase();
  const nameLower = name.toLowerCase();
  if (nameLower === brandLower || nameLower.startsWith(`${brandLower} `)) return name;
  return `${brand} ${name}`.trim();
}

function isUuidLikeString(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(value || '').trim());
}

function normalizeCanonicalProductRef(input, { requireMerchant = true, allowOpaqueProductId = true } = {}) {
  const ref = input && typeof input === 'object' && !Array.isArray(input) ? input : null;
  if (!ref) return null;
  const productId = pickFirstTrimmed(ref.product_id, ref.productId);
  const merchantId = pickFirstTrimmed(ref.merchant_id, ref.merchantId);
  if (!productId) return null;
  if (!allowOpaqueProductId && isUuidLikeString(productId)) return null;
  if (requireMerchant && !merchantId) return null;
  return {
    product_id: productId,
    ...(merchantId ? { merchant_id: merchantId } : {}),
  };
}

function extractRecoPdpDirectKeys(base, skuCandidate) {
  const candidates = [base, skuCandidate].filter((v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v));
  const subjectCandidates = [];
  for (const source of candidates) {
    if (source.subject && typeof source.subject === 'object' && !Array.isArray(source.subject)) {
      subjectCandidates.push(source.subject);
    }
  }

  let subjectProductGroupId = '';
  for (const subject of subjectCandidates) {
    const type = pickFirstTrimmed(subject.type).toLowerCase();
    const asId = pickFirstTrimmed(subject.id);
    const asPgid = pickFirstTrimmed(subject.product_group_id, subject.productGroupId);
    if (type === 'product_group' && asId) {
      subjectProductGroupId = asId;
      break;
    }
    if (asPgid) {
      subjectProductGroupId = asPgid;
      break;
    }
  }

  if (!subjectProductGroupId) {
    subjectProductGroupId = pickFirstTrimmed(
      base?.product_group_id,
      base?.productGroupId,
      skuCandidate?.product_group_id,
      skuCandidate?.productGroupId,
      base?.pdp_open?.subject?.product_group_id,
      base?.pdp_open?.subject?.id,
      base?.pdpOpen?.subject?.product_group_id,
      base?.pdpOpen?.subject?.id,
    );
  }

  const canonicalRefCandidates = [
    base?.canonical_product_ref,
    base?.canonicalProductRef,
    skuCandidate?.canonical_product_ref,
    skuCandidate?.canonicalProductRef,
    base?.product_ref,
    base?.productRef,
    skuCandidate?.product_ref,
    skuCandidate?.productRef,
  ];

  let directProductRef = null;
  for (const refRaw of canonicalRefCandidates) {
    const ref = normalizeCanonicalProductRef(refRaw, { requireMerchant: true, allowOpaqueProductId: false });
    if (ref) {
      directProductRef = ref;
      break;
    }
  }

  const rawProductId = pickFirstTrimmed(
    skuCandidate?.product_id,
    skuCandidate?.productId,
    base?.product_id,
    base?.productId,
  );
  const rawMerchantId = pickFirstTrimmed(
    skuCandidate?.merchant_id,
    skuCandidate?.merchantId,
    base?.merchant_id,
    base?.merchantId,
  );

  if (!directProductRef) {
    const fallbackRef = normalizeCanonicalProductRef(
      {
        product_id: rawProductId,
        merchant_id: rawMerchantId,
      },
      { requireMerchant: true, allowOpaqueProductId: false },
    );
    if (fallbackRef) directProductRef = fallbackRef;
  }

  return {
    subjectProductGroupId,
    directProductRef,
    rawProductId,
    rawMerchantId,
  };
}

function buildRecoResolveHints({ base, skuCandidate, rawProductId, rawMerchantId, brand, name, displayName }) {
  const aliases = [];
  const seen = new Set();
  const pushAlias = (value) => {
    const s = String(value || '').trim();
    if (!s) return;
    const key = s.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    aliases.push(s);
  };

  pushAlias(displayName);
  pushAlias(name);
  if (brand && displayName) pushAlias(joinBrandAndName(brand, displayName));
  if (brand && name) pushAlias(joinBrandAndName(brand, name));
  pushAlias(base?.title);

  const hints = {};
  const canonicalHintRef = normalizeCanonicalProductRef(
    {
      product_id: rawProductId,
      merchant_id: rawMerchantId,
    },
    { requireMerchant: false, allowOpaqueProductId: false },
  );
  if (canonicalHintRef) {
    hints.product_ref = canonicalHintRef;
  }
  if (brand) hints.brand = brand;
  if (aliases.length) hints.aliases = aliases.slice(0, 8);
  return hints;
}

function normalizeResolveReasonCode(raw, fallback = 'no_candidates') {
  const code = String(raw || '').trim().toLowerCase();
  if (code === 'db_error' || code === 'upstream_timeout' || code === 'no_candidates') return code;
  return fallback;
}

function normalizePdpOpenMode(raw, fallback = 'external') {
  const mode = String(raw || '').trim().toLowerCase();
  if (mode === 'group' || mode === 'ref' || mode === 'resolve' || mode === 'external') return mode;
  return fallback;
}

function normalizePdpOpenPath(raw, fallback = 'external') {
  const path = String(raw || '').trim().toLowerCase();
  if (path === 'internal' || path === 'external') return path;
  if (path === 'group' || path === 'ref' || path === 'resolve') return 'internal';
  return fallback;
}

function mapResolveFailureCode({ resolveBody, statusCode, error } = {}) {
  const explicit = normalizeResolveReasonCode(
    resolveBody?.reason_code || resolveBody?.reasonCode || resolveBody?.metadata?.resolve_reason_code,
    '',
  );
  if (explicit) return explicit;

  const reason = String(resolveBody?.reason || '').trim().toLowerCase();
  if (reason === 'no_candidates' || reason === 'low_confidence' || reason === 'empty_query') return 'no_candidates';
  if (reason.startsWith('db_') || reason === 'products_cache_missing') return 'db_error';
  if (reason.includes('timeout') || reason.startsWith('upstream_') || reason === 'upstream_error') return 'upstream_timeout';

  const sources = Array.isArray(resolveBody?.metadata?.sources) ? resolveBody.metadata.sources : [];
  const sourceReasons = sources
    .map((item) => String(item && item.reason ? item.reason : '').trim().toLowerCase())
    .filter(Boolean);
  if (sourceReasons.some((r) => r.startsWith('db_') || r === 'products_cache_missing')) return 'db_error';
  if (sourceReasons.some((r) => r.includes('timeout') || r.startsWith('upstream_'))) return 'upstream_timeout';

  const status = Number(statusCode || 0);
  if (status >= 500 || status === 429) return 'upstream_timeout';

  const errText = String(error?.code || error?.message || error || '').trim().toLowerCase();
  if (errText.includes('timeout') || errText.includes('econnaborted') || errText.includes('etimedout')) {
    return 'upstream_timeout';
  }
  if (errText.includes('db_') || errText.includes('database') || errText.includes('postgres')) {
    return 'db_error';
  }
  return 'no_candidates';
}

function shouldAttemptLocalRecoFallback(reasonCode, error) {
  if (reasonCode === 'no_candidates') {
    return RECO_PDP_LOCAL_INVOKE_FALLBACK_ON_NO_CANDIDATES;
  }
  if (reasonCode === 'upstream_timeout') return RECO_PDP_LOCAL_INVOKE_FALLBACK_ON_UPSTREAM_TIMEOUT;
  if (reasonCode === 'db_error') return true;
  if (error) return true;
  return false;
}

function extractCanonicalFromOffersResolveBody(body) {
  const payload = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  const mapping = payload && payload.mapping && typeof payload.mapping === 'object' && !Array.isArray(payload.mapping)
    ? payload.mapping
    : null;
  let canonicalProductGroupId = pickFirstTrimmed(
    mapping?.canonical_product_group_id,
    mapping?.canonicalProductGroupId,
    mapping?.canonical_product_group?.id,
    mapping?.canonical_product_group?.product_group_id,
  );

  const canonicalRefCandidates = [
    mapping?.canonical_ref,
    mapping?.canonical_product_ref,
    payload?.canonical_product_ref,
  ];
  let canonicalProductRef = null;
  for (const candidate of canonicalRefCandidates) {
    const normalized = normalizeCanonicalProductRef(candidate, {
      requireMerchant: true,
      allowOpaqueProductId: false,
    });
    if (normalized) {
      canonicalProductRef = normalized;
      break;
    }
  }

  if (!canonicalProductRef) {
    const canonicalProduct =
      mapping?.canonical_product && typeof mapping.canonical_product === 'object' && !Array.isArray(mapping.canonical_product)
        ? mapping.canonical_product
        : null;
    const fallbackRef = normalizeCanonicalProductRef(
      {
        product_id: pickFirstTrimmed(canonicalProduct?.product_id, canonicalProduct?.id),
        merchant_id: pickFirstTrimmed(
          canonicalProduct?.merchant_id,
          canonicalProduct?.merchantId,
          canonicalProduct?.merchant?.merchant_id,
        ),
      },
      { requireMerchant: true, allowOpaqueProductId: false },
    );
    if (fallbackRef) canonicalProductRef = fallbackRef;
  }

  const pdpTargets = [
    payload?.pdp_target?.v1,
    payload?.pdpTarget?.v1,
    mapping?.pdp_target?.v1,
    mapping?.pdpTarget?.v1,
  ].filter((candidate) => Boolean(candidate) && typeof candidate === 'object' && !Array.isArray(candidate));

  for (const target of pdpTargets) {
    if (!canonicalProductGroupId) {
      const fromSubject = pickFirstTrimmed(
        target?.subject?.product_group_id,
        target?.subject?.productGroupId,
        target?.subject?.id,
        target?.product_group_id,
        target?.productGroupId,
      );
      if (fromSubject) canonicalProductGroupId = fromSubject;
    }

    if (!canonicalProductRef) {
      const fromTargetRef =
        normalizeCanonicalProductRef(target?.canonical_product_ref, {
          requireMerchant: true,
          allowOpaqueProductId: false,
        }) ||
        normalizeCanonicalProductRef(target?.product_ref, {
          requireMerchant: true,
          allowOpaqueProductId: false,
        });
      if (fromTargetRef) canonicalProductRef = fromTargetRef;
    }
  }

  return { canonicalProductRef, canonicalProductGroupId };
}

function resolveRecoStableAliasRefByQuery(queryText) {
  if (!resolveKnownStableProductRef) return null;
  const raw = String(queryText || '').trim();
  if (!raw) return null;

  const normalizedQuery = normalizeTextForStableResolver(raw);
  const queryTokens = tokenizeStableResolverQuery(normalizedQuery);
  if (!normalizedQuery || !Array.isArray(queryTokens) || queryTokens.length === 0) return null;

  const match = resolveKnownStableProductRef({
    query: raw,
    normalizedQuery,
    queryTokens,
  });
  if (!match || !match.product_ref || typeof match.product_ref !== 'object') return null;

  const canonicalProductRef = normalizeCanonicalProductRef(match.product_ref, {
    requireMerchant: true,
    allowOpaqueProductId: false,
  });
  if (!canonicalProductRef) return null;

  return {
    canonicalProductRef,
    matchId: String(match.id || '').trim() || null,
    matchedAlias: String(match.matched_alias || '').trim() || null,
    reason: String(match.reason || '').trim() || 'stable_alias_ref',
    score: Number.isFinite(Number(match.score)) ? Number(match.score) : null,
  };
}

async function resolveRecoPdpByStableIds({
  productId,
  skuId,
  brand,
  name,
  displayName,
  merchantId,
  logger,
  allowLocalInvokeFallback = true,
} = {}) {
  const normalizedProductId = String(productId || '').trim();
  const normalizedSkuId = String(skuId || '').trim();
  const normalizedBrand = String(brand || '').trim();
  const normalizedName = String(name || '').trim();
  const normalizedDisplayName = String(displayName || '').trim();
  const normalizedMerchantId = String(merchantId || '').trim();
  const stableQueryText = pickFirstTrimmed(
    normalizedBrand && normalizedDisplayName
      ? joinBrandAndName(normalizedBrand, normalizedDisplayName)
      : '',
    normalizedBrand && normalizedName ? joinBrandAndName(normalizedBrand, normalizedName) : '',
    normalizedDisplayName,
    normalizedName,
    normalizedSkuId,
    normalizedProductId,
  );

  const stableAliasMatch = resolveRecoStableAliasRefByQuery(stableQueryText);
  if (stableAliasMatch?.canonicalProductRef) {
    logger?.info(
      {
        product_id: normalizedProductId || null,
        sku_id: normalizedSkuId || null,
        match_id: stableAliasMatch.matchId,
        matched_alias: stableAliasMatch.matchedAlias,
        score: stableAliasMatch.score,
      },
      'aurora bff: reco stable-id resolved via local stable alias',
    );
    return {
      ok: true,
      canonicalProductRef: stableAliasMatch.canonicalProductRef,
      requestIds: null,
      localFallbackAttempted: false,
      resolveAttempted: false,
      reasonCode: 'stable_alias_ref',
    };
  }

  if (!PIVOTA_BACKEND_BASE_URL || (!normalizedProductId && !normalizedSkuId)) {
    return { ok: false, reasonCode: 'no_candidates' };
  }

  const stableIdCandidates = [normalizedProductId, normalizedSkuId].filter(Boolean);
  const hasOnlyOpaqueStableIds = stableIdCandidates.length > 0 && stableIdCandidates.every((v) => isUuidLikeString(v));
  if (RECO_PDP_SKIP_OPAQUE_STABLE_IDS && hasOnlyOpaqueStableIds && !normalizedMerchantId) {
    logger?.info(
      {
        product_id: normalizedProductId || null,
        sku_id: normalizedSkuId || null,
        merchant_id: null,
      },
      'aurora bff: reco stable-id offers.resolve skipped for opaque ids without merchant',
    );
    return {
      ok: false,
      reasonCode: 'no_candidates',
      requestIds: null,
      localFallbackAttempted: false,
      resolveAttempted: false,
    };
  }

  let responseBody = null;
  let statusCode = 0;
  let responseError = null;
  let primaryRequestId = null;
  let localRequestId = null;
  let localFallbackAttempted = false;
  const primaryInvokeUrl = `${String(PIVOTA_BACKEND_BASE_URL || '').replace(/\/+$/, '')}/agent/shop/v1/invoke`;
  try {
    const resolvePayload = {
      product: {
        ...(normalizedProductId ? { product_id: normalizedProductId } : {}),
        ...(normalizedSkuId ? { sku_id: normalizedSkuId } : {}),
        ...(normalizedMerchantId ? { merchant_id: normalizedMerchantId } : {}),
        ...(normalizedBrand ? { brand: normalizedBrand } : {}),
        ...(normalizedName ? { name: normalizedName } : {}),
        ...(normalizedDisplayName ? { display_name: normalizedDisplayName } : {}),
        ...(stableQueryText ? { query: stableQueryText } : {}),
      },
      ...(normalizedProductId ? { product_id: normalizedProductId } : {}),
      ...(normalizedSkuId ? { sku_id: normalizedSkuId } : {}),
      ...(stableQueryText ? { query: stableQueryText } : {}),
    };
    const resp = await axios.post(
      primaryInvokeUrl,
      {
        operation: 'offers.resolve',
        payload: resolvePayload,
      },
      {
        headers: buildPivotaBackendAgentHeaders(),
        timeout: RECO_PDP_OFFERS_RESOLVE_TIMEOUT_MS,
        validateStatus: () => true,
      },
    );
    responseBody = resp && typeof resp.data === 'object' ? resp.data : null;
    statusCode = Number(resp?.status || 0);
    primaryRequestId = pickFirstTrimmed(
      responseBody?.metadata?.request_id,
      responseBody?.metadata?.requestId,
      resp?.headers?.['x-request-id'],
      resp?.headers?.['X-Request-Id'],
    );
  } catch (err) {
    responseError = err;
  }

  if (statusCode === 200 && responseBody && String(responseBody.status || '').trim().toLowerCase() === 'success') {
    const { canonicalProductRef, canonicalProductGroupId } = extractCanonicalFromOffersResolveBody(responseBody);
    if (canonicalProductGroupId || canonicalProductRef) {
      return {
        ok: true,
        canonicalProductGroupId,
        canonicalProductRef,
        requestIds:
          primaryRequestId
        ? { primary: primaryRequestId }
        : null,
        localFallbackAttempted: false,
        resolveAttempted: true,
      };
    }
  }

  let reasonCode = mapOfferResolveFailureCode({
    responseBody,
    statusCode,
    error: responseError,
  });

  const localInvokeUrl = `${String(RECO_PDP_LOCAL_INVOKE_BASE_URL || '').replace(/\/+$/, '')}/agent/shop/v1/invoke`;
  const shouldAttemptLocalFallback =
    allowLocalInvokeFallback &&
    RECO_PDP_LOCAL_INVOKE_FALLBACK_CHAT_ENABLED &&
    RECO_PDP_LOCAL_INVOKE_FALLBACK_ENABLED &&
    localInvokeUrl &&
    localInvokeUrl !== primaryInvokeUrl &&
    shouldAttemptLocalRecoFallback(reasonCode, responseError);
  if (
    shouldAttemptLocalFallback
  ) {
    localFallbackAttempted = true;
    let localBody = null;
    let localStatusCode = 0;
    let localError = null;
    try {
      const resp = await axios.post(
        localInvokeUrl,
        {
          operation: 'offers.resolve',
          payload: {
            product: {
              ...(normalizedProductId ? { product_id: normalizedProductId } : {}),
              ...(normalizedSkuId ? { sku_id: normalizedSkuId } : {}),
              ...(normalizedMerchantId ? { merchant_id: normalizedMerchantId } : {}),
              ...(normalizedBrand ? { brand: normalizedBrand } : {}),
              ...(normalizedName ? { name: normalizedName } : {}),
              ...(normalizedDisplayName ? { display_name: normalizedDisplayName } : {}),
              ...(stableQueryText ? { query: stableQueryText } : {}),
            },
            ...(normalizedProductId ? { product_id: normalizedProductId } : {}),
            ...(normalizedSkuId ? { sku_id: normalizedSkuId } : {}),
            ...(stableQueryText ? { query: stableQueryText } : {}),
          },
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: RECO_PDP_LOCAL_INVOKE_TIMEOUT_MS,
          validateStatus: () => true,
        },
      );
      localBody = resp && typeof resp.data === 'object' ? resp.data : null;
      localStatusCode = Number(resp?.status || 0);
      localRequestId = pickFirstTrimmed(
        localBody?.metadata?.request_id,
        localBody?.metadata?.requestId,
        resp?.headers?.['x-request-id'],
        resp?.headers?.['X-Request-Id'],
      );
    } catch (err) {
      localError = err;
    }

    if (localStatusCode === 200 && localBody && String(localBody.status || '').trim().toLowerCase() === 'success') {
      const { canonicalProductRef, canonicalProductGroupId } = extractCanonicalFromOffersResolveBody(localBody);
      if (canonicalProductGroupId || canonicalProductRef) {
        logger?.info(
          {
            product_id: normalizedProductId || null,
            sku_id: normalizedSkuId || null,
            primary_reason_code: reasonCode,
            local_status_code: localStatusCode,
            primary_request_id: primaryRequestId || null,
            local_request_id: localRequestId || null,
          },
          'aurora bff: reco stable-id resolved via local invoke fallback',
        );
        return {
          ok: true,
          canonicalProductGroupId,
          canonicalProductRef,
          requestIds:
            (primaryRequestId || localRequestId)
              ? {
                  ...(primaryRequestId ? { primary: primaryRequestId } : {}),
                  ...(localRequestId ? { local: localRequestId } : {}),
                }
              : null,
          localFallbackAttempted,
          resolveAttempted: true,
        };
      }
    }

    const localReasonCode = mapOfferResolveFailureCode({
      responseBody: localBody,
      statusCode: localStatusCode,
      error: localError,
    });
    logger?.warn(
      {
        product_id: normalizedProductId || null,
        sku_id: normalizedSkuId || null,
        primary_reason_code: reasonCode,
        local_reason_code: localReasonCode,
        local_status_code: localStatusCode || null,
        primary_request_id: primaryRequestId || null,
        local_request_id: localRequestId || null,
        local_err: localError ? localError.message || String(localError) : null,
      },
      'aurora bff: reco stable-id local invoke fallback unresolved',
    );
    if (reasonCode === 'no_candidates' && localReasonCode && localReasonCode !== 'no_candidates') {
      reasonCode = localReasonCode;
    }
  }

  if (!responseError) {
    logger?.warn(
      {
        status_code: statusCode || null,
        product_id: normalizedProductId || null,
        sku_id: normalizedSkuId || null,
        reason_code: reasonCode,
        response_status: responseBody?.status || null,
        primary_request_id: primaryRequestId || null,
        local_fallback_attempted: localFallbackAttempted,
      },
      'aurora bff: reco stable-id offers.resolve unresolved',
    );
  }
  if (responseError) {
    logger?.warn(
      {
        err: responseError?.message || String(responseError),
        product_id: normalizedProductId || null,
        sku_id: normalizedSkuId || null,
        reason_code: reasonCode,
        primary_request_id: primaryRequestId || null,
        local_fallback_attempted: localFallbackAttempted,
      },
      'aurora bff: reco stable-id offers.resolve failed',
    );
  }
  return {
    ok: false,
    reasonCode,
    requestIds:
      (primaryRequestId || localRequestId)
        ? {
            ...(primaryRequestId ? { primary: primaryRequestId } : {}),
            ...(localRequestId ? { local: localRequestId } : {}),
          }
        : null,
    localFallbackAttempted,
    resolveAttempted: true,
  };
}

function buildExternalGoogleSearchUrl(query) {
  const q = String(query || '').trim();
  if (!q) return 'https://www.google.com/';
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}

function withRecoPdpMetadata(base, {
  path,
  subject = null,
  canonicalProductRef = null,
  queryText = '',
  resolveReasonCode = null,
  resolveAttempted = false,
  resolvedViaQuery = null,
  timeToPdpMs = null,
  stableResolveRequestIds = null,
  stableResolveLocalFallbackAttempted = false,
}) {
  const nextMode = normalizePdpOpenMode(path, 'external');
  const nextPath = nextMode === 'external' ? 'external' : 'internal';
  const metadataBase = isPlainObject(base?.metadata) ? { ...base.metadata } : {};
  const normalizedFailReason =
    resolveReasonCode != null && resolveReasonCode !== ''
      ? normalizeResolveReasonCode(resolveReasonCode)
      : null;
  const normalizedTimeToPdp =
    Number.isFinite(Number(timeToPdpMs)) && Number(timeToPdpMs) >= 0
      ? Math.max(0, Math.round(Number(timeToPdpMs)))
      : null;
  const nextMetadata = {
    ...metadataBase,
    pdp_open_path: nextPath,
    pdp_open_mode: nextMode,
    ...(resolveAttempted ? { pdp_open_resolve_attempted: true } : {}),
    ...(normalizedFailReason
      ? {
          resolve_reason_code: normalizedFailReason,
          pdp_open_fail_reason: normalizedFailReason,
          resolve_fail_reason: normalizedFailReason,
        }
      : {}),
    ...(normalizedTimeToPdp != null ? { time_to_pdp_ms: normalizedTimeToPdp } : {}),
    ...(stableResolveRequestIds ? { stable_resolve_request_ids: stableResolveRequestIds } : {}),
    ...(stableResolveRequestIds || stableResolveLocalFallbackAttempted
      ? { stable_resolve_local_fallback_attempted: Boolean(stableResolveLocalFallbackAttempted) }
      : {}),
  };

  const nextSku =
    base && base.sku && typeof base.sku === 'object' && !Array.isArray(base.sku)
      ? { ...base.sku }
      : null;
  if (nextSku && subject?.product_group_id) {
    nextSku.product_group_id = String(subject.product_group_id);
  }
  if (nextSku && canonicalProductRef) {
    nextSku.canonical_product_ref = canonicalProductRef;
    nextSku.product_id = canonicalProductRef.product_id;
    nextSku.productId = canonicalProductRef.product_id;
    nextSku.sku_id = canonicalProductRef.product_id;
    nextSku.skuId = canonicalProductRef.product_id;
    if (canonicalProductRef.merchant_id) {
      nextSku.merchant_id = canonicalProductRef.merchant_id;
      nextSku.merchantId = canonicalProductRef.merchant_id;
    }
  }

  if (nextMode === 'group' && subject) {
    const productGroupId = String(subject.product_group_id || subject.id || '').trim();
    const normalizedSubject = { type: 'product_group', id: productGroupId, product_group_id: productGroupId };
    return {
      ...base,
      ...(nextSku ? { sku: nextSku } : {}),
      subject: normalizedSubject,
      metadata: nextMetadata,
      pdp_open: {
        path: 'group',
        subject: normalizedSubject,
        get_pdp_v2_payload: { subject: { type: 'product_group', id: productGroupId } },
      },
    };
  }

  if ((nextMode === 'ref' || nextMode === 'resolve') && canonicalProductRef) {
    return {
      ...base,
      ...(nextSku ? { sku: nextSku } : {}),
      canonical_product_ref: canonicalProductRef,
      metadata: nextMetadata,
      pdp_open: {
        path: nextMode,
        product_ref: canonicalProductRef,
        get_pdp_v2_payload: { product_ref: canonicalProductRef },
        ...(resolvedViaQuery ? { resolved_via_query: resolvedViaQuery } : {}),
      },
    };
  }

  const externalUrl = buildExternalGoogleSearchUrl(queryText);
  return {
    ...base,
    ...(nextSku ? { sku: nextSku } : {}),
    metadata: nextMetadata,
    pdp_open: {
      path: 'external',
      external: {
        provider: 'google',
        target: '_blank',
        url: externalUrl,
        query: String(queryText || '').trim() || null,
      },
      ...(normalizedFailReason ? { resolve_reason_code: normalizedFailReason } : {}),
    },
  };
}

async function enrichRecoItemWithPdpOpenContract(item, { logger, allowLocalInvokeFallback = true } = {}) {
  const startedAt = Date.now();
  const elapsedMs = () => Math.max(0, Date.now() - startedAt);
  const base = item && typeof item === 'object' && !Array.isArray(item) ? item : null;
  if (!base) return item;

  const skuCandidate =
    base.sku && typeof base.sku === 'object' && !Array.isArray(base.sku)
      ? base.sku
      : base.product && typeof base.product === 'object' && !Array.isArray(base.product)
        ? base.product
        : null;

  const brand = pickFirstTrimmed(skuCandidate?.brand, base.brand);
  const name = pickFirstTrimmed(skuCandidate?.name, base.name);
  const displayName = pickFirstTrimmed(
    skuCandidate?.display_name,
    skuCandidate?.displayName,
    base.display_name,
    base.displayName,
    name,
  );

  const { subjectProductGroupId, directProductRef, rawProductId, rawMerchantId } = extractRecoPdpDirectKeys(
    base,
    skuCandidate,
  );

  if (subjectProductGroupId) {
    return withRecoPdpMetadata(base, {
      path: 'group',
      subject: { type: 'product_group', id: subjectProductGroupId, product_group_id: subjectProductGroupId },
      canonicalProductRef: directProductRef,
      timeToPdpMs: elapsedMs(),
    });
  }

  if (directProductRef) {
    return withRecoPdpMetadata(base, {
      path: 'ref',
      canonicalProductRef: directProductRef,
      timeToPdpMs: elapsedMs(),
    });
  }

  const stableProductId = pickFirstTrimmed(
    rawProductId,
    skuCandidate?.product_id,
    skuCandidate?.productId,
    base?.product_id,
    base?.productId,
  );
  const stableSkuId = pickFirstTrimmed(
    skuCandidate?.sku_id,
    skuCandidate?.skuId,
    base?.sku_id,
    base?.skuId,
    stableProductId,
  );
  let stableResolveReasonCode = null;
  let stableResolveRequestIds = null;
  let stableResolveLocalFallbackAttempted = false;
  if (RECO_PDP_RESOLVE_ENABLED && PIVOTA_BACKEND_BASE_URL && (stableProductId || stableSkuId)) {
    const stableResolved = await resolveRecoPdpByStableIds({
      productId: stableProductId,
      skuId: stableSkuId,
      brand,
      name,
      displayName,
      merchantId: rawMerchantId,
      logger,
      allowLocalInvokeFallback,
    });
    stableResolveRequestIds =
      stableResolved?.requestIds && typeof stableResolved.requestIds === 'object'
        ? stableResolved.requestIds
        : null;
    stableResolveLocalFallbackAttempted = Boolean(stableResolved?.localFallbackAttempted);
    if (stableResolved.ok && stableResolved.canonicalProductGroupId) {
      return withRecoPdpMetadata(base, {
        path: 'group',
        subject: {
          type: 'product_group',
          id: stableResolved.canonicalProductGroupId,
          product_group_id: stableResolved.canonicalProductGroupId,
        },
        canonicalProductRef: stableResolved.canonicalProductRef || null,
        resolveAttempted: stableResolved.resolveAttempted === true,
        timeToPdpMs: elapsedMs(),
        stableResolveRequestIds,
        stableResolveLocalFallbackAttempted,
      });
    }
    if (stableResolved.ok && stableResolved.canonicalProductRef) {
      return withRecoPdpMetadata(base, {
        path: 'ref',
        canonicalProductRef: stableResolved.canonicalProductRef,
        resolveAttempted: stableResolved.resolveAttempted === true,
        timeToPdpMs: elapsedMs(),
        stableResolveRequestIds,
        stableResolveLocalFallbackAttempted,
      });
    }
    stableResolveReasonCode = stableResolved.reasonCode || null;
  }

  const queryText =
    buildProductInputText(skuCandidate || base, typeof base.url === 'string' ? base.url : null) ||
    pickFirstTrimmed(displayName, name, brand);
  const stableResolveFailureCode = normalizeResolveReasonCode(stableResolveReasonCode || '', null);
  if (
    RECO_PDP_SKIP_QUERY_RESOLVE_ON_STABLE_FAILURE &&
    stableResolveFailureCode &&
    stableResolveFailureCode !== 'no_candidates'
  ) {
    return withRecoPdpMetadata(base, {
      path: 'external',
      queryText,
      resolveReasonCode: stableResolveFailureCode,
      resolveAttempted: true,
      timeToPdpMs: elapsedMs(),
      stableResolveRequestIds,
      stableResolveLocalFallbackAttempted,
    });
  }

  const hints = buildRecoResolveHints({
    base,
    skuCandidate,
    rawProductId,
    rawMerchantId,
    brand,
    name,
    displayName,
  });

  if (!RECO_PDP_RESOLVE_ENABLED || !PIVOTA_BACKEND_BASE_URL || !queryText) {
    return withRecoPdpMetadata(base, {
      path: 'external',
      queryText,
      resolveReasonCode: stableResolveReasonCode || 'no_candidates',
      resolveAttempted: false,
      timeToPdpMs: elapsedMs(),
      stableResolveRequestIds,
      stableResolveLocalFallbackAttempted,
    });
  }

  // Avoid opaque UUID-only lookups; they frequently produce unstable cross-merchant misses.
  const isOpaqueUuidOnlyQuery = isUuidLikeString(queryText) && (!hints.aliases || hints.aliases.length === 0);
  if (isOpaqueUuidOnlyQuery) {
    return withRecoPdpMetadata(base, {
      path: 'external',
      queryText,
      resolveReasonCode: stableResolveReasonCode || 'no_candidates',
      resolveAttempted: false,
      timeToPdpMs: elapsedMs(),
      stableResolveRequestIds,
      stableResolveLocalFallbackAttempted,
    });
  }

  let resolveBody = null;
  let resolveStatus = 0;
  let resolveError = null;
  const primaryResolveUrl = `${PIVOTA_BACKEND_BASE_URL}/agent/v1/products/resolve`;
  const queryResolvePayload = {
    query: queryText,
    lang: 'en',
    hints,
    options: {
      search_all_merchants: true,
      timeout_ms: RECO_PDP_RESOLVE_TIMEOUT_MS,
      upstream_retries: 0,
      ...(rawMerchantId ? { prefer_merchants: [rawMerchantId] } : {}),
    },
    caller: 'aurora_chatbox',
  };
  try {
    const resp = await axios.post(
      primaryResolveUrl,
      queryResolvePayload,
      {
        headers: buildPivotaBackendAgentHeaders(),
        timeout: RECO_PDP_RESOLVE_TIMEOUT_MS,
        validateStatus: () => true,
      },
    );
    resolveBody = resp && typeof resp.data === 'object' ? resp.data : null;
    resolveStatus = Number(resp?.status || 0);
  } catch (err) {
    resolveError = err;
  }

  const resolvedProductRef = normalizeCanonicalProductRef(resolveBody?.product_ref, {
    requireMerchant: true,
    allowOpaqueProductId: false,
  });
  if (resolveStatus === 200 && resolveBody?.resolved === true && resolvedProductRef) {
    return withRecoPdpMetadata(base, {
      path: 'resolve',
      canonicalProductRef: resolvedProductRef,
      resolveAttempted: true,
      resolvedViaQuery: queryText,
      timeToPdpMs: elapsedMs(),
    });
  }

  let reasonCode = mapResolveFailureCode({
    resolveBody,
    statusCode: resolveStatus,
    error: resolveError,
  });
  const localResolveUrl = `${String(RECO_PDP_LOCAL_INVOKE_BASE_URL || '').replace(/\/+$/, '')}/agent/v1/products/resolve`;
  const shouldAttemptLocalResolveFallback =
    allowLocalInvokeFallback &&
    RECO_PDP_LOCAL_INVOKE_FALLBACK_CHAT_ENABLED &&
    RECO_PDP_LOCAL_INVOKE_FALLBACK_ENABLED &&
    localResolveUrl &&
    localResolveUrl !== primaryResolveUrl &&
    shouldAttemptLocalRecoFallback(reasonCode, resolveError);
  if (shouldAttemptLocalResolveFallback) {
    let localResolveBody = null;
    let localResolveStatus = 0;
    let localResolveError = null;
    try {
      const resp = await axios.post(
        localResolveUrl,
        queryResolvePayload,
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: RECO_PDP_LOCAL_INVOKE_TIMEOUT_MS,
          validateStatus: () => true,
        },
      );
      localResolveBody = resp && typeof resp.data === 'object' ? resp.data : null;
      localResolveStatus = Number(resp?.status || 0);
    } catch (err) {
      localResolveError = err;
    }

    const localResolvedProductRef = normalizeCanonicalProductRef(localResolveBody?.product_ref, {
      requireMerchant: true,
      allowOpaqueProductId: false,
    });
    if (localResolveStatus === 200 && localResolveBody?.resolved === true && localResolvedProductRef) {
      logger?.info(
        {
          query: queryText.slice(0, 120),
          primary_reason_code: reasonCode,
          local_status_code: localResolveStatus,
        },
        'aurora bff: reco pdp resolved via local products.resolve fallback',
      );
      return withRecoPdpMetadata(base, {
        path: 'resolve',
        canonicalProductRef: localResolvedProductRef,
        resolveAttempted: true,
        resolvedViaQuery: queryText,
        timeToPdpMs: elapsedMs(),
        stableResolveRequestIds,
        stableResolveLocalFallbackAttempted,
      });
    }

    const localReasonCode = mapResolveFailureCode({
      resolveBody: localResolveBody,
      statusCode: localResolveStatus,
      error: localResolveError,
    });
    if (reasonCode === 'no_candidates' && localReasonCode && localReasonCode !== 'no_candidates') {
      reasonCode = localReasonCode;
    }
    logger?.warn(
      {
        query: queryText.slice(0, 120),
        primary_reason_code: reasonCode,
        local_reason_code: localReasonCode,
        local_status_code: localResolveStatus || null,
        local_err: localResolveError ? localResolveError.message || String(localResolveError) : null,
      },
      'aurora bff: reco pdp local products.resolve fallback unresolved',
    );
  }
  if (resolveError) {
    logger?.warn(
      {
        err: resolveError?.message || String(resolveError),
        query: queryText.slice(0, 120),
        pdp_open_path: 'external',
        fail_reason: reasonCode,
        resolve_reason_code: reasonCode,
      },
      'aurora bff: reco pdp resolve failed; using external fallback',
    );
  }
  return withRecoPdpMetadata(base, {
    path: 'external',
    queryText,
    resolveReasonCode: reasonCode,
    resolveAttempted: true,
    timeToPdpMs: elapsedMs(),
    stableResolveRequestIds,
    stableResolveLocalFallbackAttempted,
  });
}

function tallyPdpOpenPathStats(recommendations) {
  const stats = { group: 0, ref: 0, resolve: 0, external: 0 };
  for (const item of Array.isArray(recommendations) ? recommendations : []) {
    const mode = normalizePdpOpenMode(
      item?.pdp_open?.path || item?.metadata?.pdp_open_mode || item?.metadata?.pdp_open_path,
      'external',
    );
    if (mode === 'group' || mode === 'ref' || mode === 'resolve' || mode === 'external') {
      stats[mode] += 1;
    } else {
      stats.external += 1;
    }
  }
  return stats;
}

function tallyResolveFailReasonCounts(recommendations) {
  const counts = { db_error: 0, upstream_timeout: 0, no_candidates: 0 };
  for (const item of Array.isArray(recommendations) ? recommendations : []) {
    const code = normalizeResolveReasonCode(
      item?.metadata?.pdp_open_fail_reason ||
        item?.metadata?.resolve_reason_code ||
        item?.metadata?.resolve_fail_reason ||
        item?.pdp_open?.resolve_reason_code,
      '',
    );
    if (code === 'db_error' || code === 'upstream_timeout' || code === 'no_candidates') {
      counts[code] += 1;
    }
  }
  return counts;
}

function summarizeTimeToPdpStats(items) {
  const values = [];
  for (const item of Array.isArray(items) ? items : []) {
    const raw = item?.metadata?.time_to_pdp_ms;
    const num = Number(raw);
    if (!Number.isFinite(num) || num < 0) continue;
    values.push(Math.round(num));
  }
  values.sort((a, b) => a - b);

  if (!values.length) {
    return { count: 0, mean: 0, p50: 0, p90: 0, max: 0 };
  }

  const pickPercentile = (p) => {
    const idx = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * p) - 1));
    return values[idx];
  };
  const sum = values.reduce((acc, v) => acc + v, 0);
  return {
    count: values.length,
    mean: Math.round(sum / values.length),
    p50: pickPercentile(0.5),
    p90: pickPercentile(0.9),
    max: values[values.length - 1],
  };
}

function mapOfferResolveFailureCode({ responseBody, statusCode, error } = {}) {
  const explicit = normalizeResolveReasonCode(
    responseBody?.reason_code || responseBody?.reasonCode || responseBody?.metadata?.reason_code || responseBody?.metadata?.resolve_reason_code,
    '',
  );
  if (explicit) return explicit;

  const reason = String(
    responseBody?.reason ||
      responseBody?.error ||
      responseBody?.code ||
      responseBody?.message ||
      '',
  )
    .trim()
    .toLowerCase();
  if (reason.startsWith('db_') || reason.includes('database') || reason.includes('postgres')) return 'db_error';
  if (reason.includes('timeout') || reason.startsWith('upstream_') || reason === 'upstream_error') return 'upstream_timeout';
  if (reason === 'no_candidates' || reason === 'not_found' || reason === 'not_found_in_cache') return 'no_candidates';

  const status = Number(statusCode || 0);
  if (status >= 500 || status === 429 || status === 408) return 'upstream_timeout';

  const errText = String(error?.code || error?.message || error || '').trim().toLowerCase();
  if (errText.includes('timeout') || errText.includes('econnaborted') || errText.includes('etimedout')) {
    return 'upstream_timeout';
  }
  if (errText.includes('db_') || errText.includes('database') || errText.includes('postgres')) {
    return 'db_error';
  }
  return 'no_candidates';
}

function applyOfferItemPdpOpenContract(item, { failReasonCode = null, resolveAttempted = false, timeToPdpMs = null } = {}) {
  const base = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
  const product = base.product && typeof base.product === 'object' && !Array.isArray(base.product) ? { ...base.product } : {};
  const offer = base.offer && typeof base.offer === 'object' && !Array.isArray(base.offer) ? { ...base.offer } : base.offer;
  const failReason =
    failReasonCode != null && failReasonCode !== ''
      ? normalizeResolveReasonCode(failReasonCode)
      : null;
  const { subjectProductGroupId, directProductRef } = extractRecoPdpDirectKeys(product, product);

  const metadataBase = isPlainObject(base.metadata) ? { ...base.metadata } : {};
  const normalizedTimeToPdp =
    Number.isFinite(Number(timeToPdpMs)) && Number(timeToPdpMs) >= 0
      ? Math.max(0, Math.round(Number(timeToPdpMs)))
      : null;
  const metadata = {
    ...metadataBase,
    ...(resolveAttempted ? { offer_resolve_attempted: true } : {}),
    ...(normalizedTimeToPdp != null ? { time_to_pdp_ms: normalizedTimeToPdp } : {}),
  };

  if (subjectProductGroupId) {
    const subject = {
      type: 'product_group',
      id: subjectProductGroupId,
      product_group_id: subjectProductGroupId,
    };
    product.product_group_id = subjectProductGroupId;
    if (directProductRef) product.canonical_product_ref = directProductRef;
    metadata.pdp_open_path = 'internal';
    metadata.pdp_open_mode = 'group';
    if (failReason) {
      metadata.pdp_open_fail_reason = failReason;
      metadata.resolve_reason_code = failReason;
      metadata.resolve_fail_reason = failReason;
    }
    return {
      ...base,
      product,
      ...(offer && typeof offer === 'object' ? { offer } : {}),
      metadata,
      pdp_open: {
        path: 'group',
        subject,
        get_pdp_v2_payload: { subject: { type: 'product_group', id: subjectProductGroupId } },
      },
    };
  }

  if (directProductRef) {
    product.canonical_product_ref = directProductRef;
    metadata.pdp_open_path = 'internal';
    metadata.pdp_open_mode = 'ref';
    if (failReason) {
      metadata.pdp_open_fail_reason = failReason;
      metadata.resolve_reason_code = failReason;
      metadata.resolve_fail_reason = failReason;
    }
    return {
      ...base,
      product,
      ...(offer && typeof offer === 'object' ? { offer } : {}),
      metadata,
      pdp_open: {
        path: 'ref',
        product_ref: directProductRef,
        get_pdp_v2_payload: { product_ref: directProductRef },
      },
    };
  }

  const offerUrl =
    (offer && typeof offer === 'object' && typeof offer.affiliate_url === 'string' && offer.affiliate_url.trim()) ||
    (offer && typeof offer === 'object' && typeof offer.affiliateUrl === 'string' && offer.affiliateUrl.trim()) ||
    (offer && typeof offer === 'object' && typeof offer.url === 'string' && offer.url.trim()) ||
    '';
  const queryText = buildProductInputText(product, offerUrl) || pickFirstTrimmed(product.display_name, product.name, product.brand);
  metadata.pdp_open_path = 'external';
  metadata.pdp_open_mode = 'external';
  if (failReason) {
    metadata.pdp_open_fail_reason = failReason;
    metadata.resolve_reason_code = failReason;
    metadata.resolve_fail_reason = failReason;
  }

  return {
    ...base,
    product,
    ...(offer && typeof offer === 'object' ? { offer } : {}),
    metadata,
    pdp_open: {
      path: 'external',
      external: {
        provider: 'google',
        target: '_blank',
        url: buildExternalGoogleSearchUrl(queryText),
        query: queryText || null,
      },
      ...(failReason ? { resolve_reason_code: failReason } : {}),
    },
  };
}

function summarizeOfferPdpOpen(items) {
  const stats = { internal: 0, external: 0 };
  const failReasonCounts = { db_error: 0, upstream_timeout: 0, no_candidates: 0 };
  for (const item of Array.isArray(items) ? items : []) {
    const path = normalizePdpOpenPath(item?.metadata?.pdp_open_path || item?.pdp_open?.path, 'external');
    if (path === 'internal') stats.internal += 1;
    else stats.external += 1;

    const failReason = normalizeResolveReasonCode(
      item?.metadata?.pdp_open_fail_reason || item?.metadata?.resolve_reason_code || item?.pdp_open?.resolve_reason_code,
      '',
    );
    if (failReason === 'db_error' || failReason === 'upstream_timeout' || failReason === 'no_candidates') {
      failReasonCounts[failReason] += 1;
    }
  }
  return {
    path_stats: stats,
    fail_reason_counts: failReasonCounts,
    time_to_pdp_ms_stats: summarizeTimeToPdpStats(items),
  };
}

function buildRecoPdpQuickItem(item, { fastFallbackReasonCode = null } = {}) {
  const base = item && typeof item === 'object' && !Array.isArray(item) ? item : null;
  if (!base) return item;
  const skuCandidate =
    base.sku && typeof base.sku === 'object' && !Array.isArray(base.sku)
      ? base.sku
      : base.product && typeof base.product === 'object' && !Array.isArray(base.product)
        ? base.product
        : null;

  const {
    subjectProductGroupId,
    directProductRef,
    rawProductId,
  } = extractRecoPdpDirectKeys(base, skuCandidate);
  if (subjectProductGroupId) {
    return withRecoPdpMetadata(base, {
      path: 'group',
      subject: { type: 'product_group', id: subjectProductGroupId, product_group_id: subjectProductGroupId },
      canonicalProductRef: directProductRef,
      resolveAttempted: false,
      timeToPdpMs: 0,
    });
  }
  if (directProductRef) {
    return withRecoPdpMetadata(base, {
      path: 'ref',
      canonicalProductRef: directProductRef,
      resolveAttempted: false,
      timeToPdpMs: 0,
    });
  }

  const brand = pickFirstTrimmed(skuCandidate?.brand, base.brand);
  const name = pickFirstTrimmed(skuCandidate?.name, base.name);
  const displayName = pickFirstTrimmed(
    skuCandidate?.display_name,
    skuCandidate?.displayName,
    base.display_name,
    base.displayName,
    name,
  );
  const stableProductId = pickFirstTrimmed(
    rawProductId,
    skuCandidate?.product_id,
    skuCandidate?.productId,
    base?.product_id,
    base?.productId,
  );
  const stableSkuId = pickFirstTrimmed(
    skuCandidate?.sku_id,
    skuCandidate?.skuId,
    base?.sku_id,
    base?.skuId,
    stableProductId,
  );
  const stableQueryText = pickFirstTrimmed(
    brand && displayName ? joinBrandAndName(brand, displayName) : '',
    brand && name ? joinBrandAndName(brand, name) : '',
    displayName,
    name,
    stableSkuId,
    stableProductId,
  );
  const stableAliasMatch = resolveRecoStableAliasRefByQuery(stableQueryText);
  if (stableAliasMatch?.canonicalProductRef) {
    return withRecoPdpMetadata(base, {
      path: 'ref',
      canonicalProductRef: stableAliasMatch.canonicalProductRef,
      resolveAttempted: false,
      timeToPdpMs: 0,
    });
  }

  const queryText =
    buildProductInputText(skuCandidate || base, typeof base.url === 'string' ? base.url : null) ||
    pickFirstTrimmed(
      skuCandidate?.display_name,
      skuCandidate?.displayName,
      skuCandidate?.name,
      base.display_name,
      base.displayName,
      base.name,
      base.brand,
    );
  return withRecoPdpMetadata(base, {
    path: 'external',
    queryText,
    resolveReasonCode: fastFallbackReasonCode,
    resolveAttempted: false,
    timeToPdpMs: 0,
  });
}

async function enrichRecommendationsWithPdpOpenContract({
  recommendations,
  logger,
  fastExternalFallbackReasonCode = null,
} = {}) {
  const recos = Array.isArray(recommendations) ? recommendations : [];
  if (!recos.length) {
    return {
      recommendations: recos,
      path_stats: { group: 0, ref: 0, resolve: 0, external: 0 },
      fail_reason_counts: { db_error: 0, upstream_timeout: 0, no_candidates: 0 },
      time_to_pdp_ms_stats: { count: 0, mean: 0, p50: 0, p90: 0, max: 0 },
    };
  }

  const fastFallbackReasonCode = normalizeResolveReasonCode(fastExternalFallbackReasonCode || '', null);
  if (fastFallbackReasonCode) {
    const fastExternal = recos.map((item) => buildRecoPdpQuickItem(item, { fastFallbackReasonCode }));
    return {
      recommendations: fastExternal,
      path_stats: tallyPdpOpenPathStats(fastExternal),
      fail_reason_counts: tallyResolveFailReasonCounts(fastExternal),
      time_to_pdp_ms_stats: summarizeTimeToPdpStats(fastExternal),
    };
  }

  const networkItemCap = Math.max(0, Math.min(recos.length, RECO_PDP_ENRICH_MAX_NETWORK_ITEMS));
  const allowLocalInvokeFallback = !RECO_PDP_CHAT_DISABLE_LOCAL_DOUBLE_HOP;
  const enriched = await mapWithConcurrency(recos, RECO_PDP_ENRICH_CONCURRENCY, async (item, idx) => {
    if (idx >= networkItemCap) return buildRecoPdpQuickItem(item, { fastFallbackReasonCode: null });
    return enrichRecoItemWithPdpOpenContract(item, { logger, allowLocalInvokeFallback });
  });
  const normalized = enriched.map((item, idx) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) return item;
    return recos[idx];
  });

  return {
    recommendations: normalized,
    path_stats: tallyPdpOpenPathStats(normalized),
    fail_reason_counts: tallyResolveFailReasonCounts(normalized),
    time_to_pdp_ms_stats: summarizeTimeToPdpStats(normalized),
  };
}

function coerceRecoItemForUi(item, { lang } = {}) {
  const base = item && typeof item === 'object' && !Array.isArray(item) ? item : null;
  if (!base) return item;

  const skuCandidate =
    base.sku && typeof base.sku === 'object' && !Array.isArray(base.sku)
      ? base.sku
      : base.product && typeof base.product === 'object' && !Array.isArray(base.product)
        ? base.product
        : null;

  const skuId =
    (skuCandidate && typeof skuCandidate.sku_id === 'string' ? skuCandidate.sku_id : null) ||
    (skuCandidate && typeof skuCandidate.skuId === 'string' ? skuCandidate.skuId : null) ||
    (typeof base.sku_id === 'string' ? base.sku_id : null) ||
    (typeof base.skuId === 'string' ? base.skuId : null) ||
    (skuCandidate && typeof skuCandidate.product_id === 'string' ? skuCandidate.product_id : null) ||
    (skuCandidate && typeof skuCandidate.productId === 'string' ? skuCandidate.productId : null) ||
    (typeof base.product_id === 'string' ? base.product_id : null) ||
    (typeof base.productId === 'string' ? base.productId : null) ||
    null;

  const productId =
    (skuCandidate && typeof skuCandidate.product_id === 'string' ? skuCandidate.product_id : null) ||
    (skuCandidate && typeof skuCandidate.productId === 'string' ? skuCandidate.productId : null) ||
    (typeof base.product_id === 'string' ? base.product_id : null) ||
    (typeof base.productId === 'string' ? base.productId : null) ||
    null;

  const brand =
    (skuCandidate && typeof skuCandidate.brand === 'string' ? skuCandidate.brand.trim() : '') ||
    (typeof base.brand === 'string' ? base.brand.trim() : '') ||
    '';
  const name =
    (skuCandidate && typeof skuCandidate.name === 'string' ? skuCandidate.name.trim() : '') ||
    (typeof base.name === 'string' ? base.name.trim() : '') ||
    '';
  const displayName =
    (skuCandidate && typeof skuCandidate.display_name === 'string' ? skuCandidate.display_name.trim() : '') ||
    (skuCandidate && typeof skuCandidate.displayName === 'string' ? skuCandidate.displayName.trim() : '') ||
    (typeof base.display_name === 'string' ? base.display_name.trim() : '') ||
    (typeof base.displayName === 'string' ? base.displayName.trim() : '') ||
    name ||
    '';
  const category =
    (skuCandidate && typeof skuCandidate.category === 'string' ? skuCandidate.category.trim() : '') ||
    (typeof base.category === 'string' ? base.category.trim() : '') ||
    '';

  const slotRaw = typeof base.slot === 'string' ? base.slot.trim().toLowerCase() : '';
  const slot = slotRaw === 'am' || slotRaw === 'pm' ? slotRaw : 'other';
  const step =
    (typeof base.step === 'string' && base.step.trim()) ||
    (typeof base.category === 'string' && base.category.trim()) ||
    category ||
    (String(lang || '').toUpperCase() === 'CN' ? '推荐' : 'Recommendation');

  const notesRaw =
    Array.isArray(base.notes) ? base.notes
      : Array.isArray(base.reasons) ? base.reasons
        : Array.isArray(base.why) ? base.why
          : typeof base.reason === 'string' ? [base.reason]
            : typeof base.why === 'string' ? [base.why]
              : [];

  const notes = Array.isArray(notesRaw)
    ? notesRaw
      .map((v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim()))
      .filter(Boolean)
      .slice(0, 8)
    : [];

  const nextSku = skuCandidate || skuId || productId || brand || name || displayName || category
    ? {
      ...(skuCandidate && typeof skuCandidate === 'object' ? skuCandidate : {}),
      ...(skuId ? { sku_id: skuId } : {}),
      ...(productId ? { product_id: productId } : {}),
      ...(brand ? { brand } : {}),
      ...(name ? { name } : {}),
      ...(displayName ? { display_name: displayName } : {}),
      ...(category ? { category } : {}),
    }
    : null;

  return {
    ...base,
    slot,
    step,
    ...(nextSku ? { sku: nextSku } : {}),
    ...(notes.length ? { notes } : {}),
  };
}

function buildAuroraRoutineQuery({ profile, focus, constraints, lang }) {
  const skinType = profile && typeof profile.skinType === 'string' ? profile.skinType : 'unknown';
  const barrierStatus = mapBarrierStatus(profile && profile.barrierStatus);
  const concerns = mapConcerns(profile && profile.goals);
  const region = profile && typeof profile.region === 'string' && profile.region.trim() ? profile.region.trim() : 'US';
  const budgetKnown = normalizeBudgetHint(profile && profile.budgetTier) || normalizeBudgetHint(constraints && constraints.budget) || '';
  const budget = budgetKnown || 'unknown';
  const goal = typeof focus === 'string' && focus.trim()
    ? focus.trim()
    : constraints && typeof constraints.goal === 'string' && constraints.goal.trim()
      ? constraints.goal.trim()
      : 'balanced routine';
  const preference = constraints && typeof constraints.preference === 'string' && constraints.preference.trim()
    ? constraints.preference.trim()
    : 'No special preference';

  const concernsStr = concerns.length ? concerns.join(', ') : 'none';
  const reply = lang === 'CN' ? 'Chinese' : 'English';
  const budgetRule = budgetKnown
    ? 'Budget is provided; keep product picks close to this budget band.'
    : 'Budget is unknown; provide a balanced-value baseline first and do not ask budget in the first response unless user explicitly asks to optimize by budget.';

  const productsNote = profile && profile.currentRoutine ? `Current routine: ${JSON.stringify(profile.currentRoutine).slice(0, 1000)}\n` : '';

  return (
    `User profile: skin type ${skinType}; barrier status: ${barrierStatus}; concerns: ${concernsStr}; region: ${region}; budget: ${budget}.\n` +
    `Goal: ${goal}.\n` +
    `${productsNote}` +
    `Preference: ${preference}.\n` +
    `${budgetRule}\n` +
    `Please recommend a simple AM/PM skincare routine. Reply in ${reply}.`
  );
}

function buildAuroraProductRecommendationsQuery({ profile, requestText, lang }) {
  const skinType = profile && typeof profile.skinType === 'string' ? profile.skinType : 'unknown';
  const barrierStatus = mapBarrierStatus(profile && profile.barrierStatus);
  const concerns = mapConcerns(profile && profile.goals);
  const region = profile && typeof profile.region === 'string' && profile.region.trim() ? profile.region.trim() : 'US';
  const budgetKnown = normalizeBudgetHint(profile && profile.budgetTier) || '';
  const budget = budgetKnown || 'unknown';
  const concernsStr = concerns.length ? concerns.join(', ') : 'none';
  const replyLang = lang === 'CN' ? 'Chinese' : 'English';
  const req = typeof requestText === 'string' ? requestText.trim() : '';
  const budgetReasonRule = budgetKnown
    ? 'If budget is known, include one reason that references budget fit.'
    : 'If budget is unknown, do not ask budget in the first response; focus on efficacy/tolerance and balanced value.';

  return (
    `User profile: skin type ${skinType}; barrier status: ${barrierStatus}; concerns: ${concernsStr}; region: ${region}; budget: ${budget}.\n` +
    (req ? `User request: ${req}\n` : '') +
    `Task: Generate skincare product picks (NOT a full AM/PM routine).\n` +
    `Return ONLY a JSON object with keys: recommendations (array), evidence (object), confidence (0..1), missing_info (string[]), warnings (string[]).\n` +
    `recommendations: up to 5 items, ranked.\n` +
    `Each recommendation item MUST include:\n` +
    `- slot: "other"\n` +
    `- step: category label (cleanser/sunscreen/treatment/moisturizer/other)\n` +
    `- score: integer 0..100 (fit score)\n` +
    `- sku: {brand,name,display_name,sku_id,product_id,category,availability(string[]),price{usd,cny,unknown}}\n` +
    `- reasons: string[] (max 4). Reasons must be end-user readable and user-specific.\n` +
    `  - Include at least one reason that explicitly references the user's profile (skin type / sensitivity / barrier / goals).\n` +
    `  - ${budgetReasonRule}\n` +
    `  - If recent_logs were provided, include one reason that references the last 7 days trend; otherwise add warnings: "recent_logs_missing".\n` +
    `  - If profile.itinerary (upcoming plan/travel context) is available, include one reason that references it.\n` +
    `  - If upcoming plan/travel context is not available, add warnings: "itinerary_unknown" (do NOT guess).\n` +
    `- evidence_pack: {keyActives,sensitivityFlags,pairingRules,comparisonNotes,citations} (omit unknown keys; do NOT fabricate).\n` +
    `- missing_info: string[] (per-item; ONLY user-provided fields like budget_unknown)\n` +
    `- warnings: string[] (per-item; quality signals like over_budget/price_unknown/recent_logs_missing)\n` +
    `Rules:\n` +
    `- Do NOT include checkout links.\n` +
    `- Do NOT recommend the exact same sku_id/product_id twice.\n` +
    `- If unsure, use null/unknown and list missing_info/warnings (do not fabricate).\n` +
    `- All free-text strings should be in ${replyLang}.\n`
  );
}

function looksLikeRoutineRequest(message, action) {
  const text = String(message || '').trim().toLowerCase();
  const id =
    typeof action === 'string'
      ? action
      : action && typeof action === 'object'
        ? action.action_id
        : '';
  const idText = String(id || '').trim().toLowerCase();

  const routineByAction = idText.includes('routine') || idText.includes('reco_routine');
  const routineByMessage =
    Boolean(text) &&
    (text.includes('routine') ||
      /am\s*\/\s*pm/.test(text) ||
      /生成.*(早晚|am|pm).*(护肤|routine)/.test(text) ||
      /(早晚护肤|护肤方案)/.test(text));

  // Guard against stale UI action_id leakage: when user typed a non-routine message,
  // do not let a previous routine chip/action force routine routing.
  if (routineByAction && text && !routineByMessage) return false;

  if (routineByAction) return true;
  return routineByMessage;
}

function looksLikeIngredientScienceIntent(message, action) {
  const raw = String(message || '').trim();
  const text = raw.toLowerCase();
  const id =
    typeof action === 'string'
      ? action
      : action && typeof action === 'object'
        ? action.action_id
        : '';
  const idText = String(id || '').trim().toLowerCase();

  if (idText === 'chip.start.ingredients' || idText === 'chip_start_ingredients') return true;

  const en =
    /\b(ingredient|ingredients|active|actives)\b.{0,28}\b(science|evidence|mechanism|clinical|study|paper|citation|citations)\b/i.test(raw) ||
    /\b(science|evidence|mechanism|clinical|study|paper|citation|citations)\b.{0,28}\b(ingredient|ingredients|active|actives)\b/i.test(raw);
  const cn = /(成分(机理|机制|科学|证据|原理)|证据链|循证|临床证据|论文证据|问成分)/.test(raw);
  return en || cn;
}

function messageContainsSpecificIngredientScienceTarget(message) {
  const raw = String(message || '').trim();
  if (!raw) return false;
  const lower = raw.toLowerCase();
  if (extractKnownActivesFromText(raw).length > 0) return true;

  const specificIngredient =
    /\b(niacinamide|retinol|retinoid|adapalene|tretinoin|vitamin\s*c|ascorbic|azelaic|salicylic|glycolic|mandelic|pha|ceramide|peptide|tranexamic|arbutin)\b/i
      .test(lower) ||
    /(烟酰胺|a醇|维a|阿达帕林|维c|维生素c|壬二酸|水杨酸|果酸|杏仁酸|神经酰胺|多肽|胜肽|传明酸|熊果苷)/.test(raw);
  if (specificIngredient) return true;

  const specificEffect =
    /\b(acne|breakout|redness|sensitive|dark spots?|hyperpigmentation|brightening|pores?|anti[-\s]?aging|wrinkles?|barrier|irritation)\b/i.test(lower) ||
    /(痘|闭口|泛红|敏感|淡斑|色沉|提亮|毛孔|抗老|细纹|屏障|刺激|刺痛|修护)/.test(raw);
  return specificEffect;
}

function buildIngredientScienceKickoff({ language } = {}) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  if (lang === 'CN') {
    return {
      prompt:
        '这个问题很好，我会用“证据 + 机制 + 风险”给你讲清楚。\n' +
        '先确认一个最关键点：你更想先看哪一类？',
      chips: [
        {
          chip_id: 'chip.science.target.niacinamide',
          label: '烟酰胺（证据）',
          kind: 'quick_reply',
          data: { reply_text: '问成分科学：烟酰胺。请讲证据强度、适用人群和常见风险。' },
        },
        {
          chip_id: 'chip.science.target.retinoid',
          label: 'A醇/维A类（证据）',
          kind: 'quick_reply',
          data: { reply_text: '问成分科学：A醇/维A类。请讲机制、证据等级和使用风险。' },
        },
        {
          chip_id: 'chip.science.target.vitc',
          label: '维C（证据）',
          kind: 'quick_reply',
          data: { reply_text: '问成分科学：维C。请讲证据、稳定性和刺激风险。' },
        },
        {
          chip_id: 'chip.science.goal.brightening',
          label: '目标：提亮/淡斑',
          kind: 'quick_reply',
          data: { reply_text: '我想看“提亮/淡斑”方向的成分机制与证据，不先做产品推荐。' },
        },
        {
          chip_id: 'chip.science.goal.acne',
          label: '目标：痘痘/闭口',
          kind: 'quick_reply',
          data: { reply_text: '我想看“痘痘/闭口”方向的成分机制与证据，不先做产品推荐。' },
        },
        {
          chip_id: 'chip.science.goal.redness',
          label: '目标：泛红敏感',
          kind: 'quick_reply',
          data: { reply_text: '我想看“泛红敏感”方向的成分机制与证据，不先做产品推荐。' },
        },
      ],
    };
  }

  return {
    prompt:
      "Great question. I’ll keep this evidence-based and practical.\n" +
      "Before I answer, which direction should we focus on first?",
    chips: [
      {
        chip_id: 'chip.science.target.niacinamide',
        label: 'Niacinamide (evidence)',
        kind: 'quick_reply',
        data: { reply_text: 'Ingredient science: niacinamide — explain evidence strength, who it fits, and key risks.' },
      },
      {
        chip_id: 'chip.science.target.retinoid',
        label: 'Retinoids (evidence)',
        kind: 'quick_reply',
        data: { reply_text: 'Ingredient science: retinoids — explain mechanism, evidence quality, and risk controls.' },
      },
      {
        chip_id: 'chip.science.target.vitc',
        label: 'Vitamin C (evidence)',
        kind: 'quick_reply',
        data: { reply_text: 'Ingredient science: vitamin C — explain evidence, stability concerns, and irritation risk.' },
      },
      {
        chip_id: 'chip.science.goal.brightening',
        label: 'Goal: dark spots',
        kind: 'quick_reply',
        data: { reply_text: 'Science-only: explain ingredient mechanisms/evidence for dark spots and brightening (no product picks yet).' },
      },
      {
        chip_id: 'chip.science.goal.acne',
        label: 'Goal: acne/texture',
        kind: 'quick_reply',
        data: { reply_text: 'Science-only: explain ingredient mechanisms/evidence for acne and texture (no product picks yet).' },
      },
      {
        chip_id: 'chip.science.goal.redness',
        label: 'Goal: redness',
        kind: 'quick_reply',
        data: { reply_text: 'Science-only: explain ingredient mechanisms/evidence for redness-sensitive skin (no product picks yet).' },
      },
    ],
  };
}

function isBudgetClarificationAction(actionId, clarificationId) {
  const id = String(actionId || '').trim().toLowerCase();
  const cid = String(clarificationId || '').trim().toLowerCase();
  return id.startsWith('chip.clarify.budget') || id.startsWith('chip.budget.') || cid === 'budget';
}

function isBareBudgetSelectionMessage(message) {
  const text = String(message || '').trim();
  if (!text) return false;
  if (normalizeBudgetHint(text)) return true;
  return /^(not\s+sure|不确定)$/i.test(text);
}

function buildBudgetGatePrompt(language) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  if (lang === 'CN') {
    return '如果你愿意，我可以按预算再优化一版。你的月预算大概是多少？（可选）';
  }
  return 'If you want, I can optimize this by budget. What monthly budget feels comfortable? (optional)';
}

function buildBudgetGateChips(language) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  const opts = [
    ['¥200', '¥200'],
    ['¥500', '¥500'],
    ['¥1000+', '¥1000+'],
    ['不确定', lang === 'CN' ? '不确定' : 'Not sure'],
  ];
  return opts.map(([tier, label]) => ({
    chip_id: `chip.budget.${tier.replace(/[^\w]+/g, '_')}`,
    label,
    kind: 'quick_reply',
    data: {
      profile_patch: { budgetTier: tier },
      include_alternatives: true,
      reply_text:
        lang === 'CN'
          ? tier === '不确定'
            ? '先不设预算，继续当前方案。'
            : `把当前 AM/PM 方案按 ${tier} 预算优化（保留核心功效）。`
          : tier === '不确定'
            ? 'Skip budget for now and continue.'
            : `Optimize the current AM/PM routine around ${tier} budget while keeping core efficacy.`,
    },
  }));
}

function isBudgetOptimizationEntryAction(actionId) {
  const id = String(actionId || '').trim().toLowerCase();
  return id === 'chip.budget.optimize.entry' || id === 'chip.action.budget_optimize';
}

function buildBudgetOptimizationEntryChip(language) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  return {
    chip_id: 'chip.budget.optimize.entry',
    label: lang === 'CN' ? '按预算优化（可选）' : 'Optimize by budget (optional)',
    kind: 'quick_reply',
    data: {
      include_alternatives: true,
      reply_text:
        lang === 'CN'
          ? '我想在当前方案基础上做预算优化。'
          : 'I want to optimize the current routine by budget.',
    },
  };
}

async function mapWithConcurrency(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return [];

  const concurrency = Math.max(1, Math.min(8, Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : 1));
  const out = new Array(list.length);
  let cursor = 0;

  async function runOne() {
    while (cursor < list.length) {
      const idx = cursor;
      cursor += 1;
      try {
        // eslint-disable-next-line no-await-in-loop
        out[idx] = await worker(list[idx], idx);
      } catch (err) {
        out[idx] = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, list.length) }, () => runOne());
  await Promise.all(workers);
  return out;
}

function extractAnchorIdFromProductLike(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const raw =
    (typeof obj.sku_id === 'string' && obj.sku_id) ||
    (typeof obj.skuId === 'string' && obj.skuId) ||
    (typeof obj.product_id === 'string' && obj.product_id) ||
    (typeof obj.productId === 'string' && obj.productId) ||
    null;
  const v = raw ? String(raw).trim() : '';
  return v || null;
}

function mergeFieldMissing(a, b) {
  const out = [];
  const seen = new Set();
  for (const item of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    if (!item || typeof item !== 'object') continue;
    const field = typeof item.field === 'string' ? item.field.trim() : '';
    const reason = typeof item.reason === 'string' ? item.reason.trim() : '';
    if (!field || !reason) continue;
    const key = `${field}::${reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ field, reason });
  }
  return out;
}

async function fetchRecoAlternativesForProduct({ ctx, profileSummary, recentLogs, productInput, productObj, anchorId, maxTotal, debug, logger }) {
  const inputText = String(productInput || '').trim();
  const productJson = productObj && typeof productObj === 'object' ? JSON.stringify(productObj).slice(0, 1400) : '';
  const anchor = anchorId ? String(anchorId).trim() : '';
  const bestInput = inputText || anchor;
  if (!bestInput) return { ok: false, alternatives: [], field_missing: [{ field: 'alternatives', reason: 'product_identity_missing' }] };

  const prefix = buildContextPrefix({
    profile: profileSummary || null,
    recentLogs: Array.isArray(recentLogs) ? recentLogs : [],
    lang: ctx.lang,
    trigger_source: ctx.trigger_source,
    intent: 'alternatives',
    action_id: 'chip.action.dupe_compare',
  });

  const query =
    `${prefix}` +
    `Task: Deep-scan this product and return alternatives (dupe/similar/premium) tailored to this user if possible.\n` +
    `Return ONLY a JSON object with keys: alternatives (array).\n` +
    `Each alternative item should include: product (object), similarity_score (0..1 or 0..100), tradeoffs (object), reasons (string[] max 2), evidence (object), missing_info (string[]).\n` +
    `Reasons must be end-user readable and explain why this alternative is useful for THIS user's profile/logs/budget (do NOT guess missing info; use missing_info).\n` +
    `Product: ${bestInput}\n` +
    (productJson ? `Product JSON: ${productJson}\n` : '');

  let upstream = null;
  try {
    upstream = await auroraChat({
      baseUrl: AURORA_DECISION_BASE_URL,
      query,
      timeoutMs: RECO_ALTERNATIVES_TIMEOUT_MS,
      ...(anchor ? { anchor_product_id: anchor } : {}),
    });
  } catch (err) {
    logger?.warn({ err: err && err.message ? err.message : String(err) }, 'aurora bff: alternatives upstream failed');
    return {
      ok: false,
      alternatives: [],
      field_missing: [{ field: 'alternatives', reason: 'upstream_error' }],
      ...(debug
        ? {
          debug: {
            input: bestInput.slice(0, 200),
            anchor_id: anchor || null,
            product_json_preview: productJson ? productJson.slice(0, 300) : null,
            error: err && err.message ? err.message : String(err),
          },
        }
        : {}),
    };
  }

  const answerJson = upstream && typeof upstream.answer === 'string' ? extractJsonObjectByKeys(upstream.answer, ['alternatives']) : null;
  const structuredFallback = getUpstreamStructuredOrJson(upstream);
  const structured =
    answerJson && typeof answerJson === 'object' && !Array.isArray(answerJson) && Array.isArray(answerJson.alternatives)
      ? answerJson
      : structuredFallback || answerJson;
  const alternativesRaw = structured && Array.isArray(structured.alternatives) ? structured.alternatives : [];
  const mapped = mapAuroraAlternativesToRecoAlternatives(alternativesRaw, { lang: ctx.lang, maxTotal: maxTotal ?? 3 });

  return {
    ok: true,
    alternatives: mapped,
    field_missing: mapped.length ? [] : [{ field: 'alternatives', reason: structured ? 'upstream_missing_or_empty' : 'upstream_missing_or_unstructured' }],
    ...(debug
      ? {
        debug: {
          input: bestInput.slice(0, 200),
          anchor_id: anchor || null,
          product_json_preview: productJson ? productJson.slice(0, 300) : null,
          upstream_intent: upstream && typeof upstream.intent === 'string' ? upstream.intent : null,
          has_structured: Boolean(upstream && upstream.structured),
          structured_keys:
            upstream && upstream.structured && typeof upstream.structured === 'object' && !Array.isArray(upstream.structured)
              ? Object.keys(upstream.structured).slice(0, 24)
              : [],
          extracted_answer_json_keys:
            answerJson && typeof answerJson === 'object' && !Array.isArray(answerJson) ? Object.keys(answerJson).slice(0, 24) : [],
          extracted_structured_keys:
            structured && typeof structured === 'object' && !Array.isArray(structured) ? Object.keys(structured).slice(0, 24) : [],
          alternatives_raw_count: alternativesRaw.length,
          alternatives_mapped_count: mapped.length,
        },
      }
      : {}),
  };
}

async function enrichRecommendationsWithAlternatives({ ctx, profileSummary, recentLogs, recommendations, debug, logger }) {
  const recos = Array.isArray(recommendations) ? recommendations : [];
  const maxProducts = RECO_ALTERNATIVES_MAX_PRODUCTS;
  if (!recos.length || maxProducts <= 0) return { recommendations: recos, field_missing: [] };

  if (!AURORA_DECISION_BASE_URL && !USE_AURORA_BFF_MOCK) {
    return { recommendations: recos, field_missing: [{ field: 'recommendations[].alternatives', reason: 'aurora_not_configured' }] };
  }

  const firstBySlot = { am: null, pm: null, other: null };
  for (let i = 0; i < recos.length; i += 1) {
    const item = recos[i];
    const slot = item && typeof item === 'object' ? String(item.slot || '').trim().toLowerCase() : '';
    const key = slot === 'am' ? 'am' : slot === 'pm' ? 'pm' : 'other';
    if (firstBySlot[key] == null) firstBySlot[key] = i;
  }

  const orderedIdx = [];
  const seenIdx = new Set();
  for (const key of ['am', 'pm', 'other']) {
    const idx = firstBySlot[key];
    if (typeof idx !== 'number') continue;
    if (seenIdx.has(idx)) continue;
    seenIdx.add(idx);
    orderedIdx.push(idx);
  }
  for (let i = 0; i < recos.length; i += 1) {
    if (seenIdx.has(i)) continue;
    orderedIdx.push(i);
  }

  const targets = [];
  for (const idx of orderedIdx) {
    if (targets.length >= maxProducts) break;
    const item = recos[idx];
    const base = item && typeof item === 'object' ? item : null;
    const candidate =
      base && base.sku && typeof base.sku === 'object'
        ? base.sku
        : base && base.product && typeof base.product === 'object'
          ? base.product
          : base;

    const inputText = buildProductInputText(candidate, base && typeof base.url === 'string' ? base.url : null);
    const anchorId = extractAnchorIdFromProductLike(candidate) || extractAnchorIdFromProductLike(base);
    if (!inputText && !anchorId) continue;
    targets.push({ idx, inputText, anchorId, productObj: candidate });
  }

  if (!targets.length) {
    return { recommendations: recos, field_missing: [{ field: 'recommendations[].alternatives', reason: 'recommendations_missing_product_identity' }] };
  }

  const results = await mapWithConcurrency(targets, RECO_ALTERNATIVES_CONCURRENCY, async (t) => {
    const out = await fetchRecoAlternativesForProduct({
      ctx,
      profileSummary,
      recentLogs,
      productInput: t.inputText,
      productObj: t.productObj,
      anchorId: t.anchorId,
      debug,
      logger,
    });
    return { ...out, idx: t.idx };
  });

  const enriched = recos.slice();
  let anyEmpty = false;
  for (const r of results) {
    if (!r || typeof r !== 'object' || typeof r.idx !== 'number') continue;
    const base = enriched[r.idx];
    const next = base && typeof base === 'object' ? { ...base } : {};
    next.alternatives = Array.isArray(r.alternatives) ? r.alternatives : [];
    enriched[r.idx] = next;
    if (!next.alternatives.length) anyEmpty = true;
  }

  const field_missing = anyEmpty ? [{ field: 'recommendations[].alternatives', reason: 'alternatives_partial' }] : [];
  const debugInfo = debug
    ? results
      .map((r) => (r && typeof r === 'object' && r.debug ? { idx: r.idx, ...r.debug } : null))
      .filter(Boolean)
      .slice(0, 8)
    : null;
  return { recommendations: enriched, field_missing, ...(debugInfo ? { debug: debugInfo } : {}) };
}

async function generateRoutineReco({ ctx, profile, recentLogs, focus, constraints, includeAlternatives, logger }) {
  const profileSummary = summarizeProfileForContext(profile);
  const query = buildAuroraRoutineQuery({
    profile: { ...profileSummary, ...(profile && profile.currentRoutine ? { currentRoutine: profile.currentRoutine } : {}) },
    focus,
    constraints: constraints || {},
    lang: ctx.lang,
  });

  let upstream = null;
  try {
    upstream = await auroraChat({ baseUrl: AURORA_DECISION_BASE_URL, query, timeoutMs: RECO_ROUTINE_UPSTREAM_TIMEOUT_MS });
  } catch (err) {
    if (err && err.code !== 'AURORA_NOT_CONFIGURED') {
      logger?.warn({ err: err.message }, 'aurora bff: routine upstream failed');
    }
  }

  const contextObj = upstream && upstream.context && typeof upstream.context === 'object' ? upstream.context : null;
  const routine = contextObj ? contextObj.routine : null;
  const contextMeta = contextObj && typeof contextObj === 'object' && !Array.isArray(contextObj) ? { ...contextObj } : {};
  if (profileSummary && profileSummary.budgetTier && !contextMeta.budget && !contextMeta.budget_cny) {
    contextMeta.budget = profileSummary.budgetTier;
  }
  const mapped = mapAuroraRoutineToRecoGenerate(routine, contextMeta);
  const norm = normalizeRecoGenerate(mapped);
  norm.payload = { ...norm.payload, intent: 'routine', profile: profileSummary || null };

  if (includeAlternatives) {
    const alt = await enrichRecommendationsWithAlternatives({
      ctx,
      profileSummary,
      recentLogs,
      recommendations: norm.payload.recommendations,
      logger,
    });
    norm.payload = { ...norm.payload, recommendations: alt.recommendations };
    norm.field_missing = mergeFieldMissing(norm.field_missing, alt.field_missing);
  }

  const budgetKnown = normalizeBudgetHint(profileSummary && profileSummary.budgetTier);
  if (budgetKnown && Array.isArray(norm.payload?.missing_info)) {
    norm.payload.missing_info = norm.payload.missing_info.filter((code) => String(code) !== 'budget_unknown');
  }

  const pdpOpenOut = await enrichRecommendationsWithPdpOpenContract({
    recommendations: norm.payload.recommendations,
    logger,
  });
  norm.payload = {
    ...norm.payload,
    recommendations: pdpOpenOut.recommendations,
    metadata: {
      ...(isPlainObject(norm.payload?.metadata) ? norm.payload.metadata : {}),
      pdp_open_path_stats: pdpOpenOut.path_stats,
      resolve_fail_reason_counts: pdpOpenOut.fail_reason_counts,
      time_to_pdp_ms_stats: pdpOpenOut.time_to_pdp_ms_stats,
    },
  };

  const suggestedChips = [];
  const nextActions = upstream && Array.isArray(upstream.next_actions) ? upstream.next_actions : [];
  if ((!norm.payload.recommendations || norm.payload.recommendations.length === 0) && nextActions.length) {
    for (const act of nextActions.slice(0, 8)) {
      if (!act || typeof act !== 'object') continue;
      const label = typeof act.label === 'string' ? act.label.trim() : typeof act.text === 'string' ? act.text.trim() : '';
      const text = typeof act.text === 'string' ? act.text.trim() : label;
      const id = typeof act.id === 'string' ? act.id.trim() : '';
      if (!label) continue;
      suggestedChips.push({
        chip_id: `chip.aurora.next_action.${id || label.replace(/\\s+/g, '_')}`.slice(0, 80),
        label,
        kind: 'quick_reply',
        data: { reply_text: text, aurora_action_id: id || null },
      });
    }
  }

  return { norm, suggestedChips };
}

async function generateProductRecommendations({ ctx, profile, recentLogs, message, includeAlternatives, debug, logger }) {
  const profileSummary = summarizeProfileForContext(profile);
  const analysisSummary =
    profile && profile.lastAnalysis && (!profile.lastAnalysisLang || profile.lastAnalysisLang === ctx.lang) ? profile.lastAnalysis : null;
  const analysisSummaryAt = profile && profile.lastAnalysisAt ? profile.lastAnalysisAt : null;
  const prefix = buildContextPrefix({
    profile: profileSummary || null,
    recentLogs: Array.isArray(recentLogs) ? recentLogs : [],
    lang: ctx.lang,
    state: ctx.state,
    trigger_source: ctx.trigger_source,
    action_id: 'chip.start.reco_products',
    intent: 'reco_products',
    ...(analysisSummary ? { analysis_summary: analysisSummary } : {}),
    ...(analysisSummaryAt ? { analysis_summary_at: analysisSummaryAt } : {}),
  });
  const userAsk =
    String(message || '').trim() ||
    (ctx.lang === 'CN' ? '给我推荐几款护肤产品（按我的肤况与目标）' : 'Recommend a few skincare products for my profile and goals.');

  let upstream = null;
  let contextMeta = {};

  const catalogOut = await buildRecoGenerateFromCatalog({ ctx, profileSummary, debug, logger });
  const catalogStructured =
    catalogOut && typeof catalogOut === 'object' && catalogOut.structured && typeof catalogOut.structured === 'object'
      ? catalogOut.structured
      : null;
  const catalogDebug =
    catalogOut && typeof catalogOut === 'object' && catalogOut.debug && typeof catalogOut.debug === 'object'
      ? catalogOut.debug
      : null;
  const pdpFastFallbackReasonCode = deriveRecoPdpFastFallbackReasonCode(catalogDebug);
  const useCatalogTransientFallback = shouldUseRecoCatalogTransientFallback(catalogDebug);
  const catalogTransientFallbackStructured = useCatalogTransientFallback
    ? buildRecoCatalogTransientFallbackStructured({ ctx })
    : null;

  // Prefer: catalog-grounded → explicit JSON (from answer) → routine object (from context) → any structured blob.
  let structured = catalogStructured || catalogTransientFallbackStructured;
  let structuredSource = catalogStructured
    ? 'catalog_grounded'
    : catalogTransientFallbackStructured
      ? 'catalog_transient_fallback'
      : null;
  let answerJson = null;

  if (!structured) {
    const query =
      `${prefix}` +
      buildAuroraProductRecommendationsQuery({
        profile: profileSummary || {},
        requestText: userAsk,
        lang: ctx.lang,
      });

    try {
      upstream = await auroraChat({ baseUrl: AURORA_DECISION_BASE_URL, query, timeoutMs: RECO_UPSTREAM_TIMEOUT_MS });
    } catch (err) {
      if (err && err.code !== 'AURORA_NOT_CONFIGURED') {
        logger?.warn({ err: err.message }, 'aurora bff: product reco upstream failed');
      }
    }

    const contextObj = upstream && upstream.context && typeof upstream.context === 'object' ? upstream.context : null;
    const routine = contextObj ? contextObj.routine : null;
    contextMeta = contextObj && typeof contextObj === 'object' && !Array.isArray(contextObj) ? { ...contextObj } : {};
    if (profileSummary && profileSummary.budgetTier && !contextMeta.budget && !contextMeta.budget_cny) {
      contextMeta.budget = profileSummary.budgetTier;
    }

    answerJson = upstream && typeof upstream.answer === 'string' ? extractJsonObjectByKeys(upstream.answer, ['recommendations']) : null;
    const structuredFallback = getUpstreamStructuredOrJson(upstream);

    structured = answerJson;
    structuredSource = answerJson ? 'answer_json' : null;
    if (!structured && routine) {
      structured = mapAuroraRoutineToRecoGenerate(routine, contextMeta);
      structuredSource = 'context_routine';
    }
    if (!structured) {
      structured = structuredFallback;
      structuredSource = structuredFallback ? 'structured_fallback' : null;
    }
  }

  const upstreamDebug = debug
    ? {
      intent: upstream && typeof upstream.intent === 'string' ? upstream.intent : null,
      has_structured: Boolean(upstream && upstream.structured),
      structured_keys:
        upstream && upstream.structured && typeof upstream.structured === 'object' && !Array.isArray(upstream.structured)
          ? Object.keys(upstream.structured).slice(0, 24)
          : [],
      answer_preview:
        upstream && typeof upstream.answer === 'string' ? upstream.answer.slice(0, 800) : null,
      cards_types: Array.isArray(upstream && upstream.cards)
        ? upstream.cards
          .map((c) => (c && typeof c === 'object' && typeof c.type === 'string' ? c.type : null))
          .filter(Boolean)
          .slice(0, 12)
        : [],
      clarification:
        upstream && upstream.clarification && typeof upstream.clarification === 'object' ? upstream.clarification : null,
      context_keys:
        upstream && upstream.context && typeof upstream.context === 'object' && !Array.isArray(upstream.context)
          ? Object.keys(upstream.context).slice(0, 24)
          : [],
      structured_source: structuredSource,
      extracted_answer_json_keys:
        answerJson && typeof answerJson === 'object' && !Array.isArray(answerJson) ? Object.keys(answerJson).slice(0, 24) : [],
      extracted_structured_keys:
        structured && typeof structured === 'object' && !Array.isArray(structured) ? Object.keys(structured).slice(0, 24) : [],
      reco_catalog_grounded_enabled: RECO_CATALOG_GROUNDED_ENABLED,
      reco_upstream_timeout_ms: RECO_UPSTREAM_TIMEOUT_MS,
      reco_upstream_timeout_hard_cap_ms: RECO_UPSTREAM_TIMEOUT_HARD_CAP_MS,
      reco_pdp_enrich_concurrency: RECO_PDP_ENRICH_CONCURRENCY,
      reco_pdp_enrich_max_network_items: RECO_PDP_ENRICH_MAX_NETWORK_ITEMS,
      reco_pdp_chat_disable_local_double_hop: RECO_PDP_CHAT_DISABLE_LOCAL_DOUBLE_HOP,
      reco_local_fallback_chat_enabled: RECO_PDP_LOCAL_INVOKE_FALLBACK_CHAT_ENABLED,
      reco_local_search_fallback_on_transient: RECO_PDP_LOCAL_SEARCH_FALLBACK_ON_TRANSIENT,
      reco_catalog_transient_fallback_enabled: RECO_CATALOG_TRANSIENT_FALLBACK_ENABLED,
      reco_catalog_transient_fallback_applied: Boolean(catalogTransientFallbackStructured),
      reco_catalog_debug: catalogDebug,
      reco_pdp_fast_fallback_reason: pdpFastFallbackReasonCode,
    }
    : null;
  const mapped = structured && typeof structured === 'object' && !Array.isArray(structured) ? { ...structured } : null;
  if (mapped && Array.isArray(mapped.recommendations)) {
    mapped.recommendations = mapped.recommendations.map((r) => coerceRecoItemForUi(r, { lang: ctx.lang }));
  }

  const norm = normalizeRecoGenerate(mapped);
  norm.payload = { ...norm.payload, intent: 'reco_products', profile: profileSummary || null };
  if (Array.isArray(norm.payload.recommendations) && norm.payload.recommendations.length) {
    const deduped = [];
    const seen = new Set();
    for (const item of norm.payload.recommendations) {
      if (!item || typeof item !== 'object') continue;
      const base = item && typeof item === 'object' && !Array.isArray(item) ? item : null;
      const candidate =
        base && base.sku && typeof base.sku === 'object'
          ? base.sku
          : base && base.product && typeof base.product === 'object'
            ? base.product
            : base;
      const anchorId = extractAnchorIdFromProductLike(candidate) || extractAnchorIdFromProductLike(base);
      const inputText = buildProductInputText(candidate, null);
      const key = String(anchorId || inputText || '').trim().toLowerCase();
      if (!key) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push({ ...base, slot: 'other' });
      if (deduped.length >= 8) break;
    }
    norm.payload = { ...norm.payload, recommendations: deduped };
  }
  let alternativesDebug = null;

  if (includeAlternatives) {
    const alt = await enrichRecommendationsWithAlternatives({
      ctx,
      profileSummary,
      recentLogs,
      recommendations: norm.payload.recommendations,
      debug,
      logger,
    });
    norm.payload = { ...norm.payload, recommendations: alt.recommendations };
    norm.field_missing = mergeFieldMissing(norm.field_missing, alt.field_missing);
    if (debug && alt && typeof alt === 'object' && alt.debug) {
      alternativesDebug = alt.debug;
    }
  }

  const budgetKnown = normalizeBudgetHint(profileSummary && profileSummary.budgetTier);
  if (budgetKnown && Array.isArray(norm.payload?.missing_info)) {
    norm.payload.missing_info = norm.payload.missing_info.filter((code) => String(code) !== 'budget_unknown');
  }

  const uniqStrings = (items, max = null) => {
    const out = [];
    const seen = new Set();
    for (const raw of Array.isArray(items) ? items : []) {
      const s = typeof raw === 'string' ? raw.trim() : raw == null ? '' : String(raw).trim();
      if (!s) continue;
      const key = s.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
      if (typeof max === 'number' && max > 0 && out.length >= max) break;
    }
    return out;
  };

  const itineraryText = profileSummary && typeof profileSummary.itinerary === 'string' ? profileSummary.itinerary.trim() : '';
  const itinerary = itineraryText ? itineraryText.slice(0, 160) : '';
  if (itinerary && Array.isArray(norm.payload?.recommendations)) {
    const itineraryReason = ctx.lang === 'CN' ? `接下来计划：${itinerary}` : `Upcoming plan: ${itinerary}`;
    const itineraryRegex =
      ctx.lang === 'CN'
        ? /(行程|计划|旅行|出差|户外|飞行|滑雪|天气|气候)/
        : /\b(upcoming plan|itinerary|travel|trip|flight|outdoor|cold|dry|uv|ski)\b/i;

    const pickReasons = (reasonsRaw) => {
      const base = uniqStrings(reasonsRaw, 12);
      const alreadyHasItinerary = base.some((r) => itineraryRegex.test(String(r || '')));
      const reasons = alreadyHasItinerary ? base : [...base, itineraryReason];

      const activeRegex =
        ctx.lang === 'CN'
          ? /(最有效成分|关键成分|核心成分|主打成分)/
          : /\b(most effective active|hero ingredient|key actives?|key ingredients?)\b/i;
      const goalRegex = ctx.lang === 'CN' ? /(目标|匹配|针对)/ : /\b(goal fit|targets?:|goals?:)\b/i;
      const barrierRegex =
        ctx.lang === 'CN'
          ? /(屏障|敏感|刺激|低刺激|耐受|刺痛|泛红)/
          : /\b(barrier|sensitivity|irritat|low[- ]irritation|patch test|tolerance)\b/i;
      const logsRegex =
        ctx.lang === 'CN'
          ? /(近7天|最近7天|打卡|记录|泛红|痘|补水|保湿)/
          : /\b(last 7d|check-?in|redness|hydration)\b/i;
      const analysisRegex =
        ctx.lang === 'CN'
          ? /(皮肤分析|诊断|分析结果|上次分析)/
          : /\b(last skin analysis|skin analysis)\b/i;

      const picked = [];
      const usedIdx = new Set();
      const takeFirstMatch = (re) => {
        const idx = reasons.findIndex((r, i) => !usedIdx.has(i) && re.test(String(r || '')));
        if (idx === -1) return;
        usedIdx.add(idx);
        picked.push(reasons[idx]);
      };

      for (const re of [activeRegex, goalRegex, barrierRegex, logsRegex, analysisRegex, itineraryRegex]) {
        if (picked.length >= 6) break;
        takeFirstMatch(re);
      }

      for (let i = 0; i < reasons.length && picked.length < 6; i += 1) {
        if (usedIdx.has(i)) continue;
        picked.push(reasons[i]);
        usedIdx.add(i);
      }

      if (!picked.some((r) => itineraryRegex.test(String(r || '')))) {
        if (picked.length < 6) picked.push(itineraryReason);
        else picked[picked.length - 1] = itineraryReason;
      }

      return uniqStrings(picked, 6);
    };

    norm.payload.recommendations = norm.payload.recommendations.map((item) => {
      const base = item && typeof item === 'object' && !Array.isArray(item) ? item : null;
      if (!base) return item;
      const reasonsRaw = Array.isArray(base.reasons) ? base.reasons : [];
      return { ...base, reasons: pickReasons(reasonsRaw) };
    });
  }

  const pdpOpenOut = await enrichRecommendationsWithPdpOpenContract({
    recommendations: norm.payload.recommendations,
    logger,
    fastExternalFallbackReasonCode: pdpFastFallbackReasonCode,
  });
  norm.payload = {
    ...norm.payload,
    recommendations: pdpOpenOut.recommendations,
    metadata: {
      ...(isPlainObject(norm.payload?.metadata) ? norm.payload.metadata : {}),
      pdp_open_path_stats: pdpOpenOut.path_stats,
      resolve_fail_reason_counts: pdpOpenOut.fail_reason_counts,
      time_to_pdp_ms_stats: pdpOpenOut.time_to_pdp_ms_stats,
    },
  };

  return { norm, upstreamDebug, alternativesDebug };
}

function mountAuroraBffRoutes(app, { logger }) {
  app.get('/metrics', (req, res) => {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    return res.status(200).send(renderVisionMetricsPrometheus());
  });

  app.post('/v1/auth/start', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = AuthStartRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [
            { card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', details: parsed.error.format() } },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      const challenge = await createOtpChallenge({ email: parsed.data.email, language: ctx.lang });
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage(
          ctx.lang === 'CN'
            ? '我已把验证码发送到你的邮箱。请输入验证码完成登录。'
            : "I've sent a sign-in code to your email. Enter the code to continue.",
        ),
        suggested_chips: [],
        cards: [
          {
            card_id: `auth_start_${ctx.request_id}`,
            type: 'auth_challenge',
            payload: {
              email: challenge.email,
              challenge_id: challenge.challengeId,
              expires_at: challenge.expiresAt,
              expires_in_seconds: challenge.expiresInSeconds,
              delivery: challenge.delivery,
              ...(challenge.debug_code ? { debug_code: challenge.debug_code } : {}),
              ...(challenge.delivery_error ? { delivery_error: challenge.delivery_error } : {}),
            },
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'auth_started', { delivery: challenge.delivery })],
      });
      return res.json(envelope);
    } catch (err) {
      const fallbackCode = err && err.code ? err.code : err && err.message ? err.message : 'AUTH_START_FAILED';
      const { code: storageCode, dbError, dbNotConfigured, dbSchemaError } = classifyStorageError(err);
      const code = storageCode || fallbackCode;
      const status = code === 'INVALID_EMAIL' ? 400 : code === 'AUTH_NOT_CONFIGURED' ? 503 : dbError ? 503 : 500;
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage(
          code === 'AUTH_NOT_CONFIGURED'
            ? ctx.lang === 'CN'
              ? '登录暂不可用（缺少配置）。'
              : 'Sign-in is not configured yet.'
            : dbError
              ? ctx.lang === 'CN'
                ? '登录暂不可用（存储未就绪）。请稍后重试。'
                : 'Sign-in is not ready yet (storage unavailable). Please try again shortly.'
            : ctx.lang === 'CN'
              ? '验证码发送失败，请稍后重试。'
              : "Couldn't send a sign-in code. Please try again.",
        ),
        suggested_chips: [],
        cards: [
          {
            card_id: `err_${ctx.request_id}`,
            type: 'error',
            payload: {
              error: dbNotConfigured ? 'DB_NOT_CONFIGURED' : dbSchemaError ? 'DB_SCHEMA_NOT_READY' : dbError ? 'DB_UNAVAILABLE' : code,
              ...(storageCode ? { code: storageCode } : {}),
            },
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code })],
      });
      return res.status(status).json(envelope);
    }
  });

  app.post('/v1/auth/verify', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = AuthVerifyRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [
            { card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', details: parsed.error.format() } },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      const verification = await verifyOtpChallenge({ email: parsed.data.email, code: parsed.data.code });
      if (!verification.ok) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage(
            ctx.lang === 'CN' ? '验证码无效或已过期。' : 'Invalid or expired code.',
          ),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'INVALID_CODE', reason: verification.reason } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'INVALID_CODE', reason: verification.reason })],
        });
        return res.status(401).json(envelope);
      }

      const session = await createSession({ userId: verification.userId });

      if (ctx.aurora_uid) {
        try {
          await upsertIdentityLink(ctx.aurora_uid, verification.userId);
        } catch {
          // ignore
        }
        try {
          await migrateGuestDataToUser({ auroraUid: ctx.aurora_uid, userId: verification.userId });
        } catch (err) {
          logger?.warn({ err: err?.message || String(err) }, 'aurora bff: guest->account migration failed');
        }
      }

      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage(ctx.lang === 'CN' ? '登录成功。' : 'Signed in.'),
        suggested_chips: [],
        cards: [
          {
            card_id: `auth_${ctx.request_id}`,
            type: 'auth_session',
            payload: {
              token: session.token,
              expires_at: session.expiresAt,
              user: { user_id: verification.userId, email: verification.email },
            },
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'auth_verified', { user_id: verification.userId })],
      });
      return res.json(envelope);
    } catch (err) {
      const fallbackCode = err && err.code ? err.code : err && err.message ? err.message : 'AUTH_VERIFY_FAILED';
      const { code: storageCode, dbError, dbNotConfigured, dbSchemaError } = classifyStorageError(err);
      const code = storageCode || fallbackCode;
      const status = code === 'AUTH_NOT_CONFIGURED' ? 503 : dbError ? 503 : 500;
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage(
          code === 'AUTH_NOT_CONFIGURED'
            ? ctx.lang === 'CN'
              ? '登录暂不可用（缺少配置）。'
              : 'Sign-in is not configured yet.'
            : dbError
              ? ctx.lang === 'CN'
                ? '登录暂不可用（存储未就绪）。请稍后重试。'
                : 'Sign-in is not ready yet (storage unavailable). Please try again shortly.'
            : ctx.lang === 'CN'
              ? '登录失败，请稍后重试。'
              : 'Sign-in failed. Please try again.',
        ),
        suggested_chips: [],
        cards: [
          {
            card_id: `err_${ctx.request_id}`,
            type: 'error',
            payload: {
              error: dbNotConfigured ? 'DB_NOT_CONFIGURED' : dbSchemaError ? 'DB_SCHEMA_NOT_READY' : dbError ? 'DB_UNAVAILABLE' : code,
              ...(storageCode ? { code: storageCode } : {}),
            },
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code })],
      });
      return res.status(status).json(envelope);
    }
  });

  app.post('/v1/auth/password/login', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = AuthPasswordLoginRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [
            { card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', details: parsed.error.format() } },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      const verification = await verifyPasswordForEmail({ email: parsed.data.email, password: parsed.data.password });
      if (!verification.ok) {
        const isLocked = verification.reason === 'locked';
        const status = isLocked ? 429 : verification.reason === 'no_password_set' ? 409 : 401;
        const message =
          verification.reason === 'no_password_set'
            ? ctx.lang === 'CN'
              ? '该邮箱尚未设置密码，请先用邮箱验证码登录后再设置密码。'
              : 'No password is set for this email yet. Use an email code to sign in first, then set a password.'
            : isLocked
              ? ctx.lang === 'CN'
                ? '尝试次数过多，请稍后再试。'
                : 'Too many attempts. Please try again later.'
              : ctx.lang === 'CN'
                ? '邮箱或密码错误。'
                : 'Invalid email or password.';

        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage(message),
          suggested_chips: [],
          cards: [
            {
              card_id: `err_${ctx.request_id}`,
              type: 'error',
              payload: {
                error: isLocked ? 'PASSWORD_LOCKED' : 'INVALID_CREDENTIALS',
                reason: verification.reason,
                ...(verification.locked_until ? { locked_until: verification.locked_until } : {}),
              },
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: isLocked ? 'PASSWORD_LOCKED' : 'INVALID_CREDENTIALS' })],
        });
        return res.status(status).json(envelope);
      }

      const session = await createSession({ userId: verification.userId });

      if (ctx.aurora_uid) {
        try {
          await upsertIdentityLink(ctx.aurora_uid, verification.userId);
        } catch {
          // ignore
        }
        try {
          await migrateGuestDataToUser({ auroraUid: ctx.aurora_uid, userId: verification.userId });
        } catch (err) {
          logger?.warn({ err: err?.message || String(err) }, 'aurora bff: guest->account migration failed');
        }
      }

      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage(ctx.lang === 'CN' ? '登录成功。' : 'Signed in.'),
        suggested_chips: [],
        cards: [
          {
            card_id: `auth_${ctx.request_id}`,
            type: 'auth_session',
            payload: {
              token: session.token,
              expires_at: session.expiresAt,
              user: { user_id: verification.userId, email: verification.email },
            },
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'auth_verified', { user_id: verification.userId, method: 'password' })],
      });
      return res.json(envelope);
    } catch (err) {
      const fallbackCode = err && err.code ? err.code : err && err.message ? err.message : 'AUTH_PASSWORD_LOGIN_FAILED';
      const { code: storageCode, dbError, dbNotConfigured, dbSchemaError } = classifyStorageError(err);
      const code = storageCode || fallbackCode;
      const status = code === 'AUTH_NOT_CONFIGURED' ? 503 : dbError ? 503 : 500;
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage(
          code === 'AUTH_NOT_CONFIGURED'
            ? ctx.lang === 'CN'
              ? '登录暂不可用（缺少配置）。'
              : 'Sign-in is not configured yet.'
            : dbError
              ? ctx.lang === 'CN'
                ? '登录暂不可用（存储未就绪）。请稍后重试。'
                : 'Sign-in is not ready yet (storage unavailable). Please try again shortly.'
            : ctx.lang === 'CN'
              ? '登录失败，请稍后重试。'
              : 'Sign-in failed. Please try again.',
        ),
        suggested_chips: [],
        cards: [
          {
            card_id: `err_${ctx.request_id}`,
            type: 'error',
            payload: {
              error: dbNotConfigured ? 'DB_NOT_CONFIGURED' : dbSchemaError ? 'DB_SCHEMA_NOT_READY' : dbError ? 'DB_UNAVAILABLE' : code,
              ...(storageCode ? { code: storageCode } : {}),
            },
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code })],
      });
      return res.status(status).json(envelope);
    }
  });

  app.post('/v1/auth/password/set', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const identity = await resolveIdentity(req, ctx);
      if (!identity.userId) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage(ctx.lang === 'CN' ? '请先登录。' : 'Please sign in first.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'UNAUTHORIZED' } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'UNAUTHORIZED' })],
        });
        return res.status(401).json(envelope);
      }

      const parsed = AuthPasswordSetRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [
            { card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', details: parsed.error.format() } },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      await setUserPassword({ userId: identity.userId, password: parsed.data.password });

      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage(
          ctx.lang === 'CN'
            ? '密码已设置。下次你可以用邮箱 + 密码直接登录（仍可用邮箱验证码）。'
            : 'Password set. Next time you can sign in with email + password (OTP still works too).',
        ),
        suggested_chips: [],
        cards: [
          {
            card_id: `auth_password_set_${ctx.request_id}`,
            type: 'auth_password_set',
            payload: { ok: true },
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'auth_password_set', { user_id: identity.userId })],
      });
      return res.json(envelope);
    } catch (err) {
      const fallbackCode = err && err.code ? err.code : err && err.message ? err.message : 'AUTH_PASSWORD_SET_FAILED';
      const { code: storageCode, dbError, dbNotConfigured, dbSchemaError } = classifyStorageError(err);
      const code = storageCode || fallbackCode;
      const status =
        code === 'INVALID_PASSWORD'
          ? 400
          : code === 'UNAUTHORIZED'
            ? 401
            : code === 'AUTH_NOT_CONFIGURED'
              ? 503
              : dbError
                ? 503
                : 500;
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage(
          code === 'INVALID_PASSWORD'
            ? ctx.lang === 'CN'
              ? '密码格式不正确（至少 8 位）。'
              : 'Invalid password (min 8 characters).'
            : code === 'AUTH_NOT_CONFIGURED'
              ? ctx.lang === 'CN'
                ? '登录暂不可用（缺少配置）。'
                : 'Sign-in is not configured yet.'
              : dbError
                ? ctx.lang === 'CN'
                  ? '暂时无法保存密码（存储未就绪）。请稍后重试。'
                  : "Couldn't save password yet (storage unavailable). Please try again shortly."
              : ctx.lang === 'CN'
                ? '设置密码失败，请稍后重试。'
                : "Couldn't set password. Please try again.",
        ),
        suggested_chips: [],
        cards: [
          {
            card_id: `err_${ctx.request_id}`,
            type: 'error',
            payload: {
              error: dbNotConfigured ? 'DB_NOT_CONFIGURED' : dbSchemaError ? 'DB_SCHEMA_NOT_READY' : dbError ? 'DB_UNAVAILABLE' : code,
              ...(storageCode ? { code: storageCode } : {}),
            },
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code })],
      });
      return res.status(status).json(envelope);
    }
  });

  app.get('/v1/auth/me', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const identity = await resolveIdentity(req, ctx);
      if (!identity.userId) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage(ctx.lang === 'CN' ? '未登录。' : 'Not signed in.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'UNAUTHORIZED' } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'UNAUTHORIZED' })],
        });
        return res.status(401).json(envelope);
      }

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [
          {
            card_id: `me_${ctx.request_id}`,
            type: 'auth_me',
            payload: {
              user: { user_id: identity.userId, email: identity.userEmail },
            },
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'value_moment', { kind: 'auth_me' })],
      });
      return res.json(envelope);
    } catch (err) {
      const status = err && err.status ? err.status : 500;
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to load session.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: err.code || 'AUTH_ME_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: err.code || 'AUTH_ME_FAILED' })],
      });
      return res.status(status).json(envelope);
    }
  });

  app.post('/v1/auth/logout', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const token = getBearerToken(req);
      if (token) {
        try {
          await revokeSessionToken(token);
        } catch {
          // ignore
        }
      }

      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage(ctx.lang === 'CN' ? '已退出登录。' : 'Signed out.'),
        suggested_chips: [],
        cards: [
          {
            card_id: `logout_${ctx.request_id}`,
            type: 'auth_logout',
            payload: { ok: true },
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'auth_logout', {})],
      });
      return res.json(envelope);
    } catch (err) {
      const status = err && err.status ? err.status : 500;
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to sign out.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: err.code || 'AUTH_LOGOUT_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: err.code || 'AUTH_LOGOUT_FAILED' })],
      });
      return res.status(status).json(envelope);
    }
  });

  app.post('/v1/product/parse', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = ProductParseRequestSchema.safeParse(req.body || {});
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

      const input = parsed.data.url || parsed.data.text;
      const query = `Task: Parse the user's product input into a normalized product entity.\n` +
        `Return ONLY a JSON object with keys: product (object), confidence (0..1), missing_info (string[]).\n` +
        `Input: ${input}`;

      let upstream = null;
      try {
        upstream = await auroraChat({ baseUrl: AURORA_DECISION_BASE_URL, query, timeoutMs: 12000 });
      } catch (err) {
        // ignore; fall back below
      }

      const structured = getUpstreamStructuredOrJson(upstream);
      const mapped = structured && structured.parse && typeof structured.parse === 'object'
        ? mapAuroraProductParse(structured)
        : structured;
      const norm = normalizeProductParse(mapped);
      const payload = norm.payload;

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [
          {
            card_id: `parse_${ctx.request_id}`,
            type: 'product_parse',
            payload,
            ...(norm.field_missing?.length ? { field_missing: norm.field_missing.slice(0, 8) } : {}),
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'value_moment', { kind: 'product_parse' })],
      });
      return res.json(envelope);
    } catch (err) {
      const status = err.status || 500;
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to parse product.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: err.code || 'PRODUCT_PARSE_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: err.code || 'PRODUCT_PARSE_FAILED' })],
      });
      return res.status(status).json(envelope);
    }
  });

  app.post('/v1/product/analyze', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = ProductAnalyzeRequestSchema.safeParse(req.body || {});
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

      const identity = await resolveIdentity(req, ctx);
      const profile = await getProfileForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId }).catch(() => null);
      const recentLogs = await getRecentSkinLogsForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId }, 7).catch(() => []);
      const profileSummary = summarizeProfileForContext(profile);
      const commonMeta = {
        profile: profileSummary,
        recentLogs,
        lang: ctx.lang,
        state: ctx.state || 'idle',
        trigger_source: ctx.trigger_source,
      };
      const parsePrefix = buildContextPrefix({ ...commonMeta, intent: 'product_parse', action_id: 'chip.action.parse_product' });
      const prefix = buildContextPrefix({ ...commonMeta, intent: 'product_analyze', action_id: 'chip.action.analyze_product' });

      const input = parsed.data.url || parsed.data.name || JSON.stringify(parsed.data.product || {});
      let parsedProduct = parsed.data.product || null;
      let anchorId = parsedProduct && (parsedProduct.sku_id || parsedProduct.product_id);

      // If caller only provided a name/url, try to parse into an anchor product first to improve KB hit rate.
      if (!anchorId && input) {
        try {
          const parseQuery = `${parsePrefix}Task: Parse the user's product input into a normalized product entity.\n` +
            `Return ONLY a JSON object with keys: product, confidence, missing_info (string[]).\n` +
            `Input: ${input}`;

          const parseUpstream = await auroraChat({
            baseUrl: AURORA_DECISION_BASE_URL,
            query: parseQuery,
            timeoutMs: 12000,
            ...(parsed.data.url ? { anchor_product_url: parsed.data.url } : {}),
          });

          const parseStructured = (() => {
            if (parseUpstream && parseUpstream.structured && typeof parseUpstream.structured === 'object' && !Array.isArray(parseUpstream.structured)) {
              return parseUpstream.structured;
            }
            const a =
              parseUpstream && typeof parseUpstream.answer === 'string'
                ? extractJsonObjectByKeys(parseUpstream.answer, ['product', 'parse', 'anchor_product', 'anchorProduct'])
                : null;
            return a;
          })();
          const parseMapped =
            parseStructured && parseStructured.parse && typeof parseStructured.parse === 'object'
              ? mapAuroraProductParse(parseStructured)
              : parseStructured;
          const parseNorm = normalizeProductParse(parseMapped);
          parsedProduct = parseNorm.payload.product || parsedProduct;
          anchorId =
            parsedProduct && (parsedProduct.sku_id || parsedProduct.product_id)
              ? String(parsedProduct.sku_id || parsedProduct.product_id)
              : anchorId;
        } catch (err) {
          // ignore; continue without anchor id
        }
      }

      const query = `${prefix}Task: Deep-scan this product for suitability vs the user's profile.\n` +
        `Return ONLY a JSON object with keys: assessment, evidence, confidence (0..1), missing_info (string[]).\n` +
        `Evidence must include science/social_signals/expert_notes.\n` +
        `Product: ${input}`;

      const runDeepScan = async ({ queryText, timeoutMs }) => {
        try {
          return await auroraChat({
            baseUrl: AURORA_DECISION_BASE_URL,
            query: queryText,
            timeoutMs,
            ...(anchorId ? { anchor_product_id: String(anchorId) } : {}),
            ...(parsed.data.url ? { anchor_product_url: parsed.data.url } : {}),
          });
        } catch {
          return null;
        }
      };

      let upstream = await runDeepScan({ queryText: query, timeoutMs: 16000 });

      const upstreamStructured = upstream && upstream.structured && typeof upstream.structured === 'object' && !Array.isArray(upstream.structured)
        ? upstream.structured
        : null;
      const upstreamAnswerJson =
        upstream && typeof upstream.answer === 'string'
          ? extractJsonObjectByKeys(upstream.answer, [
            'assessment',
            'evidence',
            'confidence',
            'missing_info',
            'missingInfo',
            'analyze',
            'verdict',
            'reasons',
            'science_evidence',
            'social_signals',
            'expert_notes',
          ])
          : null;
      const upstreamAnswerObj = upstreamAnswerJson && typeof upstreamAnswerJson === 'object' && !Array.isArray(upstreamAnswerJson) ? upstreamAnswerJson : null;
      const answerLooksLikeProductAnalysis =
        upstreamAnswerObj &&
        (upstreamAnswerObj.assessment != null ||
          upstreamAnswerObj.evidence != null ||
          upstreamAnswerObj.analyze != null ||
          upstreamAnswerObj.confidence != null ||
          upstreamAnswerObj.missing_info != null ||
          upstreamAnswerObj.missingInfo != null);

      // Prefer answer JSON when `structured` exists but is missing `analyze`.
      const structuredOrJson =
        upstreamStructured && upstreamStructured.analyze && typeof upstreamStructured.analyze === 'object'
          ? upstreamStructured
          : answerLooksLikeProductAnalysis
            ? upstreamAnswerObj
            : upstreamStructured || upstreamAnswerObj;

      const mapped = structuredOrJson && structuredOrJson.analyze && typeof structuredOrJson.analyze === 'object'
        ? mapAuroraProductAnalysis(structuredOrJson)
        : structuredOrJson;
      let norm = normalizeProductAnalysis(mapped);

      // If personalized scan fails (often due to upstream echoing context or dropping analysis),
      // retry once with a minimal prefix to improve reliability. Mark the payload as less personalized.
      if (!norm.payload.assessment && profileSummary && input) {
        const minimalPrefix = buildContextPrefix({
          lang: ctx.lang,
          state: ctx.state || 'idle',
          trigger_source: ctx.trigger_source,
          intent: 'product_analyze_fallback',
          action_id: 'chip.action.analyze_product_fallback',
        });
        const minimalQuery =
          `${minimalPrefix}Task: Deep-scan this product for suitability vs the user's profile.\n` +
          `Return ONLY a JSON object with keys: assessment, evidence, confidence (0..1), missing_info (string[]).\n` +
          `Evidence must include science/social_signals/expert_notes.\n` +
          `Product: ${input}`;
        const upstream2 = await runDeepScan({ queryText: minimalQuery, timeoutMs: 14000 });
        const structured2 = upstream2 && upstream2.structured && typeof upstream2.structured === 'object' && !Array.isArray(upstream2.structured)
          ? upstream2.structured
          : null;
        const answer2 =
          upstream2 && typeof upstream2.answer === 'string'
            ? extractJsonObjectByKeys(upstream2.answer, [
              'assessment',
              'evidence',
              'confidence',
              'missing_info',
              'missingInfo',
              'analyze',
              'verdict',
              'reasons',
              'science_evidence',
              'social_signals',
              'expert_notes',
            ])
            : null;
        const structuredOrJson2 =
          structured2 && structured2.analyze && typeof structured2.analyze === 'object'
            ? structured2
            : answer2 && typeof answer2 === 'object' && !Array.isArray(answer2)
              ? answer2
              : structured2 || answer2;
        const mapped2 = structuredOrJson2 && structuredOrJson2.analyze && typeof structuredOrJson2.analyze === 'object'
          ? mapAuroraProductAnalysis(structuredOrJson2)
          : structuredOrJson2;
        const norm2 = normalizeProductAnalysis(mapped2);
        if (norm2 && norm2.payload && norm2.payload.assessment) {
          const missingInfo = Array.isArray(norm2.payload.missing_info) ? norm2.payload.missing_info : [];
          norm = {
            payload: { ...norm2.payload, missing_info: Array.from(new Set([...missingInfo, 'profile_context_dropped_for_reliability'])) },
            field_missing: norm2.field_missing,
          };
        }
      }

      let payload = enrichProductAnalysisPayload(norm.payload, { lang: ctx.lang, profileSummary });
      if (parsedProduct && payload && typeof payload === 'object') {
        const a = payload.assessment && typeof payload.assessment === 'object' ? payload.assessment : null;
        if (a && !a.anchor_product && !a.anchorProduct) {
          payload = { ...payload, assessment: { ...a, anchor_product: parsedProduct } };
        }
      }

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [
          {
            card_id: `analyze_${ctx.request_id}`,
            type: 'product_analysis',
            payload,
            ...(norm.field_missing?.length ? { field_missing: norm.field_missing.slice(0, 8) } : {}),
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'value_moment', { kind: 'product_analyze' })],
      });
      return res.json(envelope);
    } catch (err) {
      const status = err.status || 500;
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to analyze product.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: err.code || 'PRODUCT_ANALYZE_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: err.code || 'PRODUCT_ANALYZE_FAILED' })],
      });
      return res.status(status).json(envelope);
    }
  });

  app.post('/v1/dupe/suggest', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = DupeSuggestRequestSchema.safeParse(req.body || {});
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

      const maxDupes = Math.max(1, Math.min(6, Number.isFinite(parsed.data.max_dupes) ? parsed.data.max_dupes : 3));
      const maxComparables = Math.max(
        1,
        Math.min(6, Number.isFinite(parsed.data.max_comparables) ? parsed.data.max_comparables : 2),
      );
      const forceRefresh = parsed.data.force_refresh === true;
      const forceValidate = parsed.data.force_validate === true;

      const originalUrl = typeof parsed.data.original_url === 'string' ? parsed.data.original_url.trim() : '';
      let originalObj =
        parsed.data.original && typeof parsed.data.original === 'object' && !Array.isArray(parsed.data.original) ? parsed.data.original : null;
      let anchorId = extractAnchorIdFromProductLike(originalObj);

      const inputText =
        buildProductInputText(originalObj, originalUrl) ||
        (typeof parsed.data.original_text === 'string' ? parsed.data.original_text.trim() : '') ||
        '';
      if (!inputText) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', details: 'original is required' } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      const buildKbKey = ({ anchor, url, text }) => {
        const id = String(anchor || '').trim();
        if (id) return normalizeDupeKbKey(`id:${id}`);
        const u = String(url || '').trim();
        if (u) return normalizeDupeKbKey(`url:${u}`);
        const t = String(text || '').trim();
        if (!t) return null;
        const norm = t.toLowerCase().replace(/\s+/g, ' ').slice(0, 220);
        return normalizeDupeKbKey(`text:${norm}`);
      };

      // 1) KB fast-path (avoid upstream parse/LLM when possible)
      let kbKey = buildKbKey({ anchor: anchorId, url: originalUrl, text: inputText });
      let kbEntry = kbKey ? await getDupeKbEntry(kbKey) : null;

      const kbVerified = kbEntry && kbEntry.verified === true;
      const canServeKb = kbEntry && kbVerified && !forceRefresh && !forceValidate;
      if (canServeKb) {
        const payload = {
          kb_key: kbKey,
          original: kbEntry.original || originalObj || null,
          dupes: Array.isArray(kbEntry.dupes) ? kbEntry.dupes : [],
          comparables: Array.isArray(kbEntry.comparables) ? kbEntry.comparables : [],
          verified: true,
          verified_at: kbEntry.verified_at || null,
          source: kbEntry.source || 'kb',
          meta: { served_from_kb: true, validated_now: false },
        };

        const envelope = buildEnvelope(ctx, {
          assistant_message: null,
          suggested_chips: [],
          cards: [{ card_id: `dupe_suggest_${ctx.request_id}`, type: 'dupe_suggest', payload }],
          session_patch: {},
          events: [makeEvent(ctx, 'value_moment', { kind: 'dupe_suggest', source: 'kb' })],
        });
        return res.json(envelope);
      }

      // 2) Best-effort parse (improves kb_key stability and gives the UI a normalized product object)
      if (!anchorId && inputText) {
        const upstreamMeta = {
          lang: ctx.lang,
          state: ctx.state || 'idle',
          trigger_source: ctx.trigger_source,
        };
        const parsePrefix = buildContextPrefix({ ...upstreamMeta, intent: 'product_parse', action_id: 'chip.action.parse_product' });
        const parseQuery =
          `${parsePrefix}Task: Parse the user's product input into a normalized product entity.\n` +
          `Return ONLY a JSON object with keys: product, confidence, missing_info (string[]).\n` +
          `Input: ${inputText}`;
        try {
          const upstream = await auroraChat({
            baseUrl: AURORA_DECISION_BASE_URL,
            query: parseQuery,
            timeoutMs: 9000,
            ...(originalUrl ? { anchor_product_url: originalUrl } : {}),
          });
          const structured = getUpstreamStructuredOrJson(upstream);
          const answerJson =
            upstream && typeof upstream.answer === 'string'
              ? extractJsonObjectByKeys(upstream.answer, ['product', 'parse', 'anchor_product', 'anchorProduct'])
              : null;
          const obj =
            structured && typeof structured === 'object' && !Array.isArray(structured)
              ? structured
              : answerJson && typeof answerJson === 'object' && !Array.isArray(answerJson)
                ? answerJson
                : null;
          const anchor =
            obj && obj.parse && typeof obj.parse === 'object'
              ? (obj.parse.anchor_product || obj.parse.anchorProduct)
              : obj && obj.product && typeof obj.product === 'object'
                ? obj.product
                : null;
          if (anchor && typeof anchor === 'object' && !Array.isArray(anchor)) {
            originalObj = originalObj || anchor;
            anchorId = anchorId || extractAnchorIdFromProductLike(anchor);
          }
        } catch {
          // ignore parse failures; continue
        }
      }

      // If we managed to derive a more stable ID key, try the KB once more.
      const stableKey = buildKbKey({ anchor: anchorId, url: originalUrl, text: inputText });
      if (stableKey && stableKey !== kbKey) {
        kbKey = stableKey;
        kbEntry = await getDupeKbEntry(kbKey);
        const stableVerified = kbEntry && kbEntry.verified === true;
        if (kbEntry && stableVerified && !forceRefresh && !forceValidate) {
          const payload = {
            kb_key: kbKey,
            original: kbEntry.original || originalObj || null,
            dupes: Array.isArray(kbEntry.dupes) ? kbEntry.dupes : [],
            comparables: Array.isArray(kbEntry.comparables) ? kbEntry.comparables : [],
            verified: true,
            verified_at: kbEntry.verified_at || null,
            source: kbEntry.source || 'kb',
            meta: { served_from_kb: true, validated_now: false },
          };

          const envelope = buildEnvelope(ctx, {
            assistant_message: null,
            suggested_chips: [],
            cards: [{ card_id: `dupe_suggest_${ctx.request_id}`, type: 'dupe_suggest', payload }],
            session_patch: {},
            events: [makeEvent(ctx, 'value_moment', { kind: 'dupe_suggest', source: 'kb' })],
          });
          return res.json(envelope);
        }
      }

      // 3) Generate and validate once via upstream LLM, then cache to KB for future calls.
      const total = Math.max(2, Math.min(6, maxDupes + maxComparables));
      const upstreamOut = await fetchRecoAlternativesForProduct({
        ctx,
        profileSummary: null,
        recentLogs: [],
        productInput: inputText,
        productObj: originalObj,
        anchorId,
        maxTotal: total,
        debug: false,
        logger,
      });

      const mapped = Array.isArray(upstreamOut.alternatives) ? upstreamOut.alternatives : [];
      const kindOf = (it) => String(it && typeof it === 'object' ? it.kind : '').trim().toLowerCase();

      const dupes = mapped.filter((it) => kindOf(it) === 'dupe').slice(0, maxDupes);
      const comparables = mapped.filter((it) => kindOf(it) !== 'dupe').slice(0, maxComparables);

      const verified = dupes.length > 0 || comparables.length > 0;
      if (kbKey) {
        await upsertDupeKbEntry({
          kb_key: kbKey,
          original: originalObj || null,
          dupes,
          comparables,
          verified,
          verified_at: verified ? new Date().toISOString() : null,
          verified_by: verified ? 'aurora_llm' : null,
          source: verified ? 'llm_generate' : 'llm_generate_empty',
          source_meta: {
            generated_at: new Date().toISOString(),
            max_dupes: maxDupes,
            max_comparables: maxComparables,
          },
        });
      }

      const payload = {
        kb_key: kbKey,
        original: originalObj || null,
        dupes,
        comparables,
        verified,
        verified_at: verified ? new Date().toISOString() : null,
        source: verified ? 'llm_generate' : 'llm_generate_empty',
        meta: { served_from_kb: false, validated_now: true, force_refresh: forceRefresh, force_validate: forceValidate },
        ...(Array.isArray(upstreamOut.field_missing) && upstreamOut.field_missing.length ? { field_missing: upstreamOut.field_missing } : {}),
      };

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [
          {
            card_id: `dupe_suggest_${ctx.request_id}`,
            type: 'dupe_suggest',
            payload,
            ...(Array.isArray(upstreamOut.field_missing) && upstreamOut.field_missing.length ? { field_missing: upstreamOut.field_missing } : {}),
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'value_moment', { kind: 'dupe_suggest', source: 'llm' })],
      });
      return res.json(envelope);
    } catch (err) {
      const status = err.status || 500;
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to suggest dupes.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: err.code || 'DUPE_SUGGEST_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: err.code || 'DUPE_SUGGEST_FAILED' })],
      });
      return res.status(status).json(envelope);
    }
  });

  app.post('/v1/dupe/compare', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = DupeCompareRequestSchema.safeParse(req.body || {});
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

      const identity = await resolveIdentity(req, ctx);
      const profile = await getProfileForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId }).catch(() => null);
      const recentLogs = await getRecentSkinLogsForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId }, 7).catch(() => []);
      const profileSummary = summarizeProfileForContext(profile);
      // Use minimal upstream context for stability: dupe_compare should not depend on per-user logs/profile size.
      const upstreamMeta = {
        lang: ctx.lang,
        state: ctx.state || 'idle',
        trigger_source: ctx.trigger_source,
      };
      const parsePrefix = buildContextPrefix({ ...upstreamMeta, intent: 'product_parse', action_id: 'chip.action.parse_product' });
      const analyzePrefix = buildContextPrefix({ ...upstreamMeta, intent: 'product_analyze', action_id: 'chip.action.analyze_product' });
      const comparePrefix = buildContextPrefix({ ...upstreamMeta, intent: 'dupe_compare', action_id: 'chip.action.dupe_compare' });

      const originalInput = buildProductInputText(parsed.data.original, parsed.data.original_url);
      const dupeInput = buildProductInputText(parsed.data.dupe, parsed.data.dupe_url);

      if (!originalInput || !dupeInput) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', details: 'original and dupe are required' } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      const productQuery = (input) => (
        `${parsePrefix}Task: Parse the user's product input into a normalized product entity.\n` +
        `Return ONLY a JSON object with keys: product, confidence, missing_info (string[]).\n` +
        `Input: ${input}`
      );

      const parseOne = async ({ inputText, anchorObj, anchorUrl }) => {
        try {
          const anchorId = anchorObj && (anchorObj.sku_id || anchorObj.product_id);
          return await auroraChat({
            baseUrl: AURORA_DECISION_BASE_URL,
            query: productQuery(inputText),
            // Best-effort only; keep fast so dupe_compare doesn't hang on parse.
            timeoutMs: 9000,
            ...(anchorId ? { anchor_product_id: String(anchorId) } : {}),
            ...(anchorUrl ? { anchor_product_url: anchorUrl } : {}),
          });
        } catch {
          return null;
        }
      };

      const [originalUpstream, dupeUpstream] = await Promise.all([
        parseOne({ inputText: originalInput, anchorObj: parsed.data.original, anchorUrl: parsed.data.original_url }),
        parseOne({ inputText: dupeInput, anchorObj: parsed.data.dupe, anchorUrl: parsed.data.dupe_url }),
      ]);

      const originalStructured = getUpstreamStructuredOrJson(originalUpstream);
      const dupeStructured = getUpstreamStructuredOrJson(dupeUpstream);
      const originalAnchorFromUpstream = originalStructured && originalStructured.parse && typeof originalStructured.parse === 'object'
        ? (originalStructured.parse.anchor_product || originalStructured.parse.anchorProduct)
        : null;
      const dupeAnchorFromUpstream = dupeStructured && dupeStructured.parse && typeof dupeStructured.parse === 'object'
        ? (dupeStructured.parse.anchor_product || dupeStructured.parse.anchorProduct)
        : null;

      const originalAnchor = originalAnchorFromUpstream || parsed.data.original || null;
      const dupeAnchor = dupeAnchorFromUpstream || parsed.data.dupe || null;

      const originalText = buildProductInputText(originalAnchor, parsed.data.original_url) || originalInput;
      const dupeText = buildProductInputText(dupeAnchor, parsed.data.dupe_url) || dupeInput;

      const compareQuery =
        `${comparePrefix}Task: Compare the original product vs the dupe/alternative.\n` +
        `Return ONLY a JSON object with keys: original, dupe, tradeoffs (string[]), evidence, confidence (0..1), missing_info (string[]).\n` +
        `Evidence must include science/social_signals/expert_notes.\n` +
        `Original: ${originalText}\n` +
        `Dupe: ${dupeText}`;

      let compareUpstream = null;
      try {
        const originalAnchorId = originalAnchor && (originalAnchor.sku_id || originalAnchor.product_id);
        compareUpstream = await auroraChat({
          baseUrl: AURORA_DECISION_BASE_URL,
          query: compareQuery,
          timeoutMs: 18000,
          ...(originalAnchorId ? { anchor_product_id: String(originalAnchorId) } : {}),
          ...(parsed.data.original_url ? { anchor_product_url: parsed.data.original_url } : {}),
        });
      } catch (err) {
        // ignore; fall back below
      }

      const compareStructured = (() => {
        const structured = compareUpstream && compareUpstream.structured && typeof compareUpstream.structured === 'object' && !Array.isArray(compareUpstream.structured)
          ? compareUpstream.structured
          : null;
        const answerJson =
          compareUpstream && typeof compareUpstream.answer === 'string'
            ? extractJsonObjectByKeys(compareUpstream.answer, [
              'tradeoffs',
              'tradeoffs_detail',
              'tradeoffsDetail',
              'evidence',
              'original',
              'dupe',
              'alternatives',
              'compare',
            ])
            : null;
        const answerObj = answerJson && typeof answerJson === 'object' && !Array.isArray(answerJson) ? answerJson : null;
        if (structured && Array.isArray(structured.alternatives)) return structured;
        if (answerObj && (Array.isArray(answerObj.tradeoffs) || answerObj.tradeoffs_detail || answerObj.tradeoffsDetail)) return answerObj;
        return structured || answerObj;
      })();

      const fallbackAnalyze = () => {
        if (!originalStructured || !dupeStructured) {
          return {
            original: originalAnchor || null,
            dupe: dupeAnchor || null,
            tradeoffs: [],
            evidence: null,
            confidence: null,
            missing_info: ['upstream_missing_or_unstructured'],
          };
        }
        const orig = mapAuroraProductAnalysis(originalStructured);
        const dup = mapAuroraProductAnalysis(dupeStructured);

        const origKeys = Array.isArray(orig.evidence?.science?.key_ingredients) ? orig.evidence.science.key_ingredients : [];
        const dupKeys = Array.isArray(dup.evidence?.science?.key_ingredients) ? dup.evidence.science.key_ingredients : [];
        const origRisk = Array.isArray(orig.evidence?.science?.risk_notes) ? orig.evidence.science.risk_notes : [];
        const dupRisk = Array.isArray(dup.evidence?.science?.risk_notes) ? dup.evidence.science.risk_notes : [];

        const barrierRaw = profileSummary && typeof profileSummary.barrierStatus === 'string' ? profileSummary.barrierStatus.trim().toLowerCase() : '';
        const barrierImpaired = barrierRaw === 'impaired' || barrierRaw === 'damaged';

        const ingredientSignals = (items) => {
          const out = {
            occlusives: [],
            humectants: [],
            soothing: [],
            exfoliants: [],
            brightening: [],
            peptides: [],
            fragrance: [],
            alcohol: [],
          };

          const seen = new Set();
          const add = (k, v) => {
            const s = typeof v === 'string' ? v.trim() : String(v || '').trim();
            if (!s) return;
            const key = `${k}:${s.toLowerCase()}`;
            if (seen.has(key)) return;
            seen.add(key);
            out[k].push(s);
          };

          for (const raw of Array.isArray(items) ? items : []) {
            const s = typeof raw === 'string' ? raw.trim() : String(raw || '').trim();
            if (!s) continue;
            const n = s.toLowerCase();

            // Ignore trivial carriers.
            if (n === 'water' || n === 'aqua') continue;

            if (
              n.includes('petrolatum') ||
              n.includes('petroleum jelly') ||
              n.includes('mineral oil') ||
              n.includes('paraffin') ||
              n.includes('dimethicone') ||
              n.includes('lanolin') ||
              n.includes('wax') ||
              n.includes('beeswax') ||
              n.includes('shea butter') ||
              n.includes('cocoa butter')
            ) {
              add('occlusives', s);
            }

            if (
              n.includes('glycerin') ||
              n.includes('hyaluronic') ||
              n.includes('sodium hyaluronate') ||
              n.includes('panthenol') ||
              n.includes('urea') ||
              n.includes('betaine') ||
              n.includes('sodium pca') ||
              n.includes('trehalose') ||
              n.includes('propanediol') ||
              n.includes('butylene glycol') ||
              n.includes('sorbitol')
            ) {
              add('humectants', s);
            }

            if (
              n.includes('panthenol') ||
              n.includes('allantoin') ||
              n.includes('madecassoside') ||
              n.includes('centella') ||
              n.includes('ceramide') ||
              n.includes('cholesterol') ||
              n.includes('beta-glucan') ||
              n.includes('cica')
            ) {
              add('soothing', s);
            }

            if (
              n.includes('glycolic') ||
              n.includes('lactic') ||
              n.includes('mandelic') ||
              n.includes('salicylic') ||
              n.includes('gluconolactone') ||
              n.includes('pha') ||
              n.includes('bha') ||
              n.includes('aha')
            ) {
              add('exfoliants', s);
            }

            if (
              n.includes('niacinamide') ||
              n.includes('tranexamic') ||
              n.includes('azelaic') ||
              n.includes('ascorbic') ||
              n.includes('vitamin c') ||
              n.includes('arbutin') ||
              n.includes('kojic') ||
              n.includes('licorice')
            ) {
              add('brightening', s);
            }

            if (n.includes('peptide')) add('peptides', s);

            if (
              n.includes('fragrance') ||
              n.includes('parfum') ||
              n.includes('essential oil') ||
              n.includes('limonene') ||
              n.includes('linalool') ||
              n.includes('citral')
            ) {
              add('fragrance', s);
            }

            if (n.includes('alcohol denat') || n.includes('denatured alcohol')) add('alcohol', s);
          }

          return out;
        };

        const pickFew = (arr, max) => Array.from(new Set(Array.isArray(arr) ? arr.map((x) => String(x || '').trim()).filter(Boolean) : [])).slice(0, max);
        const joinFew = (arr, max) => pickFew(arr, max).join(', ');
        const nonEmpty = (arr) => Array.isArray(arr) && arr.length > 0;

        const origSig = ingredientSignals(origKeys);
        const dupSig = ingredientSignals(dupKeys);

        const tradeoffs = [];
        if (nonEmpty(origSig.occlusives) && !nonEmpty(dupSig.occlusives) && nonEmpty(dupSig.humectants)) {
          tradeoffs.push(
            ctx.lang === 'CN'
              ? `质地/封闭性：原产品更偏封闭锁水（例如 ${joinFew(origSig.occlusives, 2)}）；平替更偏补水（例如 ${joinFew(dupSig.humectants, 2)}）→ 通常更清爽，但可能需要叠加面霜来“锁水”。`
              : `Texture/finish: Original is more occlusive (e.g., ${joinFew(origSig.occlusives, 2)}) while the dupe is more humectant (e.g., ${joinFew(dupSig.humectants, 2)}) → lighter feel, but may need a moisturizer on top to seal.`,
          );
        } else if (nonEmpty(origSig.occlusives) && nonEmpty(dupSig.occlusives)) {
          tradeoffs.push(
            ctx.lang === 'CN'
              ? `共同点：两者都含封闭/油脂类成分（原：${joinFew(origSig.occlusives, 2)}；平替：${joinFew(dupSig.occlusives, 2)}）→ 都可能偏“锁水/滋润”，差异更多来自比例与配方。`
              : `Shared: Both include occlusive/emollient components (orig: ${joinFew(origSig.occlusives, 2)}; dupe: ${joinFew(dupSig.occlusives, 2)}) → both can be “sealing”; differences may come from formula balance.`,
          );
        }

        if (nonEmpty(origSig.humectants) && nonEmpty(dupSig.humectants) && tradeoffs.length < 2) {
          tradeoffs.push(
            ctx.lang === 'CN'
              ? `共同点：两者都含常见保湿成分（原：${joinFew(origSig.humectants, 2)}；平替：${joinFew(dupSig.humectants, 2)}）→ 都能提升含水量，但“锁水力度”仍取决于封闭类成分。`
              : `Shared: Both include humectants (orig: ${joinFew(origSig.humectants, 2)}; dupe: ${joinFew(dupSig.humectants, 2)}) → both support hydration; how “sealing” it feels depends on occlusives.`,
          );
        }

        if (nonEmpty(dupSig.exfoliants)) {
          tradeoffs.push(
            ctx.lang === 'CN'
              ? `刺激风险：平替含去角质类成分（例如 ${joinFew(dupSig.exfoliants, 2)}）→ ${barrierImpaired ? '屏障受损时更容易不耐受，建议低频' : '更易刺激，建议低频'}，不要叠加强活性。`
              : `Irritation risk: Dupe includes exfoliant-like actives (e.g., ${joinFew(dupSig.exfoliants, 2)}) → ${barrierImpaired ? 'higher irritation risk if your barrier is impaired; start low' : 'higher irritation risk; start low'}, avoid stacking strong actives.`,
          );
        }

        if (nonEmpty(dupSig.fragrance) && !nonEmpty(origSig.fragrance)) {
          tradeoffs.push(
            ctx.lang === 'CN'
              ? `气味/敏感风险：平替可能含香精/香料相关成分（例如 ${joinFew(dupSig.fragrance, 1)}）→ 更敏感人群需要谨慎。`
              : `Fragrance risk: Dupe may include fragrance-related ingredients (e.g., ${joinFew(dupSig.fragrance, 1)}) → higher risk for sensitive skin.`,
          );
        }

        const addedRisks = dupRisk.filter((k) => !origRisk.includes(k));
        if (addedRisks.length) {
          tradeoffs.push(
            ctx.lang === 'CN'
              ? `平替风险提示：${addedRisks.slice(0, 2).join(' · ')}`
              : `Dupe risk notes: ${addedRisks.slice(0, 2).join(' · ')}`,
          );
        }

        if (!tradeoffs.length) {
          const origPreview = pickFew([...origSig.occlusives, ...origSig.humectants, ...origSig.soothing, ...origSig.brightening, ...origSig.exfoliants], 3);
          const dupPreview = pickFew([...dupSig.occlusives, ...dupSig.humectants, ...dupSig.soothing, ...dupSig.brightening, ...dupSig.exfoliants], 3);
          if (origPreview.length && dupPreview.length) {
            tradeoffs.push(
              ctx.lang === 'CN'
                ? `关键成分侧重（简要）：原产品—${origPreview.length ? origPreview.join(' / ') : '未知'}；平替—${dupPreview.length ? dupPreview.join(' / ') : '未知'}。`
                : `Key ingredient emphasis (brief): original — ${origPreview.length ? origPreview.join(' / ') : 'unknown'}; dupe — ${dupPreview.length ? dupPreview.join(' / ') : 'unknown'}.`,
            );
          }
        }

        const confidence = typeof orig.confidence === 'number' && typeof dup.confidence === 'number'
          ? (orig.confidence + dup.confidence) / 2
          : (orig.confidence || dup.confidence || null);

        const evidence = {
          science: {
            key_ingredients: Array.from(new Set([...origKeys, ...dupKeys])),
            mechanisms: Array.from(new Set([...(orig.evidence?.science?.mechanisms || []), ...(dup.evidence?.science?.mechanisms || [])])),
            fit_notes: Array.from(new Set([...(orig.evidence?.science?.fit_notes || []), ...(dup.evidence?.science?.fit_notes || [])])),
            risk_notes: Array.from(new Set([...(orig.evidence?.science?.risk_notes || []), ...(dup.evidence?.science?.risk_notes || [])])),
          },
          social_signals: { typical_positive: [], typical_negative: [], risk_for_groups: [] },
          expert_notes: Array.from(new Set([...(orig.evidence?.expert_notes || []), ...(dup.evidence?.expert_notes || [])])),
          confidence,
          missing_info: ['dupe_not_in_alternatives_used_analyze_diff'],
        };

        return {
          original: originalAnchor || null,
          dupe: dupeAnchor || null,
          tradeoffs,
          evidence,
          confidence,
          missing_info: ['dupe_not_found_in_alternatives'],
        };
      };

      const mappedFromOriginalAlts =
        originalStructured && originalStructured.alternatives
          ? mapAuroraAlternativesToDupeCompare(originalStructured, dupeAnchor, {
              fallbackAnalyze,
              originalAnchorFallback: originalAnchor,
              lang: ctx.lang,
              barrierStatus: profileSummary && profileSummary.barrierStatus,
            })
          : null;

      const mapped = (() => {
        // Prefer structured.alternatives (when present) because it yields stable similarity/tradeoffs.
        if (mappedFromOriginalAlts && Array.isArray(mappedFromOriginalAlts.tradeoffs) && mappedFromOriginalAlts.tradeoffs.length) {
          return mappedFromOriginalAlts;
        }
        if (compareStructured) {
          if (compareStructured.alternatives) {
            return mapAuroraAlternativesToDupeCompare(compareStructured, dupeAnchor, {
              fallbackAnalyze,
              originalAnchorFallback: originalAnchor,
              lang: ctx.lang,
              barrierStatus: profileSummary && profileSummary.barrierStatus,
            });
          }
          return compareStructured;
        }
        if (mappedFromOriginalAlts) return mappedFromOriginalAlts;
        return fallbackAnalyze();
      })();

      const norm = normalizeDupeCompare(mapped);
      let payload = norm.payload;
      let field_missing = norm.field_missing;
      if (!payload.original && originalAnchor) payload = { ...payload, original: originalAnchor };
      if (!payload.dupe && dupeAnchor) payload = { ...payload, dupe: dupeAnchor };

      const uniqStrings = (arr) => {
        const out = [];
        const seen = new Set();
        for (const v of Array.isArray(arr) ? arr : []) {
          const s = typeof v === 'string' ? v.trim() : String(v || '').trim();
          if (!s) continue;
          if (seen.has(s)) continue;
          seen.add(s);
          out.push(s);
        }
        return out;
      };

      const isMissingTradeoffs = !Array.isArray(payload.tradeoffs) || payload.tradeoffs.length === 0;
      if (isMissingTradeoffs) {
        const scanOne = async ({ productText, productObj, productUrl }) => {
          const anchorId = extractAnchorIdFromProductLike(productObj);
          const bestText = String(productText || '').trim() || (anchorId ? String(anchorId) : '');
          if (!bestText) return null;

          const cacheKey = (() => {
            const langKey = ctx.lang === 'CN' ? 'CN' : 'EN';
            if (anchorId) return `dupe_deepscan:${langKey}:id:${String(anchorId).trim()}`;
            const url = typeof productUrl === 'string' ? productUrl.trim() : '';
            if (url) return `dupe_deepscan:${langKey}:url:${url}`;
            const norm = bestText.toLowerCase().replace(/\s+/g, ' ').slice(0, 160);
            return `dupe_deepscan:${langKey}:text:${norm}`;
          })();
          const cached = getDupeDeepscanCache(cacheKey);
          if (cached) return cached;

          const buildQuery = (strict = false) => (
            `${analyzePrefix}Task: Deep-scan this product for a product-level ingredient/benefit/risk snapshot.\n` +
            `Return ONLY a JSON object with keys: assessment, evidence, confidence (0..1), missing_info (string[]).\n` +
            `Evidence must include science/social_signals/expert_notes.\n` +
            `${strict ? 'If possible, include at least 4 items in evidence.science.key_ingredients; if unavailable, return [] and add missing_info: \"key_ingredients_missing\".\n' : ''}` +
            `Product: ${bestText}`
          );

          const runScan = async (queryText, timeoutMs) =>
            auroraChat({
              baseUrl: AURORA_DECISION_BASE_URL,
              query: queryText,
              timeoutMs,
              ...(anchorId ? { anchor_product_id: String(anchorId) } : {}),
              ...(productUrl ? { anchor_product_url: productUrl } : {}),
            });

          const parseUpstream = (upstream) => {
            const upStructured = upstream && upstream.structured && typeof upstream.structured === 'object' && !Array.isArray(upstream.structured)
              ? upstream.structured
              : null;
            const upAnswerJson =
              upstream && typeof upstream.answer === 'string'
                ? extractJsonObjectByKeys(upstream.answer, [
                    'assessment',
                    'evidence',
                    'confidence',
                    'missing_info',
                    'missingInfo',
                    'analyze',
                    'verdict',
                    'reasons',
                    'science_evidence',
                    'social_signals',
                    'expert_notes',
                  ])
                : null;
            const upAnswerObj = upAnswerJson && typeof upAnswerJson === 'object' && !Array.isArray(upAnswerJson) ? upAnswerJson : null;
            const answerLooksLikeProductAnalysis =
              upAnswerObj &&
              (upAnswerObj.assessment != null ||
                upAnswerObj.evidence != null ||
                upAnswerObj.analyze != null ||
                upAnswerObj.confidence != null ||
                upAnswerObj.missing_info != null ||
                upAnswerObj.missingInfo != null);
            const structuredOrJson =
              upStructured && upStructured.analyze && typeof upStructured.analyze === 'object'
                ? upStructured
                : answerLooksLikeProductAnalysis
                  ? upAnswerObj
                  : upStructured || upAnswerObj;

            const mappedAnalyze = structuredOrJson && structuredOrJson.analyze && typeof structuredOrJson.analyze === 'object'
              ? mapAuroraProductAnalysis(structuredOrJson)
              : structuredOrJson;
            const normAnalyze = normalizeProductAnalysis(mappedAnalyze);
            const keyIngredientsNow = (() => {
              const ev = normAnalyze.payload && typeof normAnalyze.payload === 'object' ? normAnalyze.payload.evidence : null;
              const sci = ev && typeof ev === 'object' ? ev.science : null;
              const key = sci && typeof sci === 'object' ? (sci.key_ingredients || sci.keyIngredients) : null;
              return Array.isArray(key) ? key.filter(Boolean) : [];
            })();
            return { normAnalyze, keyIngredientsNow };
          };

          let best = null;
          try {
            const upstream1 = await runScan(buildQuery(false), 12000);
            best = parseUpstream(upstream1);
          } catch {
            // ignore
          }

          const needsRetry = !best || !best.normAnalyze.payload.assessment || best.keyIngredientsNow.length === 0;
          if (needsRetry) {
            try {
              const upstream2 = await runScan(buildQuery(true), 11000);
              const parsed2 = parseUpstream(upstream2);
              if (parsed2 && parsed2.normAnalyze && parsed2.normAnalyze.payload && parsed2.normAnalyze.payload.assessment) {
                best = parsed2;
              }
            } catch {
              // ignore
            }
          }

          if (!best) return null;

          const enriched = enrichProductAnalysisPayload(best.normAnalyze.payload, { lang: ctx.lang, profileSummary });
          const out = { payload: enriched, field_missing: best.normAnalyze.field_missing };

          const keyAfterEnrich = (() => {
            const ev = enriched && typeof enriched === 'object' ? enriched.evidence : null;
            const sci = ev && typeof ev === 'object' ? ev.science : null;
            const key = sci && typeof sci === 'object' ? (sci.key_ingredients || sci.keyIngredients) : null;
            return Array.isArray(key) ? key.filter(Boolean) : [];
          })();
          if (enriched && enriched.assessment && keyAfterEnrich.length >= 3) {
            setDupeDeepscanCache(cacheKey, out);
          }

          return out;
        };

        const [origScan, dupeScan] = await Promise.all([
          scanOne({ productText: originalText, productObj: originalAnchor, productUrl: parsed.data.original_url }),
          scanOne({ productText: dupeText, productObj: dupeAnchor, productUrl: parsed.data.dupe_url }),
        ]);

        const origPayload = origScan && origScan.payload && typeof origScan.payload === 'object' ? origScan.payload : null;
        const dupePayload = dupeScan && dupeScan.payload && typeof dupeScan.payload === 'object' ? dupeScan.payload : null;

        const extractEvidence = (p) => {
          const ev = p && typeof p === 'object' ? p.evidence : null;
          const sci = ev && typeof ev === 'object' ? ev.science : null;
          const soc = ev && typeof ev === 'object' ? (ev.social_signals || ev.socialSignals) : null;
          return {
            key: uniqStrings(sci && Array.isArray(sci.key_ingredients || sci.keyIngredients) ? (sci.key_ingredients || sci.keyIngredients) : []),
            mech: uniqStrings(sci && Array.isArray(sci.mechanisms) ? sci.mechanisms : []),
            fit: uniqStrings(sci && Array.isArray(sci.fit_notes || sci.fitNotes) ? (sci.fit_notes || sci.fitNotes) : []),
            risk: uniqStrings(sci && Array.isArray(sci.risk_notes || sci.riskNotes) ? (sci.risk_notes || sci.riskNotes) : []),
            pos: uniqStrings(soc && Array.isArray(soc.typical_positive || soc.typicalPositive) ? (soc.typical_positive || soc.typicalPositive) : []),
            neg: uniqStrings(soc && Array.isArray(soc.typical_negative || soc.typicalNegative) ? (soc.typical_negative || soc.typicalNegative) : []),
            expert: uniqStrings(ev && Array.isArray(ev.expert_notes || ev.expertNotes) ? (ev.expert_notes || ev.expertNotes) : []),
            missing: uniqStrings(ev && Array.isArray(ev.missing_info || ev.missingInfo) ? (ev.missing_info || ev.missingInfo) : []),
            conf: ev && typeof ev.confidence === 'number' ? ev.confidence : null,
          };
        };

        const origEv = extractEvidence(origPayload);
        const dupEv = extractEvidence(dupePayload);

        const isCn = ctx.lang === 'CN';

        const ingredientSignals = (items) => {
          const out = {
            occlusives: [],
            humectants: [],
            soothing: [],
            exfoliants: [],
            brightening: [],
            peptides: [],
            fragrance: [],
            alcohol: [],
          };

          const seen = new Set();
          const add = (k, v) => {
            const s = typeof v === 'string' ? v.trim() : String(v || '').trim();
            if (!s) return;
            const key = `${k}:${s.toLowerCase()}`;
            if (seen.has(key)) return;
            seen.add(key);
            out[k].push(s);
          };

          for (const raw of Array.isArray(items) ? items : []) {
            const s = typeof raw === 'string' ? raw.trim() : String(raw || '').trim();
            if (!s) continue;
            const n = s.toLowerCase();

            // Ignore trivial carriers.
            if (n === 'water' || n === 'aqua') continue;

            if (
              n.includes('petrolatum') ||
              n.includes('petroleum jelly') ||
              n.includes('mineral oil') ||
              n.includes('paraffin') ||
              n.includes('dimethicone') ||
              n.includes('lanolin') ||
              n.includes('wax') ||
              n.includes('beeswax') ||
              n.includes('shea butter') ||
              n.includes('cocoa butter')
            ) {
              add('occlusives', s);
            }

            if (
              n.includes('glycerin') ||
              n.includes('hyaluronic') ||
              n.includes('sodium hyaluronate') ||
              n.includes('panthenol') ||
              n.includes('urea') ||
              n.includes('betaine') ||
              n.includes('sodium pca') ||
              n.includes('trehalose') ||
              n.includes('propanediol') ||
              n.includes('butylene glycol') ||
              n.includes('sorbitol')
            ) {
              add('humectants', s);
            }

            if (
              n.includes('panthenol') ||
              n.includes('allantoin') ||
              n.includes('madecassoside') ||
              n.includes('centella') ||
              n.includes('ceramide') ||
              n.includes('cholesterol') ||
              n.includes('beta-glucan') ||
              n.includes('cica')
            ) {
              add('soothing', s);
            }

            if (
              n.includes('glycolic') ||
              n.includes('lactic') ||
              n.includes('mandelic') ||
              n.includes('salicylic') ||
              n.includes('gluconolactone') ||
              n.includes('pha') ||
              n.includes('bha') ||
              n.includes('aha')
            ) {
              add('exfoliants', s);
            }

            if (
              n.includes('niacinamide') ||
              n.includes('tranexamic') ||
              n.includes('azelaic') ||
              n.includes('ascorbic') ||
              n.includes('vitamin c') ||
              n.includes('arbutin') ||
              n.includes('kojic') ||
              n.includes('licorice')
            ) {
              add('brightening', s);
            }

            if (n.includes('peptide')) add('peptides', s);

            if (
              n.includes('fragrance') ||
              n.includes('parfum') ||
              n.includes('essential oil') ||
              n.includes('limonene') ||
              n.includes('linalool') ||
              n.includes('citral')
            ) {
              add('fragrance', s);
            }

            if (n.includes('alcohol denat') || n.includes('denatured alcohol')) add('alcohol', s);
          }

          return out;
        };

        const pickFew = (arr, max) => uniqStrings(arr).slice(0, max);
        const joinFew = (arr, max) => pickFew(arr, max).join(', ');
        const nonEmpty = (arr) => Array.isArray(arr) && arr.length > 0;

        const origSig = ingredientSignals(origEv.key);
        const dupSig = ingredientSignals(dupEv.key);

        const derivedTradeoffs = [];

        // More human, high-signal comparisons (avoid dumping full INCI).
        if (nonEmpty(origSig.occlusives) && !nonEmpty(dupSig.occlusives) && nonEmpty(dupSig.humectants)) {
          derivedTradeoffs.push(
            isCn
              ? `质地/封闭性：原产品更偏封闭锁水（例如 ${joinFew(origSig.occlusives, 2)}）；平替更偏补水（例如 ${joinFew(dupSig.humectants, 2)}）→ 通常更清爽，但可能需要叠加面霜来“锁水”。`
              : `Texture/finish: Original is more occlusive (e.g., ${joinFew(origSig.occlusives, 2)}) while the dupe is more humectant (e.g., ${joinFew(dupSig.humectants, 2)}) → lighter feel, but may need a moisturizer on top to seal.`,
          );
        } else if (nonEmpty(dupSig.occlusives) && !nonEmpty(origSig.occlusives) && nonEmpty(origSig.humectants)) {
          derivedTradeoffs.push(
            isCn
              ? `质地/封闭性：平替更偏封闭锁水（例如 ${joinFew(dupSig.occlusives, 2)}）；原产品更偏补水（例如 ${joinFew(origSig.humectants, 2)}）→ 平替通常更厚重、更“锁水”。`
              : `Texture/finish: Dupe is more occlusive (e.g., ${joinFew(dupSig.occlusives, 2)}) while the original is more humectant (e.g., ${joinFew(origSig.humectants, 2)}) → dupe may feel richer and more sealing.`,
          );
        } else if (nonEmpty(origSig.occlusives) && nonEmpty(dupSig.occlusives)) {
          derivedTradeoffs.push(
            isCn
              ? `共同点：两者都含封闭/油脂类成分（原：${joinFew(origSig.occlusives, 2)}；平替：${joinFew(dupSig.occlusives, 2)}）→ 都可能偏“锁水/滋润”，差异更多来自比例与配方。`
              : `Shared: Both include occlusive/emollient components (orig: ${joinFew(origSig.occlusives, 2)}; dupe: ${joinFew(dupSig.occlusives, 2)}) → both can be “sealing”; differences may come from formula balance.`,
          );
        }

        if (nonEmpty(origSig.humectants) && nonEmpty(dupSig.humectants) && derivedTradeoffs.length < 2) {
          derivedTradeoffs.push(
            isCn
              ? `共同点：两者都含常见保湿成分（原：${joinFew(origSig.humectants, 2)}；平替：${joinFew(dupSig.humectants, 2)}）→ 都能提升含水量，但“锁水力度”仍取决于封闭类成分。`
              : `Shared: Both include humectants (orig: ${joinFew(origSig.humectants, 2)}; dupe: ${joinFew(dupSig.humectants, 2)}) → both support hydration; how “sealing” it feels depends on occlusives.`,
          );
        }

        if (nonEmpty(dupSig.exfoliants)) {
          derivedTradeoffs.push(
            isCn
              ? `刺激风险：平替含去角质类成分（例如 ${joinFew(dupSig.exfoliants, 2)}）→ 屏障受损/刺痛时更容易不耐受，建议低频、不要叠加强活性。`
              : `Irritation risk: Dupe includes exfoliant-like actives (e.g., ${joinFew(dupSig.exfoliants, 2)}) → higher irritation risk if your barrier is impaired; start low and avoid stacking strong actives.`,
          );
        }

        if (nonEmpty(dupSig.fragrance) && !nonEmpty(origSig.fragrance)) {
          derivedTradeoffs.push(
            isCn
              ? `气味/敏感风险：平替可能含香精/香料相关成分（例如 ${joinFew(dupSig.fragrance, 1)}）→ 更敏感人群需要谨慎。`
              : `Fragrance risk: Dupe may include fragrance-related ingredients (e.g., ${joinFew(dupSig.fragrance, 1)}) → higher risk for sensitive skin.`,
          );
        }

        const addedRisks = dupEv.risk.filter((k) => !origEv.risk.includes(k));
        if (addedRisks.length) {
          derivedTradeoffs.push(
            isCn
              ? `平替风险提示：${addedRisks.slice(0, 2).join(' · ')}`
              : `Dupe risk notes: ${addedRisks.slice(0, 2).join(' · ')}`,
          );
        }

        if (derivedTradeoffs.length < 2) {
          const origPreview = pickFew([...origSig.occlusives, ...origSig.humectants, ...origSig.soothing, ...origSig.brightening, ...origSig.exfoliants], 3);
          const dupPreview = pickFew([...dupSig.occlusives, ...dupSig.humectants, ...dupSig.soothing, ...dupSig.brightening, ...dupSig.exfoliants], 3);
          if (origPreview.length && dupPreview.length) {
            derivedTradeoffs.push(
              isCn
                ? `关键成分侧重（简要）：原产品—${origPreview.length ? origPreview.join(' / ') : '未知'}；平替—${dupPreview.length ? dupPreview.join(' / ') : '未知'}。`
                : `Key ingredient emphasis (brief): original — ${origPreview.length ? origPreview.join(' / ') : 'unknown'}; dupe — ${dupPreview.length ? dupPreview.join(' / ') : 'unknown'}.`,
            );
          }
        }

        const origHero = origPayload && origPayload.assessment && typeof origPayload.assessment === 'object'
          ? (origPayload.assessment.hero_ingredient || origPayload.assessment.heroIngredient)
          : null;
        const dupHero = dupePayload && dupePayload.assessment && typeof dupePayload.assessment === 'object'
          ? (dupePayload.assessment.hero_ingredient || dupePayload.assessment.heroIngredient)
          : null;
        if (origHero && dupHero && origHero.name && dupHero.name && String(origHero.name).toLowerCase() !== String(dupHero.name).toLowerCase()) {
          derivedTradeoffs.push(`Hero ingredient shift: ${origHero.name} → ${dupHero.name}`);
        }

        const outConfidence = typeof origEv.conf === 'number' && typeof dupEv.conf === 'number'
          ? (origEv.conf + dupEv.conf) / 2
          : (origEv.conf || dupEv.conf || null);

        const labelLines = (label, arr, max) => uniqStrings(arr).slice(0, max).map((x) => `${label}: ${x}`);

        const mergedEvidence = {
          science: {
            key_ingredients: uniqStrings([...origEv.key, ...dupEv.key]),
            mechanisms: uniqStrings([...origEv.mech, ...dupEv.mech]).slice(0, 8),
            fit_notes: uniqStrings([...labelLines('Original', origEv.fit, 3), ...labelLines('Dupe', dupEv.fit, 3)]),
            risk_notes: uniqStrings([...labelLines('Original', origEv.risk, 3), ...labelLines('Dupe', dupEv.risk, 3)]),
          },
          social_signals: {
            typical_positive: uniqStrings([...labelLines('Original', origEv.pos, 3), ...labelLines('Dupe', dupEv.pos, 3)]),
            typical_negative: uniqStrings([...labelLines('Original', origEv.neg, 3), ...labelLines('Dupe', dupEv.neg, 3)]),
            risk_for_groups: [],
          },
          expert_notes: uniqStrings([...labelLines('Original', origEv.expert, 2), ...labelLines('Dupe', dupEv.expert, 2)]),
          confidence: outConfidence,
          missing_info: uniqStrings(['tradeoffs_from_product_analyze_diff', ...origEv.missing, ...dupEv.missing]),
        };

        const origAnchorOut =
          (origPayload && origPayload.assessment && typeof origPayload.assessment === 'object'
            ? (origPayload.assessment.anchor_product || origPayload.assessment.anchorProduct)
            : null) || payload.original || null;
        const dupeAnchorOut =
          (dupePayload && dupePayload.assessment && typeof dupePayload.assessment === 'object'
            ? (dupePayload.assessment.anchor_product || dupePayload.assessment.anchorProduct)
            : null) || payload.dupe || null;

        if (derivedTradeoffs.length) {
          const rawOut = {
            original: origAnchorOut,
            dupe: dupeAnchorOut,
            ...(payload.similarity != null ? { similarity: payload.similarity } : {}),
            ...(payload.tradeoffs_detail ? { tradeoffs_detail: payload.tradeoffs_detail } : {}),
            tradeoffs: derivedTradeoffs.slice(0, 6),
            evidence: mergedEvidence,
            confidence: outConfidence,
            missing_info: uniqStrings([
              ...uniqStrings(payload.missing_info).filter((c) => c !== 'evidence_missing'),
              'compare_tradeoffs_missing_used_deepscan_diff',
            ]),
          };
          const norm2 = normalizeDupeCompare(rawOut);
          payload = norm2.payload;
          field_missing = mergeFieldMissing(field_missing.filter((x) => x && x.field !== 'tradeoffs'), norm2.field_missing);
          field_missing = mergeFieldMissing(field_missing, mergeFieldMissing(origScan && origScan.field_missing, dupeScan && dupeScan.field_missing));
        }
      }

      if (!Array.isArray(payload.tradeoffs) || payload.tradeoffs.length === 0) {
        const note =
          ctx.lang === 'CN'
            ? '上游未返回可用的取舍对比细节（仅能提供有限对比）。你可以提供平替的链接/完整名称，或从推荐的替代里选择再比对。'
            : 'No tradeoff details were returned (comparison is limited). Provide the dupe link/full name or pick from suggested alternatives to compare again.';
        payload = { ...payload, tradeoffs: [note] };
      }

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [
          {
            card_id: `dupe_${ctx.request_id}`,
            type: 'dupe_compare',
            payload,
            ...(field_missing?.length ? { field_missing: field_missing.slice(0, 8) } : {}),
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'value_moment', { kind: 'dupe_compare' })],
      });
      return res.json(envelope);
    } catch (err) {
      const status = err.status || 500;
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to compare products.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: err.code || 'DUPE_COMPARE_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: err.code || 'DUPE_COMPARE_FAILED' })],
      });
      return res.status(status).json(envelope);
    }
  });

  app.post('/v1/reco/generate', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = RecoGenerateRequestSchema.safeParse(req.body || {});
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

      const identity = await resolveIdentity(req, ctx);
      const profile = await getProfileForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId }).catch(() => null);
      const recentLogs = await getRecentSkinLogsForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId }, 7).catch(() => []);
      const profileSummary = summarizeProfileForContext(profile);

      const gate = shouldDiagnosisGate({ message: 'recommend', triggerSource: 'action', profile });
      if (gate.gated) {
        const prompt = buildDiagnosisPrompt(ctx.lang, gate.missing);
        const chips = buildDiagnosisChips(ctx.lang, gate.missing);
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage(prompt),
          suggested_chips: chips,
          cards: [
            {
              card_id: `diag_${ctx.request_id}`,
              type: 'diagnosis_gate',
              payload: { reason: gate.reason, missing_fields: gate.missing, wants: 'recommendation', profile: profileSummary, recent_logs: recentLogs },
            },
          ],
          session_patch: { next_state: 'S2_DIAGNOSIS' },
          events: [makeEvent({ ...ctx, trigger_source: 'action' }, 'state_entered', { next_state: 'S2_DIAGNOSIS', reason: gate.reason })],
        });
        return res.json(envelope);
      }

      const query = buildAuroraRoutineQuery({
        profile: { ...profileSummary, ...(profile && profile.currentRoutine ? { currentRoutine: profile.currentRoutine } : {}) },
        focus: parsed.data.focus,
        constraints: parsed.data.constraints || {},
        lang: ctx.lang,
      });

      let upstream = null;
      try {
        upstream = await auroraChat({ baseUrl: AURORA_DECISION_BASE_URL, query, timeoutMs: 22000 });
      } catch (err) {
        // ignore
      }

      const routine = upstream && upstream.context && typeof upstream.context === 'object' ? upstream.context.routine : null;
      const mapped = mapAuroraRoutineToRecoGenerate(routine, upstream && upstream.context && typeof upstream.context === 'object' ? upstream.context : null);
      const norm = normalizeRecoGenerate(mapped);
      if (parsed.data.include_alternatives) {
        const alt = await enrichRecommendationsWithAlternatives({
          ctx,
          profileSummary,
          recentLogs,
          recommendations: norm.payload.recommendations,
          logger,
        });
        norm.payload = { ...norm.payload, recommendations: alt.recommendations };
        norm.field_missing = mergeFieldMissing(norm.field_missing, alt.field_missing);
      }
      const payload = norm.payload;

      const suggestedChips = [];
      const nextActions = upstream && Array.isArray(upstream.next_actions) ? upstream.next_actions : [];
      if ((!payload.recommendations || payload.recommendations.length === 0) && nextActions.length) {
        for (const act of nextActions.slice(0, 8)) {
          if (!act || typeof act !== 'object') continue;
          const label = typeof act.label === 'string' ? act.label.trim() : typeof act.text === 'string' ? act.text.trim() : '';
          const text = typeof act.text === 'string' ? act.text.trim() : label;
          const id = typeof act.id === 'string' ? act.id.trim() : '';
          if (!label) continue;
          suggestedChips.push({
            chip_id: `chip.aurora.next_action.${id || label.replace(/\\s+/g, '_')}`.slice(0, 80),
            label,
            kind: 'quick_reply',
            data: { reply_text: text, aurora_action_id: id || null },
          });
        }
      }

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
        ],
        session_patch: payload.recommendations && payload.recommendations.length ? { next_state: 'S7_PRODUCT_RECO' } : {},
        events: [makeEvent({ ...ctx, trigger_source: 'action' }, 'recos_requested', { explicit: true })],
      });
      return res.json(envelope);
    } catch (err) {
      const status = err.status || 500;
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to generate recommendations.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: err.code || 'RECO_GENERATE_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: err.code || 'RECO_GENERATE_FAILED' })],
      });
      return res.status(status).json(envelope);
    }
  });

  app.post('/v1/photos/presign', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = PhotosPresignRequestSchema.safeParse(req.body || {});
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

      if (USE_AURORA_BFF_MOCK) {
        // Stub: real storage/QC should be wired via pivota-backend photos endpoints.
        const photoId = `photo_${ctx.request_id}_${Date.now()}`;
        const payload = {
          photo_id: photoId,
          slot_id: parsed.data.slot_id,
          upload: {
            method: 'PUT',
            url: null,
            headers: {},
            expires_in_seconds: 600,
          },
        };

        const envelope = buildEnvelope(ctx, {
          assistant_message: null,
          suggested_chips: [],
          cards: [
            {
              card_id: `presign_${ctx.request_id}`,
              type: 'photo_presign',
              payload,
              field_missing: [{ field: 'upload.url', reason: 'mock_mode' }],
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'value_moment', { kind: 'photo_presign' })],
        });
        return res.json(envelope);
      }

      if (!PIVOTA_BACKEND_BASE_URL) {
        const photoId = `photo_${ctx.request_id}_${Date.now()}`;
        const payload = {
          photo_id: photoId,
          slot_id: parsed.data.slot_id,
          upload: {
            method: 'PUT',
            url: null,
            headers: {},
            expires_in_seconds: 600,
          },
        };

        const envelope = buildEnvelope(ctx, {
          assistant_message: null,
          suggested_chips: [],
          cards: [
            {
              card_id: `presign_${ctx.request_id}`,
              type: 'photo_presign',
              payload,
              field_missing: [{ field: 'upload.url', reason: 'pivota_backend_not_configured' }],
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'value_moment', { kind: 'photo_presign' })],
        });
        return res.json(envelope);
      }

      const authHeaders = buildPivotaBackendAuthHeaders(req);
      if (!Object.keys(authHeaders).length) {
        const photoId = `photo_${ctx.request_id}_${Date.now()}`;
        const payload = {
          photo_id: photoId,
          slot_id: parsed.data.slot_id,
          upload: {
            method: 'PUT',
            url: null,
            headers: {},
            expires_in_seconds: 600,
          },
        };

        const envelope = buildEnvelope(ctx, {
          assistant_message: null,
          suggested_chips: [],
          cards: [
            {
              card_id: `presign_${ctx.request_id}`,
              type: 'photo_presign',
              payload,
              field_missing: [{ field: 'upload.url', reason: 'pivota_backend_auth_not_configured' }],
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'value_moment', { kind: 'photo_presign' })],
        });
        return res.json(envelope);
      }

      const contentType =
        typeof parsed.data.content_type === 'string' && parsed.data.content_type.trim()
          ? parsed.data.content_type.trim()
          : 'image/jpeg';
      const byteSize = typeof parsed.data.bytes === 'number' && Number.isFinite(parsed.data.bytes) ? parsed.data.bytes : null;

      const upstreamResp = await axios.post(
        `${PIVOTA_BACKEND_BASE_URL}/photos/presign`,
        {
          content_type: contentType,
          ...(byteSize ? { byte_size: byteSize } : {}),
          consent: true,
          user_id: ctx.aurora_uid,
        },
        {
          timeout: 12000,
          validateStatus: () => true,
          headers: { 'Content-Type': 'application/json', ...authHeaders },
        },
      );

      if (upstreamResp.status !== 200 || !upstreamResp.data || !upstreamResp.data.upload_id || !upstreamResp.data.upload) {
        const detail = pickUpstreamErrorDetail(upstreamResp.data);
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Failed to presign upload.'),
          suggested_chips: [],
          cards: [
            {
              card_id: `err_${ctx.request_id}`,
              type: 'error',
              payload: {
                error: 'PHOTO_PRESIGN_UPSTREAM_FAILED',
                status: upstreamResp.status,
                detail: detail || null,
              },
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'PHOTO_PRESIGN_UPSTREAM_FAILED', status: upstreamResp.status })],
        });
        return res.status(upstreamResp.status >= 400 ? upstreamResp.status : 502).json(envelope);
      }

      const uploadId = String(upstreamResp.data.upload_id);
      const upstreamUpload = upstreamResp.data.upload || {};
      const expiresInSeconds = secondsUntilIso(upstreamResp.data.expires_at) ?? 900;

      const payload = {
        photo_id: uploadId,
        slot_id: parsed.data.slot_id,
        upload: {
          method: upstreamUpload.method || 'PUT',
          url: upstreamUpload.url || null,
          headers: upstreamUpload.headers || {},
          expires_in_seconds: expiresInSeconds,
        },
        ...(typeof upstreamResp.data.max_bytes === 'number' ? { max_bytes: upstreamResp.data.max_bytes } : {}),
        ...(upstreamResp.data.tips ? { tips: upstreamResp.data.tips } : {}),
      };

      const fieldMissing = [];
      if (!payload.upload.url) fieldMissing.push({ field: 'upload.url', reason: 'upstream_missing_upload_url' });

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [
          {
            card_id: `presign_${ctx.request_id}`,
            type: 'photo_presign',
            payload,
            ...(fieldMissing.length ? { field_missing: fieldMissing } : {}),
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'value_moment', { kind: 'photo_presign' })],
      });
      return res.json(envelope);
    } catch (err) {
      const status = err.status || 500;
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to presign upload.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: err.code || 'PHOTO_PRESIGN_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: err.code || 'PHOTO_PRESIGN_FAILED' })],
      });
      return res.status(status).json(envelope);
    }
  });

  // Proxy upload to avoid browser-to-storage CORS issues.
  // Request: multipart/form-data with fields:
  // - slot_id (required)
  // - consent=true (required)
  // - file field: photo (required)
  app.post('/v1/photos/upload', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    let tmpDir = null;
    try {
      requireAuroraUid(ctx);

      if (USE_AURORA_BFF_MOCK) {
        const photoId = `photo_${ctx.request_id}_${Date.now()}`;
        const payload = {
          photo_id: photoId,
          slot_id: 'daylight',
          qc_status: 'passed',
          qc: { state: 'done', qc_status: 'passed', advice: { summary: 'Mock: photo looks good.', suggestions: [] } },
        };
        const envelope = buildEnvelope(ctx, {
          assistant_message: null,
          suggested_chips: [],
          cards: [
            {
              card_id: `confirm_${ctx.request_id}`,
              type: 'photo_confirm',
              payload,
              field_missing: [{ field: 'upload.url', reason: 'mock_mode' }],
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'value_moment', { kind: 'photo_upload', qc_status: 'passed' })],
        });
        return res.json(envelope);
      }

      const authHeaders = buildPivotaBackendAuthHeaders(req);
      if (!PIVOTA_BACKEND_BASE_URL) {
        const payload = { photo_id: null, slot_id: null, qc_status: null };
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Photo upload is not configured.'),
          suggested_chips: [],
          cards: [
            {
              card_id: `confirm_${ctx.request_id}`,
              type: 'photo_confirm',
              payload,
              field_missing: [{ field: 'photo_id', reason: 'pivota_backend_not_configured' }],
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'PHOTO_UPLOAD_NOT_CONFIGURED' })],
        });
        return res.status(501).json(envelope);
      }
      if (!Object.keys(authHeaders).length) {
        const payload = { photo_id: null, slot_id: null, qc_status: null };
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Photo upload auth is not configured.'),
          suggested_chips: [],
          cards: [
            {
              card_id: `confirm_${ctx.request_id}`,
              type: 'photo_confirm',
              payload,
              field_missing: [{ field: 'photo_id', reason: 'pivota_backend_auth_not_configured' }],
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'PHOTO_UPLOAD_AUTH_NOT_CONFIGURED' })],
        });
        return res.status(501).json(envelope);
      }

      const reqContentType = String(req.headers['content-type'] || '').toLowerCase();
      if (!reqContentType.includes('multipart/form-data') || !reqContentType.includes('boundary=')) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', detail: 'multipart_required' } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      const { fields, files, tmpDir: parsedTmpDir } = await parseMultipart(req, {
        maxBytes: PHOTO_UPLOAD_PROXY_MAX_BYTES,
        parseTimeoutMs: PHOTO_UPLOAD_PARSE_TIMEOUT_MS,
        allowedContentTypes: new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']),
        requiredFields: ['slot_id', 'consent'],
      });
      tmpDir = parsedTmpDir;

      const slotId = String(fields.slot_id || '').trim();
      if (!slotId) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Missing slot_id.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', detail: 'slot_id_required' } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      const consentRaw = String(fields.consent || '').trim().toLowerCase();
      const consent = consentRaw === 'true' || consentRaw === '1' || consentRaw === 'yes';
      if (!consent) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('User consent is required.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'USER_CONSENT_REQUIRED' } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'USER_CONSENT_REQUIRED' })],
        });
        return res.status(400).json(envelope);
      }

      const fileEntry = files.photo || files.file || files.image || Object.values(files || {})[0];
      if (!fileEntry || !fileEntry.path) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Missing photo file.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', detail: 'photo_file_required' } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      const stat = fs.statSync(fileEntry.path);
      const byteSize = Number.isFinite(stat.size) ? stat.size : null;
      const contentType = fileEntry.contentType || 'image/jpeg';

      const presignResp = await axios.post(
        `${PIVOTA_BACKEND_BASE_URL}/photos/presign`,
        {
          content_type: contentType,
          ...(byteSize ? { byte_size: byteSize } : {}),
          consent: true,
          user_id: ctx.aurora_uid,
        },
        {
          timeout: 12000,
          validateStatus: () => true,
          headers: { 'Content-Type': 'application/json', ...authHeaders },
        },
      );

      if (presignResp.status !== 200 || !presignResp.data || !presignResp.data.upload_id || !presignResp.data.upload) {
        const detail = pickUpstreamErrorDetail(presignResp.data);
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Failed to start photo upload.'),
          suggested_chips: [],
          cards: [
            {
              card_id: `err_${ctx.request_id}`,
              type: 'error',
              payload: { error: 'PHOTO_PRESIGN_UPSTREAM_FAILED', status: presignResp.status, detail: detail || null },
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'PHOTO_PRESIGN_UPSTREAM_FAILED', status: presignResp.status })],
        });
        return res.status(presignResp.status >= 400 ? presignResp.status : 502).json(envelope);
      }

      const uploadId = String(presignResp.data.upload_id);
      const upstreamUpload = presignResp.data.upload || {};
      const uploadUrl = typeof upstreamUpload.url === 'string' ? upstreamUpload.url.trim() : '';
      const uploadMethod = typeof upstreamUpload.method === 'string' && upstreamUpload.method.trim()
        ? upstreamUpload.method.trim().toUpperCase()
        : 'PUT';
      const uploadHeaders = upstreamUpload.headers && typeof upstreamUpload.headers === 'object' ? upstreamUpload.headers : {};

      if (!uploadUrl) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Upload URL is missing from upstream.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'UPSTREAM_MISSING_UPLOAD_URL' } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'UPSTREAM_MISSING_UPLOAD_URL' })],
        });
        return res.status(502).json(envelope);
      }

      const hasHeader = (headersObj, key) => {
        const wanted = String(key || '').toLowerCase();
        for (const k of Object.keys(headersObj || {})) {
          if (String(k).toLowerCase() === wanted) return true;
        }
        return false;
      };

      const finalUploadHeaders = { ...uploadHeaders };
      // Some S3-compatible providers require a Content-Length (otherwise 411 Length Required).
      if (byteSize && !hasHeader(finalUploadHeaders, 'content-length')) {
        finalUploadHeaders['Content-Length'] = String(byteSize);
      }
      // Ensure Content-Type is present if upstream didn't include it.
      if (contentType && !hasHeader(finalUploadHeaders, 'content-type')) {
        finalUploadHeaders['Content-Type'] = contentType;
      }

      const uploadResp = await axios.request({
        method: uploadMethod,
        url: uploadUrl,
        headers: finalUploadHeaders,
        data: fs.createReadStream(fileEntry.path),
        timeout: 120000,
        maxBodyLength: 30 * 1024 * 1024,
        maxContentLength: 30 * 1024 * 1024,
        validateStatus: () => true,
      });

      if (uploadResp.status < 200 || uploadResp.status >= 300) {
        const detail =
          typeof uploadResp.data === 'string'
            ? uploadResp.data.slice(0, 4000)
            : uploadResp.data && typeof uploadResp.data === 'object'
              ? JSON.stringify(uploadResp.data).slice(0, 4000)
              : null;
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Failed to upload photo bytes.'),
          suggested_chips: [],
          cards: [
            {
              card_id: `err_${ctx.request_id}`,
              type: 'error',
              payload: { error: 'PHOTO_UPLOAD_BYTES_FAILED', status: uploadResp.status, detail },
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'PHOTO_UPLOAD_BYTES_FAILED', status: uploadResp.status })],
        });
        return res.status(502).json(envelope);
      }

      const confirmResp = await axios.post(
        `${PIVOTA_BACKEND_BASE_URL}/photos/confirm`,
        { upload_id: uploadId, ...(byteSize ? { byte_size: byteSize } : {}) },
        {
          timeout: 12000,
          validateStatus: () => true,
          headers: { 'Content-Type': 'application/json', ...authHeaders },
        },
      );

      if (confirmResp.status !== 200 || !confirmResp.data) {
        const detail = pickUpstreamErrorDetail(confirmResp.data);
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Failed to confirm upload.'),
          suggested_chips: [],
          cards: [
            {
              card_id: `err_${ctx.request_id}`,
              type: 'error',
              payload: { error: 'PHOTO_CONFIRM_UPSTREAM_FAILED', status: confirmResp.status, detail: detail || null },
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'PHOTO_CONFIRM_UPSTREAM_FAILED', status: confirmResp.status })],
        });
        return res.status(confirmResp.status >= 400 ? confirmResp.status : 502).json(envelope);
      }

      let qcStatus = resolvePhotoQcStatus(confirmResp.data);
      let qc = confirmResp.data.qc && typeof confirmResp.data.qc === 'object' ? confirmResp.data.qc : null;
      let nextPollMs = typeof confirmResp.data.next_poll_ms === 'number' ? confirmResp.data.next_poll_ms : null;

      const deadlineMs = Date.now() + 6000;
      let lastQcData = null;
      while (!qcStatus && Date.now() < deadlineMs) {
        const waitMs = Math.min(1200, Math.max(400, nextPollMs || 1000));
        await sleep(waitMs);

        const qcResp = await axios.get(`${PIVOTA_BACKEND_BASE_URL}/photos/qc`, {
          timeout: 12000,
          validateStatus: () => true,
          headers: authHeaders,
          params: { upload_id: uploadId },
        });

        if (qcResp.status !== 200 || !qcResp.data) break;
        lastQcData = qcResp.data;
        const resolvedPollStatus = resolvePhotoQcStatus(qcResp.data);
        if (resolvedPollStatus) qcStatus = resolvedPollStatus;
        qc = qcResp.data.qc && typeof qcResp.data.qc === 'object' ? qcResp.data.qc : qc;
        nextPollMs = typeof qcResp.data.next_poll_ms === 'number' ? qcResp.data.next_poll_ms : nextPollMs;
      }

      const payload = {
        photo_id: uploadId,
        slot_id: slotId,
        qc_status: qcStatus,
        ...(qc ? { qc } : {}),
        ...(typeof nextPollMs === 'number' ? { next_poll_ms: nextPollMs } : {}),
        ...(!qcStatus && lastQcData ? { qc_pending: true } : {}),
      };

      try {
        const uploadBuffer = fs.readFileSync(fileEntry.path);
        setPhotoBytesCache({
          photoId: uploadId,
          auroraUid: ctx.aurora_uid,
          buffer: uploadBuffer,
          contentType,
        });
      } catch (cacheErr) {
        logger?.warn({ err: cacheErr && cacheErr.message ? cacheErr.message : String(cacheErr) }, 'aurora bff: failed to cache upload bytes');
      }

      const fieldMissing = [];
      if (!qcStatus) fieldMissing.push({ field: 'qc_status', reason: 'qc_pending' });

      const photoConfirmCard = {
        card_id: `confirm_${ctx.request_id}`,
        type: 'photo_confirm',
        payload,
        ...(fieldMissing.length ? { field_missing: fieldMissing } : {}),
      };
      const autoAnalysis = await safeBuildAutoAnalysisFromConfirmedPhoto({
        req,
        ctx,
        photoId: uploadId,
        slotId,
        qcStatus,
        logger,
      });

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [photoConfirmCard, ...(autoAnalysis && Array.isArray(autoAnalysis.cards) ? autoAnalysis.cards : [])],
        session_patch: autoAnalysis && autoAnalysis.session_patch ? autoAnalysis.session_patch : {},
        events: [
          makeEvent(ctx, 'value_moment', { kind: 'photo_upload', qc_status: qcStatus }),
          ...(autoAnalysis && autoAnalysis.event ? [autoAnalysis.event] : []),
        ],
      });
      return res.json(envelope);
    } catch (err) {
      const status = Number(err?.statusCode || err?.status || 500);
      const code = err?.code || 'PHOTO_UPLOAD_FAILED';
      logger?.error(
        {
          err: err && err.message ? err.message : String(err),
          code,
          request_id: ctx.request_id,
          trace_id: ctx.trace_id,
          aurora_uid: ctx.aurora_uid,
        },
        'aurora bff: /v1/photos/upload failed',
      );
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to upload photo.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: code } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code })],
      });
      return res.status(status).json(envelope);
    } finally {
      if (tmpDir) rmrf(tmpDir);
    }
  });

  app.post('/v1/photos/confirm', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = PhotosConfirmRequestSchema.safeParse(req.body || {});
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

      if (USE_AURORA_BFF_MOCK) {
        const qcStatus = 'passed';
        const payload = { ...parsed.data, qc_status: qcStatus };

        const envelope = buildEnvelope(ctx, {
          assistant_message: null,
          suggested_chips: [],
          cards: [{ card_id: `confirm_${ctx.request_id}`, type: 'photo_confirm', payload }],
          session_patch: {},
          events: [makeEvent(ctx, 'value_moment', { kind: 'photo_confirm', qc_status: qcStatus })],
        });
        return res.json(envelope);
      }

      if (!PIVOTA_BACKEND_BASE_URL) {
        const payload = { ...parsed.data, qc_status: null };
        const envelope = buildEnvelope(ctx, {
          assistant_message: null,
          suggested_chips: [],
          cards: [
            {
              card_id: `confirm_${ctx.request_id}`,
              type: 'photo_confirm',
              payload,
              field_missing: [{ field: 'qc_status', reason: 'pivota_backend_not_configured' }],
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'value_moment', { kind: 'photo_confirm', qc_status: null })],
        });
        return res.json(envelope);
      }

      const authHeaders = buildPivotaBackendAuthHeaders(req);
      if (!Object.keys(authHeaders).length) {
        const payload = { ...parsed.data, qc_status: null };
        const envelope = buildEnvelope(ctx, {
          assistant_message: null,
          suggested_chips: [],
          cards: [
            {
              card_id: `confirm_${ctx.request_id}`,
              type: 'photo_confirm',
              payload,
              field_missing: [{ field: 'qc_status', reason: 'pivota_backend_auth_not_configured' }],
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'value_moment', { kind: 'photo_confirm', qc_status: null })],
        });
        return res.json(envelope);
      }

      const uploadId = parsed.data.photo_id;
      const confirmResp = await axios.post(
        `${PIVOTA_BACKEND_BASE_URL}/photos/confirm`,
        { upload_id: uploadId },
        {
          timeout: 12000,
          validateStatus: () => true,
          headers: { 'Content-Type': 'application/json', ...authHeaders },
        },
      );

      if (confirmResp.status !== 200 || !confirmResp.data) {
        const detail = pickUpstreamErrorDetail(confirmResp.data);
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Failed to confirm upload.'),
          suggested_chips: [],
          cards: [
            {
              card_id: `err_${ctx.request_id}`,
              type: 'error',
              payload: {
                error: 'PHOTO_CONFIRM_UPSTREAM_FAILED',
                status: confirmResp.status,
                detail: detail || null,
              },
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'PHOTO_CONFIRM_UPSTREAM_FAILED', status: confirmResp.status })],
        });
        return res.status(confirmResp.status >= 400 ? confirmResp.status : 502).json(envelope);
      }

      let qcStatus = resolvePhotoQcStatus(confirmResp.data);
      let qc = confirmResp.data.qc && typeof confirmResp.data.qc === 'object' ? confirmResp.data.qc : null;
      let nextPollMs = typeof confirmResp.data.next_poll_ms === 'number' ? confirmResp.data.next_poll_ms : null;

      const deadlineMs = Date.now() + 6000;
      let lastQcData = null;
      while (!qcStatus && Date.now() < deadlineMs) {
        const waitMs = Math.min(1200, Math.max(400, nextPollMs || 1000));
        await sleep(waitMs);

        const qcResp = await axios.get(`${PIVOTA_BACKEND_BASE_URL}/photos/qc`, {
          timeout: 12000,
          validateStatus: () => true,
          headers: authHeaders,
          params: { upload_id: uploadId },
        });

        if (qcResp.status !== 200 || !qcResp.data) break;

        lastQcData = qcResp.data;
        const resolvedPollStatus = resolvePhotoQcStatus(qcResp.data);
        if (resolvedPollStatus) qcStatus = resolvedPollStatus;
        qc = qcResp.data.qc && typeof qcResp.data.qc === 'object' ? qcResp.data.qc : qc;
        nextPollMs = typeof qcResp.data.next_poll_ms === 'number' ? qcResp.data.next_poll_ms : nextPollMs;
      }

      const payload = {
        ...parsed.data,
        qc_status: qcStatus,
        ...(qc ? { qc } : {}),
        ...(typeof nextPollMs === 'number' ? { next_poll_ms: nextPollMs } : {}),
        ...(!qcStatus && lastQcData ? { qc_pending: true } : {}),
      };

      const fieldMissing = [];
      if (!qcStatus) fieldMissing.push({ field: 'qc_status', reason: 'qc_pending' });

      const photoConfirmCard = {
        card_id: `confirm_${ctx.request_id}`,
        type: 'photo_confirm',
        payload,
        ...(fieldMissing.length ? { field_missing: fieldMissing } : {}),
      };
      const autoAnalysis = await safeBuildAutoAnalysisFromConfirmedPhoto({
        req,
        ctx,
        photoId: uploadId,
        slotId: parsed.data.slot_id || null,
        qcStatus,
        logger,
      });

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [photoConfirmCard, ...(autoAnalysis && Array.isArray(autoAnalysis.cards) ? autoAnalysis.cards : [])],
        session_patch: autoAnalysis && autoAnalysis.session_patch ? autoAnalysis.session_patch : {},
        events: [
          makeEvent(ctx, 'value_moment', { kind: 'photo_confirm', qc_status: qcStatus }),
          ...(autoAnalysis && autoAnalysis.event ? [autoAnalysis.event] : []),
        ],
      });
      return res.json(envelope);
    } catch (err) {
      const status = Number(err?.statusCode || err?.status || 500);
      const code = err?.code || 'PHOTO_CONFIRM_FAILED';
      logger?.error(
        {
          err: err && err.message ? err.message : String(err),
          code,
          request_id: ctx.request_id,
          trace_id: ctx.trace_id,
          aurora_uid: ctx.aurora_uid,
        },
        'aurora bff: /v1/photos/confirm failed',
      );
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to confirm upload.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: code } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code })],
      });
      return res.status(status).json(envelope);
    }
  });

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

        if (routineFromRequest !== undefined) {
          // Best-effort persistence. Analysis should still proceed even if storage is unavailable.
          profile = { ...(profile || {}), currentRoutine: routineFromRequest };
          if (persistLastAnalysis) {
            try {
              profile = await upsertProfileForIdentity(
                { auroraUid: identity.auroraUid, userId: identity.userId },
                { currentRoutine: routineFromRequest },
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
        profiler.end('quality', { kind: 'memory', has_routine: hasRoutine, logs_n: recentLogsSummary.length });

        // "Dual input" policy: photos optional, routine strongly recommended.
        // Treat missing routine as low-confidence and fall back to a baseline when no other primary signals exist.
        const hasPrimaryInput = hasRoutine || recentLogsSummary.length > 0;

        const userRequestedPhoto =
          parsed.data.use_photo === true || (parsed.data.use_photo == null && photosProvided);
        const forceVisionCall = Boolean(SKIN_VISION_FORCE_CALL && userRequestedPhoto && photosProvided && hasPrimaryInput);
        const detectorConfidence = inferDetectorConfidence({ profileSummary, recentLogsSummary, routineCandidate });
        const selectedVisionProvider = resolveVisionProviderSelection();
        const visionAvailability = classifyVisionAvailability({
          enabled: SKIN_VISION_ENABLED,
          apiKeyConfigured: selectedVisionProvider.apiKeyConfigured,
        });
        const visionAvailable = visionAvailability.available && !rollout.llmKillSwitch;
        const reportAvailable = Boolean(AURORA_DECISION_BASE_URL) && !USE_AURORA_BFF_MOCK && !rollout.llmKillSwitch;

        const analysisFieldMissing = [];
        const qualityReportReasons = [];
        const photoFailureCodes = [];
        let usedPhotos = false;
        let analysisSource = 'rule_based';
        let visionRuntime = null;
        let visionDecisionForReport = null;

	        let diagnosisPhoto = null;
	        let diagnosisPhotoBytes = null;
	        let shadowVerifyPhotoBytes = null;
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

        if (userRequestedPhoto && photosProvided && hasPrimaryInput && photoQuality.grade !== 'fail') {
          const candidates = photoQuality.grade === 'pass' ? passedPhotos : degradedPhotos.length ? degradedPhotos : passedPhotos;
          diagnosisPhoto = chooseVisionPhoto(candidates);
          if (!diagnosisPhoto) {
            analysisFieldMissing.push({ field: 'analysis.used_photos', reason: 'no_usable_photo' });
            if (ctx.lang === 'CN') qualityReportReasons.push('没有可用的照片（缺少 photo_id 或未通过质量门槛）；我会跳过照片检测。');
            else qualityReportReasons.push('No usable photo (missing photo_id or failed quality gate); skipping photo checks.');
          } else {
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
                hasPrimaryInput,
                userRequestedPhoto,
                detectorConfidenceLevel: policyDetectorConfidenceLevel,
                uncertainty: policyUncertainty,
                visionAvailable,
                visionUnavailabilityReason: visionAvailability.reason,
                reportAvailable,
                degradedMode: SKIN_DEGRADED_MODE,
              });
        const reportDecision = rollout.llmKillSwitch
          ? { decision: 'skip', reasons: ['llm_kill_switch'], downgrade_confidence: true }
          : shouldCallLlm({
              kind: 'report',
              quality: qualityForReport,
              hasPrimaryInput,
              userRequestedPhoto,
              detectorConfidenceLevel: policyDetectorConfidenceLevel,
              uncertainty: policyUncertainty,
              visionAvailable,
              reportAvailable,
              degradedMode: SKIN_DEGRADED_MODE,
            });

        let analysis = null;
        if (userRequestedPhoto && photosProvided && !hasPrimaryInput) {
          analysisFieldMissing.push({ field: 'analysis.used_photos', reason: 'routine_or_recent_logs_required' });
          if (ctx.lang === 'CN') qualityReportReasons.push('你提供了照片，但缺少“正在用什么/最近打卡”等关键信息；我会先给低风险基线。');
          else qualityReportReasons.push('You provided a photo, but I’m missing routine/recent logs; returning a low-risk baseline first.');
        }

        if (userRequestedPhoto && photosProvided && photoQuality.grade === 'fail' && !forceVisionCall) {
          analysis = profiler.timeSync('detector', () => buildRetakeSkinAnalysis({ language: ctx.lang, photoQuality }), {
            kind: 'retake',
          });
          analysisSource = 'retake';
          if (ctx.lang === 'CN') qualityReportReasons.push('照片质量未通过：我不会调用 AI 做皮肤结论，避免误判；建议按提示重拍。');
          else qualityReportReasons.push('Photo quality failed: skipping all AI analysis to avoid guessy results; please retake.');
        } else if (userRequestedPhoto && photosProvided && photoQuality.grade === 'fail' && forceVisionCall) {
          if (ctx.lang === 'CN') qualityReportReasons.push('已开启调试强制：即使质量判定失败也会尝试继续调用照片模型。');
          else qualityReportReasons.push('Force-vision debug enabled: attempting photo model call despite fail-grade quality.');
        }

        if (!analysis && visionDecision.decision === 'call') {
          const candidates = photoQuality.grade === 'pass'
            ? passedPhotos
            : degradedPhotos.length
              ? degradedPhotos
              : forceVisionCall
                ? [...passedPhotos, ...degradedPhotos, ...failedPhotos]
                : passedPhotos;
          const chosen = chooseVisionPhoto(candidates);
          if (!chosen) {
            analysisFieldMissing.push({ field: 'photos', reason: photosProvided ? 'no_usable_photo' : 'no_photo_uploaded' });
            if (ctx.lang === 'CN') qualityReportReasons.push('没有可用的照片（缺少 photo_id 或未通过质量门槛）；我会跳过照片解析。');
            else qualityReportReasons.push('No usable photo (missing photo_id or failed quality gate); skipping photo analysis.');
          } else {
            let photoBytes = null;
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
              const vision = await runVisionSkinAnalysis({
                provider: selectedVisionProvider.provider,
                imageBuffer: photoBytes,
                language: ctx.lang,
                photoQuality,
                diagnosisPolicy,
                diagnosisV1,
                profileSummary,
                recentLogsSummary,
                profiler,
                promptVersion,
              });
              visionRuntime = vision;
              if (vision && vision.ok && vision.analysis) {
                analysis = vision.analysis;
                usedPhotos = true;
                shadowVerifyPhotoBytes = photoBytes;
                analysisSource = vision.provider === 'gemini' ? 'vision_gemini' : 'vision_openai';
              } else if (vision && !vision.ok) {
                const normalizedReason = normalizeVisionReason(vision.reason);
                analysisFieldMissing.push({
                  field: 'analysis.used_photos',
                  reason: normalizedReason || 'VISION_UNKNOWN',
                });
                if (ctx.lang === 'CN') qualityReportReasons.push(`照片解析失败（${normalizedReason || 'VISION_UNKNOWN'}）；我会退回到确定性基线。`);
                else qualityReportReasons.push(`Photo analysis failed (${normalizedReason || 'VISION_UNKNOWN'}); falling back to deterministic baseline.`);
                logger?.warn(
                  {
                    reason: normalizedReason || 'VISION_UNKNOWN',
                    provider: vision.provider || selectedVisionProvider.provider || 'unknown',
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

        if (!analysis && reportDecision.decision === 'call' && hasPrimaryInput && AURORA_DECISION_BASE_URL && !USE_AURORA_BFF_MOCK) {
          const promptBase = buildSkinReportPrompt({
            language: ctx.lang,
            photoQuality: qualityForReport,
            diagnosisPolicy,
            diagnosisV1,
            profileSummary,
            routineCandidate: hasRoutine ? routineCandidate : null,
            recentLogsSummary,
            promptVersion,
          });

          let reportFailure = null;
          for (let attempt = 0; attempt < 2; attempt += 1) {
            const prompt =
              attempt === 0
                ? promptBase
                : `${promptBase}\nSELF-CHECK before responding: output MUST be strict JSON only (no markdown/text), exactly the specified keys, and strategy must end with a single direct question.\n`;

            let upstream = null;
            try {
              upstream = await profiler.timeLlmCall({ provider: 'aurora', model: null, kind: 'skin_text' }, async () =>
                auroraChat({ baseUrl: AURORA_DECISION_BASE_URL, query: prompt, timeoutMs: 12000 }),
              );
            } catch (err) {
              logger?.warn({ err: err.message }, 'aurora bff: skin analysis upstream failed');
              reportFailure = 'report_upstream_failed';
              break;
            }

            const answer = upstream && typeof upstream.answer === 'string' ? upstream.answer : '';
            const jsonOnly = unwrapCodeFence(answer);
            const parsedObj = parseJsonOnlyObject(jsonOnly);
            analysis = normalizeSkinAnalysisFromLLM(parsedObj, { language: ctx.lang });
            if (analysis) {
              analysisSource = 'aurora_text';
              break;
            }
            reportFailure = 'report_output_invalid';
          }
          if (!analysis && reportFailure) {
            if (ctx.lang === 'CN') qualityReportReasons.push(`报告模型未能稳定输出（${reportFailure}）；我会退回到确定性基线。`);
            else qualityReportReasons.push(`Report model output was unstable (${reportFailure}); falling back to deterministic baseline.`);
          }
        }
        if (!analysis && reportDecision.decision === 'skip' && reportAvailable && hasPrimaryInput) {
          const r = humanizeLlmReasons(reportDecision.reasons, { language: ctx.lang });
          if (ctx.lang === 'CN') qualityReportReasons.push(`已跳过报告模型：${r.join('；') || '原因未知'}`);
          else qualityReportReasons.push(`Skipped report model: ${r.join('; ') || 'unknown reason'}`);
        }

        if (!analysis) {
          if (!hasPrimaryInput) {
            analysis = profiler.timeSync(
              'detector',
              () => buildLowConfidenceBaselineSkinAnalysis({ profile: profileSummary || profile, language: ctx.lang }),
              { kind: 'baseline_low_confidence' },
            );
            analysisSource = 'baseline_low_confidence';
          } else {
            if (userRequestedPhoto && photosProvided && diagnosisV1 && diagnosisV1.quality) {
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
          provider: selectedVisionProvider.provider || 'openai',
          upstream_status_code: null,
          latency_ms: null,
          retry: visionRetryDefault,
        };

        if (visionRuntime && visionRuntime.ok) {
          visionDecisionForReport = {
            ...visionDecisionForReport,
            decision: 'call',
            reasons: ['quality_pass'],
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
          provider: visionDecisionForReport.provider || 'openai',
          decision: visionDecisionForReport.decision,
          reasons: visionDecisionForReport.reasons,
          latencyMs: visionDecisionForReport.latency_ms,
        });

        const mustDowngrade =
          userRequestedPhoto &&
          photosProvided &&
          (photoQuality.grade === 'degraded' || photoQuality.grade === 'unknown') &&
          analysisSource !== 'retake';
        if (analysis && mustDowngrade) analysis = downgradeSkinAnalysisConfidence(analysis, { language: ctx.lang });
        if (analysis && diagnosisV1 && usedPhotos) {
          analysis = mergePhotoFindingsIntoAnalysis({
            analysis,
            diagnosisV1,
            language: ctx.lang,
            profileSummary,
          });
        }
        const photoNotUsed = Boolean(userRequestedPhoto && photosProvided && !usedPhotos);
        const photoFailureCode = photoFailureCodes[0] || null;
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
          geometrySanitizer =
            analysis && analysis.__geometry_sanitizer && typeof analysis.__geometry_sanitizer === 'object'
              ? analysis.__geometry_sanitizer
              : null;
          if (analysis && Object.prototype.hasOwnProperty.call(analysis, '__geometry_sanitizer')) {
            delete analysis.__geometry_sanitizer;
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

        const photoModulesCard = maybeBuildPhotoModulesCardForAnalysis({
          requestId: ctx.request_id,
          analysis,
          usedPhotos,
          photoQuality,
          photoNotice:
            photoNotice && typeof photoNotice.message === 'string' && photoNotice.message.trim()
              ? photoNotice.message
              : visionPhotoNoticeMessage,
          diagnosisInternal: diagnosisV1Internal,
          profileSummary,
          language: ctx.lang,
          skinMask: photoModulesSkinMask,
        });

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

        profiler.start('render', { kind: 'envelope' });
        const envelope = buildEnvelope(ctx, {
          assistant_message: null,
          suggested_chips: [],
          cards: [
            {
              card_id: `analysis_${ctx.request_id}`,
              type: 'analysis_summary',
              payload: {
                analysis,
                low_confidence: analysisSource === 'baseline_low_confidence',
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
                  reasons: qualityReportReasons.slice(0, 8),
                },
              },
              ...(analysisFieldMissing.length ? { field_missing: analysisFieldMissing } : {}),
            },
            ...(photoModulesCard ? [photoModulesCard] : []),
          ],
          session_patch: { next_state: 'S5_ANALYSIS_SUMMARY' },
          events: [
            makeEvent(ctx, 'value_moment', { kind: 'skin_analysis', used_photos: usedPhotos, analysis_source: renderedAnalysisSource }),
          ],
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
		              .then((verify) => {
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
		              })
	              .catch((err) => {
	                logger?.warn({ err: err && err.message ? err.message : String(err) }, 'diag verify: shadow run failed');
	              });
	          });
	        }

	        return { envelope, report };
	      };

      const output = await runOnce({
        pipelineVersion: outputPipelineVersion,
        persistLastAnalysis: true,
        shadowRun: false,
      });

      if (shadowRunV2) {
        setImmediate(() => {
          runOnce({ pipelineVersion: 'v2', persistLastAnalysis: false, shadowRun: true }).catch((err) => {
            logger?.warn({ err: err && err.message ? err.message : String(err) }, 'aurora bff: v2 shadow run failed');
          });
        });
      }

      return res.json(output.envelope);
    } catch (err) {
      const status = err.status || 500;
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

  app.get('/v1/session/bootstrap', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      let profile = null;
      let recentLogs = [];
      let dbError = null;
      const identity = await resolveIdentity(req, ctx);
      try {
        profile = await getProfileForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId });
        recentLogs = await getRecentSkinLogsForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId }, 7);
      } catch (err) {
        dbError = err;
      }

      const isReturning = Boolean(profile) || recentLogs.length > 0;
      const checkinDue = isCheckinDue(recentLogs);

      const cards = [
        {
          card_id: `bootstrap_${ctx.request_id}`,
          type: 'session_bootstrap',
          payload: {
            profile: summarizeProfileForContext(profile),
            recent_logs: recentLogs,
            checkin_due: checkinDue,
            is_returning: isReturning,
            db_ready: !dbError,
          },
          ...(dbError
            ? { field_missing: [{ field: 'profile', reason: 'db_not_configured_or_unavailable' }] }
            : {}),
        },
      ];

      const events = [makeEvent(ctx, 'state_entered', { state: ctx.state || 'unknown', trigger_source: ctx.trigger_source })];
      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards,
        session_patch: {
          profile: summarizeProfileForContext(profile),
          recent_logs: recentLogs,
          checkin_due: checkinDue,
          is_returning: isReturning,
        },
        events,
      });
      return res.json(envelope);
    } catch (err) {
      const status = err.status || 500;
      logger?.warn({ err: err.message, status }, 'session bootstrap failed');
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to bootstrap session.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: err.code || 'BOOTSTRAP_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: err.code || 'BOOTSTRAP_FAILED' })],
      });
      return res.status(status).json(envelope);
    }
  });

  app.post('/v1/profile/update', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = UserProfilePatchSchema.safeParse(req.body || {});
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

      const identity = await resolveIdentity(req, ctx);
      const updated = await upsertProfileForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId }, parsed.data);

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [
          { card_id: `profile_${ctx.request_id}`, type: 'profile', payload: { profile: summarizeProfileForContext(updated) } },
        ],
        session_patch: { profile: summarizeProfileForContext(updated) },
        events: [makeEvent(ctx, 'profile_saved', { fields: Object.keys(parsed.data) })],
      });
      return res.json(envelope);
    } catch (err) {
      const { code, dbError, dbNotConfigured, dbSchemaError } = classifyStorageError(err);
      const status =
        err && typeof err.status === 'number' && Number.isFinite(err.status) && err.status >= 400 && err.status < 600
          ? err.status
          : dbError
            ? 503
            : 500;
      logger?.warn({ err: err?.message || String(err), code, status }, 'profile update failed');
      const envelope = buildEnvelope(ctx, {
        assistant_message:
          status >= 400 && status < 500
            ? makeAssistantMessage('Invalid request.')
            : makeAssistantMessage(dbError ? 'Storage is not ready yet. Please try again shortly.' : 'Failed to save profile.'),
        suggested_chips: [],
        cards: [
          {
            card_id: `err_${ctx.request_id}`,
            type: 'error',
            payload: {
              error:
                status >= 400 && status < 500
                  ? err.code || 'BAD_REQUEST'
                  : dbNotConfigured
                    ? 'DB_NOT_CONFIGURED'
                    : dbSchemaError
                      ? 'DB_SCHEMA_NOT_READY'
                      : dbError
                        ? 'DB_UNAVAILABLE'
                        : 'PROFILE_SAVE_FAILED',
              ...(status >= 400 && status < 500 ? {} : code ? { code } : {}),
            },
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: (status >= 400 && status < 500 ? err.code : code) || 'PROFILE_SAVE_FAILED' })],
      });
      return res.status(status).json(envelope);
    }
  });

	  app.post('/v1/profile/delete', async (req, res) => {
	    const ctx = buildRequestContext(req, {});
	    try {
	      requireAuroraUid(ctx);
	      const identity = await resolveIdentity(req, ctx);
	      const result = await deleteIdentityData({ auroraUid: identity.auroraUid, userId: identity.userId });
	      try {
	        const hardCases = await deleteHardCasesForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId, logger });
	        if (hardCases && hardCases.deleted) {
	          logger?.info(
	            { kind: 'hard_case_delete', request_id: ctx.request_id, deleted: hardCases.deleted },
	            'hard case sampler: deleted on profile delete',
	          );
	        }
	      } catch (err) {
	        logger?.warn({ err: err && err.message ? err.message : String(err) }, 'hard case sampler: profile delete cleanup failed');
	      }

	      const envelope = buildEnvelope(ctx, {
	        assistant_message: null,
	        suggested_chips: [],
        cards: [
          {
            card_id: `profile_delete_${ctx.request_id}`,
            type: 'profile_deleted',
            payload: { ok: Boolean(result && result.ok), deleted: Boolean(result && result.deleted), storage: result?.storage || null },
          },
        ],
        session_patch: {
          profile: null,
          recent_logs: [],
          checkin_due: true,
          is_returning: false,
        },
        events: [makeEvent(ctx, 'profile_deleted', { storage: result?.storage || null })],
      });
      return res.json(envelope);
    } catch (err) {
      const { code, dbError, dbNotConfigured, dbSchemaError } = classifyStorageError(err);
      const status =
        err && typeof err.status === 'number' && Number.isFinite(err.status) && err.status >= 400 && err.status < 600
          ? err.status
          : dbError
            ? 503
            : 500;
      logger?.warn({ err: err?.message || String(err), code, status }, 'profile delete failed');
      const envelope = buildEnvelope(ctx, {
        assistant_message:
          status >= 400 && status < 500
            ? makeAssistantMessage('Invalid request.')
            : makeAssistantMessage(dbError ? 'Storage is not ready yet. Please try again shortly.' : 'Failed to delete profile data.'),
        suggested_chips: [],
        cards: [
          {
            card_id: `err_${ctx.request_id}`,
            type: 'error',
            payload: {
              error:
                status >= 400 && status < 500
                  ? err.code || 'BAD_REQUEST'
                  : dbNotConfigured
                    ? 'DB_NOT_CONFIGURED'
                    : dbSchemaError
                      ? 'DB_SCHEMA_NOT_READY'
                      : dbError
                        ? 'DB_UNAVAILABLE'
                        : 'PROFILE_DELETE_FAILED',
              ...(status >= 400 && status < 500 ? {} : code ? { code } : {}),
            },
          },
        ],
        session_patch: {},
        events: [
          makeEvent(ctx, 'error', { code: (status >= 400 && status < 500 ? err.code : code) || 'PROFILE_DELETE_FAILED' }),
        ],
      });
      return res.status(status).json(envelope);
    }
  });

  app.post('/v1/tracker/log', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = TrackerLogSchema.safeParse(req.body || {});
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

      const identity = await resolveIdentity(req, ctx);
      const saved = await upsertSkinLogForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId }, parsed.data);
      const recent = await getRecentSkinLogsForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId }, 7);

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [
          { card_id: `tracker_${ctx.request_id}`, type: 'tracker_log', payload: { log: saved, recent_logs: recent } },
        ],
        session_patch: { recent_logs: recent, checkin_due: isCheckinDue(recent) },
        events: [makeEvent(ctx, 'tracker_logged', { date: saved?.date || null })],
      });
      return res.json(envelope);
    } catch (err) {
      const { code, dbError, dbNotConfigured, dbSchemaError } = classifyStorageError(err);
      const status =
        err && typeof err.status === 'number' && Number.isFinite(err.status) && err.status >= 400 && err.status < 600
          ? err.status
          : dbError
            ? 503
            : 500;
      logger?.warn({ err: err?.message || String(err), code, status }, 'tracker log failed');
      const envelope = buildEnvelope(ctx, {
        assistant_message:
          status >= 400 && status < 500
            ? makeAssistantMessage('Invalid request.')
            : makeAssistantMessage(dbError ? 'Storage is not ready yet. Please try again shortly.' : 'Failed to save tracker log.'),
        suggested_chips: [],
        cards: [
          {
            card_id: `err_${ctx.request_id}`,
            type: 'error',
            payload: {
              error:
                status >= 400 && status < 500
                  ? err.code || 'BAD_REQUEST'
                  : dbNotConfigured
                    ? 'DB_NOT_CONFIGURED'
                    : dbSchemaError
                      ? 'DB_SCHEMA_NOT_READY'
                      : dbError
                        ? 'DB_UNAVAILABLE'
                        : 'TRACKER_LOG_FAILED',
              ...(status >= 400 && status < 500 ? {} : code ? { code } : {}),
            },
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: (status >= 400 && status < 500 ? err.code : code) || 'TRACKER_LOG_FAILED' })],
      });
      return res.status(status).json(envelope);
    }
  });

  app.get('/v1/tracker/recent', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const days = req.query.days ? Number(req.query.days) : 7;
      const identity = await resolveIdentity(req, ctx);
      const recent = await getRecentSkinLogsForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId }, days);
      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [{ card_id: `recent_${ctx.request_id}`, type: 'tracker_recent', payload: { days, logs: recent } }],
        session_patch: { recent_logs: recent, checkin_due: isCheckinDue(recent) },
        events: [makeEvent(ctx, 'tracker_loaded', { days })],
      });
      return res.json(envelope);
    } catch (err) {
      const { code, dbError, dbNotConfigured, dbSchemaError } = classifyStorageError(err);
      const status =
        err && typeof err.status === 'number' && Number.isFinite(err.status) && err.status >= 400 && err.status < 600
          ? err.status
          : dbError
            ? 503
            : 500;
      logger?.warn({ err: err?.message || String(err), code, status }, 'tracker recent failed');
      const envelope = buildEnvelope(ctx, {
        assistant_message:
          status >= 400 && status < 500
            ? makeAssistantMessage('Invalid request.')
            : makeAssistantMessage(dbError ? 'Storage is not ready yet. Please try again shortly.' : 'Failed to load tracker logs.'),
        suggested_chips: [],
        cards: [
          {
            card_id: `err_${ctx.request_id}`,
            type: 'error',
            payload: {
              error:
                status >= 400 && status < 500
                  ? err.code || 'BAD_REQUEST'
                  : dbNotConfigured
                    ? 'DB_NOT_CONFIGURED'
                    : dbSchemaError
                      ? 'DB_SCHEMA_NOT_READY'
                      : dbError
                        ? 'DB_UNAVAILABLE'
                        : 'TRACKER_LOAD_FAILED',
              ...(status >= 400 && status < 500 ? {} : code ? { code } : {}),
            },
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: (status >= 400 && status < 500 ? err.code : code) || 'TRACKER_LOAD_FAILED' })],
      });
      return res.status(status).json(envelope);
    }
  });

  app.post('/v1/routine/simulate', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = RoutineSimulateRequestSchema.safeParse(req.body || {});
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

      const routine = parsed.data.routine || {};
      const testProduct = parsed.data.test_product || null;
      const sim = simulateConflicts({ routine, testProduct });
      const heatmapSteps = buildHeatmapStepsFromRoutine(routine, { testProduct });
      const heatmapPayload = CONFLICT_HEATMAP_V1_ENABLED
        ? buildConflictHeatmapV1({ routineSimulation: { safe: sim.safe, conflicts: sim.conflicts, summary: sim.summary }, routineSteps: heatmapSteps })
        : { schema_version: 'aurora.ui.conflict_heatmap.v1' };
      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [
          {
            card_id: `sim_${ctx.request_id}`,
            type: 'routine_simulation',
            payload: { safe: sim.safe, conflicts: sim.conflicts, summary: sim.summary },
          },
          {
            card_id: `heatmap_${ctx.request_id}`,
            type: 'conflict_heatmap',
            payload: heatmapPayload,
          },
        ],
        session_patch: {},
        events: [
          makeEvent(ctx, 'simulate_conflict', { safe: sim.safe, conflicts: sim.conflicts.length }),
          ...(CONFLICT_HEATMAP_V1_ENABLED
            ? [
              makeEvent(ctx, 'aurora_conflict_heatmap_impression', {
                schema_version: heatmapPayload.schema_version,
                state: heatmapPayload.state,
                num_steps: Array.isArray(heatmapPayload.axes?.rows?.items) ? heatmapPayload.axes.rows.items.length : 0,
                num_cells_nonzero: Array.isArray(heatmapPayload.cells?.items) ? heatmapPayload.cells.items.length : 0,
                num_unmapped_conflicts: Array.isArray(heatmapPayload.unmapped_conflicts) ? heatmapPayload.unmapped_conflicts.length : 0,
                max_severity: Math.max(
                  0,
                  ...((Array.isArray(heatmapPayload.cells?.items) ? heatmapPayload.cells.items : []).map((c) => Number(c?.severity) || 0)),
                  ...((Array.isArray(heatmapPayload.unmapped_conflicts) ? heatmapPayload.unmapped_conflicts : []).map((c) => Number(c?.severity) || 0)),
                ),
                routine_simulation_safe: Boolean(sim.safe),
                routine_conflict_count: sim.conflicts.length,
                trigger_source: ctx.trigger_source,
              }),
            ]
            : []),
        ],
      });
      return res.json(envelope);
    } catch (err) {
      logger?.warn({ err: err.message }, 'routine simulate failed');
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to simulate routine.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'SIMULATE_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: 'SIMULATE_FAILED' })],
      });
      return res.status(500).json(envelope);
    }
  });

  app.post('/v1/offers/resolve', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = OffersResolveRequestSchema.safeParse(req.body || {});
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

      const market = String(parsed.data.market || 'US').trim() || 'US';
      const items = parsed.data.items;

      const resolved = [];
      const fieldMissing = [];

      for (const item of items) {
        const itemStartedAt = Date.now();
        const itemElapsedMs = () => Math.max(0, Date.now() - itemStartedAt);
        const product = item.product;
        const offer = item.offer;
        const url = offer && (offer.affiliate_url || offer.affiliateUrl || offer.url);

        if (USE_AURORA_BFF_MOCK) {
          const nextItem = applyOfferItemPdpOpenContract({
            product: { ...product, image_url: product.image_url || 'https://img.example.com/mock.jpg' },
            offer: { ...offer, price: typeof offer.price === 'number' && offer.price > 0 ? offer.price : 12.34, currency: offer.currency || 'USD' },
          }, { timeToPdpMs: itemElapsedMs() });
          resolved.push(nextItem);
          continue;
        }

        if (!url) {
          resolved.push(applyOfferItemPdpOpenContract(item, { timeToPdpMs: itemElapsedMs() }));
          fieldMissing.push({ field: 'offer.affiliate_url', reason: 'missing_affiliate_url' });
          continue;
        }
        if (!PIVOTA_BACKEND_BASE_URL) {
          resolved.push(applyOfferItemPdpOpenContract(item, { timeToPdpMs: itemElapsedMs() }));
          fieldMissing.push({ field: 'offer.snapshot', reason: 'pivota_backend_not_configured' });
          continue;
        }

        try {
          const resp = await axios.post(
            `${PIVOTA_BACKEND_BASE_URL}/api/offers/external/resolve`,
            { market, url, forceRefresh: false },
            { timeout: 12000, validateStatus: () => true },
          );
          if (resp.status !== 200 || !resp.data || !resp.data.ok || !resp.data.offer) {
            const failReason = mapOfferResolveFailureCode({
              responseBody: resp?.data,
              statusCode: resp?.status,
            });
            resolved.push(
              applyOfferItemPdpOpenContract(item, {
                failReasonCode: failReason,
                resolveAttempted: true,
                timeToPdpMs: itemElapsedMs(),
              }),
            );
            fieldMissing.push({
              field: 'offer.snapshot',
              reason: failReason === 'db_error' ? 'external_offer_resolve_db_error' : 'external_offer_resolve_failed',
            });
            continue;
          }
          const snap = resp.data.offer;
          const patchedProduct = { ...product };
          const patchedOffer = { ...offer };

          if (snap.imageUrl) patchedProduct.image_url = snap.imageUrl;
          if (snap.title && !patchedProduct.name) patchedProduct.name = snap.title;
          if (snap.brand && !patchedProduct.brand) patchedProduct.brand = snap.brand;
          if (snap.price && typeof snap.price === 'object') {
            if (typeof snap.price.amount === 'number') patchedOffer.price = snap.price.amount;
            if (typeof snap.price.currency === 'string') patchedOffer.currency = snap.price.currency;
          }
          if (snap.canonicalUrl) patchedOffer.affiliate_url = snap.canonicalUrl;

          resolved.push(
            applyOfferItemPdpOpenContract(
              { ...item, product: patchedProduct, offer: patchedOffer },
              { resolveAttempted: true, timeToPdpMs: itemElapsedMs() },
            ),
          );
        } catch (err) {
          const failReason = mapOfferResolveFailureCode({ error: err });
          resolved.push(
            applyOfferItemPdpOpenContract(item, {
              failReasonCode: failReason,
              resolveAttempted: true,
              timeToPdpMs: itemElapsedMs(),
            }),
          );
          fieldMissing.push({
            field: 'offer.snapshot',
            reason: failReason === 'db_error' ? 'external_offer_resolve_db_error' : 'external_offer_resolve_timeout_or_network',
          });
        }
      }

      const offersPdpMeta = summarizeOfferPdpOpen(resolved);

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [
          {
            card_id: `offers_${ctx.request_id}`,
            type: 'offers_resolved',
            payload: {
              items: resolved,
              market,
              metadata: {
                pdp_open_path_stats: offersPdpMeta.path_stats,
                fail_reason_counts: offersPdpMeta.fail_reason_counts,
                time_to_pdp_ms_stats: offersPdpMeta.time_to_pdp_ms_stats,
              },
            },
            ...(fieldMissing.length ? { field_missing: fieldMissing.slice(0, 8) } : {}),
          },
        ],
        session_patch: {},
        events: [
          makeEvent(ctx, 'offers_resolved', {
            count: resolved.length,
            market,
            pdp_open_path_stats: offersPdpMeta.path_stats,
            fail_reason_counts: offersPdpMeta.fail_reason_counts,
            time_to_pdp_ms_stats: offersPdpMeta.time_to_pdp_ms_stats,
          }),
        ],
      });
      return res.json(envelope);
    } catch (err) {
      logger?.warn({ err: err.message }, 'offers resolve failed');
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to resolve offers.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'OFFERS_RESOLVE_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: 'OFFERS_RESOLVE_FAILED' })],
      });
      return res.status(500).json(envelope);
    }
  });

  app.post('/v1/affiliate/outcome', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = AffiliateOutcomeRequestSchema.safeParse(req.body || {});
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

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [{ card_id: `out_${ctx.request_id}`, type: 'affiliate_outcome', payload: parsed.data }],
        session_patch: {},
        events: [makeEvent(ctx, 'outbound_opened', { outcome: parsed.data.outcome, url: parsed.data.url || null })],
      });
      return res.json(envelope);
    } catch (err) {
      logger?.warn({ err: err.message }, 'affiliate outcome failed');
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to record outcome.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'OUTCOME_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: 'OUTCOME_FAILED' })],
      });
      return res.status(500).json(envelope);
    }
  });

  app.post('/v1/chat', async (req, res) => {
    const parsed = V1ChatRequestSchema.safeParse(req.body || {});
    const ctx = buildRequestContext(req, parsed.success ? parsed.data : req.body || {});

    try {
      requireAuroraUid(ctx);
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

      const identity = await resolveIdentity(req, ctx);

      // Best-effort context injection.
      let profile = null;
      let recentLogs = [];
      let storageContextLoadFailed = false;
      try {
        profile = await getProfileForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId });
        recentLogs = await getRecentSkinLogsForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId }, 7);
      } catch (err) {
        storageContextLoadFailed = true;
        logger?.warn({ err: err.code || err.message }, 'aurora bff: failed to load memory context');
      }
      if (storageContextLoadFailed) {
        recordProfileContextMissing({ side: 'backend' });
      }

      // If the client already has a profile snapshot (for example, cached from bootstrap or a local quick-profile flow),
      // use it as an additional best-effort context source so we don't re-ask for already-known fields when DB reads fail.
      const profilePatchFromSession = extractProfilePatchFromSession(parsed.data.session);
      if (!profilePatchFromSession) {
        recordProfileContextMissing({ side: 'frontend' });
      }
      if (profilePatchFromSession) {
        profile = { ...(profile || {}), ...profilePatchFromSession };
      }

      // Allow chips/actions to patch profile inline (so chat can progress without an extra API call).
      const profilePatchFromAction = parseProfilePatchFromAction(parsed.data.action);
      let appliedProfilePatch = null;
      if (profilePatchFromAction) {
        const patchParsed = UserProfilePatchSchema.safeParse(profilePatchFromAction);
        if (patchParsed.success) {
          appliedProfilePatch = patchParsed.data;
          // Always apply inline for gating even if DB is unavailable.
          profile = { ...(profile || {}), ...patchParsed.data };
          try {
            profile = await upsertProfileForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId }, patchParsed.data);
          } catch (err) {
            logger?.warn({ err: err.code || err.message }, 'aurora bff: failed to apply profile chip patch');
          }
        }
      }

      const actionReplyText = extractReplyTextFromAction(parsed.data.action);
      const message = String(parsed.data.message || '').trim() || actionReplyText || '';
      const actionId =
        parsed.data.action && typeof parsed.data.action === 'object'
          ? parsed.data.action.action_id
          : typeof parsed.data.action === 'string'
            ? parsed.data.action
            : null;
      const clarificationId =
        parsed.data.action &&
        typeof parsed.data.action === 'object' &&
        parsed.data.action.data &&
        typeof parsed.data.action.data === 'object'
          ? parsed.data.action.data.clarification_id || parsed.data.action.data.clarificationId || null
          : null;
      const includeAlternatives = extractIncludeAlternativesFromAction(parsed.data.action);
      const debugHeader = req.get('X-Debug') ?? req.get('X-Aurora-Debug');
      const debugFromHeader = debugHeader == null ? undefined : coerceBoolean(debugHeader);
      const debugFromBody = typeof parsed.data.debug === 'boolean' ? parsed.data.debug : undefined;
      const debugUpstream = debugFromHeader ?? debugFromBody;
      const anchorProductId =
        typeof parsed.data.anchor_product_id === 'string' && parsed.data.anchor_product_id.trim()
          ? parsed.data.anchor_product_id.trim()
          : '';
      const anchorProductUrl =
        typeof parsed.data.anchor_product_url === 'string' && parsed.data.anchor_product_url.trim()
          ? parsed.data.anchor_product_url.trim()
          : '';
      const upstreamMessages = Array.isArray(parsed.data.messages) ? parsed.data.messages : null;

      const makeChatAssistantMessage = (content, format = 'text') => {
        const preambleSeed = `${ctx.request_id || ''}|${ctx.trace_id || ''}|${String(content || '').slice(0, 96)}`;
        const text = addEmotionalPreambleToAssistantText(content, { language: ctx.lang, profile, seed: preambleSeed });
        return makeAssistantMessage(text, format);
      };

      const clientAgentState = normalizeAgentState(parsed.data.client_state);

      const requestedTransitionFromBody =
        parsed.data.requested_transition && typeof parsed.data.requested_transition === 'object'
          ? parsed.data.requested_transition
          : null;

      const derivedTransitionFromAction = !requestedTransitionFromBody && actionId
        ? deriveRequestedTransitionFromAction({ fromState: clientAgentState, actionId })
        : null;

      const derivedTransitionFromText = !requestedTransitionFromBody && !derivedTransitionFromAction && message
        ? inferTextExplicitTransition(message, ctx.lang)
        : null;

      const requestedTransition =
        requestedTransitionFromBody ||
        derivedTransitionFromAction ||
        (derivedTransitionFromText
          ? { trigger_source: 'text_explicit', trigger_id: derivedTransitionFromText.trigger_id, requested_next_state: derivedTransitionFromText.requested_next_state }
          : null);

      let agentState = clientAgentState;
      if (requestedTransition) {
        const triggerSource = String(requestedTransition.trigger_source || '').trim();
        const triggerId = String(requestedTransition.trigger_id || '').trim();
        const requestedNextState = normalizeAgentState(requestedTransition.requested_next_state);

        if (triggerSource === 'text_explicit') {
          const inferred = inferTextExplicitTransition(message, ctx.lang);
          if (!inferred || inferred.requested_next_state !== requestedNextState) {
            const envelope = buildEnvelope(ctx, {
              assistant_message: makeAssistantMessage(
                ctx.lang === 'CN'
                  ? '当前请求的状态跳转不合法（text_explicit 未命中显式短语）。'
                  : 'Requested state transition rejected (text_explicit did not match allowlist).',
              ),
              suggested_chips: [],
              cards: [
                {
                  card_id: `err_${ctx.request_id}`,
                  type: 'error',
                  payload: {
                    error: 'STATE_TRANSITION_REJECTED',
                    details: { reason: 'TEXT_EXPLICIT_NOT_ALLOWED', requested_next_state: requestedNextState },
                  },
                },
              ],
              session_patch: {},
              events: [makeEvent(ctx, 'error', { code: 'STATE_TRANSITION_REJECTED', reason: 'TEXT_EXPLICIT_NOT_ALLOWED' })],
            });
            return res.status(400).json(envelope);
          }
        }

        const validation = validateRequestedTransition({
          fromState: clientAgentState,
          triggerSource,
          triggerId,
          requestedNextState,
        });

        if (!validation.ok) {
          const envelope = buildEnvelope(ctx, {
            assistant_message: makeAssistantMessage(
              ctx.lang === 'CN'
                ? '当前请求的状态跳转不合法（状态机硬规则拒绝）。'
                : 'Requested state transition rejected (state machine hard rule).',
            ),
            suggested_chips: [],
            cards: [
              {
                card_id: `err_${ctx.request_id}`,
                type: 'error',
                payload: {
                  error: 'STATE_TRANSITION_REJECTED',
                  details: {
                    reason: validation.reason,
                    from_state: clientAgentState,
                    requested_next_state: requestedNextState,
                    trigger_source: triggerSource,
                    trigger_id: triggerId,
                  },
                },
              },
            ],
            session_patch: {},
            events: [makeEvent(ctx, 'error', { code: 'STATE_TRANSITION_REJECTED', reason: validation.reason })],
          });
          return res.status(400).json(envelope);
        }

        agentState = validation.next_state;
      }

      const recoInteractionAllowed = recommendationsAllowed({
        triggerSource: ctx.trigger_source,
        actionId,
        clarificationId,
        message,
        state: ctx.state,
        agentState,
      });

      const allowRecoCards =
        agentState === 'RECO_GATE' ||
        agentState === 'RECO_CONSTRAINTS' ||
        agentState === 'RECO_RESULTS' ||
        // Dynamic clarification chips (for example: chip.clarify.budget.*) may not exist in the
        // static state-machine map, but are still explicit recommendation interactions.
        recoInteractionAllowed;

      let upstreamMessage = message;
      let clarificationHistoryForUpstream = null;
      let resumeContextForUpstream = null;
      let pendingClarificationPatchOverride = undefined;
      let forceUpstreamAfterPendingAbandon = false;
      const clarifyChipAction = isClarifyChipAction(parsed.data.action, { actionId, clarificationId });
      const sessionStateRaw =
        parsed.data.session && typeof parsed.data.session === 'object' && !Array.isArray(parsed.data.session)
          ? parsed.data.session.state
          : null;
      const hasRawPendingClarification =
        sessionStateRaw &&
        typeof sessionStateRaw === 'object' &&
        !Array.isArray(sessionStateRaw) &&
        Object.prototype.hasOwnProperty.call(sessionStateRaw, 'pending_clarification');
      const pendingClarificationState = getPendingClarification(parsed.data.session);
      const pendingClarification = pendingClarificationState ? pendingClarificationState.pending : null;
      if (
        AURORA_CHAT_CLARIFICATION_FLOW_V2_ENABLED &&
        pendingClarificationState &&
        pendingClarificationState.upgraded &&
        pendingClarificationPatchOverride === undefined
      ) {
        pendingClarificationPatchOverride = pendingClarification;
      }
      if (AURORA_CHAT_CLARIFICATION_FLOW_V2_ENABLED && hasRawPendingClarification && !pendingClarification) {
        recordPendingClarificationAbandoned({ reason: 'error' });
      }

      let pendingClarificationExpired = false;
      if (AURORA_CHAT_CLARIFICATION_FLOW_V2_ENABLED && pendingClarification) {
        const ageMs = Date.now() - Number(pendingClarification.created_at_ms || 0);
        if (!Number.isFinite(ageMs) || ageMs > PENDING_CLARIFICATION_TTL_MS) {
          pendingClarificationExpired = true;
          pendingClarificationPatchOverride = null;
          if (clarifyChipAction) forceUpstreamAfterPendingAbandon = true;
          recordPendingClarificationAbandoned({ reason: 'ttl' });
        }
      }

      if (
        AURORA_CHAT_CLARIFICATION_FLOW_V2_ENABLED &&
        pendingClarification &&
        !pendingClarificationExpired &&
        !clarifyChipAction &&
        message
      ) {
        pendingClarificationPatchOverride = null;
        recordPendingClarificationAbandoned({ reason: 'free_text' });
      }

      if (
        AURORA_CHAT_CLARIFICATION_FLOW_V2_ENABLED &&
        !pendingClarification &&
        clarifyChipAction &&
        hasPendingClarificationStateHint(parsed.data.action)
      ) {
        recordPendingClarificationAbandoned({ reason: 'missing_state' });
      }

      if (
        AURORA_CHAT_CLARIFICATION_FLOW_V2_ENABLED &&
        pendingClarification &&
        !pendingClarificationExpired &&
        clarifyChipAction
      ) {
        const selectedOption = actionReplyText || parseClarificationReplyFromActionId(actionId);
        const selectedQuestionId =
          extractClarificationQuestionIdFromAction(parsed.data.action) ||
          (pendingClarification.current && pendingClarification.current.id) ||
          (typeof clarificationId === 'string' ? clarificationId.trim() : '') ||
          parseClarificationIdFromActionId(actionId);
        const { nextPending, nextQuestion, history } = advancePendingClarification(
          pendingClarification,
          selectedOption,
          selectedQuestionId,
        );

        if (nextPending && nextQuestion) {
          const profileSummaryForPatch = summarizeProfileForContext(profile);
          const sessionPatch = {};
          emitPendingClarificationPatch(sessionPatch, nextPending);
          if (profileSummaryForPatch) {
            sessionPatch.profile = profileSummaryForPatch;
            recordSessionPatchProfileEmitted({ changed: Boolean(appliedProfilePatch) });
          }
          const nextStepIndex = Array.isArray(nextPending.history) ? nextPending.history.length + 1 : 1;
          const chips = buildChipsForQuestion(nextQuestion, { stepIndex: nextStepIndex });
          recordAuroraChatSkipped({ reason: 'pending_clarification_step' });
          recordPendingClarificationStep({ stepIndex: Array.isArray(nextPending.history) ? nextPending.history.length : 1 });

          const questionText = String(nextQuestion.question || '').trim() ||
            (ctx.lang === 'CN' ? '再补充一个信息就好。' : 'One more quick question.');
          const envelope = buildEnvelope(ctx, {
            assistant_message: makeChatAssistantMessage(questionText),
            suggested_chips: chips,
            cards: [],
            session_patch: sessionPatch,
            events: [makeEvent(ctx, 'state_entered', { next_state: ctx.state || 'idle', reason: 'pending_clarification_step' })],
          });
          return res.json(envelope);
        }

        pendingClarificationPatchOverride = null;
        upstreamMessage = pendingClarification.resume_user_text || upstreamMessage || message;
        const compactHistory = compactClarificationHistory(history);
        if (AURORA_CHAT_CLARIFICATION_HISTORY_CONTEXT_ENABLED) {
          clarificationHistoryForUpstream = compactHistory;
        }
        const profileSummaryForResume = summarizeProfileForContext(profile);
        const knownProfileFieldsForResume = buildResumeKnownProfileFields(profileSummaryForResume);
        resumeContextForUpstream = {
          flow_id:
            pendingClarification && typeof pendingClarification.flow_id === 'string'
              ? pendingClarification.flow_id
              : null,
          resume_user_text: upstreamMessage || pendingClarification.resume_user_text || message || '(no message)',
          clarification_history: compactHistory,
          include_history: AURORA_CHAT_CLARIFICATION_HISTORY_CONTEXT_ENABLED,
          ...(knownProfileFieldsForResume ? { known_profile_fields: knownProfileFieldsForResume } : {}),
        };
        forceUpstreamAfterPendingAbandon = true;
        recordPendingClarificationCompleted();
      }

      // Optional session state override (used to escape sticky gates like S6_BUDGET when user switches intent).
      let nextStateOverride = null;

      // Escape sticky budget gate early so local short-circuit paths (env/conflict) can also return a session patch.
      if (ctx.state === 'S6_BUDGET') {
        const wantsFitCheck = looksLikeSuitabilityRequest(message);
        const wantsCompat = looksLikeCompatibilityOrConflictQuestion(message);
        const wantsScience = looksLikeIngredientScienceIntent(message, parsed.data.action);
        const wantsRecoNoRoutine =
          looksLikeRecommendationRequest(message) &&
          !looksLikeRoutineRequest(message, parsed.data.action);
        const wantsEnvStress =
          looksLikeWeatherOrEnvironmentQuestion(message) &&
          (ctx.trigger_source === 'text' || ctx.trigger_source === 'text_explicit');
        if (wantsFitCheck || wantsCompat || wantsScience || wantsEnvStress || wantsRecoNoRoutine) {
          if (stateChangeAllowed(ctx.trigger_source)) {
            nextStateOverride = allowRecoCards ? 'S7_PRODUCT_RECO' : 'idle';
          }
          ctx.state = nextStateOverride || 'idle';
        }
      }

      // Brand availability short-circuit: route "有没有某品牌的产品/有货吗/哪里买" to catalog lookup (no diagnosis intake).
      if (
        AURORA_CHAT_CATALOG_AVAIL_FAST_PATH_ENABLED &&
        message &&
        (ctx.trigger_source === 'text' || ctx.trigger_source === 'text_explicit')
      ) {
        const availabilityIntent = detectBrandAvailabilityIntent(message, ctx.lang);
        if (availabilityIntent) {
          recordCatalogAvailabilityShortCircuit({ brandId: availabilityIntent.brand_id, reason: availabilityIntent.reason });

          const brandProduct = buildBrandPlaceholderProduct({
            brandId: availabilityIntent.brand_id,
            brandName: availabilityIntent.brand_name,
            lang: ctx.lang,
          });

          const availabilityQuery = buildAvailabilityCatalogQuery(message, availabilityIntent);
          const specificAvailabilityQuery = isSpecificAvailabilityQuery(availabilityQuery, availabilityIntent);
          const resolveAliasCandidates = [
            availabilityIntent.brand_name,
            availabilityIntent.matched_alias,
          ]
            .map((value) => String(value || '').trim())
            .filter(Boolean);
          const resolveAliases = [...new Set(resolveAliasCandidates)].slice(0, 8);
          const resolveHints = {
            ...(availabilityIntent.brand_name ? { brand: availabilityIntent.brand_name } : {}),
            ...(resolveAliases.length ? { aliases: resolveAliases } : {}),
          };

          let catalogResult = { ok: false, products: [], reason: 'unknown' };
          let products = [];
          let availabilityResolveFallback = null;
          let availabilityResolveAttempted = false;
          if (PIVOTA_BACKEND_BASE_URL) {
            catalogResult = await searchPivotaBackendProducts({
              query: availabilityQuery || availabilityIntent.brand_name || availabilityIntent.matched_alias || availabilityIntent.brand_id,
              limit: 8,
              logger,
              timeoutMs: CATALOG_AVAIL_SEARCH_TIMEOUT_MS,
            });
            products = Array.isArray(catalogResult.products) ? catalogResult.products : [];
          } else {
            catalogResult = { ok: false, products: [], reason: 'pivota_backend_not_configured' };
          }

          if (!products.length && CATALOG_AVAIL_RESOLVE_FALLBACK_ENABLED && PIVOTA_BACKEND_BASE_URL) {
            const reason = String(catalogResult.reason || '').trim().toLowerCase();
            const neutralCatalogMiss =
              !reason || reason === 'empty' || reason === 'no_candidates' || reason === 'not_found';
            const shouldRunResolveFallback = specificAvailabilityQuery && neutralCatalogMiss;
            if (shouldRunResolveFallback) {
              availabilityResolveAttempted = true;
              availabilityResolveFallback = await resolveAvailabilityProductByQuery({
                query: availabilityQuery || availabilityIntent.brand_name,
                lang: ctx.lang,
                hints: Object.keys(resolveHints).length ? resolveHints : null,
                logger,
              });
              if (availabilityResolveFallback?.ok && availabilityResolveFallback?.product) {
                products = [availabilityResolveFallback.product];
              }
            }
          }

          const offersItems = (products.length ? products : [brandProduct])
            .slice(0, 8)
            .map((product) => applyOfferItemPdpOpenContract({ product, offer: null }, { timeToPdpMs: 0 }));
          const offersPdpMeta = summarizeOfferPdpOpen(offersItems);

          const marketRaw = profile && typeof profile.region === 'string' ? profile.region.trim() : '';
          const market = marketRaw ? marketRaw.slice(0, 8).toUpperCase() : 'US';

          const hasResults = products.length > 0;
          const resolvedVia = availabilityResolveFallback?.ok ? 'products_resolve' : hasResults ? 'products_search' : 'none';
          const assistantRaw =
            ctx.lang === 'CN'
              ? hasResults
                ? `我在商品库里找到了「${availabilityIntent.brand_name || '该品牌'}」的相关商品（见下方卡片）。你想查官方旗舰/自营，还是某个具体单品名？`
                : `我可以帮你查商品库，但当前没能拉到「${availabilityIntent.brand_name || '该品牌'}」的商品列表。你想查的是官方旗舰/自营，还是某个具体单品名？`
              : hasResults
                ? `I found ${products.length} items for "${availabilityIntent.brand_name || 'this brand'}" (see the cards below). Are you looking for an official store, major retailers, or a specific product name?`
                : `I can help check our catalog, but I couldn't fetch items for "${availabilityIntent.brand_name || 'this brand'}" right now. Are you looking for an official store, major retailers, or a specific product name?`;

          const assistantText = applyCommerceMedicalClaimGuard(assistantRaw, ctx.lang);

          const profileSummary = summarizeProfileForContext(profile);
          const sessionPatch = {
            ...(nextStateOverride && stateChangeAllowed(ctx.trigger_source) ? { next_state: nextStateOverride } : {}),
            ...(profileSummary ? { profile: profileSummary } : {}),
          };
          if (profileSummary) {
            recordSessionPatchProfileEmitted({ changed: Boolean(appliedProfilePatch) });
          }

          const fieldMissing = [];
          if (!hasResults && catalogResult.reason) {
            fieldMissing.push({ field: 'catalog.products', reason: String(catalogResult.reason).slice(0, 60) });
            if (availabilityResolveFallback?.resolve_reason_code) {
              fieldMissing.push({
                field: 'catalog.resolve',
                reason: String(availabilityResolveFallback.resolve_reason_code).slice(0, 60),
              });
            }
          }

          const envelope = buildEnvelope(ctx, {
            assistant_message: makeChatAssistantMessage(assistantText),
            suggested_chips: [],
            cards: [
              {
                card_id: `parse_${ctx.request_id}`,
                type: 'product_parse',
                payload: {
                  product: hasResults && products[0] ? products[0] : brandProduct,
                  confidence: 1,
                  missing_info: [],
                  intent: 'availability',
                  brand_id: availabilityIntent.brand_id,
                  brand_name: availabilityIntent.brand_name,
                },
              },
              {
                card_id: `offers_${ctx.request_id}`,
                type: 'offers_resolved',
                payload: {
                  items: offersItems,
                  market,
                  metadata: {
                    pdp_open_path_stats: offersPdpMeta.path_stats,
                    fail_reason_counts: offersPdpMeta.fail_reason_counts,
                    time_to_pdp_ms_stats: offersPdpMeta.time_to_pdp_ms_stats,
                  },
                },
                ...(fieldMissing.length ? { field_missing: fieldMissing.slice(0, 8) } : {}),
              },
            ],
            session_patch: sessionPatch,
            events: [
              makeEvent(ctx, 'catalog_availability_shortcircuit', {
                brand_id: availabilityIntent.brand_id,
                reason: availabilityIntent.reason,
                ok: Boolean(hasResults),
                count: products.length,
                query: String(availabilityQuery || '').slice(0, 120),
                resolved_via: resolvedVia,
                catalog_reason: catalogResult.reason || null,
                resolve_reason_code: availabilityResolveFallback?.resolve_reason_code || null,
              }),
            ],
          });
          return res.json(envelope);
        }
      }

      // Local env-stress short-circuit: answer weather/environment questions without upstream.
      // Only for user-typed text (including text_explicit). Chips/actions should keep their intended routing.
      if (
        looksLikeWeatherOrEnvironmentQuestion(message) &&
        (ctx.trigger_source === 'text' || ctx.trigger_source === 'text_explicit')
      ) {
        const scenario = extractWeatherScenario(message);
        const envStressUi = buildEnvStressUiModelFromLocal({ profile, recentLogs, message, language: ctx.lang });
        const advice = buildWeatherAdviceMessage({ language: ctx.lang, scenario, profile });

        const lang = ctx.lang === 'CN' ? 'CN' : 'EN';
        const scenarioHint =
          scenario === 'snow'
            ? { cn: '雪天', en: 'snowy weather' }
            : scenario === 'rain'
              ? { cn: '雨天', en: 'rainy weather' }
              : scenario === 'uv'
                ? { cn: '日晒/高 UV', en: 'high UV' }
                : scenario === 'humid'
                  ? { cn: '潮湿闷热', en: 'humid weather' }
                  : scenario === 'dry'
                    ? { cn: '干燥天气', en: 'dry air' }
                    : scenario === 'cold'
                      ? { cn: '寒冷天气', en: 'cold weather' }
                      : scenario === 'wind'
                        ? { cn: '大风天气', en: 'windy weather' }
                        : scenario === 'travel'
                          ? { cn: '旅行/飞行', en: 'travel' }
                          : { cn: '这个天气', en: 'these conditions' };
        const suggestedChips = [
          {
            chip_id: 'chip.start.routine',
            label: lang === 'CN' ? '生成 AM/PM 护肤流程' : 'Build an AM/PM routine',
            kind: 'quick_reply',
            data: {
              reply_text:
                lang === 'CN'
                  ? `帮我按${scenarioHint.cn}生成 AM/PM 护肤流程`
                  : `Build an AM/PM routine for ${scenarioHint.en}`,
            },
          },
          {
            chip_id: 'chip.start.reco_products',
            label: lang === 'CN' ? '推荐防护产品' : 'Recommend protective products',
            kind: 'quick_reply',
            data: {
              reply_text:
                lang === 'CN'
                  ? `${scenarioHint.cn}我应该用什么类型的防护产品？`
                  : `What protective products should I use for ${scenarioHint.en}?`,
            },
          },
        ];

        const envelope = buildEnvelope(ctx, {
          assistant_message: makeChatAssistantMessage(advice, 'markdown'),
          suggested_chips: suggestedChips,
          cards: envStressUi
            ? [{ card_id: `env_${ctx.request_id}`, type: 'env_stress', payload: envStressUi }]
            : [],
          session_patch:
            nextStateOverride && stateChangeAllowed(ctx.trigger_source) ? { next_state: nextStateOverride } : {},
          events: [makeEvent(ctx, 'value_moment', { kind: 'weather_advice', scenario })],
        });
        return res.json(envelope);
      }

      // Local compatibility/conflict short-circuit: return routine_simulation + conflict_heatmap without upstream.
      if (
        looksLikeCompatibilityOrConflictQuestion(message) &&
        // Allow both free text and chip/action reply_text, so users don't get stuck in unrelated gates (e.g. budget).
        (ctx.trigger_source === 'text' ||
          ctx.trigger_source === 'text_explicit' ||
          ctx.trigger_source === 'chip' ||
          ctx.trigger_source === 'action')
      ) {
        // NOTE: For ad-hoc "can I combine X with Y?" questions, do NOT auto-apply `profile.currentRoutine`.
        // Routine-specific simulation should be triggered from the routine feature/flow explicitly (e.g. /v1/routine/simulate).
        const simInput = buildLocalCompatibilitySimulationInput({ message });
        if (simInput) {
          const { routine, testProduct } = simInput;
          const sim = simulateConflicts({ routine, testProduct });
          const simPayload = { safe: sim.safe, conflicts: sim.conflicts, summary: sim.summary };
          const heatmapSteps = buildHeatmapStepsFromRoutine(routine, { testProduct });
          const heatmapPayload = CONFLICT_HEATMAP_V1_ENABLED
            ? buildConflictHeatmapV1({ routineSimulation: simPayload, routineSteps: heatmapSteps })
            : { schema_version: 'aurora.ui.conflict_heatmap.v1' };

          const routeText =
            buildRouteAwareAssistantText({
              route: 'conflict',
              payload: simPayload,
              language: ctx.lang,
              profile,
            }) ||
            (ctx.lang === 'CN'
              ? sim.safe
                ? '未发现明显冲突（见下方冲突热力图）。如果出现刺痛/爆皮，优先降频并加强保湿。'
                : '检测到可能的叠加风险（见下方冲突热力图）。更稳妥：错开晚用/隔天用，并从低频开始。'
              : sim.safe
                ? 'No major conflicts detected (see the heatmap below). If you feel irritation, reduce frequency and moisturize.'
                : 'Potential conflict detected (see the heatmap below). Safer: alternate nights and start low frequency.');
          const msgText = addEmotionalPreambleToAssistantText(routeText, {
            language: ctx.lang,
            profile,
            seed: ctx.request_id,
          });

          const events = [
            makeEvent(ctx, 'simulate_conflict', { safe: sim.safe, conflicts: sim.conflicts.length, source: 'local_chat' }),
          ];
          if (CONFLICT_HEATMAP_V1_ENABLED) {
            events.push(
              makeEvent(ctx, 'aurora_conflict_heatmap_impression', {
                schema_version: heatmapPayload.schema_version,
                state: heatmapPayload.state,
                num_steps: Array.isArray(heatmapPayload.axes?.rows?.items) ? heatmapPayload.axes.rows.items.length : 0,
                num_cells_nonzero: Array.isArray(heatmapPayload.cells?.items) ? heatmapPayload.cells.items.length : 0,
                num_unmapped_conflicts: Array.isArray(heatmapPayload.unmapped_conflicts) ? heatmapPayload.unmapped_conflicts.length : 0,
                max_severity: Math.max(
                  0,
                  ...((Array.isArray(heatmapPayload.cells?.items) ? heatmapPayload.cells.items : []).map((c) => Number(c?.severity) || 0)),
                  ...((Array.isArray(heatmapPayload.unmapped_conflicts) ? heatmapPayload.unmapped_conflicts : []).map((c) => Number(c?.severity) || 0)),
                ),
                routine_simulation_safe: Boolean(simPayload.safe),
                routine_conflict_count: Array.isArray(simPayload.conflicts) ? simPayload.conflicts.length : 0,
                trigger_source: ctx.trigger_source,
              }),
            );
          }

          const envelope = buildEnvelope(ctx, {
            assistant_message: makeChatAssistantMessage(msgText, 'markdown'),
            suggested_chips: [],
            cards: [
              { card_id: `sim_${ctx.request_id}`, type: 'routine_simulation', payload: simPayload },
              { card_id: `heatmap_${ctx.request_id}`, type: 'conflict_heatmap', payload: heatmapPayload },
            ],
            session_patch:
              nextStateOverride && stateChangeAllowed(ctx.trigger_source) ? { next_state: nextStateOverride } : {},
            events,
          });
          return res.json(envelope);
        }
      }

      // Explicit "Start diagnosis" should always enter the diagnosis flow (even if a profile already exists),
      // otherwise users can get stuck in an upstream "what next?" loop.
      if (String(agentState || '') === 'DIAG_PROFILE' || String(agentState || '').startsWith('DIAG_')) {
        const { score, missing } = profileCompleteness(profile);
        const requiredCore = ['skinType', 'sensitivity', 'barrierStatus', 'goals'];
        const missingCore = requiredCore.filter((k) => (Array.isArray(missing) ? missing.includes(k) : false));

        if (missingCore.length) {
          const prompt = buildDiagnosisPrompt(ctx.lang, missingCore);
          const chips = buildDiagnosisChips(ctx.lang, missingCore);
          const nextState = stateChangeAllowed(ctx.trigger_source) ? 'S2_DIAGNOSIS' : undefined;

          const envelope = buildEnvelope(ctx, {
            assistant_message: makeChatAssistantMessage(prompt),
            suggested_chips: chips,
            cards: [
              {
                card_id: `diag_${ctx.request_id}`,
                type: 'diagnosis_gate',
                payload: {
                  reason: 'diagnosis_start',
                  missing_fields: missingCore,
                  wants: 'diagnosis',
                  profile: summarizeProfileForContext(profile),
                  recent_logs: recentLogs,
                },
              },
            ],
            session_patch: nextState ? { next_state: nextState } : {},
            events: [makeEvent(ctx, 'state_entered', { next_state: nextState || null, reason: 'diagnosis_start' })],
          });
          return res.json(envelope);
        }

        const lang = ctx.lang === 'CN' ? 'CN' : 'EN';
        const prompt =
          lang === 'CN'
            ? '已收到你的肤况信息。要不要再上传一张照片让我更准？你也可以先跳过照片，我会给一份低置信度的安全基线。'
            : "Got it — I saved your skin profile. Want to upload a photo for a more accurate analysis? You can also skip photos and I’ll give a low-confidence, safe baseline first.";

        const nextState = stateChangeAllowed(ctx.trigger_source) ? 'S2_DIAGNOSIS' : undefined;
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeChatAssistantMessage(prompt),
          suggested_chips: [
            {
              chip_id: 'chip.intake.upload_photos',
              label: lang === 'CN' ? '上传照片（更准）' : 'Upload a photo (more accurate)',
              kind: 'quick_reply',
              data: {},
            },
            {
              chip_id: 'chip.intake.skip_analysis',
              label: lang === 'CN' ? '跳过照片（低置信度）' : 'Skip photo (low confidence)',
              kind: 'quick_reply',
              data: {},
            },
            {
              chip_id: 'chip_keep_chatting',
              label: lang === 'CN' ? '继续聊聊' : 'Just keep chatting',
              kind: 'quick_reply',
              data: {},
            },
          ],
          cards: [],
          session_patch: nextState ? { next_state: nextState, profile: summarizeProfileForContext(profile) } : { profile: summarizeProfileForContext(profile) },
          events: [makeEvent(ctx, 'state_entered', { next_state: nextState || null, reason: 'diagnosis_profile_complete' })],
        });
        return res.json(envelope);
      }

      const ingredientScienceIntent = looksLikeIngredientScienceIntent(message, parsed.data.action);
      const shouldKickoffIngredientScience =
        ingredientScienceIntent &&
        !looksLikeRoutineRequest(message, parsed.data.action) &&
        !looksLikeSuitabilityRequest(message) &&
        !looksLikeCompatibilityOrConflictQuestion(message) &&
        !looksLikeWeatherOrEnvironmentQuestion(message) &&
        !messageContainsSpecificIngredientScienceTarget(message);

      if (shouldKickoffIngredientScience) {
        const kickoff = buildIngredientScienceKickoff({ language: ctx.lang });
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeChatAssistantMessage(kickoff.prompt),
          suggested_chips: kickoff.chips,
          cards: [],
          session_patch:
            nextStateOverride && stateChangeAllowed(ctx.trigger_source) ? { next_state: nextStateOverride } : {},
          events: [makeEvent(ctx, 'state_entered', { next_state: ctx.state || 'idle', reason: 'ingredient_science_clarify' })],
        });
        return res.json(envelope);
      }

      if (isBudgetOptimizationEntryAction(actionId) && allowRecoCards) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeChatAssistantMessage(buildBudgetGatePrompt(ctx.lang)),
          suggested_chips: buildBudgetGateChips(ctx.lang),
          cards: [
            {
              card_id: `budget_${ctx.request_id}`,
              type: 'budget_gate',
              payload: { reason: 'budget_optimization_optional', profile: summarizeProfileForContext(profile) },
            },
          ],
          session_patch: stateChangeAllowed(ctx.trigger_source) ? { next_state: 'S6_BUDGET' } : {},
          events: [makeEvent(ctx, 'state_entered', { next_state: 'S6_BUDGET', reason: 'budget_optimization_optional' })],
        });
        return res.json(envelope);
      }

      // Phase 0 gate: Diagnosis-first (no recos/offers before minimal profile).
      // NOTE: In chat, avoid forcing users into "diagnosis-first" unless they explicitly asked to start diagnosis.
      // For recommendation/fit-check intents, proceed with best-effort and ask optional refinement questions later.

      // Budget gate + routing: when waiting for budget selection, proceed to routine generation.
      if (ctx.state === 'S6_BUDGET') {
        const rawBudget =
          normalizeBudgetHint(appliedProfilePatch && appliedProfilePatch.budgetTier) ||
          normalizeBudgetHint(profile && profile.budgetTier) ||
          normalizeBudgetHint(message);

        // If user asks a different explicit question while we're waiting for budget, don't trap them behind the routine budget gate.
        // Example: "Is this product suitable for me?" should go to fit-check/product analysis (budget is irrelevant).
        const wantsFitCheck = looksLikeSuitabilityRequest(message);
        const wantsCompat = looksLikeCompatibilityOrConflictQuestion(message);
        const wantsScience = looksLikeIngredientScienceIntent(message, parsed.data.action);
        const wantsRecoNoRoutine =
          looksLikeRecommendationRequest(message) &&
          !looksLikeRoutineRequest(message, parsed.data.action);
        const wantsEnvStress =
          looksLikeWeatherOrEnvironmentQuestion(message) &&
          (ctx.trigger_source === 'text' || ctx.trigger_source === 'text_explicit');

        if (wantsFitCheck || wantsCompat || wantsScience || wantsEnvStress || wantsRecoNoRoutine) {
          // Clear the budget-gate state so the client doesn't get stuck in a loop.
          if (stateChangeAllowed(ctx.trigger_source)) {
            nextStateOverride = allowRecoCards ? 'S7_PRODUCT_RECO' : 'idle';
          }
          ctx.state = nextStateOverride || 'idle';
        } else {
          if (!allowRecoCards) {
            const lang = ctx.lang === 'CN' ? 'CN' : 'EN';
            const suggestedChips = [
              {
                chip_id: 'chip.start.reco_products',
                label: lang === 'CN' ? '获取产品推荐' : 'Get product recommendations',
                kind: 'quick_reply',
                data: { reply_text: lang === 'CN' ? '给我一些产品推荐' : 'Get product recommendations' },
              },
              {
                chip_id: 'chip.start.routine',
                label: lang === 'CN' ? '生成早晚护肤 routine' : 'Build an AM/PM routine',
                kind: 'quick_reply',
                data: { reply_text: lang === 'CN' ? '生成一套早晚护肤 routine' : 'Build an AM/PM skincare routine' },
              },
            ];

            const envelope = buildEnvelope(ctx, {
              assistant_message: makeChatAssistantMessage(
                lang === 'CN'
                  ? '如需推荐与购买入口，请先点击「获取产品推荐」。'
                  : 'To see recommendations and purchase links, please tap “Get product recommendations”.',
              ),
              suggested_chips: suggestedChips,
              cards: [],
              session_patch: {},
              events: [],
            });
            return res.json(envelope);
          }

          if (!rawBudget) {
            const envelope = buildEnvelope(ctx, {
              assistant_message: makeChatAssistantMessage(buildBudgetGatePrompt(ctx.lang)),
              suggested_chips: buildBudgetGateChips(ctx.lang),
              cards: [
                {
                  card_id: `budget_${ctx.request_id}`,
                  type: 'budget_gate',
                  payload: { reason: 'budget_optimization_optional', profile: summarizeProfileForContext(profile) },
                },
              ],
              session_patch: stateChangeAllowed(ctx.trigger_source) ? { next_state: 'S6_BUDGET' } : {},
              events: [makeEvent(ctx, 'state_entered', { next_state: 'S6_BUDGET', reason: 'budget_optimization_optional' })],
            });
            return res.json(envelope);
          }

          if (!profile || profile.budgetTier !== rawBudget) {
            profile = { ...(profile || {}), budgetTier: rawBudget };
            try {
              profile = await upsertProfileForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId }, { budgetTier: rawBudget });
            } catch (err) {
              logger?.warn({ err: err.code || err.message }, 'aurora bff: failed to persist budgetTier');
            }
          }

          const { norm, suggestedChips } = await generateRoutineReco({
            ctx,
            profile,
            recentLogs,
            focus: 'daily routine',
            constraints: { simplicity: 'high' },
            includeAlternatives,
            logger,
          });

          const hasRecs = Array.isArray(norm.payload.recommendations) && norm.payload.recommendations.length > 0;
          const nextState = hasRecs && stateChangeAllowed(ctx.trigger_source) ? 'S7_PRODUCT_RECO' : undefined;
          const payload = !debugUpstream ? stripInternalRefsDeep(norm.payload) : norm.payload;

          const envelope = buildEnvelope(ctx, {
            assistant_message: makeChatAssistantMessage(
              ctx.lang === 'CN'
                ? '已收到预算信息。我生成了一个简洁 AM/PM routine（见下方卡片）。'
                : 'Got it. I generated a simple AM/PM routine (see the card below).',
            ),
            suggested_chips: suggestedChips,
            cards: [
              {
                card_id: `reco_${ctx.request_id}`,
                type: 'recommendations',
                payload,
                ...(norm.field_missing?.length ? { field_missing: norm.field_missing.slice(0, 8) } : {}),
              },
            ],
            session_patch: nextState ? { next_state: nextState } : {},
            events: [
              makeEvent(ctx, 'value_moment', { kind: 'routine_generated' }),
              makeEvent(ctx, 'recos_requested', { explicit: true }),
            ],
          });
          return res.json(envelope);
        }
      }

      // If user explicitly asks to build an AM/PM routine, generate it first.
      // Budget refinement is optional and can be done after showing a usable plan.
      if (
        allowRecoCards &&
        looksLikeRoutineRequest(message, parsed.data.action) &&
        recoInteractionAllowed
      ) {
        const budget = normalizeBudgetHint(profile && profile.budgetTier);

        const { norm, suggestedChips } = await generateRoutineReco({
          ctx,
          profile,
          recentLogs,
          focus: 'daily routine',
          constraints: { simplicity: 'high' },
          includeAlternatives,
          logger,
        });

        const hasRecs = Array.isArray(norm.payload.recommendations) && norm.payload.recommendations.length > 0;
        const nextState = hasRecs && stateChangeAllowed(ctx.trigger_source) ? 'S7_PRODUCT_RECO' : undefined;
        const payload = !debugUpstream ? stripInternalRefsDeep(norm.payload) : norm.payload;
        const nextChips = Array.isArray(suggestedChips) ? [...suggestedChips] : [];
        if (!budget) nextChips.push(buildBudgetOptimizationEntryChip(ctx.lang));

        const envelope = buildEnvelope(ctx, {
          assistant_message: makeChatAssistantMessage(
            !budget
              ? ctx.lang === 'CN'
                ? '我先按“功效与耐受优先”生成了一个简洁 AM/PM routine（见下方卡片）。如果你愿意，我可以再按预算优化一版。'
                : 'I generated a simple AM/PM routine first (efficacy + tolerance prioritized). If you want, I can optimize it by budget next.'
              : ctx.lang === 'CN'
                ? '我生成了一个简洁 AM/PM routine（见下方卡片）。'
                : 'I generated a simple AM/PM routine (see the card below).',
          ),
          suggested_chips: nextChips,
          cards: [
            {
              card_id: `reco_${ctx.request_id}`,
              type: 'recommendations',
              payload,
              ...(norm.field_missing?.length ? { field_missing: norm.field_missing.slice(0, 8) } : {}),
            },
          ],
          session_patch: nextState ? { next_state: nextState } : {},
          events: [
            makeEvent(ctx, 'value_moment', { kind: 'routine_generated' }),
            makeEvent(ctx, 'recos_requested', { explicit: true }),
          ],
        });
        return res.json(envelope);
      }

      const budgetClarificationAction =
        !forceUpstreamAfterPendingAbandon && isBudgetClarificationAction(actionId, clarificationId);
      const budgetChipCanContinueReco =
        budgetClarificationAction &&
        ctx.state === 'S6_BUDGET';
      const profileClarificationAction =
        !forceUpstreamAfterPendingAbandon &&
        Boolean(appliedProfilePatch && Object.keys(appliedProfilePatch).length > 0) &&
        (String(actionId || '').trim().toLowerCase().startsWith('chip.clarify.') || Boolean(clarificationId));
      const budgetChipOutOfFlow =
        budgetClarificationAction &&
        !budgetChipCanContinueReco &&
        isBareBudgetSelectionMessage(message) &&
        !looksLikeRecommendationRequest(message) &&
        !looksLikeSuitabilityRequest(message) &&
        !looksLikeRoutineRequest(message, parsed.data.action) &&
        !looksLikeCompatibilityOrConflictQuestion(message) &&
        !looksLikeWeatherOrEnvironmentQuestion(message);

      // Guardrail for stale budget chips:
      // if the client sends a leftover budget clarify action outside budget/reco flow, do not call upstream
      // and do not emit the confusing parse-only stub fallback.
      if (budgetChipOutOfFlow) {
        const lang = ctx.lang === 'CN' ? 'CN' : 'EN';
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeChatAssistantMessage(
            lang === 'CN'
              ? '我已记录你的预算。你现在想做哪种帮助？（评估单品 / 获取推荐 / 检查搭配冲突）'
              : 'Budget noted. What should I do next? (evaluate one product / get recommendations / check conflicts)',
          ),
          suggested_chips: [
            {
              chip_id: 'chip.action.analyze_product',
              label: lang === 'CN' ? '评估这款是否适合我' : 'Evaluate one product',
              kind: 'quick_reply',
              data: { reply_text: lang === 'CN' ? '这款适不适合我：<产品名>' : 'Is this suitable for me: <product name>' },
            },
            {
              chip_id: 'chip.start.reco_products',
              label: lang === 'CN' ? '给我产品推荐' : 'Get recommendations',
              kind: 'quick_reply',
              data: { reply_text: lang === 'CN' ? '给我一些产品推荐' : 'Get product recommendations' },
            },
            {
              chip_id: 'chip.action.dupe_compare',
              label: lang === 'CN' ? '检查搭配冲突' : 'Check compatibility',
              kind: 'quick_reply',
              data: {
                reply_text:
                  lang === 'CN' ? '阿达帕林/维A + 果酸同晚叠加会冲突吗？' : 'Can I use retinoid + acids in the same night?',
              },
            },
          ],
          cards: [
            {
              card_id: `profile_${ctx.request_id}`,
              type: 'profile',
              payload: { profile: summarizeProfileForContext(profile) },
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'state_entered', { next_state: ctx.state || 'idle', reason: 'stale_budget_chip_ignored' })],
        });
        return res.json(envelope);
      }

      // If user explicitly asks for product recommendations (via chip OR explicit free text), generate them deterministically
      // (some upstream chat flows only return clarifying chips without a recommendations card).
      const wantsProductRecommendations =
        !forceUpstreamAfterPendingAbandon &&
        allowRecoCards &&
        !looksLikeIngredientScienceIntent(message, parsed.data.action) &&
        !looksLikeRoutineRequest(message, parsed.data.action) &&
        !looksLikeSuitabilityRequest(message) &&
        recoInteractionAllowed &&
        (
          actionId === 'chip.start.reco_products' ||
          actionId === 'chip_get_recos' ||
          budgetChipCanContinueReco ||
          profileClarificationAction ||
          looksLikeRecommendationRequest(message)
        );

      if (wantsProductRecommendations) {
        const { score: profileScore, missing: profileMissing } = profileCompleteness(profile);

        // Diagnosis-first gate: if profile is incomplete, do NOT generate recommendations yet.
        // This applies regardless of the current state; otherwise users see weakly-related recos before core profile.
        if (profileScore < 3) {
          const required = Array.isArray(profileMissing) ? profileMissing : [];
          const prompt = buildDiagnosisPrompt(ctx.lang, required);
          const chips = buildDiagnosisChips(ctx.lang, required);
          const nextState = stateChangeAllowed(ctx.trigger_source) ? 'S2_DIAGNOSIS' : undefined;

          const envelope = buildEnvelope(ctx, {
            assistant_message: makeChatAssistantMessage(prompt),
            suggested_chips: chips,
            cards: [
              {
                card_id: `diag_${ctx.request_id}`,
                type: 'diagnosis_gate',
                payload: {
                  reason: 'diagnosis_first',
                  missing_fields: required,
                  wants: 'recommendation',
                  profile: summarizeProfileForContext(profile),
                  recent_logs: recentLogs,
                },
              },
            ],
            session_patch: nextState ? { next_state: nextState } : {},
            events: [
              makeEvent(ctx, 'recos_requested', { explicit: true, gated: true, reason: 'diagnosis_first' }),
              makeEvent(ctx, 'state_entered', { next_state: nextState || null, reason: 'diagnosis_first' }),
            ],
          });
          return res.json(envelope);
        }

        const refinementMissing = (Array.isArray(profileMissing) ? profileMissing : []).filter(
          (f) => f === 'skinType' || f === 'sensitivity',
        );
        const refinementChips = refinementMissing.length ? buildDiagnosisChips(ctx.lang, refinementMissing) : [];

        const { norm, upstreamDebug, alternativesDebug } = await generateProductRecommendations({
          ctx,
          profile,
          recentLogs,
          message,
          includeAlternatives,
          debug: debugUpstream,
          logger,
        });

        const hasRecs = Array.isArray(norm.payload.recommendations) && norm.payload.recommendations.length > 0;
        const nextState = hasRecs && stateChangeAllowed(ctx.trigger_source) ? 'S7_PRODUCT_RECO' : undefined;
        const payload = !debugUpstream ? stripInternalRefsDeep(norm.payload) : norm.payload;

        const recoAssistantBase = buildRouteAwareAssistantText({
          route: 'reco',
          payload,
          language: ctx.lang,
          profile,
        });
        const recoUnavailableLead = ctx.lang === 'CN'
          ? '我还没能从上游拿到完整的可购清单，先给你一版稳妥可执行方案。'
          : "I couldn't fetch a complete purchasable shortlist from upstream, so here's a safe and actionable plan first.";
        const assistantTextRaw = hasRecs
          ? (recoAssistantBase ||
            (ctx.lang === 'CN'
              ? profileScore >= 3
                ? '我已经把核心结果整理成结构化卡片（见下方）。'
                : '我先按“温和/低刺激”给你整理了几款通用选择（见下方卡片）。如果你愿意点选一下肤质/敏感程度，我可以更精准。'
              : 'I summarized the key results into structured cards below.'))
          : (recoAssistantBase
            ? `${recoUnavailableLead}\n\n${recoAssistantBase}`
            : (ctx.lang === 'CN'
              ? '我还没能从上游拿到可结构化的产品推荐结果。你可以先告诉我你想要的品类（例如：洁面/精华/面霜/防晒），我再继续。'
              : "I couldn't get a structured product recommendation from upstream yet. Tell me what category you want (cleanser / serum / moisturizer / sunscreen), and I’ll continue."));
        const assistantText = addEmotionalPreambleToAssistantText(assistantTextRaw, {
          language: ctx.lang,
          profile,
          seed: ctx.request_id,
        });

        const envelope = buildEnvelope(ctx, {
          assistant_message: makeChatAssistantMessage(assistantText),
          suggested_chips: refinementChips,
          cards: [
            {
              card_id: `reco_${ctx.request_id}`,
              type: 'recommendations',
              payload,
              ...(norm.field_missing?.length ? { field_missing: norm.field_missing.slice(0, 8) } : {}),
            },
            ...(debugUpstream && upstreamDebug
              ? [
                {
                  card_id: `aurora_debug_${ctx.request_id}`,
                  type: 'aurora_debug',
                  payload: upstreamDebug,
                },
                ...(alternativesDebug
                  ? [
                    {
                      card_id: `aurora_alt_debug_${ctx.request_id}`,
                      type: 'aurora_alt_debug',
                      payload: { items: alternativesDebug },
                    },
                  ]
                  : []),
              ]
              : []),
          ],
          session_patch: nextState ? { next_state: nextState } : {},
          events: [
            makeEvent(ctx, 'value_moment', { kind: 'product_reco' }),
            makeEvent(ctx, 'recos_requested', { explicit: true }),
          ],
        });
        return res.json(envelope);
      }

      // If user just patched profile via chip/action, continue the diagnosis flow without calling upstream.
      // Clarification chips usually carry reply_text (for UX), so we must not require empty message here.
      const hasExplicitUserIntentMessage =
        looksLikeSuitabilityRequest(message) ||
        looksLikeCompatibilityOrConflictQuestion(message) ||
        looksLikeWeatherOrEnvironmentQuestion(message) ||
        looksLikeRecommendationRequest(message);

	      if (appliedProfilePatch && (!message || profileClarificationAction) && !hasExplicitUserIntentMessage) {
	        const inDiagnosisFlow =
	          String(agentState || '').startsWith('DIAG_') ||
	          String(ctx.state || '').startsWith('S2_') ||
	          String(ctx.state || '').startsWith('S3_') ||
	          profileClarificationAction;

	        const { score, missing } = profileCompleteness(profile);

	        const requiredCore = ['skinType', 'sensitivity', 'barrierStatus', 'goals'];
	        const missingCore = requiredCore.filter((k) => (Array.isArray(missing) ? missing.includes(k) : false));
	        const profileSummaryForPatch = summarizeProfileForContext(profile);
	        if (profileSummaryForPatch) {
	          recordSessionPatchProfileEmitted({ changed: true });
	        }

	        if (inDiagnosisFlow && missingCore.length) {
	          const prompt = buildDiagnosisPrompt(ctx.lang, missingCore);
	          const chips = buildDiagnosisChips(ctx.lang, missingCore);
	          const nextState = stateChangeAllowed(ctx.trigger_source) ? 'S2_DIAGNOSIS' : undefined;

	          const envelope = buildEnvelope(ctx, {
	            assistant_message: makeChatAssistantMessage(prompt),
	            suggested_chips: chips,
	            cards: [
              {
                card_id: `diag_${ctx.request_id}`,
                type: 'diagnosis_gate',
                payload: {
                  reason: 'diagnosis_progress',
                  missing_fields: missingCore,
                  wants: 'diagnosis',
                  profile: summarizeProfileForContext(profile),
                  recent_logs: recentLogs,
                },
              },
            ],
            session_patch: nextState
              ? { next_state: nextState, profile: profileSummaryForPatch }
              : { profile: profileSummaryForPatch },
            events: [
              makeEvent(ctx, 'profile_saved', { fields: Object.keys(appliedProfilePatch) }),
              makeEvent(ctx, 'state_entered', { next_state: nextState || null, reason: 'diagnosis_progress' }),
            ],
          });
          return res.json(envelope);
        }

        const lang = ctx.lang === 'CN' ? 'CN' : 'EN';
        const suggestedChips = [
          {
            chip_id: 'chip.action.reco_routine',
            label: lang === 'CN' ? '生成早晚护肤 routine' : 'Build an AM/PM routine',
            kind: 'quick_reply',
            data: { reply_text: lang === 'CN' ? '生成一套早晚护肤 routine' : 'Build an AM/PM skincare routine' },
          },
          {
            chip_id: 'chip.action.analyze_product',
            label: lang === 'CN' ? '评估某个产品适合吗' : 'Evaluate a specific product',
            kind: 'quick_reply',
            data: { reply_text: lang === 'CN' ? '评估这款产品是否适合我' : 'Evaluate a specific product for me' },
          },
          {
            chip_id: 'chip.action.dupe_compare',
            label: lang === 'CN' ? '找平替/对比替代品' : 'Find dupes / alternatives',
            kind: 'quick_reply',
            data: { reply_text: lang === 'CN' ? '帮我找平替并比较 tradeoffs' : 'Find dupes and compare tradeoffs' },
          },
        ];

        const envelope = buildEnvelope(ctx, {
          assistant_message: makeChatAssistantMessage(
            lang === 'CN'
              ? '已更新你的偏好信息。接下来你想做什么？'
              : 'Got it. What would you like to do next?',
          ),
          suggested_chips: suggestedChips,
          cards: [
            {
              card_id: `profile_${ctx.request_id}`,
              type: 'profile',
              payload: { profile: summarizeProfileForContext(profile) },
            },
          ],
          session_patch: { profile: profileSummaryForPatch },
          events: [makeEvent(ctx, 'profile_saved', { fields: Object.keys(appliedProfilePatch) })],
        });
        return res.json(envelope);
      }

      let upstream = null;
      const profileSummary = summarizeProfileForContext(profile);
      const historyForPrefix = Array.isArray(clarificationHistoryForUpstream) ? clarificationHistoryForUpstream : [];
      if (historyForPrefix.length) {
        recordClarificationHistorySent({ count: historyForPrefix.length });
      }
      const prefix = buildContextPrefix({
        profile: profileSummary,
        recentLogs,
        lang: ctx.lang,
        state: ctx.state,
        agent_state: agentState,
        trigger_source: ctx.trigger_source,
        action_id: parsed.data.action && typeof parsed.data.action === 'object' ? parsed.data.action.action_id : null,
        clarification_id: clarificationId,
        ...(historyForPrefix.length ? { clarification_history: historyForPrefix } : {}),
      });
      const query = `${prefix}${upstreamMessage || '(no message)'}`;
      const isResumeUpstreamCall = Boolean(
        AURORA_CHAT_CLARIFICATION_FLOW_V2_ENABLED &&
          forceUpstreamAfterPendingAbandon &&
          resumeContextForUpstream &&
          typeof resumeContextForUpstream === 'object',
      );
      const resumePrefixEnabledForCall = Boolean(
        isResumeUpstreamCall &&
          (AURORA_CHAT_RESUME_PREFIX_V2_ENABLED || AURORA_CHAT_RESUME_PREFIX_V1_ENABLED),
      );
      const resumeContextForCall = isResumeUpstreamCall
        ? {
            ...resumeContextForUpstream,
            enabled: resumePrefixEnabledForCall,
            template_version: AURORA_CHAT_RESUME_PREFIX_V2_ENABLED ? 'v2' : 'v1',
          }
        : null;
      if (isResumeUpstreamCall) {
        const resumePrefixHistoryCount =
          resumePrefixEnabledForCall &&
          resumeContextForCall &&
          resumeContextForCall.include_history !== false &&
          Array.isArray(resumeContextForCall.clarification_history)
            ? Math.min(6, resumeContextForCall.clarification_history.length)
            : 0;
        recordResumePrefixInjected({ enabled: resumePrefixEnabledForCall });
        recordResumePrefixHistoryItems({ count: resumePrefixHistoryCount });
      }
      const upstreamStartedAt = Date.now();
      try {
        upstream = await auroraChat({
          baseUrl: AURORA_DECISION_BASE_URL,
          query,
          timeoutMs: 12000,
          debug: debugUpstream,
          allow_recommendations: allowRecoCards,
          ...(anchorProductId ? { anchor_product_id: anchorProductId } : {}),
          ...(anchorProductUrl ? { anchor_product_url: anchorProductUrl } : {}),
          ...(upstreamMessages && upstreamMessages.length ? { messages: upstreamMessages } : {}),
          ...(isResumeUpstreamCall && resumeContextForCall ? { resume_context: resumeContextForCall } : {}),
        });
        recordUpstreamCall({ path: 'aurora_chat', status: 'ok' });
      } catch (err) {
        recordUpstreamCall({ path: 'aurora_chat', status: 'error' });
        if (err.code !== 'AURORA_NOT_CONFIGURED') {
          logger?.warn({ err: err.message }, 'aurora bff: aurora upstream failed');
        }
      } finally {
        observeUpstreamLatency({ path: 'aurora_chat', latencyMs: Date.now() - upstreamStartedAt });
      }

      const answer = upstream && typeof upstream.answer === 'string'
        ? upstream.answer
        : ctx.lang === 'CN'
          ? '（我已收到。Aurora 上游暂不可用或未配置，当前仅能提供门控与记忆能力。）'
          : '(Received. Aurora upstream is unavailable or not configured; returning a gated/memory-aware fallback response.)';

      if (isResumeUpstreamCall && AURORA_CHAT_RESUME_PROBE_METRICS_ENABLED) {
        const resumeMode = classifyResumeResponseMode(answer);
        recordResumeResponseMode({ mode: resumeMode });
        const knownProfileFieldsForProbe = buildResumeKnownProfileFields(profileSummary);
        const reaskFields = detectResumePlaintextReaskFields(answer, knownProfileFieldsForProbe);
        for (const field of reaskFields) {
          recordResumePlaintextReaskDetected({ field });
        }
      }

      const rawCards = upstream && Array.isArray(upstream.cards) ? upstream.cards : [];
      const allowRecs = allowRecoCards;
      let cards = allowRecs ? rawCards : stripRecommendationCards(rawCards);
      const fieldMissing = [];
      if (!allowRecs && rawCards.length !== cards.length) {
        fieldMissing.push({ field: 'cards', reason: 'recommendations_not_requested' });
      }

      if (allowRecs && includeAlternatives && Array.isArray(cards) && cards.length) {
        const recoIdx = cards.findIndex((c) => {
          if (!c || typeof c !== 'object') return false;
          const t = typeof c.type === 'string' ? c.type.trim().toLowerCase() : '';
          if (t !== 'recommendations') return false;
          const payload = c.payload && typeof c.payload === 'object' ? c.payload : null;
          return payload && Array.isArray(payload.recommendations);
        });

        if (recoIdx !== -1) {
          const card = cards[recoIdx];
          const basePayload = card.payload && typeof card.payload === 'object' ? card.payload : {};
          const alt = await enrichRecommendationsWithAlternatives({
            ctx,
            profileSummary,
            recentLogs,
            recommendations: basePayload.recommendations,
            logger,
          });
          const nextCard = {
            ...card,
            payload: { ...basePayload, recommendations: alt.recommendations },
            field_missing: mergeFieldMissing(card.field_missing, alt.field_missing),
          };
          cards = cards.map((c, i) => (i === recoIdx ? nextCard : c));
        }
      }

      const clarification = upstream && upstream.clarification && typeof upstream.clarification === 'object'
        ? upstream.clarification
        : null;
      recordClarificationPresent({ present: Boolean(clarification) });

      const clarificationQuestions = filterClarificationQuestionsForChips({
        clarification,
        profileSummary,
        filterKnown: AURORA_CHAT_CLARIFICATION_FILTER_KNOWN_ENABLED,
      });

      let pendingClarificationFromUpstream = null;
      const suggestedChips = [];
      if (clarificationQuestions[0]) {
        const q0 = clarificationQuestions[0];
        const qid = String(q0.id || 'clarify').trim() || 'clarify';
        const repeatedField = (() => {
          const field = normalizeClarificationField(qid);
          return hasKnownClarificationFieldValue(profileSummary, field) ? field : null;
        })();
        if (repeatedField) recordRepeatedClarifyField({ field: repeatedField });

        if (AURORA_CHAT_CLARIFICATION_FLOW_V2_ENABLED && clarificationQuestions.length > 1) {
          const resumeUserText = String(upstreamMessage || message || '(no message)').trim() || '(no message)';
          const seededPending = sanitizePendingClarification(
            {
              v: PENDING_CLARIFICATION_SCHEMA_V1,
              flow_id: makeFlowId(),
              created_at_ms: Date.now(),
              resume_user_text: resumeUserText,
              step_index: 0,
              current: { id: qid },
              queue: clarificationQuestions.slice(1).map((q) => ({
                id: String(q.id || 'clarify'),
                question: String(q.question || ''),
                options: Array.isArray(q.options) ? q.options : [],
              })),
              history: [],
            },
            { recordMetrics: true },
          );
          if (seededPending && seededPending.pending && seededPending.pending.queue.length > 0) {
            pendingClarificationFromUpstream = seededPending.pending;
            recordClarificationFlowV2Started();
          }
        }
        suggestedChips.push(...buildChipsForQuestion(q0, { stepIndex: 1 }));
      }

      const contextRaw = upstream && upstream.context && typeof upstream.context === 'object' ? upstream.context : null;
      const derivedCards = [];
      let heatmapImpressionEvent = null;
      const responseIntentMessage = upstreamMessage || message;
      const envStressActionRequested = typeof actionId === 'string' && /env[_-]?stress|environment[_-]?stress|weather|itinerary/i.test(actionId);
      const looksEnv = looksLikeWeatherOrEnvironmentQuestion(responseIntentMessage);
      const wantsEnvStressCard = Boolean(debugUpstream) || envStressActionRequested || looksEnv;

      const isEnvStressCard = (card) => {
        if (!card || typeof card !== 'object') return false;
        const t = typeof card.type === 'string' ? card.type.trim().toLowerCase() : '';
        if (/^(env_stress|environment_stress|envstress|environmentstress)$/.test(t)) return true;
        if (t.includes('env') && t.includes('stress')) return true;
        const payload = card.payload && typeof card.payload === 'object' ? card.payload : null;
        const schema = payload && typeof payload.schema_version === 'string' ? payload.schema_version.trim() : '';
        if (schema === 'aurora.ui.env_stress.v1' || schema === 'aurora.env_stress.v1') return true;
        return false;
      };

      if (!wantsEnvStressCard && Array.isArray(cards) && cards.length) {
        const before = cards.length;
        cards = cards.filter((c) => !isEnvStressCard(c));
        if (before !== cards.length) fieldMissing.push({ field: 'cards.env_stress', reason: 'not_requested' });
      }

      let envStressUi = null;
      if (contextRaw) {
        const envStressRaw = isPlainObject(contextRaw.env_stress) ? contextRaw.env_stress : isPlainObject(contextRaw.envStress) ? contextRaw.envStress : null;
        envStressUi = buildEnvStressUiModelFromUpstream(envStressRaw, { language: ctx.lang });
      }
      if (!envStressUi && (envStressActionRequested || looksEnv)) {
        envStressUi = buildEnvStressUiModelFromLocal({ profile, recentLogs, message: responseIntentMessage, language: ctx.lang });
      }
      if (envStressUi && wantsEnvStressCard) {
        derivedCards.push({
          card_id: `env_${ctx.request_id}`,
          type: 'env_stress',
          payload: envStressUi,
        });
      }

      if (contextRaw) {
        const conflictDetector = isPlainObject(contextRaw.conflict_detector)
          ? contextRaw.conflict_detector
          : isPlainObject(contextRaw.conflictDetector)
            ? contextRaw.conflictDetector
            : null;
        const wantsConflictCards =
          Boolean(debugUpstream) ||
          looksLikeCompatibilityOrConflictQuestion(responseIntentMessage) ||
          (typeof actionId === 'string' && /(routine|compat|conflict|heatmap)/i.test(actionId)) ||
          (conflictDetector && conflictDetector.safe === false) ||
          (Array.isArray(conflictDetector && conflictDetector.conflicts) && conflictDetector.conflicts.length > 0);

        if (wantsConflictCards && conflictDetector && typeof conflictDetector.safe === 'boolean') {
          derivedCards.push({
            card_id: `conflicts_${ctx.request_id}`,
            type: 'routine_simulation',
            payload: conflictDetector,
          });
          const heatmapSteps = extractHeatmapStepsFromConflictDetector({ conflictDetector, contextRaw });
          const heatmapPayload = CONFLICT_HEATMAP_V1_ENABLED
            ? buildConflictHeatmapV1({ routineSimulation: conflictDetector, routineSteps: heatmapSteps })
            : { schema_version: 'aurora.ui.conflict_heatmap.v1' };
          derivedCards.push({
            card_id: `heatmap_${ctx.request_id}`,
            type: 'conflict_heatmap',
            payload: heatmapPayload,
          });
          if (CONFLICT_HEATMAP_V1_ENABLED) {
            heatmapImpressionEvent = makeEvent(ctx, 'aurora_conflict_heatmap_impression', {
              schema_version: heatmapPayload.schema_version,
              state: heatmapPayload.state,
              num_steps: Array.isArray(heatmapPayload.axes?.rows?.items) ? heatmapPayload.axes.rows.items.length : 0,
              num_cells_nonzero: Array.isArray(heatmapPayload.cells?.items) ? heatmapPayload.cells.items.length : 0,
              num_unmapped_conflicts: Array.isArray(heatmapPayload.unmapped_conflicts) ? heatmapPayload.unmapped_conflicts.length : 0,
              max_severity: Math.max(
                0,
                ...((Array.isArray(heatmapPayload.cells?.items) ? heatmapPayload.cells.items : []).map((c) => Number(c?.severity) || 0)),
                ...((Array.isArray(heatmapPayload.unmapped_conflicts) ? heatmapPayload.unmapped_conflicts : []).map((c) => Number(c?.severity) || 0)),
              ),
              routine_simulation_safe: Boolean(conflictDetector.safe),
              routine_conflict_count: Array.isArray(conflictDetector.conflicts) ? conflictDetector.conflicts.length : 0,
              trigger_source: ctx.trigger_source,
            });
          }
        }
      }

      // Product suitability derived card: if upstream provides an anchor product context (common for "评估/适合吗" flows),
      // emit a renderable `product_analysis` card (UI expects this, not the raw context blob).
      const anchorFromContext = (() => {
        if (!contextRaw) return null;
        if (isPlainObject(contextRaw.anchor)) return contextRaw.anchor;
        if (isPlainObject(contextRaw.anchor_product)) return contextRaw.anchor_product;
        if (isPlainObject(contextRaw.anchorProduct)) return contextRaw.anchorProduct;
        return null;
      })();

      const mapAnchorContextToProductAnalysis = (anchor, { lang, profileSummary: profileSummaryOpt } = {}) => {
        const a = isPlainObject(anchor) ? anchor : {};
        const outLang = String(lang || '').toUpperCase() === 'CN' ? 'CN' : 'EN';
        const p = isPlainObject(profileSummaryOpt) ? profileSummaryOpt : null;

        const uniqStrings = (items, max = null) => {
          const out = [];
          const seen = new Set();
          for (const raw of Array.isArray(items) ? items : []) {
            const s = typeof raw === 'string' ? raw.trim() : raw == null ? '' : String(raw).trim();
            if (!s) continue;
            const key = s.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(s);
            if (typeof max === 'number' && max > 0 && out.length >= max) break;
          }
          return out;
        };

        const brand = typeof a.brand === 'string' ? a.brand.trim() : '';
        const name = typeof a.name === 'string' ? a.name.trim() : '';
        const productId = typeof a.id === 'string' ? a.id.trim() : typeof a.product_id === 'string' ? a.product_id.trim() : '';
        const displayName = [brand, name].filter(Boolean).join(' ').trim() || (typeof a.display_name === 'string' ? a.display_name.trim() : '');

        const score = isPlainObject(a.score) ? a.score : {};
        const scoreTotal = coerceNumber(score.total);
        const scoreScience = coerceNumber(score.science);
        const scoreSocial = coerceNumber(score.social);
        const scoreEng = coerceNumber(score.engineering);

        const social = isPlainObject(a.social) ? a.social : {};
        const redScore = coerceNumber(social.red_score ?? social.redScore);
        const redditScore = coerceNumber(social.reddit_score ?? social.redditScore);
        const burnRate = coerceNumber(social.burn_rate ?? social.burnRate);
        const topKeywords = Array.isArray(social.top_keywords) ? social.top_keywords : Array.isArray(social.topKeywords) ? social.topKeywords : [];

        const kb = isPlainObject(a.kb_profile) ? a.kb_profile : isPlainObject(a.kbProfile) ? a.kbProfile : {};
        const keyActives = Array.isArray(kb.keyActives) ? kb.keyActives : [];
        const comparisonNotes = Array.isArray(kb.comparisonNotes) ? kb.comparisonNotes : [];
        const sensitivityFlags = Array.isArray(kb.sensitivityFlags) ? kb.sensitivityFlags : [];
        const pairingRules = Array.isArray(kb.pairingRules) ? kb.pairingRules : [];
        const textureFinish = Array.isArray(kb.textureFinish) ? kb.textureFinish : [];

        const expert = isPlainObject(a.expert_knowledge) ? a.expert_knowledge : isPlainObject(a.expertKnowledge) ? a.expertKnowledge : {};
        const chemistNotes = typeof expert.chemist_notes === 'string' ? expert.chemist_notes : typeof expert.chemistNotes === 'string' ? expert.chemistNotes : '';
        const sensitivityNotes =
          typeof expert.sensitivity_notes === 'string'
            ? expert.sensitivity_notes
            : typeof expert.sensitivityNotes === 'string'
              ? expert.sensitivityNotes
              : '';

        const riskFlags = uniqStrings([
          ...(Array.isArray(a.risk_flags_canonical) ? a.risk_flags_canonical : []),
          ...(Array.isArray(a.risk_flags) ? a.risk_flags : []),
          ...(Array.isArray(sensitivityFlags) ? sensitivityFlags : []),
        ].map((x) => String(x || '').trim()).filter(Boolean));

        const vetoed = Boolean(a.vetoed);
        const verdict = (() => {
          if (vetoed) return outLang === 'CN' ? '不建议' : 'Avoid';
          if (riskFlags.some((f) => /high_irritation/i.test(f))) return outLang === 'CN' ? '谨慎' : 'Caution';
          if (scoreTotal != null && scoreTotal < 55) return outLang === 'CN' ? '谨慎' : 'Caution';
          return outLang === 'CN' ? '适合' : 'Suitable';
        })();

        const take = (arr, n) => (Array.isArray(arr) ? arr.filter(Boolean).slice(0, n) : []);
        const truncate = (s, max = 200) => {
          const t = typeof s === 'string' ? s.trim() : s == null ? '' : String(s).trim();
          if (!t) return '';
          return t.length > max ? `${t.slice(0, max - 1)}…` : t;
        };

        const normalizeProfileEnum = (v) => {
          const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
          return s || null;
        };
        const profileSkinType = normalizeProfileEnum(p?.skinType);
        const profileSensitivity = normalizeProfileEnum(p?.sensitivity);
        const profileBarrier = normalizeProfileEnum(p?.barrierStatus);
        const profileGoals = Array.isArray(p?.goals) ? p.goals.map((g) => normalizeProfileEnum(g)).filter(Boolean) : [];

        const profileTags = (() => {
          if (!p) return [];
          const tags = [];

          const skinTypeLabel = (() => {
            if (!profileSkinType) return null;
            if (outLang === 'CN') {
              if (profileSkinType === 'oily') return '油皮';
              if (profileSkinType === 'dry') return '干皮';
              if (profileSkinType === 'combo' || profileSkinType === 'combination') return '混合皮';
              if (profileSkinType === 'normal') return '中性皮';
              if (profileSkinType === 'sensitive') return '敏感肌';
              return `肤质：${profileSkinType}`;
            }
            if (profileSkinType === 'combo' || profileSkinType === 'combination') return 'combination';
            return profileSkinType;
          })();

          const sensitivityLabel = (() => {
            if (!profileSensitivity) return null;
            if (outLang === 'CN') {
              if (profileSensitivity === 'low') return '低敏';
              if (profileSensitivity === 'medium') return '中敏';
              if (profileSensitivity === 'high') return '高敏';
              return `敏感：${profileSensitivity}`;
            }
            if (profileSensitivity === 'low') return 'low sensitivity';
            if (profileSensitivity === 'medium') return 'medium sensitivity';
            if (profileSensitivity === 'high') return 'high sensitivity';
            return `sensitivity=${profileSensitivity}`;
          })();

          const barrierLabel = (() => {
            if (!profileBarrier) return null;
            if (outLang === 'CN') {
              if (profileBarrier === 'healthy') return '屏障健康';
              if (profileBarrier === 'impaired') return '屏障受损';
              return `屏障：${profileBarrier}`;
            }
            if (profileBarrier === 'healthy') return 'healthy barrier';
            if (profileBarrier === 'impaired') return 'impaired barrier';
            return `barrier=${profileBarrier}`;
          })();

          if (skinTypeLabel) tags.push(skinTypeLabel);
          if (sensitivityLabel) tags.push(sensitivityLabel);
          if (barrierLabel) tags.push(barrierLabel);
          return tags;
        })();

        const lowerKeyActives = uniqStrings(take(keyActives, 12).map((x) => String(x || '').trim()).filter(Boolean))
          .join(' | ')
          .toLowerCase();
        const hasNiacinamide = /\bniacinamide\b|烟酰胺/.test(lowerKeyActives);
        const hasZincPca = /\bzinc\b.*\bpca\b|锌\s*pca/.test(lowerKeyActives);
        const isAcidLike =
          riskFlags.some((f) => /\bacid\b/i.test(f)) ||
          /\baha\b|\bbha\b|\bpha\b|\bglycolic\b|\blactic\b|\bsalicylic\b|果酸|水杨酸|杏仁酸|乳酸|葡糖酸内酯/.test(lowerKeyActives);

        const isHighIrritation =
          riskFlags.some((f) => /high_irritation/i.test(f)) ||
          /\bhigh irritation\b|刺激性偏高|can sting|may sting/.test(String(sensitivityNotes || '').toLowerCase());

        const profileSuggestsCaution =
          profileBarrier === 'impaired' ||
          profileSensitivity === 'high' ||
          (profileSensitivity === 'medium' && (isAcidLike || isHighIrritation));

        const reasons = uniqStrings([
          ...take(comparisonNotes, 1).map((s) => truncate(s, 200)),
          ...(profileTags.length
            ? [
              outLang === 'CN'
                ? `基于你的皮肤特性：${truncate(profileTags.join(' / '), 80)}。`
                : `Based on your profile: ${truncate(profileTags.join(' / '), 80)}.`,
            ]
            : []),
          ...(profileSkinType === 'oily' && (hasNiacinamide || hasZincPca)
            ? [
              outLang === 'CN'
                ? '更偏油皮友好：烟酰胺/锌类通常用于控油、痘印与毛孔观感。'
                : 'Oily-skin friendly: niacinamide/zinc are commonly used for oil control and the look of pores/marks.',
            ]
            : []),
          ...(profileGoals.includes('brightening') && hasNiacinamide
            ? [
              outLang === 'CN' ? '你的目标包含提亮：烟酰胺在“肤色不均/痘印”方向常见。' : 'Your goal includes brightening: niacinamide is commonly used for uneven tone/marks.',
            ]
            : []),
          ...(profileGoals.includes('acne') && (hasNiacinamide || hasZincPca)
            ? [
              outLang === 'CN' ? '你的目标包含痘痘：这类成分更常见于“控油/痘痘倾向”方向。' : 'Your goal includes acne-prone concerns: these actives are often used for oil/acne-prone routines.',
            ]
            : []),
          ...take(keyActives, 3).map((s) => (outLang === 'CN' ? `关键活性：${truncate(s, 180)}` : `Key active: ${truncate(s, 180)}`)),
          ...(profileSuggestsCaution
            ? [
              outLang === 'CN'
                ? '使用建议：先从低频（每周 2–3 次或更少）开始；若刺痛/泛红，先停用并以修护保湿为主。'
                : 'How to use: start low (2–3×/week or less); if stinging/redness happens, pause and focus on barrier support.',
            ]
            : []),
          ...(isHighIrritation
            ? [
              outLang === 'CN'
                ? '风险提示：刺激性偏高（部分人会刺痛/搓泥），建议少量、等待吸收、减少叠加。'
                : 'Risk: higher irritation/pilling potential; use a small amount, let it absorb, and avoid heavy layering.',
            ]
            : []),
          ...(isAcidLike
            ? [
              outLang === 'CN'
                ? '叠加提醒：同一晚尽量不要叠加强酸/维A类（更容易刺痛/爆皮）。'
                : 'Layering note: avoid stacking strong acids/retinoids in the same night to reduce irritation.',
            ]
            : []),
        ]).filter(Boolean).slice(0, 5);

        const assessment = {
          verdict,
          reasons,
          ...(productId || brand || name || displayName
            ? {
              anchor_product: {
                ...(productId ? { product_id: productId, sku_id: productId } : {}),
                ...(brand ? { brand } : {}),
                ...(name ? { name } : {}),
                ...(displayName ? { display_name: displayName } : {}),
                availability: Array.isArray(a.availability) ? a.availability : [],
              },
            }
            : {}),
        };

        const platformScores = {};
        if (redScore != null) platformScores.RED = redScore;
        if (redditScore != null) platformScores.Reddit = redditScore;
        if (burnRate != null) platformScores.burn_rate = burnRate;

        const evidence = {
          science: {
            key_ingredients: uniqStrings(take(keyActives, 8).map((s) => truncate(s, 120)), 8),
            mechanisms: [],
            fit_notes: uniqStrings([...take(textureFinish, 2), ...take(pairingRules, 1)].map((s) => truncate(s, 200)), 3),
            risk_notes: uniqStrings(
              [
                ...riskFlags.map((s) => truncate(s, 120)),
                ...(sensitivityNotes ? [truncate(sensitivityNotes, 200)] : []),
              ].filter(Boolean),
              4,
            ),
          },
          social_signals: {
            ...(Object.keys(platformScores).length ? { platform_scores: platformScores } : {}),
            typical_positive: uniqStrings(take(topKeywords, 6).map((s) => truncate(s, 60)), 6),
            typical_negative: [],
            risk_for_groups: [],
          },
          expert_notes: uniqStrings([chemistNotes, sensitivityNotes].map((s) => truncate(s, 200)).filter(Boolean), 2),
          confidence: scoreScience != null ? Math.max(0, Math.min(1, scoreScience / 100)) : null,
          missing_info: [],
        };

        const confidence = scoreTotal != null ? Math.max(0, Math.min(1, scoreTotal / 100)) : null;
        const missing_info = [];

        // Preserve score breakdown as lightweight expert note (no internal kb ids).
        const scoreLineParts = [
          scoreTotal != null ? `Total ${Math.round(scoreTotal)}/100` : null,
          scoreScience != null ? `Science ${Math.round(scoreScience)}` : null,
          scoreSocial != null ? `Social ${Math.round(scoreSocial)}` : null,
          scoreEng != null ? `Eng ${Math.round(scoreEng)}` : null,
        ].filter(Boolean);
        if (scoreLineParts.length) {
          evidence.expert_notes = uniqStrings([
            ...(Array.isArray(evidence.expert_notes) ? evidence.expert_notes : []),
            truncate(scoreLineParts.join(', '), 200),
          ], 3);
        }

        return { assessment, evidence, confidence, missing_info };
      };

      if (
        looksLikeSuitabilityRequest(responseIntentMessage) &&
        anchorFromContext &&
        !derivedCards.some((c) => String(c?.type || '').toLowerCase() === 'product_analysis') &&
        !cards.some((c) => String(c?.type || '').toLowerCase() === 'product_analysis')
      ) {
        const mapped = mapAnchorContextToProductAnalysis(anchorFromContext, { lang: ctx.lang, profileSummary });
        const norm = normalizeProductAnalysis(mapped);
        const payload = enrichProductAnalysisPayload(norm.payload, { lang: ctx.lang });
        derivedCards.push({
          card_id: `analyze_${ctx.request_id}`,
          type: 'product_analysis',
          payload: debugUpstream ? payload : stripInternalRefsDeep(payload),
          ...(norm.field_missing?.length ? { field_missing: norm.field_missing.slice(0, 8) } : {}),
        });
      }

      // Fit-check fallback: if user asks suitability but upstream did not provide a renderable
      // `product_analysis` card, run a dedicated deep-scan to guarantee actionable output.
      const wantsSuitabilityFallback =
        looksLikeSuitabilityRequest(responseIntentMessage);

      const hasProductAnalysisCard = (arr) =>
        Array.isArray(arr) &&
        arr.some((c) => {
          const t = String(c && c.type ? c.type : '').trim().toLowerCase();
          return t === 'product_analysis';
        });

      if (
        wantsSuitabilityFallback &&
        !hasProductAnalysisCard(cards) &&
        !hasProductAnalysisCard(derivedCards)
      ) {
        const productInput =
          anchorProductUrl ||
          extractProductInputFromFitCheckText(responseIntentMessage) ||
          '';

        if (productInput) {
          const commonMeta = {
            profile: profileSummary,
            recentLogs,
            lang: ctx.lang,
            state: ctx.state || 'idle',
            trigger_source: ctx.trigger_source,
          };
          const productParsePrefix = buildContextPrefix({
            ...commonMeta,
            intent: 'product_parse',
            action_id: 'chat.fit_check.parse',
          });
          const productAnalyzePrefix = buildContextPrefix({
            ...commonMeta,
            intent: 'product_analyze',
            action_id: 'chat.fit_check.deep_scan',
          });

          let parsedProduct = null;
          let anchorId = anchorProductId || '';

          // Best-effort parse to anchor_product_id to improve KB hit rate.
          if (!anchorId) {
            try {
              const parseQuery =
                `${productParsePrefix}Task: Parse the user's product input into a normalized product entity.\n` +
                `Return ONLY a JSON object with keys: product, confidence, missing_info (string[]).\n` +
                `Input: ${productInput}`;
              const parseUpstream = await auroraChat({
                baseUrl: AURORA_DECISION_BASE_URL,
                query: parseQuery,
                timeoutMs: 12000,
                ...(anchorProductUrl ? { anchor_product_url: anchorProductUrl } : {}),
              });
              const parseStructured =
                parseUpstream && parseUpstream.structured && typeof parseUpstream.structured === 'object' && !Array.isArray(parseUpstream.structured)
                  ? parseUpstream.structured
                  : parseUpstream && typeof parseUpstream.answer === 'string'
                    ? extractJsonObjectByKeys(parseUpstream.answer, ['product', 'parse', 'anchor_product', 'anchorProduct'])
                    : null;
              const parseMapped =
                parseStructured && parseStructured.parse && typeof parseStructured.parse === 'object'
                  ? mapAuroraProductParse(parseStructured)
                  : parseStructured;
              const parseNorm = normalizeProductParse(parseMapped);
              parsedProduct = parseNorm.payload.product || null;
              anchorId =
                parsedProduct && (parsedProduct.sku_id || parsedProduct.product_id)
                  ? String(parsedProduct.sku_id || parsedProduct.product_id)
                  : '';
            } catch (err) {
              // ignore; continue without anchor id
            }
          }

          const deepScanQuery =
            `${productAnalyzePrefix}Task: Deep-scan this product for suitability vs the user's profile.\n` +
            `Return ONLY a JSON object with keys: assessment, evidence, confidence (0..1), missing_info (string[]).\n` +
            `Evidence must include science/social_signals/expert_notes.\n` +
            `Product: ${productInput}`;

          const runDeepScan = async ({ queryText, timeoutMs }) => {
            try {
              return await auroraChat({
                baseUrl: AURORA_DECISION_BASE_URL,
                query: queryText,
                timeoutMs,
                ...(anchorId ? { anchor_product_id: String(anchorId) } : {}),
                ...(anchorProductUrl ? { anchor_product_url: anchorProductUrl } : {}),
              });
            } catch {
              return null;
            }
          };

          let deepUpstream = await runDeepScan({ queryText: deepScanQuery, timeoutMs: 16000 });

          const deepStructured =
            deepUpstream && deepUpstream.structured && typeof deepUpstream.structured === 'object' && !Array.isArray(deepUpstream.structured)
              ? deepUpstream.structured
              : null;
          const deepAnswerObj =
            deepUpstream && typeof deepUpstream.answer === 'string'
              ? extractJsonObjectByKeys(deepUpstream.answer, [
                'assessment',
                'evidence',
                'confidence',
                'missing_info',
                'missingInfo',
                'analyze',
                'verdict',
                'reasons',
                'science_evidence',
                'social_signals',
                'expert_notes',
              ])
              : null;
          const deepAnswerLooksLikeAnalysis =
            deepAnswerObj &&
            typeof deepAnswerObj === 'object' &&
            !Array.isArray(deepAnswerObj) &&
            (deepAnswerObj.assessment != null ||
              deepAnswerObj.evidence != null ||
              deepAnswerObj.analyze != null ||
              deepAnswerObj.confidence != null);

          const structuredOrJson =
            deepStructured && deepStructured.analyze && typeof deepStructured.analyze === 'object'
              ? deepStructured
              : deepAnswerLooksLikeAnalysis
                ? deepAnswerObj
                : deepStructured || deepAnswerObj;
          const mapped =
            structuredOrJson && structuredOrJson.analyze && typeof structuredOrJson.analyze === 'object'
              ? mapAuroraProductAnalysis(structuredOrJson)
              : structuredOrJson;
          let norm = normalizeProductAnalysis(mapped);

          // Retry once with minimal prefix if personalized context is dropped upstream.
          if (!norm.payload.assessment && productInput) {
            const minimalPrefix = buildContextPrefix({
              lang: ctx.lang,
              state: ctx.state || 'idle',
              trigger_source: ctx.trigger_source,
              intent: 'product_analyze_fallback',
              action_id: 'chat.fit_check.deep_scan_fallback',
            });
            const minimalQuery =
              `${minimalPrefix}Task: Deep-scan this product for suitability vs the user's profile.\n` +
              `Return ONLY a JSON object with keys: assessment, evidence, confidence (0..1), missing_info (string[]).\n` +
              `Evidence must include science/social_signals/expert_notes.\n` +
              `Product: ${productInput}`;
            const deepUpstream2 = await runDeepScan({ queryText: minimalQuery, timeoutMs: 14000 });
            const deepStructured2 =
              deepUpstream2 && deepUpstream2.structured && typeof deepUpstream2.structured === 'object' && !Array.isArray(deepUpstream2.structured)
                ? deepUpstream2.structured
                : null;
            const deepAnswer2 =
              deepUpstream2 && typeof deepUpstream2.answer === 'string'
                ? extractJsonObjectByKeys(deepUpstream2.answer, [
                  'assessment',
                  'evidence',
                  'confidence',
                  'missing_info',
                  'missingInfo',
                  'analyze',
                  'verdict',
                  'reasons',
                  'science_evidence',
                  'social_signals',
                  'expert_notes',
                ])
                : null;
            const structuredOrJson2 =
              deepStructured2 && deepStructured2.analyze && typeof deepStructured2.analyze === 'object'
                ? deepStructured2
                : deepAnswer2 && typeof deepAnswer2 === 'object' && !Array.isArray(deepAnswer2)
                  ? deepAnswer2
                  : deepStructured2 || deepAnswer2;
            const mapped2 =
              structuredOrJson2 && structuredOrJson2.analyze && typeof structuredOrJson2.analyze === 'object'
                ? mapAuroraProductAnalysis(structuredOrJson2)
                : structuredOrJson2;
            const norm2 = normalizeProductAnalysis(mapped2);
            if (norm2 && norm2.payload && norm2.payload.assessment) {
              const missingInfo = Array.isArray(norm2.payload.missing_info) ? norm2.payload.missing_info : [];
              norm = {
                payload: {
                  ...norm2.payload,
                  missing_info: Array.from(new Set([...missingInfo, 'profile_context_dropped_for_reliability'])),
                },
                field_missing: norm2.field_missing,
              };
            }
          }

          let payload = enrichProductAnalysisPayload(norm.payload, { lang: ctx.lang, profileSummary });
          if (parsedProduct && payload && typeof payload === 'object') {
            const a = payload.assessment && typeof payload.assessment === 'object' ? payload.assessment : null;
            if (a && !a.anchor_product && !a.anchorProduct) {
              payload = { ...payload, assessment: { ...a, anchor_product: parsedProduct } };
            }
          }

          if (payload) {
            derivedCards.push({
              card_id: `analyze_${ctx.request_id}`,
              type: 'product_analysis',
              payload: debugUpstream ? payload : stripInternalRefsDeep(payload),
              ...(norm.field_missing?.length ? { field_missing: norm.field_missing.slice(0, 8) } : {}),
            });
          }
        }
      }

      const contextCard = INCLUDE_RAW_AURORA_CONTEXT && contextRaw
        ? [{
          card_id: `aurora_ctx_${ctx.request_id}`,
          type: 'aurora_context_raw',
          payload: {
            intent: upstream && typeof upstream.intent === 'string' ? upstream.intent : null,
            clarification,
            context: contextRaw,
          },
        }]
        : [];

      const structured = getUpstreamStructuredOrJson(upstream);
      const structuredBlocked = Boolean(structured) && !allowRecs && structuredContainsCommerceLikeFields(structured);
      if (structuredBlocked) {
        fieldMissing.push({ field: 'aurora_structured', reason: 'recommendations_not_requested' });
      }
      const structuredWithExternalVerification = mergeExternalVerificationIntoStructured(structured, contextRaw);
      const structuredForEnvelope =
        structuredWithExternalVerification && !debugUpstream
          ? stripInternalRefsDeep(structuredWithExternalVerification)
          : structuredWithExternalVerification;

      const structuredCitations = Array.isArray(structuredForEnvelope?.external_verification?.citations)
        ? structuredForEnvelope.external_verification.citations
        : [];
      // UI treats aurora_structured primarily as a "references" card; if citations are empty it is hidden.
      const structuredIsRenderable = Boolean(structuredForEnvelope && !structuredBlocked && structuredCitations.length > 0);
      const uiDebug = Boolean(debugUpstream);
      const hasRenderableCards =
        structuredIsRenderable ||
        derivedCards.some((c) => isRenderableCardForChatboxUi(c, { debug: uiDebug })) ||
        cards.some((c) => isRenderableCardForChatboxUi(c, { debug: uiDebug }));

      let safeAnswer = sanitizeUpstreamAnswer(answer, {
        language: ctx.lang,
        hasRenderableCards,
        // Always keep assistant_message end-user readable; internal kb:* refs belong in debug payloads only.
        stripInternalRefs: true,
      });

      const routeCards = [...(Array.isArray(derivedCards) ? derivedCards : []), ...(Array.isArray(cards) ? cards : [])];
      const routeHintFromCards = inferRouteFromCards(routeCards);
      const routeHintFromMessage =
        !routeHintFromCards
          ? inferRouteFromMessageIntent(responseIntentMessage, { allowRecoCards: allowRecs })
          : null;
      const routeHint = resolveRouteHint(routeHintFromCards, routeHintFromMessage);
      if (routeHint && routeHint.route) {
        const routeStructured = buildRouteAwareAssistantText({
          route: routeHint.route,
          payload: routeHint.payload,
          language: ctx.lang,
          profile,
        });
        const shouldUpgrade =
          looksLikeGenericStructuredNotice(safeAnswer) ||
          !isRouteStructuredAnswer(safeAnswer, routeHint.route);
        if (shouldUpgrade && routeStructured) safeAnswer = routeStructured;
      }
      safeAnswer = addEmotionalPreambleToAssistantText(safeAnswer, {
        language: ctx.lang,
        profile,
        seed: ctx.request_id,
      });

      const cardsForEnvelope = !debugUpstream ? stripInternalRefsDeep(cards) : cards;
      const shouldEchoProfile =
        Boolean(profileSummary) &&
        (Boolean(appliedProfilePatch) || !profilePatchFromSession);
      const sessionPatch = {};
      if (nextStateOverride && stateChangeAllowed(ctx.trigger_source)) {
        sessionPatch.next_state = nextStateOverride;
      }
      if (shouldEchoProfile) {
        sessionPatch.profile = profileSummary;
        recordSessionPatchProfileEmitted({ changed: Boolean(appliedProfilePatch) });
      }
      if (pendingClarificationPatchOverride !== undefined) {
        emitPendingClarificationPatch(sessionPatch, pendingClarificationPatchOverride);
      } else if (pendingClarificationFromUpstream) {
        emitPendingClarificationPatch(sessionPatch, pendingClarificationFromUpstream);
      }

      const envelope = buildEnvelope(ctx, {
        assistant_message: makeChatAssistantMessage(safeAnswer, 'markdown'),
        suggested_chips: suggestedChips,
        cards: [
          ...(structuredForEnvelope && !structuredBlocked
            ? [{
              card_id: `structured_${ctx.request_id}`,
              type: 'aurora_structured',
              payload: structuredForEnvelope,
            }]
            : []),
          ...derivedCards,
          ...cardsForEnvelope.map((c, idx) => ({
            card_id: c.card_id || `aurora_${ctx.request_id}_${idx}`,
            type: c.type || 'aurora_card',
            title: c.title,
            payload: c.payload || c,
            ...(Array.isArray(c.field_missing) ? { field_missing: c.field_missing } : {}),
          })),
          ...contextCard,
          ...(fieldMissing.length
            ? [{ card_id: `gate_${ctx.request_id}`, type: 'gate_notice', payload: {}, field_missing: fieldMissing }]
            : []),
        ],
        session_patch: sessionPatch,
        events: [
          makeEvent(ctx, 'value_moment', { kind: 'chat_reply' }),
          ...(allowRecs ? [makeEvent(ctx, 'recos_requested', { explicit: true })] : []),
          ...(heatmapImpressionEvent ? [heatmapImpressionEvent] : []),
        ],
      });
      return res.json(envelope);
    } catch (err) {
      const status = err.status || 500;
      logger?.error({ err: err.message, status }, 'aurora bff chat failed');
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to process chat.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: err.code || 'CHAT_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: err.code || 'CHAT_FAILED' })],
      });
      return res.status(status).json(envelope);
    }
  });
}

const __internal = {
  normalizeClarificationField,
  detectBrandAvailabilityIntent,
  buildAvailabilityCatalogQuery,
  isSpecificAvailabilityQuery,
  resolveAvailabilityProductByQuery,
  searchPivotaBackendProducts,
  runOpenAIVisionSkinAnalysis,
  runGeminiVisionSkinAnalysis,
  runVisionSkinAnalysis,
  resolveVisionProviderSelection,
  fetchPhotoBytesFromPivotaBackend,
  classifySignedUrlFetchFailure,
  isSignedUrlExpiredSignal,
  setPhotoBytesCache,
  getPhotoBytesCache,
  buildLowConfidenceBaselineSkinAnalysis,
  buildRuleBasedSkinAnalysis,
  normalizeSkinAnalysisFromLLM,
  mergePhotoFindingsIntoAnalysis,
  buildExecutablePlanForAnalysis,
  maybeBuildPhotoModulesCardForAnalysis,
  buildEmotionalPreamble,
  addEmotionalPreambleToAssistantText,
  stripMismatchedLeadingGreeting,
  looksLikeGreetingAlready,
  enrichRecoItemWithPdpOpenContract,
  enrichRecommendationsWithPdpOpenContract,
  resolveRecoPdpByStableIds,
  maybeInferSkinMaskForPhotoModules,
  __setInferSkinMaskOnFaceCropForTest(fn) {
    inferSkinMaskOnFaceCropImpl = typeof fn === 'function' ? fn : inferSkinMaskOnFaceCrop;
  },
  __resetInferSkinMaskOnFaceCropForTest() {
    inferSkinMaskOnFaceCropImpl = inferSkinMaskOnFaceCrop;
  },
};

module.exports = { mountAuroraBffRoutes, __internal };
