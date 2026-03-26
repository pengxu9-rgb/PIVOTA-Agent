'use strict';

const { resolveAuroraGeminiKey } = require('./auroraGeminiKeys');
const { getGeminiGlobalGate } = require('../lib/geminiGlobalGate');

const clientsByKey = new Map();
let geminiInitFailed = false;

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

function withTimeoutMeta(promise, timeoutMs, { code = 'GEMINI_UPSTREAM_TIMEOUT', stage = 'upstream' } = {}) {
  const ms = Number.isFinite(Number(timeoutMs)) ? Math.max(1, Math.trunc(Number(timeoutMs))) : 0;
  if (!ms) return promise;
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(code);
      err.code = code;
      err.timeout_stage = stage;
      reject(err);
    }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
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

async function callAuroraGeminiGenerateContentWithMeta({
  featureEnvVar,
  route = 'aurora_gemini',
  request,
  queueTimeoutMs = 0,
  upstreamTimeoutMs = 0,
  bypassCircuit = false,
} = {}) {
  const resolved = getAuroraGeminiClient(featureEnvVar);
  if (!resolved.client) {
    const err = new Error(resolved.init_error || 'MISSING_GEMINI_KEY');
    err.code = resolved.init_error || 'MISSING_GEMINI_KEY';
    throw err;
  }
  const gate = getGeminiGlobalGate();
  let upstreamStartedAt = 0;
  const startedAt = Date.now();
  const wrapped = await gate.withGateMeta(
    route,
    async () => {
      upstreamStartedAt = Date.now();
      return await withTimeoutMeta(
        resolved.client.models.generateContent(request),
        upstreamTimeoutMs,
        { code: 'GEMINI_UPSTREAM_TIMEOUT', stage: 'upstream' },
      );
    },
    { bypassCircuit, queueTimeoutMs },
  );
  const meta = wrapped && wrapped.meta && typeof wrapped.meta === 'object' ? { ...wrapped.meta } : {};
  meta.route = route;
  meta.gate_wait_ms = Number.isFinite(Number(meta.gate_wait_ms)) ? Math.max(0, Math.trunc(Number(meta.gate_wait_ms))) : 0;
  meta.upstream_ms =
    upstreamStartedAt > 0 ? Math.max(0, Date.now() - upstreamStartedAt) : Number.isFinite(Number(meta.execution_ms)) ? Math.max(0, Math.trunc(Number(meta.execution_ms))) : 0;
  meta.total_ms = Number.isFinite(Number(meta.total_ms)) ? Math.max(0, Math.trunc(Number(meta.total_ms))) : Math.max(0, Date.now() - startedAt);
  return {
    response: wrapped ? wrapped.result : null,
    meta,
  };
}

module.exports = {
  hasAuroraGeminiApiKey,
  pickAuroraGeminiApiKey,
  getAuroraGeminiClient,
  callAuroraGeminiGenerateContent,
  callAuroraGeminiGenerateContentWithMeta,
};
