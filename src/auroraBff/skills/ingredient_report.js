const BaseSkill = require('./BaseSkill');

class IngredientReportSkill extends BaseSkill {
  constructor() {
    super('ingredient.report', '1.0.0');
  }

  async checkPreconditions(request) {
    const query = request.params?.ingredient_query;
    if (!query) {
      return {
        met: false,
        failures: [
          {
            rule_id: 'pre_has_ingredient_query',
            reason: 'No ingredient query provided',
            on_fail_message_en: 'Which ingredient would you like to learn about?',
            on_fail_message_zh: '你想了解哪个成分？',
          },
        ],
      };
    }
    return { met: true, failures: [] };
  }

  async execute(request, llmGateway) {
    const { context, params } = request;
    const query = params.ingredient_query;

    const ontologyMatch = params._resolved_ingredient || null;

    const llmResult = await llmGateway.call({
      templateId: 'ingredient_report',
      taskMode: 'ingredient',
      params: {
        ingredient_query: query,
        ontology_match: ontologyMatch,
        profile: context.profile,
        safety_flags: context.safety_flags || [],
        locale: context.locale || 'en',
      },
      schema: 'IngredientReportOutput',
    });

    const report = llmResult.parsed;
    const verified = ontologyMatch !== null;
    const claims = this._sanitizeClaims(report.claims || [], verified);

    const sections = [
      {
        type: 'ingredient_overview',
        ingredient_name: report.ingredient_name || query,
        concept_id: ontologyMatch?.concept_id || null,
        verified_in_ontology: verified,
        category: report.category,
        description_en: report.description_en,
        description_zh: report.description_zh,
      },
      {
        type: 'ingredient_claims',
        claims,
      },
    ];

    if (report.watchouts?.length > 0) {
      sections.push({
        type: 'ingredient_watchouts',
        watchouts: report.watchouts,
      });
    }

    if (report.interactions?.length > 0) {
      sections.push({
        type: 'ingredient_interactions',
        interactions: report.interactions,
      });
    }

    return {
      cards: [{ card_type: 'aurora_ingredient_report', sections }],
      ops: {
        thread_ops: [],
        profile_patch: {},
        routine_patch: {},
        experiment_events: [
          {
            event: 'ingredient_report_viewed',
            ingredient: query,
            verified,
          },
        ],
      },
      next_actions: this._buildNextActions(verified),
      _promptHash: llmResult.promptHash,
      _taskMode: 'ingredient',
      _llmCalls: 1,
    };
  }

  _buildNextActions(verified) {
    if (!verified) {
      return [
        {
          action_type: 'request_input',
          label: { en: 'Check a specific product', zh: '检查具体产品' },
          params: { input_type: 'product_anchor' },
        },
        {
          action_type: 'navigate_skill',
          target_skill_id: 'product.analyze',
          label: { en: 'Analyze a product label', zh: '分析产品标签' },
        },
      ];
    }

    return [
      {
        action_type: 'navigate_skill',
        target_skill_id: 'reco.step_based',
        label: { en: 'Find products with this ingredient', zh: '找含有这个成分的产品' },
      },
      {
        action_type: 'navigate_skill',
        target_skill_id: 'product.analyze',
        label: { en: 'Analyze a product', zh: '分析某个产品' },
      },
    ];
  }

  _sanitizeClaims(claims, verified) {
    return claims.map((claim) => {
      const nextClaim = {
        ...claim,
        evidence_badge: claim.evidence_badge || 'uncertain',
      };

      if (!verified && this._containsForbiddenProductClaim(nextClaim)) {
        return {
          ...nextClaim,
          text_en:
            'Unable to confirm product-level presence for this ingredient without ontology verification.',
          text_zh: '在未完成成分词典验证前，无法确认具体产品层面的成分归属。',
        };
      }

      return nextClaim;
    });
  }

  _containsForbiddenProductClaim(payload) {
    const text = JSON.stringify(payload || {}).toLowerCase();
    return (
      text.includes('products containing') ||
      text.includes('products with this ingredient') ||
      text.includes('含该成分的产品')
    );
  }

  async validateOutput(response, request) {
    const baseResult = await super.validateOutput(response, request);
    const issues = [...baseResult.issues];
    const verified = request.params?._resolved_ingredient != null;

    for (const card of response.cards || []) {
      for (const section of card.sections || []) {
        if (section.type === 'ingredient_overview' && !section.verified_in_ontology) {
          const claimsSection = card.sections.find((s) => s.type === 'ingredient_claims');
          if (claimsSection) {
            for (const claim of claimsSection.claims || []) {
              if (this._containsForbiddenProductClaim(claim)) {
                issues.push({
                  code: 'UNVERIFIED_PRODUCT_CLAIM',
                  message: 'Cannot claim "products containing X" without ontology verification',
                  severity: 'error',
                });
              }
            }
          }
        }

        if (section.type === 'ingredient_claims') {
          for (const claim of section.claims || []) {
            if (!claim.evidence_badge) {
              issues.push({
                code: 'MISSING_EVIDENCE_BADGE',
                message: 'Each claim must have an evidence_badge',
                severity: 'warning',
              });
            }
          }
        }
      }
    }

    if (!verified && this._containsForbiddenProductClaim(response)) {
      issues.push({
        code: 'UNVERIFIED_RESPONSE_PRODUCT_CLAIM',
        message: 'Unverified ingredient response still contains forbidden product-level claim',
        severity: 'error',
      });
    }

    return {
      quality_ok: issues.filter((i) => i.severity === 'error').length === 0,
      issues,
    };
  }
}

module.exports = IngredientReportSkill;
