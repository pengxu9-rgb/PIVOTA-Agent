const { getQualityGateForSkill } = require('../validators/schema_validator');

class QualityGateEngine {
  constructor() {
    this._handlers = new Map();
    this._registerBuiltinHandlers();
  }

  evaluate(skillId, response, request) {
    const gate = getQualityGateForSkill(skillId);
    if (!gate) {
      return { passed: true, issues: [], remediations: [] };
    }

    const issues = [];
    const remediations = [];

    for (const rule of gate.rules || []) {
      const handler = this._handlers.get(rule.rule_id) || this._handlers.get('_default');
      const result = handler(rule, response, request);
      if (result.passed) continue;

      issues.push({
        code: rule.rule_id,
        message: result.message || rule.check,
        severity: rule.severity || 'warning',
      });

      if (result.remediation) {
        remediations.push({
          rule_id: rule.rule_id,
          action: rule.on_fail,
          detail: result.remediation,
        });
      }
    }

    return {
      passed: !issues.some((issue) => issue.severity === 'error'),
      issues,
      remediations,
    };
  }

  applyRemediations(response, remediations) {
    for (const remediation of remediations || []) {
      if (remediation.action === 'strip_visual_references') {
        response.cards = (response.cards || []).map((card) => ({
          ...card,
          sections: (card.sections || []).filter((section) => section.type !== 'visual_analysis'),
        }));
      }
      if (remediation.action === 'correct_spf_schedule') {
        this._correctSpfSchedule(response);
      }
      if (remediation.action === 'correct_retinoid_schedule') {
        this._correctRetinoidSchedule(response);
      }
    }
    return response;
  }

  _correctSpfSchedule(response) {
    for (const card of response.cards || []) {
      for (const section of card.sections || []) {
        const candidateSteps = [
          ...(section.am_steps || []),
          ...(section.optimized_am_steps || []),
        ];
        for (const step of candidateSteps) {
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
        const pmSteps = section.pm_steps || section.optimized_pm_steps || [];
        for (const step of amSteps) {
          const blockedProducts = (step.products || []).filter((product) => product.concepts?.includes('RETINOID'));
          if (blockedProducts.length === 0) continue;

          step.products = (step.products || []).filter((product) => !product.concepts?.includes('RETINOID'));
          let pmTreatmentStep = pmSteps.find((candidate) => String(candidate.step_id || '').includes('treatment'));
          if (!pmTreatmentStep) {
            pmTreatmentStep = {
              step_id: 'pm_treatment',
              name_en: 'Treatment',
              name_zh: '功效产品',
              products: [],
            };
            pmSteps.push(pmTreatmentStep);
          }
          pmTreatmentStep.products = [
            ...(pmTreatmentStep.products || []),
            ...blockedProducts.map((product) => ({ ...product, time_of_day: 'pm' })),
          ];
        }
      }
    }
  }

  _registerBuiltinHandlers() {
    this._handlers.set('_default', () => ({ passed: true }));

    this._handlers.set('qg_diag_no_photo_no_visual_cues', (_rule, response, request) => {
      const hasPhoto = request.context?.profile?.has_photo === true;
      if (hasPhoto) return { passed: true };
      const hasVisual = (response.cards || []).some((card) =>
        (card.sections || []).some((section) => section.type === 'visual_analysis')
      );
      return {
        passed: !hasVisual,
        message: hasVisual ? 'Visual analysis present but user has no photo' : null,
        remediation: hasVisual ? 'strip_visual_references' : null,
      };
    });

    this._handlers.set('qg_insights_no_photo_guard', (_rule, response, request) => {
      const hasPhotos = (request.context?.recent_logs || []).some((log) => log?.has_photo);
      if (hasPhotos) return { passed: true };

      const serialized = JSON.stringify(response.cards || []).toLowerCase();
      const forbiddenTerms = ['visible improvement', 'can see', 'looks like', 'photo shows', '可见改善', '看起来'];
      const found = forbiddenTerms.find((term) => serialized.includes(term));
      return {
        passed: !found,
        message: found ? `References "${found}" but no photos are available` : null,
        remediation: found ? 'strip_visual_references' : null,
      };
    });

    this._handlers.set('qg_audit_spf_am_only', (_rule, response) => {
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

    this._handlers.set('qg_audit_retinoid_pm_only', (_rule, response) => {
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

    this._handlers.set('qg_checkin_bound_to_entity', (_rule, response) => {
      const threadOps = response.ops?.thread_ops || [];
      const hasBinding = threadOps.some(
        (operation) =>
          operation.key === 'checkin_log' &&
          (operation.value?.bound_diagnosis_id || operation.value?.bound_routine_id)
      );
      return {
        passed: hasBinding,
        message: hasBinding ? null : 'Check-in was not bound to any diagnosis or routine entity',
      };
    });

    this._handlers.set('qg_insights_min_data', (_rule, _response, request) => {
      const logCount = Array.isArray(request.context?.recent_logs) ? request.context.recent_logs.length : 0;
      return {
        passed: logCount >= 3,
        message: logCount >= 3 ? null : `Only ${logCount} check-ins are available; 3+ is recommended`,
      };
    });
  }
}

module.exports = QualityGateEngine;
