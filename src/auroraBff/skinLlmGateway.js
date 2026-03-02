const { parseJsonOnlyObject } = require('./jsonExtract');
const {
  SkinVisionObservationSchema,
  SkinReportStrategySchema,
  validateVisionObservation,
  validateReportStrategy,
} = require('./skinAnalysisContract');
const {
  buildSkinVisionPromptBundle,
  buildSkinReportPromptBundle,
} = require('./skinLlmPrompts');
const { getGeminiGlobalGate } = require('../lib/geminiGlobalGate');

const GEMINI_API_KEY = String(
  process.env.AURORA_SKIN_GEMINI_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
).trim();

const DEFAULT_SKIN_GEMINI_MODEL = 'gemini-3-pro';
const DEFAULT_SKIN_GEMINI_FALLBACK_MODEL = 'gemini-2.0-flash';
const SKIN_VISION_MODEL_GEMINI =
  String(
    process.env.AURORA_SKIN_VISION_MODEL_GEMINI ||
      process.env.AURORA_SKIN_MODEL_GEMINI ||
      process.env.GEMINI_MODEL ||
      DEFAULT_SKIN_GEMINI_MODEL,
  ).trim() || DEFAULT_SKIN_GEMINI_MODEL;
const SKIN_REPORT_MODEL_GEMINI =
  String(
    process.env.AURORA_SKIN_REPORT_MODEL_GEMINI ||
      process.env.AURORA_SKIN_MODEL_GEMINI ||
      process.env.AURORA_SKIN_VISION_MODEL_GEMINI ||
      process.env.GEMINI_MODEL ||
      DEFAULT_SKIN_GEMINI_MODEL,
  ).trim() || SKIN_VISION_MODEL_GEMINI;
const SKIN_MODEL_GEMINI = SKIN_VISION_MODEL_GEMINI;

const SKIN_LLM_TIMEOUT_MS = Math.max(2000, Math.min(30000, Number(process.env.AURORA_SKIN_VISION_TIMEOUT_MS || 12000)));

let geminiClient = null;
let geminiInitFailed = false;

function uniqModels(models = []) {
  const out = [];
  const seen = new Set();
  for (const raw of models) {
    const model = String(raw || '').trim();
    if (!model) continue;
    const key = model.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(model);
  }
  return out;
}

function parseModelLadderEnv(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  return uniqModels(text.split(',').map((item) => String(item || '').trim()));
}

function buildGeminiModelLadder({ primaryModel, fallbackModel, envOverride } = {}) {
  const fromEnv = parseModelLadderEnv(envOverride);
  if (fromEnv.length) return fromEnv;
  return uniqModels([primaryModel, fallbackModel || DEFAULT_SKIN_GEMINI_FALLBACK_MODEL]);
}

const SKIN_VISION_MODEL_LADDER = buildGeminiModelLadder({
  primaryModel: SKIN_VISION_MODEL_GEMINI,
  fallbackModel: DEFAULT_SKIN_GEMINI_FALLBACK_MODEL,
  envOverride: process.env.AURORA_SKIN_VISION_MODEL_LADDER,
});

const SKIN_REPORT_MODEL_LADDER = buildGeminiModelLadder({
  primaryModel: SKIN_REPORT_MODEL_GEMINI,
  fallbackModel: DEFAULT_SKIN_GEMINI_FALLBACK_MODEL,
  envOverride: process.env.AURORA_SKIN_REPORT_MODEL_LADDER,
});

function isGeminiSkinGatewayAvailable() {
  return Boolean(GEMINI_API_KEY);
}

function getGeminiClient() {
  const globalGate = getGeminiGlobalGate();
  const effectiveKey = globalGate.getApiKey() || GEMINI_API_KEY;
  if (!effectiveKey) return null;
  if (geminiClient) return geminiClient;
  if (geminiInitFailed) return null;
  try {
    const { GoogleGenAI } = require('@google/genai');
    geminiClient = new GoogleGenAI({ apiKey: effectiveKey });
    return geminiClient;
  } catch (_err) {
    geminiInitFailed = true;
    return null;
  }
}

function withTimeout(promise, timeoutMs) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`GEMINI_TIMEOUT_${timeoutMs}`);
        err.code = 'GEMINI_TIMEOUT';
        reject(err);
      }, timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function extractTextFromGeminiResponse(response) {
  if (!response) return '';
  if (typeof response.text === 'function') {
    const text = await response.text();
    if (typeof text === 'string' && text.trim()) return text;
  }
  if (typeof response.text === 'string' && response.text.trim()) return response.text;

  const candidates = Array.isArray(response.candidates) ? response.candidates : [];
  for (const candidate of candidates) {
    const parts = candidate && candidate.content && Array.isArray(candidate.content.parts)
      ? candidate.content.parts
      : [];
    const text = parts
      .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
      .join('\n')
      .trim();
    if (text) return text;
  }
  return '';
}

function unwrapCodeFence(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text.startsWith('```')) return text;
  const lines = text.split(/\r?\n/);
  if (!lines.length) return text;
  if (!lines[0].startsWith('```')) return text;
  let end = lines.length - 1;
  while (end > 0 && !lines[end].startsWith('```')) end -= 1;
  if (end <= 0) return text;
  return lines.slice(1, end).join('\n').trim();
}

function trimOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function clampText(value, maxLen = 500) {
  const text = trimOrNull(value);
  if (!text) return null;
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(1, maxLen - 3))}...`;
}

function sanitizeGeminiResponseSchema(schema) {
  if (Array.isArray(schema)) return schema.map((item) => sanitizeGeminiResponseSchema(item));
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    // Gemini responseSchema currently rejects this keyword in nested items.
    if (key === 'additionalProperties') continue;
    out[key] = sanitizeGeminiResponseSchema(value);
  }
  return out;
}

function toStatusCodeFromMessage(error) {
  const text = String((error && error.message) || '').trim();
  if (!text) return null;
  const patterns = [
    /got\s+status:\s*(\d{3})/i,
    /\bstatus(?:\s*code)?\s*[=:]\s*(\d{3})\b/i,
    /\bhttp\s*(\d{3})\b/i,
    /\b(\d{3})\s*(?:bad request|unauthorized|forbidden|not found|too many requests|internal server error|service unavailable)\b/i,
  ];
  for (const pattern of patterns) {
    const matched = text.match(pattern);
    if (!matched || matched.length < 2) continue;
    const num = Number(matched[1]);
    if (Number.isFinite(num) && num >= 100 && num <= 599) return Math.trunc(num);
  }
  return null;
}

function toStatusCode(error) {
  const candidates = [
    error && error.status,
    error && error.statusCode,
    error && error.response && error.response.status,
    error && error.response && error.response.data && error.response.data.status,
    error && error.response && error.response.data && error.response.data.code,
    error && error.response && error.response.data && error.response.data.error && error.response.data.error.code,
  ];
  for (const value of candidates) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) return Math.trunc(num);
  }
  return toStatusCodeFromMessage(error);
}

function getHeaderValue(headers, keyCandidates = []) {
  if (!headers || typeof headers !== 'object') return null;
  for (const key of keyCandidates) {
    const direct = trimOrNull(headers[key]);
    if (direct) return direct;
    const lower = trimOrNull(headers[String(key || '').toLowerCase()]);
    if (lower) return lower;
  }
  return null;
}

function classifyGeminiError(err) {
  if (!err) return { reason: 'UNKNOWN', upstream_status_code: null, error_evidence: null };
  const codeRaw =
    trimOrNull(err.code) ||
    trimOrNull(err.errorCode) ||
    trimOrNull(err && err.response && err.response.data && err.response.data.error && err.response.data.error.status) ||
    trimOrNull(err && err.response && err.response.data && err.response.data.error && err.response.data.error.code) ||
    trimOrNull(err && err.response && err.response.data && err.response.data.code) ||
    null;
  const code = String(codeRaw || '').trim().toUpperCase();
  const status = toStatusCode(err);
  const message = String(err.message || '').toLowerCase();
  const responseHeaders = err && err.response && err.response.headers ? err.response.headers : null;
  const rootHeaders = err && err.headers ? err.headers : null;
  const headers = responseHeaders || rootHeaders;
  const grpcStatusRaw =
    trimOrNull(err && err.grpc_status) ||
    trimOrNull(err && err.grpcStatus) ||
    trimOrNull(err && err.response && err.response.data && err.response.data.error && err.response.data.error.status) ||
    null;
  const evidenceBase = {
    reason_normalized: 'VISION_UNKNOWN',
    http_status: status,
    grpc_status: /^[A-Z_]+$/.test(String(grpcStatusRaw || '').toUpperCase())
      ? String(grpcStatusRaw).toUpperCase()
      : /^[A-Z_]+$/.test(code)
        ? code
        : null,
    provider_error_code: trimOrNull(codeRaw),
    provider_error_message: clampText(err && err.message),
    provider_request_id: getHeaderValue(headers, ['x-request-id', 'x-goog-request-id', 'request-id']),
    provider_trace: getHeaderValue(headers, ['traceparent', 'x-cloud-trace-context', 'x-b3-traceid', 'x-trace-id']),
    timeout_ms: null,
    region: trimOrNull(err && err.region),
    model: trimOrNull(err && err.model),
  };

  if (code === 'GEMINI_TIMEOUT' || message.includes('timeout') || message.includes('deadline exceeded')) {
    return {
      reason: 'TIMEOUT',
      upstream_status_code: null,
      error_evidence: { ...evidenceBase, reason_normalized: 'VISION_TIMEOUT' },
    };
  }
  if (status === 429 || message.includes('rate limit') || message.includes('resource exhausted')) {
    return {
      reason: 'RATE_LIMIT',
      upstream_status_code: 429,
      error_evidence: { ...evidenceBase, reason_normalized: 'VISION_RATE_LIMITED', http_status: 429 },
    };
  }
  if (status && status >= 500) {
    return {
      reason: 'UPSTREAM_5XX',
      upstream_status_code: status,
      error_evidence: { ...evidenceBase, reason_normalized: 'VISION_UPSTREAM_5XX' },
    };
  }
  if (status && status >= 400) {
    return {
      reason: 'UPSTREAM_4XX',
      upstream_status_code: status,
      error_evidence: { ...evidenceBase, reason_normalized: 'VISION_UPSTREAM_4XX' },
    };
  }
  return {
    reason: 'UNKNOWN',
    upstream_status_code: status,
    error_evidence: evidenceBase,
  };
}

function isGeminiModelUnavailableError(err, classified) {
  const c = classified && typeof classified === 'object' ? classified : {};
  if (String(c.reason || '').trim().toUpperCase() !== 'UPSTREAM_4XX') return false;
  const statusCode = Number(c.upstream_status_code);
  if (Number.isFinite(statusCode) && statusCode >= 400 && statusCode < 500 && statusCode !== 400 && statusCode !== 404) {
    return false;
  }

  const message = String(err && err.message ? err.message : '').toLowerCase();
  const code = String(err && (err.code || err.errorCode) ? err.code || err.errorCode : '').toLowerCase();
  const providerCode = String(
    c &&
      c.error_evidence &&
      c.error_evidence.provider_error_code
      ? c.error_evidence.provider_error_code
      : '',
  ).toLowerCase();

  const modelPattern =
    /(model|models\/|generatecontent|generatetext|not found|unsupported|unavailable|unknown|invalid argument|invalid model)/i;
  const versionPattern = /(api version|for api version|publisher model|not available)/i;
  if (modelPattern.test(message) && (message.includes('model') || versionPattern.test(message))) return true;
  if (providerCode && /(not_found|invalid_argument|unsupported|model)/i.test(providerCode)) return true;
  if (code && /(not_found|invalid_argument|unsupported|model)/i.test(code)) return true;
  return false;
}

function validateSkinAnalysisContent(layer, { lang } = {}) {
  const locale = String(lang || '').trim().toLowerCase();
  const isZh = locale === 'cn' || locale === 'zh' || locale === 'zh-cn';

  const banned = isZh
    ? /玫瑰痤疮|湿疹|银屑病|皮炎|感染|真菌|处方|抗生素|激素|治疗|治愈|诊断|品牌|推荐购买/i
    : /rosacea|eczema|psoriasis|dermatitis|infection|fungus|prescription|antibiotic|steroid|treat|cure|diagnos|brand recommendation|buy\s+/i;

  const texts = [];
  if (layer && typeof layer === 'object') {
    if (typeof layer.strategy === 'string') texts.push(layer.strategy);
    if (typeof layer.primary_question === 'string') texts.push(layer.primary_question);
    if (typeof layer.routine_expert === 'string') texts.push(layer.routine_expert);
    if (Array.isArray(layer.conditional_followups)) {
      for (const item of layer.conditional_followups) {
        if (typeof item === 'string') texts.push(item);
      }
    }
  }

  const violations = [];
  for (const text of texts) {
    if (banned.test(text)) violations.push('safety_keyword_violation');
  }
  return {
    ok: violations.length === 0,
    violations,
  };
}

async function callGeminiJson({
  model,
  modelLadder,
  systemInstruction,
  userText,
  imageBuffer,
  responseSchema,
  timeoutMs,
  profiler,
  kind,
} = {}) {
  const client = getGeminiClient();
  if (!client) {
    const requestedModel = String(model || SKIN_VISION_MODEL_GEMINI).trim() || SKIN_VISION_MODEL_GEMINI;
    return {
      ok: false,
      reason: 'MISSING_GEMINI_KEY',
      upstream_status_code: null,
      response_text: '',
      parsed: null,
      latency_ms: 0,
      requested_model: requestedModel,
      resolved_model: null,
      attempted_models: [requestedModel],
      model_fallback_used: false,
      model_fallback_reason: null,
    };
  }

  const startedAt = Date.now();
  const requestedModel = String(model || SKIN_VISION_MODEL_GEMINI).trim() || SKIN_VISION_MODEL_GEMINI;
  const attemptModels = (() => {
    if (Array.isArray(modelLadder) && modelLadder.length) return uniqModels(modelLadder);
    return [requestedModel];
  })();
  const attemptedModels = [];
  let lastFailure = null;

  for (let idx = 0; idx < attemptModels.length; idx += 1) {
    const modelName = attemptModels[idx];
    attemptedModels.push(modelName);
    const request = {
      model: modelName,
      systemInstruction: {
        parts: [{ text: String(systemInstruction || '').trim() }],
      },
      contents: [
        {
          role: 'user',
          parts: [
            ...(Buffer.isBuffer(imageBuffer) && imageBuffer.length
              ? [
                  {
                    inlineData: {
                      mimeType: 'image/jpeg',
                      data: imageBuffer.toString('base64'),
                    },
                  },
                ]
              : []),
            { text: String(userText || '').trim() },
          ],
        },
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: sanitizeGeminiResponseSchema(responseSchema),
        temperature: 0.1,
        topP: 0.8,
        candidateCount: 1,
        maxOutputTokens: 700,
      },
    };

    try {
      const globalGate = getGeminiGlobalGate();
      const invoke = () => globalGate.withGate(kind || 'skin_llm', () =>
        withTimeout(client.models.generateContent(request), timeoutMs || SKIN_LLM_TIMEOUT_MS),
      );
      const resp =
        profiler && typeof profiler.timeLlmCall === 'function'
          ? await profiler.timeLlmCall({ provider: 'gemini', model: modelName, kind }, invoke)
          : await invoke();
      const text = await extractTextFromGeminiResponse(resp);
      const jsonOnly = unwrapCodeFence(text);
      const parsed = parseJsonOnlyObject(jsonOnly);
      return {
        ok: true,
        reason: null,
        upstream_status_code: null,
        response_text: text,
        parsed,
        latency_ms: Date.now() - startedAt,
        requested_model: requestedModel,
        resolved_model: modelName,
        attempted_models: attemptedModels.slice(),
        model_fallback_used: idx > 0,
        model_fallback_reason: idx > 0 ? 'model_unavailable' : null,
      };
    } catch (err) {
      const classified = classifyGeminiError(err);
      if (classified && classified.error_evidence && typeof classified.error_evidence === 'object') {
        classified.error_evidence.timeout_ms = Number.isFinite(Number(timeoutMs))
          ? Math.max(0, Math.trunc(Number(timeoutMs)))
          : SKIN_LLM_TIMEOUT_MS;
        classified.error_evidence.model = modelName;
      }
      const canFallbackModel =
        idx < attemptModels.length - 1 && isGeminiModelUnavailableError(err, classified);
      if (canFallbackModel) {
        lastFailure = {
          reason: classified.reason,
          upstream_status_code: classified.upstream_status_code,
          error_evidence: classified.error_evidence || null,
          model_fallback_reason: 'model_unavailable',
        };
        continue;
      }
      return {
        ok: false,
        reason: classified.reason,
        upstream_status_code: classified.upstream_status_code,
        error_evidence: classified.error_evidence || null,
        response_text: '',
        parsed: null,
        latency_ms: Date.now() - startedAt,
        requested_model: requestedModel,
        resolved_model: null,
        attempted_models: attemptedModels.slice(),
        model_fallback_used: idx > 0,
        model_fallback_reason: idx > 0 ? 'model_unavailable' : null,
      };
    }
  }

  return {
    ok: false,
    reason: lastFailure && lastFailure.reason ? lastFailure.reason : 'UPSTREAM_4XX',
    upstream_status_code: lastFailure ? lastFailure.upstream_status_code : null,
    error_evidence: lastFailure ? lastFailure.error_evidence : null,
    response_text: '',
    parsed: null,
    latency_ms: Date.now() - startedAt,
    requested_model: requestedModel,
    resolved_model: null,
    attempted_models: attemptedModels.slice(),
    model_fallback_used: attemptedModels.length > 1,
    model_fallback_reason: 'model_unavailable',
  };
}

async function runGeminiVisionStrategy({
  imageBuffer,
  visionDto,
  language,
  promptVersion,
  profiler,
  timeoutMs,
} = {}) {
  if (!Buffer.isBuffer(imageBuffer) || !imageBuffer.length) {
    return {
      ok: false,
      provider: 'gemini',
      reason: 'IMAGE_FETCH_FAILED',
      schema_violation: false,
      analysis: null,
      retry: { attempted: 0, final: 'fail', last_reason: 'IMAGE_FETCH_FAILED' },
      upstream_status_code: null,
      latency_ms: 0,
      prompt_version: promptVersion || 'skin_hotfix_v1',
      input_hash: visionDto && visionDto.input_hash ? String(visionDto.input_hash) : null,
    };
  }

  const bundle = buildSkinVisionPromptBundle({ language, dto: visionDto, promptVersion });
  const response = await callGeminiJson({
    model: SKIN_VISION_MODEL_GEMINI,
    modelLadder: SKIN_VISION_MODEL_LADDER,
    systemInstruction: bundle.systemInstruction,
    userText: bundle.userPrompt,
    imageBuffer,
    responseSchema: SkinVisionObservationSchema,
    timeoutMs,
    profiler,
    kind: 'skin_vision_mainline',
  });

  if (!response.ok) {
    return {
      ok: false,
      provider: 'gemini',
      reason: response.reason || 'UNKNOWN',
      schema_violation: false,
      analysis: null,
      retry: { attempted: 0, final: 'fail', last_reason: response.reason || 'UNKNOWN' },
      upstream_status_code: response.upstream_status_code,
      error_evidence: response.error_evidence || null,
      latency_ms: response.latency_ms,
      prompt_version: bundle.promptVersion,
      input_hash: visionDto && visionDto.input_hash ? String(visionDto.input_hash) : null,
      resolved_model: response.resolved_model || null,
      attempted_models: Array.isArray(response.attempted_models) ? response.attempted_models : [SKIN_VISION_MODEL_GEMINI],
      model_fallback_used: Boolean(response.model_fallback_used),
      model_fallback_reason: response.model_fallback_reason || null,
    };
  }

  const validation = validateVisionObservation(response.parsed);
  if (!validation.ok) {
    return {
      ok: false,
      provider: 'gemini',
      reason: 'SCHEMA_INVALID',
      schema_violation: true,
      analysis: null,
      retry: { attempted: 0, final: 'fail', last_reason: 'SCHEMA_INVALID' },
      upstream_status_code: response.upstream_status_code,
      latency_ms: response.latency_ms,
      prompt_version: bundle.promptVersion,
      input_hash: visionDto && visionDto.input_hash ? String(visionDto.input_hash) : null,
      validation_errors: validation.errors,
      resolved_model: response.resolved_model || null,
      attempted_models: Array.isArray(response.attempted_models) ? response.attempted_models : [SKIN_VISION_MODEL_GEMINI],
      model_fallback_used: Boolean(response.model_fallback_used),
      model_fallback_reason: response.model_fallback_reason || null,
    };
  }

  return {
    ok: true,
    provider: 'gemini',
    reason: null,
    schema_violation: false,
    analysis: response.parsed,
    retry: { attempted: 0, final: 'success', last_reason: null },
    upstream_status_code: response.upstream_status_code,
    latency_ms: response.latency_ms,
    prompt_version: bundle.promptVersion,
    input_hash: visionDto && visionDto.input_hash ? String(visionDto.input_hash) : null,
    resolved_model: response.resolved_model || null,
    attempted_models: Array.isArray(response.attempted_models) ? response.attempted_models : [SKIN_VISION_MODEL_GEMINI],
    model_fallback_used: Boolean(response.model_fallback_used),
    model_fallback_reason: response.model_fallback_reason || null,
  };
}

async function runGeminiReportStrategy({
  reportDto,
  language,
  promptVersion,
  profiler,
  timeoutMs,
} = {}) {
  const bundle = buildSkinReportPromptBundle({ language, dto: reportDto, promptVersion });
  let retryAttempted = 0;

  const attempt = async (revisionHint) => {
    const userPrompt = revisionHint ? `${bundle.userPrompt}\n\n${revisionHint}` : bundle.userPrompt;
    return await callGeminiJson({
      model: SKIN_REPORT_MODEL_GEMINI,
      modelLadder: SKIN_REPORT_MODEL_LADDER,
      systemInstruction: bundle.systemInstruction,
      userText: userPrompt,
      imageBuffer: null,
      responseSchema: SkinReportStrategySchema,
      timeoutMs,
      profiler,
      kind: 'skin_report_mainline',
    });
  };

  let first = await attempt('');
  let validation = first.ok ? validateReportStrategy(first.parsed) : { ok: false, errors: [] };
  let safety = first.ok && validation.ok ? validateSkinAnalysisContent(first.parsed, { lang: language }) : { ok: false, violations: [] };

  const needRetry = !first.ok || !validation.ok || !safety.ok;
  if (needRetry) {
    retryAttempted = 1;
    const revisionHint =
      'Revise your previous output to comply with safety rules: remove disease names, prescription drug names, treatment claims, and brand-specific recommendations. Keep the same meaning and be concise.';
    const second = await attempt(revisionHint);
    const secondValidation = second.ok ? validateReportStrategy(second.parsed) : { ok: false, errors: [] };
    const secondSafety = second.ok && secondValidation.ok
      ? validateSkinAnalysisContent(second.parsed, { lang: language })
      : { ok: false, violations: [] };

    if (second.ok && secondValidation.ok && secondSafety.ok) {
      return {
        ok: true,
        provider: 'gemini',
        reason: null,
        schema_violation: false,
        safety_violation: false,
        layer: second.parsed,
        retry: { attempted: 1, final: 'success', last_reason: null },
        upstream_status_code: second.upstream_status_code,
        latency_ms: second.latency_ms,
        prompt_version: bundle.promptVersion,
        input_hash: reportDto && reportDto.input_hash ? String(reportDto.input_hash) : null,
        resolved_model: second.resolved_model || null,
        attempted_models: Array.isArray(second.attempted_models) ? second.attempted_models : [SKIN_REPORT_MODEL_GEMINI],
        model_fallback_used: Boolean(second.model_fallback_used),
        model_fallback_reason: second.model_fallback_reason || null,
      };
    }

    return {
      ok: false,
      provider: 'gemini',
      reason: !second.ok ? second.reason || 'UNKNOWN' : !secondValidation.ok ? 'SCHEMA_INVALID' : 'SAFETY_INVALID',
      schema_violation: Boolean(second.ok && !secondValidation.ok),
      safety_violation: Boolean(second.ok && secondValidation.ok && !secondSafety.ok),
      layer: null,
      retry: {
        attempted: retryAttempted,
        final: 'fail',
        last_reason: !second.ok ? second.reason || 'UNKNOWN' : !secondValidation.ok ? 'SCHEMA_INVALID' : 'SAFETY_INVALID',
      },
      upstream_status_code: second.upstream_status_code,
      error_evidence: second.error_evidence || null,
      latency_ms: second.latency_ms,
      prompt_version: bundle.promptVersion,
      input_hash: reportDto && reportDto.input_hash ? String(reportDto.input_hash) : null,
      validation_errors: secondValidation.errors,
      safety_violations: secondSafety.violations,
      resolved_model: second.resolved_model || null,
      attempted_models: Array.isArray(second.attempted_models) ? second.attempted_models : [SKIN_REPORT_MODEL_GEMINI],
      model_fallback_used: Boolean(second.model_fallback_used),
      model_fallback_reason: second.model_fallback_reason || null,
    };
  }

  return {
    ok: true,
    provider: 'gemini',
    reason: null,
    schema_violation: false,
    safety_violation: false,
    layer: first.parsed,
    retry: { attempted: retryAttempted, final: 'success', last_reason: null },
    upstream_status_code: first.upstream_status_code,
    latency_ms: first.latency_ms,
    prompt_version: bundle.promptVersion,
    input_hash: reportDto && reportDto.input_hash ? String(reportDto.input_hash) : null,
    resolved_model: first.resolved_model || null,
    attempted_models: Array.isArray(first.attempted_models) ? first.attempted_models : [SKIN_REPORT_MODEL_GEMINI],
    model_fallback_used: Boolean(first.model_fallback_used),
    model_fallback_reason: first.model_fallback_reason || null,
  };
}

module.exports = {
  SKIN_MODEL_GEMINI,
  SKIN_VISION_MODEL_GEMINI,
  SKIN_REPORT_MODEL_GEMINI,
  SKIN_VISION_MODEL_LADDER,
  SKIN_REPORT_MODEL_LADDER,
  SKIN_LLM_TIMEOUT_MS,
  isGeminiSkinGatewayAvailable,
  validateSkinAnalysisContent,
  runGeminiVisionStrategy,
  runGeminiReportStrategy,
  sanitizeGeminiResponseSchema,
  classifyGeminiError,
  buildGeminiModelLadder,
  isGeminiModelUnavailableError,
  toStatusCode,
};
