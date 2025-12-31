const { generateMultiImageImageFromOpenAICompat } = require("./openaiCompatMultiModal");

function buildTryOnImagePrompt({ userRequest, contextJson }) {
  const reqText = userRequest ? String(userRequest).trim() : "";
  const ctxText = contextJson ? JSON.stringify(contextJson) : "";

  return `SYSTEM:
You are a makeup try-on image editing assistant.
Task:
- Take the makeup style from TARGET_IMAGE and apply it to the person in SELFIE_IMAGE.
- Preserve the identity and facial structure of SELFIE_IMAGE.
- Keep the output realistic and wearable.
- Keep background/lighting similar to SELFIE_IMAGE when possible.
- Do NOT return the input SELFIE_IMAGE unchanged; ensure makeup changes are visibly noticeable when compared side-by-side.

Priority (must match TARGET_IMAGE):
1) Base makeup (底妆): undertone + brightness, foundation finish (matte/satin/dewy), coverage, and skin texture impression.
2) Eye makeup (眼妆): eyeshadow palette (2–3 tones), saturation, warmth/coolness, eyeliner angle/thickness/tail length, and overall eye depth.
3) Lip color (口红): shade replication: hue family (nude/rose/coral/red/berry), depth (lighter/deeper), saturation, brightness, and finish (matte/velvet/glossy).

Quality bar:
- The output must not be identical to SELFIE_IMAGE. If unsure, bias slightly stronger on lips/eyes/base while staying wearable.
- Avoid artifacts (face warping, extra facial features, smeared textures).

You will receive images in this order, each preceded by a label:
- TARGET_IMAGE (style reference)
- SELFIE_IMAGE (person to edit)
- CURRENT_RENDER (optional, current try-on result)

If USER_REQUEST exists, apply it subtly while staying close to TARGET_IMAGE.

Return a single edited IMAGE. Prefer returning it as a base64 data URL (data:image/...;base64,...).

USER_REQUEST:
${reqText || "(none)"}

CONTEXT_JSON:
${ctxText || "(none)"}
`;
}

async function runTryOnGenerateImageOpenAICompat({
  targetImagePath,
  selfieImagePath,
  currentRenderImagePath,
  userRequest,
  contextJson,
}) {
  const promptText = buildTryOnImagePrompt({ userRequest, contextJson });
  const model =
    process.env.LOOK_REPLICATOR_TRYON_MODEL_OPENAI ||
    process.env.LLM_MODEL_NAME ||
    process.env.OPENAI_MODEL ||
    "gpt-4o";

  const images = [
    { label: "TARGET_IMAGE", imagePath: targetImagePath },
    { label: "SELFIE_IMAGE", imagePath: selfieImagePath },
    ...(currentRenderImagePath ? [{ label: "CURRENT_RENDER", imagePath: currentRenderImagePath }] : []),
  ];

  const out = await generateMultiImageImageFromOpenAICompat({ promptText, images, model });
  if (!out?.ok) return out;

  const filename = `tryon.${out.value.ext}`;
  return { ok: true, value: { ...out.value, filename }, meta: out.meta };
}

module.exports = {
  runTryOnGenerateImageOpenAICompat,
};
