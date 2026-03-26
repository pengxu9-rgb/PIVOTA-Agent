function createChatTravelEnvRuntime(options = {}) {
  const {
    logger = null,
    INTENT_ENUM = {},
    GATE_MODE = {},
    BLOCK_LEVEL = {},
    AURORA_CHAT_NONBLOCKING_GATE_V1_ENABLED = false,
    looksLikeWeatherOrEnvironmentQuestion = () => false,
    extractWeatherScenario,
    buildEnvStressUiModelFromLocal,
    buildWeatherAdviceMessage,
    resolvePreferredLegacyTravelPlan,
    runTravelPipeline,
    getOpenAIClient,
    recordAuroraTravelEnvCardEmitted = () => {},
    getTravelWeather,
    buildEpiPayload,
    normalizeEnvStressTier,
    buildEpiRadarRows,
    buildTravelReadinessFromEpi,
    buildEnvStressTierDescription,
    stateChangeAllowed = () => false,
  } = options;

  function requireFunction(name, value) {
    if (typeof value === 'function') return value;
    throw new Error(`aurora chat travel env runtime missing dependency: ${name}`);
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function buildScenarioHint(scenario) {
    if (scenario === 'snow') return { cn: '雪天', en: 'snowy weather' };
    if (scenario === 'rain') return { cn: '雨天', en: 'rainy weather' };
    if (scenario === 'uv') return { cn: '日晒/高 UV', en: 'high UV' };
    if (scenario === 'humid') return { cn: '潮湿闷热', en: 'humid weather' };
    if (scenario === 'dry') return { cn: '干燥天气', en: 'dry air' };
    if (scenario === 'cold') return { cn: '寒冷天气', en: 'cold weather' };
    if (scenario === 'wind') return { cn: '大风天气', en: 'windy weather' };
    if (scenario === 'travel') return { cn: '旅行/飞行', en: 'travel' };
    return { cn: '这个天气', en: 'these conditions' };
  }

  function buildTravelSkillInvocationMatrix(travelPipelineOut = {}) {
    if (isPlainObject(travelPipelineOut.travel_skill_invocation_matrix)) {
      return travelPipelineOut.travel_skill_invocation_matrix;
    }
    return {
      llm_called: false,
      llm_skip_reason: 'unknown',
      reco_called: false,
      reco_skip_reason: 'unknown',
      store_called: false,
      store_skip_reason: 'unknown',
      kb_write_queued: Boolean(travelPipelineOut.travel_kb_write_queued),
      kb_write_skip_reason: Boolean(travelPipelineOut.travel_kb_write_queued) ? 'queued' : 'unknown',
    };
  }

  function buildTravelMissingFieldsAskText({ lang, asksDestination, asksDates }) {
    if (lang === 'CN') {
      if (asksDestination && asksDates) return '为了给你做旅行护肤方案，我先要两个信息：目的地 + 出行日期。';
      if (asksDestination) return '为了给你做旅行护肤方案，请先告诉我目的地。';
      if (asksDates) return '为了给你做旅行护肤方案，请先告诉我出行日期（开始-结束）。';
      return '我先补一个旅行信息，再给你更精准方案。';
    }
    if (asksDestination && asksDates) return 'For a travel skincare plan, I need two quick details first: destination and travel dates.';
    if (asksDestination) return 'For a travel skincare plan, please share your destination first.';
    if (asksDates) return 'For a travel skincare plan, please share your travel dates (start-end).';
    return 'I need one quick travel detail before I continue.';
  }

  function buildTravelFollowupText({ lang, asksDestination, asksDates }) {
    if (lang === 'CN') {
      if (asksDestination && asksDates) return '补充一下目的地和出行日期，我可以把策略细化到行程窗口。';
      if (asksDestination) return '补充一下目的地，我可以把策略细化到当地环境。';
      if (asksDates) return '补充一下出行日期，我可以按行程窗口细化策略。';
      return '补充一个旅行细节，我可以继续细化。';
    }
    if (asksDestination && asksDates) return 'Share destination + travel dates and I can refine this to your trip window.';
    if (asksDestination) return 'Share your destination and I can tune this to local conditions.';
    if (asksDates) return 'Share travel dates and I can tune this to your trip window.';
    return 'Share one extra travel detail and I can refine this further.';
  }

  function buildTravelSuggestedChips({ lang, scenario, includeStoreChannel = false }) {
    const scenarioHint = buildScenarioHint(scenario);
    const chips = [
      {
        chip_id: 'chip.start.routine',
        label: lang === 'CN' ? '生成 AM/PM 护肤流程' : 'Build an AM/PM routine',
        kind: 'quick_reply',
        data: {
          reply_text:
            lang === 'CN'
              ? `帮我按${scenarioHint.cn}生成 AM/PM 护肤流程`
              : `Build an AM/PM routine for ${scenarioHint.en}`,
        },
      },
      {
        chip_id: 'chip.start.reco_products',
        label: lang === 'CN' ? '推荐防护产品' : 'Recommend protective products',
        kind: 'quick_reply',
        data: {
          reply_text:
            lang === 'CN'
              ? `${scenarioHint.cn}我应该用什么类型的防护产品？`
              : `What protective products should I use for ${scenarioHint.en}?`,
        },
      },
    ];
    if (includeStoreChannel) {
      chips.push({
        chip_id: 'chip.travel.store_channel',
        label: lang === 'CN' ? '继续查渠道/有货' : 'Check stores/offers',
        kind: 'quick_reply',
        data: {
          reply_text:
            lang === 'CN'
              ? '帮我看看具体渠道和有货情况'
              : 'Can you check channel availability and offers?',
        },
      });
    }
    return chips;
  }

  async function maybeBuildTravelEnvEnvelope(args = {}) {
    const {
      ctx = {},
      message = '',
      canonicalIntent = {},
      plannerDecision = null,
      profile = null,
      recentLogs = [],
      chatContext = null,
      effectiveChatFlags = {},
      templateAcceptLanguage = '',
      safetyDecision = null,
      nextStateOverride = null,
      buildSafetyNoticeText = () => '',
      pushGateDecision,
      enqueueGateAdvisory,
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
    } = args;

    const buildEnvelopeFn = requireFunction('buildEnvelope', buildEnvelope);
    const makeChatAssistantMessageFn = requireFunction('makeChatAssistantMessage', makeChatAssistantMessage);
    const makeEventFn = requireFunction('makeEvent', makeEvent);
    const looksLikeWeatherOrEnvironmentQuestionFn = requireFunction(
      'looksLikeWeatherOrEnvironmentQuestion',
      looksLikeWeatherOrEnvironmentQuestion,
    );
    const extractWeatherScenarioFn = requireFunction('extractWeatherScenario', extractWeatherScenario);
    const buildEnvStressUiModelFromLocalFn = requireFunction(
      'buildEnvStressUiModelFromLocal',
      buildEnvStressUiModelFromLocal,
    );
    const buildWeatherAdviceMessageFn = requireFunction(
      'buildWeatherAdviceMessage',
      buildWeatherAdviceMessage,
    );
    const resolvePreferredLegacyTravelPlanFn = requireFunction(
      'resolvePreferredLegacyTravelPlan',
      resolvePreferredLegacyTravelPlan,
    );
    const runTravelPipelineFn = requireFunction('runTravelPipeline', runTravelPipeline);
    const getOpenAIClientFn = requireFunction('getOpenAIClient', getOpenAIClient);
    const getTravelWeatherFn = requireFunction('getTravelWeather', getTravelWeather);
    const buildEpiPayloadFn = requireFunction('buildEpiPayload', buildEpiPayload);
    const normalizeEnvStressTierFn = requireFunction('normalizeEnvStressTier', normalizeEnvStressTier);
    const buildEpiRadarRowsFn = requireFunction('buildEpiRadarRows', buildEpiRadarRows);
    const buildTravelReadinessFromEpiFn = requireFunction(
      'buildTravelReadinessFromEpi',
      buildTravelReadinessFromEpi,
    );
    const buildEnvStressTierDescriptionFn = requireFunction(
      'buildEnvStressTierDescription',
      buildEnvStressTierDescription,
    );
    const stateChangeAllowedFn = requireFunction('stateChangeAllowed', stateChangeAllowed);

    const travelIntentRequested =
      looksLikeWeatherOrEnvironmentQuestionFn(message) ||
      canonicalIntent.intent === INTENT_ENUM.TRAVEL_PLANNING ||
      canonicalIntent.intent === INTENT_ENUM.WEATHER_ENV;

    let policyMetaPatch = null;
    if (
      travelIntentRequested &&
      plannerDecision &&
      plannerDecision.next_step === 'ask' &&
      Array.isArray(plannerDecision.required_fields) &&
      plannerDecision.required_fields.length > 0 &&
      (!AURORA_CHAT_NONBLOCKING_GATE_V1_ENABLED || !plannerDecision.can_answer_now)
    ) {
      const lang = ctx.lang === 'CN' ? 'CN' : 'EN';
      const fields = plannerDecision.required_fields;
      const asksDestination = fields.includes('travel_plan.destination');
      const asksDates = fields.includes('travel_plan.start_date') || fields.includes('travel_plan.end_date');
      const askText = buildTravelMissingFieldsAskText({ lang, asksDestination, asksDates });
      const chips = [
        {
          chip_id: 'chip.travel.destination',
          label: lang === 'CN' ? '目的地：东京' : 'Destination: Tokyo',
          kind: 'quick_reply',
          data: { reply_text: lang === 'CN' ? '目的地东京' : 'Destination Tokyo' },
        },
        {
          chip_id: 'chip.travel.dates',
          label: lang === 'CN' ? '日期：2026-03-01 到 2026-03-05' : 'Dates: 2026-03-01 to 2026-03-05',
          kind: 'quick_reply',
          data: { reply_text: '2026-03-01 to 2026-03-05' },
        },
        {
          chip_id: 'chip.travel.climate_mode',
          label: lang === 'CN' ? '无法查天气，按气候模式' : 'No weather, use climate mode',
          kind: 'quick_reply',
          data: { reply_text: lang === 'CN' ? '按炎热潮湿气候给我方案' : 'Plan for hot and humid climate mode' },
        },
      ];
      const decision =
        typeof pushGateDecision === 'function'
          ? pushGateDecision('travel_missing_fields_gate', {
            reason_codes: ['travel_plan_missing_fields'],
          })
          : null;
      if (decision && decision.mode === GATE_MODE.ADVISORY && typeof enqueueGateAdvisory === 'function') {
        enqueueGateAdvisory({
          gate_id: 'travel_missing_fields_gate',
          message: askText,
          reason_codes: ['travel_plan_missing_fields'],
          actions: ['refine_travel_context'],
          chips,
        });
        policyMetaPatch = {
          ...(policyMetaPatch || {}),
          gate_type: 'soft',
        };
        logger?.info?.(
          {
            request_id: ctx.request_id,
            trace_id: ctx.trace_id,
            missing_fields: fields.slice(0, 4),
          },
          'aurora bff: travel missing fields gate downgraded to advisory',
        );
      }
    }

    const triggerAllowed =
      ctx.trigger_source === 'text' ||
      ctx.trigger_source === 'text_explicit' ||
      ctx.trigger_source === 'chip' ||
      ctx.trigger_source === 'action';
    if (!travelIntentRequested || !triggerAllowed) {
      return {
        handled: false,
        envelope: null,
        policyMetaPatch,
      };
    }

    const scenario = extractWeatherScenarioFn(message);
    let envStressUi = buildEnvStressUiModelFromLocalFn({
      profile,
      recentLogs,
      message,
      language: ctx.lang,
    });
    let advice = buildWeatherAdviceMessageFn({ language: ctx.lang, scenario, profile });
    policyMetaPatch = {
      ...(policyMetaPatch || {}),
      env_source: 'local_template',
      degraded: true,
    };

    const travelPlanForSkills = resolvePreferredLegacyTravelPlanFn(profile);
    const canonicalTravelEntities =
      canonicalIntent && isPlainObject(canonicalIntent.entities)
        ? canonicalIntent.entities
        : {};
    const hasTravelContextForSkills = Boolean(
      canonicalIntent.intent === INTENT_ENUM.TRAVEL_PLANNING ||
        (travelPlanForSkills && String(travelPlanForSkills.destination || '').trim()) ||
        String(canonicalTravelEntities.destination || '').trim() ||
        (canonicalTravelEntities.date_range &&
          isPlainObject(canonicalTravelEntities.date_range) &&
          (
            String(canonicalTravelEntities.date_range.start || '').trim() ||
            String(canonicalTravelEntities.date_range.end || '').trim()
          ))
    );

    if (hasTravelContextForSkills) {
      let travelPipelineOut = null;
      try {
        travelPipelineOut = await runTravelPipelineFn({
          message,
          language: ctx.lang,
          profile,
          recentLogs,
          canonicalIntent,
          plannerDecision,
          chatContext,
          travelWeatherLiveEnabled: Boolean(effectiveChatFlags.travel_weather_live_v1),
          openaiClient: getOpenAIClientFn(),
          logger,
          nowMs: Date.now(),
          userLocale: templateAcceptLanguage || '',
          hasSafetyConflict: Boolean(
            safetyDecision &&
              safetyDecision.block_level &&
              safetyDecision.block_level !== BLOCK_LEVEL.INFO,
          ),
        });
      } catch (err) {
        logger?.warn?.(
          {
            request_id: ctx.request_id,
            trace_id: ctx.trace_id,
            err: err && (err.code || err.message) ? err.code || err.message : String(err),
          },
          'aurora bff: travel skills pipeline failed, fallback to local weather path',
        );
      }

      if (travelPipelineOut && travelPipelineOut.ok) {
        advice =
          typeof travelPipelineOut.assistant_text === 'string' && travelPipelineOut.assistant_text.trim()
            ? String(travelPipelineOut.assistant_text).trim()
            : advice;
        policyMetaPatch = {
          ...(policyMetaPatch || {}),
          env_source: travelPipelineOut.env_source || 'local_template',
          degraded: Boolean(travelPipelineOut.degraded),
        };

        if (safetyDecision && safetyDecision.block_level && safetyDecision.block_level !== BLOCK_LEVEL.INFO) {
          const safetyText = String(buildSafetyNoticeText(safetyDecision) || '');
          if (safetyText) advice = `${safetyText}\n\n${advice}`;
        }

        const pipelinePatch = isPlainObject(travelPipelineOut.env_stress_patch)
          ? travelPipelineOut.env_stress_patch
          : {};
        const localEss = Number(envStressUi && envStressUi.ess);
        const pipelineEpi = Number(pipelinePatch.epi);
        envStressUi = {
          ...(envStressUi || {}),
          ...pipelinePatch,
          schema_version: 'aurora.ui.env_stress.v1',
          ess: Number.isFinite(localEss) ? localEss : Number.isFinite(pipelineEpi) ? pipelineEpi : null,
        };
        if (
          !envStressUi.travel_readiness &&
          isPlainObject(travelPipelineOut.travel_readiness)
        ) {
          envStressUi.travel_readiness = travelPipelineOut.travel_readiness;
        }
        const travelReadiness =
          envStressUi && isPlainObject(envStressUi.travel_readiness)
            ? envStressUi.travel_readiness
            : null;

        recordAuroraTravelEnvCardEmitted({
          turn:
            chatContext &&
            (
              chatContext.travel_followup ||
              chatContext.travelFollowup
            )
              ? 'followup'
              : 'first_turn',
        });

        const lang = ctx.lang === 'CN' ? 'CN' : 'EN';
        const suggestedChips = buildTravelSuggestedChips({
          lang,
          scenario,
          includeStoreChannel: Boolean(travelPipelineOut.store_channel),
        });

        const sessionPatch =
          nextStateOverride && stateChangeAllowedFn(ctx.trigger_source)
            ? { next_state: nextStateOverride }
            : {};
        const sessionMeta = isPlainObject(sessionPatch.meta)
          ? { ...sessionPatch.meta }
          : {};
        sessionMeta.travel_skills_version = travelPipelineOut.travel_skills_version || 'travel_skills_dag_v1';
        sessionMeta.travel_skills_trace = Array.isArray(travelPipelineOut.travel_skills_trace)
          ? travelPipelineOut.travel_skills_trace.slice(0, 24)
          : [];
        sessionMeta.travel_kb_hit = Boolean(travelPipelineOut.travel_kb_hit);
        sessionMeta.travel_kb_write_queued = Boolean(travelPipelineOut.travel_kb_write_queued);
        sessionMeta.travel_skill_invocation_matrix = buildTravelSkillInvocationMatrix(travelPipelineOut);
        if (isPlainObject(travelPipelineOut.travel_followup_state)) {
          sessionMeta.travel_followup = travelPipelineOut.travel_followup_state;
        }
        sessionPatch.meta = sessionMeta;
        if (travelReadiness) {
          sessionPatch.last_travel_readiness = {
            destination: travelReadiness.destination_context?.destination || null,
            start_date: travelReadiness.destination_context?.start_date || null,
            end_date: travelReadiness.destination_context?.end_date || null,
            reco_bundle: Array.isArray(travelReadiness.reco_bundle) ? travelReadiness.reco_bundle.slice(0, 5) : [],
            shopping_preview: travelReadiness.shopping_preview || null,
          };
        }

        const envelope = buildEnvelopeFn(ctx, {
          assistant_message: makeChatAssistantMessageFn(advice, 'markdown'),
          suggested_chips: suggestedChips,
          cards: envStressUi
            ? [{ card_id: `env_${ctx.request_id}`, type: 'env_stress', payload: envStressUi }]
            : [],
          session_patch: sessionPatch,
          events: [
            makeEventFn(ctx, 'value_moment', { kind: 'weather_advice', scenario }),
            makeEventFn(ctx, 'travel_skills_trace', {
              version: travelPipelineOut.travel_skills_version || 'travel_skills_dag_v1',
              skills_count: Array.isArray(travelPipelineOut.travel_skills_trace)
                ? travelPipelineOut.travel_skills_trace.length
                : 0,
            }),
          ],
        });
        envelope.meta = {
          ...(isPlainObject(envelope.meta) ? envelope.meta : {}),
          travel_skills_version: travelPipelineOut.travel_skills_version || 'travel_skills_dag_v1',
          travel_skills_trace: Array.isArray(travelPipelineOut.travel_skills_trace)
            ? travelPipelineOut.travel_skills_trace.slice(0, 24)
            : [],
          travel_kb_hit: Boolean(travelPipelineOut.travel_kb_hit),
          travel_kb_write_queued: Boolean(travelPipelineOut.travel_kb_write_queued),
          travel_skill_invocation_matrix: buildTravelSkillInvocationMatrix(travelPipelineOut),
        };
        return {
          handled: true,
          envelope,
          policyMetaPatch,
        };
      }

      if (travelPipelineOut && travelPipelineOut.ok === false) {
        logger?.warn?.(
          {
            request_id: ctx.request_id,
            trace_id: ctx.trace_id,
            quality_reason: travelPipelineOut.quality_reason || null,
          },
          'aurora bff: travel skills pipeline returned ok=false, fallback to local weather path',
        );
      }
    }

    if (effectiveChatFlags.travel_weather_live_v1) {
      const travelPlan = resolvePreferredLegacyTravelPlanFn(profile);
      const destination =
        (travelPlan && typeof travelPlan.destination === 'string' && travelPlan.destination.trim()) ||
        (canonicalIntent.entities && canonicalIntent.entities.destination) ||
        '';
      const startDate =
        (travelPlan && typeof travelPlan.start_date === 'string' && travelPlan.start_date.trim()) ||
        (canonicalIntent.entities &&
        canonicalIntent.entities.date_range &&
        typeof canonicalIntent.entities.date_range.start === 'string'
          ? canonicalIntent.entities.date_range.start
          : '');
      const endDate =
        (travelPlan && typeof travelPlan.end_date === 'string' && travelPlan.end_date.trim()) ||
        (canonicalIntent.entities &&
        canonicalIntent.entities.date_range &&
        typeof canonicalIntent.entities.date_range.end === 'string'
          ? canonicalIntent.entities.date_range.end
          : '');

      const weather = await getTravelWeatherFn({
        destination,
        startDate,
        endDate,
      });
      const epiPayload = buildEpiPayloadFn({
        weather,
        profile,
        language: ctx.lang,
        userReportedConditions: { condition: message },
      });
      const envSource = epiPayload.env_source || weather.source || 'user_reported_conditions';
      policyMetaPatch = {
        ...(policyMetaPatch || {}),
        env_source: envSource,
        degraded: envSource !== 'weather_api',
      };

      const localEss = Number(envStressUi && envStressUi.ess);
      const fusedEss = Number.isFinite(localEss) ? localEss : epiPayload.epi;
      const fusedTier = normalizeEnvStressTierFn(envStressUi && envStressUi.tier, fusedEss);
      const epiRadar = buildEpiRadarRowsFn({ language: ctx.lang, epiPayload, weather });
      const travelReadiness = buildTravelReadinessFromEpiFn({
        language: ctx.lang,
        tier: fusedTier,
        ess: fusedEss,
        epiPayload,
        weather,
      });
      envStressUi = {
        ...(envStressUi || {}),
        ess: fusedEss,
        tier: fusedTier,
        tier_description: buildEnvStressTierDescriptionFn({
          language: ctx.lang,
          tier: fusedTier,
          ess: fusedEss,
        }),
        radar: epiRadar.length ? epiRadar : Array.isArray(envStressUi && envStressUi.radar) ? envStressUi.radar : [],
        travel_readiness: travelReadiness,
        epi: epiPayload.epi,
        components: epiPayload.components,
        reco_weights: epiPayload.reco_weights,
        env_source: epiPayload.env_source,
        travel_context: weather.date_range || null,
      };

      const lang = ctx.lang === 'CN' ? 'CN' : 'EN';
      const destinationText =
        weather && weather.location && weather.location.name
          ? String(weather.location.name)
          : String(destination || '');
      const dateHint =
        weather && weather.date_range && weather.date_range.start
          ? `${weather.date_range.start}${weather.date_range.end ? ` -> ${weather.date_range.end}` : ''}`
          : '';
      const epiLinesCn = [
        `旅行环境压力指数 EPI：${epiPayload.epi}/100（来源：${epiPayload.env_source}）。`,
        destinationText ? `目的地：${destinationText}${dateHint ? `（${dateHint}）` : ''}` : '',
        '建议（AM）：',
        ...epiPayload.strategy.am.map((line) => `- ${line}`),
        '建议（PM）：',
        ...epiPayload.strategy.pm.map((line) => `- ${line}`),
        ...(epiPayload.strategy.notes || []).map((line) => `- ${line}`),
      ].filter(Boolean);
      const epiLinesEn = [
        `Environmental Pressure Index (EPI): ${epiPayload.epi}/100 (source: ${epiPayload.env_source}).`,
        destinationText ? `Destination: ${destinationText}${dateHint ? ` (${dateHint})` : ''}` : '',
        'AM strategy:',
        ...epiPayload.strategy.am.map((line) => `- ${line}`),
        'PM strategy:',
        ...epiPayload.strategy.pm.map((line) => `- ${line}`),
        ...(epiPayload.strategy.notes || []).map((line) => `- ${line}`),
      ].filter(Boolean);
      advice = (lang === 'CN' ? epiLinesCn : epiLinesEn).join('\n');
    }

    if (safetyDecision && safetyDecision.block_level && safetyDecision.block_level !== BLOCK_LEVEL.INFO) {
      const safetyText = String(buildSafetyNoticeText(safetyDecision) || '');
      if (safetyText) advice = `${safetyText}\n\n${advice}`;
    }

    if (
      AURORA_CHAT_NONBLOCKING_GATE_V1_ENABLED &&
      plannerDecision &&
      Array.isArray(plannerDecision.required_fields) &&
      plannerDecision.required_fields.length > 0
    ) {
      const missing = plannerDecision.required_fields;
      const asksDestination = missing.includes('travel_plan.destination');
      const asksDates = missing.includes('travel_plan.start_date') || missing.includes('travel_plan.end_date');
      advice = `${advice}\n\n${buildTravelFollowupText({
        lang: ctx.lang === 'CN' ? 'CN' : 'EN',
        asksDestination,
        asksDates,
      })}`;
    }

    const lang = ctx.lang === 'CN' ? 'CN' : 'EN';
    const envelope = buildEnvelopeFn(ctx, {
      assistant_message: makeChatAssistantMessageFn(advice, 'markdown'),
      suggested_chips: buildTravelSuggestedChips({ lang, scenario }),
      cards: envStressUi
        ? [{ card_id: `env_${ctx.request_id}`, type: 'env_stress', payload: envStressUi }]
        : [],
      session_patch:
        nextStateOverride && stateChangeAllowedFn(ctx.trigger_source)
          ? { next_state: nextStateOverride }
          : {},
      events: [makeEventFn(ctx, 'value_moment', { kind: 'weather_advice', scenario })],
    });

    return {
      handled: true,
      envelope,
      policyMetaPatch,
    };
  }

  return {
    maybeBuildTravelEnvEnvelope,
  };
}

module.exports = {
  createChatTravelEnvRuntime,
};
