const BaseSkill = require('./BaseSkill');

class ProductAnalyzeSkill extends BaseSkill {
  constructor() {
    super('product.analyze', '1.0.0');
  }

  async checkPreconditions(request) {
    const anchor = request.params?.product_anchor;
    if (!anchor) {
      return {
        met: false,
        failures: [
          {
            rule_id: 'pre_has_product_anchor',
            reason: 'No product anchor provided',
            on_fail_message_en: 'Please share a product link or name so I can analyze it.',
            on_fail_message_zh: '请粘贴产品链接或输入品牌+产品名，我来帮你分析。',
          },
        ],
      };
    }
    return { met: true, failures: [] };
  }

  async execute(request, llmGateway) {
    const { context, params } = request;
    const safetyFlags = context.safety_flags || [];

    const llmResult = await llmGateway.call({
      templateId: 'product_analyze',
      taskMode: 'product_analysis',
      params: {
        product_anchor: params.product_anchor,
        ingredient_list: params.ingredient_list || null,
        profile: context.profile,
        safety_flags: safetyFlags,
        current_routine: context.current_routine,
        locale: context.locale || 'en',
      },
      schema: 'ProductAnalysisOutput',
    });

    const analysis = llmResult.parsed;
    const deterministicFixes = this._applyDeterministicRules(analysis, safetyFlags, params);

    const sections = [
      {
        type: 'product_verdict_structured',
        product_name: analysis.product_name,
        brand: analysis.brand,
        product_type: analysis.product_type,
        suitability: analysis.suitability,
        usage: deterministicFixes.usage || analysis.usage,
        key_ingredients: analysis.key_ingredients,
        risk_flags: [...(analysis.risk_flags || []), ...deterministicFixes.additional_flags],
        safety_warnings: deterministicFixes.safety_warnings,
      },
    ];

    return {
      cards: [{ card_type: 'product_verdict', sections }],
      ops: {
        thread_ops: [],
        profile_patch: {},
        routine_patch: {},
        experiment_events: [{ event: 'product_analyzed', product_type: analysis.product_type }],
      },
      next_actions: [
        {
          action_type: 'navigate_skill',
          target_skill_id: 'explore.add_to_routine',
          label: { en: 'Add to my routine', zh: '加入我的护肤流程' },
          params: {
            product_anchor: params.product_anchor,
          },
        },
        {
          action_type: 'navigate_skill',
          target_skill_id: 'dupe.suggest',
          label: { en: 'Find alternatives', zh: '寻找替代品' },
        },
        {
          action_type: 'navigate_skill',
          target_skill_id: 'ingredient.report',
          label: { en: 'Learn about an ingredient', zh: '了解某个成分' },
        },
      ],
      _promptHash: llmResult.promptHash,
      _taskMode: 'product_analysis',
      _llmCalls: 1,
    };
  }

  /**
   * Deterministic rules that override LLM output. These are hard rules
   * that MUST NOT be violated regardless of LLM response.
   */
  _applyDeterministicRules(analysis, safetyFlags, params = {}) {
    const fixes = { additional_flags: [], safety_warnings: [] };
    const anchor = params.product_anchor || {};
    const ingredientList = params.ingredient_list || [];
    const ingredientConcepts = ingredientList.map((item) =>
      typeof item === 'string' ? item.toUpperCase() : item.concept
    );

    const anchorName = `${anchor.brand || ''} ${anchor.name || ''}`.toUpperCase();
    const isSPF =
      analysis.product_type === 'sunscreen' ||
      analysis.has_spf ||
      anchor.product_type === 'sunscreen' ||
      anchorName.includes('SPF') ||
      ingredientConcepts.includes('SUNSCREEN');
    if (isSPF) {
      fixes.usage = {
        time_of_day: 'am',
        frequency: 'daily',
        reapply: 'every 2 hours when outdoors',
        application_note_en: 'Apply as last skincare step before makeup. Reapply every 2h outdoors.',
        application_note_zh: '作为护肤最后一步在化妆前使用。户外每2小时补涂。',
      };
    }

    const hasStrongRetinoid = (analysis.key_ingredients || []).some(
      (i) => ['RETINOID', 'TRETINOIN', 'ADAPALENE', 'TAZAROTENE'].includes(i.concept)
    ) || ingredientConcepts.some((concept) =>
      ['RETINOID', 'TRETINOIN', 'ADAPALENE', 'TAZAROTENE', 'RETINOL'].includes(concept)
    );
    if (hasStrongRetinoid) {
      fixes.usage = fixes.usage || analysis.usage || {};
      fixes.usage.time_of_day = 'pm';
      fixes.usage.initial_frequency = '1-2x/week, build up gradually';
      fixes.usage.initial_frequency_zh = '每周1-2次，逐步增加';
    }

    const isPregnant = safetyFlags.some((f) => f.startsWith('PREG_') && f.includes('BLOCK'));
    if (isPregnant && hasStrongRetinoid) {
      fixes.safety_warnings.push({
        level: 'BLOCK',
        message_en: 'This product contains retinoids which should be avoided during pregnancy.',
        message_zh: '该产品含有维A类成分，孕期应避免使用。',
        alternatives: ['AZELAIC_ACID', 'NIACINAMIDE'],
      });
    }

    const hasHighStrengthAcid = (analysis.key_ingredients || []).some(
      (i) => ['AHA', 'BHA'].includes(i.concept) && i.strength === 'high'
    ) || ingredientConcepts.some((concept) => ['AHA', 'BHA'].includes(concept));
    if (hasHighStrengthAcid) {
      fixes.usage = fixes.usage || analysis.usage || {};
      fixes.usage.initial_frequency = fixes.usage.initial_frequency || '1-2x/week';
      fixes.additional_flags.push({
        code: 'HIGH_STRENGTH_ACID',
        message_en: 'High-strength acid: start slow and patch-test first.',
        message_zh: '高浓度酸类：请先从低频开始并做贴片测试。',
      });
    }

    return fixes;
  }
}

module.exports = ProductAnalyzeSkill;
