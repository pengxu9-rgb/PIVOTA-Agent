const BaseSkill = require('./BaseSkill');
const { runRecoStepBasedCatalogBridge, __internal: recoBridgeInternal } = require('../usecases/recoStepBasedCatalogBridge');

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

  async execute(request, _llmGateway) {
    let recoResult;
    try {
      recoResult = await runRecoStepBasedCatalogBridge({ request, logger: console });
    } catch (err) {
      console.error('[reco.step_based] catalog bridge failed:', err?.message || err);
      recoResult = {
        norm: {
          payload: {
            recommendations: [],
            recommendation_meta: {
              source_mode: 'bridge_error',
              telemetry_failure_reason: String(err?.message || 'unknown').slice(0, 200),
            },
          },
        },
      };
    }
    const payload = recoResult?.norm?.payload && typeof recoResult.norm.payload === 'object'
      ? recoResult.norm.payload
      : {};
    const recommendations = Array.isArray(payload.recommendations) ? payload.recommendations : [];
    const targetStep = String(request.params?.target_step || '').trim();
    const targetIngredient = String(request.params?.target_ingredient || '').trim();

    const nextActions = [];
    if (targetIngredient) {
      nextActions.push({
        action_type: 'navigate_skill',
        target_skill_id: 'ingredient.report',
        label: {
          en: `Learn more about ${targetIngredient}`,
          zh: `了解更多关于${targetIngredient}`,
        },
        params: { ingredient_query: targetIngredient },
      });
    }
    nextActions.push({
      action_type: 'navigate_skill',
      target_skill_id: 'product.analyze',
      label: { en: 'Analyze a specific product', zh: '分析具体产品' },
    });

    if (recommendations.length > 0) {
      return {
        cards: [
          {
            card_type: 'recommendations',
            metadata: {
              ...payload,
              recommendations,
              source_mode: payload?.recommendation_meta?.source_mode || null,
              query_count: Number(payload?.recommendation_meta?.catalog_query_count || 0),
              target_step: targetStep || null,
              target_ingredient: targetIngredient || null,
            },
          },
        ],
        ops: {
          thread_ops: [],
          profile_patch: {},
          routine_patch: {},
          experiment_events: [
            {
              event: 'reco_shown',
              step_count: recommendations.length,
              has_routine: Boolean(request.context?.current_routine),
              source_mode: payload?.recommendation_meta?.source_mode || null,
              grounding_status: payload?.grounding_status || null,
            },
          ],
        },
        next_actions: nextActions,
        _taskMode: 'recommendation',
        _llmCalls: payload?.recommendation_meta?.source_mode === 'rules_only' ? 0 : 1,
      };
    }

    const noResultMessage = this._buildNoResultMessage({
      language: recoBridgeInternal.normalizeRecoLang(request.context?.locale),
      targetStep,
      targetIngredient,
      sourceMode: payload?.recommendation_meta?.source_mode || '',
      catalogSkipReason: payload?.catalog_skip_reason || payload?.recommendation_meta?.catalog_skip_reason || '',
      telemetryReason: payload?.telemetry_reason || payload?.recommendation_meta?.telemetry_failure_reason || '',
    });

    return {
      cards: [
        {
          card_type: 'text_response',
          sections: [
            {
              type: 'text_answer',
              text_en: noResultMessage.en,
              text_zh: noResultMessage.zh,
            },
          ],
        },
      ],
      ops: {
        thread_ops: [],
        profile_patch: {},
        routine_patch: {},
        experiment_events: [
          {
            event: 'reco_empty',
            step_count: 0,
            has_routine: Boolean(request.context?.current_routine),
            source_mode: payload?.recommendation_meta?.source_mode || null,
            grounding_status: payload?.grounding_status || null,
          },
        ],
      },
      next_actions: nextActions,
      _taskMode: 'recommendation',
      _llmCalls: payload?.recommendation_meta?.source_mode === 'rules_only' ? 0 : 1,
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
        for (const reco of card.metadata?.recommendations || []) {
          for (const concept of reco.concepts || []) {
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

    return {
      quality_ok: issues.filter((issue) => issue.severity === 'error').length === 0,
      issues,
    };
  }

  _buildNoResultMessage({ language, targetStep, targetIngredient, sourceMode, catalogSkipReason, telemetryReason }) {
    const isCn = String(language || '').toUpperCase() === 'CN';
    const stepLabel = recoBridgeInternal.localizeStepLabel(targetStep, language);
    const transient = String(telemetryReason || '').trim().toLowerCase() === 'timeout_degraded'
      || String(sourceMode || '').trim().toLowerCase() === 'catalog_transient_fallback'
      || String(catalogSkipReason || '').trim().toLowerCase() === 'fail_fast_open';

    if (transient) {
      return {
        en: `Catalog grounding is unstable right now, so I couldn't confirm a strong ${stepLabel || 'skincare'} match. Try again shortly or give me a target ingredient.`,
        zh: `商品库当前有些不稳定，我暂时没法确认合适的${stepLabel || '护肤'}候选。你可以稍后重试，或直接告诉我目标成分。`,
      };
    }

    if (targetIngredient) {
      return {
        en: `I couldn't find a strong catalog-grounded match for products with ${targetIngredient}. Share your main concern, budget, or a product example and I can narrow it down.`,
        zh: `我暂时没找到足够匹配、且有商品库锚定的 ${targetIngredient} 产品。补充你的主要诉求、预算或一个参考产品，我可以继续收窄。`,
      };
    }

    if (targetStep) {
      return {
        en: `I couldn't find a strong catalog-grounded ${stepLabel} match yet. Share your main concern or a target ingredient and I can narrow it down.`,
        zh: `我暂时没找到足够匹配、且有商品库锚定的${stepLabel}候选。告诉我你的主要问题或目标成分，我可以继续收窄。`,
      };
    }

    return {
      en: "I couldn't find a strong catalog-grounded match yet. Share your main concern, target ingredient, or preferred product type and I can narrow it down.",
      zh: '我暂时没找到足够匹配、且有商品库锚定的候选。告诉我你的主要问题、目标成分或想找的产品类型，我可以继续收窄。',
    };
  }
}

module.exports = RecoStepBasedSkill;
