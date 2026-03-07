const { getQualityGateForSkill } = require('../validators/schema_validator');

/**
 * Centralized quality gate engine.
 * Evaluates quality_gates.json rules after skill execution.
 * Supplements per-skill validateOutput() with contract-level enforcement.
 */
class QualityGateEngine {
  constructor() {
    this._handlers = new Map();
    this._registerBuiltinHandlers();
  }

  /**
   * Run quality gates for a skill response.
   * Returns { passed, issues[], remediations[] }.
   */
  evaluate(skillId, response, request) {
    const gate = getQualityGateForSkill(skillId);
    if (!gate) {
      return { passed: true, issues: [], remediations: [] };
    }

    const issues = [];
    const remediations = [];

    for (const rule of gate.rules) {
      const handler = this._handlers.get(rule.rule_id) || this._handlers.get('_default');
      const result = handler(rule, response, request);

      if (!result.passed) {
        issues.push({
          code: rule.rule_id,
          message: result.message || rule.check,
          severity: rule.severity || 'error',
        });

        if (result.remediation) {
          remediations.push({
            rule_id: rule.rule_id,
            action: rule.on_fail,
            detail: result.remediation,
          });
        }
      }
    }

    const hasErrors = issues.some((i) => i.severity === 'error');

    return {
      passed: !hasErrors,
      issues,
      remediations,
    };
  }

  /**
   * Apply auto-remediations to the response where possible.
   */
  applyRemediations(response, remediations) {
    for (const rem of remediations) {
      switch (rem.action) {
        case 'inject_fallback_action':
          if (!response.next_actions || response.next_actions.length === 0) {
            response.next_actions = [
              {
                action_type: 'navigate_skill',
                target_skill_id: 'diagnosis_v2.start',
                label: { en: 'Start over', zh: '重新开始' },
              },
            ];
          }
          break;

        case 'strip_visual_references':
          response.cards = (response.cards || []).map((card) => ({
            ...card,
            sections: card.sections.filter((s) => s.type !== 'visual_analysis'),
          }));
          break;

        case 'correct_spf_schedule':
          this._correctSpfSchedule(response);
          break;

        case 'correct_retinoid_schedule':
          this._correctRetinoidSchedule(response);
          break;

        case 'strip_product_claims':
          this._stripIngredientProductClaims(response);
          break;

        case 'filter_blocked_steps':
        case 'filter_blocked_products':
          break;

        default:
          break;
      }
    }
    return response;
  }

  _correctSpfSchedule(response) {
    for (const card of response.cards || []) {
      for (const section of card.sections || []) {
        const steps = [
          ...(section.am_steps || []),
          ...(section.optimized_am_steps || []),
        ];
        for (const step of steps) {
          for (const product of step.products || []) {
            if (product.concepts?.includes('SUNSCREEN') || product.is_spf) {
              product.time_of_day = 'am';
              product.frequency = 'daily';
              product.reapply = 'every 2h when outdoors';
            }
          }
        }
      }
    }
  }

  _correctRetinoidSchedule(response) {
    for (const card of response.cards || []) {
      for (const section of card.sections || []) {
        const amSteps = section.am_steps || section.optimized_am_steps || [];
        for (const step of amSteps) {
          const retinoidProducts = (step.products || []).filter(
            (p) => p.concepts?.includes('RETINOID')
          );
          if (retinoidProducts.length > 0) {
            step.products = step.products.filter(
              (p) => !p.concepts?.includes('RETINOID')
            );
            const pmSteps = section.pm_steps || section.optimized_pm_steps || [];
            let treatmentStep = pmSteps.find((s) => s.step_id?.includes('treatment'));
            if (!treatmentStep) {
              treatmentStep = {
                step_id: 'pm_treatment',
                name_en: 'Treatment',
                name_zh: '功效产品',
                products: [],
              };
              pmSteps.push(treatmentStep);
            }
            treatmentStep.products = [
              ...(treatmentStep.products || []),
              ...retinoidProducts.map((p) => ({ ...p, time_of_day: 'pm' })),
            ];
          }
        }
      }
    }
  }

  _stripIngredientProductClaims(response) {
    for (const card of response.cards || []) {
      for (const section of card.sections || []) {
        if (section.type !== 'ingredient_claims') {
          continue;
        }

        section.claims = (section.claims || []).map((claim) => {
          const text = JSON.stringify(claim || {}).toLowerCase();
          const hasForbiddenText =
            text.includes('products containing') ||
            text.includes('products with this ingredient') ||
            text.includes('含该成分的产品');

          if (!hasForbiddenText) {
            return claim;
          }

          return {
            ...claim,
            text_en:
              'Unable to confirm product-level presence for this ingredient without ontology verification.',
            text_zh: '在未完成成分词典验证前，无法确认具体产品层面的成分归属。',
          };
        });
      }
    }
  }

  _registerBuiltinHandlers() {
    this._handlers.set('_default', (rule, response, _request) => {
      return { passed: true };
    });

    this._handlers.set('qg_diag_start_next_actions', (rule, response) => {
      const passed = response.next_actions?.length >= 1;
      return {
        passed,
        message: 'next_actions must be non-empty',
        remediation: !passed ? 'inject_fallback_action' : null,
      };
    });

    this._handlers.set('qg_diag_answer_next_actions', (rule, response) => {
      const passed = response.next_actions?.length >= 1;
      return {
        passed,
        message: 'next_actions must be non-empty',
        remediation: !passed ? 'inject_fallback_action' : null,
      };
    });

    this._handlers.set('qg_reco_next_actions', (rule, response) => {
      const passed = response.next_actions?.length >= 1;
      return {
        passed,
        message: 'next_actions must be non-empty',
        remediation: !passed ? 'inject_fallback_action' : null,
      };
    });

    this._handlers.set('qg_diag_no_photo_no_visual_cues', (rule, response, request) => {
      const hasPhoto = request.context?.profile?.has_photo === true;
      if (hasPhoto) return { passed: true };

      const hasVisual = (response.cards || []).some((c) =>
        (c.sections || []).some((s) => s.type === 'visual_analysis')
      );
      return {
        passed: !hasVisual,
        message: 'Visual analysis present but user has no photo',
        remediation: hasVisual ? 'strip_visual_references' : null,
      };
    });

    this._handlers.set('qg_insights_no_photo_guard', (rule, response, request) => {
      const hasPhotos = request.context?.recent_logs?.some((l) => l.has_photo);
      if (hasPhotos) return { passed: true };

      const text = JSON.stringify(response.cards || []).toLowerCase();
      const forbidden = ['visible improvement', 'can see', 'looks like', 'photo shows', '可见改善', '看起来'];
      const found = forbidden.find((t) => text.includes(t));
      return {
        passed: !found,
        message: found ? `References "${found}" but no photos available` : null,
        remediation: found ? 'strip_visual_references' : null,
      };
    });

    this._handlers.set('qg_audit_spf_am_only', (rule, response) => {
      for (const card of response.cards || []) {
        for (const section of card.sections || []) {
          for (const step of section.pm_steps || section.optimized_pm_steps || []) {
            for (const product of step.products || []) {
              if (product.concepts?.includes('SUNSCREEN')) {
                return {
                  passed: false,
                  message: 'SPF product found in PM routine',
                  remediation: 'correct_spf_schedule',
                };
              }
            }
          }
        }
      }
      return { passed: true };
    });

    this._handlers.set('qg_audit_retinoid_pm_only', (rule, response) => {
      for (const card of response.cards || []) {
        for (const section of card.sections || []) {
          for (const step of section.am_steps || section.optimized_am_steps || []) {
            for (const product of step.products || []) {
              if (product.concepts?.includes('RETINOID')) {
                return {
                  passed: false,
                  message: 'Retinoid found in AM routine',
                  remediation: 'correct_retinoid_schedule',
                };
              }
            }
          }
        }
      }
      return { passed: true };
    });

    this._handlers.set('qg_checkin_bound_to_entity', (rule, response) => {
      const ops = response.ops?.thread_ops || [];
      const hasBinding = ops.some(
        (op) =>
          op.key === 'checkin_log' &&
          (op.value?.bound_diagnosis_id || op.value?.bound_routine_id)
      );
      return {
        passed: hasBinding,
        message: !hasBinding ? 'Check-in not bound to any entity' : null,
      };
    });

    this._handlers.set('qg_insights_min_data', (rule, response, request) => {
      const logs = request.context?.recent_logs || [];
      return {
        passed: logs.length >= 3,
        message: logs.length < 3 ? `Only ${logs.length} check-ins, need 3+` : null,
      };
    });

    this._handlers.set('qg_ingredient_no_unverified_product_claims', (_rule, response, request) => {
      const verified = request.params?._resolved_ingredient != null;
      if (verified) {
        return { passed: true };
      }

      const text = JSON.stringify(response).toLowerCase();
      const found =
        ['products containing', 'products with this ingredient', '含该成分的产品'].find((term) =>
          text.includes(term)
        ) || null;

      return {
        passed: !found,
        message: found
          ? `Unverified ingredient response contains forbidden claim: ${found}`
          : null,
        remediation: found ? 'strip_product_claims' : null,
      };
    });
  }
}

module.exports = QualityGateEngine;
