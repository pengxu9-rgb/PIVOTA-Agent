const BaseSkill = require('./BaseSkill');
const { runRecommendationSharedStack } = require('../recommendationSharedStack');

let sharedRecoCoreRunnerOverride = null;

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

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pickFirstTrimmed(...values) {
  for (const value of values) {
    const text = value == null ? '' : String(value).trim();
    if (text) return text;
  }
  return '';
}

function buildRoutesCoreRunner() {
  if (typeof sharedRecoCoreRunnerOverride === 'function') return sharedRecoCoreRunnerOverride;
  const routes = require('../routes');
  const coreRunner = routes && routes.__internal && typeof routes.__internal.generateProductRecommendations === 'function'
    ? routes.__internal.generateProductRecommendations
    : null;
  if (!coreRunner) {
    throw new Error('reco.step_based shared core unavailable');
  }
  return coreRunner;
}

function extractRequestOverrideFromRequest(request) {
  const params = isPlainObject(request && request.params) ? request.params : {};
  const profilePatch = isPlainObject(params.profile_patch) ? params.profile_patch : {};
  const goals = Array.isArray(profilePatch.goals)
    ? profilePatch.goals
    : profilePatch.goal
      ? [profilePatch.goal]
      : profilePatch.goal_primary
        ? [profilePatch.goal_primary]
        : [];
  return {
    ...(pickFirstTrimmed(profilePatch.skinType, profilePatch.skin_type) ? { skinType: pickFirstTrimmed(profilePatch.skinType, profilePatch.skin_type) } : {}),
    ...(pickFirstTrimmed(profilePatch.sensitivity, profilePatch.sensitivity_level) ? { sensitivity: pickFirstTrimmed(profilePatch.sensitivity, profilePatch.sensitivity_level) } : {}),
    ...(pickFirstTrimmed(profilePatch.barrierStatus, profilePatch.barrier_status) ? { barrierStatus: pickFirstTrimmed(profilePatch.barrierStatus, profilePatch.barrier_status) } : {}),
    ...(goals.length ? { goals } : {}),
  };
}

function buildSkillCtx(request, lang) {
  const entrySource = String(request?.params?.entry_source || '').trim().toLowerCase();
  const triggerSource = entrySource.startsWith('chip') ? 'chip' : entrySource.includes('action') ? 'action' : 'text';
  const seed = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return {
    request_id: `reco_skill_${seed}`,
    trace_id: `reco_skill_trace_${seed}`,
    lang,
    locale: request?.context?.locale || (lang === 'CN' ? 'zh-CN' : 'en-US'),
    state: request?.thread_state?.state || 'chat',
    trigger_source: triggerSource,
  };
}

function buildClarifyMessage({ language, targetIngredient }) {
  if (targetIngredient) {
    return language === 'CN'
      ? `你想围绕 ${targetIngredient} 找哪一类产品？例如洁面、精华、面霜或防晒。`
      : `What type of product do you want around ${targetIngredient}? For example, cleanser, serum, moisturizer, or sunscreen.`;
  }
  return language === 'CN'
    ? '你想优先找哪一类产品？例如洁面、精华、面霜或防晒。'
    : 'What type of product do you want first? For example, cleanser, serum, moisturizer, or sunscreen.';
}

class RecoStepBasedSkill extends BaseSkill {
  constructor() {
    super('reco.step_based', '2.1.0');
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

  async execute(request, _llmGateway) {
    const lang = normalizeRecoLang(request.context?.locale);
    const targetStep = String(request.params?.target_step || '').trim();
    const targetIngredient = String(request.params?.target_ingredient || '').trim();
    const userQuestion = this._getUserQuestion(request);
    const profile = isPlainObject(request.context?.profile) ? request.context.profile : {};
    const recentLogs = Array.isArray(request.context?.recent_logs) ? request.context.recent_logs : [];
    const analysisContextSnapshot = isPlainObject(request.context?.analysis_context_snapshot)
      ? request.context.analysis_context_snapshot
      : null;
    const requestOverride = extractRequestOverrideFromRequest(request);
    const ctx = buildSkillCtx(request, lang);
    const coreMessage = userQuestion
      || (targetIngredient
        ? (lang === 'CN'
          ? `围绕 ${targetIngredient} 给我推荐几款产品`
          : `Recommend a few products built around ${targetIngredient}`)
        : targetStep
          ? (lang === 'CN'
            ? `给我推荐几款${localizeStepLabel(targetStep, lang)}`
            : `Recommend a few ${localizeStepLabel(targetStep, lang)}`)
          : (lang === 'CN' ? '给我推荐几款护肤产品' : 'Recommend a few skincare products'));
    let terminalState = 'pending';
    const transitionTerminalState = (nextState) => {
      if (terminalState !== 'pending' && terminalState !== nextState) {
        throw new Error(`reco.step_based terminal state already resolved as ${terminalState}`);
      }
      terminalState = nextState;
    };

    let sharedReco;
    try {
      sharedReco = await runRecommendationSharedStack({
        entryType: 'chat',
        message: coreMessage,
        params: request.params,
        actionData: request.params,
        profile,
        recentLogs,
        analysisContextSnapshot,
        requestOverride,
        coreRunner: buildRoutesCoreRunner(),
        coreInput: {
          ctx,
          profile,
          recentLogs,
          message: coreMessage,
          analysisContextSnapshot,
          requestOverride,
          includeAlternatives: request.params?.include_alternatives === true,
          logger: console,
          recoTriggerSource: String(request.params?.entry_source || '').trim() || 'chat_skill',
        },
      });
    } catch (err) {
      transitionTerminalState('safe_failure');
      console.error('[reco.step_based] shared core failed:', err?.message || err);
      const fallbackMessage = this._buildNoResultMessage({
        language: lang,
        targetStep,
        targetIngredient,
        sourceMode: 'shared_core_error',
        telemetryReason: String(err?.message || 'shared_core_error').slice(0, 200),
      });
      return {
        cards: [
          {
            card_type: 'text_response',
            metadata: {
              terminal_state: terminalState,
            },
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
              event: 'reco_shared_core_error',
              step_count: 0,
              has_routine: Boolean(request.context?.current_routine),
              source_mode: 'shared_core_error',
            },
          ],
        },
        next_actions: this._buildNextActions({ targetIngredient }),
        _taskMode: 'recommendation',
        _promptHash: null,
        _llmCalls: 0,
        _meta: {
          fallback_mode: 'severe_parse_or_prompt_failure',
          mainline_status: 'shared_core_error',
          strictness_source: 'policy_forced',
        },
      };
    }

    if (sharedReco.needs_more_context) {
      transitionTerminalState('clarify');
      return {
        cards: [
          {
            card_type: 'text_response',
            metadata: {
              terminal_state: terminalState,
              request_context_signature: sharedReco.request_context.request_context_signature,
              request_context_signature_version: sharedReco.request_context.request_context_signature_version,
              candidate_pool_signature: sharedReco.candidate_pool.candidate_pool_signature,
              candidate_pool_signature_version: sharedReco.candidate_pool.candidate_pool_signature_version,
            },
            sections: [
              {
                type: 'text_answer',
                text_en: buildClarifyMessage({ language: 'EN', targetIngredient }),
                text_zh: buildClarifyMessage({ language: 'CN', targetIngredient }),
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
              event: 'reco_clarify',
              step_count: 0,
              has_routine: Boolean(request.context?.current_routine),
              source_mode: 'shared_stack',
            },
          ],
        },
        next_actions: this._buildNextActions({ targetIngredient }),
        _taskMode: 'recommendation',
        _promptHash: null,
        _llmCalls: 0,
        _meta: {
          analysis_context_usage: sharedReco.request_context.context_usage,
          request_context_signature: sharedReco.request_context.request_context_signature,
          request_context_signature_version: sharedReco.request_context.request_context_signature_version,
          candidate_pool_signature: sharedReco.candidate_pool.candidate_pool_signature,
          candidate_pool_signature_version: sharedReco.candidate_pool.candidate_pool_signature_version,
          fallback_mode: sharedReco.core_result.fallback_mode,
          mainline_status: 'needs_more_context',
          strictness_source: sharedReco.request_context.strictness_source,
        },
      };
    }

    const upstreamReco = sharedReco.raw;
    const payload = upstreamReco && upstreamReco.norm && isPlainObject(upstreamReco.norm.payload)
      ? upstreamReco.norm.payload
      : {};
    const recommendationMeta = isPlainObject(payload.recommendation_meta) ? payload.recommendation_meta : {};
    const recommendations = Array.isArray(payload.recommendations) ? payload.recommendations : [];
    const cards = [];

    if (recommendations.length > 0) {
      transitionTerminalState('recommendation');
      cards.push({
        card_type: 'text_response',
        metadata: {
          terminal_state: terminalState,
        },
        sections: [
          {
            type: 'text_answer',
            text_en: 'I pulled together a few products that best fit your current context.',
            text_zh: '我按你当前的上下文整理了几款更匹配的产品。',
          },
        ],
      });
      cards.push({
        card_type: 'recommendations',
        metadata: {
          recommendations,
          recommendation_meta: recommendationMeta,
          source_mode: recommendationMeta.source_mode || null,
          target_step: targetStep || null,
          target_ingredient: targetIngredient || null,
          request_context_signature: sharedReco.request_context.request_context_signature,
          request_context_signature_version: sharedReco.request_context.request_context_signature_version,
          candidate_pool_signature: sharedReco.candidate_pool.candidate_pool_signature,
          candidate_pool_signature_version: sharedReco.candidate_pool.candidate_pool_signature_version,
          terminal_state: terminalState,
        },
      });
      return {
        cards,
        ops: {
          thread_ops: [],
          profile_patch: {},
          routine_patch: {},
          experiment_events: [
            {
              event: 'reco_shown',
              step_count: recommendations.length,
              has_routine: Boolean(request.context?.current_routine),
              source_mode: recommendationMeta.source_mode || null,
              grounding_status: recommendationMeta.grounding_status || payload.grounding_status || null,
            },
          ],
        },
        next_actions: this._buildNextActions({ targetIngredient }),
        _taskMode: 'recommendation',
        _promptHash: recommendationMeta.llm_trace && recommendationMeta.llm_trace.prompt_hash
          ? recommendationMeta.llm_trace.prompt_hash
          : null,
        _llmCalls: 1,
        _meta: {
          analysis_context_usage: recommendationMeta.analysis_context_usage || sharedReco.request_context.context_usage,
          request_context_signature: sharedReco.request_context.request_context_signature,
          request_context_signature_version: sharedReco.request_context.request_context_signature_version,
          candidate_pool_signature: sharedReco.candidate_pool.candidate_pool_signature,
          candidate_pool_signature_version: sharedReco.candidate_pool.candidate_pool_signature_version,
          fallback_mode: sharedReco.core_result.fallback_mode,
          mainline_status: upstreamReco.mainlineStatus || recommendationMeta.mainline_status || null,
          strictness_source: sharedReco.request_context.strictness_source,
        },
      };
    }

    transitionTerminalState('safe_failure');
    const noResultMessage = this._buildNoResultMessage({
      language: lang,
      targetStep,
      targetIngredient,
      sourceMode: recommendationMeta.source_mode || '',
      telemetryReason: recommendationMeta.telemetry_failure_reason || '',
      catalogSkipReason: recommendationMeta.catalog_skip_reason || '',
    });

    return {
      cards: [
        {
          card_type: 'text_response',
          metadata: {
            terminal_state: terminalState,
            request_context_signature: sharedReco.request_context.request_context_signature,
            request_context_signature_version: sharedReco.request_context.request_context_signature_version,
            candidate_pool_signature: sharedReco.candidate_pool.candidate_pool_signature,
            candidate_pool_signature_version: sharedReco.candidate_pool.candidate_pool_signature_version,
          },
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
            grounding_status: recommendationMeta.grounding_status || payload.grounding_status || null,
          },
        ],
      },
      next_actions: this._buildNextActions({ targetIngredient }),
      _taskMode: 'recommendation',
      _promptHash: recommendationMeta.llm_trace && recommendationMeta.llm_trace.prompt_hash
        ? recommendationMeta.llm_trace.prompt_hash
        : null,
      _llmCalls: 1,
      _meta: {
        analysis_context_usage: recommendationMeta.analysis_context_usage || sharedReco.request_context.context_usage,
        request_context_signature: sharedReco.request_context.request_context_signature,
        request_context_signature_version: sharedReco.request_context.request_context_signature_version,
        candidate_pool_signature: sharedReco.candidate_pool.candidate_pool_signature,
        candidate_pool_signature_version: sharedReco.candidate_pool.candidate_pool_signature_version,
        fallback_mode: sharedReco.core_result.fallback_mode,
        mainline_status: upstreamReco.mainlineStatus || recommendationMeta.mainline_status || null,
        strictness_source: sharedReco.request_context.strictness_source,
      },
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

RecoStepBasedSkill.__setSharedRecoCoreRunnerForTest = function __setSharedRecoCoreRunnerForTest(fn) {
  sharedRecoCoreRunnerOverride = typeof fn === 'function' ? fn : null;
};

RecoStepBasedSkill.__resetSharedRecoCoreRunnerForTest = function __resetSharedRecoCoreRunnerForTest() {
  sharedRecoCoreRunnerOverride = null;
};

module.exports = RecoStepBasedSkill;
