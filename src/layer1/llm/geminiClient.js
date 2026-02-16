const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { GeminiGuardError, getGeminiGuards } = require("./geminiGuards");
const { preprocessImageForGemini } = require("./geminiImagePreprocess");

function parseEnvString(v) {
  const s = String(v ?? "").trim();
  return s || null;
}

function parseEnvInt(v, fallback) {
  const n = Number.parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function parseEnvBool(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

function guessMimeTypeFromPath(p) {
  const ext = String(path.extname(String(p || "")).toLowerCase());
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/jpeg";
}

function extractResponseText(resp) {
  if (!resp) return "";
  if (typeof resp.text === "string") return resp.text;
  if (typeof resp.text === "function") return resp.text();
  if (typeof resp?.response?.text === "function") return resp.response.text();
  if (typeof resp?.response?.text === "string") return resp.response.text;
  return "";
}

function isRetryableMessage(msg) {
  const s = String(msg || "").toLowerCase();
  if (!s) return false;
  // Common transient signals: rate limits, service unavailable, network resets, timeouts.
  return (
    s.includes("429") ||
    s.includes("503") ||
    s.includes("timeout") ||
    s.includes("timed out") ||
    s.includes("econnreset") ||
    s.includes("etimedout") ||
    s.includes("eai_again") ||
    s.includes("temporarily") ||
    s.includes("rate limit")
  );
}

function computeRetryDelayMs({ attempt, baseDelayMs, maxDelayMs }) {
  const exp = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
  const jitter = Math.floor(Math.random() * Math.min(exp, 100));
  return Math.min(maxDelayMs, exp + jitter);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs) {
  const ms = Math.max(1, timeoutMs);
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function isLikelyImageBytes(buf) {
  if (!Buffer.isBuffer(buf)) return false;
  if (buf.length < 12) return false;

  // JPEG SOI: FF D8
  if (buf[0] === 0xff && buf[1] === 0xd8) return true;

  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  )
    return true;

  // GIF: "GIF87a" / "GIF89a"
  const hdr6 = buf.subarray(0, 6).toString("ascii");
  if (hdr6 === "GIF87a" || hdr6 === "GIF89a") return true;

  // WebP: "RIFF....WEBP"
  const riff = buf.subarray(0, 4).toString("ascii");
  const webp = buf.subarray(8, 12).toString("ascii");
  if (riff === "RIFF" && webp === "WEBP") return true;

  return false;
}

async function generateLookSpecFromImage({ imagePath, promptText, responseJsonSchema }) {
  const apiKey = parseEnvString(process.env.GEMINI_API_KEY) || parseEnvString(process.env.GOOGLE_API_KEY);
  const model = parseEnvString(process.env.GEMINI_MODEL) || "gemini-2.5-flash";
  const timeoutMs = Math.max(1, parseEnvInt(process.env.GEMINI_TIMEOUT_MS, 20_000));
  const maxRetries = Math.max(0, parseEnvInt(process.env.GEMINI_MAX_RETRIES, 1));
  const baseDelayMs = Math.max(1, parseEnvInt(process.env.GEMINI_RETRY_BASE_DELAY_MS, 200));
  const maxDelayMs = 1_000;
  const debugEnabled = parseEnvBool(process.env.GEMINI_DEBUG) || parseEnvBool(process.env.LAYER1_SELFIE_DEBUG);
  const imgMaxEdge = Math.max(64, parseEnvInt(process.env.GEMINI_IMAGE_MAX_EDGE, 1536));
  const jpegQuality = Math.min(100, Math.max(1, parseEnvInt(process.env.GEMINI_IMAGE_JPEG_QUALITY, 85)));

  const meta = {
    model,
    attempted: false,
    retries: 0,
    latencyMs: null,
    limiter: getGeminiGuards().snapshot().limiter,
    preprocess: { ok: null, usedOriginal: true, errorCode: null },
  };

  if (!apiKey) {
    return { ok: false, error: { code: "MISSING_API_KEY", message: "Missing GEMINI_API_KEY or GOOGLE_API_KEY" }, meta };
  }

  let GoogleGenAI = null;
  try {
    ({ GoogleGenAI } = require("@google/genai"));
  } catch (err) {
    return { ok: false, error: { code: "MISSING_DEP", message: "Missing @google/genai dependency" }, meta };
  }

  const imgPath = String(imagePath || "").trim();
  if (!imgPath) {
    return { ok: false, error: { code: "MISSING_IMAGE", message: "Missing imagePath" }, meta };
  }

  let effectivePath = imgPath;
  let cleanupPreprocessed = null;
  try {
    const pre = await preprocessImageForGemini({
      imagePath: imgPath,
      maxEdge: imgMaxEdge,
      quality: jpegQuality,
      tmpDir: os.tmpdir(),
    });
    if (pre?.ok && pre.path) {
      effectivePath = pre.path;
      cleanupPreprocessed = typeof pre.cleanup === "function" ? pre.cleanup : null;
      meta.preprocess.ok = true;
      meta.preprocess.usedOriginal = false;
    } else if (pre && pre.ok === false) {
      meta.preprocess.ok = false;
      meta.preprocess.usedOriginal = true;
      meta.preprocess.errorCode = String(pre?.error?.code || "PREPROCESS_FAILED");
    }
  } catch {
    meta.preprocess.ok = false;
    meta.preprocess.usedOriginal = true;
    meta.preprocess.errorCode = "PREPROCESS_FAILED";
  }

  try {
    const tStart = Date.now();
    const bytes = fs.readFileSync(effectivePath);
    const mimeType = effectivePath === imgPath ? guessMimeTypeFromPath(imgPath) : "image/jpeg";

    if (effectivePath === imgPath && meta.preprocess.ok === false && !isLikelyImageBytes(bytes)) {
      meta.preprocess.errorCode = meta.preprocess.errorCode || "PREPROCESS_FAILED";
      return {
        ok: false,
        error: { code: "PREPROCESS_FAILED", message: "Input does not look like a supported image; skipping Gemini call" },
        meta,
      };
    }

    const data = bytes.toString("base64");

    const ai = new GoogleGenAI({ apiKey });

    const request = {
      model,
      contents: [
        {
          role: "user",
          parts: [{ inlineData: { mimeType, data } }, { text: String(promptText || "") }],
        },
      ],
      config: {
        temperature: 0,
        responseMimeType: "application/json",
        responseJsonSchema,
      },
    };

    const maxAttempts = 1 + maxRetries;
    let lastErrMsg = "";
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const guards = getGeminiGuards();
        meta.limiter = guards.snapshot().limiter;
        meta.attempted = true;

        const response = await guards.withGuards("gemini", () => withTimeout(ai.models.generateContent(request), timeoutMs));
        const text = String(await extractResponseText(response));
        if (!text.trim()) {
          meta.latencyMs = Date.now() - tStart;
          meta.retries = attempt;
          return { ok: false, error: { code: "EMPTY_RESPONSE", message: "Gemini returned empty response text" }, meta };
        }

        meta.latencyMs = Date.now() - tStart;
        meta.retries = attempt;
        return { ok: true, value: text, meta };
      } catch (err) {
        if (err instanceof GeminiGuardError) {
          meta.latencyMs = Date.now() - tStart;
          meta.retries = attempt;
          return { ok: false, error: { code: err.code, message: String(err.message || "").slice(0, 220) }, meta };
        }

        const msg = err instanceof Error ? err.message : String(err || "");
        lastErrMsg = msg.slice(0, 220);
        const retryable = isRetryableMessage(msg);
        const canRetry = retryable && attempt < maxAttempts - 1;

        if (debugEnabled) {
          // eslint-disable-next-line no-console
          console.log(
            `[gemini_client] attempt=${attempt + 1}/${maxAttempts} ok=false retryable=${retryable} willRetry=${canRetry} err=${lastErrMsg}`,
          );
        }

        if (!canRetry) break;
        const delayMs = computeRetryDelayMs({ attempt, baseDelayMs, maxDelayMs });
        await sleep(delayMs);
      }
    }

    meta.latencyMs = meta.latencyMs ?? 0;
    meta.retries = Math.max(0, maxAttempts - 1);
    return { ok: false, error: { code: "REQUEST_FAILED", message: lastErrMsg || "REQUEST_FAILED" }, meta };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err || "");
    return { ok: false, error: { code: "REQUEST_FAILED", message: msg.slice(0, 220) }, meta };
  } finally {
    if (cleanupPreprocessed) cleanupPreprocessed();
  }
}

module.exports = {
  generateLookSpecFromImage,
};
