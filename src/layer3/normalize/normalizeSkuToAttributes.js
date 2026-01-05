const { z } = require('zod');
const {
  AvailabilityByMarketV0Schema,
  AvailabilitySchema,
  MoneyV0Schema,
  PriceTierSchema,
  ProductCategorySchema,
  ProductTagsV0Schema,
  UndertoneFitSchema,
} = require('../schemas/productAttributesV0');

const USD_BUDGET_MAX = 15;
const USD_MID_MAX = 35;

function normalizeString(v) {
  return String(v ?? '').trim();
}

function lower(v) {
  return normalizeString(v).toLowerCase();
}

function firstNonEmpty(...values) {
  for (const v of values) {
    const s = normalizeString(v);
    if (s) return s;
  }
  return '';
}

function extractSkuId(raw) {
  return firstNonEmpty(
    raw.skuId,
    raw.sku_id,
    raw.variant_id,
    raw.variantId,
    raw.variant_sku,
    raw.variantSku,
    raw.id,
    raw.product_id,
    raw.productId
  );
}

function extractMerchantId(raw) {
  return firstNonEmpty(raw.merchantId, raw.merchant_id, raw.store_id, raw.storeId);
}

function extractName(raw) {
  return firstNonEmpty(raw.name, raw.title, raw.product_title, raw.productTitle, raw.handle);
}

function extractBrand(raw) {
  return firstNonEmpty(raw.brand, raw.vendor, raw.merchant, raw.merchant_name, raw.merchantName);
}

function extractCurrency(raw) {
  const currency = firstNonEmpty(raw.currency, raw.price_currency, raw.priceCurrency);
  return currency || 'USD';
}

function extractPriceAmount(raw) {
  const candidates = [
    raw.price,
    raw.price_amount,
    raw.priceAmount,
    raw.amount,
    raw.unit_price,
    raw.unitPrice,
    raw.min_price,
    raw.minPrice,
  ];

  for (const v of candidates) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim()) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
    if (typeof v === 'object' && v && 'amount' in v) {
      const a = v.amount;
      if (typeof a === 'number' && Number.isFinite(a)) return a;
      if (typeof a === 'string' && a.trim()) {
        const n = Number(a);
        if (Number.isFinite(n)) return n;
      }
    }
  }

  const cents = raw.price_cents ?? raw.priceCents;
  if (typeof cents === 'number' && Number.isFinite(cents)) return cents / 100;
  if (typeof cents === 'string' && cents.trim()) {
    const n = Number(cents);
    if (Number.isFinite(n)) return n / 100;
  }

  return 0;
}

function extractImageUrl(raw) {
  const url = firstNonEmpty(raw.imageUrl, raw.image_url, raw.image, raw.image_src, raw.imageSrc);
  return url || undefined;
}

function extractProductUrl(raw) {
  const url = firstNonEmpty(raw.productUrl, raw.product_url, raw.url, raw.link);
  return url || undefined;
}

function extractPurchaseEnabled(raw) {
  const v =
    raw.purchaseEnabled ??
    raw.purchase_enabled ??
    raw.purchase_enabled_override ??
    raw.isPurchaseEnabled ??
    raw.is_purchase_enabled ??
    raw.checkoutEnabled ??
    raw.checkout_enabled;

  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string' && v.trim()) {
    const s = v.trim().toLowerCase();
    if (['true', '1', 'yes', 'y'].includes(s)) return true;
    if (['false', '0', 'no', 'n'].includes(s)) return false;
  }
  return undefined;
}

function extractAvailability(raw) {
  const inStock = raw.inStock ?? raw.in_stock ?? raw.available ?? raw.is_available ?? raw.isAvailable;
  if (typeof inStock === 'boolean') return inStock ? 'in_stock' : 'out_of_stock';

  const availability = lower(raw.availability);
  if (availability.includes('in_stock') || availability.includes('in stock')) return 'in_stock';
  if (availability.includes('out_of_stock') || availability.includes('out of stock')) return 'out_of_stock';

  const stock = lower(raw.stock);
  if (stock === '0' || stock === 'none') return 'out_of_stock';
  if (stock && stock !== '0') return 'in_stock';

  return 'unknown';
}

function derivePriceTier(price) {
  if (price.currency !== 'USD') return 'unknown';
  if (price.amount <= 0) return 'unknown';
  if (price.amount <= USD_BUDGET_MAX) return 'budget';
  if (price.amount <= USD_MID_MAX) return 'mid';
  return 'premium';
}

function pushTag(tags, tag) {
  const t = tag.trim();
  if (!t) return;
  if (!tags.includes(t)) tags.push(t);
}

function deriveTags(rawText) {
  const t = rawText.toLowerCase();

  const finish = [];
  const texture = [];
  const coverage = [];
  const effect = [];

  if (/\bsoft[- ]?matte\b/.test(t)) pushTag(finish, 'soft-matte');
  if (/\bmatte\b/.test(t)) pushTag(finish, 'matte');
  if (/\bdewy\b|\bradiant\b|\bluminous\b/.test(t)) pushTag(finish, 'dewy');
  if (/\bsatin\b/.test(t)) pushTag(finish, 'satin');
  if (/\bgloss(y|)\b|\bshine\b/.test(t)) pushTag(finish, 'glossy');
  if (/\bsheer\b|\btransparent\b/.test(t)) pushTag(finish, 'sheer');

  if (/\bpowder\b/.test(t)) pushTag(texture, 'powder');
  if (/\bcream\b/.test(t)) pushTag(texture, 'cream');
  if (/\bliquid\b/.test(t)) pushTag(texture, 'liquid');
  if (/\bgel\b/.test(t)) pushTag(texture, 'gel');
  if (/\bstick\b/.test(t)) pushTag(texture, 'stick');
  if (/\bbalm\b/.test(t)) pushTag(texture, 'balm');
  if (/\boil\b/.test(t)) pushTag(texture, 'oil');

  if (/\bfull[- ]?coverage\b/.test(t)) pushTag(coverage, 'full');
  if (/\bmedium[- ]?coverage\b/.test(t)) pushTag(coverage, 'medium');
  if (/\blight[- ]?coverage\b/.test(t)) pushTag(coverage, 'light');
  if (/\bbuildable\b/.test(t)) pushTag(coverage, 'buildable');
  if (/\bsheer\b/.test(t)) pushTag(coverage, 'sheer');

  if (/\blong[- ]?wear\b|\blong[- ]?lasting\b/.test(t)) pushTag(effect, 'long-wear');
  if (/\bwaterproof\b/.test(t)) pushTag(effect, 'waterproof');
  if (/\bsmudge[- ]?proof\b/.test(t)) pushTag(effect, 'smudge-proof');
  if (/\bvolum(izing|ise|ize)\b/.test(t)) pushTag(effect, 'volumizing');
  if (/\blengthen(ing|)\b/.test(t)) pushTag(effect, 'lengthening');
  if (/\bshimmer\b/.test(t)) pushTag(effect, 'shimmer');
  if (/\bglitter\b/.test(t)) pushTag(effect, 'glitter');
  if (/\bblurr(ing|)\b/.test(t)) pushTag(effect, 'blurring');
  if (/\bhydrat(ing|ion)\b/.test(t)) pushTag(effect, 'hydrating');
  if (/\bplump(ing|)\b/.test(t)) pushTag(effect, 'plumping');

  return ProductTagsV0Schema.parse({ finish, texture, coverage, effect });
}

function deriveUndertoneFit(rawText) {
  const t = rawText.toLowerCase();
  if (/\bcool\b/.test(t)) return 'cool';
  if (/\bwarm\b/.test(t)) return 'warm';
  if (/\bneutral\b/.test(t)) return 'neutral';
  return 'unknown';
}

function deriveShadeDescriptor(raw, rawText) {
  const explicit = firstNonEmpty(raw.shade, raw.shade_name, raw.shadeName, raw.color, raw.colour);
  if (explicit) return explicit;
  const t = rawText.toLowerCase();
  const hints = ['rose', 'beige', 'brown', 'nude', 'peach', 'coral', 'berry', 'red', 'pink', 'mauve', 'taupe'];
  for (const h of hints) if (t.includes(h)) return h;
  return undefined;
}

function normalizeSkuToAttributes(input) {
  const { market, locale, category } = input;
  const sku = input.sku;
  const raw = sku && typeof sku === 'object' ? sku : {};

  const skuId = extractSkuId(raw) || `unknown_${Math.random().toString(16).slice(2)}`;
  const merchantId = extractMerchantId(raw);
  const name = extractName(raw) || 'Unknown';
  const brand = extractBrand(raw) || 'Unknown';
  const currency = extractCurrency(raw);
  const amount = extractPriceAmount(raw);
  const price = MoneyV0Schema.parse({ currency, amount });
  const availability = AvailabilitySchema.parse(extractAvailability(raw));
  const availabilityByMarket = AvailabilityByMarketV0Schema.parse({ US: availability });
  const priceTier = PriceTierSchema.parse(derivePriceTier(price));

  const rawText = [
    name,
    brand,
    normalizeString(raw.description),
    Array.isArray(raw.tags) ? raw.tags.join(' ') : '',
    normalizeString(raw.product_type),
  ]
    .filter(Boolean)
    .join(' ')
    .trim();

  const tags = deriveTags(rawText);
  const undertoneFit = UndertoneFitSchema.parse(deriveUndertoneFit(rawText));
  const shadeDescriptor = deriveShadeDescriptor(raw, rawText);

  return {
    category: ProductCategorySchema.parse(category),
    skuId,
    ...(merchantId ? { merchantId } : {}),
    name,
    brand,
    price,
    priceTier,
    imageUrl: extractImageUrl(raw),
    productUrl: extractProductUrl(raw),
    ...(extractPurchaseEnabled(raw) != null ? { purchaseEnabled: extractPurchaseEnabled(raw) } : {}),
    availability,
    availabilityByMarket,
    tags,
    undertoneFit,
    shadeDescriptor,
    rawText,
    raw: sku,
  };
}

module.exports = {
  normalizeSkuToAttributes,
};
