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
    return ['狗', '狗狗', '小狗', '猫', '猫猫', '宠物', '狗衣服', '宠物衣服'].some((k) => t.includes(k));
  }
  return /\b(dog|dogs|puppy|cat|cats|pet|pets)\b/.test(lower);
}

function hasToyStrongSignal(text) {
  return includesAny(text, TOY_KEYWORDS_STRONG);
}

function hasHikingSignal(text) {
  const t = String(text || '');
  const lower = t.toLowerCase();
  if (/[\u4e00-\u9fff]/.test(t)) {
    return ['登山', '徒步', '爬山', '露营', '山上'].some((k) => t.includes(k));
  }
  return /\b(hiking|trail|camping|mountain)\b/.test(lower);
}

function applyHardOverrides(latestQuery, intent) {
  const q = String(latestQuery || '');
  if (!intent || typeof intent !== 'object') return intent;

  // Priority rule (enforced): latest query dominates target_object decisions.
  // If user is clearly asking for pet apparel, do not let history or vague wording override it.
  if (hasPetSignal(q) && !hasToyStrongSignal(q)) {
    const scenarioName = hasHikingSignal(q) ? 'pet_hiking' : 'pet_apparel_general';
    const patched = {
      ...intent,
      primary_domain: 'sports_outdoor',
      target_object: { ...(intent.target_object || {}), type: 'pet', age_group: 'all' },
      category: {
        required: ['pet_apparel', 'dog_jacket', 'dog_sweater'].slice(0, 3),
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
          : 'Pet apparel intent detected from latest query; history not allowed to override target_object.',
      },
    };
    return PivotaIntentV1Zod.parse(patched);
  }

  return intent;
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
    return extractIntentRuleBased(latest_user_query, recent_queries, recent_messages);
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
    return extractIntentRuleBased(latest_user_query, recent_queries, recent_messages);
  }
}

module.exports = {
  extractIntentWithOpenAI,
  extractIntentWithGemini,
  extractIntent,
};
