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

function cleanLabel(value, fallback) {
  const raw = String(value == null ? '' : value).trim();
  return raw || fallback;
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

function recordVerifyFail({ reason } = {}) {
  const safeReason = cleanLabel(reason, 'UNKNOWN');
  incCounter(verifierFails, { reason: safeReason }, 1);
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

  lines.push('# HELP verify_fail_total Total number of Gemini shadow verifier failures grouped by reason.');
  lines.push('# TYPE verify_fail_total counter');
  renderCounter(lines, 'verify_fail_total', verifierFails);

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
  for (const key of verifierAgreementHistogram.keys()) verifierAgreementHistogram.set(key, 0);
  verifierAgreementCount = 0;
  verifierAgreementSum = 0;
  verifierHardCaseCount = 0;
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
    verifierAgreementCount,
    verifierAgreementSum,
    verifierHardCaseCount,
  };
}

module.exports = {
  recordVisionDecision,
  observeVisionLatency,
  recordEnsembleProviderResult,
  recordEnsembleAgreementScore,
  recordVerifyCall,
  recordVerifyFail,
  recordVerifyAgreementScore,
  recordVerifyHardCase,
  renderVisionMetricsPrometheus,
  resetVisionMetrics,
  snapshotVisionMetrics,
};
