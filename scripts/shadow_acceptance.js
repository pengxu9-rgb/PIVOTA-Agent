#!/usr/bin/env node

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { parsePromMetrics } = require('./report_verify_live_metrics');
const { runShadowDaily } = require('./run_shadow_daily');

const DEFAULT_BASE = 'https://pivota-agent-production.up.railway.app';
const DEFAULT_IMAGE_URL = 'https://raw.githubusercontent.com/ageitgey/face_recognition/master/examples/obama.jpg';
const DEFAULT_REPORTS_OUT = 'reports';
const DEFAULT_OUTPUTS_OUT = 'outputs';
const DEFAULT_VERIFY_IN = path.join('tmp', 'diag_pseudo_label_factory');
const DEFAULT_HARD_CASES = path.join('tmp', 'diag_verify', 'hard_cases.ndjson');
const DEFAULT_HTTP_TIMEOUT_MS = 25000;
const DEFAULT_HTTP_RETRIES = 3;
const DEFAULT_HTTP_RETRY_DELAY_MS = 1200;
const DEFAULT_FORCE_CURL_HTTP = false;
const DEFAULT_ALLOW_EMBEDDED_IMAGE_FALLBACK = true;
const EMBEDDED_PROBE_IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Zx8QAAAAASUVORK5CYII=';

const DEFAULT_THRESHOLDS = Object.freeze({
  min_used_photos_ratio: 0.95,
  max_pass_fail_rate: 0.05,
  max_timeout_rate: 0.02,
  max_upstream_5xx_rate: 0.02,
});

let HTTP_TIMEOUT_MS = DEFAULT_HTTP_TIMEOUT_MS;
let HTTP_RETRIES = DEFAULT_HTTP_RETRIES;
let HTTP_RETRY_DELAY_MS = DEFAULT_HTTP_RETRY_DELAY_MS;

function setHttpTimeoutMs(ms) {
  HTTP_TIMEOUT_MS = toInt(ms, DEFAULT_HTTP_TIMEOUT_MS, 3000, 120000);
}

function setHttpRetries(value) {
  HTTP_RETRIES = toInt(value, DEFAULT_HTTP_RETRIES, 0, 10);
}

function setHttpRetryDelayMs(value) {
  HTTP_RETRY_DELAY_MS = toInt(value, DEFAULT_HTTP_RETRY_DELAY_MS, 0, 10000);
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

class RetriableHttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'RetriableHttpError';
    this.status = status;
  }
}

function isRetriableStatus(status) {
  if (!Number.isFinite(Number(status))) return false;
  const numeric = Number(status);
  return numeric === 408 || numeric === 425 || numeric === 429 || numeric >= 500;
}

function isRetriableFetchError(error) {
  if (!error) return false;
  if (error.name === 'AbortError' || error.name === 'RetriableHttpError') return true;
  const code = String(error.code || error?.cause?.code || '').toUpperCase();
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE'].includes(code)) return true;
  const message = String(error.message || '').toLowerCase();
  return message.includes('fetch failed') || message.includes('network');
}

async function withRetries(taskFn, label = 'request') {
  let attempt = 0;
  const maxAttempts = Math.max(1, HTTP_RETRIES + 1);
  let lastError = null;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await taskFn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetriableFetchError(error)) {
        throw error;
      }
      if (HTTP_RETRY_DELAY_MS > 0) {
        await sleep(HTTP_RETRY_DELAY_MS * attempt);
      }
    }
  }
  throw lastError || new Error(`${label} failed`);
}

function runCommand(command, args = []) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('close', (code) => {
      resolve({
        code: Number.isFinite(code) ? code : 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    child.on('error', (error) => {
      resolve({
        code: 1,
        stdout: '',
        stderr: error && error.message ? error.message : String(error),
      });
    });
  });
}

function curlTimeoutConfig() {
  return {
    connectTimeoutSec: String(Math.max(2, Math.round(HTTP_TIMEOUT_MS / 5000))),
    maxTimeSec: String(Math.max(5, Math.round(HTTP_TIMEOUT_MS / 1000))),
  };
}

function parseCurlHttpOutput(stdout) {
  const marker = '\n__CURL_STATUS__:';
  const raw = String(stdout || '');
  const index = raw.lastIndexOf(marker);
  if (index < 0) return { status: null, body: raw };
  const body = raw.slice(0, index);
  const statusToken = raw.slice(index + marker.length).trim();
  const status = Number(statusToken);
  return {
    status: Number.isFinite(status) ? status : null,
    body,
  };
}

async function curlHttpRequest({
  method = 'GET',
  url,
  headers = {},
  bodyText = '',
  label = 'http request',
}) {
  const maxAttempts = Math.max(1, HTTP_RETRIES + 1);
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt += 1;
    const { connectTimeoutSec, maxTimeSec } = curlTimeoutConfig();
    const args = [
      '-sS',
      '--connect-timeout',
      connectTimeoutSec,
      '--max-time',
      maxTimeSec,
      '-X',
      safeToken(method, 'GET').toUpperCase(),
      url,
    ];
    for (const [key, value] of Object.entries(headers || {})) {
      if (!safeToken(key, '') || value == null) continue;
      args.push('-H', `${key}: ${value}`);
    }
    if (bodyText) {
      args.push('--data-raw', bodyText);
    }
    args.push('-w', '\n__CURL_STATUS__:%{http_code}');

    const result = await runCommand('curl', args);
    if (result.code !== 0) {
      const message = result.stderr || `exit=${result.code}`;
      const retryableExit = [6, 7, 28, 35, 56].includes(Number(result.code));
      const retryableMessage = /resolve host|failed to connect|timed out|connection reset|ssl|tls/i.test(message);
      if ((retryableExit || retryableMessage) && attempt < maxAttempts) {
        if (HTTP_RETRY_DELAY_MS > 0) await sleep(HTTP_RETRY_DELAY_MS * attempt);
        continue;
      }
      throw new Error(`${label} failed via curl: ${message}`);
    }
    const parsed = parseCurlHttpOutput(result.stdout || '');
    if (!Number.isFinite(parsed.status)) {
      throw new Error(`${label} failed via curl: missing http status`);
    }
    if (isRetriableStatus(parsed.status) && attempt < maxAttempts) {
      if (HTTP_RETRY_DELAY_MS > 0) await sleep(HTTP_RETRY_DELAY_MS * attempt);
      continue;
    }
    return parsed;
  }
  throw new Error(`${label} failed via curl after ${maxAttempts} attempts`);
}

function parseArgs(argv) {
  const out = {
    base: '',
    calls: '',
    guardCalls: '',
    date: '',
    since: '',
    allowGuardTest: '',
    waitAfterSec: '',
    imageUrl: '',
    imagePath: '',
    reportsOut: '',
    outputsOut: '',
    verifyIn: '',
    hardCases: '',
    smokeRetries: '',
    minUsedPhotosRatio: '',
    maxPassFailRate: '',
    maxTimeoutRate: '',
    maxUpstream5xxRate: '',
    httpTimeoutMs: '',
    httpRetries: '',
    httpRetryDelayMs: '',
    guardMaxCallsPerMin: '',
    guardMaxCallsPerDay: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (!next) continue;
    if (token === '--base') {
      out.base = next;
      index += 1;
      continue;
    }
    if (token === '--calls') {
      out.calls = next;
      index += 1;
      continue;
    }
    if (token === '--guard-calls') {
      out.guardCalls = next;
      index += 1;
      continue;
    }
    if (token === '--date') {
      out.date = next;
      index += 1;
      continue;
    }
    if (token === '--since') {
      out.since = next;
      index += 1;
      continue;
    }
    if (token === '--allow-guard-test') {
      out.allowGuardTest = next;
      index += 1;
      continue;
    }
    if (token === '--wait-after-sec') {
      out.waitAfterSec = next;
      index += 1;
      continue;
    }
    if (token === '--image-url') {
      out.imageUrl = next;
      index += 1;
      continue;
    }
    if (token === '--image-path') {
      out.imagePath = next;
      index += 1;
      continue;
    }
    if (token === '--reports-out') {
      out.reportsOut = next;
      index += 1;
      continue;
    }
    if (token === '--outputs-out') {
      out.outputsOut = next;
      index += 1;
      continue;
    }
    if (token === '--in') {
      out.verifyIn = next;
      index += 1;
      continue;
    }
    if (token === '--hard-cases') {
      out.hardCases = next;
      index += 1;
      continue;
    }
    if (token === '--smoke-retries') {
      out.smokeRetries = next;
      index += 1;
      continue;
    }
    if (token === '--min-used-photos-ratio') {
      out.minUsedPhotosRatio = next;
      index += 1;
      continue;
    }
    if (token === '--max-pass-fail-rate') {
      out.maxPassFailRate = next;
      index += 1;
      continue;
    }
    if (token === '--max-timeout-rate') {
      out.maxTimeoutRate = next;
      index += 1;
      continue;
    }
    if (token === '--max-upstream-5xx-rate') {
      out.maxUpstream5xxRate = next;
      index += 1;
      continue;
    }
    if (token === '--http-timeout-ms') {
      out.httpTimeoutMs = next;
      index += 1;
      continue;
    }
    if (token === '--http-retries') {
      out.httpRetries = next;
      index += 1;
      continue;
    }
    if (token === '--http-retry-delay-ms') {
      out.httpRetryDelayMs = next;
      index += 1;
      continue;
    }
    if (token === '--guard-max-calls-per-min') {
      out.guardMaxCallsPerMin = next;
      index += 1;
      continue;
    }
    if (token === '--guard-max-calls-per-day') {
      out.guardMaxCallsPerDay = next;
      index += 1;
    }
  }
  return out;
}

function safeToken(value, fallback = '') {
  const token = String(value == null ? '' : value).trim();
  return token || fallback;
}

function safeNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function parseBool(value, fallback = false) {
  const token = String(value == null ? '' : value).trim().toLowerCase();
  if (!token) return fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(token)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(token)) return false;
  return fallback;
}

function clamp01(value, fallback) {
  const numeric = safeNumber(value, fallback);
  return Math.max(0, Math.min(1, numeric));
}

function toInt(value, fallback, min = 1, max = 10000) {
  const numeric = Math.trunc(safeNumber(value, fallback));
  return Math.max(min, Math.min(max, numeric));
}

function round3(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Number(numeric.toFixed(3));
}

function dateKeyAndStamp(dateValue = '') {
  const token = safeToken(dateValue, '');
  if (/^\d{8}$/.test(token)) return { dateKey: token, stamp: '0000' };
  if (/^\d{4}-\d{2}-\d{2}$/.test(token)) return { dateKey: token.replace(/-/g, ''), stamp: '0000' };
  const now = new Date();
  const dateKey = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
  const stamp = `${String(now.getUTCHours()).padStart(2, '0')}${String(now.getUTCMinutes()).padStart(2, '0')}`;
  return { dateKey, stamp };
}

function parseIsoTimestamp(value) {
  const token = safeToken(value, '');
  if (!token) return null;
  const ts = Date.parse(token);
  return Number.isFinite(ts) ? ts : null;
}

function resolveWindowSince({ requestedSince, runStartIso }) {
  const runStartTs = parseIsoTimestamp(runStartIso);
  const safeRunStartTs = Number.isFinite(runStartTs) ? runStartTs : Date.now();
  const requestedTs = parseIsoTimestamp(requestedSince);
  if (!Number.isFinite(requestedTs)) {
    return {
      requested_since_utc: null,
      effective_since_utc: new Date(safeRunStartTs).toISOString(),
      clamped_to_run_start: false,
      reason: 'default_run_start',
    };
  }
  if (requestedTs <= safeRunStartTs) {
    return {
      requested_since_utc: new Date(requestedTs).toISOString(),
      effective_since_utc: new Date(safeRunStartTs).toISOString(),
      clamped_to_run_start: true,
      reason: 'requested_since_before_run_start',
    };
  }
  return {
    requested_since_utc: new Date(requestedTs).toISOString(),
    effective_since_utc: new Date(requestedTs).toISOString(),
    clamped_to_run_start: false,
    reason: 'requested_since_after_run_start',
  };
}

function sleep(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function countByStatus(summary, status) {
  const row = (summary.calls_by_status || []).find((item) => safeToken(item?.status).toLowerCase() === status.toLowerCase());
  return safeNumber(row?.count, 0);
}

function countByReason(summary, reason) {
  const row = (summary.fail_by_reason || []).find((item) => safeToken(item?.reason).toUpperCase() === reason.toUpperCase());
  return safeNumber(row?.count, 0);
}

function parsePrometheusSnapshot(rawText) {
  return parsePromMetrics(rawText);
}

function computeCounterDelta(prevValue, nextValue) {
  const prev = Math.max(0, safeNumber(prevValue, 0));
  const next = Math.max(0, safeNumber(nextValue, 0));
  if (next >= prev) {
    return {
      delta: next - prev,
      resetDetected: false,
      rawDelta: next - prev,
    };
  }
  return {
    delta: next,
    resetDetected: true,
    rawDelta: next - prev,
  };
}

function computeMapDeltaWithReset({
  prevItems,
  nextItems,
  keyOf,
  valueOf,
  fallbackKey,
}) {
  const keySet = new Set();
  for (const item of prevItems || []) keySet.add(keyOf(item, fallbackKey));
  for (const item of nextItems || []) keySet.add(keyOf(item, fallbackKey));
  const delta = {};
  const rawDelta = {};
  const resetDetected = {};
  let unstable = false;
  for (const key of Array.from(keySet)) {
    const prevValue = valueOf(prevItems, key);
    const nextValue = valueOf(nextItems, key);
    const metricDelta = computeCounterDelta(prevValue, nextValue);
    delta[key] = metricDelta.delta;
    rawDelta[key] = metricDelta.rawDelta;
    if (metricDelta.resetDetected) {
      resetDetected[key] = true;
      unstable = true;
    }
  }
  return {
    delta,
    rawDelta,
    resetDetected,
    unstable,
  };
}

function diffPromSnapshots(before, after) {
  const prev = before || {};
  const next = after || {};
  const callsDelta = computeCounterDelta(prev.verify_calls_total, next.verify_calls_total);
  const failDelta = computeCounterDelta(prev.verify_fail_total, next.verify_fail_total);
  const skipDelta = computeCounterDelta(prev.verify_skip_total, next.verify_skip_total);
  const budgetGuardDelta = computeCounterDelta(prev.verify_budget_guard_total, next.verify_budget_guard_total);
  const circuitOpenDelta = computeCounterDelta(prev.verify_circuit_open_total, next.verify_circuit_open_total);

  const statusDeltaInfo = computeMapDeltaWithReset({
    prevItems: prev.calls_by_status || [],
    nextItems: next.calls_by_status || [],
    keyOf: (item, fallback) => safeToken(item?.status, fallback),
    valueOf: (items, status) => countByStatus({ calls_by_status: items }, status),
    fallbackKey: 'unknown',
  });

  const failReasonDeltaInfo = computeMapDeltaWithReset({
    prevItems: prev.fail_by_reason || [],
    nextItems: next.fail_by_reason || [],
    keyOf: (item, fallback) => safeToken(item?.reason, fallback),
    valueOf: (items, reason) => countByReason({ fail_by_reason: items }, reason),
    fallbackKey: 'UNKNOWN',
  });

  return {
    verify_calls_total: callsDelta.delta,
    verify_fail_total: failDelta.delta,
    verify_skip_total: skipDelta.delta,
    verify_budget_guard_total: budgetGuardDelta.delta,
    verify_circuit_open_total: circuitOpenDelta.delta,
    status_delta: statusDeltaInfo.delta,
    fail_reason_delta: failReasonDeltaInfo.delta,
    raw_delta: {
      verify_calls_total: callsDelta.rawDelta,
      verify_fail_total: failDelta.rawDelta,
      verify_skip_total: skipDelta.rawDelta,
      verify_budget_guard_total: budgetGuardDelta.rawDelta,
      verify_circuit_open_total: circuitOpenDelta.rawDelta,
      status_delta: statusDeltaInfo.rawDelta,
      fail_reason_delta: failReasonDeltaInfo.rawDelta,
    },
    reset_detected: {
      verify_calls_total: callsDelta.resetDetected,
      verify_fail_total: failDelta.resetDetected,
      verify_skip_total: skipDelta.resetDetected,
      verify_budget_guard_total: budgetGuardDelta.resetDetected,
      verify_circuit_open_total: circuitOpenDelta.resetDetected,
      status_delta: statusDeltaInfo.resetDetected,
      fail_reason_delta: failReasonDeltaInfo.resetDetected,
    },
    unstable:
      callsDelta.resetDetected ||
      failDelta.resetDetected ||
      skipDelta.resetDetected ||
      budgetGuardDelta.resetDetected ||
      circuitOpenDelta.resetDetected ||
      statusDeltaInfo.unstable ||
      failReasonDeltaInfo.unstable,
  };
}

async function fetchText(url) {
  const forceCurlHttp = parseBool(
    process.env.SHADOW_ACCEPTANCE_FORCE_CURL_HTTP,
    DEFAULT_FORCE_CURL_HTTP,
  );
  if (forceCurlHttp) {
    const curlResponse = await curlHttpRequest({
      method: 'GET',
      url,
      label: `GET ${url}`,
    });
    if (curlResponse.status >= 400) throw new Error(`request failed ${curlResponse.status}: ${url}`);
    return curlResponse.body;
  }

  try {
    const response = await withRetries(async () => {
      const res = await fetchWithTimeout(url, { method: 'GET' });
      if (!res.ok && isRetriableStatus(res.status)) {
        throw new RetriableHttpError(`request failed ${res.status}: ${url}`, res.status);
      }
      return res;
    }, `GET ${url}`);
    const text = await response.text();
    if (!response.ok) throw new Error(`request failed ${response.status}: ${url}`);
    return text;
  } catch (error) {
    if (!isRetriableFetchError(error)) throw error;
    process.stderr.write(
      `[shadow_acceptance] warning: fetch GET failed (${error && error.message ? error.message : String(error)}), retrying via curl fallback\n`,
    );
    const curlResponse = await curlHttpRequest({
      method: 'GET',
      url,
      label: `GET ${url}`,
    });
    if (curlResponse.status >= 400) throw new Error(`request failed ${curlResponse.status}: ${url}`);
    return curlResponse.body;
  }
}

async function fetchMetricsSummary(base) {
  const raw = await fetchText(`${base}/metrics`);
  return parsePrometheusSnapshot(raw);
}

async function fetchImageBytes(imageUrl) {
  const response = await withRetries(async () => {
    const res = await fetchWithTimeout(imageUrl, { method: 'GET' });
    if (!res.ok && isRetriableStatus(res.status)) {
      throw new RetriableHttpError(`failed to fetch image (${res.status})`, res.status);
    }
    return res;
  }, `GET ${imageUrl}`);
  if (!response.ok) throw new Error(`failed to fetch image (${response.status})`);
  const arrayBuffer = await response.arrayBuffer();
  const bytes = Buffer.from(arrayBuffer);
  if (!bytes.length) throw new Error('image download returned empty body');
  return bytes;
}

async function resolveImageBytes({ imagePath, imageUrl }) {
  const localPath = safeToken(imagePath, '');
  if (localPath) {
    return fs.readFile(path.resolve(localPath));
  }
  try {
    return await fetchImageBytes(imageUrl);
  } catch (error) {
    const allowFallback = parseBool(
      process.env.SHADOW_ACCEPTANCE_ALLOW_EMBEDDED_IMAGE_FALLBACK,
      DEFAULT_ALLOW_EMBEDDED_IMAGE_FALLBACK,
    );
    if (!allowFallback) throw error;
    process.stderr.write(
      `[shadow_acceptance] warning: failed to download probe image (${error && error.message ? error.message : String(error)}), using embedded fallback image\n`,
    );
    return Buffer.from(EMBEDDED_PROBE_IMAGE_BASE64, 'base64');
  }
}

function extractAnalysisCard(payload) {
  const cards = Array.isArray(payload?.cards) ? payload.cards : [];
  return cards.find((card) => safeToken(card?.type) === 'analysis_summary') || null;
}

async function uploadProbePhoto({ base, auroraUid, imageBytes, language = 'EN' }) {
  const uploadViaFetch = async () => {
    const response = await withRetries(async () => {
      const form = new FormData();
      const blob = new Blob([imageBytes], { type: 'image/jpeg' });
      form.append('slot_id', 'daylight');
      form.append('consent', 'true');
      form.append('photo', blob, 'probe.jpg');
      const res = await fetchWithTimeout(`${base}/v1/photos/upload`, {
        method: 'POST',
        headers: {
          'X-Aurora-UID': auroraUid,
          'X-Lang': language,
        },
        body: form,
      });
      if (!res.ok && isRetriableStatus(res.status)) {
        throw new RetriableHttpError(`photo upload failed (${res.status})`, res.status);
      }
      return res;
    }, 'POST /v1/photos/upload');
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`photo upload failed (${response.status})`);
    return json;
  };

  const uploadViaCurl = async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aurora_shadow_accept_'));
    const tmpImagePath = path.join(tmpDir, 'probe.jpg');
    try {
      await fs.writeFile(tmpImagePath, imageBytes);
      const args = [
        '-sS',
        '--connect-timeout',
        String(Math.max(2, Math.round(HTTP_TIMEOUT_MS / 5000))),
        '--max-time',
        String(Math.max(5, Math.round(HTTP_TIMEOUT_MS / 1000))),
        '-X',
        'POST',
        `${base}/v1/photos/upload`,
        '-H',
        `X-Aurora-UID: ${auroraUid}`,
        '-H',
        `X-Lang: ${language}`,
        '-F',
        'slot_id=daylight',
        '-F',
        'consent=true',
        '-F',
        `photo=@${tmpImagePath};type=image/jpeg`,
      ];
      const result = await runCommand('curl', args);
      if (result.code !== 0) {
        throw new Error(`photo upload failed via curl: ${result.stderr || `exit=${result.code}`}`);
      }
      return JSON.parse(result.stdout || '{}');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  };

  let json = null;
  const forceCurlUpload = parseBool(process.env.SHADOW_ACCEPTANCE_FORCE_CURL_UPLOAD, false);
  if (forceCurlUpload) {
    process.stderr.write('[shadow_acceptance] info: SHADOW_ACCEPTANCE_FORCE_CURL_UPLOAD=true, using curl uploader\n');
    json = await uploadViaCurl();
  } else {
    try {
      json = await uploadViaFetch();
    } catch (error) {
      const shouldFallbackToCurl = isRetriableFetchError(error);
      if (!shouldFallbackToCurl) throw error;
      process.stderr.write(
        `[shadow_acceptance] warning: fetch upload failed (${error && error.message ? error.message : String(error)}), retrying via curl fallback\n`,
      );
      json = await uploadViaCurl();
    }
  }

  const cards = Array.isArray(json?.cards) ? json.cards : [];
  const card = cards.find((item) => safeToken(item?.type) === 'photo_confirm');
  const photoId = safeToken(card?.payload?.photo_id, '');
  const qcStatus = safeToken(card?.payload?.qc_status, 'passed');
  if (!photoId) throw new Error('photo upload returned no photo_id');
  return { photoId, qcStatus };
}

async function runSmokeBatch({
  base,
  auroraUid,
  imageBytes,
  calls,
  language,
  extraHeaders = {},
  runtimeLimits = null,
}) {
  const upload = await uploadProbePhoto({ base, auroraUid, imageBytes, language });
  const analysisPayload = {
    use_photo: true,
    currentRoutine: {
      am: [{ step: 'cleanser', product: 'gentle cleanser' }],
      pm: [{ step: 'moisturizer', product: 'barrier cream' }],
    },
    photos: [
      {
        photo_id: upload.photoId,
        slot_id: 'daylight',
        qc_status: upload.qcStatus || 'passed',
      },
    ],
  };
  const analysisUrl = new URL('/v1/analysis/skin', base);
  if (runtimeLimits && Number.isFinite(runtimeLimits.maxCallsPerMin)) {
    analysisUrl.searchParams.set('diag_verify_max_calls_per_min', String(Math.max(0, Math.trunc(runtimeLimits.maxCallsPerMin))));
  }
  if (runtimeLimits && Number.isFinite(runtimeLimits.maxCallsPerDay)) {
    analysisUrl.searchParams.set('diag_verify_max_calls_per_day', String(Math.max(0, Math.trunc(runtimeLimits.maxCallsPerDay))));
  }
  const analysisUrlText = analysisUrl.toString();
  const forceCurlHttp = parseBool(
    process.env.SHADOW_ACCEPTANCE_FORCE_CURL_HTTP,
    DEFAULT_FORCE_CURL_HTTP,
  );

  let usedPhotosTrue = 0;
  let renderableCards = 0;
  const callResults = [];
  for (let index = 0; index < calls; index += 1) {
    let payload = {};
    if (forceCurlHttp) {
      const curlResponse = await curlHttpRequest({
        method: 'POST',
        url: analysisUrlText,
        headers: {
          'Content-Type': 'application/json',
          'X-Aurora-UID': auroraUid,
          'X-Lang': language,
          ...extraHeaders,
        },
        bodyText: JSON.stringify(analysisPayload),
        label: 'POST /v1/analysis/skin',
      });
      if (curlResponse.status >= 400) throw new Error(`analysis call failed (${curlResponse.status})`);
      payload = JSON.parse(curlResponse.body || '{}');
    } else {
      try {
        const response = await withRetries(async () => {
          const res = await fetchWithTimeout(analysisUrlText, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Aurora-UID': auroraUid,
              'X-Lang': language,
              ...extraHeaders,
            },
            body: JSON.stringify(analysisPayload),
          });
          if (!res.ok && isRetriableStatus(res.status)) {
            throw new RetriableHttpError(`analysis call failed (${res.status})`, res.status);
          }
          return res;
        }, 'POST /v1/analysis/skin');
        payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(`analysis call failed (${response.status})`);
      } catch (error) {
        if (!isRetriableFetchError(error)) throw error;
        process.stderr.write(
          `[shadow_acceptance] warning: fetch POST failed (${error && error.message ? error.message : String(error)}), retrying via curl fallback\n`,
        );
        const curlResponse = await curlHttpRequest({
          method: 'POST',
          url: analysisUrlText,
          headers: {
            'Content-Type': 'application/json',
            'X-Aurora-UID': auroraUid,
            'X-Lang': language,
            ...extraHeaders,
          },
          bodyText: JSON.stringify(analysisPayload),
          label: 'POST /v1/analysis/skin',
        });
        if (curlResponse.status >= 400) throw new Error(`analysis call failed (${curlResponse.status})`);
        payload = JSON.parse(curlResponse.body || '{}');
      }
    }
    const card = extractAnalysisCard(payload);
    if (card) renderableCards += 1;
    const usedPhotos = Boolean(card?.payload?.used_photos);
    if (usedPhotos) usedPhotosTrue += 1;
    callResults.push({
      used_photos: usedPhotos,
      analysis_source: safeToken(card?.payload?.analysis_source, 'unknown'),
      quality_grade: safeToken(card?.payload?.quality_report?.photo_quality?.grade, 'unknown'),
      has_analysis_card: Boolean(card),
    });
  }
  const total = callResults.length;
  return {
    total_calls: total,
    used_photos_true: usedPhotosTrue,
    used_photos_ratio: total > 0 ? round3(usedPhotosTrue / total) : 0,
    renderable_card_ratio: total > 0 ? round3(renderableCards / total) : 0,
    call_results: callResults,
  };
}

function compareSmokeResultQuality(next, current) {
  if (!current) return true;
  const nextRatio = safeNumber(next?.used_photos_ratio, 0);
  const currentRatio = safeNumber(current?.used_photos_ratio, 0);
  if (nextRatio !== currentRatio) return nextRatio > currentRatio;
  const nextRenderable = safeNumber(next?.renderable_card_ratio, 0);
  const currentRenderable = safeNumber(current?.renderable_card_ratio, 0);
  if (nextRenderable !== currentRenderable) return nextRenderable > currentRenderable;
  const nextUsed = safeNumber(next?.used_photos_true, 0);
  const currentUsed = safeNumber(current?.used_photos_true, 0);
  if (nextUsed !== currentUsed) return nextUsed > currentUsed;
  const nextCalls = safeNumber(next?.total_calls, 0);
  const currentCalls = safeNumber(current?.total_calls, 0);
  return nextCalls > currentCalls;
}

async function runSmokeWithRetries({
  base,
  auroraUid,
  imageBytes,
  calls,
  language,
  minUsedPhotosRatio,
  maxRetries,
}) {
  const attempts = [];
  let best = null;
  const retries = Math.max(0, Math.trunc(safeNumber(maxRetries, 0)));
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const attemptUid = `${auroraUid}_smoke_${attempt + 1}`;
    const result = await runSmokeBatch({
      base,
      auroraUid: attemptUid,
      imageBytes,
      calls,
      language,
    });
    result.attempt = attempt + 1;
    attempts.push(result);
    if (compareSmokeResultQuality(result, best)) best = result;
    if (
      safeNumber(result.used_photos_ratio, 0) >= safeNumber(minUsedPhotosRatio, 0) &&
      safeNumber(result.renderable_card_ratio, 0) >= 1
    ) {
      break;
    }
  }
  return {
    best: best || {
      total_calls: 0,
      used_photos_true: 0,
      used_photos_ratio: 0,
      renderable_card_ratio: 0,
      call_results: [],
      attempt: 0,
    },
    attempts,
  };
}

function evaluateThresholds({ shadowSummary, thresholds }) {
  const rates = shadowSummary?.rates || {};
  const checks = [
    {
      key: 'pass_fail_rate',
      value: safeNumber(rates.pass_fail_rate, 0) || 0,
      threshold_max: thresholds.max_pass_fail_rate,
      pass: (safeNumber(rates.pass_fail_rate, 0) || 0) <= thresholds.max_pass_fail_rate,
    },
    {
      key: 'timeout_rate_vs_calls',
      value: safeNumber(rates.timeout_rate_vs_calls, 0) || 0,
      threshold_max: thresholds.max_timeout_rate,
      pass: (safeNumber(rates.timeout_rate_vs_calls, 0) || 0) <= thresholds.max_timeout_rate,
    },
    {
      key: 'upstream_5xx_rate_vs_calls',
      value: safeNumber(rates.upstream_5xx_rate_vs_calls, 0) || 0,
      threshold_max: thresholds.max_upstream_5xx_rate,
      pass: (safeNumber(rates.upstream_5xx_rate_vs_calls, 0) || 0) <= thresholds.max_upstream_5xx_rate,
    },
  ];
  return checks;
}

function observeGuardHit(delta = {}) {
  const statusDelta = delta?.status_delta || {};
  const guardStatusDelta = safeNumber(statusDelta.guard, 0);
  const skipStatusDelta = safeNumber(statusDelta.skip, 0);
  const budgetGuardDelta = safeNumber(delta?.verify_budget_guard_total, 0);
  return {
    guardStatusDelta,
    skipStatusDelta,
    budgetGuardDelta,
    hit: guardStatusDelta > 0 || (skipStatusDelta > 0 && budgetGuardDelta > 0),
  };
}

async function checkRequiredArtifacts(paths) {
  const missing = [];
  const required = [
    paths.verify_daily_md,
    paths.pseudo_labels_daily,
    paths.hard_cases_daily,
    paths.job_summary,
  ];
  for (const filePath of required) {
    try {
      await fs.access(filePath);
    } catch (_err) {
      missing.push(filePath);
    }
  }
  return { missing, pass: missing.length === 0 };
}

function formatMdTable(headers, rows) {
  const lines = [];
  lines.push(`| ${headers.join(' | ')} |`);
  lines.push(`| ${headers.map(() => '---').join(' | ')} |`);
  for (const row of rows) {
    lines.push(`| ${row.map((item) => String(item == null ? '' : item)).join(' | ')} |`);
  }
  return lines.join('\n');
}

function buildMarkdownReport({
  generatedAt,
  base,
  verdict,
  runStartedAt,
  smoke,
  guard,
  deltaStepA,
  deltaStepB,
  shadowSummary,
  thresholdChecks,
  artifactCheck,
  failures,
}) {
  const lines = [];
  lines.push('# Shadow Acceptance Report');
  lines.push('');
  lines.push(`Generated at (UTC): ${generatedAt}`);
  lines.push(`Base: ${base}`);
  lines.push(`Run started at (UTC): ${runStartedAt}`);
  lines.push(`Verdict: ${verdict}`);
  lines.push('');
  lines.push('## Step A Smoke');
  lines.push(`- smoke_attempts: ${Array.isArray(smoke.attempts) ? smoke.attempts.length : 1}`);
  if (Array.isArray(smoke.attempts) && smoke.attempts.length > 0) {
    lines.push(`- smoke_attempt_ratios: ${smoke.attempts.map((item) => item.used_photos_ratio).join(', ')}`);
  }
  lines.push(`- used_photos_ratio: ${smoke.used_photos_ratio}`);
  lines.push(`- renderable_card_ratio: ${smoke.renderable_card_ratio}`);
  lines.push(`- verify_calls_total_delta: ${deltaStepA.verify_calls_total}`);
  lines.push(`- verify_success_delta: ${safeNumber(deltaStepA.status_delta.success, 0) + safeNumber(deltaStepA.status_delta.ok, 0)}`);
  lines.push(`- metrics_delta_unstable: ${deltaStepA.unstable ? 'yes' : 'no'}`);
  lines.push(`- verify_fail_total_delta: ${deltaStepA.verify_fail_total}`);
  lines.push('');
  lines.push('## Step B Guard Test');
  if (!guard.executed) {
    lines.push(`- skipped: ${guard.skip_reason}`);
  } else {
    const guardObserved = observeGuardHit(deltaStepB);
    lines.push(`- guard_calls: ${guard.calls}`);
    lines.push(`- verify_calls_total{status=guard} delta: ${guardObserved.guardStatusDelta}`);
    lines.push(`- verify_calls_total{status=skip} delta: ${guardObserved.skipStatusDelta}`);
    lines.push(`- verify_budget_guard_total delta: ${deltaStepB.verify_budget_guard_total}`);
    lines.push(`- guard_hit_observed: ${guardObserved.hit ? 'yes' : 'no'}`);
    lines.push(`- renderable_card_ratio: ${guard.renderable_card_ratio}`);
  }
  lines.push('');
  lines.push('## Step C Daily Artifacts');
  lines.push(`- window_since_effective_utc: ${shadowSummary.window_context?.effective_since_utc || 'n/a'}`);
  if (shadowSummary.window_context?.requested_since_utc) {
    lines.push(`- window_since_requested_utc: ${shadowSummary.window_context.requested_since_utc}`);
  }
  lines.push(`- window_since_clamped_to_run_start: ${shadowSummary.window_context?.clamped_to_run_start ? 'yes' : 'no'}`);
  lines.push(`- verify_daily_md: ${shadowSummary.outputs.verify_daily_md}`);
  lines.push(`- pseudo_labels_daily: ${shadowSummary.outputs.pseudo_labels_daily}`);
  lines.push(`- hard_cases_daily: ${shadowSummary.outputs.hard_cases_daily}`);
  lines.push(`- job_summary: ${shadowSummary.outputs.job_summary}`);
  lines.push(`- artifacts_check: ${artifactCheck.pass ? 'pass' : 'fail'}`);
  lines.push('');
  lines.push('## Threshold Checks');
  lines.push('');
  lines.push(formatMdTable(
    ['metric', 'value', 'threshold_max', 'pass'],
    thresholdChecks.map((item) => [item.key, item.value, item.threshold_max, item.pass ? 'yes' : 'no']),
  ));
  lines.push('');
  lines.push('## Failure Reasons');
  if (!failures.length) {
    lines.push('- none');
  } else {
    for (const reason of failures) lines.push(`- ${reason}`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function runShadowAcceptance(options = {}) {
  const base = safeToken(options.base, DEFAULT_BASE).replace(/\/+$/, '');
  const calls = toInt(options.calls, 20, 1, 1000);
  const guardCalls = toInt(options.guardCalls, 20, 1, 1000);
  const smokeRetriesInput = safeToken(options.smokeRetries, safeToken(process.env.SHADOW_ACCEPTANCE_SMOKE_RETRIES, '2'));
  const smokeRetries = toInt(smokeRetriesInput, 2, 0, 5);
  const waitAfterSec = toInt(options.waitAfterSec, 12, 1, 120);
  const guardMaxCallsPerMin = toInt(options.guardMaxCallsPerMin, 3, 0, 1000000);
  const guardMaxCallsPerDay = toInt(options.guardMaxCallsPerDay, 6, 0, 100000000);
  const imageUrl = safeToken(options.imageUrl, DEFAULT_IMAGE_URL);
  const reportsOut = path.resolve(options.reportsOut || DEFAULT_REPORTS_OUT);
  const outputsOut = path.resolve(options.outputsOut || DEFAULT_OUTPUTS_OUT);
  const verifyIn = path.resolve(options.verifyIn || DEFAULT_VERIFY_IN);
  const hardCases = path.resolve(options.hardCases || DEFAULT_HARD_CASES);
  const allowGuardTest = parseBool(
    options.allowGuardTest,
    parseBool(process.env.ALLOW_GUARD_TEST, false),
  );
  const thresholds = {
    min_used_photos_ratio: clamp01(options.minUsedPhotosRatio, DEFAULT_THRESHOLDS.min_used_photos_ratio),
    max_pass_fail_rate: clamp01(options.maxPassFailRate, DEFAULT_THRESHOLDS.max_pass_fail_rate),
    max_timeout_rate: clamp01(options.maxTimeoutRate, DEFAULT_THRESHOLDS.max_timeout_rate),
    max_upstream_5xx_rate: clamp01(options.maxUpstream5xxRate, DEFAULT_THRESHOLDS.max_upstream_5xx_rate),
  };
  const httpTimeoutMs = toInt(options.httpTimeoutMs, DEFAULT_HTTP_TIMEOUT_MS, 3000, 120000);
  const httpRetries = toInt(options.httpRetries, DEFAULT_HTTP_RETRIES, 0, 10);
  const httpRetryDelayMs = toInt(options.httpRetryDelayMs, DEFAULT_HTTP_RETRY_DELAY_MS, 0, 10000);
  setHttpTimeoutMs(httpTimeoutMs);
  setHttpRetries(httpRetries);
  setHttpRetryDelayMs(httpRetryDelayMs);
  const now = new Date();
  const { dateKey, stamp } = dateKeyAndStamp(options.date);
  const runStartedAtIso = now.toISOString();
  const windowSince = resolveWindowSince({
    requestedSince: options.since,
    runStartIso: runStartedAtIso,
  });
  const startedAtIso = windowSince.effective_since_utc;
  const auroraUid = `uid_shadow_accept_${Date.now()}`;
  const imageBytes = await resolveImageBytes({
    imagePath: options.imagePath,
    imageUrl,
  });

  const failures = [];

  const beforeA = await fetchMetricsSummary(base);
  const smokeResult = await runSmokeWithRetries({
    base,
    auroraUid,
    imageBytes,
    calls,
    language: 'EN',
    minUsedPhotosRatio: thresholds.min_used_photos_ratio,
    maxRetries: smokeRetries,
  });
  const smoke = {
    ...smokeResult.best,
    attempts: smokeResult.attempts,
  };
  await sleep(waitAfterSec * 1000);
  const afterA = await fetchMetricsSummary(base);
  const deltaStepA = diffPromSnapshots(beforeA, afterA);

  if (smoke.used_photos_ratio < thresholds.min_used_photos_ratio) {
    failures.push(`used_photos_ratio too low: ${smoke.used_photos_ratio} < ${thresholds.min_used_photos_ratio}`);
  }
  const successDelta = safeNumber(deltaStepA.status_delta.success, 0) + safeNumber(deltaStepA.status_delta.ok, 0);
  const hasVisionSource = (smoke.call_results || []).some(
    (item) => safeToken(item?.analysis_source).toLowerCase() === 'vision_gemini',
  );
  if (!hasVisionSource) failures.push('smoke calls produced no vision_gemini analysis_source');
  if (!deltaStepA.unstable && successDelta < 1) failures.push('verify success delta is 0 (status=success|ok)');
  if (smoke.renderable_card_ratio < 1) failures.push('analysis_summary missing in one or more smoke calls');

  let guard = { executed: false, skip_reason: 'ALLOW_GUARD_TEST=false' };
  let deltaStepB = {
    verify_calls_total: 0,
    verify_fail_total: 0,
    verify_skip_total: 0,
    verify_budget_guard_total: 0,
    verify_circuit_open_total: 0,
    status_delta: {},
    fail_reason_delta: {},
  };
  if (allowGuardTest) {
    guard = { executed: true, calls: guardCalls };
    const beforeB = await fetchMetricsSummary(base);
    const guardBatch = await runSmokeBatch({
      base,
      auroraUid,
      imageBytes,
      calls: guardCalls,
      language: 'EN',
      extraHeaders: {
        'X-Diag-Verify-Max-Calls-Per-Min': String(guardMaxCallsPerMin),
        'X-Diag-Verify-Max-Calls-Per-Day': String(guardMaxCallsPerDay),
      },
      runtimeLimits: {
        maxCallsPerMin: guardMaxCallsPerMin,
        maxCallsPerDay: guardMaxCallsPerDay,
      },
    });
    guard.renderable_card_ratio = guardBatch.renderable_card_ratio;
    await sleep(waitAfterSec * 1000);
    const afterB = await fetchMetricsSummary(base);
    deltaStepB = diffPromSnapshots(beforeB, afterB);
    const guardObserved = observeGuardHit(deltaStepB);
    if (!guardObserved.hit) {
      failures.push(
        'guard test failed: neither verify_calls_total{status="guard"} nor (status="skip" + verify_budget_guard_total) increased',
      );
    }
    if (deltaStepB.verify_budget_guard_total <= 0) {
      failures.push('guard test failed: verify_budget_guard_total did not increase');
    }
    if (guardBatch.renderable_card_ratio < 1) {
      failures.push('guard test impacted user-visible response (missing analysis_summary)');
    }
  }

  const shadowSummary = await runShadowDaily({
    date: dateKey,
    since: startedAtIso,
    verifyIn,
    hardCases,
    reportsOut,
    outputsOut,
  });
  shadowSummary.window_context = {
    requested_since_utc: windowSince.requested_since_utc,
    effective_since_utc: windowSince.effective_since_utc,
    clamped_to_run_start: windowSince.clamped_to_run_start,
    clamp_reason: windowSince.reason,
  };

  const thresholdChecks = evaluateThresholds({ shadowSummary, thresholds });
  for (const check of thresholdChecks) {
    if (!check.pass) failures.push(`${check.key} exceeds threshold (${check.value} > ${check.threshold_max})`);
  }

  const auth401 = safeNumber(shadowSummary?.rates?.upstream_401_count, 0);
  const auth403 = safeNumber(shadowSummary?.rates?.upstream_403_count, 0);
  if (auth401 > 0) failures.push(`UPSTREAM_401 detected: ${auth401}`);
  if (auth403 > 0) failures.push(`UPSTREAM_403 detected: ${auth403}`);

  const artifactCheck = await checkRequiredArtifacts(shadowSummary.outputs || {});
  if (!artifactCheck.pass) failures.push(`missing artifacts: ${artifactCheck.missing.join(', ')}`);

  const verdict = failures.length ? 'FAIL' : 'PASS';
  await fs.mkdir(reportsOut, { recursive: true });
  const reportPath = path.join(reportsOut, `shadow_acceptance_${dateKey}_${stamp}.md`);
  const jsonPath = path.join(reportsOut, `shadow_acceptance_${dateKey}_${stamp}.json`);
  const payload = {
    schema_version: 'aurora.diag.shadow_acceptance.v1',
    generated_at_utc: new Date().toISOString(),
    verdict,
    base,
    started_at_utc: runStartedAtIso,
    window_since_requested_utc: windowSince.requested_since_utc,
    window_since_effective_utc: windowSince.effective_since_utc,
    window_since_clamped_to_run_start: windowSince.clamped_to_run_start,
    smoke_retries: smokeRetries,
    thresholds,
    smoke,
    guard,
    delta_step_a: deltaStepA,
    delta_step_b: deltaStepB,
    shadow_daily: shadowSummary,
    threshold_checks: thresholdChecks,
    artifact_check: artifactCheck,
    failures,
  };
  const markdown = buildMarkdownReport({
    generatedAt: payload.generated_at_utc,
    base,
    verdict,
    runStartedAt: runStartedAtIso,
    smoke,
    guard,
    deltaStepA,
    deltaStepB,
    shadowSummary,
    thresholdChecks,
    artifactCheck,
    failures,
  });
  await fs.writeFile(reportPath, markdown, 'utf8');
  await fs.writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { reportPath, jsonPath, verdict, failures };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runShadowAcceptance(args);
  process.stdout.write(`${path.resolve(result.jsonPath)}\n${path.resolve(result.reportPath)}\n`);
  if (result.verdict !== 'PASS') process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  parsePrometheusSnapshot,
  computeCounterDelta,
  diffPromSnapshots,
  resolveWindowSince,
  compareSmokeResultQuality,
  evaluateThresholds,
  observeGuardHit,
  checkRequiredArtifacts,
  runShadowAcceptance,
};
