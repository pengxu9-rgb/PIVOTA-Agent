'use strict';

// A MODEL THE PROVIDER SAYS DOES NOT EXIST WILL NOT EXIST ON THE NEXT CALL EITHER.
//
// The find_products_multi LLM passes (rerank, semantic rewrite) take their model from env, with a hard-coded
// default. When the provider answers "no such model", every later call gets the same answer until the env or
// the provider account changes. Retrying it on every search costs a provider round trip on the search path and
// writes one identical WARN per search.
//
// So a model-not-found answer opens a breaker for that (feature, provider, model) for a cooldown
// (PIVOTA_LLM_MODEL_BREAKER_COOLDOWN_MS, default 15 min, clamped to 10-30 min). While it is open the pass skips
// that provider before dialling it. When the cooldown has passed ONE call is let through as a probe:
//   - the probe succeeds                -> closed;
//   - the probe answers model-not-found -> open again for another cooldown (and logged again);
//   - the probe fails any other way     -> open for another cooldown, without a log (inconclusive).
// Callers fall back exactly as they do on any provider failure (rerank keeps the deterministic order,
// semantic rewrite uses the rule-based intent), so the breaker changes latency and log volume, never results.
//
// WHAT OPENS IT, deliberately narrow: an HTTP 404 that says the MODEL is missing — OpenAI's
// `code: 'model_not_found'`, or a NOT_FOUND / not-found message that names a model (Gemini / Vertex). Never a
// 400: those are request-shape refusals ("'temperature' does not support 0", "'response_format' ... not
// supported") that another feature's request to the same model may not hit. Never a bare 404 (a misrouted base
// URL, a token-endpoint 404, a deploy blip), and never a timeout, 429 or 5xx.
//
// KEYED PER FEATURE. Rerank and semantic rewrite send different requests; one feature's breaker must not switch
// off the other.

const logger = require('../logger');

const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;
const MIN_COOLDOWN_MS = 10 * 60 * 1000;
const MAX_COOLDOWN_MS = 30 * 60 * 1000;

// key -> { openedAt, probeStartedAt (null when no probe is in flight), opens }
const breakers = new Map();

let clock = () => Date.now();

function cooldownMs() {
  const raw = Number(process.env.PIVOTA_LLM_MODEL_BREAKER_COOLDOWN_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_COOLDOWN_MS;
  return Math.min(MAX_COOLDOWN_MS, Math.max(MIN_COOLDOWN_MS, raw));
}

function keyOf(feature, provider, model) {
  return [feature, provider, model].map((part) => String(part || '').trim().toLowerCase()).join(':');
}

function statusOf(err) {
  const n = Number(err?.status ?? err?.response?.status);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function codeOf(err) {
  const raw = err?.error?.code ?? err?.response?.data?.error?.code ?? err?.code;
  return raw == null ? '' : String(raw).trim();
}

function upstreamStatusWordOf(err) {
  const raw = err?.response?.data?.error?.status ?? err?.error?.status;
  return typeof raw === 'string' ? raw.trim().toUpperCase() : '';
}

function messageOf(err) {
  return [err?.error?.message, err?.response?.data?.error?.message, err?.message]
    .filter((m) => typeof m === 'string')
    .join(' ')
    .toLowerCase();
}

/**
 * True only when the provider said the MODEL does not exist (see WHAT OPENS IT above).
 *  - OpenAI SDK NotFoundError: status 404, code 'model_not_found'
 *    ("The model `x` does not exist or you do not have access to it.").
 *  - Gemini AI Studio / Vertex REST: HTTP 404, error.status 'NOT_FOUND', with a message naming a model
 *    ("models/x is not found for API version ...", "Publisher Model `.../models/x` was not found ...").
 */
function isModelUnavailableError(err) {
  if (!err || typeof err !== 'object') return false;
  if (statusOf(err) !== 404) return false;
  if (codeOf(err).toLowerCase() === 'model_not_found') return true;
  const msg = messageOf(err);
  if (upstreamStatusWordOf(err) === 'NOT_FOUND') {
    return /\bmodels?\b/.test(msg) && /(does not exist|was not found|is not found)/.test(msg);
  }
  // An OpenAI-compatible endpoint without the code: the same sentence OpenAI uses.
  return /\bthe model\b/.test(msg) && /does not exist/.test(msg);
}

function stateOf(feature, provider, model) {
  return breakers.get(keyOf(feature, provider, model)) || null;
}

/**
 * Read-only: is this pair currently being skipped? False when closed, and false when its cooldown has passed
 * and no probe is in flight (a call would be let through as the probe). Grants nothing.
 */
function isModelBreakerOpen(feature, provider, model) {
  const state = stateOf(feature, provider, model);
  if (!state) return false;
  const now = clock();
  const cooldown = cooldownMs();
  if (state.probeStartedAt != null) return now - state.probeStartedAt < cooldown;
  return now - state.openedAt < cooldown;
}

/**
 * Ask to make a call. True when the breaker is closed, or when this call is granted the single half-open probe
 * (a probe that never settled is replaced after one cooldown). False while open.
 */
function acquireModelCall(feature, provider, model) {
  const state = stateOf(feature, provider, model);
  if (!state) return true;
  if (isModelBreakerOpen(feature, provider, model)) return false;
  state.probeStartedAt = clock();
  return true;
}

/** A call through this pair answered: close the breaker. */
function recordModelSuccess(feature, provider, model) {
  breakers.delete(keyOf(feature, provider, model));
}

/**
 * Report a failed call. Opens (or re-opens) the breaker when `err` says the model does not exist, logging once
 * per opening at WARN. Any other failure leaves a closed breaker closed; on a probe it keeps the breaker open
 * for another cooldown without logging (inconclusive).
 * @returns {boolean} whether the breaker is open after this report.
 */
function recordModelFailure({ feature, provider, model, err, envHint } = {}) {
  const key = keyOf(feature, provider, model);
  const state = breakers.get(key) || null;
  const now = clock();
  if (!isModelUnavailableError(err)) {
    if (state && state.probeStartedAt != null) {
      state.openedAt = now;
      state.probeStartedAt = null;
    }
    return Boolean(state);
  }
  if (state && state.probeStartedAt == null) {
    // Already open: a concurrent in-flight call reporting the same answer. Logged when it opened.
    return true;
  }
  const opens = (state ? state.opens : 0) + 1;
  breakers.set(key, { openedAt: now, probeStartedAt: null, opens });
  try {
    logger.warn(
      {
        event: 'llm_model_breaker_open',
        feature: String(feature || ''),
        provider: String(provider || ''),
        model: String(model || ''),
        upstream_status: statusOf(err),
        upstream_code: codeOf(err) || null,
        reopened: opens > 1,
        cooldown_ms: cooldownMs(),
        env_hint: envHint || null,
      },
      'find_products_multi llm model unavailable; provider skipped until the cooldown probe',
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

function __resetModelBreakersForTests() {
  breakers.clear();
  clock = () => Date.now();
}

function __setClockForTests(fn) {
  clock = typeof fn === 'function' ? fn : () => Date.now();
}

module.exports = {
  LlmModelUnavailableError,
  acquireModelCall,
  isModelBreakerOpen,
  isModelUnavailableError,
  recordModelFailure,
  recordModelSuccess,
  __resetModelBreakersForTests,
  __setClockForTests,
};
