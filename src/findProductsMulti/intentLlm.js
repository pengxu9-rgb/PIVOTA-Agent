const OpenAI = require('openai');
const axios = require('axios');
const intentSchema = require('../schemas/intent.v1.json');
const {
  PivotaIntentV1Zod,
  extractIntentRuleBased,
  TOY_KEYWORDS_STRONG,
} = require('./intent');

function isEnabled() {
  return process.env.PIVOTA_INTENT_LLM_ENABLED === 'true';
}

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set');
  const baseURL = process.env.OPENAI_BASE_URL || undefined;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY, ...(baseURL ? { baseURL } : {}) });
}

function buildSystemPrompt() {
  return [
    'You are an intent extraction component for an e-commerce agent.',
    'Output MUST be a single JSON object that conforms to the provided JSON Schema (PivotaIntentV1).',
    'Do not output markdown, comments, or additional keys.',
    '',
    'Priority rule:',
    '- The latest user query dominates domain + target_object decisions.',
    '- Conversation history / recent_queries may ONLY be used as soft_preferences or to resolve explicit references like "same as before".',
    '- Never let toy-related history override a clear human apparel request.',
    '',
    'If uncertain:',
    '- Fill unknown fields with null/unknown,',
    '- Lower confidence scores,',
    '- Set ambiguity.needs_clarification=true and propose up to 3 clarifying questions.',
  ].join('\n');
}

function buildDeveloperPrompt() {
  return [
    'Input fields:',
    '1) latest_user_query: string',
    '2) recent_queries: string[]',
    '3) recent_messages: [{role, content}] (optional)',
    '',
    'You must:',
    '- Decide primary_domain and target_object.',
    '- Extract required categories into category.required (hard).',
    '- Put weaker guesses into category.optional (soft).',
    '- Add hard_constraints.must_exclude_domains/keywords when appropriate:',
    '  - If target_object=human, exclude toy_accessory and keywords like doll/toy/Labubu/娃娃/公仔.',
    '- Set history_usage.used=false if the latest query is clear and history is unrelated.',
    '',
    'Return JSON only.',
  ].join('\n');
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

  return brandOrProductCue || availabilityCue;
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

async function extractIntentWithOpenAI(latest_user_query, recent_queries = [], recent_messages = []) {
  const model = process.env.PIVOTA_INTENT_MODEL || 'gpt-5.1-mini';
  const openai = getOpenAIClient();

  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'developer', content: buildDeveloperPrompt() },
    {
      role: 'user',
      content: JSON.stringify(
        {
          latest_user_query: String(latest_user_query || ''),
          recent_queries: Array.isArray(recent_queries) ? recent_queries : [],
          recent_messages: Array.isArray(recent_messages) ? recent_messages : [],
          schema: intentSchema,
        },
        null,
        2
      ),
    },
  ];

  const completion = await openai.chat.completions.create({
    model,
    messages,
    // Best-effort hint; model/policy may ignore.
    response_format: { type: 'json_object' },
  });

  const content = completion?.choices?.[0]?.message?.content || '';
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`Intent LLM did not return valid JSON: ${String(err)}`);
  }

  return PivotaIntentV1Zod.parse(parsed);
}

async function extractIntentWithGemini(latest_user_query, recent_queries = [], recent_messages = []) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set');
  }

  const model = process.env.PIVOTA_INTENT_MODEL_GEMINI || process.env.PIVOTA_INTENT_MODEL || 'gemini-1.5-flash';
  const baseURL =
    (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');

  const url = `${baseURL}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(
    process.env.GEMINI_API_KEY
  )}`;

  const systemText = `${buildSystemPrompt()}\n\n${buildDeveloperPrompt()}`;
  const userText = JSON.stringify(
    {
      latest_user_query: String(latest_user_query || ''),
      recent_queries: Array.isArray(recent_queries) ? recent_queries : [],
      recent_messages: Array.isArray(recent_messages) ? recent_messages : [],
      schema: intentSchema,
    },
    null,
    2
  );

  const body = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
    },
  };

  const res = await axios.post(url, body, { timeout: 12000 });
  const text =
    res?.data?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join('\n') || '';

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Gemini intent did not return valid JSON: ${String(err)}`);
  }

  return PivotaIntentV1Zod.parse(parsed);
}

async function extractIntent(latest_user_query, recent_queries = [], recent_messages = []) {
  if (!isEnabled()) {
    const intent = extractIntentRuleBased(latest_user_query, recent_queries, recent_messages);
    try {
      return applyHardOverrides(latest_user_query, intent);
    } catch (err) {
      return intent;
    }
  }
  try {
    const primary = (process.env.PIVOTA_INTENT_LLM_PROVIDER || 'openai').toLowerCase();
    const fallback = (process.env.PIVOTA_INTENT_LLM_FALLBACK_PROVIDER || 'gemini').toLowerCase();

    const run = async (provider) => {
      if (provider === 'openai') {
        return await extractIntentWithOpenAI(latest_user_query, recent_queries, recent_messages);
      }
      if (provider === 'gemini') {
        return await extractIntentWithGemini(latest_user_query, recent_queries, recent_messages);
      }
      throw new Error(`Unsupported intent provider: ${provider}`);
    };

    try {
      const intent = await run(primary);
      return applyHardOverrides(latest_user_query, intent);
    } catch (primaryErr) {
      if (!fallback || fallback === primary) throw primaryErr;
      const intent = await run(fallback);
      return applyHardOverrides(latest_user_query, intent);
    }
  } catch (err) {
    // Fail-safe: never block search; fall back to deterministic extraction.
    const intent = extractIntentRuleBased(latest_user_query, recent_queries, recent_messages);
    return applyHardOverrides(latest_user_query, intent);
  }
}

module.exports = {
  extractIntentWithOpenAI,
  extractIntentWithGemini,
  extractIntent,
};
