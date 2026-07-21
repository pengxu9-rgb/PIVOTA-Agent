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

module.exports = {
  vertexEnabled,
  vertexProject,
  vertexLocation,
  geminiClientOptions,
  credentialsAvailable,
  clientCacheKey,
};
