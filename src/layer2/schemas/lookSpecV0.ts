import { z } from "zod";

export const LookAreaSchema = z.enum(["prep", "base", "contour", "brow", "eye", "blush", "lip"]);

const LinerDirectionEnumSchema = z.enum(["down", "straight", "up", "unknown"]);

export function normalizeLinerDirection(input: unknown): z.infer<typeof LinerDirectionEnumSchema> {
  const s = String(input ?? "").trim().toLowerCase();
  if (s === "up" || s === "upward" || s === "upwards") return "up";
  if (s === "down" || s === "downward" || s === "downwards") return "down";
  if (s === "straight" || s === "horizontal" || s === "flat") return "straight";
  return "unknown";
}

export const LookSpecLinerDirectionSchema = z
  .object({
    direction: z.preprocess(normalizeLinerDirection, LinerDirectionEnumSchema),
  })
  .strict();

const ShadeDepthEnumSchema = z.enum(["very_light", "light", "medium", "tan", "deep", "unknown"]);
const ShadeSaturationEnumSchema = z.enum(["muted", "medium", "vivid", "unknown"]);
const ShadeTemperatureEnumSchema = z.enum(["warm", "cool", "neutral", "mixed", "unknown"]);
const ShadeUndertoneEnumSchema = z.enum(["cool", "neutral", "warm", "olive", "unknown"]);

function normalizeEnumToken(input: unknown): string {
  return String(input ?? "").trim().toLowerCase().replace(/[\s_]+/g, "_");
}

function normalizeShadeDepth(input: unknown): z.infer<typeof ShadeDepthEnumSchema> {
  const s = normalizeEnumToken(input);
  if (!s || s === "unknown") return "unknown";
  if (s === "very_light" || s === "verylight" || s === "fair") return "very_light";
  if (s === "light") return "light";
  if (s === "medium" || s === "mid") return "medium";
  if (s === "tan" || s === "medium_tan" || s === "mediumtan") return "tan";
  if (s === "deep" || s === "dark") return "deep";
  return "unknown";
}

function normalizeShadeSaturation(input: unknown): z.infer<typeof ShadeSaturationEnumSchema> {
  const s = normalizeEnumToken(input);
  if (!s || s === "unknown") return "unknown";
  if (s === "muted" || s === "soft" || s === "low") return "muted";
  if (s === "medium" || s === "mid") return "medium";
  if (s === "vivid" || s === "bright" || s === "high") return "vivid";
  return "unknown";
}

function normalizeShadeTemperature(input: unknown): z.infer<typeof ShadeTemperatureEnumSchema> {
  const s = normalizeEnumToken(input);
  if (!s || s === "unknown") return "unknown";
  if (s === "warm") return "warm";
  if (s === "cool") return "cool";
  if (s === "neutral") return "neutral";
  if (s === "mixed" || s === "mix") return "mixed";
  return "unknown";
}

function normalizeShadeUndertone(input: unknown): z.infer<typeof ShadeUndertoneEnumSchema> {
  const s = normalizeEnumToken(input);
  if (!s || s === "unknown") return "unknown";
  if (s === "cool" || s === "pink" || s === "rosy") return "cool";
  if (s === "warm" || s === "yellow" || s === "golden") return "warm";
  if (s === "neutral") return "neutral";
  if (s === "olive") return "olive";
  return "unknown";
}

export const ShadeProfileV0Schema = z
  .object({
    // Free-text, but should be short and non-brand-specific (e.g., "rosy nude", "brick red", "neutral beige").
    hueFamily: z.string().min(1).default("unknown"),
    temperature: z.preprocess(normalizeShadeTemperature, ShadeTemperatureEnumSchema).default("unknown"),
    undertone: z.preprocess(normalizeShadeUndertone, ShadeUndertoneEnumSchema).default("unknown"),
    depth: z.preprocess(normalizeShadeDepth, ShadeDepthEnumSchema).default("unknown"),
    saturation: z.preprocess(normalizeShadeSaturation, ShadeSaturationEnumSchema).default("unknown"),

    // For eye palette: optionally list 2-6 short color words (e.g., ["taupe","brown","champagne"]).
    keyColors: z.array(z.string().min(1)).default([]),
    notes: z.array(z.string().min(1)).default([]),
    confidence: z.enum(["low", "medium", "high"]).optional(),
  })
  .strict();

export const LookSpecBreakdownAreaV0Schema = z
  .object({
    intent: z.string().min(1),
    finish: z.string().min(1),
    coverage: z.string().min(1),
    shade: ShadeProfileV0Schema.default({ hueFamily: "unknown", temperature: "unknown", undertone: "unknown", depth: "unknown", saturation: "unknown", keyColors: [], notes: [] }),
    keyNotes: z.array(z.string().min(1)).default([]),
    evidence: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const LookSpecBreakdownEyeV0Schema = LookSpecBreakdownAreaV0Schema.extend({
  linerDirection: LookSpecLinerDirectionSchema.default({ direction: "unknown" }),
  shadowShape: z.string().min(1).optional(),
}).strict();

export const UnknownLookSpecBreakdownAreaV0 = {
  intent: "unknown",
  finish: "unknown",
  coverage: "unknown",
  keyNotes: [],
  evidence: [],
} as const;

export const LookSpecV0Schema = z
  .object({
    schemaVersion: z.literal("v0"),
    market: z.enum(["US", "JP"]),
    locale: z.string().min(1),

    layer2EngineVersion: z.union([z.literal("l2-us-0.1.0"), z.literal("l2-jp-0.1.0")]),
    layer3EngineVersion: z.union([z.literal("l3-us-0.1.0"), z.literal("l3-jp-0.1.0")]),
    orchestratorVersion: z.union([z.literal("orchestrator-us-0.1.0"), z.literal("orchestrator-jp-0.1.0")]),

    lookTitle: z.string().min(1).optional(),
    styleTags: z.array(z.string().min(1)).default([]),

    breakdown: z
      .object({
        base: LookSpecBreakdownAreaV0Schema,
        eye: LookSpecBreakdownEyeV0Schema,
        lip: LookSpecBreakdownAreaV0Schema,
        prep: LookSpecBreakdownAreaV0Schema.default(UnknownLookSpecBreakdownAreaV0),
        contour: LookSpecBreakdownAreaV0Schema.default(UnknownLookSpecBreakdownAreaV0),
        brow: LookSpecBreakdownAreaV0Schema.default(UnknownLookSpecBreakdownAreaV0),
        blush: LookSpecBreakdownAreaV0Schema.default(UnknownLookSpecBreakdownAreaV0),
      })
      .strict(),

    warnings: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type LookSpecV0 = z.infer<typeof LookSpecV0Schema>;
