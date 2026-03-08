const BaseSkill = require('./BaseSkill');

class DiagnosisAnswerSkill extends BaseSkill {
  constructor() {
    super('diagnosis_v2.answer', '1.0.0');
  }

  async checkPreconditions(request) {
    const goals = request.thread_state?.diagnosis_goals;
    if (!goals || goals.length === 0) {
      return {
        met: false,
        failures: [
          {
            rule_id: 'pre_diagnosis_has_goal',
            reason: 'No diagnosis goals selected',
            on_fail_target: 'diagnosis_v2.start',
            on_fail_message_en: 'Please select your skin goals first.',
            on_fail_message_zh: '请先选择你的护肤目标。',
          },
        ],
      };
    }
    return { met: true, failures: [] };
  }

  async execute(request, llmGateway) {
    const { context, thread_state: threadState } = request;
    const goals = threadState.diagnosis_goals;
    const hasPhoto = context?.profile?.has_photo === true;
    const safetyFlags = context?.safety_flags || [];

    const llmResult = await llmGateway.call({
      templateId: 'diagnosis_v2_answer_blueprint',
      taskMode: 'diagnosis',
      params: {
        goals,
        profile: context.profile,
        recent_logs: context.recent_logs,
        has_photo: hasPhoto,
        safety_flags: safetyFlags,
        locale: context.locale || 'en',
      },
      schema: 'DiagnosisBlueprintOutput',
    });

    const blueprint = llmResult.parsed;

    const skinStatusSections = [
      {
        type: 'skin_status_structured',
        skin_type: blueprint.inferred_skin_type,
        primary_concerns: blueprint.primary_concerns,
        severity_scores: blueprint.severity_scores,
        confidence: blueprint.confidence,
      },
    ];

    if (hasPhoto && blueprint.visual_observations) {
      skinStatusSections.push({
        type: 'visual_analysis',
        observations: blueprint.visual_observations,
      });
    }

    const cards = [{ card_type: 'skin_status', sections: skinStatusSections }];

    if (blueprint.nudge) {
      cards.push({
        card_type: 'nudge',
        sections: [{ type: 'nudge_structured', ...blueprint.nudge }],
      });
    }

    const nextActions = [
      {
        action_type: 'navigate_skill',
        target_skill_id: 'routine.apply_blueprint',
        label: { en: 'Build my routine', zh: '生成我的护肤流程' },
      },
      {
        action_type: 'navigate_skill',
        target_skill_id: 'reco.step_based',
        label: { en: 'Get product recommendations', zh: '获取产品推荐' },
      },
    ];

    if (!hasPhoto) {
      nextActions.push({
        action_type: 'trigger_photo',
        label: { en: 'Add a photo for deeper analysis', zh: '添加照片获得更深入分析' },
      });
    }

    return {
      cards,
      ops: {
        thread_ops: [
          { op: 'set', key: 'blueprint_id', value: blueprint.blueprint_id },
          { op: 'set', key: 'diagnosis_state', value: 'completed' },
        ],
        profile_patch: {
          skin_type: blueprint.inferred_skin_type,
          primary_concerns: blueprint.primary_concerns,
          goals,
        },
        routine_patch: {},
        experiment_events: [],
      },
      next_actions: nextActions,
      _promptHash: llmResult.promptHash,
      _taskMode: 'diagnosis',
      _llmCalls: 1,
    };
  }

  async validateOutput(response, request) {
    const baseResult = await super.validateOutput(response, request);
    const issues = [...baseResult.issues];
    const hasPhoto = request.context?.profile?.has_photo === true;

    if (!hasPhoto) {
      for (const card of response.cards || []) {
        for (const section of card.sections || []) {
          if (section.type === 'visual_analysis') {
            issues.push({
              code: 'NO_PHOTO_VISUAL_REF',
              message: 'Visual analysis present but user has no photo',
              severity: 'error',
            });
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

module.exports = DiagnosisAnswerSkill;
