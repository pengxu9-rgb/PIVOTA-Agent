const crypto = require('crypto');
const DiagnosisStartSkill = require('../skills/diagnosis_v2_start');
const DiagnosisAnswerSkill = require('../skills/diagnosis_v2_answer');
const RoutineApplyBlueprintSkill = require('../skills/routine_apply_blueprint');
const RoutineIntakeProductsSkill = require('../skills/routine_intake_products');
const RoutineAuditOptimizeSkill = require('../skills/routine_audit_optimize');
const RecoStepBasedSkill = require('../skills/reco_step_based');
const TrackerCheckinLogSkill = require('../skills/tracker_checkin_log');
const TrackerCheckinInsightsSkill = require('../skills/tracker_checkin_insights');
const ProductAnalyzeSkill = require('../skills/product_analyze');
const ProductPipelineAuditStatusSkill = require('../skills/product_pipeline_audit_status');
const IngredientReportSkill = require('../skills/ingredient_report');
const DupeSuggestSkill = require('../skills/dupe_suggest');
const DupeCompareSkill = require('../skills/dupe_compare');
const TravelApplyModeSkill = require('../skills/travel_apply_mode');
const ExploreAddToRoutineSkill = require('../skills/explore_add_to_routine');
const QualityGateEngine = require('./quality_gate_engine');
const { hasCompleteTravelPlan, hasTravelCue } = require('../travelPlanUtils');
const { extractRecoTargetStepFromText, normalizeRecoTargetStep } = require('../recoTargetStep');

const SKILL_MAP = Object.freeze({
  'diagnosis_v2.start': DiagnosisStartSkill,
  'diagnosis_v2.answer': DiagnosisAnswerSkill,
  'routine.apply_blueprint': RoutineApplyBlueprintSkill,
  'routine.intake_products': RoutineIntakeProductsSkill,
  'routine.audit_optimize': RoutineAuditOptimizeSkill,
  'reco.step_based': RecoStepBasedSkill,
  'tracker.checkin_log': TrackerCheckinLogSkill,
  'tracker.checkin_insights': TrackerCheckinInsightsSkill,
  'product.analyze': ProductAnalyzeSkill,
  'product.pipeline.audit_status': ProductPipelineAuditStatusSkill,
  'ingredient.report': IngredientReportSkill,
  'dupe.suggest': DupeSuggestSkill,
  'dupe.compare': DupeCompareSkill,
  'travel.apply_mode': TravelApplyModeSkill,
  'explore.add_to_routine': ExploreAddToRoutineSkill,
});

const INTENT_TO_SKILL = Object.freeze({
  skin_diagnosis: 'diagnosis_v2.start',
  apply_blueprint: 'routine.apply_blueprint',
  intake_products: 'routine.intake_products',
  audit_optimize: 'routine.audit_optimize',
  recommend_products: 'reco.step_based',
  step_recommendation: 'reco.step_based',
  checkin_log: 'tracker.checkin_log',
  checkin_insights: 'tracker.checkin_insights',
  tracker_trends: 'tracker.checkin_insights',
  evaluate_product: 'product.analyze',
  product_analysis: 'product.analyze',
  product_pipeline_audit_status: 'product.pipeline.audit_status',
  ingredient_report: 'ingredient.report',
  ingredient_science: 'ingredient.report',
  ingredient_query: 'ingredient.report',
  dupe_suggest: 'dupe.suggest',
  dupe_compare: 'dupe.compare',
  travel_mode: 'travel.apply_mode',
  travel_adjust: 'travel.apply_mode',
  add_to_routine: 'explore.add_to_routine',
});

const ENTRY_SOURCE_TO_SKILL = Object.freeze({
  'chip.start.diagnosis': 'diagnosis_v2.start',
  'chip_start_diagnosis': 'diagnosis_v2.start',
  'chip.action.apply_blueprint': 'routine.apply_blueprint',
  'chip_start_diagnosis': 'diagnosis_v2.start',
  'chip.action.intake_products': 'routine.intake_products',
  'chip.action.audit_optimize': 'routine.audit_optimize',
  'chip.start.reco_products': 'reco.step_based',
  'chip.start.dupes': 'dupe.suggest',
  'chip.action.checkin': 'tracker.checkin_log',
  'chip.action.analyze_product': 'product.analyze',
  'chip.action.dupe_suggest': 'dupe.suggest',
  'chip.action.dupe_compare': 'dupe.compare',
  'chip.action.add_to_routine': 'explore.add_to_routine',
});

function resolveSkillId({ intent, threadState, entrySource }) {
  if (entrySource && ENTRY_SOURCE_TO_SKILL[entrySource]) {
    const baseSkillId = ENTRY_SOURCE_TO_SKILL[entrySource];
    if (baseSkillId === 'diagnosis_v2.start' && Array.isArray(threadState?.diagnosis_goals) && threadState.diagnosis_goals.length > 0) {
      return 'diagnosis_v2.answer';
    }
    return baseSkillId;
  }

  if (intent && INTENT_TO_SKILL[intent]) {
    const baseSkillId = INTENT_TO_SKILL[intent];
    if (baseSkillId === 'diagnosis_v2.start' && Array.isArray(threadState?.diagnosis_goals) && threadState.diagnosis_goals.length > 0) {
      return 'diagnosis_v2.answer';
    }
    return baseSkillId;
  }

  return null;
}

function extractUserMessage(request) {
  return (
    request?.params?.user_message ||
    request?.params?.message ||
    request?.params?.text ||
    null
  );
}

function extractDupeCompareProductsFromText(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];

  const normalized = raw
    .replace(/\s+/g, ' ')
    .replace(/[？?！!。．]+$/g, '')
    .trim();
  if (!normalized) return [];

  const patterns = [
    /^(?:compare|check compatibility between|compare between|what(?:'s| is) the difference between)\s+(.+?)\s+(?:vs\.?|versus|and)\s+(.+)$/i,
    /^(.+?)\s+(?:vs\.?|versus)\s+(.+)$/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) continue;
    const left = String(match[1] || '').trim().replace(/^between\s+/i, '');
    const right = String(match[2] || '').trim();
    if (!left || !right) continue;
    if (left.toLowerCase() === right.toLowerCase()) continue;
    return [left, right];
  }

  return [];
}

function resolveDeterministicTravelSkill(request, userMessage) {
  if (!hasTravelCue(userMessage)) return null;
  if (!hasCompleteTravelPlan(request?.context?.travel_plan)) return null;
  return 'travel.apply_mode';
}

function compactText(value) {
  if (value == null) return '';
  return String(value).trim();
}

function isFreeTextUserTurn(request, userMessage = extractUserMessage(request)) {
  const entrySource = compactText(request?.params?.entry_source).toLowerCase();
  return Boolean(compactText(userMessage)) && !entrySource.startsWith('chip.');
}

function detectProfileMismatchGuard(request, userMessage = extractUserMessage(request)) {
  const lower = compactText(userMessage).toLowerCase();
  const profileSkinType = compactText(request?.context?.profile?.skin_type || request?.context?.profile?.skinType).toLowerCase();
  const asksAboutDryness = /(dry|dryness|tight|tightness|dehydrat)/i.test(lower);
  const asksAboutOiliness = /(oil|oily|greasy|shine|shiny)/i.test(lower);
  return (
    (profileSkinType === 'oily' && asksAboutDryness) ||
    (profileSkinType === 'dry' && asksAboutOiliness)
  );
}

function getProfileMismatchWatchoutSpec(request, userMessage = extractUserMessage(request)) {
  const lower = compactText(userMessage).toLowerCase();
  const profileSkinType = compactText(request?.context?.profile?.skin_type || request?.context?.profile?.skinType).toLowerCase();
  const asksAboutDryness = /(dry|dryness|tight|tightness|dehydrat)/i.test(lower);
  const asksAboutOiliness = /(oil|oily|greasy|shine|shiny)/i.test(lower);

  if (profileSkinType === 'oily' && asksAboutDryness) {
    return {
      key: 'oily_dryness',
      en: 'Because your skin usually runs oily, keep hydration lightweight and avoid piling on heavy occlusives if they make you feel greasy or congested.',
      zh: '如果你平时偏油，补水尽量轻薄；如果厚重封闭型产品会让你觉得油闷或容易堵塞，就不要叠得太重。',
      enPattern: /(oily|greasy|occlusive|congest)/i,
      zhPattern: /(偏油|轻薄|封闭|油闷|堵塞)/,
    };
  }

  if (profileSkinType === 'dry' && asksAboutOiliness) {
    return {
      key: 'dry_oiliness',
      en: 'Because your skin usually runs dry, avoid over-stripping cleansers or repeated strong oil-control actives that can leave you tighter and more irritated.',
      zh: '如果你平时偏干，别用过度清洁或反复叠加强控油活性，否则更容易越控越干、越刺激。',
      enPattern: /(dry|stripping|irritated|tight)/i,
      zhPattern: /(偏干|过度清洁|控油活性|刺激)/,
    };
  }

  return null;
}

function deriveTargetStep(request, classification) {
  const explicit = normalizeRecoTargetStep(
    request?.params?.target_step
    || classification?.entities?.target_step,
  );
  if (explicit) return explicit;

  const userMessage = extractUserMessage(request);
  return extractRecoTargetStepFromText(userMessage);
}

class SkillRouter {
  constructor(llmGateway) {
    this._llmGateway = llmGateway;
    this._skillInstances = Object.create(null);
    this._qualityGateEngine = new QualityGateEngine();
  }

  _getSkill(skillId) {
    if (!this._skillInstances[skillId]) {
      const SkillClass = SKILL_MAP[skillId];
      if (!SkillClass) return null;
      this._skillInstances[skillId] = new SkillClass();
    }
    return this._skillInstances[skillId];
  }

  async route(request) {
    const resolved = await this._resolveSkillRequest(request);
    if (resolved.mode === 'freeform') {
      return this._handleFreeFormChat(request, resolved.userMessage);
    }
    if (!resolved.skillId) {
      return this._buildUnresolvedResponse(request);
    }

    const skill = this._getSkill(resolved.skillId);
    if (!skill) {
      throw new Error(`Skill ${resolved.skillId} not found in registry`);
    }

    this._preserveRawQuestion(request, resolved.userMessage);
    const answerPrelude = await this._maybeBuildAnswerFirstPrelude(request, resolved.userMessage);
    const response = await skill.run(request, this._llmGateway);
    const composed = this._composeSkillResponseWithAnswerPrelude(response, answerPrelude, request, resolved.userMessage);
    return this._applyQualityGates(resolved.skillId, composed, request);
  }

  async routeStream(request, onEvent) {
    const emit = typeof onEvent === 'function' ? onEvent : () => {};
    emit({
      type: 'thinking',
      step: 'analyzing_intent',
      message: 'Understanding your question...',
    });

    const resolved = await this._resolveSkillRequest(request, { emitThinking: emit });

    if (resolved.mode === 'freeform') {
      emit({
        type: 'thinking',
        step: 'generating_response',
        message: 'Preparing your answer...',
      });
      const response = await this._handleFreeFormChat(request, resolved.userMessage, {
        onChunk: (text) => emit({ type: 'chunk', text }),
      });
      emit({ type: 'result', data: response });
      return response;
    }

    if (!resolved.skillId) {
      const response = this._buildUnresolvedResponse(request);
      emit({ type: 'result', data: response });
      return response;
    }

    emit({
      type: 'thinking',
      step: 'running_skill',
      message: `Running ${resolved.skillId}...`,
    });

    const skill = this._getSkill(resolved.skillId);
    if (!skill) {
      throw new Error(`Skill ${resolved.skillId} not found in registry`);
    }

    this._preserveRawQuestion(request, resolved.userMessage);
    const answerPrelude = await this._maybeBuildAnswerFirstPrelude(request, resolved.userMessage);
    const response = await skill.run(request, this._llmGateway);
    const composed = this._composeSkillResponseWithAnswerPrelude(response, answerPrelude, request, resolved.userMessage);
    const gatedResponse = this._applyQualityGates(resolved.skillId, composed, request);
    emit({ type: 'result', data: gatedResponse });
    return gatedResponse;
  }

  async _resolveSkillRequest(request, { emitThinking } = {}) {
    let skillId = request.skill_id || resolveSkillId({
      intent: request.intent,
      threadState: request.thread_state,
      entrySource: request.params?.entry_source,
    });
    const userMessage = extractUserMessage(request);

    if (!skillId && userMessage) {
      skillId = resolveDeterministicTravelSkill(request, userMessage);
    }

    if (!skillId && userMessage) {
      const classification = await this._classifyIntent(userMessage);
      if (classification) {
        this._applyClassificationEntities(request, classification);
        if (typeof emitThinking === 'function') {
          emitThinking({
            type: 'thinking',
            step: 'intent_classified',
            message: `Identified ${classification.intent} (${Math.round((Number(classification.confidence) || 0) * 100)}%)`,
          });
        }
        skillId = this._mapClassifiedIntent(classification, request);
      }
    }

    if (!skillId && userMessage) {
      return { mode: 'freeform', userMessage, skillId: null };
    }

    return { mode: 'skill', userMessage, skillId };
  }

  async _classifyIntent(userMessage) {
    try {
      const result = await this._llmGateway.call({
        templateId: 'intent_classifier',
        taskMode: 'chat',
        params: { user_message: userMessage },
        schema: 'IntentClassifierOutput',
      });
      return result.parsed || null;
    } catch (error) {
      console.error('[SkillRouter] intent classification failed:', error.message);
      return null;
    }
  }

  _mapClassifiedIntent(classification, request) {
    const confidence = Number(classification?.confidence) || 0;
    const intent = classification?.intent || null;
    if (confidence < 0.5) return null;
    if (intent === 'general_chat' || intent === 'routine_advice') return null;
    if (intent === 'safety_escalation') return null;

    const baseSkillId = INTENT_TO_SKILL[intent] || null;
    if (!baseSkillId) return null;
    if (baseSkillId === 'diagnosis_v2.start' && Array.isArray(request?.thread_state?.diagnosis_goals) && request.thread_state.diagnosis_goals.length > 0) {
      return 'diagnosis_v2.answer';
    }
    return baseSkillId;
  }

  _applyClassificationEntities(request, classification) {
    const entities = classification?.entities || {};
    request.params = request.params || {};
    const extractedProducts = Array.isArray(entities.products)
      ? entities.products
        .map((value) => String(value || '').trim())
        .filter(Boolean)
      : [];
    const fallbackProducts = (
      classification?.intent === 'dupe_compare'
      && extractedProducts.length < 2
    )
      ? extractDupeCompareProductsFromText(entities.user_question || extractUserMessage(request))
      : [];
    const normalizedProducts = extractedProducts.length >= 2 ? extractedProducts : fallbackProducts;

    if (!request.params._user_question && entities.user_question) {
      request.params._user_question = entities.user_question;
    }
    if (!request.params.ingredient_query && Array.isArray(entities.ingredients) && entities.ingredients.length > 0) {
      request.params.ingredient_query = entities.ingredients[0];
    }
    if (!request.params.product_anchor && normalizedProducts.length > 0) {
      request.params.product_anchor = { name: normalizedProducts[0] };
    }
    if (
      classification?.intent === 'dupe_compare'
      && (!Array.isArray(request.params.comparison_targets) || request.params.comparison_targets.length === 0)
      && normalizedProducts.length > 1
    ) {
      const anchorName = String(
        request.params?.product_anchor?.name
        || request.params?.product_anchor?.display_name
        || normalizedProducts[0]
        || ''
      ).trim().toLowerCase();
      const comparisonNames = normalizedProducts
        .slice(request.params.product_anchor ? 0 : 1)
        .filter((name, index, list) => {
          const normalizedName = String(name || '').trim().toLowerCase();
          if (!normalizedName) return false;
          if (normalizedName === anchorName) return false;
          return list.findIndex((entry) => String(entry || '').trim().toLowerCase() === normalizedName) === index;
        });
      if (comparisonNames.length > 0) {
        request.params.comparison_targets = comparisonNames.map((name) => ({ name }));
      }
    }
    if (!request.params._extracted_concerns && Array.isArray(entities.concerns) && entities.concerns.length > 0) {
      request.params._extracted_concerns = entities.concerns.slice(0, 3);
    }
    if (!request.params.target_step) {
      const targetStep = deriveTargetStep(request, classification);
      if (targetStep) {
        request.params.target_step = targetStep;
      }
    }
  }

  _applyQualityGates(skillId, response, request) {
    const gateResult = this._qualityGateEngine.evaluate(skillId, response, request);
    if (!gateResult.passed) {
      response.quality.quality_ok = false;
      response.quality.issues = [...(response.quality.issues || []), ...gateResult.issues];
      this._qualityGateEngine.applyRemediations(response, gateResult.remediations);
    } else if (gateResult.issues.length > 0) {
      response.quality.issues = [...(response.quality.issues || []), ...gateResult.issues];
    }
    return response;
  }

  _preserveRawQuestion(request, userMessage) {
    if (!compactText(userMessage)) return;
    request.params = request.params || {};
    if (!request.params._user_question) {
      request.params._user_question = compactText(userMessage);
    }
  }

  _responseStartsWithTextResponse(response) {
    return response?.cards?.[0]?.card_type === 'text_response';
  }

  _buildTextResponseCard(answerEn, answerZh, safetyNotes) {
    const card = {
      card_type: 'text_response',
      sections: [
        {
          type: 'text_answer',
          text_en: answerEn,
          text_zh: answerZh || null,
        },
      ],
    };

    if (Array.isArray(safetyNotes) && safetyNotes.length > 0) {
      card.sections.push({
        type: 'safety_notes',
        notes: safetyNotes,
      });
    }

    return card;
  }

  _appendWatchoutParagraph(baseText, watchout) {
    const answer = compactText(baseText);
    const addition = compactText(watchout);
    if (!answer) return addition;
    if (!addition) return answer;
    return `${answer}\n\n${addition}`;
  }

  _enforceProfileMismatchWatchoutOnTexts(request, userMessage, answerEn, answerZh) {
    const watchout = getProfileMismatchWatchoutSpec(request, userMessage);
    if (!watchout) {
      return {
        answerEn,
        answerZh,
        enforced: false,
        profileMismatchGuardApplied: false,
      };
    }

    const hasWatchoutAlready = watchout.enPattern.test(String(answerEn || ''))
      || watchout.zhPattern.test(String(answerZh || ''));

    if (hasWatchoutAlready) {
      return {
        answerEn,
        answerZh,
        enforced: false,
        profileMismatchGuardApplied: true,
      };
    }

    return {
      answerEn: this._appendWatchoutParagraph(answerEn, watchout.en),
      answerZh: answerZh ? this._appendWatchoutParagraph(answerZh, watchout.zh) : answerZh,
      enforced: true,
      profileMismatchGuardApplied: true,
    };
  }

  _enforceLeadingTextResponseWatchout(response, request, userMessage) {
    if (!this._responseStartsWithTextResponse(response)) {
      return { response, enforced: false, profileMismatchGuardApplied: false };
    }

    const textSection = response?.cards?.[0]?.sections?.find((section) => section.type === 'text_answer');
    if (!textSection) {
      return { response, enforced: false, profileMismatchGuardApplied: false };
    }

    const enforced = this._enforceProfileMismatchWatchoutOnTexts(
      request,
      userMessage,
      textSection.text_en,
      textSection.text_zh,
    );

    textSection.text_en = enforced.answerEn;
    textSection.text_zh = enforced.answerZh || null;

    return {
      response,
      enforced: enforced.enforced,
      profileMismatchGuardApplied: enforced.profileMismatchGuardApplied,
    };
  }

  async _maybeBuildAnswerFirstPrelude(request, userMessage) {
    if (!isFreeTextUserTurn(request, userMessage)) {
      return {
        applied: false,
        profileMismatchGuardApplied: false,
        profileMismatchWatchoutEnforced: false,
        spacingArtifactDetected: false,
      };
    }

    const callId = crypto.randomUUID();
    try {
      const priorMessages = Array.isArray(request.params?.messages) ? request.params.messages : undefined;
      const chatResult = await this._llmGateway.chat({
        userMessage,
        context: request.context,
        locale: request.context?.locale,
        priorMessages,
      });
      const parsed = chatResult.parsed || {};
      const enforced = this._enforceProfileMismatchWatchoutOnTexts(
        request,
        userMessage,
        parsed.answer_en || chatResult.text,
        parsed.answer_zh || null,
      );

      return {
        applied: true,
        callId,
        parsed,
        card: this._buildTextResponseCard(enforced.answerEn, enforced.answerZh, parsed.safety_notes),
        profileMismatchGuardApplied: enforced.profileMismatchGuardApplied,
        profileMismatchWatchoutEnforced: enforced.enforced,
        spacingArtifactDetected: chatResult?.telemetry?.collapsed_spacing_pattern_detected === true,
      };
    } catch (error) {
      console.error('[SkillRouter] answer-first prelude failed:', error.message);
      return {
        applied: false,
        profileMismatchGuardApplied: detectProfileMismatchGuard(request, userMessage),
        profileMismatchWatchoutEnforced: false,
        spacingArtifactDetected: false,
      };
    }
  }

  _composeSkillResponseWithAnswerPrelude(response, prelude, request, userMessage) {
    const composed = response || {};
    const telemetry = composed.telemetry || {};
    telemetry.answer_first_applied = Boolean(prelude?.applied);
    telemetry.profile_mismatch_guard_applied = Boolean(prelude?.profileMismatchGuardApplied);
    telemetry.profile_mismatch_watchout_enforced = Boolean(prelude?.profileMismatchWatchoutEnforced);
    telemetry.collapsed_spacing_pattern_detected = Boolean(prelude?.spacingArtifactDetected);
    composed.telemetry = telemetry;

    if (!prelude?.applied || !prelude.card) {
      const patched = this._enforceLeadingTextResponseWatchout(composed, request, userMessage);
      telemetry.profile_mismatch_guard_applied = telemetry.profile_mismatch_guard_applied || patched.profileMismatchGuardApplied;
      telemetry.profile_mismatch_watchout_enforced = telemetry.profile_mismatch_watchout_enforced || patched.enforced;
      return patched.response;
    }
    if (this._responseStartsWithTextResponse(composed)) {
      const patched = this._enforceLeadingTextResponseWatchout(composed, request, userMessage);
      telemetry.profile_mismatch_guard_applied = telemetry.profile_mismatch_guard_applied || patched.profileMismatchGuardApplied;
      telemetry.profile_mismatch_watchout_enforced = telemetry.profile_mismatch_watchout_enforced || patched.enforced;
      return patched.response;
    }

    composed.cards = [prelude.card, ...(Array.isArray(composed.cards) ? composed.cards : [])];
    return composed;
  }

  async _handleFreeFormChat(request, userMessage, { onChunk } = {}) {
    const callId = crypto.randomUUID();
    const startMs = Date.now();

    try {
      const priorMessages = Array.isArray(request.params?.messages) ? request.params.messages : undefined;
      const chatResult = await this._llmGateway.chat({
        userMessage,
        context: request.context,
        locale: request.context?.locale,
        onChunk,
        priorMessages,
      });

      const parsed = chatResult.parsed || {};
      const enforced = this._enforceProfileMismatchWatchoutOnTexts(
        request,
        userMessage,
        parsed.answer_en || chatResult.text,
        parsed.answer_zh || null,
      );
      const cards = [
        this._buildTextResponseCard(enforced.answerEn, enforced.answerZh, parsed.safety_notes),
      ];

      if (Array.isArray(parsed.ingredients_mentioned) && parsed.ingredients_mentioned.length > 0) {
        cards.push({
          card_type: 'aurora_ingredient_report',
          sections: [
            {
              type: 'ingredient_list',
              ingredients: parsed.ingredients_mentioned.map((ingredient) => ({
                name: ingredient.name,
                inci: ingredient.inci || null,
                relevance: ingredient.relevance || null,
                pros: ingredient.pros_en || ingredient.pros || [],
                cons: ingredient.cons_en || ingredient.cons || [],
                evidence_level: ingredient.evidence_level || 'uncertain',
                best_for: ingredient.best_for || [],
              })),
            },
          ],
        });
      }

      const nextActions = [];
      if (Array.isArray(parsed.ingredients_mentioned) && parsed.ingredients_mentioned.length > 0) {
        nextActions.push({
          action_type: 'navigate_skill',
          target_skill_id: 'ingredient.report',
          label: { en: 'Deep dive into an ingredient', zh: '深入了解某个成分' },
          params: { ingredient_query: parsed.ingredients_mentioned[0].name },
        });
        nextActions.push({
          action_type: 'navigate_skill',
          target_skill_id: 'reco.step_based',
          label: { en: 'Find products', zh: '查找产品' },
        });
      }

      if (Array.isArray(parsed.followup_suggestions)) {
        for (const suggestion of parsed.followup_suggestions.slice(0, 2)) {
          nextActions.push({
            action_type: 'show_chip',
            label: { en: suggestion, zh: suggestion },
          });
        }
      }

      if (nextActions.length === 0) {
        nextActions.push({
          action_type: 'show_chip',
          label: { en: 'Tell me more', zh: '了解更多' },
        });
      }

      return {
        cards,
        ops: {
          thread_ops: [],
          profile_patch: {},
          routine_patch: {},
          experiment_events: [],
        },
        quality: {
          schema_valid: true,
          quality_ok: true,
          issues: [],
          preconditions_met: true,
          precondition_failures: [],
        },
        telemetry: {
          call_id: callId,
          skill_id: 'chat.freeform',
          skill_version: '1.0.0',
          prompt_hash: null,
          task_mode: 'chat',
          elapsed_ms: Date.now() - startMs,
          llm_calls: 1,
          answer_first_applied: true,
          profile_mismatch_guard_applied: enforced.profileMismatchGuardApplied,
          profile_mismatch_watchout_enforced: enforced.enforced,
          collapsed_spacing_pattern_detected: chatResult?.telemetry?.collapsed_spacing_pattern_detected === true,
        },
        next_actions: nextActions,
      };
    } catch (error) {
      console.error('[SkillRouter] free-form chat failed:', error.message);
      return this._buildUnresolvedResponse(request);
    }
  }

  _buildUnresolvedResponse(request) {
    return {
      cards: [
        {
          card_type: 'empty_state',
          sections: [
            {
              type: 'empty_state_message',
              message_en: "I'm not sure what you'd like to do. Try asking a skincare question or pick one of the next actions.",
              message_zh: '我还不确定你想执行什么操作。可以直接问护肤问题，或选择下面的下一步动作。',
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
      quality: {
        schema_valid: true,
        quality_ok: false,
        issues: [
          {
            code: 'UNRESOLVED_INTENT',
            message: `Cannot resolve intent: ${request.intent || 'unknown'}`,
            severity: 'error',
          },
        ],
        preconditions_met: false,
        precondition_failures: [],
      },
      telemetry: {
        call_id: crypto.randomUUID(),
        skill_id: 'orchestrator.unresolved',
        skill_version: '1.0.0',
        prompt_hash: null,
        task_mode: 'unknown',
        elapsed_ms: 0,
        llm_calls: 0,
      },
      next_actions: [
        {
          action_type: 'navigate_skill',
          target_skill_id: 'diagnosis_v2.start',
          label: { en: 'Start diagnosis', zh: '开始诊断' },
        },
        {
          action_type: 'show_chip',
          label: { en: 'Analyze a product', zh: '分析产品' },
        },
        {
          action_type: 'show_chip',
          label: { en: 'Ask about an ingredient', zh: '了解成分' },
        },
      ],
    };
  }
}

module.exports = {
  SkillRouter,
  resolveSkillId,
  __internal: {
    deriveTargetStep,
    detectProfileMismatchGuard,
    getProfileMismatchWatchoutSpec,
  },
};
