const BaseSkill = require('./BaseSkill');

class RecoStepBasedSkill extends BaseSkill {
  constructor() {
    super('reco.step_based', '1.0.0');
  }

  async checkPreconditions(request) {
    const profile = request.context?.profile;
    const routine = request.context?.current_routine;

    const hasProfile = profile && (profile.skin_type || profile.concerns?.length > 0);
    const hasRoutine =
      routine && (routine.am_steps?.length > 0 || routine.pm_steps?.length > 0);

    if (!hasProfile && !hasRoutine) {
      return {
        met: false,
        failures: [
          {
            rule_id: 'pre_has_profile_or_routine',
            reason: 'No profile or routine available for recommendations',
            on_fail_target: 'diagnosis_v2.start',
            on_fail_message_en: 'We need to know a bit about your skin first.',
            on_fail_message_zh: '我们需要先了解一下你的肌肤状况。',
          },
        ],
      };
    }
    return { met: true, failures: [] };
  }

  async execute(request, llmGateway) {
    const { context, params } = request;
    const targetStep = params?.target_step || null;
    const safetyFlags = context.safety_flags || [];

    const llmResult = await llmGateway.call({
      templateId: 'reco_step_based',
      taskMode: 'recommendation',
      params: {
        profile: context.profile,
        routine: context.current_routine,
        inventory: context.inventory,
        target_step: targetStep,
        safety_flags: safetyFlags,
        locale: context.locale || 'en',
      },
      schema: 'StepRecommendationOutput',
    });

    const reco = llmResult.parsed;

    const sections = [];
    for (const stepReco of reco.step_recommendations || []) {
      sections.push({
        type: 'step_recommendation',
        step_id: stepReco.step_id,
        step_name: stepReco.step_name,
        candidates: stepReco.candidates.map((c) => ({
          product_id: c.product_id,
          brand: c.brand,
          name: c.name,
          why: c.why,
          suitability_score: c.suitability_score,
          price_tier: c.price_tier,
        })),
      });
    }

    if (sections.length === 0) {
      sections.push({
        type: 'empty_state_message',
        message_en: 'No suitable recommendations found for your current profile.',
        message_zh: '暂未找到适合你当前肌肤状况的推荐产品。',
      });
    }

    return {
      cards: [{ card_type: 'effect_review', sections }],
      ops: {
        thread_ops: [],
        profile_patch: {},
        routine_patch: {},
        experiment_events: [
          {
            event: 'reco_shown',
            step_count: sections.length,
            has_routine: !!context.current_routine,
          },
        ],
      },
      next_actions: [
        {
          action_type: 'show_chip',
          label: { en: 'Add to my routine', zh: '加入我的护肤流程' },
        },
        {
          action_type: 'navigate_skill',
          target_skill_id: 'product.analyze',
          label: { en: 'Analyze a specific product', zh: '分析某个产品' },
        },
        {
          action_type: 'navigate_skill',
          target_skill_id: 'tracker.checkin_log',
          label: { en: 'Start tracking', zh: '开始打卡记录' },
        },
      ],
      _promptHash: llmResult.promptHash,
      _taskMode: 'recommendation',
      _llmCalls: 1,
    };
  }

  async validateOutput(response, request) {
    const baseResult = await super.validateOutput(response, request);
    const issues = [...baseResult.issues];

    const safetyFlags = request.context?.safety_flags || [];
    const blockedConcepts = new Set();

    const blockRulePrefixes = ['PREG_', 'CHILD_', 'MINOR_'];
    for (const flag of safetyFlags) {
      for (const prefix of blockRulePrefixes) {
        if (flag.startsWith(prefix) && flag.includes('BLOCK')) {
          const concept = flag.replace(prefix, '').replace('_BLOCK', '').replace('_BLOCK_SPECIFIC', '');
          blockedConcepts.add(concept);
        }
      }
    }

    if (blockedConcepts.size > 0) {
      for (const card of response.cards || []) {
        for (const section of card.sections || []) {
          for (const candidate of section.candidates || []) {
            if (candidate.concepts) {
              for (const concept of candidate.concepts) {
                if (blockedConcepts.has(concept)) {
                  issues.push({
                    code: 'BLOCKED_CONCEPT_IN_RECO',
                    message: `Recommended product contains blocked concept: ${concept}`,
                    severity: 'error',
                  });
                }
              }
            }
          }
        }
      }
    }

    return {
      quality_ok: issues.filter((i) => i.severity === 'error').length === 0,
      issues,
    };
  }
}

module.exports = RecoStepBasedSkill;
