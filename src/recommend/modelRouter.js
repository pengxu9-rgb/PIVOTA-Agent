const OpenAI = require('openai');
const { validateCopyOverrides } = require('./validators');
const { ERROR_CODES } = require('./errors');

const MODEL_ID = process.env.RECOMMEND_LLM_MODEL || 'gpt-4o-mini';
const MAX_LLM_MS = Number(process.env.RECOMMEND_LLM_BUDGET_MS || 2000);

function buildPrompt({ items, persona, copyPack }) {
  const introStyle = copyPack.intro_style_id || 'INTRO_WARM_SHORT';
  const signature = persona?.signature_phrases || [];
  const allowedEmojis = persona?.allowed_emojis || [];
  const instructions = `
You produce ONLY JSON with keys: intro_text, items, follow_up_question_id.
Rules:
- Only allowed placeholder is {{NAME}}. No other { or }.
- Do NOT use digits or currency symbols.
- Do NOT output brand names, product names, URLs, prices, facts.
- Keep it short. Max one sentence per field.
- Tone: ${persona?.tone_tag || 'warm'} with emoji level ${(persona?.emoji_level ?? 0)}.
- Allowed signature phrases: ${signature.join(' | ') || 'none'}; use at most one overall.
- Allowed emojis: ${allowedEmojis.join(' ')}.
- intro_style_id: ${introStyle}.
`;
  const safeItems = items.map((p) => ({
    product_id: p.product_id,
    safe_display_name: p.safe_display_name,
    safe_features: p.safe_features?.slice(0, 3) || [],
    reason_codes: p.reason_codes || [],
  }));
  return {
    system: instructions,
    user: JSON.stringify({ items: safeItems }),
  };
}

async function runOpenAICompletion(messages, abortSignal) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client.chat.completions.create(
    {
      model: MODEL_ID,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      response_format: { type: 'json_object' },
    },
    { signal: abortSignal },
  );
}

async function maybeGenerateCopy({
  items,
  persona,
  copyPack,
  allow,
  expectedProductIds,
  maxItems,
  requireExactCount = false,
}) {
  if (!allow) {
    return { used: false, skipReason: 'DISABLED', copy: null };
  }
  if (!process.env.OPENAI_API_KEY) {
    return { used: false, skipReason: 'NO_API_KEY', copy: null };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAX_LLM_MS);
  try {
    const prompt = buildPrompt({ items, persona, copyPack });
    const res = await runOpenAICompletion(
      [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      controller.signal,
    );
    const content = res.choices?.[0]?.message?.content;
    if (!content) {
      return { used: false, skipReason: ERROR_CODES.PROVIDER_DOWN, copy: null };
    }
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      return { used: false, skipReason: ERROR_CODES.VALIDATION_FAIL, copy: null };
    }
    const validation = validateCopyOverrides(parsed, expectedProductIds, maxItems, requireExactCount);
    if (!validation.valid) {
      return { used: false, skipReason: ERROR_CODES.VALIDATION_FAIL, copy: null };
    }
    return { used: true, skipReason: null, copy: parsed };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { used: false, skipReason: ERROR_CODES.BUDGET_SKIP, copy: null };
    }
    return { used: false, skipReason: ERROR_CODES.LLM_TIMEOUT, copy: null };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  maybeGenerateCopy,
};
