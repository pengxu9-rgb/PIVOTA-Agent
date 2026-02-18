const { routeCandidates } = require('./competitorBlockRouter');

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

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

function applyLightweightRerank(candidates, { ingredientIndexPresent = false, skinFitPresent = false } = {}) {
  const rows = Array.isArray(candidates) ? candidates : [];
  return rows
    .map((row) => {
      const item = isPlainObject(row) ? { ...row } : null;
      if (!item) return null;
      const breakdown = isPlainObject(item.score_breakdown) ? item.score_breakdown : {};
      const base = normalizeScore(item.similarity_score ?? item.similarityScore, 0.4);
      const ingredientSimilarity = normalizeScore(
        breakdown.ingredient_similarity ?? breakdown.ingredientSimilarity,
        0,
      );
      const skinFitSimilarity = normalizeScore(
        breakdown.skin_fit_similarity ?? breakdown.skinFitSimilarity,
        0,
      );
      const socialScore = normalizeScore(
        breakdown.social_reference_score ?? breakdown.socialReferenceScore,
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

  const boundedTimeout = Math.max(30, Math.min(timeoutMs, timeLeft));
  const startedAt = Date.now();
  stat.attempts += 1;
  try {
    const raw = await withTimeout(
      Promise.resolve().then(() =>
        sourceFn({
          anchor,
          ctx,
          timeout_ms: boundedTimeout,
          deadline_ms: deadlineMs,
          budget_ms: budgetMs,
          source_name: sourceName,
        }),
      ),
      boundedTimeout,
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
  const maxCandidates = toSafeInt(
    ctx.max_candidates,
    Number(process.env.AURORA_BFF_PRODUCT_URL_COMPETITOR_MAX_CANDIDATES || 4),
    1,
    10,
  );
  const totalBudgetMs = toSafeInt(budgetMs, DEFAULT_BUDGET_MS, 120, 12000);
  const deadlineMs = Date.now() + totalBudgetMs;
  const diagnostics = {
    mode,
    on_page_mode: onPageMode,
    budget_ms: totalBudgetMs,
    blocks: {},
    timed_out_blocks: [],
    fallbacks_used: [],
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
      const annRetry = await executeSource({
        sourceName: 'catalog_ann',
        sourceFn: sources.catalog_ann,
        anchor,
        ctx,
        timeoutMs: Math.max(140, timeouts.catalog_ann),
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
        maxCandidates,
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
        dupePool = dedupeCandidates(nextDupes, maxCandidates);
      }
    }
  }

  compPool = compPool.filter((row) => extractSourceType(row) !== 'on_page_related');
  dupePool = dupePool.filter((row) => extractSourceType(row) !== 'on_page_related');

  const blocksWithInternal = {
    competitors: { candidates: dedupeCandidates(compPool, maxCandidates) },
    related_products: { candidates: dedupeCandidates(relPool, maxCandidates) },
    dupes: { candidates: dedupeCandidates(dupePool, maxCandidates) },
  };

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
    competitors: { candidates: stripInternalCandidateFields(blocksWithInternal.competitors.candidates, maxCandidates) },
    related_products: { candidates: stripInternalCandidateFields(blocksWithInternal.related_products.candidates, maxCandidates) },
    dupes: { candidates: stripInternalCandidateFields(blocksWithInternal.dupes.candidates, maxCandidates) },
    diagnostics,
    provenance_patch: provenancePatch,
    confidence_patch: confidencePatch,
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
  setImmediate(() => {
    logger?.info?.(
      {
        url: input.product_url || null,
        mode: input.mode || 'main_path',
      },
      'aurora bff: social_enrich_async stub scheduled',
    );
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
