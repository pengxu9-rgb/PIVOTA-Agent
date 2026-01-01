const { generateMultiImageImageFromOpenAICompat } = require("./openaiCompatMultiModal");

function buildTryOnImagePrompt({ userRequest, contextJson }) {
  const reqText = userRequest ? String(userRequest).trim() : "";
  const ctxText = contextJson ? JSON.stringify(contextJson) : "";

  return `SYSTEM:
You are a makeup try-on image editing assistant.
Task:
- Take the makeup style from TARGET_IMAGE and apply it to the person in SELFIE_IMAGE.
- Preserve the identity and facial structure of SELFIE_IMAGE.
- Do not replace the face/skin/identity with TARGET_IMAGE. Do not do face swap, face transplant, cut-and-paste collage, or change facial geometry.
- Do not add extra facial parts (duplicate eyes/mouth) or halos/patches around the face.
- Keep the output realistic and wearable.
- Keep background/lighting similar to SELFIE_IMAGE when possible.
- Do NOT generate a "no-makeup" look. The makeup must be clearly visible and distinct.
- Do NOT return the input SELFIE_IMAGE unchanged; ensure makeup changes are visibly noticeable when compared side-by-side.

Priority (must match TARGET_IMAGE):
1) Base makeup (底妆): undertone + brightness, foundation finish (matte/satin/dewy), coverage, and skin texture impression.
2) Eye makeup (眼妆): eyeshadow palette (2–3 tones), saturation, warmth/coolness, eyeliner angle/thickness/tail length, and overall eye depth.
3) Lip color (口红): shade replication: hue family (nude/rose/coral/red/berry), depth (lighter/deeper), saturation, brightness, and finish (matte/velvet/glossy).

High-fidelity instructions (CRITICAL):
1) Base Makeup (Foundation): Recreate the exact skin finish (matte/dewy/satin) of TARGET_IMAGE. Apply a high-coverage foundation effect that evens out the skin tone clearly while retaining the same person identity and facial structure.
2) Eye Makeup (Critical): Heavily emphasize the eye makeup. Replicate the eyeshadow color, gradient, and placement. Ensure the eyeliner shape is sharp, dark, and clearly defined. Make the eyeshadow noticeably pigmented (not washed out).
3) Lip Makeup: Accurately clone the lipstick shade, saturation, and texture/finish (velvet/glossy/satin/matte) from TARGET_IMAGE. The lip contours should be precise and the color must be vibrant.
4) Overall Vibe: The final result should look like a professional makeup trial. Increase makeup opacity and color saturation to closely match TARGET_IMAGE.

Quality bar:
- The output must not be identical to SELFIE_IMAGE. If unsure, bias slightly stronger on lips/eyes/base while staying wearable.
- Make base/eyes/lips changes clearly noticeable and as close as possible to TARGET_IMAGE (do not under-apply).
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
  const rawModel = process.env.LOOK_REPLICATOR_TRYON_MODEL_OPENAI || "";
  const models = String(rawModel)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!models.length) {
    return { ok: false, error: { code: "CONFIG_MISSING", message: "Missing LOOK_REPLICATOR_TRYON_MODEL_OPENAI" }, meta: { attempted: false } };
  }

  const images = [
    { label: "TARGET_IMAGE", imagePath: targetImagePath },
    { label: "SELFIE_IMAGE", imagePath: selfieImagePath },
    ...(currentRenderImagePath ? [{ label: "CURRENT_RENDER", imagePath: currentRenderImagePath }] : []),
  ];

  const attempted = [];
  let lastErr = null;

  for (const model of models) {
    attempted.push(model);
    const out = await generateMultiImageImageFromOpenAICompat({ promptText, images, model });
    if (out?.ok) {
      const filename = `tryon.${out.value.ext}`;
      return { ok: true, value: { ...out.value, filename }, meta: { ...(out.meta || {}), attemptedModels: attempted } };
    }
    lastErr = out;

    const status = out?.error?.status;
    const code = out?.error?.code;
    // Try the next model when the relay rejects the requested model (common for 403/404).
    if (status === 403 || status === 404 || code === "OUTPUT_TOO_SIMILAR" || code === "OUTPUT_SUSPECT_FACE_SWAP") continue;
    break;
  }

  if (lastErr && lastErr.meta && typeof lastErr.meta === "object") {
    return { ...lastErr, meta: { ...(lastErr.meta || {}), attemptedModels: attempted } };
  }
  return lastErr || { ok: false, error: { code: "REQUEST_FAILED", message: "Try-on image generation failed" }, meta: { attemptedModels: attempted } };
}

module.exports = {
  runTryOnGenerateImageOpenAICompat,
};
