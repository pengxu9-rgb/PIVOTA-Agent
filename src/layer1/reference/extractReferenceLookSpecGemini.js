const { z } = require("zod");

const { generateLookSpecFromImage } = require("../llm/geminiClient");
const { LookSpecBreakdownAreaV0Schema, LookSpecBreakdownEyeV0Schema, LookSpecV0Schema } = require("../../layer2/schemas/lookSpecV0");
const { normalizeVibeTagsForMarket } = require("../../layer2/dicts/lookSpecLexicon");

const { LookSpecExtractCoreJsonSchema } = require("../selfie/extractSelfieLookSpecGemini");

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

function parseEnvBool(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

function debugLog(msg) {
  if (!parseEnvBool(process.env.GEMINI_DEBUG) && !parseEnvBool(process.env.LAYER1_SELFIE_DEBUG)) return;
  // eslint-disable-next-line no-console
  console.log(`[gemini_reference] ${msg}`);
}

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
    return { code: String(err.code || "UNKNOWN"), message: String(err.message || "").slice(0, 220) };
  }
  if (err instanceof Error) return { code: "UNEXPECTED_ERROR", message: err.message.slice(0, 220) };
  return { code: "UNKNOWN_ERROR", message: String(err || "").slice(0, 220) };
}

async function extractReferenceLookSpecGemini({ market, locale, imagePath, promptText }) {
  const m = String(market || "").trim() || "US";
  const loc = String(locale || "").trim() || "en-US";
  const versions = engineVersionFor(m);

  const prompt = [
    "Analyze the REFERENCE (target) image and output ONLY JSON matching the schema.",
    'If unsure, use "unknown" for direction/intent/finish/coverage; do not omit required keys.',
    String(promptText || ""),
  ].join("\n\n");

  try {
    const gen = await generateLookSpecFromImage({
      imagePath,
      promptText: prompt,
      responseJsonSchema: LookSpecExtractCoreJsonSchema,
    });

    if (!gen.ok) return { ok: false, error: toError(gen.error) };

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

    debugLog("ok=true");
    return { ok: true, value: lookSpec };
  } catch (err) {
    const e = toError(err);
    debugLog(`ok=false code=${e.code}`);
    return { ok: false, error: e };
  }
}

module.exports = {
  extractReferenceLookSpecGemini,
};

