'use strict';

// Aggregation: percentiles and per-dimension rollups over the call records.

/** Linear-interpolated percentile (p in [0,100]) of a numeric list. null for an empty list. */
function percentile(values, p) {
  const xs = (values || []).filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  if (xs.length === 1) return xs[0];
  const rank = (p / 100) * (xs.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const v = xs[lo] + (xs[hi] - xs[lo]) * (rank - lo);
  return Math.round(v * 10) / 10;
}

function latencySummary(values) {
  const xs = (values || []).filter((v) => typeof v === 'number' && Number.isFinite(v));
  return {
    n: xs.length,
    p50: percentile(xs, 50),
    p95: percentile(xs, 95),
    p99: percentile(xs, 99),
    max: xs.length ? Math.max(...xs) : null,
  };
}

// Outcomes that mean "the partner did not get an answer from the service".
const UNAVAILABLE_OUTCOMES = new Set(['transport_error', 'timeout', 'http_error', 'parse_error', 'jsonrpc_error', 'attestation_missing', 'redirect_refused']);

/**
 * Availability over call records. 429 (rate_limited) and 401/403 (auth_error) are counted separately and
 * excluded from the availability denominator's failures: a 429 is the service working as configured, an auth
 * error is a harness configuration problem — both are reported, neither is hidden.
 */
function availabilitySummary(records) {
  const out = {
    calls: 0,
    ok: 0,
    tool_error: 0,
    failed_with_hits: 0,
    rate_limited: 0,
    auth_error: 0,
    by_outcome: {},
    tool_error_codes: {},
  };
  for (const r of records) {
    out.calls += 1;
    out.by_outcome[r.outcome] = (out.by_outcome[r.outcome] || 0) + 1;
    if (r.outcome === 'ok') out.ok += 1;
    if (r.outcome === 'rate_limited') out.rate_limited += 1;
    if (r.outcome === 'auth_error') out.auth_error += 1;
    if (r.tool_error) {
      out.tool_error += 1;
      out.tool_error_codes[r.tool_error_code] = (out.tool_error_codes[r.tool_error_code] || 0) + 1;
    }
    if (r.failed_with_hits) out.failed_with_hits += 1;
  }
  const unavailable = records.filter((r) => UNAVAILABLE_OUTCOMES.has(r.outcome)).length;
  const denom = out.calls - out.rate_limited - out.auth_error;
  out.unavailable = unavailable;
  out.availability = denom > 0 ? round4(1 - unavailable / denom) : null;
  out.tool_error_rate = out.calls > 0 ? round4(out.tool_error / out.calls) : null;
  out.rate_limited_rate = out.calls > 0 ? round4(out.rate_limited / out.calls) : null;
  return out;
}

function round4(x) {
  return Math.round(x * 10000) / 10000;
}

function groupBy(items, keyFn) {
  const m = new Map();
  for (const it of items) {
    const k = keyFn(it);
    if (k === undefined) continue;
    const key = k === null ? 'none' : String(k);
    if (!m.has(key)) m.set(key, []);
    m.get(key).push(it);
  }
  return m;
}

function rate(num, den) {
  return den > 0 ? round4(num / den) : null;
}

module.exports = { percentile, latencySummary, availabilitySummary, groupBy, rate, round4, UNAVAILABLE_OUTCOMES };
