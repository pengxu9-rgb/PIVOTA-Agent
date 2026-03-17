const BaseSkill = require('./BaseSkill');

class IngredientHubSkill extends BaseSkill {
  constructor() {
    super('ingredient.hub', '1.0.0');
  }

  async execute(request) {
    const locale = String(request?.context?.locale || 'en').toLowerCase();
    const isCN = locale.startsWith('zh');
    const entrySource = String(request?.params?.entry_source || '').trim().toLowerCase();
    const isDeepLink = entrySource.includes('deeplink');

    const introText = isCN
      ? (isDeepLink
          ? '你已进入成分查询入口。可以先查具体成分，或按功效找成分；诊断是可选项。'
          : '成分入口已切到“查询优先”。你可以先查具体成分，或按功效找成分；诊断是可选项。')
      : (isDeepLink
          ? 'You are now in the ingredient hub. Start with a specific ingredient lookup or find by goal first; diagnosis stays optional.'
          : 'Ingredients now starts in query-first mode. You can lookup a specific ingredient or find by goal first; diagnosis is optional.');

    return {
      cards: [
        {
          card_type: 'text_response',
          sections: [
            {
              type: 'text_answer',
              text_en: introText,
              text_zh: isCN ? introText : null,
            },
          ],
        },
        {
          card_type: 'ingredient_hub',
          sections: [],
          metadata: {
            title: isCN ? '成分查询入口' : 'Ingredient Hub',
            subtitle: isCN
              ? '先查成分，或按功效找成分；诊断只在你需要时再开启。'
              : 'Start with ingredient lookup or goal-based matching. Diagnosis stays optional.',
            suggested_goals: ['Acne', 'Brightening', 'Barrier', 'Anti-aging', 'Hydration'],
            route_source: isDeepLink ? 'deeplink' : 'chip',
          },
        },
      ],
      ops: {
        thread_ops: [],
        profile_patch: {},
        routine_patch: {},
        experiment_events: [
          {
            event: 'ingredient_hub_viewed',
            entry_source: entrySource || null,
          },
        ],
      },
      next_actions: [],
      _taskMode: 'ingredient',
      _llmCalls: 0,
    };
  }

  async validateOutput(_response, _request) {
    return {
      quality_ok: true,
      issues: [],
    };
  }
}

module.exports = IngredientHubSkill;
