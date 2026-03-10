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
  bypassCircuit = false,
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
  const response = await gate.withGate(
    route,
    async () => {
      upstreamStartedAt = Date.now();
      return resolved.client.models.generateContent(request);
    },
    { bypassCircuit },
  );
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
  callAuroraGeminiGenerateContentWithMeta,
};
