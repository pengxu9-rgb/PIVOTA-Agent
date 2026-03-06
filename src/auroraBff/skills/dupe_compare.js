const BaseSkill = require('./BaseSkill');

class DupeCompareSkill extends BaseSkill {
  constructor() {
    super('dupe.compare', '1.0.0');
  }

  async checkPreconditions(request) {
    const failures = [];

    if (!request.params?.product_anchor) {
      failures.push({
        rule_id: 'pre_has_anchor_product',
        reason: 'No anchor product provided',
        on_fail_message_en: 'Please share a product to compare.',
        on_fail_message_zh: '请提供要对比的产品。',
      });
    }

    const targets = request.params?.comparison_targets;
    if (!targets || targets.length === 0) {
      failures.push({
        rule_id: 'pre_has_comparison_target',
        reason: 'No comparison targets provided',
        on_fail_message_en: 'Which product would you like to compare it with?',
        on_fail_message_zh: '你想拿它跟哪个产品做对比？',
      });
    }

    return { met: failures.length === 0, failures };
  }

  async execute(request, llmGateway) {
    const { context, params } = request;

    const llmResult = await llmGateway.call({
      templateId: 'dupe_compare',
      taskMode: 'dupe',
      params: {
        anchor: params.product_anchor,
        targets: params.comparison_targets,
        profile: context.profile,
        locale: context.locale || 'en',
      },
      schema: 'DupeCompareOutput',
    });

    const comparison = llmResult.parsed;

    const sections = [
      {
        type: 'compatibility_structured',
        anchor: comparison.anchor_summary,
        comparisons: (comparison.comparisons || []).map((c) => ({
          target: c.target,
          key_ingredients_match: c.key_ingredients_match,
          texture_comparison: c.texture_comparison,
          suitability_comparison: c.suitability_comparison,
          price_comparison: c.price_comparison,
          verdict_en: c.verdict_en,
          verdict_zh: c.verdict_zh,
        })),
        comparison_mode: comparison.mode || 'full',
      },
    ];

    return {
      cards: [{ card_type: 'compatibility', sections }],
      ops: {
        thread_ops: [],
        profile_patch: {},
        routine_patch: {},
        experiment_events: [
          {
            event: 'dupe_compare_shown',
            anchor: params.product_anchor,
            target_count: params.comparison_targets?.length || 0,
          },
        ],
      },
      next_actions: [
        {
          action_type: 'navigate_skill',
          target_skill_id: 'explore.add_to_routine',
          label: { en: 'Add the better option to routine', zh: '将更优选项加入护肤流程' },
        },
        {
          action_type: 'navigate_skill',
          target_skill_id: 'dupe.suggest',
          label: { en: 'See more alternatives', zh: '查看更多替代品' },
        },
      ],
      _promptHash: llmResult.promptHash,
      _taskMode: 'dupe',
      _llmCalls: 1,
    };
  }

  async validateOutput(response, request) {
    const baseResult = await super.validateOutput(response, request);
    const issues = [...baseResult.issues];

    for (const card of response.cards || []) {
      for (const section of card.sections || []) {
        if (section.type === 'compatibility_structured') {
          for (const comp of section.comparisons || []) {
            const hasBasicInfo =
              comp.key_ingredients_match != null &&
              comp.texture_comparison != null &&
              comp.suitability_comparison != null;

            if (!hasBasicInfo) {
              issues.push({
                code: 'INCOMPLETE_COMPARISON',
                message: `Comparison for ${comp.target?.name || 'unknown'} missing basic info (key_ingredients, texture, suitability)`,
                severity: 'error',
              });
            }
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

module.exports = DupeCompareSkill;
