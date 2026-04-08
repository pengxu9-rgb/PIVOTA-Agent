const {
  buildPdpImageDedupeKey,
  normalizePdpImageUrl,
  normalizePdpImageUrls,
} = require('./utils/pdpImageUrls');
const { stripExternalSeedMarketingBannerPrefix } = require('./services/externalSeedMarketingText');

const SHOPIFY_FILE_HASH_SUFFIX_RE =
  /^(.*?_[0-9]+)_(?:[0-9a-f]{8,}(?:-[0-9a-f]{4,}){2,}|[0-9a-f-]{16,})\.(avif|gif|jpe?g|png|webp)$/i;

const BEAUTY_KEYWORDS = [
  'beauty',
  'makeup',
  'cosmetic',
  'skincare',
  'skin care',
  'lip',
  'lips',
  'lipstick',
  'foundation',
  'concealer',
  'blush',
  'mascara',
  'eyeshadow',
  'fragrance',
  'perfume',
];
const INGREDIENT_SECTION_HEADING_RE = /\b(ingredients?|inci|full ingredients?)\b/i;
const ACTIVE_INGREDIENT_SECTION_HEADING_RE = /\b(active ingredients?|key ingredients?|actives?)\b/i;
const HOW_TO_USE_SECTION_HEADING_RE = /\b(how to use|directions?|usage|application)\b/i;
const BRAND_STORY_SECTION_HEADING_RE = /\b(brand|story)\b/i;
const GENERIC_DETAIL_SECTION_HEADING_RE = /^(product details?|details?|overview)$/i;
const CATEGORY_SECTION_HEADING_RE = /^category$/i;
const DETAIL_LABEL_PHRASES = [
  'What Else You Need To Know',
  'Shades Included',
  'Skin Concern',
  'Set Includes',
  'Skin Type',
  'Key Notes',
  'Coverage',
  'Benefits',
  'Free From',
  'Finish',
];
const OVERVIEW_FACT_LABELS = [
  'Skin Type',
  'Skin Concern',
  'Finish',
  'Coverage',
  'Best For',
  'Key Notes',
];
const OVERVIEW_HIGHLIGHT_LABELS = [
  'Benefits',
  'Features',
  'Highlights',
  'Results',
  'What Else You Need To Know',
  'Free From',
];
const INLINE_SENTENCE_BREAK_LABELS = Array.from(
  new Set([...OVERVIEW_FACT_LABELS, ...OVERVIEW_HIGHLIGHT_LABELS]),
).sort((left, right) => right.length - left.length);
const INGREDIENT_DISCLAIMER_PATTERNS = [
  /\bplease be aware that ingredient lists?[\s\S]*$/i,
  /\bplease note that ingredient lists?[\s\S]*$/i,
  /\bplease refer to the ingredient list[\s\S]*$/i,
  /\bfor the most up-to-date information[\s\S]*$/i,
];
const INGREDIENT_ITEM_NOISE_PATTERNS = [
  /\bplease be aware\b/i,
  /\bplease refer to\b/i,
  /\bfor the most up-to-date information\b/i,
  /\bwe got you covered\b/i,
  /\bhealth and safety\b/i,
  /\bhigh-quality ingredients\b/i,
  /\btab on each product\b/i,
  /\bconsult(?:ing)? your physician\b/i,
  /\bwhile nursing\b/i,
  /\bhit up your physician\b/i,
  /\bdescription page\b/i,
  /^&(?:[a-z]+|#\d+);?$/i,
  /^[’'`]+$/i,
  /\bhelp create a soothing lather\b/i,
  /\bcaffeine-containing ingredients\b/i,
  /\bhighly prized japanese tea\b/i,
  /\btom ford research\b/i,
];
const EXTERNAL_SEED_FACT_NOISE_RE =
  /\b(contact us|customer service|privacy policy|terms(?: and conditions)?|shipping policy|return policy|about us|about the brands?|blog|blogs|impact|foundation transparency|transparency|give 20%|donation|donate|store locator|support|avoid contact with eyes|keep out of reach of children|customerservice@|clearorg\.eu|clear \d+\s+rue|student discounts|careers)\b/i;
const EXTERNAL_SEED_LOW_VALUE_FACT_RE =
  /\b(earth-conscious details?|outer box is recyclable|recyclable packaging|refillable packaging|recycle the inner container)\b/i;
const EXTERNAL_SEED_SYNTHETIC_SUMMARY_RE =
  /^\s*OFFICIAL:\s*([\s\S]*?)(?:\s*\/\/\/\s*SOCIAL HIGHLIGHTS:\s*[\s\S]*)$/i;
const EXTERNAL_SEED_OVERVIEW_TAG_PHRASES = [
  'cruelty free',
  'paraben free',
  'vegan',
  'gluten free',
  'fragrance free',
  'dermatologist tested',
  'sulfate free',
  'silicone free',
  'oil free',
  'noncomedogenic',
  'non-comedogenic',
  'clean at sephora',
];
const EXTERNAL_SEED_OVERVIEW_MEASUREMENT_RE =
  /\b\d+(?:\.\d+)?\s*(?:fl\.?\s*oz|oz|ml|mL|g|kg)\b/i;
const UI_CHROME_IMAGE_FILENAME_RE =
  /^(?:menu|close|search|cart|account|icon[-_](?:search|cart|account)|tf_logo|logo)\.(?:svg|ico|gif)$/i;

const { buildProductIntelBundle } = require('./pdpProductIntel');

function createPageRequestId() {
  return `pr_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
}

function ensureJsonObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function stripHtml(input) {
  return String(input || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtmlEntities(input) {
  return String(input || '')
    .replace(/&#(\d+);?/g, (_match, code) => {
      const numeric = Number(code);
      return Number.isFinite(numeric) ? String.fromCodePoint(numeric) : _match;
    })
    .replace(/&#x([0-9a-f]+);?/gi, (_match, code) => {
      const numeric = Number.parseInt(code, 16);
      return Number.isFinite(numeric) ? String.fromCodePoint(numeric) : _match;
    })
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&rsquo;/gi, "'")
    .replace(/&lsquo;/gi, "'")
    .replace(/&rdquo;/gi, '"')
    .replace(/&ldquo;/gi, '"')
    .replace(/&mdash;/gi, '-')
    .replace(/&ndash;/gi, '-')
    .replace(/&hellip;/gi, '...');
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeAmount(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value) || 0;
  if (value && typeof value.amount === 'number') return value.amount;
  if (value && typeof value.amount === 'string') return Number(value.amount) || 0;
  return 0;
}

function normalizeCurrency(value, fallback = 'USD') {
  return value?.currency || value?.currency_code || fallback;
}

function normalizeInStock(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value > 0;
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
    const asNumber = Number(value);
    if (!Number.isNaN(asNumber)) return asNumber > 0;
  }
  return undefined;
}

function resolveProductBrandLabel(product) {
  if (!product || typeof product !== 'object') return null;
  const brandObject =
    product.brand && typeof product.brand === 'object' && !Array.isArray(product.brand)
      ? product.brand
      : null;
  const candidates = [
    brandObject?.name,
    brandObject?.brand_name,
    typeof product.brand === 'string' ? product.brand : null,
    product.brand_name,
    product.vendor,
    product.vendor_name,
  ];
  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (value) return value;
  }
  return null;
}

function detectTemplateHint(product) {
  const category = String(product.category || product.product_type || '').toLowerCase();
  const title = String(product.title || product.name || '').toLowerCase();
  const tags = Array.isArray(product.tags) ? product.tags.join(' ').toLowerCase() : '';
  const brand = String(resolveProductBrandLabel(product) || '').toLowerCase();
  const combined = `${category} ${title} ${tags} ${brand}`;
  return BEAUTY_KEYWORDS.some((kw) => combined.includes(kw)) ? 'beauty' : 'generic';
}

function isExternalSeedProduct(product) {
  const source = String(product?.source || '').trim().toLowerCase();
  const merchantId = String(product?.merchant_id || product?.merchant?.id || '').trim().toLowerCase();
  const productId = String(product?.product_id || product?.id || '').trim().toLowerCase();
  return source === 'external_seed' || merchantId === 'external_seed' || productId.startsWith('ext_');
}

function looksLikeExternalSeedFactNoise(value) {
  const text = normalizeTextValue(value);
  if (!text) return false;
  return EXTERNAL_SEED_FACT_NOISE_RE.test(text);
}

function looksLikeExternalSeedOverviewTagSoup(value) {
  const text = normalizeTextValue(value);
  if (!text) return false;
  const segments = text
    .split(/\n+|[•|]+/)
    .map((item) => normalizeTextValue(item))
    .filter(Boolean);
  const normalizedText = text.toLowerCase();
  const tagHits = EXTERNAL_SEED_OVERVIEW_TAG_PHRASES.reduce(
    (count, phrase) => count + (normalizedText.includes(phrase) ? 1 : 0),
    0,
  );
  const measurementHits = (segments.length ? segments : [text]).reduce(
    (count, item) => count + (EXTERNAL_SEED_OVERVIEW_MEASUREMENT_RE.test(item) ? 1 : 0),
    0,
  );
  return (measurementHits >= 1 && tagHits >= 2) || tagHits >= 4;
}

const MODULE_REQUIREMENTS = {
  media_gallery: {
    requiredPaths: ['data.items'],
    validate: (module) => {
      const items = module?.data?.items;
      return Array.isArray(items) && items.some((item) => item?.url && item?.type);
    },
  },
  price_promo: {
    requiredPaths: ['data.price.amount', 'data.price.currency'],
  },
  variant_selector: {
    requiredPaths: ['data.selected_variant_id'],
  },
  ingredients_inci: {
    requiredPaths: ['data.title'],
    validate: (module) =>
      hasValue(getByPath(module, 'data.raw_text')) ||
      (Array.isArray(module?.data?.items) && module.data.items.length > 0),
  },
  active_ingredients: {
    requiredPaths: ['data.title'],
    validate: (module) =>
      (Array.isArray(module?.data?.items) && module.data.items.length > 0) ||
      hasValue(getByPath(module, 'data.raw_text')),
  },
  how_to_use: {
    requiredPaths: ['data.title'],
    validate: (module) =>
      hasValue(getByPath(module, 'data.raw_text')) ||
      (Array.isArray(module?.data?.steps) && module.data.steps.length > 0),
  },
  product_facts: {
    requiredPaths: ['data.sections'],
    validate: (module) => {
      const sections = module?.data?.sections;
      return (
        Array.isArray(sections) &&
        sections.some((section) => section?.heading && section?.content && section?.content_type)
      );
    },
  },
  product_details: {
    requiredPaths: ['data.sections'],
    validate: (module) => {
      const sections = module?.data?.sections;
      return (
        Array.isArray(sections) &&
        sections.some((section) => section?.heading && section?.content && section?.content_type)
      );
    },
  },
  product_intel: {
    requiredPaths: ['data.display_name', 'data.what_it_is'],
    validate: (module) =>
      Boolean(module?.data?.what_it_is?.headline || module?.data?.what_it_is?.body),
  },
  texture_finish: {
    validate: (module) =>
      Boolean(
        module?.data?.texture ||
          module?.data?.finish ||
          (Array.isArray(module?.data?.sensory_notes) && module.data.sensory_notes.length) ||
          (Array.isArray(module?.data?.layering_notes) && module.data.layering_notes.length),
      ),
  },
  community_signals: {
    requiredPaths: ['data.status'],
    validate: (module) => String(module?.data?.status || '').trim().toLowerCase() === 'available',
  },
  reviews_preview: {
    requiredPaths: ['data.rating', 'data.review_count'],
  },
  recommendations: {
    requiredPaths: ['data.items'],
    validate: (module) => Array.isArray(module?.data?.items) && module.data.items.length > 0,
  },
  trust_badges: {
    requiredPaths: ['data.items'],
    validate: (module) => Array.isArray(module?.data?.items) && module.data.items.length > 0,
  },
};

function getByPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc ? acc[key] : undefined), obj);
}

function hasValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function isValidSizeGuide(sizeGuide) {
  if (!sizeGuide || typeof sizeGuide !== 'object') return false;
  const columns = Array.isArray(sizeGuide.columns) ? sizeGuide.columns : [];
  const rows = Array.isArray(sizeGuide.rows) ? sizeGuide.rows : [];
  if (!columns.length || !rows.length) return false;
  return rows.every(
    (row) => row?.label && Array.isArray(row.values) && row.values.length > 0,
  );
}

function validateModule(module) {
  if (!module || typeof module !== 'object') return false;
  const rule = MODULE_REQUIREMENTS[module.type];
  if (!rule) return true;
  const paths = rule.requiredPaths || [];
  for (const path of paths) {
    if (!hasValue(getByPath(module, path))) {
      return false;
    }
  }
  if (rule.validate && !rule.validate(module)) {
    return false;
  }
  return true;
}

function validateBasePayload(payload, qualitySignals) {
  let ok = true;
  if (!payload || typeof payload !== 'object') ok = false;
  if (!payload?.schema_version || typeof payload.schema_version !== 'string') ok = false;
  if (!payload?.page_type || typeof payload.page_type !== 'string') ok = false;
  if (!payload?.tracking?.page_request_id || !payload?.tracking?.entry_point) ok = false;
  if (!payload?.product || typeof payload.product !== 'object') ok = false;
  if (!payload?.product?.product_id) ok = false;
  if (!payload?.product?.title) ok = false;
  if (!payload?.product?.default_variant_id) ok = false;
  if (!Array.isArray(payload?.product?.variants)) ok = false;
  if (!Array.isArray(payload?.modules)) ok = false;
  if (!Array.isArray(payload?.actions)) ok = false;
  if (!ok) {
    qualitySignals.fallback_used.schema = true;
  }
  return ok;
}

function compileModules(modules, qualitySignals) {
  const safeModules = [];
  const droppedModules = [];
  const list = Array.isArray(modules) ? modules : [];
  list.forEach((module) => {
    const valid = validateModule(module);
    if (valid) {
      safeModules.push(module);
      if (module?.type) {
        qualitySignals.coverage_by_module[module.type] = 1;
      }
    } else if (module?.type) {
      qualitySignals.coverage_by_module[module.type] = 0;
      qualitySignals.fallback_used[module.type] = true;
      droppedModules.push({
        module_id: module?.module_id,
        type: module?.type,
        reason: 'missing_required_fields',
      });
    }
  });
  return { modules: safeModules, droppedModules };
}

function computeBuyBoxSignals(payload, qualitySignals) {
  const modules = Array.isArray(payload?.modules) ? payload.modules : [];
  const priceModule = modules.find((m) => m?.type === 'price_promo');
  const priceOk =
    priceModule &&
    hasValue(getByPath(priceModule, 'data.price.amount')) &&
    hasValue(getByPath(priceModule, 'data.price.currency'));
  const actions = Array.isArray(payload?.actions) ? payload.actions : [];
  const hasCheckoutAction = actions.some(
    (action) => action?.action_type === 'buy_now' || action?.action_type === 'add_to_cart',
  );
  const inStock = payload?.product?.availability?.in_stock;
  const stockOk = typeof inStock === 'boolean' ? inStock : true;
  const coverage = priceOk && hasCheckoutAction && stockOk ? 1 : 0;
  qualitySignals.coverage_by_module.buy_box = coverage;
  qualitySignals.gating.buy_box_ok = coverage >= 1;
  if (coverage < 1) {
    qualitySignals.fallback_used.buy_box = true;
  }
}

function computeSizeGuideSignals(payload, qualitySignals) {
  const sizeGuide = payload?.product?.size_guide;
  const isValid = isValidSizeGuide(sizeGuide);
  if (!isValid && payload?.product?.size_guide) {
    delete payload.product.size_guide;
  }
  const confidence = isValid ? 1 : 0;
  qualitySignals.parse_confidence.size_guide = confidence;
  qualitySignals.fallback_used.size_guide = Boolean(sizeGuide) && !isValid;
  qualitySignals.gating.size_guide_ok = confidence >= 0.6;
}

function compilePdpPayload(payload, options = {}) {
  const qualitySignals = {
    coverage_by_module: {},
    parse_confidence: {},
    fallback_used: {},
    gating: {},
  };

  validateBasePayload(payload, qualitySignals);
  const compiled = compileModules(payload.modules, qualitySignals);
  payload.modules = compiled.modules;
  computeBuyBoxSignals(payload, qualitySignals);
  computeSizeGuideSignals(payload, qualitySignals);

  payload.quality_signals = qualitySignals;
  const debugEnabled =
    Boolean(options.debug) &&
    (process.env.NODE_ENV !== 'production' || process.env.PDP_DEBUG === 'true');
  if (debugEnabled) {
    payload.x_debug = {
      dropped_modules: compiled.droppedModules,
    };
  }
  return payload;
}

function inferCategoryPath(product) {
  const category = String(product.category || product.product_type || '').trim();
  if (!category) return [];
  return category.split('/').map((s) => s.trim()).filter(Boolean);
}

function toVariantPrice(input, currency) {
  if (!input) return undefined;
  const amount =
    input.amount ??
    input.current?.amount ??
    input.price ??
    input.price_amount ??
    input.value ??
    input;
  const compareAt =
    input.compare_at ??
    input.compareAt ??
    input.compare_at_price ??
    input.list_price;

  return {
    current: { amount: normalizeAmount(amount), currency: normalizeCurrency(input, currency) },
    ...(compareAt != null
      ? {
          compare_at: {
            amount: normalizeAmount(compareAt),
            currency: normalizeCurrency(input, currency),
          },
        }
      : {}),
  };
}

function buildVariants(product) {
  const currency = product.currency || 'USD';
  const rawVariants = Array.isArray(product.variants) ? product.variants : [];
  if (!rawVariants.length) {
    const availabilityInStock = normalizeInStock(product.in_stock);
    const rawQty =
      product.available_quantity ?? product.inventory_quantity ?? product.quantity ?? product.stock;
    const availableQuantity =
      rawQty == null || rawQty === ''
        ? undefined
        : Number.isFinite(Number(rawQty))
          ? Math.max(0, Math.floor(Number(rawQty)))
          : undefined;

    const availability = {};
    if (availabilityInStock !== undefined) availability.in_stock = availabilityInStock;
    if (availableQuantity !== undefined) availability.available_quantity = availableQuantity;
    return [
      {
        variant_id: product.product_id || product.id,
        sku_id: product.sku || product.product_id || product.id,
        title: 'Default',
        options: [],
        price: { current: { amount: normalizeAmount(product.price), currency } },
        availability,
        image_url: normalizePdpImageUrl(product.image_url) || undefined,
      },
    ];
  }

  return rawVariants.map((v, idx) => {
    const attrs =
      v && typeof v.variant_attributes === 'object' && !Array.isArray(v.variant_attributes)
        ? v.variant_attributes
        : {};
    const variantId = v.variant_id || v.id || v.sku || v.sku_id || `${product.product_id}-${idx + 1}`;
    const title = v.title || v.name || v.option_title || v.sku_name || `Variant ${idx + 1}`;
    const productOptionNames = Array.isArray(product.options)
      ? product.options
          .map((option) =>
            typeof option === 'string'
              ? option
              : option?.name || option?.title || option?.label || null,
          )
          .filter(Boolean)
      : Array.isArray(product.product_options)
        ? product.product_options
            .map((option) =>
              typeof option === 'string'
                ? option
                : option?.name || option?.title || option?.label || null,
            )
            .filter(Boolean)
        : [];
    const selectedOptions = Array.isArray(attrs.selected_options)
      ? attrs.selected_options
      : Array.isArray(attrs.options)
        ? attrs.options
        : [];
    const fallbackTupleOptions = [v.option1, v.option2, v.option3]
      .map((value, optionIndex) => {
        if (value == null || value === '') return null;
        return {
          name: productOptionNames[optionIndex] || `Option ${optionIndex + 1}`,
          value: String(value),
        };
      })
      .filter(Boolean);
    const options = Array.isArray(v.options)
      ? v.options
      : typeof v.options === 'object' && v.options
        ? Object.entries(v.options).map(([name, value]) => ({ name, value: String(value) }))
        : selectedOptions.length
          ? selectedOptions
              .map((option, optionIndex) => {
                if (!option || typeof option !== 'object') return null;
                const name =
                  option.name ||
                  option.option_name ||
                  option.key ||
                  productOptionNames[optionIndex] ||
                  `Option ${optionIndex + 1}`;
                const value =
                  option.value ??
                  option.option_value ??
                  option.label ??
                  option.title;
                if (!name || value == null || value === '') return null;
                return {
                  name: String(name),
                  value: String(value),
                };
              })
              .filter(Boolean)
          : fallbackTupleOptions;

    let inStock;
    if (typeof v.in_stock === 'boolean') {
      inStock = v.in_stock;
    } else if (typeof v.available === 'boolean') {
      inStock = v.available;
    } else if (v.inventory_quantity != null) {
      inStock = Number(v.inventory_quantity) > 0;
    } else if (v.quantity != null) {
      inStock = Number(v.quantity) > 0;
    }

    const rawQty =
      v.available_quantity ?? v.inventory_quantity ?? v.quantity ?? v.stock ?? v.inventory?.available_quantity;
    const availableQuantity =
      rawQty == null || rawQty === ''
        ? undefined
        : Number.isFinite(Number(rawQty))
          ? Math.max(0, Math.floor(Number(rawQty)))
          : undefined;

    if (inStock === undefined && availableQuantity !== undefined) {
      inStock = availableQuantity > 0;
    }

    const swatchHex =
      v.color_hex ||
      v.swatch?.hex ||
      v.beauty_meta?.shade_hex ||
      v.shade_hex ||
      v.hex;

    const availability = {};
    if (inStock !== undefined) availability.in_stock = inStock;
    if (availableQuantity !== undefined) availability.available_quantity = availableQuantity;
    const variantImages = filterVariantImagesBySku(
      [
        v.image_url,
        v.image,
        ...(Array.isArray(v.images) ? v.images : []),
        ...(Array.isArray(v.image_urls) ? v.image_urls : []),
      ],
      v.sku_id || v.sku || v.sku_code || attrs.sku,
    );

    const resolvedSkuId =
      v.sku_id || v.sku || v.sku_code || attrs.sku || extractAssetSkuFromUrl(variantImages[0]);

    return {
      variant_id: String(variantId),
      sku_id: resolvedSkuId || undefined,
      title: String(title),
      options,
      swatch: swatchHex ? { hex: swatchHex } : undefined,
      price: toVariantPrice(v.price || v.pricing, currency),
      availability,
      image_url: variantImages[0],
      images: variantImages,
      image_urls: variantImages,
    };
  });
}

function buildMediaItems(product, variants) {
  const items = [];
  const seenMediaKeys = new Set();
  const media = Array.isArray(product.media) ? product.media : [];
  const images = Array.isArray(product.images)
    ? product.images
    : Array.isArray(product.image_urls)
      ? product.image_urls
      : [];
  const primaryVariant =
    Array.isArray(variants) && variants.length > 0 && variants[0] && typeof variants[0] === 'object'
      ? variants[0]
      : null;
  const primaryVariantSku = String(
    primaryVariant?.sku_id ||
      primaryVariant?.sku ||
      extractAssetSkuFromUrl(primaryVariant?.image_url),
  )
    .trim()
    .toLowerCase();
  const resolveVariantGalleryImages = (variant) =>
    filterVariantImagesBySku(
      [
        ...(Array.isArray(variant?.images) ? variant.images : []),
        ...(Array.isArray(variant?.image_urls) ? variant.image_urls : []),
        ...(variant?.image_url ? [variant.image_url] : []),
      ],
      variant?.sku_id || variant?.sku || extractAssetSkuFromUrl(variant?.image_url),
    );
  const primaryVariantImages = primaryVariant ? resolveVariantGalleryImages(primaryVariant) : [];
  const shouldKeepBaseProductImage = (url) => {
    if (!url || isLikelyUiChromeImageUrl(url)) return false;
    const assetSku = extractAssetSkuFromUrl(url);
    if (!assetSku || !primaryVariantSku) return true;
    return assetSku === primaryVariantSku;
  };

  const pushImageItem = (rawUrl, extra = {}) => {
    const url = normalizePdpImageUrl(rawUrl);
    const key = buildPdpImageDedupeKey(url);
    if (!url || !key || seenMediaKeys.has(key)) return;
    seenMediaKeys.add(key);
    items.push({
      type: 'image',
      url,
      ...extra,
    });
  };

  primaryVariantImages.forEach((variantImage) => {
    const url = normalizePdpImageUrl(
      typeof variantImage === 'string'
        ? variantImage
        : variantImage?.url || variantImage?.src || variantImage?.image_url,
    );
    if (!url) return;
    pushImageItem(url, {
      alt_text: product.title,
    });
  });

  media.forEach((m) => {
    const url = normalizePdpImageUrl(m.url || m.image_url || m.src);
    const mediaType = m.type || m.media_type || 'image';
    if (!url) return;
    if (String(mediaType).trim().toLowerCase() === 'video') {
      items.push({
        type: mediaType,
        url,
        thumbnail_url: normalizePdpImageUrl(m.thumbnail_url || m.thumbnail) || undefined,
        alt_text: m.alt_text || product.title,
        source: m.source,
        duration_ms: m.duration_ms,
      });
      return;
    }
    if (!shouldKeepBaseProductImage(url)) return;
    pushImageItem(url, {
      alt_text: m.alt_text || product.title,
      source: m.source,
      thumbnail_url: normalizePdpImageUrl(m.thumbnail_url || m.thumbnail) || undefined,
    });
  });

  images.forEach((img) => {
    const url = normalizePdpImageUrl(typeof img === 'string' ? img : img.url || img.image_url);
    if (!url || !shouldKeepBaseProductImage(url)) return;
    pushImageItem(url, {
      alt_text: typeof img === 'object' ? img.alt_text : product.title,
      source: typeof img === 'object' ? img.source : undefined,
      thumbnail_url:
        typeof img === 'object'
          ? normalizePdpImageUrl(img.thumbnail_url) || undefined
          : undefined,
    });
  });

  (Array.isArray(variants) ? variants.slice(1) : []).forEach((variant) => {
    const previewImage = resolveVariantGalleryImages(variant)[0];
    if (!previewImage) return;
    pushImageItem(previewImage, {
      alt_text: [product.title, variant?.title].filter(Boolean).join(' - ') || product.title,
      source: 'variant_preview',
    });
  });

  const fallbackProductImage = normalizePdpImageUrl(product.image_url);
  if (!items.length && fallbackProductImage) {
    pushImageItem(fallbackProductImage, {
      alt_text: product.title,
    });
  }

  return items;
}

function normalizeTextValue(value) {
  return decodeHtmlEntities(stripHtml(value || ''));
}

function normalizeComparisonKey(value) {
  return normalizeTextValue(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function extractImageFilename(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    return decodeURIComponent(String(parsed.pathname.split('/').pop() || '').trim());
  } catch {
    return '';
  }
}

function isLikelyUiChromeImageUrl(value) {
  const filename = extractImageFilename(value);
  if (!filename) return false;
  const normalizedFilenameKey = filename.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  return (
    UI_CHROME_IMAGE_FILENAME_RE.test(filename) ||
    /\b(?:plpbanner|banner|masthead)\b/i.test(normalizedFilenameKey)
  );
}

function extractAssetSkuFromUrl(value) {
  const filename = extractImageFilename(value);
  if (!filename) return '';
  const matched = filename.match(/(?:^|[_-])tfb?_sku_([A-Za-z0-9]+)_/i);
  return matched?.[1] ? String(matched[1]).trim().toLowerCase() : '';
}

function isHashedShopifyAssetFilename(filename) {
  return SHOPIFY_FILE_HASH_SUFFIX_RE.test(String(filename || '').trim());
}

function isLowConfidenceTomFordVariantImage(url) {
  const filename = extractImageFilename(url);
  if (!/^tfb?_sku_/i.test(filename)) return false;
  if (isHashedShopifyAssetFilename(filename)) return false;
  const matched = filename.match(/_(\d+)\.(?:avif|gif|jpe?g|png|webp)$/i);
  if (!matched?.[1]) return false;
  const slot = Number(matched[1]);
  if (!Number.isFinite(slot)) return false;
  return slot === 0 || slot >= 3;
}

function filterLowConfidenceTomFordVariantImages(values) {
  const normalized = Array.isArray(values) ? values.filter(Boolean) : [];
  const hasPreferredTomFordAsset = normalized.some((value) => {
    const filename = extractImageFilename(value);
    if (!/^tfb?_sku_/i.test(filename)) return false;
    if (isHashedShopifyAssetFilename(filename)) return true;
    return /_1\.(?:jpe?g|png|webp)$/i.test(filename);
  });

  if (!hasPreferredTomFordAsset) return normalized;
  return normalized.filter((value) => !isLowConfidenceTomFordVariantImage(value));
}

function filterVariantImagesBySku(values, sku) {
  const normalized = normalizePdpImageUrls(values).filter((value) => !isLikelyUiChromeImageUrl(value));
  const normalizedSku = String(sku || '').trim().toLowerCase();
  if (!normalizedSku || !normalized.length) return filterLowConfidenceTomFordVariantImages(normalized);
  const exactMatches = normalized.filter((value) => extractAssetSkuFromUrl(value) === normalizedSku);
  return filterLowConfidenceTomFordVariantImages(exactMatches.length ? exactMatches : normalized);
}

function normalizeIngredientComparisonKey(value) {
  const normalized = normalizeComparisonKey(value);
  const aliases = {
    glycerine: 'glycerin',
    'hyaluronic acid': 'hyaluronic acid',
    'sodium hyaluronate': 'hyaluronic acid',
  };
  return aliases[normalized] || normalized;
}

function consumeKnownDetailLabelsFromEdge(value, direction = 'start') {
  let remaining = normalizeTextValue(value);
  let consumed = 0;
  const phrases = DETAIL_LABEL_PHRASES.slice().sort((left, right) => right.length - left.length);

  while (remaining) {
    let matched = false;
    for (const phrase of phrases) {
      const escaped = escapeRegExp(phrase);
      const pattern =
        direction === 'end'
          ? new RegExp(`\\s*${escaped}$`, 'i')
          : new RegExp(`^${escaped}(?:\\b|\\s)+`, 'i');
      if (!pattern.test(remaining)) continue;
      remaining = remaining.replace(pattern, '').trim();
      consumed += 1;
      matched = true;
      break;
    }
    if (!matched) break;
  }

  return { remaining, consumed };
}

function sanitizeNarrativeText(value) {
  const original = normalizeTextValue(value);
  if (!original) return '';
  const prefix = consumeKnownDetailLabelsFromEdge(original, 'start');
  const prefixStripped = prefix.consumed >= 2 ? prefix.remaining : original;
  const suffix = consumeKnownDetailLabelsFromEdge(prefixStripped, 'end');
  let cleaned = suffix.consumed >= 2 ? suffix.remaining : prefixStripped;
  cleaned = cleaned
    .replace(/^(?:details\b[\s:.-]*){1,}/i, '')
    .replace(/^(?:description|about the product|what it is)\b[\s:.-]*/i, '')
    .trim();
  const syntheticSummaryMatch = cleaned.match(EXTERNAL_SEED_SYNTHETIC_SUMMARY_RE);
  if (syntheticSummaryMatch?.[1]) {
    cleaned = normalizeTextValue(syntheticSummaryMatch[1]);
  } else {
    cleaned = cleaned
      .replace(/^\s*OFFICIAL:\s*/i, '')
      .replace(/\s*\/\/\/\s*SOCIAL HIGHLIGHTS:\s*[\s\S]*$/i, '')
      .trim();
  }
  cleaned = stripExternalSeedMarketingBannerPrefix(cleaned);
  const narrativeCutPatterns = [
    /\bthe lowdown\b/i,
    /\bthe #s don't lie\b/i,
    /\bfill weight\s*:/i,
    /\blearn more\s+close\b/i,
    /\bhow to use\b/i,
    /(?:^|\s)INGREDIENTS\b/,
    /(?:^|\s)Ingredients\s*:/,
    /\bnet wt\.?\b/i,
    /\bproduct dimensions?\b/i,
    /\bpackage dimensions?\b/i,
    /\bavoid contact with eyes\b/i,
    /\bkeep out of reach of children\b/i,
    /\bcustomerservice@/i,
    /\bclear\s+\d+\s+rue\b/i,
    /\bclose\b(?=\s+bha\b)/i,
    /\bdetails\b(?=\s+[A-Z])/i,
  ];
  for (const pattern of narrativeCutPatterns) {
    const matched = cleaned.match(pattern);
    const cutIndex = matched?.index ?? -1;
    if (cutIndex >= 40) {
      cleaned = cleaned.slice(0, cutIndex).trim();
      break;
    }
  }
  if (!cleaned && (prefix.consumed >= 2 || suffix.consumed >= 2)) return '';
  return cleaned || original;
}

function isKnownDetailLabelRun(value) {
  const normalized = normalizeTextValue(value);
  if (!normalized) return false;
  const consumed = consumeKnownDetailLabelsFromEdge(normalized, 'start');
  return consumed.consumed > 0 && !normalizeTextValue(consumed.remaining);
}

function normalizeRichTextPreserveBreaks(value) {
  return String(value || '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*li\b[^>]*>/gi, '\n- ')
    .replace(/<\/?\s*(?:p|div|section|article|header|footer|blockquote|h[1-6]|ul|ol|li)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function insertStructuredSentenceBreaks(value) {
  let text = normalizeRichTextPreserveBreaks(value);
  if (!text) return '';

  for (const label of INLINE_SENTENCE_BREAK_LABELS) {
    const escaped = escapeRegExp(label);
    text = text.replace(
      new RegExp(`([.!?])\\s+(${escaped})(?=\\s+[A-Z0-9])`, 'gi'),
      '$1\n\n$2',
    );
  }

  return text.replace(/\n{3,}/g, '\n\n').trim();
}

function splitLeadingStructuredLabelBlock(value) {
  const normalized = normalizeTextValue(value);
  if (!normalized) return [];
  const phrases = DETAIL_LABEL_PHRASES.slice().sort((left, right) => right.length - left.length);
  for (const phrase of phrases) {
    const escaped = escapeRegExp(phrase);
    const matched = normalized.match(new RegExp(`^(${escaped})([:\\s-]+)(.+)$`, 'i'));
    if (!matched?.[1] || !matched?.[2] || !matched?.[3]) continue;
    const separator = String(matched[2] || '');
    const body = normalizeTextValue(matched[3]);
    if (!body) continue;
    const isLooseWhitespaceSeparator = !/[:\-]/.test(separator);
    if (isLooseWhitespaceSeparator && /^[a-z]/.test(body)) continue;
    return [normalizeTextValue(matched[1]), body].filter(Boolean);
  }
  return [normalized];
}

function splitStructuredBlocks(value) {
  return insertStructuredSentenceBreaks(value)
    .split(/\n{2,}/)
    .flatMap((item) => splitLeadingStructuredLabelBlock(item))
    .map((item) => item.trim())
    .filter(Boolean);
}

function isStructuredHeadingBlock(value) {
  const text = normalizeTextValue(value);
  if (!text || text.length > 48) return false;
  if (/[.?!:]/.test(text)) return false;
  return /^[A-Za-z0-9 '&/()+-]+$/.test(text);
}

function resolveOverviewFactLabel(value) {
  const key = normalizeComparisonKey(value);
  return OVERVIEW_FACT_LABELS.find((label) => normalizeComparisonKey(label) === key) || null;
}

function resolveOverviewHighlightLabel(value) {
  const key = normalizeComparisonKey(value);
  return OVERVIEW_HIGHLIGHT_LABELS.find((label) => normalizeComparisonKey(label) === key) || null;
}

function uniqueOverviewFacts(items) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const label = normalizeTextValue(item?.label);
    const value = normalizeTextValue(item?.value);
    if (!label || !value) continue;
    const key = `${normalizeComparisonKey(label)}|${normalizeComparisonKey(value)}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ label, value });
  }
  return out;
}

function uniqueNarrativeBlocks(items, maxItems = 8) {
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    const normalized = normalizeTextValue(item);
    if (!normalized) continue;
    const key = normalizeComparisonKey(normalized);
    if (!key) continue;

    let shouldSkip = false;
    for (let index = 0; index < out.length; index += 1) {
      const existing = out[index];
      const existingKey = normalizeComparisonKey(existing);
      if (!existingKey) continue;
      if (key === existingKey) {
        shouldSkip = true;
        break;
      }
      if (key.includes(existingKey)) {
        shouldSkip = true;
        break;
      }
      if (existingKey.includes(key)) {
        out[index] = normalized;
        shouldSkip = true;
        break;
      }
    }

    if (shouldSkip) continue;
    out.push(normalized);
    if (out.length >= Math.max(1, Number(maxItems) || 8)) break;
  }
  return out;
}

function splitOverviewHighlightItems(value, headingLabel = '') {
  const normalizedHeading = normalizeComparisonKey(headingLabel);
  let normalized = normalizeRichTextPreserveBreaks(value);
  if (!normalized) return [];

  for (const label of OVERVIEW_HIGHLIGHT_LABELS) {
    const labelKey = normalizeComparisonKey(label);
    if (!labelKey || labelKey === normalizedHeading) continue;
    const escaped = escapeRegExp(label);
    normalized = normalized.replace(
      new RegExp(`\\s+(${escaped})(?=\\s+[A-Z0-9])`, 'gi'),
      '\n$1 ',
    );
  }

  const rawParts = normalized
    .replace(/\n[•●▪*]\s+/g, '\n- ')
    .replace(/(?:^|\s)[•●▪*]\s+/g, '\n- ')
    .split(/\n-\s*|\n+|(?:^|\s)-\s+/)
    .map((item) => cleanStructuredToken(item))
    .filter(Boolean);

  const out = [];
  const seen = new Set();
  for (const part of rawParts.length ? rawParts : [normalized]) {
    const cleaned = cleanStructuredToken(part);
    if (!cleaned) continue;
    if (isKnownDetailLabelRun(cleaned)) continue;
    let formatted =
      /^free from\b/i.test(cleaned)
        ? cleaned.replace(/^free from\b/i, 'Free from')
        : cleaned;
    formatted =
      normalizedHeading === normalizeComparisonKey('Free From') &&
      !/^free from\b/i.test(cleaned)
        ? `Free from ${cleaned}`
        : formatted;
    const key = normalizeComparisonKey(formatted);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(formatted);
  }
  return out;
}

function collectRawGenericDetailBodies(product) {
  const sources = [
    Array.isArray(product.pdp_details_sections) ? product.pdp_details_sections : [],
    Array.isArray(product.details_sections) ? product.details_sections : [],
    Array.isArray(product.detail_sections) ? product.detail_sections : [],
    Array.isArray(product.details) ? product.details : [],
  ];
  const out = [];
  const seen = new Set();

  sources.forEach((sections) => {
    sections.forEach((section) => {
      const heading = normalizeTextValue(section?.heading || section?.title || section?.name);
      const body = String(section?.body || section?.content || section?.value || section?.text || '');
      if (!heading || !body) return;
      if (!GENERIC_DETAIL_SECTION_HEADING_RE.test(heading)) return;
      const key = normalizeComparisonKey(body);
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(body);
    });
  });

  return out;
}

function buildBeautyOverviewModel(product) {
  if (detectTemplateHint(product) !== 'beauty') return null;

  const candidates = [
    product.pdp_description_raw,
    product.description,
    ...collectRawGenericDetailBodies(product),
  ];
  const blocks = [];
  const seenBlocks = new Set();

  candidates.forEach((candidate) => {
    splitStructuredBlocks(candidate).forEach((block) => {
      const key = normalizeComparisonKey(block);
      if (!key || seenBlocks.has(key)) return;
      seenBlocks.add(key);
      blocks.push(block);
    });
  });

  if (!blocks.length) return null;

  const facts = [];
  const highlightItems = [];
  const narrativeBlocks = [];
  let currentHeading = '';

  for (const block of blocks) {
    if (looksLikeExternalSeedFactNoise(block)) {
      currentHeading = '';
      continue;
    }
    const factHeading = resolveOverviewFactLabel(block);
    const highlightHeading = resolveOverviewHighlightLabel(block);
    if (factHeading || highlightHeading || isStructuredHeadingBlock(block)) {
      currentHeading = factHeading || highlightHeading || block;
      continue;
    }

    const activeFactHeading = resolveOverviewFactLabel(currentHeading);
    if (activeFactHeading) {
      const value = normalizeTextValue(block);
      if (value && value.length <= 180 && !looksLikeExternalSeedFactNoise(value)) {
        facts.push({ label: activeFactHeading, value });
        currentHeading = '';
        continue;
      }
    }

    const activeHighlightHeading = resolveOverviewHighlightLabel(currentHeading);
    if (activeHighlightHeading) {
      const items = splitOverviewHighlightItems(block, activeHighlightHeading);
      if (items.length) {
        highlightItems.push(
          ...items.filter(
            (item) =>
              !looksLikeExternalSeedFactNoise(item) &&
              !looksLikeExternalSeedOverviewTagSoup(item),
          ),
        );
        continue;
      }
    }

    if (
      normalizeComparisonKey(currentHeading) === normalizeComparisonKey('Details') &&
      looksLikeExternalSeedOverviewTagSoup(block)
    ) {
      currentHeading = '';
      continue;
    }

    if (
      (/^[\s\-•*]/.test(block) || /\n[\s\-•*]/.test(block)) &&
      !looksLikeExternalSeedOverviewTagSoup(block)
    ) {
      highlightItems.push(...splitOverviewHighlightItems(block, currentHeading));
      continue;
    }

    const sanitized = sanitizeNarrativeText(block);
    if (
      sanitized &&
      !looksLikeExternalSeedFactNoise(sanitized) &&
      !looksLikeExternalSeedOverviewTagSoup(sanitized)
    ) {
      narrativeBlocks.push(sanitized);
    }
    currentHeading = '';
  }

  const uniqueFacts = uniqueOverviewFacts(facts);
  const uniqueHighlights = normalizeStringList(highlightItems, 8);
  const description = uniqueNarrativeBlocks(narrativeBlocks, 3)
    .filter((item) => item.length >= 24)
    .slice(0, 2)
    .join(' ');
  const fallbackDescription = sanitizeNarrativeText(product.pdp_description_raw || product.description);
  const overviewLines = [];

  uniqueFacts.forEach((item) => {
    overviewLines.push(`${item.label}: ${item.value}`);
  });

  if (uniqueHighlights.length) {
    if (overviewLines.length) overviewLines.push('');
    overviewLines.push('Benefits');
    uniqueHighlights.forEach((item) => {
      overviewLines.push(`- ${item}`);
    });
  }

  return {
    description: description || fallbackDescription,
    overviewSection: overviewLines.length
      ? {
          heading: 'Overview',
          content_type: 'text',
          content: overviewLines.join('\n'),
          collapsed_by_default: false,
        }
      : null,
  };
}

function sanitizeIngredientRawText(value) {
  let text = normalizeTextValue(value);
  if (!text) return '';
  text = text
    .replace(/\bwe got you covered\b[\s\S]*?(?=AQUA\/WATER\/EAU\b|ingredients?:)/i, '')
    .replace(/\bconsult(?:ing)? your physician\b[\s\S]*?(?=AQUA\/WATER\/EAU\b|ingredients?:)/i, '')
    .replace(/\bhit up your physician before you glow\b[\s\S]*?(?=AQUA\/WATER\/EAU\b|ingredients?:)/i, '')
    .trim();
  const matches = Array.from(text.matchAll(/\bingredients(?:\s*\(inci\))?\s*:/gi));
  if (matches.length) {
    const lastMatch = matches[matches.length - 1];
    text = text.slice((lastMatch.index || 0) + lastMatch[0].length).trim();
  }
  for (const pattern of INGREDIENT_DISCLAIMER_PATTERNS) {
    text = text.replace(pattern, '').trim();
  }
  text = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return text;
}

function looksLikeStructuredIngredientList(value) {
  const text = sanitizeIngredientRawText(value);
  if (!text) return false;
  if (/\b(aqua\/water\/eau|ingredients(?:\s*\(inci\))?\s*:|ci\s*\d{3,5})\b/i.test(text)) return true;
  const parts = text
    .split(/,(?![^()]*\))/)
    .map((item) => normalizeTextValue(item))
    .filter(Boolean);
  if (parts.length < 4) return false;
  const verboseItemCount = parts.filter((item) => item.split(/\s+/).length >= 4).length;
  const likelyNarrative =
    hasNarrativeIngredientSignals(text) ||
    /[.!?]/.test(text) ||
    verboseItemCount >= Math.max(2, Math.ceil(parts.length * 0.35));
  if (likelyNarrative) return false;
  return true;
}

function hasNarrativeIngredientSignals(value) {
  const text = normalizeTextValue(value);
  if (!text) return false;
  return /\b(vitamin|antioxidant|locks in hydration|hydrates?|hydration|fights shine|reduces the look|helps hydrate|soothe|condition|nutrient-rich|superfruit|detoxif|commonly used|reduces oil|refines pores)\b/i.test(
    text,
  );
}

function cleanIngredientItem(value) {
  return normalizeTextValue(value)
    .replace(/^full ingredients[:\s-]*/i, '')
    .replace(/^key ingredients[:\s-]*/i, '')
    .replace(/^ingredients(?:\s*\(inci\))?[:\s-]*/i, '')
    .replace(/^\[\+\/-\s*/i, '')
    .replace(/\]+$/g, '')
    .replace(/<[^>]+>/g, ' ')
    .trim();
}

function isLikelyIngredientNoise(value) {
  const normalized = cleanIngredientItem(value);
  if (!normalized) return false;
  if (INGREDIENT_ITEM_NOISE_PATTERNS.some((pattern) => pattern.test(normalized))) return true;
  if (/^-\s*/.test(normalized) && /:/.test(normalized)) return true;
  return false;
}

function normalizeIngredientItems(values, maxItems = 48) {
  const out = [];
  const seen = new Set();
  const normalizedValues =
    typeof values === 'string'
      ? values.split(/[,\n;|•]+/)
      : Array.isArray(values)
        ? values
        : [];
  for (const value of normalizedValues) {
    const normalized =
      typeof value === 'string'
        ? cleanIngredientItem(value)
        : cleanIngredientItem(
            value?.name ||
              value?.label ||
              value?.title ||
              value?.ingredient ||
              value?.value ||
              value?.text,
          );
    if (!normalized || isLikelyIngredientNoise(normalized)) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= Math.max(1, Number(maxItems) || 48)) break;
  }
  return collapseCiVariantIngredientItems(out);
}

function collapseCiVariantIngredientItems(items) {
  const out = [];
  const groupedByBase = new Map();

  for (const item of Array.isArray(items) ? items : []) {
    const normalized = cleanIngredientItem(item);
    const matched = normalized.match(/^(.+?)\s*\(\s*ci\s*([^)]+)\s*\)$/i);
    if (!matched) {
      out.push(normalized);
      continue;
    }

    const baseLabel = normalizeTextValue(matched[1]);
    const baseKey = normalizeComparisonKey(baseLabel);
    const codes = Array.from(String(matched[2] || '').matchAll(/\d{3,5}/g)).map((match) => match[0]);
    if (!baseLabel || !baseKey || !codes.length) {
      out.push(normalized);
      continue;
    }

    const existing = groupedByBase.get(baseKey);
    if (existing) {
      codes.forEach((code) => existing.codes.add(code));
      continue;
    }

    const entry = {
      baseLabel,
      codes: new Set(codes),
    };
    groupedByBase.set(baseKey, entry);
    out.push(entry);
  }

  return out.map((item) => {
    if (typeof item === 'string') return item;
    return `${item.baseLabel} (CI ${Array.from(item.codes).join(' / ')})`;
  });
}

function normalizeStringList(values, maxItems = 48) {
  const out = [];
  const seen = new Set();
  const normalizedValues =
    typeof values === 'string'
      ? values.split(/[,\n;|•]+/)
      : Array.isArray(values)
        ? values
        : [];
  for (const value of normalizedValues) {
    const normalized =
      typeof value === 'string'
        ? normalizeTextValue(value)
        : normalizeTextValue(
            value?.name ||
              value?.label ||
              value?.title ||
              value?.ingredient ||
              value?.value ||
              value?.text,
          );
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= Math.max(1, Number(maxItems) || 48)) break;
  }
  return out;
}

function splitDelimitedText(input, maxItems = 64) {
  const text = normalizeTextValue(input);
  if (!text) return [];
  return normalizeStringList(text.split(/[,\n;|•]+/), maxItems);
}

function cleanStructuredToken(value) {
  return normalizeTextValue(value)
    .replace(/^[\s\-•*]+/, '')
    .replace(/^(?:step\s*)?\d+[\).:\-]\s*/i, '')
    .replace(/\s*[-•]\s*$/, '')
    .trim();
}

function normalizeStructuredTokens(values, maxItems = 64) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = cleanStructuredToken(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= Math.max(1, Number(maxItems) || 64)) break;
  }
  return out;
}

function splitIngredientsText(input, maxItems = 64) {
  const text = sanitizeIngredientRawText(input)
    .replace(/^full ingredients[:\s-]*/i, '')
    .replace(/^ingredients(?:\s*\(inci\))?[:\s-]*/i, '')
    .trim();
  if (!text) return [];
  return normalizeIngredientItems(text.split(/\n+|;|,(?![^()]*\))/), maxItems).filter(
    (item) => item.length > 1,
  );
}

function splitHowToUseSteps(input, maxItems = 8) {
  const text = normalizeTextValue(input);
  if (!text) return [];
  const normalized = text
    .replace(/\r/g, '\n')
    .replace(/(?:^|\s)[•●▪*-]\s+/g, '\n')
    .replace(/(?:^|\s)(?:step\s*)?\d+[\).:\-]\s*/gi, '\n')
    .replace(/\s+-\s+/g, '\n');
  const lines = normalizeStructuredTokens(normalized.split(/\n+/), maxItems).filter(
    (item) => item !== '-' && item !== '•',
  );
  if (lines.length > 1) return lines;
  return normalizeStructuredTokens(
    text
      .split(/(?:\.\s+)(?=[A-Z])|(?:;\s+)/)
      .map((part) => part.trim())
      .filter(Boolean),
    maxItems,
  );
}

function matchesSectionHeading(section, pattern) {
  return Boolean(pattern && pattern.test(String(section?.heading || '')));
}

function readDetailSections(product) {
  const sections = [];
  const seen = new Set();
  const sources = [
    Array.isArray(product.pdp_details_sections) ? product.pdp_details_sections : [],
    Array.isArray(product.details_sections) ? product.details_sections : [],
    Array.isArray(product.detail_sections) ? product.detail_sections : [],
    Array.isArray(product.details) ? product.details : [],
  ];

  sources.forEach((items) => {
    items.forEach((item) => {
      const heading = normalizeTextValue(item?.heading || item?.title || item?.name);
      const content = normalizeTextValue(
        item?.body || item?.content || item?.value || item?.text,
      );
      if (!heading || !content) return;
      const key = `${heading.toLowerCase()}|${content.toLowerCase()}`;
      if (seen.has(key)) return;
      seen.add(key);
      sections.push({
        heading,
        content_type: 'text',
        content,
        collapsed_by_default: item?.collapsed_by_default ?? true,
      });
    });
  });

  if (product.category || product.product_type) {
    sections.push({
      heading: 'Category',
      content_type: 'text',
      content: String(product.category || product.product_type),
      collapsed_by_default: true,
    });
  }

  return sections;
}

function resolveIngredientSourceMeta(product, prefersPdpField = false) {
  const source = String(
    product?.ingredient_intel?.external_seed_enrichment?.source ||
      product?.ingredient_intel?.source ||
      '',
  )
    .trim()
    .toLowerCase();

  if (source === 'kb_reviewed') {
    return { source_origin: 'reviewed_kb', source_quality_status: 'reviewed' };
  }
  if (source === 'pdp_ingredient_fields' || prefersPdpField) {
    return { source_origin: 'retail_pdp', source_quality_status: 'captured' };
  }
  if (source === 'description_parse') {
    return { source_origin: 'retail_pdp', source_quality_status: 'parsed' };
  }
  if (source === 'title_url_anchor') {
    return { source_origin: 'structured_seed', source_quality_status: 'derived' };
  }
  return { source_origin: 'unknown', source_quality_status: 'unknown' };
}

function extractStructuredSourceMeta(payload) {
  const sourceOrigin = normalizeTextValue(payload?.source_origin || payload?.sourceOrigin);
  const sourceQualityStatus = normalizeTextValue(
    payload?.source_quality_status || payload?.sourceQualityStatus,
  );
  return {
    ...(sourceOrigin ? { source_origin: sourceOrigin } : {}),
    ...(sourceQualityStatus ? { source_quality_status: sourceQualityStatus } : {}),
  };
}

function isRegulatoryActiveIngredientSource(sourceMeta, rawText) {
  const combined = [sourceMeta?.source_origin, sourceMeta?.source_quality_status, rawText]
    .map((value) => String(value || '').toLowerCase())
    .join(' ');
  return (
    combined.includes('regulatory') ||
    combined.includes('otc') ||
    combined.includes('drug facts') ||
    combined.includes('active ingredient')
  );
}

function shouldSuppressLowConfidenceActiveIngredients(product, items, ingredientsModule, sourceMeta, rawText) {
  if (!isExternalSeedProduct(product)) return false;
  if (detectTemplateHint(product) !== 'beauty') return false;
  if (isRegulatoryActiveIngredientSource(sourceMeta, rawText)) return false;
  const qualityStatus = String(sourceMeta?.source_quality_status || '').trim().toLowerCase();
  if (qualityStatus === 'reviewed' || qualityStatus === 'high') {
    return false;
  }
  const activeCount = Array.isArray(items) ? items.length : 0;
  const ingredientsItems = Array.isArray(ingredientsModule?.items) ? ingredientsModule.items : [];
  const ingredientsCount = ingredientsItems.length;
  const ingredientKeys = new Set(
    ingredientsItems.map((item) => normalizeIngredientComparisonKey(item)).filter(Boolean),
  );
  const activeKeys = Array.isArray(items)
    ? items.map((item) => normalizeIngredientComparisonKey(item)).filter(Boolean)
    : [];
  const subsetOfIngredients =
    activeKeys.length > 0 && activeKeys.every((item) => ingredientKeys.has(item));
  const activeRawKey = normalizeComparisonKey(rawText);
  const ingredientRawKey = normalizeComparisonKey(ingredientsModule?.raw_text);
  if (activeCount <= 1 && ingredientsCount >= 4) return true;
  if (subsetOfIngredients && activeCount <= 3 && ingredientsCount >= 8) return true;
  if (
    qualityStatus !== 'reviewed' &&
    qualityStatus !== 'high' &&
    subsetOfIngredients &&
    activeRawKey &&
    ingredientRawKey &&
    activeRawKey === ingredientRawKey
  ) {
    return true;
  }
  if (
    qualityStatus !== 'reviewed' &&
    qualityStatus !== 'high' &&
    hasNarrativeIngredientSignals(rawText) &&
    (subsetOfIngredients || activeCount <= 4)
  ) {
    return true;
  }
  if (qualityStatus === 'captured') return false;
  return (
    !normalizeTextValue(rawText) &&
    activeCount <= 3 &&
    ingredientsCount >= 8 &&
    subsetOfIngredients
  );
}

function shouldSuppressLowConfidenceIngredients(product, items, sourceMeta, rawText) {
  if (!isExternalSeedProduct(product)) return false;
  if (detectTemplateHint(product) !== 'beauty') return false;
  const qualityStatus = String(sourceMeta?.source_quality_status || '').trim().toLowerCase();
  if (qualityStatus === 'reviewed' || qualityStatus === 'high') return false;
  if (looksLikeStructuredIngredientList(rawText)) return false;
  const normalizedItems = Array.isArray(items) ? items : [];
  if (!normalizedItems.length) return false;
  const verboseItemCount = normalizedItems.filter((item) => String(item || '').trim().split(/\s+/).length >= 4).length;
  const likelyNarrative =
    hasNarrativeIngredientSignals(rawText) ||
    verboseItemCount >= Math.max(2, Math.ceil(normalizedItems.length * 0.35));
  return likelyNarrative;
}

function buildIngredientsModule(product, detailSections) {
  const suppressionFlags = ensureJsonObject(
    product?.external_seed_suppression_flags ||
      product?.suppression_flags ||
      product?.external_seed_recall?.suppression_flags,
  );
  if (suppressionFlags.suppress_ingredients === true) return null;
  const directIngredientsPayload =
    product.ingredients_inci ||
    product.ingredientsInci ||
    product.inci_ingredients ||
    product.inciIngredients ||
    null;
  const rawText =
    sanitizeIngredientRawText(directIngredientsPayload?.raw_text || directIngredientsPayload?.text) ||
    sanitizeIngredientRawText(product.raw_ingredient_text_clean) ||
    sanitizeIngredientRawText(product.pdp_ingredients_raw) ||
    sanitizeIngredientRawText(
      detailSections.find((section) => matchesSectionHeading(section, INGREDIENT_SECTION_HEADING_RE))
        ?.content,
    );
  const directItems = normalizeIngredientItems(
    directIngredientsPayload?.items || directIngredientsPayload?.list || directIngredientsPayload,
  );
  const inciItems = normalizeIngredientItems(product.inci_list);
  const tokenItems = normalizeIngredientItems(product.ingredient_tokens);
  const parsedRawItems = splitIngredientsText(rawText);
  const preferParsedRawItems =
    parsedRawItems.length >= 8 && directItems.some((item) => isLikelyIngredientNoise(item));
  const normalizedItems = preferParsedRawItems
    ? parsedRawItems
    : directItems.length
    ? normalizeIngredientItems([...directItems, ...parsedRawItems])
    : inciItems.length
    ? inciItems
    : tokenItems.length
      ? tokenItems
      : parsedRawItems;
  if (!rawText && !normalizedItems.length) return null;
  const sourceMeta = extractStructuredSourceMeta(directIngredientsPayload);
  const resolvedSourceMeta = Object.keys(sourceMeta).length
    ? sourceMeta
    : resolveIngredientSourceMeta(product, Boolean(product.pdp_ingredients_raw));
  if (shouldSuppressLowConfidenceIngredients(product, normalizedItems, resolvedSourceMeta, rawText)) {
    return null;
  }
  return {
    title: 'Ingredients',
    raw_text: rawText || undefined,
    items: normalizedItems,
    ...resolvedSourceMeta,
  };
}

function buildActiveIngredientsModule(product, detailSections, ingredientsModule) {
  const suppressionFlags = ensureJsonObject(
    product?.external_seed_suppression_flags ||
      product?.suppression_flags ||
      product?.external_seed_recall?.suppression_flags,
  );
  if (suppressionFlags.suppress_active_ingredients === true) return null;
  const directActivePayload =
    product.active_ingredients ||
    product.activeIngredients ||
    product.key_ingredients ||
    product.keyIngredients ||
    null;
  const rawText =
    normalizeTextValue(directActivePayload?.raw_text || directActivePayload?.text) ||
    normalizeTextValue(product.pdp_active_ingredients_raw) ||
    normalizeTextValue(
      detailSections.find((section) => matchesSectionHeading(section, ACTIVE_INGREDIENT_SECTION_HEADING_RE))
        ?.content,
    );
  const items = normalizeStringList(
    directActivePayload?.items || directActivePayload?.list || product.active_ingredients,
  );
  const keyItems = normalizeStringList(product.key_ingredients || product.keyIngredients);
  const normalizedItems = items.length
    ? items
    : keyItems.length
      ? keyItems
      : splitIngredientsText(rawText, 16);
  if (!rawText && !normalizedItems.length) return null;
  const sourceMeta = Object.keys(extractStructuredSourceMeta(directActivePayload)).length
    ? extractStructuredSourceMeta(directActivePayload)
    : resolveIngredientSourceMeta(
        product,
        Boolean(product.pdp_active_ingredients_raw),
      );
  if (
    shouldSuppressLowConfidenceActiveIngredients(
      product,
      normalizedItems,
      ingredientsModule,
      sourceMeta,
      rawText,
    )
  ) {
    return null;
  }
  return {
    title: 'Active ingredients',
    items: normalizedItems,
    ...(rawText ? { raw_text: rawText } : {}),
    ...sourceMeta,
  };
}

function buildHowToUseModule(product, detailSections) {
  const directHowToUsePayload =
    product.how_to_use ||
    product.howToUse ||
    product.directions ||
    product.instructions ||
    product.usage ||
    null;
  const rawText =
    normalizeTextValue(
      directHowToUsePayload?.raw_text ||
      directHowToUsePayload?.text ||
      directHowToUsePayload?.body,
    ) ||
    normalizeTextValue(product.pdp_how_to_use_raw) ||
    normalizeTextValue(
      detailSections.find((section) => matchesSectionHeading(section, HOW_TO_USE_SECTION_HEADING_RE))
        ?.content,
    );
  const directSteps = normalizeStringList(
    directHowToUsePayload?.steps ||
    directHowToUsePayload?.items ||
    directHowToUsePayload?.list,
    8,
  );
  const splitDirectSteps = directSteps.flatMap((step) => splitHowToUseSteps(step, 8));
  const steps = splitDirectSteps.length
    ? normalizeStringList(splitDirectSteps, 8)
    : splitHowToUseSteps(rawText);
  if (!rawText && !steps.length) return null;
  return {
    title: 'How to use',
    raw_text: rawText || undefined,
    steps,
    source_origin: normalizeTextValue(product.pdp_how_to_use_raw) ? 'retail_pdp' : 'unknown',
  };
}

function buildProductFactSections(product, detailSections, primaryDescription = '', beautyOverview = null) {
  const suppressionFlags = ensureJsonObject(
    product?.external_seed_suppression_flags ||
      product?.suppression_flags ||
      product?.external_seed_recall?.suppression_flags,
  );
  if (suppressionFlags.suppress_facts === true) return [];
  const normalizedPrimaryDescription = normalizeComparisonKey(primaryDescription);
  const seen = new Set();
  const narrativeDetailSections = (Array.isArray(detailSections) ? detailSections : []).filter((section) => {
    if (!section?.heading || !section?.content) return false;
    if (CATEGORY_SECTION_HEADING_RE.test(String(section.heading || '').trim())) return false;
    return true;
  });
  const factSections = detailSections
    .filter(
      (section) =>
        !matchesSectionHeading(section, INGREDIENT_SECTION_HEADING_RE) &&
        !matchesSectionHeading(section, ACTIVE_INGREDIENT_SECTION_HEADING_RE) &&
        !matchesSectionHeading(section, HOW_TO_USE_SECTION_HEADING_RE) &&
        !(isExternalSeedProduct(product) && GENERIC_DETAIL_SECTION_HEADING_RE.test(String(section?.heading || '').trim())) &&
        !(beautyOverview?.overviewSection && GENERIC_DETAIL_SECTION_HEADING_RE.test(String(section?.heading || '').trim())),
    )
    .map((section) => ({
      ...section,
      content: sanitizeNarrativeText(section?.content),
    }))
    .filter((section) => {
      if (!section?.heading || !section?.content) return false;
      if (isExternalSeedProduct(product) && looksLikeExternalSeedFactNoise(`${section.heading} ${section.content}`)) {
        return false;
      }
      if (isExternalSeedProduct(product) && EXTERNAL_SEED_LOW_VALUE_FACT_RE.test(`${section.heading} ${section.content}`)) {
        return false;
      }
      if (isExternalSeedProduct(product) && looksLikeExternalSeedOverviewTagSoup(section.content)) {
        return false;
      }
      if (CATEGORY_SECTION_HEADING_RE.test(String(section.heading || '').trim())) return false;
      const contentKey = normalizeComparisonKey(section.content);
      if (!contentKey) return false;
      if (normalizedPrimaryDescription && contentKey === normalizedPrimaryDescription) {
        return false;
      }
      const dedupeKey = `${String(section.heading || '').trim().toLowerCase()}|${contentKey}`;
      if (seen.has(dedupeKey)) return false;
      seen.add(dedupeKey);
      return true;
    });

  if (factSections.length) return factSections;

  if (narrativeDetailSections.length > 0 && normalizedPrimaryDescription) {
    return [];
  }

  if (isExternalSeedProduct(product)) {
    return [];
  }

  const fallbackDescription = sanitizeNarrativeText(
    primaryDescription || product.pdp_description_raw || product.description,
  );
  if (!fallbackDescription || looksLikeExternalSeedFactNoise(fallbackDescription)) return [];
  return [
    {
      heading: 'Description',
      content_type: 'text',
      content: fallbackDescription,
      collapsed_by_default: false,
    },
  ];
}

function isRedundantDescriptionOnlyFacts(sections, primaryDescription = '') {
  if (!Array.isArray(sections) || sections.length !== 1) return false;
  const [section] = sections;
  if (String(section?.heading || '').trim().toLowerCase() !== 'description') return false;
  const sectionKey = normalizeComparisonKey(section?.content);
  const descriptionKey = normalizeComparisonKey(primaryDescription);
  return Boolean(sectionKey && descriptionKey && sectionKey === descriptionKey);
}

function shouldDropNarrativeIngredientModules(product, activeIngredientsModule, ingredientsModule) {
  if (!isExternalSeedProduct(product)) return false;
  if (detectTemplateHint(product) !== 'beauty') return false;
  if (!activeIngredientsModule || !ingredientsModule) return false;
  if (
    isRegulatoryActiveIngredientSource(
      activeIngredientsModule,
      activeIngredientsModule?.raw_text || ingredientsModule?.raw_text,
    )
  ) {
    return false;
  }

  const activeItems = normalizeStringList(activeIngredientsModule?.items || []);
  const ingredientItems = normalizeIngredientItems(ingredientsModule?.items || []);
  const activeRawText = normalizeTextValue(activeIngredientsModule?.raw_text);
  const ingredientRawText = sanitizeIngredientRawText(ingredientsModule?.raw_text);
  const narrativeRawText = activeRawText || ingredientRawText;
  const verboseIngredientItemCount = ingredientItems.filter(
    (item) => String(item || '').trim().split(/\s+/).length >= 4,
  ).length;
  const ingredientKeys = new Set(
    ingredientItems.map((item) => normalizeIngredientComparisonKey(item)).filter(Boolean),
  );
  const activeKeys = activeItems.map((item) => normalizeIngredientComparisonKey(item)).filter(Boolean);
  const activeSubsetOfIngredients =
    activeKeys.length > 0 && activeKeys.every((item) => ingredientKeys.has(item));
  const sameRawText =
    normalizeComparisonKey(activeRawText) &&
    normalizeComparisonKey(activeRawText) === normalizeComparisonKey(ingredientRawText);

  return Boolean(
    !looksLikeStructuredIngredientList(narrativeRawText) &&
      hasNarrativeIngredientSignals(narrativeRawText) &&
      verboseIngredientItemCount >= Math.max(2, Math.ceil(Math.max(ingredientItems.length, 1) * 0.3)) &&
      (sameRawText || activeSubsetOfIngredients || activeItems.length <= 4),
  );
}

function buildProductDetailsSections(product, detailSections, primaryDescription = '', beautyOverview = null) {
  if (
    beautyOverview?.overviewSection &&
    !looksLikeExternalSeedFactNoise(beautyOverview.overviewSection?.content) &&
    !looksLikeExternalSeedOverviewTagSoup(beautyOverview.overviewSection?.content)
  ) {
    return [beautyOverview.overviewSection];
  }

  const genericSections = (Array.isArray(detailSections) ? detailSections : [])
    .filter((section) => matchesSectionHeading(section, GENERIC_DETAIL_SECTION_HEADING_RE))
    .map((section) => ({
      heading: 'Overview',
      content_type: 'text',
      content: sanitizeNarrativeText(section?.content),
      collapsed_by_default: false,
    }))
    .filter(
      (section) =>
        section.content &&
        !looksLikeExternalSeedFactNoise(section.content) &&
        !looksLikeExternalSeedOverviewTagSoup(section.content),
    );
  if (genericSections.length) return genericSections.slice(0, 1);

  if (!isExternalSeedProduct(product)) return [];

  const fallbackDescription = sanitizeNarrativeText(
    primaryDescription || product.pdp_description_raw || product.description,
  );
  if (!fallbackDescription || looksLikeExternalSeedFactNoise(fallbackDescription)) return [];
  return [
    {
      heading: 'Overview',
      content_type: 'text',
      content: fallbackDescription,
      collapsed_by_default: false,
    },
  ];
}

function extractBrandStory(product, factSections) {
  const explicit = normalizeTextValue(product.brand_story);
  if (explicit) return explicit;
  const section = factSections.find((item) => matchesSectionHeading(item, BRAND_STORY_SECTION_HEADING_RE));
  return section?.content || undefined;
}

function buildReviewsPreview(product, options = {}) {
  const summary =
    product.review_summary ||
    product.reviews_summary ||
    product.reviews?.summary ||
    null;

  if (!summary && !options.includeEmpty) {
    return null;
  }

  const scale = Number(summary?.scale || summary?.rating_scale || 5) || 5;
  const rating = Number(summary?.rating || summary?.average_rating || summary?.avg_rating || 0) || 0;
  const reviewCount = Number(summary?.review_count || summary?.count || summary?.total || 0) || 0;
  const previewItems = Array.isArray(summary?.preview_items)
    ? summary.preview_items
    : Array.isArray(summary?.snippets)
      ? summary.snippets
      : [];
  const summaryBrandCard =
    summary?.brand_card && typeof summary.brand_card === 'object' ? summary.brand_card : null;
  const brandCardName =
    String(summaryBrandCard?.name || '').trim() || resolveProductBrandLabel(product);
  const brandCardSubtitle = String(summaryBrandCard?.subtitle || '').trim() || null;

  const distributionRaw =
    summary?.rating_distribution ||
    summary?.star_distribution ||
    summary?.ratingDistribution ||
    summary?.starDistribution ||
    summary?.distribution ||
    null;

  const ratingDistribution = (() => {
    if (!distributionRaw) return undefined;

    const map = new Map();

    if (Array.isArray(distributionRaw)) {
      distributionRaw.forEach((item) => {
        const stars = Number(item?.stars ?? item?.star ?? item?.rating ?? item?.score);
        if (!Number.isFinite(stars) || stars < 1 || stars > 5) return;
        const count = Number(item?.count ?? item?.n ?? item?.value);
        const percent = Number(
          item?.percent ?? item?.ratio ?? item?.pct ?? item?.percentage ?? item?.share,
        );
        map.set(stars, {
          stars,
          ...(Number.isFinite(count) ? { count } : {}),
          ...(Number.isFinite(percent) ? { percent } : {}),
        });
      });
    } else if (typeof distributionRaw === 'object') {
      Object.entries(distributionRaw).forEach(([k, v]) => {
        const stars = Number(k);
        if (!Number.isFinite(stars) || stars < 1 || stars > 5) return;
        const value = Number(v);
        if (!Number.isFinite(value)) return;
        map.set(stars, { stars, value });
      });
    }

    const rows = [];
    for (let stars = 5; stars >= 1; stars -= 1) {
      const item = map.get(stars) || {};
      let count = Number.isFinite(item.count) ? item.count : undefined;
      let percent = Number.isFinite(item.percent) ? item.percent : undefined;

      if (count == null && Number.isFinite(item.value)) {
        const v = item.value;
        if (reviewCount && v > 1 && v <= reviewCount) {
          count = v;
        } else if (v > 1) {
          percent = v / 100;
        } else {
          percent = v;
        }
      }

      if (count != null && reviewCount > 0) {
        percent = count / reviewCount;
      }

      if (percent != null && Number.isFinite(percent)) {
        percent = Math.max(0, Math.min(1, percent));
      } else {
        percent = undefined;
      }

      rows.push({
        stars,
        ...(count != null ? { count } : {}),
        ...(percent != null ? { percent } : {}),
      });
    }

    const hasAny = rows.some((r) => (r.count != null && r.count > 0) || (r.percent != null && r.percent > 0));
    return hasAny ? rows : undefined;
  })();

  return {
    scale,
    rating,
    review_count: reviewCount,
    ...(brandCardName
      ? {
          brand_card: {
            name: brandCardName,
            ...(brandCardSubtitle ? { subtitle: brandCardSubtitle } : {}),
          },
        }
      : {}),
    ...(ratingDistribution
      ? { star_distribution: ratingDistribution, rating_distribution: ratingDistribution }
      : {}),
    preview_items: previewItems.slice(0, 6).map((item, idx) => ({
      review_id: String(item.review_id || item.id || idx),
      rating: Number(item.rating || item.score || scale) || scale,
      author_label: item.author_label || item.author || item.user,
      title: item.title ? String(item.title) : undefined,
      text_snippet: String(item.text_snippet || item.text || item.body || item.title || ''),
      media: Array.isArray(item.media)
        ? item.media.map((m) => ({
            type: m.type || 'image',
            url: normalizePdpImageUrl(m.url || m.image_url) || undefined,
            thumbnail_url: normalizePdpImageUrl(m.thumbnail_url) || undefined,
          })).filter((mediaItem) => mediaItem.url)
        : undefined,
    })),
    entry_points: {
      open_reviews: {
        action_type: 'open_embed',
        label: 'See all reviews',
        target: {
          embed_intent_type: 'reviews_read',
          resolve_params: {
            product_id: product.product_id || product.id,
            merchant_id: product.merchant_id || product.merchant?.id || '',
          },
        },
      },
      write_review: {
        action_type: 'open_embed',
        label: 'Write a review',
        target: {
          embed_intent_type: 'buyer_review_submission',
          resolve_params: {
            product_id: product.product_id || product.id,
            merchant_id: product.merchant_id || product.merchant?.id || '',
          },
        },
      },
    },
  };
}

function buildRecommendations(input, currencyFallback) {
  const items = Array.isArray(input) ? input : Array.isArray(input?.items) ? input.items : [];
  const metadata = input && !Array.isArray(input) && typeof input === 'object' && input.metadata && typeof input.metadata === 'object'
    ? input.metadata
    : null;

  return {
    strategy:
      input && !Array.isArray(input) && typeof input === 'object' && String(input.strategy || '').trim()
        ? String(input.strategy || '').trim()
        : 'related_products',
    ...(metadata ? { metadata } : {}),
    items: items.map((p) => ({
      product_id: p.product_id || p.id,
      merchant_id: p.merchant_id || p.merchant?.id || p.merchant_uuid,
      title: p.title || p.name,
      image_url:
        normalizePdpImageUrl(
          p.image_url || p.image || (Array.isArray(p.images) ? p.images[0] : undefined),
        ) || undefined,
      price: {
        amount: normalizeAmount(p.price),
        currency: normalizeCurrency(p, currencyFallback),
      },
      // Additive fields (safe for older clients to ignore).
      source: p.source || p.recommendation_source || undefined,
      reason: p.reason || p.recommendation_reason || undefined,
      x_score: typeof p.x_score === 'number' ? p.x_score : undefined,
      rating: p.rating || p.review_rating || undefined,
      review_count: p.review_count || p.reviews_count || undefined,
    })),
  };
}

function buildPdpPayload(args) {
  const product = args.product || {};
  const suppressionFlags = ensureJsonObject(
    product?.external_seed_suppression_flags ||
      product?.suppression_flags ||
      product?.external_seed_recall?.suppression_flags,
  );
  const brandLabel = resolveProductBrandLabel(product);
  const currency = product.currency || 'USD';
  const variants = buildVariants(product);
  const defaultVariant = variants[0];
  const mediaItems = buildMediaItems(product, variants);
  const detailSections = readDetailSections(product);
  const beautyOverview = buildBeautyOverviewModel(product);
  const primaryDescription = sanitizeNarrativeText(
    beautyOverview?.description ||
      sanitizeNarrativeText(product.pdp_description_raw || product.description),
  );
  let ingredientsModule = buildIngredientsModule(product, detailSections);
  let activeIngredientsModule = buildActiveIngredientsModule(
    product,
    detailSections,
    ingredientsModule,
  );
  if (shouldDropNarrativeIngredientModules(product, activeIngredientsModule, ingredientsModule)) {
    ingredientsModule = null;
    activeIngredientsModule = null;
  }
  const howToUseModule = buildHowToUseModule(product, detailSections);
  const productFactsSections = buildProductFactSections(
    product,
    detailSections,
    primaryDescription,
    beautyOverview,
  );
  const productDetailsSections = buildProductDetailsSections(
    product,
    detailSections,
    primaryDescription,
    beautyOverview,
  );
  const suppressRedundantDescriptionFacts =
    isRedundantDescriptionOnlyFacts(productFactsSections, primaryDescription) &&
    Boolean(activeIngredientsModule || ingredientsModule || howToUseModule);
  const resolvedProductFactsSections = suppressRedundantDescriptionFacts ? [] : productFactsSections;
  const reviews = buildReviewsPreview(product, { includeEmpty: args.includeEmptyReviews });
  const relatedProducts = Array.isArray(args.relatedProducts)
    ? { items: args.relatedProducts }
    : args.relatedProducts && typeof args.relatedProducts === 'object'
      ? { ...args.relatedProducts, items: Array.isArray(args.relatedProducts.items) ? args.relatedProducts.items : [] }
      : { items: [] };
  const recommendations = relatedProducts.items.length
    ? buildRecommendations(
        {
          ...relatedProducts,
          items: relatedProducts.items.filter((item) => {
            const flags = ensureJsonObject(
              item?.external_seed_suppression_flags ||
                item?.suppression_flags ||
                item?.external_seed_recall?.suppression_flags,
            );
            return flags.exclude_from_similar !== true && flags.exclude_from_recall !== true;
          }),
        },
        currency,
      )
    : null;
  const brandStory = extractBrandStory(product, productFactsSections);
  const emitLegacyProductDetails = Boolean(
    productDetailsSections.length ||
      (
        resolvedProductFactsSections.length &&
        !activeIngredientsModule &&
        !ingredientsModule &&
        !howToUseModule
      ),
  );

  const modules = [];
  if (mediaItems.length) {
    modules.push({
      module_id: 'm_media',
      type: 'media_gallery',
      priority: 100,
      data: { items: mediaItems },
    });
  }
  if (variants.length > 1) {
    modules.push({
      module_id: 'm_variant',
      type: 'variant_selector',
      priority: 95,
      data: { selected_variant_id: defaultVariant.variant_id },
    });
  }
  modules.push({
    module_id: 'm_price',
    type: 'price_promo',
    priority: 90,
    data: {
      price: defaultVariant.price?.current || { amount: normalizeAmount(product.price), currency },
      compare_at: defaultVariant.price?.compare_at,
      promotions: product.promotions || [],
    },
  });
  if (activeIngredientsModule) {
    modules.push({
      module_id: 'm_active_ingredients',
      type: 'active_ingredients',
      priority: 82,
      data: activeIngredientsModule,
    });
  }
  if (ingredientsModule) {
    modules.push({
      module_id: 'm_ingredients',
      type: 'ingredients_inci',
      priority: 81,
      data: ingredientsModule,
    });
  }
  if (howToUseModule) {
    modules.push({
      module_id: 'm_how_to_use',
      type: 'how_to_use',
      priority: 80,
      data: howToUseModule,
    });
  }
  if (resolvedProductFactsSections.length) {
    modules.push({
      module_id: 'm_product_facts',
      type: 'product_facts',
      priority: 71,
      data: { sections: resolvedProductFactsSections },
    });
  }
  if (emitLegacyProductDetails) {
    modules.push({
      module_id: 'm_details',
      type: 'product_details',
      priority: 70,
      data: { sections: productDetailsSections.length ? productDetailsSections : resolvedProductFactsSections },
    });
  }
  if (reviews) {
    modules.push({
      module_id: 'm_reviews',
      type: 'reviews_preview',
      priority: 50,
      data: reviews,
    });
  }
  if (
    recommendations &&
    recommendations.items.length &&
    suppressionFlags.exclude_from_similar !== true
  ) {
    modules.push({
      module_id: 'm_recs',
      type: 'recommendations',
      priority: 20,
      data: recommendations,
    });
  }

  const availabilityInStock = normalizeInStock(product.in_stock);
  const productRawQty =
    product.available_quantity ?? product.inventory_quantity ?? product.quantity ?? product.stock;
  const productAvailableQuantity =
    productRawQty == null || productRawQty === ''
      ? undefined
      : Number.isFinite(Number(productRawQty))
        ? Math.max(0, Math.floor(Number(productRawQty)))
        : undefined;
  const productAvailability = {};
  if (availabilityInStock !== undefined) productAvailability.in_stock = availabilityInStock;
  if (productAvailableQuantity !== undefined) productAvailability.available_quantity = productAvailableQuantity;
  if (productAvailability.in_stock === undefined && productAvailableQuantity !== undefined) {
    productAvailability.in_stock = productAvailableQuantity > 0;
  }
  const payload = {
    schema_version: '1.0.0',
    page_type: 'product_detail',
    x_template_hint: args.templateHint || detectTemplateHint(product),
    tracking: {
      page_request_id: createPageRequestId(),
      entry_point: args.entryPoint || 'agent',
      ...(args.experiment ? { experiment: args.experiment } : {}),
    },
    product: {
      product_id: product.product_id || product.id,
      merchant_id: product.merchant_id || product.merchant?.id || product.merchant_uuid,
      title: product.title || product.name,
      subtitle: product.subtitle || '',
      brand: brandLabel ? { name: brandLabel } : undefined,
      category_path: inferCategoryPath(product),
      image_url: normalizePdpImageUrl(product.image_url || product.image) || undefined,
      tags: Array.isArray(product.tags) ? product.tags : undefined,
      department: product.department || undefined,
      default_variant_id: defaultVariant.variant_id,
      variants,
      price: defaultVariant.price,
      availability: productAvailability,
      shipping: product.shipping || undefined,
      returns: product.returns || undefined,
      description: primaryDescription || '',
      ...(brandStory ? { brand_story: brandStory } : {}),
      ...(product.size_guide || product.sizeGuide
        ? { size_guide: product.size_guide || product.sizeGuide }
        : {}),
      ...(product.raw || product.raw_detail || product.raw_payload
        ? { raw: product.raw || product.raw_detail || product.raw_payload }
        : {}),
    },
    modules,
    actions: [
      { action_type: 'add_to_cart', label: 'Add to Cart', priority: 20, target: {} },
      { action_type: 'buy_now', label: 'Buy Now', priority: 10, target: {} },
    ],
  };

  return compilePdpPayload(payload, { debug: args.debug });
}

module.exports = {
  buildPdpPayload,
  detectTemplateHint,
};
