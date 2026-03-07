const BaseSkill = require('./BaseSkill');

class RoutineIntakeProductsSkill extends BaseSkill {
  constructor() {
    super('routine.intake_products', '1.0.0');
  }

  async checkPreconditions(request) {
    const routine = request.context?.current_routine;
    if (!routine || !routine.steps?.length) {
      const hasAmOrPm = routine?.am_steps?.length > 0 || routine?.pm_steps?.length > 0;
      if (!hasAmOrPm) {
        return {
          met: false,
          failures: [
            {
              rule_id: 'pre_has_routine_skeleton',
              reason: 'No routine skeleton available',
              on_fail_target: 'routine.apply_blueprint',
              on_fail_message_en: 'Set up your routine framework first.',
              on_fail_message_zh: '请先建立你的护肤流程框架。',
            },
          ],
        };
      }
    }
    return { met: true, failures: [] };
  }

  async execute(request, llmGateway) {
    const { context, params } = request;
    const products = params?.products || [];

    if (products.length === 0) {
      return {
        cards: [
          {
            card_type: 'routine',
            sections: [
              {
                type: 'product_intake_prompt',
                title_en: 'What products are you currently using?',
                title_zh: '你目前在用哪些产品？',
                hint_en: 'Share brand names, product names, or paste product links',
                hint_zh: '分享品牌名、产品名，或粘贴产品链接',
              },
            ],
          },
        ],
        ops: {
          thread_ops: [],
          profile_patch: {},
          routine_patch: {},
          experiment_events: [],
        },
        next_actions: [
          {
            action_type: 'request_input',
            label: { en: 'Type or paste your products', zh: '输入或粘贴你的产品' },
          },
          {
            action_type: 'show_chip',
            label: { en: 'Skip — recommend products for me', zh: '跳过——帮我推荐产品' },
            params: { navigate_to: 'reco.step_based' },
          },
        ],
        _taskMode: 'routine',
        _llmCalls: 0,
      };
    }

    const llmResult = await llmGateway.call({
      templateId: 'routine_categorize_products',
      taskMode: 'routine',
      params: {
        products,
        routine: context.current_routine,
        locale: context.locale || 'en',
      },
      schema: 'ProductCategorizationOutput',
    });

    const categorized = llmResult.parsed?.categorized_products || [];
    const unresolved = llmResult.parsed?.unresolved || [];

    return {
      cards: [
        {
          card_type: 'routine',
          sections: [
            {
              type: 'routine_structured',
              routine_id: context.current_routine?.routine_id,
              categorized_products: categorized,
              unresolved_products: unresolved,
            },
          ],
        },
      ],
      ops: {
        thread_ops: [],
        profile_patch: {},
        routine_patch: {
          products_added: categorized,
        },
        experiment_events: [],
      },
      next_actions: [
        {
          action_type: 'navigate_skill',
          target_skill_id: 'routine.audit_optimize',
          label: { en: 'Check for conflicts & optimize', zh: '检查冲突并优化' },
        },
      ],
      _promptHash: llmResult.promptHash,
      _taskMode: 'routine',
      _llmCalls: 1,
    };
  }
}

module.exports = RoutineIntakeProductsSkill;
