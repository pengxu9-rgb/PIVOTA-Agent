const { buildPdpImageDedupeKey, normalizePdpImageUrl, normalizePdpImageUrls } = require('./utils/pdpImageUrls');

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

function createPageRequestId() {
  return `pr_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
}

function stripHtml(input) {
  return String(input || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

function normalizePdpHttpUrl(value) {
  const str = stripHtml(value);
  if (!str) return '';
  if (!/^https?:\/\//i.test(str)) return '';
  return str;
}

function isExternalSeedLikeProduct(product) {
  if (!product || typeof product !== 'object') return false;
  const merchantId = stripHtml(product.merchant_id || product.merchantId || product.merchant?.id)
    .toLowerCase();
  const source = stripHtml(
    product.source ||
      product.product_source ||
      product.productSource ||
      product.detail_source ||
      product.query_source,
  ).toLowerCase();
  const platform = stripHtml(product.platform || product.source_platform).toLowerCase();
  const purchaseRoute = stripHtml(product.purchase_route || product.purchaseRoute).toLowerCase();
  const commerceMode = stripHtml(product.commerce_mode || product.commerceMode).toLowerCase();
  return (
    merchantId === 'external_seed' ||
    source === 'external_seed' ||
    source === 'external_product_seeds' ||
    source === 'external_seed_db' ||
    platform === 'external' ||
    ['affiliate_outbound', 'merchant_site', 'external_redirect', 'links_out'].includes(purchaseRoute) ||
    ['links_out', 'affiliate_outbound', 'merchant_site'].includes(commerceMode)
  );
}

function resolveProductExternalRedirectUrl(product) {
  if (!product || typeof product !== 'object') return '';

  const explicit = [
    product.external_redirect_url,
    product.externalRedirectUrl,
    product.affiliate_url,
    product.affiliateUrl,
    product.external_url,
    product.externalUrl,
    product.redirect_url,
    product.redirectUrl,
  ]
    .map(normalizePdpHttpUrl)
    .find(Boolean);
  if (explicit) return explicit;

  if (!isExternalSeedLikeProduct(product)) return '';

  return (
    [
      product.destination_url,
      product.destinationUrl,
      product.canonical_url,
      product.canonicalUrl,
      product.source_url,
      product.sourceUrl,
      product.url,
      product.product_url,
      product.productUrl,
      product.raw?.destination_url,
      product.raw?.canonical_url,
      product.raw_detail?.destination_url,
      product.raw_detail?.canonical_url,
      product.seed_data?.destination_url,
      product.seed_data?.canonical_url,
    ]
      .map(normalizePdpHttpUrl)
      .find(Boolean) || ''
  );
}

function detectTemplateHint(product) {
  const category = String(product.category || product.product_type || '').toLowerCase();
  const title = String(product.title || product.name || '').toLowerCase();
  const tags = Array.isArray(product.tags) ? product.tags.join(' ').toLowerCase() : '';
  const brand = String(resolveProductBrandLabel(product) || '').toLowerCase();
  const combined = `${category} ${title} ${tags} ${brand}`;
  return BEAUTY_KEYWORDS.some((kw) => combined.includes(kw)) ? 'beauty' : 'generic';
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
  ingredients_inci: {
    requiredPaths: ['data.title', 'data.items'],
    validate: (module) => Array.isArray(module?.data?.items) && module.data.items.length > 0,
  },
  active_ingredients: {
    requiredPaths: ['data.title', 'data.items'],
    validate: (module) => Array.isArray(module?.data?.items) && module.data.items.length > 0,
  },
  how_to_use: {
    requiredPaths: ['data.title', 'data.steps'],
    validate: (module) => Array.isArray(module?.data?.steps) && module.data.steps.length > 0,
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

function asNonEmptyString(value) {
  if (typeof value !== 'string') return '';
  const normalized = stripHtml(value);
  return normalized;
}

function uniqueNonEmptyStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const normalized = asNonEmptyString(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function normalizeStructuredItems(input, options = {}) {
  const mode = options.mode || 'list';
  const items = [];
  const push = (value) => {
    const normalized = asNonEmptyString(value);
    if (normalized) items.push(normalized);
  };
  const parseText = (text) => {
    const normalized = asNonEmptyString(text);
    if (!normalized) return;
    const parts =
      mode === 'steps'
        ? normalized
            .split(/\n+|(?:^|\s)[-•]\s+|(?<=[.!?])\s+(?=[A-Z0-9])/)
            .map((part) => part.trim())
            .filter(Boolean)
        : normalized
            .split(/\n+|;|,/)
            .map((part) => part.trim())
            .filter(Boolean);
    if (parts.length) {
      parts.forEach((part) => push(part));
    } else {
      push(normalized);
    }
  };
  const visit = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry));
      return;
    }
    if (typeof value === 'string') {
      parseText(value);
      return;
    }
    if (typeof value !== 'object') return;
    if (Array.isArray(value.items)) visit(value.items);
    if (Array.isArray(value.steps)) visit(value.steps);
    if (Array.isArray(value.values)) visit(value.values);
    if (Array.isArray(value.selected_options)) visit(value.selected_options);
    if (typeof value.value === 'string') parseText(value.value);
    if (typeof value.name === 'string' && !value.value) push(value.name);
    if (typeof value.text === 'string') parseText(value.text);
    if (typeof value.raw_text === 'string') parseText(value.raw_text);
    if (typeof value.rawText === 'string') parseText(value.rawText);
    if (typeof value.description === 'string') parseText(value.description);
    if (typeof value.content === 'string') parseText(value.content);
    if (typeof value.body === 'string') parseText(value.body);
    if (typeof value.instructions === 'string') parseText(value.instructions);
    if (typeof value.directions === 'string') parseText(value.directions);
    if (typeof value.how_to_use === 'string') parseText(value.how_to_use);
    if (typeof value.howToUse === 'string') parseText(value.howToUse);
  };
  visit(input);
  return uniqueNonEmptyStrings(items);
}

function pickStructuredText(input) {
  if (!input) return '';
  if (typeof input === 'string') return asNonEmptyString(input);
  if (typeof input !== 'object') return '';
  return (
    asNonEmptyString(input.raw_text) ||
    asNonEmptyString(input.rawText) ||
    asNonEmptyString(input.text) ||
    asNonEmptyString(input.description) ||
    asNonEmptyString(input.content) ||
    asNonEmptyString(input.body) ||
    ''
  );
}

function pickStructuredTitle(input, fallbackTitle) {
  if (input && typeof input === 'object') {
    return (
      asNonEmptyString(input.title) ||
      asNonEmptyString(input.heading) ||
      asNonEmptyString(input.name) ||
      fallbackTitle
    );
  }
  return fallbackTitle;
}

function buildStructuredListModuleData(product, candidates, fallbackTitle, options = {}) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const items = normalizeStructuredItems(candidate, options);
    const rawText = pickStructuredText(candidate);
    if (!items.length && !rawText) continue;
    const data = {
      title: pickStructuredTitle(candidate, fallbackTitle),
      ...(rawText ? { raw_text: rawText } : {}),
      ...(options.mode === 'steps' ? { steps: items } : { items }),
    };
    if (candidate && typeof candidate === 'object') {
      const sourceOrigin =
        asNonEmptyString(candidate.source_origin) ||
        asNonEmptyString(candidate.sourceOrigin) ||
        '';
      const sourceQualityStatus =
        asNonEmptyString(candidate.source_quality_status) ||
        asNonEmptyString(candidate.sourceQualityStatus) ||
        '';
      if (sourceOrigin) data.source_origin = sourceOrigin;
      if (sourceQualityStatus) data.source_quality_status = sourceQualityStatus;
    }
    return data;
  }
  return null;
}

function extractStructuredSourceMeta(candidate) {
  if (!candidate || typeof candidate !== 'object') return {};
  const sourceOrigin =
    asNonEmptyString(candidate.source_origin) ||
    asNonEmptyString(candidate.sourceOrigin) ||
    '';
  const sourceQualityStatus =
    asNonEmptyString(candidate.source_quality_status) ||
    asNonEmptyString(candidate.sourceQualityStatus) ||
    '';
  return {
    ...(sourceOrigin ? { source_origin: sourceOrigin } : {}),
    ...(sourceQualityStatus ? { source_quality_status: sourceQualityStatus } : {}),
  };
}

function cleanStructuredToken(value) {
  return String(value || '')
    .replace(/^[\s\-•*]+/, '')
    .replace(/^(?:step\s*)?\d+[\).:\-]\s*/i, '')
    .replace(/\s*[-•]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitIngredientsItemsFromText(text) {
  const normalized = asNonEmptyString(text)
    .replace(/^full ingredients[:\s-]*/i, '')
    .replace(/^ingredients(?:\s*\(inci\))?[:\s-]*/i, '')
    .trim();
  if (!normalized) return [];
  return uniqueNonEmptyStrings(
    normalized
      .split(/\n+|;|,(?![^()]*\))/)
      .map((item) => cleanStructuredToken(item))
      .filter((item) => item.length > 1),
  );
}

function splitHowToUseStepsFromText(text) {
  const normalized = asNonEmptyString(text);
  if (!normalized) return [];
  const withBreaks = normalized
    .replace(/(?:^|\s)(?:step\s*)?\d+[\).:\-]\s*/gi, '\n')
    .replace(/(?:^|\s)[•*-]\s+/g, '\n')
    .replace(/\s+-\s+/g, '\n');
  return uniqueNonEmptyStrings(
    withBreaks
      .split(/\n+/)
      .map((item) => cleanStructuredToken(item))
      .filter((item) => item.length > 1),
  );
}

function buildIngredientsModuleData(candidates, fallbackTitle) {
  const collectAtomicItems = (candidate) => {
    const directLists = [];
    if (Array.isArray(candidate)) directLists.push(candidate);
    if (candidate && typeof candidate === 'object') {
      if (Array.isArray(candidate.items)) directLists.push(candidate.items);
      if (Array.isArray(candidate.values)) directLists.push(candidate.values);
    }
    return uniqueNonEmptyStrings(
      directLists.flatMap((list) => list.map((item) => asNonEmptyString(item)).filter(Boolean)),
    );
  };

  for (const candidate of candidates) {
    if (!candidate) continue;
    const rawText = pickStructuredText(candidate);
    const atomicItems = collectAtomicItems(candidate);
    const items = uniqueNonEmptyStrings([
      ...(atomicItems.length ? atomicItems : normalizeStructuredItems(candidate)),
      ...(atomicItems.length ? [] : splitIngredientsItemsFromText(rawText)),
    ]);
    if (!items.length && !rawText) continue;
    return {
      title: pickStructuredTitle(candidate, fallbackTitle),
      ...(rawText ? { raw_text: rawText } : {}),
      items,
      ...extractStructuredSourceMeta(candidate),
    };
  }
  return null;
}

function buildHowToUseModuleData(candidates, fallbackTitle) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const rawText = pickStructuredText(candidate);
    const structuredSteps = normalizeStructuredItems(candidate, { mode: 'steps' }).flatMap((item) =>
      splitHowToUseStepsFromText(item),
    );
    const steps = uniqueNonEmptyStrings([
      ...structuredSteps,
      ...(structuredSteps.length > 1 ? [] : splitHowToUseStepsFromText(rawText)),
    ]);
    if (!steps.length && !rawText) continue;
    return {
      title: pickStructuredTitle(candidate, fallbackTitle),
      ...(rawText ? { raw_text: rawText } : {}),
      steps,
      ...extractStructuredSourceMeta(candidate),
    };
  }
  return null;
}

function isRegulatoryActiveIngredientSource(candidate) {
  const combined = [
    candidate?.source_origin,
    candidate?.sourceOrigin,
    candidate?.source_quality_status,
    candidate?.sourceQualityStatus,
  ]
    .map((value) => String(value || '').toLowerCase())
    .join(' ');
  return (
    combined.includes('regulatory') ||
    combined.includes('otc') ||
    combined.includes('drug facts') ||
    combined.includes('active ingredient')
  );
}

function shouldSuppressLowConfidenceActiveIngredients(product, candidate, data, ingredientsInci) {
  if (String(product?.source || '').trim().toLowerCase() !== 'external_seed') return false;
  if (detectTemplateHint(product) !== 'beauty') return false;
  if (isRegulatoryActiveIngredientSource(candidate)) return false;
  if (String(data?.source_quality_status || '').trim().toLowerCase() === 'high') return false;
  const itemCount = Array.isArray(data?.items) ? data.items.length : 0;
  const ingredientsCount = Array.isArray(ingredientsInci?.items) ? ingredientsInci.items.length : 0;
  return itemCount <= 1 && ingredientsCount >= 4;
}

function getProductOptionNames(product) {
  const rawOptions = Array.isArray(product.options)
    ? product.options
    : Array.isArray(product.product_options)
      ? product.product_options
      : [];
  const normalized = rawOptions
    .map((entry, index) => {
      if (typeof entry === 'string') return entry.trim();
      if (entry && typeof entry === 'object') {
        return (
          asNonEmptyString(entry.name) ||
          asNonEmptyString(entry.title) ||
          asNonEmptyString(entry.label) ||
          asNonEmptyString(entry.option) ||
          `Option ${index + 1}`
        );
      }
      return '';
    })
    .filter(Boolean);
  return normalized;
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

  const productOptionNames = getProductOptionNames(product);

  return rawVariants.map((v, idx) => {
    const attrs = v && typeof v.variant_attributes === 'object' ? v.variant_attributes : {};
    const variantId = v.variant_id || v.id || attrs.variant_id || v.sku || v.sku_id || `${product.product_id}-${idx + 1}`;
    const title =
      attrs.title || v.title || v.name || v.option_title || v.sku_name || `Variant ${idx + 1}`;
    let options = Array.isArray(v.options)
      ? v.options
      : Array.isArray(attrs.selected_options)
        ? attrs.selected_options
        : typeof v.options === 'object' && v.options
          ? Object.entries(v.options).map(([name, value]) => ({ name, value: String(value) }))
          : [];

    if (!options.length) {
      options = ['option1', 'option2', 'option3']
        .map((key, optionIndex) => {
          const value = attrs[key] ?? v[key];
          const normalizedValue = asNonEmptyString(value);
          if (!normalizedValue) return null;
          const optionName = productOptionNames[optionIndex] || `Option ${optionIndex + 1}`;
          return { name: optionName, value: normalizedValue };
        })
        .filter(Boolean);
    }

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
    const variantImages = normalizePdpImageUrls([
      v.image_url,
      v.image,
      ...(Array.isArray(v.images) ? v.images : []),
      ...(Array.isArray(v.image_urls) ? v.image_urls : []),
    ]);

    return {
      variant_id: String(variantId),
      sku_id: attrs.sku || v.sku_id || v.sku || v.sku_code,
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

  const readVariantImages = (variant) => {
    if (!variant || typeof variant !== 'object') return [];
    return [
      ...(Array.isArray(variant.images) ? variant.images : []),
      ...(Array.isArray(variant.image_urls) ? variant.image_urls : []),
      ...(variant.image_url ? [variant.image_url] : []),
    ];
  };

  const primaryVariantImages = readVariantImages(primaryVariant);
  const hasAuthoritativeVariantGallery =
    Array.isArray(variants) && variants.length > 1 && primaryVariantImages.some((value) => buildPdpImageDedupeKey(value));

  media.forEach((m) => {
    const url = normalizePdpImageUrl(m.url || m.image_url || m.src);
    if (!url) return;
    const mediaType = m.type || m.media_type || 'image';
    if (String(mediaType).trim().toLowerCase() !== 'image') {
      items.push({
        type: mediaType,
        url,
        thumbnail_url: m.thumbnail_url || m.thumbnail,
        alt_text: m.alt_text || product.title,
        source: m.source,
        source_scope: m.source_scope,
        source_tier: m.source_tier,
        source_kind: m.source_kind,
        duration_ms: m.duration_ms,
      });
      return;
    }
    if (hasAuthoritativeVariantGallery) return;
    pushImageItem(url, {
      url,
      thumbnail_url: m.thumbnail_url || m.thumbnail,
      alt_text: m.alt_text || product.title,
      source: m.source,
      source_scope: m.source_scope,
      source_tier: m.source_tier,
      source_kind: m.source_kind,
      duration_ms: m.duration_ms,
    });
  });

  if (hasAuthoritativeVariantGallery) {
    const pushVariantGallery = (variant, includePrimaryHero) => {
      const variantImages = readVariantImages(variant);
      const heroKey = buildPdpImageDedupeKey(variant?.image_url || variantImages[0]);
      variantImages
        .filter((variantImage) => buildPdpImageDedupeKey(variantImage) !== heroKey)
        .forEach((variantImage) => pushImageItem(variantImage, { alt_text: product.title }));
      if (includePrimaryHero && heroKey) {
        pushImageItem(variant?.image_url || variantImages[0], { alt_text: product.title });
      }
    };

    pushVariantGallery(primaryVariant, true);
    variants.slice(1).forEach((variant) => pushVariantGallery(variant, false));

    if (items.length) return items;
  }

  images.forEach((img) => {
    const url = normalizePdpImageUrl(typeof img === 'string' ? img : img.url || img.image_url);
    if (!url) return;
    pushImageItem(url, {
      url,
      alt_text: typeof img === 'object' ? img.alt_text : product.title,
      source: typeof img === 'object' ? img.source : undefined,
      source_scope: typeof img === 'object' ? img.source_scope : undefined,
      source_tier: typeof img === 'object' ? img.source_tier : undefined,
      source_kind: typeof img === 'object' ? img.source_kind : undefined,
      thumbnail_url: typeof img === 'object' ? img.thumbnail_url : undefined,
    });
  });

  variants.forEach((v) => {
    const variantImages = Array.isArray(v.images)
      ? v.images
      : Array.isArray(v.image_urls)
        ? v.image_urls
        : v.image_url
          ? [v.image_url]
          : [];

    variantImages.forEach((variantImage) => {
      const url = normalizePdpImageUrl(
        typeof variantImage === 'string' ? variantImage : variantImage?.url || variantImage?.src || variantImage?.image_url,
      );
      if (!url) return;
      pushImageItem(url, {
        url,
        alt_text: product.title,
      });
    });

    const variantImageUrl = normalizePdpImageUrl(v.image_url);
    if (variantImageUrl) {
      pushImageItem(variantImageUrl, {
        url: variantImageUrl,
        alt_text: product.title,
      });
    }
  });

  const fallbackProductImage = normalizePdpImageUrl(product.image_url);
  if (!items.length && fallbackProductImage) {
    pushImageItem(fallbackProductImage, {
      url: fallbackProductImage,
      alt_text: product.title,
    });
  }

  return items;
}

const STRUCTURED_DETAIL_SECTION_RE =
  /^(ingredients|active ingredients?|how to use|how to apply|directions?|warnings?|warning|caution|faq|frequently asked questions?|q\s*&\s*a|questions?)$/i;
const OVERVIEW_DETAIL_SECTION_RE = /^(overview|product details|details|about|description)$/i;
const BRAND_STORY_SECTION_RE = /(?:brand story|our story|about the brand)/i;
const FACT_DETAIL_SECTION_RE =
  /^(benefits?|clinical results?|results?|proven results?|key ingredients?|why it works|texture|finish|best for|formulation|what else you should know|good to know)$/i;

function normalizeDetailSectionHeading(value) {
  const heading = asNonEmptyString(value);
  if (!heading) return '';
  if (/^(?:product details?|details?|about(?: the product)?|description)$/i.test(heading)) return 'Details';
  if (/^(?:benefits?|why it works|what it does|why we love it)$/i.test(heading)) return 'Benefits';
  if (/^(?:key ingredients?|highlight(?:ed)? ingredients?|ingredients story)$/i.test(heading)) {
    return 'Key Ingredients';
  }
  if (/^(?:clinical(?: results?| claims?)?|results?|proven results?)$/i.test(heading)) {
    return 'Clinical Results';
  }
  if (/^(?:how to use|how to apply|directions?|usage)$/i.test(heading)) return 'How to Use';
  if (/^(?:ingredients?|ingredients and safety|ingredient list|full ingredients?|full ingredient list|inci)$/i.test(heading)) {
    return 'Ingredients';
  }
  if (/^(?:faq|frequently asked questions?|q(?:uestions)?\s*&\s*a|questions?)$/i.test(heading)) {
    return 'FAQ';
  }
  return heading;
}

function collectStructuredDetailSections(product) {
  const rawSections = Array.isArray(product.pdp_details_sections)
    ? product.pdp_details_sections
    : Array.isArray(product.details_sections)
      ? product.details_sections
      : Array.isArray(product.detail_sections)
        ? product.detail_sections
        : Array.isArray(product.details)
          ? product.details
          : [];
  const out = [];
  const seen = new Set();
  for (const section of rawSections) {
    const heading = normalizeDetailSectionHeading(section?.heading || section?.title || section?.name);
    const content = stripHtml(
      section?.content ||
        section?.value ||
        section?.text ||
        section?.body ||
        section?.description ||
        '',
    );
    if (!heading || !content) continue;
    const key = `${heading.toLowerCase()}::${content.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      heading,
      content_type: 'text',
      content,
      collapsed_by_default: section?.collapsed_by_default ?? true,
    });
  }
  return out;
}

function resolveProductDescriptionText(product, detailSections = collectStructuredDetailSections(product)) {
  const explicitPdpDescription = asNonEmptyString(product.pdp_description_raw);
  if (explicitPdpDescription) return explicitPdpDescription;

  const structuredDescription =
    typeof product.description === 'string'
      ? product.description
      : product.description && typeof product.description === 'object'
        ? product.description.text || product.description.raw_text || ''
        : '';
  const normalizedDescription = stripHtml(structuredDescription || '');
  if (normalizedDescription) return normalizedDescription;

  const overviewSection =
    detailSections.find((section) => OVERVIEW_DETAIL_SECTION_RE.test(section.heading)) ||
    detailSections.find(
      (section) =>
        !STRUCTURED_DETAIL_SECTION_RE.test(section.heading) &&
        !FACT_DETAIL_SECTION_RE.test(section.heading) &&
        !BRAND_STORY_SECTION_RE.test(section.heading),
    );
  return overviewSection?.content || '';
}

function resolveBrandStoryText(product, detailSections = collectStructuredDetailSections(product)) {
  const explicit = asNonEmptyString(product.brand_story || product.brandStory);
  if (explicit) return explicit;
  return detailSections.find((section) => BRAND_STORY_SECTION_RE.test(section.heading))?.content || '';
}

function buildDetailSections(product, detailSections = collectStructuredDetailSections(product)) {
  const sections = [];
  const desc = resolveProductDescriptionText(product, detailSections);
  if (desc) {
    sections.push({
      heading: 'Description',
      content_type: 'text',
      content: desc,
      collapsed_by_default: false,
    });
  }

  detailSections
    .filter((section) => {
      if (STRUCTURED_DETAIL_SECTION_RE.test(section.heading)) return false;
      if (FACT_DETAIL_SECTION_RE.test(section.heading)) return false;
      if (BRAND_STORY_SECTION_RE.test(section.heading)) return false;
      if (OVERVIEW_DETAIL_SECTION_RE.test(section.heading)) return false;
      if (desc && section.content === desc) return false;
      return true;
    })
    .forEach((section) => {
      sections.push({
        heading: section.heading,
        content_type: 'text',
        content: section.content,
        collapsed_by_default: section.collapsed_by_default,
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

function buildProductFactsSections(product, detailSections = collectStructuredDetailSections(product)) {
  return detailSections
    .filter((section) => FACT_DETAIL_SECTION_RE.test(section.heading) && !BRAND_STORY_SECTION_RE.test(section.heading))
    .map((section) => ({
      heading: section.heading,
      content_type: 'text',
      content: section.content,
      collapsed_by_default: section.collapsed_by_default ?? true,
    }));
}

function buildIngredientsInci(product) {
  const structured = buildIngredientsModuleData(
    [
      product.pdp_ingredients_raw,
      product.ingredients_inci,
      product.ingredientsInci,
      product.inci_ingredients,
      product.inciIngredients,
      product.ingredients,
    ],
    'Ingredients',
  );
  if (structured) return structured;

  const rawText = asNonEmptyString(product.raw_ingredient_text_clean);
  const items = uniqueNonEmptyStrings([
    ...(Array.isArray(product.inci_list) ? product.inci_list : []),
    ...splitIngredientsItemsFromText(rawText),
  ]);
  if (!rawText && !items.length) return null;
  return {
    title: 'Ingredients',
    ...(rawText ? { raw_text: rawText } : {}),
    items,
    source_origin: 'retail_pdp',
    source_quality_status: 'captured',
  };
}

function buildActiveIngredients(product, ingredientsInci) {
  const candidates = [
    product.pdp_active_ingredients_raw,
    product.active_ingredients,
    product.activeIngredients,
    product.key_ingredients,
    product.keyIngredients,
    product.highlight_ingredients,
    product.highlightIngredients,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const rawText = pickStructuredText(candidate);
    const items = uniqueNonEmptyStrings(normalizeStructuredItems(candidate));
    if (!items.length && !rawText) continue;
    const data = {
      title: pickStructuredTitle(candidate, 'Active ingredients'),
      ...(rawText ? { raw_text: rawText } : {}),
      items,
      ...extractStructuredSourceMeta(candidate),
    };
    if (shouldSuppressLowConfidenceActiveIngredients(product, candidate, data, ingredientsInci)) {
      return null;
    }
    return data;
  }

  return null;
}

function buildHowToUse(product) {
  const detailSections = collectStructuredDetailSections(product);
  const detailSectionHowToUse =
    detailSections.find((section) => /^(how to use|how to apply|directions?|usage)$/i.test(section.heading))
      ?.content || '';
  return buildHowToUseModuleData(
    [
      product.pdp_how_to_use_raw,
      detailSectionHowToUse,
      product.how_to_use,
      product.howToUse,
      product.directions,
      product.instructions,
      product.usage,
    ],
    'How to use',
  );
}

function normalizeQuestionKey(value) {
  return asNonEmptyString(value)
    .toLowerCase()
    .replace(/^(?:q(?:uestion)?\s*[:/-]\s*)/i, '')
    .replace(/[?？]+$/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeQuestionText(value) {
  return asNonEmptyString(value)
    .replace(/^(?:q(?:uestion)?\s*[:/-]\s*)/i, '')
    .trim();
}

function normalizeAnswerText(value) {
  return asNonEmptyString(value)
    .replace(/^(?:a(?:nswer)?\s*[:/-]\s*)/i, '')
    .trim();
}

function normalizeFaqItemsForQuestions(product) {
  const rawItems = Array.isArray(product.pdp_faq_items)
    ? product.pdp_faq_items
    : Array.isArray(product.faq_items)
      ? product.faq_items
      : Array.isArray(product.seed_data?.pdp_faq_items)
        ? product.seed_data.pdp_faq_items
        : Array.isArray(product.seed_data?.snapshot?.pdp_faq_items)
          ? product.seed_data.snapshot.pdp_faq_items
          : [];
  const out = [];
  const seen = new Set();
  for (const item of rawItems) {
    const question = normalizeQuestionText(item?.question);
    const answer = normalizeAnswerText(item?.answer);
    const key = normalizeQuestionKey(question);
    if (!question || !answer || !key || seen.has(`${key}::${answer.toLowerCase()}`)) continue;
    seen.add(`${key}::${answer.toLowerCase()}`);
    out.push({
      question,
      answer,
      source: 'merchant_faq',
      source_label: 'Official FAQ',
    });
  }
  return out;
}

function normalizeReviewSummaryQuestions(items) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const question = normalizeQuestionText(item?.question || item?.title);
    const answer = normalizeAnswerText(item?.answer);
    const replies = item?.replies ?? item?.reply_count;
    const key = normalizeQuestionKey(question);
    if (!question || !key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      question,
      ...(answer ? { answer } : {}),
      ...(replies != null ? { replies: Number(replies) || 0 } : {}),
      source: asNonEmptyString(item?.source) || 'review_derived',
      source_label: asNonEmptyString(item?.source_label || item?.sourceLabel) || 'From reviews',
      ...(item?.support_count != null ? { support_count: Number(item.support_count) || 0 } : {}),
    });
  }
  return out;
}

function extractReviewQuestionCandidate(item) {
  const reviewId = String(item?.review_id || item?.id || '').trim();
  const explicitQuestion = normalizeQuestionText(item?.question || item?.prompt);
  const explicitAnswer = normalizeAnswerText(item?.answer);
  if (explicitQuestion && explicitAnswer) {
    return {
      question: explicitQuestion,
      answer: explicitAnswer,
      review_id: reviewId,
    };
  }

  const title = normalizeQuestionText(item?.title);
  const text = normalizeAnswerText(item?.text_snippet || item?.text || item?.body);
  let question = '';
  let answer = '';

  if (/[?？]$/.test(title)) {
    question = title;
    answer = text;
  } else {
    const match = text.match(/^(.{8,160}?\?)\s+([\s\S]{16,})$/);
    if (match) {
      question = normalizeQuestionText(match[1]);
      answer = normalizeAnswerText(match[2]);
    }
  }

  if (!question || !answer) return null;
  return {
    question,
    answer,
    review_id: reviewId,
  };
}

function deriveReviewQuestionsFromPreviewItems(items) {
  const grouped = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const extracted = extractReviewQuestionCandidate(item);
    if (!extracted) continue;
    const key = normalizeQuestionKey(extracted.question);
    if (!key) continue;
    const existing = grouped.get(key) || {
      question: extracted.question,
      answers: new Map(),
      review_ids: new Set(),
    };
    existing.question = existing.question || extracted.question;
    existing.review_ids.add(extracted.review_id || key);
    const answerKey = extracted.answer.toLowerCase();
    const answerEntry = existing.answers.get(answerKey) || { answer: extracted.answer, count: 0 };
    answerEntry.count += 1;
    existing.answers.set(answerKey, answerEntry);
    grouped.set(key, existing);
  }

  const out = [];
  for (const entry of grouped.values()) {
    const supportCount = entry.review_ids.size;
    if (supportCount < 2) continue;
    const answer = Array.from(entry.answers.values()).sort((a, b) => b.count - a.count || b.answer.length - a.answer.length)[0];
    if (!answer?.answer) continue;
    out.push({
      question: entry.question,
      answer: answer.answer,
      source: 'review_derived',
      source_label: 'From reviews',
      support_count: supportCount,
    });
  }
  return out;
}

function mergeQuestionItems(groups) {
  const merged = new Map();
  for (const group of groups) {
    for (const item of Array.isArray(group) ? group : []) {
      const question = normalizeQuestionText(item?.question);
      const key = normalizeQuestionKey(question);
      if (!question || !key) continue;
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, {
          question,
          ...(item?.answer ? { answer: item.answer } : {}),
          ...(item?.replies != null ? { replies: item.replies } : {}),
          ...(item?.source ? { source: item.source } : {}),
          ...(item?.source_label ? { source_label: item.source_label } : {}),
          ...(item?.support_count != null ? { support_count: item.support_count } : {}),
        });
        continue;
      }

      if (!existing.answer && item?.answer) existing.answer = item.answer;
      if (existing.replies == null && item?.replies != null) existing.replies = item.replies;
      if ((!existing.source || existing.source === 'community') && item?.source) existing.source = item.source;
      if (!existing.source_label && item?.source_label) existing.source_label = item.source_label;
      if ((existing.support_count || 0) < (item?.support_count || 0)) {
        existing.support_count = item.support_count;
      }
    }
  }
  return Array.from(merged.values());
}

function buildReviewsPreview(product, options = {}) {
  const merchantFaqQuestions = normalizeFaqItemsForQuestions(product);
  const summary =
    product.review_summary ||
    product.reviews_summary ||
    product.reviews?.summary ||
    null;

  if (!summary && !options.includeEmpty && merchantFaqQuestions.length === 0) {
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
  const explicitQuestions = normalizeReviewSummaryQuestions(summary?.questions);
  const derivedQuestions = deriveReviewQuestionsFromPreviewItems(previewItems);
  const questions = mergeQuestionItems([merchantFaqQuestions, explicitQuestions, derivedQuestions]);
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

  const normalizeScopedSummary = (rawSummary) => {
    if (!rawSummary || typeof rawSummary !== 'object') return null;
    const nestedScale = Number(rawSummary.scale || rawSummary.rating_scale || scale) || scale;
    const nestedRating =
      Number(rawSummary.rating || rawSummary.average_rating || rawSummary.avg_rating || 0) || 0;
    const nestedReviewCount =
      Number(rawSummary.review_count || rawSummary.count || rawSummary.total || 0) || 0;
    const nestedPreviewItems = Array.isArray(rawSummary.preview_items)
      ? rawSummary.preview_items
      : Array.isArray(rawSummary.snippets)
        ? rawSummary.snippets
        : [];
    const nestedDistributionRaw =
      rawSummary.rating_distribution ||
      rawSummary.star_distribution ||
      rawSummary.ratingDistribution ||
      rawSummary.starDistribution ||
      rawSummary.distribution ||
      null;
    const nestedRatingDistribution = (() => {
      if (!nestedDistributionRaw) return undefined;
      const map = new Map();
      if (Array.isArray(nestedDistributionRaw)) {
        nestedDistributionRaw.forEach((item) => {
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
      } else if (typeof nestedDistributionRaw === 'object') {
        Object.entries(nestedDistributionRaw).forEach(([k, v]) => {
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
          if (nestedReviewCount && v > 1 && v <= nestedReviewCount) {
            count = v;
          } else if (v > 1) {
            percent = v / 100;
          } else {
            percent = v;
          }
        }
        if (count != null && nestedReviewCount > 0) {
          percent = count / nestedReviewCount;
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
      const hasAny = rows.some(
        (row) => (row.count != null && row.count > 0) || (row.percent != null && row.percent > 0),
      );
      return hasAny ? rows : undefined;
    })();

    return {
      scale: nestedScale,
      rating: nestedRating,
      review_count: nestedReviewCount,
      ...(typeof rawSummary.scope_label === 'string' && rawSummary.scope_label.trim()
        ? { scope_label: rawSummary.scope_label.trim() }
        : {}),
      ...(nestedRatingDistribution
        ? {
            star_distribution: nestedRatingDistribution,
            rating_distribution: nestedRatingDistribution,
          }
        : {}),
      preview_items: nestedPreviewItems.slice(0, 6).map((item, idx) => ({
        review_id: String(item.review_id || item.id || idx),
        rating: Number(item.rating || item.score || nestedScale) || nestedScale,
        author_label: item.author_label || item.author || item.user,
        title: item.title ? String(item.title) : undefined,
        text_snippet: String(item.text_snippet || item.text || item.body || item.title || ''),
        media: Array.isArray(item.media)
          ? item.media.map((m) => ({
              type: m.type || 'image',
              url: m.url || m.image_url,
              thumbnail_url: m.thumbnail_url,
            }))
          : undefined,
      })),
      ...(rawSummary?.brand_card && typeof rawSummary.brand_card === 'object'
        ? { brand_card: rawSummary.brand_card }
        : {}),
    };
  };
  const scopedSummaries =
    summary?.scoped_summaries && typeof summary.scoped_summaries === 'object'
      ? Object.entries(summary.scoped_summaries).reduce((acc, [key, value]) => {
          const normalized = normalizeScopedSummary(value);
          if (normalized) acc[key] = normalized;
          return acc;
        }, {})
      : undefined;

  return {
    scale,
    rating,
    review_count: reviewCount,
    aggregation_scope:
      typeof summary?.aggregation_scope === 'string' ? summary.aggregation_scope : undefined,
    exact_item_review_count:
      Number.isFinite(Number(summary?.exact_item_review_count))
        ? Number(summary.exact_item_review_count)
        : undefined,
    product_line_review_count:
      Number.isFinite(Number(summary?.product_line_review_count))
        ? Number(summary.product_line_review_count)
        : undefined,
    scope_label: summary?.scope_label ? String(summary.scope_label) : undefined,
    ...(questions.length ? { questions } : {}),
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
            url: m.url || m.image_url,
            thumbnail_url: m.thumbnail_url,
          }))
        : undefined,
    })),
    filters: Array.isArray(summary?.filters)
      ? summary.filters
          .map((item) =>
            item && typeof item === 'object'
              ? {
                  id: String(item.id || '').trim(),
                  label: String(item.label || item.name || '').trim(),
                  count: Number(item.count || 0) || 0,
                }
              : null,
          )
          .filter((item) => item && item.id && item.label)
      : undefined,
    tabs: Array.isArray(summary?.tabs)
      ? summary.tabs
          .map((item) =>
            item && typeof item === 'object'
              ? {
                  id: String(item.id || '').trim(),
                  label: String(item.label || item.name || '').trim(),
                  count: Number(item.count || 0) || 0,
                  default: item.default === true,
                }
              : null,
          )
          .filter((item) => item && item.id && item.label)
      : undefined,
    scoped_summaries:
      scopedSummaries && Object.keys(scopedSummaries).length > 0 ? scopedSummaries : undefined,
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

function buildRecommendations(items, currencyFallback) {
  return {
    strategy: 'related_products',
    items: (items || []).map((p) => ({
      product_id: p.product_id || p.id,
      merchant_id: p.merchant_id || p.merchant?.id || p.merchant_uuid,
      title: p.title || p.name,
      image_url:
        normalizePdpImageUrl(p.image_url || p.image || (Array.isArray(p.images) ? p.images[0] : undefined)) ||
        undefined,
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
  const brandLabel = resolveProductBrandLabel(product);
  const currency = product.currency || 'USD';
  const variants = buildVariants(product);
  const defaultVariant = variants[0];
  const detailSections = collectStructuredDetailSections(product);
  const descriptionText = resolveProductDescriptionText(product, detailSections);
  const brandStoryText = resolveBrandStoryText(product, detailSections);
  const mediaItems = buildMediaItems(product, variants);
  const previewItems = Array.isArray(product.line_preview_images)
    ? product.line_preview_images
        .map((item) => {
          const url = normalizePdpImageUrl(
            typeof item === 'string' ? item : item?.url || item?.image_url || item?.src,
          );
          if (!url) return null;
          return {
            type: 'image',
            url,
            alt_text: typeof item === 'object' ? item.alt_text || product.title : product.title,
            source: typeof item === 'object' ? item.source : undefined,
            source_scope: typeof item === 'object' ? item.source_scope : undefined,
            source_tier: typeof item === 'object' ? item.source_tier : undefined,
            source_kind:
              typeof item === 'object'
                ? item.source_kind || 'product_line_preview'
                : 'product_line_preview',
            thumbnail_url: typeof item === 'object' ? item.thumbnail_url : undefined,
            merchant_id: typeof item === 'object' ? item.merchant_id : undefined,
            product_id: typeof item === 'object' ? item.product_id : undefined,
          };
        })
        .filter(Boolean)
    : [];
  const details = buildDetailSections(product, detailSections);
  const productFacts = buildProductFactsSections(product, detailSections);
  const ingredientsInci = buildIngredientsInci(product);
  const activeIngredients = buildActiveIngredients(product, ingredientsInci);
  const howToUse = buildHowToUse(product);
  const reviews = buildReviewsPreview(product, { includeEmpty: args.includeEmptyReviews });
  const recommendations = args.relatedProducts?.length
    ? buildRecommendations(args.relatedProducts, currency)
    : null;
  const productSource = stripHtml(product.source || product.product_source || product.productSource);
  const productPurchaseRoute = stripHtml(product.purchase_route || product.purchaseRoute);
  const productCommerceMode = stripHtml(product.commerce_mode || product.commerceMode);
  const productCheckoutHandoff = stripHtml(product.checkout_handoff || product.checkoutHandoff);
  const externalRedirectUrl = resolveProductExternalRedirectUrl(product);
  const productUrl = normalizePdpHttpUrl(product.url || product.product_url || product.productUrl);
  const canonicalUrl = normalizePdpHttpUrl(product.canonical_url || product.canonicalUrl);
  const destinationUrl = normalizePdpHttpUrl(product.destination_url || product.destinationUrl);
  const sourceUrl = normalizePdpHttpUrl(product.source_url || product.sourceUrl);

  const modules = [];
  if (mediaItems.length) {
    modules.push({
      module_id: 'm_media',
      type: 'media_gallery',
      priority: 100,
      data: {
        items: mediaItems,
        gallery_scope: typeof product.gallery_scope === 'string' ? product.gallery_scope : undefined,
        preview_scope: typeof product.preview_scope === 'string' ? product.preview_scope : undefined,
        preview_items: previewItems.length ? previewItems : undefined,
      },
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
  if (details.length) {
    modules.push({
      module_id: 'm_details',
      type: 'product_details',
      priority: 70,
      data: { sections: details },
    });
  }
  if (productFacts.length) {
    modules.push({
      module_id: 'm_facts',
      type: 'product_facts',
      priority: 72,
      data: { sections: productFacts },
    });
  }
  if (activeIngredients) {
    modules.push({
      module_id: 'm_active_ingredients',
      type: 'active_ingredients',
      priority: 82,
      data: activeIngredients,
    });
  }
  if (ingredientsInci) {
    modules.push({
      module_id: 'm_ingredients_inci',
      type: 'ingredients_inci',
      priority: 81,
      data: ingredientsInci,
    });
  }
  if (howToUse) {
    modules.push({
      module_id: 'm_how_to_use',
      type: 'how_to_use',
      priority: 80,
      data: howToUse,
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
  if (recommendations && recommendations.items.length) {
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
      source: productSource || undefined,
      purchase_route: productPurchaseRoute || undefined,
      commerce_mode: productCommerceMode || undefined,
      checkout_handoff: productCheckoutHandoff || undefined,
      external_redirect_url: externalRedirectUrl || undefined,
      url: productUrl || undefined,
      canonical_url: canonicalUrl || undefined,
      destination_url: destinationUrl || undefined,
      source_url: sourceUrl || undefined,
      default_variant_id: defaultVariant.variant_id,
      variants,
      price: defaultVariant.price,
      availability: productAvailability,
      shipping: product.shipping || undefined,
      returns: product.returns || undefined,
      description: descriptionText || '',
      ...(brandStoryText ? { brand_story: brandStoryText } : {}),
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
  isExternalSeedLikeProduct,
  normalizePdpHttpUrl,
  resolveProductExternalRedirectUrl,
};
