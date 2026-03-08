const { buildRequestContext } = require('../requestContext');

// ---------------------------------------------------------------------------
// In-memory brand index (populated from catalog on first request, cached)
// ---------------------------------------------------------------------------

const TOP_BEAUTY_BRANDS = [
  'CeraVe', 'La Roche-Posay', 'The Ordinary', 'Cetaphil', 'Neutrogena',
  'Paula\'s Choice', 'Drunk Elephant', 'Tatcha', 'SK-II', 'Laneige',
  'Beauty of Joseon', 'COSRX', 'Bioderma', 'Avène', 'Kiehl\'s',
  'Clinique', 'Estée Lauder', 'Shiseido', 'Sulwhasoo', 'Innisfree',
  'Missha', 'Purito', 'Anessa', 'Biore', 'Canmake',
  'Hada Labo', 'Rohto', 'Muji', 'Fancl', 'DHC',
  'Olay', 'Garnier', 'L\'Oréal', 'Vichy', 'Eucerin',
  'Vanicream', 'EltaMD', 'Supergoop', 'SkinCeuticals', 'Dr. Jart+',
  'Glow Recipe', 'Summer Fridays', 'Tower 28', 'Kosas', 'Rare Beauty',
  'Glossier', 'Fresh', 'Origins', 'Aesop', 'Byredo',
];

let brandIndexCache = null;
let brandIndexCacheTs = 0;
const BRAND_CACHE_TTL_MS = 10 * 60 * 1000;

function buildBrandIndex() {
  if (brandIndexCache && Date.now() - brandIndexCacheTs < BRAND_CACHE_TTL_MS) return brandIndexCache;

  const map = new Map();
  for (let i = 0; i < TOP_BEAUTY_BRANDS.length; i++) {
    const name = TOP_BEAUTY_BRANDS[i];
    const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    map.set(normalized, {
      brand_id: `brand_${normalized}`,
      name,
      logo_url: null,
      product_count: null,
      popular: true,
      rank: i,
    });
  }

  brandIndexCache = map;
  brandIndexCacheTs = Date.now();
  return map;
}

function prefixSearch(index, prefix, limit) {
  const norm = String(prefix || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!norm) {
    return Array.from(index.values())
      .filter((b) => b.popular)
      .sort((a, b) => a.rank - b.rank)
      .slice(0, limit);
  }
  const results = [];
  for (const [key, value] of index.entries()) {
    if (key.startsWith(norm) || value.name.toLowerCase().startsWith(prefix.toLowerCase())) {
      results.push(value);
    }
  }
  results.sort((a, b) => {
    const aPop = a.popular ? 0 : 1;
    const bPop = b.popular ? 0 : 1;
    if (aPop !== bPop) return aPop - bPop;
    return a.name.localeCompare(b.name);
  });
  return results.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

function mountBrandSearchRoutes(app, { logger, requireAuroraUid, resolveIdentity, catalogSearch }) {

  app.get('/v1/brands', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const prefix = String(req.query.prefix || '').trim();
      const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
      const index = buildBrandIndex();
      const brands = prefixSearch(index, prefix, limit);
      return res.json({ brands });
    } catch (err) {
      logger?.warn({ err: err?.message }, 'brands search failed');
      return res.status(500).json({ error: 'BRANDS_SEARCH_FAILED' });
    }
  });

  app.get('/v1/brands/:brandId/products', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const brandId = String(req.params.brandId || '').trim();
      const index = buildBrandIndex();

      let brandName = null;
      for (const [, value] of index.entries()) {
        if (value.brand_id === brandId) {
          brandName = value.name;
          break;
        }
      }
      if (!brandName) {
        brandName = brandId.replace(/^brand_/, '').replace(/_/g, ' ');
      }

      const category = String(req.query.category || '').trim() || undefined;
      const searchQuery = String(req.query.q || '').trim() || undefined;
      const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
      const offset = Math.max(0, Number(req.query.offset) || 0);

      const queryText = [brandName, category, searchQuery].filter(Boolean).join(' ');

      if (typeof catalogSearch === 'function') {
        try {
          const searchResult = await catalogSearch({
            query: queryText,
            limit: limit + offset,
            brand: brandName,
          });
          const products = Array.isArray(searchResult?.products) ? searchResult.products : [];
          const sliced = products.slice(offset, offset + limit).map((p) => ({
            product_id: p.product_id || p.sku_id || p.id,
            sku_id: p.sku_id || null,
            name: p.name || p.title || '',
            brand: p.brand || brandName,
            category: p.category || p.product_type || null,
            image_url: p.image_url || p.imageUrl || null,
            price: p.price || null,
            display_name: p.display_name || p.displayName || null,
          }));
          return res.json({ brand: brandName, products: sliced, total: products.length });
        } catch (searchErr) {
          logger?.warn({ err: searchErr?.message }, 'catalog search for brand products failed, falling back');
        }
      }

      return res.json({ brand: brandName, products: [], total: 0, fallback: true });
    } catch (err) {
      logger?.warn({ err: err?.message }, 'brand products search failed');
      return res.status(500).json({ error: 'BRAND_PRODUCTS_FAILED' });
    }
  });
}

module.exports = {
  mountBrandSearchRoutes,
  buildBrandIndex,
  prefixSearch,
};
