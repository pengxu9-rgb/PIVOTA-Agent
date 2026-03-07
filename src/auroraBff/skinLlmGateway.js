const { parseJsonOnlyObject } = require('./jsonExtract');
const {
  SkinVisionObservationSchema,
  SkinVisionGatewaySchema,
  SkinVisionCanonicalSchema,
  SkinReportStrategySchema,
  SkinReportCanonicalSchema,
  SkinDeepeningCanonicalSchema,
  buildPoorPhotoTemplate,
  validateVisionObservation,
  validateVisionCanonicalLayer,
  validateReportStrategy,
  validateReportCanonicalLayer,
  validateDeepeningCanonicalLayer,
  normalizeVisionObservationLayer,
  normalizeVisionCanonicalLayer,
  normalizeReportStrategyLayer,
  normalizeReportCanonicalLayer,
  normalizeDeepeningCanonicalLayer,
  renderVisionCanonicalLayer,
  renderReportCanonicalLayer,
  renderDeepeningCanonicalLayer,
  evaluateVisionCanonicalSemantic,
  evaluateReportCanonicalSemantic,
  evaluateDeepeningCanonicalSemantic,
} = require('./skinAnalysisContract');
const {
  buildSkinVisionPromptBundle,
  buildSkinReportPromptBundle,
  buildSkinDeepeningPromptBundle,
  isSkinPromptV3,
  isSkinDeepeningV2,
} = require('./skinLlmPrompts');
const { resolveAuroraGeminiKey } = require('./auroraGeminiKeys');
const { getGeminiGlobalGate, GeminiGateError } = require('../lib/geminiGlobalGate');

const FALLBACK_GEMINI_API_KEY = resolveAuroraGeminiKey('AURORA_VISION_GEMINI_API_KEY');

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

const geminiClientsByKey = new Map();
let geminiInitFailed = false;

function isGeminiSkinGatewayAvailable() {
  try {
    const gate = getGeminiGlobalGate();
    const snapshot = gate && typeof gate.snapshot === 'function' ? gate.snapshot() : null;
    const keyCount = Number(snapshot && snapshot.gate && snapshot.gate.keyCount);
    if (Number.isFinite(keyCount) && keyCount > 0) return true;
  } catch {
    // noop
  }
  return Boolean(FALLBACK_GEMINI_API_KEY);
}

function pickGeminiApiKey() {
  try {
    const gate = getGeminiGlobalGate();
    const pooledKey = gate && typeof gate.getApiKey === 'function' ? gate.getApiKey() : null;
    if (typeof pooledKey === 'string' && pooledKey.trim()) return pooledKey.trim();
  } catch {
    // noop
  }
  return FALLBACK_GEMINI_API_KEY;
}

function getGeminiClient(apiKey) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) return null;
  if (geminiClientsByKey.has(key)) return geminiClientsByKey.get(key);
  if (geminiInitFailed) return null;
  try {
    const { GoogleGenAI } = require('@google/genai');
    const client = new GoogleGenAI({ apiKey: key });
    geminiClientsByKey.set(key, client);
    return client;
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
  if (code === 'GLOBAL_RATE_LIMITED' || code === 'RATE_LIMITED') {
    return { reason: 'RATE_LIMIT', upstream_status_code: 429 };
  }
  if (code === 'CIRCUIT_OPEN') {
    return { reason: 'UPSTREAM_5XX', upstream_status_code: 503 };
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

function buildSemanticRevisionHint({ stage, issues } = {}) {
  const list = Array.isArray(issues) ? issues.map((item) => String(item || '').trim()).filter(Boolean) : [];
  if (stage === 'vision') {
    return [
      'Revise your previous output.',
      'Fix the following issues:',
      list.map((item) => `- ${item}`).join('\n'),
      'Do not invent cues.',
      'If the image is insufficient, set visibility_status=insufficient with insufficient_reason.',
      'If the image is not insufficient on pass-quality input, return at least 2 distinct grounded observations.',
    ].filter(Boolean).join('\n');
  }
  if (stage === 'report') {
    return [
      'Revise your previous output.',
      'Fix the following issues:',
      list.map((item) => `- ${item}`).join('\n'),
      'Every routine step must be grounded in linked_cues.',
      'Keep the plan conservative, structured, and free of user-facing prose.',
    ].filter(Boolean).join('\n');
  }
  return [
    'Revise your previous output.',
    'Fix the following issues:',
    list.map((item) => `- ${item}`).join('\n'),
    'Keep the output fully structured and renderable.',
  ].filter(Boolean).join('\n');
}

function buildVisionAttemptBundle({ language, visionDto, promptVersion, revisionHint } = {}) {
  const bundle = buildSkinVisionPromptBundle({ language, dto: visionDto, promptVersion });
  return {
    bundle,
    userPrompt: revisionHint ? `${bundle.userPrompt}\n\n${revisionHint}` : bundle.userPrompt,
  };
}

function buildReportAttemptBundle({ language, reportDto, promptVersion, revisionHint, lifecycleInstructions } = {}) {
  const bundle = buildSkinReportPromptBundle({
    language,
    dto: reportDto,
    promptVersion,
    lifecycleInstructions,
  });
  return {
    bundle,
    userPrompt: revisionHint ? `${bundle.userPrompt}\n\n${revisionHint}` : bundle.userPrompt,
  };
}

function buildDeepeningAttemptBundle({ language, deepeningDto, promptVersion, revisionHint } = {}) {
  const bundle = buildSkinDeepeningPromptBundle({ language, dto: deepeningDto, promptVersion });
  return {
    bundle,
    userPrompt: revisionHint ? `${bundle.userPrompt}\n\n${revisionHint}` : bundle.userPrompt,
  };
}

async function callGeminiJson({
  systemInstruction,
  userText,
  imageBuffer,
  imageMimeType,
  responseSchema,
  maxOutputTokens,
  timeoutMs,
  profiler,
  kind,
} = {}) {
  const apiKey = pickGeminiApiKey();
  const client = getGeminiClient(apiKey);
  if (!client || !apiKey) {
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
                    mimeType: typeof imageMimeType === 'string' && imageMimeType.trim() ? imageMimeType.trim() : 'image/jpeg',
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
    const globalGate = getGeminiGlobalGate();
    const effectiveTimeoutMs = Math.max(
      readTimeoutMs(timeoutMs, SKIN_LLM_TIMEOUT_MS),
      inferStructuredTimeoutMs(request.config && request.config.maxOutputTokens),
    );
    const invoke = () =>
      withTimeout(
        globalGate.withGate(kind || 'aurora_skin_llm', async () => client.models.generateContent(request)),
        effectiveTimeoutMs,
      );
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
      error: err instanceof GeminiGateError ? `${err.code}:${String(err.message || '').slice(0, 460)}` : String(err.message || '').slice(0, 500),
    };
  }
}

async function runGeminiVisionStrategy({
  imageBuffer,
  imageMimeType,
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

  const isCanonical = isSkinPromptV3(promptVersion);
  const attemptVision = async (revisionHint) => {
    const { bundle, userPrompt } = buildVisionAttemptBundle({ language, visionDto, promptVersion, revisionHint });
    const response = await callGeminiJson({
      systemInstruction: bundle.systemInstruction,
      userText: userPrompt,
      imageBuffer,
      imageMimeType,
      responseSchema: isCanonical ? SkinVisionCanonicalSchema : SkinVisionGatewaySchema,
      maxOutputTokens: SKIN_VISION_MAX_OUTPUT_TOKENS,
      timeoutMs,
      profiler,
      kind: 'skin_vision_mainline',
    });
    return { bundle, response };
  };

  const firstAttempt = await attemptVision('');
  if (!firstAttempt.response.ok) {
    return {
      ok: false,
      provider: 'gemini',
      reason: firstAttempt.response.reason || 'UNKNOWN',
      schema_violation: false,
      semantic_violation: false,
      analysis: null,
      retry: { attempted: 0, final: 'fail', last_reason: firstAttempt.response.reason || 'UNKNOWN' },
      upstream_status_code: firstAttempt.response.upstream_status_code,
      latency_ms: firstAttempt.response.latency_ms,
      prompt_version: firstAttempt.bundle.promptVersion,
      input_hash: visionDto && visionDto.input_hash ? String(visionDto.input_hash) : null,
    };
  }

  if (isCanonical) {
    const canonical = normalizeVisionCanonicalLayer(firstAttempt.response.parsed);
    const validation = validateVisionCanonicalLayer(canonical);
    const semantic = validation.ok ? evaluateVisionCanonicalSemantic(canonical, { quality: visionDto && visionDto.quality }) : { ok: false, code: 'SCHEMA_INVALID', issues: validation.errors || [] };
    if (validation.ok && semantic.ok) {
      const rendered = renderVisionCanonicalLayer(canonical, { lang: language });
      const publicValidation = validateVisionObservation(rendered);
      if (!publicValidation.ok) {
        return {
          ok: false,
          provider: 'gemini',
          reason: 'SCHEMA_INVALID',
          schema_violation: true,
          semantic_violation: false,
          analysis: null,
          retry: { attempted: 0, final: 'fail', last_reason: 'SCHEMA_INVALID' },
          upstream_status_code: firstAttempt.response.upstream_status_code,
          latency_ms: firstAttempt.response.latency_ms,
          prompt_version: firstAttempt.bundle.promptVersion,
          input_hash: visionDto && visionDto.input_hash ? String(visionDto.input_hash) : null,
          validation_errors: publicValidation.errors,
        };
      }
      return {
        ok: true,
        provider: 'gemini',
        reason: null,
        schema_violation: false,
        semantic_violation: false,
        analysis: rendered,
        canonical,
        semantic,
        raw_response_text: firstAttempt.response.response_text,
        retry: { attempted: 0, final: 'success', last_reason: null },
        upstream_status_code: firstAttempt.response.upstream_status_code,
        latency_ms: firstAttempt.response.latency_ms,
        prompt_version: firstAttempt.bundle.promptVersion,
        input_hash: visionDto && visionDto.input_hash ? String(visionDto.input_hash) : null,
      };
    }

    const revisionHint = buildSemanticRevisionHint({
      stage: 'vision',
      issues: validation.ok ? semantic.issues : validation.errors,
    });
    const secondAttempt = await attemptVision(revisionHint);
    if (!secondAttempt.response.ok) {
      return {
        ok: false,
        provider: 'gemini',
        reason: secondAttempt.response.reason || 'UNKNOWN',
        schema_violation: false,
        semantic_violation: false,
        analysis: null,
        retry: { attempted: 1, final: 'fail', last_reason: secondAttempt.response.reason || 'UNKNOWN' },
        upstream_status_code: secondAttempt.response.upstream_status_code,
        latency_ms: secondAttempt.response.latency_ms,
        prompt_version: secondAttempt.bundle.promptVersion,
        input_hash: visionDto && visionDto.input_hash ? String(visionDto.input_hash) : null,
      };
    }
    const revisedCanonical = normalizeVisionCanonicalLayer(secondAttempt.response.parsed);
    const revisedValidation = validateVisionCanonicalLayer(revisedCanonical);
    const revisedSemantic = revisedValidation.ok
      ? evaluateVisionCanonicalSemantic(revisedCanonical, { quality: visionDto && visionDto.quality })
      : { ok: false, code: 'SCHEMA_INVALID', issues: revisedValidation.errors || [] };
    if (!revisedValidation.ok || !revisedSemantic.ok) {
      return {
        ok: false,
        provider: 'gemini',
        reason: !revisedValidation.ok ? 'SCHEMA_INVALID' : revisedSemantic.code || 'SEMANTIC_INVALID',
        schema_violation: !revisedValidation.ok,
        semantic_violation: Boolean(revisedValidation.ok && !revisedSemantic.ok),
        analysis: null,
        canonical: revisedCanonical,
        semantic: revisedSemantic,
        raw_response_text: secondAttempt.response.response_text,
        retry: {
          attempted: 1,
          final: 'fail',
          last_reason: !revisedValidation.ok ? 'SCHEMA_INVALID' : revisedSemantic.code || 'SEMANTIC_INVALID',
        },
        upstream_status_code: secondAttempt.response.upstream_status_code,
        latency_ms: secondAttempt.response.latency_ms,
        prompt_version: secondAttempt.bundle.promptVersion,
        input_hash: visionDto && visionDto.input_hash ? String(visionDto.input_hash) : null,
        validation_errors: !revisedValidation.ok ? revisedValidation.errors : undefined,
        semantic_issues: revisedSemantic.issues,
      };
    }
    const revisedRendered = renderVisionCanonicalLayer(revisedCanonical, { lang: language });
    const revisedPublicValidation = validateVisionObservation(revisedRendered);
    if (!revisedPublicValidation.ok) {
      return {
        ok: false,
        provider: 'gemini',
        reason: 'SCHEMA_INVALID',
        schema_violation: true,
        semantic_violation: false,
        analysis: null,
        retry: { attempted: 1, final: 'fail', last_reason: 'SCHEMA_INVALID' },
        upstream_status_code: secondAttempt.response.upstream_status_code,
        latency_ms: secondAttempt.response.latency_ms,
        prompt_version: secondAttempt.bundle.promptVersion,
        input_hash: visionDto && visionDto.input_hash ? String(visionDto.input_hash) : null,
        validation_errors: revisedPublicValidation.errors,
      };
    }
    return {
      ok: true,
      provider: 'gemini',
      reason: null,
      schema_violation: false,
      semantic_violation: false,
      analysis: revisedRendered,
      canonical: revisedCanonical,
      semantic: revisedSemantic,
      raw_response_text: secondAttempt.response.response_text,
      retry: { attempted: 1, final: 'success', last_reason: null },
      upstream_status_code: secondAttempt.response.upstream_status_code,
      latency_ms: secondAttempt.response.latency_ms,
      prompt_version: secondAttempt.bundle.promptVersion,
      input_hash: visionDto && visionDto.input_hash ? String(visionDto.input_hash) : null,
    };
  }

  const normalizedLayer = normalizeVisionObservationLayer(firstAttempt.response.parsed);
  const validation = validateVisionObservation(normalizedLayer);
  if (!validation.ok) {
    return {
      ok: false,
      provider: 'gemini',
      reason: 'SCHEMA_INVALID',
      schema_violation: true,
      semantic_violation: false,
      analysis: null,
      retry: { attempted: 0, final: 'fail', last_reason: 'SCHEMA_INVALID' },
      upstream_status_code: firstAttempt.response.upstream_status_code,
      latency_ms: firstAttempt.response.latency_ms,
      prompt_version: firstAttempt.bundle.promptVersion,
      input_hash: visionDto && visionDto.input_hash ? String(visionDto.input_hash) : null,
      validation_errors: validation.errors,
    };
  }
  return {
    ok: true,
    provider: 'gemini',
    reason: null,
    schema_violation: false,
    semantic_violation: false,
    analysis: normalizedLayer,
    raw_response_text: firstAttempt.response.response_text,
    retry: { attempted: 0, final: 'success', last_reason: null },
    upstream_status_code: firstAttempt.response.upstream_status_code,
    latency_ms: firstAttempt.response.latency_ms,
    prompt_version: firstAttempt.bundle.promptVersion,
    input_hash: visionDto && visionDto.input_hash ? String(visionDto.input_hash) : null,
  };
}

async function runGeminiReportStrategy({
  reportDto,
  language,
  promptVersion,
  profiler,
  timeoutMs,
  lifecycleInstructions,
} = {}) {
  const bundle = buildSkinReportPromptBundle({
    language,
    dto: reportDto,
    promptVersion,
    lifecycleInstructions,
  });
  const isCanonical = isSkinPromptV3(promptVersion);
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
    const promptBundle = isCanonical
      ? buildReportAttemptBundle({
          language,
          reportDto,
          promptVersion,
          revisionHint,
          lifecycleInstructions,
        })
      : { bundle, userPrompt: revisionHint ? `${bundle.userPrompt}\n\n${revisionHint}` : bundle.userPrompt };
    return await callGeminiJson({
      systemInstruction: promptBundle.bundle.systemInstruction,
      userText: promptBundle.userPrompt,
      imageBuffer: null,
      responseSchema: isCanonical ? SkinReportCanonicalSchema : SkinReportStrategySchema,
      maxOutputTokens: SKIN_REPORT_MAX_OUTPUT_TOKENS,
      timeoutMs,
      profiler,
      kind: 'skin_report_mainline',
    });
  };

  let first = await attempt('');
  let validation = first.ok
    ? (isCanonical ? validateReportCanonicalLayer(normalizeReportCanonicalLayer(first.parsed)) : validateReportStrategy(first.parsed))
    : { ok: false, errors: [] };
  let semantic = first.ok && validation.ok && isCanonical
    ? evaluateReportCanonicalSemantic(normalizeReportCanonicalLayer(first.parsed))
    : { ok: true, issues: [] };
  let safety = first.ok && validation.ok && (!isCanonical || semantic.ok)
    ? validateSkinAnalysisContent(
        isCanonical
          ? renderReportCanonicalLayer(normalizeReportCanonicalLayer(first.parsed), {
              lang: language,
              quality: reportDto && reportDto.quality,
            })
          : first.parsed,
        { lang: language },
      )
    : { ok: false, violations: [] };

  const needRetry = !first.ok || !validation.ok || !semantic.ok || !safety.ok;
  if (needRetry) {
    retryAttempted = 1;
    const revisionHint = !validation.ok || !semantic.ok
      ? buildSemanticRevisionHint({
          stage: 'report',
          issues: !validation.ok ? validation.errors : semantic.issues,
        })
      : 'Revise your previous output to comply with safety rules: remove disease names, prescription drug names, treatment claims, and brand-specific recommendations. Keep the same meaning and be concise.';
    const second = await attempt(revisionHint);
    const secondCanonical = second.ok && isCanonical ? normalizeReportCanonicalLayer(second.parsed) : null;
    const secondValidation = second.ok
      ? (isCanonical ? validateReportCanonicalLayer(secondCanonical) : validateReportStrategy(second.parsed))
      : { ok: false, errors: [] };
    const secondSemantic = second.ok && secondValidation.ok && isCanonical
      ? evaluateReportCanonicalSemantic(secondCanonical)
      : { ok: true, issues: [] };
    const secondRendered = second.ok && secondValidation.ok && isCanonical
      ? renderReportCanonicalLayer(secondCanonical, { lang: language, quality: reportDto && reportDto.quality })
      : null;
    const secondSafety = second.ok && secondValidation.ok && (!isCanonical || secondSemantic.ok)
      ? validateSkinAnalysisContent(isCanonical ? secondRendered : second.parsed, { lang: language })
      : { ok: false, violations: [] };

    if (second.ok && secondValidation.ok && secondSemantic.ok && secondSafety.ok) {
      return {
        ok: true,
        provider: 'gemini',
        reason: null,
        schema_violation: false,
        safety_violation: false,
        semantic_violation: false,
        layer: isCanonical ? secondRendered : normalizeReportStrategyLayer(second.parsed, { lang: language }),
        canonical: secondCanonical,
        semantic: secondSemantic,
        raw_response_text: second.response_text,
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
      reason: !second.ok
        ? second.reason || 'UNKNOWN'
        : !secondValidation.ok
          ? 'SCHEMA_INVALID'
          : !secondSemantic.ok
            ? secondSemantic.code || 'SEMANTIC_INVALID'
            : 'SAFETY_INVALID',
      schema_violation: Boolean(second.ok && !secondValidation.ok),
      semantic_violation: Boolean(second.ok && secondValidation.ok && !secondSemantic.ok),
      safety_violation: Boolean(second.ok && secondValidation.ok && secondSemantic.ok && !secondSafety.ok),
      layer: null,
      canonical: secondCanonical,
      semantic: secondSemantic,
      raw_response_text: second.response_text,
      retry: {
        attempted: retryAttempted,
        final: 'fail',
        last_reason: !second.ok
          ? second.reason || 'UNKNOWN'
          : !secondValidation.ok
            ? 'SCHEMA_INVALID'
            : !secondSemantic.ok
              ? secondSemantic.code || 'SEMANTIC_INVALID'
              : 'SAFETY_INVALID',
      },
      upstream_status_code: second.upstream_status_code,
      latency_ms: second.latency_ms,
      prompt_version: bundle.promptVersion,
      input_hash: reportDto && reportDto.input_hash ? String(reportDto.input_hash) : null,
      validation_errors: secondValidation.errors,
      semantic_issues: secondSemantic.issues,
      safety_violations: secondSafety.violations,
    };
  }

  return {
    ok: true,
    provider: 'gemini',
    reason: null,
    schema_violation: false,
    safety_violation: false,
    semantic_violation: false,
    layer: isCanonical
      ? renderReportCanonicalLayer(normalizeReportCanonicalLayer(first.parsed), { lang: language, quality: reportDto && reportDto.quality })
      : normalizeReportStrategyLayer(first.parsed, { lang: language }),
    canonical: isCanonical ? normalizeReportCanonicalLayer(first.parsed) : null,
    semantic,
    raw_response_text: first.response_text,
    retry: { attempted: retryAttempted, final: 'success', last_reason: null },
    upstream_status_code: first.upstream_status_code,
    latency_ms: first.latency_ms,
    prompt_version: bundle.promptVersion,
    input_hash: reportDto && reportDto.input_hash ? String(reportDto.input_hash) : null,
  };
}

async function runGeminiDeepeningStrategy({
  deepeningDto,
  language,
  promptVersion,
  profiler,
  timeoutMs,
} = {}) {
  const isCanonical = isSkinDeepeningV2(promptVersion);
  const attempt = async (revisionHint) => {
    const { bundle, userPrompt } = buildDeepeningAttemptBundle({ language, deepeningDto, promptVersion, revisionHint });
    const response = await callGeminiJson({
      systemInstruction: bundle.systemInstruction,
      userText: userPrompt,
      imageBuffer: null,
      responseSchema: SkinDeepeningCanonicalSchema,
      maxOutputTokens: 1200,
      timeoutMs,
      profiler,
      kind: 'skin_deepening_mainline',
    });
    return { bundle, response };
  };

  if (!isCanonical) {
    return {
      ok: false,
      provider: 'gemini',
      reason: 'UNSUPPORTED_PROMPT_VERSION',
      schema_violation: false,
      semantic_violation: false,
      layer: null,
      retry: { attempted: 0, final: 'fail', last_reason: 'UNSUPPORTED_PROMPT_VERSION' },
      upstream_status_code: null,
      latency_ms: 0,
      prompt_version: promptVersion || 'skin_deepening_v1',
      input_hash: deepeningDto && deepeningDto.input_hash ? String(deepeningDto.input_hash) : null,
    };
  }

  const first = await attempt('');
  if (!first.response.ok) {
    return {
      ok: false,
      provider: 'gemini',
      reason: first.response.reason || 'UNKNOWN',
      schema_violation: false,
      semantic_violation: false,
      layer: null,
      retry: { attempted: 0, final: 'fail', last_reason: first.response.reason || 'UNKNOWN' },
      upstream_status_code: first.response.upstream_status_code,
      latency_ms: first.response.latency_ms,
      prompt_version: first.bundle.promptVersion,
      input_hash: deepeningDto && deepeningDto.input_hash ? String(deepeningDto.input_hash) : null,
    };
  }
  const canonical = normalizeDeepeningCanonicalLayer(first.response.parsed);
  const validation = validateDeepeningCanonicalLayer(canonical);
  const semantic = validation.ok ? evaluateDeepeningCanonicalSemantic(canonical) : { ok: false, code: 'SCHEMA_INVALID', issues: validation.errors || [] };
  if (validation.ok && semantic.ok) {
    return {
      ok: true,
      provider: 'gemini',
      reason: null,
      schema_violation: false,
      semantic_violation: false,
      layer: renderDeepeningCanonicalLayer(canonical, { lang: language }),
      canonical,
      semantic,
      raw_response_text: first.response.response_text,
      retry: { attempted: 0, final: 'success', last_reason: null },
      upstream_status_code: first.response.upstream_status_code,
      latency_ms: first.response.latency_ms,
      prompt_version: first.bundle.promptVersion,
      input_hash: deepeningDto && deepeningDto.input_hash ? String(deepeningDto.input_hash) : null,
    };
  }
  const second = await attempt(buildSemanticRevisionHint({
    stage: 'deepening',
    issues: validation.ok ? semantic.issues : validation.errors,
  }));
  if (!second.response.ok) {
    return {
      ok: false,
      provider: 'gemini',
      reason: second.response.reason || 'UNKNOWN',
      schema_violation: false,
      semantic_violation: false,
      layer: null,
      retry: { attempted: 1, final: 'fail', last_reason: second.response.reason || 'UNKNOWN' },
      upstream_status_code: second.response.upstream_status_code,
      latency_ms: second.response.latency_ms,
      prompt_version: second.bundle.promptVersion,
      input_hash: deepeningDto && deepeningDto.input_hash ? String(deepeningDto.input_hash) : null,
    };
  }
  const revisedCanonical = normalizeDeepeningCanonicalLayer(second.response.parsed);
  const revisedValidation = validateDeepeningCanonicalLayer(revisedCanonical);
  const revisedSemantic = revisedValidation.ok
    ? evaluateDeepeningCanonicalSemantic(revisedCanonical)
    : { ok: false, code: 'SCHEMA_INVALID', issues: revisedValidation.errors || [] };
  if (!revisedValidation.ok || !revisedSemantic.ok) {
    return {
      ok: false,
      provider: 'gemini',
      reason: !revisedValidation.ok ? 'SCHEMA_INVALID' : revisedSemantic.code || 'SEMANTIC_INVALID',
      schema_violation: !revisedValidation.ok,
      semantic_violation: Boolean(revisedValidation.ok && !revisedSemantic.ok),
      layer: null,
      canonical: revisedCanonical,
      semantic: revisedSemantic,
      raw_response_text: second.response.response_text,
      retry: {
        attempted: 1,
        final: 'fail',
        last_reason: !revisedValidation.ok ? 'SCHEMA_INVALID' : revisedSemantic.code || 'SEMANTIC_INVALID',
      },
      upstream_status_code: second.response.upstream_status_code,
      latency_ms: second.response.latency_ms,
      prompt_version: second.bundle.promptVersion,
      input_hash: deepeningDto && deepeningDto.input_hash ? String(deepeningDto.input_hash) : null,
      validation_errors: !revisedValidation.ok ? revisedValidation.errors : undefined,
      semantic_issues: revisedSemantic.issues,
    };
  }
  return {
    ok: true,
    provider: 'gemini',
    reason: null,
    schema_violation: false,
    semantic_violation: false,
    layer: renderDeepeningCanonicalLayer(revisedCanonical, { lang: language }),
    canonical: revisedCanonical,
    semantic: revisedSemantic,
    raw_response_text: second.response.response_text,
    retry: { attempted: 1, final: 'success', last_reason: null },
    upstream_status_code: second.response.upstream_status_code,
    latency_ms: second.response.latency_ms,
    prompt_version: second.bundle.promptVersion,
    input_hash: deepeningDto && deepeningDto.input_hash ? String(deepeningDto.input_hash) : null,
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
  runGeminiDeepeningStrategy,
};
