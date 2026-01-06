import { z } from "zod";
import {
  AvailabilityByMarketV0Schema,
  AvailabilitySchema,
  MoneyV0Schema,
  PriceTierSchema,
  ProductCategorySchema,
  ProductTagsV0Schema,
  UndertoneFitSchema,
} from "../schemas/productAttributesV0";

export type NormalizedSkuForRanking = {
  category: z.infer<typeof ProductCategorySchema>;
  skuId: string;
  merchantId?: string;
  name: string;
  brand: string;
  price: z.infer<typeof MoneyV0Schema>;
  priceTier: z.infer<typeof PriceTierSchema>;
  imageUrl?: string;
  productUrl?: string;
  purchaseEnabled?: boolean;
  availability: z.infer<typeof AvailabilitySchema>;
  availabilityByMarket: z.infer<typeof AvailabilityByMarketV0Schema>;
  tags: z.infer<typeof ProductTagsV0Schema>;
  undertoneFit: z.infer<typeof UndertoneFitSchema>;
  shadeDescriptor?: string;
  rawText: string;
  raw: unknown;
};

const USD_BUDGET_MAX = 15;
const USD_MID_MAX = 35;

function normalizeString(v: unknown): string {
  return String(v ?? "").trim();
}

function lower(v: unknown): string {
  return normalizeString(v).toLowerCase();
}

function firstNonEmpty(...values: unknown[]): string {
  for (const v of values) {
    const s = normalizeString(v);
    if (s) return s;
  }
  return "";
}

function extractSkuId(raw: Record<string, unknown>): string {
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

function extractMerchantId(raw: Record<string, unknown>): string {
  return firstNonEmpty(raw.merchantId, raw.merchant_id, raw.store_id, raw.storeId);
}

function extractName(raw: Record<string, unknown>): string {
  return firstNonEmpty(raw.name, raw.title, raw.product_title, raw.productTitle, raw.handle);
}

function extractBrand(raw: Record<string, unknown>): string {
  return firstNonEmpty(raw.brand, raw.vendor, raw.merchant, raw.merchant_name, raw.merchantName);
}

function extractCurrency(raw: Record<string, unknown>): string {
  const priceObj = typeof raw.price === "object" && raw.price ? (raw.price as Record<string, unknown>) : null;
  const moneyObj = typeof (raw as any).money === "object" && (raw as any).money ? ((raw as any).money as Record<string, unknown>) : null;
  const currency = firstNonEmpty(
    // Common top-level fields
    (raw as any).currency,
    (raw as any).currency_code,
    (raw as any).currencyCode,
    (raw as any).price_currency,
    (raw as any).priceCurrency,
    (raw as any).priceCurrencyCode,
    // Nested money objects
    priceObj && ((priceObj as any).currency || (priceObj as any).currency_code || (priceObj as any).currencyCode),
    moneyObj && ((moneyObj as any).currency || (moneyObj as any).currency_code || (moneyObj as any).currencyCode),
  );
  return currency || "USD";
}

function extractPriceAmount(raw: Record<string, unknown>): number {
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
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim()) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
    if (typeof v === "object" && v && "amount" in (v as any)) {
      const a = (v as any).amount;
      if (typeof a === "number" && Number.isFinite(a)) return a;
      if (typeof a === "string" && a.trim()) {
        const n = Number(a);
        if (Number.isFinite(n)) return n;
      }
    }
  }

  const cents = raw.price_cents ?? raw.priceCents;
  if (typeof cents === "number" && Number.isFinite(cents)) return cents / 100;
  if (typeof cents === "string" && cents.trim()) {
    const n = Number(cents);
    if (Number.isFinite(n)) return n / 100;
  }

  return 0;
}

function extractImageUrl(raw: Record<string, unknown>): string | undefined {
  const url = firstNonEmpty(raw.imageUrl, raw.image_url, raw.image, raw.image_src, raw.imageSrc);
  return url || undefined;
}

function extractProductUrl(raw: Record<string, unknown>): string | undefined {
  const url = firstNonEmpty(raw.productUrl, raw.product_url, raw.url, raw.link);
  return url || undefined;
}

function extractPurchaseEnabled(raw: Record<string, unknown>): boolean | undefined {
  const v =
    raw.purchaseEnabled ??
    raw.purchase_enabled ??
    raw.purchase_enabled_override ??
    raw.isPurchaseEnabled ??
    raw.is_purchase_enabled ??
    raw.checkoutEnabled ??
    raw.checkout_enabled;

  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string" && v.trim()) {
    const s = v.trim().toLowerCase();
    if (["true", "1", "yes", "y"].includes(s)) return true;
    if (["false", "0", "no", "n"].includes(s)) return false;
  }
  return undefined;
}

function extractAvailability(raw: Record<string, unknown>): z.infer<typeof AvailabilitySchema> {
  const inStock = raw.inStock ?? raw.in_stock ?? raw.available ?? raw.is_available ?? raw.isAvailable;
  if (typeof inStock === "boolean") return inStock ? "in_stock" : "out_of_stock";

  const availability = lower(raw.availability);
  if (availability.includes("in_stock") || availability.includes("in stock")) return "in_stock";
  if (availability.includes("out_of_stock") || availability.includes("out of stock")) return "out_of_stock";

  const stock = lower(raw.stock);
  if (stock === "0" || stock === "none") return "out_of_stock";
  if (stock && stock !== "0") return "in_stock";

  return "unknown";
}

function derivePriceTier(price: { currency: string; amount: number }): z.infer<typeof PriceTierSchema> {
  if (price.currency !== "USD") return "unknown";
  if (price.amount <= 0) return "unknown";
  if (price.amount <= USD_BUDGET_MAX) return "budget";
  if (price.amount <= USD_MID_MAX) return "mid";
  return "premium";
}

function pushTag(tags: string[], tag: string) {
  const t = tag.trim();
  if (!t) return;
  if (!tags.includes(t)) tags.push(t);
}

function deriveTags(rawText: string): z.infer<typeof ProductTagsV0Schema> {
  const t = rawText.toLowerCase();

  const finish: string[] = [];
  const texture: string[] = [];
  const coverage: string[] = [];
  const effect: string[] = [];

  if (/\bsoft[- ]?matte\b/.test(t)) pushTag(finish, "soft-matte");
  if (/\bmatte\b/.test(t)) pushTag(finish, "matte");
  if (/\bdewy\b|\bradiant\b|\bluminous\b/.test(t)) pushTag(finish, "dewy");
  if (/\bsatin\b/.test(t)) pushTag(finish, "satin");
  if (/\bgloss(y|)\b|\bshine\b/.test(t)) pushTag(finish, "glossy");
  if (/\bsheer\b|\btransparent\b/.test(t)) pushTag(finish, "sheer");

  if (/\bpowder\b/.test(t)) pushTag(texture, "powder");
  if (/\bcream\b/.test(t)) pushTag(texture, "cream");
  if (/\bliquid\b/.test(t)) pushTag(texture, "liquid");
  if (/\bgel\b/.test(t)) pushTag(texture, "gel");
  if (/\bstick\b/.test(t)) pushTag(texture, "stick");
  if (/\bbalm\b/.test(t)) pushTag(texture, "balm");
  if (/\boil\b/.test(t)) pushTag(texture, "oil");

  if (/\bfull[- ]?coverage\b/.test(t)) pushTag(coverage, "full");
  if (/\bmedium[- ]?coverage\b/.test(t)) pushTag(coverage, "medium");
  if (/\blight[- ]?coverage\b/.test(t)) pushTag(coverage, "light");
  if (/\bbuildable\b/.test(t)) pushTag(coverage, "buildable");
  if (/\bsheer\b/.test(t)) pushTag(coverage, "sheer");

  if (/\blong[- ]?wear\b|\blong[- ]?lasting\b/.test(t)) pushTag(effect, "long-wear");
  if (/\bwaterproof\b/.test(t)) pushTag(effect, "waterproof");
  if (/\bsmudge[- ]?proof\b/.test(t)) pushTag(effect, "smudge-proof");
  if (/\bvolum(izing|ise|ize)\b/.test(t)) pushTag(effect, "volumizing");
  if (/\blengthen(ing|)\b/.test(t)) pushTag(effect, "lengthening");
  if (/\bshimmer\b/.test(t)) pushTag(effect, "shimmer");
  if (/\bglitter\b/.test(t)) pushTag(effect, "glitter");
  if (/\bblurr(ing|)\b/.test(t)) pushTag(effect, "blurring");
  if (/\bhydrat(ing|ion)\b/.test(t)) pushTag(effect, "hydrating");
  if (/\bplump(ing|)\b/.test(t)) pushTag(effect, "plumping");

  return ProductTagsV0Schema.parse({ finish, texture, coverage, effect });
}

function deriveUndertoneFit(rawText: string): z.infer<typeof UndertoneFitSchema> {
  const t = rawText.toLowerCase();
  if (/\bcool\b/.test(t)) return "cool";
  if (/\bwarm\b/.test(t)) return "warm";
  if (/\bneutral\b/.test(t)) return "neutral";
  return "unknown";
}

function deriveShadeDescriptor(raw: Record<string, unknown>, rawText: string): string | undefined {
  const explicit = firstNonEmpty(raw.shade, raw.shade_name, raw.shadeName, raw.color, raw.colour);
  if (explicit) return explicit;
  const t = rawText.toLowerCase();
  const hints = ["rose", "beige", "brown", "nude", "peach", "coral", "berry", "red", "pink", "mauve", "taupe"];
  for (const h of hints) {
    if (t.includes(h)) return h;
  }
  return undefined;
}

export function normalizeSkuToAttributes(input: {
  market: "US";
  locale: string;
  category: z.infer<typeof ProductCategorySchema>;
  sku: unknown;
}): NormalizedSkuForRanking {
  const { category, locale, sku } = input;
  if (!sku || typeof sku !== "object") {
    throw new Error("SKU_NORMALIZE_INVALID_INPUT");
  }

  const raw = sku as Record<string, unknown>;
  const skuId = extractSkuId(raw);
  const merchantId = extractMerchantId(raw);
  const name = extractName(raw);
  const brand = extractBrand(raw) || "Unknown";
  const currency = extractCurrency(raw);
  const amount = extractPriceAmount(raw);
  const price = MoneyV0Schema.parse({ currency, amount });
  const availability = extractAvailability(raw);
  const availabilityByMarket = AvailabilityByMarketV0Schema.parse({ US: availability });

  const imageUrl = extractImageUrl(raw);
  const productUrl = extractProductUrl(raw);
  const purchaseEnabled = extractPurchaseEnabled(raw);

  const rawText = [
    name,
    raw.description,
    raw.product_type,
    raw.category,
    raw.vendor,
    raw.brand,
    Array.isArray(raw.tags) ? raw.tags.join(" ") : "",
  ]
    .map((v) => normalizeString(v))
    .filter(Boolean)
    .join(" | ");

  const tags = deriveTags(rawText);
  const undertoneFit = deriveUndertoneFit(rawText);
  const shadeDescriptor = deriveShadeDescriptor(raw, rawText);
  const priceTier = derivePriceTier(price);

  return {
    category,
    skuId: skuId || `${category}_unknown_sku`,
    ...(merchantId ? { merchantId } : {}),
    name: name || "Unknown product",
    brand,
    price,
    priceTier,
    imageUrl,
    productUrl,
    ...(purchaseEnabled != null ? { purchaseEnabled } : {}),
    availability,
    availabilityByMarket,
    tags,
    undertoneFit,
    shadeDescriptor,
    rawText,
    raw: sku,
  };
}
