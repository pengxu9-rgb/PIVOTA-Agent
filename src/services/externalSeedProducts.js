const crypto = require('node:crypto');
const { lookupExternalSeedImageOverride } = require('./externalSeedImageOverrides');

const EXTERNAL_SEED_MERCHANT_ID = 'external_seed';
const SKINCARE_STEP_CATEGORY_PATTERNS = [
  ['Serum', /\b(serum|essence|ampoule|concentrate)\b/i],
  ['Moisturizer', /\b(moisturizer|moisturiser|cream|lotion|gel cream|gel-cream|barrier cream)\b/i],
  ['Cleanser', /\b(cleanser|cleansing|face wash|facial wash|cleansing milk|cleansing foam|cleansing gel|wash)\b/i],
  ['Toner', /\b(toner|mist|pad)\b/i],
];

function stableExternalProductId(url) {
  const u = String(url || '').trim();
  if (!u) return '';
  const hash = crypto.createHash('sha256').update(u).digest('hex').slice(0, 24);
  return `ext_${hash}`;
}

function ensureJsonObject(val) {
  if (!val) return {};
  if (typeof val === 'object') return val;
  if (typeof val !== 'string') return {};
  const trimmed = val.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeSeedAvailability(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return null;
  if (v === 'in stock' || v === 'instock' || v === 'in_stock' || v === 'available') return 'in_stock';
  if (v === 'out of stock' || v === 'outofstock' || v === 'out_of_stock' || v === 'oos') return 'out_of_stock';
  return v;
}

function availabilityToInStock(availability) {
  const a = normalizeSeedAvailability(availability);
  if (!a) return null;
  if (a === 'in_stock') return true;
  if (a === 'out_of_stock') return false;
  return null;
}

function normalizeCurrency(value, fallback = 'USD') {
  return String(value || fallback).trim().toUpperCase() || fallback;
}

function normalizeAmount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const normalized = value.replace(/[^0-9.-]+/g, '');
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (value && typeof value === 'object') {
    return normalizeAmount(value.amount ?? value.current?.amount ?? value.price_amount ?? value.value);
  }
  return 0;
}

function normalizeHttpUrl(value) {
  const url = String(value || '').trim();
  if (!/^https?:\/\//i.test(url)) return '';
  return url;
}

function normalizeExplicitSkincareCategory(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^external$/i.test(text)) return '';
  for (const [label, pattern] of SKINCARE_STEP_CATEGORY_PATTERNS) {
    if (pattern.test(text)) return label;
  }
  return text;
}

function inferExternalSeedSkincareCategory(...values) {
  const surfaceText = values
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ');
  if (!surfaceText) return '';
  for (const [label, pattern] of SKINCARE_STEP_CATEGORY_PATTERNS) {
    if (pattern.test(surfaceText)) return label;
  }
  return '';
}

function normalizeIngredientToken(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  const normalized = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!normalized) return '';
  const aliases = {
    'ascorbic acid': 'ascorbic_acid',
    'azelaic acid': 'azelaic_acid',
    'benzoyl peroxide': 'benzoyl_peroxide',
    benzoyl: 'benzoyl_peroxide',
    bpo: 'benzoyl_peroxide',
    ceramide: 'ceramide_np',
    ceramides: 'ceramide_np',
    'ceramide np': 'ceramide_np',
    glycerin: 'glycerin',
    glycerine: 'glycerin',
    'hyaluronic acid': 'hyaluronic_acid',
    hyaluronic: 'hyaluronic_acid',
    hyaluron: 'hyaluronic_acid',
    'sodium hyaluronate': 'hyaluronic_acid',
    niacinamide: 'niacinamide',
    panthenol: 'panthenol',
    'vitamin b5': 'panthenol',
    'provitamin b5': 'panthenol',
    b5: 'panthenol',
    peptide: 'peptides',
    peptides: 'peptides',
    'multi peptide': 'peptides',
    'multi-peptide': 'peptides',
    'copper peptide': 'peptides',
    'copper peptides': 'peptides',
    tripeptide: 'peptides',
    tetrapeptide: 'peptides',
    hexapeptide: 'peptides',
    retinol: 'retinol',
    retinoid: 'retinol',
    'vitamin a': 'retinol',
    salicylic: 'salicylic_acid',
    'salicylic acid': 'salicylic_acid',
    bha: 'salicylic_acid',
    'vitamin c': 'ascorbic_acid',
    'zinc pca': 'zinc_pca',
    zinc: 'zinc_pca',
  };
  return aliases[normalized] || normalized.replace(/\s+/g, '_');
}

function appendStructuredIngredientIds(out, raw) {
  if (raw == null) return;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        appendStructuredIngredientIds(out, JSON.parse(trimmed));
        return;
      } catch {}
    }
    for (const token of trimmed.split(/[;,|]/)) {
      const normalized = normalizeIngredientToken(token);
      if (normalized && !out.includes(normalized)) out.push(normalized);
    }
    return;
  }
  if (Array.isArray(raw)) {
    for (const item of raw) appendStructuredIngredientIds(out, item);
    return;
  }
  if (typeof raw === 'object') {
    for (const key of [
      'ingredient_ids',
      'ingredientIds',
      'reviewed_ingredient_ids',
      'reviewedIngredientIds',
      'canonical_ingredient_ids',
      'canonicalIngredientIds',
      'platform_metadata',
      'platformMetadata',
      'beauty_meta',
      'beautyMeta',
    ]) {
      if (Object.prototype.hasOwnProperty.call(raw, key)) {
        appendStructuredIngredientIds(out, raw[key]);
      }
    }
    return;
  }
  const normalized = normalizeIngredientToken(raw);
  if (normalized && !out.includes(normalized)) out.push(normalized);
}

function collectStructuredIngredientIds(row, seedData, snapshot) {
  const out = [];
  for (const candidate of [
    row?.reviewed_ingredient_ids,
    row?.canonical_ingredient_ids,
    row?.ingredient_ids,
    row?.platform_metadata,
    seedData?.reviewed_ingredient_ids,
    seedData?.canonical_ingredient_ids,
    seedData?.ingredient_ids,
    seedData?.platform_metadata,
    snapshot?.reviewed_ingredient_ids,
    snapshot?.canonical_ingredient_ids,
    snapshot?.ingredient_ids,
    snapshot?.platform_metadata,
  ]) {
    appendStructuredIngredientIds(out, candidate);
  }
  return out;
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (normalized) return normalized;
  }
  return '';
}

function normalizeStringList(value, maxItems = 64) {
  const out = [];
  const seen = new Set();

  const append = (candidate) => {
    const normalized = normalizeIngredientSignalToken(candidate);
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(normalized);
  };

  const visit = (input) => {
    if (!input) return;
    if (typeof input === 'string') {
      input
        .split(/[,\n;|•]+/)
        .map((item) => item.trim())
        .filter(Boolean)
        .forEach(append);
      return;
    }
    if (Array.isArray(input)) {
      input.forEach(visit);
      return;
    }
    if (typeof input !== 'object') return;
    append(
      input.name ||
        input.title ||
        input.label ||
        input.value ||
        input.ingredient_name ||
        input.display_name ||
        input.inci_name,
    );
  };

  visit(value);
  return out.slice(0, maxItems);
}

function normalizeIngredientSignalToken(value) {
  const text = String(value || '')
    .replace(/\[more\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (/^key ingredients?$/i.test(text)) return '';
  return text;
}

function appendIngredientSignalTokens(out, value) {
  if (!value) return;

  if (typeof value === 'string') {
    const parts = value.split(/[,\n;|/]+/);
    for (const part of parts) {
      const token = normalizeIngredientSignalToken(part);
      if (!token || out.includes(token)) continue;
      out.push(token);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) appendIngredientSignalTokens(out, item);
    return;
  }

  if (typeof value !== 'object') return;

  appendIngredientSignalTokens(out, value.inci);
  appendIngredientSignalTokens(out, value.inci_name);
  appendIngredientSignalTokens(out, value.ingredient_name);
  appendIngredientSignalTokens(out, value.name);
  appendIngredientSignalTokens(out, value.display_name);
  appendIngredientSignalTokens(out, value.title);
}

function collectSeedIngredientSignalTokens(seedData, row) {
  const parsedSeedData = ensureJsonObject(seedData);
  const snapshot = ensureJsonObject(parsedSeedData.snapshot);
  const ingredientIntel = ensureJsonObject(parsedSeedData.ingredient_intel);
  const snapshotIngredientIntel = ensureJsonObject(snapshot.ingredient_intel);
  const science = ensureJsonObject(parsedSeedData.science);
  const snapshotScience = ensureJsonObject(snapshot.science);
  const assessment = ensureJsonObject(parsedSeedData.assessment);
  const snapshotAssessment = ensureJsonObject(snapshot.assessment);

  const out = [];
  const sources = [
    row?.ingredient_tokens,
    row?.key_ingredients,
    row?.hero_ingredients,
    row?.active_ingredients,
    parsedSeedData.ingredient_tokens,
    parsedSeedData.key_ingredients,
    parsedSeedData.keyIngredients,
    parsedSeedData.hero_ingredients,
    parsedSeedData.heroIngredients,
    parsedSeedData.active_ingredients,
    parsedSeedData.activeIngredients,
    parsedSeedData.ingredient_names,
    parsedSeedData.ingredientNames,
    parsedSeedData.ingredients,
    parsedSeedData.likely_key_ingredients_or_signals,
    parsedSeedData.likelyKeyIngredientsOrSignals,
    science.key_ingredients,
    science.keyIngredients,
    assessment.hero_ingredient,
    assessment.heroIngredient,
    ingredientIntel.inci_normalized,
    ingredientIntel.inciNormalized,
    ingredientIntel.key_ingredients,
    ingredientIntel.keyIngredients,
    ingredientIntel.inci_raw,
    ingredientIntel.raw_ingredient_text_clean,
    ingredientIntel.inci_list,
    snapshot.ingredient_tokens,
    snapshot.key_ingredients,
    snapshot.keyIngredients,
    snapshot.hero_ingredients,
    snapshot.heroIngredients,
    snapshot.active_ingredients,
    snapshot.activeIngredients,
    snapshot.ingredient_names,
    snapshot.ingredientNames,
    snapshot.ingredients,
    snapshot.likely_key_ingredients_or_signals,
    snapshot.likelyKeyIngredientsOrSignals,
    snapshotScience.key_ingredients,
    snapshotScience.keyIngredients,
    snapshotAssessment.hero_ingredient,
    snapshotAssessment.heroIngredient,
    snapshotIngredientIntel.inci_normalized,
    snapshotIngredientIntel.inciNormalized,
    snapshotIngredientIntel.key_ingredients,
    snapshotIngredientIntel.keyIngredients,
    snapshotIngredientIntel.inci_raw,
    snapshotIngredientIntel.raw_ingredient_text_clean,
    snapshotIngredientIntel.inci_list,
  ];
  for (const source of sources) appendIngredientSignalTokens(out, source);
  return out;
}

function appendImageUrls(out, value) {
  if (!value) return;

  if (typeof value === 'string') {
    const url = normalizeHttpUrl(value);
    if (!url || out.includes(url)) return;
    out.push(url);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) appendImageUrls(out, item);
    return;
  }

  if (typeof value !== 'object') return;
  appendImageUrls(out, value.image_url);
  appendImageUrls(out, value.url);
  appendImageUrls(out, value.src);
  appendImageUrls(out, value.contentUrl);
}

function collectSeedImageUrls(seedData, row) {
  const parsedSeedData = ensureJsonObject(seedData);
  const out = [];
  appendImageUrls(out, parsedSeedData.snapshot?.image_url);
  appendImageUrls(out, parsedSeedData.snapshot?.image_urls);
  appendImageUrls(out, parsedSeedData.snapshot?.images);
  appendImageUrls(out, row?.image_url);
  appendImageUrls(out, parsedSeedData.image_url);
  appendImageUrls(out, parsedSeedData.image_urls);
  appendImageUrls(out, parsedSeedData.images);
  return out;
}

function resolveSeedImageOverride(seedData, row) {
  const parsedSeedData = ensureJsonObject(seedData);
  const snapshot = ensureJsonObject(parsedSeedData.snapshot);
  return lookupExternalSeedImageOverride(
    snapshot.canonical_url,
    snapshot.destination_url,
    row?.canonical_url,
    row?.destination_url,
    parsedSeedData.canonical_url,
    parsedSeedData.destination_url,
  );
}

function normalizeSeedImageUrls(seedData, row) {
  const out = collectSeedImageUrls(seedData, row);
  if (out.length > 0) return out;

  const override = resolveSeedImageOverride(seedData, row);
  if (!override) return out;

  appendImageUrls(out, override.image_urls);
  appendImageUrls(out, override.image_url);
  return out;
}

function normalizeOptions(rawVariant, optionName, optionValue) {
  if (Array.isArray(rawVariant?.options)) {
    return rawVariant.options
      .map((option) => {
        if (option && typeof option === 'object' && option.name && option.value != null) {
          return { name: String(option.name), value: String(option.value) };
        }
        return null;
      })
      .filter(Boolean);
  }

  if (rawVariant?.options && typeof rawVariant.options === 'object') {
    return Object.entries(rawVariant.options)
      .map(([name, value]) => ({ name: String(name), value: String(value) }))
      .filter((option) => option.name && option.value);
  }

  if (optionName || optionValue) {
    return [{ name: optionName || 'Variant', value: optionValue || 'Default' }];
  }

  return [];
}

function normalizeSeedVariants(seedData, row) {
  const parsedSeedData = ensureJsonObject(seedData);
  const rawVariants =
    Array.isArray(parsedSeedData.snapshot?.variants) && parsedSeedData.snapshot.variants.length > 0
      ? parsedSeedData.snapshot.variants
      : Array.isArray(parsedSeedData.variants)
        ? parsedSeedData.variants
        : [];

  if (!rawVariants.length) return [];

  const productImageUrls = normalizeSeedImageUrls(parsedSeedData, row);
  const fallbackCurrency = normalizeCurrency(
    row?.price_currency || parsedSeedData.price_currency || parsedSeedData.snapshot?.price_currency,
    'USD',
  );

  return rawVariants
    .map((rawVariant, idx) => {
      if (!rawVariant || typeof rawVariant !== 'object') return null;

      const optionName = String(rawVariant.option_name || '').trim();
      const optionValue = String(rawVariant.option_value || '').trim();
      const sku = String(
        rawVariant.sku || rawVariant.sku_id || rawVariant.variant_sku || rawVariant.variant_id || rawVariant.id || '',
      ).trim();
      const variantId = String(rawVariant.variant_id || rawVariant.id || sku || `seed-variant-${idx + 1}`).trim();
      const title =
        String(rawVariant.title || rawVariant.name || optionValue || sku || `Variant ${idx + 1}`).trim() ||
        `Variant ${idx + 1}`;
      const currency = normalizeCurrency(
        rawVariant.currency || rawVariant.price_currency || rawVariant.pricing?.current?.currency,
        fallbackCurrency,
      );
      const price = normalizeAmount(
        rawVariant.price_amount ?? rawVariant.price ?? rawVariant.pricing?.current?.amount ?? rawVariant.pricing,
      );
      const rawAvailability =
        rawVariant.availability ??
        rawVariant.stock_status ??
        rawVariant.stock ??
        row?.availability ??
        parsedSeedData.availability ??
        parsedSeedData.snapshot?.availability;
      let inStock;
      if (typeof rawVariant.in_stock === 'boolean') {
        inStock = rawVariant.in_stock;
      } else if (typeof rawVariant.available === 'boolean') {
        inStock = rawVariant.available;
      } else if (rawVariant.inventory_quantity != null && rawVariant.inventory_quantity !== '') {
        inStock = Number(rawVariant.inventory_quantity) > 0;
      } else if (rawVariant.available_quantity != null && rawVariant.available_quantity !== '') {
        inStock = Number(rawVariant.available_quantity) > 0;
      } else {
        inStock = availabilityToInStock(rawAvailability);
      }

      const rawQty =
        rawVariant.available_quantity ??
        rawVariant.inventory_quantity ??
        rawVariant.quantity ??
        rawVariant.stock_quantity ??
        rawVariant.stock;
      const availableQuantity =
        rawQty == null || rawQty === ''
          ? undefined
          : Number.isFinite(Number(rawQty))
            ? Math.max(0, Math.floor(Number(rawQty)))
            : undefined;
      if (availableQuantity != null) {
        inStock = availableQuantity > 0;
      }

      const imageUrls = normalizeSeedImageUrls(
        {
          image_url: rawVariant.image_url || rawVariant.image,
          image_urls: rawVariant.image_urls,
          images: rawVariant.images,
        },
        null,
      );
      const normalizedImageUrls = imageUrls.length > 0 ? imageUrls : productImageUrls;
      const imageUrl = normalizedImageUrls[0];
      const options = normalizeOptions(rawVariant, optionName, optionValue);
      const url = normalizeHttpUrl(rawVariant.url);
      const availability = normalizeSeedAvailability(rawAvailability);
      const description = String(
        rawVariant.description || rawVariant.description_html || rawVariant.summary || rawVariant.body_html || '',
      ).trim();

      return {
        id: variantId,
        variant_id: variantId,
        sku_id: sku || variantId,
        sku: sku || variantId,
        title,
        options,
        price,
        currency,
        pricing: { current: { amount: price, currency } },
        inventory_quantity: availableQuantity ?? (inStock === true ? 999 : inStock === false ? 0 : null),
        in_stock: inStock,
        available: typeof inStock === 'boolean' ? inStock : undefined,
        availability: availability || undefined,
        option_name: optionName || undefined,
        option_value: optionValue || undefined,
        description: description || undefined,
        image_url: imageUrl || undefined,
        images: normalizedImageUrls,
        image_urls: normalizedImageUrls,
        ...(url ? { url } : {}),
      };
    })
    .filter(Boolean);
}

function buildExternalSeedProduct(row) {
  if (!row || typeof row !== 'object') return null;

  const seedData = ensureJsonObject(row.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const ingredientIntel = ensureJsonObject(seedData.ingredient_intel);
  const snapshotIngredientIntel = ensureJsonObject(snapshot.ingredient_intel);
  const science = ensureJsonObject(seedData.science);
  const snapshotScience = ensureJsonObject(snapshot.science);
  const destinationUrl = String(
    snapshot.destination_url || row.destination_url || seedData.destination_url || '',
  ).trim();
  const canonicalUrl = String(
    snapshot.canonical_url || row.canonical_url || seedData.canonical_url || '',
  ).trim();

  const externalProductId =
    String(
      row.external_product_id || seedData.external_product_id || seedData.product_id || snapshot.product_id || '',
    ).trim() || stableExternalProductId(canonicalUrl || destinationUrl);

  if (!externalProductId) return null;

  const title =
    String(snapshot.title || row.title || seedData.title || canonicalUrl || destinationUrl || externalProductId).trim() ||
    externalProductId;
  const description = String(snapshot.description || row.description || seedData.description || '').trim();
  const pdpDescriptionRaw = firstNonEmptyString(
    seedData.pdp_description_raw,
    snapshot.pdp_description_raw,
  );
  const pdpIngredientsRaw = firstNonEmptyString(
    seedData.pdp_ingredients_raw,
    snapshot.pdp_ingredients_raw,
  );
  const pdpActiveIngredientsRaw = firstNonEmptyString(
    seedData.pdp_active_ingredients_raw,
    snapshot.pdp_active_ingredients_raw,
  );
  const pdpHowToUseRaw = firstNonEmptyString(
    seedData.pdp_how_to_use_raw,
    snapshot.pdp_how_to_use_raw,
  );
  const rawIngredientTextClean = firstNonEmptyString(
    ingredientIntel.raw_ingredient_text_clean,
    snapshotIngredientIntel.raw_ingredient_text_clean,
    seedData.raw_ingredient_text_clean,
    snapshot.raw_ingredient_text_clean,
  );
  const inciList = normalizeStringList(
    ingredientIntel.inci_list ||
      snapshotIngredientIntel.inci_list ||
      ingredientIntel.inci_normalized ||
      snapshotIngredientIntel.inci_normalized,
  );
  const activeIngredients = normalizeStringList(
    seedData.active_ingredients ||
      seedData.activeIngredients ||
      snapshot.active_ingredients ||
      snapshot.activeIngredients ||
      science.key_ingredients ||
      science.keyIngredients ||
      snapshotScience.key_ingredients ||
      snapshotScience.keyIngredients,
    24,
  );
  const keyIngredients = normalizeStringList(
    seedData.key_ingredients ||
      seedData.keyIngredients ||
      snapshot.key_ingredients ||
      snapshot.keyIngredients ||
      science.key_ingredients ||
      science.keyIngredients ||
      snapshotScience.key_ingredients ||
      snapshotScience.keyIngredients,
    24,
  );
  const pdpDetailsSections = Array.isArray(seedData.pdp_details_sections)
    ? seedData.pdp_details_sections
    : Array.isArray(snapshot.pdp_details_sections)
      ? snapshot.pdp_details_sections
      : [];
  const pdpFieldCaptureStatus =
    (seedData.pdp_field_capture_status && typeof seedData.pdp_field_capture_status === 'object')
      ? seedData.pdp_field_capture_status
      : (snapshot.pdp_field_capture_status && typeof snapshot.pdp_field_capture_status === 'object')
        ? snapshot.pdp_field_capture_status
        : undefined;
  const seedDescriptionOrigin = firstNonEmptyString(
    seedData.seed_description_origin,
    snapshot.seed_description_origin,
  );
  const brand = String(seedData.brand || snapshot.brand || '').trim() || undefined;
  const explicitCategory =
    normalizeExplicitSkincareCategory(seedData.category) ||
    normalizeExplicitSkincareCategory(seedData.product?.category) ||
    normalizeExplicitSkincareCategory(snapshot.category) ||
    normalizeExplicitSkincareCategory(seedData.product_type) ||
    normalizeExplicitSkincareCategory(seedData.productType) ||
    normalizeExplicitSkincareCategory(snapshot.product_type) ||
    normalizeExplicitSkincareCategory(snapshot.productType);
  const category = explicitCategory || inferExternalSeedSkincareCategory(title, canonicalUrl, destinationUrl) || undefined;
  const ingredientTokens = collectSeedIngredientSignalTokens(seedData, row);
  const ingredientIds = collectStructuredIngredientIds(row, seedData, snapshot);

  let variants = normalizeSeedVariants(seedData, row);
  let imageUrls = normalizeSeedImageUrls(seedData, row);
  if (!imageUrls.length && variants.length) {
    imageUrls = Array.from(
      new Set(
        variants.flatMap((variant) => {
          const urls = [];
          appendImageUrls(urls, variant.image_urls);
          appendImageUrls(urls, variant.images);
          appendImageUrls(urls, variant.image_url);
          return urls;
        }),
      ),
    );
  }
  const imageUrl = imageUrls[0] || undefined;

  const rawAmount = row.price_amount ?? seedData.price_amount ?? snapshot.price_amount;
  let price = normalizeAmount(rawAmount);
  if (!(price > 0) && variants.length > 0) {
    const variantPrices = variants.map((variant) => normalizeAmount(variant.price)).filter((value) => value > 0);
    price = variantPrices.length ? Math.min(...variantPrices) : 0;
  }

  const currency = normalizeCurrency(
    row.price_currency || seedData.price_currency || snapshot.price_currency || variants[0]?.currency,
    'USD',
  );

  const availability = normalizeSeedAvailability(row.availability || seedData.availability || snapshot.availability);
  const variantStates = variants.map((variant) => (typeof variant?.in_stock === 'boolean' ? variant.in_stock : null));
  const explicitVariantStates = variantStates.filter((value) => value !== null);
  const inStock =
    explicitVariantStates.length > 0
      ? explicitVariantStates.some(Boolean)
        ? true
        : explicitVariantStates.length === variantStates.length
          ? false
          : null
      : variants.length > 0
        ? null
        : availabilityToInStock(availability);

  if (!variants.length) {
    variants = [
      {
        id: externalProductId,
        variant_id: externalProductId,
        sku_id: externalProductId,
        sku: externalProductId,
        title: 'Default',
        options: [],
        price,
        currency,
        pricing: { current: { amount: price, currency } },
        inventory_quantity: inStock === true ? 999 : inStock === false ? 0 : null,
        in_stock: inStock,
        available: typeof inStock === 'boolean' ? inStock : undefined,
        image_url: imageUrl,
        images: imageUrls,
        image_urls: imageUrls,
      },
    ];
  }

  const merchantName =
    String(seedData.merchant_display_name || brand || row.domain || 'External').trim() || 'External';

  return {
    id: externalProductId,
    product_id: externalProductId,
    merchant_id: EXTERNAL_SEED_MERCHANT_ID,
    merchant_name: merchantName,
    platform: 'external',
    platform_product_id: externalProductId,
    title,
    description,
    price,
    currency,
    image_url: imageUrl,
    images: imageUrls,
    image_urls: imageUrls,
    inventory_quantity: inStock === true ? 999 : inStock === false ? 0 : null,
    in_stock: inStock,
    availability: availability || undefined,
    product_type: category || 'external',
    source: 'external_seed',
    ...(ingredientIds.length ? { ingredient_ids: ingredientIds } : {}),
    url: canonicalUrl || destinationUrl || undefined,
    canonical_url: canonicalUrl || undefined,
    destination_url: destinationUrl || undefined,
    external_seed_id: row.id ? String(row.id) : undefined,
    seed_data: seedData,
    variants,
    ...(rawIngredientTextClean ? { raw_ingredient_text_clean: rawIngredientTextClean } : {}),
    ...(inciList.length ? { inci_list: inciList } : {}),
    ...(activeIngredients.length ? { active_ingredients: activeIngredients } : {}),
    ...(keyIngredients.length ? { key_ingredients: keyIngredients } : {}),
    ...(pdpDescriptionRaw ? { pdp_description_raw: pdpDescriptionRaw } : {}),
    ...(pdpDetailsSections.length ? { pdp_details_sections: pdpDetailsSections } : {}),
    ...(pdpIngredientsRaw ? { pdp_ingredients_raw: pdpIngredientsRaw } : {}),
    ...(pdpActiveIngredientsRaw ? { pdp_active_ingredients_raw: pdpActiveIngredientsRaw } : {}),
    ...(pdpHowToUseRaw ? { pdp_how_to_use_raw: pdpHowToUseRaw } : {}),
    ...(seedDescriptionOrigin ? { seed_description_origin: seedDescriptionOrigin } : {}),
    ...(pdpFieldCaptureStatus ? { pdp_field_capture_status: pdpFieldCaptureStatus } : {}),
    ...(Object.keys(ingredientIntel).length ? { ingredient_intel: ingredientIntel } : {}),
    ...(ingredientTokens.length ? { ingredient_tokens: ingredientTokens } : {}),
    ...(brand ? { vendor: brand, brand } : {}),
    ...(category ? { category } : {}),
  };
}

module.exports = {
  EXTERNAL_SEED_MERCHANT_ID,
  stableExternalProductId,
  ensureJsonObject,
  normalizeSeedAvailability,
  availabilityToInStock,
  collectSeedImageUrls,
  normalizeSeedImageUrls,
  normalizeSeedVariants,
  buildExternalSeedProduct,
};
