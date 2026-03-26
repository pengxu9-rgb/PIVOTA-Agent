function pushNormalizedProductImageCandidate(target, value) {
  const url = String(value || '').trim();
  if (!url || (!/^https?:\/\//i.test(url) && !/^\/\//.test(url))) return;
  target.push(url);
}

function collectNormalizedProductImageUrls(product) {
  if (!product || typeof product !== 'object') return [];
  const candidates = [];
  const pushFromCollection = (collection) => {
    const items = Array.isArray(collection) ? collection : [];
    for (const item of items) {
      if (item && typeof item === 'object') {
        pushNormalizedProductImageCandidate(
          candidates,
          item.url || item.image_url || item.imageUrl || item.src,
        );
      } else {
        pushNormalizedProductImageCandidate(candidates, item);
      }
    }
  };

  pushNormalizedProductImageCandidate(candidates, product.image_url || product.imageUrl);
  pushFromCollection(product.image_urls || product.imageUrls);
  pushFromCollection(product.images);
  pushFromCollection(product.variants);
  pushFromCollection(product.media);
  pushFromCollection(product.seed_data?.snapshot?.image_urls);
  pushFromCollection(product.seed_data?.snapshot?.images);
  pushFromCollection(product.seed_data?.snapshot?.media);

  const deduped = Array.from(new Set(candidates));
  const https = deduped.filter((url) => url.startsWith('https://'));
  const http = deduped.filter((url) => url.startsWith('http://'));
  return [...https, ...http];
}

function normalizeProductImages(product) {
  if (!product || typeof product !== 'object') {
    return {
      primaryImageUrl: null,
      normalizedImages: [],
    };
  }

  const normalizedImages = collectNormalizedProductImageUrls(product);
  return {
    primaryImageUrl: normalizedImages[0] || null,
    normalizedImages,
  };
}

function normalizeAgentProductsListResponse(raw, ctx = {}) {
  if (!raw) return raw;

  const nowIso = new Date().toISOString();

  const applyNormalizedProductImages = (product) => {
    if (!product || typeof product !== 'object') return product;
    const { primaryImageUrl, normalizedImages } = normalizeProductImages(product);
    if (!normalizedImages.length) return product;
    return {
      ...product,
      image_url: primaryImageUrl,
      images: normalizedImages,
    };
  };

  const getProducts = (obj) => {
    if (!obj) return [];
    if (Array.isArray(obj)) return obj;
    if (Array.isArray(obj.products)) return obj.products;
    if (Array.isArray(obj.items)) return obj.items;
    if (Array.isArray(obj.results)) return obj.results;
    const data = obj.data;
    if (data && typeof data === 'object') {
      if (Array.isArray(data.products)) return data.products;
      if (Array.isArray(data.items)) return data.items;
      if (Array.isArray(data.results)) return data.results;
    }
    return [];
  };

  const base = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const products = getProducts(raw).map((product) => applyNormalizedProductImages(product));

  const totalRaw =
    base.total ??
    base.count ??
    base.total_count ??
    base.totalCount ??
    base.page_total ??
    base.pageTotal;
  const total = typeof totalRaw === 'number' ? totalRaw : products.length;

  const limitRaw = ctx.limit ?? base.limit ?? base.page_size ?? base.pageSize;
  const offsetRaw = ctx.offset ?? base.offset ?? 0;
  const limit = Number(limitRaw);
  const offset = Number(offsetRaw);
  const page =
    Number.isFinite(limit) && limit > 0 && Number.isFinite(offset) && offset >= 0
      ? Math.floor(offset / limit) + 1
      : base.page || 1;

  const mergedMetadata =
    base.metadata && typeof base.metadata === 'object' && !Array.isArray(base.metadata)
      ? { ...base.metadata }
      : {};

  if (!mergedMetadata.query_source) mergedMetadata.query_source = 'agent_products_search';
  if (!mergedMetadata.fetched_at) mergedMetadata.fetched_at = nowIso;

  return {
    ...base,
    status: base.status || 'success',
    success: typeof base.success === 'boolean' ? base.success : true,
    products,
    total,
    page,
    page_size: typeof base.page_size === 'number' ? base.page_size : products.length,
    reply: base.reply ?? null,
    metadata: mergedMetadata,
  };
}

module.exports = {
  collectNormalizedProductImageUrls,
  normalizeProductImages,
  normalizeAgentProductsListResponse,
};
