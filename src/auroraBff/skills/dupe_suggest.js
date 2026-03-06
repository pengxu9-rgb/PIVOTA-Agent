const BaseSkill = require('./BaseSkill');

class DupeSuggestSkill extends BaseSkill {
  constructor() {
    super('dupe.suggest', '1.0.0');
  }

  async checkPreconditions(request) {
    const failures = [];

    if (!request.params?.product_anchor) {
      failures.push({
        rule_id: 'pre_has_anchor_product',
        reason: 'No anchor product provided',
        on_fail_message_en: 'Please share a product link or name so I can find alternatives.',
        on_fail_message_zh: '请粘贴产品链接或输入品牌+产品名，我来帮你找替代品。',
      });
    }

    const candidatePool = request.params?._candidate_pool;
    if (request.params?.product_anchor && (!candidatePool || candidatePool.length === 0)) {
      failures.push({
        rule_id: 'pre_has_candidate_pool',
        reason: 'Candidate pool is empty',
        on_fail_message_en: "I couldn't find alternatives for this product in our database.",
        on_fail_message_zh: '在数据库中没有找到该产品的替代品。',
      });
    }

    return { met: failures.length === 0, failures };
  }

  async execute(request, llmGateway) {
    const { context, params } = request;
    const candidatePool = params._candidate_pool || [];

    const llmResult = await llmGateway.call({
      templateId: 'dupe_suggest',
      taskMode: 'dupe',
      params: {
        anchor: params.product_anchor,
        candidates: candidatePool,
        profile: context.profile,
        locale: context.locale || 'en',
      },
      schema: 'DupeSuggestOutput',
    });

    const result = llmResult.parsed;
    const buckets = this._bucketCandidates(result.candidates || []);

    const sections = [
      {
        type: 'product_verdict_structured',
        anchor_product: result.anchor_summary,
        same_price: buckets.same_price,
        cheaper: buckets.cheaper,
        more_expensive: buckets.more_expensive,
        unknown_price: buckets.unknown_price,
        total_candidates: (result.candidates || []).length,
      },
    ];

    return {
      cards: [{ card_type: 'product_verdict', sections }],
      ops: {
        thread_ops: [],
        profile_patch: {},
        routine_patch: {},
        experiment_events: [
          {
            event: 'dupe_suggest_shown',
            anchor: params.product_anchor,
            candidate_count: (result.candidates || []).length,
          },
        ],
      },
      next_actions: [
        {
          action_type: 'navigate_skill',
          target_skill_id: 'dupe.compare',
          label: { en: 'Compare in detail', zh: '详细对比' },
        },
        {
          action_type: 'navigate_skill',
          target_skill_id: 'product.analyze',
          label: { en: 'Analyze a candidate', zh: '分析候选产品' },
        },
      ],
      _promptHash: llmResult.promptHash,
      _taskMode: 'dupe',
      _llmCalls: 1,
    };
  }

  _bucketCandidates(candidates) {
    const buckets = {
      same_price: [],
      cheaper: [],
      more_expensive: [],
      unknown_price: [],
    };

    for (const c of candidates) {
      if (c.confidence === 0) continue;
      const tier = c.price_comparison || 'unknown_price';
      if (buckets[tier]) {
        buckets[tier].push(c);
      } else {
        buckets.unknown_price.push(c);
      }
    }

    return buckets;
  }

  async validateOutput(response, request) {
    const baseResult = await super.validateOutput(response, request);
    const issues = [...baseResult.issues];

    for (const card of response.cards || []) {
      for (const section of card.sections || []) {
        if (section.type === 'product_verdict_structured') {
          if (section.total_candidates === 0) {
            issues.push({
              code: 'EMPTY_CANDIDATE_POOL',
              message: 'No candidates returned; should have been caught by preconditions',
              severity: 'error',
            });
          }

          const allCandidates = [
            ...(section.same_price || []),
            ...(section.cheaper || []),
            ...(section.more_expensive || []),
            ...(section.unknown_price || []),
          ];

          for (const c of allCandidates) {
            if (!c.differences || c.differences.length === 0) {
              issues.push({
                code: 'MISSING_DIFFERENCES',
                message: `Candidate ${c.name || 'unknown'} missing differences[]`,
                severity: 'error',
              });
            }
            if (!c.tradeoffs || c.tradeoffs.length === 0) {
              issues.push({
                code: 'MISSING_TRADEOFFS',
                message: `Candidate ${c.name || 'unknown'} missing tradeoffs[]`,
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

module.exports = DupeSuggestSkill;
