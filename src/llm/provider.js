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

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new LlmError('LLM_PARSE_FAILED', 'Empty model output');

  try {
    return JSON.parse(raw);
  } catch {
    // continue
  }

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new LlmError('LLM_PARSE_FAILED', 'Model output is not JSON');
  }

  const sliced = raw.slice(start, end + 1);
  try {
    return JSON.parse(sliced);
  } catch (err) {
    throw new LlmError('LLM_PARSE_FAILED', 'Failed to parse JSON from model output', err);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      ? geminiApiKey()
        ? 'gemini'
        : hasEnv('OPENAI_API_KEY')
          ? 'openai'
          : 'gemini'
      : hasEnv('OPENAI_API_KEY')
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
    (primary === 'gemini' && hasEnv('OPENAI_API_KEY') ? 'openai' : primary === 'openai' && geminiApiKey() ? 'gemini' : '');

  const fallback = String(inferredFallback || '').toLowerCase();

  const run = (provider) => {
    if (provider === 'openai') {
      const apiKey = getEnv('OPENAI_API_KEY');
      const baseUrl = getEnv('OPENAI_BASE_URL') || 'https://api.openai.com';
      const model = getEnv('PIVOTA_LAYER2_MODEL_OPENAI') || getEnv('PIVOTA_LAYER2_MODEL') || 'gpt-4o-mini';
      if (!apiKey) throw new LlmError('LLM_CONFIG_MISSING', 'Missing required env var: OPENAI_API_KEY');

      const client = axios.create({
        baseURL: baseUrl.replace(/\/$/, ''),
        timeout: Number(getEnv('LLM_TIMEOUT_MS') || '20000'),
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      });

      async function postWithRetry(body, schema) {
        const maxAttempts = 1 + 2;
        let lastErr = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          try {
            const response = await client.post('/v1/chat/completions', body);
            const content =
              response.data?.choices?.[0]?.message?.content ??
              response.data?.choices?.[0]?.message?.content?.[0]?.text ??
              '';
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
              await sleep(250 * attempt);
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

    if (provider === 'gemini') {
      const apiKey = geminiApiKey();
      const baseURL = geminiBaseUrl();
      const model = geminiModelName(
        getEnv('PIVOTA_LAYER2_MODEL_GEMINI') || getEnv('PIVOTA_LAYER2_MODEL') || 'gemini-1.5-flash'
      );
      if (!apiKey) throw new LlmError('LLM_CONFIG_MISSING', 'Missing required env var: GEMINI_API_KEY');

      const url = `${baseURL}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(
        apiKey
      )}`;

      async function postGeminiWithRetry(body, schema) {
        const maxAttempts = 1 + 2;
        let lastErr = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          try {
            const res = await axios.post(url, body, { timeout: Number(getEnv('LLM_TIMEOUT_MS') || '20000') });
            const text = res?.data?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join('\n') || '';
            const json = extractJsonObject(String(text));
            const parsed = schema.safeParse(json);
            if (!parsed.success) {
              throw new LlmError('LLM_SCHEMA_INVALID', 'Model JSON did not match expected schema', parsed.error);
            }
            return parsed.data;
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
              await sleep(250 * attempt);
              continue;
            }
            throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
          }
        }

        throw lastErr instanceof Error ? lastErr : new Error('LLM request failed');
      }

      return {
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

  try {
    return run(primary);
  } catch (err) {
    if (!fallback) throw err;
    return run(fallback);
  }
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
    const maxAttempts = 1 + 2;
    let lastErr = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await client.post('/v1/chat/completions', body);
        const content =
          response.data?.choices?.[0]?.message?.content ??
          response.data?.choices?.[0]?.message?.content?.[0]?.text ??
          '';
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
          await sleep(250 * attempt);
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
