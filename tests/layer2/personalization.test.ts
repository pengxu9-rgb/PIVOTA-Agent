import { z } from "zod";

import { generateAdjustments } from "../../src/layer2/personalization/generateAdjustments";
import { generateSteps } from "../../src/layer2/personalization/generateSteps";
import { LookSpecV0Schema } from "../../src/layer2/schemas/lookSpecV0";
import { LlmProvider } from "../../src/llm/provider";

function sampleFaceProfile(source: "selfie" | "reference") {
  return {
    version: "v0",
    market: "US",
    source,
    locale: "en",
    quality: {
      valid: true,
      score: 95,
      faceCount: 1,
      lightingScore: 80,
      sharpnessScore: 90,
      pose: { yawDeg: 0, pitchDeg: 0, rollDeg: 0 },
      occlusionFlags: { eyesOccluded: false, mouthOccluded: false, faceBorderCutoff: false },
      rejectReasons: [],
    },
    geometry: {
      faceAspect: 1.0,
      jawToCheekRatio: 0.75,
      chinLengthRatio: 0.22,
      midfaceRatio: 0.4,
      eyeSpacingRatio: 0.29,
      eyeTiltDeg: 2,
      eyeOpennessRatio: 0.28,
      lipFullnessRatio: 0.26,
    },
    categorical: { faceShape: "oval", eyeType: "almond", lipType: "balanced" },
    derived: { geometryVector: [1.0, 0.75, 0.22, 0.4, 0.29, 2, 0.28, 0.26], embeddingVersion: "geom-v0" },
  };
}

function sampleLookSpec() {
  return LookSpecV0Schema.parse({
    schemaVersion: "v0",
    market: "US",
    locale: "en",
    layer2EngineVersion: "l2-us-0.1.0",
    layer3EngineVersion: "l3-us-0.1.0",
    orchestratorVersion: "orchestrator-us-0.1.0",
    lookTitle: "Soft everyday look",
    styleTags: ["soft"],
    breakdown: {
      base: { intent: "natural base", finish: "satin", coverage: "light-medium", keyNotes: ["thin base"], evidence: ["ref.image"] },
      eye: { intent: "soft lifted", finish: "matte", coverage: "sheer-buildable", keyNotes: ["outer third focus"], evidence: ["ref.image"] },
      lip: { intent: "balanced lip", finish: "gloss", coverage: "sheer", keyNotes: ["close shade family"], evidence: ["ref.image"] },
    },
    warnings: [],
  });
}

describe("Layer2 personalization generation", () => {
  test("always returns exactly 3 adjustments with evidence", async () => {
    const provider: LlmProvider = {
      analyzeImageToJson: async () => {
        throw new Error("not used");
      },
      analyzeTextToJson: async <TSchema extends z.ZodTypeAny>({ schema }: { schema: TSchema }) =>
        schema.parse({
          adjustments: [
            {
              impactArea: "base",
              ruleId: "BASE_FALLBACK_THIN_LAYER",
              title: "Keep base thin",
              because: "A thin base keeps the finish aligned with the reference.",
              do: "Apply a light layer first.",
              why: "Thin layers are more forgiving.",
              confidence: "low",
              evidence: ["lookSpec.breakdown.base.finish"],
            },
            {
              impactArea: "eye",
              ruleId: "EYE_FALLBACK_SAFE_CONTROL",
              title: "Control liner safely",
              because: "Liner direction affects eye emphasis.",
              do: "Start liner at the outer third and keep it thin.",
              why: "A thin, short wing is forgiving.",
              confidence: "low",
              evidence: ["lookSpec.breakdown.eye.intent"],
            },
            {
              impactArea: "lip",
              ruleId: "LIP_FALLBACK_FINISH_FOCUS",
              title: "Match lip finish",
              because: "Finish carries the lip mood.",
              do: "Match the reference finish and stay in a close shade family.",
              why: "Finish is more reliable than exact shape tweaks.",
              confidence: "low",
              evidence: ["lookSpec.breakdown.lip.finish"],
            },
          ],
        }) as z.infer<TSchema>,
    };

    const out = await generateAdjustments({
      market: "US",
      locale: "en",
      userFaceProfile: null,
      refFaceProfile: sampleFaceProfile("reference"),
      similarityReport: null,
      lookSpec: sampleLookSpec(),
      provider,
    });

    expect(out.adjustments).toHaveLength(3);
    for (const a of out.adjustments) {
      expect(a.evidence.length).toBeGreaterThan(0);
    }
  });

  test("returns 8-12 steps with evidence", async () => {
    const provider: LlmProvider = {
      analyzeImageToJson: async () => {
        throw new Error("not used");
      },
      analyzeTextToJson: async <TSchema extends z.ZodTypeAny>({ schema }: { schema: TSchema }) =>
        schema.parse({
          steps: Array.from({ length: 8 }).map((_, i) => ({
            impactArea: i < 3 ? "base" : i < 6 ? "eye" : "lip",
            title: `Step ${i}`,
            instruction: "Do the thing.",
            tips: [],
            cautions: [],
            fitConditions: [],
            evidence: ["lookSpec.breakdown.base.intent"],
          })),
          warnings: [],
        }) as z.infer<TSchema>,
    };

    const adjustments = [
      {
        impactArea: "base" as const,
        ruleId: "BASE_FALLBACK_THIN_LAYER",
        title: "Keep base thin",
        because: "Because",
        do: "Do",
        why: "Why",
        confidence: "low" as const,
        evidence: ["x"],
      },
      {
        impactArea: "eye" as const,
        ruleId: "EYE_FALLBACK_SAFE_CONTROL",
        title: "Control liner",
        because: "Because",
        do: "Do",
        why: "Why",
        confidence: "low" as const,
        evidence: ["x"],
      },
      {
        impactArea: "lip" as const,
        ruleId: "LIP_FALLBACK_FINISH_FOCUS",
        title: "Match finish",
        because: "Because",
        do: "Do",
        why: "Why",
        confidence: "low" as const,
        evidence: ["x"],
      },
    ];

    const out = await generateSteps({
      market: "US",
      locale: "en",
      lookSpec: sampleLookSpec(),
      adjustments,
      userFaceProfile: null,
      provider,
    });

    expect(out.steps.length).toBeGreaterThanOrEqual(8);
    expect(out.steps.length).toBeLessThanOrEqual(12);
    for (const s of out.steps) {
      expect(s.evidence.length).toBeGreaterThan(0);
    }
  });
});
