const { routeCandidates } = require('./competitorBlockRouter');
const { attachExplanations } = require('./recoScoreExplain');
const { extractWhitelistedSocialChannels } = require('./socialSummaryUserVisible');
const { teamDraftInterleave } = require('./recoInterleave');
const { selectExplorationCandidates } = require('./recoExploration');
const { runSocialEnrichWorker, getSocialEnrichCacheStats } = require('./socialEnrichWorker');
const {
  recordSocialFetchRequest,
  recordSocialFetchSuccess,
  recordSocialFetchTimeout,
  recordSocialKbBackfill,
  setSocialCacheHitRate,
  setSocialChannelsCoverage,
} = require('./visionMetrics');

const DEFAULT_BUDGET_MS = 1200;
const SOURCE_NAMES = [
  'catalog_ann',
  'ingredient_index',
  'skin_fit_light',
  'kb_backfill',
  'dupe_pipeline',
  'on_page_related',
];
const DEFAULT_TIMEOUTS_MS = {
  catalog_ann: 450,
  ingredient_index: 300,
  skin_fit_light: 240,
  kb_backfill: 220,
  dupe_pipeline: 350,
  on_page_related: 220,
};
const SOURCE_TIMEOUT_GRACE_MS = {
  // Catalog ANN often needs extra time after upstream search returns to normalize and route candidates.
  catalog_ann: 220,
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pickFirstString(...values) {
  for (const value of values) {
    const text = String(value == null ? '' : value).trim();
    if (!text) continue;
    return text;
  }
  return '';
}

function toSafeInt(value, fallback, min, max) {
  const raw = Number(value);
  const n = Number.isFinite(raw) ? Math.trunc(raw) : fallback;
  return Math.max(min, Math.min(max, n));
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function normalizeScore(value, fallback = 0) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n > 1) return clamp01(n / 100);
  return clamp01(n);
}

function normalizeTimeouts(raw) {
  const out = {};
  const src = isPlainObject(raw) ? raw : {};
  for (const source of SOURCE_NAMES) {
    out[source] = toSafeInt(src[source], DEFAULT_TIMEOUTS_MS[source], 40, 8000);
  }
  return out;
}

function normalizeCandidateSource(raw, defaultType) {
  if (isPlainObject(raw) && typeof raw.type === 'string' && raw.type.trim()) {
    return {
      type: raw.type.trim(),
      ...(typeof raw.name === 'string' && raw.name.trim() ? { name: raw.name.trim() } : {}),
      ...(typeof raw.url === 'string' && raw.url.trim() ? { url: raw.url.trim() } : {}),
    };
  }
  if (typeof raw === 'string' && raw.trim()) return { type: raw.trim() };
  return { type: defaultType || 'unknown' };
}

function normalizeCandidate(row, sourceName, defaultSourceType) {
  const item = isPlainObject(row) ? { ...row } : null;
  if (!item) return null;
  const source = normalizeCandidateSource(item.source || item.source_type || item.sourceType, defaultSourceType);
  return {
    ...item,
    source,
    source_type: source.type,
    __dag_source: sourceName,
    similarity_score: Number(normalizeScore(item.similarity_score ?? item.similarityScore, 0.45).toFixed(3)),
  };
}

function normalizeCandidateList(rows, sourceName, defaultSourceType) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const item = normalizeCandidate(row, sourceName, defaultSourceType);
    if (!item) continue;
    out.push(item);
  }
  return out;
}

function normalizeSourceResult(raw, sourceName, defaultSourceType) {
  const obj = isPlainObject(raw) ? raw : {};
  const candidates = normalizeCandidateList(Array.isArray(raw) ? raw : obj.candidates, sourceName, defaultSourceType);
  const competitors = normalizeCandidateList(obj.competitors, sourceName, defaultSourceType);
  const relatedProducts = normalizeCandidateList(
    obj.related_products || obj.relatedProducts || obj.related,
    sourceName,
    'on_page_related',
  );
  const dupes = normalizeCandidateList(obj.dupes, sourceName, defaultSourceType);
  const queries = (Array.isArray(obj.queries) ? obj.queries : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 8);
  return {
    candidates,
    competitors,
    related_products: relatedProducts,
    dupes,
    queries,
    reason: typeof obj.reason === 'string' ? obj.reason : null,
    meta: isPlainObject(obj.meta) ? obj.meta : {},
  };
}

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`timeout:${label}`);
      err.code = 'SOURCE_TIMEOUT';
      reject(err);
    }, timeoutMs);
    Promise.resolve(promise)
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function createEmptyStat() {
  return {
    eligible: 0,
    returned: 0,
    duration_ms: 0,
    timeout: false,
    error: null,
    attempts: 0,
  };
}

function buildAnchorForRouter(anchor) {
  const src = isPlainObject(anchor) ? anchor : {};
  return {
    brand_id:
      src.brand_id ||
      src.brandId ||
      src.brand ||
      src.brand_name ||
      src.brandName ||
      null,
    category_taxonomy: src.category_taxonomy || src.categoryTaxonomy || src.category || src.use_case || src.useCase || null,
    price: src.price || null,
  };
}

function buildAnchorForExplain(anchor, ingredientMeta, skinFitMeta) {
  const ingredientObj = isPlainObject(ingredientMeta) ? ingredientMeta : {};
  const skinObj = isPlainObject(skinFitMeta) ? skinFitMeta : {};
  return {
    ...buildAnchorForRouter(anchor),
    ingredient_tokens: Array.isArray(ingredientObj.key_ingredients) ? ingredientObj.key_ingredients : [],
    profile_skin_tags: Array.isArray(skinObj.profile_skin_tags) ? skinObj.profile_skin_tags : [],
  };
}

function buildCandidateKey(row, index) {
  const item = isPlainObject(row) ? row : {};
  const ref =
    item.product_id ||
    item.productId ||
    item.sku_id ||
    item.skuId ||
    item.id ||
    item.url ||
    item.name ||
    item.display_name ||
    `idx:${index}`;
  return String(ref || `idx:${index}`).trim().toLowerCase();
}

function dedupeCandidates(rows, maxCandidates) {
  const out = [];
  const seen = new Set();
  for (let i = 0; i < (Array.isArray(rows) ? rows : []).length; i += 1) {
    const row = rows[i];
    if (!isPlainObject(row)) continue;
    const key = buildCandidateKey(row, i);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
    if (out.length >= maxCandidates) break;
  }
  return out;
}

function stripInternalCandidateFields(rows, maxCandidates) {
  return dedupeCandidates(rows, maxCandidates).map((row) => {
    const next = { ...row };
    delete next.__dag_source;
    delete next.social_raw;
    delete next.socialRaw;
    delete next.__social_channels_used;
    return next;
  });
}

function extractSourceType(candidate) {
  const row = isPlainObject(candidate) ? candidate : {};
  return String(row?.source?.type || row.source_type || row.sourceType || '')
    .trim()
    .toLowerCase();
}

function addFallbackToken(fallbacks, token) {
  if (!token) return;
  if (fallbacks.includes(token)) return;
  fallbacks.push(token);
}

function collectSocialChannelsFromPools(pools, max = 5) {
  const out = [];
  const seen = new Set();
  for (const pool of Array.isArray(pools) ? pools : []) {
    for (const row of Array.isArray(pool) ? pool : []) {
      const channels = extractWhitelistedSocialChannels(row?.social_raw ?? row?.socialRaw ?? null);
      for (const channel of channels) {
        const key = String(channel || '').trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(key);
        if (out.length >= max) return out;
      }
    }
  }
  return out;
}

function buildConfidenceEntry(score, reasons) {
  const value = Number(clamp01(score).toFixed(3));
  const level = value >= 0.75 ? 'high' : value >= 0.4 ? 'med' : 'low';
  const normalizedReasons = Array.from(new Set((Array.isArray(reasons) ? reasons : []).map((x) => String(x || '').trim()).filter(Boolean)))
    .slice(0, 8);
  return {
    score: value,
    level,
    reasons: normalizedReasons.length ? normalizedReasons : ['confidence_default'],
  };
}

function buildConfidencePatch({ compCount, relCount, dupeCount, timedOutBlocks, fallbacksUsed }) {
  const timeoutPenalty = Math.min(0.18, (Array.isArray(timedOutBlocks) ? timedOutBlocks.length : 0) * 0.05);
  const fallbackPenalty = Math.min(0.12, (Array.isArray(fallbacksUsed) ? fallbacksUsed.length : 0) * 0.03);
  const competitorsScore = compCount
    ? Math.max(0.26, 0.66 - timeoutPenalty - fallbackPenalty)
    : 0.18;
  const competitorReasons = compCount
    ? ['competitor_recall_available']
    : ['all_competitor_recall_failed'];
  if (timedOutBlocks.includes('catalog_ann')) competitorReasons.push('catalog_ann_timeout');
  if (timedOutBlocks.includes('kb_backfill')) competitorReasons.push('kb_backfill_timeout');
  for (const token of fallbacksUsed) competitorReasons.push(`fallback_${token}`);

  const relatedScore = relCount ? 0.64 : 0.4;
  const dupeScore = dupeCount ? 0.6 : 0.35;

  return {
    competitors: buildConfidenceEntry(competitorsScore, competitorReasons),
    related_products: buildConfidenceEntry(
      relatedScore,
      relCount ? ['related_candidates_available'] : ['related_candidates_sparse'],
    ),
    dupes: buildConfidenceEntry(
      dupeScore,
      dupeCount ? ['dupe_candidates_available'] : ['dupe_candidates_sparse'],
    ),
  };
}

function normalizeDogfoodConfig(raw) {
  const src = isPlainObject(raw) ? raw : {};
  const explorationSrc = isPlainObject(src.exploration) ? src.exploration : {};
  const interleaveSrc = isPlainObject(src.interleave) ? src.interleave : {};
  const uiSrc = isPlainObject(src.ui) ? src.ui : {};
  const retrievalSrc = isPlainObject(src.retrieval) ? src.retrieval : {};
  const poolSrc = isPlainObject(retrievalSrc.pool_size) ? retrievalSrc.pool_size : {};
  return {
    dogfood_mode: src.dogfood_mode === true,
    exploration: {
      enabled: explorationSrc.enabled === true,
      rate_per_block: clamp01(explorationSrc.rate_per_block == null ? 0 : explorationSrc.rate_per_block),
      max_explore_items: toSafeInt(explorationSrc.max_explore_items, 0, 0, 5),
    },
    interleave: {
      enabled: interleaveSrc.enabled === true,
      rankerA: String(interleaveSrc.rankerA || 'ranker_v1').trim() || 'ranker_v1',
      rankerB: String(interleaveSrc.rankerB || 'ranker_v2').trim() || 'ranker_v2',
    },
    ui: {
      lock_top_n_on_first_paint: toSafeInt(uiSrc.lock_top_n_on_first_paint, 3, 0, 12),
      show_employee_feedback_controls: uiSrc.show_employee_feedback_controls === true,
      allow_block_internal_rerank_on_async: uiSrc.allow_block_internal_rerank_on_async === true,
    },
    retrieval: {
      pool_size: {
        competitors: toSafeInt(poolSrc.competitors, 120, 1, 5000),
        dupes: toSafeInt(poolSrc.dupes, 80, 1, 3000),
        related_products: toSafeInt(poolSrc.related_products, 80, 1, 3000),
      },
    },
  };
}

function scoreTotalOf(row) {
  return normalizeScore(
    row?.score_breakdown?.score_total ?? row?.similarity_score ?? row?.similarityScore,
    0,
  );
}

function sortByRankerA(rows) {
  return (Array.isArray(rows) ? rows : [])
    .slice()
    .sort((a, b) => {
      const sa = scoreTotalOf(a);
      const sb = scoreTotalOf(b);
      if (sb !== sa) return sb - sa;
      return String(a?.name || '').localeCompare(String(b?.name || ''));
    });
}

function sortByRankerB(rows, block) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  return list.sort((a, b) => {
    const socialA = normalizeScore(a?.score_breakdown?.social_reference_strength, 0);
    const socialB = normalizeScore(b?.score_breakdown?.social_reference_strength, 0);
    const priceA = normalizeScore(a?.score_breakdown?.price_distance, 0);
    const priceB = normalizeScore(b?.score_breakdown?.price_distance, 0);
    const ingredientA = normalizeScore(a?.score_breakdown?.ingredient_functional_similarity, 0);
    const ingredientB = normalizeScore(b?.score_breakdown?.ingredient_functional_similarity, 0);
    const categoryA = normalizeScore(a?.score_breakdown?.category_use_case_match, 0);
    const categoryB = normalizeScore(b?.score_breakdown?.category_use_case_match, 0);

    const rankBScoreA =
      (block === 'related_products' ? socialA * 0.45 + categoryA * 0.35 + priceA * 0.2 : 0) +
      (block === 'dupes' ? priceA * 0.55 + ingredientA * 0.25 + socialA * 0.2 : 0) +
      (block === 'competitors' ? socialA * 0.5 + ingredientA * 0.35 + categoryA * 0.15 : 0);
    const rankBScoreB =
      (block === 'related_products' ? socialB * 0.45 + categoryB * 0.35 + priceB * 0.2 : 0) +
      (block === 'dupes' ? priceB * 0.55 + ingredientB * 0.25 + socialB * 0.2 : 0) +
      (block === 'competitors' ? socialB * 0.5 + ingredientB * 0.35 + categoryB * 0.15 : 0);

    if (rankBScoreB !== rankBScoreA) return rankBScoreB - rankBScoreA;
    return String(a?.name || '').localeCompare(String(b?.name || ''));
  });
}

function buildTrackingMapByBlock(rowsByBlock, interleaveAttributionByBlock, explorationKeysByBlock) {
  const out = {};
  for (const [block, rows] of Object.entries(rowsByBlock || {})) {
    const attr = isPlainObject(interleaveAttributionByBlock?.[block]) ? interleaveAttributionByBlock[block] : {};
    const exploreSet = new Set(Array.isArray(explorationKeysByBlock?.[block]) ? explorationKeysByBlock[block] : []);
    const blockMap = {};
    for (let i = 0; i < (Array.isArray(rows) ? rows : []).length; i += 1) {
      const row = rows[i];
      const key = buildCandidateKey(row, i);
      if (!key) continue;
      blockMap[key] = {
        attribution: ['A', 'B', 'both', 'explore'].includes(String(attr[key] || '')) ? attr[key] : 'both',
        was_exploration_slot: exploreSet.has(key),
        rank_position: i + 1,
      };
    }
    out[block] = blockMap;
  }
  return out;
}

function applyLightweightRerank(candidates, { ingredientIndexPresent = false, skinFitPresent = false } = {}) {
  const rows = Array.isArray(candidates) ? candidates : [];
  return rows
    .map((row) => {
      const item = isPlainObject(row) ? { ...row } : null;
      if (!item) return null;
      const breakdown = isPlainObject(item.score_breakdown) ? item.score_breakdown : {};
      const base = normalizeScore(item.similarity_score ?? item.similarityScore, 0.4);
      const ingredientSimilarity = normalizeScore(
        breakdown.ingredient_functional_similarity ?? breakdown.ingredient_similarity ?? breakdown.ingredientSimilarity,
        0,
      );
      const skinFitSimilarity = normalizeScore(
        breakdown.skin_fit_similarity ?? breakdown.skinFitSimilarity,
        0,
      );
      const socialScore = normalizeScore(
        breakdown.social_reference_strength ?? breakdown.social_reference_score ?? breakdown.socialReferenceScore,
        0,
      );
      const boost = (ingredientIndexPresent ? ingredientSimilarity * 0.08 : 0)
        + (skinFitPresent ? skinFitSimilarity * 0.06 : 0)
        + socialScore * 0.02;
      item.similarity_score = Number(clamp01(base + boost).toFixed(3));
      return item;
    })
    .filter(Boolean)
    .sort((a, b) => {
      const sa = normalizeScore(a?.similarity_score, 0);
      const sb = normalizeScore(b?.similarity_score, 0);
      if (sb !== sa) return sb - sa;
      return String(a?.name || '').localeCompare(String(b?.name || ''));
    });
}

async function executeSource({
  sourceName,
  sourceFn,
  anchor,
  ctx,
  timeoutMs,
  budgetMs,
  deadlineMs,
  defaultSourceType,
  diagnostics,
}) {
  const stat = diagnostics.blocks[sourceName] || createEmptyStat();
  diagnostics.blocks[sourceName] = stat;

  if (typeof sourceFn !== 'function') {
    stat.error = stat.error || 'source_not_configured';
    return normalizeSourceResult({}, sourceName, defaultSourceType);
  }

  const now = Date.now();
  const timeLeft = deadlineMs - now;
  if (timeLeft <= 0) {
    stat.timeout = true;
    stat.error = stat.error || 'budget_exhausted';
    if (!diagnostics.timed_out_blocks.includes(sourceName)) diagnostics.timed_out_blocks.push(sourceName);
    return normalizeSourceResult({}, sourceName, defaultSourceType);
  }

  const sourceTimeoutMs = Math.max(30, Math.min(timeoutMs, timeLeft));
  const timeoutGraceMs = sourceTimeoutMs >= 180
    ? toSafeInt(SOURCE_TIMEOUT_GRACE_MS[sourceName], 0, 0, 2000)
    : 0;
  const wrapperTimeoutMs = Math.max(30, Math.min(timeLeft, sourceTimeoutMs + timeoutGraceMs));
  const startedAt = Date.now();
  stat.attempts += 1;
  try {
    const raw = await withTimeout(
      Promise.resolve().then(() =>
        sourceFn({
          anchor,
          ctx,
          timeout_ms: sourceTimeoutMs,
          deadline_ms: deadlineMs,
          budget_ms: budgetMs,
          source_name: sourceName,
        }),
      ),
      wrapperTimeoutMs,
      sourceName,
    );
    const out = normalizeSourceResult(raw, sourceName, defaultSourceType);
    stat.eligible += out.candidates.length + out.competitors.length + out.related_products.length + out.dupes.length;
    stat.duration_ms += Date.now() - startedAt;
    return out;
  } catch (err) {
    stat.duration_ms += Date.now() - startedAt;
    const code = String(err?.code || '').trim();
    if (code === 'SOURCE_TIMEOUT') {
      stat.timeout = true;
      if (!diagnostics.timed_out_blocks.includes(sourceName)) diagnostics.timed_out_blocks.push(sourceName);
      stat.error = 'timeout';
    } else {
      stat.error = String(err?.message || err || 'source_failed').slice(0, 160);
    }
    return normalizeSourceResult({}, sourceName, defaultSourceType);
  }
}

function countReturnedBySource(blocks, sourceName) {
  let total = 0;
  const lists = [
    blocks?.competitors?.candidates,
    blocks?.related_products?.candidates,
    blocks?.dupes?.candidates,
  ];
  for (const rows of lists) {
    for (const row of Array.isArray(rows) ? rows : []) {
      if (String(row?.__dag_source || '').trim() === sourceName) total += 1;
    }
  }
  return total;
}

async function recoBlocks(anchor, ctx = {}, budgetMs = DEFAULT_BUDGET_MS) {
  const mode = typeof ctx.mode === 'string' && ctx.mode.trim() ? ctx.mode.trim() : 'main_path';
  const onPageMode = typeof ctx.on_page_mode === 'string' && ctx.on_page_mode.trim()
    ? ctx.on_page_mode.trim()
    : 'fallback_only';
  const logger = ctx.logger && typeof ctx.logger === 'object' ? ctx.logger : null;
  const sources = isPlainObject(ctx.sources) ? ctx.sources : {};
  const timeouts = normalizeTimeouts(ctx.timeouts_ms);
  const routerCtx = {
    allow_same_brand_competitors: false,
    allow_same_brand_dupes: false,
    ...(isPlainObject(ctx.router_ctx) ? ctx.router_ctx : {}),
  };
  const outputMaxCandidates = toSafeInt(
    ctx.max_candidates,
    Number(process.env.AURORA_BFF_PRODUCT_URL_COMPETITOR_MAX_CANDIDATES || 4),
    1,
    10,
  );
  const dogfoodConfig = normalizeDogfoodConfig(ctx.dogfood_config);
  const poolSize = {
    competitors: toSafeInt(
      ctx.pool_size?.competitors,
      dogfoodConfig.retrieval.pool_size.competitors,
      1,
      5000,
    ),
    dupes: toSafeInt(
      ctx.pool_size?.dupes,
      dogfoodConfig.retrieval.pool_size.dupes,
      1,
      3000,
    ),
    related_products: toSafeInt(
      ctx.pool_size?.related_products,
      dogfoodConfig.retrieval.pool_size.related_products,
      1,
      3000,
    ),
  };
  const finalCapByBlock = {
    competitors: Math.max(
      1,
      Math.min(
        12,
        outputMaxCandidates + (dogfoodConfig.dogfood_mode && dogfoodConfig.exploration.enabled ? dogfoodConfig.exploration.max_explore_items : 0),
      ),
    ),
    dupes: Math.max(
      1,
      Math.min(
        12,
        outputMaxCandidates + (dogfoodConfig.dogfood_mode && dogfoodConfig.exploration.enabled ? dogfoodConfig.exploration.max_explore_items : 0),
      ),
    ),
    related_products: Math.max(
      1,
      Math.min(
        12,
        outputMaxCandidates + (dogfoodConfig.dogfood_mode && dogfoodConfig.exploration.enabled ? dogfoodConfig.exploration.max_explore_items : 0),
      ),
    ),
  };
  const totalBudgetMs = toSafeInt(budgetMs, DEFAULT_BUDGET_MS, 120, 12000);
  const deadlineMs = Date.now() + totalBudgetMs;
  const diagnostics = {
    mode,
    on_page_mode: onPageMode,
    budget_ms: totalBudgetMs,
    blocks: {},
    timed_out_blocks: [],
    fallbacks_used: [],
    interleave_enabled: false,
    exploration_enabled: false,
    exploration_inserted_count_by_block: {},
  };

  for (const source of SOURCE_NAMES) diagnostics.blocks[source] = createEmptyStat();

  const defaultSourceTypeBySource = {
    catalog_ann: 'catalog_search',
    ingredient_index: 'ingredient_index',
    skin_fit_light: 'skin_fit_light',
    kb_backfill: 'kb_backfill',
    dupe_pipeline: 'dupe_pipeline',
    on_page_related: 'on_page_related',
  };

  const stageA = await Promise.all([
    executeSource({
      sourceName: 'catalog_ann',
      sourceFn: sources.catalog_ann,
      anchor,
      ctx,
      timeoutMs: timeouts.catalog_ann,
      budgetMs: totalBudgetMs,
      deadlineMs,
      defaultSourceType: defaultSourceTypeBySource.catalog_ann,
      diagnostics,
    }),
    executeSource({
      sourceName: 'ingredient_index',
      sourceFn: sources.ingredient_index,
      anchor,
      ctx,
      timeoutMs: timeouts.ingredient_index,
      budgetMs: totalBudgetMs,
      deadlineMs,
      defaultSourceType: defaultSourceTypeBySource.ingredient_index,
      diagnostics,
    }),
    executeSource({
      sourceName: 'skin_fit_light',
      sourceFn: sources.skin_fit_light,
      anchor,
      ctx,
      timeoutMs: timeouts.skin_fit_light,
      budgetMs: totalBudgetMs,
      deadlineMs,
      defaultSourceType: defaultSourceTypeBySource.skin_fit_light,
      diagnostics,
    }),
    executeSource({
      sourceName: 'kb_backfill',
      sourceFn: sources.kb_backfill,
      anchor,
      ctx,
      timeoutMs: timeouts.kb_backfill,
      budgetMs: totalBudgetMs,
      deadlineMs,
      defaultSourceType: defaultSourceTypeBySource.kb_backfill,
      diagnostics,
    }),
    executeSource({
      sourceName: 'dupe_pipeline',
      sourceFn: sources.dupe_pipeline,
      anchor,
      ctx,
      timeoutMs: timeouts.dupe_pipeline,
      budgetMs: totalBudgetMs,
      deadlineMs,
      defaultSourceType: defaultSourceTypeBySource.dupe_pipeline,
      diagnostics,
    }),
  ]);

  const stageResult = {
    catalog_ann: stageA[0],
    ingredient_index: stageA[1],
    skin_fit_light: stageA[2],
    kb_backfill: stageA[3],
    dupe_pipeline: stageA[4],
  };

  const baseCandidates = [
    ...stageResult.catalog_ann.candidates,
    ...stageResult.ingredient_index.candidates,
    ...stageResult.skin_fit_light.candidates,
    ...stageResult.kb_backfill.competitors,
    ...stageResult.kb_backfill.candidates,
    ...stageResult.dupe_pipeline.candidates,
  ];
  const rerankedCandidates = applyLightweightRerank(baseCandidates, {
    ingredientIndexPresent:
      stageResult.ingredient_index.candidates.length > 0 ||
      Object.keys(stageResult.ingredient_index.meta || {}).length > 0,
    skinFitPresent:
      stageResult.skin_fit_light.candidates.length > 0 ||
      Object.keys(stageResult.skin_fit_light.meta || {}).length > 0,
  });

  let routed = routeCandidates(buildAnchorForRouter(anchor), rerankedCandidates, routerCtx);
  let compPool = Array.isArray(routed?.comp_pool) ? [...routed.comp_pool] : [];
  let relPool = Array.isArray(routed?.rel_pool) ? [...routed.rel_pool] : [];
  let dupePool = Array.isArray(routed?.dupe_pool) ? [...routed.dupe_pool] : [];

  const needCompetitorFallback = !compPool.length || diagnostics.blocks.catalog_ann.timeout || diagnostics.blocks.kb_backfill.timeout;
  if (needCompetitorFallback) {
    if (!compPool.length || diagnostics.blocks.kb_backfill.timeout) {
      addFallbackToken(diagnostics.fallbacks_used, 'kb_or_cache_competitors');
      const kbRetry = await executeSource({
        sourceName: 'kb_backfill',
        sourceFn: sources.kb_backfill,
        anchor,
        ctx,
        timeoutMs: Math.max(120, timeouts.kb_backfill),
        budgetMs: totalBudgetMs,
        deadlineMs,
        defaultSourceType: defaultSourceTypeBySource.kb_backfill,
        diagnostics,
      });
      if (kbRetry.competitors.length || kbRetry.candidates.length) {
        const merged = applyLightweightRerank(
          [...rerankedCandidates, ...kbRetry.competitors, ...kbRetry.candidates],
          {
            ingredientIndexPresent: true,
            skinFitPresent: true,
          },
        );
        routed = routeCandidates(buildAnchorForRouter(anchor), merged, routerCtx);
        compPool = Array.isArray(routed?.comp_pool) ? [...routed.comp_pool] : [];
        relPool = Array.isArray(routed?.rel_pool) ? [...routed.rel_pool] : [];
        dupePool = Array.isArray(routed?.dupe_pool) ? [...routed.dupe_pool] : [];
      }
    }
    if (!compPool.length || diagnostics.blocks.catalog_ann.timeout) {
      addFallbackToken(diagnostics.fallbacks_used, 'fast_ann_competitors');
      const annRetryTimeoutMs = diagnostics.blocks.catalog_ann.timeout && timeouts.catalog_ann >= 180
        ? Math.max(220, timeouts.catalog_ann + 220)
        : Math.max(140, timeouts.catalog_ann);
      const annRetry = await executeSource({
        sourceName: 'catalog_ann',
        sourceFn: sources.catalog_ann,
        anchor,
        ctx,
        timeoutMs: annRetryTimeoutMs,
        budgetMs: totalBudgetMs,
        deadlineMs,
        defaultSourceType: defaultSourceTypeBySource.catalog_ann,
        diagnostics,
      });
      if (annRetry.candidates.length) {
        const merged = applyLightweightRerank(
          [...rerankedCandidates, ...annRetry.candidates],
          {
            ingredientIndexPresent: true,
            skinFitPresent: true,
          },
        );
        routed = routeCandidates(buildAnchorForRouter(anchor), merged, routerCtx);
        compPool = Array.isArray(routed?.comp_pool) ? [...routed.comp_pool] : [];
        relPool = Array.isArray(routed?.rel_pool) ? [...routed.rel_pool] : [];
        dupePool = Array.isArray(routed?.dupe_pool) ? [...routed.dupe_pool] : [];
      }
    }
  }

  if (!relPool.length && onPageMode === 'fallback_only') {
    addFallbackToken(diagnostics.fallbacks_used, 'related_on_page_fallback');
    const onPageResult = await executeSource({
      sourceName: 'on_page_related',
      sourceFn: sources.on_page_related,
      anchor,
      ctx,
      timeoutMs: timeouts.on_page_related,
      budgetMs: totalBudgetMs,
      deadlineMs,
      defaultSourceType: defaultSourceTypeBySource.on_page_related,
      diagnostics,
    });
    if (onPageResult.candidates.length || onPageResult.related_products.length) {
      const onPageCandidates = [...onPageResult.candidates, ...onPageResult.related_products];
      const onPageRouted = routeCandidates(buildAnchorForRouter(anchor), onPageCandidates, routerCtx);
      relPool = dedupeCandidates(
        [...relPool, ...(Array.isArray(onPageRouted?.rel_pool) ? onPageRouted.rel_pool : [])],
        poolSize.related_products,
      );
    }
  }

  if (!dupePool.length) {
    addFallbackToken(diagnostics.fallbacks_used, 'kb_backfill_dupes');
    const kbDupes = stageResult.kb_backfill.dupes;
    if (kbDupes.length) {
      const dupeRouted = routeCandidates(buildAnchorForRouter(anchor), kbDupes, routerCtx);
      const nextDupes = Array.isArray(dupeRouted?.dupe_pool) ? dupeRouted.dupe_pool : [];
      if (nextDupes.length) {
        dupePool = dedupeCandidates(nextDupes, poolSize.dupes);
      }
    }
  }

  compPool = compPool.filter((row) => extractSourceType(row) !== 'on_page_related');
  dupePool = dupePool.filter((row) => extractSourceType(row) !== 'on_page_related');
  compPool = dedupeCandidates(compPool, poolSize.competitors);
  relPool = dedupeCandidates(relPool, poolSize.related_products);
  dupePool = dedupeCandidates(dupePool, poolSize.dupes);
  const socialChannelsUsed = collectSocialChannelsFromPools([compPool, relPool, dupePool], 5);

  const explainAnchor = buildAnchorForExplain(
    anchor,
    stageResult.ingredient_index?.meta,
    stageResult.skin_fit_light?.meta,
  );
  const explainOpts = {
    lang: ctx.lang || 'EN',
    max_evidence_refs: 6,
  };
  compPool = attachExplanations('competitors', explainAnchor, compPool, explainOpts);
  relPool = attachExplanations('related_products', explainAnchor, relPool, explainOpts);
  dupePool = attachExplanations('dupes', explainAnchor, dupePool, explainOpts);

  let rowsByBlock = {
    competitors: sortByRankerA(compPool),
    related_products: sortByRankerA(relPool),
    dupes: sortByRankerA(dupePool),
  };
  let interleaveAttributionByBlock = {
    competitors: {},
    related_products: {},
    dupes: {},
  };
  let explorationKeysByBlock = {
    competitors: [],
    related_products: [],
    dupes: [],
  };

  const interleaveEnabled = Boolean(dogfoodConfig.dogfood_mode && dogfoodConfig.interleave.enabled);
  if (interleaveEnabled) {
    diagnostics.interleave_enabled = true;
    const seedBase = `${mode}:${pickFirstString(anchor?.brand_id, anchor?.brandId, anchor?.brand, 'unknown')}`;
    for (const blockName of ['competitors', 'related_products', 'dupes']) {
      const rankedA = sortByRankerA(rowsByBlock[blockName]);
      const rankedB = sortByRankerB(rowsByBlock[blockName], blockName);
      const interleave = teamDraftInterleave({
        rankedA,
        rankedB,
        limit: poolSize[blockName] || rankedA.length,
        seed: `${seedBase}:${blockName}`,
      });
      rowsByBlock[blockName] = Array.isArray(interleave.interleaved) ? interleave.interleaved : rankedA;
      interleaveAttributionByBlock[blockName] = isPlainObject(interleave.attribution) ? interleave.attribution : {};
    }
  } else {
    for (const blockName of ['competitors', 'related_products', 'dupes']) {
      const defaultAttr = {};
      for (let i = 0; i < rowsByBlock[blockName].length; i += 1) {
        const key = buildCandidateKey(rowsByBlock[blockName][i], i);
        defaultAttr[key] = 'both';
      }
      interleaveAttributionByBlock[blockName] = defaultAttr;
    }
  }

  const explorationEnabled = Boolean(dogfoodConfig.dogfood_mode && dogfoodConfig.exploration.enabled);
  if (explorationEnabled) {
    diagnostics.exploration_enabled = true;
    for (const blockName of ['competitors', 'related_products', 'dupes']) {
      const selection = selectExplorationCandidates({
        block: blockName,
        ranked: rowsByBlock[blockName],
        gatedPool: rowsByBlock[blockName],
        ratePerBlock: dogfoodConfig.exploration.rate_per_block,
        maxExploreItems: dogfoodConfig.exploration.max_explore_items,
      });
      rowsByBlock[blockName] = Array.isArray(selection.list) ? selection.list : rowsByBlock[blockName];
      explorationKeysByBlock[blockName] = Array.from(selection.explorationKeys || []);
      diagnostics.exploration_inserted_count_by_block[blockName] = Number(selection.insertedCount || 0);
      for (const key of explorationKeysByBlock[blockName]) {
        if (!interleaveAttributionByBlock[blockName][key]) interleaveAttributionByBlock[blockName][key] = 'explore';
      }
    }
  } else {
    diagnostics.exploration_inserted_count_by_block = {
      competitors: 0,
      related_products: 0,
      dupes: 0,
    };
  }

  rowsByBlock.competitors = rowsByBlock.competitors.filter((row) => extractSourceType(row) !== 'on_page_related');
  rowsByBlock.dupes = rowsByBlock.dupes.filter((row) => extractSourceType(row) !== 'on_page_related');

  const blocksWithInternal = {
    competitors: { candidates: dedupeCandidates(rowsByBlock.competitors, finalCapByBlock.competitors) },
    related_products: { candidates: dedupeCandidates(rowsByBlock.related_products, finalCapByBlock.related_products) },
    dupes: { candidates: dedupeCandidates(rowsByBlock.dupes, finalCapByBlock.dupes) },
  };
  const trackingByBlock = buildTrackingMapByBlock(
    {
      competitors: blocksWithInternal.competitors.candidates,
      related_products: blocksWithInternal.related_products.candidates,
      dupes: blocksWithInternal.dupes.candidates,
    },
    interleaveAttributionByBlock,
    explorationKeysByBlock,
  );

  for (const sourceName of SOURCE_NAMES) {
    diagnostics.blocks[sourceName].returned = countReturnedBySource(blocksWithInternal, sourceName);
    if (!Number.isFinite(diagnostics.blocks[sourceName].duration_ms)) diagnostics.blocks[sourceName].duration_ms = 0;
  }

  const confidencePatch = buildConfidencePatch({
    compCount: blocksWithInternal.competitors.candidates.length,
    relCount: blocksWithInternal.related_products.candidates.length,
    dupeCount: blocksWithInternal.dupes.candidates.length,
    timedOutBlocks: diagnostics.timed_out_blocks,
    fallbacksUsed: diagnostics.fallbacks_used,
  });

  const provenancePatch = {
    pipeline: 'reco_blocks_dag.v1',
    validation_mode: 'soft_fail',
    timed_out_blocks: diagnostics.timed_out_blocks.slice(0, 8),
    fallbacks_used: diagnostics.fallbacks_used.slice(0, 12),
    block_stats: Object.fromEntries(
      Object.entries(diagnostics.blocks).map(([key, value]) => [
        key,
        {
          eligible: Number(value.eligible || 0),
          returned: Number(value.returned || 0),
          timeout: value.timeout === true,
          duration_ms: Number(value.duration_ms || 0),
          ...(value.error ? { error: value.error } : {}),
        },
      ]),
    ),
    mode,
    on_page_mode: onPageMode,
    dogfood_mode: dogfoodConfig.dogfood_mode,
    dogfood_features_effective: {
      interleave: diagnostics.interleave_enabled,
      exploration: diagnostics.exploration_enabled,
      async_rerank: Boolean(dogfoodConfig.ui.allow_block_internal_rerank_on_async && dogfoodConfig.dogfood_mode),
      show_employee_feedback_controls: Boolean(dogfoodConfig.ui.show_employee_feedback_controls && dogfoodConfig.dogfood_mode),
    },
    interleave: {
      enabled: diagnostics.interleave_enabled,
      rankerA: dogfoodConfig.interleave.rankerA,
      rankerB: dogfoodConfig.interleave.rankerB,
    },
    exploration_inserted_count_by_block: diagnostics.exploration_inserted_count_by_block,
    ...(socialChannelsUsed.length ? { social_channels_used: socialChannelsUsed } : {}),
  };

  logger?.info?.(
    {
      mode,
      budget_ms: totalBudgetMs,
      timed_out_blocks: diagnostics.timed_out_blocks,
      fallbacks_used: diagnostics.fallbacks_used,
      block_stats: provenancePatch.block_stats,
    },
    'aurora bff: reco blocks dag completed',
  );

  return {
    competitors: { candidates: stripInternalCandidateFields(blocksWithInternal.competitors.candidates, finalCapByBlock.competitors) },
    related_products: { candidates: stripInternalCandidateFields(blocksWithInternal.related_products.candidates, finalCapByBlock.related_products) },
    dupes: { candidates: stripInternalCandidateFields(blocksWithInternal.dupes.candidates, finalCapByBlock.dupes) },
    diagnostics,
    provenance_patch: provenancePatch,
    confidence_patch: confidencePatch,
    tracking: {
      by_block: trackingByBlock,
      exploration_keys_by_block: explorationKeysByBlock,
      interleave_attribution_by_block: interleaveAttributionByBlock,
    },
    internal_reason_codes: Array.isArray(routed?.internal_reason_codes) ? routed.internal_reason_codes : [],
    catalog_queries: Array.from(
      new Set([
        ...stageResult.catalog_ann.queries,
      ]),
    ),
  };
}

function social_enrich_async(input = {}) {
  const logger = isPlainObject(input) && isPlainObject(input.logger) ? input.logger : null;
  const mode = pickFirstString(input.mode, 'main_path') || 'main_path';
  setImmediate(() => {
    void (async () => {
      recordSocialFetchRequest({ mode });
      let out = null;
      try {
        out = await runSocialEnrichWorker({
          payload: isPlainObject(input.payload) ? input.payload : null,
          logger,
          lang: pickFirstString(input.lang, 'EN') || 'EN',
          mode,
          anchor_product: isPlainObject(input.anchor_product) ? input.anchor_product : null,
          profile_summary: isPlainObject(input.profile_summary) ? input.profile_summary : null,
          kb_key: pickFirstString(input.kb_key),
          source: pickFirstString(input.source),
          source_meta: isPlainObject(input.source_meta) ? input.source_meta : null,
          skip_kb_write: input.skip_kb_write === true,
          timeout_ms: input.timeout_ms,
          ...(typeof input.fetch_fn === 'function' ? { fetch_fn: input.fetch_fn } : {}),
          ...(typeof input.apply_async_patch === 'function' ? { apply_async_patch: input.apply_async_patch } : {}),
          ...(typeof input.on_async_update === 'function' ? { on_async_update: input.on_async_update } : {}),
        });
      } catch (err) {
        logger?.warn?.(
          {
            mode,
            err: err?.message || String(err),
          },
          'aurora bff: social_enrich_async failed',
        );
      }

      const cacheStats = getSocialEnrichCacheStats();
      if (cacheStats && Number.isFinite(Number(cacheStats.hit_rate))) {
        setSocialCacheHitRate(Number(cacheStats.hit_rate));
      }

      if (out && Array.isArray(out.channels_used)) {
        const coverage = Math.max(0, Math.min(1, out.channels_used.length / 5));
        setSocialChannelsCoverage(coverage);
      }

      if (out && out.ok) {
        recordSocialFetchSuccess({ mode });
        if (out.kb_backfilled) recordSocialKbBackfill({ mode });
        logger?.info?.(
          {
            mode,
            reason: out.reason || null,
            from_cache: out.from_cache === true,
            fetch_status: out.fetch_status || 'ok',
            source_version: out.source_version || null,
            channels_used: Array.isArray(out.channels_used) ? out.channels_used : [],
            changed_blocks: Array.isArray(out.changed_blocks) ? out.changed_blocks : [],
            kb_backfilled: out.kb_backfilled === true,
          },
          'aurora bff: social_enrich_async applied',
        );
        return;
      }

      const reason = String(out?.reason || '').trim().toLowerCase();
      if (reason.includes('timeout')) recordSocialFetchTimeout({ mode });
      logger?.info?.(
        {
          mode,
          reason: out?.reason || 'unknown',
          from_cache: out?.from_cache === true,
          fetch_status: out?.fetch_status || 'skipped',
          channels_used: Array.isArray(out?.channels_used) ? out.channels_used : [],
        },
        'aurora bff: social_enrich_async skipped',
      );
    })();
  });
}

function skin_fit_heavy_async(input = {}) {
  const logger = isPlainObject(input) && isPlainObject(input.logger) ? input.logger : null;
  setImmediate(() => {
    logger?.info?.(
      {
        url: input.product_url || null,
        mode: input.mode || 'main_path',
      },
      'aurora bff: skin_fit_heavy_async stub scheduled',
    );
  });
}

module.exports = {
  recoBlocks,
  social_enrich_async,
  skin_fit_heavy_async,
};
