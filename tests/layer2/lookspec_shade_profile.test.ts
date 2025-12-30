import { LookSpecV0Schema } from "../../src/layer2/schemas/lookSpecV0";
import { normalizeLookSpecToV1 } from "../../src/layer2/schemas/lookSpecV1";

function sampleLookSpecV0WithoutShade() {
  return {
    schemaVersion: "v0" as const,
    market: "US" as const,
    locale: "en",
    layer2EngineVersion: "l2-us-0.1.0" as const,
    layer3EngineVersion: "l3-us-0.1.0" as const,
    orchestratorVersion: "orchestrator-us-0.1.0" as const,
    lookTitle: "Soft everyday look",
    styleTags: ["soft", "clean"],
    breakdown: {
      base: { intent: "natural base", finish: "satin", coverage: "light-medium" },
      eye: { intent: "soft lifted eye", finish: "matte", coverage: "sheer-buildable" },
      lip: { intent: "balanced lip", finish: "gloss", coverage: "sheer" },
    },
    warnings: [],
  };
}

describe("LookSpec shade profile defaults", () => {
  test("LookSpecV0Schema defaults shade when missing", () => {
    const validated = LookSpecV0Schema.parse(sampleLookSpecV0WithoutShade());

    expect(validated.breakdown.base.shade).toEqual({
      hueFamily: "unknown",
      temperature: "unknown",
      undertone: "unknown",
      depth: "unknown",
      saturation: "unknown",
      keyColors: [],
      notes: [],
    });
  });

  test("normalizeLookSpecToV1 keeps shade defaults", () => {
    const v1 = normalizeLookSpecToV1(sampleLookSpecV0WithoutShade());

    expect(v1.schemaVersion).toBe("v1");
    expect(v1.breakdown.lip.shade.depth).toBe("unknown");
    expect(v1.breakdown.eye.shade.keyColors).toEqual([]);
  });
});

