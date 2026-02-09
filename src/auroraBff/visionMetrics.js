const {
  normalizeVisionReason,
  isVisionFailureReason,
} = require('./visionPolicy');

const LATENCY_BUCKETS_MS = Object.freeze([100, 250, 500, 1000, 2000, 5000, 10000, 30000, Infinity]);

const callsCounter = new Map();
const failCounter = new Map();
const fallbackCounter = new Map();
const latencyByProvider = new Map();

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
        .map((reason) => normalizeVisionReason(reason))
        .filter((reason) => isVisionFailureReason(reason)),
    ),
  );

  if (safeDecision === 'fallback') {
    for (const reason of normalizedReasons) {
      incCounter(fallbackCounter, { provider: safeProvider, reason }, 1);
    }
  }

  if (normalizedReasons.length) {
    for (const reason of normalizedReasons) {
      incCounter(failCounter, { provider: safeProvider, reason }, 1);
    }
  }
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

  return `${lines.join('\n')}\n`;
}

function resetVisionMetrics() {
  callsCounter.clear();
  failCounter.clear();
  fallbackCounter.clear();
  latencyByProvider.clear();
}

function snapshotVisionMetrics() {
  return {
    calls: Array.from(callsCounter.entries()),
    fails: Array.from(failCounter.entries()),
    fallbacks: Array.from(fallbackCounter.entries()),
    latencyProviders: Array.from(latencyByProvider.keys()),
  };
}

module.exports = {
  recordVisionDecision,
  observeVisionLatency,
  renderVisionMetricsPrometheus,
  resetVisionMetrics,
  snapshotVisionMetrics,
};
