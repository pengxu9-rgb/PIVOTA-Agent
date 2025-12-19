const axios = require('axios');
const OpenAI = require('openai');
const crypto = require('crypto');

const CACHE_TTL_MS = Number(process.env.PIVOTA_EMBEDDINGS_CACHE_TTL_MS || 5 * 60 * 1000);

let openaiClient = null;
const inMemoryCache = new Map();

function sha256(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function nowMs() {
  return Date.now();
}

function cacheGet(key) {
  const hit = inMemoryCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= nowMs()) {
    inMemoryCache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value, ttlMs) {
  inMemoryCache.set(key, { value, expiresAt: nowMs() + Math.max(1000, Number(ttlMs || CACHE_TTL_MS)) });
}

function getOpenAIClient() {
  if (openaiClient) return openaiClient;
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set');
  const baseURL = process.env.OPENAI_BASE_URL || undefined;
  openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, ...(baseURL ? { baseURL } : {}) });
  return openaiClient;
}

function normalizeProvider(provider) {
  const p = String(provider || '').toLowerCase();
  if (!p) return 'gemini';
  if (p === 'google') return 'gemini';
  return p;
}

function getProviderOrder(options = {}) {
  const explicit = options.provider ? [options.provider] : [];
  const primary = process.env.PIVOTA_EMBEDDINGS_PROVIDER || 'gemini';
  const fallback = process.env.PIVOTA_EMBEDDINGS_FALLBACK_PROVIDER || '';
  const order = [...explicit, primary, fallback].map(normalizeProvider).filter(Boolean);
  return Array.from(new Set(order));
}

function getModelForProvider(provider, options = {}) {
  if (options.model) return options.model;
  if (provider === 'openai') return process.env.PIVOTA_EMBEDDINGS_MODEL_OPENAI || process.env.PIVOTA_EMBEDDINGS_MODEL || 'text-embedding-3-small';
  if (provider === 'gemini') return process.env.PIVOTA_EMBEDDINGS_MODEL_GEMINI || process.env.PIVOTA_EMBEDDINGS_MODEL || 'text-embedding-004';
  throw new Error(`Unsupported embeddings provider: ${provider}`);
}

function clampTextForEmbedding(text) {
  const t = String(text || '').trim();
  const maxChars = Number(process.env.PIVOTA_EMBEDDINGS_MAX_CHARS || 6000);
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars);
}

function assertEmbeddingVector(vec) {
  if (!Array.isArray(vec) || vec.length === 0) throw new Error('Embedding vector is empty');
  for (const n of vec) {
    if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error('Embedding vector contains non-numeric values');
  }
  return vec;
}

async function embedWithOpenAI(texts, model) {
  const openai = getOpenAIClient();
  const res = await openai.embeddings.create({
    model,
    input: texts,
  });
  const vectors = (res?.data || []).map((d) => assertEmbeddingVector(d.embedding));
  if (vectors.length !== texts.length) throw new Error('OpenAI embeddings count mismatch');
  return vectors;
}

function geminiBaseUrl() {
  return (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
}

function geminiModelName(model) {
  const m = String(model || '').trim();
  if (!m) return 'text-embedding-004';
  return m.startsWith('models/') ? m.slice('models/'.length) : m;
}

async function embedWithGemini(texts, model) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set');
  const baseURL = geminiBaseUrl();
  const name = geminiModelName(model);
  const mpath = `models/${name}`;

  if (texts.length === 1) {
    const url = `${baseURL}/v1beta/models/${encodeURIComponent(name)}:embedContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
    const body = {
      content: { parts: [{ text: texts[0] }] },
    };
    const res = await axios.post(url, body, { timeout: 12000 });
    const vec = res?.data?.embedding?.values || res?.data?.embedding?.value || null;
    return [assertEmbeddingVector(vec)];
  }

  const url = `${baseURL}/v1beta/models/${encodeURIComponent(name)}:batchEmbedContents?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
  const body = {
    requests: texts.map((t) => ({
      model: mpath,
      content: { parts: [{ text: t }] },
    })),
  };
  const res = await axios.post(url, body, { timeout: 20000 });
  const embeddings = res?.data?.embeddings || res?.data?.responses?.map((r) => r.embedding) || [];
  const vectors = embeddings.map((e) => assertEmbeddingVector(e?.values || e?.value));
  if (vectors.length !== texts.length) throw new Error('Gemini embeddings count mismatch');
  return vectors;
}

async function embedTexts(texts, options = {}) {
  const raw = Array.isArray(texts) ? texts : [texts];
  const inputs = raw.map(clampTextForEmbedding);
  const providers = getProviderOrder(options);
  let lastErr = null;

  for (const provider of providers) {
    try {
      const model = getModelForProvider(provider, options);
      const cacheKey =
        options.cache === false
          ? null
          : `${provider}:${model}:${sha256(inputs.join('\n---\n'))}`;
      if (cacheKey) {
        const cached = cacheGet(cacheKey);
        if (cached) return cached;
      }

      let vectors;
      if (provider === 'openai') vectors = await embedWithOpenAI(inputs, model);
      else if (provider === 'gemini') vectors = await embedWithGemini(inputs, model);
      else throw new Error(`Unsupported embeddings provider: ${provider}`);

      const out = {
        provider,
        model,
        dim: vectors[0]?.length || 0,
        vectors,
      };
      if (cacheKey) cacheSet(cacheKey, out);
      return out;
    } catch (err) {
      lastErr = err;
    }
  }

  throw lastErr || new Error('Embeddings failed');
}

async function embedText(text, options = {}) {
  const res = await embedTexts([text], options);
  return {
    provider: res.provider,
    model: res.model,
    dim: res.dim,
    vector: res.vectors[0],
  };
}

module.exports = {
  embedText,
  embedTexts,
};
