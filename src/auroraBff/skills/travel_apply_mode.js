const BaseSkill = require('./BaseSkill');
const {
  buildDatesLabel,
  hasCompleteTravelPlan,
  normalizeTravelPlan,
} = require('../travelPlanUtils');

class TravelApplyModeSkill extends BaseSkill {
  constructor() {
    super('travel.apply_mode', '1.0.0');
  }

  async checkPreconditions(request) {
    const plan = normalizeTravelPlan(request.context?.travel_plan);
    const displayDates = plan?.dates || buildDatesLabel(plan?.start_date, plan?.end_date);
    if (!plan || !plan.destination || !displayDates || !hasCompleteTravelPlan(plan)) {
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
    const travelPlan = normalizeTravelPlan(context.travel_plan);
    const climateArchetype = params?._climate_archetype || null;
    const displayDates = travelPlan.dates || buildDatesLabel(travelPlan.start_date, travelPlan.end_date);
    const persistedTravelPlan = {
      ...travelPlan,
      dates: displayDates,
    };

    const llmResult = await llmGateway.call({
      templateId: 'travel_apply_mode',
      taskMode: 'travel',
      params: {
        travel_plan: persistedTravelPlan,
        climate_archetype: climateArchetype,
        profile: context.profile,
        current_routine: context.current_routine,
        safety_flags: context.safety_flags || [],
        locale: context.locale || 'en',
      },
      schema: 'TravelModeOutput',
    });

    const travelMode = this._normalizeTravelMode(
      llmResult.parsed || {},
      climateArchetype,
      context.current_routine,
      context.safety_flags || []
    );
    const adjustments = this._buildAdjustments(travelMode, climateArchetype);
    const envPayload = this._buildEnvStressPayload({
      travelPlan: persistedTravelPlan,
      travelMode,
      adjustments,
      climateArchetype,
      currentRoutine: context.current_routine,
      recentLogs: context.recent_logs,
    });

    const sections = [
      {
        type: 'travel_structured',
        destination: travelPlan.destination,
        dates: displayDates,
        climate: climateArchetype || travelMode.inferred_climate,
        adjustments,
        packing_list: travelMode.packing_list,
        env_payload: envPayload,
      },
    ];

    return {
      cards: [{ card_type: 'travel', sections }],
      ops: {
        thread_ops: [
          { op: 'set', key: 'travel_plan', value: persistedTravelPlan },
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

  _buildEnvStressPayload({ travelPlan, travelMode, adjustments, climateArchetype, currentRoutine, recentLogs }) {
    const inferredClimate = String(climateArchetype || travelMode?.inferred_climate || '').trim();
    const humidity = String(travelMode?.humidity || '').trim().toLowerCase();
    const uvLevel = String(travelMode?.uv_level || '').trim().toLowerCase();
    const hasRoutine = Array.isArray(currentRoutine?.am_steps) || Array.isArray(currentRoutine?.pm_steps);
    const hasRecentLogs = Array.isArray(recentLogs) && recentLogs.length > 0;
    const summaryTags = ['baseline_unavailable'];

    if (humidity === 'high') summaryTags.push('humid');
    if (humidity === 'low') summaryTags.push('dry');
    if (uvLevel === 'high' || uvLevel === 'extreme') summaryTags.push('high_uv');
    if (/tropical|equatorial/i.test(inferredClimate)) summaryTags.push('tropical');
    if (/humid/i.test(inferredClimate)) summaryTags.push('more_humid');
    if (/dry/i.test(inferredClimate)) summaryTags.push('drier_air');

    const riskScore =
      (uvLevel === 'extreme' ? 82 : uvLevel === 'high' ? 72 : 56)
      + (humidity === 'high' ? 6 : 0)
      + (travelMode?.reduce_irritation ? 8 : 0);
    const ess = Math.max(28, Math.min(88, riskScore));
    const tier = ess >= 65 ? 'High' : ess >= 40 ? 'Moderate' : 'Low';

    const adaptiveActions = adjustments.map((item) => ({
      why: this._adjustmentWhy(item),
      what_to_do: item?.instruction_en || '',
    }));

    const categorizedKit = this._buildCategorizedKit({ adjustments, packingList: travelMode?.packing_list, humidity, uvLevel });
    const packingListLines = this._buildPackingListLines(travelMode?.packing_list);
    const activeHandling = adjustments
      .filter((item) => item?.type === 'reduce_actives')
      .map((item) => item.instruction_en)
      .filter(Boolean);

    return {
      schema_version: 'aurora.ui.env_stress.v1',
      ess,
      tier,
      tier_description: 'Climate-based travel adjustment using destination conditions and your current skincare context.',
      radar: [
        { axis: 'UV', value: uvLevel === 'extreme' ? 90 : uvLevel === 'high' ? 78 : 54 },
        { axis: 'Hydration', value: humidity === 'high' ? 66 : humidity === 'low' ? 74 : 58 },
        { axis: 'Barrier', value: travelMode?.reduce_irritation ? 72 : 52 },
      ],
      notes: [
        !hasRoutine ? 'missing_current_routine' : '',
        !hasRecentLogs ? 'recent_logs' : '',
      ].filter(Boolean),
      travel_readiness: {
        destination_context: {
          destination: travelPlan.destination,
          start_date: travelPlan.start_date || null,
          end_date: travelPlan.end_date || null,
          env_source: 'climate_fallback',
          weather_reason: 'travel_apply_mode_generalized',
        },
        delta_vs_home: {
          summary_tags: summaryTags,
        },
        adaptive_actions: adaptiveActions,
        categorized_kit: categorizedKit,
        structured_sections: {
          travel_kit: packingListLines,
          routine_adjustments: adjustments.map((item) => item.instruction_en).filter(Boolean),
          active_handling: activeHandling,
        },
        confidence: {
          level: hasRoutine ? 'medium' : 'low',
          missing_inputs: [
            !hasRoutine ? 'current_routine' : '',
            !hasRecentLogs ? 'recent_logs' : '',
          ].filter(Boolean),
          improve_by: [
            !hasRoutine ? 'Add your AM/PM routine for product-specific swaps.' : '',
            !hasRecentLogs ? 'Add a quick check-in if you want more personalized travel guidance.' : '',
          ].filter(Boolean),
        },
        ...(inferredClimate
          ? {
              personal_focus: [
                {
                  focus: 'Destination climate',
                  why: inferredClimate,
                  what_to_do: adjustments[0]?.instruction_en || 'Keep the routine simple and climate-adapted.',
                },
              ],
            }
          : {}),
      },
    };
  }

  _buildCategorizedKit({ adjustments, packingList, humidity, uvLevel }) {
    const entries = [];

    if (uvLevel === 'high' || uvLevel === 'extreme') {
      entries.push({
        id: 'sun_protection',
        title: 'Sun protection',
        climate_link: uvLevel === 'extreme' ? 'Extreme UV exposure' : 'High UV exposure',
        why: 'UV intensity is elevated at your destination.',
        ingredient_logic: 'Use broad-spectrum, photostable sunscreen and easy reapplication formats.',
        preparations: [
          {
            name: 'SPF 50+ sunscreen',
            detail: 'Reapply every 2 hours outdoors',
          },
        ],
      });
    }

    if (humidity === 'high') {
      entries.push({
        id: 'humidity_control',
        title: 'Warmer / more humid',
        climate_link: 'Humid climate',
        why: 'Lighter textures can reduce congestion while keeping hydration steady.',
        ingredient_logic: 'Humectants, gel creams, and non-heavy layers work better in humidity.',
        preparations: [
          {
            name: 'Gel moisturizer',
            detail: 'Use as a lightweight daytime layer',
          },
        ],
      });
    } else if (humidity === 'low') {
      entries.push({
        id: 'hydration_support',
        title: 'Dry air support',
        climate_link: 'Dry climate',
        why: 'Lower humidity can increase dehydration and tightness.',
        ingredient_logic: 'Layer humectants with a richer moisturizer to hold water in the skin.',
        preparations: [
          {
            name: 'Barrier moisturizer',
            detail: 'Use a richer layer when skin feels tight',
          },
        ],
      });
    }

    if (adjustments.some((item) => item?.type === 'reduce_actives')) {
      entries.push({
        id: 'active_management',
        title: 'Active management',
        climate_link: 'Barrier protection',
        why: 'Travel stress plus actives can increase irritation risk.',
        ingredient_logic: 'Lower active frequency and keep the barrier routine stable.',
        preparations: [
          {
            name: 'Barrier repair cream',
            detail: 'Use on recovery nights if skin feels reactive',
          },
        ],
      });
    }

    if (entries.length === 0) {
      entries.push({
        id: 'travel_essentials',
        title: 'Travel essentials',
        climate_link: 'General travel adjustment',
        why: 'Keep the routine stable and easy to tolerate while traveling.',
        ingredient_logic: 'Focus on cleanser, moisturizer, sunscreen, and one proven treatment.',
        preparations: this._buildPackingPreparations(packingList),
      });
    }

    return entries;
  }

  _buildPackingPreparations(packingList) {
    const normalized = Array.isArray(packingList) ? packingList : [];
    const items = normalized
      .map((entry) => {
        if (typeof entry === 'string') {
          const text = entry.trim();
          return text ? { name: text, detail: '' } : null;
        }
        if (!entry || typeof entry !== 'object') return null;
        const name = String(entry.product_type || entry.name || '').trim();
        const detail = String(entry.reason_en || entry.detail || '').trim();
        return name ? { name, detail } : null;
      })
      .filter(Boolean);

    return items.length ? items.slice(0, 4) : [{ name: 'Core travel skincare', detail: 'Pack only well-tolerated essentials.' }];
  }

  _buildPackingListLines(packingList) {
    return this._buildPackingPreparations(packingList).map((item) =>
      item.detail ? `【${item.name}】 ${item.detail}` : item.name
    );
  }

  _adjustmentWhy(item) {
    const type = String(item?.type || '').trim().toLowerCase();
    if (type === 'spf_reapply') return 'UV pressure is higher than usual.';
    if (type === 'lighter_texture') return 'Humidity can increase congestion risk.';
    if (type === 'hydration_boost') return 'Dry air can increase dehydration and tightness.';
    if (type === 'reduce_actives') return 'Barrier stress is more likely during travel.';
    return 'Keep the routine simple and travel-tolerant.';
  }

  _normalizeTravelMode(travelMode, climateArchetype, currentRoutine, safetyFlags) {
    const climate = String(climateArchetype || travelMode?.inferred_climate || '').trim().toLowerCase();
    const uvLevel = travelMode?.uv_level || (this._isHighUvClimate(climate) ? 'high' : 'moderate');
    const humidity = travelMode?.humidity || (climate.includes('dry') ? 'low' : climate.includes('humid') ? 'high' : 'medium');
    const packingList = Array.isArray(travelMode?.packing_list) ? travelMode.packing_list : [];
    const reduceIrritation =
      travelMode?.reduce_irritation === true ||
      this._shouldReduceActives({ climate, uvLevel, currentRoutine, safetyFlags });

    return {
      ...travelMode,
      uv_level: uvLevel,
      humidity,
      packing_list: packingList,
      inferred_climate: travelMode?.inferred_climate || climateArchetype || null,
      reduce_irritation: reduceIrritation,
    };
  }

  _shouldReduceActives({ climate, uvLevel, currentRoutine, safetyFlags }) {
    const routineProducts = this._collectRoutineProducts(currentRoutine);
    const hasStrongActives = routineProducts.some((product) => {
      const concepts = Array.isArray(product?.concepts) ? product.concepts.map((item) => String(item || '').toUpperCase()) : [];
      const name = String(product?.name || '').toUpperCase();
      return (
        concepts.some((concept) => ['RETINOID', 'RETINOL', 'AHA', 'BHA', 'BENZOYL_PEROXIDE'].includes(concept)) ||
        /RETIN|RETINOID|SALICYLIC|GLYCOLIC|LACTIC|MANDELIC|BENZOYL/i.test(name)
      );
    });

    const hasSensitivityFlags = (Array.isArray(safetyFlags) ? safetyFlags : []).some((flag) =>
      /BARRIER|PROCEDURE|SENSITIVE|IRRIT|RECENT_PROCEDURE/i.test(String(flag || ''))
    );

    return hasSensitivityFlags || (hasStrongActives && (this._isHighUvClimate(climate) || uvLevel === 'high' || uvLevel === 'extreme'));
  }

  _collectRoutineProducts(currentRoutine) {
    const amSteps = Array.isArray(currentRoutine?.am_steps) ? currentRoutine.am_steps : [];
    const pmSteps = Array.isArray(currentRoutine?.pm_steps) ? currentRoutine.pm_steps : [];
    return [...amSteps, ...pmSteps].flatMap((step) => (Array.isArray(step?.products) ? step.products : []));
  }

  _isHighUvClimate(climate) {
    return /high_uv|tropical|equatorial|beach|desert/i.test(String(climate || ''));
  }
}

module.exports = TravelApplyModeSkill;
