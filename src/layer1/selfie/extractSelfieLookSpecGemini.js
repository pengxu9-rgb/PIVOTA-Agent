const { z } = require("zod");

const { generateLookSpecFromImage } = require("../llm/geminiClient");

const { LookSpecBreakdownAreaV0Schema, LookSpecBreakdownEyeV0Schema, LookSpecV0Schema } = require("../../layer2/schemas/lookSpecV0");
const { normalizeVibeTagsForMarket } = require("../../layer2/dicts/lookSpecLexicon");

const UnknownBreakdownAreaV0 = {
  intent: "unknown",
  finish: "unknown",
  coverage: "unknown",
  keyNotes: [],
  evidence: [],
};

const LookSpecExtractCoreSchema = z
  .object({
    lookTitle: z.string().min(1).default("unknown"),
    styleTags: z.array(z.string().min(1)).default([]),
    breakdown: z
      .object({
        base: LookSpecBreakdownAreaV0Schema,
        eye: LookSpecBreakdownEyeV0Schema,
        lip: LookSpecBreakdownAreaV0Schema,
        prep: LookSpecBreakdownAreaV0Schema.default(UnknownBreakdownAreaV0),
        contour: LookSpecBreakdownAreaV0Schema.default(UnknownBreakdownAreaV0),
        brow: LookSpecBreakdownAreaV0Schema.default(UnknownBreakdownAreaV0),
        blush: LookSpecBreakdownAreaV0Schema.default(UnknownBreakdownAreaV0),
      })
      .strict(),
    warnings: z.array(z.string().min(1)).default([]),
  })
  .strict();

const LookDirectionEnum = ["up", "down", "straight", "unknown"];
const ShadeDepthEnum = ["very_light", "light", "medium", "tan", "deep", "unknown"];
const ShadeSaturationEnum = ["muted", "medium", "vivid", "unknown"];
const ShadeTemperatureEnum = ["warm", "cool", "neutral", "mixed", "unknown"];
const ShadeUndertoneEnum = ["cool", "neutral", "warm", "olive", "unknown"];

const LookSpecExtractCoreJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    lookTitle: { type: "string" },
    styleTags: { type: "array", items: { type: "string" } },
    breakdown: {
      type: "object",
      additionalProperties: false,
      properties: {
        base: {
          type: "object",
          additionalProperties: false,
          properties: {
            intent: { type: "string" },
            finish: { type: "string" },
            coverage: { type: "string" },
            shade: {
              type: "object",
              additionalProperties: false,
              properties: {
                hueFamily: { type: "string" },
                temperature: { type: "string", enum: ShadeTemperatureEnum },
                undertone: { type: "string", enum: ShadeUndertoneEnum },
                depth: { type: "string", enum: ShadeDepthEnum },
                saturation: { type: "string", enum: ShadeSaturationEnum },
                keyColors: { type: "array", items: { type: "string" } },
                notes: { type: "array", items: { type: "string" } },
                confidence: { type: "string", enum: ["low", "medium", "high"] },
              },
            },
            keyNotes: { type: "array", items: { type: "string" } },
            evidence: { type: "array", items: { type: "string" } },
          },
          required: ["intent", "finish", "coverage"],
        },
        eye: {
          type: "object",
          additionalProperties: false,
          properties: {
            intent: { type: "string" },
            finish: { type: "string" },
            coverage: { type: "string" },
            shade: {
              type: "object",
              additionalProperties: false,
              properties: {
                hueFamily: { type: "string" },
                temperature: { type: "string", enum: ShadeTemperatureEnum },
                undertone: { type: "string", enum: ShadeUndertoneEnum },
                depth: { type: "string", enum: ShadeDepthEnum },
                saturation: { type: "string", enum: ShadeSaturationEnum },
                keyColors: { type: "array", items: { type: "string" } },
                notes: { type: "array", items: { type: "string" } },
                confidence: { type: "string", enum: ["low", "medium", "high"] },
              },
            },
            keyNotes: { type: "array", items: { type: "string" } },
            evidence: { type: "array", items: { type: "string" } },
            linerDirection: {
              type: "object",
              additionalProperties: false,
              properties: {
                direction: { type: "string", enum: LookDirectionEnum },
              },
              required: ["direction"],
            },
            shadowShape: { type: "string" },
          },
          required: ["intent", "finish", "coverage"],
        },
        lip: {
          type: "object",
          additionalProperties: false,
          properties: {
            intent: { type: "string" },
            finish: { type: "string" },
            coverage: { type: "string" },
            shade: {
              type: "object",
              additionalProperties: false,
              properties: {
                hueFamily: { type: "string" },
                temperature: { type: "string", enum: ShadeTemperatureEnum },
                undertone: { type: "string", enum: ShadeUndertoneEnum },
                depth: { type: "string", enum: ShadeDepthEnum },
                saturation: { type: "string", enum: ShadeSaturationEnum },
                keyColors: { type: "array", items: { type: "string" } },
                notes: { type: "array", items: { type: "string" } },
                confidence: { type: "string", enum: ["low", "medium", "high"] },
              },
            },
            keyNotes: { type: "array", items: { type: "string" } },
            evidence: { type: "array", items: { type: "string" } },
          },
          required: ["intent", "finish", "coverage"],
        },
        prep: { $ref: "#/properties/breakdown/properties/base" },
        contour: { $ref: "#/properties/breakdown/properties/base" },
        brow: { $ref: "#/properties/breakdown/properties/base" },
        blush: { $ref: "#/properties/breakdown/properties/base" },
      },
      required: ["base", "eye", "lip"],
    },
    warnings: { type: "array", items: { type: "string" } },
  },
  required: ["breakdown"],
};

function engineVersionFor(market) {
  const m = String(market || "US").toLowerCase();
  return {
    layer2: `l2-${m}-0.1.0`,
    layer3: `l3-${m}-0.1.0`,
    orchestrator: `orchestrator-${m}-0.1.0`,
  };
}

function toError(err) {
  if (err && typeof err === "object" && "code" in err && "message" in err) {
    return { code: String(err.code || "UNKNOWN"), message: String(err.message || "") };
  }
  if (err instanceof Error) return { code: "UNEXPECTED_ERROR", message: err.message };
  return { code: "UNKNOWN_ERROR", message: String(err || "") };
}

async function extractSelfieLookSpecGemini({ market, locale, imagePath, promptText }) {
  const m = String(market || "").trim() || "US";
  const loc = String(locale || "").trim() || "en-US";
  const versions = engineVersionFor(m);

  const prompt = [
    "Analyze the SELFIE (user) image and output ONLY JSON matching the schema.",
    "If unsure, use \"unknown\" for direction/intent/finish/coverage; do not omit required keys.",
    String(promptText || ""),
  ].join("\n\n");

  const gen = await generateLookSpecFromImage({
    imagePath,
    promptText: prompt,
    responseJsonSchema: LookSpecExtractCoreJsonSchema,
  });

  if (!gen.ok) return { ok: false, error: toError(gen.error), ...(gen.meta ? { meta: gen.meta } : {}) };

  let parsedJson;
  try {
    parsedJson = JSON.parse(String(gen.value || ""));
  } catch {
    return { ok: false, error: { code: "JSON_PARSE_FAILED", message: "Gemini returned invalid JSON" } };
  }

  const core = LookSpecExtractCoreSchema.safeParse(parsedJson);
  if (!core.success) {
    return { ok: false, error: { code: "SCHEMA_INVALID", message: "Gemini JSON did not match expected lookSpec shape" } };
  }

  const lookSpec = LookSpecV0Schema.parse({
    schemaVersion: "v0",
    market: m,
    locale: loc,
    layer2EngineVersion: versions.layer2,
    layer3EngineVersion: versions.layer3,
    orchestratorVersion: versions.orchestrator,
    lookTitle: core.data.lookTitle,
    styleTags: normalizeVibeTagsForMarket(core.data.styleTags, m),
    breakdown: core.data.breakdown,
    warnings: core.data.warnings,
  });

  return { ok: true, value: lookSpec, ...(gen.meta ? { meta: gen.meta } : {}) };
}

module.exports = {
  LookSpecExtractCoreJsonSchema,
  extractSelfieLookSpecGemini,
};
