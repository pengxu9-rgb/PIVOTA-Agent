'use strict';

const { resolveAuroraGeminiKey } = require('./auroraGeminiKeys');
const { getGeminiGlobalGate } = require('../lib/geminiGlobalGate');

const clientsByKey = new Map();
let geminiInitFailed = false;

function withTimeoutCode(promise, timeoutMs, timeoutCode, onTimeout = null) {
  const ms = Number.isFinite(Number(timeoutMs)) ? Math.max(1, Math.trunc(Number(timeoutMs))) : 0;
  if (!ms) return promise;
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(timeoutCode || 'timeout');
      err.code = timeoutCode || 'TIMEOUT';
      if (typeof onTimeout === 'function') onTimeout(err);
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function withGeminiSdkHttpTimeout(request, timeoutMs) {
  const ms = Number.isFinite(Number(timeoutMs)) ? Math.max(0, Math.trunc(Number(timeoutMs))) : 0;
  if (!ms || !request || typeof request !== 'object' || Array.isArray(request)) return request;
  const config = request.config && typeof request.config === 'object' && !Array.isArray(request.config)
    ? request.config
    : {};
  const httpOptions = config.httpOptions && typeof config.httpOptions === 'object' && !Array.isArray(config.httpOptions)
    ? config.httpOptions
    : {};
  return {
    ...request,
    config: {
      ...config,
      httpOptions: {
        ...httpOptions,
        timeout: ms,
      },
    },
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeGeminiRestModelName(model) {
  return String(model || '')
    .trim()
    .replace(/^models\//i, '')
    .replace(/^publishers\/google\/models\//i, '');
}

function buildGeminiRestBodyFromSdkRequest(request) {
  const src = isPlainObject(request) ? request : {};
  const config = isPlainObject(src.config) ? { ...src.config } : {};
  delete config.httpOptions;

  const body = {
    contents: Array.isArray(src.contents) ? src.contents : [],
  };
  if (isPlainObject(src.systemInstruction)) {
    body.systemInstruction = src.systemInstruction;
  }
  if (Object.keys(config).length > 0) {
    body.generationConfig = config;
  }
  return body;
}

function buildGeminiRestTransportError(err, timeoutCode = 'GEMINI_UPSTREAM_TIMEOUT') {
  const code = String(err && err.code ? err.code : '').toUpperCase();
  const name = String(err && err.name ? err.name : '').toLowerCase();
  if (
    code === 'GEMINI_UPSTREAM_TIMEOUT' ||
    code === 'ETIMEDOUT' ||
    code === 'ERR_CANCELED' ||
    name === 'aborterror' ||
    name === 'timeouterror'
  ) {
    const wrapped = new Error(timeoutCode);
    wrapped.code = timeoutCode;
    return wrapped;
  }
  return err;
}

function extractGeminiRestErrorDetail(responseBody, response) {
  const detail =
    responseBody && responseBody.error && (responseBody.error.message || responseBody.error.status)
      ? responseBody.error.message || responseBody.error.status
      : response && response.statusText
        ? response.statusText
        : '';
  return String(detail || '').trim();
}

function hasAuroraGeminiApiKey(featureEnvVar) {
  try {
    const gate = getGeminiGlobalGate();
    const snapshot = gate && typeof gate.snapshot === 'function' ? gate.snapshot() : null;
    const keyCount = Number(snapshot && snapshot.gate && snapshot.gate.keyCount);
    if (Number.isFinite(keyCount) && keyCount > 0) return true;
  } catch {
    // noop
  }
  return Boolean(resolveAuroraGeminiKey(featureEnvVar));
}

function pickAuroraGeminiApiKey(featureEnvVar) {
  try {
    const gate = getGeminiGlobalGate();
    const pooledKey = gate && typeof gate.getApiKey === 'function' ? gate.getApiKey() : null;
    if (typeof pooledKey === 'string' && pooledKey.trim()) return pooledKey.trim();
  } catch {
    // noop
  }
  return resolveAuroraGeminiKey(featureEnvVar);
}

function getAuroraGeminiClient(featureEnvVar) {
  const apiKey = pickAuroraGeminiApiKey(featureEnvVar);
  if (!apiKey) {
    return { client: null, apiKey: '', init_error: 'MISSING_GEMINI_KEY' };
  }
  if (clientsByKey.has(apiKey)) {
    return { client: clientsByKey.get(apiKey), apiKey, init_error: null };
  }
  if (geminiInitFailed) {
    return { client: null, apiKey, init_error: 'GEMINI_INIT_FAILED' };
  }
  try {
    const { GoogleGenAI } = require('@google/genai');
    const client = new GoogleGenAI({ apiKey });
    clientsByKey.set(apiKey, client);
    return { client, apiKey, init_error: null };
  } catch {
    geminiInitFailed = true;
    return { client: null, apiKey, init_error: 'GEMINI_INIT_FAILED' };
  }
}

async function callAuroraGeminiGenerateContent({
  featureEnvVar,
  route = 'aurora_gemini',
  request,
} = {}) {
  const resolved = getAuroraGeminiClient(featureEnvVar);
  if (!resolved.client) {
    const err = new Error(resolved.init_error || 'MISSING_GEMINI_KEY');
    err.code = resolved.init_error || 'MISSING_GEMINI_KEY';
    throw err;
  }
  const gate = getGeminiGlobalGate();
  return await gate.withGate(route, async () => resolved.client.models.generateContent(request));
}

async function postGeminiRestGenerateContent({ apiKey, request, upstreamTimeoutMs = 0 } = {}) {
  if (typeof fetch !== 'function') {
    const err = new Error('FETCH_UNAVAILABLE');
    err.code = 'FETCH_UNAVAILABLE';
    throw err;
  }
  const modelName = normalizeGeminiRestModelName(request && request.model);
  if (!modelName) {
    const err = new Error('MISSING_GEMINI_MODEL');
    err.code = 'MISSING_GEMINI_MODEL';
    throw err;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent`;
  const controller =
    typeof AbortController === 'function' && Number(upstreamTimeoutMs) > 0
      ? new AbortController()
      : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), Math.max(1, Math.trunc(Number(upstreamTimeoutMs) || 1)))
    : null;
  if (timer && typeof timer.unref === 'function') timer.unref();

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(buildGeminiRestBodyFromSdkRequest(request)),
      signal: controller ? controller.signal : undefined,
    });
    const responseText = await response.text();
    let responseBody = null;
    if (responseText) {
      try {
        responseBody = JSON.parse(responseText);
      } catch {
        responseBody = null;
      }
    }
    if (!response.ok) {
      const err = new Error(extractGeminiRestErrorDetail(responseBody, response) || `GEMINI_REST_HTTP_${response.status}`);
      err.code = 'GEMINI_REST_HTTP_ERROR';
      err.status = Number(response.status) || 0;
      err.response_body = responseBody;
      throw err;
    }
    return responseBody || {};
  } catch (err) {
    throw buildGeminiRestTransportError(err);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function callAuroraGeminiGenerateContentRestWithMeta({
  featureEnvVar,
  route = 'aurora_gemini_rest',
  request,
  bypassCircuit = false,
  queueTimeoutMs = 0,
  upstreamTimeoutMs = 0,
} = {}) {
  const apiKey = pickAuroraGeminiApiKey(featureEnvVar);
  if (!apiKey) {
    const err = new Error('MISSING_GEMINI_KEY');
    err.code = 'MISSING_GEMINI_KEY';
    throw err;
  }
  const gate = getGeminiGlobalGate();
  const startedAt = Date.now();
  let upstreamStartedAt = startedAt;
  const normalizedTotalTimeoutMs = (() => {
    const queueMs = Number.isFinite(Number(queueTimeoutMs)) ? Math.max(0, Math.trunc(Number(queueTimeoutMs))) : 0;
    const upstreamMs = Number.isFinite(Number(upstreamTimeoutMs)) ? Math.max(0, Math.trunc(Number(upstreamTimeoutMs))) : 0;
    if (queueMs > 0 || upstreamMs > 0) return Math.max(1, queueMs + upstreamMs);
    return 0;
  })();
  const gatePromise = gate.withGate(
    route,
    async () => {
      upstreamStartedAt = Date.now();
      const upstreamPromise = postGeminiRestGenerateContent({
        apiKey,
        request,
        upstreamTimeoutMs,
      });
      return await withTimeoutCode(upstreamPromise, upstreamTimeoutMs, 'GEMINI_UPSTREAM_TIMEOUT');
    },
    { bypassCircuit, queueTimeoutMs: normalizedTotalTimeoutMs || queueTimeoutMs },
  );
  const response = await withTimeoutCode(gatePromise, normalizedTotalTimeoutMs, 'GEMINI_TOTAL_TIMEOUT', (err) => {
    const now = Date.now();
    const timedOutUpstream = upstreamStartedAt > startedAt;
    err.code = timedOutUpstream ? 'GEMINI_UPSTREAM_TIMEOUT' : 'GEMINI_QUEUE_TIMEOUT';
    err.timeout_stage = timedOutUpstream ? 'upstream' : 'queue';
    err.meta = {
      gate_wait_ms: timedOutUpstream ? Math.max(0, upstreamStartedAt - startedAt) : Math.max(0, now - startedAt),
      upstream_ms: timedOutUpstream ? Math.max(0, now - upstreamStartedAt) : 0,
      total_ms: Math.max(0, now - startedAt),
      transport: 'rest',
    };
  });
  const finishedAt = Date.now();
  const totalMs = Math.max(0, finishedAt - startedAt);
  const upstreamMs = Math.max(0, finishedAt - upstreamStartedAt);
  const gateWaitMs = Math.max(0, totalMs - upstreamMs);
  return {
    response,
    meta: {
      gate_wait_ms: gateWaitMs,
      upstream_ms: upstreamMs,
      total_ms: totalMs,
      transport: 'rest',
    },
  };
}

async function callAuroraGeminiGenerateContentWithMeta({
  featureEnvVar,
  route = 'aurora_gemini',
  request,
  bypassCircuit = false,
  queueTimeoutMs = 0,
  upstreamTimeoutMs = 0,
} = {}) {
  const resolved = getAuroraGeminiClient(featureEnvVar);
  if (!resolved.client) {
    const err = new Error(resolved.init_error || 'MISSING_GEMINI_KEY');
    err.code = resolved.init_error || 'MISSING_GEMINI_KEY';
    throw err;
  }
  const gate = getGeminiGlobalGate();
  const startedAt = Date.now();
  let upstreamStartedAt = startedAt;
  const normalizedTotalTimeoutMs = (() => {
    const queueMs = Number.isFinite(Number(queueTimeoutMs)) ? Math.max(0, Math.trunc(Number(queueTimeoutMs))) : 0;
    const upstreamMs = Number.isFinite(Number(upstreamTimeoutMs)) ? Math.max(0, Math.trunc(Number(upstreamTimeoutMs))) : 0;
    if (queueMs > 0 || upstreamMs > 0) return Math.max(1, queueMs + upstreamMs);
    return 0;
  })();
  const gatePromise = gate.withGate(
    route,
    async () => {
      upstreamStartedAt = Date.now();
      const upstreamPromise = resolved.client.models.generateContent(
        withGeminiSdkHttpTimeout(request, upstreamTimeoutMs),
      );
      return await withTimeoutCode(upstreamPromise, upstreamTimeoutMs, 'GEMINI_UPSTREAM_TIMEOUT');
    },
    { bypassCircuit, queueTimeoutMs: normalizedTotalTimeoutMs || queueTimeoutMs },
  );
  const response = await withTimeoutCode(gatePromise, normalizedTotalTimeoutMs, 'GEMINI_TOTAL_TIMEOUT', (err) => {
    const now = Date.now();
    const timedOutUpstream = upstreamStartedAt > startedAt;
    err.code = timedOutUpstream ? 'GEMINI_UPSTREAM_TIMEOUT' : 'GEMINI_QUEUE_TIMEOUT';
    err.timeout_stage = timedOutUpstream ? 'upstream' : 'queue';
    err.meta = {
      gate_wait_ms: timedOutUpstream ? Math.max(0, upstreamStartedAt - startedAt) : Math.max(0, now - startedAt),
      upstream_ms: timedOutUpstream ? Math.max(0, now - upstreamStartedAt) : 0,
      total_ms: Math.max(0, now - startedAt),
    };
  });
  const finishedAt = Date.now();
  const totalMs = Math.max(0, finishedAt - startedAt);
  const upstreamMs = Math.max(0, finishedAt - upstreamStartedAt);
  const gateWaitMs = Math.max(0, totalMs - upstreamMs);
  return {
    response,
    meta: {
      gate_wait_ms: gateWaitMs,
      upstream_ms: upstreamMs,
      total_ms: totalMs,
    },
  };
}

module.exports = {
  hasAuroraGeminiApiKey,
  pickAuroraGeminiApiKey,
  getAuroraGeminiClient,
  callAuroraGeminiGenerateContent,
  callAuroraGeminiGenerateContentRestWithMeta,
  callAuroraGeminiGenerateContentWithMeta,
  __internal: {
    buildGeminiRestBodyFromSdkRequest,
    normalizeGeminiRestModelName,
  },
};
