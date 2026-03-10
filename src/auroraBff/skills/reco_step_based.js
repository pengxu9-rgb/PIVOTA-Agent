const BaseSkill = require('./BaseSkill');

class RecoStepBasedSkill extends BaseSkill {
  constructor() {
    super('reco.step_based', '2.0.0');
  }

  async checkPreconditions(request) {
    const profile = request.context?.profile || {};
    const routine = request.context?.current_routine || null;
    const concerns = request.params?._extracted_concerns || [];
    const targetIngredient = request.params?.target_ingredient || null;
    const targetStep = request.params?.target_step || null;
    const profileConcerns = Array.isArray(profile.concerns)
      ? profile.concerns
      : Array.isArray(profile.goals)
        ? profile.goals
        : [];

    const hasProfile =
      Boolean(profile.skin_type || profile.skinType || profile.sensitivity || profile.barrier_status || profile.barrierStatus) ||
      profileConcerns.length > 0;
    const hasRoutine = Boolean(routine && ((routine.am_steps || []).length > 0 || (routine.pm_steps || []).length > 0));
    const hasConcernContext = Array.isArray(concerns) && concerns.length > 0;
    const hasTargetContext = Boolean(targetIngredient || targetStep);

    if (!hasProfile && !hasRoutine && !hasConcernContext && !hasTargetContext) {
      return {
        met: false,
        failures: [
          {
            rule_id: 'pre_has_context_for_reco',
            reason: 'Need some context for recommendations',
            on_fail_message_en: 'Tell me your main skin concerns or what ingredient/product type you need.',
            on_fail_message_zh: '告诉我你的主要皮肤问题，或者你想找的成分/产品类型。',
          },
        ],
      };
    }

    return { met: true, failures: [] };
  }

  async execute(request, llmGateway) {
    const llmResult = await llmGateway.call({
      templateId: 'reco_step_based',
      taskMode: 'recommendation',
      params: {
        profile: request.context?.profile || {},
        routine: request.context?.current_routine || null,
        inventory: request.context?.inventory || [],
        target_step: request.params?.target_step || null,
        target_ingredient: request.params?.target_ingredient || null,
        concerns: request.params?._extracted_concerns || [],
        safety_flags: request.context?.safety_flags || [],
        locale: request.context?.locale || 'en',
      },
      schema: 'StepRecommendationOutput',
    });

    const recommendations = llmResult.parsed?.step_recommendations || [];
    const sections = recommendations
      .filter((recommendation) => Array.isArray(recommendation.candidates) && recommendation.candidates.length > 0)
      .map((recommendation) => ({
        type: 'step_recommendation',
        step_id: recommendation.step_id,
        step_name: recommendation.step_name,
        candidates: recommendation.candidates.map((candidate) => ({
          product_id: candidate.product_id,
          brand: candidate.brand,
          name: candidate.name,
          why: candidate.why,
          suitability_score: candidate.suitability_score,
          price_tier: candidate.price_tier,
        })),
      }));

    if (sections.length === 0) {
      sections.push({
        type: 'empty_state_message',
        message_en: "I couldn't find specific recommendations right now. Share a bit more about your concern or target ingredient.",
        message_zh: '暂时没有找到具体推荐。可以再补充一点你的皮肤问题或目标成分。',
      });
    }

    const nextActions = [];
    if (request.params?.target_ingredient) {
      nextActions.push({
        action_type: 'navigate_skill',
        target_skill_id: 'ingredient.report',
        label: {
          en: `Learn more about ${request.params.target_ingredient}`,
          zh: `了解更多关于${request.params.target_ingredient}`,
        },
        params: { ingredient_query: request.params.target_ingredient },
      });
    }
    nextActions.push({
      action_type: 'navigate_skill',
      target_skill_id: 'product.analyze',
      label: { en: 'Analyze a specific product', zh: '分析具体产品' },
    });

    return {
      cards: [
        {
          card_type: 'effect_review',
          sections,
        },
      ],
      ops: {
        thread_ops: [],
        profile_patch: {},
        routine_patch: {},
        experiment_events: [
          {
            event: 'reco_shown',
            step_count: sections.length,
            has_routine: Boolean(request.context?.current_routine),
          },
        ],
      },
      next_actions: nextActions,
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

    for (const flag of safetyFlags) {
      const raw = String(flag || '');
      if (!raw.includes('BLOCK')) continue;
      const match = raw.match(/(?:PREG|CHILD|MINOR)_([^_]+(?:_[^_]+)*)_BLOCK(?:_SPECIFIC)?$/);
      if (match && match[1]) {
        blockedConcepts.add(match[1]);
      }
    }

    if (blockedConcepts.size > 0) {
      for (const card of response.cards || []) {
        for (const section of card.sections || []) {
          for (const candidate of section.candidates || []) {
            for (const concept of candidate.concepts || []) {
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

    return {
      quality_ok: issues.filter((issue) => issue.severity === 'error').length === 0,
      issues,
    };
  }
}

module.exports = RecoStepBasedSkill;
