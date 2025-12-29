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

export const LookSpecBreakdownAreaV0Schema = z
  .object({
    intent: z.string().min(1),
    finish: z.string().min(1),
    coverage: z.string().min(1),
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
