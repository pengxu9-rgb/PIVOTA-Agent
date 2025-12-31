import axios from "axios";
import { z } from "zod";
import { LookSpecV0 } from "../../layer2/schemas/lookSpecV0";
import { ProductCategorySchema } from "../schemas/productAttributesV0";

const PIVOTA_API_BASE = (process.env.PIVOTA_API_BASE || "http://localhost:8080").replace(/\/$/, "");
const PIVOTA_API_KEY = process.env.PIVOTA_API_KEY || "";
const API_MODE = process.env.API_MODE || (PIVOTA_API_KEY ? "REAL" : "MOCK");

export type RawSkuCandidate = Record<string, unknown>;

export type CandidatesByCategory = Partial<Record<z.infer<typeof ProductCategorySchema>, RawSkuCandidate[]>>;

function normalizeString(v: unknown): string {
  return String(v ?? "").trim();
}

function buildQueryForCategory(category: z.infer<typeof ProductCategorySchema>, lookSpec: LookSpecV0): string {
  const area = lookSpec.breakdown[category];
  const base = [normalizeString(area.finish), normalizeString(area.coverage), ...(area.keyNotes || [])].filter(Boolean);

  const anchors: Record<z.infer<typeof ProductCategorySchema>, string[]> = {
    prep: ["primer", "setting spray", "prep"],
    base: ["foundation", "concealer", "setting powder", "skin tint", "bb cream"],
    contour: ["contour", "bronzer", "sculpt"],
    brow: ["brow pencil", "brow gel", "eyebrow"],
    eye: ["eyeliner", "mascara", "eyeshadow", "eye palette"],
    blush: ["blush", "cheek tint", "cheek"],
    lip: ["lipstick", "lip gloss", "lip liner", "lip tint", "lip balm"],
  };

  const tokens = [...anchors[category], ...base]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return tokens || anchors[category][0];
}

function productText(p: Record<string, unknown>): string {
  return [
    p.title,
    p.name,
    p.description,
    p.product_type,
    p.category,
    p.vendor,
    p.brand,
    Array.isArray(p.tags) ? p.tags.join(" ") : "",
  ]
    .map((v) => normalizeString(v).toLowerCase())
    .filter(Boolean)
    .join(" ");
}

function matchesCategory(category: z.infer<typeof ProductCategorySchema>, p: Record<string, unknown>): boolean {
  const text = productText(p);
  const keywords: Record<z.infer<typeof ProductCategorySchema>, string[]> = {
    prep: ["primer", "priming", "setting spray", "setting mist", "grip", "pore"],
    base: ["foundation", "concealer", "powder", "skin tint", "tint", "bb", "cc"],
    contour: ["contour", "bronzer", "sculpt"],
    brow: ["brow", "brows", "eyebrow", "pomade", "brow pencil", "brow gel"],
    eye: ["eyeliner", "liner", "mascara", "eyeshadow", "palette", "kohl", "kajal"],
    blush: ["blush", "cheek", "cheeks"],
    lip: ["lipstick", "lip gloss", "gloss", "lip liner", "lip tint", "lip balm", "lip oil", "lip stain"],
  };

  return keywords[category].some((k) => text.includes(k));
}

function explodeVariantsToSkus(product: Record<string, unknown>): RawSkuCandidate[] {
  const variants = product.variants;
  if (Array.isArray(variants) && variants.length) {
    const productTitle = normalizeString((product as any).productTitle ?? (product as any).product_title ?? (product as any).title ?? (product as any).name);
    return variants
      .filter((v) => v && typeof v === "object")
      .map((v) => {
        const variantTitle = normalizeString((v as any).variantTitle ?? (v as any).variant_title ?? (v as any).title ?? (v as any).name);
        const isDefaultVariantTitle = variantTitle.toLowerCase() === "default title";
        const displayTitle =
          productTitle && variantTitle && !isDefaultVariantTitle && variantTitle !== productTitle
            ? `${productTitle} - ${variantTitle}`
            : productTitle || variantTitle;

        return {
          ...product,
          ...(v as Record<string, unknown>),
          productTitle,
          product_title: productTitle,
          variantTitle,
          variant_title: variantTitle,
          ...(displayTitle ? { title: displayTitle } : {}),
          // Keep explicit product link / image on variant if missing.
          productUrl: (v as any).productUrl ?? (product as any).productUrl ?? (product as any).url,
          imageUrl: (v as any).imageUrl ?? (product as any).imageUrl ?? (product as any).image_url,
        };
      });
  }
  return [product];
}

export async function getCandidates(input: {
  market: "US";
  locale: string;
  lookSpec: LookSpecV0;
  limitPerCategory?: number;
  fetcher?: (args: { query: string; limit: number }) => Promise<RawSkuCandidate[]>;
}): Promise<CandidatesByCategory> {
  const { lookSpec } = input;
  const limitPerCategory = input.limitPerCategory ?? 80;

  const fetcher: (args: { query: string; limit: number }) => Promise<RawSkuCandidate[]> =
    input.fetcher ??
    (async ({ query, limit }) => {
      if (API_MODE === "MOCK") return [];

      const payload = {
        operation: "find_products_multi",
        payload: {
          search: {
            query,
            category: null,
            price_min: null,
            price_max: null,
            page: 1,
            limit: Math.min(500, Math.max(1, limit)),
            in_stock_only: false,
          },
          metadata: {},
        },
        metadata: {
          source: "layer3-kit",
        },
      };

      const resp = await axios.post(`${PIVOTA_API_BASE}/agent/shop/v1/invoke`, payload, {
        headers: { "Content-Type": "application/json" },
        timeout: 15000,
      });

      const products: unknown[] = Array.isArray(resp.data?.products) ? resp.data.products : [];
      return products.filter((p: unknown): p is RawSkuCandidate => !!p && typeof p === "object");
    });

  const categories = ProductCategorySchema.options;
  const results: Partial<CandidatesByCategory> = {};

  await Promise.all(
    categories.map(async (category) => {
      const query = buildQueryForCategory(category, lookSpec);
      const products = await fetcher({ query, limit: limitPerCategory });
      const expanded = products.flatMap((p: RawSkuCandidate) => explodeVariantsToSkus(p));
      const filtered = expanded.filter((p: RawSkuCandidate) => matchesCategory(category, p));
      results[category] = filtered.slice(0, limitPerCategory);
    })
  );

  return results as CandidatesByCategory;
}
