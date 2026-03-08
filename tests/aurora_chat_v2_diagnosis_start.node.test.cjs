const test = require('node:test');
const assert = require('node:assert/strict');

const DiagnosisStartSkill = require('../src/auroraBff/skills/diagnosis_v2_start');
const { LlmQualityError } = require('../src/auroraBff/services/llm_gateway');

function makeRequest(profile = {}) {
  return {
    context: {
      locale: 'en',
      profile,
    },
  };
}

test('diagnosis_v2_start gracefully degrades when personalized follow-up schema validation fails', async () => {
  const skill = new DiagnosisStartSkill();
  const llmGateway = {
    async call() {
      throw new LlmQualityError('LLM output failed schema validation: DiagnosisStartOutput');
    },
  };

  const result = await skill.execute(
    makeRequest({ skin_type: 'oily', concerns: ['acne'] }),
    llmGateway,
  );

  assert.equal(result._llmCalls, 1);
  assert.equal(result._promptHash, null);
  assert.equal(result.cards[0].card_type, 'diagnosis_gate');
  assert.equal(result.cards[0].sections.some((section) => section.type === 'follow_up_questions'), false);
  assert.equal(result.cards[0].sections[0].type, 'goal_selection');
  assert.deepEqual(
    result.next_actions.map((action) => action.action_type),
    ['request_input', 'trigger_photo'],
  );
});

test('diagnosis_v2_start preserves personalized follow-up questions when llm succeeds', async () => {
  const skill = new DiagnosisStartSkill();
  const llmGateway = {
    async call() {
      return {
        parsed: {
          follow_up_questions: [
            {
              question_en: 'Which area bothers you most?',
              question_zh: '你最在意哪个部位？',
              options: [{ id: 't_zone', label_en: 'T-zone', label_zh: 'T区' }],
            },
          ],
        },
        promptHash: 'prompt_hash_ok',
      };
    },
  };

  const result = await skill.execute(
    makeRequest({ skin_type: 'combination', concerns: ['pores'] }),
    llmGateway,
  );

  assert.equal(result._llmCalls, 1);
  assert.equal(result._promptHash, 'prompt_hash_ok');
  assert.equal(result.cards[0].sections.some((section) => section.type === 'follow_up_questions'), true);
});

test('diagnosis_v2_start rethrows non-quality llm errors', async () => {
  const skill = new DiagnosisStartSkill();
  const llmGateway = {
    async call() {
      throw new Error('network timeout');
    },
  };

  await assert.rejects(
    () => skill.execute(makeRequest({ skin_type: 'dry', concerns: ['redness'] }), llmGateway),
    /network timeout/,
  );
});
