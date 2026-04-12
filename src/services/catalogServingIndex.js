const axios = require('axios');
const {
  buildIdentityListingFromProduct,
  buildSourceListingRef,
  listLivePdpIdentityRowsForRefs,
  _internals: { fetchBackfillProducts },
} = require('./pdpIdentityGraph');

function asString(value) {
  const normalized = String(value || '').trim();
  return normalized || '';
}

function asNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const normalized = asString(value);
    if (normalized) return normalized;
  }
  return '';
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

function normalizeImageUrls(values = [], limit = 8) {
  return uniqStrings(
    asArray(values)
      .map((item) => {
        if (typeof item === 'string') return item;
        if (!item || typeof item !== 'object') return '';
        return item.url || item.image_url || item.src || '';
      })
      .filter(Boolean),
    limit,
  );
}

function fillMissingStrings(target, source, keys = []) {
  const next = { ...(target || {}) };
  const src = asPlainObject(source);
  for (const key of keys) {
    if (asString(next[key])) continue;
    const candidate = asString(src[key]);
    if (candidate) next[key] = candidate;
  }
  return next;
}

function normalizeGroupMembers(entries = []) {
  const out = [];
  const seen = new Set();
  for (const entry of asArray(entries)) {
    const merchantId = asString(entry?.merchant_id);
    const productId = asString(entry?.product_id);
    if (!merchantId || !productId) continue;
    const key = `${merchantId}:${productId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ merchant_id: merchantId, product_id: productId });
  }
  return out;
}

function normalizeOfferKey(offer = {}) {
  const normalized = asPlainObject(offer);
  return (
    asString(normalized.offer_id || normalized.id) ||
    [
      asString(normalized.merchant_id),
      asString(normalized.product_id),
      asString(normalized.variant_id || normalized.sku_id || normalized.sku),
      asString(normalized.external_redirect_url || normalized.redirect_url),
      asString(extractPriceAmount(normalized.price || normalized.current_price || normalized)),
    ].join('|')
  );
}

function mergeOffers(entries = []) {
  const out = [];
  const seen = new Set();
  for (const entry of asArray(entries)) {
    for (const offer of asArray(entry?.product?.offers)) {
      const normalized = asPlainObject(offer);
      const key = normalizeOfferKey(normalized);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(normalized);
    }
  }
  return out;
}

function maxTimestamp(values = []) {
  let bestRaw = '';
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const value of asArray(values)) {
    const normalized = asString(value);
    if (!normalized) continue;
    const ms = Date.parse(normalized);
    if (Number.isFinite(ms) && ms > bestMs) {
      bestMs = ms;
      bestRaw = normalized;
      continue;
    }
    if (!bestRaw) bestRaw = normalized;
  }
  return bestRaw || null;
}

function resolveGroupMarket(entries = [], fallbackMarket = 'US') {
  for (const entry of asArray(entries)) {
    const product = asPlainObject(entry?.product);
    const market = firstNonEmptyString(
      entry?.source_meta?.market,
      product.market,
      product.region,
      product.locale_market,
      fallbackMarket,
    );
    if (market) return market;
  }
  return asString(fallbackMarket || 'US') || 'US';
}

function scoreCatalogServingEntry(entry = {}) {
  const product = asPlainObject(entry.product);
  let score = entry?.effective_identity?.source_tier === 'brand' ? 100 : 40;
  if (firstNonEmptyString(product.title, product.name, product.card_title)) score += 20;
  if (firstNonEmptyString(product.description, product.pdp_description_raw, product.card_subtitle)) score += 10;
  if (resolvePivotaInsightSummary(product)) score += 12;
  if (normalizeImageUrls([product.image_url, ...asArray(product.images), ...asArray(product.image_urls)], 8).length) {
    score += 10;
  }
  if (mergeOffers([entry]).length > 0) score += 8;
  if (Number(product.review_summary?.review_count || product.reviews_summary?.review_count || 0) > 0) {
    score += 4;
  }
  score += Number(entry?.effective_identity?.identity_confidence || 0);
  return score;
}

function sortCatalogServingEntries(entries = []) {
  return [...asArray(entries)].sort((a, b) => scoreCatalogServingEntry(b) - scoreCatalogServingEntry(a));
}

function resolveBackfillPublishState(entries = []) {
  if (
    asArray(entries).every(
      (entry) =>
        asString(entry?.effective_identity?.identity_status) === 'approved' &&
        entry?.effective_identity?.review_required !== true,
    )
  ) {
    return 'eligible';
  }
  return 'shadow';
}

function pickDefaultOfferId(offers = [], entries = []) {
  for (const entry of asArray(entries)) {
    const explicit = asString(entry?.product?.default_offer_id);
    if (explicit) return explicit;
  }
  const internalOffer = asArray(offers).find(
    (offer) => !asString(offer?.external_redirect_url || offer?.redirect_url),
  );
  return asString(internalOffer?.offer_id || internalOffer?.id || offers[0]?.offer_id || offers[0]?.id) || null;
}

function buildCatalogServingBackfillEntries(sourceRows = [], { identityRows = [] } = {}) {
  const identityMap = new Map();
  for (const row of asArray(identityRows)) {
    const sourceRef = asString(row?.source_listing_ref);
    if (!sourceRef) continue;
    identityMap.set(sourceRef, row);
  }

  return asArray(sourceRows)
    .map((row) => {
      const product = asPlainObject(row?.product);
      const merchantId = asString(row?.merchant_id || product.merchant_id || product.merchantId);
      const productId = asString(row?.product_id || product.product_id || product.id);
      if (!merchantId || !productId || !product) return null;
      const sourceListingRef = buildSourceListingRef({ merchantId, productId });
      if (!sourceListingRef) return null;
      const liveIdentity = identityMap.get(sourceListingRef) || null;
      const computedIdentity = buildIdentityListingFromProduct({
        merchantId,
        productId,
        product,
        sourceKind: asString(row?.source_kind) || 'internal',
        sourceMeta: asPlainObject(row?.source_meta),
      });
      const effectiveIdentity = liveIdentity || computedIdentity;
      if (!effectiveIdentity) return null;
      return {
        merchant_id: merchantId,
        product_id: productId,
        source_kind: asString(row?.source_kind) || 'internal',
        source_meta: asPlainObject(row?.source_meta),
        product,
        source_listing_ref: sourceListingRef,
        live_identity: liveIdentity,
        computed_identity: computedIdentity,
        effective_identity: effectiveIdentity,
        is_public:
          asString(liveIdentity?.identity_status) === 'approved' && liveIdentity?.live_read_enabled === true,
      };
    })
    .filter(Boolean);
}

function buildCatalogServingGroupInput(entries = [], { publishState = 'shadow', market = 'US' } = {}) {
  const sortedEntries = sortCatalogServingEntries(entries);
  const baseEntry = sortedEntries[0] || null;
  const baseProduct = asPlainObject(baseEntry?.product);
  if (!baseEntry || !baseProduct) return null;

  let composed = { ...baseProduct };
  for (const entry of sortedEntries) {
    composed = fillMissingStrings(composed, entry.product, [
      'title',
      'name',
      'card_title',
      'card_subtitle',
      'subtitle',
      'brand',
      'brand_name',
      'vendor',
      'description',
      'pdp_description_raw',
      'source_url',
      'canonical_url',
      'destination_url',
      'url',
      'product_url',
      'handle',
    ]);
  }

  const identity = asPlainObject(baseEntry.effective_identity);
  const mergedOffers = mergeOffers(sortedEntries);
  const mergedImages = normalizeImageUrls(
    sortedEntries.flatMap((entry) => [
      entry?.product?.image_url,
      ...asArray(entry?.product?.images),
      ...asArray(entry?.product?.image_urls),
    ]),
    8,
  );
  const mergedCategoryPaths = uniqStrings(
    sortedEntries.flatMap((entry) => resolveCategoryPaths(entry.product)),
    16,
  );
  const mergedTags = uniqStrings(
    sortedEntries.flatMap((entry) => asArray(entry?.product?.tags)),
    32,
  );
  const insightSummary =
    firstNonEmptyString(...sortedEntries.map((entry) => resolvePivotaInsightSummary(entry.product))) || null;
  const qualityScore = Math.max(
    ...sortedEntries
      .map((entry) => asNumber(entry?.product?.quality_score))
      .filter((value) => value != null),
    -1,
  );
  const browseScore = Math.max(
    ...sortedEntries
      .map((entry) => asNumber(entry?.product?.browse_score))
      .filter((value) => value != null),
    -1,
  );
  const updatedAt = maxTimestamp(
    sortedEntries.flatMap((entry) => [
      entry?.product?.updated_at,
      entry?.product?.updatedAt,
      entry?.source_meta?.updated_at,
      entry?.source_meta?.cached_at,
    ]),
  );
  const directPrices = sortedEntries
    .map((entry) => asNumber(entry?.product?.price))
    .filter((value) => value != null);

  return {
    ...composed,
    merchant_id: asString(baseEntry.merchant_id || composed.merchant_id || composed.merchantId) || undefined,
    product_id:
      asString(baseEntry.product_id || composed.product_id || composed.id || composed.platform_product_id) ||
      undefined,
    sellable_item_group_id: asString(identity.sellable_item_group_id) || null,
    product_line_id: asString(identity.product_line_id) || null,
    review_family_id: asString(identity.review_family_id || identity.product_line_id) || null,
    variant_axes: asPlainObject(identity.variant_axes),
    brand:
      firstNonEmptyString(
        composed.brand,
        composed.brand_name,
        composed.vendor,
        ...sortedEntries.map((entry) =>
          firstNonEmptyString(entry?.product?.brand, entry?.product?.brand_name, entry?.product?.vendor),
        ),
      ) || undefined,
    category_paths: mergedCategoryPaths,
    image_url: firstNonEmptyString(composed.image_url, mergedImages[0]) || undefined,
    images: mergedImages.length ? mergedImages : asArray(composed.images),
    image_urls: mergedImages.length ? mergedImages : asArray(composed.image_urls),
    price: directPrices.length ? Math.min(...directPrices) : composed.price,
    offers: mergedOffers,
    default_offer_id: pickDefaultOfferId(mergedOffers, sortedEntries),
    group_members: normalizeGroupMembers(sortedEntries),
    tags: mergedTags,
    pivota_insight_summary: insightSummary,
    quality_score: qualityScore >= 0 ? qualityScore : composed.quality_score,
    browse_score: browseScore >= 0 ? browseScore : composed.browse_score,
    publish_state: publishState,
    market: resolveGroupMarket(sortedEntries, market),
    updated_at: updatedAt || composed.updated_at || composed.updatedAt || null,
  };
}

function buildCatalogServingBackfillDocs(
  sourceRows = [],
  { identityRows = [], includeNonPublic = true, market = 'US' } = {},
) {
  const entries = buildCatalogServingBackfillEntries(sourceRows, { identityRows });
  const groups = new Map();
  for (const entry of entries) {
    const groupKey =
      asString(entry?.effective_identity?.sellable_item_group_id) || asString(entry?.source_listing_ref);
    if (!groupKey) continue;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(entry);
  }

  const docs = [];
  for (const groupEntries of groups.values()) {
    const publicEntries = groupEntries.filter((entry) => entry.is_public);
    if (publicEntries.length > 0) {
      const input = buildCatalogServingGroupInput(publicEntries, {
        publishState: 'public',
        market,
      });
      if (!input) continue;
      docs.push(
        buildCatalogServingDoc(input, {
          publish_state: 'public',
          market: input.market || market,
        }),
      );
      continue;
    }
    if (includeNonPublic !== true) continue;
    const publishState = resolveBackfillPublishState(groupEntries);
    const input = buildCatalogServingGroupInput(groupEntries, {
      publishState,
      market,
    });
    if (!input) continue;
    docs.push(
      buildCatalogServingDoc(input, {
        publish_state: publishState,
        shadow: publishState === 'shadow',
        market: input.market || market,
      }),
    );
  }

  return docs;
}

async function backfillCatalogServingIndex(
  {
    limit = 500,
    brand = null,
    market = 'US',
    dryRun = false,
    refresh = false,
    includeNonPublic = true,
    queryFn,
  } = {},
  {
    fetchBackfillProductsFn = fetchBackfillProducts,
    identityRowsResolverFn = listLivePdpIdentityRowsForRefs,
    bulkUpsertFn = bulkUpsertCatalogServingDocs,
    httpClient = axios,
    env = process.env,
  } = {},
) {
  const sourceRows = await fetchBackfillProductsFn({
    limit,
    brandFilter: brand,
    ...(typeof queryFn === 'function' ? { queryFn } : {}),
  });
  const sourceListingRefs = uniqStrings(
    sourceRows.map((row) =>
      buildSourceListingRef({
        merchantId: row?.merchant_id,
        productId: row?.product_id,
      }),
    ),
    5000,
  );
  const identityRows = await identityRowsResolverFn({
    sourceListingRefs,
    ...(typeof queryFn === 'function' ? { queryFn } : {}),
  });
  const docs = buildCatalogServingBackfillDocs(sourceRows, {
    identityRows,
    includeNonPublic,
    market,
  });
  const publishStateBreakdown = docs.reduce((acc, doc) => {
    const key = asString(doc?.publish_state) || 'unknown';
    acc[key] = Number(acc[key] || 0) + 1;
    return acc;
  }, {});

  const writeResult =
    dryRun === true
      ? {
          indexed: 0,
          source: 'dry_run',
        }
      : await bulkUpsertFn(docs, { httpClient, env, refresh });

  return {
    dry_run: dryRun === true,
    source_rows_scanned: sourceRows.length,
    live_identity_rows: identityRows.length,
    docs_built: docs.length,
    public_docs_built: Number(publishStateBreakdown.public || 0),
    non_public_docs_built:
      Number(publishStateBreakdown.shadow || 0) + Number(publishStateBreakdown.eligible || 0),
    publish_state_breakdown: publishStateBreakdown,
    ...writeResult,
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
  backfillCatalogServingIndex,
  buildCatalogServingBackfillDocs,
  buildCatalogServingDoc,
  buildCatalogServingSearchBody,
  bulkUpsertCatalogServingDocs,
  decodeCatalogServingCursor,
  encodeCatalogServingCursor,
  getCatalogServingIndexConfig,
  isCatalogServingIndexEnabled,
  searchCatalogServingIndex,
  _internals: {
    buildCatalogServingBackfillEntries,
    buildCatalogServingGroupInput,
    resolveBackfillPublishState,
    sortCatalogServingEntries,
  },
};
