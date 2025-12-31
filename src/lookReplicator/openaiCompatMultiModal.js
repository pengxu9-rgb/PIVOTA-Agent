const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const axios = require("axios");
const sharp = require("sharp");

const { preprocessImageForGemini } = require("../layer1/llm/geminiImagePreprocess");

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

function normalizeBaseUrl(raw) {
  const s = String(raw || "").trim().replace(/\/+$/, "");
  if (!s) return null;
  if (s.endsWith("/v1")) return s.slice(0, -3);
  return s;
}

function openaiCompatConfig() {
  const baseUrl = normalizeBaseUrl(process.env.OPENAI_BASE_URL || process.env.LLM_BASE_URL || "");
  const apiKey = parseEnvString(process.env.OPENAI_API_KEY || process.env.LLM_API_KEY);
  return { baseUrl, apiKey };
}

function retryDelayMs(attempt) {
  const base = 250;
  const max = 2_000;
  const exp = Math.min(max, base * Math.pow(2, Math.max(0, attempt - 1)));
  const jitter = Math.floor(Math.random() * Math.min(200, exp));
  return Math.min(max, exp + jitter);
}

function isRetryableStatus(status) {
  return status === 429 || status === 503 || status === 502 || status === 504;
}

function isRetryableError(err) {
  if (!err) return false;
  if (err?.code === "ECONNABORTED") return true;
  const status = err?.response?.status;
  if (typeof status === "number" && isRetryableStatus(status)) return true;
  const msg = String(err?.message || "").toLowerCase();
  return msg.includes("timeout") || msg.includes("timed out") || msg.includes("econnreset") || msg.includes("etimedout");
}

function extractFirstTextContent(resp) {
  const msg = resp?.data?.choices?.[0]?.message;
  const content = msg?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content
      .map((c) => (c && typeof c === "object" ? c.text : null))
      .filter(Boolean)
      .map(String);
    return texts.join("\n");
  }
  return "";
}

function extractFirstImageData(resp) {
  const msg = resp?.data?.choices?.[0]?.message;
  const content = msg?.content;
  const candidates = [];
  if (Array.isArray(content)) candidates.push(...content);
  if (typeof content === "string") candidates.push({ type: "text", text: content });

  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;

    if (c.type === "image_url" && c.image_url && typeof c.image_url.url === "string") {
      const url = c.image_url.url;
      if (url.startsWith("data:image/")) return { kind: "data_url", url };
      if (url.startsWith("http://") || url.startsWith("https://")) return { kind: "http_url", url };
    }

    const text = typeof c.text === "string" ? c.text : "";
    const m = text.match(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/);
    if (m) return { kind: "data_url", url: m[0] };
  }

  // Some OpenAI-compatible proxies return images under `data[0].b64_json` (images endpoint style).
  const b64 = resp?.data?.data?.[0]?.b64_json;
  if (typeof b64 === "string" && b64) {
    return { kind: "base64", data: b64, mimeType: "image/png" };
  }

  return null;
}

function parseDataUrl(dataUrl) {
  const m = String(dataUrl || "").match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return null;
  return { mimeType: m[1], dataB64: m[2] };
}

function extFromMimeType(mimeType) {
  const mt = String(mimeType || "").toLowerCase();
  if (mt.includes("png")) return "png";
  if (mt.includes("webp")) return "webp";
  return "jpg";
}

async function tinyRgbFromImageBytes(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || "");
  if (!buf.length) throw new Error("EMPTY_IMAGE_BYTES");
  const { data } = await sharp(buf)
    .rotate()
    .resize(64, 64, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return data;
}

function meanAbsDiff(a, b) {
  const aa = Buffer.isBuffer(a) ? a : Buffer.from(a || "");
  const bb = Buffer.isBuffer(b) ? b : Buffer.from(b || "");
  const n = Math.min(aa.length, bb.length);
  if (!n) return null;
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += Math.abs(aa[i] - bb[i]);
  return sum / n;
}

async function tryComputeDiffScore({ selfieBytes, outputBytes }) {
  try {
    const a = await tinyRgbFromImageBytes(selfieBytes);
    const b = await tinyRgbFromImageBytes(outputBytes);
    return meanAbsDiff(a, b);
  } catch {
    return null;
  }
}

async function imagePathToDataUrl(imagePath, { maxEdge, quality }) {
  const imgPath = String(imagePath || "").trim();
  if (!imgPath) return null;

  const imgMaxEdge = Math.max(64, Number(maxEdge) || parseEnvInt(process.env.GEMINI_IMAGE_MAX_EDGE, 1536));
  const jpegQuality = Math.min(100, Math.max(1, Number(quality) || parseEnvInt(process.env.GEMINI_IMAGE_JPEG_QUALITY, 85)));

  let effectivePath = imgPath;
  let cleanup = null;
  try {
    const pre = await preprocessImageForGemini({ imagePath: imgPath, maxEdge: imgMaxEdge, quality: jpegQuality, tmpDir: os.tmpdir() });
    if (pre?.ok && pre.path) {
      effectivePath = pre.path;
      cleanup = typeof pre.cleanup === "function" ? pre.cleanup : null;
    }

    const bytes = fs.readFileSync(effectivePath);
    const dataB64 = Buffer.from(bytes).toString("base64");
    // We preprocess to jpeg, so use jpeg when preprocessed; else infer from ext.
    const ext = String(path.extname(effectivePath || "").slice(1) || "").toLowerCase();
    const mimeType = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    return `data:${mimeType};base64,${dataB64}`;
  } finally {
    if (cleanup) cleanup();
  }
}

async function postChatCompletions({ model, messages, timeoutMs, temperature, maxTokens }) {
  const { baseUrl, apiKey } = openaiCompatConfig();
  if (!baseUrl) return { ok: false, error: { code: "CONFIG_MISSING", message: "Missing OPENAI_BASE_URL (or LLM_BASE_URL)" } };
  if (!apiKey) return { ok: false, error: { code: "CONFIG_MISSING", message: "Missing OPENAI_API_KEY (or LLM_API_KEY)" } };
  if (!model) return { ok: false, error: { code: "CONFIG_MISSING", message: "Missing model" } };

  const debugEnabled = parseEnvBool(process.env.GEMINI_DEBUG) || parseEnvBool(process.env.LAYER1_SELFIE_DEBUG);
  const maxAttempts = Math.max(1, Math.min(5, parseEnvInt(process.env.LLM_MAX_ATTEMPTS, 3)));
  const timeout = Math.max(1, Number(timeoutMs) || parseEnvInt(process.env.LLM_TIMEOUT_MS, 30_000));

  const client = axios.create({
    baseURL: baseUrl,
    timeout,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    validateStatus: () => true,
  });

  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const resp = await client.post("/v1/chat/completions", {
        model,
        messages,
        temperature: typeof temperature === "number" ? temperature : 0.2,
        max_tokens: typeof maxTokens === "number" ? maxTokens : 1800,
      });
      if (resp.status >= 200 && resp.status < 300) return { ok: true, resp };

      const apiMessage =
        typeof resp?.data?.error?.message === "string" ? String(resp.data.error.message).trim() : "";
      const msg = `LLM request failed (HTTP ${resp.status})${apiMessage ? `: ${apiMessage.slice(0, 200)}` : ""}`;
      const err = new Error(msg);
      err.response = resp;
      last = err;
      if (attempt < maxAttempts && isRetryableStatus(resp.status)) {
        await new Promise((r) => setTimeout(r, retryDelayMs(attempt)));
        continue;
      }
      break;
    } catch (err) {
      last = err;
      if (debugEnabled) {
        // eslint-disable-next-line no-console
        console.log(`[openai_compat] attempt=${attempt}/${maxAttempts} ok=false err=${err instanceof Error ? err.message : String(err)}`);
      }
      if (attempt < maxAttempts && isRetryableError(err)) {
        await new Promise((r) => setTimeout(r, retryDelayMs(attempt)));
        continue;
      }
      break;
    }
  }

  const status = last?.response?.status;
  const apiMessage =
    typeof last?.response?.data?.error?.message === "string" ? String(last.response.data.error.message).trim() : "";
  const message = status
    ? `got status: ${status}. ${apiMessage || ""}`.trim()
    : String(last?.message || "REQUEST_FAILED");
  return { ok: false, error: { code: "REQUEST_FAILED", message: message.slice(0, 220), ...(status ? { status } : {}) } };
}

async function generateMultiImageJsonFromOpenAICompat({ promptText, images, schema, model }) {
  const meta = { model, attempted: false };
  const list = Array.isArray(images) ? images : [];
  if (!list.length) return { ok: false, error: { code: "MISSING_IMAGE", message: "Missing images" }, meta };

  const parts = [{ type: "text", text: String(promptText || "") }];
  for (const it of list) {
    const label = String(it?.label || "").trim() || "IMAGE";
    const p = String(it?.imagePath || "").trim();
    if (!p) return { ok: false, error: { code: "MISSING_IMAGE", message: `Missing imagePath for ${label}` }, meta };

    const dataUrl = await imagePathToDataUrl(p, {});
    if (!dataUrl) return { ok: false, error: { code: "MISSING_IMAGE", message: `Missing image data for ${label}` }, meta };
    parts.push({ type: "text", text: `${label}:` });
    parts.push({ type: "image_url", image_url: { url: dataUrl } });
  }

  meta.attempted = true;
  const out = await postChatCompletions({
    model,
    messages: [
      { role: "system", content: "You are a strict JSON generator. Output JSON only. No markdown, no extra text." },
      { role: "user", content: parts },
    ],
    temperature: 0,
    maxTokens: 1800,
  });
  if (!out.ok) return { ok: false, error: out.error, meta };

  const text = extractFirstTextContent(out.resp);
  if (!text.trim()) return { ok: false, error: { code: "EMPTY_RESPONSE", message: "Empty model output" }, meta };
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // best-effort extraction
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      return { ok: false, error: { code: "JSON_PARSE_FAILED", message: "Model output is not JSON" }, meta, raw: text.slice(0, 2000) };
    }
    try {
      json = JSON.parse(text.slice(start, end + 1));
    } catch {
      return { ok: false, error: { code: "JSON_PARSE_FAILED", message: "Failed to parse JSON" }, meta, raw: text.slice(0, 2000) };
    }
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) return { ok: false, error: { code: "SCHEMA_INVALID", message: "Model JSON did not match expected schema" }, meta, details: parsed.error.format() };
  return { ok: true, value: parsed.data, meta };
}

async function generateMultiImageImageFromOpenAICompat({ promptText, images, model }) {
  const meta = { model, attempted: false };
  const list = Array.isArray(images) ? images : [];
  if (!list.length) return { ok: false, error: { code: "MISSING_IMAGE", message: "Missing images" }, meta };

  const parts = [{ type: "text", text: String(promptText || "") }];
  for (const it of list) {
    const label = String(it?.label || "").trim() || "IMAGE";
    const p = String(it?.imagePath || "").trim();
    if (!p) return { ok: false, error: { code: "MISSING_IMAGE", message: `Missing imagePath for ${label}` }, meta };

    const dataUrl = await imagePathToDataUrl(p, {});
    if (!dataUrl) return { ok: false, error: { code: "MISSING_IMAGE", message: `Missing image data for ${label}` }, meta };
    parts.push({ type: "text", text: `${label}:` });
    parts.push({ type: "image_url", image_url: { url: dataUrl } });
  }

  meta.attempted = true;
  const out = await postChatCompletions({
    model,
    messages: [
      { role: "system", content: "You are an image editing assistant. Return a single edited image. If possible, return it as a data URL (data:image/...;base64,...)." },
      { role: "user", content: parts },
    ],
    timeoutMs: parseEnvInt(process.env.LLM_TIMEOUT_MS, 45_000),
    temperature: 0.2,
    maxTokens: 1800,
  });
  if (!out.ok) return { ok: false, error: out.error, meta };

  const img = extractFirstImageData(out.resp);
  if (!img) return { ok: false, error: { code: "EMPTY_IMAGE", message: "Model did not return an image" }, meta };

  if (img.kind === "base64") {
    const mimeType = String(img.mimeType || "image/png");
    const data = String(img.data || "");
    const ext = extFromMimeType(mimeType);
    const selfiePath = list.find((x) => String(x?.label || "").trim().toUpperCase() === "SELFIE_IMAGE")?.imagePath;
    if (selfiePath) {
      const diffScore = await tryComputeDiffScore({
        selfieBytes: fs.readFileSync(String(selfiePath)),
        outputBytes: Buffer.from(data, "base64"),
      });
      const minDiff = Number(process.env.LOOK_REPLICATOR_TRYON_MIN_DIFF || "2.5");
      if (diffScore != null && Number.isFinite(diffScore) && diffScore < minDiff) {
        return {
          ok: false,
          error: { code: "OUTPUT_TOO_SIMILAR", message: `Try-on output too similar to selfie (diff=${diffScore.toFixed(2)})` },
          meta: { ...meta, diffScore },
        };
      }
      meta.diffScore = diffScore;
    }
    return { ok: true, value: { mimeType, data, ext }, meta };
  }

  if (img.kind === "data_url") {
    const parsed = parseDataUrl(img.url);
    if (!parsed) return { ok: false, error: { code: "IMAGE_PARSE_FAILED", message: "Invalid data URL" }, meta };
    const ext = extFromMimeType(parsed.mimeType);
    const selfiePath = list.find((x) => String(x?.label || "").trim().toUpperCase() === "SELFIE_IMAGE")?.imagePath;
    if (selfiePath) {
      const diffScore = await tryComputeDiffScore({
        selfieBytes: fs.readFileSync(String(selfiePath)),
        outputBytes: Buffer.from(parsed.dataB64, "base64"),
      });
      const minDiff = Number(process.env.LOOK_REPLICATOR_TRYON_MIN_DIFF || "2.5");
      if (diffScore != null && Number.isFinite(diffScore) && diffScore < minDiff) {
        return {
          ok: false,
          error: { code: "OUTPUT_TOO_SIMILAR", message: `Try-on output too similar to selfie (diff=${diffScore.toFixed(2)})` },
          meta: { ...meta, diffScore },
        };
      }
      meta.diffScore = diffScore;
    }
    return { ok: true, value: { mimeType: parsed.mimeType, data: parsed.dataB64, ext }, meta };
  }

  // http_url is unsupported here (we avoid SSRF here). Return an explicit error.
  return { ok: false, error: { code: "IMAGE_URL_UNSUPPORTED", message: "Model returned a remote URL; expected base64 image" }, meta };
}

module.exports = {
  openaiCompatConfig,
  generateMultiImageJsonFromOpenAICompat,
  generateMultiImageImageFromOpenAICompat,
};
