function parseBool(value, fallback = false) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'y' || raw === 'on';
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  const out = Number.isFinite(n) ? Math.trunc(n) : fallback;
  return Math.max(min, Math.min(max, out));
}

function clampFloat(value, fallback, min, max) {
  const n = Number(value);
  const out = Number.isFinite(n) ? n : fallback;
  return Math.max(min, Math.min(max, out));
}

function buildRecoDogfoodConfig(env = process.env) {
  const dogfoodMode = parseBool(env.AURORA_BFF_RECO_DOGFOOD_MODE, false);

  const defaultPool = {
    competitors: 120,
    dupes: 80,
    related_products: 80,
  };

  const dogfoodPool = {
    competitors: clampInt(env.AURORA_BFF_RECO_DOGFOOD_POOL_COMPETITORS, 800, 20, 5000),
    dupes: clampInt(env.AURORA_BFF_RECO_DOGFOOD_POOL_DUPES, 400, 20, 3000),
    related_products: clampInt(env.AURORA_BFF_RECO_DOGFOOD_POOL_RELATED_PRODUCTS, 500, 20, 3000),
  };

  const explorationEnabled = parseBool(env.AURORA_BFF_RECO_DOGFOOD_EXPLORATION_ENABLED, true);
  const interleaveEnabled = parseBool(env.AURORA_BFF_RECO_INTERLEAVE_ENABLED, true);
  const prelabelEnabled = parseBool(env.AURORA_BFF_RECO_PRELABEL_ENABLED, true);

  return {
    dogfood_mode: dogfoodMode,
    exploration: {
      enabled: dogfoodMode ? explorationEnabled : false,
      rate_per_block: clampFloat(env.AURORA_BFF_RECO_DOGFOOD_EXPLORATION_RATE_PER_BLOCK, 0.2, 0, 1),
      max_explore_items: clampInt(env.AURORA_BFF_RECO_DOGFOOD_EXPLORATION_MAX_ITEMS, 2, 0, 5),
    },
    ui: {
      show_employee_feedback_controls: dogfoodMode
        ? parseBool(env.AURORA_BFF_RECO_DOGFOOD_UI_SHOW_EMPLOYEE_FEEDBACK_CONTROLS, true)
        : false,
      allow_block_internal_rerank_on_async: dogfoodMode
        ? parseBool(env.AURORA_BFF_RECO_DOGFOOD_UI_ALLOW_BLOCK_INTERNAL_RERANK_ON_ASYNC, true)
        : false,
      lock_top_n_on_first_paint: clampInt(env.AURORA_BFF_RECO_DOGFOOD_UI_LOCK_TOP_N_ON_FIRST_PAINT, 3, 0, 8),
    },
    retrieval: {
      pool_size: dogfoodMode ? dogfoodPool : defaultPool,
    },
    interleave: {
      enabled: dogfoodMode ? interleaveEnabled : false,
      rankerA: String(env.AURORA_BFF_RECO_INTERLEAVE_RANKER_A || 'ranker_v1').trim() || 'ranker_v1',
      rankerB: String(env.AURORA_BFF_RECO_INTERLEAVE_RANKER_B || 'ranker_v2').trim() || 'ranker_v2',
    },
    async: {
      poll_ttl_ms: clampInt(env.AURORA_BFF_RECO_ASYNC_POLL_TTL_MS, 600000, 5000, 3600000),
    },
    prelabel: {
      enabled: dogfoodMode ? prelabelEnabled : false,
      ttl_ms: clampInt(env.AURORA_BFF_RECO_PRELABEL_CACHE_TTL_MS, 24 * 60 * 60 * 1000, 60 * 1000, 7 * 24 * 60 * 60 * 1000),
      timeout_ms: clampInt(env.AURORA_BFF_RECO_PRELABEL_TIMEOUT_MS, 5000, 1000, 20000),
      max_anchors_per_request: clampInt(env.AURORA_BFF_RECO_PRELABEL_MAX_ANCHORS_PER_REQUEST, 1, 1, 10),
      max_candidates_per_block: {
        competitors: clampInt(env.AURORA_BFF_RECO_PRELABEL_MAX_CANDIDATES_PER_BLOCK_COMPETITORS, 10, 1, 40),
        dupes: clampInt(env.AURORA_BFF_RECO_PRELABEL_MAX_CANDIDATES_PER_BLOCK_DUPES, 8, 1, 40),
        related_products: clampInt(env.AURORA_BFF_RECO_PRELABEL_MAX_CANDIDATES_PER_BLOCK_RELATED_PRODUCTS, 10, 1, 40),
      },
    },
  };
}

module.exports = {
  buildRecoDogfoodConfig,
};
