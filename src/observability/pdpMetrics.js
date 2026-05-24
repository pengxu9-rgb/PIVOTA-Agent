const HISTOGRAM_BUCKETS_MS = [50, 100, 250, 500, 1000, 1200, 2000, 5000, 10000];

const moduleLatency = new Map();
const recsTimeouts = new Map();
const similarDeferred = new Map();

function sanitizeLabelValue(value, fallback = 'unknown') {
  const text = String(value || '').trim();
  return text ? text.replace(/\\/g, '\\\\').replace(/"/g, '\\"') : fallback;
}

function labelsToKey(labels = {}) {
  return Object.keys(labels)
    .sort()
    .map((key) => `${key}=${String(labels[key] || '')}`)
    .join('\n');
}

function keyToLabels(key) {
  if (!key) return {};
  return key.split('\n').reduce((acc, part) => {
    const idx = part.indexOf('=');
    if (idx <= 0) return acc;
    acc[part.slice(0, idx)] = part.slice(idx + 1);
    return acc;
  }, {});
}

function formatLabels(labels = {}) {
  const entries = Object.entries(labels).filter(([, value]) => value != null && value !== '');
  if (!entries.length) return '';
  return `{${entries
    .map(([key, value]) => `${key}="${sanitizeLabelValue(value)}"`)
    .join(',')}}`;
}

function getHistogram(map, labels) {
  const key = labelsToKey(labels);
  let entry = map.get(key);
  if (!entry) {
    entry = {
      labels,
      buckets: new Array(HISTOGRAM_BUCKETS_MS.length).fill(0),
      count: 0,
      sum: 0,
    };
    map.set(key, entry);
  }
  return entry;
}

function incrementCounter(map, labels, amount = 1) {
  const key = labelsToKey(labels);
  map.set(key, (map.get(key) || 0) + amount);
}

function recordPdpV2ModuleLatency({ module, status = 'complete', latencyMs } = {}) {
  const ms = Number(latencyMs);
  if (!module || !Number.isFinite(ms) || ms < 0) return;
  const entry = getHistogram(moduleLatency, {
    module: String(module),
    status: String(status || 'complete'),
  });
  entry.count += 1;
  entry.sum += ms;
  HISTOGRAM_BUCKETS_MS.forEach((bucket, index) => {
    if (ms <= bucket) entry.buckets[index] += 1;
  });
}

function recordPdpRecsTimeout({ stage = 'unknown' } = {}) {
  incrementCounter(recsTimeouts, { stage: String(stage || 'unknown') });
}

function recordSimilarDeferred({ source = 'unknown' } = {}) {
  incrementCounter(similarDeferred, { source: String(source || 'unknown') });
}

function renderHistogram(name, help, map) {
  const lines = [
    `# HELP ${name} ${help}`,
    `# TYPE ${name} histogram`,
  ];
  for (const entry of map.values()) {
    HISTOGRAM_BUCKETS_MS.forEach((bucket, index) => {
      lines.push(`${name}_bucket${formatLabels({ ...entry.labels, le: bucket })} ${entry.buckets[index]}`);
    });
    lines.push(`${name}_bucket${formatLabels({ ...entry.labels, le: '+Inf' })} ${entry.count}`);
    lines.push(`${name}_sum${formatLabels(entry.labels)} ${entry.sum}`);
    lines.push(`${name}_count${formatLabels(entry.labels)} ${entry.count}`);
  }
  return `${lines.join('\n')}\n`;
}

function renderCounter(name, help, map) {
  const lines = [
    `# HELP ${name} ${help}`,
    `# TYPE ${name} counter`,
  ];
  for (const [key, value] of map.entries()) {
    lines.push(`${name}${formatLabels(keyToLabels(key))} ${value}`);
  }
  return `${lines.join('\n')}\n`;
}

function renderPdpMetricsPrometheus() {
  return [
    renderHistogram(
      'pdp_v2_module_latency_ms',
      'PDP v2 module latency in milliseconds.',
      moduleLatency,
    ),
    renderCounter(
      'pdp_recs_timeout_total',
      'Recommendation query or stage timeouts while building PDP recommendations.',
      recsTimeouts,
    ),
    renderCounter(
      'similar_deferred_total',
      'PDP similar module responses deferred from first paint.',
      similarDeferred,
    ),
  ].join('');
}

function __resetPdpMetricsForTest() {
  moduleLatency.clear();
  recsTimeouts.clear();
  similarDeferred.clear();
}

module.exports = {
  recordPdpV2ModuleLatency,
  recordPdpRecsTimeout,
  recordSimilarDeferred,
  renderPdpMetricsPrometheus,
  __resetPdpMetricsForTest,
};
