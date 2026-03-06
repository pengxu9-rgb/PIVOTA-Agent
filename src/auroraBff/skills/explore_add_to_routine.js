const BaseSkill = require('./BaseSkill');

class ExploreAddToRoutineSkill extends BaseSkill {
  constructor() {
    super('explore.add_to_routine', '1.0.0');
  }

  async checkPreconditions(request) {
    const failures = [];

    if (!request.params?.product_anchor) {
      failures.push({
        rule_id: 'pre_has_product_anchor',
        reason: 'No product to add',
        on_fail_message_en: 'Which product would you like to add to your routine?',
        on_fail_message_zh: '你想把哪个产品加入护肤流程？',
      });
    }

    const routine = request.context?.current_routine;
    const hasRoutine =
      routine && (routine.am_steps?.length > 0 || routine.pm_steps?.length > 0);
    if (!hasRoutine) {
      failures.push({
        rule_id: 'pre_has_routine_skeleton',
        reason: 'No routine to add product to',
        on_fail_target: 'routine.apply_blueprint',
        on_fail_message_en: 'Set up your routine framework first.',
        on_fail_message_zh: '请先建立你的护肤流程框架。',
      });
    }

    return { met: failures.length === 0, failures };
  }

  async execute(request, _llmGateway) {
    const { context, params } = request;
    const routine = context.current_routine;
    const product = params.product_anchor;
    const safetyFlags = context.safety_flags || [];

    const safetyCheck = this._checkSafety(product, safetyFlags);
    if (!safetyCheck.safe) {
      return {
        cards: [
          {
            card_type: 'routine',
            sections: [
              {
                type: 'safety_warning',
                warnings: safetyCheck.warnings,
                product: product,
              },
            ],
          },
        ],
        ops: { thread_ops: [], profile_patch: {}, routine_patch: {}, experiment_events: [] },
        next_actions: [
          {
            action_type: 'navigate_skill',
            target_skill_id: 'product.analyze',
            label: { en: 'Learn more about this product', zh: '了解更多关于这个产品' },
          },
          {
            action_type: 'navigate_skill',
            target_skill_id: 'dupe.suggest',
            label: { en: 'Find a safer alternative', zh: '寻找更安全的替代品' },
          },
        ],
        _taskMode: 'explore',
        _llmCalls: 0,
      };
    }

    const stepAssignment = this._assignStep(product, routine);

    return {
      cards: [
        {
          card_type: 'routine',
          sections: [
            {
              type: 'routine_structured',
              routine_id: routine.routine_id,
              product_added: {
                ...product,
                step_id: stepAssignment.step_id,
                time_of_day: stepAssignment.time_of_day,
                is_new: true,
              },
            },
          ],
        },
      ],
      ops: {
        thread_ops: [],
        profile_patch: {},
        routine_patch: {
          products_added: [
            {
              ...product,
              step_id: stepAssignment.step_id,
              time_of_day: stepAssignment.time_of_day,
              is_new: true,
              added_from: 'explore',
            },
          ],
        },
        experiment_events: [
          {
            event: 'product_added_from_explore',
            step_id: stepAssignment.step_id,
          },
        ],
      },
      next_actions: [
        {
          action_type: 'navigate_skill',
          target_skill_id: 'routine.audit_optimize',
          label: { en: 'Check for conflicts', zh: '检查冲突' },
        },
        {
          action_type: 'navigate_skill',
          target_skill_id: 'tracker.checkin_log',
          label: { en: 'Start tracking', zh: '开始打卡记录' },
        },
      ],
      _taskMode: 'explore',
      _llmCalls: 0,
    };
  }

  _checkSafety(product, safetyFlags) {
    const warnings = [];
    const productConcepts = product.concepts || [];

    const blockedConcepts = new Set();
    for (const flag of safetyFlags) {
      if (flag.includes('BLOCK')) {
        const parts = flag.split('_');
        const conceptIndex = parts.findIndex((p) => p === 'BLOCK');
        if (conceptIndex > 1) {
          blockedConcepts.add(parts.slice(1, conceptIndex).join('_'));
        }
      }
    }

    for (const concept of productConcepts) {
      if (blockedConcepts.has(concept)) {
        warnings.push({
          level: 'BLOCK',
          concept,
          message_en: `This product contains ${concept} which is currently blocked for your safety profile.`,
          message_zh: `该产品含有 ${concept}，根据你的安全设置目前被限制使用。`,
        });
      }
    }

    return {
      safe: warnings.filter((w) => w.level === 'BLOCK').length === 0,
      warnings,
    };
  }

  _assignStep(product, routine) {
    const type = product.product_type || product.category || '';

    const typeToStep = {
      cleanser: { step_id: 'am_cleanser', time_of_day: 'both' },
      toner: { step_id: 'am_toner', time_of_day: 'both' },
      serum: { step_id: 'am_serum', time_of_day: 'both' },
      moisturizer: { step_id: 'am_moisturizer', time_of_day: 'both' },
      sunscreen: { step_id: 'am_sunscreen', time_of_day: 'am' },
      treatment: { step_id: 'pm_treatment', time_of_day: 'pm' },
      retinoid: { step_id: 'pm_treatment', time_of_day: 'pm' },
      mask: { step_id: 'pm_mask', time_of_day: 'pm' },
      eye_cream: { step_id: 'pm_eye', time_of_day: 'both' },
    };

    return typeToStep[type.toLowerCase()] || { step_id: 'pm_treatment', time_of_day: 'pm' };
  }
}

module.exports = ExploreAddToRoutineSkill;
