const axios = require('axios');
const logger = require('../logger');
const {
  observeDiscoveryCandidateCount,
  observeDiscoveryFeedLatency,
  recordDiscoveryFeedRequest,
  setLastDiscoverySnapshot,
} = require('../observability/discoveryMetrics');
const {
  _internals: {
    normalizeText,
    tokenize,
    jaccard,
    getBrandName,
    getLeafCategory,
    getParentCategory,
  },
} = require('./RecommendationEngine');

const SCORING_VERSION = 'discovery_v1';
const MAX_RECENT_VIEWS = 50;
const MAX_RECENT_QUERIES = 8;
const MAX_ANCHORS = 5;
const MAX_CANDIDATE_FETCH = 800;
const DEFAULT_DEBUG_TOP_CANDIDATES = 10;
const PRODUCTS_SEARCH_PAGE_SIZE = 100;
const MAX_PRODUCTS_SEARCH_CALLS = 4;
const EXTERNAL_SEED_MERCHANT_ID = 'external_seed';
const VALID_SURFACES = new Set(['home_hot_deals', 'browse_products']);
const VALID_AUTH_STATES = new Set(['authenticated', 'anonymous']);

class DiscoveryValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DiscoveryValidationError';
    this.statusCode = 400;
    this.code = 'INVALID_DISCOVERY_REQUEST';
  }
}

class DiscoveryCatalogUnavailableError extends Error {
  constructor(message = 'Discovery catalog is unavailable') {
    super(message);
    this.name = 'DiscoveryCatalogUnavailableError';
    this.statusCode = 503;
    this.code = 'DISCOVERY_CATALOG_UNAVAILABLE';
  }
}

function clampInt(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(num)));
}

function uniqStrings(values, limit) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (limit && out.length >= limit) break;
  }
  return out;
}

function normalizeAuthState(raw) {
  const value = String(raw || '').trim().toLowerCase();
  return VALID_AUTH_STATES.has(value) ? value : 'anonymous';
}

function parseViewedAt(raw) {
  if (!raw) return null;
  const ts = Date.parse(String(raw));
  return Number.isFinite(ts) ? ts : null;
}

function roundMetric(value, digits = 4) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Number(numeric.toFixed(digits));
}

function normalizeBaseUrl(raw) {
  return String(raw || '').trim().replace(/\/+$/, '');
}

function getDiscoveryProductsSearchBaseUrl() {
  return normalizeBaseUrl(process.env.PIVOTA_BACKEND_BASE_URL || process.env.PIVOTA_API_BASE);
}

function getDiscoveryProductsSearchTimeoutMs() {
  return clampInt(process.env.DISCOVERY_PRODUCTS_SEARCH_TIMEOUT_MS, 6500, 1000, 20000);
}

function buildProductKey(merchantId, productId) {
  const mid = String(merchantId || '').trim();
  const pid = String(productId || '').trim();
  return mid && pid ? `${mid}::${pid}` : '';
}

function getTopMapKeys(map, limit = 5) {
  return Array.from(map instanceof Map ? map.entries() : [])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key]) => key);
}

function normalizeRecentView(raw, idx) {
  if (!raw || typeof raw !== 'object') return null;
  const merchantId = String(raw.merchant_id || raw.merchantId || '').trim();
  const productId = String(raw.product_id || raw.productId || raw.id || '').trim();
  const title = String(raw.title || raw.name || '').trim();
  const description = String(raw.description || '').trim();
  const brand = String(raw.brand || raw.vendor || '').trim();
  const category = String(raw.category || '').trim();
  const productType = String(raw.product_type || raw.productType || '').trim();
  const source = String(raw.history_source || raw.source || '').trim().toLowerCase();
  const viewedAtMs = parseViewedAt(raw.viewed_at || raw.viewedAt);
  if (!productId && !title && !brand && !category && !productType) return null;
  return {
    merchant_id: merchantId || null,
    product_id: productId || null,
    title,
    description,
    brand,
    category,
    product_type: productType,
    viewed_at: viewedAtMs != null ? new Date(viewedAtMs).toISOString() : null,
    viewed_at_ms: viewedAtMs,
    history_source: source || null,
    original_index: idx,
  };
}

function normalizeDiscoveryDebug(raw) {
  if (raw === true) {
    return {
      enabled: true,
      top_candidates: DEFAULT_DEBUG_TOP_CANDIDATES,
    };
  }
  if (!raw || typeof raw !== 'object') {
    return {
      enabled: false,
      top_candidates: DEFAULT_DEBUG_TOP_CANDIDATES,
    };
  }
  return {
    enabled: raw.enabled !== false,
    top_candidates: clampInt(
      raw.top_candidates ?? raw.topCandidates ?? raw.limit,
      DEFAULT_DEBUG_TOP_CANDIDATES,
      1,
      25,
    ),
  };
}

function normalizeDiscoveryRequest(input = {}) {
  const source = input && typeof input.discovery === 'object' ? { ...input.discovery, ...input } : input;
  const surface = String(source.surface || '').trim();
  if (!VALID_SURFACES.has(surface)) {
    throw new DiscoveryValidationError('surface must be home_hot_deals or browse_products');
  }
  const page = clampInt(source.page, 1, 1, 1000);
  const limit = clampInt(source.limit, 20, 1, 100);
  const context = source.context && typeof source.context === 'object' ? source.context : {};

  const recentViewsRaw = Array.isArray(context.recent_views) ? context.recent_views : [];
  const sortedRecentViews = recentViewsRaw
    .map((view, idx) => normalizeRecentView(view, idx))
    .filter(Boolean)
    .sort((a, b) => {
      const aTs = a.viewed_at_ms;
      const bTs = b.viewed_at_ms;
      if (aTs != null && bTs != null && aTs !== bTs) return bTs - aTs;
      if (aTs != null && bTs == null) return -1;
      if (aTs == null && bTs != null) return 1;
      return a.original_index - b.original_index;
    });

  const dedupedRecentViews = [];
  const seenKeys = new Set();
  for (const view of sortedRecentViews) {
    const key = buildProductKey(view.merchant_id, view.product_id);
    if (key) {
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
    }
    dedupedRecentViews.push(view);
    if (dedupedRecentViews.length >= MAX_RECENT_VIEWS) break;
  }

  const recentQueries = uniqStrings(context.recent_queries, MAX_RECENT_QUERIES);
  const authState = normalizeAuthState(context.auth_state);
  const locale = String(context.locale || 'en-US').trim() || 'en-US';
  const debug = normalizeDiscoveryDebug(source.debug);

  return {
    surface,
    page,
    limit,
    context: {
      recent_views: dedupedRecentViews,
      recent_queries: recentQueries,
      auth_state: authState,
      locale,
    },
    debug,
  };
}

function buildAnchorFeatures(view) {
  const brand = normalizeText(view.brand || '');
  const category = normalizeText(view.product_type || view.category || '');
  const parentCategory = normalizeText(view.category || '');
  const tokens = tokenize(
    [
      view.title,
      view.description,
      view.brand,
      view.category,
      view.product_type,
    ]
      .filter(Boolean)
      .join(' '),
  );
  return {
    key: buildProductKey(view.merchant_id, view.product_id),
    merchant_id: view.merchant_id,
    product_id: view.product_id,
    brand,
    category,
    parent_category: parentCategory,
    tokens,
  };
}

function mapScore(map, key) {
  if (!map.size || !key) return 0;
  const max = Math.max(...map.values());
  if (!(max > 0)) return 0;
  return (map.get(key) || 0) / max;
}

function inferPersonalizationSource(recentViews, authState) {
  if (!Array.isArray(recentViews) || recentViews.length === 0) return 'none';
  const sources = new Set(
    recentViews
      .map((view) => String(view.history_source || '').trim().toLowerCase())
      .filter(Boolean),
  );
  if (sources.has('account') && (sources.has('session') || sources.has('local'))) {
    return 'merged';
  }
  if (sources.has('session') || sources.has('local')) return 'session_history';
  if (sources.has('account')) return 'account_history';
  return authState === 'authenticated' ? 'account_history' : 'session_history';
}

function buildDiscoveryProfile(context = {}) {
  const recentViews = Array.isArray(context.recent_views) ? context.recent_views : [];
  const recentQueries = uniqStrings(context.recent_queries, MAX_RECENT_QUERIES);
  const brandAffinity = new Map();
  const categoryAffinity = new Map();
  const queryTokens = new Set();

  recentQueries.forEach((queryText) => {
    tokenize(queryText).forEach((token) => queryTokens.add(token));
  });

  recentViews.forEach((view, idx) => {
    const weight = Math.exp(-idx / 8);
    const brandKey = normalizeText(view.brand || '');
    const categoryKeys = uniqStrings(
      [view.product_type, view.category].map((value) => normalizeText(value)),
      2,
    );
    if (brandKey) brandAffinity.set(brandKey, (brandAffinity.get(brandKey) || 0) + weight);
    categoryKeys.forEach((key) => {
      if (!key) return;
      categoryAffinity.set(key, (categoryAffinity.get(key) || 0) + weight);
    });
  });

  const anchors = [];
  const usedBrands = new Set();
  const usedCategories = new Set();
  for (const view of recentViews) {
    const anchor = buildAnchorFeatures(view);
    if (!anchor.product_id && !anchor.tokens.length) continue;
    const brandConflict = anchor.brand && usedBrands.has(anchor.brand);
    const categoryConflict = anchor.category && usedCategories.has(anchor.category);
    if (anchors.length > 0 && brandConflict && categoryConflict) continue;
    anchors.push(anchor);
    if (anchor.brand) usedBrands.add(anchor.brand);
    if (anchor.category) usedCategories.add(anchor.category);
    if (anchors.length >= MAX_ANCHORS) break;
  }

  const historyItemsUsed = recentViews.length;
  const personalizationSource = inferPersonalizationSource(recentViews, context.auth_state);
  const hasInterestSignals =
    historyItemsUsed > 0 && (brandAffinity.size > 0 || categoryAffinity.size > 0 || anchors.length > 0);

  return {
    brandAffinity,
    categoryAffinity,
    anchors,
    historyItemsUsed,
    personalizationSource,
    queryTokens,
    hasInterestSignals,
  };
}

function isCandidateSellable(product) {
  if (!product || typeof product !== 'object') return false;
  const status = String(product.status || 'active').trim().toLowerCase();
  if (status && status !== 'active') return false;
  if (product.in_stock === false) return false;
  const inventoryQuantity =
    product.inventory_quantity ??
    product.inventoryQuantity ??
    product.available_quantity ??
    product.availableQuantity;
  if (inventoryQuantity != null) {
    const quantity = Number(inventoryQuantity);
    if (Number.isFinite(quantity) && quantity <= 0) return false;
  }
  return true;
}

function normalizeCandidateProduct(product, browseRank = 0) {
  if (!product || typeof product !== 'object') return null;
  const merchantId = String(product.merchant_id || product.merchantId || '').trim();
  const productId = String(product.product_id || product.productId || product.id || '').trim();
  if (!merchantId || !productId) return null;
  if (!isCandidateSellable(product)) return null;
  const brand = getBrandName(product);
  const category =
    getLeafCategory(product) ||
    normalizeText(product.category || product.product_type || product.productType || '');
  const parentCategory = getParentCategory(product) || normalizeText(product.category || '');
  const title = String(product.title || product.name || '').trim();
  const description = String(product.description || '').trim();
  const tokens = tokenize([title, description, brand, category, parentCategory].filter(Boolean).join(' '));
  return {
    raw: {
      ...product,
      id: product.id || productId,
      product_id: product.product_id || productId,
      merchant_id: product.merchant_id || merchantId,
      ...(product.product_type || product.productType || !product.category
        ? {}
        : { product_type: product.category }),
    },
    key: buildProductKey(merchantId, productId),
    merchantId,
    productId,
    brand,
    category,
    parentCategory,
    tokens,
    browseRank,
  };
}

function buildDiscoveryInterestQuery(request, profile) {
  const terms = [];
  const seen = new Set();
  const pushTerm = (value) => {
    const normalized = String(value || '').trim().replace(/\s+/g, ' ');
    const key = normalizeText(normalized);
    if (!normalized || !key || seen.has(key)) return;
    seen.add(key);
    terms.push(normalized);
  };

  uniqStrings(request?.context?.recent_queries, 2).forEach(pushTerm);

  if (terms.length === 0) {
    for (const anchor of Array.isArray(profile?.anchors) ? profile.anchors : []) {
      pushTerm(anchor.brand);
      pushTerm(anchor.category);
      if (terms.length >= 2) break;
    }
  }

  getTopMapKeys(profile?.brandAffinity, 2).forEach(pushTerm);
  getTopMapKeys(profile?.categoryAffinity, 2).forEach(pushTerm);

  return terms.slice(0, 4).join(' ').trim();
}

function buildDiscoveryRecallPlan(request, profile, limit) {
  const safeLimit = Math.max(40, Math.min(limit, MAX_CANDIDATE_FETCH));
  const pageSize = Math.min(PRODUCTS_SEARCH_PAGE_SIZE, safeLimit);
  const maxCalls = clampInt(
    process.env.DISCOVERY_PRODUCTS_SEARCH_MAX_CALLS,
    MAX_PRODUCTS_SEARCH_CALLS,
    1,
    8,
  );

  const buildBrowseSteps = (maxItems, startOffset = 0, label = 'browse_pool') => {
    const steps = [];
    for (
      let offset = startOffset, seenItems = 0;
      seenItems < maxItems && steps.length < maxCalls;
      offset += pageSize, seenItems += pageSize
    ) {
      steps.push({
        label,
        query: '',
        offset,
        limit: Math.min(pageSize, maxItems - seenItems),
      });
    }
    return steps;
  };

  if (request?.surface === 'browse_products') {
    return buildBrowseSteps(safeLimit);
  }

  const interestQuery = buildDiscoveryInterestQuery(request, profile);
  const plan = [];
  if (interestQuery) {
    plan.push({
      label: 'interest_pool',
      query: interestQuery,
      offset: 0,
      limit: pageSize,
    });
  }

  const remainingItems = Math.max(pageSize, safeLimit - plan.reduce((sum, step) => sum + step.limit, 0));
  const remainingCalls = Math.max(0, maxCalls - plan.length);
  const browseSteps = buildBrowseSteps(remainingItems, 0).slice(0, remainingCalls);
  return [...plan, ...browseSteps];
}

async function loadProductsSearchCandidates({ request, profile, limit = MAX_CANDIDATE_FETCH } = {}) {
  const safeLimit = Math.max(40, Math.min(limit, MAX_CANDIDATE_FETCH));
  const baseUrl = getDiscoveryProductsSearchBaseUrl();
  if (!baseUrl) {
    throw new DiscoveryCatalogUnavailableError(
      'PIVOTA_BACKEND_BASE_URL or PIVOTA_API_BASE is not configured for discovery feed',
    );
  }

  const requestHeaders = {};
  const apiKey = String(process.env.PIVOTA_API_KEY || '').trim();
  if (apiKey) {
    requestHeaders['X-API-Key'] = apiKey;
    requestHeaders.Authorization = `Bearer ${apiKey}`;
  }

  const recallPlan = buildDiscoveryRecallPlan(request, profile, safeLimit);
  const mergedProducts = [];
  const seenKeys = new Set();
  const recallSummary = [];
  let successCount = 0;

  for (const step of recallPlan) {
    try {
      const resp = await axios.get(`${baseUrl}/agent/v1/products/search`, {
        params: {
          ...(step.query ? { query: step.query } : {}),
          in_stock_only: false,
          limit: step.limit,
          offset: step.offset,
        },
        headers: requestHeaders,
        timeout: getDiscoveryProductsSearchTimeoutMs(),
        validateStatus: () => true,
      });

      const products = Array.isArray(resp.data?.products)
        ? resp.data.products
        : Array.isArray(resp.data?.results)
          ? resp.data.results
          : [];

      recallSummary.push({
        label: step.label,
        query: step.query || null,
        offset: step.offset,
        limit: step.limit,
        status: Number(resp.status || 0) || null,
        returned: products.length,
      });

      if (!(resp.status >= 200 && resp.status < 300)) continue;

      successCount += 1;
      for (const product of products) {
        const merchantId = String(product?.merchant_id || product?.merchantId || '').trim();
        const productId = String(product?.product_id || product?.productId || product?.id || '').trim();
        const key = buildProductKey(merchantId, productId);
        if (!key || seenKeys.has(key)) continue;
        seenKeys.add(key);
        mergedProducts.push(product);
        if (mergedProducts.length >= safeLimit) break;
      }
      if (mergedProducts.length >= safeLimit) break;
    } catch (err) {
      recallSummary.push({
        label: step.label,
        query: step.query || null,
        offset: step.offset,
        limit: step.limit,
        status: null,
        returned: 0,
        error: err?.message || String(err),
      });
    }
  }

  if (successCount <= 0) {
    logger.warn(
      {
        base_url: baseUrl,
        surface: request?.surface || 'unknown',
        recall_summary: recallSummary,
      },
      'discovery feed products/search recall failed',
    );
    throw new DiscoveryCatalogUnavailableError('Failed to load discovery candidates from products/search');
  }

  return {
    products: mergedProducts,
    recallSummary,
  };
}

async function loadCatalogCandidates({
  request = null,
  profile = null,
  limit = MAX_CANDIDATE_FETCH,
} = {}) {
  const safeLimit = Math.max(40, Math.min(limit, MAX_CANDIDATE_FETCH));
  return loadProductsSearchCandidates({
    request,
    profile,
    limit: safeLimit,
  });
}

function scoreAnchorSimilarity(candidate, anchors) {
  let best = 0;
  for (const anchor of anchors) {
    const tokenOverlap = jaccard(anchor.tokens || [], candidate.tokens || []);
    const score =
      (anchor.brand && candidate.brand && anchor.brand === candidate.brand ? 0.5 : 0) +
      (anchor.category && candidate.category && anchor.category === candidate.category ? 0.35 : 0) +
      (anchor.parent_category && candidate.parentCategory && anchor.parent_category === candidate.parentCategory ? 0.1 : 0) +
      tokenOverlap * 0.35;
    if (score > best) best = score;
  }
  return Math.min(1, best);
}

function scoreRecentQueryOverlap(candidate, queryTokens) {
  if (!(queryTokens instanceof Set) || queryTokens.size === 0) return 0;
  const candidateTokens = new Set(candidate.tokens || []);
  let overlap = 0;
  for (const token of queryTokens) {
    if (candidateTokens.has(token)) overlap += 1;
  }
  return overlap / queryTokens.size;
}

function scoreCandidate(candidate, profile, surface) {
  const brandScore = mapScore(profile.brandAffinity, candidate.brand);
  const categoryScore = Math.max(
    mapScore(profile.categoryAffinity, candidate.category),
    mapScore(profile.categoryAffinity, candidate.parentCategory),
  );
  const anchorScore = scoreAnchorSimilarity(candidate, profile.anchors);
  const recentQueryScore = scoreRecentQueryOverlap(candidate, profile.queryTokens);
  const interestScore =
    brandScore * 0.46 +
    categoryScore * 0.31 +
    anchorScore * 0.18 +
    recentQueryScore * 0.05;
  const browseBase = Math.max(0, 1 - candidate.browseRank / MAX_CANDIDATE_FETCH);
  const finalScore =
    surface === 'home_hot_deals'
      ? interestScore + browseBase * 0.12
      : browseBase * 0.82 + interestScore * 0.45;
  return {
    brandScore,
    categoryScore,
    anchorScore,
    recentQueryScore,
    interestScore,
    browseBase,
    finalScore,
  };
}

function compareHomeEntries(a, b) {
  if (b.scores.finalScore !== a.scores.finalScore) return b.scores.finalScore - a.scores.finalScore;
  if (b.scores.interestScore !== a.scores.interestScore) return b.scores.interestScore - a.scores.interestScore;
  if (a.candidate.browseRank !== b.candidate.browseRank) return a.candidate.browseRank - b.candidate.browseRank;
  return a.candidate.key.localeCompare(b.candidate.key);
}

function compareBrowseEntries(a, b) {
  if (b.scores.finalScore !== a.scores.finalScore) return b.scores.finalScore - a.scores.finalScore;
  if (b.scores.browseBase !== a.scores.browseBase) return b.scores.browseBase - a.scores.browseBase;
  if (a.candidate.browseRank !== b.candidate.browseRank) return a.candidate.browseRank - b.candidate.browseRank;
  return a.candidate.key.localeCompare(b.candidate.key);
}

function selectHomeProducts(scoredCandidates, viewedKeys, limit, options = {}) {
  const collectDebug = options.collectDebug === true;
  const ranked = [...scoredCandidates].sort(compareHomeEntries);

  const selected = [];
  const decisions = collectDebug ? new Map() : null;
  const brandCounts = new Map();
  const rankedEligible = [];
  for (const entry of ranked) {
    if (viewedKeys.has(entry.candidate.key)) {
      if (decisions) decisions.set(entry.candidate.key, 'filtered_recent_view');
      continue;
    }
    rankedEligible.push(entry);
    if (selected.length >= limit) continue;
    const brandKey = entry.candidate.brand;
    const nextBrandCount = brandKey ? (brandCounts.get(brandKey) || 0) + 1 : 0;
    if (brandKey && nextBrandCount > 2) {
      if (decisions) decisions.set(entry.candidate.key, 'filtered_brand_cap');
      continue;
    }
    selected.push(entry);
    if (decisions) decisions.set(entry.candidate.key, 'selected');
    if (brandKey) brandCounts.set(brandKey, nextBrandCount);
  }

  for (const entry of rankedEligible) {
    if (selected.length >= limit) break;
    if (selected.some((picked) => picked.candidate.key === entry.candidate.key)) continue;
    selected.push(entry);
    if (decisions) decisions.set(entry.candidate.key, 'selected_fill');
  }

  const selectedItems = selected.slice(0, limit);
  if (!collectDebug) return selectedItems;

  for (const entry of rankedEligible) {
    if (!decisions.has(entry.candidate.key)) {
      decisions.set(entry.candidate.key, 'not_selected_limit');
    }
  }

  return {
    ranked,
    selected: selectedItems,
    eligiblePool: rankedEligible,
    decisions,
  };
}

function selectBrowseProducts(scoredCandidates, viewedKeys, page, limit, options = {}) {
  const collectDebug = options.collectDebug === true;
  const ranked = [...scoredCandidates].sort(compareBrowseEntries);
  const decisions = collectDebug ? new Map() : null;

  const orderedPool = [];
  if (page <= 1) {
    for (const entry of ranked) {
      if (viewedKeys.has(entry.candidate.key)) {
        if (decisions) decisions.set(entry.candidate.key, 'filtered_recent_view');
        continue;
      }
      orderedPool.push(entry);
    }
  } else {
    orderedPool.push(...ranked);
  }

  const start = (page - 1) * limit;
  const pageItems = orderedPool.slice(start, start + limit);
  if (!collectDebug) {
    return {
      orderedPool,
      pageItems,
    };
  }

  const selectedKeys = new Set(pageItems.map((entry) => entry.candidate.key));
  for (const entry of orderedPool) {
    if (decisions.has(entry.candidate.key)) continue;
    decisions.set(
      entry.candidate.key,
      selectedKeys.has(entry.candidate.key) ? 'selected' : 'page_window_excluded',
    );
  }

  return {
    ranked,
    orderedPool,
    pageItems,
    decisions,
  };
}

function formatDiscoveryResponseProduct(candidate) {
  return {
    ...candidate.raw,
    id: candidate.raw.id || candidate.productId,
    product_id: candidate.raw.product_id || candidate.productId,
    merchant_id: candidate.raw.merchant_id || candidate.merchantId,
    ...(candidate.raw.brand ? {} : candidate.brand ? { brand: candidate.brand } : {}),
    ...(candidate.raw.category ? {} : candidate.category ? { category: candidate.category } : {}),
    ...(candidate.raw.product_type || !candidate.category ? {} : { product_type: candidate.category }),
  };
}

function buildCandidateCounts({
  raw,
  normalized,
  scored,
  eligiblePool,
  returned,
} = {}) {
  return {
    raw: Number(raw || 0),
    normalized: Number(normalized || 0),
    scored: Number(scored || 0),
    eligible_pool: Number(eligiblePool || 0),
    returned: Number(returned || 0),
  };
}

function getCandidateSource(options = {}) {
  if (Array.isArray(options.candidateProducts)) return 'override';
  return 'products_search';
}

function topMapEntries(map, limit = 5) {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key, score]) => ({
      key,
      score: roundMetric(score),
    }));
}

function buildRankDebug({
  ranked,
  orderedPool,
  decisions,
  profile,
  topCandidates,
  recallSummary,
} = {}) {
  const decisionMap = decisions instanceof Map ? decisions : new Map();
  const poolRanks = new Map(
    Array.isArray(orderedPool)
      ? orderedPool.map((entry, idx) => [entry.candidate.key, idx + 1])
      : [],
  );

  return {
    top_candidates: (Array.isArray(ranked) ? ranked : []).slice(0, topCandidates).map((entry, idx) => ({
      rank: idx + 1,
      pool_rank: poolRanks.get(entry.candidate.key) || null,
      decision: decisionMap.get(entry.candidate.key) || 'not_selected',
      merchant_id: entry.candidate.merchantId,
      product_id: entry.candidate.productId,
      title: entry.candidate.raw.title || '',
      brand: entry.candidate.raw.brand || entry.candidate.brand || null,
      category: entry.candidate.raw.category || entry.candidate.parentCategory || null,
      product_type: entry.candidate.raw.product_type || entry.candidate.category || null,
      scores: {
        final_score: roundMetric(entry.scores.finalScore),
        interest_score: roundMetric(entry.scores.interestScore),
        browse_base: roundMetric(entry.scores.browseBase),
        brand_score: roundMetric(entry.scores.brandScore),
        category_score: roundMetric(entry.scores.categoryScore),
        anchor_score: roundMetric(entry.scores.anchorScore),
        recent_query_score: roundMetric(entry.scores.recentQueryScore),
      },
    })),
    profile_summary: {
      top_brands: topMapEntries(profile.brandAffinity, 5),
      top_categories: topMapEntries(profile.categoryAffinity, 5),
      anchors: (profile.anchors || []).slice(0, MAX_ANCHORS).map((anchor) => ({
        merchant_id: anchor.merchant_id || null,
        product_id: anchor.product_id || null,
        brand: anchor.brand || null,
        category: anchor.category || anchor.parent_category || null,
      })),
      recent_query_tokens: Array.from(profile.queryTokens || []).sort((a, b) => a.localeCompare(b)),
    },
    recall_summary: (Array.isArray(recallSummary) ? recallSummary : []).map((step) => ({
      label: String(step?.label || '').trim() || 'unknown',
      query: step?.query ? String(step.query) : null,
      offset: Number(step?.offset || 0),
      limit: Number(step?.limit || 0),
      status: step?.status == null ? null : Number(step.status),
      returned: Number(step?.returned || 0),
      ...(step?.error ? { error: String(step.error) } : {}),
    })),
  };
}

async function getDiscoveryFeed(payload = {}, options = {}) {
  const startedAt = Date.now();
  let request = null;
  let profile = null;
  let strategy = 'unknown';
  let personalizationSource = 'unknown';
  const candidateSource = getCandidateSource(options);
  let candidateCounts = buildCandidateCounts();
  let recallSummary = [];

  try {
    request = normalizeDiscoveryRequest(payload);
    profile = buildDiscoveryProfile(request.context);
    strategy = profile.hasInterestSignals ? 'personalized_interest' : 'cold_start_curated';
    personalizationSource =
      strategy === 'personalized_interest' ? profile.personalizationSource : 'none';

    const candidateLoadResult = Array.isArray(options.candidateProducts)
      ? {
          products: options.candidateProducts,
          recallSummary: [],
        }
      : await loadCatalogCandidates({
          request,
          profile,
          limit: options.candidateLimit || MAX_CANDIDATE_FETCH,
        });
    const rawCandidates = Array.isArray(candidateLoadResult?.products)
      ? candidateLoadResult.products
      : [];
    recallSummary = Array.isArray(candidateLoadResult?.recallSummary)
      ? candidateLoadResult.recallSummary
      : [];
    observeDiscoveryCandidateCount({
      surface: request.surface,
      stage: 'raw',
      count: rawCandidates.length,
    });

    const normalizedCandidates = [];
    const seenKeys = new Set();
    for (let idx = 0; idx < rawCandidates.length; idx += 1) {
      const normalized = normalizeCandidateProduct(rawCandidates[idx], idx);
      if (!normalized || seenKeys.has(normalized.key)) continue;
      seenKeys.add(normalized.key);
      normalizedCandidates.push(normalized);
    }
    observeDiscoveryCandidateCount({
      surface: request.surface,
      stage: 'normalized',
      count: normalizedCandidates.length,
    });

    const viewedKeys = new Set(
      (request.context.recent_views || [])
        .map((view) => buildProductKey(view.merchant_id, view.product_id))
        .filter(Boolean),
    );

    const scoredCandidates = normalizedCandidates.map((candidate) => ({
      candidate,
      scores: scoreCandidate(candidate, profile, request.surface),
    }));
    observeDiscoveryCandidateCount({
      surface: request.surface,
      stage: 'scored',
      count: scoredCandidates.length,
    });

    let selectedEntries;
    let total;
    let eligiblePoolCount = 0;
    let ranked = [];
    let orderedPool = [];
    let decisions = new Map();

    if (request.surface === 'home_hot_deals') {
      const homeSelection = selectHomeProducts(
        scoredCandidates,
        viewedKeys,
        request.limit,
        { collectDebug: request.debug.enabled },
      );
      if (request.debug.enabled) {
        selectedEntries = homeSelection.selected;
        total = homeSelection.eligiblePool.length;
        eligiblePoolCount = homeSelection.eligiblePool.length;
        ranked = homeSelection.ranked;
        orderedPool = homeSelection.eligiblePool;
        decisions = homeSelection.decisions;
      } else {
        selectedEntries = homeSelection;
        total = scoredCandidates.filter((entry) => !viewedKeys.has(entry.candidate.key)).length;
        eligiblePoolCount = total;
      }
    } else {
      const browseSelection = selectBrowseProducts(
        scoredCandidates,
        viewedKeys,
        request.page,
        request.limit,
        { collectDebug: request.debug.enabled },
      );
      selectedEntries = browseSelection.pageItems;
      total = browseSelection.orderedPool.length;
      eligiblePoolCount = browseSelection.orderedPool.length;
      if (request.debug.enabled) {
        ranked = browseSelection.ranked;
        orderedPool = browseSelection.orderedPool;
        decisions = browseSelection.decisions;
      }
    }

    candidateCounts = buildCandidateCounts({
      raw: rawCandidates.length,
      normalized: normalizedCandidates.length,
      scored: scoredCandidates.length,
      eligiblePool: eligiblePoolCount,
      returned: selectedEntries.length,
    });

    observeDiscoveryCandidateCount({
      surface: request.surface,
      stage: 'eligible_pool',
      count: eligiblePoolCount,
    });
    observeDiscoveryCandidateCount({
      surface: request.surface,
      stage: 'returned',
      count: selectedEntries.length,
    });

    const latencyMs = Date.now() - startedAt;
    const metadata = {
      discovery_strategy: strategy,
      personalization_source: personalizationSource,
      history_items_used: profile.historyItemsUsed,
      anchor_count: profile.anchors.length,
      scoring_version: SCORING_VERSION,
      surface: request.surface,
      locale: request.context.locale,
      candidate_source: candidateSource,
      candidate_counts: candidateCounts,
      request_latency_ms: latencyMs,
    };

    if (request.debug.enabled) {
      metadata.rank_debug = buildRankDebug({
        ranked,
        orderedPool,
        decisions,
        profile,
        topCandidates: request.debug.top_candidates,
        recallSummary,
      });
    }

    const response = {
      status: 'success',
      success: true,
      products: selectedEntries.map((entry) => formatDiscoveryResponseProduct(entry.candidate)),
      total,
      page: request.page,
      page_size: selectedEntries.length,
      metadata,
    };

    recordDiscoveryFeedRequest({
      surface: request.surface,
      status: 'success',
      strategy,
      personalizationSource,
      candidateSource,
      reason: 'none',
    });
    observeDiscoveryFeedLatency({
      surface: request.surface,
      status: 'success',
      latencyMs,
    });
    setLastDiscoverySnapshot({
      surface: request.surface,
      status: 'success',
      strategy,
      personalization_source: personalizationSource,
      candidate_source: candidateSource,
      candidate_counts: candidateCounts,
      history_items_used: profile.historyItemsUsed,
      anchor_count: profile.anchors.length,
      total,
      page: request.page,
      limit: request.limit,
      returned_count: selectedEntries.length,
      latency_ms: latencyMs,
    });
    logger.info(
      {
        surface: request.surface,
        page: request.page,
        limit: request.limit,
        strategy,
        personalization_source: personalizationSource,
        candidate_source: candidateSource,
        candidate_counts: candidateCounts,
        latency_ms: latencyMs,
      },
      'discovery feed built',
    );

    return response;
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const status =
      err instanceof DiscoveryValidationError || Number(err?.statusCode) === 400
        ? 'validation_error'
        : err instanceof DiscoveryCatalogUnavailableError || Number(err?.statusCode) === 503
          ? 'catalog_unavailable'
          : 'error';
    const surface =
      request?.surface || String(payload?.surface || payload?.discovery?.surface || '').trim() || 'unknown';

    recordDiscoveryFeedRequest({
      surface,
      status,
      strategy,
      personalizationSource,
      candidateSource,
      reason: err?.code || err?.name || 'unknown_error',
    });
    observeDiscoveryFeedLatency({
      surface,
      status,
      latencyMs,
    });
    setLastDiscoverySnapshot({
      surface,
      status,
      strategy,
      personalization_source: personalizationSource,
      candidate_source: candidateSource,
      candidate_counts: candidateCounts,
      latency_ms: latencyMs,
      error_code: err?.code || err?.name || 'UNKNOWN_ERROR',
      error_message: err?.message || 'Unknown discovery error',
    });
    throw err;
  }
}

module.exports = {
  DiscoveryCatalogUnavailableError,
  DiscoveryValidationError,
  buildDiscoveryProfile,
  getDiscoveryFeed,
  _internals: {
    normalizeDiscoveryRequest,
    normalizeCandidateProduct,
    scoreCandidate,
    selectBrowseProducts,
    selectHomeProducts,
    buildProductKey,
  },
};
