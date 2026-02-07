const axios = require('axios');
const { withClient } = require('../db');

const EXTERNAL_SEED_MERCHANT_ID = 'external_seed';

function clampInt(value, { min, max, fallback }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const v = Math.trunc(n);
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

function normalizeTextForResolver(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';

  // Normalizations:
  // - NFKC collapses full-width variants (e.g. Chinese punctuation, full-width digits).
  // - Map common symbols to lexical tokens so "+" and "%" can match across variants.
  // - Keep unicode letters/numbers (including CJK), drop other punctuation.
  const normalized = raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[＋+]/g, ' plus ')
    .replace(/[%％]/g, ' percent ')
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized;
}

function tokenizeNormalizedResolverQuery(normalized) {
  const s = String(normalized || '').trim();
  if (!s) return [];
  const parts = s.split(/\s+/g).filter(Boolean);
  if (!parts.length) return [];

  const stop = new Set([
    'a',
    'an',
    'and',
    'are',
    'as',
    'at',
    'be',
    'by',
    'for',
    'from',
    'have',
    'i',
    'in',
    'is',
    'it',
    'of',
    'on',
    'or',
    'the',
    'this',
    'to',
    'with',
    'you',
    'your',
  ]);

  const out = [];
  const seen = new Set();
  for (const tok of parts) {
    const t = String(tok || '').trim();
    if (!t) continue;

    const isNumeric = /^[0-9]+$/.test(t);
    const isLatin = /^[a-z0-9]+$/.test(t);
    if (isLatin && !isNumeric) {
      if (stop.has(t)) continue;
      if (t.length < 2) continue;
    }

    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 12) break;
  }

  return out;
}

function isExternalProduct(product) {
  const mid = String(product?.merchant_id || product?.merchantId || '').trim();
  if (mid === EXTERNAL_SEED_MERCHANT_ID) return true;
  const platform = String(product?.platform || '').trim().toLowerCase();
  if (platform === 'external') return true;
  const source = String(product?.source || product?.source_type || '').trim().toLowerCase();
  if (source === 'external_seed' || source === 'external') return true;
  const pid = String(product?.product_id || product?.productId || product?.id || '').trim();
  return pid.startsWith('ext_');
}

function getCandidateTitle(product) {
  return (
    product?.title ||
    product?.name ||
    product?.display_name ||
    product?.displayName ||
    product?.product_title ||
    product?.productTitle ||
    ''
  );
}

function getCandidateBrand(product) {
  return (
    (product?.brand && typeof product.brand === 'object' ? product.brand.name : null) ||
    product?.brand ||
    product?.vendor ||
    product?.vendor_name ||
    product?.manufacturer ||
    ''
  );
}

function extractProductRef(product) {
  const productId = String(product?.product_id || product?.productId || product?.id || '').trim();
  const merchantId = String(product?.merchant_id || product?.merchantId || '').trim();
  if (!productId || !merchantId) return null;
  return { product_id: productId, merchant_id: merchantId };
}

function computeTokenOverlapScore(queryTokens, candidateText) {
  if (!Array.isArray(queryTokens) || queryTokens.length === 0) return 0;
  const blob = normalizeTextForResolver(candidateText);
  if (!blob) return 0;

  const tokens = tokenizeNormalizedResolverQuery(blob);
  if (tokens.length === 0) return 0;
  const tokenSet = new Set(tokens);

  let common = 0;
  for (const t of queryTokens) {
    if (tokenSet.has(t)) common += 1;
  }

  const recall = common / queryTokens.length;
  const precision = common / tokenSet.size;
  const denom = recall + precision;
  const f1 = denom > 0 ? (2 * recall * precision) / denom : 0;

  // F1 is stable for "name-heavy" queries; also preserve recall as a fallback.
  return Math.max(f1, recall * 0.9);
}

function computeCandidateTextScore({ normalizedQuery, queryTokens, product }) {
  const title = getCandidateTitle(product);
  const brand = getCandidateBrand(product);
  const combined = `${brand} ${title}`.trim();
  const normCombined = normalizeTextForResolver(combined);
  const normTitle = normalizeTextForResolver(title);

  if (!normalizedQuery) return 0;
  if (normTitle && normTitle === normalizedQuery) return { score: 1, reason: 'exact_title' };
  if (normTitle && normTitle.includes(normalizedQuery)) return { score: 0.95, reason: 'title_contains_query' };
  if (normCombined && normCombined.includes(normalizedQuery)) return { score: 0.9, reason: 'brand_title_contains_query' };

  const score = computeTokenOverlapScore(queryTokens, combined);
  return { score, reason: 'token_overlap' };
}

function computeInventoryBoost(product) {
  const inStock =
    typeof product?.in_stock === 'boolean'
      ? product.in_stock
      : typeof product?.inStock === 'boolean'
        ? product.inStock
        : null;
  if (inStock === true) return 0.05;

  const invRaw =
    product?.inventory_quantity ??
    product?.inventoryQuantity ??
    (product?.inventory && product.inventory.quantity) ??
    null;
  if (invRaw == null) return 0;
  const inv = Number(invRaw);
  if (Number.isFinite(inv) && inv > 0) return 0.05;
  return 0;
}

function computeOrderablePenalty(product) {
  const raw = product?.orderable ?? product?.is_orderable ?? product?.isOrderable ?? null;
  if (raw == null) return 0;
  const v = typeof raw === 'boolean' ? raw : String(raw).trim().toLowerCase() === 'true';
  return v ? 0 : -0.25;
}

function scoreAndRankCandidates({ query, lang, products, options }) {
  const normalizedQuery = normalizeTextForResolver(query);
  const queryTokens = tokenizeNormalizedResolverQuery(normalizedQuery);
  const preferMerchants = Array.isArray(options?.prefer_merchants) ? options.prefer_merchants : [];
  const allowExternalSeed = options?.allow_external_seed === true;

  const scored = [];
  for (const p of products || []) {
    if (!p || typeof p !== 'object') continue;
    if (!allowExternalSeed && isExternalProduct(p)) continue;
    const ref = extractProductRef(p);
    if (!ref) continue;

    const base = computeCandidateTextScore({ normalizedQuery, queryTokens, product: p });
    const isPreferredMerchant = preferMerchants.includes(ref.merchant_id);
    const merchantBoost = isPreferredMerchant ? 0.18 : 0;
    const invBoost = computeInventoryBoost(p);
    const orderablePenalty = computeOrderablePenalty(p);

    const rankScore = base.score + merchantBoost + invBoost + orderablePenalty;
    let final = rankScore;
    if (final < 0) final = 0;
    if (final > 1) final = 1;

    scored.push({
      product_ref: ref,
      title: String(getCandidateTitle(p) || '').trim() || null,
      brand: String(getCandidateBrand(p) || '').trim() || null,
      merchant_name: String(p?.merchant_name || p?.merchantName || p?.store_name || p?.storeName || '').trim() || null,
      score: Number(final.toFixed(4)),
      _rank_score: Number(rankScore.toFixed(6)),
      _preferred_merchant: isPreferredMerchant,
      score_reason: base.reason,
      _raw: p,
    });
  }

  scored.sort((a, b) => {
    const ds = (b._rank_score || 0) - (a._rank_score || 0);
    if (ds) return ds;
    const dp = (b._preferred_merchant ? 1 : 0) - (a._preferred_merchant ? 1 : 0);
    if (dp) return dp;
    return (b.score || 0) - (a.score || 0);
  });
  return {
    normalized_query: normalizedQuery,
    query_tokens: queryTokens,
    scored,
  };
}

function resolveFromRankedCandidates({ ranked, options }) {
  const threshold = typeof options?.min_confidence === 'number' ? options.min_confidence : 0.72;
  const top = Array.isArray(ranked) ? ranked[0] : null;
  if (!top) {
    return {
      resolved: false,
      product_ref: null,
      confidence: 0,
      reason: 'no_candidates',
    };
  }

  if (top.score < threshold) {
    return {
      resolved: false,
      product_ref: null,
      confidence: top.score,
      reason: 'low_confidence',
    };
  }

  return {
    resolved: true,
    product_ref: top.product_ref,
    confidence: top.score,
    reason: top.score_reason || 'matched',
  };
}

function extractProductsFromAgentSearchResponse(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.products)) return raw.products;
    if (raw.data && typeof raw.data === 'object' && Array.isArray(raw.data.products)) return raw.data.products;
    if (Array.isArray(raw.items)) return raw.items;
    if (raw.data && typeof raw.data === 'object' && Array.isArray(raw.data.items)) return raw.data.items;
    if (Array.isArray(raw.results)) return raw.results;
    if (raw.data && typeof raw.data === 'object' && Array.isArray(raw.data.results)) return raw.data.results;
  }
  return [];
}

function buildUpstreamHeaders({ pivotaApiKey, checkoutToken }) {
  const token = String(checkoutToken || '').trim();
  if (token) return { 'X-Checkout-Token': token };
  const key = String(pivotaApiKey || '').trim();
  if (!key) return {};
  return {
    'X-API-Key': key,
    Authorization: `Bearer ${key}`,
  };
}

async function fetchCandidatesViaAgentSearch({
  pivotaApiBase,
  pivotaApiKey,
  checkoutToken,
  query,
  merchantIds,
  searchAllMerchants,
  limit,
  timeoutMs,
}) {
  const baseUrl = String(pivotaApiBase || '').replace(/\/$/, '');
  if (!baseUrl) return { ok: false, products: [], reason: 'pivota_api_base_missing' };

  const q = String(query || '').trim();
  if (!q) return { ok: false, products: [], reason: 'query_missing' };

  const safeLimit = clampInt(limit, { min: 1, max: 50, fallback: 20 });
  const safeTimeout = clampInt(timeoutMs, { min: 50, max: 15000, fallback: 1500 });

  const params = {
    query: q,
    in_stock_only: false,
    limit: safeLimit,
    offset: 0,
    ...(searchAllMerchants ? { search_all_merchants: true } : {}),
    ...(Array.isArray(merchantIds) && merchantIds.length > 0 ? { merchant_ids: merchantIds } : {}),
  };

  try {
    const resp = await axios.get(`${baseUrl}/agent/v1/products/search`, {
      params,
      headers: buildUpstreamHeaders({ pivotaApiKey, checkoutToken }),
      timeout: safeTimeout,
      validateStatus: () => true,
    });

    if (resp.status !== 200) {
      return { ok: false, products: [], reason: `upstream_status_${resp.status}` };
    }
    const products = extractProductsFromAgentSearchResponse(resp.data);
    return { ok: true, products };
  } catch (err) {
    const msg = String(err?.message || err || '');
    const isTimeout = /timeout|aborted|ECONNABORTED/i.test(msg);
    return { ok: false, products: [], reason: isTimeout ? 'upstream_timeout' : 'upstream_error' };
  }
}

async function fetchCandidatesViaProductsCache({ merchantIds, query, limit, timeoutMs }) {
  const mids = Array.isArray(merchantIds) ? merchantIds.map((m) => String(m || '').trim()).filter(Boolean) : [];
  if (mids.length === 0) return { ok: false, products: [], reason: 'merchant_ids_missing' };
  if (!process.env.DATABASE_URL) return { ok: false, products: [], reason: 'db_not_configured' };

  const normalizedQuery = normalizeTextForResolver(query);
  const tokens = tokenizeNormalizedResolverQuery(normalizedQuery);
  if (tokens.length === 0) return { ok: true, products: [] };

  const safeLimit = clampInt(limit, { min: 1, max: 100, fallback: 40 });
  const fetchLimit = Math.min(250, Math.max(safeLimit * 6, 80));
  const safeTimeout = clampInt(timeoutMs, { min: 50, max: 15000, fallback: 1500 });

  const matchFields = [
    "lower(coalesce(product_data->>'title',''))",
    "lower(coalesce(product_data->>'name',''))",
    "lower(coalesce(product_data->>'description',''))",
    "lower(coalesce(product_data->>'product_type',''))",
    "lower(coalesce(product_data->>'sku',''))",
    "lower(coalesce(product_data->>'vendor',''))",
    "lower(coalesce(product_data->>'brand',''))",
  ];

  const whereParts = [];
  const params = [mids];
  let idx = 2;

  for (const t of tokens.slice(0, 10)) {
    params.push(`%${t}%`);
    const ors = matchFields.map((f) => `${f} LIKE $${idx}`).join(' OR ');
    whereParts.push(`(${ors})`);
    idx += 1;
  }

  const tokenWhere = whereParts.length ? `(${whereParts.join(' OR ')})` : 'TRUE';

  const sql = `
    WITH latest AS (
      SELECT DISTINCT ON (merchant_id, cache_product_id)
        merchant_id,
        cache_product_id,
        product_data,
        cached_at
      FROM (
        SELECT
          merchant_id,
          COALESCE(
            NULLIF(platform_product_id, ''),
            NULLIF(product_data->>'id', ''),
            NULLIF(product_data->>'product_id', ''),
            NULLIF(product_data->>'productId', '')
          ) AS cache_product_id,
          product_data,
          cached_at
        FROM products_cache
        WHERE merchant_id = ANY($1)
          AND (expires_at IS NULL OR expires_at > now())
          AND COALESCE(lower(product_data->>'status'), 'active') = 'active'
          AND COALESCE(lower(product_data->>'orderable'), 'true') <> 'false'
          AND ${tokenWhere}
      ) t
      WHERE cache_product_id IS NOT NULL
      ORDER BY merchant_id, cache_product_id, cached_at DESC
    )
    SELECT merchant_id, cache_product_id, product_data
    FROM latest
    ORDER BY cached_at DESC
    LIMIT $${idx}
  `;
  params.push(fetchLimit);

  try {
    const res = await withClient(async (client) => {
      const ms = Math.max(25, safeTimeout);
      // Note: Postgres does not reliably accept bind params in `SET statement_timeout`.
      // `ms` is clamped to a small integer range, so string interpolation is safe here.
      await client.query(`SET statement_timeout = ${Math.trunc(ms)}`);
      try {
        return await client.query(sql, params);
      } finally {
        await client.query('SET statement_timeout = 0');
      }
    });

    const rows = Array.isArray(res?.rows) ? res.rows : [];
    const products = rows
      .map((r) => {
        const productData = r?.product_data;
        if (!productData || typeof productData !== 'object') return null;
        const merchantId = String(r?.merchant_id || '').trim();
        const productId = String(r?.cache_product_id || '').trim() ||
          String(productData.product_id || productData.id || '').trim();
        if (!merchantId || !productId) return null;
        return {
          ...productData,
          merchant_id: merchantId,
          product_id: productId,
          source_type: productData.source_type || productData.source || 'products_cache',
        };
      })
      .filter(Boolean);

    return { ok: true, products: products.slice(0, fetchLimit), reason: null };
  } catch (err) {
    const code = String(err?.code || '');
    // 42P01: undefined_table
    if (code === '42P01') return { ok: false, products: [], reason: 'products_cache_missing' };
    return { ok: false, products: [], reason: 'db_error' };
  }
}

function dedupeByProductRef(candidates) {
  const out = [];
  const seen = new Set();
  for (const item of candidates || []) {
    const ref = item && item.product_ref ? item.product_ref : null;
    const key = ref ? `${ref.merchant_id}::${ref.product_id}` : null;
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

async function resolveProductRef({
  query,
  lang,
  hints,
  options,
  pivotaApiBase,
  pivotaApiKey,
  checkoutToken,
}) {
  const startMs = Date.now();
  const timeoutMs = clampInt(options?.timeout_ms, { min: 100, max: 15000, fallback: 800 });
  const deadlineMs = startMs + timeoutMs;

  const q = String(query || '').trim();
  const normalizedQuery = normalizeTextForResolver(q);
  const queryTokens = tokenizeNormalizedResolverQuery(normalizedQuery);
  if (!normalizedQuery || queryTokens.length === 0) {
    return {
      resolved: false,
      product_ref: null,
      confidence: 0,
      reason: 'empty_query',
      candidates: [],
      normalized_query: normalizedQuery,
    };
  }

  const preferMerchantsRaw =
    options?.prefer_merchants ||
    options?.preferMerchants ||
    options?.prefer_merchant_ids ||
    options?.preferMerchantIds ||
    [];
  const preferMerchantsList = Array.isArray(preferMerchantsRaw)
    ? preferMerchantsRaw
    : typeof preferMerchantsRaw === 'string' && preferMerchantsRaw.trim()
      ? [preferMerchantsRaw.trim()]
      : [];
  const preferMerchants = Array.from(
    new Set(preferMerchantsList.map((m) => String(m || '').trim()).filter(Boolean)),
  ).slice(0, 20);
  const allowExternalSeed = options?.allow_external_seed === true || options?.allowExternalSeed === true;
  const searchAllMerchants =
    options?.search_all_merchants === true || options?.searchAllMerchants === true || (!preferMerchants.length && options?.search_all_merchants !== false);
  const limit = clampInt(options?.limit, { min: 1, max: 50, fallback: 20 });

  const products = [];
  const sources = [];

  function remainingMs() {
    return Math.max(0, deadlineMs - Date.now());
  }

  // 1) Prefer: products_cache (merchant inventory) for prefer_merchants.
  if (preferMerchants.length > 0 && remainingMs() >= 60) {
    const cacheResp = await fetchCandidatesViaProductsCache({
      merchantIds: preferMerchants,
      query: q,
      limit,
      timeoutMs: Math.max(50, remainingMs()),
    });
    if (cacheResp.ok && Array.isArray(cacheResp.products) && cacheResp.products.length) {
      products.push(...cacheResp.products);
      sources.push({ source: 'products_cache', ok: true, count: cacheResp.products.length });
    } else {
      sources.push({ source: 'products_cache', ok: false, reason: cacheResp.reason || 'no_results' });
    }
  }

  // 2) Fallback: agent search scoped to prefer_merchants (fast).
  if (products.length === 0 && preferMerchants.length > 0 && remainingMs() >= 80) {
    const upstreamScoped = await fetchCandidatesViaAgentSearch({
      pivotaApiBase,
      pivotaApiKey,
      checkoutToken,
      query: q,
      merchantIds: preferMerchants,
      searchAllMerchants: false,
      limit,
      timeoutMs: Math.max(50, remainingMs()),
    });
    if (upstreamScoped.ok && Array.isArray(upstreamScoped.products) && upstreamScoped.products.length) {
      products.push(...upstreamScoped.products);
      sources.push({ source: 'agent_search_scoped', ok: true, count: upstreamScoped.products.length });
    } else {
      sources.push({ source: 'agent_search_scoped', ok: false, reason: upstreamScoped.reason || 'no_results' });
    }
  }

  // 3) Optional: global agent search (no external_seed by default).
  const shouldTryGlobal =
    remainingMs() >= 120 &&
    (searchAllMerchants === true || (!preferMerchants.length && searchAllMerchants !== false)) &&
    // Avoid a second network call when we already have plenty of candidates.
    products.length < Math.max(6, Math.min(14, limit));
  if (shouldTryGlobal) {
    const upstreamGlobal = await fetchCandidatesViaAgentSearch({
      pivotaApiBase,
      pivotaApiKey,
      checkoutToken,
      query: q,
      merchantIds: undefined,
      searchAllMerchants: true,
      limit: Math.max(limit, 18),
      timeoutMs: Math.max(50, remainingMs()),
    });
    if (upstreamGlobal.ok && Array.isArray(upstreamGlobal.products) && upstreamGlobal.products.length) {
      products.push(...upstreamGlobal.products);
      sources.push({ source: 'agent_search_global', ok: true, count: upstreamGlobal.products.length });
    } else {
      sources.push({ source: 'agent_search_global', ok: false, reason: upstreamGlobal.reason || 'no_results' });
    }
  }

  const { scored, normalized_query } = scoreAndRankCandidates({
    query: q,
    lang,
    products,
    options: { ...options, prefer_merchants: preferMerchants, allow_external_seed: allowExternalSeed },
  });

  const unique = dedupeByProductRef(scored);
  const topN = unique.slice(0, clampInt(options?.candidates_limit, { min: 1, max: 12, fallback: 6 }));

  const decision = resolveFromRankedCandidates({
    ranked: unique,
    options,
  });

  const latencyMs = Date.now() - startMs;

  return {
    resolved: decision.resolved,
    product_ref: decision.product_ref,
    confidence: decision.confidence,
    reason: decision.reason,
    candidates: topN.map((c) => ({
      product_ref: c.product_ref,
      title: c.title,
      score: c.score,
      ...(c.merchant_name ? { merchant_name: c.merchant_name } : {}),
    })),
    normalized_query,
    metadata: {
      lang: String(lang || '').toLowerCase() === 'cn' ? 'cn' : 'en',
      timeout_ms: timeoutMs,
      latency_ms: latencyMs,
      sources,
      ...(preferMerchants.length ? { prefer_merchants: preferMerchants } : {}),
      ...(allowExternalSeed ? { allow_external_seed: true } : {}),
    },
  };
}

module.exports = {
  resolveProductRef,
  _internals: {
    normalizeTextForResolver,
    tokenizeNormalizedResolverQuery,
    scoreAndRankCandidates,
    resolveFromRankedCandidates,
    isExternalProduct,
    fetchCandidatesViaProductsCache,
    fetchCandidatesViaAgentSearch,
  },
};
