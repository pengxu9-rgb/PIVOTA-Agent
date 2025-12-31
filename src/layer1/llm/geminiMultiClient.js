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

function extractResponseText(resp) {
  if (!resp) return "";
  if (typeof resp.text === "string") return resp.text;
  if (typeof resp.text === "function") return resp.text();
  if (typeof resp?.response?.text === "function") return resp.response.text();
  if (typeof resp?.response?.text === "string") return resp.response.text;
  return "";
}

function guessMimeTypeFromPath(p) {
  const ext = String(path.extname(String(p || "")).toLowerCase());
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/jpeg";
}

function parseJsonObjectStrict(text) {
  const s = String(text || "").trim();
  if (!s) throw new Error("Empty response");
  return JSON.parse(s);
}

async function withTimeout(promise, timeoutMs) {
  const ms = Math.max(1, timeoutMs);
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Gemini multi-image JSON generation helper.
 * - Uses the same guards & preprocessing as single-image calls.
 * - Accepts multiple local image paths; each image is attached with a label.
 */
async function generateMultiImageJsonFromGemini({ promptText, images, schema }) {
  const apiKey = parseEnvString(process.env.GEMINI_API_KEY);
  const model = parseEnvString(process.env.GEMINI_MODEL) || "gemini-2.5-flash";
  const timeoutMs = Math.max(1, parseEnvInt(process.env.GEMINI_TIMEOUT_MS, 25_000));
  const debugEnabled = parseEnvBool(process.env.GEMINI_DEBUG) || parseEnvBool(process.env.LAYER1_SELFIE_DEBUG);
  const imgMaxEdge = Math.max(64, parseEnvInt(process.env.GEMINI_IMAGE_MAX_EDGE, 1536));
  const jpegQuality = Math.min(100, Math.max(1, parseEnvInt(process.env.GEMINI_IMAGE_JPEG_QUALITY, 85)));

  const meta = {
    model,
    attempted: false,
    latencyMs: null,
    limiter: getGeminiGuards().snapshot().limiter,
    preprocess: [],
  };

  if (!apiKey) return { ok: false, error: { code: "MISSING_API_KEY", message: "Missing GEMINI_API_KEY" }, meta };

  let GoogleGenAI = null;
  try {
    ({ GoogleGenAI } = require("@google/genai"));
  } catch {
    return { ok: false, error: { code: "MISSING_DEP", message: "Missing @google/genai dependency" }, meta };
  }

  const list = Array.isArray(images) ? images : [];
  if (list.length < 1) return { ok: false, error: { code: "MISSING_IMAGE", message: "Missing images" }, meta };

  const cleanupFns = [];
  const parts = [{ text: String(promptText || "") }];

  try {
    for (const it of list) {
      const label = String(it?.label || "").trim() || "IMAGE";
      const imagePath = String(it?.imagePath || "").trim();
      if (!imagePath) {
        return { ok: false, error: { code: "MISSING_IMAGE", message: `Missing imagePath for ${label}` }, meta };
      }

      let effectivePath = imagePath;
      let usedOriginal = true;
      let preprocessOk = null;
      let preprocessErrorCode = null;

      try {
        const pre = await preprocessImageForGemini({
          imagePath,
          maxEdge: imgMaxEdge,
          quality: jpegQuality,
          tmpDir: os.tmpdir(),
        });
        if (pre?.ok && pre.path) {
          effectivePath = pre.path;
          usedOriginal = false;
          preprocessOk = true;
          if (typeof pre.cleanup === "function") cleanupFns.push(pre.cleanup);
        } else if (pre && pre.ok === false) {
          preprocessOk = false;
          preprocessErrorCode = String(pre?.error?.code || "PREPROCESS_FAILED");
        }
      } catch {
        preprocessOk = false;
        preprocessErrorCode = "PREPROCESS_FAILED";
      }

      meta.preprocess.push({ label, ok: preprocessOk, usedOriginal, errorCode: preprocessErrorCode });

      const bytes = fs.readFileSync(effectivePath);
      const data = bytes.toString("base64");
      const mimeType = usedOriginal ? String(it?.mimeType || "").trim() || guessMimeTypeFromPath(imagePath) : "image/jpeg";

      parts.push({ text: `${label}:` });
      parts.push({ inlineData: { mimeType, data } });
    }

    const ai = new GoogleGenAI({ apiKey });
    const request = {
      model,
      contents: [{ role: "user", parts }],
      config: { temperature: 0, responseMimeType: "application/json" },
    };

    const t0 = Date.now();
    const guards = getGeminiGuards();
    meta.limiter = guards.snapshot().limiter;
    meta.attempted = true;

    const response = await guards.withGuards("gemini", () => withTimeout(ai.models.generateContent(request), timeoutMs));
    const text = String(await extractResponseText(response));
    if (!text.trim()) {
      meta.latencyMs = Date.now() - t0;
      return { ok: false, error: { code: "EMPTY_RESPONSE", message: "Gemini returned empty response text" }, meta };
    }

    let json;
    try {
      json = parseJsonObjectStrict(text);
    } catch (err) {
      meta.latencyMs = Date.now() - t0;
      return { ok: false, error: { code: "JSON_PARSE_FAILED", message: "Gemini returned invalid JSON" }, meta, raw: text.slice(0, 2000) };
    }

    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      meta.latencyMs = Date.now() - t0;
      return { ok: false, error: { code: "SCHEMA_INVALID", message: "Gemini JSON did not match expected schema" }, meta, details: parsed.error.format(), raw: text.slice(0, 2000) };
    }

    meta.latencyMs = Date.now() - t0;
    return { ok: true, value: parsed.data, meta };
  } catch (err) {
    if (err instanceof GeminiGuardError) {
      return { ok: false, error: { code: err.code, message: String(err.message || "").slice(0, 220) }, meta };
    }
    if (debugEnabled) {
      // eslint-disable-next-line no-console
      console.log(`[gemini_multi_client] failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const msg = err instanceof Error ? err.message : String(err || "");
    return { ok: false, error: { code: "REQUEST_FAILED", message: msg.slice(0, 220) }, meta };
  } finally {
    for (const fn of cleanupFns) {
      try {
        fn();
      } catch {
        // ignore
      }
    }
  }
}

module.exports = {
  generateMultiImageJsonFromGemini,
};
