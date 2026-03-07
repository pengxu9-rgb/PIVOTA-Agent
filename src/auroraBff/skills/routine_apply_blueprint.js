const BaseSkill = require('./BaseSkill');

class RoutineApplyBlueprintSkill extends BaseSkill {
  constructor() {
    super('routine.apply_blueprint', '1.0.0');
  }

  async checkPreconditions(request) {
    const blueprint = request.thread_state?.blueprint_id;
    if (!blueprint) {
      return {
        met: false,
        failures: [
          {
            rule_id: 'pre_has_blueprint',
            reason: 'No blueprint available',
            on_fail_target: 'diagnosis_v2.start',
            on_fail_message_en: 'Complete a skin diagnosis first to generate your blueprint.',
            on_fail_message_zh: '请先完成肌肤诊断以生成你的护肤蓝图。',
          },
        ],
      };
    }
    return { met: true, failures: [] };
  }

  async execute(request, _llmGateway) {
    const { context, thread_state: threadState } = request;
    const profile = context.profile || {};
    const safetyFlags = context.safety_flags || [];

    const amSteps = this._buildAmSteps(profile, safetyFlags);
    const pmSteps = this._buildPmSteps(profile, safetyFlags);

    const routineId = `routine_${Date.now()}`;

    return {
      cards: [
        {
          card_type: 'routine',
          sections: [
            {
              type: 'routine_structured',
              routine_id: routineId,
              version: 1,
              am_steps: amSteps,
              pm_steps: pmSteps,
              notes_en: 'This is your starting framework. Add your products next!',
              notes_zh: '这是你的初始护肤框架，接下来添加你的产品吧！',
            },
          ],
        },
      ],
      ops: {
        thread_ops: [{ op: 'set', key: 'routine_id', value: routineId }],
        profile_patch: {},
        routine_patch: {
          routine_id: routineId,
          version: 1,
          am_steps: amSteps,
          pm_steps: pmSteps,
        },
        experiment_events: [],
      },
      next_actions: [
        {
          action_type: 'navigate_skill',
          target_skill_id: 'routine.intake_products',
          label: { en: 'Add my products', zh: '添加我的产品' },
        },
        {
          action_type: 'navigate_skill',
          target_skill_id: 'reco.step_based',
          label: { en: 'Recommend products for each step', zh: '为每个步骤推荐产品' },
        },
      ],
      _taskMode: 'routine',
      _llmCalls: 0,
    };
  }

  _buildAmSteps(profile, safetyFlags) {
    const steps = [
      { step_id: 'am_cleanser', name_en: 'Cleanser', name_zh: '洁面', required: true, products: [] },
      { step_id: 'am_toner', name_en: 'Toner', name_zh: '化妆水', required: false, products: [] },
    ];

    const needsBrightening =
      profile.primary_concerns?.includes('pigmentation') ||
      profile.primary_concerns?.includes('dullness');
    if (needsBrightening) {
      steps.push({
        step_id: 'am_serum_brightening',
        name_en: 'Brightening Serum',
        name_zh: '提亮精华',
        required: false,
        products: [],
        concept_hint: 'VITAMIN_C',
      });
    }

    steps.push(
      { step_id: 'am_moisturizer', name_en: 'Moisturizer', name_zh: '面霜/乳液', required: true, products: [] },
      { step_id: 'am_sunscreen', name_en: 'Sunscreen SPF 30+', name_zh: '防晒 SPF 30+', required: true, products: [], concept_hint: 'SUNSCREEN' }
    );

    return steps;
  }

  _buildPmSteps(profile, safetyFlags) {
    const isPregnant = safetyFlags.some((f) =>
      f.startsWith('PREG_') && !f.includes('UNKNOWN')
    );

    const steps = [
      { step_id: 'pm_cleanser', name_en: 'Cleanser', name_zh: '洁面', required: true, products: [] },
    ];

    const hasAcneConcern = profile.primary_concerns?.includes('acne');
    const hasAgingConcern = profile.primary_concerns?.includes('anti_aging');

    if (hasAcneConcern || hasAgingConcern) {
      if (isPregnant) {
        steps.push({
          step_id: 'pm_treatment',
          name_en: 'Treatment (pregnancy-safe)',
          name_zh: '功效产品（孕期安全）',
          required: false,
          products: [],
          concept_hint: 'AZELAIC_ACID',
          safety_note: 'Retinoids blocked during pregnancy',
        });
      } else {
        steps.push({
          step_id: 'pm_treatment',
          name_en: 'Treatment',
          name_zh: '功效产品',
          required: false,
          products: [],
          concept_hint: hasAgingConcern ? 'RETINOID' : 'BHA',
        });
      }
    }

    steps.push({
      step_id: 'pm_moisturizer',
      name_en: 'Moisturizer',
      name_zh: '面霜/乳液',
      required: true,
      products: [],
    });

    return steps;
  }
}

module.exports = RoutineApplyBlueprintSkill;
