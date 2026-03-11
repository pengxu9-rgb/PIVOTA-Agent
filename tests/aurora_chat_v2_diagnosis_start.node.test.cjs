const test = require('node:test');
const assert = require('node:assert/strict');

const DiagnosisStartSkill = require('../src/auroraBff/skills/diagnosis_v2_start');
const { LlmQualityError } = require('../src/auroraBff/services/llm_gateway');
const { resolveSkillId } = require('../src/auroraBff/orchestrator/skill_router');

function makeRequest(profile = {}) {
  return {
    context: {
      locale: 'en',
      profile,
    },
  };
}

test('skill_router maps chip.start.diagnosis to diagnosis_v2.start', () => {
  const result = resolveSkillId({ intent: null, threadState: {}, entrySource: 'chip.start.diagnosis' });
  assert.equal(result, 'diagnosis_v2.start');
});

test('skill_router maps chip_start_diagnosis (legacy alias) to diagnosis_v2.start', () => {
  const result = resolveSkillId({ intent: null, threadState: {}, entrySource: 'chip_start_diagnosis' });
  assert.equal(result, 'diagnosis_v2.start');
});

test('skill_router routes diagnosis follow-up to diagnosis_v2.answer when goals exist', () => {
  const result = resolveSkillId({
    intent: null,
    threadState: { diagnosis_goals: ['hydration'] },
    entrySource: 'chip.start.diagnosis',
  });
  assert.equal(result, 'diagnosis_v2.answer');
});

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
  const followUpSection = result.cards[0].sections.find((section) => section.type === 'follow_up_questions');
  assert.ok(followUpSection);
  const question = followUpSection.questions[0];
  assert.equal(question.question, 'Which area bothers you most?');
  assert.equal(question.question_en, 'Which area bothers you most?');
  assert.equal(question.question_zh, '你最在意哪个部位？');
  assert.equal(question.options[0].label, 'T-zone');
  assert.equal(question.options[0].label_en, 'T-zone');
  assert.equal(question.options[0].label_zh, 'T区');
});

test('diagnosis_v2_start normalizes string options from llm output', async () => {
  const skill = new DiagnosisStartSkill();
  const llmGateway = {
    async call() {
      return {
        parsed: {
          follow_up_questions: [
            {
              question_en: 'When does it feel worst?',
              question_zh: '什么时候感觉最明显？',
              options: ['Morning', 'Afternoon', 'Evening'],
            },
          ],
        },
        promptHash: 'prompt_hash_strings',
      };
    },
  };

  const result = await skill.execute(
    makeRequest({ skin_type: 'dry', concerns: ['redness'] }),
    llmGateway,
  );

  const followUpSection = result.cards[0].sections.find((section) => section.type === 'follow_up_questions');
  assert.ok(followUpSection);
  const question = followUpSection.questions[0];
  assert.equal(question.question, 'When does it feel worst?');
  assert.equal(question.options.length, 3);
  assert.equal(question.options[0].label, 'Morning');
  assert.equal(question.options[1].label, 'Afternoon');
  assert.equal(question.options[2].label, 'Evening');
});

test('diagnosis_v2_start never returns empty_state for diagnosis entry', async () => {
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

  assert.equal(result.cards[0].card_type, 'diagnosis_gate');
  assert.notEqual(result.cards[0].card_type, 'empty_state');
  assert.equal(result.cards[0].sections[0].type, 'goal_selection');
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
