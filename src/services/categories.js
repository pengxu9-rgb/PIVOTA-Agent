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

function containsKeyword(normalizedHaystack, keyword) {
  const hay = String(normalizedHaystack || '');
  if (!hay) return false;
  const needle = normalizeTextForMatch(keyword);
  if (!needle) return false;

  // CJK terms are commonly written without spaces, so token boundaries
  // are not meaningful. Use substring match.
  if (/[\u4e00-\u9fff]/.test(needle)) {
    return hay.includes(needle);
  }

  // For Latin words/phrases, require token boundary matching to avoid
  // false positives like "bra" matching "braun".
  return ` ${hay} `.includes(` ${needle} `);
}

const HEURISTIC_RULES = [
  {
    id: 'designer-toys',
    keywords: [
      'designer toys',
      'collectible toys',
      'art toys',
      'vinyl figure',
      'blind box',
      'labubu',
      'pop mart',
      'the monsters',
      'bag charm',
      'plush pendant',
      'keychain plush',
      '潮玩',
      '收藏玩具',
      '盲盒',
      '手办',
      '泡泡玛特',
      '包挂',
      '挂件',
      '钥匙扣',
    ],
  },
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
      'bralette',
      'panty',
      'panties',
      'underwear',
      'sexy lingerie',
      '内衣',
      '内裤',
      '文胸',
      '胸罩',
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
    id: 'womens-dress',
    keywords: [
      'dress',
      'dresses',
      'gown',
      'maxi dress',
      'midi dress',
      '连衣裙',
      '裙子',
      '礼服',
    ],
  },
  {
    id: 'outdoor-clothing',
    keywords: [
      'outdoor clothing',
      'hiking jacket',
      'windbreaker',
      'rain jacket',
      'waterproof',
      'outdoor jacket',
      'camp jacket',
      '户外服装',
      '冲锋衣',
      '风衣',
      '雨衣',
    ],
  },
  {
    id: 'camping-gear',
    keywords: ['camping gear', 'camping', 'tent', 'sleeping bag', 'camp stove', '露营', '帐篷', '睡袋', '炉具'],
  },
  {
    id: 'hunting-accessories',
    keywords: ['hunting accessories', 'hunting', 'scope', 'camouflage', '狩猎', '迷彩'],
  },
  {
    id: 'toys',
    keywords: ['toy', 'toys', 'plush', 'stuffed', 'doll', 'figure', '玩具', '毛绒', '公仔', '娃娃', '手办'],
  },
  {
    id: 'makeup',
    keywords: ['makeup', 'foundation', 'lipstick', 'concealer', 'blush', 'eyeshadow', '彩妆', '粉底', '口红', '遮瑕', '腮红', '眼影'],
  },
  {
    id: 'skin-care',
    keywords: [
      'skin care',
      'skincare',
      'moisturizer',
      'serum',
      'cleanser',
      'toner',
      '护肤',
      '面霜',
      '精华',
      '洁面',
      '爽肤水',
    ],
  },
  {
    id: 'facial-care',
    keywords: ['facial care', 'face mask', 'exfoliation', 'face wash', '面部护理', '面膜', '去角质', '洗面奶'],
  },
  {
    id: 'haircare',
    keywords: ['haircare', 'shampoo', 'conditioner', 'hair oil', 'hair mask', '护发', '洗发水', '护发素', '发油', '发膜'],
  },
  {
    id: 'eyelashes',
    keywords: ['eyelashes', 'false lashes', 'lash extensions', 'lash glue', '假睫毛', '睫毛胶'],
  },
  {
    id: 'nail-polish',
    keywords: ['nail polish', 'gel polish', 'polish', '指甲油', '甲油胶'],
  },
  {
    id: 'press-on-nails',
    keywords: ['press on nails', 'press-ons', 'fake nails', '穿戴甲', '假指甲'],
  },
  {
    id: 'beauty-tools',
    keywords: ['beauty tools', 'makeup brush', 'sponge', 'applicator', '美妆工具', '化妆刷', '美妆蛋'],
  },
  {
    id: 'beauty-devices',
    keywords: ['beauty device', 'led mask', 'microcurrent', 'beauty仪', '美容仪', 'LED面罩', '微电流'],
  },
  {
    id: 'contact-lens',
    keywords: ['contact lens', 'contact lenses', 'colored contacts', 'contacts', '隐形眼镜', '美瞳'],
  },
  {
    id: 'pet-toys',
    keywords: ['pet toys', 'dog toy', 'cat toy', 'chew toy', 'pet plush', '宠物玩具', '狗玩具', '猫玩具'],
  },
  {
    id: 'pet-apparel',
    keywords: [
      'pet clothing',
      'pet clothes',
      'pet apparel',
      'dog clothes',
      'cat clothes',
      'dog clothing',
      'cat clothing',
      'dog sweater',
      'cat sweater',
      'dog coat',
      'cat coat',
      'pet jacket',
      'pet onesie',
      'pet boots',
      'dog boots',
      'dog shoes',
      '宠物衣服',
      '宠物服饰',
      '狗衣服',
      '猫衣服',
      '宠物鞋',
      '狗鞋',
      '猫鞋',
    ],
  },
];

function isStatusActive(status) {
  const normalized = String(status || 'active').toLowerCase();
  return normalized === 'active';
}

function isProductSellable(product) {
  if (!product || typeof product !== 'object') return false;
  const status = product.status;
  if (!isStatusActive(status)) return false;

  // Only treat explicit false as unsellable; undefined / null / missing
  // are allowed so that older cache rows without orderable still surface.
  if (Object.prototype.hasOwnProperty.call(product, 'orderable')) {
    if (product.orderable === false) return false;
  }

  return true;
}

function heuristicCategoryForProduct(product) {
  const primaryHaystack = normalizeTextForMatch(
    [
      product.title,
      product.name,
      product.description,
      product.product_type,
      product.category,
    ]
      .filter(Boolean)
      .join(' '),
  );

  const haystack = normalizeTextForMatch(
    [
      product.title,
      product.name,
      product.description,
      product.vendor,
      product.brand,
      product.product_type,
      product.category,
      normalizeMerchantCategoryKey(product),
    ]
      .filter(Boolean)
      .join(' '),
  );

  // Detect strong lingerie / sleepwear signals from the product itself
  // (title / description / product type / category). When these are
  // present we should not override them with a generic "toy" match that
  // might come from a noisy merchant category.
  const lingerieSignals = [
    'lingerie',
    'lingerie set',
    'bra',
    'bralette',
    'panty',
    'panties',
    'underwear',
    'sexy lingerie',
    'sleepwear',
    'pajamas',
    'pyjamas',
    'robe',
    'homewear',
    '内衣',
    '内裤',
    '文胸',
    '胸罩',
    '家居服',
    '睡衣',
    '浴袍',
  ];
  let hasLingerieSignal = false;
  for (const kw of lingerieSignals) {
    if (containsKeyword(primaryHaystack, kw)) {
      hasLingerieSignal = true;
      break;
    }
  }

  const petSignals = ['dogs', 'cats', 'pet', 'puppy', 'kitten', '宠物', '狗', '猫'];
  let hasPetSignal = false;
  for (const kw of petSignals) {
    if (containsKeyword(primaryHaystack, kw)) {
      hasPetSignal = true;
      break;
    }
  }

  if (hasPetSignal) {
    const petToySignals = [
      'pet toy',
      'pet toys',
      'dog toy',
      'cat toy',
      'chew toy',
      'squeaky',
      'chew',
      'ball',
      'fetch',
      '玩具',
      '磨牙',
      '咬咬',
    ];
    for (const kw of petToySignals) {
      if (containsKeyword(haystack, kw)) return 'pet-toys';
    }

    const petApparelSignals = [
      'onesie',
      'sweater',
      'coat',
      'vest',
      'tee',
      'shirt',
      'jacket',
      'clothes',
      'clothing',
      'hoodie',
      'raincoat',
      'boot',
      'boots',
      'shoe',
      'shoes',
      'padded',
      'knit',
      '衣服',
      '服饰',
      '外套',
      '毛衣',
      '背心',
      '鞋',
      '雨衣',
    ];
    for (const kw of petApparelSignals) {
      if (containsKeyword(primaryHaystack, kw)) return 'pet-apparel';
    }

    // Default pet bucket: in absence of a clearer signal, prefer pet-apparel
    // so pet items don't leak into womenswear buckets.
    return 'pet-apparel';
  }

  // Toys are visually very different from fashion/lingerie, and we want
  // to avoid misclassifying collectible dolls/plushies as lingerie just
  // because the vendor name contains "lingerie". Give toy signals a
  // dedicated fast-path before generic keyword rules – but never override
  // clear lingerie / sleepwear signals coming from the product itself.
  const toySignals = [
    'toy',
    'toys',
    'plush',
    'stuffed',
    'doll',
    'figure',
    '玩具',
    '毛绒',
    '公仔',
    '娃娃',
    '手办',
  ];
  if (!hasLingerieSignal) {
    for (const kw of toySignals) {
      if (containsKeyword(haystack, kw)) {
        return 'toys';
      }
    }
  }

  // Prefer routing brushes/sponges/devices into dedicated beauty buckets
  // before broader "makeup" matches.
  const beautyToolsSignals = [
    'beauty tools',
    'makeup brush',
    'sponge',
    'applicator',
    '美妆工具',
    '化妆刷',
    '美妆蛋',
  ];
  for (const kw of beautyToolsSignals) {
    if (containsKeyword(primaryHaystack, kw)) return 'beauty-tools';
  }

  const beautyDeviceSignals = ['beauty device', 'led mask', 'microcurrent', 'beauty仪', '美容仪', 'LED面罩', '微电流'];
  for (const kw of beautyDeviceSignals) {
    if (containsKeyword(primaryHaystack, kw)) return 'beauty-devices';
  }

  for (const rule of HEURISTIC_RULES) {
    for (const kw of rule.keywords) {
      if (containsKeyword(primaryHaystack, kw)) return rule.id;
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

const CATEGORY_GROUPS = {
  fashion: new Set(['sportswear', 'lingerie-set', 'womens-loungewear', 'womens-dress', 'outdoor-clothing']),
  beauty: new Set([
    'beauty-tools',
    'beauty-devices',
    'makeup',
    'skin-care',
    'facial-care',
    'haircare',
    'eyelashes',
    'nails',
    'nail-polish',
    'press-on-nails',
    'contact-lens',
  ]),
  pets: new Set(['pet-toys', 'pet-apparel']),
  toys: new Set(['toys', 'designer-toys']),
  outdoor: new Set(['camping-gear', 'hunting-accessories']),
};

function categoryGroup(categoryId) {
  const id = String(categoryId || '').trim();
  if (!id) return 'other';
  for (const [group, ids] of Object.entries(CATEGORY_GROUPS)) {
    if (ids.has(id)) return group;
  }
  return 'other';
}

const loggedMappingOverrides = new Set();

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
    const heuristicId = heuristicCategoryForProduct(p);

    let categoryId = heuristicId;
    if (mapped && mapped.confidence >= 0.6) {
      categoryId = mapped.categoryId;

      // Guardrail: if a merchant-level mapping produces a clear cross-vertical mismatch
      // (e.g., beauty tools mapped to lingerie), prefer the product-level heuristic.
      const mappedGroup = categoryGroup(mapped.categoryId);
      const heuristicGroup = categoryGroup(heuristicId);
      if (
        mappedGroup !== 'other' &&
        heuristicGroup !== 'other' &&
        mappedGroup !== heuristicGroup &&
        heuristicId &&
        heuristicId !== 'other'
      ) {
        categoryId = heuristicId;
        if (!loggedMappingOverrides.has(mapKey)) {
          loggedMappingOverrides.add(mapKey);
          logger.warn(
            {
              merchantId,
              merchantCategoryKey: key,
              mappedCategoryId: mapped.categoryId,
              mappedConfidence: mapped.confidence,
              heuristicCategoryId: heuristicId,
            },
            'Overriding merchant category mapping due to cross-vertical conflict',
          );
        }
      }
    }

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

  // MOCK mode: use local mockProducts catalog.
  if (USE_MOCK) {
    const indexedProducts = [];
    const mids = merchantIds.length ? merchantIds : Object.keys(mockProducts);
    for (const mid of mids) {
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

  // Prefer reading the full merchant catalog directly from the cache DB
  // when available so that category trees (including toys) reflect the
  // actual merchant portal inventory, not just the recall subset used
  // by find_products_multi.
  if (merchantIds.length && process.env.DATABASE_URL) {
    try {
      const limit = Number(process.env.CREATOR_CATEGORIES_MAX_PRODUCTS || 2000);
      const res = await query(
        `
          SELECT product_data
          FROM products_cache
          WHERE merchant_id = ANY($1)
            AND expires_at > now()
          ORDER BY cached_at DESC
          LIMIT $2
        `,
        [merchantIds, limit],
      );

      if (Array.isArray(res.rows) && res.rows.length > 0) {
        const indexedProducts = res.rows
          .map((row) => row.product_data || row.product || row)
          .filter((product) => isProductSellable(product))
          .map((product) => {
            const path = deriveCategoryPathFromProduct(product);
            const leafId = buildCategoryIdFromSegments(path);
            const slug = slugify(path[path.length - 1] || 'Other');
            return { product, path, leafId, slug };
          });
        return { indexedProducts, merchantIds };
      }

      logger.warn(
        { creatorId, merchantIds, limit },
        'No products found in products_cache for creator; falling back to gateway recall'
      );
    } catch (err) {
      logger.warn(
        { err: err.message, creatorId, merchantIds },
        'Failed to load creator products from cache; falling back to gateway recall'
      );
    }
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
    // For creator categories, we intentionally do not hard-filter by
    // merchantIds here so that the taxonomy and category tree can
    // leverage the full cross-merchant product pool returned by
    // find_products_multi. We only drop items missing a merchant id.
    const filtered = products.filter((p) => {
      const mid = String(p.merchant_id || p.merchantId || '').trim();
      if (!mid) return false;
      return isProductSellable(p);
    });

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
  const { dealsOnly = false, includeCounts = true, includeEmpty = false } = options;
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
      const children = childrenIds
        .map((cid) => toNode(cid))
        .filter(Boolean)
        .sort((a, b) => (b.category.priority ?? 0) - (a.category.priority ?? 0));

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

    function filterAndLift(nodes) {
      const out = [];
      for (const node of nodes) {
        const liftedChildren = filterAndLift(node.children || []);
        const hasDeals = Array.isArray(node.category.deals) && node.category.deals.length > 0;
        const visibleByCount = (node.category.productCount || 0) >= minCount;
        const shouldInclude =
          !node._hidden &&
          (node._pinned ||
            includeEmpty ||
            visibleByCount ||
            hasDeals ||
            liftedChildren.length > 0);

        if (shouldInclude) {
          out.push({
            category: node.category,
            children: liftedChildren,
          });
        } else {
          out.push(...liftedChildren);
        }
      }
      return out;
    }

    let finalRoots = filterAndLift(roots).sort(
      (a, b) => (b.category.priority ?? 0) - (a.category.priority ?? 0),
    );
    if (dealsOnly) {
      finalRoots = filterTreeByDeals(finalRoots);
    }

    return {
      creatorId,
      taxonomyVersion: taxonomy.version,
      market: taxonomy.market,
      locale: taxonomy.locale,
      viewId: taxonomy.viewId,
      source: 'canonical',
      roots: finalRoots,
      hotDeals,
    };
  }

  if (!indexedProducts.length) {
    return {
      creatorId,
      source: 'legacy',
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
    source: 'legacy',
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
