const DEFAULT_TIMEOUT_MS = 12000;

let geminiClient = null;
let geminiClientInitFailed = false;

function resolveGeminiApiKey() {
  return String(
    process.env.AURORA_SKIN_GEMINI_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
  ).trim();
}

function getGeminiClient() {
  const apiKey = resolveGeminiApiKey();
  if (!apiKey) return { client: null, reason: 'VISION_MISSING_KEY' };
  if (geminiClient) return { client: geminiClient, reason: null };
  if (geminiClientInitFailed) return { client: null, reason: 'VISION_UNKNOWN' };

  try {
    const { GoogleGenAI } = require('@google/genai');
    geminiClient = new GoogleGenAI({ apiKey });
    return { client: geminiClient, reason: null };
  } catch {
    geminiClientInitFailed = true;
    return { client: null, reason: 'VISION_UNKNOWN' };
  }
}

function stripCodeFence(text) {
  const value = String(text == null ? '' : text).trim();
  if (!value) return '';
  const fenced = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced && fenced[1]) return String(fenced[1]).trim();
  return value;
}

async function extractTextFromGeminiResponse(response) {
  if (!response) return '';
  if (typeof response.text === 'function') {
    const output = await response.text();
    if (typeof output === 'string' && output.trim()) return output;
  }
  if (typeof response.text === 'string' && response.text.trim()) return response.text;

  const candidates = Array.isArray(response.candidates) ? response.candidates : [];
  const chunks = [];
  for (const candidate of candidates) {
    const parts = candidate && candidate.content && Array.isArray(candidate.content.parts)
      ? candidate.content.parts
      : [];
    for (const part of parts) {
      if (part && typeof part.text === 'string' && part.text.trim()) chunks.push(part.text);
    }
  }
  return chunks.join('\n').trim();
}

async function withTimeout(promise, timeoutMs) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(`gemini timeout after ${timeoutMs}ms`);
          err.code = 'GEMINI_TIMEOUT';
          reject(err);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseGeminiJson(text) {
  const raw = stripCodeFence(text);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function normalizeFailureReason(error) {
  const code = String(error && error.code ? error.code : '').trim().toUpperCase();
  const message = String(error && error.message ? error.message : '').toLowerCase();
  if (code === 'GEMINI_TIMEOUT' || code.includes('TIMEOUT') || message.includes('timeout')) return 'VISION_TIMEOUT';
  if (message.includes('429') || message.includes('rate')) return 'VISION_RATE_LIMITED';
  if (message.includes('quota')) return 'VISION_QUOTA_EXCEEDED';
  if (message.includes('403') || message.includes('401')) return 'VISION_UPSTREAM_4XX';
  if (message.includes('500') || message.includes('503') || message.includes('upstream')) return 'VISION_UPSTREAM_5XX';
  return 'VISION_UNKNOWN';
}

function buildGenerationConfig({ responseSchema, maxOutputTokens } = {}) {
  const config = {
    responseMimeType: 'application/json',
    temperature: 0.1,
    topP: 0.8,
    candidateCount: 1,
    maxOutputTokens: Number.isFinite(Number(maxOutputTokens))
      ? Math.max(128, Math.min(1200, Math.trunc(Number(maxOutputTokens))))
      : 700,
  };
  if (responseSchema && typeof responseSchema === 'object') {
    config.responseSchema = responseSchema;
    config.responseJsonSchema = responseSchema;
  }
  return config;
}

async function callGeminiStructured({
  model,
  prompt,
  dto,
  imageBuffer,
  responseSchema,
  timeoutMs,
  maxOutputTokens,
  promptVersion,
} = {}) {
  const startedAt = Date.now();
  const gemini = getGeminiClient();
  if (!gemini || !gemini.client) {
    return {
      ok: false,
      provider: 'gemini',
      reason: gemini && gemini.reason ? gemini.reason : 'VISION_MISSING_KEY',
      latency_ms: Date.now() - startedAt,
      prompt_version: promptVersion || null,
    };
  }

  const parts = [];
  if (imageBuffer && Buffer.isBuffer(imageBuffer) && imageBuffer.length > 0) {
    parts.push({
      inlineData: {
        mimeType: 'image/jpeg',
        data: imageBuffer.toString('base64'),
      },
    });
  }
  parts.push({ text: String(prompt || '').trim() });
  if (dto && typeof dto === 'object') {
    parts.push({ text: `context=${JSON.stringify(dto)}` });
  }

  try {
    const response = await withTimeout(
      gemini.client.models.generateContent({
        model,
        contents: [{ role: 'user', parts }],
        config: buildGenerationConfig({ responseSchema, maxOutputTokens }),
      }),
      Number.isFinite(Number(timeoutMs)) ? Math.max(1000, Math.trunc(Number(timeoutMs))) : DEFAULT_TIMEOUT_MS,
    );

    const text = await extractTextFromGeminiResponse(response);
    const parsed = parseGeminiJson(text);
    if (!parsed) {
      return {
        ok: false,
        provider: 'gemini',
        reason: 'VISION_SCHEMA_INVALID',
        latency_ms: Date.now() - startedAt,
        prompt_version: promptVersion || null,
        raw_text: text || null,
      };
    }

    return {
      ok: true,
      provider: 'gemini',
      json: parsed,
      latency_ms: Date.now() - startedAt,
      prompt_version: promptVersion || null,
    };
  } catch (error) {
    return {
      ok: false,
      provider: 'gemini',
      reason: normalizeFailureReason(error),
      detail: error && error.message ? String(error.message) : null,
      latency_ms: Date.now() - startedAt,
      prompt_version: promptVersion || null,
    };
  }
}

async function callGeminiReportWithRetry({
  model,
  prompt,
  dto,
  responseSchema,
  timeoutMs,
  maxOutputTokens,
  promptVersion,
  validate,
  revisionInstruction,
} = {}) {
  const first = await callGeminiStructured({
    model,
    prompt,
    dto,
    responseSchema,
    timeoutMs,
    maxOutputTokens,
    promptVersion,
  });

  if (!first.ok) {
    return {
      ...first,
      retry: { attempted: 0, success: false },
    };
  }

  const firstValidation = typeof validate === 'function' ? validate(first.json) : { ok: true };
  if (firstValidation && firstValidation.ok !== false) {
    return {
      ...first,
      retry: { attempted: 0, success: false },
    };
  }

  const retryPrompt = `${String(prompt || '').trim()}\n\n${String(revisionInstruction || '').trim()}`;
  const second = await callGeminiStructured({
    model,
    prompt: retryPrompt,
    dto,
    responseSchema,
    timeoutMs,
    maxOutputTokens,
    promptVersion,
  });

  if (!second.ok) {
    return {
      ...second,
      retry: { attempted: 1, success: false },
    };
  }

  const secondValidation = typeof validate === 'function' ? validate(second.json) : { ok: true };
  if (secondValidation && secondValidation.ok === false) {
    return {
      ok: false,
      provider: 'gemini',
      reason: 'VISION_SCHEMA_INVALID',
      latency_ms: second.latency_ms,
      prompt_version: promptVersion || null,
      retry: { attempted: 1, success: false },
    };
  }

  return {
    ...second,
    retry: { attempted: 1, success: true },
  };
}

module.exports = {
  callGeminiStructured,
  callGeminiReportWithRetry,
  getGeminiClient,
};
