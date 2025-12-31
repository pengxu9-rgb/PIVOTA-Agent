const path = require("node:path");

const { generateMultiImageImageFromGemini } = require("../layer1/llm/geminiMultiClient");

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

  return { ok: true, value: { mimeType, data, ext, filename }, meta: out.meta };
}

module.exports = {
  runTryOnGenerateImageGemini,
};

