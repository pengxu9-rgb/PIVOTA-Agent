'use strict';

const OpenAI = require('openai');

const GEMINI_MODEL = String(process.env.DIAGNOSIS_V2_GEMINI_MODEL || 'gemini-2.0-flash').trim();
const OPENAI_MODEL = String(process.env.DIAGNOSIS_V2_OPENAI_MODEL || 'gpt-4o-mini').trim();
const OPENAI_BASE_URL = String(process.env.OPENAI_BASE_URL || '').trim();
const REQUEST_TIMEOUT_MS = 25_000;
const RETRY_DELAY_MS = 1_000;
const RETRY_TIMEOUT_BOOST_MS = 8_000;

class LlmProviderUnavailableError extends Error {
  constructor(message = 'Diagnosis v2 LLM provider unavailable') {
    super(message);
    this.name = 'LlmProviderUnavailableError';
    this.code = 'LLM_PROVIDER_UNAVAILABLE';
  }
}

function withTimeout(promise, timeoutMs = REQUEST_TIMEOUT_MS, code = 'LLM_PROVIDER_TIMEOUT') {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const err = new Error(code);
      err.code = code;
      setTimeout(() => reject(err), timeoutMs);
    }),
  ]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unwrapCodeFence(text) {
  const raw = String(text || '').trim();
  if (!raw.startsWith('```')) return raw;
  return raw.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
}

let geminiClient;
let geminiInitFailed = false;
function getGeminiClient() {
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) return null;
  if (geminiClient) return geminiClient;
  if (geminiInitFailed) return null;
  try {
    const { GoogleGenAI } = require('@google/genai');
    geminiClient = new GoogleGenAI({ apiKey });
    return geminiClient;
  } catch (_err) {
    geminiInitFailed = true;
    return null;
  }
}

let openaiClient;
function getOpenAiClient() {
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) return null;
  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey,
      ...(OPENAI_BASE_URL ? { baseURL: OPENAI_BASE_URL } : {}),
    });
  }
  return openaiClient;
}

async function callGemini({ system, user, temperature = 0, maxTokens = 1024, timeoutMs }) {
  const client = getGeminiClient();
  if (!client) throw new LlmProviderUnavailableError();
  const response = await withTimeout(
    client.models.generateContent({
      model: GEMINI_MODEL,
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: `${String(system || '')}\n\n${String(user || '')}`.trim(),
            },
          ],
        },
      ],
      config: {
        temperature,
        maxOutputTokens: Math.max(128, Math.min(4096, Math.trunc(Number(maxTokens) || 1024))),
        responseMimeType: 'application/json',
      },
    }),
    timeoutMs || REQUEST_TIMEOUT_MS,
  );

  if (typeof response?.text === 'function') {
    const text = await response.text();
    return { provider: 'gemini', text: unwrapCodeFence(text) };
  }

  const parts = [];
  const candidates = Array.isArray(response?.candidates) ? response.candidates : [];
  for (const candidate of candidates) {
    const contentParts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    for (const part of contentParts) {
      if (typeof part?.text === 'string' && part.text.trim()) parts.push(part.text);
    }
  }
  return { provider: 'gemini', text: unwrapCodeFence(parts.join('\n')) };
}

async function callOpenAi({ system, user, temperature = 0, maxTokens = 1024, timeoutMs }) {
  const client = getOpenAiClient();
  if (!client) throw new LlmProviderUnavailableError();
  const response = await withTimeout(
    client.chat.completions.create({
      model: OPENAI_MODEL,
      temperature,
      max_tokens: Math.max(128, Math.min(4096, Math.trunc(Number(maxTokens) || 1024))),
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: String(system || 'Return strict JSON only.') },
        { role: 'user', content: String(user || '') },
      ],
    }),
    timeoutMs || REQUEST_TIMEOUT_MS,
  );
  const content = response?.choices?.[0]?.message?.content;
  return { provider: 'openai', text: unwrapCodeFence(content) };
}

function createDiagnosisV2LlmProvider() {
  const hasGemini = Boolean(String(process.env.GEMINI_API_KEY || '').trim());
  const hasOpenAi = Boolean(String(process.env.OPENAI_API_KEY || '').trim());

  async function callWithRetryAndFailover(params) {
    const primary = hasGemini ? callGemini : hasOpenAi ? callOpenAi : null;
    const secondary = hasGemini && hasOpenAi ? callOpenAi : null;
    if (!primary) throw new LlmProviderUnavailableError();

    let lastError;

    // Attempt 1 — primary provider, default timeout
    try {
      return await primary(params);
    } catch (err) {
      lastError = err;
      if (err instanceof LlmProviderUnavailableError) {
        if (!secondary) throw err;
      }
    }

    // Attempt 2 — primary provider retry with boosted timeout
    if (!(lastError instanceof LlmProviderUnavailableError)) {
      try {
        await sleep(RETRY_DELAY_MS);
        return await primary({ ...params, timeoutMs: REQUEST_TIMEOUT_MS + RETRY_TIMEOUT_BOOST_MS });
      } catch (err) {
        lastError = err;
      }
    }

    // Attempt 3 — secondary provider failover
    if (secondary) {
      try {
        return await secondary({ ...params, timeoutMs: REQUEST_TIMEOUT_MS + RETRY_TIMEOUT_BOOST_MS });
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError;
  }

  return {
    isAvailable() {
      return hasGemini || hasOpenAi;
    },
    async generate({ system, user, temperature = 0, maxTokens = 1024 }) {
      return callWithRetryAndFailover({ system, user, temperature, maxTokens });
    },
  };
}

module.exports = {
  LlmProviderUnavailableError,
  createDiagnosisV2LlmProvider,
};
