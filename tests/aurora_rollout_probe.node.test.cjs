const test = require('node:test');
const assert = require('node:assert/strict');

const { __internal } = require('../scripts/aurora_rollout_probe');

function makeAttempt(overrides = {}) {
  return {
    status: 200,
    text: '{"ok":true}',
    json: {
      meta: {
        rollout_variant: 'v2_core',
        rollout_bucket: 2,
        policy_version: 'aurora_chat_v2_p0',
      },
    },
    headers: {
      variant: 'v2_core',
      bucketRaw: '2',
      policyVersion: 'aurora_chat_v2_p0',
    },
    ...overrides,
  };
}

function makeSummary(overrides = {}) {
  return {
    total_requests: 10,
    success_200: 10,
    non_200_count: 0,
    parse_error_count: 0,
    meta_null_count: 0,
    mismatch_count: 0,
    bucket_out_of_range_count: 0,
    infra_flake_count: 0,
    header_variant_pct: {
      legacy: 93,
      v2_core: 5,
      v2_safety: 1,
      v2_weather: 1,
    },
    ...overrides,
  };
}

function makeCfg(overrides = {}) {
  return {
    elevatedFailureWindowMs: 10 * 60 * 1000,
    splitDriftMinSamples: 200,
    splitCoreMinPct: 2.0,
    splitCoreMaxPct: 10.0,
    splitSafetyMinPct: 0.2,
    splitSafetyMaxPct: 3.0,
    splitWeatherMinPct: 0.2,
    splitWeatherMaxPct: 3.0,
    ...overrides,
  };
}

function withEnv(patch, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(patch || {})) {
    prev[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }

  const restore = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };

  try {
    const out = fn();
    if (out && typeof out.then === 'function') return out.finally(restore);
    restore();
    return out;
  } catch (err) {
    restore();
    throw err;
  }
}

test('classifyAttempt marks meta missing as invariant failure', () => {
  const out = __internal.classifyAttempt(
    makeAttempt({
      json: { reply: 'ok' },
    }),
  );

  assert.equal(out.invariants.metaNull, true);
  assert.ok(out.reasons.includes('meta_null'));
});

test('classifyAttempt marks header/meta mismatch fields', () => {
  const out = __internal.classifyAttempt(
    makeAttempt({
      json: {
        meta: {
          rollout_variant: 'legacy',
          rollout_bucket: 7,
          policy_version: 'legacy',
        },
      },
    }),
  );

  assert.equal(out.invariants.variantMismatch, true);
  assert.equal(out.invariants.bucketMismatch, true);
  assert.equal(out.invariants.policyMismatch, true);
  assert.ok(out.reasons.includes('variant_mismatch'));
  assert.ok(out.reasons.includes('bucket_mismatch'));
  assert.ok(out.reasons.includes('policy_mismatch'));
});

test('classifyAttempt treats missing bucket header as invalid', () => {
  const out = __internal.classifyAttempt(
    makeAttempt({
      headers: {
        variant: 'v2_core',
        bucketRaw: null,
        policyVersion: 'aurora_chat_v2_p0',
      },
    }),
  );

  assert.equal(out.invariants.bucketOutOfRange, true);
  assert.ok(out.reasons.includes('bucket_out_of_range'));
});

test('aggregateRows computes mismatch and bucket range correctly', () => {
  const rows = [
    {
      index: 0,
      recovered_after_retry: false,
      final: {
        status: 200,
        error: null,
        parse_error: false,
        infra_flake: false,
        reasons: [],
        headers: { variant: 'v2_core', bucketRaw: '2', policyVersion: 'aurora_chat_v2_p0' },
        invariants: {
          metaNull: false,
          variantMismatch: false,
          bucketMismatch: false,
          policyMismatch: false,
          bucketOutOfRange: false,
        },
        meta: { rollout_variant: 'v2_core', rollout_bucket: 2, policy_version: 'aurora_chat_v2_p0' },
      },
    },
    {
      index: 1,
      recovered_after_retry: false,
      final: {
        status: 200,
        error: null,
        parse_error: false,
        infra_flake: false,
        reasons: ['variant_mismatch', 'bucket_mismatch'],
        headers: { variant: 'legacy', bucketRaw: '7', policyVersion: 'legacy' },
        invariants: {
          metaNull: false,
          variantMismatch: true,
          bucketMismatch: true,
          policyMismatch: false,
          bucketOutOfRange: false,
        },
        meta: { rollout_variant: 'v2_core', rollout_bucket: 2, policy_version: 'legacy' },
      },
    },
  ];

  const out = __internal.aggregateRows(rows);
  assert.equal(out.total_requests, 2);
  assert.equal(out.mismatch_count, 2);
  assert.equal(out.bucket_min, 2);
  assert.equal(out.bucket_max, 7);
  assert.equal(out.failures.length, 1);
});

test('evaluateAlertChecks raises high on second elevated failure window hit', () => {
  const nowMs = Date.now();
  const state = {
    runs: [
      { ts_ms: nowMs - 60 * 1000, non_200_or_parse_error_count: 1 },
      { ts_ms: nowMs - 3 * 60 * 1000, non_200_or_parse_error_count: 1 },
    ],
  };
  const summary = makeSummary({
    non_200_count: 1,
    infra_flake_count: 1,
  });
  const cfg = makeCfg();

  const out = __internal.evaluateAlertChecks({ summary, state, cfg, nowMs });
  const elevated = out.checks.find((row) => row.id === 'elevated_failures');

  assert.equal(Boolean(elevated && elevated.triggered), true);
  assert.equal(out.severity, 'high');
});

test('evaluateAlertChecks raises warn for single-run infra flake', () => {
  const nowMs = Date.now();
  const state = { runs: [] };
  const summary = makeSummary({
    non_200_count: 1,
    infra_flake_count: 1,
  });
  const cfg = makeCfg();

  const out = __internal.evaluateAlertChecks({ summary, state, cfg, nowMs });
  const warnRow = out.checks.find((row) => row.id === 'infra_flake_single_run');

  assert.equal(Boolean(warnRow && warnRow.triggered), true);
  assert.equal(out.severity, 'warn');
});

test('evaluateAlertChecks warns on variant split drift when sample is large', () => {
  const nowMs = Date.now();
  const state = { runs: [] };
  const summary = makeSummary({
    total_requests: 300,
    header_variant_pct: {
      legacy: 98.8,
      v2_core: 0.7,
      v2_safety: 0.3,
      v2_weather: 0.2,
    },
  });
  const cfg = makeCfg();

  const out = __internal.evaluateAlertChecks({ summary, state, cfg, nowMs });
  const splitDrift = out.checks.find((row) => row.id === 'variant_split_drift');

  assert.equal(Boolean(splitDrift && splitDrift.triggered), true);
  assert.equal(out.severity, 'warn');
});

test('parseArgs supports AURORA_PROBE_* aliases and window minutes', () => {
  return withEnv(
    {
      AURORA_PROBE_BASE_URL: 'https://example.com',
      AURORA_PROBE_WEBHOOK_URL: 'https://hooks.example.com/probe',
      AURORA_PROBE_WEBHOOK_TOKEN: 'token_123',
      AURORA_PROBE_SAMPLES: '20',
      AURORA_PROBE_CONCURRENCY: '5',
      AURORA_PROBE_RETRY_COUNT: '1',
      AURORA_PROBE_WINDOW_MINUTES: '10',
      AURORA_ROLLOUT_PROBE_BASE: undefined,
      AURORA_ROLLOUT_PROBE_ALERT_WEBHOOK_URL: undefined,
      AURORA_ROLLOUT_PROBE_WEBHOOK_TOKEN: undefined,
      AURORA_ROLLOUT_PROBE_SAMPLES: undefined,
      AURORA_ROLLOUT_PROBE_CONCURRENCY: undefined,
      AURORA_ROLLOUT_PROBE_RETRY_COUNT: undefined,
      AURORA_ROLLOUT_PROBE_ELEVATED_WINDOW_MS: undefined,
    },
    () => {
      const cfg = __internal.parseArgs([]);
      assert.equal(cfg.base, 'https://example.com');
      assert.equal(cfg.webhookUrl, 'https://hooks.example.com/probe');
      assert.equal(cfg.webhookToken, 'token_123');
      assert.equal(cfg.samples, 20);
      assert.equal(cfg.concurrency, 5);
      assert.equal(cfg.retryCount, 1);
      assert.equal(cfg.elevatedFailureWindowMs, 10 * 60 * 1000);
    },
  );
});

test('parseArgs supports CLI aliases --webhook --webhook-token --window-minutes', () => {
  const cfg = __internal.parseArgs([
    '--webhook',
    'https://hooks.example.com/cli',
    '--webhook-token',
    'cli_token',
    '--window-minutes',
    '15',
  ]);

  assert.equal(cfg.webhookUrl, 'https://hooks.example.com/cli');
  assert.equal(cfg.webhookToken, 'cli_token');
  assert.equal(cfg.elevatedFailureWindowMs, 15 * 60 * 1000);
});
