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

function detectTemplateHint(product) {
  const category = String(product.category || product.product_type || '').toLowerCase();
  const title = String(product.title || product.name || '').toLowerCase();
  const tags = Array.isArray(product.tags) ? product.tags.join(' ').toLowerCase() : '';
  const brand = String(product.brand?.name || product.brand || '').toLowerCase();
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
        image_url: product.image_url,
      },
    ];
  }

  return rawVariants.map((v, idx) => {
    const variantId = v.variant_id || v.id || v.sku || v.sku_id || `${product.product_id}-${idx + 1}`;
    const title = v.title || v.name || v.option_title || v.sku_name || `Variant ${idx + 1}`;
    const options = Array.isArray(v.options)
      ? v.options
      : typeof v.options === 'object' && v.options
        ? Object.entries(v.options).map(([name, value]) => ({ name, value: String(value) }))
        : [];

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

    return {
      variant_id: String(variantId),
      sku_id: v.sku_id || v.sku || v.sku_code,
      title: String(title),
      options,
      swatch: swatchHex ? { hex: swatchHex } : undefined,
      price: toVariantPrice(v.price || v.pricing, currency),
      availability,
      image_url: v.image_url || v.image || v.images?.[0],
    };
  });
}

function buildMediaItems(product, variants) {
  const items = [];
  const media = Array.isArray(product.media) ? product.media : [];
  const images = Array.isArray(product.images)
    ? product.images
    : Array.isArray(product.image_urls)
      ? product.image_urls
      : [];

  media.forEach((m) => {
    const url = m.url || m.image_url || m.src;
    if (!url) return;
    items.push({
      type: m.type || m.media_type || 'image',
      url,
      thumbnail_url: m.thumbnail_url || m.thumbnail,
      alt_text: m.alt_text || product.title,
      source: m.source,
      duration_ms: m.duration_ms,
    });
  });

  images.forEach((img) => {
    const url = typeof img === 'string' ? img : img.url || img.image_url;
    if (!url) return;
    items.push({
      type: 'image',
      url,
      alt_text: typeof img === 'object' ? img.alt_text : product.title,
      source: typeof img === 'object' ? img.source : undefined,
      thumbnail_url: typeof img === 'object' ? img.thumbnail_url : undefined,
    });
  });

  variants.forEach((v) => {
    if (v.image_url && !items.some((i) => i.url === v.image_url)) {
      items.push({
        type: 'image',
        url: v.image_url,
        alt_text: product.title,
      });
    }
  });

  if (!items.length && product.image_url) {
    items.push({
      type: 'image',
      url: product.image_url,
      alt_text: product.title,
    });
  }

  return items;
}

function buildDetailSections(product) {
  const sections = [];
  const desc = stripHtml(product.description || '');
  if (desc) {
    sections.push({
      heading: 'Description',
      content_type: 'text',
      content: desc,
      collapsed_by_default: false,
    });
  }

  const rawSections = Array.isArray(product.details_sections)
    ? product.details_sections
    : Array.isArray(product.detail_sections)
      ? product.detail_sections
      : Array.isArray(product.details)
        ? product.details
        : [];

  rawSections.forEach((s) => {
    const heading = s.heading || s.title || s.name;
    const content = s.content || s.value || s.text;
    if (!heading || !content) return;
    sections.push({
      heading: String(heading),
      content_type: 'text',
      content: stripHtml(String(content)),
      collapsed_by_default: s.collapsed_by_default ?? true,
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
    ...(ratingDistribution
      ? { star_distribution: ratingDistribution, rating_distribution: ratingDistribution }
      : {}),
    preview_items: previewItems.slice(0, 3).map((item, idx) => ({
      review_id: String(item.review_id || item.id || idx),
      rating: Number(item.rating || item.score || scale) || scale,
      author_label: item.author_label || item.author || item.user,
      text_snippet: String(item.text_snippet || item.text || item.body || ''),
      media: Array.isArray(item.media)
        ? item.media.map((m) => ({
            type: m.type || 'image',
            url: m.url || m.image_url,
            thumbnail_url: m.thumbnail_url,
          }))
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

function buildRecommendations(items, currencyFallback) {
  return {
    strategy: 'related_products',
    items: (items || []).map((p) => ({
      product_id: p.product_id || p.id,
      merchant_id: p.merchant_id || p.merchant?.id || p.merchant_uuid,
      title: p.title || p.name,
      image_url: p.image_url || p.image || (Array.isArray(p.images) ? p.images[0] : undefined),
      price: {
        amount: normalizeAmount(p.price),
        currency: normalizeCurrency(p, currencyFallback),
      },
      rating: p.rating || p.review_rating || undefined,
      review_count: p.review_count || p.reviews_count || undefined,
    })),
  };
}

function buildPdpPayload(args) {
  const product = args.product || {};
  const currency = product.currency || 'USD';
  const variants = buildVariants(product);
  const defaultVariant = variants[0];
  const mediaItems = buildMediaItems(product, variants);
  const details = buildDetailSections(product);
  const reviews = buildReviewsPreview(product, { includeEmpty: args.includeEmptyReviews });
  const recommendations = args.relatedProducts?.length
    ? buildRecommendations(args.relatedProducts, currency)
    : null;

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
  if (details.length) {
    modules.push({
      module_id: 'm_details',
      type: 'product_details',
      priority: 70,
      data: { sections: details },
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
      brand: product.brand ? { name: product.brand.name || product.brand } : undefined,
      category_path: inferCategoryPath(product),
      image_url: product.image_url || product.image || undefined,
      tags: Array.isArray(product.tags) ? product.tags : undefined,
      department: product.department || undefined,
      default_variant_id: defaultVariant.variant_id,
      variants,
      price: defaultVariant.price,
      availability: productAvailability,
      shipping: product.shipping || undefined,
      returns: product.returns || undefined,
      description: product.description || '',
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
