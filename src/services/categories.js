const axios = require('axios');
const logger = require('../logger');
const { getCreatorConfig } = require('../creatorConfig');
const { getAllPromotions } = require('../promotionStore');
const { mockProducts } = require('../mockProducts');
const { getTaxonomyView } = require('./taxonomyStore');
const { query } = require('../db');

// Keep API mode resolution consistent with src/server.js so that
// categories behave the same way as the main invoke endpoint.
const PIVOTA_API_KEY = process.env.PIVOTA_API_KEY || '';
const API_MODE = process.env.API_MODE || (PIVOTA_API_KEY ? 'REAL' : 'MOCK');
const USE_MOCK = API_MODE === 'MOCK';
const PIVOTA_API_BASE = (process.env.PIVOTA_API_BASE || 'http://localhost:8080').replace(/\/$/, '');

const CHANNEL_CREATOR = 'creator_agents';

function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'uncategorized';
}

function deriveCategoryPathFromProduct(product) {
  // TODO: Align with actual catalog category fields once wired.
  // For now we derive from (in order of preference):
  // - product.categoryPath (if present)
  // - product.product_type (StandardProduct)
  // - product.category (mock products)
  const explicitPath = product.categoryPath;
  if (Array.isArray(explicitPath) && explicitPath.length) {
    return explicitPath.map((p) => String(p || '').trim()).filter(Boolean);
  }

  const raw =
    (product.product_type && String(product.product_type)) ||
    (product.category && String(product.category)) ||
    '';

  const trimmed = raw.trim();
  if (!trimmed) {
    return ['Other'];
  }

  let parts = [trimmed];
  if (trimmed.includes('>')) {
    parts = trimmed.split('>').map((s) => s.trim());
  } else if (trimmed.includes('/')) {
    parts = trimmed.split('/').map((s) => s.trim());
  } else if (trimmed.includes('|')) {
    parts = trimmed.split('|').map((s) => s.trim());
  }

  const cleaned = parts.map((p) => p).filter(Boolean);
  return cleaned.length ? cleaned : ['Other'];
}

function buildCategoryIdFromSegments(segments) {
  const slugs = segments.map(slugify).filter(Boolean);
  if (!slugs.length) return 'uncategorized';
  return slugs.join('/');
}

function normalizeMerchantCategoryKey(product) {
  const explicitPath = product.categoryPath;
  if (Array.isArray(explicitPath) && explicitPath.length) {
    return explicitPath.map((p) => String(p || '').trim()).filter(Boolean).join(' > ');
  }
  const raw =
    (product.product_type && String(product.product_type)) ||
    (product.category && String(product.category)) ||
    (product.productType && String(product.productType)) ||
    '';
  return raw.trim() || 'Other';
}

function normalizeTextForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\u2019']/g, "'")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const HEURISTIC_RULES = [
  {
    id: 'sportswear',
    keywords: [
      'sportswear',
      'activewear',
      'athleisure',
      'workout',
      'gym',
      'yoga',
      'running',
      'leggings',
      'sports bra',
      'training',
      'fitness',
      '运动',
      '瑜伽',
      '健身',
      '跑步',
      '运动内衣',
      '紧身裤',
    ],
  },
  {
    id: 'lingerie-set',
    keywords: [
      'lingerie',
      'lingerie set',
      'bra',
      'panty',
      'panties',
      'underwear',
      'lace',
      'sexy lingerie',
      '内衣',
      '内裤',
      '文胸',
      '胸罩',
      '蕾丝',
    ],
  },
  {
    id: 'womens-loungewear',
    keywords: [
      'loungewear',
      'lounge set',
      'sleepwear',
      'pajamas',
      'pyjamas',
      'robe',
      'homewear',
      'cozy',
      '家居服',
      '睡衣',
      '浴袍',
      '居家',
    ],
  },
  {
    id: 'toys',
    keywords: ['toy', 'toys', 'plush', 'stuffed', 'doll', 'figure', '玩具', '毛绒', '公仔', '娃娃', '手办'],
  },
];

function heuristicCategoryForProduct(product) {
  const haystack = normalizeTextForMatch(
    [
      product.title,
      product.name,
      product.description,
      product.product_type,
      product.category,
      normalizeMerchantCategoryKey(product),
    ]
      .filter(Boolean)
      .join(' '),
  );

  for (const rule of HEURISTIC_RULES) {
    for (const kw of rule.keywords) {
      const needle = normalizeTextForMatch(kw);
      if (!needle) continue;
      if (haystack.includes(needle)) return rule.id;
    }
  }
  return 'other';
}

async function loadCreatorOverrides(creatorId) {
  if (!process.env.DATABASE_URL) return new Map();
  try {
    const res = await query(
      `
        SELECT
          category_id,
          pinned,
          hidden,
          display_name_override,
          image_override,
          COALESCE(priority_boost, 0) AS priority_boost
        FROM creator_category_override
        WHERE creator_id = $1
      `,
      [creatorId],
    );
    return new Map(
      res.rows.map((r) => [
        r.category_id,
        {
          pinned: r.pinned === null ? null : Boolean(r.pinned),
          hidden: r.hidden === null ? null : Boolean(r.hidden),
          name: r.display_name_override || null,
          image: r.image_override || null,
          boost: Number(r.priority_boost || 0),
        },
      ]),
    );
  } catch (err) {
    logger.warn({ err: err.message, creatorId }, 'Failed to load creator overrides');
    return new Map();
  }
}

async function loadMerchantCategoryMappings(pairs) {
  if (!process.env.DATABASE_URL) return new Map();
  if (!pairs.length) return new Map();

  const placeholders = [];
  const params = [];
  let idx = 1;
  for (const [merchantId, key] of pairs) {
    placeholders.push(`($${idx++}, $${idx++})`);
    params.push(merchantId, key);
  }

  try {
    const res = await query(
      `
        SELECT merchant_id, merchant_category_key, canonical_category_id, confidence
        FROM merchant_category_mapping
        WHERE (merchant_id, merchant_category_key) IN (VALUES ${placeholders.join(', ')})
      `,
      params,
    );

    const out = new Map();
    for (const row of res.rows) {
      out.set(`${row.merchant_id}::${row.merchant_category_key}`, {
        categoryId: row.canonical_category_id,
        confidence: Number(row.confidence || 0),
      });
    }
    return out;
  } catch (err) {
    logger.warn({ err: err.message }, 'Failed to load merchant category mappings');
    return new Map();
  }
}

async function mapProductsToCanonical(indexedProducts) {
  const pairs = [];
  const seen = new Set();
  for (const item of indexedProducts) {
    const p = item.product;
    const merchantId = String(p.merchant_id || p.merchantId || '').trim();
    const key = normalizeMerchantCategoryKey(p);
    if (!merchantId || !key) continue;
    const k = `${merchantId}::${key}`;
    if (seen.has(k)) continue;
    seen.add(k);
    pairs.push([merchantId, key]);
  }

  const mapping = await loadMerchantCategoryMappings(pairs);
  const assigned = [];
  for (const item of indexedProducts) {
    const p = item.product;
    const merchantId = String(p.merchant_id || p.merchantId || '').trim();
    const key = normalizeMerchantCategoryKey(p);
    const mapKey = `${merchantId}::${key}`;
    const mapped = mapping.get(mapKey);
    const categoryId =
      mapped && mapped.confidence >= 0.6 ? mapped.categoryId : heuristicCategoryForProduct(p);
    assigned.push({ product: p, categoryId: categoryId || 'other' });
  }
  return assigned;
}

/**
 * Build category tree and index from a list of products that have category paths.
 *
 * @param {Array<{ product: any, path: string[], leafId: string, slug: string }>} indexedProducts
 * @returns {{ roots: Array<any>, categoryMap: Map<string, any> }}
 */
function buildCategoryTree(indexedProducts) {
  const categoryMap = new Map();

  function ensureNode(id, name, level, path, parentId) {
    let node = categoryMap.get(id);
    if (!node) {
      node = {
        category: {
          id,
          slug: slugify(name),
          name,
          parentId: parentId || null,
          level,
          imageUrl: undefined,
          productCount: 0,
          path: [...path],
          externalKeys: undefined,
          deals: undefined,
          priority: undefined,
          seoDescription: undefined,
        },
        children: [],
      };
      categoryMap.set(id, node);

      if (parentId && categoryMap.has(parentId)) {
        const parent = categoryMap.get(parentId);
        if (!parent.children.find((c) => c.category.id === id)) {
          parent.children.push(node);
        }
      }
    }
    return node;
  }

  for (const item of indexedProducts) {
    const { path } = item;
    let parentId = null;
    const lineage = [];

    for (let i = 0; i < path.length; i += 1) {
      const name = path[i];
      const currentPath = path.slice(0, i + 1);
      const id = buildCategoryIdFromSegments(currentPath);
      const node = ensureNode(id, name, i, currentPath, parentId);
      lineage.push(node.category.id);
      parentId = id;
    }

    // Increment product count for the whole lineage so that each node's
    // count includes all products in its subtree.
    for (const catId of lineage) {
      const node = categoryMap.get(catId);
      if (node) {
        node.category.productCount += 1;
      }
    }
  }

  const roots = [];
  for (const node of categoryMap.values()) {
    if (!node.category.parentId) {
      roots.push(node);
    }
  }

  return { roots, categoryMap };
}

function isPromoActive(promo, nowTs) {
  const start = new Date(promo.startAt).getTime();
  const end = new Date(promo.endAt).getTime();
  return nowTs >= start && nowTs <= end && !promo.deletedAt;
}

function allowedForCreator(promo, creatorId) {
  if (!creatorId) {
    return promo.exposeToCreators !== false;
  }
  if (promo.exposeToCreators === false) return false;
  if (promo.allowedCreatorIds && promo.allowedCreatorIds.length > 0) {
    return promo.allowedCreatorIds.includes(creatorId);
  }
  return true;
}

function matchesScope(promo, product) {
  const scope = promo.scope || {};
  if (scope.global) return true;

  const pid = String(product.product_id || product.id || '');
  if (scope.productIds && scope.productIds.includes(pid)) return true;

  const category = (product.category || product.product_type || '').toLowerCase();
  if (
    scope.categoryIds &&
    scope.categoryIds.some((c) => category && category.includes(String(c).toLowerCase()))
  ) {
    return true;
  }

  const brand = (product.vendor || product.brand || '').toLowerCase();
  if (
    scope.brandIds &&
    scope.brandIds.some((b) => brand && brand.includes(String(b).toLowerCase()))
  ) {
    return true;
  }

  return false;
}

function findApplicablePromotionsForProduct(product, now, promotions, creatorId) {
  const nowTs = now.getTime();
  const productMerchant = String(product.merchant_id || product.merchantId || '');
  return promotions.filter(
    (promo) =>
      isPromoActive(promo, nowTs) &&
      (!promo.merchantId || !productMerchant || String(promo.merchantId) === productMerchant) &&
      matchesScope(promo, product) &&
      Array.isArray(promo.channels) &&
      promo.channels.includes(CHANNEL_CREATOR) &&
      allowedForCreator(promo, creatorId)
  );
}

function computeUrgency(endAt) {
  if (!endAt) return 'LOW';
  const end = new Date(endAt).getTime();
  const now = Date.now();
  const diffMs = end - now;
  if (diffMs <= 0) return 'LOW';
  const diffHours = diffMs / (1000 * 60 * 60);
  if (diffHours <= 1) return 'HIGH';
  if (diffHours <= 24) return 'MEDIUM';
  return 'LOW';
}

function promotionToDealPayload(promo, productPrice) {
  const base = {
    id: promo.id,
    type: promo.type,
    label: promo.humanReadableRule || promo.name || 'Deal',
  };

  if (promo.config?.kind === 'FLASH_SALE') {
    const flashPrice = promo.config.flashPrice || null;
    const originalPrice =
      promo.config.originalPrice || productPrice || (productPrice === 0 ? 0 : null);
    const discountPercent =
      originalPrice && originalPrice > 0 && flashPrice
        ? Math.round((1 - flashPrice / originalPrice) * 100)
        : undefined;

    return {
      ...base,
      discount_percent: discountPercent,
      flash_price: flashPrice || undefined,
      end_at: promo.endAt,
      urgency_level: computeUrgency(promo.endAt),
    };
  }

  if (promo.config?.kind === 'MULTI_BUY_DISCOUNT') {
    return {
      ...base,
      discount_percent: promo.config.discountPercent,
      threshold_quantity: promo.config.thresholdQuantity,
      end_at: promo.endAt,
      urgency_level: computeUrgency(promo.endAt),
    };
  }

  return base;
}

function computeHumanReadableRule(promo) {
  if (promo.humanReadableRule) return promo.humanReadableRule;
  if (promo.config?.kind === 'MULTI_BUY_DISCOUNT') {
    const t = promo.config.thresholdQuantity;
    const d = promo.config.discountPercent;
    if (t && d) return `Buy ${t}, get ${d}% off`;
    return 'Bundle & save';
  }
  if (promo.config?.kind === 'FLASH_SALE') {
    const fp = promo.config.flashPrice;
    if (fp) return 'Flash deal';
    return 'Flash deal';
  }
  return promo.name || 'Deal';
}

async function getActivePromotions(now = new Date()) {
  let promos = [];
  try {
    promos = await getAllPromotions();
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to load promotions in category service');
    promos = [];
  }

  return promos
    .filter((p) => !p.deletedAt)
    .map((p) => ({
      ...p,
      humanReadableRule: computeHumanReadableRule(p),
    }));
}

function enrichProductsWithDeals(products, promotions, now = new Date(), creatorId = null) {
  if (!Array.isArray(products) || !products.length) return products;
  return products.map((product) => {
    const applicablePromos = findApplicablePromotionsForProduct(
      product,
      now,
      promotions,
      creatorId
    );
    const allDeals = applicablePromos.map((p) =>
      promotionToDealPayload(p, product.price || product.price_cents || product.unit_price)
    );

    let bestDeal = null;
    if (allDeals.length) {
      bestDeal = allDeals.reduce((best, current) => {
        if (!best) return current;
        const bestDiscount = best.discount_percent || 0;
        const currentDiscount = current.discount_percent || 0;
        if (currentDiscount > bestDiscount) return current;
        if (currentDiscount === bestDiscount) {
          const rank = { LOW: 0, MEDIUM: 1, HIGH: 2 };
          const bestUrgency = rank[best.urgency_level || 'LOW'];
          const currentUrgency = rank[current.urgency_level || 'LOW'];
          return currentUrgency > bestUrgency ? current : best;
        }
        return best;
      }, null);
    }

    return {
      ...product,
      best_deal: bestDeal || product.best_deal || null,
      all_deals: allDeals.length ? allDeals : product.all_deals,
    };
  });
}

async function loadCreatorProducts(creatorId) {
  const config = getCreatorConfig(creatorId);
  if (!config) {
    const err = new Error('Unknown creator');
    err.code = 'UNKNOWN_CREATOR';
    throw err;
  }

  const merchantIds = config.merchantIds || [];
  if (!merchantIds.length) {
    return { indexedProducts: [], merchantIds };
  }

  // MOCK mode: use local mockProducts catalog.
  if (USE_MOCK) {
    const indexedProducts = [];
    for (const mid of merchantIds) {
      const list = mockProducts[mid] || [];
      for (const product of list) {
        const path = deriveCategoryPathFromProduct(product);
        const leafId = buildCategoryIdFromSegments(path);
        const slug = slugify(path[path.length - 1] || 'Other');
        indexedProducts.push({ product, path, leafId, slug });
      }
    }
    return { indexedProducts, merchantIds };
  }

  // REAL / HYBRID mode: call upstream Shopping Gateway find_products_multi.
  try {
    const payload = {
      operation: 'find_products_multi',
      payload: {
        search: {
          query: '',
          category: null,
          price_min: null,
          price_max: null,
          page: 1,
          // Increase pool size while respecting backend validation (max 500).
          limit: 500,
          in_stock_only: false,
        },
        metadata: {
          creator_id: creatorId,
        },
      },
      metadata: {
        creator_id: creatorId,
        source: 'creator-category-service',
      },
    };

    const resp = await axios.post(`${PIVOTA_API_BASE}/agent/shop/v1/invoke`, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    });

    const products = Array.isArray(resp.data?.products) ? resp.data.products : [];
    let filtered = products.filter((p) => {
      const mid = String(p.merchant_id || p.merchantId || '').trim();
      if (!mid) return false;
      if (!merchantIds.length) return true;
      return merchantIds.includes(mid);
    });

    // Safety net: if creator merchant mapping is stale or empty in production
    // and filtering yields no products, fall back to all products so that
    // the Categories page still has meaningful content.
    if (!filtered.length && merchantIds.length && products.length) {
      logger.warn(
        {
          creatorId,
          expectedMerchants: merchantIds,
          totalProducts: products.length,
        },
        'No products matched creator merchants; falling back to all products for categories'
      );
      filtered = products;
    }

    const indexedProducts = filtered.map((product) => {
      const path = deriveCategoryPathFromProduct(product);
      const leafId = buildCategoryIdFromSegments(path);
      const slug = slugify(path[path.length - 1] || 'Other');
      return { product, path, leafId, slug };
    });

    return { indexedProducts, merchantIds };
  } catch (err) {
    logger.error(
      { err: err.message, creatorId },
      'Failed to load creator products from upstream for categories'
    );
    return { indexedProducts: [], merchantIds };
  }
}

function computeCategoryDeals(indexedProducts, categoryMap, promotions, now, creatorId) {
  const promoToCategoryIds = new Map();

  const promoIndex = new Map();
  for (const promo of promotions) {
    promoIndex.set(promo.id, promo);
  }

  for (const item of indexedProducts) {
    const applicable = findApplicablePromotionsForProduct(
      item.product,
      now,
      promotions,
      creatorId
    );
    if (!applicable.length || !item.leafId) continue;

    for (const promo of applicable) {
      let set = promoToCategoryIds.get(promo.id);
      if (!set) {
        set = new Set();
        promoToCategoryIds.set(promo.id, set);
      }
      set.add(item.leafId);
    }
  }

  // Attach deals to categories (and their ancestors) and compute priorities.
  for (const [promoId, catSet] of promoToCategoryIds.entries()) {
    const promo = promoIndex.get(promoId);
    if (!promo) continue;

    for (const catId of catSet) {
      let node = categoryMap.get(catId);
      while (node) {
        if (!Array.isArray(node.category.deals)) {
          node.category.deals = [];
        }
        if (!node.category.deals.includes(promoId)) {
          node.category.deals.push(promoId);
        }
        const parentId = node.category.parentId;
        node = parentId ? categoryMap.get(parentId) : null;
      }
    }
  }

  for (const node of categoryMap.values()) {
    const dealsCount = Array.isArray(node.category.deals) ? node.category.deals.length : 0;
    node.category.priority = node.category.productCount + dealsCount * 5;
  }

  const hotDeals = [];
  for (const [promoId, catSet] of promoToCategoryIds.entries()) {
    const promo = promoIndex.get(promoId);
    if (!promo) continue;
    if (!catSet.size) continue;

    const type =
      promo.config?.kind === 'FLASH_SALE' || promo.type === 'FLASH_SALE'
        ? 'FLASH_SALE'
        : 'MULTI_BUY_DISCOUNT';

    const label = promo.humanReadableRule || computeHumanReadableRule(promo);

    hotDeals.push({
      id: promo.id,
      label,
      type,
      categoryIds: Array.from(catSet),
    });
  }

  return hotDeals;
}

function filterTreeByDeals(nodes) {
  const result = [];
  for (const node of nodes) {
    const filteredChildren = filterTreeByDeals(node.children || []);
    const hasDeals = Array.isArray(node.category.deals) && node.category.deals.length > 0;
    if (hasDeals || filteredChildren.length > 0) {
      result.push({
        category: node.category,
        children: filteredChildren,
      });
    }
  }
  return result;
}

function stripCounts(nodes) {
  for (const node of nodes) {
    node.category.productCount = 0;
    if (Array.isArray(node.children)) {
      stripCounts(node.children);
    }
  }
}

async function buildCreatorCategoryTree(creatorId, options = {}) {
  const { dealsOnly = false, includeCounts = true } = options;
  const { indexedProducts } = await loadCreatorProducts(creatorId);

  const taxonomy = await getTaxonomyView({
    viewId: options.viewId,
    locale: options.locale,
  });

  if (taxonomy) {
    const creatorOverrides = await loadCreatorOverrides(creatorId);
    const assigned = await mapProductsToCanonical(indexedProducts);
    const countById = new Map();

    const parentById = new Map();
    for (const cat of taxonomy.byId.values()) {
      parentById.set(cat.id, cat.parentId || null);
    }

    const ancestorMemo = new Map();
    function ancestorsOf(id) {
      if (ancestorMemo.has(id)) return ancestorMemo.get(id);
      const out = [];
      let current = id;
      while (current && taxonomy.byId.has(current)) {
        out.push(current);
        current = parentById.get(current);
      }
      ancestorMemo.set(id, out);
      return out;
    }

    for (const { categoryId } of assigned) {
      for (const anc of ancestorsOf(categoryId)) {
        countById.set(anc, (countById.get(anc) || 0) + 1);
      }
    }

    const now = new Date();
    const promotions = await getActivePromotions(now);

    // Attach deals to categories based on product membership.
    const promoToCategoryIds = new Map();
    for (const { product, categoryId } of assigned) {
      const applicable = findApplicablePromotionsForProduct(product, now, promotions, creatorId);
      if (!applicable.length) continue;
      for (const promo of applicable) {
        let set = promoToCategoryIds.get(promo.id);
        if (!set) {
          set = new Set();
          promoToCategoryIds.set(promo.id, set);
        }
        set.add(categoryId);
      }
    }

    const dealsByCategory = new Map();
    for (const [promoId, catSet] of promoToCategoryIds.entries()) {
      for (const catId of catSet) {
        for (const anc of ancestorsOf(catId)) {
          let arr = dealsByCategory.get(anc);
          if (!arr) {
            arr = [];
            dealsByCategory.set(anc, arr);
          }
          if (!arr.includes(promoId)) arr.push(promoId);
        }
      }
    }

    const hotDeals = [];
    for (const [promoId, catSet] of promoToCategoryIds.entries()) {
      const promo = promotions.find((p) => p.id === promoId);
      if (!promo) continue;
      const type =
        promo.config?.kind === 'FLASH_SALE' || promo.type === 'FLASH_SALE'
          ? 'FLASH_SALE'
          : 'MULTI_BUY_DISCOUNT';
      const label = promo.humanReadableRule || computeHumanReadableRule(promo);
      hotDeals.push({
        id: promo.id,
        label,
        type,
        categoryIds: Array.from(catSet),
      });
    }

    function toNode(id) {
      const base = taxonomy.byId.get(id);
      if (!base) return null;

      const override = creatorOverrides.get(id);
      const hiddenByCreator = override?.hidden === true;
      const hidden = base.hidden || hiddenByCreator;

      const name = override?.name || base.name;
      const imageUrl = override?.image || base.imageUrl || undefined;

      const productCount = includeCounts ? Number(countById.get(id) || 0) : 0;
      const deals = dealsByCategory.get(id) || undefined;
      const dealsCount = Array.isArray(deals) ? deals.length : 0;

      const priorityBoost = Number(base.priorityBoost || 0) + Number(override?.boost || 0);
      const pinned = base.pinned || override?.pinned === true;
      const priority = (base.priorityBase || 0) + priorityBoost + productCount + dealsCount * 5;

      const childrenIds = taxonomy.childrenById.get(id) || [];
      const children = childrenIds.map((cid) => toNode(cid)).filter(Boolean);

      const node = {
        category: {
          id,
          slug: base.slug,
          name,
          parentId: base.parentId,
          level: base.level,
          imageUrl,
          productCount,
          path: base.path || [name],
          deals,
          priority: pinned ? priority + 1000 : priority,
        },
        children,
        _hidden: hidden,
        _pinned: pinned,
      };

      return node;
    }

    const minCount = Number(process.env.CATEGORY_MIN_PRODUCT_COUNT || 1);
    const roots = taxonomy.roots.map((rid) => toNode(rid)).filter(Boolean);

    function filterHidden(nodes) {
      const out = [];
      for (const node of nodes) {
        const children = filterHidden(node.children || []);
        const hasDeals = Array.isArray(node.category.deals) && node.category.deals.length > 0;
        const visibleByCount = (node.category.productCount || 0) >= minCount;

        if (!node._hidden && (node._pinned || visibleByCount || hasDeals || children.length > 0)) {
          out.push({
            category: node.category,
            children,
          });
        }
      }
      return out;
    }

    let finalRoots = filterHidden(roots);
    if (dealsOnly) {
      finalRoots = filterTreeByDeals(finalRoots);
    }

    return {
      creatorId,
      roots: finalRoots,
      hotDeals,
    };
  }

  if (!indexedProducts.length) {
    return {
      creatorId,
      roots: [],
      hotDeals: [],
    };
  }

  const { roots, categoryMap } = buildCategoryTree(indexedProducts);
  const now = new Date();
  const promotions = await getActivePromotions(now);
  const hotDeals = computeCategoryDeals(
    indexedProducts,
    categoryMap,
    promotions,
    now,
    creatorId
  );

  let finalRoots = roots;
  if (dealsOnly) {
    finalRoots = filterTreeByDeals(roots);
  }
  if (!includeCounts) {
    stripCounts(finalRoots);
  }

  return {
    creatorId,
    roots: finalRoots,
    hotDeals,
  };
}

async function getCreatorCategoryProducts(creatorId, categorySlug, options = {}) {
  const page = Number(options.page) > 0 ? Number(options.page) : 1;
  const limit = Number(options.limit) > 0 ? Number(options.limit) : 20;

  const { indexedProducts } = await loadCreatorProducts(creatorId);
  if (!indexedProducts.length) {
    const err = new Error('Unknown category');
    err.code = 'UNKNOWN_CATEGORY';
    throw err;
  }

  const taxonomy = await getTaxonomyView({
    viewId: options.viewId,
    locale: options.locale,
  });

  if (taxonomy) {
    let targetId = null;
    for (const cat of taxonomy.byId.values()) {
      if (cat.slug === categorySlug || cat.id === categorySlug) {
        targetId = cat.id;
        break;
      }
    }
    if (!targetId) {
      const err = new Error('Unknown category');
      err.code = 'UNKNOWN_CATEGORY';
      throw err;
    }

    const targetIds = new Set();
    const stack = [targetId];
    while (stack.length) {
      const id = stack.pop();
      if (targetIds.has(id)) continue;
      targetIds.add(id);
      const children = taxonomy.childrenById.get(id) || [];
      for (const cid of children) stack.push(cid);
    }

    const assigned = await mapProductsToCanonical(indexedProducts);
    const productsForCategory = assigned
      .filter((p) => targetIds.has(p.categoryId))
      .map((p) => p.product);

    const now = new Date();
    const promotions = await getActivePromotions(now);
    const enriched = enrichProductsWithDeals(productsForCategory, promotions, now, creatorId);

    const total = enriched.length;
    const startIdx = (page - 1) * limit;
    const endIdx = startIdx + limit;
    const slice = enriched.slice(startIdx, endIdx);

    return {
      creatorId,
      categorySlug,
      products: slice,
      pagination: {
        page,
        limit,
        total,
      },
    };
  }

  const { categoryMap } = buildCategoryTree(indexedProducts);

  let targetNode = null;
  for (const node of categoryMap.values()) {
    if (node.category.slug === categorySlug) {
      targetNode = node;
      break;
    }
  }

  if (!targetNode) {
    const err = new Error('Unknown category');
    err.code = 'UNKNOWN_CATEGORY';
    throw err;
  }

  const targetIds = new Set();
  function collectIds(node) {
    targetIds.add(node.category.id);
    for (const child of node.children || []) {
      collectIds(child);
    }
  }
  collectIds(targetNode);

  const productsForCategory = [];
  for (const item of indexedProducts) {
    if (targetIds.has(item.leafId)) {
      productsForCategory.push(item.product);
    }
  }

  const now = new Date();
  const promotions = await getActivePromotions(now);
  const enriched = enrichProductsWithDeals(productsForCategory, promotions, now, creatorId);

  const total = enriched.length;
  const startIdx = (page - 1) * limit;
  const endIdx = startIdx + limit;
  const slice = enriched.slice(startIdx, endIdx);

  return {
    creatorId,
    categorySlug,
    products: slice,
    pagination: {
      page,
      limit,
      total,
    },
  };
}

function suggestCategoriesFromQuery(query, categories) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  if (!Array.isArray(categories) || !categories.length) return [];

  const terms = q.split(/\s+/).filter(Boolean);

  const scored = categories.map((cat) => {
    const name = String(cat.name || '').toLowerCase();
    const slug = String(cat.slug || '').toLowerCase();
    const pathNames = Array.isArray(cat.path) ? cat.path.join(' ').toLowerCase() : '';
    const haystack = `${name} ${slug} ${pathNames}`;

    let score = 0;
    if (haystack.includes(q)) {
      score += 2;
    }
    for (const term of terms) {
      if (haystack.includes(term)) {
        score += 1;
      }
    }

    return score > 0 ? { categoryId: cat.id, score } : null;
  });

  return scored
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

module.exports = {
  buildCreatorCategoryTree,
  getCreatorCategoryProducts,
  suggestCategoriesFromQuery,
};
