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

function credentialsJson() {
  return String(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || '').trim();
}

/**
 * Build the error for an unusable inline credential, logging it once.
 *
 * Of the seven client-construction sites, four catch without logging (they set
 * a sticky `geminiInitFailed` and return null). Without a log here the reason
 * never reaches an operator: it surfaces as a generic "Gemini unavailable",
 * which is exactly indistinguishable from the credential never having been
 * supplied — the ambiguity that made the 2026-07-21 outage take a day to find.
 */
function credentialFailure(message) {
  if (!warnedBadCredential) {
    warnedBadCredential = true;
    console.error(`[vertexGemini] ${message}`);
  }
  return new Error(message);
}

/**
 * Parsed inline credentials, or null when none are configured.
 *
 * Both credential paths in this module go through here, so they agree on what
 * "configured" means. They did not before: `accessToken()` parsed the variable
 * itself, outside its own try block, so a malformed value threw a bare
 * SyntaxError, never set `adcProbe = false`, and left `credentialsAvailable()`
 * answering true for the life of the process.
 *
 * Railway (and anything not on GCP) can only hand us env vars, while ADC reads
 * GOOGLE_APPLICATION_CREDENTIALS as a FILE PATH — accepting the key material
 * inline is what lets a deployment supply a service account with no bootstrap
 * step that writes it to disk.
 *
 * A syntax check alone is not enough. `GOOGLE_APPLICATION_CREDENTIALS_JSON=null`
 * parses cleanly, and google-auth-library discards a falsy `credentials`
 * (`opts.credentials || null` in googleauth.js) and falls back to bare ADC —
 * silently reproducing the outage this inline path exists to prevent. So the
 * shape is checked too; `type` covers service_account, external_account (WIF)
 * and authorized_user without enumerating them.
 */
function parsedCredentials() {
  const raw = credentialsJson();
  if (!raw) return null;
  let info;
  try {
    info = JSON.parse(raw);
  } catch (err) {
    throw credentialFailure(
      `GOOGLE_APPLICATION_CREDENTIALS_JSON is not valid JSON: ${err.message}`,
    );
  }
  if (!info || typeof info !== 'object' || Array.isArray(info)) {
    throw credentialFailure(
      'GOOGLE_APPLICATION_CREDENTIALS_JSON parsed but is not a JSON object',
    );
  }
  // `type` is how GoogleAuth.fromJSON dispatches (service_account,
  // authorized_user, external_account, external_account_authorized_user,
  // impersonated_service_account). But its fallback branch hands anything
  // unrecognised to JWT.fromJSON, which validates only client_email and
  // private_key and never looks at `type` — so a service-account key with the
  // field stripped genuinely works today. Accept that too rather than
  // narrowing what already resolves.
  const hasType = typeof info.type === 'string' && info.type.trim();
  const looksLikeJwt = Boolean(info.client_email && info.private_key);
  if (!hasType && !looksLikeJwt) {
    throw credentialFailure(
      'GOOGLE_APPLICATION_CREDENTIALS_JSON parsed but is not a credential ' +
        'object (expected a "type", e.g. "service_account", or a ' +
        'client_email/private_key pair)',
    );
  }
  warnOnProjectMismatch(info);
  return info;
}

/**
 * Warn when the key's own project disagrees with GOOGLE_CLOUD_PROJECT.
 *
 * Requests bill the configured project while quota is checked against the
 * credential's, so a mismatch spends from a project nobody is watching. The
 * Python twin has warned about this since the migration landed; this side was
 * silent, which matters more now that a whole service account arrives as one
 * pasted env var.
 */
function warnOnProjectMismatch(info) {
  if (warnedProjectMismatch) return;
  const keyProject = String(info.project_id || info.quota_project_id || '').trim();
  const configured = vertexProject();
  if (!keyProject || !configured || keyProject === configured) return;
  warnedProjectMismatch = true;
  console.error(
    `[vertexGemini] credential project "${keyProject}" != GOOGLE_CLOUD_PROJECT ` +
      `"${configured}" — requests bill the configured project but quota is ` +
      `checked against the credential's`,
  );
}

/**
 * Options for `new GoogleGenAI(...)`.
 *
 * `apiKey` is the caller's own resolved key and is used verbatim on the AI
 * Studio path — several callers accept it as an argument rather than reading
 * the env, so swallowing it here would change behaviour beyond transport. On
 * the Vertex path it is ignored: that endpoint authenticates via ADC.
 *
 * The SDK path is what took Gemini audit probes down on 2026-07-21. The REST
 * path in `accessToken()` already accepted inline credentials; this one did
 * not, so it resolved bare ADC, found nothing, and every probe died before its
 * request. Audit probes construct through here (see
 * src/internal/agentCenterLlmProbe.js), which is why only they were affected.
 *
 * Throws rather than omitting the credential when one is configured but
 * unusable — omitting it would fall through to bare ADC, which is the failure
 * being fixed. In the normal flow callers gate on `credentialsAvailable()`
 * first, which now reports false for the same condition, so they degrade
 * cleanly and this throw is only a backstop for a caller that skipped the
 * guard.
 */
function geminiClientOptions(apiKey) {
  if (!vertexEnabled()) return { apiKey };
  const options = {
    vertexai: true,
    project: vertexProject(),
    location: vertexLocation(),
    // @google/genai@0.7.0 derives the host as `${location}-aiplatform.
    // googleapis.com` with NO case for "global" (verified: zero occurrences of
    // 'global' in the bundle; ApiClient ctor, dist/node/index.js:7329). Our
    // configured location IS global, which resolves to
    // global-aiplatform.googleapis.com — a host that answers 404 where the
    // real endpoint answers 401. Pinning it to the same rule vertexHost()
    // applies on the REST path keeps the two transports on one host, and an
    // explicit httpOptions.baseUrl is patched over the derived one
    // (index.js:7345) while apiVersion and headers survive untouched.
    //
    // This is invisible until credentials resolve — auth happens before the
    // URL is used — so it was hiding behind the ADC failure this branch fixes.
    httpOptions: { baseUrl: `${vertexHost()}/` },
  };
  const credentials = parsedCredentials();
  if (credentials) options.googleAuthOptions = { credentials };
  return options;
}

/**
 * Whether ADC has any chance of resolving, checked synchronously.
 *
 * Explicit key material always counts. Otherwise we look for a marker that this
 * process is running somewhere with a metadata server, because that is the only
 * other way `google.auth` can succeed without configuration.
 *
 * Inline credentials must be USABLE, not merely present. Presence was the old
 * test, and it is what let the outage through the guard: the variable was set,
 * so this returned true, callers were waved through, and the call then died at
 * the transport. A value that is set but unparseable is worse than an unset one
 * — it looks configured to whoever is reading the env — so it is not allowed to
 * vouch for the other sources either.
 */
function credentialSourceConfigured() {
  if (credentialsJson()) {
    try {
      return parsedCredentials() !== null;
    } catch {
      return false;
    }
  }
  return Boolean(
    String(process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim() ||
      process.env.K_SERVICE || // Cloud Run
      process.env.GAE_SERVICE || // App Engine
      process.env.GCE_METADATA_HOST,
  );
}

function startProbe() {
  if (probeStarted) return;
  probeStarted = true;
  // Swallow: the point is only to record whether a token can be minted.
  accessToken().catch(() => {});
}

/**
 * Whether a call would authenticate, without making one.
 *
 * This has to be synchronous because the guards it replaced were, but ADC
 * resolution is async — so it answers from an observed probe once one exists,
 * and from configuration before that.
 *
 * It fails CLOSED when nothing is configured. Returning true and letting the
 * token mint throw is worse than degrading: callers treat this as "is the LLM
 * usable", and a false positive converts a clean "LLM unavailable" path into a
 * mid-request exception. That is exactly what happened on staging when the flag
 * was flipped before any credential existed.
 *
 * The background probe keeps that from being sticky on a real GCP runtime that
 * has a metadata server but none of the env markers above: the first call fails
 * closed, the probe resolves, and subsequent calls return the observed answer.
 */
function credentialsAvailable(apiKey) {
  if (!vertexEnabled()) return Boolean(apiKey && String(apiKey).trim());
  if (!vertexProject()) return false;
  if (adcProbe !== null) return adcProbe;
  if (credentialSourceConfigured()) return true;
  startProbe();
  return false;
}

// The only image-generation model that resolves on Vertex for this project,
// verified by probing :generateContent in both us-central1 and global. Every
// AI Studio "-image-preview" id 404s there, as do the imagen-* ids.
const VERTEX_IMAGE_MODEL = 'gemini-2.5-flash-image';

/**
 * Translate an AI Studio model id to its Vertex equivalent.
 *
 * Only image-generation models need this. Non-image calls are already pinned to
 * gemini-2.5-flash by src/lib/geminiModelFloor.js, and that floor deliberately
 * excludes image models — so the try-on path is the one place an AI Studio id
 * reaches the wire unmapped.
 *
 * Ids without the "-preview" suffix pass through untouched, so a Vertex-native
 * id (gemini-2.5-flash-image) stays as-is, and a future one will too rather than
 * being silently rewritten to today's model.
 */
function vertexModelName(model) {
  const raw = String(model || '').trim();
  if (!vertexEnabled() || !raw) return raw;
  const normalized = raw.startsWith('models/') ? raw.slice('models/'.length) : raw;
  const isImagePreview =
    normalized.includes('-image-preview') || normalized.startsWith('imagen-');
  return isImagePreview ? VERTEX_IMAGE_MODEL : normalized;
}

/**
 * Human-readable reason a call cannot authenticate, for the mode actually in
 * effect.
 *
 * Structured error CODES stay as they are — callers and tests match on those —
 * but the prose has to name the thing that is genuinely missing. Under Vertex,
 * "GEMINI_API_KEY is not set" points at a variable that is deliberately unused
 * and sends whoever is debugging in exactly the wrong direction.
 */
function missingCredentialMessage() {
  if (!vertexEnabled()) return 'Missing GEMINI_API_KEY or GOOGLE_API_KEY';
  if (!vertexProject()) return 'VERTEX_AI_ENABLED=true but GOOGLE_CLOUD_PROJECT is unset';
  // "Set GOOGLE_APPLICATION_CREDENTIALS_JSON" is actively misleading when it IS
  // set and merely unusable; say which it is.
  if (credentialsJson()) {
    try {
      parsedCredentials();
    } catch (err) {
      return err.message;
    }
  }
  return (
    'Vertex credentials unavailable: set GOOGLE_APPLICATION_CREDENTIALS_JSON, ' +
    'or run where Application Default Credentials resolve'
  );
}

/** Test hook — drops the memoised auth client and probe state. */
function resetCredentialsCache() {
  cachedAuth = null;
  adcProbe = null;
  probeStarted = false;
  warnedBadCredential = false;
  warnedProjectMismatch = false;
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
// null = never probed; true/false = observed result of an actual token mint.
let adcProbe = null;
let probeStarted = false;
// Log an unusable inline credential once per process, not once per call.
let warnedBadCredential = false;
let warnedProjectMismatch = false;

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
  // Client construction is INSIDE the try: it parses the inline credential,
  // and when that throws the failure has to be recorded like any other. It sat
  // outside, so a malformed value escaped as a bare SyntaxError, left adcProbe
  // null, and `credentialsAvailable()` went on reporting true for the life of
  // the process — waving every caller into the same mid-request failure.
  try {
    if (!cachedAuth) {
      const { GoogleAuth } = require('google-auth-library');
      const credentials = parsedCredentials();
      cachedAuth = credentials
        ? new GoogleAuth({ scopes: SCOPES, credentials })
        : new GoogleAuth({ scopes: SCOPES });
    }
    // GoogleAuth caches the client and refreshes the token internally.
    const token = await cachedAuth.getAccessToken();
    if (!token) throw new Error('VERTEX_ADC_NO_TOKEN');
    adcProbe = true;
    return token;
  } catch (err) {
    // Remember that ADC cannot resolve here, so credentialsAvailable() stops
    // waving callers through into a guaranteed mid-request failure.
    adcProbe = false;
    throw err;
  }
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
    url: `${vertexHost()}/v1/${vertexModelPath()}/${encodeURIComponent(vertexModelName(model))}:${method}${suffix}`,
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

/**
 * A GoogleAuth instance for Vertex consumers that are NOT `@google/genai`
 * (today: Claude via `@anthropic-ai/vertex-sdk`, which accepts a `googleAuth`
 * option). Routed through parsedCredentials() so every credential reader in
 * this module keeps agreeing on what "configured" means — google-auth-library
 * on its own only reads GOOGLE_APPLICATION_CREDENTIALS as a FILE PATH and
 * would silently miss the inline-JSON variable this deployment actually sets.
 * With no inline credential configured it falls back to ADC, which is correct
 * on a workstation with `gcloud auth application-default login`.
 */
function googleAuthForVertex() {
  // Lazy require: google-auth-library ships transitively; a missing module
  // should surface at the one consumer, not at every vertexGemini import.
  const { GoogleAuth } = require('google-auth-library');
  const credentials = parsedCredentials();
  return new GoogleAuth({
    scopes: 'https://www.googleapis.com/auth/cloud-platform',
    ...(credentials ? { credentials } : {}),
  });
}

module.exports = {
  vertexEnabled,
  vertexProject,
  vertexLocation,
  geminiClientOptions,
  credentialsAvailable,
  clientCacheKey,
  accessToken,
  credentialSourceConfigured,
  missingCredentialMessage,
  vertexModelName,
  resetCredentialsCache,
  restTarget,
  openAiCompatBaseUrl,
  openAiCompatModel,
  openAiCompatHeaders,
  embedTarget,
  googleAuthForVertex,
};
