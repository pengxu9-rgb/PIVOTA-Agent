const { generateMultiImageImageFromOpenAICompat } = require("./openaiCompatMultiModal");
const { applyTryOnFaceComposite } = require("./tryOnFaceComposite");
const { computeSimilarity, isTooSimilar } = require("./imageSimilarity");

function parseEnvBool(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

function parseEnvInt(v, fallback) {
  const n = Number.parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

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

function withNoopRetryHint(promptText, attempt) {
  const n = Number(attempt) || 1;
  if (n <= 1) return promptText;
  return `${promptText}\n\nNO_OP_RETRY_HINT (attempt=${n}):\nThe previous output was too similar to SELFIE_IMAGE (no-op).\nYou MUST make the makeup changes visibly stronger (especially eyes + lips + base) while keeping identity.\nReturn a single edited IMAGE only.\n`;
}

async function runTryOnGenerateImageOpenAICompat({
  targetImagePath,
  selfieImagePath,
  currentRenderImagePath,
  userRequest,
  contextJson,
  faceBox,
  faceMaskPath,
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
    const blendEnabled =
      !parseEnvBool(process.env.LOOK_REPLICATOR_TRYON_DISABLE_FACE_BLEND) &&
      (parseEnvBool(process.env.LOOK_REPLICATOR_TRYON_FACE_BLEND) ||
        process.env.LOOK_REPLICATOR_TRYON_FACE_BLEND == null ||
        faceMaskPath ||
        faceBox);

    const variationAttempts = Math.max(1, Math.min(4, parseEnvInt(process.env.LOOK_REPLICATOR_TRYON_VARIATION_ATTEMPTS, 2)));

    for (let variationAttempt = 1; variationAttempt <= variationAttempts; variationAttempt += 1) {
      const out = await generateMultiImageImageFromOpenAICompat({
        promptText: withNoopRetryHint(promptText, variationAttempt),
        images,
        model,
        // When we are going to face-blend anyway, the full-frame similarity check is too strict
        // (it averages over background). We rely on the face-region similarity check in the blend step.
        skipSimilarityCheck: blendEnabled,
      });

      if (out?.ok) {
        if (blendEnabled) {
          const rawBytes = Buffer.from(String(out.value.data || ""), "base64");
          let blended;
          try {
            blended = await applyTryOnFaceComposite({
              selfieImagePath,
              tryOnImageBytes: rawBytes,
              faceMaskPath,
              faceBox,
            });
          } catch (err) {
            blended = null;
            const msg = err instanceof Error ? err.message : String(err);

            // If blending fails, fall back to a strict full-frame similarity check before returning.
            // This keeps the original behavior of rejecting "no-op" outputs.
            try {
              const selfieBytes = require("node:fs").readFileSync(String(selfieImagePath));
              const similarity = await computeSimilarity(selfieBytes, rawBytes).catch(() => null);
              const minDiff = Number(process.env.LOOK_REPLICATOR_TRYON_MIN_DIFF || "6");
              const maxDhashDist = Number(process.env.LOOK_REPLICATOR_TRYON_MAX_DHASH_DIST || "4");
              if (similarity && isTooSimilar(similarity, { minDiff, maxDhashDist })) {
                lastErr = {
                  ok: false,
                  error: {
                    code: "OUTPUT_TOO_SIMILAR",
                    message: `Try-on output too similar to selfie (diff=${Number(similarity.diffScore || 0).toFixed(2)} dhash=${similarity.dhashDist})`,
                  },
                  meta: {
                    ...(out.meta || {}),
                    ...(similarity || {}),
                    attemptedModels: attempted,
                    blended: false,
                    blendError: msg.slice(0, 160),
                    blendEnabled,
                    variationAttempt,
                    variationAttempts,
                  },
                };
                if (variationAttempt < variationAttempts) continue;
                break;
              }
            } catch {
              // ignore similarity failures
            }

            return {
              ok: true,
              value: { ...out.value, filename: `tryon.${out.value.ext}` },
              meta: { ...(out.meta || {}), attemptedModels: attempted, blended: false, blendError: msg.slice(0, 160), variationAttempt, variationAttempts },
            };
          }

          if (!blended.ok && blended.error?.code === "OUTPUT_TOO_SIMILAR") {
            lastErr = {
              ...blended,
              meta: {
                ...(blended.meta || {}),
                upstream: out.meta,
                blendEnabled,
                variationAttempt,
                variationAttempts,
              },
            };
            if (variationAttempt < variationAttempts) continue;
            break;
          }
          if (blended.ok) {
            return {
              ok: true,
              value: {
                mimeType: blended.value.mimeType,
                data: blended.value.dataB64,
                ext: "png",
                filename: "tryon.png",
              },
              meta: { ...(out.meta || {}), ...(blended.meta || {}), attemptedModels: attempted, blended: true, variationAttempt, variationAttempts },
            };
          }
        }

        const filename = `tryon.${out.value.ext}`;
        return { ok: true, value: { ...out.value, filename }, meta: { ...(out.meta || {}), attemptedModels: attempted, variationAttempt, variationAttempts } };
      }

      lastErr = out;
      if (lastErr && lastErr.meta && typeof lastErr.meta === "object") {
        lastErr = { ...lastErr, meta: { ...(lastErr.meta || {}), blendEnabled, variationAttempt, variationAttempts } };
      }

      const status = out?.error?.status;
      const code = out?.error?.code;
      if (code === "OUTPUT_TOO_SIMILAR" && variationAttempt < variationAttempts) continue;

      // Try the next model when the relay rejects the requested model (common for 403/404).
      if (status === 403 || status === 404 || code === "OUTPUT_TOO_SIMILAR" || code === "OUTPUT_SUSPECT_FACE_SWAP") break;
      variationAttempt = variationAttempts; // eslint-disable-line no-param-reassign
    }

    const status = lastErr?.error?.status;
    const code = lastErr?.error?.code;
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
