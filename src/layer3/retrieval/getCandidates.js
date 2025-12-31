const axios = require('axios');
const { ProductCategorySchema } = require('../schemas/productAttributesV0');

const PIVOTA_API_BASE = (process.env.PIVOTA_API_BASE || 'http://localhost:8080').replace(/\/$/, '');
const PIVOTA_API_KEY = process.env.PIVOTA_API_KEY || '';
function getApiMode() {
  return process.env.API_MODE || (PIVOTA_API_KEY ? 'REAL' : 'MOCK');
}

function normalizeString(v) {
  return String(v ?? '').trim();
}

function buildQueryForCategory(category, lookSpec) {
  const area = lookSpec.breakdown[category];
  const base = [normalizeString(area.finish), normalizeString(area.coverage), ...(area.keyNotes || [])].filter(Boolean);

  const anchors = {
    prep: ['primer', 'setting spray', 'prep'],
    base: ['foundation', 'concealer', 'setting powder', 'skin tint', 'bb cream'],
    contour: ['contour', 'bronzer', 'sculpt'],
    brow: ['brow pencil', 'brow gel', 'eyebrow'],
    eye: ['eyeliner', 'mascara', 'eyeshadow', 'eye palette'],
    blush: ['blush', 'cheek tint', 'cheek'],
    lip: ['lipstick', 'lip gloss', 'lip liner', 'lip tint', 'lip balm'],
  };

  const tokens = [...anchors[category], ...base].join(' ').replace(/\s+/g, ' ').trim();
  return tokens || anchors[category][0];
}

function productText(p) {
  return [
    p.title,
    p.name,
    p.description,
    p.product_type,
    p.category,
    p.vendor,
    p.brand,
    Array.isArray(p.tags) ? p.tags.join(' ') : '',
  ]
    .map((v) => normalizeString(v).toLowerCase())
    .filter(Boolean)
    .join(' ');
}

function matchesCategory(category, p) {
  const text = productText(p);
  const keywords = {
    prep: ['primer', 'priming', 'setting spray', 'setting mist', 'grip', 'pore'],
    base: ['foundation', 'concealer', 'powder', 'skin tint', 'tint', 'bb', 'cc'],
    contour: ['contour', 'bronzer', 'sculpt'],
    brow: ['brow', 'brows', 'eyebrow', 'pomade', 'brow pencil', 'brow gel'],
    eye: ['eyeliner', 'liner', 'mascara', 'eyeshadow', 'palette', 'kohl', 'kajal'],
    blush: ['blush', 'cheek', 'cheeks'],
    lip: ['lipstick', 'lip gloss', 'gloss', 'lip liner', 'lip tint', 'lip balm', 'lip oil', 'lip stain'],
  };
  return keywords[category].some((k) => text.includes(k));
}

function explodeVariantsToSkus(product) {
  const variants = product.variants;
  if (Array.isArray(variants) && variants.length) {
    const productTitle = normalizeString(product.productTitle ?? product.product_title ?? product.title ?? product.name);
    return variants
      .filter((v) => v && typeof v === 'object')
      .map((v) => {
        const variantTitle = normalizeString(v.variantTitle ?? v.variant_title ?? v.title ?? v.name);
        const isDefaultVariantTitle = variantTitle.toLowerCase() === 'default title';
        const displayTitle =
          productTitle && variantTitle && !isDefaultVariantTitle && variantTitle !== productTitle
            ? `${productTitle} - ${variantTitle}`
            : productTitle || variantTitle;

        return {
          ...product,
          ...v,
          productTitle,
          product_title: productTitle,
          variantTitle,
          variant_title: variantTitle,
          ...(displayTitle ? { title: displayTitle } : {}),
          productUrl: v.productUrl ?? product.productUrl ?? product.url,
          imageUrl: v.imageUrl ?? product.imageUrl ?? product.image_url,
        };
      });
  }
  return [product];
}

async function getCandidates(input) {
  const { lookSpec } = input;
  const limitPerCategory = input.limitPerCategory ?? 80;

  const fetcher =
    input.fetcher ??
    (async ({ query, limit }) => {
      if (getApiMode() === 'MOCK') return [];

      const payload = {
        operation: 'find_products_multi',
        payload: {
          search: {
            query,
            category: null,
            price_min: null,
            price_max: null,
            page: 1,
            limit: Math.min(500, Math.max(1, limit)),
            in_stock_only: false,
          },
          metadata: {},
        },
        metadata: { source: 'layer3-kit' },
      };

      const resp = await axios.post(`${PIVOTA_API_BASE}/agent/shop/v1/invoke`, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000,
      });

      const products = Array.isArray(resp.data?.products) ? resp.data.products : [];
      return products.filter((p) => !!p && typeof p === 'object');
    });

  const categories = ProductCategorySchema.options;
  const results = {};

  await Promise.all(
    categories.map(async (category) => {
      try {
        const query = buildQueryForCategory(category, lookSpec);
        const products = await fetcher({ query, limit: limitPerCategory });
        const expanded = products.flatMap((p) => explodeVariantsToSkus(p));
        const filtered = expanded.filter((p) => matchesCategory(category, p));
        results[category] = filtered.slice(0, limitPerCategory);
      } catch {
        results[category] = [];
      }
    })
  );

  return results;
}

module.exports = {
  getCandidates,
};
