'use strict';

/**
 * Single seam for how this repo's Gemini clients authenticate.
 *
 * The Node twin of `services/vertex_gemini.py` in pivota-backend, and it works
 * the same way: one env flag decides whether a client talks to the AI Studio
 * API with an API key, or to Vertex AI with Application Default Credentials.
 *
 *   VERTEX_AI_ENABLED=false   AI Studio + GEMINI_API_KEY   (default)
 *   VERTEX_AI_ENABLED=true    Vertex AI + ADC
 *
 * `@google/genai` is already the unified SDK, so on the Vertex path this is
 * purely a constructor-options change — no call-site rewrites, no new
 * dependency (google-auth-library ships with the SDK and resolves ADC).
 *
 * Both paths stay live so the flag can be flipped per environment and rolled
 * back without a revert. Merges to main auto-deploy prod; a hard cutover of
 * every LLM path at merge time is not something this repo can absorb.
 */

function vertexEnabled() {
  return String(process.env.VERTEX_AI_ENABLED || '').trim().toLowerCase() === 'true';
}

function vertexProject() {
  return String(process.env.GOOGLE_CLOUD_PROJECT || '').trim();
}

function vertexLocation() {
  // "global" is also valid, and carries higher quota than any single region.
  return String(process.env.GOOGLE_CLOUD_LOCATION || '').trim() || 'us-central1';
}

/**
 * Options for `new GoogleGenAI(...)`.
 *
 * `apiKey` is the caller's own resolved key and is used verbatim on the AI
 * Studio path — several callers accept it as an argument rather than reading
 * the env, so swallowing it here would change behaviour beyond transport. On
 * the Vertex path it is ignored: that endpoint authenticates via ADC.
 */
function geminiClientOptions(apiKey) {
  if (!vertexEnabled()) return { apiKey };
  return { vertexai: true, project: vertexProject(), location: vertexLocation() };
}

/**
 * Whether a client could authenticate, without building one.
 *
 * Replaces the `if (!apiKey) return null` guard the callers already had, so
 * their degradation paths keep working once the flag flips and GEMINI_API_KEY
 * is no longer the thing that matters. ADC itself resolves lazily inside the
 * SDK, so this checks the one thing that must be configured up front.
 */
function credentialsAvailable(apiKey) {
  if (!vertexEnabled()) return Boolean(apiKey && String(apiKey).trim());
  return Boolean(vertexProject());
}

/**
 * Key for the per-API-key client caches a few modules keep. On Vertex there is
 * no per-key identity, so every caller collapses onto one cached client rather
 * than keying on an empty string.
 */
function clientCacheKey(apiKey) {
  if (!vertexEnabled()) return String(apiKey || '');
  return `vertex:${vertexProject()}:${vertexLocation()}`;
}

const AI_STUDIO_HOST = 'https://generativelanguage.googleapis.com';
const SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];

let cachedAuth = null;

/** Vertex host: the global endpoint is not region-prefixed. */
function vertexHost() {
  const loc = vertexLocation();
  return loc === 'global'
    ? 'https://aiplatform.googleapis.com'
    : `https://${loc}-aiplatform.googleapis.com`;
}

function vertexModelPath() {
  return `projects/${vertexProject()}/locations/${vertexLocation()}/publishers/google/models`;
}

/**
 * ADC access token. google-auth-library ships with @google/genai, so this adds
 * no dependency. Resolution order is the library's: service-account key,
 * Workload Identity Federation, metadata server, or a local gcloud ADC session
 * — which is why choosing between those is an env change, not a code change.
 */
async function accessToken() {
  if (!cachedAuth) {
    const { GoogleAuth } = require('google-auth-library');
    cachedAuth = new GoogleAuth({ scopes: SCOPES });
  }
  // GoogleAuth caches the client and refreshes the token internally.
  const token = await cachedAuth.getAccessToken();
  if (!token) throw new Error('VERTEX_ADC_NO_TOKEN');
  return token;
}

/**
 * URL + headers for a REST `:generateContent` / `:streamGenerateContent` call.
 *
 * Async because Vertex needs a minted OAuth token; on the AI Studio path it
 * resolves immediately.
 *
 * Note the key moves out of the query string and into `x-goog-api-key` even on
 * the AI Studio path. The two are equivalent to the API, and several of these
 * call sites were interpolating the key straight into a URL that ends up in
 * logs and error messages.
 */
async function restTarget({ model, apiKey, stream = false, baseUrl = null, apiVersion = 'v1beta' } = {}) {
  const method = stream ? 'streamGenerateContent' : 'generateContent';
  const suffix = stream ? '?alt=sse' : '';

  if (!vertexEnabled()) {
    const base = String(baseUrl || AI_STUDIO_HOST).replace(/\/+$/, '');
    return {
      url: `${base}/${apiVersion}/models/${encodeURIComponent(model)}:${method}${suffix}`,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    };
  }

  // Vertex exposes only v1 for generateContent; the AI Studio v1beta/v1 split
  // does not carry over.
  return {
    url: `${vertexHost()}/v1/${vertexModelPath()}/${encodeURIComponent(model)}:${method}${suffix}`,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${await accessToken()}`,
    },
  };
}

/**
 * Base URL for the OpenAI-compatible chat/completions surface.
 *
 * Vertex exposes its own OpenAI-compat endpoint, but under a different path and
 * with model ids namespaced as `google/<model>` — see `openAiCompatModel`.
 */
function openAiCompatBaseUrl(fallback = `${AI_STUDIO_HOST}/v1beta/openai`) {
  if (!vertexEnabled()) return String(fallback).replace(/\/+$/, '');
  return `${vertexHost()}/v1beta1/projects/${vertexProject()}/locations/${vertexLocation()}/endpoints/openapi`;
}

function openAiCompatModel(model) {
  const m = String(model || '').trim();
  if (!vertexEnabled()) return m;
  return m.startsWith('google/') ? m : `google/${m}`;
}

async function openAiCompatHeaders(apiKey) {
  if (!vertexEnabled()) return { authorization: `Bearer ${apiKey}` };
  return { authorization: `Bearer ${await accessToken()}` };
}

/**
 * Embeddings target. The two APIs disagree on more than the URL:
 *
 *   AI Studio  :batchEmbedContents  {requests:[{content:{parts:[{text}]}}]}
 *                                   -> {embeddings:[{values}]}
 *   Vertex     :predict             {instances:[{content}]}
 *                                   -> {predictions:[{embeddings:{values}}]}
 *
 * So this returns the body and a parser alongside the URL, and the caller stays
 * shape-agnostic. Vertex handles batches natively via multiple instances, which
 * maps cleanly onto batchEmbedContents.
 */
function embedTarget({ model, texts, apiKey, baseUrl = null }) {
  const name = String(model || '').replace(/^models\//, '');

  if (!vertexEnabled()) {
    const base = String(baseUrl || AI_STUDIO_HOST).replace(/\/+$/, '');
    const headers = { 'content-type': 'application/json', 'x-goog-api-key': apiKey };

    // AI Studio has a dedicated single-content endpoint with its own response
    // shape; keep using it for one text so the flag-off path is unchanged.
    if (texts.length === 1) {
      return {
        url: `${base}/v1beta/models/${encodeURIComponent(name)}:embedContent`,
        headers,
        body: { content: { parts: [{ text: texts[0] }] } },
        parse: (data) => [data?.embedding?.values || data?.embedding?.value],
      };
    }

    return {
      url: `${base}/v1beta/models/${encodeURIComponent(name)}:batchEmbedContents`,
      headers,
      body: {
        requests: texts.map((t) => ({
          model: `models/${name}`,
          content: { parts: [{ text: t }] },
        })),
      },
      parse: (data) => {
        const embeddings = data?.embeddings || data?.responses?.map((r) => r.embedding) || [];
        return embeddings.map((e) => e?.values || e?.value);
      },
    };
  }

  return {
    url: `${vertexHost()}/v1/${vertexModelPath()}/${encodeURIComponent(name)}:predict`,
    headers: { 'content-type': 'application/json' },
    needsBearer: true,
    body: { instances: texts.map((t) => ({ content: t })) },
    parse: (data) => (data?.predictions || []).map((p) => p?.embeddings?.values),
  };
}

module.exports = {
  vertexEnabled,
  vertexProject,
  vertexLocation,
  geminiClientOptions,
  credentialsAvailable,
  clientCacheKey,
  accessToken,
  restTarget,
  openAiCompatBaseUrl,
  openAiCompatModel,
  openAiCompatHeaders,
  embedTarget,
};
