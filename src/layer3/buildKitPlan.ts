import { z } from "zod";
import { LookSpecV0 } from "../layer2/schemas/lookSpecV0";
import { KitPlanV0, KitPlanV0Schema } from "./schemas/kitPlanV0";
import { ProductAttributesV0, ProductAttributesV0Schema, ProductCategorySchema } from "./schemas/productAttributesV0";
import { getCandidates, CandidatesByCategory, RawSkuCandidate } from "./retrieval/getCandidates";
import { normalizeSkuToAttributes } from "./normalize/normalizeSkuToAttributes";
import { rankCandidates } from "./ranking/rankCandidates";
import { buildWhyThis } from "./copy/whyThis";

function makePlaceholder(input: {
  category: z.infer<typeof ProductCategorySchema>;
  locale: string;
  kind: "best" | "dupe";
  lookSpec: LookSpecV0;
  reason: string;
}): ProductAttributesV0 {
  const { category, locale, kind, lookSpec, reason } = input;
  const area = lookSpec.breakdown[category];
  const whyThis = `No catalog match found (${reason}). Placeholder for ${category} to target ${area.finish} finish and ${area.coverage} coverage.`;
  return ProductAttributesV0Schema.parse({
    schemaVersion: "v0",
    market: "US",
    locale,
    layer2EngineVersion: "l2-us-0.1.0",
    layer3EngineVersion: "l3-us-0.1.0",
    orchestratorVersion: "orchestrator-us-0.1.0",
    category,
    skuId: `placeholder_${category}_${kind}`,
    name: `Placeholder ${category} (${kind})`,
    brand: "Unknown",
    price: { currency: "USD", amount: 0 },
    priceTier: "unknown",
    imageUrl: undefined,
    productUrl: undefined,
    availability: "unknown",
    availabilityByMarket: { US: "unknown" },
    tags: { finish: [], texture: [], coverage: [], effect: [] },
    undertoneFit: "unknown",
    shadeDescriptor: undefined,
    whyThis,
    evidence: [
      `lookSpec.breakdown.${category}.finish`,
      `lookSpec.breakdown.${category}.coverage`,
      "product.priceTier",
      "product.availabilityByMarket.US",
    ],
  });
}

function toProductAttributes(input: {
  locale: string;
  lookSpec: LookSpecV0;
  normalized: ReturnType<typeof normalizeSkuToAttributes>;
  category: z.infer<typeof ProductCategorySchema>;
  additionalWarnings: string[];
}): ProductAttributesV0 {
  const { normalized, category, locale, lookSpec, additionalWarnings } = input;
  const { whyThis, evidence } = buildWhyThis({ category, candidate: normalized, lookSpec });

  const product = ProductAttributesV0Schema.parse({
    schemaVersion: "v0",
    market: "US",
    locale,
    layer2EngineVersion: "l2-us-0.1.0",
    layer3EngineVersion: "l3-us-0.1.0",
    orchestratorVersion: "orchestrator-us-0.1.0",
    category,
    skuId: normalized.skuId,
    name: normalized.name,
    brand: normalized.brand,
    price: normalized.price,
    priceTier: normalized.priceTier,
    imageUrl: normalized.imageUrl,
    productUrl: normalized.productUrl,
    availability: normalized.availability,
    availabilityByMarket: normalized.availabilityByMarket,
    tags: normalized.tags,
    undertoneFit: normalized.undertoneFit,
    shadeDescriptor: normalized.shadeDescriptor,
    whyThis,
    evidence,
  });

  if (additionalWarnings.length) {
    // Do not mutate schema; warnings live on KitPlanV0.
    return product;
  }
  return product;
}

export async function buildKitPlan(input: {
  market: "US";
  locale: string;
  lookSpec: LookSpecV0;
  candidatesByCategory?: CandidatesByCategory;
  limitPerCategory?: number;
}): Promise<KitPlanV0> {
  const { market, locale, lookSpec } = input;
  if (market !== "US") {
    throw new Error("MARKET_NOT_SUPPORTED");
  }

  const warnings: string[] = [];
  const candidatesByCategory =
    input.candidatesByCategory ??
    (await getCandidates({
      market,
      locale,
      lookSpec,
      limitPerCategory: input.limitPerCategory,
    }));

  function buildArea(category: z.infer<typeof ProductCategorySchema>, rawCandidates: RawSkuCandidate[]) {
    if (!rawCandidates.length) {
      warnings.push(`NO_CANDIDATES:${category}`);
      return {
        best: makePlaceholder({ category, locale, kind: "best", lookSpec, reason: "NO_CANDIDATES" }),
        dupe: makePlaceholder({ category, locale, kind: "dupe", lookSpec, reason: "NO_CANDIDATES" }),
      };
    }

    const normalized = rawCandidates
      .map((sku) =>
        normalizeSkuToAttributes({
          market,
          locale,
          category,
          sku,
        })
      )
      .filter(Boolean);

    const ranked = rankCandidates({ category, lookSpec, candidates: normalized });
    for (const w of ranked.warnings) warnings.push(`${w}:${category}`);

    const best =
      ranked.best ??
      normalizeSkuToAttributes({
        market,
        locale,
        category,
        sku: rawCandidates[0],
      });
    const dupe =
      ranked.dupe ??
      normalizeSkuToAttributes({
        market,
        locale,
        category,
        sku: rawCandidates[Math.min(1, rawCandidates.length - 1)],
      });

    return {
      best: toProductAttributes({ locale, lookSpec, normalized: best, category, additionalWarnings: ranked.warnings }),
      dupe: toProductAttributes({ locale, lookSpec, normalized: dupe, category, additionalWarnings: ranked.warnings }),
    };
  }

  const kit = {
    base: buildArea("base", candidatesByCategory.base || []),
    eye: buildArea("eye", candidatesByCategory.eye || []),
    lip: buildArea("lip", candidatesByCategory.lip || []),
  };

  const result: KitPlanV0 = KitPlanV0Schema.parse({
    schemaVersion: "v0",
    market: "US",
    locale,
    layer2EngineVersion: "l2-us-0.1.0",
    layer3EngineVersion: "l3-us-0.1.0",
    orchestratorVersion: "orchestrator-us-0.1.0",
    kit,
    ...(warnings.length ? { warnings } : {}),
  });

  return result;
}
