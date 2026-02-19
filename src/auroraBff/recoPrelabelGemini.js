const { GoogleGenAI } = require('@google/genai');

function toInt(value, fallback, min, max) {
  const n = Number(value);
  const v = Number.isFinite(n) ? Math.trunc(n) : fallback;
  return Math.max(min, Math.min(max, v));
}

function normalizeModel(raw) {
  const s = String(raw || '').trim();
  return s || 'gemini-2.0-flash';
}

function withTimeout(promise, timeoutMs) {
  const safeMs = Math.max(500, Number(timeoutMs) || 5000);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`gemini prelabel timeout after ${safeMs}ms`);
      err.code = 'PRELABEL_TIMEOUT';
      reject(err);
    }, safeMs);
    Promise.resolve(promise)
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function extractTextFromGeminiResponse(resp) {
  const parts = Array.isArray(resp?.candidates?.[0]?.content?.parts)
    ? resp.candidates[0].content.parts
    : [];
  const text = parts
    .map((p) => String(p?.text || '').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
  return text;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(err) {
  const text = String(err?.message || err || '').toLowerCase();
  if (!text) return false;
  return text.includes('timeout') || text.includes('429') || text.includes('503') || text.includes('rate');
}

function createSemaphore(limit) {
  const max = Math.max(1, Number(limit) || 1);
  let inUse = 0;
  const queue = [];

  async function acquire() {
    if (inUse < max) {
      inUse += 1;
      return () => {
        inUse = Math.max(0, inUse - 1);
        const next = queue.shift();
        if (next) next();
      };
    }
    return new Promise((resolve) => {
      queue.push(() => {
        inUse += 1;
        resolve(() => {
          inUse = Math.max(0, inUse - 1);
          const next = queue.shift();
          if (next) next();
        });
      });
    });
  }

  return { acquire };
}

function createTokenBucket(ratePerMin) {
  const rate = Math.max(1, Number(ratePerMin) || 120);
  let tokens = rate;
  let lastTs = Date.now();

  function take() {
    const now = Date.now();
    const elapsed = Math.max(0, now - lastTs);
    const refill = (elapsed * rate) / 60000;
    tokens = Math.min(rate, tokens + refill);
    lastTs = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  }

  return { take };
}

const prelabelSemaphore = createSemaphore(
  toInt(process.env.AURORA_BFF_RECO_PRELABEL_CONCURRENCY, 8, 1, 64),
);
const prelabelRateBucket = createTokenBucket(
  toInt(process.env.AURORA_BFF_RECO_PRELABEL_RATE_PER_MIN, 120, 1, 5000),
);

async function callGeminiPrelabel({
  systemPrompt,
  userPrompt,
  timeoutMs = 5000,
  model = process.env.AURORA_BFF_RECO_PRELABEL_MODEL || 'gemini-2.0-flash',
  logger,
} = {}) {
  const apiKey = String(
    process.env.AURORA_SKIN_GEMINI_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
  ).trim();
  if (!apiKey) {
    const err = new Error('MISSING_GEMINI_KEY');
    err.code = 'MISSING_GEMINI_KEY';
    throw err;
  }
  if (!prelabelRateBucket.take()) {
    const err = new Error('PRELABEL_RATE_LIMITED');
    err.code = 'PRELABEL_RATE_LIMITED';
    throw err;
  }
  const release = await prelabelSemaphore.acquire();
  const startedAt = Date.now();
  try {
    const ai = new GoogleGenAI({ apiKey });
    const request = {
      model: normalizeModel(model),
      systemInstruction: {
        parts: [{ text: String(systemPrompt || '').trim() }],
      },
      contents: [
        {
          role: 'user',
          parts: [{ text: String(userPrompt || '').trim() }],
        },
      ],
      config: {
        temperature: 0,
        responseMimeType: 'application/json',
      },
    };

    const maxAttempts = toInt(process.env.AURORA_BFF_RECO_PRELABEL_CALL_RETRIES, 1, 0, 2) + 1;
    let lastErr = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const resp = await withTimeout(ai.models.generateContent(request), timeoutMs);
        const text = extractTextFromGeminiResponse(resp);
        return {
          ok: true,
          text,
          attempts: attempt + 1,
          latency_ms: Date.now() - startedAt,
          model_name: normalizeModel(model),
        };
      } catch (err) {
        lastErr = err;
        if (attempt >= maxAttempts - 1 || !isRetryable(err)) break;
        await sleep(220 * (2 ** attempt));
      }
    }
    throw lastErr || new Error('PRELABEL_GEMINI_FAILED');
  } catch (err) {
    logger?.warn?.(
      {
        err: err?.message || String(err),
        code: err?.code || null,
      },
      'aurora bff: prelabel gemini call failed',
    );
    throw err;
  } finally {
    release();
  }
}

module.exports = {
  callGeminiPrelabel,
  __internal: {
    extractTextFromGeminiResponse,
    withTimeout,
  },
};
