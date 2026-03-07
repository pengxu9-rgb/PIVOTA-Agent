const BaseSkill = require('./BaseSkill');

class TravelApplyModeSkill extends BaseSkill {
  constructor() {
    super('travel.apply_mode', '1.0.0');
  }

  async checkPreconditions(request) {
    const plan = request.context?.travel_plan;
    if (!plan || !plan.destination || !plan.dates) {
      return {
        met: false,
        failures: [
          {
            rule_id: 'pre_has_travel_plan',
            reason: 'No travel plan with destination and dates',
            on_fail_message_en: "Where are you traveling to and when? I'll adjust your routine for the trip.",
            on_fail_message_zh: '你要去哪里旅行，什么时候？我来帮你调整旅行期间的护肤方案。',
          },
        ],
      };
    }
    return { met: true, failures: [] };
  }

  async execute(request, llmGateway) {
    const { context, params } = request;
    const travelPlan = context.travel_plan;
    const climateArchetype = params?._climate_archetype || null;

    const llmResult = await llmGateway.call({
      templateId: 'travel_apply_mode',
      taskMode: 'travel',
      params: {
        travel_plan: travelPlan,
        climate_archetype: climateArchetype,
        profile: context.profile,
        current_routine: context.current_routine,
        safety_flags: context.safety_flags || [],
        locale: context.locale || 'en',
      },
      schema: 'TravelModeOutput',
    });

    const travelMode = llmResult.parsed;
    const adjustments = this._buildAdjustments(travelMode, climateArchetype);

    const sections = [
      {
        type: 'travel_structured',
        destination: travelPlan.destination,
        dates: travelPlan.dates,
        climate: climateArchetype || travelMode.inferred_climate,
        adjustments,
        packing_list: travelMode.packing_list,
      },
    ];

    return {
      cards: [{ card_type: 'travel', sections }],
      ops: {
        thread_ops: [
          { op: 'set', key: 'travel_mode_active', value: true },
        ],
        profile_patch: {},
        routine_patch: {
          travel_overrides: adjustments,
        },
        experiment_events: [
          {
            event: 'travel_mode_applied',
            destination: travelPlan.destination,
            climate: climateArchetype,
          },
        ],
      },
      next_actions: [
        {
          action_type: 'show_chip',
          label: { en: 'Apply travel adjustments', zh: '应用旅行调整' },
        },
        {
          action_type: 'schedule_reminder',
          label: { en: 'Remind me to reapply sunscreen', zh: '提醒我补涂防晒' },
          params: { interval_hours: 2 },
        },
        {
          action_type: 'navigate_skill',
          target_skill_id: 'tracker.checkin_log',
          label: { en: 'Log a travel check-in', zh: '记录旅行打卡' },
        },
      ],
      _promptHash: llmResult.promptHash,
      _taskMode: 'travel',
      _llmCalls: 1,
    };
  }

  _buildAdjustments(travelMode, climateArchetype) {
    const adjustments = [];

    const isHighUV = travelMode.uv_level === 'high' || travelMode.uv_level === 'extreme';
    if (isHighUV) {
      adjustments.push({
        type: 'spf_reapply',
        priority: 'high',
        instruction_en: 'Reapply sunscreen every 2 hours outdoors. Use SPF 50+ if available.',
        instruction_zh: '户外每2小时补涂防晒。如有条件使用SPF 50+。',
      });
    }

    const isHumid = travelMode.humidity === 'high';
    const isDry = travelMode.humidity === 'low';

    if (isDry) {
      adjustments.push({
        type: 'hydration_boost',
        priority: 'medium',
        instruction_en: 'Add extra hydrating layers. Consider a heavier moisturizer and facial mist.',
        instruction_zh: '增加补水层数。可考虑更厚重的面霜和保湿喷雾。',
      });
    }

    if (isHumid) {
      adjustments.push({
        type: 'lighter_texture',
        priority: 'low',
        instruction_en: 'Switch to lighter textures to prevent congestion in humid weather.',
        instruction_zh: '换用更轻薄的质地，避免潮湿天气造成闷痘。',
      });
    }

    if (travelMode.reduce_irritation) {
      adjustments.push({
        type: 'reduce_actives',
        priority: 'medium',
        instruction_en: 'Reduce frequency of strong actives (retinoids, acids) during travel.',
        instruction_zh: '旅行期间降低强功效成分（维A类、酸类）的使用频率。',
      });
    }

    adjustments.push({
      type: 'minimal_packing',
      priority: 'info',
      instruction_en: 'Pack essentials: gentle cleanser, moisturizer, sunscreen, one targeted treatment.',
      instruction_zh: '携带必需品：温和洁面、保湿、防晒、一个你已建立耐受的功效产品。',
    });

    return adjustments;
  }
}

module.exports = TravelApplyModeSkill;
