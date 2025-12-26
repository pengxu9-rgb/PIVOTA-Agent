import { LookSpecV0Schema } from "../../src/layer2/schemas/lookSpecV0";
import { StepPlanV0Schema } from "../../src/layer2/schemas/stepPlanV0";
import { ProductAttributesV0Schema } from "../../src/layer3/schemas/productAttributesV0";
import { KitPlanV0Schema } from "../../src/layer3/schemas/kitPlanV0";
import { LookReplicateResultV0Schema } from "../../src/schemas/lookReplicateResultV0";

function baseMeta() {
  return {
    schemaVersion: "v0" as const,
    market: "US" as const,
    locale: "en",
    layer2EngineVersion: "l2-us-0.1.0" as const,
    layer3EngineVersion: "l3-us-0.1.0" as const,
    orchestratorVersion: "orchestrator-us-0.1.0" as const,
  };
}

function sampleBreakdown() {
  return {
    base: { intent: "natural skin-like base", finish: "satin", coverage: "light-medium", keyNotes: ["keep texture"], evidence: ["ref.image"] },
    eye: { intent: "soft lifted eye", finish: "matte", coverage: "sheer-buildable", keyNotes: ["outer third focus"], evidence: ["ref.image"] },
    lip: { intent: "balanced lip", finish: "gloss", coverage: "sheer", keyNotes: ["close shade family"], evidence: ["ref.image"] },
  };
}

function sampleStep(order: number, impactArea: "base" | "eye" | "lip") {
  return StepPlanV0Schema.parse({
    ...baseMeta(),
    stepId: `s_${order}`,
    order,
    impactArea,
    title: `Step ${order}`,
    instruction: "Do the thing.",
    tips: [],
    cautions: [],
    fitConditions: [],
    evidence: ["layer1.adjustment"],
  });
}

function sampleProduct(skuId: string, category: "base" | "eye" | "lip") {
  return ProductAttributesV0Schema.parse({
    ...baseMeta(),
    category,
    skuId,
    name: "Example Product",
    brand: "Example Brand",
    price: { currency: "USD", amount: 19.99 },
    priceTier: "mid",
    imageUrl: "https://example.com/p.png",
    productUrl: "https://example.com/p",
    availability: "in_stock",
    availabilityByMarket: { US: "in_stock" },
    tags: { finish: ["satin"], texture: ["cream"], coverage: ["medium"], effect: ["long-wear"] },
    undertoneFit: "neutral",
    shadeDescriptor: "neutral beige",
    whyThis: "Matches the target finish.",
    evidence: ["catalog.match.finish"],
  });
}

describe("Layer2/3 contract schemas (US v0)", () => {
  test("LookSpecV0 validates", () => {
    const lookSpec = LookSpecV0Schema.parse({
      ...baseMeta(),
      lookTitle: "Soft everyday look",
      styleTags: ["soft", "clean"],
      breakdown: sampleBreakdown(),
      warnings: [],
    });

    expect(lookSpec.market).toBe("US");
  });

  test("KitPlanV0 validates", () => {
    const kit = KitPlanV0Schema.parse({
      ...baseMeta(),
      kit: {
        base: { best: sampleProduct("sku_base_best", "base"), dupe: sampleProduct("sku_base_dupe", "base") },
        eye: { best: sampleProduct("sku_eye_best", "eye"), dupe: sampleProduct("sku_eye_dupe", "eye") },
        lip: { best: sampleProduct("sku_lip_best", "lip"), dupe: sampleProduct("sku_lip_dupe", "lip") },
      },
    });

    expect(kit.kit.base.best.skuId).toBe("sku_base_best");
  });

  test("LookReplicateResultV0 validates invariants", () => {
    const steps = [
      sampleStep(0, "base"),
      sampleStep(1, "base"),
      sampleStep(2, "base"),
      sampleStep(3, "eye"),
      sampleStep(4, "eye"),
      sampleStep(5, "eye"),
      sampleStep(6, "lip"),
      sampleStep(7, "lip"),
    ];

    const result = LookReplicateResultV0Schema.parse({
      ...baseMeta(),
      breakdown: sampleBreakdown(),
      adjustments: [
        {
          impactArea: "base",
          title: "Keep base thin",
          because: "Finish matches better with a thin base.",
          do: "Apply a thin layer and spot conceal.",
          why: "Preserves texture and reduces mismatch risk.",
          evidence: ["layer1.similarityReport.adjustments[base]"],
          confidence: "high",
        },
        {
          impactArea: "eye",
          title: "Control liner direction",
          because: "Direction affects the perceived lift.",
          do: "Start from outer third and keep the wing short.",
          why: "Safer for matching the reference angle.",
          evidence: ["layer1.similarityReport.adjustments[eye]"],
          confidence: "high",
        },
        {
          impactArea: "lip",
          title: "Match finish",
          because: "Finish drives the lip mood.",
          do: "Match gloss vs satin and stay in a close shade family.",
          why: "More reliable than chasing exact lip shape.",
          evidence: ["layer1.similarityReport.adjustments[lip]"],
          confidence: "high",
        },
      ],
      steps,
      kit: {
        ...baseMeta(),
        kit: {
          base: { best: sampleProduct("sku_base_best", "base"), dupe: sampleProduct("sku_base_dupe", "base") },
          eye: { best: sampleProduct("sku_eye_best", "eye"), dupe: sampleProduct("sku_eye_dupe", "eye") },
          lip: { best: sampleProduct("sku_lip_best", "lip"), dupe: sampleProduct("sku_lip_dupe", "lip") },
        },
      },
      warnings: ["Example warning"],
      share: { shareId: "share_123", canonicalUrl: "https://example.com/share/share_123" },
    });

    expect(result.adjustments).toHaveLength(3);
    expect(result.steps.length).toBeGreaterThanOrEqual(8);
    expect(result.steps.length).toBeLessThanOrEqual(12);
  });
});
