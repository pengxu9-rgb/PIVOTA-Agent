const path = require("node:path");
const fs = require("node:fs");

const { generateMultiImageImageFromGemini } = require("../layer1/llm/geminiMultiClient");
const { computeSimilarity, isTooSimilar, isSuspectFaceSwap } = require("./imageSimilarity");

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
- If the makeup style is subtle, still adjust at least lips/eyes/base so the difference is clearly perceptible.

Priority (must match TARGET_IMAGE):
1) Base makeup (底妆): match undertone + brightness, foundation finish (matte/satin/dewy), coverage, and skin texture impression.
   - If TARGET_IMAGE looks warmer/cooler than SELFIE_IMAGE, shift undertone accordingly.
   - Recreate highlight vs. shadow distribution (T-zone glow vs. oil control), but keep it natural.
2) Eye makeup (眼妆): match eyeshadow palette (2–3 tones), saturation, warmth/coolness, eyeliner angle/thickness/tail length, and overall eye depth.
   - Make the eyeshadow color difference noticeable (but not costume-like).
3) Lip color (口红): match the shade as close as possible: hue family (nude/rose/coral/red/berry), depth (lighter/deeper), saturation, and finish (matte/velvet/glossy).
   - Ensure lip color change is clearly visible vs. SELFIE_IMAGE.

High-fidelity instructions (CRITICAL):
1) Base Makeup (Foundation): Recreate the exact skin finish (matte/dewy/satin) of TARGET_IMAGE. Apply a high-coverage foundation effect that evens out the skin tone clearly while retaining the same person identity and facial structure.
2) Eye Makeup (Critical): Heavily emphasize the eye makeup. Replicate the eyeshadow color, gradient, and placement. Ensure the eyeliner shape is sharp, dark, and clearly defined. Make the eyeshadow noticeably pigmented (not washed out).
3) Lip Makeup: Accurately clone the lipstick shade, saturation, and texture/finish (velvet/glossy/satin/matte) from TARGET_IMAGE. The lip contours should be precise and the color must be vibrant.
4) Overall Vibe: The final result should look like a professional makeup trial. Increase makeup opacity and color saturation to closely match TARGET_IMAGE.

Quality bar:
- The edited result should look like the same person as SELFIE_IMAGE wearing the makeup from TARGET_IMAGE.
- The output must not be identical to SELFIE_IMAGE. If unsure, bias slightly stronger on lips/eyes/base while staying wearable.
- Make base/eyes/lips changes clearly noticeable and as close as possible to TARGET_IMAGE (do not under-apply).
- Avoid artifacts (face warping, extra facial features, smeared textures).

You will receive images in this order, each preceded by a label:
- TARGET_IMAGE (style reference)
- SELFIE_IMAGE (person to edit)
- CURRENT_RENDER (optional, current try-on result)

If USER_REQUEST exists, apply it subtly while staying close to TARGET_IMAGE.

Return an IMAGE only.

USER_REQUEST:
${reqText || "(none)"}

CONTEXT_JSON (optional, may include target breakdown and mismatch hints):
${ctxText || "(none)"}
`;
}

function extFromMimeType(mimeType) {
  const mt = String(mimeType || "").toLowerCase();
  if (mt.includes("png")) return "png";
  if (mt.includes("webp")) return "webp";
  return "jpg";
}

async function runTryOnGenerateImageGemini({
  targetImagePath,
  selfieImagePath,
  currentRenderImagePath,
  userRequest,
  contextJson,
}) {
  const promptText = buildTryOnImagePrompt({ userRequest, contextJson });

  const images = [
    { label: "TARGET_IMAGE", imagePath: targetImagePath },
    { label: "SELFIE_IMAGE", imagePath: selfieImagePath },
    ...(currentRenderImagePath ? [{ label: "CURRENT_RENDER", imagePath: currentRenderImagePath }] : []),
  ];

  const out = await generateMultiImageImageFromGemini({ promptText, images });
  if (!out?.ok) return out;

  const mimeType = String(out.value?.mimeType || "image/png");
  const data = String(out.value?.data || "");
  const ext = extFromMimeType(mimeType);
  const filename = `tryon.${ext}`;

  try {
    const selfieBytes = fs.readFileSync(String(selfieImagePath));
    const targetBytes = fs.readFileSync(String(targetImagePath));
    const outputBytes = Buffer.from(data, "base64");
    const outSelfie = await computeSimilarity(selfieBytes, outputBytes).catch(() => null);
    const outTarget = await computeSimilarity(targetBytes, outputBytes).catch(() => null);
    const selfieTarget = await computeSimilarity(selfieBytes, targetBytes).catch(() => null);

    const minDiff = Number(process.env.LOOK_REPLICATOR_TRYON_MIN_DIFF || "6");
    const maxDhashDist = Number(process.env.LOOK_REPLICATOR_TRYON_MAX_DHASH_DIST || "4");
    if (outSelfie && isTooSimilar(outSelfie, { minDiff, maxDhashDist })) {
      return {
        ok: false,
        error: {
          code: "OUTPUT_TOO_SIMILAR",
          message: `Try-on output too similar to selfie (diff=${Number(outSelfie.diffScore || 0).toFixed(2)} dhash=${outSelfie.dhashDist})`,
        },
        meta: { ...(out.meta || {}), ...(outSelfie || {}) },
      };
    }

    const faceSwapOpts = {
      maxTargetDiff: Number(process.env.LOOK_REPLICATOR_TRYON_FACE_SWAP_MAX_TARGET_DIFF || "20"),
      maxTargetDhashDist: Number(process.env.LOOK_REPLICATOR_TRYON_FACE_SWAP_MAX_TARGET_DHASH_DIST || "10"),
      diffMargin: Number(process.env.LOOK_REPLICATOR_TRYON_FACE_SWAP_DIFF_MARGIN || "6"),
      dhashMargin: Number(process.env.LOOK_REPLICATOR_TRYON_FACE_SWAP_DHASH_MARGIN || "8"),
    };
    if (outSelfie && outTarget && isSuspectFaceSwap(outSelfie, outTarget, selfieTarget, faceSwapOpts)) {
      return {
        ok: false,
        error: {
          code: "OUTPUT_SUSPECT_FACE_SWAP",
          message: `Try-on output resembles TARGET more than SELFIE (outSelfie diff=${Number(outSelfie.diffScore || 0).toFixed(
            2
          )} dhash=${outSelfie.dhashDist}; outTarget diff=${Number(outTarget.diffScore || 0).toFixed(2)} dhash=${outTarget.dhashDist})`,
        },
        meta: {
          ...(out.meta || {}),
          ...(outSelfie || {}),
          ...(outTarget ? { targetDiffScore: outTarget.diffScore, targetDhashDist: outTarget.dhashDist } : {}),
          ...(selfieTarget ? { selfieTargetDiffScore: selfieTarget.diffScore, selfieTargetDhashDist: selfieTarget.dhashDist } : {}),
        },
      };
    }
  } catch {
    // ignore similarity failures
  }

  return { ok: true, value: { mimeType, data, ext, filename }, meta: out.meta };
}

module.exports = {
  runTryOnGenerateImageGemini,
};
