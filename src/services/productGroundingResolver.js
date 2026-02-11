const axios = require('axios');
const { withClient } = require('../db');

const EXTERNAL_SEED_MERCHANT_ID = 'external_seed';
const LATIN_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
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
  'please',
  'should',
  'the',
  'this',
  'to',
  'want',
  'with',
  'would',
  'you',
  'your',
  // High-frequency commerce wrappers that are not useful for product identity.
  'any',
  'available',
  'buy',
  'find',
  'in-stock',
  'instock',
  'need',
  'product',
  'products',
  'sell',
  'selling',
  'stock',
]);
const HAS_HAN_RE = /[\u4E00-\u9FFF]/;
const CJK_QUERY_PREFIX_RE = /^(?:有没有|有无|有沒|有没|是否有|请问|能不能|可以|想买|想要|哪里买|怎么买)/;
const CJK_QUERY_SUFFIX_RE = /(?:吗|呢|呀|吧|嘛)$/;
const KNOWN_STABLE_PRODUCT_REFS = [
  {
    id: 'the_ordinary_niacinamide_10_zinc_1',
    product_ref: {
      product_id: 'prod_the_ordinary_niacinamide_10_zinc_1',
      merchant_id: 'merch_efbc46b4619cfbdf',
    },
    title: 'The Ordinary Niacinamide 10% + Zinc 1%',
    aliases: [
      'The Ordinary Niacinamide 10% + Zinc 1%',
      'Niacinamide 10% + Zinc 1%',
      'the ordinary niacinamide 10 zinc 1',
      'niacinamide 10 zinc 1',
    ],
  },
  {
    id: 'winona_soothing_repair_serum',
    product_ref: {
      product_id: 'prod_winona_soothing_repair_serum',
      merchant_id: 'merch_efbc46b4619cfbdf',
    },
    title: 'Winona Soothing Repair Serum',
    aliases: [
      'Winona Soothing Repair Serum',
      'winona soothing repair serum',
      '薇诺娜 舒缓 修护 精华',
      '薇诺娜修护精华',
    ],
  },
];

function compactNoSpaces(s) {
  return String(s || '').replace(/\s+/g, '');
}

function stripCommonCjkQueryAffixes(compact) {
  const s = String(compact || '');
  if (!s) return '';
  return s.replace(CJK_QUERY_PREFIX_RE, '').replace(CJK_QUERY_SUFFIX_RE, '');
}

function sleep(ms) {
  const delay = Math.max(0, Number(ms) || 0);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function clampInt(value, { min, max, fallback }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const v = Math.trunc(n);
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

function firstNonEmptyString(...values) {
  for (const raw of values) {
    const s = String(raw || '').trim();
    if (s) return s;
  }
  return '';
}

function isUuidLike(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.trim());
}

function buildKnownStableAliasEntries() {
  const out = [];
  for (const item of KNOWN_STABLE_PRODUCT_REFS) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id || '').trim();
    const title = String(item.title || '').trim();
    const productRef =
      item.product_ref && typeof item.product_ref === 'object'
        ? {
            product_id: String(item.product_ref.product_id || '').trim(),
            merchant_id: String(item.product_ref.merchant_id || '').trim(),
          }
        : null;
    if (!id || !productRef?.product_id || !productRef?.merchant_id) continue;
    const aliases = Array.isArray(item.aliases) ? item.aliases : [];
    for (const alias of aliases) {
      const normalized = normalizeTextForResolver(alias);
      if (!normalized) continue;
      const tokens = tokenizeNormalizedResolverQuery(normalized);
      if (!tokens.length) continue;
      out.push({
        id,
        alias: String(alias || '').trim(),
        title: title || String(alias || '').trim(),
        product_ref: productRef,
        normalized,
        compact: compactNoSpaces(normalized),
        token_set: new Set(tokens),
        token_count: tokens.length,
      });
    }
  }
  return out;
}

const KNOWN_STABLE_ALIAS_ENTRIES = buildKnownStableAliasEntries();

function resolveKnownStableProductRef({ query, normalizedQuery, queryTokens }) {
  const raw = String(query || '').trim();
  const normalized = String(normalizedQuery || '').trim();
  if (!normalized || !Array.isArray(queryTokens) || queryTokens.length === 0) return null;
  if (isUuidLike(raw)) return null;

  const compactQuery = compactNoSpaces(normalized);
  let best = null;

  for (const entry of KNOWN_STABLE_ALIAS_ENTRIES) {
    let score = 0;
    let reason = '';

    if (normalized === entry.normalized || compactQuery === entry.compact) {
      score = 1;
      reason = 'alias_exact';
    } else if (normalized.includes(entry.normalized) || entry.normalized.includes(normalized)) {
      const a = normalized.length;
      const b = entry.normalized.length;
      const ratio = Math.min(a, b) / Math.max(a, b);
      if (ratio >= 0.72) {
        score = 0.97;
        reason = 'alias_contains';
      }
    }

    if (!score) {
      const overlap = computeTokenOverlapScoreFromTokenSet(queryTokens, entry.token_set);
      if (overlap >= 0.88) {
        score = Number(Math.min(overlap, 0.95).toFixed(4));
        reason = 'alias_token_overlap';
      }
    }

    if (!score) continue;

    if (reason === 'alias_token_overlap') {
      let common = 0;
      for (const t of queryTokens) {
        if (entry.token_set.has(t)) common += 1;
      }
      if (common < Math.min(3, entry.token_count)) continue;
    }

    if (!best || score > best.score) {
      best = { ...entry, score, reason };
    }
  }

  if (!best) return null;
  return {
    id: best.id,
    title: best.title,
    matched_alias: best.alias,
    product_ref: {
      product_id: best.product_ref.product_id,
      merchant_id: best.product_ref.merchant_id,
    },
    score: best.score,
    reason: best.reason,
  };
}

function extractResolverHints(hints) {
  if (!hints || typeof hints !== 'object' || Array.isArray(hints)) {
    return {
      product_ref: null,
      aliases: [],
      brand: null,
    };
  }

  const hintObj = hints;
  const hintRefRaw =
    (hintObj.product_ref && typeof hintObj.product_ref === 'object' ? hintObj.product_ref : null) ||
    (hintObj.productRef && typeof hintObj.productRef === 'object' ? hintObj.productRef : null) ||
    (hintObj.target && typeof hintObj.target === 'object' ? hintObj.target : null);

  const hintProductId = firstNonEmptyString(
    hintRefRaw?.product_id,
    hintRefRaw?.productId,
    hintObj.product_id,
    hintObj.productId,
    hintObj.id,
  );
  const hintMerchantId = firstNonEmptyString(
    hintRefRaw?.merchant_id,
    hintRefRaw?.merchantId,
    hintObj.merchant_id,
    hintObj.merchantId,
    hintObj.merchant && typeof hintObj.merchant === 'object' ? hintObj.merchant.merchant_id : null,
  );
  const productRef = hintProductId
    ? {
        product_id: hintProductId,
        ...(hintMerchantId ? { merchant_id: hintMerchantId } : {}),
      }
    : null;

  const brand = firstNonEmptyString(hintObj.brand, hintObj.vendor) || null;
  const name = firstNonEmptyString(
    hintObj.name,
    hintObj.title,
    hintObj.display_name,
    hintObj.displayName,
    hintObj.product_name,
    hintObj.productName,
  );
  const explicitQuery = firstNonEmptyString(hintObj.query);

  const aliases = [];
  const seen = new Set();
  const pushAlias = (value) => {
    const s = String(value || '').trim();
    if (!s) return;
    const key = s.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    aliases.push(s);
  };

  pushAlias(name);
  if (brand && name) pushAlias(`${brand} ${name}`);
  pushAlias(explicitQuery);

  if (Array.isArray(hintObj.aliases)) {
    for (const alias of hintObj.aliases) {
      pushAlias(alias);
      if (aliases.length >= 8) break;
    }
  }

  return {
    product_ref: productRef,
    aliases: aliases.slice(0, 8),
    brand,
  };
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

  const out = [];
  const seen = new Set();
  for (const tok of parts) {
    const t = String(tok || '').trim();
    if (!t) continue;

    const isNumeric = /^[0-9]+$/.test(t);
    const isLatin = /^[a-z0-9]+$/.test(t);
    if (isLatin && !isNumeric) {
      if (LATIN_STOPWORDS.has(t)) continue;
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
  if (!productId) return null;
  return {
    product_id: productId,
    ...(merchantId ? { merchant_id: merchantId } : {}),
  };
}

function computeTokenOverlapScore(queryTokens, candidateText) {
  if (!Array.isArray(queryTokens) || queryTokens.length === 0) return 0;
  const blob = normalizeTextForResolver(candidateText);
  if (!blob) return 0;

  const tokens = tokenizeNormalizedResolverQuery(blob);
  if (tokens.length === 0) return 0;
  return computeTokenOverlapScoreFromTokenSet(queryTokens, new Set(tokens));
}

function computeTokenOverlapScoreFromTokenSet(queryTokens, tokenSet) {
  if (!Array.isArray(queryTokens) || queryTokens.length === 0) return 0;
  if (!tokenSet || typeof tokenSet.size !== 'number' || tokenSet.size <= 0) return 0;

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
  if (!normalizedQuery) return { score: 0, reason: 'empty_query' };

  const title = getCandidateTitle(product);
  const normTitle = normalizeTextForResolver(title);
  if (normTitle && normTitle === normalizedQuery) return { score: 1, reason: 'exact_title' };
  if (normTitle && normTitle.includes(normalizedQuery)) return { score: 0.95, reason: 'title_contains_query' };

  const brand = getCandidateBrand(product);
  const combined = `${brand} ${title}`.trim();
  const normCombined = normalizeTextForResolver(combined);
  if (normCombined && normCombined.includes(normalizedQuery)) return { score: 0.9, reason: 'brand_title_contains_query' };

  // CJK queries often come without whitespace tokenization (e.g. "有没有薇诺娜修护乳").
  // If we have Han characters, fall back to compact containment (strip common question affixes).
  if (normCombined && (HAS_HAN_RE.test(normalizedQuery) || HAS_HAN_RE.test(normCombined))) {
    const compactQuery = stripCommonCjkQueryAffixes(compactNoSpaces(normalizedQuery));
    if (compactQuery && compactQuery.length >= 2) {
      const compactCandidate = compactNoSpaces(normCombined);
      if (compactCandidate && compactCandidate.includes(compactQuery)) {
        return { score: 0.9, reason: 'cjk_compact_contains_query' };
      }
    }
  }

  const tokens = tokenizeNormalizedResolverQuery(normCombined);
  const score = computeTokenOverlapScoreFromTokenSet(queryTokens, new Set(tokens));
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
  const opt = options && typeof options === 'object' ? options : {};
  const normalizedQuery =
    typeof opt.normalized_query === 'string' && opt.normalized_query.trim()
      ? String(opt.normalized_query).trim()
      : normalizeTextForResolver(query);
  const queryTokens =
    Array.isArray(opt.query_tokens) && opt.query_tokens.length
      ? opt.query_tokens
      : tokenizeNormalizedResolverQuery(normalizedQuery);

  const preferMerchantsRaw = Array.isArray(opt.prefer_merchants) ? opt.prefer_merchants : [];
  const preferMerchantsSet = new Set(preferMerchantsRaw.map((m) => String(m || '').trim()).filter(Boolean));
  const allowExternalSeed = options?.allow_external_seed === true;

  const scored = [];
  for (const p of products || []) {
    if (!p || typeof p !== 'object') continue;
    if (!allowExternalSeed && isExternalProduct(p)) continue;
    const ref = extractProductRef(p);
    if (!ref) continue;

    const base = computeCandidateTextScore({ normalizedQuery, queryTokens, product: p });
    const isPreferredMerchant = Boolean(ref.merchant_id && preferMerchantsSet.has(ref.merchant_id));
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
  maxRetries,
  retryBackoffMs,
}) {
  const baseUrl = String(pivotaApiBase || '').replace(/\/$/, '');
  if (!baseUrl) return { ok: false, products: [], reason: 'pivota_api_base_missing' };

  const q = String(query || '').trim();
  if (!q) return { ok: false, products: [], reason: 'query_missing' };

  const safeLimit = clampInt(limit, { min: 1, max: 50, fallback: 20 });
  const safeTimeout = clampInt(timeoutMs, { min: 50, max: 15000, fallback: 1500 });
  const safeMaxRetries = clampInt(maxRetries, { min: 0, max: 3, fallback: 1 });
  const safeRetryBackoff = clampInt(retryBackoffMs, { min: 25, max: 1000, fallback: 90 });

  const params = {
    query: q,
    in_stock_only: false,
    limit: safeLimit,
    offset: 0,
    ...(searchAllMerchants ? { search_all_merchants: true } : {}),
    ...(Array.isArray(merchantIds) && merchantIds.length > 0 ? { merchant_ids: merchantIds } : {}),
  };

  let attempts = 0;
  while (attempts <= safeMaxRetries) {
    attempts += 1;
    try {
      const resp = await axios.get(`${baseUrl}/agent/v1/products/search`, {
        params,
        headers: buildUpstreamHeaders({ pivotaApiKey, checkoutToken }),
        timeout: safeTimeout,
        validateStatus: () => true,
      });

      if (resp.status === 200) {
        const products = extractProductsFromAgentSearchResponse(resp.data);
        return { ok: true, products, attempts };
      }

      const reason = `upstream_status_${resp.status}`;
      const retryable = resp.status === 429 || resp.status >= 500;
      if (retryable && attempts <= safeMaxRetries) {
        await sleep(safeRetryBackoff * attempts);
        continue;
      }
      return { ok: false, products: [], reason, status: resp.status, attempts };
    } catch (err) {
      const msg = String(err?.message || err || '');
      const isTimeout = /timeout|aborted|ECONNABORTED/i.test(msg);
      const reason = isTimeout ? 'upstream_timeout' : 'upstream_error';
      if (attempts <= safeMaxRetries) {
        await sleep(safeRetryBackoff * attempts);
        continue;
      }
      return { ok: false, products: [], reason, attempts };
    }
  }

  return { ok: false, products: [], reason: 'upstream_error', attempts };
}

async function fetchCandidatesViaProductsCache({
  merchantIds,
  query,
  limit,
  timeoutMs,
  searchAllMerchants = false,
}) {
  const mids = Array.isArray(merchantIds)
    ? merchantIds.map((m) => String(m || '').trim()).filter(Boolean)
    : [];
  const useMerchantScope = !searchAllMerchants;
  if (useMerchantScope && mids.length === 0) return { ok: false, products: [], reason: 'merchant_ids_missing' };
  if (!process.env.DATABASE_URL) return { ok: false, products: [], reason: 'db_not_configured' };

  const normalizedQuery = normalizeTextForResolver(query);
  const tokens = tokenizeNormalizedResolverQuery(normalizedQuery);
  if (tokens.length === 0) return { ok: true, products: [] };

  const safeLimit = clampInt(limit, { min: 1, max: 100, fallback: 40 });
  const fetchLimit = Math.min(350, Math.max(safeLimit * 8, 120));
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
  const params = [];
  let idx = 1;

  for (const t of tokens.slice(0, 10)) {
    params.push(`%${t}%`);
    const ors = matchFields.map((f) => `${f} LIKE $${idx}`).join(' OR ');
    whereParts.push(`(${ors})`);
    idx += 1;
  }

  const tokenWhere = whereParts.length ? `(${whereParts.join(' OR ')})` : 'TRUE';
  const merchantScopeWhere = useMerchantScope ? `merchant_id = ANY($${idx})` : 'TRUE';
  if (useMerchantScope) {
    params.push(mids);
    idx += 1;
  }
  const limitParam = idx;
  params.push(fetchLimit);

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
        WHERE ${merchantScopeWhere}
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
    LIMIT $${limitParam}
  `;

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
    const code = String(err?.code || '').toUpperCase();
    const msg = String(err?.message || err || '').toLowerCase();
    // 42P01: undefined_table
    if (code === '42P01') return { ok: false, products: [], reason: 'products_cache_missing', error_code: code };
    // 57014: query_canceled (often statement_timeout)
    if (code === '57014' || /statement timeout|canceling statement due to statement timeout|query canceled/.test(msg)) {
      return { ok: false, products: [], reason: 'db_query_timeout', error_code: code || '57014' };
    }
    // 42703: undefined_column
    if (code === '42703') return { ok: false, products: [], reason: 'db_schema_mismatch', error_code: code };
    // 28P01: invalid_password
    if (code === '28P01') return { ok: false, products: [], reason: 'db_auth_failed', error_code: code };
    // 08xxx: connection exceptions
    if (code.startsWith('08')) return { ok: false, products: [], reason: 'db_unreachable', error_code: code };
    return { ok: false, products: [], reason: 'db_error', error_code: code || null };
  }
}

function dedupeByProductRef(candidates) {
  const out = [];
  const seen = new Set();
  for (const item of candidates || []) {
    const ref = item && item.product_ref ? item.product_ref : null;
    const merchantKey = ref?.merchant_id ? String(ref.merchant_id).trim() : '_';
    const productKey = ref?.product_id ? String(ref.product_id).trim() : '';
    const key = productKey ? `${merchantKey}::${productKey}` : null;
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function createProductGroundingResolver(deps = {}) {
  const fetchProductsCache =
    typeof deps.fetchCandidatesViaProductsCache === 'function'
      ? deps.fetchCandidatesViaProductsCache
      : fetchCandidatesViaProductsCache;
  const fetchAgentSearch =
    typeof deps.fetchCandidatesViaAgentSearch === 'function'
      ? deps.fetchCandidatesViaAgentSearch
      : fetchCandidatesViaAgentSearch;
  const rankCandidates =
    typeof deps.scoreAndRankCandidates === 'function' ? deps.scoreAndRankCandidates : scoreAndRankCandidates;
  const decide =
    typeof deps.resolveFromRankedCandidates === 'function'
      ? deps.resolveFromRankedCandidates
      : resolveFromRankedCandidates;

  return async function resolveProductRef({
    query,
    lang,
    hints,
    options,
    pivotaApiBase,
    pivotaApiKey,
    checkoutToken,
  }) {
  const startMs = Date.now();
  const timeoutMs = clampInt(options?.timeout_ms, { min: 100, max: 15000, fallback: 1600 });
  const deadlineMs = startMs + timeoutMs;

  const rawQuery = String(query || '').trim();
  const hintData = extractResolverHints(hints);
  const hintedQuery = hintData.aliases[0] || '';
  const q =
    isUuidLike(rawQuery) && hintedQuery
      ? hintedQuery
      : rawQuery;
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
  const upstreamRetries = clampInt(options?.upstream_retries, { min: 0, max: 3, fallback: 1 });
  const upstreamRetryBackoffMs = clampInt(options?.upstream_retry_backoff_ms, { min: 25, max: 1000, fallback: 90 });

  const products = [];
  const sources = [];
  const hintedRefProductId = String(hintData.product_ref?.product_id || '').trim();
  const hintedRefMerchantId = String(hintData.product_ref?.merchant_id || '').trim();
  const opaqueHintProductId = Boolean(hintedRefProductId) && isUuidLike(hintedRefProductId);
  const canUseHintProductRef = Boolean(hintedRefProductId) && !opaqueHintProductId;

  if (canUseHintProductRef && (hintedQuery || isUuidLike(rawQuery))) {
    const resolvedHintRef = {
      product_id: hintData.product_ref.product_id,
      ...(hintedRefMerchantId ? { merchant_id: hintedRefMerchantId } : {}),
    };
    products.push({
      product_id: resolvedHintRef.product_id,
      ...(resolvedHintRef.merchant_id ? { merchant_id: resolvedHintRef.merchant_id } : {}),
      title: hintedQuery || rawQuery,
      ...(hintData.brand ? { brand: hintData.brand } : {}),
      source: 'hint_product_ref',
    });
    sources.push({
      source: 'hints_product_ref',
      ok: true,
      count: 1,
    });
    const latencyMs = Date.now() - startMs;
    return {
      resolved: true,
      product_ref: resolvedHintRef,
      confidence: 1,
      reason: 'hint_product_ref',
      candidates: [
        {
          product_ref: resolvedHintRef,
          title: hintedQuery || rawQuery,
          score: 1,
        },
      ],
      normalized_query: normalizedQuery,
      metadata: {
        lang: String(lang || '').toLowerCase() === 'cn' ? 'cn' : 'en',
        timeout_ms: timeoutMs,
        latency_ms: latencyMs,
        sources,
        ...(q !== rawQuery ? { query_from_hints: true, effective_query: q, original_query: rawQuery } : {}),
        ...(preferMerchants.length ? { prefer_merchants: preferMerchants } : {}),
        hint_short_circuit: true,
      },
    };
  }
  if (opaqueHintProductId) {
    sources.push({ source: 'hints_product_ref', ok: false, reason: 'opaque_hint_requires_lookup' });
  }

  function remainingMs() {
    return Math.max(0, deadlineMs - Date.now());
  }

  function stageTimeout({ capMs, reserveMs = 0, floorMs = 50 }) {
    const remaining = remainingMs();
    if (remaining <= floorMs) return 0;
    const keep = Math.max(0, Number(reserveMs) || 0);
    const cap = Math.max(floorMs, Number(capMs) || floorMs);
    const budgeted = Math.max(floorMs, remaining - keep);
    return Math.max(floorMs, Math.min(cap, budgeted));
  }

  // 1) Prefer: products_cache (merchant inventory) for prefer_merchants.
  const scopedCacheTimeout = stageTimeout({ capMs: 650, reserveMs: 900, floorMs: 60 });
  if (preferMerchants.length > 0 && scopedCacheTimeout >= 60) {
    const cacheResp = await fetchProductsCache({
      merchantIds: preferMerchants,
      query: q,
      limit,
      timeoutMs: scopedCacheTimeout,
      searchAllMerchants: false,
    });
    if (cacheResp.ok && Array.isArray(cacheResp.products) && cacheResp.products.length) {
      products.push(...cacheResp.products);
      sources.push({ source: 'products_cache', ok: true, count: cacheResp.products.length });
    } else {
      sources.push({
        source: 'products_cache',
        ok: false,
        reason: cacheResp.reason || 'no_results',
        ...(cacheResp.error_code ? { error_code: cacheResp.error_code } : {}),
      });
    }
  }

  // 2) Fallback: agent search scoped to prefer_merchants (fast).
  const scopedUpstreamTimeout = stageTimeout({ capMs: 900, reserveMs: 850, floorMs: 80 });
  if (products.length === 0 && preferMerchants.length > 0 && scopedUpstreamTimeout >= 80) {
    const scopedRetries = scopedUpstreamTimeout >= 700 ? upstreamRetries : 0;
    const upstreamScoped = await fetchAgentSearch({
      pivotaApiBase,
      pivotaApiKey,
      checkoutToken,
      query: q,
      merchantIds: preferMerchants,
      searchAllMerchants: false,
      limit,
      timeoutMs: scopedUpstreamTimeout,
      maxRetries: scopedRetries,
      retryBackoffMs: upstreamRetryBackoffMs,
    });
    if (upstreamScoped.ok && Array.isArray(upstreamScoped.products) && upstreamScoped.products.length) {
      products.push(...upstreamScoped.products);
      sources.push({
        source: 'agent_search_scoped',
        ok: true,
        count: upstreamScoped.products.length,
        attempts: upstreamScoped.attempts || 1,
      });
    } else {
      sources.push({
        source: 'agent_search_scoped',
        ok: false,
        reason: upstreamScoped.reason || 'no_results',
        ...(upstreamScoped.status ? { status: upstreamScoped.status } : {}),
        attempts: upstreamScoped.attempts || 1,
      });
    }
  }

  // 3) Optional: global products_cache fallback (avoids network timeouts).
  const globalCacheTimeout = stageTimeout({ capMs: 850, reserveMs: 300, floorMs: 60 });
  const shouldTryGlobalCache =
    globalCacheTimeout >= 60 &&
    (searchAllMerchants === true || (!preferMerchants.length && searchAllMerchants !== false)) &&
    products.length < Math.max(6, Math.min(14, limit));
  if (shouldTryGlobalCache) {
    const cacheGlobal = await fetchProductsCache({
      query: q,
      limit: Math.max(limit, 24),
      timeoutMs: globalCacheTimeout,
      searchAllMerchants: true,
    });
    if (cacheGlobal.ok && Array.isArray(cacheGlobal.products) && cacheGlobal.products.length) {
      products.push(...cacheGlobal.products);
      sources.push({ source: 'products_cache_global', ok: true, count: cacheGlobal.products.length });
    } else {
      sources.push({
        source: 'products_cache_global',
        ok: false,
        reason: cacheGlobal.reason || 'no_results',
        ...(cacheGlobal.error_code ? { error_code: cacheGlobal.error_code } : {}),
      });
    }
  }

  // 4) Optional: global agent search (no external_seed by default).
  const globalUpstreamTimeout = stageTimeout({ capMs: 1400, reserveMs: 0, floorMs: 120 });
  const shouldTryGlobal =
    globalUpstreamTimeout >= 120 &&
    (searchAllMerchants === true || (!preferMerchants.length && searchAllMerchants !== false)) &&
    // Avoid a second network call when we already have plenty of candidates.
    products.length < Math.max(6, Math.min(14, limit));
  if (shouldTryGlobal) {
    const globalRetries = globalUpstreamTimeout >= 900 ? upstreamRetries : 0;
    const upstreamGlobal = await fetchAgentSearch({
      pivotaApiBase,
      pivotaApiKey,
      checkoutToken,
      query: q,
      merchantIds: undefined,
      searchAllMerchants: true,
      limit: Math.max(limit, 18),
      timeoutMs: globalUpstreamTimeout,
      maxRetries: globalRetries,
      retryBackoffMs: upstreamRetryBackoffMs,
    });
    if (upstreamGlobal.ok && Array.isArray(upstreamGlobal.products) && upstreamGlobal.products.length) {
      products.push(...upstreamGlobal.products);
      sources.push({
        source: 'agent_search_global',
        ok: true,
        count: upstreamGlobal.products.length,
        attempts: upstreamGlobal.attempts || 1,
      });
    } else {
      sources.push({
        source: 'agent_search_global',
        ok: false,
        reason: upstreamGlobal.reason || 'no_results',
        ...(upstreamGlobal.status ? { status: upstreamGlobal.status } : {}),
        attempts: upstreamGlobal.attempts || 1,
      });
    }
  }

  const { scored, normalized_query } = rankCandidates({
    query: q,
    lang,
    products,
    options: {
      ...options,
      prefer_merchants: preferMerchants,
      allow_external_seed: allowExternalSeed,
      normalized_query: normalizedQuery,
      query_tokens: queryTokens,
    },
  });

  const unique = dedupeByProductRef(scored);
  const topN = unique.slice(0, clampInt(options?.candidates_limit, { min: 1, max: 12, fallback: 6 }));

  const decision = decide({
    ranked: unique,
    options,
  });

  const shouldTryStableAliasFallback =
    !decision.resolved &&
    !hintData.product_ref &&
    (!Array.isArray(hintData.aliases) || hintData.aliases.length === 0);
  const stableAliasMatch = shouldTryStableAliasFallback
    ? resolveKnownStableProductRef({
        query: q,
        normalizedQuery,
        queryTokens,
      })
    : null;
  if (stableAliasMatch) {
    sources.push({
      source: 'stable_alias_ref',
      ok: true,
      match_id: stableAliasMatch.id,
      score: stableAliasMatch.score,
      match_reason: stableAliasMatch.reason,
    });
    const latencyMs = Date.now() - startMs;
    return {
      resolved: true,
      product_ref: stableAliasMatch.product_ref,
      confidence: stableAliasMatch.score,
      reason: 'stable_alias_ref',
      candidates: [
        {
          product_ref: stableAliasMatch.product_ref,
          title: stableAliasMatch.title || q,
          score: stableAliasMatch.score,
        },
      ],
      normalized_query: normalizedQuery,
      metadata: {
        lang: String(lang || '').toLowerCase() === 'cn' ? 'cn' : 'en',
        timeout_ms: timeoutMs,
        latency_ms: latencyMs,
        sources,
        stable_alias_match_id: stableAliasMatch.id,
        stable_alias_match_query: stableAliasMatch.matched_alias,
        ...(q !== rawQuery ? { query_from_hints: true, effective_query: q, original_query: rawQuery } : {}),
        ...(preferMerchants.length ? { prefer_merchants: preferMerchants } : {}),
      },
    };
  }

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
      ...(q !== rawQuery ? { query_from_hints: true, effective_query: q, original_query: rawQuery } : {}),
      ...(preferMerchants.length ? { prefer_merchants: preferMerchants } : {}),
      ...(allowExternalSeed ? { allow_external_seed: true } : {}),
    },
  };
  };
}

const resolveProductRef = createProductGroundingResolver();

module.exports = {
  resolveProductRef,
  createProductGroundingResolver,
  _internals: {
    normalizeTextForResolver,
    tokenizeNormalizedResolverQuery,
    scoreAndRankCandidates,
    resolveFromRankedCandidates,
    isExternalProduct,
    isUuidLike,
    extractResolverHints,
    fetchCandidatesViaProductsCache,
    fetchCandidatesViaAgentSearch,
    computeTokenOverlapScoreFromTokenSet,
  },
};
