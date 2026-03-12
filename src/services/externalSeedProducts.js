const crypto = require('node:crypto');

const EXTERNAL_SEED_MERCHANT_ID = 'external_seed';

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

function normalizeSeedImageUrls(seedData, row) {
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
  const brand = String(seedData.brand || snapshot.brand || '').trim() || undefined;
  const category = String(seedData.category || seedData.product?.category || snapshot.category || '').trim() || undefined;

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
    url: canonicalUrl || destinationUrl || undefined,
    canonical_url: canonicalUrl || undefined,
    destination_url: destinationUrl || undefined,
    external_seed_id: row.id ? String(row.id) : undefined,
    seed_data: seedData,
    variants,
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
  normalizeSeedImageUrls,
  normalizeSeedVariants,
  buildExternalSeedProduct,
};
