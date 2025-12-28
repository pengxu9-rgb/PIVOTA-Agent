import { describe, expect, it } from "@jest/globals";
import { buildKitPlan } from "../../src/layer3/buildKitPlan";
import { LookSpecV0Schema } from "../../src/layer2/schemas/lookSpecV0";

function makeLookSpec() {
  return LookSpecV0Schema.parse({
    schemaVersion: "v0",
    market: "US",
    locale: "en",
    layer2EngineVersion: "l2-us-0.1.0",
    layer3EngineVersion: "l3-us-0.1.0",
    orchestratorVersion: "orchestrator-us-0.1.0",
    lookTitle: "Soft matte brown look",
    styleTags: ["soft", "natural"],
    breakdown: {
      base: {
        intent: "Even, natural base",
        finish: "soft-matte",
        coverage: "medium",
        keyNotes: ["thin layers", "set T-zone"],
        evidence: ["ref.image"],
      },
      eye: {
        intent: "Lifted outer corner",
        finish: "matte",
        coverage: "medium",
        keyNotes: ["soft brown", "short wing"],
        evidence: ["ref.image"],
      },
      lip: {
        intent: "Natural lip",
        finish: "sheer",
        coverage: "light",
        keyNotes: ["rose beige"],
        evidence: ["ref.image"],
      },
    },
  });
}

describe("Layer3 KitPlanV0", () => {
  it("returns base/eye/lip with best+dupe and grounded whyThis", async () => {
    const lookSpec = makeLookSpec();

    const result = await buildKitPlan({
      market: "US",
      locale: "en",
      lookSpec,
      candidatesByCategory: {
        base: [
          {
            sku_id: "sku_base_best",
            title: "Soft Matte Foundation",
            description: "Soft matte medium coverage foundation. Buildable, long-wear.",
            vendor: "Brand A",
            price: 32,
            currency: "USD",
            image_url: "https://example.com/base-best.jpg",
            url: "https://example.com/base-best",
            in_stock: true,
          },
          {
            sku_id: "sku_base_dupe",
            title: "Matte Foundation Budget",
            description: "Matte medium coverage foundation. Buildable.",
            vendor: "Brand B",
            price: 12,
            currency: "USD",
            image_url: "https://example.com/base-dupe.jpg",
            url: "https://example.com/base-dupe",
            in_stock: true,
          },
        ],
        eye: [
          {
            sku_id: "sku_eye_best",
            title: "Brown Eyeliner Pen",
            description: "Smudge-proof, waterproof brown eyeliner pen. Matte finish.",
            vendor: "Brand C",
            price: 24,
            currency: "USD",
            image_url: "https://example.com/eye-best.jpg",
            url: "https://example.com/eye-best",
            in_stock: true,
          },
          {
            sku_id: "sku_eye_dupe",
            title: "Brown Liner Budget",
            description: "Smudge-proof brown eyeliner. Matte.",
            vendor: "Brand D",
            price: 9,
            currency: "USD",
            image_url: "https://example.com/eye-dupe.jpg",
            url: "https://example.com/eye-dupe",
            in_stock: true,
          },
        ],
        lip: [
          {
            sku_id: "sku_lip_best",
            title: "Rose Beige Lip Tint",
            description: "Sheer finish lip tint in rose beige. Hydrating.",
            vendor: "Brand E",
            price: 22,
            currency: "USD",
            image_url: "https://example.com/lip-best.jpg",
            url: "https://example.com/lip-best",
            in_stock: true,
          },
          {
            sku_id: "sku_lip_dupe",
            title: "Rose Beige Lip Balm",
            description: "Sheer lip balm, rose beige.",
            vendor: "Brand F",
            price: 6,
            currency: "USD",
            image_url: "https://example.com/lip-dupe.jpg",
            url: "https://example.com/lip-dupe",
            in_stock: true,
          },
        ],
      },
    });

    expect(result.market).toBe("US");
    expect(result.kit.base.best.category).toBe("base");
    expect(result.kit.eye.best.category).toBe("eye");
    expect(result.kit.lip.best.category).toBe("lip");

    expect(result.kit.base.best.price.amount).toBeGreaterThanOrEqual(result.kit.base.dupe.price.amount);
    expect(result.kit.eye.best.price.amount).toBeGreaterThanOrEqual(result.kit.eye.dupe.price.amount);
    expect(result.kit.lip.best.price.amount).toBeGreaterThanOrEqual(result.kit.lip.dupe.price.amount);

    expect(result.kit.base.best.whyThis).toContain("soft-matte");
    expect(result.kit.base.best.whyThis).toContain("medium");
    expect(result.kit.eye.best.evidence.length).toBeGreaterThan(0);
    expect(result.kit.lip.dupe.evidence.length).toBeGreaterThan(0);
  });

  it("adds a warning when dupe is not cheaper", async () => {
    const lookSpec = makeLookSpec();
    const result = await buildKitPlan({
      market: "US",
      locale: "en",
      lookSpec,
      candidatesByCategory: {
        base: [
          {
            sku_id: "sku_base_best",
            title: "Soft Matte Foundation",
            // Include key notes from LookSpec so this is a stronger match despite being cheaper.
            description: "Soft matte medium coverage foundation. Thin layers, set T-zone. Buildable, long-wear.",
            vendor: "Brand A",
            price: 10,
            currency: "USD",
            in_stock: true,
          },
          {
            sku_id: "sku_base_dupe",
            title: "Soft Matte Foundation (higher price)",
            // Still a close match, but more expensive than the "best" to trigger the warning.
            description: "Soft matte medium coverage foundation. Thin layers.",
            vendor: "Brand B",
            price: 20,
            currency: "USD",
            in_stock: true,
          },
        ],
        eye: [],
        lip: [],
      },
    });

    expect(result.warnings || []).toContain("DUPE_NOT_CHEAPER:base");
  });

  it("returns placeholders + warnings when a category has no candidates", async () => {
    const envBackup = process.env.LAYER3_TRIGGER_MATCH_DEBUG;
    const lookSpec = makeLookSpec();
    try {
      process.env.LAYER3_TRIGGER_MATCH_DEBUG = "1";
      const result = await buildKitPlan({
        market: "US",
        locale: "en",
        lookSpec,
        candidatesByCategory: { base: [], eye: [], lip: [] },
      });

      expect(result.warnings || []).toContain("NO_CANDIDATES market=US category=base candidates=0");
      expect(result.kit.base.best.skuId).toContain("placeholder_base_best");
    } finally {
      if (envBackup == null) delete process.env.LAYER3_TRIGGER_MATCH_DEBUG;
      else process.env.LAYER3_TRIGGER_MATCH_DEBUG = envBackup;
    }
  });
});
