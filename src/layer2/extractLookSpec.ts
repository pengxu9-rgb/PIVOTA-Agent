import fs from "fs";
import path from "path";
import { z } from "zod";

import { createOpenAiCompatibleProvider, ImageInput, LlmError, LlmProvider } from "../llm/provider";
import { LookSpecBreakdownAreaV0Schema, LookSpecV0, LookSpecV0Schema } from "./schemas/lookSpecV0";

const LookSpecExtractCoreSchema = z
  .object({
    lookTitle: z.string().min(1).default("unknown"),
    styleTags: z.array(z.string().min(1)).default([]),
    breakdown: z
      .object({
        base: LookSpecBreakdownAreaV0Schema,
        eye: LookSpecBreakdownAreaV0Schema,
        lip: LookSpecBreakdownAreaV0Schema,
      })
      .strict(),
    warnings: z.array(z.string().min(1)).default([]),
  })
  .strict();

type LookSpecExtractCore = z.infer<typeof LookSpecExtractCoreSchema>;

export type ExtractLookSpecInput = {
  market: "US";
  locale: string;
  referenceImage: ImageInput;
  provider?: LlmProvider;
};

let cachedPrompt: string | null = null;

function loadPrompt(): string {
  if (cachedPrompt) return cachedPrompt;
  const p = path.join(__dirname, "prompts", "lookSpec_extract_en.txt");
  cachedPrompt = fs.readFileSync(p, "utf8");
  return cachedPrompt;
}

function unknownLookSpec(locale: string, warnings: string[]): LookSpecV0 {
  return LookSpecV0Schema.parse({
    schemaVersion: "v0",
    market: "US",
    locale,
    layer2EngineVersion: "l2-us-0.1.0",
    layer3EngineVersion: "l3-us-0.1.0",
    orchestratorVersion: "orchestrator-us-0.1.0",
    lookTitle: "unknown",
    styleTags: [],
    breakdown: {
      base: { intent: "unknown", finish: "unknown", coverage: "unknown", keyNotes: [], evidence: [] },
      eye: { intent: "unknown", finish: "unknown", coverage: "unknown", keyNotes: [], evidence: [] },
      lip: { intent: "unknown", finish: "unknown", coverage: "unknown", keyNotes: [], evidence: [] },
    },
    warnings,
  });
}

function toWarning(err: unknown): string[] {
  if (err instanceof LlmError) {
    return [`LookSpec extraction failed (${err.code}).`];
  }
  if (err instanceof Error) {
    return ["LookSpec extraction failed (UNEXPECTED_ERROR)."];
  }
  return ["LookSpec extraction failed (UNKNOWN_ERROR)."];
}

export async function extractLookSpec(input: ExtractLookSpecInput): Promise<LookSpecV0> {
  const { market, locale, referenceImage } = input;

  if (market !== "US") {
    throw new Error("Only market=US is supported for LookSpec extraction.");
  }

  const provider = input.provider ?? createOpenAiCompatibleProvider();
  const prompt = loadPrompt();

  try {
    const core: LookSpecExtractCore = await provider.analyzeImageToJson({
      prompt,
      image: referenceImage,
      schema: LookSpecExtractCoreSchema,
    });

    return LookSpecV0Schema.parse({
      schemaVersion: "v0",
      market: "US",
      locale,
      layer2EngineVersion: "l2-us-0.1.0",
      layer3EngineVersion: "l3-us-0.1.0",
      orchestratorVersion: "orchestrator-us-0.1.0",
      lookTitle: core.lookTitle,
      styleTags: core.styleTags,
      breakdown: core.breakdown,
      warnings: core.warnings,
    });
  } catch (err) {
    return unknownLookSpec(locale, toWarning(err));
  }
}

