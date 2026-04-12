const axios = require('axios');

function asString(value) {
  const normalized = String(value || '').trim();
  return normalized || '';
}

function asNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function uniqStrings(values = [], limit = 64) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : [values]) {
    const normalized = asString(value);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function encodeBase64UrlJson(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function decodeBase64UrlJson(raw) {
  const normalized = asString(raw).replace(/-/g, '+').replace(/_/g, '/');
  if (!normalized) return null;
  const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
}

function getCatalogServingIndexConfig(env = process.env) {
  const baseUrl = asString(env.CATALOG_SERVING_INDEX_BASE_URL).replace(/\/+$/g, '');
  const indexName = asString(env.CATALOG_SERVING_INDEX_NAME) || 'catalog_public_v1';
  const apiKey = asString(env.CATALOG_SERVING_INDEX_API_KEY);
  const shadowReadEnabled =
    asString(env.CATALOG_SERVING_INDEX_SHADOW_READ_ENABLED).toLowerCase() === 'true';
  return {
    base_url: baseUrl,
    index_name: indexName,
    api_key: apiKey || null,
    shadow_read_enabled: shadowReadEnabled,
    enabled: Boolean(baseUrl),
  };
}

function isCatalogServingIndexEnabled(env = process.env) {
  return getCatalogServingIndexConfig(env).enabled;
}

function extractPriceAmount(source) {
  if (!source || typeof source !== 'object') return null;
  if (typeof source.amount === 'number') return source.amount;
  if (typeof source.price === 'number') return source.price;
  if (typeof source.current?.amount === 'number') return source.current.amount;
  return null;
}

function extractOfferAmounts(offers = []) {
  return (Array.isArray(offers) ? offers : [])
    .map((offer) => {
      if (!offer || typeof offer !== 'object') return null;
      return extractPriceAmount(offer.price || offer.current_price || offer);
    })
    .filter((amount) => Number.isFinite(amount));
}

function resolveAvailabilityState(input = {}) {
  if (input.in_stock === false) return 'out_of_stock';
  const normalized = asString(input.availability || input.availability_state).toLowerCase();
  if (!normalized) return input.in_stock === false ? 'out_of_stock' : 'available';
  if (['out_of_stock', 'sold_out', 'unavailable'].includes(normalized)) return 'out_of_stock';
  if (['preorder', 'backorder'].includes(normalized)) return normalized;
  return 'available';
}

function resolveCategoryPaths(input = {}) {
  return uniqStrings(
    [
      input.category,
      input.product_type,
      input.department,
      ...(Array.isArray(input.category_paths) ? input.category_paths : []),
    ],
    16,
  );
}

function resolveSourceRefs(input = {}) {
  const groupMembers = Array.isArray(input.group_members) ? input.group_members : [];
  const explicitRefs = groupMembers
    .map((member) => {
      const merchantId = asString(member?.merchant_id);
      const productId = asString(member?.product_id);
      if (!merchantId || !productId) return null;
      return `${merchantId}:${productId}`;
    })
    .filter(Boolean);
  if (explicitRefs.length) return explicitRefs;
  const merchantId = asString(input.merchant_id);
  const productId = asString(input.product_id || input.id);
  if (merchantId && productId) return [`${merchantId}:${productId}`];
  return [];
}

function resolvePublishState(input = {}, options = {}) {
  const explicit = asString(options.publish_state || input.publish_state).toLowerCase();
  if (['shadow', 'eligible', 'public', 'suppressed'].includes(explicit)) return explicit;
  return options.shadow === true ? 'shadow' : 'public';
}

function resolvePivotaInsightSummary(input = {}) {
  return (
    asString(input.pivota_insight_summary) ||
    asString(input.card_intro) ||
    asString(input.shopping_card?.intro) ||
    asString(input.product_intel?.product_intel_core?.what_it_is?.body)
  );
}

function resolvePivotaInsightStatus(input = {}) {
  const explicit = asString(input.pivota_insight_status).toLowerCase();
  if (explicit) return explicit;
  return resolvePivotaInsightSummary(input) ? 'available' : 'missing';
}

function buildCatalogServingDoc(input = {}, options = {}) {
  const productId = asString(input.product_id || input.id);
  const merchantId = asString(input.merchant_id);
  const sellableItemGroupId = asString(input.sellable_item_group_id);
  const productLineId = asString(input.product_line_id);
  const reviewFamilyId = asString(input.review_family_id) || productLineId;
  const brandName = asString(input.brand || input.brand_name || input.vendor);
  const categoryPaths = resolveCategoryPaths(input);
  const offers = Array.isArray(input.offers) ? input.offers : [];
  const offerAmounts = extractOfferAmounts(offers);
  const productAmount = asNumber(input.price);
  const allAmounts = productAmount != null ? [productAmount, ...offerAmounts] : offerAmounts;
  const priceMin = allAmounts.length ? Math.min(...allAmounts) : null;
  const priceMax = allAmounts.length ? Math.max(...allAmounts) : null;
  const externalOfferExists =
    Boolean(asString(input.external_redirect_url || input.external_url || input.destination_url)) ||
    offers.some((offer) => Boolean(asString(offer?.external_redirect_url || offer?.redirect_url)));
  const internalOfferExists =
    Boolean(offers.some((offer) => !asString(offer?.external_redirect_url || offer?.redirect_url))) ||
    (Boolean(merchantId) && merchantId !== 'external_seed' && !externalOfferExists);
  const heroMediaUrl =
    asString(input.image_url) ||
    asString(Array.isArray(input.images) ? input.images[0]?.url || input.images[0] : '');
  const previewMedia = uniqStrings(
    Array.isArray(input.images)
      ? input.images.map((item) => (typeof item === 'string' ? item : item?.url))
      : [],
    8,
  );
  const updatedAt = asString(input.updated_at || input.updatedAt || options.updated_at);
  const subtitle =
    asString(input.card_subtitle) ||
    asString(input.shopping_card?.subtitle) ||
    asString(input.description);

  return {
    doc_id:
      sellableItemGroupId
        ? `sellable:${sellableItemGroupId}`
        : merchantId && productId
          ? `source:${merchantId}:${productId}`
          : `product:${productId || 'unknown'}`,
    sellable_item_group_id: sellableItemGroupId || null,
    product_line_id: productLineId || null,
    review_family_id: reviewFamilyId || null,
    brand_name: brandName || null,
    category_paths: categoryPaths,
    market: asString(options.market || input.market || input.region || 'US') || 'US',
    availability_state: resolveAvailabilityState(input),
    publish_state: resolvePublishState(input, options),
    title: asString(input.card_title || input.title || input.name || productId),
    subtitle: subtitle || null,
    variant_axes:
      input.variant_axes && typeof input.variant_axes === 'object' && !Array.isArray(input.variant_axes)
        ? input.variant_axes
        : {},
    size: asString(input.size) || null,
    shade: asString(input.shade) || null,
    pack: asString(input.pack) || null,
    hero_media: heroMediaUrl
      ? {
          url: heroMediaUrl,
          source_kind: asString(input.source || 'catalog'),
          source_tier: asString(input.source_tier || input.identity_graph?.source_tier || 'catalog'),
        }
      : null,
    preview_media: previewMedia,
    price_min: priceMin,
    price_max: priceMax,
    default_offer_id: asString(input.default_offer_id) || null,
    internal_offer_exists: internalOfferExists,
    external_offer_exists: externalOfferExists,
    pivota_insight_status: resolvePivotaInsightStatus(input),
    pivota_insight_summary: resolvePivotaInsightSummary(input) || null,
    quality_score: asNumber(input.quality_score),
    browse_score: asNumber(input.browse_score),
    facet_tokens: uniqStrings(
      [
        brandName,
        ...categoryPaths,
        ...(Array.isArray(input.tags) ? input.tags : []),
      ],
      32,
    ),
    sort_keys: {
      price_min: priceMin,
      price_max: priceMax,
      updated_at: updatedAt || null,
    },
    updated_at: updatedAt || null,
    source_refs: resolveSourceRefs(input),
  };
}

function buildCatalogServingSearchSort(sort = 'popular') {
  if (sort === 'price_desc') {
    return [
      { price_max: 'desc' },
      { updated_at: 'desc' },
      { sellable_item_group_id: 'asc' },
    ];
  }
  if (sort === 'price_asc') {
    return [
      { price_min: 'asc' },
      { updated_at: 'desc' },
      { sellable_item_group_id: 'asc' },
    ];
  }
  return [
    { browse_score: 'desc' },
    { updated_at: 'desc' },
    { sellable_item_group_id: 'asc' },
  ];
}

function encodeCatalogServingCursor(searchAfterValues = []) {
  if (!Array.isArray(searchAfterValues) || searchAfterValues.length < 1) return null;
  return encodeBase64UrlJson({ search_after: searchAfterValues });
}

function decodeCatalogServingCursor(rawCursor) {
  if (!asString(rawCursor)) return null;
  const decoded = decodeBase64UrlJson(rawCursor);
  return Array.isArray(decoded?.search_after) ? decoded.search_after : null;
}

function buildCatalogServingSearchBody({
  query_text = '',
  brand_names = [],
  categories = [],
  market = 'US',
  limit = 24,
  cursor = null,
  sort = 'popular',
} = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit || 24) || 24, 100));
  const filter = [
    { term: { publish_state: 'public' } },
    { term: { market: asString(market || 'US') || 'US' } },
  ];
  const must = [];
  const brandTerms = uniqStrings(brand_names, 12);
  const categoryTerms = uniqStrings(categories, 12);
  const queryText = asString(query_text);

  if (brandTerms.length) {
    filter.push({ terms: { brand_name: brandTerms } });
  }
  if (categoryTerms.length) {
    filter.push({ terms: { category_paths: categoryTerms } });
  }
  if (queryText) {
    must.push({
      multi_match: {
        query: queryText,
        fields: [
          'title^4',
          'subtitle^2',
          'brand_name^3',
          'facet_tokens^2',
          'pivota_insight_summary',
        ],
        type: 'best_fields',
      },
    });
  }

  const body = {
    size: safeLimit,
    track_total_hits: false,
    query: {
      bool: {
        ...(must.length ? { must } : { must: [{ match_all: {} }] }),
        filter,
      },
    },
    sort: buildCatalogServingSearchSort(sort),
  };
  const searchAfter = decodeCatalogServingCursor(cursor);
  if (searchAfter) {
    body.search_after = searchAfter;
  }
  return body;
}

async function searchCatalogServingIndex(params = {}, { httpClient = axios, env = process.env } = {}) {
  const config = getCatalogServingIndexConfig(env);
  if (!config.enabled) {
    return {
      items: [],
      cursor_info: {
        next_cursor: null,
        has_next_page: false,
        serving_mode: 'exhaustive',
      },
      source: 'disabled',
    };
  }

  const body = buildCatalogServingSearchBody(params);
  const timeoutMs = Math.max(100, Math.min(Number(params.timeout_ms || 0) || 800, 5000));
  const response = await httpClient.post(
    `${config.base_url}/${encodeURIComponent(config.index_name)}/_search`,
    body,
    {
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        ...(config.api_key ? { Authorization: `ApiKey ${config.api_key}` } : {}),
      },
    },
  );
  const hits = Array.isArray(response?.data?.hits?.hits) ? response.data.hits.hits : [];
  const lastSort = Array.isArray(hits[hits.length - 1]?.sort) ? hits[hits.length - 1].sort : null;
  const nextCursor = hits.length >= Number(body.size || 0) && lastSort
    ? encodeCatalogServingCursor(lastSort)
    : null;

  return {
    items: hits.map((hit) => hit?._source).filter(Boolean),
    cursor_info: {
      next_cursor: nextCursor,
      has_next_page: Boolean(nextCursor),
      serving_mode: 'exhaustive',
    },
    source: 'opensearch_compatible',
    raw: response?.data || null,
  };
}

async function bulkUpsertCatalogServingDocs(docs = [], { httpClient = axios, env = process.env, refresh = false } = {}) {
  const config = getCatalogServingIndexConfig(env);
  if (!config.enabled) {
    return {
      indexed: 0,
      source: 'disabled',
    };
  }

  const normalizedDocs = (Array.isArray(docs) ? docs : [])
    .filter((doc) => doc && typeof doc === 'object')
    .map((doc) => ({
      ...doc,
      doc_id: asString(doc.doc_id),
    }))
    .filter((doc) => doc.doc_id);

  if (!normalizedDocs.length) {
    return {
      indexed: 0,
      source: 'opensearch_compatible',
    };
  }

  const lines = [];
  for (const doc of normalizedDocs) {
    lines.push(JSON.stringify({ index: { _index: config.index_name, _id: doc.doc_id } }));
    lines.push(JSON.stringify(doc));
  }
  const body = `${lines.join('\n')}\n`;

  const response = await httpClient.post(
    `${config.base_url}/_bulk${refresh ? '?refresh=true' : ''}`,
    body,
    {
      headers: {
        'Content-Type': 'application/x-ndjson',
        ...(config.api_key ? { Authorization: `ApiKey ${config.api_key}` } : {}),
      },
    },
  );

  return {
    indexed: normalizedDocs.length,
    source: 'opensearch_compatible',
    raw: response?.data || null,
  };
}

module.exports = {
  buildCatalogServingDoc,
  buildCatalogServingSearchBody,
  bulkUpsertCatalogServingDocs,
  decodeCatalogServingCursor,
  encodeCatalogServingCursor,
  getCatalogServingIndexConfig,
  isCatalogServingIndexEnabled,
  searchCatalogServingIndex,
};
