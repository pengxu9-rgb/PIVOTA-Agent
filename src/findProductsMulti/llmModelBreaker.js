'use strict';

// A MODEL THAT DOES NOT EXIST WILL NOT START EXISTING ON THE NEXT CALL.
//
// The find_products_multi LLM passes (rerank, semantic rewrite) name their model from env with a hard-coded
// default. When the provider answers "no such model" (HTTP 404, or a 400 that says the model is unknown), every
// later call gets the same answer: the model id and the provider credentials are fixed for the life of the
// process, and changing either is a redeploy. Retrying it per request buys nothing — it costs a provider round
// trip on the search path and writes one identical WARN per search.
//
// So the first model-not-found answer opens a breaker for that (provider, model) pair for the rest of the
// process, logs it ONCE at WARN with what to change, and every later call skips that provider before it is
// dialled. Callers fall back exactly as they do on any other provider failure (rerank keeps the deterministic
// order; semantic rewrite uses the rule-based intent), so the breaker changes latency and log volume, never
// results.
//
// Keyed by provider AND model, and shared across features: "openai/<model> does not exist" is a fact about that
// pair, whichever pass asked. A different model on the same provider is unaffected.
//
// Other failures (timeouts, 429, 5xx, bad JSON) are transient or content-dependent and never open it.

const logger = require('../logger');

const open = new Map(); // `${provider}:${model}` -> { status, code, feature, opened_at }

function keyOf(provider, model) {
  return `${String(provider || '').trim().toLowerCase()}:${String(model || '').trim()}`;
}

function statusOf(err) {
  const raw = err?.status ?? err?.response?.status;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function codeOf(err) {
  const raw = err?.code ?? err?.error?.code ?? err?.response?.data?.error?.code ?? err?.response?.data?.error?.status;
  return typeof raw === 'string' ? raw.trim() : raw != null ? String(raw) : '';
}

function messageOf(err) {
  return [err?.message, err?.error?.message, err?.response?.data?.error?.message]
    .filter((m) => typeof m === 'string')
    .join(' ')
    .toLowerCase();
}

/**
 * True when the provider said the MODEL is unavailable — not when the request merely failed.
 *  - OpenAI (SDK): NotFoundError, status 404, code 'model_not_found'.
 *  - Gemini (REST/Vertex): HTTP 404 'NOT_FOUND' ("Publisher Model ... was not found").
 *  - OpenAI-compatible endpoints: some answer 400 with a message naming the model as unknown/invalid.
 * A 404 from a model endpoint means the model (or the endpoint built from it) does not exist for these
 * credentials, which no retry changes.
 */
function isModelUnavailableError(err) {
  if (!err || typeof err !== 'object') return false;
  if (codeOf(err).toLowerCase() === 'model_not_found') return true;
  const status = statusOf(err);
  if (status === 404) return true;
  if (status === 400) {
    const msg = messageOf(err);
    return /\bmodel\b/.test(msg) && /(not found|does not exist|not exist|unknown|invalid|not supported|unsupported)/.test(msg);
  }
  return false;
}

function isModelBreakerOpen(provider, model) {
  return open.has(keyOf(provider, model));
}

/**
 * Open the breaker when `err` says the model is unavailable. Logs once per (provider, model) per process.
 * @returns {boolean} whether the breaker is (now) open for this pair.
 */
function recordModelFailure({ feature, provider, model, err, envHint } = {}) {
  const key = keyOf(provider, model);
  if (open.has(key)) return true;
  if (!isModelUnavailableError(err)) return false;
  const entry = {
    status: statusOf(err),
    code: codeOf(err) || null,
    feature: feature || null,
    opened_at: new Date().toISOString(),
  };
  open.set(key, entry);
  try {
    logger.warn(
      {
        feature: entry.feature,
        provider: String(provider || ''),
        model: String(model || ''),
        upstream_status: entry.status,
        upstream_code: entry.code,
        env_hint: envHint || null,
      },
      'find_products_multi llm model unavailable; provider skipped for this process (logged once)',
    );
  } catch (_) {
    // Logging must never turn a skipped quality pass into a failed search.
  }
  return true;
}

class LlmModelUnavailableError extends Error {
  constructor(provider, model) {
    super(`llm model unavailable (breaker open): ${provider}/${model}`);
    this.name = 'LlmModelUnavailableError';
    this.code = 'LLM_MODEL_UNAVAILABLE';
  }
}

function openModelBreakers() {
  return [...open.entries()].map(([key, v]) => ({ key, ...v }));
}

function __resetModelBreakersForTests() {
  open.clear();
}

module.exports = {
  LlmModelUnavailableError,
  isModelBreakerOpen,
  isModelUnavailableError,
  openModelBreakers,
  recordModelFailure,
  __resetModelBreakersForTests,
};
