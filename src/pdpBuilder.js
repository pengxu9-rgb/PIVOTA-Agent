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

function detectTemplateHint(product) {
  const category = String(product.category || product.product_type || '').toLowerCase();
  const title = String(product.title || product.name || '').toLowerCase();
  const tags = Array.isArray(product.tags) ? product.tags.join(' ').toLowerCase() : '';
  const brand = String(product.brand?.name || product.brand || '').toLowerCase();
  const combined = `${category} ${title} ${tags} ${brand}`;
  return BEAUTY_KEYWORDS.some((kw) => combined.includes(kw)) ? 'beauty' : 'generic';
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
    return [
      {
        variant_id: product.product_id || product.id,
        sku_id: product.sku || product.product_id || product.id,
        title: 'Default',
        options: [],
        price: { current: { amount: normalizeAmount(product.price), currency } },
        availability: { in_stock: Boolean(product.in_stock) },
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

    const inStock =
      typeof v.in_stock === 'boolean'
        ? v.in_stock
        : typeof v.available === 'boolean'
          ? v.available
          : (v.inventory_quantity || v.quantity || 0) > 0;

    const swatchHex =
      v.color_hex ||
      v.swatch?.hex ||
      v.beauty_meta?.shade_hex ||
      v.shade_hex ||
      v.hex;

    return {
      variant_id: String(variantId),
      sku_id: v.sku_id || v.sku || v.sku_code,
      title: String(title),
      options,
      swatch: swatchHex ? { hex: swatchHex } : undefined,
      price: toVariantPrice(v.price || v.pricing, currency),
      availability: { in_stock: inStock },
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

  return {
    scale,
    rating,
    review_count: reviewCount,
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

  return {
    schema_version: '1.0.0',
    page_type: 'product_detail',
    template_hint: args.templateHint || detectTemplateHint(product),
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
      availability: { in_stock: Boolean(product.in_stock) },
      shipping: product.shipping || undefined,
      returns: product.returns || undefined,
      description: product.description || '',
    },
    modules,
    actions: [
      { action_type: 'add_to_cart', label: 'Add to Cart', priority: 20, target: {} },
      { action_type: 'buy_now', label: 'Buy Now', priority: 10, target: {} },
    ],
  };
}

module.exports = {
  buildPdpPayload,
  detectTemplateHint,
};
