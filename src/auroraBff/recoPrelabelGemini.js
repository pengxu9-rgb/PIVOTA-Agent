const { GoogleGenAI } = require('@google/genai');
const { resolveAuroraGeminiKey } = require('./auroraGeminiKeys');
const { getGeminiGlobalGate } = require('../lib/geminiGlobalGate');

function toInt(value, fallback, min, max) {
  const n = Number(value);
  const v = Number.isFinite(n) ? Math.trunc(n) : fallback;
  return Math.max(min, Math.min(max, v));
}

function normalizeModel(raw) {
  const s = String(raw || '').trim();
  return s || 'gemini-3-flash-preview';
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
  return (
    text.includes('timeout') ||
    text.includes('aborted') ||
    text.includes('abort') ||
    text.includes('429') ||
    text.includes('503') ||
    text.includes('rate')
  );
}

function isTimeoutLike(err) {
  if (!err) return false;
  const code = String(err.code || '').toLowerCase();
  const name = String(err.name || '').toLowerCase();
  const text = String(err.message || '').toLowerCase();
  return (
    name === 'aborterror' ||
    code.includes('timeout') ||
    code.includes('abort') ||
    text.includes('timeout') ||
    text.includes('timed out') ||
    text.includes('deadline') ||
    text.includes('aborted')
  );
}

async function callGeminiPrelabel({
  systemPrompt,
  userPrompt,
  timeoutMs = 5000,
  model = process.env.AURORA_BFF_RECO_PRELABEL_MODEL || 'gemini-3-flash-preview',
  logger,
} = {}) {
  const apiKey = resolveAuroraGeminiKey('AURORA_RECO_GEMINI_API_KEY');
  if (!apiKey) {
    const err = new Error('MISSING_GEMINI_KEY');
    err.code = 'MISSING_GEMINI_KEY';
    throw err;
  }
  const gate = getGeminiGlobalGate();
  const startedAt = Date.now();
  const resolvedTimeoutMs = Number.isFinite(Number(timeoutMs)) ? Math.max(500, Math.trunc(Number(timeoutMs))) : 5000;
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
        httpOptions: { timeout: resolvedTimeoutMs },
      },
    };

    const maxAttempts = toInt(process.env.AURORA_BFF_RECO_PRELABEL_CALL_RETRIES, 1, 0, 2) + 1;
    let lastErr = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const resp = await gate.withGate('reco_prelabel', () => ai.models.generateContent(request));
        const text = await extractTextFromGeminiResponse(resp);
        return {
          ok: true,
          text,
          attempts: attempt + 1,
          latency_ms: Date.now() - startedAt,
          model_name: normalizeModel(model),
        };
      } catch (err) {
        if (isTimeoutLike(err) && !err.code) {
          err.code = 'PRELABEL_TIMEOUT';
        }
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
  }
}

module.exports = {
  callGeminiPrelabel,
  __internal: {
    extractTextFromGeminiResponse,
  },
};
