import fs from "fs";
import path from "path";
import { z } from "zod";

import { createProviderFromEnv, LlmProvider } from "../../llm/provider";
import { hintsFromLayer1 } from "./hintsFromLayer1";
import { LookSpecV0Schema } from "../schemas/lookSpecV0";

// Use the existing Layer1 JS schemas as runtime validators.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { FaceProfileV0Schema } = require("../../layer1/schemas/faceProfileV0");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SimilarityReportV0Schema } = require("../../layer1/schemas/similarityReportV0");

export const Layer2AdjustmentV0Schema = z
  .object({
    impactArea: z.enum(["base", "eye", "lip"]),
    title: z.string().min(1),
    because: z.string().min(1),
    do: z.string().min(1),
    confidence: z.enum(["high", "medium", "low"]),
    evidence: z.array(z.string().min(1)).min(1),
  })
  .strict();

export type Layer2AdjustmentV0 = z.infer<typeof Layer2AdjustmentV0Schema>;

const AdjustmentsCoreSchema = z
  .object({
    adjustments: z.array(Layer2AdjustmentV0Schema).min(1),
    warnings: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type GenerateAdjustmentsInput = {
  market: "US";
  locale: string;
  userFaceProfile?: unknown | null;
  refFaceProfile: unknown;
  similarityReport?: unknown | null;
  lookSpec: unknown;
  provider?: LlmProvider;
};

export type GenerateAdjustmentsOutput = {
  adjustments: [Layer2AdjustmentV0, Layer2AdjustmentV0, Layer2AdjustmentV0];
  warnings: string[];
};

let cachedPrompt: string | null = null;

function loadPrompt(): string {
  if (cachedPrompt) return cachedPrompt;
  const p = path.join(__dirname, "..", "prompts", "adjustments_generate_en.txt");
  cachedPrompt = fs.readFileSync(p, "utf8");
  return cachedPrompt;
}

function fallbackAdjustment(area: "base" | "eye" | "lip", lowConfidence: boolean): Layer2AdjustmentV0 {
  if (area === "base") {
    return {
      impactArea: "base",
      title: "Keep base thin",
      because: lowConfidence
        ? "To match the reference look reliably, a thin base preserves finish and texture."
        : "A thin base preserves finish and makes matching easier.",
      do: "Apply a light layer first, then spot-conceal only where needed and re-blend.",
      confidence: lowConfidence ? "low" : "medium",
      evidence: ["fallback:base", "lookSpec.breakdown.base.finish"],
    };
  }
  if (area === "eye") {
    return {
      impactArea: "eye",
      title: "Control liner direction",
      because: lowConfidence
        ? "To match the reference look, a shorter controlled wing is safer without exact geometry."
        : "Wing direction strongly affects the eye emphasis.",
      do: "Start liner from the outer third, keep the wing shorter, and connect back with a thin stroke.",
      confidence: lowConfidence ? "low" : "medium",
      evidence: ["fallback:eye", "lookSpec.breakdown.eye.intent"],
    };
  }
  return {
    impactArea: "lip",
    title: "Match lip finish",
    because: lowConfidence
      ? "To match the reference look, finish (gloss vs satin) is more reliable than chasing exact shape."
      : "Finish changes the lip mood more reliably than shape tweaks.",
    do: "Match gloss vs satin and stay in a close shade family; adjust intensity with a light blot if needed.",
    confidence: lowConfidence ? "low" : "medium",
    evidence: ["fallback:lip", "lookSpec.breakdown.lip.finish"],
  };
}

function ensureExactlyThree(
  candidate: Layer2AdjustmentV0[],
  lowConfidence: boolean,
  warnings: string[]
): [Layer2AdjustmentV0, Layer2AdjustmentV0, Layer2AdjustmentV0] {
  const byArea: Partial<Record<"base" | "eye" | "lip", Layer2AdjustmentV0>> = {};
  for (const a of candidate) {
    if (!a || typeof a !== "object") continue;
    if (a.impactArea !== "base" && a.impactArea !== "eye" && a.impactArea !== "lip") continue;
    if (!byArea[a.impactArea]) byArea[a.impactArea] = a;
  }

  const areas: Array<"base" | "eye" | "lip"> = ["base", "eye", "lip"];
  for (const area of areas) {
    if (!byArea[area]) {
      byArea[area] = fallbackAdjustment(area, lowConfidence);
      warnings.push(`Filled missing ${area} adjustment with fallback.`);
    }
  }

  const out: [Layer2AdjustmentV0, Layer2AdjustmentV0, Layer2AdjustmentV0] = [
    byArea.base!,
    byArea.eye!,
    byArea.lip!,
  ];

  // Enforce low confidence when selfie missing.
  if (lowConfidence) {
    for (const a of out) {
      a.confidence = "low";
      if (!/reference look/i.test(a.because)) {
        a.because = `To match the reference look, ${a.because}`;
      }
    }
  }

  return out;
}

export async function generateAdjustments(input: GenerateAdjustmentsInput): Promise<GenerateAdjustmentsOutput> {
  if (input.market !== "US") {
    throw new Error("Only market=US is supported for Layer2 personalization.");
  }

  const locale = String(input.locale || "en").trim() || "en";

  const lookSpec = LookSpecV0Schema.parse(input.lookSpec);
  const userFace = input.userFaceProfile == null ? null : FaceProfileV0Schema.parse(input.userFaceProfile);
  const refFace = FaceProfileV0Schema.parse(input.refFaceProfile);
  const similarityReport = input.similarityReport == null ? null : SimilarityReportV0Schema.parse(input.similarityReport);
  const hints = hintsFromLayer1(similarityReport);

  const provider = input.provider ?? createProviderFromEnv("generic");
  const promptTemplate = loadPrompt();

  const lowConfidence = userFace == null;

  const prompt =
    `${promptTemplate}\n\n` +
    `INPUT_JSON:\n` +
    JSON.stringify(
      {
        market: "US",
        locale,
        userFaceProfile: userFace,
        refFaceProfile: refFace,
        similarityReport,
        layer1Hints: hints,
        lookSpec,
      },
      null,
      2
    );

  const warnings: string[] = [];

  try {
    const parsed = await provider.analyzeTextToJson({
      prompt,
      schema: AdjustmentsCoreSchema,
    });

    const candidate = Array.isArray(parsed.adjustments) ? parsed.adjustments : [];
    const fixed = ensureExactlyThree(candidate, lowConfidence, warnings);
    const mergedWarnings = [...(parsed.warnings || []), ...warnings];
    return { adjustments: fixed, warnings: mergedWarnings };
  } catch (err) {
    warnings.push("LLM failed: using fallback adjustments.");
    const fixed = ensureExactlyThree([], lowConfidence, warnings);
    return { adjustments: fixed, warnings };
  }
}

