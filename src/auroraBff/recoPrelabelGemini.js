const {
  hasAuroraGeminiApiKey,
  callAuroraGeminiGenerateContent,
} = require('./auroraGeminiGlobalClient');
const { resolveNonImageGeminiModel } = require('../lib/geminiModelFloor');

function toInt(value, fallback, min, max) {
  const n = Number(value);
  const v = Number.isFinite(n) ? Math.trunc(n) : fallback;
  return Math.max(min, Math.min(max, v));
}

function normalizeModel(raw) {
  return resolveNonImageGeminiModel({
    model: String(raw || '').trim(),
    fallbackModel: 'gemini-3-flash-preview',
    envSource: 'AURORA_BFF_RECO_PRELABEL_MODEL',
    callPath: 'aurora_reco_prelabel',
  }).effectiveModel;
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

function stringifyObject(value) {
  if (!value || typeof value !== 'object') return '';
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

async function maybeCallTextFn(target) {
  if (!target || typeof target.text !== 'function') return '';
  try {
    const out = await target.text();
    return String(out || '').trim();
  } catch {
    return '';
  }
}

async function extractTextFromGeminiResponse(resp) {
  if (!resp) return '';

  // SDK variants can return parsed JSON directly.
  const parsedDirect = stringifyObject(resp?.parsed || resp?.response?.parsed);
  if (parsedDirect) return parsedDirect;

  // Most stable path across SDK versions.
  const textFromFn = await maybeCallTextFn(resp);
  if (textFromFn) return textFromFn;
  const textFromRespFn = await maybeCallTextFn(resp?.response);
  if (textFromRespFn) return textFromRespFn;

  if (typeof resp.text === 'string' && resp.text.trim()) return resp.text.trim();
  if (typeof resp?.response?.text === 'string' && resp.response.text.trim()) return resp.response.text.trim();

  const candidates = Array.isArray(resp?.candidates) ? resp.candidates : [];
  const textParts = [];
  for (const candidate of candidates) {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    for (const part of parts) {
      if (part && typeof part.text === 'string' && part.text.trim()) textParts.push(part.text.trim());
    }
  }
  return textParts.join('\n').trim();
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
  model = process.env.AURORA_BFF_RECO_PRELABEL_MODEL || 'gemini-3-flash-preview',
  logger,
} = {}) {
  if (!hasAuroraGeminiApiKey('AURORA_RECO_GEMINI_API_KEY')) {
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
        const resp = await withTimeout(
          callAuroraGeminiGenerateContent({
            featureEnvVar: 'AURORA_RECO_GEMINI_API_KEY',
            route: 'aurora_reco_prelabel',
            request,
          }),
          timeoutMs,
        );
        const text = await extractTextFromGeminiResponse(resp);
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
