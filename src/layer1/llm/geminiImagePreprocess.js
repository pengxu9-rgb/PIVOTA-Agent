const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function parseEnvInt(v, fallback) {
  const n = Number.parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function parseEnvBool(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

function safeMsg(err) {
  const msg = err instanceof Error ? err.message : String(err || "");
  return msg.slice(0, 220);
}

async function preprocessImageForGemini({ imagePath, maxEdge, quality, tmpDir } = {}) {
  const inputPath = String(imagePath || "").trim();
  if (!inputPath) return { ok: false, error: { code: "MISSING_IMAGE", message: "Missing imagePath" } };

  let sharp = null;
  try {
    sharp = require("sharp");
  } catch (err) {
    return { ok: false, error: { code: "MISSING_DEP", message: "Missing sharp dependency" } };
  }

  const outDir = String(tmpDir || "").trim() || os.tmpdir();
  const outName = `pivota-gemini-pre-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.jpg`;
  const outPath = path.join(outDir, outName);

  const maxEdgePx = Math.max(64, Number(maxEdge) || parseEnvInt(process.env.GEMINI_IMAGE_MAX_EDGE, 1536));
  const q = Math.min(100, Math.max(1, Number(quality) || parseEnvInt(process.env.GEMINI_IMAGE_JPEG_QUALITY, 85)));
  const debugEnabled = parseEnvBool(process.env.GEMINI_DEBUG) || parseEnvBool(process.env.LAYER1_SELFIE_DEBUG);

  try {
    await sharp(inputPath)
      .rotate()
      .resize({ width: maxEdgePx, height: maxEdgePx, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: q })
      .toFile(outPath);

    return {
      ok: true,
      path: outPath,
      cleanup: () => {
        try {
          fs.rmSync(outPath, { force: true });
        } catch {
          // ignore
        }
      },
    };
  } catch (err) {
    if (debugEnabled) {
      // eslint-disable-next-line no-console
      console.log(`[gemini_preprocess] ok=false err=${safeMsg(err)}`);
    }
    try {
      fs.rmSync(outPath, { force: true });
    } catch {
      // ignore
    }
    return { ok: false, error: { code: "PREPROCESS_FAILED", message: safeMsg(err) } };
  }
}

module.exports = {
  preprocessImageForGemini,
};

