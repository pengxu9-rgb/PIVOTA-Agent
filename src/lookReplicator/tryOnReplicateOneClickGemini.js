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
  .partial()
  .default({});

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
  .passthrough();

const AltOneClickSchema = z
  .object({
    overall_feedback: z.string().optional(),
    top_mismatches: z.array(z.unknown()).optional(),
    visual_suggestions: z.record(z.unknown()).optional(),
    shopping_recommendations: z.unknown().optional(),
    overall_similarity_score: z.number().min(0).max(100).optional(),
    similarity_score: z.number().min(0).max(100).optional(),
  })
  .passthrough();

function normalizeArea(v) {
  const s = String(v || "").trim().toLowerCase();
  if (s === "brows") return "brow";
  if (s === "eyes") return "eye";
  if (s === "lips") return "lip";
  if (s === "foundation") return "base";
  if (s === "prep") return "prep";
  if (s === "base") return "base";
  if (s === "contour") return "contour";
  if (s === "brow") return "brow";
  if (s === "eye") return "eye";
  if (s === "blush") return "blush";
  if (s === "lip") return "lip";
  return null;
}

function normalizeImpact(v) {
  const s = String(v || "").trim().toLowerCase();
  if (s === "low" || s === "mid" || s === "high") return s;
  return "mid";
}

function coerceTopMismatches(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const it of list) {
    const area = normalizeArea(it?.area || it?.impactArea || it?.category || it?.slot);
    const issue = String(it?.issue || it?.reason || it?.message || it?.text || "").trim();
    if (!area || !issue) continue;
    out.push({ area, issue, impact: normalizeImpact(it?.impact || it?.severity) });
  }
  return out;
}

function buildCanonicalFromAlt(alt) {
  const score =
    (typeof alt?.overall_similarity_score === "number" && Number.isFinite(alt.overall_similarity_score) ? alt.overall_similarity_score : null) ??
    (typeof alt?.similarity_score === "number" && Number.isFinite(alt.similarity_score) ? alt.similarity_score : null) ??
    60;

  const top_mismatches = coerceTopMismatches(alt?.top_mismatches);
  const assistant_message = String(alt?.overall_feedback || "").trim() || "已生成微调建议";

  const vs = alt?.visual_suggestions;
  const edits =
    (vs && typeof vs === "object" && ("edits" in vs) ? vs.edits : null) ??
    (vs && typeof vs === "object" ? vs : null) ??
    {};

  return {
    summary: { overall_similarity_score: Math.max(0, Math.min(100, Number(score) || 0)), top_mismatches },
    edits,
    quick_adjust_chips: [],
    shopping_intent: alt?.shopping_recommendations ?? undefined,
    assistant_message,
  };
}

function normalizeOneClickResult(raw) {
  // 1) Canonical shape
  const direct = TryOnReplicateOneClickV0Schema.safeParse(raw);
  if (direct.success) {
    const v = direct.data;
    const summary = v.summary || { overall_similarity_score: 60, top_mismatches: [] };
    const edits = v.edits || {};
    return TryOnReplicateOneClickV0Schema.parse({
      summary: {
        overall_similarity_score: Math.max(0, Math.min(100, Number(summary.overall_similarity_score) || 0)),
        top_mismatches: Array.isArray(summary.top_mismatches) ? summary.top_mismatches : [],
      },
      edits,
      quick_adjust_chips: Array.isArray(v.quick_adjust_chips) ? v.quick_adjust_chips : [],
      shopping_intent: v.shopping_intent,
      assistant_message: String(v.assistant_message || "").trim() || "已生成微调建议",
    });
  }

  // 2) Alt schema -> canonical transform
  const altParsed = AltOneClickSchema.safeParse(raw);
  if (altParsed.success) {
    const candidate = buildCanonicalFromAlt(altParsed.data);
    return TryOnReplicateOneClickV0Schema.parse(candidate);
  }

  // 3) Give a safe empty canonical response
  return TryOnReplicateOneClickV0Schema.parse({
    summary: { overall_similarity_score: 0, top_mismatches: [{ area: "base", issue: "模型输出格式不符合预期，建议稍后重试", impact: "high" }] },
    edits: {},
    quick_adjust_chips: [],
    shopping_intent: undefined,
    assistant_message: "系统提示：微调结果解析失败，请稍后重试。",
  });
}

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
  - CONTEXT_JSON.oneClickIterationV0 (optional): previous turns for iterative improvement. Build on the latest turns; avoid repeating prior advice.
  - CONTEXT_JSON.targetBreakdownV0 (optional): structured summary of the TARGET look (e.g. finish/coverage/intent). Use this as an anchor for edits.
  - CONTEXT_JSON.uiDiffByAreaV0 (optional): UI-level mismatch summary (may be coarse). Use it as a hint when uncertain.

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
- If CONTEXT_JSON.oneClickIterationV0.turns exists, treat this as an iteration: focus on incremental improvements over the previous best attempt.
- Keep edits conservative: small changes that are likely to improve similarity without making the look unrealistic.

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
    schema: z.any(),
  });
  if (!out?.ok) return out;

  try {
    const normalized = normalizeOneClickResult(out.value);
    return { ok: true, value: normalized, meta: out.meta };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err || "");
    return { ok: false, error: { code: "SCHEMA_INVALID", message: "Model JSON did not match expected schema" }, meta: out.meta, raw: JSON.stringify(out.value).slice(0, 2000), details: { message: msg.slice(0, 220) } };
  }
}

module.exports = {
  TryOnReplicateOneClickV0Schema,
  runTryOnReplicateOneClickGemini,
  normalizeOneClickResult,
};
