const LATENCY_BUCKETS_MS = [25, 50, 100, 250, 500, 1000, 1500, 2500, 5000, 10000, Infinity];
const COUNT_BUCKETS = [0, 1, 2, 5, 10, 25, 50, 100, 250, Infinity];

const recallCounter = new Map();
const recallLatencyHistogram = new Map();
const countHistogram = new Map();
const postFilterCounter = new Map();

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

  const entries = Array.from(store.values()).sort((a, b) =>
    keyFromLabels(a.labels).localeCompare(keyFromLabels(b.labels)),
  );
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

function toCount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.floor(numeric));
}

function recordRelationshipGraphRecall({
  surface,
  status,
  latencyMs,
  anchorRefCount,
  edgeCount,
  itemCount,
  error,
} = {}) {
  const labels = {
    surface: cleanLabel(surface, 'unknown'),
    status: cleanLabel(status, 'unknown'),
    error: cleanLabel(error, 'none'),
  };
  incCounter(recallCounter, labels, 1);
  observeHistogram(recallLatencyHistogram, labels, latencyMs, LATENCY_BUCKETS_MS);
  observeHistogram(countHistogram, { ...labels, stage: 'anchor_refs' }, toCount(anchorRefCount), COUNT_BUCKETS);
  observeHistogram(countHistogram, { ...labels, stage: 'edges' }, toCount(edgeCount), COUNT_BUCKETS);
  observeHistogram(countHistogram, { ...labels, stage: 'items' }, toCount(itemCount), COUNT_BUCKETS);
}

function recordRelationshipGraphPostFilter({
  surface,
  status,
  rawServedCount,
  servedCount,
  filteredCount,
} = {}) {
  const labels = {
    surface: cleanLabel(surface, 'unknown'),
    status: cleanLabel(status, 'unknown'),
    error: 'none',
  };
  incCounter(postFilterCounter, labels, 1);
  observeHistogram(countHistogram, { ...labels, stage: 'raw_served' }, toCount(rawServedCount), COUNT_BUCKETS);
  observeHistogram(countHistogram, { ...labels, stage: 'served' }, toCount(servedCount), COUNT_BUCKETS);
  observeHistogram(countHistogram, { ...labels, stage: 'filtered' }, toCount(filteredCount), COUNT_BUCKETS);
}

function renderRelationshipGraphMetricsPrometheus() {
  const lines = [];
  lines.push('# HELP relationship_graph_recall_requests_total Total relationship graph recall attempts by surface/status/error.');
  lines.push('# TYPE relationship_graph_recall_requests_total counter');
  renderCounter(lines, 'relationship_graph_recall_requests_total', recallCounter);

  renderHistogram(
    lines,
    'relationship_graph_recall_latency_ms',
    'Relationship graph recall latency in milliseconds by surface/status/error.',
    recallLatencyHistogram,
    LATENCY_BUCKETS_MS,
  );

  lines.push('# HELP relationship_graph_post_filter_total Total relationship graph post-filter observations by surface/status/error.');
  lines.push('# TYPE relationship_graph_post_filter_total counter');
  renderCounter(lines, 'relationship_graph_post_filter_total', postFilterCounter);

  renderHistogram(
    lines,
    'relationship_graph_items',
    'Relationship graph anchor, edge, item, served, and filtered counts by surface/status/stage.',
    countHistogram,
    COUNT_BUCKETS,
  );

  return `${lines.join('\n')}\n`;
}

function resetRelationshipGraphMetricsForTest() {
  recallCounter.clear();
  recallLatencyHistogram.clear();
  countHistogram.clear();
  postFilterCounter.clear();
}

module.exports = {
  recordRelationshipGraphPostFilter,
  recordRelationshipGraphRecall,
  renderRelationshipGraphMetricsPrometheus,
  resetRelationshipGraphMetricsForTest,
};
