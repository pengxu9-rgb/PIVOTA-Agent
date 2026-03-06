const { parseJsonOnlyObject } = require('./jsonExtract');
const {
  SkinVisionObservationSchema,
  SkinVisionGatewaySchema,
  SkinReportStrategySchema,
  buildPoorPhotoTemplate,
  validateVisionObservation,
  validateReportStrategy,
  normalizeVisionObservationLayer,
  normalizeReportStrategyLayer,
} = require('./skinAnalysisContract');
const {
  buildSkinVisionPromptBundle,
  buildSkinReportPromptBundle,
} = require('./skinLlmPrompts');
const { resolveAuroraGeminiKey } = require('./auroraGeminiKeys');
const { getGeminiGlobalGate } = require('../lib/geminiGlobalGate');

const GEMINI_API_KEY = resolveAuroraGeminiKey('AURORA_VISION_GEMINI_API_KEY');

const SKIN_MODEL_GEMINI =
  String(process.env.AURORA_SKIN_VISION_MODEL_GEMINI || process.env.GEMINI_MODEL || 'gemini-3-flash-preview').trim() ||
  'gemini-3-flash-preview';

function readTimeoutMs(raw, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(2000, Math.min(45000, Math.trunc(value)));
}

const SKIN_LLM_TIMEOUT_MS = readTimeoutMs(process.env.AURORA_SKIN_VISION_TIMEOUT_MS, 12000);

function readOutputTokenBudget(envName, fallback) {
  const raw = Number(process.env[envName]);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.max(256, Math.min(8192, Math.trunc(raw)));
}

const SKIN_VISION_MAX_OUTPUT_TOKENS = readOutputTokenBudget('AURORA_SKIN_VISION_MAX_OUTPUT_TOKENS', 1800);
const SKIN_REPORT_MAX_OUTPUT_TOKENS = readOutputTokenBudget('AURORA_SKIN_REPORT_MAX_OUTPUT_TOKENS', 5000);

function inferStructuredTimeoutMs(maxOutputTokens) {
  const budget = readOutputTokenBudget('AURORA_SKIN_MAX_OUTPUT_TOKENS', Number(maxOutputTokens) || 700);
  if (budget >= 4000) return Math.max(SKIN_LLM_TIMEOUT_MS, 30000);
  if (budget >= 3000) return Math.max(SKIN_LLM_TIMEOUT_MS, 25000);
  if (budget >= 1400) return Math.max(SKIN_LLM_TIMEOUT_MS, 15000);
  return SKIN_LLM_TIMEOUT_MS;
}

let geminiClient = null;
let geminiInitFailed = false;

function isGeminiSkinGatewayAvailable() {
  return Boolean(GEMINI_API_KEY);
}

function getGeminiClient() {
  if (!GEMINI_API_KEY) return null;
  if (geminiClient) return geminiClient;
  if (geminiInitFailed) return null;
  try {
    const { GoogleGenAI } = require('@google/genai');
    geminiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    return geminiClient;
  } catch (_err) {
    geminiInitFailed = true;
    return null;
  }
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

function classifyGeminiError(err) {
  if (!err) return { reason: 'UNKNOWN', upstream_status_code: null };
  const code = String(err.code || '').trim().toUpperCase();
  const name = String(err.name || '').trim().toUpperCase();
  const rawStatus = Number.isFinite(Number(err.status)) ? Math.trunc(Number(err.status)) : null;
  const message = String(err.message || '').toLowerCase();

  // @google/genai 0.7.0 ClientError embeds HTTP status in message text.
  const status = rawStatus || (() => {
    const m = String(err.message || '').match(/got status:\s*(\d{3})/i);
    return m ? parseInt(m[1], 10) : null;
  })();

  if (
    code === 'GEMINI_TIMEOUT' ||
    code.includes('TIMEOUT') ||
    code.includes('ABORT') ||
    name === 'ABORTERROR' ||
    message.includes('timeout') ||
    message.includes('deadline exceeded') ||
    message.includes('aborted')
  ) {
    return { reason: 'TIMEOUT', upstream_status_code: null };
  }
  if (status === 429 || message.includes('rate limit') || message.includes('resource exhausted')) {
    return { reason: 'RATE_LIMIT', upstream_status_code: 429 };
  }
  if (status && status >= 500) {
    return { reason: 'UPSTREAM_5XX', upstream_status_code: status };
  }
  if (status && status >= 400) {
    return { reason: 'UPSTREAM_4XX', upstream_status_code: status };
  }
  return { reason: 'UNKNOWN', upstream_status_code: status };
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
    if (layer.routine_expert && typeof layer.routine_expert === 'object' && !Array.isArray(layer.routine_expert)) {
      try {
        texts.push(JSON.stringify(layer.routine_expert));
      } catch {
        // noop
      }
    }
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

function shouldUseLimitedSignalReportFallback(reportDto) {
  return Boolean(reportDto && reportDto.insufficient_visual_detail);
}

function buildLimitedSignalReportLayer(reportDto, { lang } = {}) {
  const fallback = buildPoorPhotoTemplate({ lang });
  const quality = reportDto && reportDto.quality && typeof reportDto.quality === 'object' && !Array.isArray(reportDto.quality)
    ? reportDto.quality
    : null;
  return normalizeReportStrategyLayer(
    {
      ...fallback,
      ...(quality ? { quality } : {}),
      insufficient_visual_detail: true,
    },
    { lang },
  );
}

function buildConservativeReportFallbackLayer(reportDto, { lang } = {}) {
  const locale = String(lang || '').trim().toLowerCase();
  const isZh = locale === 'cn' || locale === 'zh' || locale === 'zh-cn';
  const quality = reportDto && reportDto.quality && typeof reportDto.quality === 'object' && !Array.isArray(reportDto.quality)
    ? reportDto.quality
    : null;
  const base = isZh
    ? {
        strategy:
          '当前图像信号需要保守处理 -> 注意事项：先不要一次叠加多种强活性 -> 修复路径：维持温和清洁、保湿、防晒三步 7 天，再逐项观察变化 -> 下一问：你现在最困扰的是紧绷、泛红还是出油？',
        needs_risk_check: false,
        primary_question: '你现在最困扰的是紧绷、泛红还是出油？',
        conditional_followups: ['洁面后会刺痛或紧绷吗？', 'T 区到中午会明显出油吗？', '近期是否新加了酸类或维A类？'],
        routine_expert: '',
        guidance_brief: ['先维持基础护理 7 天。', '不要同时新增多个强活性。', '如出现持续刺激，立即回退到清洁+保湿+防晒。'],
        two_week_focus: ['稳定屏障', '记录刺激触发因素', '观察出油与泛红波动'],
      }
    : {
        strategy:
          'Current signal should be handled conservatively -> Watchouts: do not stack multiple strong actives at once -> Repair path: keep a gentle cleanse, moisturizer, and sunscreen baseline for 7 days, then reintroduce changes one at a time -> Next question: what feels most uncomfortable right now, tightness, redness, or oiliness?',
        needs_risk_check: false,
        primary_question: 'What feels most uncomfortable right now: tightness, redness, or oiliness?',
        conditional_followups: ['Do you feel stinging or tightness after cleansing?', 'Does your T-zone become oily by midday?', 'Have you recently added acids or retinoids?'],
        routine_expert: '',
        guidance_brief: [
          'Keep a basic cleanse-moisturize-sunscreen routine for 7 days.',
          'Do not introduce multiple strong actives at the same time.',
          'If irritation persists, step back to cleanse, moisturizer, and sunscreen only.',
        ],
        two_week_focus: ['Stabilize the barrier', 'Track trigger patterns', 'Monitor redness and oil fluctuation'],
      };

  return normalizeReportStrategyLayer(
    {
      ...base,
      ...(quality ? { quality } : {}),
    },
    { lang },
  );
}

async function callGeminiJson({
  systemInstruction,
  userText,
  imageBuffer,
  responseSchema,
  maxOutputTokens,
  timeoutMs,
  profiler,
  kind,
} = {}) {
  const client = getGeminiClient();
  if (!client) {
    return {
      ok: false,
      reason: 'MISSING_GEMINI_KEY',
      upstream_status_code: null,
      response_text: '',
      parsed: null,
      latency_ms: 0,
    };
  }

  const startedAt = Date.now();
  const resolvedOutputTokens = readOutputTokenBudget(
    'AURORA_SKIN_MAX_OUTPUT_TOKENS',
    Number.isFinite(Number(maxOutputTokens)) ? Number(maxOutputTokens) : 700,
  );
  const resolvedTimeoutMs = Math.max(
    readTimeoutMs(timeoutMs, SKIN_LLM_TIMEOUT_MS),
    inferStructuredTimeoutMs(resolvedOutputTokens),
  );
  const request = {
    model: SKIN_MODEL_GEMINI,
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
      responseSchema,
      temperature: 0.1,
      topP: 0.8,
      candidateCount: 1,
      maxOutputTokens: resolvedOutputTokens,
      httpOptions: { timeout: resolvedTimeoutMs },
    },
  };

  try {
    const gate = getGeminiGlobalGate();
    const gateRoute = kind || 'skin_vision';
    const invoke = () => gate.withGate(gateRoute, () => client.models.generateContent(request));
    const resp =
      profiler && typeof profiler.timeLlmCall === 'function'
        ? await profiler.timeLlmCall({ provider: 'gemini', model: SKIN_MODEL_GEMINI, kind }, invoke)
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
    };
  } catch (err) {
    if (err && err.name === 'GeminiGateError') {
      return {
        ok: false,
        reason: String(err.code || 'GATE_ERROR'),
        upstream_status_code: null,
        response_text: '',
        parsed: null,
        latency_ms: Date.now() - startedAt,
      };
    }
    const classified = classifyGeminiError(err);
    return {
      ok: false,
      reason: classified.reason,
      upstream_status_code: classified.upstream_status_code,
      response_text: '',
      parsed: null,
      latency_ms: Date.now() - startedAt,
      error: String(err.message || '').slice(0, 500),
    };
  }
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
    systemInstruction: bundle.systemInstruction,
    userText: bundle.userPrompt,
    imageBuffer,
    responseSchema: SkinVisionGatewaySchema,
    maxOutputTokens: SKIN_VISION_MAX_OUTPUT_TOKENS,
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
      latency_ms: response.latency_ms,
      prompt_version: bundle.promptVersion,
      input_hash: visionDto && visionDto.input_hash ? String(visionDto.input_hash) : null,
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
    };
  }

  return {
    ok: true,
    provider: 'gemini',
    reason: null,
    schema_violation: false,
    analysis: normalizeVisionObservationLayer(response.parsed),
    retry: { attempted: 0, final: 'success', last_reason: null },
    upstream_status_code: response.upstream_status_code,
    latency_ms: response.latency_ms,
    prompt_version: bundle.promptVersion,
    input_hash: visionDto && visionDto.input_hash ? String(visionDto.input_hash) : null,
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

  if (shouldUseLimitedSignalReportFallback(reportDto)) {
    return {
      ok: true,
      provider: 'gemini',
      reason: null,
      schema_violation: false,
      safety_violation: false,
      layer: buildLimitedSignalReportLayer(reportDto, { lang: language }),
      retry: { attempted: 0, final: 'success', last_reason: null },
      upstream_status_code: null,
      latency_ms: 0,
      prompt_version: bundle.promptVersion,
      input_hash: reportDto && reportDto.input_hash ? String(reportDto.input_hash) : null,
    };
  }

  const attempt = async (revisionHint) => {
    const userPrompt = revisionHint ? `${bundle.userPrompt}\n\n${revisionHint}` : bundle.userPrompt;
    return await callGeminiJson({
      systemInstruction: bundle.systemInstruction,
      userText: userPrompt,
      imageBuffer: null,
      responseSchema: SkinReportStrategySchema,
      maxOutputTokens: SKIN_REPORT_MAX_OUTPUT_TOKENS,
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
        layer: normalizeReportStrategyLayer(second.parsed, { lang: language }),
        retry: { attempted: 1, final: 'success', last_reason: null },
        upstream_status_code: second.upstream_status_code,
        latency_ms: second.latency_ms,
        prompt_version: bundle.promptVersion,
        input_hash: reportDto && reportDto.input_hash ? String(reportDto.input_hash) : null,
      };
    }

    if (second.ok && (!secondValidation.ok || !secondSafety.ok)) {
      return {
        ok: true,
        provider: 'gemini',
        reason: null,
        schema_violation: false,
        safety_violation: false,
        layer: buildConservativeReportFallbackLayer(reportDto, { lang: language }),
        retry: { attempted: retryAttempted, final: 'success', last_reason: null },
        upstream_status_code: second.upstream_status_code,
        latency_ms: second.latency_ms,
        prompt_version: bundle.promptVersion,
        input_hash: reportDto && reportDto.input_hash ? String(reportDto.input_hash) : null,
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
      latency_ms: second.latency_ms,
      prompt_version: bundle.promptVersion,
      input_hash: reportDto && reportDto.input_hash ? String(reportDto.input_hash) : null,
      validation_errors: secondValidation.errors,
      safety_violations: secondSafety.violations,
    };
  }

  return {
    ok: true,
    provider: 'gemini',
    reason: null,
    schema_violation: false,
    safety_violation: false,
    layer: normalizeReportStrategyLayer(first.parsed, { lang: language }),
    retry: { attempted: retryAttempted, final: 'success', last_reason: null },
    upstream_status_code: first.upstream_status_code,
    latency_ms: first.latency_ms,
    prompt_version: bundle.promptVersion,
    input_hash: reportDto && reportDto.input_hash ? String(reportDto.input_hash) : null,
  };
}

module.exports = {
  SKIN_MODEL_GEMINI,
  SKIN_LLM_TIMEOUT_MS,
  classifyGeminiError,
  isGeminiSkinGatewayAvailable,
  validateSkinAnalysisContent,
  runGeminiVisionStrategy,
  runGeminiReportStrategy,
};
