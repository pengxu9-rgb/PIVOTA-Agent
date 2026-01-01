const axios = require('axios');
const { AxiosError } = require('axios');
const { z } = require('zod');

class LlmError extends Error {
  /**
   * @param {'LLM_CONFIG_MISSING'|'LLM_REQUEST_FAILED'|'LLM_TIMEOUT'|'LLM_PARSE_FAILED'|'LLM_SCHEMA_INVALID'} code
   * @param {string} message
   * @param {unknown} [cause]
   */
  constructor(code, message, cause) {
    super(message);
    this.code = code;
    this.cause = cause;
  }
}

function getEnv(name) {
  const v = process.env[name];
  return v && String(v).trim() ? String(v).trim() : undefined;
}

function hasEnv(name) {
  return Boolean(getEnv(name));
}

function toDataUrl(bytes, contentType) {
  const b64 = Buffer.from(bytes).toString('base64');
  return `data:${contentType};base64,${b64}`;
}

function geminiApiKey() {
  return getEnv('GEMINI_API_KEY') || getEnv('PIVOTA_GEMINI_API_KEY') || getEnv('GOOGLE_API_KEY');
}

function openaiApiKey() {
  return getEnv('OPENAI_API_KEY') || getEnv('LLM_API_KEY');
}

function openaiBaseUrl() {
  return getEnv('OPENAI_BASE_URL') || getEnv('LLM_BASE_URL') || 'https://api.openai.com';
}

function normalizeOpenAiBaseUrl(raw) {
  const base = String(raw || '').trim() || 'https://api.openai.com';
  const noTrailingSlash = base.replace(/\/+$/, '');
  // Some proxies ask users to set ".../v1" as the base URL. Our client always calls "/v1/chat/completions".
  return noTrailingSlash.replace(/\/v1$/i, '');
}

function geminiBaseUrl() {
  const raw = String(
    getEnv('GEMINI_BASE_URL') ||
      getEnv('GOOGLE_GENAI_BASE_URL') ||
      'https://generativelanguage.googleapis.com'
  ).trim();
  const noTrailingSlash = raw.replace(/\/+$/, '');
  // Some deploy configs include the API version in the base URL already.
  return noTrailingSlash
    .replace(/\/v1beta\/models$/i, '')
    .replace(/\/v1\/models$/i, '')
    .replace(/\/v1beta$/i, '')
    .replace(/\/v1$/i, '');
}

function geminiModelName(model) {
  const m = String(model || '').trim();
  if (!m) return 'gemini-1.5-flash';
  return m.startsWith('models/') ? m.slice('models/'.length) : m;
}

function uniqueStrings(list) {
  const seen = new Set();
  const out = [];
  for (const v of list) {
    const s = String(v || '').trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function splitModelList(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  return s
    .split(',')
    .map((m) => String(m || '').trim())
    .filter(Boolean);
}

function isGeminiModelNotFoundMessage(message) {
  const m = String(message || '').toLowerCase();
  return m.includes('is not found') || m.includes('not supported for generatecontent') || m.includes('call listmodels');
}

function extractOpenAiTextContent(message) {
  const msg = message && typeof message === 'object' ? message : null;
  const content = msg?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === 'object' ? p.text : null))
      .filter(Boolean)
      .map(String)
      .join('\n');
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return String(content.text);
  return '';
}

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new LlmError('LLM_PARSE_FAILED', 'Empty model output');

  const cleaned = raw
    // common wrappers
    .replace(/^\uFEFF/, '')
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    // continue
  }

  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    const preview = cleaned.replace(/\s+/g, ' ').slice(0, 200);
    const suffix = preview ? `: ${preview}` : '';
    throw new LlmError('LLM_PARSE_FAILED', `Model output is not JSON${suffix}`);
  }

  let sliced = cleaned.slice(start, end + 1);

  // Best-effort repair for common "almost JSON" issues.
  // - trailing commas
  // - smart quotes
  sliced = sliced
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*}/g, '}')
    .replace(/,\s*]/g, ']');

  // Some models accidentally wrap JSON in markdown fences inside the slice.
  sliced = sliced.replace(/```(?:json)?/gi, '').trim();

  try {
    return JSON.parse(sliced);
  } catch (err) {
    const preview = sliced.replace(/\s+/g, ' ').slice(0, 200);
    const msg = preview ? `Failed to parse JSON from model output: ${preview}` : 'Failed to parse JSON from model output';
    throw new LlmError('LLM_PARSE_FAILED', msg, err);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function llmMaxAttempts() {
  const raw = Number(getEnv('LLM_MAX_ATTEMPTS') || '');
  if (!Number.isFinite(raw) || raw <= 0) return 3;
  return Math.max(1, Math.min(10, Math.floor(raw)));
}

function parseRetryAfterMs(headers) {
  if (!headers || typeof headers !== 'object') return null;
  const v = headers['retry-after'] ?? headers['Retry-After'];
  if (!v) return null;

  const s = String(v).trim();
  if (!s) return null;

  const seconds = Number(s);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const dateMs = Date.parse(s);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());

  return null;
}

function retryDelayMs(attempt, err) {
  const base = Number(getEnv('LLM_RETRY_BASE_MS') || '750');
  const cap = Number(getEnv('LLM_RETRY_MAX_MS') || '10000');
  const exp = Math.min(cap, base * Math.pow(2, Math.max(0, attempt - 1)));
  const jitter = Math.floor(Math.random() * Math.min(250, exp * 0.2));
  const computed = Math.min(cap, exp + jitter);

  let retryAfterMs = null;
  if (err instanceof AxiosError) {
    retryAfterMs = parseRetryAfterMs(err.response?.headers);
  } else if (err instanceof LlmError && err.cause instanceof AxiosError) {
    retryAfterMs = parseRetryAfterMs(err.cause.response?.headers);
  }

  if (retryAfterMs != null && Number.isFinite(retryAfterMs)) {
    return Math.min(cap, Math.max(computed, retryAfterMs));
  }

  return computed;
}

function isRetryableError(err) {
  if (err instanceof LlmError) {
    return err.code === 'LLM_TIMEOUT' || err.code === 'LLM_REQUEST_FAILED' || err.code === 'LLM_PARSE_FAILED';
  }
  return false;
}

async function resolveImageForGemini(image) {
  if (image && image.kind === 'bytes') {
    return { mimeType: image.contentType, dataB64: Buffer.from(image.bytes).toString('base64') };
  }

  if (!image || image.kind !== 'url' || !image.url) {
    throw new LlmError('LLM_PARSE_FAILED', 'Invalid image input');
  }

  const res = await axios.get(image.url, {
    responseType: 'arraybuffer',
    timeout: Number(getEnv('LLM_TIMEOUT_MS') || '20000'),
    validateStatus: (s) => s >= 200 && s < 300,
  });
  const contentType = String(res.headers?.['content-type'] || '').split(';')[0].trim();
  const mimeType = contentType || 'image/jpeg';
  return { mimeType, dataB64: Buffer.from(res.data).toString('base64') };
}

function createProviderFromEnv(purpose = 'generic') {
  const explicitPrimary =
    getEnv(purpose === 'layer2_lookspec' ? 'PIVOTA_LAYER2_LLM_PROVIDER' : '') || getEnv('PIVOTA_INTENT_LLM_PROVIDER');

  const inferredPrimary =
    purpose === 'layer2_lookspec'
      ? Boolean(openaiApiKey())
        ? 'openai'
        : geminiApiKey()
          ? 'gemini'
          : 'gemini'
      : Boolean(openaiApiKey())
        ? 'openai'
        : geminiApiKey()
          ? 'gemini'
          : 'openai';

  const primary = String(explicitPrimary || inferredPrimary).toLowerCase();

  const explicitFallback =
    getEnv(purpose === 'layer2_lookspec' ? 'PIVOTA_LAYER2_LLM_FALLBACK_PROVIDER' : '') ||
    getEnv('PIVOTA_INTENT_LLM_FALLBACK_PROVIDER');

  const inferredFallback =
    explicitFallback ||
    (purpose === 'layer2_lookspec'
      ? ''
      : primary === 'gemini'
        ? hasEnv('OPENAI_API_KEY')
          ? 'openai'
          : ''
        : primary === 'openai' && geminiApiKey()
          ? 'gemini'
          : '');

  const fallback = String(inferredFallback || '').toLowerCase();

  const shouldUseFallback = (err) =>
    err instanceof LlmError && (err.code === 'LLM_TIMEOUT' || err.code === 'LLM_REQUEST_FAILED');

  const run = (provider) => {
    if (provider === 'openai') {
      const apiKey = openaiApiKey();
      const baseUrl = normalizeOpenAiBaseUrl(openaiBaseUrl());
      const rawModel = getEnv('PIVOTA_LAYER2_MODEL_OPENAI') || getEnv('PIVOTA_LAYER2_MODEL') || 'gpt-4o-mini';
      const models = splitModelList(rawModel);
      const defaultModel = models[0] || String(rawModel || '').trim() || 'gpt-4o-mini';
      if (!apiKey) throw new LlmError('LLM_CONFIG_MISSING', 'Missing required env var: OPENAI_API_KEY');

      const client = axios.create({
        baseURL: baseUrl.replace(/\/$/, ''),
        timeout: Number(getEnv('LLM_TIMEOUT_MS') || '20000'),
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      });

      const disableResponseFormat =
        String(getEnv('OPENAI_DISABLE_RESPONSE_FORMAT') || getEnv('PIVOTA_OPENAI_DISABLE_RESPONSE_FORMAT') || '')
          .trim()
          .toLowerCase() === 'true' ||
        String(getEnv('OPENAI_DISABLE_RESPONSE_FORMAT') || getEnv('PIVOTA_OPENAI_DISABLE_RESPONSE_FORMAT') || '')
          .trim()
          .toLowerCase() === '1';

      const meta = { provider: 'openai', model: defaultModel, baseUrl };

      async function postWithRetry(body, schema) {
        const maxAttempts = llmMaxAttempts();
        let lastErr = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          try {
            const response = await client.post('/v1/chat/completions', body);
            const content = extractOpenAiTextContent(response.data?.choices?.[0]?.message);
            const json = extractJsonObject(String(content));
            const parsed = schema.safeParse(json);
            if (!parsed.success) {
              throw new LlmError('LLM_SCHEMA_INVALID', 'Model JSON did not match expected schema', parsed.error);
            }
            return parsed.data;
          } catch (err) {
            if (err instanceof LlmError && err.code === 'LLM_SCHEMA_INVALID') throw err;

            if (err instanceof AxiosError) {
              const status = err.response?.status;
              if (err.code === 'ECONNABORTED') {
                lastErr = new LlmError('LLM_TIMEOUT', 'LLM request timed out', err);
              } else {
                const apiMessage =
                  typeof err.response?.data?.error?.message === 'string'
                    ? String(err.response?.data?.error?.message).trim()
                    : typeof err.response?.data?.message === 'string'
                      ? String(err.response?.data?.message).trim()
                      : '';
                const suffix = apiMessage ? `: ${apiMessage.slice(0, 200)}` : '';
                const msg = status ? `LLM request failed (HTTP ${status})${suffix}` : `LLM request failed${suffix}`;
                lastErr = new LlmError('LLM_REQUEST_FAILED', msg, err);
              }
            } else if (err instanceof LlmError) {
              lastErr = err;
            } else {
              lastErr = err;
            }

            if (attempt < maxAttempts && isRetryableError(lastErr)) {
              await sleep(retryDelayMs(attempt, err));
              continue;
            }
            throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
          }
        }

        throw lastErr instanceof Error ? lastErr : new Error('LLM request failed');
      }

      return {
        __meta: meta,

        async analyzeImageToJson({ prompt, image, schema }) {
          const imageUrl = image.kind === 'url' ? image.url : toDataUrl(image.bytes, image.contentType);
          const attemptedModels = models.length ? models : [defaultModel];
          let lastErr = null;
          for (const m of attemptedModels) {
            meta.model = m;
            try {
              return await postWithRetry(
                {
                  model: m,
                  temperature: 0,
                  max_tokens: 1500,
                  ...(!disableResponseFormat ? { response_format: { type: 'json_object' } } : {}),
                  messages: [
                    {
                      role: 'system',
                      content: 'You are a strict JSON generator. Output JSON only. No markdown, no extra keys, no prose.',
                    },
                    {
                      role: 'user',
                      content: [
                        { type: 'text', text: prompt },
                        { type: 'image_url', image_url: { url: imageUrl } },
                      ],
                    },
                  ],
                },
                schema
              );
            } catch (err) {
              lastErr = err;
              const status = err?.cause?.response?.status;
              if ((status === 403 || status === 404 || status === 429) && attemptedModels.length > 1) continue;
              throw err;
            }
          }
          throw lastErr instanceof Error ? lastErr : new Error('LLM request failed');
        },

        async analyzeTextToJson({ prompt, schema }) {
          const attemptedModels = models.length ? models : [defaultModel];
          let lastErr = null;
          for (const m of attemptedModels) {
            meta.model = m;
            try {
              return await postWithRetry(
                {
                  model: m,
                  temperature: 0,
                  max_tokens: 2000,
                  ...(!disableResponseFormat ? { response_format: { type: 'json_object' } } : {}),
                  messages: [
                    {
                      role: 'system',
                      content: 'You are a strict JSON generator. Output JSON only. No markdown, no extra keys, no prose.',
                    },
                    { role: 'user', content: prompt },
                  ],
                },
                schema
              );
            } catch (err) {
              lastErr = err;
              const status = err?.cause?.response?.status;
              if ((status === 403 || status === 404 || status === 429) && attemptedModels.length > 1) continue;
              throw err;
            }
          }
          throw lastErr instanceof Error ? lastErr : new Error('LLM request failed');
        },
      };
    }

    if (provider === 'gemini') {
      const apiKey = geminiApiKey();
      const baseURL = geminiBaseUrl();
      const requestedModel = geminiModelName(getEnv('PIVOTA_LAYER2_MODEL_GEMINI') || getEnv('PIVOTA_LAYER2_MODEL'));
      const candidateModels = uniqueStrings([
        requestedModel,
        'gemini-1.5-flash-latest',
        'gemini-1.5-flash',
        'gemini-2.0-flash-lite',
        'gemini-2.0-flash',
        'gemini-1.5-pro-latest',
      ]);
      const apiVersions = ['v1beta', 'v1'];
      if (!apiKey) throw new LlmError('LLM_CONFIG_MISSING', 'Missing required env var: GEMINI_API_KEY');

      const urlFor = (apiVersion, model) =>
        `${baseURL}/${apiVersion}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

      async function postGeminiWithRetry(body, schema) {
        const maxAttempts = llmMaxAttempts();
        let lastErr = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          try {
            for (const apiVersion of apiVersions) {
              for (const model of candidateModels) {
                try {
                  const res = await axios.post(urlFor(apiVersion, model), body, {
                    timeout: Number(getEnv('LLM_TIMEOUT_MS') || '20000'),
                  });
                  const text =
                    res?.data?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join('\n') || '';
                  const json = extractJsonObject(String(text));
                  const parsed = schema.safeParse(json);
                  if (!parsed.success) {
                    throw new LlmError('LLM_SCHEMA_INVALID', 'Model JSON did not match expected schema', parsed.error);
                  }
                  return parsed.data;
                } catch (innerErr) {
                  if (innerErr instanceof LlmError && innerErr.code === 'LLM_SCHEMA_INVALID') throw innerErr;

                  if (innerErr instanceof AxiosError) {
                    const status = innerErr.response?.status;
                    const apiMessage =
                      typeof innerErr.response?.data?.error?.message === 'string'
                        ? String(innerErr.response?.data?.error?.message).trim()
                        : '';
                    if (status === 404 && isGeminiModelNotFoundMessage(apiMessage)) {
                      continue;
                    }
                  }
                  throw innerErr;
                }
              }
            }
            throw new LlmError(
              'LLM_CONFIG_MISSING',
              'No supported Gemini model found for generateContent. Set PIVOTA_LAYER2_MODEL_GEMINI to an available model name.'
            );
          } catch (err) {
            if (err instanceof LlmError && err.code === 'LLM_SCHEMA_INVALID') throw err;

            if (err instanceof AxiosError) {
              if (err.code === 'ECONNABORTED') {
                lastErr = new LlmError('LLM_TIMEOUT', 'LLM request timed out', err);
              } else {
                const status = err.response?.status;
                const apiMessage =
                  typeof err.response?.data?.error?.message === 'string'
                    ? String(err.response?.data?.error?.message).trim()
                    : '';
                const suffix = apiMessage ? `: ${apiMessage.slice(0, 200)}` : '';
                const msg = status ? `LLM request failed (HTTP ${status})${suffix}` : `LLM request failed${suffix}`;
                lastErr = new LlmError('LLM_REQUEST_FAILED', msg, err);
              }
            } else if (err instanceof LlmError) {
              lastErr = err;
            } else {
              lastErr = err;
            }

            if (attempt < maxAttempts && isRetryableError(lastErr)) {
              await sleep(retryDelayMs(attempt, err));
              continue;
            }
            throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
          }
        }

        throw lastErr instanceof Error ? lastErr : new Error('LLM request failed');
      }

      return {
        __meta: { provider: 'gemini', model: candidateModels[0] || requestedModel || 'unknown', baseUrl: baseURL },

        async analyzeImageToJson({ prompt, image, schema }) {
          const { mimeType, dataB64 } = await resolveImageForGemini(image);
          return postGeminiWithRetry(
            {
              systemInstruction: {
                parts: [
                  {
                    text: 'You are a strict JSON generator. Output JSON only. No markdown, no extra keys, no prose.',
                  },
                ],
              },
              contents: [
                {
                  role: 'user',
                  parts: [{ text: prompt }, { inlineData: { mimeType, data: dataB64 } }],
                },
              ],
              generationConfig: { temperature: 0, responseMimeType: 'application/json' },
            },
            schema
          );
        },

        async analyzeTextToJson({ prompt, schema }) {
          return postGeminiWithRetry(
            {
              systemInstruction: {
                parts: [
                  {
                    text: 'You are a strict JSON generator. Output JSON only. No markdown, no extra keys, no prose.',
                  },
                ],
              },
              contents: [{ role: 'user', parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0, responseMimeType: 'application/json' },
            },
            schema
          );
        },
      };
    }

    throw new LlmError('LLM_CONFIG_MISSING', `Unsupported provider: ${provider}`);
  };

  const primaryProvider = run(primary);
  if (!fallback || fallback === primary) return primaryProvider;

  let fallbackProvider = null;
  try {
    fallbackProvider = run(fallback);
  } catch {
    return primaryProvider;
  }

  return {
    __meta: primaryProvider?.__meta,

    async analyzeImageToJson(input) {
      try {
        return await primaryProvider.analyzeImageToJson(input);
      } catch (err) {
        if (!fallbackProvider || !shouldUseFallback(err)) throw err;
        return fallbackProvider.analyzeImageToJson(input);
      }
    },

    async analyzeTextToJson(input) {
      try {
        return await primaryProvider.analyzeTextToJson(input);
      } catch (err) {
        if (!fallbackProvider || !shouldUseFallback(err)) throw err;
        return fallbackProvider.analyzeTextToJson(input);
      }
    },
  };
}

function createOpenAiCompatibleProvider() {
  const baseUrl = getEnv('LLM_BASE_URL');
  const apiKey = getEnv('LLM_API_KEY');
  const model = getEnv('LLM_MODEL_NAME');

  if (!baseUrl || !apiKey || !model) {
    throw new LlmError(
      'LLM_CONFIG_MISSING',
      'Missing required env vars: LLM_BASE_URL, LLM_API_KEY, LLM_MODEL_NAME'
    );
  }

  const client = axios.create({
    baseURL: baseUrl.replace(/\/$/, ''),
    timeout: Number(getEnv('LLM_TIMEOUT_MS') || '20000'),
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  });

  async function postWithRetry(body, schema) {
        const maxAttempts = llmMaxAttempts();
        let lastErr = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await client.post('/v1/chat/completions', body);
        const content = extractOpenAiTextContent(response.data?.choices?.[0]?.message);
        const json = extractJsonObject(String(content));
        const parsed = schema.safeParse(json);
        if (!parsed.success) {
          throw new LlmError('LLM_SCHEMA_INVALID', 'Model JSON did not match expected schema', parsed.error);
        }
        return parsed.data;
      } catch (err) {
        if (err instanceof LlmError && err.code === 'LLM_SCHEMA_INVALID') throw err;

        if (err instanceof AxiosError) {
          const status = err.response?.status;
          if (err.code === 'ECONNABORTED') {
            lastErr = new LlmError('LLM_TIMEOUT', 'LLM request timed out', err);
          } else {
            const msg = status ? `LLM request failed (HTTP ${status})` : 'LLM request failed';
            lastErr = new LlmError('LLM_REQUEST_FAILED', msg, err);
          }
        } else if (err instanceof LlmError) {
          lastErr = err;
        } else {
          lastErr = err;
          }

          if (attempt < maxAttempts && isRetryableError(lastErr)) {
            await sleep(retryDelayMs(attempt, err));
            continue;
          }
          throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
        }
      }

    throw lastErr instanceof Error ? lastErr : new Error('LLM request failed');
  }

  return {
    async analyzeImageToJson({ prompt, image, schema }) {
      const imageUrl = image.kind === 'url' ? image.url : toDataUrl(image.bytes, image.contentType);
      return postWithRetry(
        {
          model,
          temperature: 0.2,
          max_tokens: 900,
          messages: [
            {
              role: 'system',
              content: 'You are a strict JSON generator. Output JSON only. No markdown, no extra keys, no prose.',
            },
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: imageUrl } },
              ],
            },
          ],
        },
        schema
      );
    },

    async analyzeTextToJson({ prompt, schema }) {
      return postWithRetry(
        {
          model,
          temperature: 0.2,
          max_tokens: 900,
          messages: [
            {
              role: 'system',
              content: 'You are a strict JSON generator. Output JSON only. No markdown, no extra keys, no prose.',
            },
            { role: 'user', content: prompt },
          ],
        },
        schema
      );
    },
  };
}

module.exports = {
  z,
  LlmError,
  createOpenAiCompatibleProvider,
  createProviderFromEnv,
};
