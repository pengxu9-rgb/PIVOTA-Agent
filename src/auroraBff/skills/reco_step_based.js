const BaseSkill = require('./BaseSkill');
const recoHybridResolver = require('../usecases/recoHybridResolveCandidates');

function normalizeRecoLang(locale) {
  const raw = String(locale || '').trim().toLowerCase();
  return raw === 'cn' || raw === 'zh' || raw.startsWith('zh-') ? 'CN' : 'EN';
}

function localizeStepLabel(step, lang = 'EN') {
  const isCn = String(lang || '').toUpperCase() === 'CN';
  const map = {
    cleanser: isCn ? '洁面' : 'cleanser',
    toner: isCn ? '化妆水' : 'toner',
    essence: isCn ? '精华水' : 'essence',
    serum: isCn ? '精华' : 'serum',
    moisturizer: isCn ? '保湿霜' : 'moisturizer',
    sunscreen: isCn ? '防晒' : 'sunscreen',
    treatment: isCn ? '功效产品' : 'treatment',
    mask: isCn ? '面膜' : 'mask',
    oil: isCn ? '护肤油' : 'face oil',
  };
  return map[String(step || '').trim().toLowerCase()] || (isCn ? '护肤产品' : 'skincare product');
}

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
    const hasUserQuestion = Boolean(this._getUserQuestion(request));

    if (!hasProfile && !hasRoutine && !hasConcernContext && !hasTargetContext && !hasUserQuestion) {
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
    const lang = normalizeRecoLang(request.context?.locale);
    const targetStep = String(request.params?.target_step || '').trim();
    const targetIngredient = String(request.params?.target_ingredient || '').trim();
    const userQuestion = this._getUserQuestion(request);

    let candidateOutput = {
      answer_en: '',
      answer_zh: null,
      products: [],
    };
    let promptHash = null;

    try {
      const llmResult = await llmGateway.call({
        templateId: 'reco_step_based',
        taskMode: 'recommendation',
        params: {
          profile: request.context?.profile || {},
          routine: request.context?.current_routine || null,
          inventory: Array.isArray(request.context?.inventory) ? request.context.inventory : [],
          target_step: targetStep || null,
          target_ingredient: targetIngredient || null,
          concerns: Array.isArray(request.params?._extracted_concerns) ? request.params._extracted_concerns : [],
          safety_flags: Array.isArray(request.context?.safety_flags) ? request.context.safety_flags : [],
          locale: request.context?.locale || 'en-US',
          user_question: userQuestion || null,
        },
        schema: 'RecoHybridCandidateOutput',
      });
      if (llmResult?.parsed && typeof llmResult.parsed === 'object') {
        candidateOutput = llmResult.parsed;
      }
      promptHash = llmResult?.promptHash || null;
    } catch (err) {
      console.error('[reco.step_based] llm candidate generation failed:', err?.message || err);
      const fallbackMessage = this._buildNoResultMessage({
        language: lang,
        targetStep,
        targetIngredient,
        sourceMode: 'llm_error',
        telemetryReason: String(err?.message || 'llm_error').slice(0, 200),
      });
      return {
        cards: [
          {
            card_type: 'text_response',
            sections: [
              {
                type: 'text_answer',
                text_en: fallbackMessage.en,
                text_zh: fallbackMessage.zh,
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
              event: 'reco_llm_error',
              step_count: 0,
              has_routine: Boolean(request.context?.current_routine),
              source_mode: 'llm_error',
            },
          ],
        },
        next_actions: this._buildNextActions({ targetIngredient }),
        _taskMode: 'recommendation',
        _promptHash: null,
        _llmCalls: 1,
      };
    }

    let resolved;
    try {
      resolved = await recoHybridResolver.runRecoHybridResolveCandidates({
        request,
        candidateOutput,
        logger: console,
      });
    } catch (err) {
      console.error('[reco.step_based] hybrid resolver failed:', err?.message || err);
      resolved = {
        rows: [],
        recommendation_meta: {
          source_mode: 'llm_catalog_hybrid',
          llm_seed_count: Array.isArray(candidateOutput.products) ? candidateOutput.products.length : 0,
          exact_match_count: 0,
          fuzzy_match_count: 0,
          unresolved_seed_count: 0,
          target_step: targetStep || null,
          target_ingredient: targetIngredient || null,
          telemetry_failure_reason: String(err?.message || 'resolver_error').slice(0, 200),
        },
      };
    }

    const recommendations = Array.isArray(resolved?.rows) ? resolved.rows : [];
    const recommendationMeta = resolved?.recommendation_meta && typeof resolved.recommendation_meta === 'object'
      ? resolved.recommendation_meta
      : {
          source_mode: 'llm_catalog_hybrid',
          llm_seed_count: Array.isArray(candidateOutput.products) ? candidateOutput.products.length : 0,
          exact_match_count: 0,
          fuzzy_match_count: 0,
          unresolved_seed_count: 0,
          target_step: targetStep || null,
          target_ingredient: targetIngredient || null,
        };

    const cards = [];
    const answerEn = String(candidateOutput?.answer_en || '').trim();
    const answerZh = String(candidateOutput?.answer_zh || '').trim();
    if (answerEn || answerZh) {
      cards.push({
        card_type: 'text_response',
        sections: [
          {
            type: 'text_answer',
            text_en: answerEn || this._buildNoResultMessage({ language: 'EN', targetStep, targetIngredient }).en,
            text_zh: answerZh || null,
          },
        ],
      });
    }

    if (recommendations.length > 0) {
      cards.push({
        card_type: 'recommendations',
        metadata: {
          recommendations,
          recommendation_meta: recommendationMeta,
          source_mode: recommendationMeta.source_mode || 'llm_catalog_hybrid',
          target_step: targetStep || null,
          target_ingredient: targetIngredient || null,
          query_count: Number(recommendationMeta.query_count || 0),
        },
      });
    }

    if (cards.length > 0) {
      return {
        cards,
        ops: {
          thread_ops: [],
          profile_patch: {},
          routine_patch: {},
          experiment_events: [
            {
              event: recommendations.length > 0 ? 'reco_shown' : 'reco_empty',
              step_count: recommendations.length,
              has_routine: Boolean(request.context?.current_routine),
              source_mode: recommendationMeta.source_mode || null,
              grounding_status: 'llm_catalog_hybrid',
            },
          ],
        },
        next_actions: this._buildNextActions({ targetIngredient }),
        _taskMode: 'recommendation',
        _promptHash: promptHash,
        _llmCalls: 1,
      };
    }

    const noResultMessage = this._buildNoResultMessage({
      language: lang,
      targetStep,
      targetIngredient,
      sourceMode: recommendationMeta.source_mode || '',
      telemetryReason: recommendationMeta.telemetry_failure_reason || '',
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
            source_mode: recommendationMeta.source_mode || null,
            grounding_status: 'llm_catalog_hybrid',
          },
        ],
      },
      next_actions: this._buildNextActions({ targetIngredient }),
      _taskMode: 'recommendation',
      _promptHash: promptHash,
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

  _getUserQuestion(request) {
    return String(
      request.params?._user_question ||
      request.params?.user_message ||
      request.params?.message ||
      request.params?.text ||
      '',
    ).trim();
  }

  _buildNextActions({ targetIngredient }) {
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
    return nextActions;
  }

  _buildNoResultMessage({ language, targetStep, targetIngredient, sourceMode, catalogSkipReason, telemetryReason }) {
    const stepLabel = localizeStepLabel(targetStep, language);
    const transient = String(telemetryReason || '').trim().toLowerCase() === 'timeout_degraded'
      || String(sourceMode || '').trim().toLowerCase() === 'catalog_transient_fallback'
      || String(sourceMode || '').trim().toLowerCase() === 'llm_error'
      || String(catalogSkipReason || '').trim().toLowerCase() === 'fail_fast_open';

    if (transient) {
      return {
        en: `Catalog grounding is unstable right now, so I couldn't confirm a strong ${stepLabel || 'skincare'} match. Try again shortly or give me a target ingredient.`,
        zh: `商品库当前有些不稳定，我暂时没法确认合适的${stepLabel || '护肤'}候选。你可以稍后重试，或直接告诉我目标成分。`,
      };
    }

    if (targetIngredient) {
      return {
        en: `I couldn't find a strong match for products with ${targetIngredient}. Share your main concern, budget, or a product example and I can narrow it down.`,
        zh: `我暂时没找到足够匹配的 ${targetIngredient} 产品。补充你的主要诉求、预算或一个参考产品，我可以继续收窄。`,
      };
    }

    if (targetStep) {
      return {
        en: `I couldn't find a strong ${stepLabel} match yet. Share your main concern or a target ingredient and I can narrow it down.`,
        zh: `我暂时没找到足够匹配的${stepLabel}候选。告诉我你的主要问题或目标成分，我可以继续收窄。`,
      };
    }

    return {
      en: "I couldn't build a confident product shortlist yet. Share your main concern, target ingredient, or preferred product type and I can narrow it down.",
      zh: '我暂时还没法形成足够可靠的推荐清单。告诉我你的主要问题、目标成分或想找的产品类型，我可以继续收窄。',
    };
  }
}

module.exports = RecoStepBasedSkill;
