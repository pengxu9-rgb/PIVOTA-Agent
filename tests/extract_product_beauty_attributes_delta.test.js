const {
  runDeltaJob,
  fetchGapSize,
  parsePositiveInt,
  DEFAULT_LIMIT,
  DEFAULT_ALERT_THRESHOLD,
  HARD_LIMIT_MAX,
} = require('../scripts/extract-product-beauty-attributes-delta');

const FIXED_NOW = 1_700_000_000_000;
const TICK = 1_500;

function makeNow() {
  let calls = 0;
  return () => {
    const v = FIXED_NOW + calls * TICK;
    calls += 1;
    return v;
  };
}

const DEEPSEEK_CONFIG = { provider: 'deepseek', model: 'deepseek-chat', kind: 'openai_compatible', apiKey: 'sk-fake' };

describe('parsePositiveInt', () => {
  test('returns fallback for non-finite input', () => {
    expect(parsePositiveInt('xyz', 7)).toBe(7);
    expect(parsePositiveInt(undefined, 7)).toBe(7);
  });
  test('clamps to min/max', () => {
    expect(parsePositiveInt('-5', 7, { min: 1 })).toBe(1);
    expect(parsePositiveInt('999', 7, { min: 1, max: 50 })).toBe(50);
  });
  test('truncates floats', () => {
    expect(parsePositiveInt('42.9', 7)).toBe(42);
  });
});

describe('fetchGapSize', () => {
  test('returns the gap count from the first row', async () => {
    const queryFn = jest.fn(async () => ({ rows: [{ gap: 17 }] }));
    expect(await fetchGapSize(queryFn)).toBe(17);
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(queryFn.mock.calls[0][0]).toMatch(/external_product_seeds/);
    expect(queryFn.mock.calls[0][0]).toMatch(/NOT IN \(SELECT product_key FROM product_beauty_attributes\)/);
  });

  test('returns null when no rows', async () => {
    const queryFn = jest.fn(async () => ({ rows: [] }));
    expect(await fetchGapSize(queryFn)).toBeNull();
  });
});

describe('runDeltaJob', () => {
  test('emits config_error metric when provider is unconfigured', async () => {
    const queryFn = jest.fn(async () => ({ rows: [{ gap: 4 }] }));
    const runExtractionFn = jest.fn();
    const { metric, exitCode } = await runDeltaJob({
      queryFn,
      runExtractionFn,
      providerConfig: { provider: 'unconfigured', kind: 'missing' },
      limit: DEFAULT_LIMIT,
      alertThreshold: DEFAULT_ALERT_THRESHOLD,
      now: makeNow(),
    });
    expect(metric.status).toBe('config_error');
    expect(metric.reason).toBe('missing_llm_credentials');
    expect(metric.products_attempted).toBe(0);
    expect(metric.gap_size_pre).toBe(4);
    expect(exitCode).toBe(2);
    expect(runExtractionFn).not.toHaveBeenCalled();
  });

  test('emits noop metric when gap is already zero (skips extractor)', async () => {
    const queryFn = jest.fn(async () => ({ rows: [{ gap: 0 }] }));
    const runExtractionFn = jest.fn();
    const { metric, exitCode } = await runDeltaJob({
      queryFn,
      runExtractionFn,
      providerConfig: DEEPSEEK_CONFIG,
      limit: 50,
      alertThreshold: 100,
      now: makeNow(),
    });
    expect(metric.status).toBe('noop');
    expect(metric.gap_size_pre).toBe(0);
    expect(metric.gap_size_post).toBe(0);
    expect(metric.alert_threshold_exceeded).toBe(false);
    expect(metric.provider).toBe('deepseek');
    expect(exitCode).toBe(0);
    expect(runExtractionFn).not.toHaveBeenCalled();
  });

  test('runs extractor with universeSource=external_seed and apply=true', async () => {
    let call = 0;
    const queryFn = jest.fn(async () => ({ rows: [{ gap: call++ === 0 ? 12 : 0 }] }));
    const runExtractionFn = jest.fn(async () => ({
      mode: 'apply', attempted: 12, successful: 12, failed: 0, estimated_cost_usd: 0.01,
    }));

    const { metric, exitCode } = await runDeltaJob({
      queryFn,
      runExtractionFn,
      providerConfig: DEEPSEEK_CONFIG,
      limit: 50,
      alertThreshold: 100,
      now: makeNow(),
    });

    expect(runExtractionFn).toHaveBeenCalledWith(expect.objectContaining({
      apply: true,
      limit: 50,
      universeSource: 'external_seed',
      providerConfig: DEEPSEEK_CONFIG,
      queryFn,
    }));
    expect(metric.status).toBe('ok');
    expect(metric.gap_size_pre).toBe(12);
    expect(metric.gap_size_post).toBe(0);
    expect(metric.products_classified).toBe(12);
    expect(metric.alert_threshold_exceeded).toBe(false);
    expect(metric.estimated_cost_usd).toBe(0.01);
    expect(exitCode).toBe(0);
  });

  test('alert fires when gap_size_post exceeds threshold', async () => {
    let call = 0;
    const queryFn = jest.fn(async () => ({ rows: [{ gap: call++ === 0 ? 250 : 200 }] }));
    const runExtractionFn = jest.fn(async () => ({
      attempted: 50, successful: 50, failed: 0, estimated_cost_usd: 0.04,
    }));

    const { metric } = await runDeltaJob({
      queryFn,
      runExtractionFn,
      providerConfig: DEEPSEEK_CONFIG,
      limit: 50,
      alertThreshold: 100,
      now: makeNow(),
    });

    expect(metric.gap_size_pre).toBe(250);
    expect(metric.gap_size_post).toBe(200);
    expect(metric.alert_threshold_exceeded).toBe(true);
  });

  test('partial status when extractor throws but post-gap query succeeds', async () => {
    let call = 0;
    const queryFn = jest.fn(async () => ({ rows: [{ gap: call++ === 0 ? 5 : 3 }] }));
    const runExtractionFn = jest.fn(async () => {
      throw new Error('BUDGET_LIMIT_EXCEEDED');
    });

    const { metric, exitCode } = await runDeltaJob({
      queryFn,
      runExtractionFn,
      providerConfig: DEEPSEEK_CONFIG,
      limit: 50,
      alertThreshold: 100,
      now: makeNow(),
    });

    expect(metric.status).toBe('partial');
    expect(metric.error).toMatch(/BUDGET_LIMIT_EXCEEDED/);
    expect(metric.gap_size_pre).toBe(5);
    expect(metric.gap_size_post).toBe(3);
    expect(exitCode).toBe(0);
  });
});

describe('defaults', () => {
  test('exposes documented defaults', () => {
    expect(DEFAULT_LIMIT).toBe(50);
    expect(DEFAULT_ALERT_THRESHOLD).toBe(100);
    expect(HARD_LIMIT_MAX).toBe(500);
  });
});
