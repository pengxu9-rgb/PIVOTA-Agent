const test = require('node:test');
const assert = require('node:assert/strict');

const { SkillRouter } = require('../src/auroraBff/orchestrator/skill_router');

test('skill_router keeps generic analysis follow-up out of product.analyze', async () => {
  const calls = [];
  const router = new SkillRouter({
    async call(payload) {
      calls.push(payload);
      assert.equal(payload.templateId, 'intent_classifier');
      return {
        parsed: {
          intent: 'product_analysis',
          confidence: 0.91,
          entities: {
            products: ['这个分析'],
            user_question: '这个分析里最该先改哪一步？',
          },
        },
        promptHash: 'classifier_hash',
      };
    },
    async chat() {
      return {
        parsed: {
          answer_en: 'Start with the highest-priority routine gap.',
          answer_zh: '先改最高优先级的 routine 缺口。',
        },
        text: 'Start with the highest-priority routine gap.',
      };
    },
  });

  const response = await router.route({
    context: {
      profile: {},
      locale: 'zh-CN',
    },
    params: {
      user_message: '这个分析里最该先改哪一步？',
      message: '这个分析里最该先改哪一步？',
      text: '这个分析里最该先改哪一步？',
    },
    thread_state: {},
  });

  assert.equal(response.telemetry.skill_id, 'chat.freeform');
  assert.equal(calls.length, 1);
  assert.equal(response.cards[0]?.card_type, 'text_response');
});
