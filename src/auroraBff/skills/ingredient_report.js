const BaseSkill = require('./BaseSkill');

class IngredientReportSkill extends BaseSkill {
  constructor() {
    super('ingredient.report', '2.0.0');
  }

  async checkPreconditions(request) {
    const query = request.params?.ingredient_query;
    const userQuestion = request.params?._user_question;

    if (!query && !userQuestion) {
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
    const query = request.params?.ingredient_query;
    const userQuestion = request.params?._user_question;

    if (userQuestion && (!query || this._isGeneralIngredientQuestion(userQuestion))) {
      return this._handleIngredientQuestion(request, llmGateway);
    }

    return this._handleSpecificIngredient(request, llmGateway);
  }

  async _handleIngredientQuestion(request, llmGateway) {
    const locale = request.context?.locale || 'en';
    const userQuestion = request.params?._user_question || request.params?.ingredient_query || '';

    const llmResult = await llmGateway.call({
      templateId: 'ingredient_query_answer',
      taskMode: 'ingredient',
      params: {
        user_question: userQuestion,
        profile: request.context?.profile || {},
        safety_flags: request.context?.safety_flags || [],
        locale,
      },
      schema: 'IngredientQueryOutput',
    });

    const answer = llmResult.parsed || {};
    const cards = [
      {
        card_type: 'text_response',
        sections: [
          {
            type: 'text_answer',
            text_en: answer.answer_en,
            text_zh: answer.answer_zh || null,
          },
        ],
      },
    ];

    if (Array.isArray(answer.safety_notes) && answer.safety_notes.length > 0) {
      cards[0].sections.push({
        type: 'safety_notes',
        notes: answer.safety_notes,
      });
    }

    if (Array.isArray(answer.ingredients_mentioned) && answer.ingredients_mentioned.length > 0) {
      cards.push({
        card_type: 'aurora_ingredient_report',
        sections: [
          {
            type: 'ingredient_list',
            ingredients: answer.ingredients_mentioned.map((ingredient) => ({
              name: ingredient.name,
              inci: ingredient.inci || null,
              relevance: ingredient.relevance || null,
              pros: locale.startsWith('zh') ? ingredient.pros_zh || [] : ingredient.pros_en || [],
              cons: locale.startsWith('zh') ? ingredient.cons_zh || [] : ingredient.cons_en || [],
              evidence_level: ingredient.evidence_level || 'uncertain',
              best_for: ingredient.best_for || [],
            })),
          },
        ],
      });
    }

    const nextActions = [];
    if (Array.isArray(answer.ingredients_mentioned) && answer.ingredients_mentioned.length > 0) {
      nextActions.push({
        action_type: 'navigate_skill',
        target_skill_id: 'ingredient.report',
        label: {
          en: `Deep dive: ${answer.ingredients_mentioned[0].name}`,
          zh: `深入了解：${answer.ingredients_mentioned[0].name}`,
        },
        params: {
          ingredient_query: answer.ingredients_mentioned[0].name,
        },
      });
    }
    nextActions.push({
      action_type: 'navigate_skill',
      target_skill_id: 'reco.step_based',
      label: { en: 'Find products', zh: '查找产品' },
      params: {
        _extracted_concerns: request.params?._extracted_concerns || [],
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
            event: 'ingredient_query_answered',
            question: userQuestion,
            ingredients_count: Array.isArray(answer.ingredients_mentioned) ? answer.ingredients_mentioned.length : 0,
          },
        ],
      },
      next_actions: nextActions,
      _promptHash: llmResult.promptHash,
      _taskMode: 'ingredient',
      _llmCalls: 1,
    };
  }

  async _handleSpecificIngredient(request, llmGateway) {
    const query = request.params?.ingredient_query;
    const ontologyMatch = request.params?._resolved_ingredient || null;

    const llmResult = await llmGateway.call({
      templateId: 'ingredient_report',
      taskMode: 'ingredient',
      params: {
        ingredient_query: query,
        ontology_match: ontologyMatch,
        profile: request.context?.profile || {},
        safety_flags: request.context?.safety_flags || [],
        locale: request.context?.locale || 'en',
      },
      schema: 'IngredientReportOutput',
    });

    const report = llmResult.parsed || {};
    const verified = Boolean(ontologyMatch);
    const normalizedClaims = this._normalizeClaims(report.claims, {
      ingredientName: report.ingredient_name || query,
      verified,
    });
    const sections = [
      {
        type: 'ingredient_overview',
        ingredient_name: report.ingredient_name || query,
        inci_name: report.inci_name || null,
        concept_id: ontologyMatch?.concept_id || null,
        verified_in_ontology: verified,
        category: report.category || 'other',
        description_en: report.description_en || '',
        description_zh: report.description_zh || null,
      },
    ];

    if (Array.isArray(report.benefits) && report.benefits.length > 0) {
      sections.push({
        type: 'ingredient_benefits',
        benefits: report.benefits,
      });
    }

    sections.push({
      type: 'ingredient_claims',
      claims: normalizedClaims,
    });

    if (report.how_to_use) {
      sections.push({
        type: 'ingredient_usage',
        how_to_use: report.how_to_use,
      });
    }

    if (Array.isArray(report.watchouts) && report.watchouts.length > 0) {
      sections.push({
        type: 'ingredient_watchouts',
        watchouts: report.watchouts,
      });
    }

    if (Array.isArray(report.interactions) && report.interactions.length > 0) {
      sections.push({
        type: 'ingredient_interactions',
        interactions: report.interactions,
      });
    }

    if (Array.isArray(report.related_ingredients) && report.related_ingredients.length > 0) {
      sections.push({
        type: 'related_ingredients',
        ingredients: report.related_ingredients,
      });
    }

    return {
      cards: [
        {
          card_type: 'aurora_ingredient_report',
          sections,
        },
      ],
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
      next_actions: [
        {
          action_type: 'navigate_skill',
          target_skill_id: 'reco.step_based',
          label: {
            en: `Find products with ${report.ingredient_name || query}`,
            zh: `查找含有${report.ingredient_name || query}的产品`,
          },
          params: { target_ingredient: query },
        },
        {
          action_type: 'navigate_skill',
          target_skill_id: 'product.analyze',
          label: { en: 'Analyze a product', zh: '分析一个产品' },
        },
      ],
      _promptHash: llmResult.promptHash,
      _taskMode: 'ingredient',
      _llmCalls: 1,
    };
  }

  _normalizeClaims(claims, { ingredientName, verified }) {
    const normalized = Array.isArray(claims)
      ? claims
          .filter((claim) => claim && typeof claim === 'object')
          .map((claim) => ({
            ...claim,
            text_en: claim.text_en || `${ingredientName} may support some skincare goals, but results depend on the exact ingredient identity and formula.`,
            text_zh: claim.text_zh || null,
            evidence_badge: claim.evidence_badge || (verified ? 'limited' : 'uncertain'),
            verified_source: verified,
          }))
      : [];

    if (normalized.length > 0) {
      return normalized;
    }

    return [
      {
        text_en: verified
          ? `${ingredientName} may offer skincare benefits, but tolerance and real-world performance still depend on formulation and usage.`
          : `${ingredientName} may be relevant to skincare, but the exact ingredient identity and evidence level are not verified here.`,
        text_zh: null,
        evidence_badge: verified ? 'limited' : 'uncertain',
        verified_source: verified,
      },
    ];
  }

  _isGeneralIngredientQuestion(question) {
    const lower = String(question || '').toLowerCase();
    const patterns = [
      'best for',
      'what ingredient',
      'which ingredient',
      'good for',
      'help with',
      'what works for',
      '什么成分',
      '哪个成分',
      '推荐',
      '适合',
    ];
    return patterns.some((pattern) => lower.includes(pattern));
  }
}

module.exports = IngredientReportSkill;
