// `metadata.route_trace.node_timings_ms` is the column scripts/search_stability_matrix.js has read
// since it was written, and until 2026-08-27 nothing in the server ever wrote it -- so every prod
// smoke row reported `node_timings_ms: null`. A column that is structurally always null reads as
// "this run had no timing data" rather than "this field is unimplemented", which is why the 28.5s
// aurora-bff regression had to be attributed by hand from Cloud Run logs.
//
// These tests pin the emission itself. The mutants that matter: dropping the withSearchDiagnostics
// attach (back to null), summing off_path entries (overstates the pipeline the way fpm_unattributed_ms
// is careful not to), and overwriting rather than summing same-named stages (the cache lane runs more
// than one search per request).
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test';
const { buildFpmNodeTimingsMs, INVOKE_FPM_STAGE_CONTEXT, withSearchDiagnostics } =
  require('../src/server')._debug;

describe('buildFpmNodeTimingsMs', () => {
  it('collapses a stage breakdown to {stage: ms}', () => {
    expect(
      buildFpmNodeTimingsMs([
        { stage: 'route_entry', latency_ms: 0 },
        { stage: 'cache_cross_merchant_search', latency_ms: 16335 },
        { stage: 'primary_upstream', latency_ms: 11991, upstream_http: true },
      ]),
    ).toEqual({ route_entry: 0, cache_cross_merchant_search: 16335, primary_upstream: 11991 });
  });

  it('SUMS repeated stages rather than keeping only the last', () => {
    // The cache lane calls runCacheSearch more than once per request (raw query, then expanded).
    // Overwriting would report the cheap retry and hide the expensive first attempt.
    expect(
      buildFpmNodeTimingsMs([
        { stage: 'cache_cross_merchant_search', latency_ms: 2500 },
        { stage: 'cache_cross_merchant_search', latency_ms: 13835 },
      ]),
    ).toEqual({ cache_cross_merchant_search: 16335 });
  });

  it('SKIPS off_path entries, which overlap the pipeline', () => {
    // Same reason fpm_unattributed_ms excludes them: the citable supplement is a floating promise
    // running alongside the pipeline, so counting it would overstate serial time.
    expect(
      buildFpmNodeTimingsMs([
        { stage: 'citable_supplement', latency_ms: 9, off_path: true },
        { stage: 'context_build', latency_ms: 157 },
      ]),
    ).toEqual({ context_build: 157 });
  });

  it('returns null for empty, missing, or entirely unusable input', () => {
    expect(buildFpmNodeTimingsMs([])).toBeNull();
    expect(buildFpmNodeTimingsMs(null)).toBeNull();
    expect(buildFpmNodeTimingsMs(undefined)).toBeNull();
    expect(buildFpmNodeTimingsMs('nope')).toBeNull();
    expect(buildFpmNodeTimingsMs([{ stage: '', latency_ms: 5 }])).toBeNull();
    expect(buildFpmNodeTimingsMs([{ stage: 'x', latency_ms: 'abc' }])).toBeNull();
    expect(buildFpmNodeTimingsMs([{ stage: 'y', latency_ms: 1, off_path: true }])).toBeNull();
  });
});

describe('withSearchDiagnostics route_trace.node_timings_ms', () => {
  const body = () => ({ products: [], metadata: { query_source: 'cache_cross_merchant_search' } });

  it('attaches the in-flight breakdown from the request-scoped store', () => {
    const breakdown = [{ stage: 'cache_cross_merchant_search', latency_ms: 16335 }];
    const out = INVOKE_FPM_STAGE_CONTEXT.run(breakdown, () => withSearchDiagnostics(body(), {}));
    expect(out.metadata.route_trace.node_timings_ms).toEqual({
      cache_cross_merchant_search: 16335,
    });
  });

  it('sees stages recorded AFTER the store was entered', () => {
    // enterWith publishes the array by reference; the handler records most stages long after. If
    // this were snapshotted at entry the field would always be near-empty.
    const breakdown = [];
    const out = INVOKE_FPM_STAGE_CONTEXT.run(breakdown, () => {
      breakdown.push({ stage: 'primary_upstream', latency_ms: 11991 });
      return withSearchDiagnostics(body(), {});
    });
    expect(out.metadata.route_trace.node_timings_ms).toEqual({ primary_upstream: 11991 });
  });

  it('omits route_trace entirely when there is no store', () => {
    const out = withSearchDiagnostics(body(), {});
    expect(out.metadata.route_trace).toBeUndefined();
  });

  it('preserves other route_trace fields it did not author', () => {
    const withTrace = { products: [], metadata: { route_trace: { failure_stage: 'upstream' } } };
    const out = INVOKE_FPM_STAGE_CONTEXT.run([{ stage: 'context_build', latency_ms: 157 }], () =>
      withSearchDiagnostics(withTrace, {}),
    );
    expect(out.metadata.route_trace.failure_stage).toBe('upstream');
    expect(out.metadata.route_trace.node_timings_ms).toEqual({ context_build: 157 });
  });

  it('does not leak one request’s timings into a concurrent request', () => {
    // containerConcurrency is 80. A module-level accumulator would blend these two.
    const a = INVOKE_FPM_STAGE_CONTEXT.run([{ stage: 'a', latency_ms: 1 }], () =>
      withSearchDiagnostics(body(), {}),
    );
    const b = INVOKE_FPM_STAGE_CONTEXT.run([{ stage: 'b', latency_ms: 2 }], () =>
      withSearchDiagnostics(body(), {}),
    );
    expect(a.metadata.route_trace.node_timings_ms).toEqual({ a: 1 });
    expect(b.metadata.route_trace.node_timings_ms).toEqual({ b: 2 });
  });
});
