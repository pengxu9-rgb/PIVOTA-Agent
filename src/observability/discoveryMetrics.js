const LATENCY_BUCKETS_MS = [50, 100, 250, 500, 1000, 1500, 2500, 5000, 10000, Infinity];
const CANDIDATE_BUCKETS = [0, 1, 5, 10, 25, 50, 100, 250, 500, 1000, Infinity];

const requestsCounter = new Map();
const latencyHistogramBySurface = new Map();
const candidateHistogramByStage = new Map();
const recallRequestsCounter = new Map();
const recallLatencyHistogramByStep = new Map();
const lastSnapshotBySurface = new Map();

function cleanLabel(value, fallback = 'unknown') {
  const normalized = String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || fallback;
}

function keyFromLabels(labels = {}) {
  return Object.keys(labels)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => `${key}:${String(labels[key])}`)
    .join('|');
}

function escapePromValue(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"');
}

function incCounter(counterMap, labels, delta = 1) {
  const key = keyFromLabels(labels);
  counterMap.set(key, Number(counterMap.get(key) || 0) + delta);
}

function observeHistogram(store, labels, value, buckets) {
  const key = keyFromLabels(labels);
  let state = store.get(key);
  if (!state) {
    state = {
      labels,
      buckets: new Map(buckets.map((bucket) => [bucket, 0])),
      sum: 0,
      count: 0,
    };
    store.set(key, state);
  }

  const numericValue = Math.max(0, Number(value) || 0);
  state.sum += numericValue;
  state.count += 1;
  for (const bucket of buckets) {
    if (numericValue <= bucket) {
      state.buckets.set(bucket, Number(state.buckets.get(bucket) || 0) + 1);
    }
  }
}

function renderCounter(lines, metricName, counterMap) {
  const entries = Array.from(counterMap.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  if (entries.length === 0) {
    lines.push(`${metricName} 0`);
    return;
  }
  for (const [key, value] of entries) {
    const labels = key
      .split('|')
      .filter(Boolean)
      .map((pair) => {
        const [name, raw] = pair.split(':');
        return `${name}="${escapePromValue(raw)}"`;
      });
    lines.push(`${metricName}{${labels.join(',')}} ${value}`);
  }
}

function renderHistogram(lines, metricName, helpText, store, buckets) {
  lines.push(`# HELP ${metricName} ${helpText}`);
  lines.push(`# TYPE ${metricName} histogram`);

  const entries = Array.from(store.values()).sort((a, b) => keyFromLabels(a.labels).localeCompare(keyFromLabels(b.labels)));
  if (entries.length === 0) {
    for (const bucket of buckets) {
      const le = bucket === Infinity ? '+Inf' : String(bucket);
      lines.push(`${metricName}_bucket{le="${le}"} 0`);
    }
    lines.push(`${metricName}_sum 0`);
    lines.push(`${metricName}_count 0`);
    return;
  }

  for (const entry of entries) {
    const labelPrefix = Object.entries(entry.labels)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, value]) => `${name}="${escapePromValue(value)}"`)
      .join(',');

    for (const bucket of buckets) {
      const le = bucket === Infinity ? '+Inf' : String(bucket);
      const labels = labelPrefix ? `${labelPrefix},le="${le}"` : `le="${le}"`;
      lines.push(`${metricName}_bucket{${labels}} ${Number(entry.buckets.get(bucket) || 0)}`);
    }

    const sumLabels = labelPrefix ? `{${labelPrefix}}` : '';
    lines.push(`${metricName}_sum${sumLabels} ${entry.sum}`);
    lines.push(`${metricName}_count${sumLabels} ${entry.count}`);
  }
}

function recordDiscoveryFeedRequest({
  surface,
  status,
  strategy,
  personalizationSource,
  candidateSource,
  reason,
} = {}) {
  incCounter(
    requestsCounter,
    {
      surface: cleanLabel(surface, 'unknown'),
      status: cleanLabel(status, 'unknown'),
      strategy: cleanLabel(strategy, 'unknown'),
      personalization_source: cleanLabel(personalizationSource, 'unknown'),
      candidate_source: cleanLabel(candidateSource, 'unknown'),
      reason: cleanLabel(reason, 'none'),
    },
    1,
  );
}

function observeDiscoveryFeedLatency({ surface, status, latencyMs } = {}) {
  observeHistogram(
    latencyHistogramBySurface,
    {
      surface: cleanLabel(surface, 'unknown'),
      status: cleanLabel(status, 'unknown'),
    },
    latencyMs,
    LATENCY_BUCKETS_MS,
  );
}

function observeDiscoveryCandidateCount({ surface, stage, count } = {}) {
  observeHistogram(
    candidateHistogramByStage,
    {
      surface: cleanLabel(surface, 'unknown'),
      stage: cleanLabel(stage, 'unknown'),
    },
    count,
    CANDIDATE_BUCKETS,
  );
}

function recordDiscoveryRecallStep({ surface, step, status, latencyMs, cacheHit } = {}) {
  const labels = {
    surface: cleanLabel(surface, 'unknown'),
    step: cleanLabel(step, 'unknown'),
    status: cleanLabel(status, 'unknown'),
    cache_hit: cacheHit ? 'true' : 'false',
  };
  incCounter(recallRequestsCounter, labels, 1);
  observeHistogram(recallLatencyHistogramByStep, labels, latencyMs, LATENCY_BUCKETS_MS);
}

function setLastDiscoverySnapshot(snapshot = {}) {
  const surface = cleanLabel(snapshot.surface, 'unknown');
  lastSnapshotBySurface.set(surface, {
    ...snapshot,
    surface,
    recorded_at: new Date().toISOString(),
  });
}

function getLastDiscoverySnapshot(surface = null) {
  if (surface) {
    return lastSnapshotBySurface.get(cleanLabel(surface, 'unknown')) || null;
  }
  return Object.fromEntries(Array.from(lastSnapshotBySurface.entries()).sort((a, b) => a[0].localeCompare(b[0])));
}

function renderDiscoveryMetricsPrometheus() {
  const lines = [];
  lines.push('# HELP discovery_feed_requests_total Total discovery feed requests by surface/status/strategy/source.');
  lines.push('# TYPE discovery_feed_requests_total counter');
  renderCounter(lines, 'discovery_feed_requests_total', requestsCounter);

  renderHistogram(
    lines,
    'discovery_feed_latency_ms',
    'Discovery feed end-to-end latency in milliseconds by surface and status.',
    latencyHistogramBySurface,
    LATENCY_BUCKETS_MS,
  );

  renderHistogram(
    lines,
    'discovery_feed_candidates',
    'Discovery feed candidate counts by surface and stage.',
    candidateHistogramByStage,
    CANDIDATE_BUCKETS,
  );

  lines.push('# HELP discovery_feed_recall_requests_total Total discovery recall steps by surface/step/status/cache.');
  lines.push('# TYPE discovery_feed_recall_requests_total counter');
  renderCounter(lines, 'discovery_feed_recall_requests_total', recallRequestsCounter);

  renderHistogram(
    lines,
    'discovery_feed_recall_latency_ms',
    'Discovery feed recall step latency in milliseconds by surface/step/status/cache.',
    recallLatencyHistogramByStep,
    LATENCY_BUCKETS_MS,
  );

  return `${lines.join('\n')}\n`;
}

function resetDiscoveryMetricsForTest() {
  requestsCounter.clear();
  latencyHistogramBySurface.clear();
  candidateHistogramByStage.clear();
  recallRequestsCounter.clear();
  recallLatencyHistogramByStep.clear();
  lastSnapshotBySurface.clear();
}

module.exports = {
  getLastDiscoverySnapshot,
  observeDiscoveryCandidateCount,
  observeDiscoveryFeedLatency,
  recordDiscoveryRecallStep,
  recordDiscoveryFeedRequest,
  renderDiscoveryMetricsPrometheus,
  resetDiscoveryMetricsForTest,
  setLastDiscoverySnapshot,
};
