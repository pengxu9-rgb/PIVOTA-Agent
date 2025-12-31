const { TryOnReplicateOneClickV0Schema } = require("./tryOnReplicateOneClickGemini");
const { generateMultiImageJsonFromOpenAICompat } = require("./openaiCompatMultiModal");

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

Return ONLY valid JSON matching the schema (no markdown, no extra text).

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

async function runTryOnReplicateOneClickOpenAICompat({
  targetImagePath,
  selfieImagePath,
  currentRenderImagePath,
  userRequest,
  contextJson,
}) {
  const prompt = buildPrompt({ userRequest, contextJson });
  const model =
    process.env.LOOK_REPLICATOR_ONE_CLICK_MODEL_OPENAI ||
    process.env.PIVOTA_LAYER2_MODEL_OPENAI ||
    process.env.LLM_MODEL_NAME ||
    process.env.OPENAI_MODEL ||
    "gpt-4o-mini";

  const images = [
    { label: "TARGET_IMAGE", imagePath: targetImagePath },
    { label: "SELFIE_IMAGE", imagePath: selfieImagePath },
    ...(currentRenderImagePath ? [{ label: "CURRENT_RENDER", imagePath: currentRenderImagePath }] : []),
  ];

  return generateMultiImageJsonFromOpenAICompat({
    promptText: prompt,
    images,
    schema: TryOnReplicateOneClickV0Schema,
    model,
  });
}

module.exports = {
  runTryOnReplicateOneClickOpenAICompat,
};

