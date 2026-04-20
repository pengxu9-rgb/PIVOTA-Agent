const crypto = require('node:crypto');

const { extractJsonObject, parseJsonOnlyObject } = require('./jsonExtract');
const {
  hasAuroraGeminiApiKey,
  callAuroraGeminiGenerateContentRestWithMeta,
  callAuroraGeminiGenerateContentWithMeta,
} = require('./auroraGeminiGlobalClient');
const { DEFAULT_TRAVEL_LLM_MODEL, __internal: travelLlmInternal } = require('./travelLlmCalibrator');
const { resolveNonImageGeminiModel } = require('../lib/geminiModelFloor');

const DEFAULT_TRAVEL_FINAL_REWRITE_MODEL = String(
  process.env.AURORA_TRAVEL_FINAL_REWRITE_MODEL ||
    process.env.AURORA_TRAVEL_LLM_MODEL ||
    DEFAULT_TRAVEL_LLM_MODEL ||
    'gemini-3-flash-preview',
).trim() || 'gemini-3-flash-preview';

const DEFAULT_TRAVEL_FINAL_REWRITE_TRANSPORT = String(
  process.env.AURORA_TRAVEL_GEMINI_TRANSPORT || 'rest',
).trim().toLowerCase();

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(value, maxLen = 220) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text) return '';
  return text.slice(0, maxLen);
}

function normalizeNumber(value) {
  if (value == null) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeLang(value) {
  return String(value || '').trim().toUpperCase() === 'CN' ? 'CN' : 'EN';
}

function normalizeTravelFinalRewriteModel(model) {
  return resolveNonImageGeminiModel({
    model: String(model || '').trim(),
    fallbackModel: 'gemini-3-flash-preview',
    envSource: 'AURORA_TRAVEL_FINAL_REWRITE_MODEL',
    callPath: 'aurora_travel_final_assistant_rewrite',
  }).effectiveModel;
}

function hashPromptPayload(value, tokenLen = 24) {
  const text = typeof value === 'string' ? value : String(value || '');
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  const len = Number.isFinite(Number(tokenLen)) ? Math.max(8, Math.min(64, Math.trunc(Number(tokenLen)))) : 24;
  return hash.slice(0, len);
}

function compactProfileForFinalRewrite(profile) {
  const p = isPlainObject(profile) ? profile : {};
  const goals = Array.isArray(p.goals) ? p.goals.map((v) => normalizeText(v, 80)).filter(Boolean).slice(0, 5) : [];
  return {
    ...(normalizeText(p.skinType || p.skin_type, 80) ? { skin_type: normalizeText(p.skinType || p.skin_type, 80) } : {}),
    ...(normalizeText(p.sensitivity, 80) ? { sensitivity: normalizeText(p.sensitivity, 80) } : {}),
    ...(normalizeText(p.barrierStatus || p.barrier_status, 80)
      ? { barrier_status: normalizeText(p.barrierStatus || p.barrier_status, 80) }
      : {}),
    ...(goals.length ? { goals } : {}),
    ...(normalizeText(p.currentRoutine || p.current_routine, 500)
      ? { current_routine: normalizeText(p.currentRoutine || p.current_routine, 500) }
      : {}),
    ...(normalizeText(p.skin_analysis_summary || p.skinAnalysisSummary, 500)
      ? { skin_analysis_summary: normalizeText(p.skin_analysis_summary || p.skinAnalysisSummary, 500) }
      : {}),
  };
}

function compactSafetyDecisionForFinalRewrite(safetyDecision) {
  const s = isPlainObject(safetyDecision) ? safetyDecision : null;
  if (!s) return null;
  const blockLevel = normalizeText(s.block_level || s.blockLevel, 40);
  const reasons = Array.isArray(s.reasons) ? s.reasons.map((line) => normalizeText(line, 220)).filter(Boolean).slice(0, 2) : [];
  const alternatives = Array.isArray(s.safe_alternatives)
    ? s.safe_alternatives.map((line) => normalizeText(line, 160)).filter(Boolean).slice(0, 2)
    : [];
  if (!blockLevel && !reasons.length && !alternatives.length) return null;
  return {
    ...(blockLevel ? { block_level: blockLevel } : {}),
    ...(reasons.length ? { reasons } : {}),
    ...(alternatives.length ? { safe_alternatives: alternatives } : {}),
  };
}

function compactStructuredSectionsForFinalRewrite(sections) {
  const src = isPlainObject(sections) ? sections : {};
  const pickLines = (key, maxItems, maxLen = 220) => (
    Array.isArray(src[key])
      ? src[key].map((line) => normalizeText(line, maxLen)).filter(Boolean).slice(0, maxItems)
      : []
  );
  return {
    key_deltas: pickLines('key_deltas', 4),
    routine_adjustments: pickLines('routine_adjustments', 4),
    jetlag_sleep: pickLines('jetlag_sleep', 3),
    flight_day_plan: pickLines('flight_day_plan', 3),
    active_handling: pickLines('active_handling', 3),
    phased_plan: pickLines('phased_plan', 3),
    travel_kit: pickLines('travel_kit', 8),
    product_guidance: pickLines('product_guidance', 6),
    troubleshooting: pickLines('troubleshooting', 3),
  };
}

function compactShoppingForFinalRewrite(travelReadiness) {
  const readiness = isPlainObject(travelReadiness) ? travelReadiness : {};
  const shopping = isPlainObject(readiness.shopping_preview) ? readiness.shopping_preview : {};
  const products = Array.isArray(shopping.products) ? shopping.products : [];
  return {
    ...(normalizeText(shopping.mode, 80) ? { mode: normalizeText(shopping.mode, 80) } : {}),
    ...(normalizeText(shopping.coverage_status || shopping.coverageStatus, 80)
      ? { coverage_status: normalizeText(shopping.coverage_status || shopping.coverageStatus, 80) }
      : {}),
    ...(normalizeNumber(shopping.grounded_count || shopping.groundedCount) != null
      ? { grounded_count: normalizeNumber(shopping.grounded_count || shopping.groundedCount) }
      : {}),
    products: products.slice(0, 8).map((row) => {
      const product = isPlainObject(row) ? row : {};
      return {
        name: normalizeText(product.name, 120) || null,
        brand: normalizeText(product.brand, 80) || null,
        category: normalizeText(product.category, 80) || null,
        product_source: normalizeText(product.product_source || product.productSource, 80) || null,
        display_mode: normalizeText(product.display_mode || product.displayMode, 80) || null,
        product_id: normalizeText(product.product_id || product.productId, 120) || null,
      };
    }).filter((row) => row.name),
    ...(Array.isArray(shopping.buying_channels) && shopping.buying_channels.length
      ? { buying_channels: shopping.buying_channels.map((v) => normalizeText(v, 80)).filter(Boolean).slice(0, 6) }
      : {}),
  };
}

function buildFinalRewritePromptInput({
  message,
  language,
  profile,
  travelReadiness,
  structuredSections,
  deterministicBrief,
  safetyDecision,
} = {}) {
  const readiness = isPlainObject(travelReadiness) ? travelReadiness : {};
  return {
    language: normalizeLang(language),
    user_question: normalizeText(message, 800),
    profile: compactProfileForFinalRewrite(profile),
    travel_readiness: travelLlmInternal.compactTravelReadinessForPrompt(readiness),
    structured_sections: compactStructuredSectionsForFinalRewrite(structuredSections),
    shopping: compactShoppingForFinalRewrite(readiness),
    safety: compactSafetyDecisionForFinalRewrite(safetyDecision),
    deterministic_brief: normalizeText(deterministicBrief, 1000),
  };
}

function buildTravelFinalRewritePrompts(input) {
  const promptInput = buildFinalRewritePromptInput(input);
  const lang = normalizeLang(promptInput.language);
  const shopping = isPlainObject(promptInput.shopping) ? promptInput.shopping : {};
  const coverageStatus = normalizeText(shopping.coverage_status, 80).toLowerCase();
  const shoppingMode = normalizeText(shopping.mode, 80).toLowerCase();
  const groundedCount = normalizeNumber(shopping.grounded_count) || 0;
  const categoryOnly =
    coverageStatus === 'category_only' ||
    shoppingMode === 'category_guidance' ||
    (!groundedCount && Array.isArray(shopping.products) && shopping.products.length > 0);
  const hasSafety = Boolean(promptInput.safety && Object.keys(promptInput.safety).length);

  const systemPrompt = [
    'You are Aurora, a senior travel skincare advisor writing the final user-facing answer.',
    'Use only the provided structured facts. Do not invent weather, dates, locations, products, stores, prices, clinical claims, or availability.',
    'Do not expose internal payload terms, fallback labels, source tiers, or debug wording.',
    'Do not use absolute marketing words: best, most, perfect, guaranteed, must-have, miracle, holy grail.',
    'Do not use these headings or phrases: Risk note, Practical alternatives, Suggested products, rule_fallback.',
    'Write a concise plan that feels like an advisor synthesized the trip, not a dump of every payload field.',
    'Keep it under 1700 characters, with at most 4 short sections and at most 9 bullets total.',
    'Must cover: weather/UV/humidity change, timezone or jet lag if present, before departure, flight, first 48 hours, and local buying guidance.',
    'If category-only shopping is provided, call it product categories or buying categories; explicitly do not present them as grounded product picks.',
    'If grounded products are provided, say product options to review, not top/best products.',
    'Integrate safety context naturally into UV/actives guidance; do not prepend a separate safety block.',
    'End with one useful follow-up question only if it would materially improve product narrowing.',
    'Return strict JSON only: {"assistant_text":"..."}',
  ].join('\n');

  const userPrompt = [
    `language=${lang}`,
    categoryOnly ? 'Shopping status: category_only. Be honest that these are categories, not specific grounded products.' : '',
    hasSafety ? 'Safety status: integrate safety advice naturally; no Risk note heading.' : '',
    'Task: rewrite the final travel skincare answer from the facts below. Preserve all numeric facts if mentioned.',
    `Fact JSON:${JSON.stringify(promptInput)}`,
  ].filter(Boolean).join('\n');

  return { systemPrompt, userPrompt, promptInput };
}

function buildGeminiRequest({ model, systemPrompt, userPrompt } = {}) {
  return {
    model: normalizeTravelFinalRewriteModel(model || DEFAULT_TRAVEL_FINAL_REWRITE_MODEL),
    contents: [
      {
        role: 'user',
        parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }],
      },
    ],
    config: {
      temperature: 0.22,
      maxOutputTokens: 1150,
      responseMimeType: 'application/json',
      thinkingConfig: {
        includeThoughts: false,
        thinkingBudget: 96,
      },
    },
  };
}

function withTimeout(promise, timeoutMs, timeoutCode = 'TRAVEL_FINAL_REWRITE_TIMEOUT') {
  const ms = Number.isFinite(Number(timeoutMs)) ? Math.max(1, Math.trunc(Number(timeoutMs))) : 0;
  if (!ms) return promise;
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(timeoutCode);
      err.code = timeoutCode;
      reject(err);
    }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function parseTravelFinalRewritePayload(text) {
  const parsed = parseJsonOnlyObject(text) || extractJsonObject(text);
  if (!isPlainObject(parsed)) return null;
  const assistantText = normalizeText(parsed.assistant_text || parsed.assistantText || parsed.text, 2600);
  if (!assistantText) return null;
  return { assistant_text: assistantText };
}

function validateTravelFinalRewriteText(text, { promptInput } = {}) {
  const assistantText = normalizeText(text, 2600);
  if (!assistantText) return { ok: false, reason: 'empty_rewrite' };
  if (assistantText.length < 180) return { ok: false, reason: 'rewrite_too_short' };
  if (assistantText.length > 2200) return { ok: false, reason: 'rewrite_too_long' };
  if (/(^|\n)\s*(Risk note|Practical alternatives|Suggested products)\s*:/i.test(assistantText)) {
    return { ok: false, reason: 'rewrite_forbidden_heading' };
  }
  if (/rule_fallback|fallback_source|Products actually selected|Primary recommendation focus/i.test(assistantText)) {
    return { ok: false, reason: 'rewrite_internal_terms' };
  }
  if (/\b(best|most|perfect|guaranteed|must-have|miracle|holy grail)\b/i.test(assistantText)) {
    return { ok: false, reason: 'rewrite_absolute_wording' };
  }

  const shopping = isPlainObject(promptInput && promptInput.shopping) ? promptInput.shopping : {};
  const coverageStatus = normalizeText(shopping.coverage_status, 80).toLowerCase();
  const shoppingMode = normalizeText(shopping.mode, 80).toLowerCase();
  const groundedCount = normalizeNumber(shopping.grounded_count) || 0;
  const hasCategoryRows = Array.isArray(shopping.products) && shopping.products.length > 0;
  const categoryOnly = coverageStatus === 'category_only' || shoppingMode === 'category_guidance' || (!groundedCount && hasCategoryRows);
  if (categoryOnly && /\b(specific product picks|grounded products|product recommendations|recommended products)\b/i.test(assistantText)) {
    return { ok: false, reason: 'rewrite_overstates_category_guidance' };
  }

  const safety = isPlainObject(promptInput && promptInput.safety) ? promptInput.safety : null;
  if (safety && Object.keys(safety).length) {
    if (!/(sunscreen|spf|uv|active|actives|retinoid|acid|防晒|活性)/i.test(assistantText)) {
      return { ok: false, reason: 'rewrite_missing_safety_integration' };
    }
  }
  return { ok: true, reason: 'ok' };
}

function normalizeErrorCode(err, fallback = 'TRAVEL_FINAL_REWRITE_ERROR') {
  const token = normalizeText(err && (err.code || err.message), 80);
  return token || fallback;
}

async function rewriteTravelAssistantTextWithLlm({
  geminiGenerateContent = null,
  language = 'EN',
  message = '',
  profile = null,
  travelReadiness = null,
  structuredSections = null,
  deterministicBrief = '',
  safetyDecision = null,
  timeoutMs = 5200,
  model = DEFAULT_TRAVEL_FINAL_REWRITE_MODEL,
  logger = null,
} = {}) {
  const stage = 'travel_final_assistant_rewrite_v1';
  const { systemPrompt, userPrompt, promptInput } = buildTravelFinalRewritePrompts({
    language,
    message,
    profile,
    travelReadiness,
    structuredSections,
    deterministicBrief,
    safetyDecision,
  });
  const promptHash = hashPromptPayload(`${systemPrompt}\n${userPrompt}`);
  const promptChars = `${systemPrompt}\n${userPrompt}`.length;
  const effectiveModel = normalizeTravelFinalRewriteModel(model || DEFAULT_TRAVEL_FINAL_REWRITE_MODEL);
  const request = buildGeminiRequest({ model: effectiveModel, systemPrompt, userPrompt });
  const hasGeminiClient =
    typeof geminiGenerateContent === 'function' ||
    hasAuroraGeminiApiKey('AURORA_TRAVEL_GEMINI_API_KEY');

  if (!hasGeminiClient) {
    return {
      stage,
      used: false,
      outcome: 'skip_no_client',
      reason: 'no_gemini_client',
      assistant_text: '',
      source_meta: {
        provider: 'gemini',
        model: effectiveModel,
        prompt_hash: promptHash,
        prompt_chars: promptChars,
        error_code: 'no_gemini_client',
      },
    };
  }

  try {
    const totalTimeoutMs = Math.max(1200, Math.trunc(Number(timeoutMs || 5200) || 5200));
    const queueTimeoutMs = Math.min(900, Math.max(200, Math.floor(totalTimeoutMs * 0.12)));
    const upstreamTimeoutMs = Math.max(1400, totalTimeoutMs - queueTimeoutMs);
    const realGeminiCaller =
      DEFAULT_TRAVEL_FINAL_REWRITE_TRANSPORT === 'sdk'
        ? callAuroraGeminiGenerateContentWithMeta
        : callAuroraGeminiGenerateContentRestWithMeta;
    const callResult = typeof geminiGenerateContent === 'function'
      ? {
          response: await withTimeout(
            geminiGenerateContent(request),
            totalTimeoutMs,
            'TRAVEL_FINAL_REWRITE_TIMEOUT',
          ),
          meta: {},
        }
      : await realGeminiCaller({
          featureEnvVar: 'AURORA_TRAVEL_GEMINI_API_KEY',
          route: 'aurora_travel_final_assistant_rewrite',
          request,
          queueTimeoutMs,
          upstreamTimeoutMs,
        });

    const responseMeta = travelLlmInternal.extractGeminiResponseDebugMeta(callResult && callResult.response);
    const text = await travelLlmInternal.extractGeminiText(callResult && callResult.response);
    const parsed = parseTravelFinalRewritePayload(text);
    if (!parsed) {
      return {
        stage,
        used: false,
        outcome: 'error',
        reason: 'invalid_json',
        assistant_text: '',
        source_meta: {
          provider: 'gemini',
          model: effectiveModel,
          prompt_hash: promptHash,
          prompt_chars: promptChars,
          ...(isPlainObject(callResult && callResult.meta) ? callResult.meta : {}),
          ...responseMeta,
          error_code: 'TRAVEL_FINAL_REWRITE_INVALID_JSON',
          raw_text_chars: String(text || '').length,
          raw_text_excerpt: normalizeText(text, 800),
        },
      };
    }

    const validation = validateTravelFinalRewriteText(parsed.assistant_text, { promptInput });
    if (!validation.ok) {
      return {
        stage,
        used: false,
        outcome: 'guard_reject',
        reason: validation.reason,
        assistant_text: '',
        source_meta: {
          provider: 'gemini',
          model: effectiveModel,
          prompt_hash: promptHash,
          prompt_chars: promptChars,
          ...(isPlainObject(callResult && callResult.meta) ? callResult.meta : {}),
          ...responseMeta,
          error_code: validation.reason,
          raw_text_chars: String(text || '').length,
          raw_text_excerpt: normalizeText(text, 800),
        },
      };
    }

    return {
      stage,
      used: true,
      outcome: 'call',
      reason: 'ok',
      assistant_text: parsed.assistant_text,
      source_meta: {
        provider: 'gemini',
        model: effectiveModel,
        prompt_hash: promptHash,
        prompt_chars: promptChars,
        ...(isPlainObject(callResult && callResult.meta) ? callResult.meta : {}),
        ...responseMeta,
      },
    };
  } catch (err) {
    const timeoutErr = /TIMEOUT/i.test(String(err && (err.code || err.message) || ''));
    const errorMeta = isPlainObject(err && err.meta) ? err.meta : {};
    logger?.warn(
      {
        err: normalizeErrorCode(err, timeoutErr ? 'TRAVEL_FINAL_REWRITE_TIMEOUT' : 'TRAVEL_FINAL_REWRITE_ERROR'),
        stage,
        timeout_ms: timeoutMs,
      },
      'aurora bff: travel final assistant rewrite failed',
    );
    return {
      stage,
      used: false,
      outcome: timeoutErr ? 'timeout' : 'error',
      reason: timeoutErr ? 'timeout' : 'error',
      assistant_text: '',
      source_meta: {
        provider: 'gemini',
        model: effectiveModel,
        prompt_hash: promptHash,
        prompt_chars: promptChars,
        error_code: normalizeErrorCode(err, timeoutErr ? 'TRAVEL_FINAL_REWRITE_TIMEOUT' : 'TRAVEL_FINAL_REWRITE_ERROR'),
        ...(normalizeText(err && err.timeout_stage, 40) ? { timeout_stage: normalizeText(err.timeout_stage, 40) } : {}),
        ...(normalizeNumber(errorMeta.gate_wait_ms) != null ? { gate_wait_ms: normalizeNumber(errorMeta.gate_wait_ms) } : {}),
        ...(normalizeNumber(errorMeta.upstream_ms) != null ? { upstream_ms: normalizeNumber(errorMeta.upstream_ms) } : {}),
        ...(normalizeNumber(errorMeta.total_ms) != null ? { total_ms: normalizeNumber(errorMeta.total_ms) } : {}),
      },
    };
  }
}

module.exports = {
  DEFAULT_TRAVEL_FINAL_REWRITE_MODEL,
  rewriteTravelAssistantTextWithLlm,
  __internal: {
    buildFinalRewritePromptInput,
    buildTravelFinalRewritePrompts,
    buildGeminiRequest,
    parseTravelFinalRewritePayload,
    validateTravelFinalRewriteText,
    compactShoppingForFinalRewrite,
    compactStructuredSectionsForFinalRewrite,
    compactSafetyDecisionForFinalRewrite,
  },
};
