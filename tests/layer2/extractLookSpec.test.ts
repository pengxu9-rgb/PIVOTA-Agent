import { extractLookSpec } from "../../src/layer2/extractLookSpec";
import { LookSpecV0Schema } from "../../src/layer2/schemas/lookSpecV0";
import { LlmError, LlmProvider } from "../../src/llm/provider";

function sampleCore() {
  return {
    lookTitle: "Soft everyday look",
    styleTags: ["soft", "clean"],
    breakdown: {
      base: { intent: "natural skin-like base", finish: "satin", coverage: "light-medium", keyNotes: [], evidence: ["ref.image"] },
      eye: { intent: "soft lifted eye", finish: "matte", coverage: "sheer-buildable", keyNotes: [], evidence: ["ref.image"] },
      lip: { intent: "balanced lip", finish: "gloss", coverage: "sheer", keyNotes: [], evidence: ["ref.image"] },
    },
    warnings: [],
  };
}

describe("extractLookSpec (Layer2, US)", () => {
  test("returns a LookSpecV0 that validates", async () => {
    const provider: LlmProvider = {
      analyzeImageToJson: async ({ schema }) => schema.parse(sampleCore()),
      analyzeTextToJson: async () => {
        throw new Error("not used");
      },
    };

    const out = await extractLookSpec({
      market: "US",
      locale: "en",
      referenceImage: { kind: "url", url: "https://example.com/ref.jpg" },
      provider,
    });

    const validated = LookSpecV0Schema.parse(out);
    expect(validated.market).toBe("US");
    expect(validated.layer2EngineVersion).toBe("l2-us-0.1.0");
  });

  test("falls back to unknown on provider failure", async () => {
    const provider: LlmProvider = {
      analyzeImageToJson: async () => {
        throw new LlmError("LLM_PARSE_FAILED", "Model output is not JSON");
      },
      analyzeTextToJson: async () => {
        throw new Error("not used");
      },
    };

    const out = await extractLookSpec({
      market: "US",
      locale: "en",
      referenceImage: { kind: "url", url: "https://example.com/ref.jpg" },
      provider,
    });

    expect(out.lookTitle).toBe("unknown");
    expect(out.warnings?.[0]).toContain("LLM_PARSE_FAILED");
    LookSpecV0Schema.parse(out);
  });
});
