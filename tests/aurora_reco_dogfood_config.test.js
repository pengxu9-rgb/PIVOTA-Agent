const { buildRecoDogfoodConfig } = require('../src/auroraBff/recoDogfoodConfig');

describe('aurora reco dogfood config', () => {
  test('defaults to non-dogfood with conservative pool size', () => {
    const cfg = buildRecoDogfoodConfig({});
    expect(cfg.dogfood_mode).toBe(false);
    expect(cfg.exploration.enabled).toBe(false);
    expect(cfg.interleave.enabled).toBe(false);
    expect(cfg.ui.show_employee_feedback_controls).toBe(false);
    expect(cfg.retrieval.pool_size).toEqual({
      competitors: 120,
      dupes: 80,
      related_products: 80,
    });
  });

  test('dogfood env enables exploration/interleave and enlarged pools', () => {
    const cfg = buildRecoDogfoodConfig({
      AURORA_BFF_RECO_DOGFOOD_MODE: 'true',
      AURORA_BFF_RECO_DOGFOOD_EXPLORATION_ENABLED: 'true',
      AURORA_BFF_RECO_DOGFOOD_EXPLORATION_RATE_PER_BLOCK: '0.35',
      AURORA_BFF_RECO_DOGFOOD_EXPLORATION_MAX_ITEMS: '2',
      AURORA_BFF_RECO_DOGFOOD_UI_SHOW_EMPLOYEE_FEEDBACK_CONTROLS: 'true',
      AURORA_BFF_RECO_DOGFOOD_UI_ALLOW_BLOCK_INTERNAL_RERANK_ON_ASYNC: 'true',
      AURORA_BFF_RECO_DOGFOOD_UI_LOCK_TOP_N_ON_FIRST_PAINT: '4',
      AURORA_BFF_RECO_DOGFOOD_POOL_COMPETITORS: '900',
      AURORA_BFF_RECO_DOGFOOD_POOL_DUPES: '420',
      AURORA_BFF_RECO_DOGFOOD_POOL_RELATED_PRODUCTS: '510',
      AURORA_BFF_RECO_INTERLEAVE_ENABLED: 'true',
      AURORA_BFF_RECO_INTERLEAVE_RANKER_A: 'ranker_a',
      AURORA_BFF_RECO_INTERLEAVE_RANKER_B: 'ranker_b',
      AURORA_BFF_RECO_ASYNC_POLL_TTL_MS: '30000',
    });
    expect(cfg.dogfood_mode).toBe(true);
    expect(cfg.exploration.enabled).toBe(true);
    expect(cfg.exploration.rate_per_block).toBeCloseTo(0.35);
    expect(cfg.exploration.max_explore_items).toBe(2);
    expect(cfg.interleave.enabled).toBe(true);
    expect(cfg.interleave.rankerA).toBe('ranker_a');
    expect(cfg.interleave.rankerB).toBe('ranker_b');
    expect(cfg.ui.show_employee_feedback_controls).toBe(true);
    expect(cfg.ui.allow_block_internal_rerank_on_async).toBe(true);
    expect(cfg.ui.lock_top_n_on_first_paint).toBe(4);
    expect(cfg.async.poll_ttl_ms).toBe(30000);
    expect(cfg.retrieval.pool_size).toEqual({
      competitors: 900,
      dupes: 420,
      related_products: 510,
    });
  });
});
