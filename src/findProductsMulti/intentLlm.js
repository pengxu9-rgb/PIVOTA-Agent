const OpenAI = require('openai');
const intentSchema = require('../schemas/intent.v1.json');
const { PivotaIntentV1Zod, extractIntentRuleBased } = require('./intent');

function isEnabled() {
  return process.env.PIVOTA_INTENT_LLM_ENABLED === 'true';
}

function getClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set');
  }
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
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

async function extractIntentWithLLM(latest_user_query, recent_queries = [], recent_messages = []) {
  const model = process.env.PIVOTA_INTENT_MODEL || 'gpt-5.1-mini';
  const openai = getClient();

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

async function extractIntent(latest_user_query, recent_queries = [], recent_messages = []) {
  if (!isEnabled()) {
    return extractIntentRuleBased(latest_user_query, recent_queries, recent_messages);
  }
  try {
    return await extractIntentWithLLM(latest_user_query, recent_queries, recent_messages);
  } catch (err) {
    // Fail-safe: never block search; fall back to deterministic extraction.
    return extractIntentRuleBased(latest_user_query, recent_queries, recent_messages);
  }
}

module.exports = {
  extractIntentWithLLM,
  extractIntent,
};

