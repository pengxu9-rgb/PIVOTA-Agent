const {
  VisionUnavailabilityReason,
  normalizeVisionFailureReason,
  isVisionFailureReason,
} = require('./visionPolicy');

const LATENCY_BUCKETS_MS = Object.freeze([100, 250, 500, 1000, 2000, 5000, 10000, 30000, Infinity]);

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
const productRecEmittedCounter = new Map();
const productRecSuppressedCounter = new Map();
const claimsTemplateFallbackCounter = new Map();
const claimsViolationCounter = new Map();
let clarificationIdNormalizedEmptyCount = 0;
const catalogAvailabilityShortCircuitCounter = new Map();
const repeatedClarifyFieldCounter = new Map();
const profileContextMissingCounter = new Map();
const sessionPatchProfileEmittedCounter = new Map();
const upstreamCallsCounter = new Map();
const upstreamLatencyByPath = new Map();
let modulesInteractionCount = 0;
let actionClickCount = 0;
let actionCopyCount = 0;
let retakeAfterModulesCount = 0;
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

  lines.push('# HELP profile_context_missing_total Total number of requests missing profile context from frontend session or backend storage.');
  lines.push('# TYPE profile_context_missing_total counter');
  renderCounter(lines, 'profile_context_missing_total', profileContextMissingCounter);

  lines.push('# HELP session_patch_profile_emitted_total Total number of responses that emitted env.session_patch.profile (changed=true|false).');
  lines.push('# TYPE session_patch_profile_emitted_total counter');
  renderCounter(lines, 'session_patch_profile_emitted_total', sessionPatchProfileEmittedCounter);

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
  productRecEmittedCounter.clear();
  productRecSuppressedCounter.clear();
  claimsTemplateFallbackCounter.clear();
  claimsViolationCounter.clear();
  clarificationIdNormalizedEmptyCount = 0;
  catalogAvailabilityShortCircuitCounter.clear();
  repeatedClarifyFieldCounter.clear();
  profileContextMissingCounter.clear();
  sessionPatchProfileEmittedCounter.clear();
  upstreamCallsCounter.clear();
  upstreamLatencyByPath.clear();
  modulesInteractionCount = 0;
  actionClickCount = 0;
  actionCopyCount = 0;
  retakeAfterModulesCount = 0;
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
    productRecEmitted: Array.from(productRecEmittedCounter.entries()),
    productRecSuppressed: Array.from(productRecSuppressedCounter.entries()),
    claimsTemplateFallbacks: Array.from(claimsTemplateFallbackCounter.entries()),
    claimsViolations: Array.from(claimsViolationCounter.entries()),
    clarificationIdNormalizedEmptyCount,
    catalogAvailabilityShortCircuits: Array.from(catalogAvailabilityShortCircuitCounter.entries()),
    repeatedClarifyFields: Array.from(repeatedClarifyFieldCounter.entries()),
    profileContextMissing: Array.from(profileContextMissingCounter.entries()),
    sessionPatchProfileEmitted: Array.from(sessionPatchProfileEmittedCounter.entries()),
    upstreamCalls: Array.from(upstreamCallsCounter.entries()),
    upstreamLatencyPaths: Array.from(upstreamLatencyByPath.keys()),
    modulesInteractionCount,
    actionClickCount,
    actionCopyCount,
    retakeAfterModulesCount,
  };
}

module.exports = {
  recordClarificationIdNormalizedEmpty,
  recordCatalogAvailabilityShortCircuit,
  recordRepeatedClarifyField,
  recordProfileContextMissing,
  recordSessionPatchProfileEmitted,
  recordUpstreamCall,
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
  recordUiBehaviorEvent,
  recordGeometrySanitizerDropReason,
  renderVisionMetricsPrometheus,
  resetVisionMetrics,
  snapshotVisionMetrics,
};
