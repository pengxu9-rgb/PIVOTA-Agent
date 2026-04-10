#!/usr/bin/env node
/* eslint-disable no-console */
const DEFAULT_BASE_URL = 'https://pivota-agent-production.up.railway.app';
const DEFAULT_ENDPOINT = '/agent/shop/v1/invoke';
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_LOCALE = 'en-US';
const EXPECTED_CANDIDATE_SOURCE = 'multi_provider';

function firstNonEmpty(values) {
  for (const value of values || []) {
    const normalized = String(value || '').trim();
    if (normalized) return normalized;
  }
  return '';
}

function normalizeBaseUrl(raw) {
  return String(raw || '').trim().replace(/\/+$/, '');
}

function normalizeEndpoint(raw) {
  const value = String(raw || '').trim();
  if (!value) return DEFAULT_ENDPOINT;
  return value.startsWith('/') ? value : `/${value}`;
}

function buildAuthHeaders(authInput, authTokenInput = '') {
  let apiKey = '';
  let authToken = '';
  if (authInput && typeof authInput === 'object' && !Array.isArray(authInput)) {
    apiKey = String(authInput.apiKey || '').trim();
    authToken = String(authInput.authToken || '').trim();
  } else {
    apiKey = String(authInput || '').trim();
    authToken = String(authTokenInput || apiKey || '').trim();
  }

  const headers = {};
  if (apiKey) {
    headers['X-Agent-API-Key'] = apiKey;
  }
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }
  return headers;
}

function deriveRecentQuery(seedProduct) {
  if (!seedProduct || typeof seedProduct !== 'object') return 'recommended products';
  return firstNonEmpty([
    seedProduct.product_type,
    seedProduct.category,
    seedProduct.brand,
    seedProduct.title,
    'recommended products',
  ]);
}

function buildRecentView(seedProduct) {
  if (!seedProduct || typeof seedProduct !== 'object') {
    throw new Error('seed product is required to build recent view');
  }
  return {
    merchant_id: String(seedProduct.merchant_id || seedProduct.merchantId || '').trim(),
    product_id: String(seedProduct.product_id || seedProduct.productId || seedProduct.id || '').trim(),
    title: String(seedProduct.title || seedProduct.name || '').trim(),
    description: String(seedProduct.description || '').trim(),
    brand: String(seedProduct.brand || '').trim(),
    category: String(seedProduct.category || '').trim(),
    product_type: String(seedProduct.product_type || seedProduct.productType || '').trim(),
    viewed_at: new Date().toISOString(),
    history_source: 'account',
  };
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function summarizeProducts(products) {
  return (Array.isArray(products) ? products : []).slice(0, 5).map((product) => ({
    merchant_id: product?.merchant_id || product?.merchantId || null,
    product_id: product?.product_id || product?.productId || product?.id || null,
    title: product?.title || product?.name || null,
  }));
}

function matchesDisallowedTitle(title, patterns) {
  const normalizedTitle = String(title || '').trim();
  if (!normalizedTitle) return false;
  return (Array.isArray(patterns) ? patterns : []).some((pattern) => {
    if (pattern instanceof RegExp) return pattern.test(normalizedTitle);
    const text = String(pattern || '').trim();
    return text ? new RegExp(text, 'i').test(normalizedTitle) : false;
  });
}

function validateDiscoveryResponse(response, expectations = {}) {
  ensure(response && typeof response === 'object', 'response must be an object');
  const products = Array.isArray(response.products) ? response.products : [];
  const metadata = response.metadata && typeof response.metadata === 'object' ? response.metadata : {};
  const providerBreakdown = Array.isArray(metadata.provider_breakdown) ? metadata.provider_breakdown : [];
  const summarizedProviderBreakdown = providerBreakdown.map((entry) => ({
    provider: entry?.provider || null,
    successful: entry?.successful === true,
    returned: Number(entry?.returned || 0),
    skipped: entry?.skipped === true,
    failure_reason: entry?.failure_reason || entry?.zero_recall_reason || null,
  }));
  ensure(
    String(metadata.catalog_status || '') !== 'unavailable',
    `response reported unavailable discovery catalog: ${JSON.stringify({
      catalog_status: metadata.catalog_status,
      provider_breakdown: summarizedProviderBreakdown,
    })}`,
  );
  ensure(
    providerBreakdown.some((entry) => entry?.successful === true),
    `response reported no successful discovery providers: ${JSON.stringify(summarizedProviderBreakdown)}`,
  );
  const productsSearchBreakdown = providerBreakdown.find(
    (entry) => String(entry?.provider || '').trim() === 'products_search',
  );
  const disallowedProductsSearchFailures = new Set(['missing_base_url', 'http_401', 'http_403', 'timeout']);
  ensure(
    !disallowedProductsSearchFailures.has(String(productsSearchBreakdown?.failure_reason || '').trim()),
    `products_search provider degraded unexpectedly: ${JSON.stringify({
      provider: productsSearchBreakdown?.provider || null,
      failure_reason: productsSearchBreakdown?.failure_reason || null,
      returned: Number(productsSearchBreakdown?.returned || 0),
    })}`,
  );
  const minimumProducts = expectations.minProducts || 1;
  ensure(
    products.length >= minimumProducts,
    `response returned insufficient products: ${JSON.stringify({
      returned: products.length,
      required: minimumProducts,
      titles: summarizeProducts(products),
      strategy: metadata.discovery_strategy || null,
      candidate_source: metadata.candidate_source || null,
      candidate_counts: metadata.candidate_counts || {},
      filter_counts: metadata.filter_counts || {},
      provider_breakdown: summarizedProviderBreakdown,
    })}`,
  );
  if (Array.isArray(expectations.candidateSource)) {
    const allowed = new Set(expectations.candidateSource.map((value) => String(value || '').trim()).filter(Boolean));
    ensure(
      allowed.has(String(metadata.candidate_source || '').trim()),
      `unexpected candidate_source: ${metadata.candidate_source || 'missing'}`,
    );
  } else {
    ensure(
      String(metadata.candidate_source || '') === String(expectations.candidateSource || EXPECTED_CANDIDATE_SOURCE),
      `unexpected candidate_source: ${metadata.candidate_source || 'missing'}`,
    );
  }

  if (expectations.discoveryStrategy) {
    ensure(
      String(metadata.discovery_strategy || '') === String(expectations.discoveryStrategy),
      `unexpected discovery_strategy: ${metadata.discovery_strategy || 'missing'}`,
    );
  }

  if (expectations.personalizationSource) {
    ensure(
      String(metadata.personalization_source || '') === String(expectations.personalizationSource),
      `unexpected personalization_source: ${metadata.personalization_source || 'missing'}`,
    );
  }

  if (expectations.requireRankDebug) {
    ensure(metadata.rank_debug && typeof metadata.rank_debug === 'object', 'rank_debug is missing');
    ensure(
      Array.isArray(metadata.rank_debug.recall_summary) && metadata.rank_debug.recall_summary.length > 0,
      'rank_debug.recall_summary is missing',
    );
  }

  if (Array.isArray(expectations.requiredProviders) && expectations.requiredProviders.length > 0) {
    const providerNames = new Set(
      (Array.isArray(metadata.provider_breakdown) ? metadata.provider_breakdown : [])
        .map((entry) => String(entry?.provider || '').trim())
        .filter(Boolean),
    );
    expectations.requiredProviders.forEach((provider) => {
      ensure(providerNames.has(String(provider || '').trim()), `missing provider breakdown entry: ${provider}`);
    });
  }

  if (Array.isArray(expectations.requiredRecallLabels) && expectations.requiredRecallLabels.length > 0) {
    const labels = new Set(
      (Array.isArray(metadata.rank_debug?.recall_summary) ? metadata.rank_debug.recall_summary : [])
        .map((step) => String(step?.label || '').trim())
        .filter(Boolean),
    );
    expectations.requiredRecallLabels.forEach((labelOrLabels) => {
      if (Array.isArray(labelOrLabels)) {
        ensure(
          labelOrLabels.some((label) => labels.has(String(label || '').trim())),
          `missing recall label any-of: ${labelOrLabels.join(', ')}`,
        );
        return;
      }
      const label = String(labelOrLabels || '').trim();
      ensure(labels.has(label), `missing recall label: ${label}`);
    });
  }

  if (Array.isArray(expectations.excludeProductKeys) && expectations.excludeProductKeys.length > 0) {
    const returnedKeys = new Set(
      products.map((product) =>
        `${String(product?.merchant_id || product?.merchantId || '').trim()}::${String(
          product?.product_id || product?.productId || product?.id || '',
        ).trim()}`,
      ),
    );
    expectations.excludeProductKeys.forEach((key) => {
      ensure(!returnedKeys.has(key), `suppressed product returned unexpectedly: ${key}`);
    });
  }

  if (Array.isArray(expectations.disallowTitlePatterns) && expectations.disallowTitlePatterns.length > 0) {
    const offenders = products
      .slice(0, Math.max(1, Number(expectations.disallowTopN || 3)))
      .filter((product) => matchesDisallowedTitle(product?.title || product?.name || '', expectations.disallowTitlePatterns))
      .map((product) => product?.title || product?.name || '');
    ensure(offenders.length === 0, `disallowed cold-start titles returned: ${offenders.join(' | ')}`);
  }

  return {
    productCount: products.length,
    strategy: metadata.discovery_strategy || null,
    personalizationSource: metadata.personalization_source || null,
    candidateSource: metadata.candidate_source || null,
    providerBreakdown,
    topProducts: summarizeProducts(products),
    recallSummary: Array.isArray(metadata.rank_debug?.recall_summary)
      ? metadata.rank_debug.recall_summary
      : [],
  };
}

function pickSeedProduct(response) {
  const products = Array.isArray(response?.products) ? response.products : [];
  const seed = products.find((product) => {
    const merchantId = String(product?.merchant_id || product?.merchantId || '').trim();
    const productId = String(product?.product_id || product?.productId || product?.id || '').trim();
    const title = String(product?.title || product?.name || '').trim();
    return Boolean(merchantId && productId && title);
  });
  if (!seed) throw new Error('could not pick a seed product from discovery response');
  return seed;
}

async function postDiscoveryFeed({ baseUrl, endpoint, apiKey, authToken, payload, metadata, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildAuthHeaders({ apiKey, authToken }),
      },
      body: JSON.stringify({
        operation: 'get_discovery_feed',
        payload,
        metadata,
      }),
      signal: controller.signal,
    });

    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch (err) {
      throw new Error(`failed to parse response JSON: ${text}`);
    }

    if (!response.ok) {
      throw new Error(
        `discovery feed request failed with status ${response.status}: ${JSON.stringify(data)}`,
      );
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function runSmoke(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl || process.env.BASE_URL || DEFAULT_BASE_URL);
  const endpoint = normalizeEndpoint(options.endpoint || process.env.ENDPOINT || DEFAULT_ENDPOINT);
  const timeoutMs = Number(options.timeoutMs || process.env.TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const locale = String(options.locale || process.env.LOCALE || DEFAULT_LOCALE).trim() || DEFAULT_LOCALE;
  const apiKey = firstNonEmpty([
    options.apiKey,
    process.env.CREATOR_AGENT_API_KEY,
    process.env.PIVOTA_AGENT_API_KEY,
    process.env.SHOP_GATEWAY_AGENT_API_KEY,
    process.env.AGENT_API_KEY,
    process.env.PIVOTA_API_KEY,
  ]);
  const authToken = firstNonEmpty([
    options.authToken,
    process.env.AUTH_TOKEN,
    process.env.COMMERCE_CORE_PROD_AUTH_TOKEN,
    process.env.PIVOTA_AGENT_PROD_AUTH_TOKEN,
    process.env.PIVOTA_AUTH_TOKEN,
    apiKey,
  ]);
  const tracePrefix = `discovery_smoke_${Date.now()}`;
  const source = String(options.source || process.env.SOURCE || 'shopping_agent').trim() || 'shopping_agent';

  console.log(`BASE_URL=${baseUrl}`);
  console.log(`ENDPOINT=${endpoint}`);
  console.log(`TIMEOUT_MS=${timeoutMs}`);
  console.log(`SOURCE=${source}`);
  console.log(`API_KEY_CONFIGURED=${apiKey ? 'true' : 'false'}`);
  console.log(`AUTH_TOKEN_CONFIGURED=${authToken ? 'true' : 'false'}`);

  const coldStart = await postDiscoveryFeed({
    baseUrl,
    endpoint,
    apiKey,
    authToken,
    timeoutMs,
    payload: {
      surface: 'home_hot_deals',
      page: 1,
      limit: 6,
      debug: true,
      context: {
        auth_state: 'anonymous',
        locale,
        recent_views: [],
        recent_queries: [],
      },
    },
    metadata: {
      source,
      trace_id: `${tracePrefix}_cold_start`,
    },
  });

  const coldStartResult = validateDiscoveryResponse(coldStart, {
    discoveryStrategy: 'cold_start_curated',
    personalizationSource: 'none',
    candidateSource: [
      EXPECTED_CANDIDATE_SOURCE,
      'products_search+external_seed_fastpath',
      'external_seed_fastpath',
      'external_seed_fastpath+products_search',
    ],
    minProducts: 3,
    requireRankDebug: true,
    requiredRecallLabels: [['cold_start_curated', 'cold_start_fill', 'external_seed_pool_fastpath']],
    requiredProviders: ['products_search', 'external_seeds'],
    disallowTopN: 3,
    disallowTitlePatterns: [
      '\\bpet\\b',
      '\\bdog\\b',
      '\\bcat\\b',
      '\\blingerie\\b',
      '\\bsleepwear\\b',
      '\\bbralette\\b',
      '\\bpajama\\b',
      '\\bnightwear\\b',
    ],
  });
  console.log(`PASS cold_start_home ${JSON.stringify(coldStartResult)}`);

  const seedProduct = pickSeedProduct(coldStart);
  const recentView = buildRecentView(seedProduct);
  const recentQuery = deriveRecentQuery(seedProduct);
  const suppressedKey = `${recentView.merchant_id}::${recentView.product_id}`;

  const personalizedHome = await postDiscoveryFeed({
    baseUrl,
    endpoint,
    apiKey,
    authToken,
    timeoutMs,
    payload: {
      surface: 'home_hot_deals',
      page: 1,
      limit: 6,
      debug: true,
      context: {
        auth_state: 'authenticated',
        locale,
        recent_views: [recentView],
        recent_queries: [recentQuery],
      },
    },
    metadata: {
      source,
      trace_id: `${tracePrefix}_personalized_home`,
    },
  });

  const personalizedHomeResult = validateDiscoveryResponse(personalizedHome, {
    discoveryStrategy: 'personalized_interest',
    personalizationSource: 'account_history',
    candidateSource: [EXPECTED_CANDIDATE_SOURCE, 'beauty_interest_mainline', 'beauty_interest_mainline+multi_provider'],
    minProducts: 4,
    requireRankDebug: true,
    requiredRecallLabels: [
      ['interest_pool', 'external_seed_pool_fastpath', 'beauty_interest_mainline'],
      ['expansion_pool', 'external_seed_pool_fastpath', 'beauty_interest_mainline'],
    ],
    excludeProductKeys: [suppressedKey],
  });
  console.log(`PASS personalized_home ${JSON.stringify(personalizedHomeResult)}`);

  const browsePageOne = await postDiscoveryFeed({
    baseUrl,
    endpoint,
    apiKey,
    authToken,
    timeoutMs,
    payload: {
      surface: 'browse_products',
      page: 1,
      limit: 6,
      debug: true,
      context: {
        auth_state: 'authenticated',
        locale,
        recent_views: [recentView],
        recent_queries: [recentQuery],
      },
    },
    metadata: {
      source,
      trace_id: `${tracePrefix}_browse_page_one`,
    },
  });

  const browsePageOneResult = validateDiscoveryResponse(browsePageOne, {
    discoveryStrategy: 'personalized_interest',
    personalizationSource: 'account_history',
    candidateSource: [EXPECTED_CANDIDATE_SOURCE, 'beauty_interest_mainline', 'beauty_interest_mainline+multi_provider'],
    minProducts: 6,
    requireRankDebug: true,
    requiredRecallLabels: [['browse_pool', 'expansion_pool', 'beauty_interest_mainline']],
    excludeProductKeys: [suppressedKey],
  });
  console.log(`PASS browse_page_one ${JSON.stringify(browsePageOneResult)}`);

  console.log('PASS discovery feed smoke');
  return {
    coldStart: coldStartResult,
    personalizedHome: personalizedHomeResult,
    browsePageOne: browsePageOneResult,
  };
}

if (require.main === module) {
  runSmoke().catch((err) => {
    console.error(`FAIL discovery feed smoke: ${err?.message || String(err)}`);
    process.exit(1);
  });
}

module.exports = {
  buildAuthHeaders,
  buildRecentView,
  deriveRecentQuery,
  normalizeBaseUrl,
  normalizeEndpoint,
  pickSeedProduct,
  runSmoke,
  validateDiscoveryResponse,
};
