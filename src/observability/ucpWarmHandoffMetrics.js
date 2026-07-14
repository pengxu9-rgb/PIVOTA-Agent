'use strict';

/*
 * ucpWarmHandoffMetrics.js — read-only, in-process Prometheus-style metrics for the LIVE Shopify UCP
 * warm-handoff lane (H2 of docs/ucp_shopify_lane_hardening_2026-07-13.md). Mirrors the exact convention of the
 * sibling observability modules (src/observability/discoveryMetrics.js, pdpMetrics.js): label-keyed counter Maps
 * + a bucketed latency histogram, rendered as Prometheus text and concatenated into the `/metrics` endpoint.
 *
 * SAFETY: structured metrics ONLY. No PII, no secrets, no `continue_url` / cart-key material ever passes through
 * here — the sole free-form label is the brand domain (already public), which is sanitized to [a-z0-9_]. The
 * warm-handoff cohort is a bounded set of Shopify D2C brands, so brand_domain cardinality stays small.
 */

const LATENCY_BUCKETS_MS = [50, 100, 250, 500, 1000, 1500, 2500, 5000, 10000, Infinity];

// outcome=success|fallback ; reason='ok' (success) or the H1 error-taxonomy reason (fallback) ; brand_domain.
const outcomeCounter = new Map();
// A previously-reachable brand domain started failing UCP discovery (cohort coverage drift signal).
const reachabilityDriftCounter = new Map();
// discover -> cart wall-clock latency, split by outcome.
const latencyHistogram = new Map();

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
    state = { labels, buckets: new Map(buckets.map((b) => [b, 0])), sum: 0, count: 0 };
    store.set(key, state);
  }
  const numericValue = Math.max(0, Number(value) || 0);
  state.sum += numericValue;
  state.count += 1;
  for (const bucket of buckets) {
    if (numericValue <= bucket) state.buckets.set(bucket, Number(state.buckets.get(bucket) || 0) + 1);
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
        const idx = pair.indexOf(':');
        const name = pair.slice(0, idx);
        const raw = pair.slice(idx + 1);
        return `${name}="${escapePromValue(raw)}"`;
      });
    lines.push(`${metricName}{${labels.join(',')}} ${value}`);
  }
}

function renderHistogram(lines, metricName, helpText, store, buckets) {
  lines.push(`# HELP ${metricName} ${helpText}`);
  lines.push(`# TYPE ${metricName} histogram`);
  const entries = Array.from(store.values())
    .sort((a, b) => keyFromLabels(a.labels).localeCompare(keyFromLabels(b.labels)));
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

/**
 * Record a warm-handoff terminal outcome.
 * @param {{ outcome: 'success'|'fallback', reason?: string, brandDomain?: string }} params
 *   - success => the lane returned a warm cart + continue_url. reason defaults to 'ok'.
 *   - fallback => the lane fell back to the cold redirect; reason is the H1 taxonomy tag (e.g. not_ucp_reachable,
 *     timeout, out_of_stock, variant_invalid, tool_error, profile_unreachable, no_continue_url).
 */
function recordWarmHandoffOutcome({ outcome, reason, brandDomain } = {}) {
  const outcomeLabel = cleanLabel(outcome, 'unknown');
  incCounter(outcomeCounter, {
    outcome: outcomeLabel,
    reason: cleanLabel(reason, outcomeLabel === 'success' ? 'ok' : 'unknown'),
    brand_domain: cleanLabel(brandDomain, 'unknown'),
  });
}

/** Observe the discover->cart wall-clock latency for a warm-handoff attempt, split by outcome. */
function observeWarmHandoffLatency({ outcome, latencyMs } = {}) {
  observeHistogram(
    latencyHistogram,
    { outcome: cleanLabel(outcome, 'unknown') },
    latencyMs,
    LATENCY_BUCKETS_MS,
  );
}

/** A previously-reachable brand domain started failing UCP discovery (reachability drift). */
function recordReachabilityDrift({ brandDomain } = {}) {
  incCounter(reachabilityDriftCounter, { brand_domain: cleanLabel(brandDomain, 'unknown') });
}

function renderUcpWarmHandoffMetricsPrometheus() {
  const lines = [];
  lines.push('# HELP ucp_warm_handoff_total Warm-handoff outcomes by outcome(success|fallback)/reason/brand_domain.');
  lines.push('# TYPE ucp_warm_handoff_total counter');
  renderCounter(lines, 'ucp_warm_handoff_total', outcomeCounter);

  lines.push('# HELP ucp_warm_handoff_reachability_drift_total Previously-reachable brand domains now failing UCP discovery.');
  lines.push('# TYPE ucp_warm_handoff_reachability_drift_total counter');
  renderCounter(lines, 'ucp_warm_handoff_reachability_drift_total', reachabilityDriftCounter);

  renderHistogram(
    lines,
    'ucp_warm_handoff_latency_ms',
    'Warm-handoff discover->cart wall-clock latency in milliseconds by outcome.',
    latencyHistogram,
    LATENCY_BUCKETS_MS,
  );

  return `${lines.join('\n')}\n`;
}

function resetUcpWarmHandoffMetricsForTest() {
  outcomeCounter.clear();
  reachabilityDriftCounter.clear();
  latencyHistogram.clear();
}

module.exports = {
  recordWarmHandoffOutcome,
  observeWarmHandoffLatency,
  recordReachabilityDrift,
  renderUcpWarmHandoffMetricsPrometheus,
  resetUcpWarmHandoffMetricsForTest,
};
