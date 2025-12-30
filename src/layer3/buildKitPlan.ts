import { z } from "zod";

import { LookSpecV0 } from "../layer2/schemas/lookSpecV0";

import { KitPlanV0, KitPlanV0Schema } from "./schemas/kitPlanV0";
import { ProductAttributesV0, ProductAttributesV0Schema, ProductCategorySchema } from "./schemas/productAttributesV0";

import { getCandidates, CandidatesByCategory, RawSkuCandidate } from "./retrieval/getCandidates";
import { normalizeSkuToAttributes } from "./normalize/normalizeSkuToAttributes";
import { rankCandidates } from "./ranking/rankCandidates";
import { buildWhyThis } from "./copy/whyThis";

type Market = "US" | "JP";

function engineVersionFor(market: Market) {
  const m = String(market || "US").toLowerCase();
  return {
    layer2: `l2-${m}-0.1.0`,
    layer3: `l3-${m}-0.1.0`,
    orchestrator: `orchestrator-${m}-0.1.0`,
  };
}

function makePlaceholder(input: {
  market: Market;
  category: z.infer<typeof ProductCategorySchema>;
  locale: string;
  kind: "best" | "dupe";
  lookSpec: LookSpecV0;
  reason: string;
  purchaseEnabled?: boolean;
}): ProductAttributesV0 {
  const { market, category, locale, kind, lookSpec, reason, purchaseEnabled } = input;
  const area = lookSpec.breakdown[category];
  const whyThis = `No catalog match found (${reason}). Placeholder for ${category} to target ${area.finish} finish and ${area.coverage} coverage.`;
  const versions = engineVersionFor(market);

  return ProductAttributesV0Schema.parse({
    schemaVersion: "v0",
    market,
    locale,
    layer2EngineVersion: versions.layer2 as any,
    layer3EngineVersion: versions.layer3 as any,
    orchestratorVersion: versions.orchestrator as any,
    category,
    skuId: `placeholder_${category}_${kind}`,
    name: `Placeholder ${category} (${kind})`,
    brand: "Unknown",
    price: { currency: market === "JP" ? "JPY" : "USD", amount: 0 },
    priceTier: "unknown",
    imageUrl: undefined,
    productUrl: undefined,
    availability: "unknown",
    availabilityByMarket: market === "US" ? { US: "unknown" } : { JP: "unknown" },
    tags: { finish: [], texture: [], coverage: [], effect: [] },
    undertoneFit: "unknown",
    shadeDescriptor: undefined,
    whyThis,
    evidence: [
      `lookSpec.breakdown.${category}.finish`,
      `lookSpec.breakdown.${category}.coverage`,
      "product.priceTier",
      market === "US" ? "product.availabilityByMarket.US" : "product.availabilityByMarket.JP",
    ],
    ...(purchaseEnabled != null ? { purchaseEnabled } : {}),
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
    return product;
  }
  return product;
}

export async function buildKitPlan(input: {
  market: Market;
  locale: string;
  lookSpec: LookSpecV0;
  commerceEnabled?: boolean;
  candidatesByCategory?: CandidatesByCategory;
  limitPerCategory?: number;
  userSignals?: Record<string, unknown> | null;
}): Promise<KitPlanV0> {
  const { market, locale, lookSpec } = input;
  if (market !== "US" && market !== "JP") throw new Error("MARKET_NOT_SUPPORTED");

  const versions = engineVersionFor(market);
  const debugTriggerMatch = String(process.env.LAYER3_TRIGGER_MATCH_DEBUG || "").trim() === "1";

  if (market === "JP") {
    if (input.commerceEnabled !== false) throw new Error("MARKET_NOT_SUPPORTED");

    const kit = {
      base: {
        best: makePlaceholder({ market, category: "base", locale, kind: "best", lookSpec, reason: "COMMERCE_DISABLED", purchaseEnabled: false }),
        dupe: makePlaceholder({ market, category: "base", locale, kind: "dupe", lookSpec, reason: "COMMERCE_DISABLED", purchaseEnabled: false }),
      },
      eye: {
        best: makePlaceholder({ market, category: "eye", locale, kind: "best", lookSpec, reason: "COMMERCE_DISABLED", purchaseEnabled: false }),
        dupe: makePlaceholder({ market, category: "eye", locale, kind: "dupe", lookSpec, reason: "COMMERCE_DISABLED", purchaseEnabled: false }),
      },
      lip: {
        best: makePlaceholder({ market, category: "lip", locale, kind: "best", lookSpec, reason: "COMMERCE_DISABLED", purchaseEnabled: false }),
        dupe: makePlaceholder({ market, category: "lip", locale, kind: "dupe", lookSpec, reason: "COMMERCE_DISABLED", purchaseEnabled: false }),
      },
    };

    return KitPlanV0Schema.parse({
      schemaVersion: "v0",
      market,
      locale,
      layer2EngineVersion: versions.layer2 as any,
      layer3EngineVersion: versions.layer3 as any,
      orchestratorVersion: versions.orchestrator as any,
      kit,
      warnings: ["COMMERCE_DISABLED:JP"],
    });
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
      if (debugTriggerMatch) warnings.push(`NO_CANDIDATES market=${market} category=${category} candidates=0`);
      return {
        best: makePlaceholder({ market, category, locale, kind: "best", lookSpec, reason: "NO_CANDIDATES" }),
        dupe: makePlaceholder({ market, category, locale, kind: "dupe", lookSpec, reason: "NO_CANDIDATES" }),
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

    const ranked = rankCandidates({ category, lookSpec, candidates: normalized, userSignals: input.userSignals ?? null });
    for (const w of ranked.warnings) {
      if (w === "NO_CANDIDATES") {
        if (debugTriggerMatch) warnings.push(`NO_CANDIDATES market=${market} category=${category} candidates=${normalized.length}`);
      } else {
        warnings.push(`${w}:${category}`);
      }
    }

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

  return KitPlanV0Schema.parse({
    schemaVersion: "v0",
    market,
    locale,
    layer2EngineVersion: versions.layer2 as any,
    layer3EngineVersion: versions.layer3 as any,
    orchestratorVersion: versions.orchestrator as any,
    kit,
    ...(warnings.length ? { warnings } : {}),
  });
}
