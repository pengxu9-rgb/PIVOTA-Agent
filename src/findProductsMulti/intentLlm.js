const OpenAI = require('openai');
const axios = require('axios');
const {
  PivotaIntentV1Zod,
  extractIntentRuleBased,
  extractHumanApparelCategories,
  TOY_KEYWORDS_STRONG,
} = require('./intent');
const {
  resolveFindProductsGeminiApiKey,
  resolveFindProductsLlmRuntime,
  resolveFindProductsOpenAiApiKey,
} = require('./llmRuntime');
const { resolveNonImageGeminiModel } = require('../lib/geminiModelFloor');
const { extractJsonObject, parseJsonOnlyObject } = require('../auroraBff/jsonExtract');

const INTENT_LLM_MAX_RECENT_QUERIES = Math.max(
  1,
  Math.min(6, Number(process.env.FIND_PRODUCTS_MULTI_INTENT_LLM_MAX_RECENT_QUERIES || 4) || 4),
);
const INTENT_LLM_MAX_RECENT_MESSAGES = Math.max(
  1,
  Math.min(8, Number(process.env.FIND_PRODUCTS_MULTI_INTENT_LLM_MAX_RECENT_MESSAGES || 6) || 6),
);
const INTENT_LLM_MAX_MESSAGE_CHARS = Math.max(
  80,
  Math.min(600, Number(process.env.FIND_PRODUCTS_MULTI_INTENT_LLM_MAX_MESSAGE_CHARS || 240) || 240),
);
const INTENT_LLM_PROVIDER_TIMEOUT_MS = Math.max(
  1000,
  Math.min(15000, Number(process.env.FIND_PRODUCTS_MULTI_INTENT_LLM_PROVIDER_TIMEOUT_MS || 6000) || 6000),
);
const INTENT_LLM_MAX_RECENT_QUERIES_WITH_CONTRACT = Math.max(
  1,
  Math.min(INTENT_LLM_MAX_RECENT_QUERIES, Number(process.env.FIND_PRODUCTS_MULTI_INTENT_LLM_MAX_RECENT_QUERIES_WITH_CONTRACT || 2) || 2),
);
const INTENT_LLM_MAX_RECENT_MESSAGES_WITH_CONTRACT = Math.max(
  1,
  Math.min(INTENT_LLM_MAX_RECENT_MESSAGES, Number(process.env.FIND_PRODUCTS_MULTI_INTENT_LLM_MAX_RECENT_MESSAGES_WITH_CONTRACT || 3) || 3),
);
const INTENT_LLM_MAX_MESSAGE_CHARS_WITH_CONTRACT = Math.max(
  80,
  Math.min(INTENT_LLM_MAX_MESSAGE_CHARS, Number(process.env.FIND_PRODUCTS_MULTI_INTENT_LLM_MAX_MESSAGE_CHARS_WITH_CONTRACT || 160) || 160),
);
const INTENT_LLM_GEMINI_MAX_OUTPUT_TOKENS = Math.max(
  128,
  Math.min(1024, Number(process.env.FIND_PRODUCTS_MULTI_INTENT_LLM_GEMINI_MAX_OUTPUT_TOKENS || 384) || 384),
);
const INTENT_LLM_ERROR_MESSAGE_MAX_CHARS = 240;
const SEMANTIC_REWRITE_DEFAULT_OPENAI_MODEL = 'gpt-5.1-mini';
const SEMANTIC_REWRITE_DEFAULT_GEMINI_MODEL = 'gemini-3-flash-preview';
const SEMANTIC_REWRITE_OPENAI_MODEL_ENV = 'FIND_PRODUCTS_MULTI_SEMANTIC_REWRITE_MODEL_OPENAI';
const SEMANTIC_REWRITE_GEMINI_MODEL_ENV = 'FIND_PRODUCTS_MULTI_SEMANTIC_REWRITE_MODEL_GEMINI';
const INTENT_OUTPUT_CONTRACT = Object.freeze({
  required_keys: [
    'language',
    'primary_domain',
    'target_object.type',
    'target_object.age_group',
    'query_class',
    'category.required',
    'category.optional',
    'scenario.name',
    'scenario.signals',
    'hard_constraints.must_exclude_domains',
    'hard_constraints.must_exclude_keywords',
    'history_usage.used',
    'history_usage.reason',
    'ambiguity.needs_clarification',
    'ambiguity.questions',
    'confidence.overall',
  ],
});

function isEnabled() {
  return resolveFindProductsLlmRuntime('semantic_rewrite').enabled;
}

function getOpenAIClient() {
  const apiKey = resolveFindProductsOpenAiApiKey();
  if (!apiKey) throw new Error('OPENAI_API_KEY or LLM_API_KEY is not set');
  const baseURL = process.env.OPENAI_BASE_URL || undefined;
  return new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
}

function normalizeSemanticContractForExecutionPlan(contract) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) return null;
  const requestClass = String(contract.request_class || contract.requestClass || '').trim().toLowerCase() || null;
  const owner = String(contract.owner || '').trim().toLowerCase() || null;
  const sourceSurface =
    String(contract.source_surface || contract.sourceSurface || '').trim().toLowerCase() || null;
  return {
    owner,
    request_class: requestClass,
    source_surface: sourceSurface,
  };
}

function shouldLockSingleIntentProvider(options = {}) {
  const contract = normalizeSemanticContractForExecutionPlan(options?.semanticContract);
  if (!contract) return false;
  if (contract.request_class === 'exact_lookup') return false;
  return contract.owner === 'aurora_reco_planner' && contract.source_surface === 'aurora_beauty_strict';
}

function resolveIntentOpenAiModel() {
  const explicitModel = String(process.env[SEMANTIC_REWRITE_OPENAI_MODEL_ENV] || '').trim();
  return {
    model: explicitModel || SEMANTIC_REWRITE_DEFAULT_OPENAI_MODEL,
    model_owner: explicitModel ? SEMANTIC_REWRITE_OPENAI_MODEL_ENV : 'default_semantic_rewrite_openai_model',
  };
}

function resolveIntentGeminiModel() {
  const resolved = resolveNonImageGeminiModel({
    model: process.env[SEMANTIC_REWRITE_GEMINI_MODEL_ENV],
    fallbackModel: SEMANTIC_REWRITE_DEFAULT_GEMINI_MODEL,
    envSource: process.env[SEMANTIC_REWRITE_GEMINI_MODEL_ENV]
      ? SEMANTIC_REWRITE_GEMINI_MODEL_ENV
      : 'default_semantic_rewrite_gemini_model',
    callPath: 'find_products_intent',
  });
  return {
    model: resolved.effectiveModel,
    model_owner: resolved.envSource || 'default_semantic_rewrite_gemini_model',
  };
}

function resolveIntentProviderModel(provider) {
  if (provider === 'openai') return resolveIntentOpenAiModel();
  if (provider === 'gemini') return resolveIntentGeminiModel();
  return {
    model: null,
    model_owner: null,
  };
}

function resolveIntentLlmExecutionPlan(options = {}) {
  const runtime = resolveFindProductsLlmRuntime('semantic_rewrite');
  const providerChainBase =
    Array.isArray(runtime?.providerChain) && runtime.providerChain.length
      ? runtime.providerChain.filter(Boolean)
      : [];
  const singleProviderLocked = shouldLockSingleIntentProvider(options);
  const providerChain = singleProviderLocked ? providerChainBase.slice(0, 1) : providerChainBase;
  const primaryProvider = providerChain[0] || runtime?.primaryProvider || null;
  const fallbackProvider = providerChain[1] || null;
  const primaryModelMeta = resolveIntentProviderModel(primaryProvider);
  const fallbackModelMeta = resolveIntentProviderModel(fallbackProvider);

  return {
    ...runtime,
    providerChain,
    primaryProvider,
    fallbackProvider,
    primaryModel: primaryModelMeta.model,
    primaryModelOwner: primaryModelMeta.model_owner,
    fallbackModel: fallbackModelMeta.model,
    fallbackModelOwner: fallbackModelMeta.model_owner,
    singleProviderLocked,
  };
}

function trimIntentLlmText(value, maxChars = INTENT_LLM_ERROR_MESSAGE_MAX_CHARS) {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
}

function annotateIntentLlmError(error, meta = {}) {
  if (!error || typeof error !== 'object') return error;
  const existingMeta =
    error.__intent_llm_meta && typeof error.__intent_llm_meta === 'object'
      ? error.__intent_llm_meta
      : {};
  const nextMeta = {
    ...existingMeta,
    ...meta,
  };
  try {
    Object.defineProperty(error, '__intent_llm_meta', {
      value: nextMeta,
      configurable: true,
      enumerable: false,
      writable: true,
    });
  } catch (_err) {
    error.__intent_llm_meta = nextMeta;
  }
  return error;
}

function isIntentLlmTimeoutError(error) {
  const code = String(error?.code || '').trim().toUpperCase();
  const message = String(error?.message || '').trim().toLowerCase();
  return (
    code === 'ECONNABORTED' ||
    code === 'ETIMEDOUT' ||
    code === 'ERR_CANCELED' ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('aborted')
  );
}

function normalizeIntentLlmError(error = null) {
  const annotatedMeta =
    error && typeof error === 'object' && error.__intent_llm_meta && typeof error.__intent_llm_meta === 'object'
      ? error.__intent_llm_meta
      : {};
  const upstreamStatus =
    Number.isFinite(Number(error?.response?.status)) && Number(error.response.status) > 0
      ? Number(error.response.status)
      : null;
  const upstreamErrorCode = trimIntentLlmText(
    error?.response?.data?.error?.status ||
      error?.response?.data?.error?.code ||
      error?.code ||
      error?.name ||
      '',
    96,
  );
  const upstreamErrorMessage = trimIntentLlmText(
    error?.response?.data?.error?.message ||
      error?.response?.data?.message ||
      '',
  );
  const errorMessage = trimIntentLlmText(error?.message || upstreamErrorMessage || '');
  let errorClass = 'provider_error';
  if (isIntentLlmTimeoutError(error)) errorClass = 'timeout';
  else if (error?.name === 'ZodError' || Array.isArray(error?.issues)) errorClass = 'schema_validation_failed';
  else if (/did not return valid json/i.test(String(errorMessage || '').toLowerCase())) errorClass = 'invalid_json';
  else if (/api key is not set|unsupported intent provider/i.test(String(errorMessage || '').toLowerCase())) {
    errorClass = 'config_error';
  }
  return {
    llm_error_class: errorClass,
    llm_error_stage: trimIntentLlmText(annotatedMeta.stage || '', 48),
    llm_error_provider: trimIntentLlmText(annotatedMeta.provider || '', 48),
    llm_error_message: errorMessage,
    llm_finish_reason: trimIntentLlmText(annotatedMeta.finish_reason || '', 48),
    llm_raw_preview: trimIntentLlmText(annotatedMeta.raw_preview || '', 160),
    llm_candidate_count:
      Number.isFinite(Number(annotatedMeta.candidate_count)) && Number(annotatedMeta.candidate_count) >= 0
        ? Number(annotatedMeta.candidate_count)
        : null,
    llm_upstream_status: upstreamStatus,
    llm_upstream_error_code: upstreamErrorCode,
    llm_upstream_error_message: upstreamErrorMessage || errorMessage,
  };
}

function parseIntentJsonObject(rawText, sourceLabel = 'Intent LLM') {
  const text = String(rawText || '').trim();
  if (!text) {
    throw new Error(`${sourceLabel} returned empty JSON response`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    const recovered = parseJsonOnlyObject(text) || extractJsonObject(text);
    if (recovered && typeof recovered === 'object' && !Array.isArray(recovered)) {
      return recovered;
    }
    throw new Error(`${sourceLabel} did not return valid JSON: ${String(err)}`);
  }
}

function applyIntentExecutionMeta(meta = {}, plan = {}, provider = null) {
  const normalizedProvider = String(provider || '').trim() || null;
  const effectiveProvider =
    normalizedProvider ||
    (String(meta?.llm_primary_provider || '').trim() || String(plan?.primaryProvider || '').trim() || null);
  const effectiveModel =
    normalizedProvider === plan?.primaryProvider
      ? plan?.primaryModel
      : normalizedProvider === plan?.fallbackProvider
        ? plan?.fallbackModel
        : effectiveProvider === plan?.primaryProvider
          ? plan?.primaryModel
          : effectiveProvider === plan?.fallbackProvider
            ? plan?.fallbackModel
        : null;
  const effectiveModelOwner =
    normalizedProvider === plan?.primaryProvider
      ? plan?.primaryModelOwner
      : normalizedProvider === plan?.fallbackProvider
        ? plan?.fallbackModelOwner
        : effectiveProvider === plan?.primaryProvider
          ? plan?.primaryModelOwner
          : effectiveProvider === plan?.fallbackProvider
            ? plan?.fallbackModelOwner
        : null;
  return {
    ...meta,
    enable_owner: String(meta?.enable_owner || plan?.enableOwner || '').trim() || null,
    provider_owner: String(meta?.provider_owner || plan?.providerOwner || '').trim() || null,
    fallback_owner: String(meta?.fallback_owner || plan?.fallbackOwner || '').trim() || null,
    llm_provider_chain: Array.isArray(plan?.providerChain) ? plan.providerChain : [],
    llm_primary_provider: String(plan?.primaryProvider || '').trim() || null,
    llm_fallback_provider: String(plan?.fallbackProvider || '').trim() || null,
    llm_model: String(meta?.llm_model || effectiveModel || plan?.primaryModel || '').trim() || null,
    llm_model_owner:
      String(meta?.llm_model_owner || effectiveModelOwner || plan?.primaryModelOwner || '').trim() || null,
    llm_error_class: String(meta?.llm_error_class || '').trim() || null,
    llm_error_stage: String(meta?.llm_error_stage || '').trim() || null,
    llm_error_provider: String(meta?.llm_error_provider || '').trim() || null,
    llm_error_message: trimIntentLlmText(meta?.llm_error_message || ''),
    llm_finish_reason: trimIntentLlmText(meta?.llm_finish_reason || '', 48),
    llm_raw_preview: trimIntentLlmText(meta?.llm_raw_preview || '', 160),
    llm_candidate_count:
      Number.isFinite(Number(meta?.llm_candidate_count)) && Number(meta.llm_candidate_count) >= 0
        ? Number(meta.llm_candidate_count)
        : null,
    llm_upstream_status:
      Number.isFinite(Number(meta?.llm_upstream_status)) && Number(meta.llm_upstream_status) > 0
        ? Number(meta.llm_upstream_status)
        : null,
    llm_upstream_error_code: trimIntentLlmText(meta?.llm_upstream_error_code || '', 96),
    llm_upstream_error_message: trimIntentLlmText(meta?.llm_upstream_error_message || ''),
    single_provider_locked: Boolean(plan?.singleProviderLocked),
  };
}

function buildDeterministicIntentWithMeta(
  latestUserQuery,
  recentQueries = [],
  recentMessages = [],
  fallbackReason = 'deterministic_fallback',
) {
  const intent = extractIntentRuleBased(latestUserQuery, recentQueries, recentMessages);
  try {
    return {
      intent: applyHardOverrides(latestUserQuery, intent),
      meta: {
        applied: true,
        mode: 'deterministic_fallback',
        provider: 'rule_based',
        fallback_reason: String(fallbackReason || '').trim() || 'deterministic_fallback',
      },
    };
  } catch (_err) {
    return {
      intent,
      meta: {
        applied: true,
        mode: 'deterministic_fallback',
        provider: 'rule_based',
        fallback_reason: 'hard_override_failed',
      },
    };
  }
}

function buildSystemPrompt() {
  return [
    'You extract shopping intent for an e-commerce agent.',
    'Return one JSON object only.',
    'Latest user query dominates.',
    'History is only for explicit carry-over references.',
    'If semantic_contract is present, treat it as hard guidance for request class and step family.',
    'If unsure, keep fields null/unknown and set ambiguity.needs_clarification=true.',
  ].join('\n');
}

function buildDeveloperPrompt() {
  return [
    'Input:',
    '- latest_user_query',
    '- recent_queries',
    '- recent_messages',
    '- semantic_contract (optional)',
    '- output_contract',
    '',
    'Rules:',
    '- Fill output_contract keys only.',
    '- category.required is hard intent; category.optional is soft guesswork.',
    '- For human requests, exclude toy_accessory and doll/toy/Labubu cues in hard_constraints.',
    '- Set history_usage.used=false when latest query is already clear.',
    '- Keep ambiguity.questions to at most 3 short questions.',
  ].join('\n');
}

function truncateText(value, maxChars = INTENT_LLM_MAX_MESSAGE_CHARS) {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function normalizeRecentQueriesForIntentLlm(recentQueries = [], options = {}) {
  const compactHistory = Boolean(options?.compactHistory);
  const maxChars = compactHistory ? 80 : 120;
  const maxItems = compactHistory ? INTENT_LLM_MAX_RECENT_QUERIES_WITH_CONTRACT : INTENT_LLM_MAX_RECENT_QUERIES;
  return (Array.isArray(recentQueries) ? recentQueries : [])
    .map((value) => truncateText(value, maxChars))
    .filter(Boolean)
    .slice(-maxItems);
}

function normalizeRecentMessagesForIntentLlm(recentMessages = [], options = {}) {
  const compactHistory = Boolean(options?.compactHistory);
  const maxChars = compactHistory ? INTENT_LLM_MAX_MESSAGE_CHARS_WITH_CONTRACT : INTENT_LLM_MAX_MESSAGE_CHARS;
  const maxItems = compactHistory ? INTENT_LLM_MAX_RECENT_MESSAGES_WITH_CONTRACT : INTENT_LLM_MAX_RECENT_MESSAGES;
  return (Array.isArray(recentMessages) ? recentMessages : [])
    .map((message) => ({
      role: String(message?.role || '').trim() || 'user',
      content: truncateText(message?.content, maxChars),
    }))
    .filter((message) => message.content)
    .slice(-maxItems);
}

function compactSemanticContractForIntentLlm(contract) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) return null;
  const owner = String(contract.owner || '').trim() || null;
  const planner_mode = String(contract.planner_mode || contract.plannerMode || '').trim() || null;
  const request_class = String(contract.request_class || contract.requestClass || '').trim() || null;
  const target_step_family = String(contract.target_step_family || contract.targetStepFamily || '').trim() || null;
  const primary_role_id = String(contract.primary_role_id || contract.primaryRoleId || '').trim() || null;
  const semantic_family = String(contract.semantic_family || contract.semanticFamily || '').trim() || null;
  const source_surface = String(contract.source_surface || contract.sourceSurface || '').trim() || null;
  const support_role_ids = (Array.isArray(contract.support_role_ids) ? contract.support_role_ids : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .slice(0, 4);
  const allowed_step_families = (Array.isArray(contract.allowed_step_families) ? contract.allowed_step_families : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .slice(0, 4);
  const ingredient_hypotheses = (Array.isArray(contract.ingredient_hypotheses) ? contract.ingredient_hypotheses : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .slice(0, 4);
  return {
    owner,
    planner_mode,
    request_class,
    target_step_family,
    primary_role_id,
    support_role_ids,
    semantic_family,
    allowed_step_families,
    ingredient_hypotheses,
    source_surface,
  };
}

function buildIntentLlmInput(latestUserQuery, recentQueries = [], recentMessages = [], options = {}) {
  const semanticContract = compactSemanticContractForIntentLlm(options?.semanticContract);
  const compactHistory = Boolean(semanticContract);
  return JSON.stringify({
    latest_user_query: String(latestUserQuery || ''),
    recent_queries: normalizeRecentQueriesForIntentLlm(recentQueries, { compactHistory }),
    recent_messages: normalizeRecentMessagesForIntentLlm(recentMessages, { compactHistory }),
    ...(semanticContract ? { semantic_contract: semanticContract } : {}),
    output_contract: INTENT_OUTPUT_CONTRACT,
  });
}

function includesAny(haystack, needles) {
  if (!haystack) return false;
  const lowered = String(haystack).toLowerCase();
  return needles.some((k) => lowered.includes(String(k).toLowerCase()));
}

function hasPetSignal(text) {
  const t = String(text || '');
  const lower = t.toLowerCase();
  if (/[\u4e00-\u9fff]/.test(t)) {
    // Chinese / Japanese Kanji coverage (also works for Japanese short queries like "犬 服")
    return ['狗', '狗狗', '小狗', '猫', '猫猫', '宠物', '狗衣服', '宠物衣服', '犬', 'ペット', '犬服', '猫服'].some((k) =>
      t.includes(k)
    );
  }
  // English / Spanish / French
  return /\b(dog|dogs|puppy|cat|cats|pet|pets)\b/.test(lower) ||
    /\b(perro|perros|perrita|cachorro|mascota|mascotas|gato|gatos)\b/.test(lower) ||
    /\b(chien|chiens|chienne|chiot|animal|animaux|chat|chats)\b/.test(lower);
}

function hasPetHarnessSignal(text) {
  const t = String(text || '');
  const lower = t.toLowerCase();
  if (!t) return false;
  return (
    /背带|背帶|胸背|牵引|牽引|牵引绳|牽引繩|遛狗绳|狗链|狗鏈|狗链子|狗鏈子|项圈|項圈|胸背带|胸背帶|宠物背带|寵物背帶|狗绳|狗繩|犬用ハーネス|ハーネス|リード|首輪/.test(
      t,
    ) ||
    /\b(harness|leash|collar|lead|no-?pull|dog\s+harness|dog\s+leash|pet\s+harness|pet\s+leash)\b/.test(
      lower,
    ) ||
    /\b(arn[eé]s|correa|collier|harnais)\b/.test(lower)
  );
}

function hasToyStrongSignal(text) {
  return includesAny(text, TOY_KEYWORDS_STRONG);
}

function hasHikingSignal(text) {
  const t = String(text || '');
  const lower = t.toLowerCase();
  if (/[\u4e00-\u9fff]/.test(t)) {
    return ['登山', '徒步', '爬山', '露营', '山上', 'ハイキング', '登山', '山', '寒い'].some((k) => t.includes(k));
  }
  return (
    /\b(hiking|trail|camping|mountain|trek|trekking)\b/.test(lower) ||
    /\b(senderismo|caminata|excursi[oó]n|monta[nñ]a)\b/.test(lower) ||
    /\b(randonn[eé]e|montagne|trek)\b/.test(lower)
  );
}

function hasBeautyToolSignal(text) {
  const t = String(text || '');
  const lower = t.toLowerCase();
  // Japanese: keep strict enough to avoid tooth-brush etc; require makeup context.
  if (/[\u3040-\u30ff]/.test(t)) {
    const hasBrush = /ブラシ|メイクブラシ|ブラシセット|化粧筆/.test(t);
    const hasMakeup = /メイク|化粧/.test(t);
    return hasBrush && hasMakeup;
  }
  // Chinese (Han): common tool keywords
  if (/[\u4e00-\u9fff]/.test(t)) {
    return /化妆刷|刷具|粉底刷|散粉刷|腮红刷|修容刷|遮瑕刷|眼影刷|晕染刷|美妆蛋|粉扑|睫毛夹/.test(t);
  }
  // Latin: makeup brush/sponge terms
  return /\b(makeup|cosmetic)\b/.test(lower) && /\b(brush|brushes|sponge|puff)\b/.test(lower);
}

function hasBeautyGeneralSignal(text) {
  const t = String(text || '');
  if (!t) return false;
  const lower = t.toLowerCase();
  if (/[\u4e00-\u9fff]/.test(t)) {
    return /化妆|化妝|妆容|妝容|彩妆|彩妝|美妆|美妝|护肤|護膚|底妆|底妝|眼妆|眼妝|唇妆|唇妝|约会妆|約會妝|出差护肤|出差護膚|旅行护肤|旅行護膚/.test(
      t,
    );
  }
  if (/[\u3040-\u30ff]/.test(t)) {
    return /メイク|化粧|スキンケア/.test(t);
  }
  return /\b(makeup|cosmetic|cosmetics|beauty|skincare|skin care)\b/.test(lower);
}

function hasBeautyBrandOrProductSignal(text) {
  const t = String(text || '');
  if (!t) return false;
  const lower = t.toLowerCase();

  const brandOrProductCue =
    /ipsa|茵芙莎|winona|薇诺娜/.test(lower) ||
    /流金水|化妆水|爽肤水|精华|精华液|乳液|面霜|防晒|防晒霜|洁面|洗面奶|面膜|化粧水|美容液|日焼け止め/.test(t) ||
    /\b(serum|essence|toner|lotion|moisturizer|cleanser|sunscreen|cream|foundation|cushion|lipstick)\b/.test(lower) ||
    /\b(suero|esencia|t[oó]nico|loci[oó]n|hidratante|limpiador|protector solar|crema|base)\b/.test(lower) ||
    /\b(s[eé]rum|essence|tonique|lotion|hydratant|nettoyant|cr[eè]me|fond de teint)\b/.test(lower);

  const availabilityCue =
    /有货|库存|有没有|能买吗|哪里买|available|availability|in stock|where to buy/.test(lower);

  return brandOrProductCue || (availabilityCue && hasBeautyGeneralSignal(t));
}

function detectLanguageHeuristic(text) {
  const t = String(text || '');
  if (!t) return 'other';
  if (/[\u3040-\u30ff]/.test(t)) return 'ja';
  if (/[\uac00-\ud7af]/.test(t)) return 'ko';
  if (/[\u4e00-\u9fff]/.test(t)) return 'zh';
  const lower = t.toLowerCase();
  if (/[¿¡ñáéíóúü]/i.test(t) || /\b(senderismo|perro|mascota|ropa|fr[ií]o)\b/.test(lower)) return 'es';
  if (/[çœàâæéèêëîïôœùûüÿ]/i.test(t) || /\b(randonn[eé]e|chien|v[eê]tement|froid)\b/.test(lower)) return 'fr';
  return 'en';
}

function applyHardOverrides(latestQuery, intent) {
  const q = String(latestQuery || '');
  if (!intent || typeof intent !== 'object') return intent;
  const language = detectLanguageHeuristic(q);

  // Priority rule (enforced): latest query dominates target_object decisions.
  // If user is clearly asking for pet apparel, do not let history or vague wording override it.
  if (hasPetSignal(q) && !hasToyStrongSignal(q)) {
    const hasHarnessIntent = hasPetHarnessSignal(q);
    const scenarioName = hasHarnessIntent
      ? 'pet_harness'
      : hasHikingSignal(q)
      ? 'pet_hiking'
      : 'pet_apparel_general';
    const queryClass = 'category';
    const requiredCategories = hasHarnessIntent
      ? ['pet_accessory', 'pet_harness', 'pet_leash']
      : ['pet_apparel', 'dog_jacket', 'dog_sweater'].slice(0, 3);
    const patched = {
      ...intent,
      language,
      primary_domain: 'sports_outdoor',
      target_object: { ...(intent.target_object || {}), type: 'pet', age_group: 'all' },
      category: {
        required: requiredCategories,
        optional: Array.isArray(intent.category?.optional) ? intent.category.optional : [],
      },
      scenario: {
        name: scenarioName,
        signals: Array.isArray(intent.scenario?.signals) ? intent.scenario.signals : [],
      },
      hard_constraints: {
        ...(intent.hard_constraints || {}),
        must_exclude_domains: Array.from(
          new Set([...(intent.hard_constraints?.must_exclude_domains || []), 'toy_accessory'])
        ),
        must_exclude_keywords: Array.from(
          new Set([
            ...(intent.hard_constraints?.must_exclude_keywords || []),
            'Labubu',
            'doll',
            'vinyl face doll',
            '娃娃',
            '公仔',
            '娃衣',
            '盲盒',
          ])
        ).slice(0, 16),
      },
      history_usage: {
        ...(intent.history_usage || {}),
        used: Boolean(intent.history_usage?.used),
        reason: intent.history_usage?.used
          ? intent.history_usage.reason
          : hasHarnessIntent
          ? 'Pet harness/leash intent detected from latest query; history not allowed to override target_object.'
          : 'Pet apparel intent detected from latest query; history not allowed to override target_object.',
      },
      query_class: queryClass,
    };
    return PivotaIntentV1Zod.parse(patched);
  }

  // Beauty tools: if the latest query is clearly about makeup tools, force a
  // tool-first scenario so non-tool products (e.g., apparel) are blocked.
  if (hasBeautyToolSignal(q)) {
    const patched = {
      ...intent,
      language,
      primary_domain: 'beauty',
      target_object: {
        ...(intent.target_object || {}),
        type: 'human',
        age_group: intent.target_object?.age_group || 'all',
      },
      category: {
        required: ['cosmetic_tools'],
        optional: Array.isArray(intent.category?.optional) ? intent.category.optional : [],
      },
      scenario: {
        name: 'beauty_tools',
        signals: Array.isArray(intent.scenario?.signals) ? intent.scenario.signals : [],
      },
      history_usage: {
        ...(intent.history_usage || {}),
        used: Boolean(intent.history_usage?.used),
        reason: intent.history_usage?.used
          ? intent.history_usage.reason
          : 'Beauty tools intent detected from latest query; forcing tool-first scenario.',
      },
    };
    return PivotaIntentV1Zod.parse(patched);
  }

  if (hasBeautyGeneralSignal(q)) {
    const patched = {
      ...intent,
      language,
      primary_domain: 'beauty',
      target_object: {
        ...(intent.target_object || {}),
        type: 'human',
        age_group: intent?.target_object?.age_group || 'all',
      },
      category: {
        required: [],
        optional: Array.isArray(intent?.category?.optional) ? intent.category.optional : [],
      },
      scenario: {
        name: 'general',
        signals: Array.isArray(intent?.scenario?.signals) ? intent.scenario.signals : [],
      },
      history_usage: {
        ...(intent.history_usage || {}),
        used: Boolean(intent.history_usage?.used),
        reason: intent.history_usage?.used
          ? intent.history_usage.reason
          : 'Beauty intent detected from latest query; keeping non-tool beauty scenario.',
      },
    };
    return PivotaIntentV1Zod.parse(patched);
  }

  const humanApparelCategories = extractHumanApparelCategories(q);
  if (humanApparelCategories.length > 0) {
    const patched = {
      ...intent,
      language,
      primary_domain: 'human_apparel',
      target_object: {
        ...(intent.target_object || {}),
        type: 'human',
        age_group: intent?.target_object?.age_group || 'adult',
      },
      category: {
        required: humanApparelCategories,
        optional: Array.isArray(intent?.category?.optional) ? intent.category.optional : [],
      },
      scenario: {
        name: 'human_apparel_general',
        signals: Array.isArray(intent?.scenario?.signals) ? intent.scenario.signals : [],
      },
      hard_constraints: {
        ...(intent.hard_constraints || {}),
        must_exclude_domains: Array.from(
          new Set([...(intent.hard_constraints?.must_exclude_domains || []), 'toy_accessory'])
        ),
        must_exclude_keywords: Array.from(
          new Set([
            ...(intent.hard_constraints?.must_exclude_keywords || []),
            'Labubu',
            'doll',
            'vinyl face doll',
            '娃娃',
            '公仔',
            '娃衣',
            '盲盒',
          ])
        ).slice(0, 16),
      },
      history_usage: {
        ...(intent.history_usage || {}),
        used: false,
        reason: 'Human apparel category detected from latest query; overriding ambiguous domain classification.',
      },
      query_class: 'category',
    };
    return PivotaIntentV1Zod.parse(patched);
  }

  // Brand/product lookup (non-tool) should not stay locked in tool-first scenarios
  // due to prior conversation history.
  if (!hasBeautyToolSignal(q) && hasBeautyBrandOrProductSignal(q)) {
    const scenarioName = String(intent?.scenario?.name || '');
    const requiredCategories = Array.isArray(intent?.category?.required) ? intent.category.required : [];
    const hasToolLockedScenario =
      scenarioName === 'beauty_tools' ||
      scenarioName === 'eye_shadow_brush' ||
      requiredCategories.some((c) => /cosmetic_tools|eye_shadow_brush|eye_brush|brush/i.test(String(c || '')));

    if (hasToolLockedScenario) {
      const nextRequired = requiredCategories.filter(
        (c) => !/cosmetic_tools|eye_shadow_brush|eye_brush|brush/i.test(String(c || '')),
      );
      const patched = {
        ...intent,
        language,
        primary_domain: intent?.primary_domain === 'beauty' ? 'beauty' : intent?.primary_domain || 'other',
        target_object: {
          ...(intent.target_object || {}),
          type: 'human',
          age_group: intent?.target_object?.age_group || 'all',
        },
        category: {
          required: nextRequired,
          optional: Array.isArray(intent?.category?.optional) ? intent.category.optional : [],
        },
        scenario: {
          name: 'general',
          signals: [],
        },
        history_usage: {
          ...(intent.history_usage || {}),
          used: false,
          reason:
            'Detected brand/product lookup in latest query; skipped tool-first carryover from prior turns.',
        },
      };
      return PivotaIntentV1Zod.parse(patched);
    }
  }

  // Always normalize language to match the query (LLMs may default to English).
  const patched = { ...intent, language };
  return PivotaIntentV1Zod.parse(patched);
}

async function extractIntentWithOpenAI(latest_user_query, recent_queries = [], recent_messages = [], options = {}) {
  const model = String(options?.model || resolveIntentOpenAiModel().model || 'gpt-5.1-mini').trim() || 'gpt-5.1-mini';
  const openai = getOpenAIClient();
  const input = buildIntentLlmInput(latest_user_query, recent_queries, recent_messages, options);

  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'developer', content: buildDeveloperPrompt() },
    {
      role: 'user',
      content: input,
    },
  ];

  const completion = await openai.chat.completions.create(
    {
      model,
      messages,
      // Best-effort hint; model/policy may ignore.
      response_format: { type: 'json_object' },
    },
    options?.signal ? { signal: options.signal } : undefined,
  );

  const content = completion?.choices?.[0]?.message?.content || '';
  let parsed;
  try {
    parsed = parseIntentJsonObject(content, 'Intent LLM');
  } catch (err) {
    throw annotateIntentLlmError(err, {
      finish_reason:
        String(completion?.choices?.[0]?.finish_reason || completion?.choices?.[0]?.finishReason || '').trim() ||
        null,
      raw_preview: trimIntentLlmText(content, 160),
      candidate_count: Array.isArray(completion?.choices) ? completion.choices.length : null,
    });
  }
  return PivotaIntentV1Zod.parse(parsed);
}

async function extractIntentWithGemini(latest_user_query, recent_queries = [], recent_messages = [], options = {}) {
  const apiKey = resolveFindProductsGeminiApiKey();
  if (!apiKey) {
    throw new Error('Gemini API key is not set');
  }

  const model = String(options?.model || resolveIntentGeminiModel().model || 'gemini-3-flash-preview').trim() ||
    'gemini-3-flash-preview';
  const baseURL =
    (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');

  const url = `${baseURL}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const systemText = `${buildSystemPrompt()}\n\n${buildDeveloperPrompt()}`;
  const userText = buildIntentLlmInput(latest_user_query, recent_queries, recent_messages, options);

  const body = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      topK: 1,
      topP: 0.1,
      maxOutputTokens: INTENT_LLM_GEMINI_MAX_OUTPUT_TOKENS,
    },
  };

  const res = await axios.post(url, body, {
    timeout: Math.max(
      1000,
      Math.min(
        INTENT_LLM_PROVIDER_TIMEOUT_MS,
        Number.isFinite(Number(options?.timeoutMs)) && Number(options.timeoutMs) > 0
          ? Number(options.timeoutMs)
          : INTENT_LLM_PROVIDER_TIMEOUT_MS,
      ),
    ),
    ...(options?.signal ? { signal: options.signal } : {}),
  });
  const text =
    res?.data?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join('') || '';
  let parsed;
  try {
    parsed = parseIntentJsonObject(text, 'Gemini intent');
  } catch (err) {
    throw annotateIntentLlmError(err, {
      finish_reason:
        String(res?.data?.candidates?.[0]?.finishReason || res?.data?.candidates?.[0]?.finish_reason || '').trim() ||
        null,
      raw_preview: trimIntentLlmText(text, 160),
      candidate_count: Array.isArray(res?.data?.candidates) ? res.data.candidates.length : null,
    });
  }
  return PivotaIntentV1Zod.parse(parsed);
}

async function extractIntent(latest_user_query, recent_queries = [], recent_messages = []) {
  const result = await extractIntentWithMeta(latest_user_query, recent_queries, recent_messages);
  return result.intent;
}

async function extractIntentWithMeta(latest_user_query, recent_queries = [], recent_messages = [], options = {}) {
  const plan = resolveIntentLlmExecutionPlan(options);
  if (!plan.enabled) {
    const fallback = buildDeterministicIntentWithMeta(
      latest_user_query,
      recent_queries,
      recent_messages,
      plan.disabledReason === 'master_disabled'
        ? 'llm_master_disabled'
        : 'llm_unconfigured',
    );
    fallback.meta = applyIntentExecutionMeta(fallback.meta, plan, null);
    return fallback;
  }
  try {
    const primary = plan.primaryProvider;
    const fallback = plan.fallbackProvider;

    const run = async (provider, stage) => {
      try {
        if (provider === 'openai') {
          return await extractIntentWithOpenAI(latest_user_query, recent_queries, recent_messages, {
            ...options,
            model: plan.primaryProvider === 'openai' ? plan.primaryModel : plan.fallbackModel,
          });
        }
        if (provider === 'gemini') {
          return await extractIntentWithGemini(latest_user_query, recent_queries, recent_messages, {
            ...options,
            model: plan.primaryProvider === 'gemini' ? plan.primaryModel : plan.fallbackModel,
          });
        }
        throw new Error(`Unsupported intent provider: ${provider}`);
      } catch (err) {
        throw annotateIntentLlmError(err, {
          provider,
          stage,
        });
      }
    };

    try {
      const intent = await run(primary, 'primary');
      return {
        intent: applyHardOverrides(latest_user_query, intent),
        meta: applyIntentExecutionMeta({
          applied: true,
          mode: 'llm',
          provider: primary,
          fallback_reason: null,
        }, plan, primary),
      };
    } catch (primaryErr) {
      if (!fallback || fallback === primary) throw primaryErr;
      const intent = await run(fallback, 'fallback');
      return {
        intent: applyHardOverrides(latest_user_query, intent),
        meta: applyIntentExecutionMeta({
          applied: true,
          mode: 'llm',
          provider: fallback,
          fallback_reason: `primary_${primary}_failed`,
        }, plan, fallback),
      };
    }
  } catch (err) {
    // Fail-safe: never block search; fall back to deterministic extraction.
    const fallback = buildDeterministicIntentWithMeta(
      latest_user_query,
      recent_queries,
      recent_messages,
      'llm_failed',
    );
    fallback.meta = applyIntentExecutionMeta({
      ...(fallback.meta || {}),
      ...normalizeIntentLlmError(err),
    }, plan, null);
    return fallback;
  }
}

module.exports = {
  buildDeterministicIntentWithMeta,
  extractIntentWithOpenAI,
  extractIntentWithGemini,
  extractIntent,
  extractIntentWithMeta,
  _debug: {
    applyHardOverrides,
    buildIntentLlmInput,
    compactSemanticContractForIntentLlm,
    hasBeautyBrandOrProductSignal,
    isEnabled,
    normalizeIntentLlmError,
    parseIntentJsonObject,
    resolveIntentGeminiModel,
    resolveIntentLlmExecutionPlan,
    resolveIntentOpenAiModel,
    resolveIntentProviderModel,
    resolveFindProductsGeminiApiKey,
    resolveFindProductsLlmRuntime,
    resolveFindProductsOpenAiApiKey,
  },
};
