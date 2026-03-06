const DiagnosisStartSkill = require('../skills/diagnosis_v2_start');
const DiagnosisAnswerSkill = require('../skills/diagnosis_v2_answer');
const RoutineApplyBlueprintSkill = require('../skills/routine_apply_blueprint');
const RoutineIntakeProductsSkill = require('../skills/routine_intake_products');
const RoutineAuditOptimizeSkill = require('../skills/routine_audit_optimize');
const RecoStepBasedSkill = require('../skills/reco_step_based');
const TrackerCheckinLogSkill = require('../skills/tracker_checkin_log');
const TrackerCheckinInsightsSkill = require('../skills/tracker_checkin_insights');
const ProductAnalyzeSkill = require('../skills/product_analyze');
const IngredientReportSkill = require('../skills/ingredient_report');
const DupeSuggestSkill = require('../skills/dupe_suggest');
const DupeCompareSkill = require('../skills/dupe_compare');
const TravelApplyModeSkill = require('../skills/travel_apply_mode');
const ExploreAddToRoutineSkill = require('../skills/explore_add_to_routine');

const SKILL_MAP = {
  'diagnosis_v2.start': DiagnosisStartSkill,
  'diagnosis_v2.answer': DiagnosisAnswerSkill,
  'routine.apply_blueprint': RoutineApplyBlueprintSkill,
  'routine.intake_products': RoutineIntakeProductsSkill,
  'routine.audit_optimize': RoutineAuditOptimizeSkill,
  'reco.step_based': RecoStepBasedSkill,
  'tracker.checkin_log': TrackerCheckinLogSkill,
  'tracker.checkin_insights': TrackerCheckinInsightsSkill,
  'product.analyze': ProductAnalyzeSkill,
  'ingredient.report': IngredientReportSkill,
  'dupe.suggest': DupeSuggestSkill,
  'dupe.compare': DupeCompareSkill,
  'travel.apply_mode': TravelApplyModeSkill,
  'explore.add_to_routine': ExploreAddToRoutineSkill,
};

/**
 * Resolve canonical_intent + thread_state + entry_source to a skill_id.
 * Aligned with AURORA_CHAT_TRIGGER_MATRIX trigger_source + canonical_intent + allow_reco.
 */
function resolveSkillId({ intent, threadState, entrySource }) {
  if (entrySource === 'chip.start.diagnosis' || intent === 'skin_diagnosis') {
    const hasGoal = threadState?.diagnosis_goals?.length > 0;
    return hasGoal ? 'diagnosis_v2.answer' : 'diagnosis_v2.start';
  }

  if (entrySource === 'chip.action.apply_blueprint' || intent === 'apply_blueprint') {
    return 'routine.apply_blueprint';
  }

  if (entrySource === 'chip.action.intake_products' || intent === 'intake_products') {
    return 'routine.intake_products';
  }

  if (entrySource === 'chip.action.audit_optimize' || intent === 'audit_optimize') {
    return 'routine.audit_optimize';
  }

  if (
    entrySource === 'chip.start.reco_products' ||
    intent === 'recommend_products' ||
    intent === 'step_recommendation'
  ) {
    return 'reco.step_based';
  }

  if (entrySource === 'chip.action.checkin' || intent === 'checkin_log') {
    return 'tracker.checkin_log';
  }

  if (intent === 'checkin_insights' || intent === 'tracker_trends') {
    return 'tracker.checkin_insights';
  }

  if (
    entrySource === 'chip.action.analyze_product' ||
    intent === 'evaluate_product' ||
    intent === 'product_analysis'
  ) {
    return 'product.analyze';
  }

  if (intent === 'ingredient_report' || intent === 'ingredient_science') {
    return 'ingredient.report';
  }

  if (entrySource === 'chip.action.dupe_suggest' || intent === 'dupe_suggest') {
    return 'dupe.suggest';
  }

  if (entrySource === 'chip.action.dupe_compare' || intent === 'dupe_compare') {
    return 'dupe.compare';
  }

  if (intent === 'travel_mode' || intent === 'travel_adjust') {
    if (threadState?.travel_plan || threadState?.travel_mode_active) {
      return 'travel.apply_mode';
    }
  }

  if (intent === 'add_to_routine' || entrySource === 'chip.action.add_to_routine') {
    return 'explore.add_to_routine';
  }

  return null;
}

class SkillRouter {
  constructor(llmGateway) {
    this._llmGateway = llmGateway;
    this._skillInstances = {};

    const QualityGateEngine = require('./quality_gate_engine');
    this._qualityGateEngine = new QualityGateEngine();
  }

  _getSkill(skillId) {
    if (!this._skillInstances[skillId]) {
      const SkillClass = SKILL_MAP[skillId];
      if (!SkillClass) {
        return null;
      }
      this._skillInstances[skillId] = new SkillClass();
    }
    return this._skillInstances[skillId];
  }

  async route(request) {
    const skillId =
      request.skill_id ||
      resolveSkillId({
        intent: request.intent,
        threadState: request.thread_state,
        entrySource: request.params?.entry_source,
      });

    if (!skillId) {
      return {
        cards: [
          {
            card_type: 'empty_state',
            sections: [
              {
                type: 'empty_state_message',
                message_en: 'I\'m not sure what you\'d like to do. Try selecting an option.',
                message_zh: '我不太确定你想做什么，请试试选择一个选项。',
              },
            ],
          },
        ],
        ops: { thread_ops: [], profile_patch: {}, routine_patch: {}, experiment_events: [] },
        quality: {
          schema_valid: true,
          quality_ok: false,
          issues: [{ code: 'UNRESOLVED_INTENT', message: `Cannot resolve intent: ${request.intent}`, severity: 'error' }],
          preconditions_met: false,
          precondition_failures: [],
        },
        telemetry: {
          call_id: require('crypto').randomUUID(),
          skill_id: 'orchestrator.unresolved',
          skill_version: '1.0.0',
          prompt_hash: null,
          task_mode: 'unknown',
          elapsed_ms: 0,
          llm_calls: 0,
        },
        next_actions: [
          { action_type: 'navigate_skill', target_skill_id: 'diagnosis_v2.start', label: { en: 'Start diagnosis', zh: '开始诊断' } },
          { action_type: 'show_chip', label: { en: 'Analyze a product', zh: '分析产品' } },
        ],
      };
    }

    const skill = this._getSkill(skillId);
    if (!skill) {
      throw new Error(`Skill ${skillId} not found in registry`);
    }

    const result = await skill.run(request, this._llmGateway);

    const gateResult = this._qualityGateEngine.evaluate(skillId, result, request);
    if (!gateResult.passed) {
      result.quality.quality_ok = false;
      result.quality.issues = [
        ...(result.quality.issues || []),
        ...gateResult.issues,
      ];
      this._qualityGateEngine.applyRemediations(result, gateResult.remediations);
    }

    if (!result.quality.quality_ok) {
      return this._applyDegradation(result, skillId);
    }

    return result;
  }

  /**
   * When quality gate fails, degrade gracefully: keep the response but
   * inject warnings and ensure next_actions exist.
   */
  _applyDegradation(result, skillId) {
    if (!result.next_actions || result.next_actions.length === 0) {
      result.next_actions = [
        {
          action_type: 'navigate_skill',
          target_skill_id: 'diagnosis_v2.start',
          label: { en: 'Start over', zh: '重新开始' },
        },
      ];
    }
    return result;
  }
}

module.exports = { SkillRouter, resolveSkillId };
