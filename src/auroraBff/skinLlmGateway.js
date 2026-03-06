const { parseJsonOnlyObject } = require('./jsonExtract');
const {
  SkinVisionObservationSchema,
  SkinReportStrategySchema,
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

const GEMINI_API_KEY = resolveAuroraGeminiKey('AURORA_VISION_GEMINI_API_KEY');

const SKIN_MODEL_GEMINI =
  String(process.env.AURORA_SKIN_VISION_MODEL_GEMINI || process.env.GEMINI_MODEL || 'gemini-3-flash-preview').trim() ||
  'gemini-3-flash-preview';

const SKIN_LLM_TIMEOUT_MS = Math.max(2000, Math.min(30000, Number(process.env.AURORA_SKIN_VISION_TIMEOUT_MS || 12000)));

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

function classifyGeminiError(err) {
  if (!err) return { reason: 'UNKNOWN', upstream_status_code: null };
  const code = String(err.code || '').trim().toUpperCase();
  const rawStatus = Number.isFinite(Number(err.status)) ? Math.trunc(Number(err.status)) : null;
  const message = String(err.message || '').toLowerCase();

  // @google/genai 0.7.0 ClientError embeds status in message: "got status: 400 Bad Request. {...}"
  const status = rawStatus || (() => {
    const m = String(err.message || '').match(/got status:\s*(\d{3})/i);
    return m ? parseInt(m[1], 10) : null;
  })();

  if (code === 'GEMINI_TIMEOUT' || message.includes('timeout') || message.includes('deadline exceeded')) {
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

async function callGeminiJson({
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
      maxOutputTokens: 700,
    },
  };

  try {
    const invoke = () => withTimeout(client.models.generateContent(request), timeoutMs || SKIN_LLM_TIMEOUT_MS);
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

  const attempt = async (revisionHint) => {
    const userPrompt = revisionHint ? `${bundle.userPrompt}\n\n${revisionHint}` : bundle.userPrompt;
    return await callGeminiJson({
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
        layer: normalizeReportStrategyLayer(second.parsed, { lang: language }),
        retry: { attempted: 1, final: 'success', last_reason: null },
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
