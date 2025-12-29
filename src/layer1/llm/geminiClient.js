const fs = require("node:fs");
const path = require("node:path");

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

async function generateLookSpecFromImage({ imagePath, promptText, responseJsonSchema }) {
  const apiKey = parseEnvString(process.env.GEMINI_API_KEY);
  const model = parseEnvString(process.env.GEMINI_MODEL) || "gemini-2.5-flash";
  const timeoutMs = Math.max(1, parseEnvInt(process.env.GEMINI_TIMEOUT_MS, 20_000));
  const maxRetries = Math.max(0, parseEnvInt(process.env.GEMINI_MAX_RETRIES, 1));
  const baseDelayMs = Math.max(1, parseEnvInt(process.env.GEMINI_RETRY_BASE_DELAY_MS, 200));
  const maxDelayMs = 1_000;
  const debugEnabled = parseEnvBool(process.env.GEMINI_DEBUG) || parseEnvBool(process.env.LAYER1_SELFIE_DEBUG);

  if (!apiKey) {
    return { ok: false, error: { code: "MISSING_API_KEY", message: "Missing GEMINI_API_KEY" } };
  }

  let GoogleGenAI = null;
  try {
    ({ GoogleGenAI } = require("@google/genai"));
  } catch (err) {
    return { ok: false, error: { code: "MISSING_DEP", message: "Missing @google/genai dependency" } };
  }

  const imgPath = String(imagePath || "").trim();
  if (!imgPath) {
    return { ok: false, error: { code: "MISSING_IMAGE", message: "Missing imagePath" } };
  }

  try {
    const bytes = fs.readFileSync(imgPath);
    const mimeType = guessMimeTypeFromPath(imgPath);
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
        const response = await withTimeout(ai.models.generateContent(request), timeoutMs);
        const text = String(await extractResponseText(response));
        if (!text.trim()) {
          return { ok: false, error: { code: "EMPTY_RESPONSE", message: "Gemini returned empty response text" } };
        }

        return { ok: true, value: text };
      } catch (err) {
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

    return { ok: false, error: { code: "REQUEST_FAILED", message: lastErrMsg || "REQUEST_FAILED" } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err || "");
    return { ok: false, error: { code: "REQUEST_FAILED", message: msg.slice(0, 220) } };
  }
}

module.exports = {
  generateLookSpecFromImage,
};
