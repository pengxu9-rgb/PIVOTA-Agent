const { z } = require("zod");
const { generateMultiImageJsonFromGemini } = require("../layer1/llm/geminiMultiClient");

const AreaSchema = z.enum(["prep", "base", "contour", "brow", "eye", "blush", "lip"]);
const ImpactSchema = z.enum(["low", "mid", "high"]);

const SummarySchema = z
  .object({
    overall_similarity_score: z.number().min(0).max(100),
    top_mismatches: z
      .array(
        z.object({
          area: AreaSchema,
          issue: z.string().min(1),
          impact: ImpactSchema,
        }),
      )
      .default([]),
  })
  .strict();

const BaseEditsSchema = z
  .object({
    finish: z.enum(["matte", "satin", "dewy"]).optional(),
    coverage: z.number().min(0).max(1).optional(),
    brightness: z.number().min(-1).max(1).optional(),
    oil_control: z.number().min(0).max(1).optional(),
    undertone: z.enum(["warm", "cool", "neutral"]).optional(),
  })
  .strict()
  .optional();

const EyeEditsSchema = z
  .object({
    liner_angle_deg: z.number().min(-10).max(25).optional(),
    liner_thickness: z.number().min(0).max(1).optional(),
    tail_length: z.number().min(0).max(1).optional(),
    shadow_saturation: z.number().min(0).max(1).optional(),
    shadow_warmth: z.number().min(-1).max(1).optional(),
  })
  .strict()
  .optional();

const BlushEditsSchema = z
  .object({
    placement: z.enum(["center", "high", "outer"]).optional(),
    intensity: z.number().min(0).max(1).optional(),
    hue_shift: z.number().min(-1).max(1).optional(),
  })
  .strict()
  .optional();

const LipsEditsSchema = z
  .object({
    opacity: z.number().min(0).max(1).optional(),
    saturation: z.number().min(0).max(1).optional(),
    brightness: z.number().min(-1).max(1).optional(),
    finish: z.enum(["matte", "velvet", "glossy"]).optional(),
    hue_family: z.enum(["nude", "rose", "coral", "red", "berry"]).optional(),
  })
  .strict()
  .optional();

const EditsSchema = z
  .object({
    base: BaseEditsSchema,
    eyes: EyeEditsSchema,
    blush: BlushEditsSchema,
    lips: LipsEditsSchema,
  })
  .strict();

const QuickChipSchema = z
  .object({
    label: z.string().min(1),
    prefill_user_message: z.string().min(1),
    target_edits_patch: z.record(z.unknown()),
  })
  .strict();

const ShoppingIntentSchema = z
  .object({
    recommended_keywords: z
      .object({
        base: z.array(z.string().min(1)).default([]),
        eyes: z.array(z.string().min(1)).default([]),
        lips: z.array(z.string().min(1)).default([]),
      })
      .strict(),
    shade_direction: z
      .object({
        lips: z
          .object({
            more: z.enum(["pink", "orange", "red", "brown", "purple"]).optional(),
            less: z.enum(["pink", "orange", "red", "brown", "purple"]).optional(),
            depth: z.enum(["lighter", "deeper"]).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

const TryOnReplicateOneClickV0Schema = z
  .object({
    summary: SummarySchema,
    edits: EditsSchema,
    quick_adjust_chips: z.array(QuickChipSchema).default([]),
    shopping_intent: ShoppingIntentSchema,
    assistant_message: z.string().min(1),
  })
  .strict();

function buildPrompt({ userRequest, contextJson }) {
  const reqText = userRequest ? String(userRequest).trim() : "";
  const ctxText = contextJson ? JSON.stringify(contextJson) : "";

  return `SYSTEM:
You are a makeup look replication assistant for an ecommerce try-on product.
Goals:
1) Improve visual similarity between TARGET_IMAGE and USER_SELFIE by adjusting makeup parameters.
2) Keep results realistic and wearable.
3) Provide actionable suggestions and structured outputs for UI controls and shopping recommendations.

You will receive images in this order, each preceded by a label:
- TARGET_IMAGE
- SELFIE_IMAGE
- CURRENT_RENDER (optional)

You may also receive:
- USER_REQUEST (optional): user's adjustment request in natural language
- CONTEXT_JSON (optional): detected attributes and user profile signals

Return ONLY valid JSON. Do not include any extra text.

JSON_SCHEMA:
{
  "summary": {
    "overall_similarity_score": 0-100,
    "top_mismatches": [
      { "area": "prep|base|contour|brow|eye|blush|lip", "issue": "string", "impact": "low|mid|high" }
    ]
  },
  "edits": {
    "base": { "finish": "matte|satin|dewy", "coverage": 0-1, "brightness": -1..1, "oil_control": 0-1, "undertone": "warm|cool|neutral" },
    "eyes": { "liner_angle_deg": -10..25, "liner_thickness": 0-1, "tail_length": 0-1, "shadow_saturation": 0-1, "shadow_warmth": -1..1 },
    "blush": { "placement": "center|high|outer", "intensity": 0-1, "hue_shift": -1..1 },
    "lips": { "opacity": 0-1, "saturation": 0-1, "brightness": -1..1, "finish": "matte|velvet|glossy", "hue_family": "nude|rose|coral|red|berry" }
  },
  "quick_adjust_chips": [
    { "label": "string", "prefill_user_message": "string", "target_edits_patch": { } }
  ],
  "shopping_intent": {
    "recommended_keywords": {
      "base": ["string"],
      "eyes": ["string"],
      "lips": ["string"]
    },
    "shade_direction": {
      "lips": { "more": "pink|orange|red|brown|purple", "less": "pink|orange|red|brown|purple", "depth": "lighter|deeper" }
    }
  },
  "assistant_message": "A concise, friendly explanation in Chinese (<=80 words)."
}

Rules:
- If USER_REQUEST conflicts with TARGET_IMAGE replication, balance: keep similarity while applying the request subtly.
- If confidence is low for any area, include it in top_mismatches with impact=mid/high and suggest a safe adjustment.

USER_REQUEST:
${reqText || "(none)"}

CONTEXT_JSON:
${ctxText || "(none)"}
`;
}

async function runTryOnReplicateOneClickGemini({
  targetImagePath,
  selfieImagePath,
  currentRenderImagePath,
  userRequest,
  contextJson,
}) {
  const prompt = buildPrompt({ userRequest, contextJson });

  const images = [
    { label: "TARGET_IMAGE", imagePath: targetImagePath },
    { label: "SELFIE_IMAGE", imagePath: selfieImagePath },
    ...(currentRenderImagePath ? [{ label: "CURRENT_RENDER", imagePath: currentRenderImagePath }] : []),
  ];

  const out = await generateMultiImageJsonFromGemini({
    promptText: prompt,
    images,
    schema: TryOnReplicateOneClickV0Schema,
  });
  return out;
}

module.exports = {
  TryOnReplicateOneClickV0Schema,
  runTryOnReplicateOneClickGemini,
};

