const BaseSkill = require('./BaseSkill');

class RoutineAuditOptimizeSkill extends BaseSkill {
  constructor() {
    super('routine.audit_optimize', '1.0.0');
  }

  async checkPreconditions(request) {
    const routine = request.context?.current_routine;
    const hasProducts = this._routineHasProducts(routine);
    if (!hasProducts) {
      return {
        met: false,
        failures: [
          {
            rule_id: 'pre_has_routine_with_products',
            reason: 'Routine has no assigned products',
            on_fail_target: 'routine.intake_products',
            on_fail_message_en: 'Add your current products to the routine first.',
            on_fail_message_zh: '请先把你现在用的产品添加到护肤流程中。',
          },
        ],
      };
    }
    return { met: true, failures: [] };
  }

  _routineHasProducts(routine) {
    if (!routine) return false;
    const allSteps = [...(routine.am_steps || []), ...(routine.pm_steps || [])];
    return allSteps.some((s) => s.products?.length > 0);
  }

  async execute(request, llmGateway) {
    const { context } = request;
    const routine = context.current_routine;
    const safetyFlags = context.safety_flags || [];
    const interactionRules = request.params?._interaction_rules || [];

    const auditResults = this._runDeterministicAudit(routine, safetyFlags);

    const llmResult = await llmGateway.call({
      templateId: 'routine_audit_optimize',
      taskMode: 'routine',
      params: {
        routine,
        profile: context.profile,
        audit_results: auditResults,
        safety_flags: safetyFlags,
        locale: context.locale || 'en',
      },
      schema: 'RoutineAuditOutput',
    });

    const audit = llmResult.parsed;

    const cards = [
      {
        card_type: 'routine',
        sections: [
          {
            type: 'routine_structured',
            routine_id: routine.routine_id,
            optimized_am_steps: audit.optimized_am_steps || routine.am_steps,
            optimized_pm_steps: audit.optimized_pm_steps || routine.pm_steps,
            changes_applied: audit.changes || [],
          },
        ],
      },
    ];

    if (audit.compatibility_issues?.length > 0) {
      cards.push({
        card_type: 'compatibility',
        sections: [
          {
            type: 'compatibility_structured',
            issues: audit.compatibility_issues,
          },
        ],
      });
    }

    return {
      cards,
      ops: {
        thread_ops: [],
        profile_patch: {},
        routine_patch: {
          optimized: true,
          changes: audit.changes,
        },
        experiment_events: [],
      },
      next_actions: [
        {
          action_type: 'show_chip',
          label: { en: 'Apply optimizations', zh: '应用优化方案' },
        },
        {
          action_type: 'navigate_skill',
          target_skill_id: 'reco.step_based',
          label: { en: 'Fill gaps with recommendations', zh: '用推荐产品填补空缺' },
        },
        {
          action_type: 'navigate_skill',
          target_skill_id: 'tracker.checkin_log',
          label: { en: 'Start tracking', zh: '开始打卡记录' },
        },
      ],
      _promptHash: llmResult.promptHash,
      _taskMode: 'routine',
      _llmCalls: 1,
    };
  }

  /**
   * Deterministic pre-LLM audit: SPF schedule, retinoid schedule,
   * interaction_rules checks.
   */
  _runDeterministicAudit(routine, safetyFlags) {
    const issues = [];
    const allSteps = [...(routine.am_steps || []), ...(routine.pm_steps || [])];

    for (const step of routine.am_steps || []) {
      for (const product of step.products || []) {
        if (product.concepts?.includes('RETINOID')) {
          issues.push({
            code: 'RETINOID_IN_AM',
            step_id: step.step_id,
            product_id: product.product_id,
            fix: 'move_to_pm',
            message: 'Retinoids should be used PM only',
          });
        }
      }
    }

    for (const step of routine.pm_steps || []) {
      for (const product of step.products || []) {
        if (product.concepts?.includes('SUNSCREEN')) {
          issues.push({
            code: 'SPF_IN_PM',
            step_id: step.step_id,
            product_id: product.product_id,
            fix: 'move_to_am',
            message: 'Sunscreen should be used AM only',
          });
        }
      }
    }

    const amConcepts = new Set();
    const pmConcepts = new Set();
    for (const step of routine.am_steps || []) {
      for (const p of step.products || []) {
        (p.concepts || []).forEach((c) => amConcepts.add(c));
      }
    }
    for (const step of routine.pm_steps || []) {
      for (const p of step.products || []) {
        (p.concepts || []).forEach((c) => pmConcepts.add(c));
      }
    }

    const highRiskPairs = [
      ['RETINOID', 'AHA'],
      ['RETINOID', 'BHA'],
      ['AHA', 'BHA'],
      ['AHA', 'BENZOYL_PEROXIDE'],
      ['BHA', 'BENZOYL_PEROXIDE'],
    ];

    for (const [a, b] of highRiskPairs) {
      if (pmConcepts.has(a) && pmConcepts.has(b)) {
        issues.push({
          code: 'HIGH_RISK_INTERACTION_PM',
          concepts: [a, b],
          fix: 'separate_days',
          message: `${a} + ${b} in same PM routine: separate to alternate nights`,
        });
      }
    }

    return issues;
  }
}

module.exports = RoutineAuditOptimizeSkill;
